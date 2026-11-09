// The completion record of a review run by `review` itself, and the
// coverage it is built from. Coverage comes from the reviewer's trace (the
// tool calls its agent reported), never from the reviewer's own word: a
// changed range counts as given to the reviewer when its file's diff was in
// the brief, when the run put it in a correction round, or when successful
// reads cover every line of it. A deletion has no line in the snapshot, so
// only the diff in the brief or a correction round can show it. A reviewer
// whose trace is not complete (Codex) reports no reads, so for it only the
// brief and the correction rounds count.
import type { Change, CompletionRecord, HunkRef, ModelAttempt, ModelCompletionRecord, ModelToolEntry, ReviewerRecord, ReviewerSessionRecord } from "./types.js";

// One tool call of the reviewer. `path` is relative to the snapshot when
// `inside`, else as the agent named it. `range` is the first and last line a
// read delivered. For a reviewer whose trace is not complete (Codex),
// `inside` is null (not checked) and `detail` holds the call's input as
// reported (a command, a search), kept as a diagnostic only. `own`: a call
// outside the snapshot on the agent's own saved output of this session
// (Claude Code's tool-results folder), which reads no repository file.
// `session`: in a staged review, the ReviewerRole of the session that made
// the call (every session's calls are kept in one trace).
export type TraceEntry = { tool: string; path: string | null; inside: boolean | null; range: [number, number] | null; ok: boolean; detail?: string; own?: true; session?: string };

// Whether a call names anything outside the snapshot, except the
// agent's own saved output of this session.
export function outsideSnapshot(t: TraceEntry): boolean {
  return t.inside !== true && t.own !== true;
}

// A missing result keeps ok true, so an unanswered call still fails closed.
export function leftSnapshot(t: TraceEntry): boolean {
  return outsideSnapshot(t) && t.ok;
}

export function refusedOutside(t: TraceEntry): boolean {
  return outsideSnapshot(t) && !t.ok;
}

export type Hunk = Pick<HunkRef, "path" | "start" | "end" | "deletion"> & Partial<Omit<HunkRef, "path" | "start" | "end" | "deletion">>;

export type Coverage = CompletionRecord["coverage"];

// The tools a reviewer is given. A successful call to anything else fails the run.
export const REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
// Added unless the user config sets `reviewer_web: off`.
export const REVIEWER_WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

// Shown in `missing`, so a long list stays readable.
const MAX_LISTED = 10;

// Every changed range of the change: runs of added or modified lines, and
// each deletion point as the lines on either side of it.
export function changedHunks(change: Change): Hunk[] {
  const hunks: Hunk[] = [];
  for (const [path, lines] of change.coverage) {
    for (const [start, end] of lines.ranges()) hunks.push({ path, start, end, deletion: false });
  }
  for (const [path, points] of change.deletionPoints) {
    for (const p of points) hunks.push({ path, start: Math.min(...p.anchors), end: Math.max(...p.anchors), deletion: true });
  }
  return hunks;
}

// Whether the reads cover every line from `start` to `end`.
function covers(ranges: [number, number][], start: number, end: number): boolean {
  let next = start;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > next) break;
    next = Math.max(next, b + 1);
    if (next > end) return true;
  }
  return next > end;
}

// `lineCount`: a file's line count in the snapshot, or null when it cannot be
// told. A file the change could not map (Change.uncovered) is one range from
// its first line to its last, read only when reads cover all of it; with no
// line count it can never be shown read.
// `delivered`: ranges the tool itself put in front of the reviewer in a
// correction round; a line range counts like a read, a deletion when the
// same deletion was delivered.
export type CoverageArgs = {
  change: Change;
  obligations?: Hunk[];
  briefCarried?: Hunk[];
  digestCarried?: Hunk[];
  trace: TraceEntry[];
  lineCount?: (path: string) => number | null;
  delivered?: Hunk[];
};

export function readCoverage(args: CoverageArgs): Coverage {
  const reads = new Map<string, [number, number][]>();
  for (const t of args.trace) {
    if (t.tool !== "Read" || !t.ok || t.inside !== true || t.path === null || t.range === null) continue;
    reads.set(t.path, [...(reads.get(t.path) ?? []), t.range]);
  }
  const whole = (args.change.uncovered ?? []).map((path) => ({ path, start: 1, end: args.lineCount?.(path) ?? 0, deletion: false }));
  const hunks = args.obligations ?? [...changedHunks(args.change), ...whole];
  const sources = [
    { by: "brief" as const, entries: args.briefCarried ?? [] },
    { by: "digest" as const, entries: args.digestCarried ?? [] },
    { by: "page" as const, entries: args.delivered ?? [] },
  ];
  const given: NonNullable<Coverage["given"]> = [];
  const unread: Hunk[] = [];
  const deletionId = (h: Hunk) => typeof h.deletion === "object" ? h.deletion.id : `${h.path}#${h.point ?? (args.change.deletionPoints.get(h.path) ?? []).findIndex((p) => Math.min(...p.anchors) === h.start && Math.max(...p.anchors) === h.end)}`;
  for (const h of hunks) {
    if (h.end < h.start && !h.deletion) { unread.push(h); continue; }
    const matching = sources.map((source) => ({ ...source, entries: source.entries.filter((d) => d.path === h.path && Boolean(d.deletion) === Boolean(h.deletion) && (!h.deletion || deletionId(d) === deletionId(h))) }));
    const range = (d: Hunk): [number, number] => typeof d.deletion === "object" ? [d.deletion.oldStart, d.deletion.oldEnd] : [d.start, d.end];
    const [start, end] = range(h);
    const own = matching.flatMap((s) => s.entries.map(range));
    const read = h.deletion ? [] : reads.get(h.path) ?? [];
    if ((h.deletion && end < start ? !matching.some((s) => s.entries.length) : !covers([...own, ...read], start, end))) { unread.push(h); continue; }
    // Own deliveries win over reads. Subtract earlier credit so overlapping
    // finder pairs and repeated reads never list a line twice.
    let left: [number, number][] = [[start, end]];
    const credit = (by: "brief" | "page" | "digest" | "read", ranges: [number, number][]) => {
      const merged: [number, number][] = [];
      for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
        const prior = merged.at(-1);
        if (prior && a <= prior[1] + 1) prior[1] = Math.max(prior[1], b);
        else merged.push([a, b]);
      }
      for (const [a, b] of merged) {
        const next: [number, number][] = [];
        for (const [from, to] of left) {
          if (b < from || a > to) { next.push([from, to]); continue; }
          const first = Math.max(a, from);
          const last = Math.min(b, to);
          given.push({ path: h.path, start: h.deletion ? h.start : first, end: h.deletion ? h.end : last, ...(h.deletion ? { deletion: deletionId(h), ...(typeof h.deletion === "object" ? { fragment: { of: deletionId(h), from: first, to: last } } : {}) } : {}), by });
          if (from < first) next.push([from, first - 1]);
          if (last < to) next.push([last + 1, to]);
        }
        left = next;
      }
    };
    if (h.deletion && end < start) {
      given.push({ path: h.path, start: h.start, end: h.end, deletion: deletionId(h), by: matching.find((s) => s.entries.length > 0)!.by });
    } else {
      for (const source of matching) credit(source.by, source.entries.map(range));
      credit("read", read);
    }

  }
  const readable = args.change.files.filter((f) => f.status !== "deleted" && !f.binary).map((f) => f.path);
  return {
    hunks: hunks.length,
    covered: hunks.length - unread.length,
    unread,
    given,
    files_read: [...reads.keys()].sort(),
    files_not_read: readable.filter((p) => !reads.has(p)).sort(),
  };
}

// The legacy single pass still has a file-diff renderer. Translate that
// renderer's receipt to intervals before it enters the coverage engine.
function singlePassRanges(args: { change: Change; diffFiles: ReadonlySet<string>; lineCount?: (path: string) => number | null }): Hunk[] {
  return [...changedHunks(args.change), ...(args.change.uncovered ?? []).map((path) => ({ path, start: 1, end: args.lineCount?.(path) ?? 0, deletion: false }))].filter((h) => args.diffFiles.has(h.path));
}

export function singlePassCoverage(args: CoverageArgs & { diffFiles: ReadonlySet<string> }): Coverage {
  const { diffFiles: _, ...rest } = args;
  const { given: __, ...coverage } = readCoverage({ ...rest, briefCarried: singlePassRanges(args) });
  return coverage;
}

export function singlePassModelCoverage(args: Omit<CoverageArgs, "trace"> & { diffFiles: ReadonlySet<string>; briefSent: boolean; toolLog: ModelToolEntry[] }): Coverage {
  const { diffFiles: _, ...rest } = args;
  const { given: __, ...coverage } = modelCoverage({ ...rest, briefCarried: singlePassRanges(args) });
  return coverage;
}

const where = (h: Hunk) => (h.end > h.start ? `${h.path}:${h.start}-${h.end}` : `${h.path}:${h.start}`);

function listed(items: string[]): string {
  const more = items.length - MAX_LISTED;
  return items.slice(0, MAX_LISTED).join(", ") + (more > 0 ? ` and ${more} more` : "");
}

export function completionRecord(args: {
  change: Change;
  reviewer: ReviewerRecord | null;
  snapshot: { tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  coverage: Coverage;
  trace: TraceEntry[];
  // The numbered rejections the last answer still had; empty when it passed.
  submissionErrors: string[];
  // `review --all`: no changed ranges, so coverage is reported, never required.
  wholeRepo: boolean;
  // Why the reviewer gave no answer that could be checked (it timed out, it
  // exited, it started with more than it was given).
  failure?: string | null;
  // The tools the reviewer was given; REVIEWER_TOOLS when left out.
  tools?: readonly string[];
  // False when the reviewer's event stream does not show every tool call
  // (Codex): the trace is then a diagnostic list, and neither its paths nor
  // its tool names can complete or fail the review. True when left out.
  traced?: boolean;
  missing?: string[];
}): CompletionRecord {
  const traced = args.traced ?? true;
  const missing: string[] = [...(args.missing ?? [])];
  if (args.reviewer === null) missing.push("no reviewer process was started by openqodex");
  if (args.failure) missing.push(args.failure);
  if (args.snapshot.after === null || args.snapshot.after !== args.snapshot.before) {
    missing.push("the snapshot changed while the reviewer read it");
  }
  const outside = traced ? [...new Set(args.trace.filter(outsideSnapshot).map((t) => t.path ?? "(no path)"))] : [];
  const reads = traced ? [...new Set(args.trace.filter(leftSnapshot).map((t) => t.path ?? "(no path)"))] : [];
  if (reads.length > 0) missing.push(`the reviewer read outside the snapshot: ${listed(reads)}`);
  const given = args.tools ?? REVIEWER_TOOLS;
  const tools = traced ? [...new Set(args.trace.filter((t) => t.ok && !given.includes(t.tool)).map((t) => t.tool))] : [];
  if (tools.length > 0) missing.push(`the reviewer used a tool it was not given: ${tools.join(", ")}`);
  const refused = traced ? [...new Set([
    ...args.trace.filter(refusedOutside).map((t) => t.path ?? "(no path)"),
    ...args.trace.filter((t) => !t.ok && !given.includes(t.tool)).map((t) => t.tool),
  ])] : [];
  const open = args.candidates.total - args.candidates.disposed;
  if (open > 0) missing.push(`${open} scanner ${open === 1 ? "candidate has" : "candidates have"} no disposition`);
  if (args.submissionErrors.length > 0) {
    const n = args.submissionErrors.length;
    missing.push(`the reviewer's answer still failed ${n} ${n === 1 ? "check" : "checks"} after the correction rounds`, ...args.submissionErrors.slice(0, MAX_LISTED));
  }
  if (!args.wholeRepo && args.coverage.unread.length > 0) {
    const n = args.coverage.unread.length;
    missing.push(`${n} changed ${n === 1 ? "range was" : "ranges were"} ${traced ? "not read" : "not given to the reviewer"}: ${listed(args.coverage.unread.map(where))}`);
  }
  return {
    version: 1,
    contract: "openqodex-review-2",
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    refused,
    reviewer: args.reviewer,
    snapshot: { change_id: args.change.id, ...args.snapshot },
    candidates: args.candidates,
    // Reads were not measured without a complete trace: no file is listed as read or not read.
    coverage: traced ? args.coverage : { ...args.coverage, files_read: [], files_not_read: [] },
    outside_reads: outside,
    trace_complete: traced,
  };
}

// The model record (contract "openqodex-model-review-1"): a review by a model
// reviewer, whose every request the brain built and whose every tool call
// the brain served. Coverage counts what a request that was sent carried:
// the brief's diff when the request carrying the brief was sent, a
// correction round's ranges, and the lines a read_file result carried once a
// later request carried that result. A result served but never sent counts
// for nothing.

export const MODEL_REVIEW_CONTRACT = "openqodex-model-review-1";
// The tool whose results count as reads.
export const MODEL_READ_TOOL = "read_file";

// The line a budget refusal leaves in `missing`, and in the conversation's
// failure. `call` counts the reviewer's calls from 1, the refused one included.
export function budgetRefusedLine(purpose: string, call: number): string {
  return `budget refused before ${purpose} call ${call}`;
}

// Coverage from the brain's delivery log, by the rules of readCoverage: the
// brief's diff counts only when `briefSent`; `delivered` holds the ranges of
// correction requests that were sent; a read_file result counts for the
// lines it carried, and only once `delivered`. A refused result carries
// nothing, and neither does one for a path outside the snapshot or outside
// the review's scopes.
export function modelCoverage(args: Omit<CoverageArgs, "trace"> & { briefSent: boolean; toolLog: ModelToolEntry[] }): Coverage {
  const reads: TraceEntry[] = args.toolLog
    .filter((t) => t.tool === MODEL_READ_TOOL && t.delivered && t.in_scope !== false)
    .map((t) => ({ tool: "Read", path: t.path, inside: t.inside, range: t.range, ok: t.ok }));
  return readCoverage({ ...args, briefCarried: args.briefSent ? args.briefCarried : [], digestCarried: args.briefSent ? args.digestCarried : [], trace: reads });
}

export function modelCompletionRecord(args: {
  changeId: string;
  // The model the reviewer asked for (ModelReviewer.model).
  model: string;
  snapshot: { tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  // From modelCoverage, on the same tool log.
  coverage: Coverage;
  // Every tool call the model asked for, in order.
  toolLog: ModelToolEntry[];
  // Every model attempt, in order, the refused ones included.
  attempts: ModelAttempt[];
  // The names of the tools the brain defined for the reviewer.
  tools: readonly string[];
  // The numbered rejections the last answer still had; empty when it passed.
  submissionErrors: string[];
  // Why the conversation ended without an answer that could be checked.
  failure?: string | null;
  second?: ModelCompletionRecord;
  sessions?: ReviewerSessionRecord[];
  missing?: string[];
}): ModelCompletionRecord {
  const missing: string[] = [...(args.missing ?? [])];
  const add = (line: string) => {
    if (!missing.includes(line)) missing.push(line);
  };
  // A refusal anywhere ends the review as incomplete; the attempts before
  // it keep their usage.
  args.attempts.forEach((a, i) => {
    if (a.outcome === "refused") add(budgetRefusedLine(a.purpose, i + 1));
  });
  args.second?.attempts.forEach((a, i) => {
    if (a.outcome === "refused") add(`the second reviewer: ${budgetRefusedLine(a.purpose, i + 1)}`);
  });
  if (args.failure) add(args.failure);
  if (args.attempts.length === 0) add("no model call was made");
  if (args.snapshot.after === null || args.snapshot.after !== args.snapshot.before) add("the snapshot changed while the reviewer read it");
  const defined = (t: ModelToolEntry) => args.tools.includes(t.tool);
  // Only successful calls fail the review. Refusal text is still served to the model.
  const outside = [...new Set(args.toolLog.filter((t) => t.ok && defined(t) && t.inside !== true).map((t) => t.path ?? "(no path)"))];
  if (outside.length > 0) add(`the reviewer read outside the snapshot: ${listed(outside)}`);
  const unscoped = [...new Set(args.toolLog.filter((t) => t.ok && defined(t) && t.inside === true && t.in_scope === false).map((t) => t.path ?? "(no path)"))];
  if (unscoped.length > 0) add(`the reviewer asked for a path outside the review's scopes: ${listed(unscoped)}`);
  const undefinedTools = [...new Set(args.toolLog.filter((t) => t.ok && !defined(t)).map((t) => t.tool))];
  if (undefinedTools.length > 0) add(`the reviewer returned a tool call the brain did not define: ${listed(undefinedTools)}`);
  const refused = [...new Set(args.toolLog.filter((t) => !t.ok && (!defined(t) || t.inside !== true || t.in_scope === false))
    .map((t) => defined(t) ? t.path ?? "(no path)" : t.tool))];
  const open = args.candidates.total - args.candidates.disposed;
  if (open > 0) add(`${open} scanner ${open === 1 ? "candidate has" : "candidates have"} no disposition`);
  if (args.submissionErrors.length > 0) {
    const n = args.submissionErrors.length;
    missing.push(`the reviewer's answer still failed ${n} ${n === 1 ? "check" : "checks"} after the correction rounds`, ...args.submissionErrors.slice(0, MAX_LISTED));
  }
  if (args.coverage.unread.length > 0) {
    const n = args.coverage.unread.length;
    missing.push(`${n} changed ${n === 1 ? "range was" : "ranges were"} not sent to the reviewer: ${listed(args.coverage.unread.map(where))}`);
  }
  // Only the names the responses gave: a model the provider did not name is not listed.
  const servedModels = [...new Set(args.attempts.map((a) => a.usage?.servedModel).filter((m): m is string => typeof m === "string" && m !== ""))];
  return {
    contract: MODEL_REVIEW_CONTRACT,
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    refused,
    reviewer: { kind: "model", model: args.model, servedModels, calls: args.attempts.filter((a) => a.outcome !== "refused").length },
    snapshot: { change_id: args.changeId, ...args.snapshot },
    candidates: args.candidates,
    coverage: args.coverage,
    tool_log: args.toolLog,
    attempts: args.attempts,
    ...(args.second ? { second: args.second } : {}),
    ...(args.sessions ? { sessions: args.sessions } : {}),
    trace_complete: true,
  };
}
