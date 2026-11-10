// Byte ranges and cursors, built once without retaining patch payload rows.
import { closeSync, openSync, readSync } from "node:fs";
import type { ByteLine } from "./delivery.js";
import type { DiffEntry } from "./types.js";

export type DiffRange = { start: number; end: number; side?: "old" | "new"; old?: readonly [number, number] | null };
// `rowFrom` to `rowTo`: this page's payload rows in the index's row table.
type Span = { rowFrom: number; rowTo: number; group: number; offset: number; end: number; old: number; next: number; oldEnd: number; nextEnd: number; header: string; sectionHeader?: string; rows: number; additions: number; deletions: number };
export type PatchIndex = {
  bytes: number;
  readBytes: number;
  header: string;
  hunks: Span[];
  wholeHunks: Span[];
  removed: { after: number; oldStart: number; count: number }[];
  replacements: { start: number; end: number; oldStart: number; oldEnd: number }[];
  // Every payload row's start and end offsets, in pairs, and its marker
  // byte. Typed arrays, so a patch of millions of rows keeps no row objects.
  rows: { offsets: Float64Array; marks: Uint8Array; count: number };
  // Whether the patch's last row lacks a final LF.
  open: boolean;
};
const indexes = new WeakMap<DiffEntry, { text: string | undefined; file: string | undefined; index: PatchIndex; buffer?: Buffer }>();
const PAGE_BYTES = 64 * 1024;

// Capture at most a header's worth per row while indexing. Even a source
// line longer than a JavaScript string never needs to become a string here.
function* rows(entry: DiffEntry, from = 0, to = Infinity, onRead?: (bytes: number) => void): Generator<{ offset: number; end: number; head: string; open?: true }> {
  if (entry.text !== undefined) {
    let offset = 0;
    for (let at = 0; at < entry.text.length;) {
      const nl = entry.text.indexOf("\n", at);
      const end = nl === -1 ? entry.text.length : nl + 1;
      const bytes = Buffer.byteLength(entry.text.slice(at, end));
      onRead?.(bytes);
      if (offset >= to) break;
      if (offset >= from) yield { offset, end: offset + bytes, head: entry.text.slice(at, Math.min(end, at + PAGE_BYTES)).replace(/\n$/, ""), ...(nl === -1 ? { open: true as const } : {}) };
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
      onRead?.(n);
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
    if (offset > start) yield { offset: start, end: offset, head: prefix.toString("utf8"), open: true };
  } finally { closeSync(fd); }
}

export function patchIndex(entry: DiffEntry): PatchIndex {
  const cached = indexes.get(entry);
  if (cached && cached.text === entry.text && cached.file === entry.file) return cached.index;
  // A row takes at least two bytes with its LF, so a small text patch
  // starts with room for its rows only. A patch on disk starts at 1,024.
  const capacity = entry.text === undefined ? 1024 : Math.min(1024, Math.ceil(entry.text.length / 2) + 1);
  const index: PatchIndex = { bytes: 0, readBytes: 0, header: "", hunks: [], wholeHunks: [], removed: [], replacements: [], rows: { offsets: new Float64Array(2 * capacity), marks: new Uint8Array(capacity), count: 0 }, open: false };
  const addRow = (offset: number, end: number, mark: number) => {
    const table = index.rows;
    if (table.count === table.marks.length) {
      const offsets = new Float64Array(table.offsets.length * 2);
      offsets.set(table.offsets);
      const marks = new Uint8Array(table.marks.length * 2);
      marks.set(table.marks);
      table.offsets = offsets;
      table.marks = marks;
    }
    table.offsets[2 * table.count] = offset;
    table.offsets[2 * table.count + 1] = end;
    table.marks[table.count++] = mark;
  };
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
  for (const row of rows(entry, 0, Infinity, (n) => { index.readBytes += n; })) {
    index.bytes = row.end;
    index.open = row.open === true;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row.head);
    if (m) {
      closeRun();
      old = Number(m[1]) + Number(m[2] === "0");
      next = Number(m[3]) + Number(m[4] === "0");
      hunk = { rowFrom: index.rows.count, rowTo: index.rows.count, group: index.wholeHunks.length, offset: row.end, end: row.end, old, next, oldEnd: old, nextEnd: next, header: row.head, rows: 0, additions: 0, deletions: 0 };
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
        hunk = { rowFrom: index.rows.count, rowTo: index.rows.count, group: hunk.group, sectionHeader: hunk.sectionHeader, offset: row.offset, end: row.offset, old, next, oldEnd: old, nextEnd: next, header: "", rows: 0, additions: 0, deletions: 0 };
        index.hunks.push(hunk);
      }
      addRow(row.offset, row.end, marker!.charCodeAt(0));
      hunk.rowTo = index.rows.count;
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
  // Release the growth room once the row count is final.
  index.rows = { offsets: index.rows.offsets.slice(0, 2 * index.rows.count), marks: index.rows.marks.slice(0, index.rows.count), count: index.rows.count };
  indexes.set(entry, { text: entry.text, file: entry.file, index });
  return index;
}

// A pair can hold more than one section (a type change is a deletion then
// an addition), and each section restarts both cursors. The runs where the
// cursors rise are found once per span table.
const monotoneRuns = new WeakMap<Span[], number[]>();
function runsOf(spans: Span[]): number[] {
  let runs = monotoneRuns.get(spans);
  if (runs) return runs;
  runs = [0];
  for (let i = 1; i < spans.length; i++) if (spans[i]!.old < spans[i - 1]!.oldEnd || spans[i]!.next < spans[i - 1]!.nextEnd) runs.push(i);
  runs.push(spans.length);
  monotoneRuns.set(spans, runs);
  return runs;
}

// Within one run both cursors are monotone, including zero-length sides.
// Search each requested side in each run, then merge the page intervals.
function selected(spans: Span[], range?: DiffRange): [number, number][] {
  if (!range) return [[0, spans.length]];
  const interval = (start: number, end: number, side: "old" | "new", runFrom: number, runTo: number): [number, number] => {
    const first = side === "old" ? "old" : "next";
    const last = side === "old" ? "oldEnd" : "nextEnd";
    let lo = runFrom;
    let hi = runTo;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const span = spans[mid]!;
      if (Math.max(span[first], span[last] - 1) < start) lo = mid + 1; else hi = mid;
    }
    const from = lo;
    hi = runTo;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (spans[mid]![first] <= end) lo = mid + 1; else hi = mid;
    }
    return [from, lo];
  };
  const runs = runsOf(spans);
  const ranges: [number, number][] = [];
  for (let r = 0; r + 1 < runs.length; r++) {
    ranges.push(interval(range.start, range.end, range.side ?? "new", runs[r]!, runs[r + 1]!));
    if (range.old) ranges.push(interval(range.old[0], range.old[1], "old", runs[r]!, runs[r + 1]!));
  }
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

// cutRows: a page over maxBytes is read with each row cut to its first
// cutRows bytes, instead of skipped; for a reader that cuts long rows anyway.
export type DiffReadOptions = { oldRanges?: readonly (readonly [number, number])[]; exact?: boolean; sections?: boolean; original?: boolean; join?: boolean; groups?: ReadonlySet<number>; onLimit?: () => void; cutRows?: number };

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
      const firstAt = at;
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
        // The index keeps each row's offsets, so rows are found without reading them.
        const table = index.rows;
        for (let r = spans[firstAt]!.rowFrom; r < spans[at - 1]!.rowTo; r++) {
          const row = { offset: table.offsets[2 * r]!, end: table.offsets[2 * r + 1]! };
          const marker = String.fromCharCode(table.marks[r]!);
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
            index.readBytes += size;
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
      if (size > maxBytes && !options.cutRows) {
        if (!options.onLimit) throw new DiffReadLimit();
        options.onLimit();
        continue;
      }
      if (entry.text !== undefined) cached.buffer ??= Buffer.from(entry.text, "utf8");
      // Reads `length` bytes at `from` of the patch.
      const read = (from: number, length: number): Buffer => {
        const out = cached.buffer?.subarray(from, from + length) ?? Buffer.allocUnsafe(length);
        if (fd !== null) for (let at = 0; at < length;) {
          const n = readSync(fd, out, at, length - at, from + at);
          if (n === 0) throw new Error("the retained patch ended before its indexed hunk");
          at += n;
        }
        index.readBytes += length;
        return out;
      };
      let body: Buffer;
      if (size > maxBytes) {
        // Each row up to cutRows bytes, ending with its line feed.
        const parts: Buffer[] = [];
        for (let r = span.rowFrom; r < last.rowTo; r++) {
          const from = index.rows.offsets[2 * r]!;
          const end = index.rows.offsets[2 * r + 1]!;
          if (end - from <= options.cutRows!) parts.push(read(from, end - from));
          else parts.push(read(from, options.cutRows!), Buffer.from("\n"));
        }
        body = Buffer.concat(parts);
      } else body = read(span.offset, size);
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

// Locate long rows without reading their payload. The caller consumes each
// source before advancing the iterator, while its file descriptor is open.
export function* indexedLines(entry: DiffEntry, range: DiffRange): Generator<{ line: number; old: number; mark: string; source: ByteLine }> {
  const index = patchIndex(entry);
  const fd = entry.text === undefined ? openSync(entry.file!, "r") : null;
  const cached = indexes.get(entry)!;
  if (entry.text !== undefined) cached.buffer ??= Buffer.from(entry.text);
  const read = (from: number, length: number): Buffer => {
    index.readBytes += length;
    if (cached.buffer) return cached.buffer.subarray(from, from + length);
    const bytes = Buffer.allocUnsafe(length);
    for (let at = 0; at < length;) {
      const n = readSync(fd!, bytes, at, length - at, from + at);
      if (!n) throw new Error("the retained patch ended before its indexed line");
      at += n;
    }
    return bytes;
  };
  try {
    for (const [first, last] of selected(index.hunks, range)) for (let i = first; i < last; i++) {
      const span = index.hunks[i]!;
      const table = index.rows;
      let old = span.old;
      let next = span.next;
      for (let r = span.rowFrom; r < span.rowTo; r++) {
        const mark = String.fromCharCode(table.marks[r]!);
        const line = range.side === "old" ? old : next;
        if (line > range.end) break;
        if ((range.side === "old" ? mark === "-" : mark === "+" || mark === " ") && line >= range.start) {
          const offset = table.offsets[2 * r]! + 1;
          const end = table.offsets[2 * r + 1]!;
          // Only the patch's last row can lack its LF; the index knows which.
          const bytes = end - offset - Number(end > offset && !(index.open && end === index.bytes));
          yield { line, old, mark, source: { bytes, read: (from, length) => read(offset + from, Math.max(0, Math.min(length, bytes - from))) } };
        }
        if (mark === "-" || mark === " ") old++;
        if (mark === "+" || mark === " ") next++;
      }
    }
  } finally { if (fd !== null) closeSync(fd); }
}
