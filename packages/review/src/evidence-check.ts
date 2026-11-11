import { z } from "zod";
import { lineFragments, FIELD_SENTENCE_LIMITS, FINDER_CONFIDENCE_FLOOR, diffEntry, diffHunks, proseErrors, scannerTerms } from "@openqodex/core";
import type { Change, EvidenceCitation, FindAnswer, FindCandidate, ReviewUnit, ScanResult, VerifyAnswer, VerifyBatch } from "@openqodex/core";

import type { FragmentRead as SnapshotText } from "./line-fragments.js";

// Oversized neighbours are gaps in the window, never evidence that the
// whole file is binary. A quote cannot bridge a row we could not check.
const quoteLines = (read: SnapshotText, path: string, from: number, to: number): { rows: (string | null)[]; error: string | null } => {
  try {
    if (read.readRows) {
      const rows = read.readRows(path, from, to, 200 * 1024);
      if (rows === null) return { rows: [], error: "the file is not a text file in the snapshot" };
      return { rows: [...rows].map((row) => row.text?.replace(/\n$/, "") ?? null), error: null };
    }
    const raw = read(path);
    if (raw === null) return { rows: [], error: "the file is not a text file in the snapshot" };
    const rows = raw.split("\n");
    if (rows.at(-1) === "") rows.pop();
    return { rows: rows.slice(from - 1, to).map((row) => Buffer.byteLength(row, "utf8") > 200 * 1024 ? null : row), error: null };
  } catch { return { rows: [], error: "the file could not be read in the snapshot" }; }
};
const citedLineError = (read: SnapshotText, path: string, line: number): string | null => {
  if (read.lineCount) {
    const count = read.lineCount(path);
    return count === null ? "the file is not a text file in the snapshot" : line > count ? "the cited line is past the end of the file" : null;
  }
  const window = quoteLines(read, path, line, line);
  return window.error ?? (window.rows.length === 0 ? "the cited line is past the end of the file" : null);
};
const normal = (text: string) => text.replace(/\s+/g, " ").trim();
const line = z.number().int().min(1);
const severity = z.enum(["critical", "major", "minor", "nitpick", "info"]);
const category = z.enum(["bug", "security", "performance", "maintainability", "style"]);
const citation = z.object({ file_path: z.string().min(1), line_number: line, quote: z.string().min(1), removed: z.literal(true).optional() });
const candidate = z.object({ severity, category, confidence: z.number().min(FINDER_CONFIDENCE_FLOOR).max(1), file_path: z.string().min(1), line_number: line, line_end: line.optional(), title: z.string().min(1), claim: z.string().min(1), evidence: z.array(citation).min(1).max(3), lens: z.string().nullable().optional() });
const findSchema = z.object({ version: z.literal("find-1"), change_id: z.string(), unit: z.string(), examined: z.array(z.string()), analysis: z.array(z.object({ hunk: z.string(), changed: z.string().min(1), could_break: z.string().min(1) })), candidates: z.array(candidate) });
const verdict = z.object({ id: z.string().min(1), verdict: z.enum(["confirmed", "refuted", "unresolved"]), reason: z.string().min(1), duplicate_of: z.string().nullable().optional(), severity, category, confidence: z.number().min(0).max(1), file_path: z.string().min(1), line_number: line, line_end: line.optional(), title: z.string(), problem: z.string(), consequence: z.string(), fix: z.string(), suggested_change: z.string().nullable().optional(), tier: z.enum(["finding", "observation"]) });
const verifySchema = z.object({ version: z.literal("verify-1"), change_id: z.string(), verdicts: z.array(verdict) });
const sameChange = (id: string, change: Change) => id === change.id || id === change.shortId;
const shapeErrors = (error: z.ZodError) => error.issues.map((e) => `${e.path.join(".")}: ${e.message}`.replace(/\s*\n\s*/g, " "));

export function checkEvidence(c: EvidenceCitation, snapshotText: SnapshotText, change: Change): string | null {
  const at = `${c.file_path}:${c.line_number}${c.removed ? " (removed)" : ""}`.replace(/[\r\n]/g, " ");
  const quote = normal(c.quote);
  if (quote === "") return `evidence ${at}: the quote is empty`;
  if (c.removed) {
    const path = diffEntry(change, c.file_path)?.path ?? change.files.find((f) => f.oldPath === c.file_path)?.path;
    let oldLine = 0;
    const removed: string[] = [];
    let skipped = false;
    for (const hunk of path ? diffHunks(change, path, { start: Math.max(1, c.line_number - 2), end: c.line_number + 2, side: "old" }, 512 * 1024, { onLimit: () => { skipped = true; } }) : []) for (const row of hunk.split("\n")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(row);
      if (header) { oldLine = Number(header[1]); continue; }
      if (oldLine === 0) continue;
      if (row.startsWith("-")) {
        if (Math.abs(oldLine - c.line_number) <= 2) removed.push(row.slice(1));
        oldLine++;
      } else if (row.startsWith(" ")) oldLine++;
      else if (!row.startsWith("+") && !row.startsWith("\\")) oldLine = 0;
    }
    if (skipped) return `evidence ${at}: the removed lines cannot be checked within the 512 KB byte budget; cite evidence from another line`;
    return normal(removed.join(" ")).includes(quote) ? null : `evidence ${at}: the quote is not in the removed lines of this file's diff`;
  }
  const from = Math.max(1, c.line_number - 2);
  const to = c.line_number + 2;
  // Beside lines over the row bound, the short rows are matched first, from
  // a bounded cache, so many citations there never read the long line.
  const long = snapshotText.longLines && snapshotText.byteLines ? snapshotText.longLines(c.file_path, from, to).filter((l) => l.bytes > 200 * 1024).map((l) => l.line) : [];
  if (long.length) {
    let count = 0;
    let next = from;
    const windows: ReturnType<typeof quoteLines>[] = [];
    for (const line of [...long, to + 1]) {
      if (line > next) {
        const window = shortLines(snapshotText, c.file_path, next, Math.min(to, line - 1));
        if (window.error) return `evidence ${at}: ${window.error}`;
        count += window.rows.length;
        windows.push(window);
      }
      if (line <= to) count++;
      next = line + 1;
    }
    // The end of the file is checked before any row can match.
    if (c.line_number - from >= count) return `evidence ${at}: the cited line is past the end of the file`;
    for (const window of windows) {
      const groups = [""];
      for (const row of window.rows) {
        if (row === null) groups.push("");
        else groups[groups.length - 1] += ` ${row}`;
      }
      if (groups.some((group) => normal(group).includes(quote))) return null;
    }
    const found = streamMatch(snapshotText, c.file_path, from, to, quote);
    if (found === "error") return `evidence ${at}: the file could not be read in the snapshot`;
    return found === "match" ? null : `evidence ${at}: the quote is not within two lines of the cited line`;
  }
  const window = quoteLines(snapshotText, c.file_path, from, to);
  if (window.error) return `evidence ${at}: ${window.error}`;
  if (c.line_number - from >= window.rows.length) return `evidence ${at}: the cited line is past the end of the file`;
  if (window.rows.some((row) => row === null)) {
    // Keep only enough normalised text to match this quote across fragment
    // boundaries. Checking evidence never grants whole-line read coverage.
    if (snapshotText.byteLines) {
      const found = streamMatch(snapshotText, c.file_path, from, to, quote);
      if (found === "error") return `evidence ${at}: the file could not be read in the snapshot`;
      if (found === "match") return null;
    } else {
      const raw = snapshotText(c.file_path);
      if (raw !== null && normal(raw.split("\n").slice(from - 1, to).join(" ")).includes(quote)) return null;
    }
  }
  const groups = [""];
  for (const row of window.rows) {
    if (row === null) groups.push("");
    else groups[groups.length - 1] += ` ${row}`;
  }
  const matches = groups.some((group) => normal(group).includes(quote));
  return matches ? null : `evidence ${at}: the quote is not within two lines of the cited line`;
}

// Matches `quote` against rows `from` to `to`, fragment by fragment, keeping
// only a tail as long as the quote. No line is ever held whole. One stream
// answers every expected citation that shares a long line with this one, and
// the answers are kept, so many citations of one long line read it once.
function streamMatch(read: SnapshotText, path: string, from: number, to: number, quote: string): StreamResult {
  const known = streamed(read);
  const key = streamKey(path, from, to, quote);
  const kept = known.results.get(key);
  if (kept) return kept;
  const long = new Set((read.longLines?.(path, from, to) ?? []).map((l) => l.line));
  const shares = (w: Window) => w.path === path && (read.longLines?.(path, w.from, w.to) ?? []).some((l) => long.has(l.line));
  const wanted = [{ path, from, to, quote }, ...known.expected.filter((w) => shares(w) && !known.results.has(streamKey(w.path, w.from, w.to, w.quote)))];
  const results = streamWindows(read, path, wanted);
  wanted.forEach((w, i) => remember(known, streamKey(w.path, w.from, w.to, w.quote), results[i]!));
  return results[0]!;
}

type StreamResult = "match" | "none" | "error";
type Window = { path: string; from: number; to: number; quote: string };
const streamKey = (path: string, from: number, to: number, quote: string) => `${path}\0${from}\0${to}\0${quote}`;

// Streams the union of the windows once. Each window keeps its own tail,
// fed only by its own rows, so each answer equals a stream of its rows alone.
function streamWindows(read: SnapshotText, path: string, windows: Window[]): StreamResult[] {
  const state = windows.map((w) => ({ w, tail: "", result: "none" as StreamResult }));
  const first = Math.min(...windows.map((w) => w.from));
  const last = Math.max(...windows.map((w) => w.to));
  let at = first;
  try {
    for (const { line, source } of read.byteLines!(path, first, last)) {
      at = line;
      const open = state.filter((s) => s.result === "none" && line >= s.w.from && line <= s.w.to);
      if (!open.length) continue;
      for (const fragment of lineFragments(source)) {
        for (const s of open) if (s.result === "none") {
          s.tail = (s.tail + fragment.text).replace(/\s+/g, " ");
          if (s.tail.includes(s.w.quote)) s.result = "match";
          else s.tail = s.tail.slice(-s.w.quote.length);
        }
        if (open.every((s) => s.result !== "none")) break;
      }
      for (const s of open) s.tail = (s.tail + " ").replace(/\s+/g, " ").slice(-s.w.quote.length);
    }
  } catch { return state.map((s) => s.result === "match" || s.w.to < at ? s.result : "error"); }
  return state.map((s) => s.result);
}

// Per reader: the citations an answer is about to check, and the streamed
// answers, kept up to about this many bytes of keys; the oldest go first.
const STREAMED_BYTES = 16 * 1024 * 1024;
const streams = new WeakMap<object, { expected: Window[]; results: Map<string, StreamResult>; bytes: number }>();
function streamed(read: SnapshotText) {
  let known = streams.get(read);
  if (!known) { known = { expected: [], results: new Map(), bytes: 0 }; streams.set(read, known); }
  return known;
}
function remember(known: ReturnType<typeof streamed>, key: string, result: StreamResult): void {
  if (known.results.has(key)) return;
  known.results.set(key, result);
  known.bytes += key.length * 2;
  for (const [old] of known.results) {
    if (known.bytes <= STREAMED_BYTES || old === key) break;
    known.results.delete(old);
    known.bytes -= old.length * 2;
  }
}

// Names the citations an answer holds, so the first long-line stream for
// one of them answers the others that share its long line.
function expectCitations(read: SnapshotText, citations: EvidenceCitation[]): void {
  streamed(read).expected = citations.filter((c) => !c.removed && normal(c.quote) !== "").map((c) => ({ path: c.file_path, from: Math.max(1, c.line_number - 2), to: c.line_number + 2, quote: normal(c.quote) }));
}

// The short rows beside a long line, kept per reader up to about this many
// bytes; the oldest windows go first.
const SHORT_ROWS_BYTES = 16 * 1024 * 1024;
const shortRows = new WeakMap<object, { windows: Map<string, ReturnType<typeof quoteLines>>; bytes: number }>();
const windowBytes = (window: ReturnType<typeof quoteLines>) => window.rows.reduce((n, row) => n + (row?.length ?? 0) * 2 + 16, 64);
function shortLines(read: SnapshotText, path: string, from: number, to: number): ReturnType<typeof quoteLines> {
  let known = shortRows.get(read);
  if (!known) { known = { windows: new Map(), bytes: 0 }; shortRows.set(read, known); }
  const key = `${path}\0${from}\0${to}`;
  let window = known.windows.get(key);
  if (!window) {
    window = quoteLines(read, path, from, to);
    known.windows.set(key, window);
    known.bytes += windowBytes(window);
    for (const [old, kept] of known.windows) {
      if (known.bytes <= SHORT_ROWS_BYTES || old === key) break;
      known.windows.delete(old);
      known.bytes -= windowBytes(kept);
    }
  }
  return window;
}

// The bytes the short-row cache holds for one reader, for tests.
export function evidenceCacheBytes(read: SnapshotText): number {
  return shortRows.get(read)?.bytes ?? 0;
}

export type RejectedEvidence = { candidate: FindCandidate; errors: string[] };
export function checkFindAnswer(value: unknown, unit: ReviewUnit, change: Change, snapshotText: SnapshotText, lenses: readonly string[] = []): { answer: FindAnswer; errors: string[]; answerErrors: string[]; rejected: RejectedEvidence[]; parsed: boolean } {
  const parsed = findSchema.safeParse(value);
  if (!parsed.success) return { answer: { version: "find-1", change_id: change.id, unit: unit.id, examined: [], analysis: [], candidates: [] }, errors: shapeErrors(parsed.error), answerErrors: shapeErrors(parsed.error), rejected: [], parsed: false };
  const answer = parsed.data;
  const errors: string[] = [];
  if (!sameChange(answer.change_id, change)) errors.push(`change_id: use ${change.shortId}`);
  if (answer.unit !== unit.id) errors.push(`unit: use ${unit.id}`);
  const required = unit.digest ? [{ id: unit.digest.id, path: unit.files[0], start: 0, end: 0 }] : unit.hunks;
  for (const h of required) {
    if (!answer.examined.includes(h.id)) errors.push(`hunk ${h.id} of ${h.path}:${h.start}-${h.end} was not examined`);
    if (!answer.analysis.some((a) => a.hunk === h.id)) errors.push(`analysis: hunk ${h.id} of ${h.path}:${h.start}-${h.end} needs its analysis`);
  }
  for (const id of [...answer.examined, ...answer.analysis.map((a) => a.hunk)]) if (!required.some((h) => h.id === id)) errors.push(`hunk ${id} is not in unit ${unit.id}`);
  const rejected: RejectedEvidence[] = [];
  expectCitations(snapshotText, answer.candidates.flatMap((c) => c.evidence));
  answer.candidates.forEach((c, i) => {
    if (c.lens && !lenses.includes(c.lens)) c.lens = null;
    const candidateErrors = proseErrors(`candidates[${i}].claim`, c.claim, null, FIELD_SENTENCE_LIMITS.problem);
    if (!change.files.some((f) => f.path === c.file_path && f.status === "deleted")) {
      const error = citedLineError(snapshotText, c.file_path, c.line_number);
      if (error) candidateErrors.push(`candidates[${i}].file_path: ${c.file_path}: ${error}`);
    }
    if (c.line_end !== undefined && c.line_end < c.line_number) candidateErrors.push(`candidates[${i}].line_end: it is before line_number`);
    for (const e of c.evidence) {
      const error = checkEvidence(e, snapshotText, change);
      if (error) candidateErrors.push(`candidates[${i}]: ${error}`);
    }
    if (candidateErrors.length) rejected.push({ candidate: c, errors: candidateErrors });
  });
  return { answer, errors: [...errors, ...rejected.flatMap((r) => r.errors)], answerErrors: errors, rejected, parsed: true };
}

// This repeats finalize.ts's private citesChange rule, including its
// 200-line bound. Finalize remains the judge of the assembled submission.
function citesChange(path: string, start: number, end: number, change: Change, lineCount: (path: string) => number | null): string | null {
  if (!change.files.some((f) => f.path === path)) return "the file is not in this change; cite a changed line, or a line next to a deletion";
  if (!change.coverage.get(path)?.has(start) && !(change.deletionPoints.get(path) ?? []).some((p) => p.anchors.includes(start))) return `line ${start} of ${path} is not a line this change added or modified; start the range on a changed line, or a line next to a deletion`;
  const count = lineCount(path);
  if (count !== null && end > count) return `line ${end} of ${path} does not exist; it has ${count} lines`;
  const span = end - start + 1;
  if (span > 200) return `the range spans ${span} lines; the limit is 200, so cite the lines that show the problem`;
  return null;
}

export function checkVerifyAnswer(value: unknown, batch: VerifyBatch, change: Change, snapshotText: SnapshotText, lineCount: (path: string) => number | null, scan?: ScanResult): { answer: VerifyAnswer; errors: string[] } {
  const parsed = verifySchema.safeParse(value);
  if (!parsed.success) return { answer: { version: "verify-1", change_id: change.id, verdicts: [] }, errors: shapeErrors(parsed.error) };
  const answer = parsed.data;
  const errors: string[] = [];
  if (!sameChange(answer.change_id, change)) errors.push(`change_id: use ${change.shortId}`);
  const ids = new Set(batch.candidates.map((c) => c.id));
  const banned = scannerTerms(scan ?? { candidates: batch.candidates.flatMap((c) => c.kind === "scanner" ? [c.candidate] : []), scanners: [] } as unknown as ScanResult);
  for (const c of batch.candidates) {
    const n = answer.verdicts.filter((v) => v.id === c.id).length;
    if (n !== 1) errors.push(`candidate ${c.id}: needs exactly one verdict, got ${n}`);
  }
  expectCitations(snapshotText, batch.candidates.flatMap((c) => c.kind === "finder" ? c.candidate.evidence : []));
  for (const v of answer.verdicts) {
    const at = `candidate ${v.id}`;
    if (!ids.has(v.id)) errors.push(`${at}: is not in this batch`);
    if (v.duplicate_of && (!ids.has(v.duplicate_of) || v.duplicate_of === v.id)) errors.push(`${at}.duplicate_of: name another id in this batch`);
    const c = batch.candidates.find((c) => c.id === v.id);
    if (c?.kind === "scanner" && v.verdict === "unresolved") errors.push(`${at}: a scanner candidate is confirmed or refuted`);
    if (c?.kind === "scanner" && v.verdict === "refuted") errors.push(...proseErrors(`${at}.reason`, v.reason, null, 2));
    if (v.line_end !== undefined && v.line_end < v.line_number) errors.push(`${at}.line_end: it is before line_number`);
    if (v.duplicate_of) {
      const target = answer.verdicts.find((item) => item.id === v.duplicate_of);
      if (v.verdict !== "confirmed" || target?.verdict !== "confirmed") errors.push(`${at}.duplicate_of: both candidates must be confirmed`);
      if (c?.kind === "scanner" && batch.candidates.find((item) => item.id === v.duplicate_of)?.kind === "finder") errors.push(`${at}.duplicate_of: a scanner candidate survives; mark the finder candidate as the duplicate`);
    }
    if (v.verdict === "confirmed") {
      for (const field of ["title", "problem", "consequence", "fix"] as const) {
        if (v[field].trim() === "") errors.push(`${at}.${field}: must not be empty`);
        errors.push(...proseErrors(`${at}.${field}`, v[field], banned, field === "title" ? null : FIELD_SENTENCE_LIMITS[field]));
      }
      if (!change.files.some((f) => f.path === v.file_path && f.status === "deleted")) {
        const error = citedLineError(snapshotText, v.file_path, v.line_number);
        if (error) errors.push(`${at}: ${v.file_path}: ${error}`);
      }
      const wrong = citesChange(v.file_path, v.line_number, v.line_end ?? v.line_number, change, lineCount);
      if (wrong) errors.push(`${at}: ${wrong}`);
      if (c?.kind === "finder") for (const e of c.candidate.evidence) {
        const error = checkEvidence(e, snapshotText, change);
        if (error) errors.push(`${at}: ${error}`);
      }
    }
  }
  // A duplicate cycle has no target that can carry the combined provenance.
  const links = new Map(answer.verdicts.filter((v) => v.duplicate_of).map((v) => [v.id, v.duplicate_of!]));
  for (const id of links.keys()) {
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next && links.has(next)) {
      if (seen.has(next)) { errors.push(`candidate ${id}.duplicate_of: duplicate links form a cycle`); break; }
      seen.add(next);
      next = links.get(next);
    }
  }
  return { answer, errors };
}
