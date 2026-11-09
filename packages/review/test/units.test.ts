// Failure cases: unstable hunk ids, a hunk assigned twice or lost, small
// changes spawning too many sessions, oversized files staying in one unit.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { afterAll, expect, it } from "vitest";
import { buildFindBrief } from "@openqodex/core";
import { hunkRefs, unitsOf, GROUP_DIFF_BYTES, MAX_UNIT_DIFF_BYTES } from "../src/units.js";
import { cleanupFixtures, fixture } from "./staged-fixture.js";

afterAll(cleanupFixtures);

it("gives ids in file and line order, including deletion anchors", () => {
  const { change } = fixture();
  change.coverage = new Map([["b.txt", makeLineSet([8, 3])], ["a.txt", makeLineSet([9])]]);
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
  change.coverage.set("a.txt", makeLineSet([1, 10]));
  change.diffs![0]!.text = `@@ -1 +1 @@\n+${"x".repeat(65 * 1024)}\n@@ -10 +10 @@\n+${"y".repeat(65 * 1024)}\n`;
  const refs = hunkRefs(change);
  const units = unitsOf(change, refs);
  expect(units).toHaveLength(2);
  expect(units.every((u) => u.diffBytes <= MAX_UNIT_DIFF_BYTES)).toBe(true);
  expect(units.flatMap((u) => u.hunks)).toEqual(refs);
});
it("shows each deletion's own text when equal anchors fall in separate units", () => {
  const { change, config, scan } = fixture(["a.txt"]);
  change.coverage.clear();
  change.deletionPoints.set("a.txt", [{ after: 0, lines: 1, anchors: [1] }, { after: 1, lines: 1, anchors: [1] }]);
  const first = `first_${"a".repeat(MAX_UNIT_DIFF_BYTES)}`;
  const second = `second_${"b".repeat(MAX_UNIT_DIFF_BYTES)}`;
  change.diffs = [{ path: "a.txt", text: `@@ -1,3 +1 @@\n-${first}\n survivor\n-${second}\n` }];
  const refs = hunkRefs(change);
  expect(refs.map((h) => h.point)).toEqual([0, 1]);
  const units = unitsOf(change, refs);
  expect(units).toHaveLength(2);
  const briefs = units.map((unit) => buildFindBrief({ change, config, scan, lenses: [], secrets: [] }, unit, "local").text);
  expect(briefs[0]).toContain(`-${first}`);
  expect(briefs[0]).not.toContain(`-${second}`);
  expect(briefs[1]).toContain(`-${second}`);
  expect(briefs[1]).not.toContain(`-${first}`);
});

// Failure case: a binary-only file starts finders without any hunk.
it("skips a changed file with no hunks", () => {
  const { change } = fixture(["a.txt"]);
  change.coverage.clear();
  expect(unitsOf(change, hunkRefs(change))).toEqual([]);
});
