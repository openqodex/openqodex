import pc from "picocolors";
import type { ImpactEdge, Report, ReportFinding } from "../types.js";
import {
  SEVERITIES_DESC,
  candidateLocation,
  coverageLine,
  display,
  findingTitle,
  firstLine,
  location,
  lowConfidenceReason,
  observationsOmittedLine,
  orderObservations,
  orderPossible,
  sourceLabel,
  verdictLine,
} from "./common.js";

// Every value that came from a scanner or the agent goes through `display`
// before the renderer adds its own colour codes.
function findingLines(f: ReportFinding, c: ReturnType<typeof pc.createColors>, observation = false): string[] {
  const title = observation ? findingTitle(f) : f.title;
  const lines = [`  ${c.bold(display(location(f)))}  ${display(title)}`];
  const desc = display(firstLine(f.description));
  if (desc) lines.push(`    ${desc}`);
  // A finding from the agent's own reading has no source to name.
  if (f.source !== null || f.origin !== "agent") lines.push(`    ${c.dim(display(sourceLabel(f)))}`);
  return lines;
}

// The code graph's one line under the verdict; null when the graph was off.
// The markdown report prints the same line.
export function impactLine(report: Report): string | null {
  const impact = report.impact;
  if (!impact || impact.status === "off") return null;
  if (impact.status === "skipped" || impact.status === "failed") {
    return `Blast radius: not traced, ${impact.status === "failed" ? "the code graph failed" : "skipped"} (${impact.reasons[0] ?? impact.status})`;
  }
  const last = (edges: ImpactEdge[]) => edges[edges.length - 1] as ImpactEdge;
  const callers = new Set(impact.callers.map((p) => last(p.edges).from)).size;
  const files = new Set(impact.callers.flatMap((p) => last(p.edges).sites.map((s) => s.file))).size;
  const moved = new Set(impact.symbols.filter((s) => s.movedTo).map((s) => s.id));
  const removed = impact.removed.filter((id) => !moved.has(id)).length;
  const parts = [`${impact.touched.length} ${impact.touched.length === 1 ? "symbol" : "symbols"} touched`];
  if (removed > 0) parts.push(`${removed} removed`);
  if (impact.removed.length > removed) parts.push(`${impact.removed.length - removed} moved`);
  const names = impact.exports?.length ?? 0;
  if (names > 0) parts.push(`${names} public ${names === 1 ? "name" : "names"} changed`);
  parts.push(`${callers} ${callers === 1 ? "caller" : "callers"} in ${files} ${files === 1 ? "file" : "files"}`);
  const partial = impact.status === "partial" ? ", partial graph" : "";
  // What the graph could not see: the brief and the packet say which calls.
  const floor = impact.unknown?.floor && impact.touched.length + impact.removed.length > 0 ? ", a floor: some calls the graph could not see" : "";
  return `Blast radius: risk ${impact.risk ?? "none"} (${parts.join(", ")}${partial}${floor})`;
}

export function renderTerminal(report: Report, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  const verdict = verdictLine(report);
  const out: string[] = [report.verdict === "blocked" ? c.red(c.bold(verdict)) : c.green(c.bold(verdict))];
  if (report.reviewed_by) out.push(display(report.reviewed_by));
  const risk = impactLine(report);
  if (risk) out.push(display(risk));

  for (const severity of SEVERITIES_DESC) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const label = `${severity[0]?.toUpperCase()}${severity.slice(1)} (${group.length})`;
    out.push("", severity === "critical" || severity === "major" ? c.red(label) : c.yellow(label));
    for (const f of group) out.push(...findingLines(f, c));
  }

  const observations = orderObservations(report);
  const omitted = observationsOmittedLine(report);
  if (observations.length > 0 || omitted) {
    out.push("", "Observations (do not count toward the verdict):");
    for (const f of observations) out.push(...findingLines(f, c, true));
    if (omitted) out.push(omitted);
  }

  const possible = orderPossible(report);
  if (possible.length > 0) {
    // wording: session
    out.push("", "Possible issues (not counted, confidence under the floor)");
    for (const f of possible) out.push(...findingLines(f, c, true));
  }

  if (report.outside_change.length > 0) {
    out.push("", "Outside the changed lines (not counted)");
    for (const f of report.outside_change) out.push(...findingLines(f, c));
  }
  if (report.not_reviewed.length > 0) {
    out.push("", "Not reviewed by the agent");
    for (const cand of report.not_reviewed) {
      const where = display(`${cand.id} [${cand.token}] ${candidateLocation(cand)}`);
      out.push(`  ${where} (${cand.reviewSeverity}) ${display(firstLine(cand.message))}`);
    }
  }
  if (report.dropped.length > 0) {
    out.push("", "Dropped by the agent");
    for (const d of report.dropped) {
      out.push(`  ${display(`${d.candidate.id} [${d.candidate.token}] ${candidateLocation(d.candidate)}: ${firstLine(d.reason)}`)}`);
    }
  }
  if (report.low_confidence.length > 0) {
    out.push("", "Below the confidence floor (not counted)");
    for (const l of report.low_confidence) {
      out.push(`  ${display(l.file_path)}  ${display(l.title)} (confidence ${l.confidence}, floor ${l.floor})${lowConfidenceReason(l)}`);
    }
  }
  if (report.not_reviewed_paths.length > 0) {
    out.push("", `Not reviewed, change too large: ${display(report.not_reviewed_paths.join(", "))}`);
  }
  out.push("", c.dim(coverageLine(report.scanners)));
  return `${out.join("\n")}\n`;
}
