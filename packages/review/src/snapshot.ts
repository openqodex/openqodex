// Reading the frozen snapshot a review runs on: its files, one hash over
// them, line counts, text and the files Git LFS holds. Nothing here writes.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeGit } from "@openqodex/core";

// Every regular file under `dir` but the work tree's .git link file, by
// path relative to `dir`. Links (there are none: they were written as
// plain files) and anything else are skipped.
export function snapshotFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (path === ".git") continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

const CHUNK_BYTES = 64 * 1024;
// Anchor by lines for dense files and by bytes for wide rows.
const ANCHOR_LINES = 1024;
const ANCHOR_BYTES = 1024 * 1024;
export type LineIndex = { starts: readonly number[]; lines: readonly number[]; count: number; size: number; text: boolean };
type CachedIndex = { stamp: string; index: LineIndex };
// A snapshot directory belongs to one review. Hashing at the review's two
// boundaries invalidates it; cleanup releases anything subsequent reads cached.
const indexes = new Map<string, Map<string, CachedIndex>>();

export function clearLineIndexes(dir: string): void {
  indexes.delete(resolve(dir));
}

function snapshotPath(dir: string, path: string): string | null {
  const full = resolve(dir, path);
  const rel = relative(resolve(dir), full);
  return rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel === ".git" || rel.startsWith(".git/") ? null : full;
}

// Sparse byte offsets and their line numbers. A final LF does not invent a line.
// Build once by streaming; all consumers of this review share the index.
export function lineIndex(dir: string, path: string): LineIndex | null {
  const full = snapshotPath(dir, path);
  if (full === null) return null;
  let fd = -1;
  try {
    if (!lstatSync(full).isFile()) return null;
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const root = resolve(dir);
    let cache = indexes.get(root);
    if (!cache) indexes.set(root, (cache = new Map()));
    const cached = cache.get(full);
    if (cached?.stamp === stamp) return cached.index;
    const starts: number[] = st.size > 0 ? [0] : [];
    const lines: number[] = st.size > 0 ? [1] : [];
    let count = st.size > 0 ? 1 : 0;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    let text = true;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) {
      const chunk = buf.subarray(0, n);
      if (chunk.includes(0)) text = false;
      if (text) {
        try { decoder.decode(chunk, { stream: true }); } catch { text = false; }
      }
      for (let i = buf.subarray(0, n).indexOf(10); i !== -1; i = buf.subarray(0, n).indexOf(10, i + 1)) {
        if (offset + i + 1 < st.size) {
          const next = offset + i + 1;
          if (count % ANCHOR_LINES === 0 || next - starts[starts.length - 1]! >= ANCHOR_BYTES) {
            starts.push(next);
            lines.push(count + 1);
          }
          count++;
        }
      }
      offset += n;
    }
    if (text) {
      try { decoder.decode(); } catch { text = false; }
    }
    const index = { starts, lines, count, size: offset, text };
    cache.set(full, { stamp, index });
    return index;
  } catch {
    return null;
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

// Find one line from the nearest anchor, without keeping intervening rows.
function lineOffset(fd: number, index: LineIndex, line: number): number {
  if (line > index.count) return index.size;
  let lo = 0;
  let hi = index.lines.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (index.lines[mid]! <= line) lo = mid;
    else hi = mid - 1;
  }
  const anchor = lo;
  let at = index.starts[anchor]!;
  let current = index.lines[anchor]!;
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  while (current < line) {
    const n = readSync(fd, buf, 0, buf.length, at);
    if (n === 0) throw new Error("the snapshot ended before the indexed line");
    const chunk = buf.subarray(0, n);
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
      if (++current === line) return at + i + 1;
    }
    at += n;
  }
  return at;
}

// Inclusive, one-based lines, including their original line endings.
// The index refuses the whole file if any byte is not UTF-8 text.
export function readLines(dir: string, path: string, from: number, to: number, maxBytes = Infinity): string | null {
  const index = lineIndex(dir, path);
  if (index === null || !index.text) return null;
  const first = Math.max(1, from);
  if (first > index.count || to < first) return "";
  let fd = -1;
  try {
    fd = openSync(snapshotPath(dir, path)!, constants.O_RDONLY | constants.O_NOFOLLOW);
    const start = lineOffset(fd, index, first);
    const end = lineOffset(fd, index, Math.min(to, index.count) + 1);
    if (end - start > maxBytes) return null;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - start));
    const parts: string[] = [];
    for (let at = start; at < end;) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, end - at), at);
      if (n === 0) return null;
      const chunk = buf.subarray(0, n);
      if (chunk.includes(0)) return null;
      parts.push(decoder.decode(chunk, { stream: true }));
      at += n;
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch {
    return null;
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

// A single chunked pass over a window, keeping at most maxRowBytes of one
// row. Oversized rows have null text and keep their line number. Callers
// must check the index's whole-file text decision before using this iterator.
// I/O and decoding failures throw, so a partial window is never credited.
export function* readRows(dir: string, path: string, from: number, to: number, maxRowBytes: number): Generator<{ line: number; text: string | null }> {
  const index = lineIndex(dir, path);
  if (index === null || !index.text) throw new Error("the snapshot file is not text");
  const fd = openSync(snapshotPath(dir, path)!, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let line = Math.max(1, from);
    if (line > index.count || to < line) return;
    let at = lineOffset(fd, index, line);
    const last = Math.min(to, index.count);
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let parts: Buffer[] = [];
    let size = 0;
    const text = (): string | null => size > maxRowBytes ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts));
    while (at < index.size && line <= last) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, index.size - at), at);
      if (n === 0) throw new Error("the snapshot ended before the indexed row");
      at += n;
      let start = 0;
      while (start < n && line <= last) {
        const nl = chunk.subarray(0, n).indexOf(10, start);
        const end = nl === -1 ? n : nl + 1;
        const bytes = chunk.subarray(start, end);
        if (bytes.includes(0)) throw new Error("the snapshot row is not text");
        size += bytes.length;
        if (size <= maxRowBytes) parts.push(Buffer.from(bytes));
        else parts = [];
        if (nl !== -1) {
          yield { line, text: text() };
          line++;
          parts = [];
          size = 0;
        }
        start = end;
      }
    }
    if (size > 0 && line <= last) yield { line, text: text() };
  } finally { closeSync(fd); }
}

// Content, never size and mtime, proves that the snapshot did not change.
export function hashSnapshot(dir: string): string {
  clearLineIndexes(dir);
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  for (const path of snapshotFiles(dir)) {
    h.update(`${path}\0`);
    const fd = openSync(join(dir, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) h.update(buf.subarray(0, n));
    } finally { closeSync(fd); }
    h.update("\0");
  }
  return h.digest("hex");
}

export function lineCounter(dir: string): (path: string) => number | null {
  return (path) => lineIndex(dir, path)?.count ?? null;
}

// Keep the whole-file callback contract for report rendering. Range-aware
// consumers use its readLines member and never materialise a large file.
export type SnapshotText = ((path: string) => string | null) & {
  // A text file's actual count, without reading its rows; null otherwise.
  lineCount?: (path: string) => number | null;
  readLines?: (path: string, from: number, to: number, maxBytes?: number) => string | null;
  readRows?: (path: string, from: number, to: number, maxRowBytes: number) => Iterable<{ line: number; text: string | null }> | null;
};
export function snapshotText(dir: string, maxBytes = 5 * 1024 * 1024): SnapshotText {
  return Object.assign((path: string) => readLines(dir, path, 1, Infinity, maxBytes), {
    lineCount: (path: string) => {
      const index = lineIndex(dir, path);
      return index === null || !index.text ? null : index.count;
    },
    readRows: (path: string, from: number, to: number, maxRowBytes: number) => {
      const index = lineIndex(dir, path);
      return index === null || !index.text ? null : readRows(dir, path, from, to, maxRowBytes);
    },
    readLines: (path: string, from: number, to: number, rangeBytes = maxBytes) => readLines(dir, path, from, to, rangeBytes),
  });
}

// How many of `paths` the checkout stores in Git LFS: their content was not
// fetched, so the files hold pointers.
export async function lfsPaths(tree: string, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const r = await safeGit(tree, ["check-attr", "-z", "--stdin", "filter"], `${paths.join("\0")}\0`);
  if (r.code !== 0) return 0;
  const parts = r.stdout.toString("utf8").split("\0");
  let n = 0;
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") n++;
  return n;
}
