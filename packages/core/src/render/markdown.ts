import type { Report, ReportFinding } from "../types.js";
import { SEVERITIES_DESC, candidateLocation, coverageLine, escapeMarkdown, location, lowConfidenceReason, orderPossible, sourceLabel, verdictLine } from "./common.js";
import { impactLine } from "./terminal.js";
import { renderObservations } from "./review.js";

const CLOSING = "Made by Qodex: review on every pull request at https://qodex.ai";

// Every line-ending form Markdown or a browser may treat as a break.
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g;
// Control characters left after line breaks are handled.
// Matching control characters is the point here.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

// One table cell: every character markdown or HTML gives meaning to escaped,
// as in the review report, so a scanner's message or reason makes no link,
// image or tag; then every line ending a <br>.
function cell(text: string): string {
  return escapeMarkdown(text.replace(CONTROL, ""))
    .replace(LINE_BREAK, "<br>")
    .replace(/\t/g, " ")
    .trim();
}

// An inline code span that is also safe inside a table cell: one line, no
// backtick, pipes escaped (a table unescapes them inside code spans).
function code(text: string): string {
  const one = text.replace(CONTROL, "").replace(LINE_BREAK, " ").replace(/\t/g, " ").replace(/`/g, "'");
  return `\`${one.replace(/\|/g, "\\|")}\``;
}

// The agent's summary, kept inside one quote block under its own heading so
// none of its lines reads as a heading or section of the report itself.
function quote(text: string): string {
  return text
    .replace(CONTROL, "")
    .replace(LINE_BREAK, "\n")
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function findingTable(findings: ReportFinding[]): string[] {
  const ordered = SEVERITIES_DESC.flatMap((s) => findings.filter((f) => f.severity === s));
  const rows = ["| Severity | Location | Finding | Source |", "|---|---|---|---|"];
  for (const f of ordered) {
    const text = f.description ? `**${cell(f.title)}**<br>${cell(f.description)}` : `**${cell(f.title)}**`;
    const notes = f.notes.length > 0 ? `<br>_${cell(f.notes.join("; "))}_` : "";
    rows.push(`| ${f.severity} | ${code(location(f))} | ${text}${notes} | ${code(sourceLabel(f))} |`);
  }
  return rows;
}

export function renderMarkdown(report: Report): string {
  const title = report.kind === "review" ? "OpenQodex review" : "OpenQodex scan";
  const { files, additions, deletions } = report.stats;
  const out = [
    `# ${title}`,
    "",
    `**${verdictLine(report)}**`,
    "",
    ...(report.reviewed_by ? [cell(report.reviewed_by), ""] : []),
    ...(impactLine(report) ? [cell(impactLine(report) as string), ""] : []),
    `Change ${code(report.change_id.slice(0, 12))} against ${code(report.base.ref)} (${code(report.base.sha.slice(0, 12))}), ${files} ${files === 1 ? "file" : "files"}, +${additions} -${deletions}.`,
  ];
  if (report.summary) out.push("", "## Summary", "", quote(report.summary));
  if (report.notes?.length) out.push("", "## Review notes", "", ...report.notes.map((note) => `- ${cell(note)}`));

  out.push("", "## Findings", "");
  if (report.findings.length === 0) out.push("No findings on the changed lines.");
  else out.push(...findingTable(report.findings));

  const observations = renderObservations(report);
  if (observations) out.push("", observations.trimEnd());

  const possible = orderPossible(report);
  if (possible.length > 0) {
    // wording: session
    out.push("", "## Possible issues (not counted)", "", ...findingTable(possible));
  }

  if (report.outside_change.length > 0) {
    out.push("", "## Outside the changed lines", "", "Shown for information; these never count toward the verdict.", "");
    out.push(...findingTable(report.outside_change));
  }
  if (report.not_reviewed.length > 0) {
    out.push(
      "",
      "## Not reviewed by the agent",
      "",
      "Scanner candidates the agent neither raised nor dropped. They count toward the verdict.",
      "",
      "| Id | Severity | Location | Rule | Message |",
      "|---|---|---|---|---|",
    );
    for (const c of report.not_reviewed) {
      out.push(`| ${c.id} | ${c.reviewSeverity} | ${code(candidateLocation(c))} | ${code(c.token)} | ${cell(c.message)} |`);
    }
  }
  if (report.dropped.length > 0) {
    out.push("", "## Dropped by the agent", "", "| Id | Location | Rule | Reason |", "|---|---|---|---|");
    for (const d of report.dropped) {
      out.push(`| ${d.candidate.id} | ${code(candidateLocation(d.candidate))} | ${code(d.candidate.token)} | ${cell(d.reason)} |`);
    }
  }
  if (report.low_confidence.length > 0) {
    out.push("", "## Below the confidence floor", "", "| File | Finding | Confidence | Floor |", "|---|---|---|---|");
    for (const l of report.low_confidence) {
      out.push(`| ${code(l.file_path)} | ${cell(l.title + lowConfidenceReason(l))} | ${l.confidence} | ${l.floor} |`);
    }
  }
  if (report.not_reviewed_paths.length > 0) {
    out.push("", "## Not reviewed, change too large", "");
    for (const p of report.not_reviewed_paths) out.push(`- ${code(p)}`);
  }

  out.push("", "## Scanners", "", cell(coverageLine(report.scanners)));
  if (report.scanners.length > 0) {
    out.push(
      "",
      "<details><summary>Scanner details</summary>",
      "",
      "| Scanner | Status | Version | Found | Kept | Time | Reason |",
      "|---|---|---|---|---|---|---|",
    );
    for (const s of report.scanners) {
      out.push(
        `| ${cell(s.scanner)} | ${s.status.replace(/_/g, " ")} | ${cell(s.version ?? "")} | ${s.rawCount} | ${s.keptCount} | ${(s.durationMs / 1000).toFixed(1)} s | ${cell(s.reason ?? "")} |`,
      );
    }
    out.push("", "</details>");
  }
  if (report.kind === "review") out.push("", "---", "", CLOSING);
  return `${out.join("\n")}\n`;
}
