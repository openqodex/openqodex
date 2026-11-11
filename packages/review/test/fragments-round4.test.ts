// Round 4 of long lines as byte fragments. Failures guarded: page headings
// that name the new path for removed rows, a library call that drops the
// secrets list, thousands of notes when fixed blocks fill a brief, library
// callers that register an empty list, briefs rendered twice for short
// units, a top-level JSON string left undigested, short-line rescans, a
// single-pass brief cut from decoded text, long cited lines held whole, and
// a quote that ties several parts.
import { afterAll, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFindBrief, buildReviewerBrief, completionRecord, readCoverage, registeredSecrets, setFragmentSource, stagedDiffCache, verifyPartDistance } from "@openqodex/core";
import type { HunkRef, ReviewerRecord, ReviewUnit } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { hunkRefs, longestBrief, obligations, unitsOf } from "../src/units.js";
import { deliverRanges } from "../src/conversation.js";
import { checkEvidence, evidenceCacheBytes } from "../src/evidence-check.js";
import { fragmentSnapshotText, snapshotByteLines } from "../src/line-fragments.js";
import { snapshotReads } from "../src/snapshot.js";
import { candidate, cleanupFixtures, fixture } from "./staged-fixture.js";
afterAll(cleanupFixtures);

const reviewer: ReviewerRecord = { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
type Fixture = ReturnType<typeof fixture>;
const find = (f: Fixture, extra = 0, count?: { local: number; contracts: number }) => (unit: ReviewUnit, pass: "local" | "contracts") => {
  if (count) count[pass]++;
  return buildFindBrief({ ...f, secrets: [], lenses: [], instructions: extra ? "r".repeat(extra) : undefined }, unit, pass);
};

it("R4.4 heads a renamed file's pages with the old path for removed rows and the label form for long lines", () => {
  const f = fixture(["a.txt"]);
  f.change.files = [{ path: "a.txt", status: "renamed", oldPath: "old.txt", binary: false }];
  writeFileSync(join(f.dir, "a.txt"), "keep\n");
  f.change.coverage.clear();
  f.change.deletionPoints.set("a.txt", [{ after: 1, lines: 1, anchors: [1] }]);
  f.change.diffs = [{ path: "a.txt", text: `@@ -1,2 +1 @@\n keep\n-${"o".repeat(600 * 1024)}\n` }];
  setFragmentSource(f.change, (path, from, to) => snapshotByteLines(f.dir, path, from, to), []);
  const old = deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [], unread: [{ path: "a.txt", start: 1, end: 1, deletion: true }] }).text.split("\n");
  expect(old[0]).toBe("old.txt: old line 2, removed, in byte fragments:");
  expect(old[1]).toMatch(/^-old\.txt: old line 2, bytes 1 to 2,000 of 614,400\t/);
  const g = fixture(["a.txt"]);
  g.change.files = [{ path: "a.txt", status: "renamed", oldPath: "old.txt", binary: false }];
  writeFileSync(join(g.dir, "a.txt"), `keep\n${"n".repeat(600 * 1024)}\n`);
  const added = deliverRanges({ snapshotDir: g.dir, change: g.change, secrets: [], unread: [{ path: "a.txt", start: 2, end: 2, deletion: false }] }).text.split("\n");
  expect(added[0]).toBe("a.txt: line 2, in byte fragments (with context 1 to 1 before it):");
  expect(added[2]).toMatch(/^a\.txt: line 2, bytes 1 to 2,000 of 614,400\t/);
});

it("R4.5 keeps the inventory's secrets list when a library caller asks for hunkRefs", () => {
  const f = fixture(["a.txt"]);
  const list = ["SECRET12345678901234"];
  obligations(f.change, fragmentSnapshotText(f.dir), stagedDiffCache(f.change, list));
  hunkRefs(f.change);
  expect(registeredSecrets(f.change)).toBe(list);
});

it("R4.17 writes one note, not one per fragment, when fixed blocks alone fill a brief", () => {
  const f = fixture(["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "x".repeat(1024 * 1024) + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${"x".repeat(1024 * 1024)}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  const units = unitsOf(f.change, refs, (unit, both) => longestBrief(unit, find(f, 254 * 1024), both));
  // The inventory keeps one entry for the line, noted with the cause.
  const noted = refs.filter((h) => h.note);
  expect(units.flatMap((u) => u.hunks).filter((h) => h.fragment)).toEqual([]);
  expect(noted).toHaveLength(1);
  expect(noted[0]!.fragment).toMatchObject({ from: 1, to: 1024 * 1024 });
  expect(noted[0]!.note).toMatch(/fixed blocks .* exceed MAX_BRIEF_BYTES/);
  const coverage = readCoverage({ change: f.change, obligations: refs, briefCarried: units.flatMap((u) => u.hunks).filter((h) => !h.note), trace: [] });
  const missing = completionRecord({ change: f.change, coverage, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false }).missing;
  expect(missing.filter((m) => m.includes("bytes"))).toEqual(["  a.txt: line 1, bytes 1 to 1,048,576 of 1,048,576"]);
}, 60_000);

it("R4.21 refuses to cut a removed line for a library caller on a change with no secrets list", () => {
  const f = fixture(["a.txt"]);
  f.change.deletionPoints.set("a.txt", [{ after: 0, lines: 1, anchors: [1] }]);
  f.change.diffs = [{ path: "a.txt", text: `@@ -1 +0,0 @@\n-${"o".repeat(600 * 1024)}\n` }];
  const ref: HunkRef = { id: "h1", path: "a.txt", start: 1, end: 1, deletion: { id: "a.txt#0", oldStart: 1, oldEnd: 1 }, old: [1, 1], lineBytes: 600 * 1024, fragment: { of: "h1", from: 1, to: 600 * 1024 } };
  expect(() => unitsOf(f.change, [ref], (unit, both) => longestBrief(unit, find(f), both))).toThrow(/no secrets list registered/);
  expect(registeredSecrets(f.change)).toBeUndefined();
});

it("R4.22 renders each short unit's brief once, by the local pass alone", () => {
  const f = fixture(["a.txt", "b.txt"]);
  const count = { local: 0, contracts: 0 };
  const units = unitsOf(f.change, obligations(f.change, fragmentSnapshotText(f.dir)), (unit, both) => longestBrief(unit, find(f, 0, count), both));
  expect(units.length).toBeGreaterThan(0);
  expect(count.contracts).toBe(0);
  expect(count.local).toBeGreaterThan(0);
});

it("R4.23 digests a top-level JSON string over the part budget", () => {
  const f = fixture(["s.json"]);
  const text = JSON.stringify("v".repeat(600 * 1024));
  writeFileSync(join(f.dir, "s.json"), text + "\n");
  f.change.coverage.set("s.json", makeLineSet([1]));
  f.change.diffs = [{ path: "s.json", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const render = (unit: ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  const units = unitsOf(f.change, obligations(f.change, () => text), render);
  expect(units.length).toBeGreaterThan(0);
  expect(units.every((u) => u.digest?.kind === "json")).toBe(true);
});

it("R4.24 walks 100,000 short lines reading the file about once", () => {
  const f = fixture(["a.txt"]);
  const text = Array.from({ length: 100_000 }, (_, i) => `row ${i}`).join("\n") + "\n";
  writeFileSync(join(f.dir, "a.txt"), text);
  const before = snapshotReads.bytes;
  let lines = 0;
  for (const { source } of snapshotByteLines(f.dir, "a.txt", 1, 100_000)) { source.read(0, source.bytes); lines++; }
  expect(lines).toBe(100_000);
  expect(snapshotReads.bytes - before).toBeLessThan(4 * text.length);
});

it("R4.12 labels a Windows-1252 line in the single-pass brief by its snapshot bytes, as pages do", () => {
  const f = fixture(["a.txt"]);
  // 0xe9 is one byte in the file and three once decoded as UTF-8.
  const line = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("x".repeat(153_596))]);
  writeFileSync(join(f.dir, "a.txt"), Buffer.concat([line, Buffer.from("\n")]));
  f.change.coverage.set("a.txt", makeLineSet([1]));
  f.change.diffs = [{ path: "a.txt", text: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+${line.toString("utf8")}\n` }];
  const brief = buildReviewerBrief({ change: f.change, scan: f.scan, lenses: [], config: f.config, secrets: [], byteLines: (path, from, to) => snapshotByteLines(f.dir, path, from, to) }).text.split("\n");
  const rows = brief.filter((r) => r.startsWith("+a.txt: line 1, bytes ")).map((r) => r.split("\t")[0]!.slice(1));
  expect(rows[0]).toBe("a.txt: line 1, bytes 1 to 2,000 of 153,600");
  expect(rows.at(-1)).toBe("a.txt: line 1, bytes 152,001 to 153,600 of 153,600");
  // A page labels the same line with the same totals and offsets.
  const page = deliverRanges({ snapshotDir: f.dir, secrets: [], unread: [{ path: "a.txt", start: 1, end: 1, deletion: false }] });
  const paged = page.text.split("\n").filter((r) => r.startsWith("a.txt: line 1, bytes ")).map((r) => r.split("\t")[0]);
  expect(paged.length).toBeGreaterThan(0);
  expect(paged).toEqual(rows.slice(0, paged.length));
});

it("R4.19 verifies a mid-line quote on a 20 MB cited line without decoding it whole, with a bounded cache", () => {
  const f = fixture(["a.txt"]);
  const long = "z".repeat(10 * 1024 * 1024) + "needle in the middle" + "z".repeat(10 * 1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), `above\n${long}\nbelow\n`);
  const read = fragmentSnapshotText(f.dir);
  // The longest string built by joining or replacing text while checking:
  // a whole-line decode builds one of 20 MB.
  let largest = 0;
  const arrayJoin = Array.prototype.join;
  const replace = String.prototype.replace;
  Array.prototype.join = function (this: unknown[], ...args: Parameters<typeof arrayJoin>) { const out = arrayJoin.apply(this, args); largest = Math.max(largest, out.length); return out; } as typeof arrayJoin;
  String.prototype.replace = function (this: string, ...args: unknown[]) { largest = Math.max(largest, this.length); return (replace as (...a: unknown[]) => string).apply(this, args); } as typeof replace;
  try {
    expect(checkEvidence({ file_path: "a.txt", line_number: 2, quote: "needle in the middle" }, read, f.change)).toBeNull();
    expect(checkEvidence({ file_path: "a.txt", line_number: 2, quote: "not there" }, read, f.change)).toMatch(/not within two lines/);
    expect(checkEvidence({ file_path: "a.txt", line_number: 3, quote: "below" }, read, f.change)).toBeNull();
  } finally { Array.prototype.join = arrayJoin; String.prototype.replace = replace; }
  expect(largest).toBeGreaterThan(0);
  expect(largest).toBeLessThan(1024 * 1024);
  // Windows of 150 KB rows beside 250 KB lines would hold about 48 MB unbounded.
  const g = fixture(["b.txt"]);
  const rows = Array.from({ length: 200 }, (_, i) => i % 5 === 0 ? "l".repeat(250 * 1024) : `row ${i} `.padEnd(150 * 1024, "s"));
  writeFileSync(join(g.dir, "b.txt"), rows.join("\n") + "\n");
  const many = fragmentSnapshotText(g.dir);
  for (let line = 2; line <= 200; line += 5) expect(checkEvidence({ file_path: "b.txt", line_number: line, quote: `row ${line - 1} ` }, many, g.change)).toBeNull();
  expect(evidenceCacheBytes(many)).toBeGreaterThan(0);
  expect(evidenceCacheBytes(many)).toBeLessThanOrEqual(16 * 1024 * 1024);
}, 60_000);

it("R4.20 picks one part for a quote whose first 16 KB recurs in three parts", () => {
  const f = fixture(["a.txt"]);
  const head = "Q".repeat(17 * 1024);
  const at = [10_000, 250_000, 490_000];
  const tails = ["alpha", "beta", "gamma"];
  let text = "f".repeat(600_000);
  at.forEach((offset, i) => { const region = head + tails[i]; text = text.slice(0, offset) + region + text.slice(offset + region.length); });
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const parts = obligations(f.change, fragmentSnapshotText(f.dir));
  expect(parts.length).toBeGreaterThan(3);
  const own = (quote: string) => {
    const cited = [{ id: "k1", kind: "finder" as const, candidate: { ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 1, quote }] }, foundBy: [] }];
    return parts.filter((h) => verifyPartDistance(h, cited, f.change) === 0);
  };
  const covers = (h: HunkRef, offset: number) => h.fragment!.from <= offset + 1 && h.fragment!.to >= offset + 1;
  // The whole quote decides: only the third region holds "gamma".
  const third = own(head + "gamma");
  expect(third.length).toBeGreaterThan(0);
  expect(third.every((h) => h.fragment!.to >= at[2]! + 1 && h.fragment!.from <= at[2]! + head.length + 5)).toBe(true);
  // A quote found three times ties; the first in file order is carried.
  const tied = own(head);
  expect(tied.length).toBeGreaterThan(0);
  expect(tied.some((h) => covers(h, at[0]!) || covers(h, at[0]! + head.length - 1))).toBe(true);
  expect(tied.some((h) => covers(h, at[1]!) || covers(h, at[2]!))).toBe(false);
}, 60_000);
