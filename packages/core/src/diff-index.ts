// Byte ranges and cursors, built once without retaining patch payload rows.
import { closeSync, openSync, readSync } from "node:fs";
import type { DiffEntry } from "./types.js";

export type DiffRange = { start: number; end: number; side?: "old" | "new"; old?: readonly [number, number] | null };
type Span = { group: number; offset: number; end: number; old: number; next: number; oldEnd: number; nextEnd: number; header: string; sectionHeader?: string; rows: number; additions: number; deletions: number };
export type PatchIndex = {
  bytes: number;
  header: string;
  hunks: Span[];
  wholeHunks: Span[];
  removed: { after: number; oldStart: number; count: number }[];
  replacements: { start: number; end: number; oldStart: number; oldEnd: number }[];
};
const indexes = new WeakMap<DiffEntry, { text: string | undefined; file: string | undefined; index: PatchIndex; buffer?: Buffer }>();
const PAGE_BYTES = 64 * 1024;

// Capture at most a header's worth per row while indexing. Even a source
// line longer than a JavaScript string never needs to become a string here.
function* rows(entry: DiffEntry, from = 0, to = Infinity): Generator<{ offset: number; end: number; head: string }> {
  if (entry.text !== undefined) {
    let offset = 0;
    for (let at = 0; at < entry.text.length;) {
      const nl = entry.text.indexOf("\n", at);
      const end = nl === -1 ? entry.text.length : nl + 1;
      const bytes = Buffer.byteLength(entry.text.slice(at, end));
      if (offset >= to) break;
      if (offset >= from) yield { offset, end: offset + bytes, head: entry.text.slice(at, Math.min(end, at + PAGE_BYTES)).replace(/\n$/, "") };
      offset += bytes;
      at = end;
    }
    return;
  }
  const fd = openSync(entry.file, "r");
  const buffer = Buffer.allocUnsafe(PAGE_BYTES);
  let offset = from;
  let start = from;
  let prefix: Buffer = Buffer.alloc(0);
  try {
    for (let n = readSync(fd, buffer, 0, Math.min(PAGE_BYTES, to - offset), offset); n > 0; n = readSync(fd, buffer, 0, Math.min(PAGE_BYTES, to - offset), offset)) {
      for (let at = 0; at < n;) {
        const nl = buffer.indexOf(10, at);
        const end = nl === -1 || nl >= n ? n : nl + 1;
        if (prefix.length < PAGE_BYTES) prefix = Buffer.concat([prefix, buffer.subarray(at, Math.min(end, at + PAGE_BYTES - prefix.length))]);
        offset += end - at;
        if (nl !== -1 && nl < n) {
          yield { offset: start, end: offset, head: prefix.toString("utf8").replace(/\n$/, "") };
          start = offset;
          prefix = Buffer.alloc(0);
        }
        at = end;
      }
    }
    if (offset > start) yield { offset: start, end: offset, head: prefix.toString("utf8") };
  } finally { closeSync(fd); }
}

export function patchIndex(entry: DiffEntry): PatchIndex {
  const cached = indexes.get(entry);
  if (cached && cached.text === entry.text && cached.file === entry.file) return cached.index;
  const index: PatchIndex = { bytes: 0, header: "", hunks: [], wholeHunks: [], removed: [], replacements: [] };
  let hunk: Span | undefined;
  let whole: Span | undefined;
  let sectionHeader = "";
  let activeSection = "";
  let old = 0;
  let next = 0;
  let run: { oldStart: number; oldEnd: number; start: number; end: number; after: number } | undefined;
  const closeRun = () => {
    if (!run) return;
    if (run.oldEnd >= run.oldStart) {
      if (run.end >= run.start) index.replacements.push({ start: run.start, end: run.end, oldStart: run.oldStart, oldEnd: run.oldEnd });
      else index.removed.push({ after: run.after, oldStart: run.oldStart, count: run.oldEnd - run.oldStart + 1 });
    }
    run = undefined;
  };
  for (const row of rows(entry)) {
    index.bytes = row.end;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row.head);
    if (m) {
      closeRun();
      old = Number(m[1]) + Number(m[2] === "0");
      next = Number(m[3]) + Number(m[4] === "0");
      hunk = { group: index.wholeHunks.length, offset: row.end, end: row.end, old, next, oldEnd: old, nextEnd: next, header: row.head, rows: 0, additions: 0, deletions: 0 };
      if (sectionHeader) { activeSection = sectionHeader; sectionHeader = ""; }
      if (activeSection) hunk.sectionHeader = activeSection;
      index.hunks.push(hunk);
      whole = { ...hunk };
      index.wholeHunks.push(whole);
    } else if (hunk && /^[+ \\-]/.test(row.head)) {
      const marker = row.head[0];
      if (hunk.end - hunk.offset >= PAGE_BYTES && marker !== "\\") {
        // A page is a valid hunk in its own right, including the first
        // page whose original header described the whole unsplit hunk.
        const oldCount = hunk.oldEnd - hunk.old;
        const newCount = hunk.nextEnd - hunk.next;
        const section = / @@(.*)$/.exec(hunk.header)?.[1] ?? "";
        hunk.header = `@@ -${hunk.old - Number(oldCount === 0)},${oldCount} +${hunk.next - Number(newCount === 0)},${newCount} @@${section}`;
        hunk = { group: hunk.group, sectionHeader: hunk.sectionHeader, offset: row.offset, end: row.offset, old, next, oldEnd: old, nextEnd: next, header: "", rows: 0, additions: 0, deletions: 0 };
        index.hunks.push(hunk);
      }
      if (marker === "-" || marker === "+") {
        run ??= { oldStart: old, oldEnd: old - 1, start: next, end: next - 1, after: next - 1 };
        if (marker === "-") { run.oldEnd = old; old++; hunk.deletions++; }
        else { run.end = next; next++; hunk.additions++; }
      } else if (marker === " ") { closeRun(); old++; next++; }
      hunk.end = row.end;
      hunk.oldEnd = old;
      hunk.nextEnd = next;
      if (marker !== "\\") hunk.rows++;
      whole!.end = row.end;
      whole!.oldEnd = old;
      whole!.nextEnd = next;
      if (marker !== "\\") whole!.rows++;
      if (marker === "+") whole!.additions++;
      else if (marker === "-") whole!.deletions++;
    } else {
      closeRun();
      hunk = undefined;
      if (index.wholeHunks.length === 0) index.header += `${row.head}\n`;
      else sectionHeader += `${row.head}\n`;
    }
  }
  closeRun();
  indexes.set(entry, { text: entry.text, file: entry.file, index });
  return index;
}

// Both cursors are monotone, including zero-length sides. Search each
// requested side independently, then merge their page intervals.
function selected(spans: Span[], range?: DiffRange): [number, number][] {
  if (!range) return [[0, spans.length]];
  const interval = (start: number, end: number, side: "old" | "new"): [number, number] => {
    const first = side === "old" ? "old" : "next";
    const last = side === "old" ? "oldEnd" : "nextEnd";
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const span = spans[mid]!;
      if (Math.max(span[first], span[last] - 1) < start) lo = mid + 1; else hi = mid;
    }
    const from = lo;
    hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (spans[mid]![first] <= end) lo = mid + 1; else hi = mid;
    }
    return [from, lo];
  };
  const ranges = [interval(range.start, range.end, range.side ?? "new")];
  if (range.old) ranges.push(interval(range.old[0], range.old[1], "old"));
  ranges.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of ranges) {
    if (r[0] === r[1]) continue;
    const prior = out.at(-1);
    if (prior && r[0] <= prior[1]) prior[1] = Math.max(prior[1], r[1]);
    else out.push(r);
  }
  return out;
}

export type DiffReadOptions = { oldRanges?: readonly (readonly [number, number])[]; exact?: boolean; sections?: boolean; original?: boolean; join?: boolean; groups?: ReadonlySet<number>; onLimit?: () => void };

// A hunk may itself be hundreds of MB. Pages retain its cursors, so a
// selected range reads only nearby bytes, and full walks release each page.
export class DiffReadLimit extends Error {
  constructor() { super("the requested diff rows exceed this reader's byte budget"); }
}

export function* indexedHunks(entry: DiffEntry, range?: DiffRange, maxBytes = Infinity, options: DiffReadOptions = {}): Generator<string> {
  const index = patchIndex(entry);
  const cached = indexes.get(entry)!;
  const spans = index.hunks;
  const fd = entry.text === undefined ? openSync(entry.file!, "r") : null;
  let previousGroup = -1;
  let previousSection = "";
  // Original headers describe every row in the group. Reject it before
  // yielding any page if a later page cannot be read under this budget.
  const skipped = new Set<number>();
  const noted = new Set<number>();
  if (options.original) for (const span of spans) if ((!options.groups || options.groups.has(span.group)) && span.end - span.offset > maxBytes) skipped.add(span.group);
  try {
    for (const [from, to] of selected(spans, range)) for (let at = from; at < to;) {
      const span = spans[at++]!;
      let last = span;
      // Joined selected pages keep a replacement's removed and added rows
      // in the same parsed hunk. Whole walks can still release each page.
      if (options.join) while (at < to && spans[at]!.group === span.group) last = spans[at++]!;
      if (options.groups && !options.groups.has(span.group)) continue;
      if (skipped.has(span.group)) {
        if (!options.onLimit) throw new DiffReadLimit();
        if (!noted.has(span.group)) { options.onLimit(); noted.add(span.group); }
        // Skip every remaining page, including pages selected later.
        while (at < to && spans[at]!.group === span.group) at++;
        continue;
      }
      if (options.exact && range) {
        let old = span.old;
        let next = span.next;
        let startOld = old;
        let startNext = next;
        let oldCount = 0;
        let newCount = 0;
        let bytes = 0;
        let oldAt = 0;
        let chunks: Buffer[] = [];
        const flush = () => {
          if (!chunks.length) return "";
          const header = `@@ -${startOld - Number(oldCount === 0)},${oldCount} +${startNext - Number(newCount === 0)},${newCount} @@`;
          const text = `${header}\n${Buffer.concat(chunks).toString("utf8")}`;
          chunks = [];
          oldCount = 0;
          newCount = 0;
          return text;
        };
        if (options.sections && span.sectionHeader && span.sectionHeader !== previousSection) {
          yield span.sectionHeader;
          previousSection = span.sectionHeader;
        }
        for (const row of rows(entry, span.offset, last.end)) {
          const marker = row.head[0];
          const oldRanges = options.oldRanges;
          while (oldRanges && oldAt < oldRanges.length && old > oldRanges[oldAt]![1]) oldAt++;
          const owned = !oldRanges || Boolean(oldRanges[oldAt] && old >= oldRanges[oldAt]![0]);
          const wanted = marker === "\\" ? chunks.length > 0 : marker === "-"
            ? range.side === "old" ? old >= range.start && old <= range.end : Boolean(owned && range.old && old >= range.old[0] && old <= range.old[1])
            : range.side !== "old" && next >= range.start && next <= range.end;
          if (wanted) {
            const size = row.end - row.offset;
            bytes += size;
            if (bytes > maxBytes) throw new DiffReadLimit();
            if (!chunks.length) { startOld = old; startNext = next; }
            const body = Buffer.allocUnsafe(size);
            if (fd !== null) for (let at = 0; at < size;) {
              const n = readSync(fd, body, at, size - at, row.offset + at);
              if (n === 0) throw new Error("the retained patch ended before its indexed row");
              at += n;
            }
            else { cached.buffer ??= Buffer.from(entry.text!, "utf8"); cached.buffer.copy(body, 0, row.offset, row.end); }
            chunks.push(body);
            if (marker === "-" || marker === " ") oldCount++;
            if (marker === "+" || marker === " ") newCount++;
          } else {
            const text = flush();
            if (text) yield text;
          }
          if (marker === "-" || marker === " ") old++;
          if (marker === "+" || marker === " ") next++;
        }
        const text = flush();
        if (text) yield text;
        continue;
      }
      const size = last.end - span.offset;
      if (size > maxBytes) {
        if (!options.onLimit) throw new DiffReadLimit();
        options.onLimit();
        continue;
      }
      if (entry.text !== undefined) cached.buffer ??= Buffer.from(entry.text, "utf8");
      const body = cached.buffer?.subarray(span.offset, last.end) ?? Buffer.allocUnsafe(size);
      if (fd !== null) for (let at = 0; at < size;) {
        const n = readSync(fd, body, at, size - at, span.offset + at);
        if (n === 0) throw new Error("the retained patch ended before its indexed hunk");
        at += n;
      }
      const oldCount = last.oldEnd - span.old;
      const newCount = last.nextEnd - span.next;
      const section = / @@(.*)$/.exec(span.header)?.[1] ?? "";
      const header = last === span && span.header ? span.header : `@@ -${span.old - Number(oldCount === 0)},${oldCount} +${span.next - Number(newCount === 0)},${newCount} @@${section}`;
      // Rewriting an incremental patch must preserve original hunk boundaries,
      // even though the reader releases its body one bounded page at a time.
      const prefix = options.original ? previousGroup === span.group ? "" : `${index.wholeHunks[span.group]!.header}\n` : `${header}\n`;
      previousGroup = span.group;
      const sectionHeader = options.sections && span.sectionHeader !== previousSection ? span.sectionHeader ?? "" : "";
      previousSection = span.sectionHeader ?? "";
      yield `${sectionHeader}${prefix}${body.toString("utf8")}`;
    }
  } finally { if (fd !== null) closeSync(fd); }
}
