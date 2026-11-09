// Snapshot row byte sources, shared by streaming pages and the part cutter.
// The sparse index supplies a nearby anchor; no source line is materialised.
// Fragments are bytes, so any file serves them, text or not; lineFragments
// decodes bytes that are not UTF-8 leniently for display.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotText } from "./snapshot.js";
import type { ByteLine } from "@openqodex/core";
import { DELIVERY_ROW_BYTES } from "@openqodex/core";
import { lineCounter, lineIndex, snapshotReads, snapshotText } from "./snapshot.js";

// Each long line's start and end offsets, learnt once per file per review.
// Only lines over 2,000 bytes are kept, so the map holds at most one entry
// per 2,000 bytes of the file.
const bounds = new WeakMap<object, Map<number, [number, number]>>();
const longLengths = new WeakMap<object, Map<number, number>>();

export function* snapshotByteLines(dir: string, path: string, from: number, to: number): Generator<{ line: number; source: ByteLine }> {
  const index = lineIndex(dir, path);
  if (!index) return;
  let known = bounds.get(index);
  if (!known) { known = new Map(); bounds.set(index, known); }
  // The index already knows each long line's length, so its end needs no scan.
  let lengths = longLengths.get(index);
  if (!lengths) {
    lengths = new Map();
    for (let i = 0; i < index.long.length; i += 2) lengths.set(index.long[i]!, index.long[i + 1]!);
    longLengths.set(index, lengths);
  }
  const fd = openSync(join(dir, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const source = (offset: number, end: number): ByteLine => ({ bytes: end - offset, read(from, length) {
    length = Math.max(0, Math.min(length, end - offset - from));
    const bytes = Buffer.allocUnsafe(length);
    for (let n = 0; n < length;) {
      const got = readSync(fd, bytes, n, length - n, offset + from + n);
      if (!got) throw new Error("the snapshot ended before its indexed fragment");
      snapshotReads.bytes += got;
      n += got;
    }
    return bytes;
  } });
  // Where `line` starts: a saved neighbour's end, else a scan from the anchor.
  // The scan saves the bounds of long lines it passes, never of short ones.
  // The line this call yielded last, so a run of short lines never rescans.
  let previous: [number, number] | null = null;
  // The last chunk read stays, so a run of short lines reads each byte once.
  let held = { at: -1, n: 0 };
  const bytesAt = (at: number): Buffer => {
    if (at < held.at || at >= held.at + held.n) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, index.size - at), at);
      if (!n) throw new Error("the snapshot ended before its indexed line");
      snapshotReads.bytes += n;
      held = { at, n };
    }
    return chunk.subarray(at - held.at, held.n);
  };
  const startOf = (line: number): number | null => {
    const before = previous?.[0] === line - 1 ? [0, previous[1]] : known!.get(line - 1);
    if (before) return before[1] + 1;
    let anchor = 0;
    while (anchor + 1 < index.lines.length && index.lines[anchor + 1]! <= line) anchor++;
    let current = index.lines[anchor] ?? 1;
    let start = index.starts[anchor] ?? 0;
    if (current === line) return start < index.size ? start : null;
    for (let at = start; at < index.size;) {
      const bytes = bytesAt(at);
      for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) {
        if (at + i - start > DELIVERY_ROW_BYTES) known!.set(current, [start, at + i]);
        current++;
        start = at + i + 1;
        if (current === line) return start < index.size ? start : null;
      }
      at += bytes.length;
    }
    return null;
  };
  // Where the line that starts at `start` ends, its LF excluded.
  const endOf = (start: number): number => {
    for (let at = start; at < index.size;) {
      const bytes = bytesAt(at);
      const nl = bytes.indexOf(10);
      if (nl !== -1) return at + nl;
      at += bytes.length;
    }
    return index.size;
  };
  try {
    for (let line = Math.max(1, from); line <= to && line <= index.count; line++) {
      let saved = known.get(line);
      if (!saved) {
        const start = startOf(line);
        if (start === null) return;
        saved = [start, lengths.has(line) ? start + lengths.get(line)! : endOf(start)];
        if (saved[1] - saved[0] > DELIVERY_ROW_BYTES) known.set(line, saved);
      }
      previous = [line, saved[1]];
      yield { line, source: source(saved[0], saved[1]) };
    }
  } finally { closeSync(fd); }
}

// `longLines`: the lines over 2,000 bytes from `from` to `to`, with their lengths.
export type FragmentRead = SnapshotText & {
  byteLines?: (path: string, from: number, to: number) => Iterable<{ line: number; source: ByteLine }>;
  longLines?: (path: string, from: number, to: number) => { line: number; bytes: number }[];
};
export function fragmentSnapshotText(dir: string): FragmentRead {
  const count = lineCounter(dir);
  return Object.assign(snapshotText(dir), { byteLines: (path: string, from: number, to: number) => snapshotByteLines(dir, path, from, to), longLines: count.longLines });
}
