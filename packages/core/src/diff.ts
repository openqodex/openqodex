// Parse a unified diff into a map of (file -> set of new-side line numbers).
// The change source hands this a zero-context diff (`-U0`), so the set holds
// exactly the lines the developer added or changed; the changed-line filter
// keeps only findings on those lines.
//
// Only the new side is tracked: deleted lines exist only on the old side and
// cannot carry a finding. Context lines (" ") are counted too, which matters
// only if a diff with context is passed in. A hunk that only deletes is kept
// apart as a deletion point, so a finding can cite the lines around it.
import { statSync } from "node:fs";
import { indexedHunks, patchIndex } from "./diff-index.js";
import type { DiffRange, DiffReadOptions } from "./diff-index.js";
export { DiffReadLimit } from "./diff-index.js";
export type { DiffRange } from "./diff-index.js";
import { LineSet } from "./line-set.js";
import type { Change, DeletionPoint, DiffCoverage, DiffEntry } from "./types.js";

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

// git C-quotes a header path that carries a byte outside printable ASCII, a
// double quote or a backslash (core.quotePath, on by default):
// `+++ "b/caf\303\251.ts"`. Read verbatim, that names a file called
// `"b/caf\303\251.ts"`, quotes included, which no tool can open. Decodes it
// back to the real path; an unquoted path passes through untouched.
export function unquoteDiffPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const chars = Array.from(raw.slice(1, -1));
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...encoder.encode(chars[i]));
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      // Up to three octal digits: one byte of the UTF-8 encoding.
      let octal = "";
      while (octal.length < 3) {
        const digit = chars[i + 1];
        if (digit === undefined || digit < "0" || digit > "7") break;
        octal += digit;
        i++;
      }
      bytes.push(parseInt(octal, 8));
      continue;
    }
    bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseDiffCoverage(diff: string): DiffCoverage {
  const parser = createCoverageParser();
  for (const rawLine of diff.split("\n")) parser.push(rawLine);
  return parser.result();
}

// The same parser fed one line at a time, so a streamed diff is never held
// whole in memory.
export function createCoverageParser(): {
  push(rawLine: string): void;
  result(): DiffCoverage;
  deletionPoints(): Map<string, Omit<DeletionPoint, "anchors">[]>;
} {
  const out: DiffCoverage = new Map();
  const deleted = new Map<string, Omit<DeletionPoint, "anchors">[]>();
  let currentFile: string | null = null;
  let rightLine = 0;
  let runStart: number | null = null;
  const flush = (): void => {
    if (runStart !== null && currentFile !== null) out.get(currentFile)!.addRange(runStart, rightLine - 1);
    runStart = null;
  };

  // Header lines are only read in a block's preamble, before its first @@.
  // Inside hunk payload an added source line "++ x" renders as "+++ x" (SQL
  // comments are the natural real-world case), which would otherwise be
  // parsed as a file header and point every later line of coverage at a path
  // built from source text. Once inHunk is set, "+++ x" falls through to the
  // payload branch below and is counted as the added line it actually is.
  let inHunk = false;

  const push = (rawLine: string): void => {
    if (rawLine[0] !== "+" && rawLine[0] !== " ") flush();
    // File header on the new side: "+++ b/<path>", or "+++ /dev/null" for a
    // deletion. currentFile is set only when there is a new-side file.
    if (!inHunk && rawLine.startsWith("+++ ")) {
      // git ends a header path that contains a space with a tab; only that
      // tab is removed, so a name ending in a space keeps it.
      const target = unquoteDiffPath(rawLine.slice(4).replace(/\t$/, ""));
      if (target === "/dev/null") {
        currentFile = null;
      } else if (target.startsWith("b/")) {
        currentFile = target.slice(2);
        if (!out.has(currentFile)) out.set(currentFile, new LineSet());
      } else {
        // Some diff producers omit the b/ prefix; accept as-is.
        currentFile = target;
        if (!out.has(currentFile)) out.set(currentFile, new LineSet());
      }
      return;
    }
    if (!inHunk && rawLine.startsWith("--- ")) return;
    if (rawLine.startsWith("diff --git ")) {
      // New file boundary. Wait for the +++ line to set currentFile.
      currentFile = null;
      inHunk = false;
      return;
    }
    if (rawLine.startsWith("@@")) {
      inHunk = true;
      // Hunk header: @@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@ <ctx>
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      if (m) {
        rightLine = parseInt(m[2], 10);
        // An empty new side: git names the line before the deletion.
        if (m[3] === "0" && currentFile) {
          const points = deleted.get(currentFile) ?? [];
          points.push({ after: rightLine, lines: m[1] === undefined ? 1 : parseInt(m[1], 10) });
          deleted.set(currentFile, points);
        }
      }
      return;
    }
    if (!currentFile) return;

    const c = rawLine[0];
    if (c === "+") {
      runStart ??= rightLine;
      rightLine++;
    } else if (c === " ") {
      runStart ??= rightLine;
      rightLine++;
    }
    // "-" is an old-side line and does not advance the new side. Other
    // markers (the "\ No newline at end of file" sentinel, blank lines
    // outside any hunk) are ignored without changing line state.
  };
  return { push, result: () => { flush(); return out; }, deletionPoints: () => { flush(); return deleted; } };
}

// What one file's diff removed at each deletion point: the runs of removed
// lines with no added line beside them. `after` is the new side's line just
// before the run (0 at the top of the file), as the zero-context diff names
// it for the deletion point; `lines` is the removed text without its `-`.
// Read from the diff the change already holds (Change.diffs), the text the
// brief carries, so a deletion can be shown where the brief had no room.
export function removedRuns(fileDiff: string): { after: number; oldStart: number; lines: string[] }[] {
  const runs: { after: number; oldStart: number; lines: string[] }[] = [];
  let inHunk = false;
  // The new side's next line number.
  let next = 0;
  let old = 0;
  let run: { after: number; oldStart: number; lines: string[] } | null = null;
  let added = false;
  const close = (): void => {
    if (run !== null && !added) runs.push(run);
    run = null;
    added = false;
  };
  for (const line of fileDiff.split("\n")) {
    if (line.startsWith("@@")) {
      close();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      inHunk = m !== null;
      // An empty new side names the line before it, as in the parser above.
      if (m) {
        old = Number(m[1]);
        next = m[3] === "0" ? Number(m[2]) + 1 : Number(m[2]);
      }
    } else if (!inHunk || line.startsWith("\\")) {
      // A header, or the "\ No newline at end of file" sentinel.
    } else if (line.startsWith("-")) {
      run ??= { after: next - 1, oldStart: old, lines: [] };
      run.lines.push(line.slice(1));
      old++;
    } else if (line.startsWith("+")) {
      // Lines replaced, not only removed: no deletion point.
      added = true;
      next++;
    } else if (line.startsWith(" ")) {
      close();
      next++;
      old++;
    } else {
      // The next block's "diff --git" line, or the end.
      close();
      inHunk = false;
    }
  }
  close();
  return runs;
}

// One path index is shared by every consumer of the same per-file array.
const entries = new WeakMap<NonNullable<Change["diffs"]>, Map<string, DiffEntry>>();
export function diffEntry(change: Pick<Change, "diffs">, path: string): DiffEntry | undefined {
  const diffs = change.diffs;
  if (!diffs) return undefined;
  let index = entries.get(diffs);
  if (!index) { index = new Map(diffs.map((d) => [d.path, d])); entries.set(diffs, index); }
  return index.get(path);
}

export function diffSize(change: Pick<Change, "diffs">, path: string): number {
  const entry = diffEntry(change, path);
  return entry ? entry.text === undefined ? statSync(entry.file).size : Buffer.byteLength(entry.text, "utf8") : 0;
}

export function diffIndex(change: Pick<Change, "diffs">, path: string) {
  const entry = diffEntry(change, path);
  return entry ? patchIndex(entry) : null;
}

export function* diffHunks(change: Pick<Change, "diffs">, path: string, range?: DiffRange, maxBytes = Infinity, options: DiffReadOptions = {}): Generator<string> {
  const entry = diffEntry(change, path);
  if (entry) yield* indexedHunks(entry, range, maxBytes, options);
}

// Whole text is only for small patches. Large consumers walk diffHunks,
// optionally selecting the old or new line range they actually need.
export function diffText(change: Pick<Change, "diffs">, path: string): string | null {
  const entry = diffEntry(change, path);
  if (!entry) return null;
  if (entry.text !== undefined) return entry.text;
  if (diffSize(change, path) > 5 * 1024 * 1024) return null;
  return patchIndex(entry).header + [...indexedHunks(entry, undefined, 5 * 1024 * 1024, { sections: true })].join("");
}
