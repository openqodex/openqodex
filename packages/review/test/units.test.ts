// 1. Failure cases: unstable hunk ids, a hunk assigned twice or lost, small
// changes spawning too many sessions, oversized files staying in one unit.
// 7. Many hunks reparse snapshots and repeatedly render growing units.
// 8. A continuation owning a later replacement loses the earlier owner.
// 9. Oversized removed rows are described as an oversized new line.
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, hunkRows, readCoverage, completionRecord } from "@openqodex/core";
import { hunkRefs, obligations, unitsOf, GROUP_DIFF_BYTES, MAX_UNIT_DIFF_BYTES } from "../src/units.js";
import { deliverRanges } from "../src/conversation.js";
import { snapshotText } from "../src/snapshot.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupFixtures, fixture } from "./staged-fixture.js";

afterAll(cleanupFixtures);
function missing(change: ReturnType<typeof fixture>["change"], coverage: ReturnType<typeof readCoverage>) {
  return completionRecord({ change, coverage, reviewer: { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } }, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false });
}

it("gives ids in file and line order, including deletion anchors", () => {
  const { change } = fixture();
  change.coverage = new Map([["b.txt", new Set([8, 3])], ["a.txt", new Set([9])]]);
  change.deletionPoints.set("a.txt", [{ after: 1, anchors: [1, 2], lines: 1 }]);
  expect(hunkRefs(change).map((h) => [h.id, h.path, h.start])).toEqual([["h1", "a.txt", 1], ["h2", "a.txt", 9], ["h3", "b.txt", 3], ["h4", "b.txt", 8]]);
});
it("packs twelve 2 KB file diffs into at most two units without losing a hunk", () => {
  const { change } = fixture(Array.from({ length: 12 }, (_, i) => `${i}.txt`));
  change.diffs!.forEach((d) => { d.text = "x".repeat(2 * 1024); });
  const refs = hunkRefs(change);
  const units = unitsOf(change, refs);
  expect(units.length).toBeLessThanOrEqual(2);
  expect(units.every((u) => u.diffBytes <= GROUP_DIFF_BYTES)).toBe(true);
  expect(units.flatMap((u) => u.hunks)).toEqual(refs);
});
it("splits a 130 KB file diff at hunk ranges under 120 KB", () => {
  const { change } = fixture(["a.txt"]);
  change.coverage.set("a.txt", new Set([1, 10]));
  change.diffs![0]!.text = `@@ -1 +1 @@\n+${"x".repeat(65 * 1024)}\n@@ -10 +10 @@\n+${"y".repeat(65 * 1024)}\n`;
  const refs = hunkRefs(change);
  const units = unitsOf(change, refs);
  expect(units).toHaveLength(2);
  expect(units.every((u) => u.diffBytes <= MAX_UNIT_DIFF_BYTES)).toBe(true);
  expect(units.flatMap((u) => u.hunks)).toEqual(refs);
});
it("cuts a deletion over the bound into distinct old-side fragments", () => {
  const { change } = fixture(["a.txt"]);
  change.coverage.clear();
  change.deletionPoints.set("a.txt", [{ after: 0, lines: 9000, anchors: [1] }]);
  change.diffs = [{ path: "a.txt", text: "@@ -1,9000 +0,0 @@\n" + Array.from({ length: 9000 }, (_, i) => `-removed_${i}`).join("\n") + "\n" }];
  const refs = obligations(change, () => null);
  expect(refs.length).toBeGreaterThanOrEqual(3);
  expect(refs[0]!.deletion).toMatchObject({ id: "a.txt#0", oldStart: 1 });
  const intervals = refs.map((h) => h.old!);
  expect(intervals[0]![0]).toBe(1);
  expect(intervals.at(-1)![1]).toBe(9000);
  intervals.slice(1).forEach((range, i) => expect(range[0]).toBe(intervals[i]![1] + 1));
  expect(new Set(refs.map((h) => h.id)).size).toBe(refs.length);
  for (const h of refs) {
    const rows = hunkRows(change, h);
    expect(rows.length).toBeLessThanOrEqual(4000);
    expect(Buffer.byteLength(rows.join("\n"))).toBeLessThanOrEqual(MAX_UNIT_DIFF_BYTES);
  }
});

// 2. Snapshot-only entries must have measured weight, including page context.
it("does not group three 300 KB snapshot-only files as zero bytes", () => {
  const f = fixture(["a.txt", "b.txt", "c.txt"]);
  f.change.diffs = [];
  f.change.coverage.clear();
  f.change.uncovered = f.change.changedPaths;
  for (const path of f.change.changedPaths) writeFileSync(join(f.dir, path), "x".repeat(74) + "\n" + ("y".repeat(74) + "\n").repeat(4095));
  const refs = obligations(f.change, snapshotText(f.dir));
  const units = unitsOf(f.change, refs);
  expect(units.length).toBeGreaterThanOrEqual(9);
  expect(refs.every((h) => h.rows! <= 4000 && h.bytes! <= MAX_UNIT_DIFF_BYTES && h.bytes! > 0)).toBe(true);
  expect(units.flatMap((u) => u.hunks)).toEqual(refs);
});

// 3. Replacement old rows belong to one part, or to explicit old-side fragments.
it("renders 5000 removed rows once across a 9000-line replacement", () => {
  const f = fixture(["a.txt"]);
  f.change.coverage.set("a.txt", new Set(Array.from({ length: 9000 }, (_, i) => i + 1)));
  f.change.diffs = [{ path: "a.txt", text: "@@ -1,5000 +1,9000 @@\n" + "-old_row\n".repeat(5000) + "+new_row\n".repeat(9000) }];
  const refs = obligations(f.change, () => null);
  expect(refs.find((h) => !h.deletion)!.removedIn).toEqual([1, 2]);
  const rendered = refs.map((h) => hunkRows(f.change, h));
  expect(rendered.flat().filter((row) => row === "-old_row")).toHaveLength(5000);
  expect(rendered.flat().filter((row) => row === "+new_row")).toHaveLength(9000);
  for (const rows of rendered) {
    expect(rows.length).toBeLessThanOrEqual(4000);
    expect(Buffer.byteLength(rows.join("\n"))).toBeLessThanOrEqual(MAX_UNIT_DIFF_BYTES);
  }
});

// Failure case: a binary-only file starts finders without any hunk.
it("skips a changed file with no hunks", () => {
  const { change } = fixture(["a.txt"]);
  change.coverage.clear();
  expect(unitsOf(change, hunkRefs(change))).toEqual([]);
});

// 4. Metadata can overflow a brief even when its measured diff is small.
it("moves the last entry to a fresh unit when the real brief exceeds 256 KB", () => {
  const { change, config, scan } = fixture(["a.txt"]);
  const paths = Array.from({ length: 250 }, (_, i) => `${"long-directory/".repeat(50)}file-${i}.ts`);
  change.files = paths.map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  change.coverage = new Map(paths.map((path) => [path, new Set([1])]));
  change.diffs = paths.map((path) => ({ path, text: "@@ -0,0 +1 @@\n+x\n" }));
  const refs = obligations(change, () => "x\n");
  const render = (unit: import("@openqodex/core").ReviewUnit) => buildFindBrief({ change, config, scan, lenses: [], secrets: [] }, unit, "local").text;
  const units = unitsOf(change, refs, render);
  expect(units.length).toBeGreaterThan(1);
  expect(units.flatMap((u) => u.hunks)).toEqual(refs);
  expect(units.every((u) => Buffer.byteLength(render(u)) <= 256 * 1024)).toBe(true);
});

// 5. Empty intervals invent a line and credit unreadable files.
it("keeps an unreadable uncovered file missing after a Read of lines 1 to 5", () => {
  const f = fixture(["a.txt"]);
  f.change.coverage.clear();
  f.change.uncovered = ["a.txt"];
  f.change.diffs = [];
  const refs = obligations(f.change, () => null);
  const coverage = readCoverage({ change: f.change, obligations: refs, trace: [{ tool: "Read", path: "a.txt", inside: true, ok: true, range: [1, 5] }] });
  expect(coverage.unread).toEqual(refs);
  expect(coverage.given).toEqual([]);
  expect(missing(f.change, coverage)).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("a.txt:1")] });
  expect(refs[0]).toMatchObject({ start: 1, end: 0 });
  expect(refs[0]!.part).toBeUndefined();
});
it("keeps a deleted empty file without a part or a made-up removed row", () => {
  const f = fixture(["a.txt"]);
  f.change.coverage.clear();
  f.change.files[0]!.status = "deleted";
  f.change.deletionPoints.set("a.txt", [{ after: 0, lines: 0, anchors: [1] }]);
  f.change.diffs = [];
  const refs = obligations(f.change, () => null);
  expect(refs[0]!.part).toBeUndefined();
  expect(refs[0]!.old).toEqual([1, 0]);
  const page = deliverRanges({ snapshotDir: f.dir, unread: refs, secrets: [], change: f.change });
  expect(page.text).toContain("it held no lines");
  expect(page.text).not.toContain("-\t");
});

// 6. Fixed blocks overflow a single entry; replacement fragments cannot page.
it("notes a single entry whose real finder brief exceeds 256 KB instead of throwing", () => {
  const f = fixture(["a.txt"]);
  const refs = obligations(f.change, () => null);
  const render = (unit: import("@openqodex/core").ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [], impactBlock: "i".repeat(240 * 1024) }, unit, "local").text;
  const units = unitsOf(f.change, refs, render);
  expect(units).toHaveLength(0);
  expect(refs[0]!.note).toContain("MAX_BRIEF_BYTES");
  const brief = { carried: [] };
  const coverage = readCoverage({ change: f.change, obligations: refs, briefCarried: brief.carried, trace: [] });
  expect(coverage.unread).toEqual(refs);
  expect(missing(f.change, coverage)).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("a.txt:1")] });
});
it("leaves an uncarried replacement fragment missing because it has no deletion anchor to page", () => {
  const f = fixture(["a.txt"]);
  f.change.diffs = [{ path: "a.txt", text: "@@ -1,5000 +1 @@\n" + "-old_row\n".repeat(5000) + "+unsafe operation\n" }];
  const refs = obligations(f.change, () => "unsafe operation\n");
  const fragment = refs.find((h) => typeof h.deletion === "object" && h.deletion.id.includes("#replacement"))!;
  expect(fragment).toBeDefined();
  const page = deliverRanges({ snapshotDir: f.dir, unread: [fragment], secrets: [], change: f.change });
  expect(page.delivered).toEqual([]);
  const coverage = readCoverage({ change: f.change, obligations: [fragment], delivered: page.delivered, trace: [] });
  expect(coverage.unread).toEqual([fragment]);
  expect(missing(f.change, coverage)).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("a.txt:1")] });
});

it("bounds rendered hunk visits and snapshot reads for 1500 hunks", () => {
  const f = fixture(["a.txt"]);
  const lines = Array.from({ length: 1500 }, (_, i) => i * 13 + 1);
  f.change.coverage.set("a.txt", new Set(lines));
  f.change.diffs = [{ path: "a.txt", text: lines.map((n) => `@@ -${n} +${n} @@\n-old\n+new\n`).join("") }];
  let reads = 0;
  let visits = 0;
  const start = performance.now();
  const refs = obligations(f.change, () => { reads++; return "safe\n".repeat(20000); });
  const render = (unit: import("@openqodex/core").ReviewUnit) => {
    visits += unit.hunks.length;
    // Stop the old quadratic path early, without a timing-dependent assertion.
    if (visits > 4500) throw new Error("more than 4500 rendered hunk visits");
    return buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  };
  try {
    const units = unitsOf(f.change, refs, render);
    expect(units.flatMap((u) => u.hunks)).toEqual(refs);
    expect(visits).toBeLessThanOrEqual(4500);
    expect(reads).toBe(1);
  } finally { console.log(`1500 hunks: ${(performance.now() - start).toFixed(1)} ms, ${visits} rendered hunk visits, ${reads} snapshot reads`); }
});
it("packs the same units as rendering every trial on a small fixture", () => {
  const f = fixture(["a.txt", "b.txt", "c.txt"]);
  const refs = obligations(f.change, () => "unsafe operation\n");
  const render = (unit: import("@openqodex/core").ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  const slow: import("@openqodex/core").ReviewUnit[] = [];
  for (const ref of refs) {
    const prior = slow.at(-1);
    const trial = prior ? { ...prior, files: [...new Set([...prior.files, ref.path])], hunks: [...prior.hunks, ref], diffBytes: prior.diffBytes + ref.bytes! } : null;
    if (trial && trial.diffBytes <= (prior!.files.includes(ref.path) ? MAX_UNIT_DIFF_BYTES : GROUP_DIFF_BYTES) && trial.hunks.reduce((n, h) => n + h.rows!, 0) <= 4000 && Buffer.byteLength(render(trial)) <= 256 * 1024) slow[slow.length - 1] = trial;
    else slow.push({ id: `u${slow.length + 1}`, files: [ref.path], hunks: [ref], diffBytes: ref.bytes! });
  }
  expect(unitsOf(f.change, refs, render)).toEqual(slow);
});
it("names the earlier removal owner when a continuation owns a later replacement", () => {
  const f = fixture(["a.txt"]);
  f.change.coverage.set("a.txt", new Set(Array.from({ length: 5002 }, (_, i) => i + 1)));
  f.change.diffs = [{ path: "a.txt", text: "@@ -1,3 +1,5002 @@\n-old_first\n" + "+new_first\n".repeat(5000) + " keep\n-old_second\n+new_second\n" }];
  const refs = obligations(f.change, () => null);
  const continuation = refs.find((h) => h.start > 1 && h.old !== null)!;
  expect(continuation).toBeDefined();
  expect(continuation.removedIn).toBe(1);
  expect(hunkRows(f.change, continuation)).toContain("-old_second");
});
it("names removed rows when a replacement owner exceeds the budget", () => {
  const f = fixture(["a.txt"]);
  f.change.diffs = [{ path: "a.txt", text: "@@ -1 +1 @@\n-" + "x".repeat(130 * 1024) + "\n+new\n" }];
  const refs = obligations(f.change, () => "new\n");
  expect(refs.find((h) => h.deletion)!.note).toContain("removed row");
  expect(refs.find((h) => h.deletion)!.note).not.toContain("single line");
});
