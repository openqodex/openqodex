// The standard report of a review run by `review` itself: one list of lines
// built from the report's fields, then dressed for the terminal (colour and
// indent) or for markdown (headings, bullets and bold labels). The words and
// their order are the same in both; only the markup differs.
import pc from "picocolors";
import type { ModelCompletionRecord, Report, ReportFinding, ReviewerRecord } from "../types.js";
import { candidateLocation, coverageLine, display, escapeMarkdown, findingTitle, firstLine, location, lowConfidenceReason, notOpenedLabel, observationsOmittedLine, orderFindings, orderObservations, orderPossible, severityBreakdown, verdictLine } from "./common.js";
import { impactLine } from "./terminal.js";

type Line =
  | { kind: "verdict"; text: string; bad: boolean }
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "item"; text: string }
  | { kind: "label"; text: string }
  | { kind: "code"; text: string }
  | { kind: "field"; label: string; text: string };

export const CLOSING = "Made by Qodex: review on every pull request at https://qodex.ai";
const INCOMPLETE = "Review incomplete: this is not a review of the change";
// The scanner candidates of an incomplete review that no reviewer checked.
const UNCHECKED = "Unchecked scanner candidates, not a review";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The product name of a driver, for the report.
const PRODUCT: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
export const product = (driver: string) => PRODUCT[driver] ?? driver;

export function reviewerLine(r: ReviewerRecord | null): string {
  if (r === null) return "Reviewer: none started";
  const parts = [`${r.driver} ${r.version}`, `${Math.round(r.duration_ms / 1000)} s`, plural(r.usage.turns, "turn", "turns")];
  if (r.rounds > 1) parts.push(plural(r.rounds - 1, "correction round", "correction rounds"));
  if (r.usage.input_tokens !== null) parts.push(`${r.usage.input_tokens.toLocaleString("en-US")} tokens in`);
  if (r.usage.output_tokens !== null) parts.push(`${r.usage.output_tokens.toLocaleString("en-US")} out`);
  if (r.usage.cost_usd !== null) parts.push(`$${r.usage.cost_usd.toFixed(2)}`);
  return `Reviewer: ${parts.join(", ")}`;
}

// The reviewer line of a model review, from the brain's own record of every
// attempt: the requested model (and the models that answered, when another
// one did), the calls made, and the tokens and cost the responses reported.
// A value no response reported is "not reported", never a zero.
export function modelReviewerLine(record: ModelCompletionRecord): string {
  const r = record.reviewer;
  const answered = record.attempts.filter((a) => a.usage !== null);
  // A sum is known only when every response that came back reported its part.
  const sum = (values: (number | null | undefined)[]): number | null => (values.length > 0 && values.every((v) => typeof v === "number") ? (values as number[]).reduce((n, v) => n + v, 0) : null);
  const input = sum(answered.map((a) => a.usage?.inputTokens));
  const output = sum(answered.map((a) => a.usage?.outputTokens));
  const cost = sum(answered.map((a) => a.usage?.costUsd));
  const served = r.servedModels.length > 0 && (r.servedModels.length !== 1 || r.servedModels[0] !== r.model) ? ` (served by ${r.servedModels.join(", ")})` : "";
  const shown = (n: number | null) => (n === null ? "not reported" : n.toLocaleString("en-US"));
  return `Reviewed by a model reviewer, ${r.model}${served}, ${plural(r.calls, "call", "calls")}, tokens in ${shown(input)}, out ${shown(output)}, cost ${cost === null ? "not reported" : `$${cost.toFixed(2)}`}`;
}

// "1. Critical security: Search query built from request input"
const findingLabel = (f: ReportFinding, n: number) => `${n}. ${findingTitle(f)}`;

function findingLines(f: ReportFinding, n: number): Line[] {
  return [
    { kind: "item", text: findingLabel(f, n) },
    { kind: "field", label: "Where", text: location(f) },
    { kind: "field", label: "Problem", text: f.problem ?? f.description },
    { kind: "field", label: "Why it matters", text: f.consequence ?? "" },
    { kind: "field", label: "Fix", text: f.fix ?? "" },
    { kind: "field", label: "Source", text: f.source ?? "the reviewer" },
    ...f.notes.map((text): Line => ({ kind: "field", label: "Note", text })),
    ...(f.found_by ? [{ kind: "field" as const, label: "Found by", text: f.found_by.join(", ") }] : []),
  ];
}

function observationLines(report: Report): Line[] {
  const ordered = orderObservations(report);
  const omitted = observationsOmittedLine(report);
  if (ordered.length === 0 && omitted === null) return [];
  const out: Line[] = [{ kind: "heading", text: "Observations" }, { kind: "text", text: "These do not count toward the verdict." }];
  ordered.forEach((f, i) => {
    out.push(...findingLines(f, report.findings.length + i + 1));
    if (f.suggested_change) {
      out.push({ kind: "label", text: "Suggested change" }, { kind: "code", text: f.suggested_change });
    }
  });
  if (omitted) out.push({ kind: "text", text: omitted });
  return out;
}

function possibleHeading(report: Report): string {
  // wording: session
  return `Possible issues (${report.possible?.length ?? 0}), not counted`;
}

function possibleLines(report: Report): Line[] {
  const ordered = orderPossible(report);
  if (ordered.length === 0) return [];
  const out: Line[] = [{ kind: "heading", text: possibleHeading(report) }];
  const offset = report.findings.length + orderObservations(report).length;
  ordered.forEach((f, i) => {
    out.push(...findingLines(f, offset + i + 1));
    if (f.suggested_change) out.push({ kind: "label", text: "Suggested change" }, { kind: "code", text: f.suggested_change });
  });
  return out;
}

// A dropped candidate, as one item and its source.
function droppedLines(d: Report["dropped"][number]): Line[] {
  const cited = d.cited ? ` (see ${d.cited.file_path}:${d.cited.line_number})` : "";
  return [
    { kind: "item", text: `${d.candidate.id} at ${candidateLocation(d.candidate)}: ${d.reason}${cited}` },
    { kind: "field", label: "Source", text: d.candidate.token },
    ...(d.candidate.fixedIn?.length ? [{ kind: "field" as const, label: "Note", text: `Scanner: fixed in ${d.candidate.fixedIn.join(", ")}` }] : []),
  ];
}

// A scanner candidate no reviewer checked: where, the rule, the scanner,
// its severity and its message.
function uncheckedLines(c: Report["not_reviewed"][number]): Line[] {
  return [
    { kind: "item", text: `${c.id} at ${candidateLocation(c)}: ${c.ruleId}` },
    { kind: "field", label: "Scanner", text: c.source },
    { kind: "field", label: "Severity", text: c.reviewSeverity },
    { kind: "field", label: "Message", text: c.message },
  ];
}

function lines(report: Report): Line[] {
  const c = report.completion;
  const out: Line[] = [];
  const { files, additions, deletions } = report.stats;
  const changeLine = { kind: "text" as const, text: `Change ${report.change_id.slice(0, 12)} against ${report.base.ref}, ${plural(files, "file", "files")}, +${additions} -${deletions}` };
  const complete = c?.status === "complete";
  const ordered = orderFindings(report.findings);
  const summary: Line[] = hasSummary(report) ? [{ kind: "text", text: `Summary: ${report.summary}` }] : [];
  if (!complete) {
    // What is missing comes first; the findings that passed every check
    // follow under a heading that says the change was not fully reviewed.
    out.push({ kind: "verdict", text: INCOMPLETE, bad: true }, changeLine, ...summary, { kind: "heading", text: "Missing" });
    for (const m of c?.missing ?? ["no completion record"]) out.push({ kind: "item", text: m });
    out.push({ kind: "heading", text: `Findings so far (the change was not fully reviewed) (${ordered.length})` });
    if (ordered.length === 0) out.push({ kind: "text", text: "None yet." });
  } else {
    out.push({ kind: "verdict", text: verdictLine(report), bad: report.verdict === "blocked" }, changeLine, ...summary);
    const risk = impactLine(report);
    if (risk) out.push({ kind: "text", text: risk });
    const counts = [report.findings.length > 0 ? `${plural(report.findings.length, "finding", "findings")} (${severityBreakdown(report.findings.map((f) => f.severity))})` : "no findings"];
    counts.push(`${plural(report.dropped.length, "scanner candidate", "scanner candidates")} dropped`);
    if (report.below_threshold > 0) counts.push(`${report.below_threshold} below the severity threshold`);
    out.push({ kind: "text", text: `Counts: ${counts.join(", ")}` });
    out.push({ kind: "heading", text: `Findings (${ordered.length})` });
    if (ordered.length === 0) out.push({ kind: "text", text: "No findings on the changed lines." });
  }
  ordered.forEach((f, i) => out.push(...findingLines(f, i + 1)));
  out.push(...observationLines(report), ...possibleLines(report));
  if (report.outside_change.length > 0) {
    // Numbered after findings, observations and possible issues.
    const shown = ordered.length + orderObservations(report).length + orderPossible(report).length;
    out.push({ kind: "heading", text: `Outside the changed lines (${report.outside_change.length}), never counted` });
    report.outside_change.forEach((f, i) => out.push(...findingLines(f, shown + i + 1)));
  }
  // Only an incomplete review has them: what the scanners found, unchecked.
  if (!complete && report.not_reviewed.length > 0) {
    out.push({ kind: "heading", text: `${UNCHECKED} (${report.not_reviewed.length})` });
    out.push({ kind: "text", text: "The scanners found these. No reviewer checked them, so each may be a real problem or a false alarm." });
    for (const cand of report.not_reviewed) out.push(...uncheckedLines(cand));
  }

  if (report.dropped.length > 0) {
    out.push({ kind: "heading", text: `Dropped scanner candidates (${report.dropped.length})` });
    for (const d of report.dropped) out.push(...droppedLines(d));
  }
  if (report.second_dropped && report.second_dropped.length > 0) {
    out.push({ kind: "heading", text: `Dropped by the second reviewer (${report.second_dropped.length})` });
    for (const d of report.second_dropped) out.push(...droppedLines(d));
  }
  const disagreements = c?.contract === "openqodex-model-review-1" ? (c.disagreements ?? []) : [];
  if (disagreements.length > 0) {
    out.push({ kind: "heading", text: `Disagreements (${disagreements.length})` });
    for (const d of disagreements) out.push({ kind: "item", text: `${d.candidate}: raised by ${d.raisedBy}, dropped by ${d.droppedBy}${d.reason ? ` (${d.reason})` : ""}` });
  }
  if (report.notes && report.notes.length > 0) {
    out.push({ kind: "heading", text: "Notes" });
    for (const n of report.notes) out.push({ kind: "text", text: n });
  }
  if (report.low_confidence.length > 0) {
    out.push({ kind: "heading", text: "Below the confidence floor (not counted)" });
    for (const l of report.low_confidence) out.push({ kind: "item", text: `${l.file_path}: ${l.title} (confidence ${l.confidence}, floor ${l.floor})${lowConfidenceReason(l)}` });
  }
  if (c) {
    out.push({ kind: "heading", text: "Coverage" });
    if (c.trace_complete === false) {
      // Reads were not measured: say so, never "Files not read".
      const by = `not recorded by ${c.reviewer ? product(c.reviewer.driver) : "the reviewer"}`;
      out.push({ kind: "field", label: "Files the reviewer opened", text: by });
      out.push({ kind: "field", label: "Reads outside the snapshot", text: by });
    } else {
      out.push({ kind: "field", label: "Files the reviewer opened", text: c.coverage.files_read.length > 0 ? c.coverage.files_read.join(", ") : "none" });
      out.push({ kind: "field", label: notOpenedLabel(c.coverage), text: c.coverage.files_not_read.length > 0 ? c.coverage.files_not_read.join(", ") : "none" });
    }
    out.push({ kind: "field", label: "Changed ranges given to the reviewer", text: `${c.coverage.covered} of ${c.coverage.hunks}` });
  }
  if (report.not_reviewed_paths.length > 0) out.push({ kind: "field", label: "Left out, change too large", text: report.not_reviewed_paths.join(", ") });
  out.push({ kind: "text", text: `Scanners: ${coverageLine(report.scanners)}` });
  out.push({ kind: "text", text: c?.contract === "openqodex-model-review-1" ? modelReviewerLine(c) : reviewerLine(c?.reviewer ?? null) });
  out.push({ kind: "text", text: CLOSING });
  return out;
}

const hasSummary = (report: Report): boolean => report.summary !== null && report.summary.trim() !== "";

// Text kept as lines (a suggested change): every control character but the
// tab dropped from each line.
function codeLines(text: string): string[] {
  // Matching control characters is the point here.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
}

// What the screen shows after a review: the verdict, the change, the
// reviewer's summary, one line per finding (its number, severity, category,
// title and place), and the absolute paths of report.html and report.md.
// Each finding's problem, consequence and fix stay in those files, so the
// developer reads them and names what to fix. The numbers are the report's.
// A legacy review (no completion record) gets the same, with the line that
// names who reviewed.
export function renderReceipt(report: Report, opts: { html: string; md: string; color?: boolean }): string {
  const c = pc.createColors(opts.color === true);
  const record = report.completion;
  const complete = record === undefined || record.status === "complete";
  const ordered = orderFindings(report.findings);
  const { files, additions, deletions } = report.stats;
  const verdict = complete ? verdictLine(report) : INCOMPLETE;
  const out: string[] = [report.verdict === "blocked" || !complete ? c.red(c.bold(verdict)) : c.green(c.bold(verdict))];
  if (report.reviewed_by && record === undefined) out.push(display(report.reviewed_by));
  out.push(display(`Change ${report.change_id.slice(0, 12)} against ${report.base.ref}, ${plural(files, "file", "files")}, +${additions} -${deletions}`));
  if (hasSummary(report)) out.push(display(`Summary: ${report.summary}`));
  if (!complete) {
    out.push(display(`Missing: ${(record?.missing ?? ["no completion record"]).join("; ")}`));
    out.push(`Findings so far (the change was not fully reviewed): ${ordered.length === 0 ? "none" : ordered.length}`);
  } else if (ordered.length === 0) {
    out.push("No findings on the changed lines.");
  }
  ordered.forEach((f, i) => out.push(display(`${findingLabel(f, i + 1)} (${location(f)})`)));
  const observations = orderObservations(report);
  const omitted = observationsOmittedLine(report);
  if (observations.length > 0 || omitted) {
    out.push("Observations (do not count toward the verdict):");
    observations.forEach((f, i) => out.push(display(`${findingLabel(f, ordered.length + i + 1)} (${location(f)})`)));
    if (omitted) out.push(omitted);
  }
  const possible = orderPossible(report);
  if (possible.length > 0) {
    out.push(possibleHeading(report));
    possible.forEach((f, i) => out.push(display(`${findingLabel(f, ordered.length + observations.length + i + 1)} (${location(f)})`)));
  }
  if (!complete && report.not_reviewed.length > 0) {
    // One line each: the developer sees what the scanners found, unchecked.
    out.push(`${UNCHECKED} (${report.not_reviewed.length}):`);
    for (const cand of report.not_reviewed) out.push(display(`${cand.id} at ${candidateLocation(cand)}: ${cand.source} ${cand.ruleId} (${cand.reviewSeverity}): ${firstLine(cand.message)}`));
  } else if (report.not_reviewed.length > 0) {
    out.push(`${plural(report.not_reviewed.length, "scanner candidate was", "scanner candidates were")} not checked by the reviewer and count toward the verdict; the report lists them.`);
  }
  for (const note of report.notes ?? []) if (/^Convention(?:s supplied| omitted| transformed):/.test(note)) out.push(display(note));
  out.push(`Report: ${opts.html}`, `Markdown: ${opts.md}`);
  return `${out.join("\n")}\n`;
}

// The named findings in full, for the agent to fix: each one's number,
// severity, category and title, then where, the problem, why it matters,
// the fix, any suggested change and the source. `numbers` are the receipt's
// and must exist; they are printed in the order given.
export function renderFindingDetails(report: Report, numbers: number[]): string {
  const ordered = [...orderFindings(report.findings), ...orderObservations(report), ...orderPossible(report)];
  const out: string[] = [];
  let observations = false;
  let possible = false;
  for (const n of numbers) {
    const f = ordered[n - 1];
    if (f === undefined) continue;
    const possibleItem = n > report.findings.length + (report.observations?.length ?? 0);
    const observation = n > report.findings.length && !possibleItem;
    if (possibleItem && !possible) {
      out.push(possibleHeading(report));
      possible = true;
    }
    if (observation && !observations) {
      out.push("Observations (do not count toward the verdict):");
      observations = true;
    }
    out.push(display(findingLabel(f, n)));
    const fields = f.problem !== undefined || observation || possibleItem ? findingLines(f, n).slice(1) : [{ kind: "field" as const, label: "Where", text: location(f) }, { kind: "field" as const, label: "Description", text: f.description }, { kind: "field" as const, label: "Source", text: f.source ?? "the reviewer" }];
    for (const l of fields) if (l.kind === "field") out.push(`   ${l.label}: ${display(l.text)}`);
    if (f.suggested_change !== null && f.suggested_change.trim() !== "") {
      out.push("   Suggested change:");
      for (const l of codeLines(f.suggested_change)) out.push(`      ${l}`);
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// Text for markdown that cannot make structure. The reviewer read a change
// that may be hostile, and paths come from the repository, so every string
// first becomes one line with no control character (`display`), then every
// character markdown or HTML gives meaning to is escaped (`escapeMarkdown`).
export function markdownText(text: string): string {
  return escapeMarkdown(display(text));
}

function renderLines(lines: Line[], opts: { format: "terminal" | "markdown"; color?: boolean }): string {
  const c = pc.createColors(opts.format === "terminal" && opts.color === true);
  const out: string[] = [];
  const md = opts.format === "markdown";
  for (const l of lines) {
    if (l.kind === "code") {
      const code = codeLines(l.text);
      const fence = "`".repeat((l.text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 3));
      if (md) out.push("", [fence, ...code, fence].join("\n"), "");
      else out.push(code.map((line) => `   ${line}`).join("\n"));
      continue;
    }
    // Terminal: one line, no control character. Markdown: also escaped.
    const text = md ? markdownText(l.text) : display(l.text);
    if (l.kind === "label") {
      out.push(md ? `- **${text}:**` : `   ${c.dim(`${text}:`)}`);
      continue;
    }
    if (l.kind === "field") {
      out.push(md ? `- **${l.label}:** ${text}` : `   ${c.dim(`${l.label}:`)} ${text}`);
      continue;
    }
    if (md) {
      if (l.kind === "verdict") out.push(`# ${text}`, "");
      else if (l.kind === "heading") out.push("", `## ${text}`, "");
      else if (l.kind === "item") out.push("", `### ${text}`, "");
      else out.push(text, "");
      continue;
    }
    if (l.kind === "verdict") out.push(l.bad ? c.red(c.bold(text)) : c.green(c.bold(text)));
    else if (l.kind === "heading") out.push("", c.bold(text));
    else if (l.kind === "item") out.push(`${text}`);
    else out.push(text);
  }
  return `${out.filter((line, i) => line !== "" || out[i - 1] !== "").join("\n").trim()}\n`;
}

// The legacy markdown report uses an unnumbered table for findings.
export function renderObservations(report: Report): string {
  const lines = observationLines(report);
  if (lines.length === 0) return "";
  lines.splice(1, 0, { kind: "text", text: "The numbers continue the receipt's numbering." });
  return renderLines(lines, { format: "markdown" });
}

export function renderReview(report: Report, opts: { format: "terminal" | "markdown"; color?: boolean }): string {
  return renderLines(lines(report), opts);
}
