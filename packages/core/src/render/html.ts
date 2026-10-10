// report.html: one self-contained page beside report.md, built like a pull
// request review. The verdict first, then each changed file as a unified
// diff with each finding as a card under its line, then the evidence:
// accounting, the scanners and the blast radius. A pure function of the
// report and its display model (display.ts).
//
// The markup is a port of the designer's reference renderer (render.py; its
// output for the sample is test/fixtures/report-html/expected.html, and
// html.test.ts proves the port renders the same elements, classes and text).
// The stylesheet is html-style.ts.
//
// The page quotes code under review and text from the reviewer and the
// scanners, so every string from the report or the display goes through
// text() (one line), block() (keeps line breaks, for code), paragraphs(),
// num() or word() before it reaches the page. Ids are generated, never taken
// from a path. There is no script, no inline style attribute and nothing
// that loads; the page's policy allows nothing but its own stylesheet, by
// hash. Secrets are redacted in the display model before this runs.
import { createHash } from "node:crypto";
import type { Candidate, ImpactEdge, ImpactSummary, Report, ReportFinding } from "../types.js";
import type { Display, DisplayFile, DisplayHunk } from "./display.js";
import { REPORT_CSS } from "./html-style.js";
import { modelReviewerLine, product } from "./review.js";

export type HtmlInput = {
  report: Report;
  // null: the code was not saved (a saved display that did not match); the
  // findings are shown by file without it.
  display: Display | null;
  // The openqodex version that wrote the page.
  version?: string;
  // The report.md path the footer tells the developer to name to the agent.
  reportMd?: string;
};

// ---------- vocabulary (mirrors common.ts) ----------

const SEVERITIES_DESC = ["critical", "major", "minor", "nitpick", "info"];
const SCANNER_STATUS_WORDS: Record<string, string> = {
  ran: "ran",
  no_matching_files: "no matching files",
  not_installed: "not installed",
  installing: "installing",
  failed: "failed",
  disabled: "disabled",
  untrusted: "untrusted",
};
const FILE_STATUS_WORDS: Record<string, string> = { added: "added", modified: "modified", deleted: "deleted", renamed: "renamed" };
const CLOSING = "Made by Qodex: review on every pull request at ";
const CLOSING_URL = "https://qodex.ai";

// Control characters other than tab and line break; carriage returns and
// the other line separators become line breaks first.
// Matching control characters is the point here.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// oxlint-disable-next-line no-control-regex
const LINE_BREAK = /\r\n|[\r\u000b\u000c\u0085\u2028\u2029]/g;

// ---------- escaping: every untrusted string goes through one of these ----------

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

// HTML-escapes a value for text or an attribute. Never called twice on one value.
function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

// One line of untrusted text: breaks and control characters removed, then escaped.
function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  const one = String(value).replace(LINE_BREAK, " ").replace(/\n/g, " ").replace(/\t/g, " ");
  return esc(one.replace(/ {2,}/g, " ").replace(CONTROL, "").trim());
}

// Untrusted text that keeps its line breaks, for <pre> and code.
function block(value: unknown): string {
  if (value === null || value === undefined) return "";
  return esc(String(value).replace(LINE_BREAK, "\n").replace(CONTROL, ""));
}

// Untrusted prose, one <p> per line that is not empty.
function paragraphs(value: unknown): string {
  const out: string[] = [];
  for (const line of String(value ?? "").replace(LINE_BREAK, "\n").split("\n")) {
    if (line.trim() !== "") out.push(`<p>${esc(line.trim().replace(CONTROL, ""))}</p>`);
  }
  return out.join("\n");
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// A number to `places` decimals, rounding an exact tie to even, as the
// reference renderer (Python's format) does: 0.25 is 0.2, never 0.3.
function fixed(x: number, places: number): string {
  const exact = x.toFixed(Math.min(100, places + 40));
  const [whole = "0", frac = ""] = exact.split(".");
  if (/^50*$/.test(frac.slice(places))) {
    const last = places > 0 ? frac[places - 1] : whole.at(-1);
    if (Number(last) % 2 === 0) return places > 0 ? `${whole}.${frac.slice(0, places)}` : whole;
  }
  return x.toFixed(places);
}

function grouped(x: number, places: number): string {
  const [whole = "0", frac] = fixed(x, places).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  return `${sign}${group(whole.replace("-", ""))}${frac !== undefined ? `.${frac}` : ""}`;
}

// A number from the data; anything else is an empty string.
function num(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return esc(Number.isInteger(value) ? grouped(value, 0) : grouped(value, 2));
}

function plural(n: number, one: string, many?: string): string {
  return `${grouped(n, 0)} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

// A fixed-vocabulary value: the table's word, else the value itself, escaped.
function word(value: unknown, table: Record<string, string>): string {
  const key = String(value);
  if (Object.hasOwn(table, key)) return esc(table[key]);
  return text(key.replace(/_/g, " "));
}

const sevClass = (severity: unknown): string => (SEVERITIES_DESC.includes(severity as string) ? `sev-${severity as string}` : "sev-unknown");

const shortId = (value: unknown): string => text(String(value ?? "").slice(0, 12));

function when(iso: unknown): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return text(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return esc(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`);
}

function seconds(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) ? esc(`${fixed(n / 1000, 1)} s`) : "";
}

// ---------- derived facts (mirror verdictLine, impactLine, coverageLine) ----------

type Numbered = [number, ReportFinding];

function orderedFindings(report: Report): ReportFinding[] {
  const findings = report.findings ?? [];
  return [...SEVERITIES_DESC.flatMap((s) => findings.filter((f) => f.severity === s)), ...findings.filter((f) => !SEVERITIES_DESC.includes(f.severity))];
}

function countedSeverities(report: Report): string[] {
  return [...(report.findings ?? []).map((f) => f.severity as string), ...(report.not_reviewed ?? []).map((c) => c.reviewSeverity as string)];
}

function breakdown(severities: string[]): string {
  return SEVERITIES_DESC.map((s) => [s, severities.filter((x) => x === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

const atOrAbove = (severity: string, threshold: string): boolean => SEVERITIES_DESC.includes(severity) && SEVERITIES_DESC.includes(threshold) && SEVERITIES_DESC.indexOf(severity) <= SEVERITIES_DESC.indexOf(threshold);

function isComplete(report: Report): boolean {
  if (report.verdict === "incomplete") return false;
  return report.completion === undefined || report.completion === null || report.completion.status === "complete";
}

function verdictSentence(report: Report): string {
  const counted = countedSeverities(report);
  const threshold = report.block_on_severity;
  const what = (n: number) => plural(n, "finding");
  if (report.verdict === "blocked" && threshold) {
    const over = counted.filter((s) => atOrAbove(s, threshold));
    return `Blocked: ${what(over.length)} at or above ${threshold} (${breakdown(counted)})`;
  }
  if (counted.length === 0) return "Passed: no findings";
  if (!threshold) return `Passed with warnings: ${what(counted.length)} (${breakdown(counted)})`;
  return `Passed: nothing at or above ${threshold}, ${what(counted.length)} below it (${breakdown(counted)})`;
}

function verdictShort(report: Report): string {
  if (!isComplete(report)) return "Review incomplete";
  if (report.verdict === "blocked") return "Blocked";
  return countedSeverities(report).length > 0 ? "Passed with warnings" : "Passed";
}

function thresholdSentence(report: Report): string {
  const threshold = report.block_on_severity;
  return threshold !== null && SEVERITIES_DESC.includes(threshold) ? `blocks at ${threshold} and above` : "none set, findings warn and never block";
}

type ImpactSymbolView = ImpactSummary["symbols"][number];

function impactCounts(impact: ImpactSummary): { callers: number; files: number; removed: string[]; moved: string[]; symbols: Map<string, ImpactSymbolView> } {
  const callers = new Set<string>();
  const files = new Set<string>();
  for (const path of impact.callers ?? []) {
    const edges: readonly ImpactEdge[] = path.edges ?? [];
    if (edges.length === 0) continue;
    const last = edges[edges.length - 1]!;
    callers.add(last.from);
    for (const site of last.sites ?? []) files.add(site.file);
  }
  const symbols = new Map((impact.symbols ?? []).map((s) => [s.id, s]));
  const moved = (impact.removed ?? []).filter((id) => symbols.get(id)?.movedTo);
  const removed = (impact.removed ?? []).filter((id) => !symbols.get(id)?.movedTo);
  return { callers: callers.size, files: files.size, removed, moved, symbols };
}

function impactSentence(report: Report): string | null {
  const impact = report.impact;
  if (!impact || impact.status === "off") return null;
  if (impact.status === "skipped" || impact.status === "failed") {
    const why = (impact.reasons ?? [])[0] ?? impact.status;
    const how = impact.status === "failed" ? "the code graph failed" : "skipped";
    return `not traced, ${how} (${why})`;
  }
  const c = impactCounts(impact);
  const parts = [`${plural((impact.touched ?? []).length, "symbol")} touched`];
  if (c.removed.length > 0) parts.push(`${c.removed.length} removed`);
  if (c.moved.length > 0) parts.push(`${c.moved.length} moved`);
  parts.push(`${plural(c.callers, "caller")} in ${plural(c.files, "file")}`);
  const partial = impact.status === "partial" ? ", partial graph" : "";
  return `risk ${impact.risk ?? "none"} (${parts.join(", ")}${partial})`;
}

function coverageSentence(scanners: Report["scanners"]): string {
  const ran = scanners.filter((s) => s.status === "ran").length;
  const idle = scanners.filter((s) => s.status === "no_matching_files").length;
  const out = scanners.filter((s) => s.status !== "ran" && s.status !== "no_matching_files");
  const parts = [`${plural(ran, "scanner")} ran`];
  if (idle > 0) parts.push(`${idle} had nothing to check`);
  if (out.length > 0) parts.push(`${out.length} not included (${out.map((s) => `${s.scanner}: ${s.reason || s.status.replace(/_/g, " ")}`).join("; ")})`);
  return parts.join(", ");
}

function reviewerSentence(report: Report): string {
  if (report.reviewed_by) return report.reviewed_by;
  if (report.completion?.contract === "openqodex-model-review-1") return modelReviewerLine(report.completion);
  const r = report.completion?.reviewer;
  if (!r) return "not recorded in this report";
  const usage = r.usage ?? { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null };
  const parts = [`${r.driver} ${r.version}`, `${fixed((r.duration_ms ?? 0) / 1000, 0)} s`, plural(usage.turns ?? 0, "turn")];
  if ((r.rounds ?? 1) > 1) parts.push(plural(r.rounds - 1, "correction round"));
  if (usage.input_tokens !== null) parts.push(`${grouped(usage.input_tokens, 0)} tokens in`);
  if (usage.output_tokens !== null) parts.push(`${grouped(usage.output_tokens, 0)} out`);
  if (usage.cost_usd !== null) parts.push(`$${fixed(usage.cost_usd, 2)}`);
  return parts.join(", ");
}

function location(f: { file_path: string; line_number: number; line_end?: number | null }): string {
  const start = f.line_number;
  const end = f.line_end || f.line_number;
  return `${f.file_path}:${Number.isInteger(start) && Number.isInteger(end) && end > start ? `${start}-${end}` : `${start}`}`;
}

function candidateLocation(c: Candidate): string {
  const start = c.lineStart;
  const end = c.lineEnd;
  return `${c.filePath}:${Number.isInteger(start) && Number.isInteger(end) && end > start ? `${start}-${end}` : `${start}`}`;
}

// ---------- diff model ----------

type Row = { sign: "+" | "-" | " "; old: number | null; new: number | null; text: string };
type Hunk = { header: string; context: string; rows: Row[] };
// One file of the page: a file of the display, or one that holds a finding
// or a dropped candidate and has no display entry.
type Entry = { path: string; old_path: string | null; status: string; omitted: string | null; hunks: Hunk[] };

function numberHunk(h: DisplayHunk, excerpt: boolean): Hunk {
  const rows: Row[] = h.rows.map((r) => ({ sign: r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ", old: r.old, new: r.new, text: r.text }));
  const olds = rows.filter((r) => r.old !== null).length;
  const news = rows.filter((r) => r.new !== null).length;
  const first = rows.find((r) => r.new !== null)?.new ?? h.new_start;
  const header = excerpt ? `lines ${first} to ${first + news - 1}` : `@@ -${h.old_start},${olds} +${h.new_start},${news} @@`;
  return { header, context: h.section ?? "", rows };
}

function fileCounts(hunks: Hunk[]): [number, number] {
  const rows = hunks.flatMap((h) => h.rows);
  return [rows.filter((r) => r.sign === "+").length, rows.filter((r) => r.sign === "-").length];
}

function entryOf(f: DisplayFile, excerpt: boolean): Entry {
  return { path: f.path, old_path: f.old_path, status: f.status, omitted: f.note, hunks: f.hunks.map((h) => numberHunk(h, excerpt)) };
}

// ---------- fragments ----------

const severityBadge = (severity: unknown): string => `<span class="severity ${sevClass(severity)}">${text(severity)}</span>`;

function findingCard(f: ReportFinding, n: number | string): string {
  const sev = sevClass(f.severity);
  const source = f.source || (f.origin === "agent" ? "the reviewer" : "scanner");
  const rows: string[] = [];
  const problem = f.problem || f.description;
  if (problem) rows.push(`<dt>Problem</dt><dd>${paragraphs(problem)}</dd>`);
  if (f.consequence) rows.push(`<dt>Why it matters</dt><dd>${paragraphs(f.consequence)}</dd>`);
  if (f.fix) rows.push(`<dt>Fix</dt><dd>${paragraphs(f.fix)}</dd>`);
  for (const note of f.notes ?? []) rows.push(`<dt>Note</dt><dd><p>${text(note)}</p></dd>`);
  const suggested = f.suggested_change ? `<details class="suggested"><summary>Suggested change</summary><pre>${block(f.suggested_change)}</pre></details>` : "";
  const conf = typeof f.confidence === "number" ? `<span class="finding-confidence">confidence ${num(f.confidence)}</span>` : "";
  const candidate = f.candidate ? `<span class="finding-candidate">raises ${text(f.candidate)}</span>` : "";
  return `<article class="finding-card ${sev}" id="f${n}">
<header class="finding-head">
<a class="finding-id" href="#index-f${n}">${n}</a>
${severityBadge(f.severity)}
<span class="category">${text(f.category)}</span>
<h4 class="finding-title">${text(f.title)}</h4>
<span class="finding-where">${text(location(f))}</span>
</header>
<dl class="finding-body">
${rows.join("")}
</dl>
${suggested}
<footer class="finding-foot">
<span class="finding-source">Source: ${text(source)}</span>
${conf}
${candidate}
<a class="finding-back" href="#index-f${n}">Back to the findings list</a>
</footer>
</article>`;
}

type Dropped = Report["dropped"][number];

// Candidates the reviewer dropped on this line, collapsed and muted.
function droppedBlock(items: Dropped[], byCandidate: Map<string, number>): string {
  const parts = items.map((d) => {
    const c = d.candidate;
    const covered = byCandidate.get(c.id);
    const raised = covered !== undefined ? ` <span class="dropped-covered">(raised as <a href="#f${covered}">${covered}</a>)</span>` : "";
    return `<li><span class="dropped-id">${text(c.id)}</span> <span class="dropped-token">${text(c.token)}</span> ${text(d.reason)}${raised}</li>`;
  });
  const ids = items.map((d) => text(d.candidate.id)).join(", ");
  return `<details class="dropped"><summary>Dropped here: ${ids}</summary><ul class="dropped-list">${parts.join("")}</ul></details>`;
}

function diffTable(hunks: Hunk[], cardsByLine: Map<number, string[]>, droppedByLine: Map<number, Dropped[]>, byCandidate: Map<string, number>, flagged: Map<number, string>): string {
  const out = ['<table class="diff"><colgroup><col class="col-num"><col class="col-num"><col class="col-sign"><col class="col-code"></colgroup>'];
  for (const h of hunks) {
    out.push('<tbody class="hunk">');
    out.push(`<tr class="hunk-header"><td class="num" colspan="2"></td><td class="code" colspan="2">${esc(h.header)} <span class="hunk-context">${text(h.context)}</span></td></tr>`);
    for (const r of h.rows) {
      const kind = r.sign === "+" ? "line-add" : r.sign === "-" ? "line-del" : "line-ctx";
      const flag = r.new !== null && flagged.has(r.new) ? ` line-flagged ${flagged.get(r.new)}` : "";
      const old = r.old !== null ? ` data-n="${r.old}"` : "";
      const nu = r.new !== null ? ` data-n="${r.new}"` : "";
      out.push(`<tr class="line ${kind}${flag}"><td class="num num-old"${old}></td><td class="num num-new"${nu}></td><td class="sign">${esc(r.sign.trim() || " ")}</td><td class="code">${block(r.text)}</td></tr>`);
      if (r.new === null) continue;
      for (const card of cardsByLine.get(r.new) ?? []) out.push(`<tr class="finding-row"><td colspan="4">${card}</td></tr>`);
      cardsByLine.delete(r.new);
      const dropped = droppedByLine.get(r.new) ?? [];
      droppedByLine.delete(r.new);
      if (dropped.length > 0) out.push(`<tr class="dropped-row"><td colspan="4">${droppedBlock(dropped, byCandidate)}</td></tr>`);
    }
    out.push("</tbody>");
  }
  out.push("</table>");
  return out.join("\n");
}

// The shown lines a finding's range covers, marked with the severity of the
// first finding that covers each (findings come highest severity first).
// Only lines on the page are visited: a range of twenty million lines over
// one shown line costs one step, and a line already marked is skipped
// through `next`, so all ranges together cost the shown lines once.
function flagger(lines: number[]): { flagged: Map<number, string>; range: (from: number, to: number, cls: string) => void } {
  const flagged = new Map<number, string>();
  const next = Array.from({ length: lines.length + 1 }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (next[root] !== root) root = next[root]!;
    while (next[i] !== root) {
      const up = next[i]!;
      next[i] = root;
      i = up;
    }
    return root;
  };
  const range = (from: number, to: number, cls: string): void => {
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = find(lo); i < lines.length && lines[i]! <= to; i = find(i + 1)) {
      flagged.set(lines[i]!, cls);
      next[i] = i + 1;
    }
  };
  return { flagged, range };
}

function fileSection(entry: Entry, index: number, findings: Numbered[], dropped: Dropped[], byCandidate: Map<string, number>): string {
  const path = entry.path;
  const hunks = entry.hunks;
  const [adds, dels] = fileCounts(hunks);
  const status = word(entry.status, FILE_STATUS_WORDS);
  const old = entry.old_path ? `<span class="file-old">renamed from ${text(entry.old_path)}</span>` : "";
  const count = findings.length > 0 ? `<span class="file-findings">${plural(findings.length, "finding")}</span>` : '<span class="file-findings file-findings-none">no findings</span>';
  const counts = hunks.length > 0 ? `<span class="file-counts"><span class="added">+${adds}</span> <span class="removed">-${dels}</span></span>` : "";

  const cardsByLine = new Map<number, string[]>();
  const unanchored: string[] = [];
  const shown = new Set(hunks.flatMap((h) => h.rows).filter((r) => r.new !== null).map((r) => r.new as number));
  const flag = flagger([...shown].sort((a, b) => a - b));
  for (const [n, f] of findings) {
    const anchor = f.line_end || f.line_number;
    if (shown.has(anchor)) {
      cardsByLine.set(anchor, [...(cardsByLine.get(anchor) ?? []), findingCard(f, n)]);
      flag.range(f.line_number || anchor, anchor, sevClass(f.severity));
    } else {
      unanchored.push(findingCard(f, n));
    }
  }
  const flagged = flag.flagged;
  const droppedByLine = new Map<number, Dropped[]>();
  const droppedUnanchored: Dropped[] = [];
  for (const d of dropped) {
    const line = d.cited && d.cited.file_path === path ? d.cited.line_number : d.candidate.lineEnd;
    if (shown.has(line)) droppedByLine.set(line, [...(droppedByLine.get(line) ?? []), d]);
    else droppedUnanchored.push(d);
  }

  const body: string[] = [];
  if (entry.omitted) body.push(`<p class="file-omitted">Diff not shown: ${text(entry.omitted)}</p>`);
  else if (hunks.length > 0) body.push(diffTable(hunks, cardsByLine, droppedByLine, byCandidate, flagged));
  else body.push('<p class="file-omitted">No lines to show.</p>');
  const leftovers = [...unanchored, ...[...cardsByLine.values()].flat()];
  const rest = [...droppedUnanchored, ...[...droppedByLine.values()].flat()];
  if (leftovers.length > 0 || rest.length > 0) {
    body.push('<div class="file-unanchored"><h4>Not on a line shown above</h4>');
    body.push(...leftovers);
    if (rest.length > 0) body.push(droppedBlock(rest, byCandidate));
    body.push("</div>");
  }
  return `<section class="file" id="file-${index}">
<header class="file-header">
<h3 class="file-path">${text(path)}</h3>
${old}
<span class="file-status">${status}</span>
${counts}
${count}
</header>
${body.join("")}
</section>`;
}

// A data table. Cells are already-escaped fragments.
function table(headers: string[], rows: string[][], numeric: Set<number> = new Set(), classes = ""): string {
  const n = (i: number) => (numeric.has(i) ? ' class="n"' : "");
  const head = headers.map((h, i) => `<th${n(i)}>${esc(h)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell, i) => `<td${n(i)}>${cell}</td>`).join("")}</tr>`).join("");
  return `<table class="table ${classes}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------- sections ----------

function masthead(report: Report, complete: boolean, impactText: string | null): string {
  const stats = report.stats ?? { files: 0, additions: 0, deletions: 0 };
  const base = report.base ?? { ref: "", sha: "" };
  let verdictCls: string;
  let verdict: string;
  if (complete) {
    verdictCls = report.verdict === "blocked" ? "verdict-failed" : "verdict-passed";
    verdict = esc(verdictSentence(report));
  } else {
    verdictCls = "verdict-failed";
    verdict = "Review incomplete: this is not a review of the change";
  }
  const missing = complete ? "" : `<div class="missing"><h2>Missing</h2><ul>${(report.completion?.missing ?? ["no completion record"]).map((m) => `<li>${text(m)}</li>`).join("")}</ul></div>`;
  const meta: [string, string][] = [
    ["Change", `<code>${shortId(report.change_id)}</code> against <code>${text(base.ref)}</code> <code>${shortId(base.sha)}</code>`],
    ["Size", `${plural(stats.files ?? 0, "file")}, <span class="added">+${num(stats.additions ?? 0)}</span> <span class="removed">-${num(stats.deletions ?? 0)}</span>`],
    ["Block threshold", esc(thresholdSentence(report))],
    ["Reviewer", text(reviewerSentence(report))],
    ["Generated", when(report.generated_at)],
  ];
  if (impactText) meta.push(["Blast radius", `<a href="#blast-radius">${esc(impactText)}</a>`]);
  const items = meta.map(([k, v]) => `<div class="meta-item"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("");
  return `<header class="masthead">
<div class="masthead-row">
<span class="wordmark">OpenQodex review</span>
<span class="masthead-kind">${complete ? "review complete" : "review incomplete"}</span>
</div>
<h1 class="verdict ${verdictCls}">${verdict}</h1>
${missing}
<dl class="meta">${items}</dl>
</header>`;
}

function verdictBar(report: Report, complete: boolean, findings: Numbered[], filesTotal: number): string {
  const counted = countedSeverities(report);
  const verdictCls = complete && report.verdict !== "blocked" ? "verdict-passed" : "verdict-failed";
  const counts = `${plural(counted.length, "finding")}${counted.length > 0 ? `: ${breakdown(counted)}` : ""}`;
  const dropped = `${plural((report.dropped ?? []).length, "scanner candidate")} dropped`;
  const jumps: [string, string][] = [
    ["#summary", "Summary"],
    ["#findings", `Findings (${findings.length})`],
    ["#files", `Files (${filesTotal})`],
    ["#scanners", "Scanners"],
    ["#blast-radius", "Blast radius"],
  ];
  return `<div class="verdict-bar">
<span class="verdict-word ${verdictCls}">${esc(verdictShort(report))}</span>
<span class="counts">${esc(counts)}</span>
<span class="counts counts-dropped">${esc(dropped)}</span>
<nav class="jumps" aria-label="Sections">${jumps.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join("")}</nav>
</div>`;
}

function summary(report: Report): string {
  const body = report.summary ? paragraphs(report.summary) : '<p class="muted">The reviewer gave no summary.</p>';
  return `<section class="summary" id="summary"><h2>Summary</h2><div class="prose">${body}</div></section>`;
}

function coverage(report: Report): string {
  const completion = report.completion;
  const scanners = report.scanners ?? [];
  const findings = report.findings ?? [];
  const raw = scanners.reduce((n, s) => n + (s.rawCount || 0), 0);
  const kept = scanners.reduce((n, s) => n + (s.keptCount || 0), 0);
  const raised = findings.filter((f) => f.candidate).length;
  const dropped = (report.dropped ?? []).length;
  const unreviewed = (report.not_reviewed ?? []).length;
  const muted = (s: string) => `<span class="muted">${s}</span>`;

  let ranges: string;
  let read: string;
  // The files the reviewer did not open, when reads were measured: their
  // changed lines were in front of it anyway when every range was given.
  let notOpened: [string, string] | null = null;
  if (completion) {
    const cov = completion.coverage;
    ranges = `${num(cov.covered)} of ${num(cov.hunks)}`;
    if (completion.trace_complete === false) {
      read = `not recorded by ${text(completion.reviewer ? product(completion.reviewer.driver) : "the reviewer")}`;
    } else {
      read = cov.files_read.length > 0 ? cov.files_read.map((p) => text(p)).join(", ") : "none";
      if (cov.files_not_read.length > 0) {
        const label = cov.covered === cov.hunks ? "Files not opened (their changed lines were in the brief)" : "Files not opened";
        notOpened = [label, cov.files_not_read.map((p) => text(p)).join(", ")];
      }
    }
  } else {
    ranges = muted("not recorded in this report");
    read = muted("not recorded in this report");
  }

  const candidates = kept === 0 ? (raw > 0 ? `none on a changed line (${raw} scanner ${raw === 1 ? "result" : "results"} found, 0 kept)` : "none") : `${kept} on changed lines: ${raised} raised, ${dropped} dropped, ${unreviewed} not reviewed`;
  const out = scanners.filter((s) => s.status !== "ran" && s.status !== "no_matching_files");
  const excluded = out.length === 0 ? "none" : out.map((s) => `${text(s.scanner)}: ${text(s.reason || s.status.replace(/_/g, " "))}`).join("; ");

  const items: [string, string][] = [
    ["Changed ranges given to the reviewer", ranges],
    ["Files the reviewer opened", read],
    ...(notOpened ? [notOpened] : []),
    ["Scanner candidates", esc(candidates)],
    ["Scanners not included", excluded],
  ];
  return `<section class="coverage" aria-label="Coverage"><dl>${items.map(([k, v]) => `<div class="coverage-item"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl></section>`;
}

function filesNav(entries: Entry[], findingsByPath: Map<string, Numbered[]>, filesTotal: number): string {
  const items = entries.map((entry, i) => {
    const [adds, dels] = fileCounts(entry.hunks);
    const n = (findingsByPath.get(entry.path) ?? []).length;
    const counts = entry.hunks.length > 0 ? `<span class="added">+${adds}</span> <span class="removed">-${dels}</span>` : '<span class="muted">no diff</span>';
    return `<li><a href="#file-${i + 1}">${text(entry.path)}</a><span class="file-meta">${counts}</span><span class="file-meta file-meta-2">${word(entry.status, FILE_STATUS_WORDS)}, ${plural(n, "finding")}</span></li>`;
  });
  const rest = filesTotal - entries.length;
  const note = rest > 0 ? `<p class="files-note">Diffs for ${plural(rest, "other changed file")} are not in this report.</p>` : "";
  return `<nav class="files" id="files" aria-label="Changed files">
<h2>Files <span class="count">(${filesTotal})</span></h2>
<ol>${items.join("")}</ol>
${note}
</nav>`;
}

function findingsIndex(findings: Numbered[], complete: boolean): string {
  const title = complete ? "Findings" : 'Findings so far <span class="count">(the change was not fully reviewed)</span>';
  if (findings.length === 0) {
    const empty = complete ? "No findings on the changed lines." : "None yet.";
    return `<section class="findings-index" id="findings"><h2>${title} <span class="count">(0)</span></h2><p class="muted">${empty}</p></section>`;
  }
  const rows = findings.map(
    ([n, f]) =>
      `<li id="index-f${n}" class="${sevClass(f.severity)}"><span class="index-n">${n}</span>${severityBadge(f.severity)}<a class="index-title" href="#f${n}">${text(f.title)}</a><span class="index-where"><span class="category">${text(f.category)}</span> ${text(location(f))}</span></li>`,
  );
  return `<section class="findings-index" id="findings"><h2>${title} <span class="count">(${findings.length})</span></h2><ol>${rows.join("")}</ol></section>`;
}

function accounting(report: Report): string {
  const findings = report.findings ?? [];
  const scanners = report.scanners ?? [];
  const own = findings.filter((f) => !f.candidate).length;
  const fromScanners = findings.length - own;
  const notKept = scanners.map((s) => [s.scanner, (s.rawCount || 0) - (s.keptCount || 0)] as const).filter(([, n]) => n > 0);
  const dropped = report.dropped ?? [];
  const notReviewed = report.not_reviewed ?? [];
  const low = report.low_confidence ?? [];
  const outsideChange = report.outside_change ?? [];
  const leftOut = report.not_reviewed_paths ?? [];
  const rows: string[][] = [
    ["Raised by the reviewer", num(findings.length), esc(`${own} from its own reading, ${fromScanners} from scanner candidates`)],
    ["Dropped by the reviewer", num(dropped.length), dropped.length === 0 ? esc("none") : dropped.map((d) => `${text(d.candidate.id)}: ${text(d.reason)}`).join("; ")],
    ["Not reviewed, counted at scanner severity", num(notReviewed.length), notReviewed.length === 0 ? esc("none") : notReviewed.map((c) => `${text(c.id)} ${text(c.token)} at ${text(candidateLocation(c))}`).join("; ")],
    ["Below the confidence floor", num(low.length), low.length === 0 ? esc("none") : low.map((l) => `${text(l.file_path)}: ${text(l.title)} (${num(l.confidence)}, floor ${num(l.floor)})`).join("; ")],
    ["Below the severity threshold", num(report.below_threshold || 0), esc("left out of the findings, never counted")],
    ["Outside the changed lines", num(outsideChange.length), outsideChange.length > 0 ? esc("shown for information, never counted") : esc("none")],
    ["Scanner results not kept", num(notKept.reduce((n, [, k]) => n + k, 0)), notKept.length > 0 ? esc(`a result is kept only when it sits on a changed line; ${notKept.map(([name, k]) => `${name} ${k}`).join(", ")}`) : esc("none")],
    ["Left out, change too large", num(leftOut.length), leftOut.length === 0 ? esc("none") : leftOut.map((p) => text(p)).join(", ")],
  ];
  const outside =
    outsideChange.length > 0
      ? `<h3>Outside the changed lines</h3><p class="muted">Shown for information; these never count toward the verdict.</p>${outsideChange.map((f, i) => findingCard(f, `o${i + 1}`)).join("")}`
      : "";
  return `<section class="accounting" id="accounting"><h2>Review accounting</h2>${table(["What", "Count", "Detail"], rows, new Set([1]), "table-keyed")}${outside}</section>`;
}

function scannersSection(report: Report): string {
  const scanners = report.scanners ?? [];
  const rows = scanners.map((s) => [
    `<span class="mono">${text(s.scanner)}</span>`,
    `<span class="scanner-status scanner-${text(s.status)}">${word(s.status, SCANNER_STATUS_WORDS)}</span>`,
    `<span class="mono">${text(s.version ?? "")}</span>`,
    num(s.rawCount || 0),
    num(s.keptCount || 0),
    seconds(s.durationMs || 0),
    text(s.reason ?? ""),
  ]);
  return `<section class="scanners" id="scanners"><h2>Scanners</h2><p>${esc(coverageSentence(scanners))}.</p>${table(["Scanner", "Status", "Version", "Found", "Kept", "Time", "Reason"], rows, new Set([3, 4, 5]))}</section>`;
}

function blastRadius(report: Report): string {
  const impact = report.impact;
  const head = '<section class="blast-radius" id="blast-radius"><h2>Blast radius</h2>';
  if (!impact || impact.status === "off") return `${head}<p class="muted">The code graph is off for this review. Find the callers of changed code with your own tools.</p></section>`;
  if (impact.status === "skipped" || impact.status === "failed") {
    const lead = impact.status === "skipped" ? "The code graph was skipped" : "The code graph could not be built";
    const why = (impact.reasons ?? []).map((r) => text(r)).join("; ") || text(impact.status);
    return `${head}<p>${lead}: ${why}. Find the callers of changed code with your own tools.</p></section>`;
  }

  const c = impactCounts(impact);
  const symbols = c.symbols;
  const build = impact.build ?? { durationMs: 0, cacheHits: 0, eligibleFiles: 0, parsedFiles: 0, omittedFiles: 0, unresolvedSites: 0 };
  const where = (s: ImpactSymbolView) => `<span class="mono">${text(s.file)}:${num(s.startLine)}</span>`;
  const risk = impact.risk ?? "none";
  let lead = impactSentence(report) ?? "";
  if (lead.startsWith(`risk ${risk} (`)) lead = lead.slice(`risk ${risk} (`.length);
  if (lead.endsWith(")")) lead = lead.slice(0, -1);
  const out = [head, `<p>Risk ${esc(risk)}: ${esc(lead)}.</p>`];
  if (impact.status === "partial") {
    out.push(`<p class="muted">The graph is partial: ${(impact.reasons ?? []).map((r) => text(r)).join("; ")}. ${num(build.parsedFiles)} of ${num(build.eligibleFiles)} files are in it; callers in the others are missing.</p>`);
  }
  out.push(
    `<p class="muted">Built on this machine from the call graph of ${plural(build.parsedFiles || 0, "file")} in ${seconds(build.durationMs || 0)}; ${plural(build.unresolvedSites || 0, "call site")} could not be bound to a definition and are not counted. The graph cannot see dynamic calls, so a symbol with no listed caller may still be called.</p>`,
  );

  const touched = impact.touched ?? [];
  if (touched.length === 0 && c.removed.length === 0) {
    out.push("<p>The change touches no function, method, class or type in a TypeScript, JavaScript, Python, Go or Ruby file, so there is no caller to trace.</p>");
  } else {
    if (c.removed.length > 0) {
      const called = new Map<string, number>();
      for (const p of impact.callers ?? []) {
        const edges: readonly ImpactEdge[] = p.edges ?? [];
        if (edges.length === 1 && c.removed.includes(p.seed)) called.set(p.seed, (called.get(p.seed) ?? 0) + (edges[0]!.sites ?? []).length);
      }
      const rows: string[][] = [];
      for (const sid of c.removed) {
        const s = symbols.get(sid);
        if (!s) continue;
        const still = called.get(sid) ? esc(`still called from ${plural(called.get(sid)!, "site")}`) : '<span class="muted">no remaining caller found</span>';
        rows.push([where(s), `<span class="mono">${text(s.name)}</span>`, text(s.kind), still]);
      }
      out.push(`<h3>Removed by this change <span class="count">(${rows.length})</span></h3>`);
      out.push(table(["Where (base version)", "Symbol", "Kind", "Callers"], rows));
    }
    if (c.moved.length > 0) {
      const rows: string[][] = [];
      for (const sid of c.moved) {
        const s = symbols.get(sid);
        if (s?.movedTo) rows.push([where(s), `<span class="mono">${text(s.name)}</span>`, text(s.kind), `<span class="mono">${text(s.movedTo.file)}:${num(s.movedTo.line)}</span>`]);
      }
      out.push(`<h3>Moved to another file <span class="count">(${rows.length})</span></h3>`);
      out.push(table(["Where (base version)", "Symbol", "Kind", "Now at"], rows));
    }

    const byFile = new Map<string, ImpactSymbolView[]>();
    for (const sid of touched) {
      const s = symbols.get(sid);
      if (s) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    }
    const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const cap = 12;
    const rows = ranked.slice(0, cap).map(([path, syms]) => {
      const names = syms.slice(0, 6).map((s) => text(s.name)).join(", ") + (syms.length > 6 ? esc(` and ${syms.length - 6} more`) : "");
      return [`<span class="mono">${text(path)}</span>`, num(syms.length), `<span class="mono">${names}</span>`];
    });
    out.push(`<h3>Touched symbols by file <span class="count">(${plural(touched.length, "symbol")} in ${plural(byFile.size, "file")})</span></h3>`);
    out.push(table(["File", "Symbols", "Names"], rows, new Set([1])));
    if (ranked.length > cap) {
      const rest = ranked.slice(cap).reduce((n, [, v]) => n + v.length, 0);
      out.push(`<p class="muted">And ${plural(ranked.length - cap, "more file")} holding ${plural(rest, "touched symbol")}.</p>`);
    }

    const sitesByFile = new Map<string, number>();
    for (const p of impact.callers ?? []) {
      const edges: readonly ImpactEdge[] = p.edges ?? [];
      if (edges.length === 0) continue;
      for (const site of edges[edges.length - 1]!.sites ?? []) sitesByFile.set(site.file, (sitesByFile.get(site.file) ?? 0) + 1);
    }
    if (sitesByFile.size > 0) {
      const siteRows = [...sitesByFile.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([path, n]) => [`<span class="mono">${text(path)}</span>`, num(n)]);
      const total = [...sitesByFile.values()].reduce((n, k) => n + k, 0);
      out.push(`<h3>Call sites of the touched and removed code <span class="count">(${plural(total, "site")} in ${plural(siteRows.length, "file")})</span></h3>`);
      out.push(table(["Calling file", "Sites"], siteRows, new Set([1]), "table-narrow"));
      if (impact.truncated?.walk && (impact.hubs ?? []).length === 0) out.push('<p class="muted">The walk stopped at 200 symbols; callers further out are not listed.</p>');
    } else {
      out.push("<p>No caller of the touched code was found in the graph.</p>");
    }
    for (const h of impact.hubs ?? []) {
      const s = symbols.get(h.symbol);
      out.push(`<p class="muted"><span class="mono">${text(s?.name || h.symbol)}</span> is a hub: called by ${plural(h.callers || 0, "symbol")} from ${plural(h.sites || 0, "site")} in ${plural(h.files || 0, "file")}.</p>`);
    }
  }

  const importers = impact.importers ?? [];
  if (importers.length > 0) {
    const byTarget = new Map<string, Set<string>>();
    for (const e of importers) byTarget.set(e.to, new Set([...(byTarget.get(e.to) ?? []), e.from]));
    const ranked = [...byTarget.entries()].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const cap = 12;
    const rows = ranked.slice(0, cap).map(([path, srcs]) => [`<span class="mono">${text(path)}</span>`, num(srcs.size)]);
    out.push(`<h3>Changed files that others import <span class="count">(${plural(byTarget.size, "file")}, ${plural(new Set(importers.map((e) => e.from)).size, "importing file")})</span></h3>`);
    out.push(table(["Changed file", "Imported by"], rows, new Set([1]), "table-narrow"));
    if (ranked.length > cap) out.push(`<p class="muted">And ${plural(ranked.length - cap, "more changed file")} that others import.</p>`);
  }
  out.push("</section>");
  return out.join("");
}

function footer(report: Report, input: HtmlInput, findings: Numbered[]): string {
  const reviewer = text(reviewerSentence(report));
  const ids = findings.slice(0, 2).map(([n]) => String(n)).join(", ") || "1";
  const where = input.reportMd ? text(input.reportMd) : "report.md beside this file";
  const by = input.version ? ` by openqodex ${text(input.version)}` : "";
  return `<footer class="footer">
<p>Reviewer: ${reviewer}. Generated ${when(report.generated_at)}${by}. Report schema version ${num(report.version || 1)}.</p>
<p>report.md, report.json and report.sarif are beside this file. To have your agent fix findings by number, say:</p>
<p class="ask"><code>Fix OpenQodex findings ${esc(ids)} from ${where}</code></p>
<p>This page is a file on your disk. It loads nothing, runs no script and sends nothing.</p>
<p class="closing">${esc(CLOSING)}<a href="${esc(CLOSING_URL)}" rel="noreferrer">${esc(CLOSING_URL)}</a></p>
</footer>`;
}

// ---------- page ----------

// The page's policy: nothing loads, nothing runs, no form goes anywhere;
// the one stylesheet is allowed by its hash, so a style element anywhere
// else in the page (from text that escaped its escaping) would not apply.
function policy(css: string): string {
  const hash = createHash("sha256").update(css, "utf8").digest("base64");
  return `default-src 'none'; style-src 'sha256-${hash}'; script-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy(REPORT_CSS)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function renderHtml(input: HtmlInput): string {
  const { report } = input;
  const complete = isComplete(report);
  const findings: Numbered[] = orderedFindings(report).map((f, i) => [i + 1, f]);
  const findingsByPath = new Map<string, Numbered[]>();
  for (const [n, f] of findings) findingsByPath.set(f.file_path, [...(findingsByPath.get(f.file_path) ?? []), [n, f]]);
  const byCandidate = new Map<string, number>();
  for (const [n, f] of findings) if (f.candidate) byCandidate.set(f.candidate, n);
  const droppedByPath = new Map<string, Dropped[]>();
  for (const d of report.dropped ?? []) {
    const path = d.cited?.file_path || d.candidate.filePath;
    droppedByPath.set(path, [...(droppedByPath.get(path) ?? []), d]);
  }

  const excerpt = input.display?.kind === "excerpts";
  const entries: Entry[] = (input.display?.files ?? []).map((f) => entryOf(f, excerpt));
  const listed = new Set(entries.map((e) => e.path));
  // A file that holds a finding or a dropped candidate but has no display entry still gets a section.
  for (const path of [...findingsByPath.keys(), ...droppedByPath.keys()]) {
    if (listed.has(path)) continue;
    entries.push({ path, old_path: null, status: "modified", omitted: "diff not included in this report", hunks: [] });
    listed.add(path);
  }
  // A review of the whole repository lists only the files it cites.
  const filesTotal = excerpt ? entries.length + (input.display?.omitted_files ?? 0) : Math.max(report.stats?.files ?? 0, entries.length);

  const sections = entries.map((e, i) => fileSection(e, i + 1, findingsByPath.get(e.path) ?? [], droppedByPath.get(e.path) ?? [], byCandidate)).join("\n");
  const body = `<div class="page">
${masthead(report, complete, impactSentence(report))}
</div>
${verdictBar(report, complete, findings, filesTotal)}
<main class="page">
${summary(report)}
${coverage(report)}
<div class="review-body">
${filesNav(entries, findingsByPath, filesTotal)}
<div class="review-main">
${findingsIndex(findings, complete)}
${sections}
</div>
</div>
${accounting(report)}
${scannersSection(report)}
${blastRadius(report)}
</main>
<div class="page">
${footer(report, input, findings)}
</div>`;
  return page(`OpenQodex review: ${verdictShort(report)}`, body);
}

// The page of a review that never started: no reviewer could. It is not a
// review and says so; the unchecked scanner candidates are in their own file.
export function renderUnavailableHtml(input: { changeId: string; reasons: string[]; candidatesPath: string; fallback: string; version: string }): string {
  const body = `<div class="page">
<header class="masthead">
<div class="masthead-row">
<span class="wordmark">OpenQodex review</span>
<span class="masthead-kind">review unavailable</span>
</div>
<h1 class="verdict verdict-failed">Full review unavailable: openqodex could not start a reviewer</h1>
<div class="missing"><h2>Why</h2><ul>${input.reasons.map((r) => `<li>${text(r)}</li>`).join("")}</ul></div>
<dl class="meta"><div class="meta-item"><dt>Change</dt><dd><code>${shortId(input.changeId)}</code></dd></div></dl>
</header>
</div>
<main class="page">
<section class="coverage" aria-label="What there is"><dl><div class="coverage-item"><dt>Unchecked scanner candidates, not a review</dt><dd>${text(input.candidatesPath)}</dd></div><div class="coverage-item"><dt>To review with the agent you are in</dt><dd><code>${text(input.fallback)}</code></dd></div></dl></section>
</main>
<div class="page">
<footer class="footer">
<p>Generated by openqodex ${text(input.version)}.</p>
<p>This page is a file on your disk. It loads nothing, runs no script and sends nothing.</p>
</footer>
</div>`;
  return page("OpenQodex review: unavailable", body);
}
