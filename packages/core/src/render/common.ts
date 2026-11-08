// Wording shared by the renderers and the brief, so the terminal, the
// markdown report and the brief say the same thing the same way.
import { DISABLED_REASON } from "../config.js";
import { SEVERITIES, atOrAbove } from "../severity.js";
import type { Candidate, Report, ReportFinding, ScannerRunSummary, Severity } from "../types.js";

// Highest first, the order findings are shown in.
export const SEVERITIES_DESC: readonly Severity[] = [...SEVERITIES].reverse();

// The findings in the one order every output numbers them by: highest
// severity first, then as the report holds them. Finding n is element n - 1.
export function orderFindings<F extends { severity: Severity }>(findings: readonly F[]): F[] {
  return SEVERITIES_DESC.flatMap((s) => findings.filter((f) => f.severity === s));
}

// Observations keep the severity order, then the most confident first.
export function orderObservations(report: Report): ReportFinding[] {
  return orderFindings([...(report.observations ?? [])].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1)));
}

export function orderPossible(report: Report): ReportFinding[] {
  return orderFindings(report.possible ?? []);
}

export function observationsOmittedLine(report: Report): string | null {
  const omitted = report.observations_omitted ?? 0;
  return omitted > 0 ? `${plural(omitted, "more observation was", "more observations were")} left out.` : null;
}

export function lowConfidenceReason(entry: Report["low_confidence"][number]): string {
  return entry.reason ? ` (${entry.reason})` : "";
}

export function findingTitle(f: ReportFinding): string {
  return `${f.severity[0]?.toUpperCase()}${f.severity.slice(1)} ${f.category}: ${f.title}`;
}

// Text from a scanner or the agent made safe for a terminal: every run of
// whitespace (line breaks included) becomes one space, and every remaining
// C0 or C1 control character is dropped, so nothing can move the cursor,
// clear the screen or start a new line.
export function display(text: string): string {
// Matching control characters is the point here.
// oxlint-disable-next-line no-control-regex
  return text.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

// Every character markdown or HTML gives meaning to, escaped with a
// backslash: no heading, list, link, image, HTML tag, table cell, code span,
// fence or emphasis can start inside the text. A reader of the rendered page
// sees the same words.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()!<>#|~]/g, (c) => `\\${c}`);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// A scanner with nothing to check is idle; every other scanner either ran
// or was left out.
function scannerCoverage(scanners: ScannerRunSummary[]) {
  const ran = scanners.filter((s) => s.status === "ran").length;
  const idle = scanners.filter((s) => s.status === "no_matching_files").length;
  const out = scanners.filter((s) => s.status !== "ran" && s.status !== "no_matching_files");
  return { ran, idle, out };
}

// "7 scanners ran, 4 had nothing to check, 2 not included (brakeman: needs
// Ruby 2.7 or newer; semgrep: first run only, still installing)"
export function coverageLine(scanners: ScannerRunSummary[]): string {
  const { ran, idle, out } = scannerCoverage(scanners);
  const parts = [`${plural(ran, "scanner", "scanners")} ran`];
  if (idle > 0) parts.push(`${idle} had nothing to check`);
  if (out.length > 0) {
    const reasons = out.map((s) => display(`${s.scanner}: ${s.reason ?? s.status.replace(/_/g, " ")}`)).join("; ");
    parts.push(`${out.length} not included (${reasons})`);
  }
  return parts.join(", ");
}

// The severities of everything that counts toward the verdict: findings on
// changed lines and candidates the agent left unreviewed.
export function countedSeverities(report: Report): Severity[] {
  return [...report.findings.map((f) => f.severity), ...report.not_reviewed.map((c) => c.reviewSeverity)];
}

// "1 critical, 2 minor"
export function severityBreakdown(severities: Severity[]): string {
  return SEVERITIES_DESC.map((s) => [s, severities.filter((x) => x === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

// Why a scanner left out of a run did not run, in the verdict's words. A
// "disabled" entry here was not switched off in the config: the four network
// scanners record a reason that starts "offline, " when --offline skips them,
// and any other skip (folders held back) is "skipped".
function gapWord(s: ScannerRunSummary): string {
  if (s.status !== "disabled") return s.status.replace(/_/g, " ");
  return s.reason?.startsWith("offline, ") ? "skipped offline" : "skipped";
}

export function verdictLine(report: Report): string {
  const counted = countedSeverities(report);
  const threshold = report.block_on_severity;
  const what = (n: number) => plural(n, "finding", "findings");
  // A scanner switched off in the config is the developer's choice, not a
  // gap: it is in neither number. The coverage line still lists it.
  const { ran, out: left } = scannerCoverage(report.scanners);
  const out = left.filter((s) => !(s.status === "disabled" && s.reason === DISABLED_REASON));
  const ofSelected = plural(ran + out.length, "scanner", "scanners");
  const clause = out.length > 0 ? `; ${out.length} of ${ofSelected} did not run` : "";
  if (report.verdict === "blocked" && threshold) {
    const over = counted.filter((s) => atOrAbove(s, threshold));
    return `Blocked: ${what(over.length)} at or above ${threshold} (${severityBreakdown(counted)})${clause}`;
  }
  if (counted.length === 0) {
    if (out.length === 0) return "Passed: no findings";
    const reasons = ["not installed", "failed", "installing", "skipped offline", "skipped", "untrusted"]
      .map((word) => [word, out.filter((s) => gapWord(s) === word).length] as const)
      .filter(([, n]) => n > 0)
      .map(([word, n]) => `${n} ${word}`)
      .join(", ");
    return `No findings from ${ran} of ${ofSelected}; ${out.length} did not run (${reasons})`;
  }
  if (!threshold) return `Passed with warnings: ${what(counted.length)} (${severityBreakdown(counted)})${clause}`;
  return `Passed: nothing at or above ${threshold}, ${what(counted.length)} below it (${severityBreakdown(counted)})${clause}`;
}

// The coverage label for files the reviewer did not open. With every changed
// range given to the reviewer, their changed lines were in front of it
// without opening them, which "not read" would hide.
export function notOpenedLabel(cov: { covered: number; hunks: number }): string {
  return cov.covered === cov.hunks ? "Files not opened (their changed lines were in the brief)" : "Files not opened";
}

export function location(f: { file_path: string; line_number: number; line_end: number }): string {
  return f.line_end > f.line_number ? `${f.file_path}:${f.line_number}-${f.line_end}` : `${f.file_path}:${f.line_number}`;
}

export function candidateLocation(c: Candidate): string {
  return c.lineEnd > c.lineStart ? `${c.filePath}:${c.lineStart}-${c.lineEnd}` : `${c.filePath}:${c.lineStart}`;
}

export function sourceLabel(f: ReportFinding): string {
  return f.source ?? (f.origin === "agent" ? "agent" : "scanner");
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}
