// Round 3 of long lines as byte fragments, core side. Failures guarded: a patch
// measured on every cache call, one object per diff row, gaps counted as
// ranges, a cut Read credited whole, and fragments matched by line alone.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, expect, it, vi } from "vitest";
import { stagedDiffCache } from "../src/brief-staged.js";
import { completionRecord, readCoverage, shortenedMissing, singlePassCoverage } from "../src/completion.js";
import type { LineCount } from "../src/completion.js";
import { diffIndex } from "../src/diff.js";
import { makeChange } from "../src/test-fixtures.js";
import type { Change, ReviewerRecord } from "../src/types.js";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const reviewer: ReviewerRecord = { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
const record = (change: Change, coverage: ReturnType<typeof readCoverage>) => completionRecord({ change, coverage, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false });
// A line counter that names each long line, as the snapshot's does.
const counted = (long: Record<number, number>): LineCount => Object.assign(() => 1000, {
  longLines: (_path: string, start: number, end: number) => Object.entries(long).map(([line, bytes]) => ({ line: Number(line), bytes })).filter((l) => l.line >= start && l.line <= end),
});

it("R3.4 measures a 4 MB in-memory patch once over 200 cache calls", () => {
  const text = `@@ -0,0 +1 @@\n+${"x".repeat(4 * 1024 * 1024)}\n`;
  const change = makeChange({ diffs: [{ path: "a.txt", text }] });
  const cache = stagedDiffCache(change);
  const measure = vi.spyOn(Buffer, "byteLength");
  for (let i = 0; i < 200; i++) cache.file("a.txt");
  const counted = measure.mock.calls.filter(([value]) => value === text).length;
  measure.mockRestore();
  expect(counted).toBe(1);
});

it("R3.5 indexes a 2 million row patch in under 64 MB of extra memory", () => {
  const text = `@@ -0,0 +1,2000000 @@\n${"+x\n".repeat(2_000_000)}`;
  const change = makeChange({ diffs: [{ path: "a.txt", text }] });
  // Collect garbage first, so the count is what the index keeps. V8 frees
  // the memory of dead typed arrays in a background sweep that the next
  // collection finishes, so a second one keeps the 32 MB growth array the
  // index drops out of the count (a Linux runner once read 68.2 MB, not 36.2).
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const used = () => { gc(); gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
  const before = used();
  const index = diffIndex(change, "a.txt");
  const grown = used() - before;
  expect(index!.rows.count).toBe(2_000_000);
  console.log(`R3.5 a 2,000,000 row index added ${(grown / 1024 / 1024).toFixed(1)} MB`);
  expect(index).toBeTruthy();
  expect(grown).toBeLessThan(64 * 1024 * 1024);
}, 60_000);

it("R3.8 lists a range's byte gaps beneath it and counts ranges, not gaps", () => {
  const change = makeChange({ coverage: new Map([["a.txt", makeLineSet([1, 2, 3])]]), deletionPoints: new Map() });
  const h = { id: "h1", path: "a.txt", start: 1, end: 3, deletion: false };
  const middle = { path: "a.txt", start: 2, end: 2, deletion: false, lineBytes: 6000, fragment: { of: "h1", from: 2001, to: 4000 } };
  const coverage = readCoverage({ change, obligations: [h], lineCount: counted({ 2: 6000 }), delivered: [middle, { ...h, start: 1, end: 1 }, { ...h, start: 3, end: 3 }], trace: [] });
  expect(record(change, coverage).missing).toEqual([
    "1 changed range was not examined",
    "a.txt:1-3",
    "  a.txt: line 2, bytes 1 to 2,000 of 6,000",
    "  a.txt: line 2, bytes 4,001 to 6,000 of 6,000",
  ]);
  // The single pass keeps its inventory when a gap is a byte gap.
  const single = singlePassCoverage({ change, diffFiles: new Set(), lineCount: counted({ 2: 6000 }), trace: [{ tool: "Read", path: "a.txt", range: [1, 3], ok: true, inside: true, byteRanges: [{ line: 2, from: 1, to: 2000 }] }] });
  expect(record(change, single).missing[0]).toBe("1 changed range was not examined");
  // Twelve ranges of two gaps each: ten are listed with their gaps.
  const lines = Array.from({ length: 12 }, (_, i) => 10 * (i + 1));
  const many = makeChange({ coverage: new Map([["a.txt", makeLineSet(lines)]]), deletionPoints: new Map() });
  const refs = lines.map((line, i) => ({ id: `h${i + 1}`, path: "a.txt", start: line, end: line, deletion: false }));
  const pieces = refs.map((r) => ({ ...r, lineBytes: 6000, fragment: { of: r.id, from: 2001, to: 4000 } }));
  const all = record(many, readCoverage({ change: many, obligations: refs, lineCount: counted(Object.fromEntries(lines.map((l) => [l, 6000]))), delivered: pieces, trace: [] })).missing;
  expect(all[0]).toBe("12 changed ranges were not examined");
  const short = shortenedMissing(all);
  expect(short.at(-1)).toBe("and 2 more; the report names each one");
  expect(short.filter((m) => m.startsWith("  "))).toHaveLength(20);
});

it("R3.9 omits fragment.of on a route with no inventory id", () => {
  const change = makeChange({ coverage: new Map([["a.txt", makeLineSet([7])]]), deletionPoints: new Map() });
  const coverage = singlePassCoverage({ change, diffFiles: new Set(), lineCount: counted({ 7: 6000 }), trace: [], delivered: [{ path: "a.txt", start: 7, end: 7, deletion: false, lineBytes: 6000, fragment: { from: 1, to: 2000 } }] });
  expect(coverage.unread).toEqual([expect.objectContaining({ start: 7, end: 7, fragment: { from: 2001, to: 6000 } })]);
  expect(Object.keys(coverage.unread[0]!.fragment!)).toEqual(["from", "to"]);
});

it("R3.17 credits bytes 1 to 2,000 of a cut 1,000,000 byte line and leaves the rest unread", () => {
  // The probe-read case: one Read of lines 1 to 20 returned line 10 cut.
  const change = { ...makeChange(), files: [{ path: "a.txt", status: "modified" as const, oldPath: null, binary: false }], coverage: new Map(), deletionPoints: new Map(), uncovered: [] };
  const h = { path: "a.txt", start: 1, end: 20, deletion: false };
  const c = readCoverage({ change, obligations: [h], lineCount: counted({ 10: 1_000_000 }), trace: [{ tool: "Read", path: "a.txt", range: [1, 20], inside: true, ok: true, byteRanges: [{ line: 10, from: 1, to: 2000 }] }] });
  expect(c.covered).toBe(0);
  expect(c.unread).toEqual([
    { ...h, start: 10, end: 10, lineBytes: 1_000_000, fragment: { from: 2001, to: 1_000_000 } },
  ]);
  // Without recorded bytes, a Read credits none of the long line.
  const none = readCoverage({ change, obligations: [h], lineCount: counted({ 10: 1_000_000 }), trace: [{ tool: "Read", path: "a.txt", range: [1, 20], inside: true, ok: true }] });
  expect(none.unread).toEqual([{ ...h, start: 10, end: 10, lineBytes: 1_000_000, fragment: { from: 1, to: 1_000_000 } }]);
});

it("R3.21 lists a touching line's missing bytes under the hunk that owns them", () => {
  // The probe-touch case: A is lines 1 to 10, B lines 10 to 20, B owns line 10's bytes.
  // A is credited for lines 1 to 9; line 10's missing bytes are listed once, under B.
  const change = { ...makeChange(), files: [{ path: "a.txt", status: "modified" as const, oldPath: null, binary: false }], coverage: new Map(), deletionPoints: new Map(), uncovered: [] };
  const A = { id: "h1", path: "a.txt", start: 1, end: 10, deletion: false };
  const B = { id: "h2", path: "a.txt", start: 10, end: 20, deletion: false };
  const page = { path: "a.txt", start: 10, end: 10, deletion: false, lineBytes: 5000, fragment: { of: "h2", from: 1, to: 2500 } };
  const c = readCoverage({ change, obligations: [A, B], delivered: [page, { path: "a.txt", start: 1, end: 9, deletion: false }, { path: "a.txt", start: 11, end: 20, deletion: false }], trace: [] });
  expect(c.unread.map((u) => [u.id, u.start, u.end, u.fragment])).toEqual([
    ["h2", 10, 10, { of: "h2", from: 2501, to: 5000 }],
  ]);
  expect(c.given).toContainEqual({ path: "a.txt", start: 1, end: 9, by: "page" });
  expect(c.inventory![0]!.by).toBe("page");
});
