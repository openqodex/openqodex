// Round 4 of long lines as byte fragments, core side. Failures guarded: a
// path printed twice, "old line" with no old line, a non-text Read credited,
// an old-line range in `fragment`, a colon read as a range, a second secrets
// list, a stale removed-line layout, and a hand-built Change with no files.
import { afterAll, expect, it } from "vitest";
import { fragmentSecrets, hunkRows, partHeading, setFragmentSource } from "../src/brief-staged.js";
import { completionRecord, readCoverage, shortenedMissing } from "../src/completion.js";
import type { LineCount } from "../src/completion.js";
import { fileCoverageLines, renderReceipt } from "../src/render/review.js";
import { makeChange } from "../src/test-fixtures.js";
import type { Change, ReviewerRecord } from "../src/types.js";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const reviewer: ReviewerRecord = { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
const record = (change: Change, coverage: ReturnType<typeof readCoverage>) => completionRecord({ change, coverage, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false });
const counted = (long: Record<number, number>, text = true): LineCount => Object.assign(() => 1000, {
  longLines: (_path: string, start: number, end: number) => Object.entries(long).map(([line, bytes]) => ({ line: Number(line), bytes })).filter((l) => l.line >= start && l.line <= end),
  text: () => text,
});

it("R4.2 prints a fragment line's path once, from its label", () => {
  const change = makeChange({ coverage: new Map([["a.js", makeLineSet([7])]]), deletionPoints: new Map(), files: [] });
  const h = { id: "h1", path: "a.js", start: 7, end: 7, deletion: false, lineBytes: 6000, fragment: { of: "h1", from: 1, to: 6000 } };
  const coverage = readCoverage({ change, obligations: [h], briefCarried: [{ ...h, fragment: { of: "h1", from: 1, to: 4000 } }], delivered: [{ ...h, fragment: { of: "h1", from: 4001, to: 6000 } }], trace: [] });
  expect(fileCoverageLines(coverage)).toEqual(["a.js: line 7, bytes 1 to 4,000 of 6,000 brief, a.js: line 7, bytes 4,001 to 6,000 of 6,000 page"]);
  // A plain range first keeps the file prefix once.
  const two = makeChange({ coverage: new Map([["a.js", makeLineSet([1, 7])]]), deletionPoints: new Map(), files: [] });
  const plain = { id: "h2", path: "a.js", start: 1, end: 1, deletion: false };
  const both = readCoverage({ change: two, obligations: [plain, h], briefCarried: [plain, h], trace: [] });
  expect(fileCoverageLines(both)).toEqual(["a.js: 1 brief, a.js: line 7, bytes 1 to 6,000 of 6,000 brief"]);
});

it("R4.3 labels a removed fragment with no old line in the new-side form", () => {
  const change = makeChange({ coverage: new Map(), deletionPoints: new Map([["a.js", [{ after: 6, lines: 1, anchors: [6, 7] }]]]) });
  change.files = [{ path: "a.js", status: "renamed", oldPath: "old.js", binary: false }];
  const h = { path: "a.js", start: 6, end: 7, deletion: true, lineBytes: 6000, fragment: { from: 2001, to: 6000 } };
  const coverage = { hunks: 1, covered: 0, unread: [h], given: [], files: change.files, files_read: [], files_not_read: [] };
  expect(fileCoverageLines(coverage)).toEqual(["a.js: line 6, bytes 2,001 to 6,000 of 6,000 (deletion) not examined"]);
  const missing = record(change, coverage).missing;
  expect(missing.join("\n")).not.toContain("old line");
  expect(missing, JSON.stringify(missing)).toContain("  a.js: line 6, bytes 2,001 to 6,000 of 6,000 (deletion a.js#0)");
  expect(partHeading({ id: "h1", ...h }, true, change)).toBe("### h1 a.js 6-7 (a.js: line 6, bytes 2,001 to 6,000 of 6,000)");
  // With the old line on record, the old path and "old line" form.
  expect(partHeading({ id: "h1", ...h, old: [9, 9] }, true, change)).toBe("### h1 a.js 6-7 (old.js: old line 9, bytes 2,001 to 6,000 of 6,000)");
});

it("R4.6 credits a shared line only to the hunk its fragments name", () => {
  const change = { ...makeChange(), files: [{ path: "a.txt", status: "modified" as const, oldPath: null, binary: false }], coverage: new Map(), deletionPoints: new Map(), uncovered: [] };
  const A = { id: "h1", path: "a.txt", start: 1, end: 10, deletion: false };
  const B = { id: "h2", path: "a.txt", start: 10, end: 20, deletion: false };
  const page = { path: "a.txt", start: 10, end: 10, deletion: false, lineBytes: 5000, fragment: { of: "h2", from: 1, to: 2500 } };
  // The snapshot names line 10 as long, so A also looks at it by bytes.
  const c = readCoverage({ change, obligations: [A, B], lineCount: counted({ 10: 5000 }), delivered: [page, { path: "a.txt", start: 1, end: 9, deletion: false }, { path: "a.txt", start: 11, end: 20, deletion: false }], trace: [] });
  expect(c.unread.map((u) => [u.id, u.start, u.end, u.fragment])).toEqual([["h2", 10, 10, { of: "h2", from: 2501, to: 5000 }]]);
  expect(c.given).toContainEqual({ path: "a.txt", start: 1, end: 9, by: "page" });
  expect(c.given!.some((g) => g.start <= 10 && g.end >= 10)).toBe(false);
});

it("R4.7 credits nothing of a long line of a non-text file to a Read", () => {
  const change = { ...makeChange(), files: [{ path: "a.txt", status: "modified" as const, oldPath: null, binary: false }], coverage: new Map(), deletionPoints: new Map(), uncovered: [] };
  const h = { path: "a.txt", start: 1, end: 20, deletion: false };
  const trace = [{ tool: "Read", path: "a.txt", range: [1, 20] as [number, number], inside: true, ok: true, byteRanges: [{ line: 10, from: 1, to: 2000 }] }];
  const text = readCoverage({ change, obligations: [h], lineCount: counted({ 10: 1_000_000 }), trace });
  expect(text.unread[0]!.fragment).toEqual({ from: 2001, to: 1_000_000 });
  const bytes = readCoverage({ change, obligations: [h], lineCount: counted({ 10: 1_000_000 }, false), trace });
  expect(bytes.unread).toEqual([{ ...h, start: 10, end: 10, lineBytes: 1_000_000, fragment: { from: 1, to: 1_000_000 } }]);
  // Even a tool that returns lines whole decodes the file, so it credits none.
  const whole = readCoverage({ change, obligations: [h], lineCount: counted({ 10: 1_000_000 }, false), trace: [{ ...trace[0]!, byteRanges: undefined, whole: true as const }] });
  expect(whole.unread[0]!.fragment).toEqual({ from: 1, to: 1_000_000 });
});

it("R4.8 keeps a replacement deletion's old lines in `old`, never in `fragment`", () => {
  const change = makeChange({ coverage: new Map(), deletionPoints: new Map(), files: [] });
  const h = { path: "src/old.ts", start: 1, end: 2, deletion: { id: "src/old.ts#0", oldStart: 21, oldEnd: 30 } };
  const coverage = readCoverage({ change, obligations: [h], briefCarried: [h], trace: [] });
  expect(coverage.given).toEqual([{ path: "src/old.ts", start: 1, end: 2, deletion: "src/old.ts#0", old: [21, 30], by: "brief" }]);
  expect(fileCoverageLines(coverage)).toEqual(["src/old.ts: 1-2 (deletion src/old.ts#0, old lines 21-30) brief"]);
});

it("R4.9 ends the unread block at the first row that is not a range", () => {
  const change = makeChange({ coverage: new Map([["a.txt", makeLineSet(Array.from({ length: 12 }, (_, i) => i + 1))]]), deletionPoints: new Map() });
  const refs = Array.from({ length: 12 }, (_, i) => ({ id: `h${i + 1}`, path: "a.txt", start: i + 1, end: i + 1, deletion: false }));
  const missing = [...record(change, readCoverage({ change, obligations: refs, trace: [] })).missing, "the reviewer read outside the snapshot: /etc/hosts:1"];
  const short = shortenedMissing(missing);
  expect(short.at(-2)).toBe("and 2 more; the report names each one");
  expect(short.at(-1)).toBe("the reviewer read outside the snapshot: /etc/hosts:1");
});

it("R4.5 throws for a fragment path with no secrets list, and a second list never replaces the first", () => {
  const change = makeChange({ diffs: [{ path: "a.txt", text: `@@ -1 +0,0 @@\n-${"o".repeat(5000)}\n` }] });
  const ref = { id: "h1", path: "a.txt", start: 0, end: 0, deletion: { id: "a.txt#0", oldStart: 1, oldEnd: 1 }, old: [1, 1] as [number, number], lineBytes: 5000, fragment: { of: "h1", from: 1, to: 2000 } };
  expect(() => hunkRows(change, ref)).toThrow(/has no secrets list registered/);
  const list = ["SECRET"];
  setFragmentSource(change, () => [], list);
  // The same secrets keep the registered list; other secrets throw.
  setFragmentSource(change, () => [], ["SECRET"]);
  expect(fragmentSecrets(change)).toBe(list);
  expect(() => setFragmentSource(change, () => [], [])).toThrow(/different secrets list/);
  expect(() => hunkRows(change, ref, ["OTHER"])).toThrow(/differs/);
  expect(hunkRows(change, ref)).toHaveLength(1);
});

it("R4.18 rescans a removed line whose diffs were swapped for an equal-length one", () => {
  const change = makeChange({ diffs: [{ path: "a.txt", text: `@@ -1 +0,0 @@\n-${"a".repeat(3000)}SECRETONE${"b".repeat(3000)}\n` }] });
  setFragmentSource(change, () => [], ["SECRETONE", "SECRETTWO"]);
  const ref = { id: "h1", path: "a.txt", start: 0, end: 0, deletion: { id: "a.txt#0", oldStart: 1, oldEnd: 1 }, old: [1, 1] as [number, number], lineBytes: 6010, fragment: { of: "h1", from: 2001, to: 4000 } };
  expect(hunkRows(change, ref).join("\n")).toContain("[redacted]");
  // The same length, the secret now 100 bytes later: the old spans would misplace it.
  change.diffs = [{ path: "a.txt", text: `@@ -1 +0,0 @@\n-${"a".repeat(3100)}SECRETTWO${"b".repeat(2900)}\n` }];
  const rows = hunkRows(change, ref).join("\n");
  expect(rows).not.toContain("SECRETTWO");
  expect(rows).toContain(`${"a".repeat(1100)}[redacted]`);
});

it("R4.27 renders rows of a hand-built Change with an empty file list, and names a missing one", () => {
  const change = { files: [], diffs: [{ path: "big.ts", text: "@@ -0,0 +1,2 @@\n+a\n+b\n" }], deletionPoints: new Map() } as unknown as Change;
  expect(hunkRows(change, { id: "h1", path: "big.ts", start: 1, end: 2, deletion: false })).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
  const bare = { diffs: change.diffs, deletionPoints: new Map() } as unknown as Change;
  expect(() => hunkRows(bare, { id: "h1", path: "big.ts", start: 1, end: 2, deletion: false })).toThrow(/needs the change's file list/);
});

it("R4.2 receipt counts the one range as not examined", () => {
  const change = makeChange({ coverage: new Map([["a.js", makeLineSet([7])]]), deletionPoints: new Map() });
  const h = { id: "h1", path: "a.js", start: 7, end: 7, deletion: false, lineBytes: 6000, fragment: { of: "h1", from: 1, to: 6000 } };
  const coverage = readCoverage({ change, obligations: [h], briefCarried: [{ ...h, fragment: { of: "h1", from: 1, to: 4000 } }], trace: [] });
  const report = { completion: record(change, coverage), findings: [], observations: [], possible: [], not_reviewed: [], notes: [], stats: { files: 1, additions: 1, deletions: 0 }, change_id: "abcdef123456", base: { ref: "main" }, summary: null, verdict: "pass" } as never;
  expect(renderReceipt(report, { html: "r.html", md: "r.md" })).toContain("Changed ranges: 0 in a finder's brief, 0 structural summary, 0 by page, 0 read by the reviewer, 1 not examined");
});
