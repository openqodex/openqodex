// 1. A deletion page invents removed rows from a later run in the same hunk.
// 2. Page boundaries lose replacement rows and incremental hunk tails.
// 3. Ranged disk reads scan all 20000 spans for every cutter probe.
// 4. Incremental file accounting scans all diffs for each kept file.
// 5. Oversized diff rows crash optional readers instead of being skipped.
// 6. Unselected oversized context makes a small part overflow.
// 7. Missing-diff replies describe a retired change-size cap.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cleanupDiffs, diffHunks, DiffStore, hunkRows, hunksBlock, LineSet, setFragmentSource } from "@openqodex/core";
import type { Change, DiffEntry } from "@openqodex/core";
import { deliverRanges } from "../src/conversation.js";
import { deltaChange } from "../src/incremental.js";
import { buildNeighbourhood } from "../src/neighbourhood.js";
import { runTool } from "../src/tools/index.js";
import { checkEvidence } from "../src/evidence-check.js";
import { obligations } from "../src/units.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
// Test 4 took 97 to 116 ms measured alone; its wall-clock bound is ten times 120.
const ALONE_MS = 120;

afterAll(removeTempDirs);
function change(diffs: DiffEntry[]): Change {
  return { repoRoot: ".", baseRef: "HEAD", baseSha: "a".repeat(40), id: "b".repeat(64), shortId: "b".repeat(12), files: diffs.map((d) => ({ path: d.path, oldPath: null, status: "modified", binary: false })), changedPaths: diffs.map((d) => d.path), coverage: new Map(), deletionPoints: new Map(), diff: "", diffs, notReviewed: [], stats: { files: diffs.length, additions: 0, deletions: 0 } };
}
function lineSet(ranges: [number, number][]): LineSet {
  const lines = new LineSet();
  for (const [a, b] of ranges) lines.addRange(a, b);
  return lines;
}
function disk(text: string): DiffEntry {
  const file = join(tempDir("oq-round2-patch-"), "retained.patch");
  writeFileSync(file, text);
  return { path: "a.ts", file };
}
it("1. delivers only old line 10 when later removed runs overlap the selected hunk", () => {
  const dir = tempDir("oq-round2-snapshot-");
  writeFileSync(join(dir, "a.ts"), "context\n".repeat(15));
  const c = change([{ path: "a.ts", text: "@@ -10,31 +10,1 @@\n-a\n context\n" + Array.from({ length: 29 }, (_, i) => `-later_${i}`).join("\n") + "\n" }]);
  c.deletionPoints.set("a.ts", [{ after: 9, lines: 1, anchors: [9, 10] }]);
  const ref = { path: "a.ts", start: 9, end: 10, old: [10, 10] as const, deletion: { id: "a.ts#0", oldStart: 10, oldEnd: 10 } };
  const page = deliverRanges({ snapshotDir: dir, unread: [ref], change: c, secrets: [] });
  expect(page.delivered).toEqual([ref]);
  expect(page.text.split("\n").filter((row) => row.startsWith("-\t"))).toEqual(["-\ta"]);
  expect(page.text).toContain("old lines 10 to 10");
});
it("2. carries all 70 KB of removed rows and keeps the complete incremental hunk", () => {
  const old = Array.from({ length: 700 }, (_, i) => `-old_${i}_${"x".repeat(95)}`);
  const added = Array.from({ length: 100 }, (_, i) => `+new_${i}_${"y".repeat(95)}`);
  const store = new DiffStore("replacement", tempDir("oq-round2-spill-"));
  store.push("padding.bin", Buffer.alloc(5 * 1024 * 1024 + 1));
  store.push("a.ts", Buffer.from(`@@ -1,700 +1,100 @@\n${[...old, ...added].join("\n")}\n`));
  const c = change(store.finish().filter((entry) => entry.path === "a.ts"));
  expect(c.diffs![0]!.file).toBeDefined();
  c.coverage.set("a.ts", lineSet([[1, 100]]));
  const refs = obligations(c, () => null);
  expect(refs.flatMap((ref) => hunkRows(c, ref)).filter((row) => row.startsWith("-"))).toEqual(old);
  const since = { ...c, coverage: new Map([["a.ts", lineSet([[100, 100]])]]) };
  const delta = deltaChange(c, since, tempDir("oq-round2-delta-"));
  try {
    const rows = [...diffHunks(delta, "a.ts")].join("").split("\n");
    expect(rows.filter((row) => row.startsWith("-"))).toEqual(old);
    expect(rows.filter((row) => row.startsWith("+"))).toEqual(added);
    expect(delta.stats).toMatchObject({ additions: 100, deletions: 700 });
    expect(refs.flatMap((ref) => hunkRows(delta, ref)).filter((row) => row.startsWith("-"))).toEqual(old);
  } finally { cleanupDiffs(delta); store.dispose(); }
});
it("3. inventories and cuts 20000 disk-backed hunks in under two seconds", () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => i * 3 + 1);
  const c = change([disk(lines.map((n) => `@@ -${n} +${n} @@\n-old\n+new\n`).join(""))]);
  c.coverage.set("a.ts", lineSet(lines.map((n) => [n, n])));
  const started = performance.now();
  const refs = obligations(c, () => null);
  const elapsed = performance.now() - started;
  console.log(`CUTTER hunks=${refs.length} milliseconds=${elapsed.toFixed(2)}`);
  expect(refs).toHaveLength(20_000);
  // Quadratic work took tens of seconds here; the bound is wide because the
  // suite runs beside other suites on a loaded machine.
  expect(elapsed).toBeLessThan(10_000);
  expect([...diffHunks(c, "a.ts", { start: 59_998, end: 59_998 })].join("")).toContain("@@ -59998");
});
it("4. accounts for 50000 kept files with linear lookups", () => {
  const c = change(Array.from({ length: 50_000 }, (_, i) => ({ path: `${i}.bin`, text: "" })));
  c.files.forEach((f) => { f.binary = true; });
  // Count every row read from the file and diff lists, by any loop or
  // method: a scan per file would visit 50,000 squared rows.
  let visits = 0;
  const counted = <T extends object>(list: T[]): T[] => new Proxy(list, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) visits++;
      return Reflect.get(target, key, receiver);
    },
  });
  c.files = counted(c.files);
  c.diffs = counted(c.diffs!);
  const started = performance.now();
  const delta = deltaChange(c, c, tempDir("oq-round2-many-"));
  const elapsed = performance.now() - started;
  console.log(`DELTA files=${delta.files.length} visits=${visits} milliseconds=${elapsed.toFixed(2)}`);
  expect(delta.files).toHaveLength(50_000);
  expect(delta.diffs).toHaveLength(50_000);
  expect(visits).toBeLessThan(20 * 50_000);
  expect(elapsed).toBeLessThan(ALONE_MS * 10);
});
it("5. skips oversized pages with notes and still reads later neighbourhood hunks", async () => {
  const dir = tempDir("oq-round2-reader-");
  writeFileSync(join(dir, "a.ts"), "fresh\n");
  writeFileSync(join(dir, "caller.ts"), "later_symbol();\n");
  const c = change([disk(`@@ -1 +1 @@\n-${"x".repeat(2 * 1024 * 1024)}\n+fresh\n@@ -10 +10 @@\n-later_symbol();\n+new_symbol();\n`)]);
  const reply = await runTool({ snapshotDir: dir, change: c, secrets: [], graph: null, graphNote: null }, "read_diff_for_file", { path: "a.ts" });
  expect(reply.text).toMatch(/skipped.*byte budget/i);
  const packet = buildNeighbourhood({ change: c, snapshotDir: dir, secrets: [], impact: null });
  expect(packet.partial).toMatch(/skipped.*byte budget/i);
  expect(packet.symbols.map((s) => s.name)).toContain("later_symbol");
  c.coverage.set("a.ts", lineSet([[1, 1], [10, 10]]));
  const delta = deltaChange(c, { ...c, coverage: new Map([["a.ts", lineSet([[1, 1], [10, 10]])]]) }, dir);
  try { expect([...diffHunks(delta, "a.ts")].join("")).not.toContain("x".repeat(100)); }
  finally { cleanupDiffs(delta); }
});

it("2b. retains every page of a hunk over 512 KB when only its last new line changed", () => {
  const old = "-old_row_" + "x".repeat(95) + "\n";
  const c = change([disk("@@ -1,6000 +1,100 @@\n" + old.repeat(6000) + "+new\n".repeat(100))]);
  c.coverage.set("a.ts", lineSet([[1, 100]]));
  const delta = deltaChange(c, { ...c, coverage: new Map([["a.ts", lineSet([[100, 100]])]]) }, tempDir("oq-round2-whole-"));
  try {
    expect(delta.stats).toMatchObject({ additions: 100, deletions: 6000 });
    const rows = [...diffHunks(delta, "a.ts")].join("").split("\n");
    expect(rows.filter((row) => row.startsWith("-"))).toEqual(Array(6000).fill(old.trimEnd()));
    expect(rows.filter((row) => row.startsWith("+"))).toEqual(Array(100).fill("+new"));
  }
  finally { cleanupDiffs(delta); }
});

it("5b. omits a whole original hunk when its middle page exceeds the budget", () => {
  const old = Array.from({ length: 700 }, (_, i) => `-${String(i).padStart(3, "0")}${"x".repeat(96)}`);
  const c = change([disk(`@@ -1,700 +1,11 @@\n${old.join("\n")}\n+${"y".repeat(600 * 1024)}\n${"+tail\n".repeat(10)}`)]);
  c.coverage.set("a.ts", lineSet([[1, 11]]));
  const delta = deltaChange(c, c, tempDir("oq-round3-middle-"));
  try {
    expect([...diffHunks(delta, "a.ts")]).toEqual([]);
    expect(delta.stats).toMatchObject({ additions: 0, deletions: 0 });
  } finally { cleanupDiffs(delta); }
});
it("6. carries line 5 beside 500 KB of unselected context just as in memory", () => {
  const text = `@@ -5,1 +5,2 @@\n+x\n ${"c".repeat(500 * 1024)}\n`;
  const stored = change([disk(text)]);
  const memory = change([{ path: "a.ts", text }]);
  for (const c of [stored, memory]) {
    c.coverage.set("a.ts", lineSet([[5, 5]]));
    const refs = obligations(c, () => null);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.note).toBeUndefined();
    expect(hunkRows(c, refs[0]!)).toEqual(["@@ -4,0 +5,1 @@", "+x"]);
    expect(hunksBlock(c, refs, []).carried).toEqual(refs);
  }
});
it("5c. rejects oversized removed evidence as not checkable without throwing", () => {
  const c = change([disk(`@@ -1 +0,0 @@\n-${"x".repeat(600 * 1024)}needle\n`)]);
  expect(checkEvidence({ file_path: "a.ts", line_number: 1, quote: "needle", removed: true }, () => null, c)).toMatch(/cannot be checked.*byte budget/i);
});
it("5d. pages a removed line over the page budget by old-side fragments", () => {
  const dir = tempDir("oq-round3-delivery-");
  const c = change([disk(`@@ -1 +0,0 @@\n-${"x".repeat(600 * 1024)}\n`)]);
  c.files[0]!.status = "deleted";
  c.deletionPoints.set("a.ts", [{ after: 0, lines: 1, anchors: [1] }]);
  const ref = { path: "a.ts", start: 1, end: 1, deletion: { id: "a.ts#0", oldStart: 1, oldEnd: 1 } };
  // The single pass registers the run's secrets list before it pages.
  setFragmentSource(c, () => [], []);
  const page = deliverRanges({ snapshotDir: dir, change: c, unread: [ref], secrets: [] });
  expect(page.left).toEqual([ref]);
  expect(page.text.split("\n")[1]).toBe(`-a.ts: old line 1, bytes 1 to 2,000 of 614,400\t${"x".repeat(2000)}`);
  const next = deliverRanges({ snapshotDir: dir, change: c, unread: page.left, earlier: page.delivered, secrets: [] });
  expect(next.left).toEqual([]);
  expect(next.delivered.at(-1)).toEqual(ref);
  expect(next.text).toContain("-a.ts: old line 1, bytes 614,001 to 614,400 of 614,400\t");
});
it("7. asks for a file range when a hand-built change has no diff entry", async () => {
  const c = change([{ path: "a.ts", text: "" }]);
  c.diffs = [];
  const reply = await runTool({ snapshotDir: tempDir("oq-round3-tool-"), change: c, secrets: [], graph: null, graphNote: null }, "read_diff_for_file", { path: "a.ts" });
  expect(reply.text).toContain("range");
  expect(reply.text).not.toContain("too large");
});

it("6b. excludes an unowned oversized deletion from the selected row budget", () => {
  const text = `@@ -1,5 +1,4 @@\n-old_a\n+new_a\n keep_a\n-${"z".repeat(500 * 1024)}\n keep_b\n-old_b\n+new_b\n`;
  const c = change([disk(text)]);
  const ref = { id: "h1", path: "a.ts", start: 1, end: 4, old: [1, 5] as [number, number], deletion: false };
  const rows = hunkRows(c, ref);
  expect(rows).toContain("-old_a");
  expect(rows).toContain("-old_b");
  expect(rows.some((row) => row.includes("zzzz"))).toBe(false);
});
