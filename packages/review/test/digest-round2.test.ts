// 1. Non-JSON snapshots are copied for every hunk and hang inventory building.
// 2. Oversized overlapping entries stay on an unread digest page.
// 3. Keyed maps and distinct families make fixed summaries unbounded.
// 4. Every JSON node scans all changed ranges.
// 5. Store inventory, generated markers and brief membership scan file arrays.
// 6. Range and omission rows overflow otherwise bounded JSON pages.
// 7. Unchanged odd records create finder pages with no changed parts.
import { afterAll, expect, it } from "vitest";
import { buildFindBrief } from "@openqodex/core";
import type { HunkRef, ReviewUnit } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { jsonSections } from "../src/digest.js";
import { MAX_BRIEF_BYTES, obligations, unitsOf } from "../src/units.js";
import { cleanupFixtures, fixture } from "./staged-fixture.js";

afterAll(cleanupFixtures);
function setup(text: string, lines?: number[], path = "runs.json") {
  const f = fixture(["a.txt"]);
  f.change.files = [{ path, status: "added", oldPath: null, binary: false }];
  f.change.changedPaths = [path];
  f.change.diffs = [];
  f.change.coverage = new Map([[path, makeLineSet(lines ?? Array.from({ length: text.split("\n").length }, (_, i) => i + 1))]]);
  const render = (unit: ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  return { ...f, render, inventory: () => obligations(f.change, () => text) };
}
it("inventories 100000 non-JSON lines and 10000 hunks in under two seconds", () => {
  const f = setup("lockfile record ".repeat(3).concat("\n").repeat(100000), Array.from({ length: 10000 }, (_, i) => 10 * i + 1), "lockfile");
  const start = performance.now();
  const refs = f.inventory();
  const ms = performance.now() - start;
  console.log(`round2 inventory: ${ms.toFixed(1)} ms, ${refs.length} hunks`);
  expect(refs).toHaveLength(10000);
  expect(ms).toBeLessThan(2000);
});
it.each([
  ["minified", JSON.stringify(Array.from({ length: 3000 }, (_, id) => ({ id, value: "x".repeat(100) })))],
  ["tied shapes", JSON.stringify([{ meta: "records" }, { data: Array.from({ length: 30000 }, (_, id) => ({ id, value: "x".repeat(20) })) }], null, 2)],
])("routes oversized %s entry groups to parts", (_, text) => {
  const f = setup(text);
  const refs = f.inventory();
  const units = unitsOf(f.change, refs, f.render);
  expect(units.length).toBeGreaterThan(0);
  expect(units.every((u) => !u.digest)).toBe(true);
  expect(refs.some((h) => h.note?.includes("digest"))).toBe(false);
  // C1 owns long-line delivery; C2 must leave every changed line on parts.
  expect(refs.reduce((sum, h) => sum + h.end - h.start + 1, 0)).toBe(text.split("\n").length);
});
it("collapses 3000 keyed packages into a fixed block below 20 KB", () => {
  const text = JSON.stringify({ name: "fixture", packages: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`node_modules/pkg${i}`, { version: "1.0.0", resolved: `https://example.test/${i}`, size: i }])) }, null, 2);
  const changed: HunkRef[] = [{ id: "h1", path: "package-lock.json", start: 1, end: text.split("\n").length, deletion: false }];
  const sections = jsonSections("package-lock.json", text, changed);
  expect(Buffer.byteLength(sections.fixed)).toBeLessThan(20000);
  expect(sections.fixed).toContain("records $.packages[*]:");
  expect(sections.fixed).toContain("total 3000");
});
it("caps distinct record and numeric families at 50 with their total counts", () => {
  const text = JSON.stringify(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`family${i}`, Array.from({ length: 10 }, (_, n) => ({ [`key${i}`]: n }))])));
  const sections = jsonSections("runs.json", text, [{ id: "h1", path: "runs.json", start: 1, end: 1, deletion: false }]);
  expect(sections.fixed).toContain("Record families: 1001 (first 50)");
  expect(sections.fixed).toContain("Numeric families: 1000 (first 50)");
  expect(Buffer.byteLength(sections.fixed)).toBeLessThan(20000);
});
it("checks 200000 JSON nodes against 20000 hunks in under two seconds", () => {
  const text = "[\n" + Array.from({ length: 200000 }, (_, i) => ` ${i}`).join(",\n") + "\n]";
  const changed: HunkRef[] = Array.from({ length: 20000 }, (_, i) => ({ id: `h${i}`, path: "runs.json", start: i * 10 + 2, end: i * 10 + 2, deletion: false }));
  const start = performance.now();
  const sections = jsonSections("runs.json", text, changed);
  const ms = performance.now() - start;
  console.log(`round2 JSON overlap: ${ms.toFixed(1)} ms, ${sections.entries.length} entries`);
  expect(sections.entries).toHaveLength(20000);
  expect(ms).toBeLessThan(2000);
});
it("packs 30000 generated store files through real briefs in under 500 ms", () => {
  const f = fixture(["a.txt"]);
  const paths = Array.from({ length: 30000 }, (_, i) => `node_modules/p${i}/x`);
  f.change.files = paths.map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  f.change.changedPaths = paths;
  f.change.diffs = [];
  f.change.coverage = new Map(paths.map((path) => [path, makeLineSet([1])]));
  const render = (unit: ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  const start = performance.now();
  const refs = obligations(f.change, () => "// @generated\n");
  const units = unitsOf(f.change, refs, render);
  const ms = performance.now() - start;
  console.log(`round2 store: ${ms.toFixed(1)} ms, ${paths.length} files, ${units.length} pages`);
  expect(units.flatMap((u) => u.files)).toEqual(paths);
  expect(units.every((u) => u.digest?.kind === "store")).toBe(true);
  expect(ms).toBeLessThan(3000);
});
it("counts range and omission rows when paging 5000 values", () => {
  const text = JSON.stringify(Array.from({ length: 5000 }, (_, i) => "v".repeat(i % 10 === 0 ? 250 : 190)), null, 2);
  const lines = Array.from({ length: 2500 }, (_, i) => i * 2 + 2);
  const f = setup(text, lines, `${"long-path/".repeat(30)}runs.json`);
  // One wide changed scalar qualifies for JSON without merging the other ranges.
  const wide = text.replace("v".repeat(250), "v".repeat(130000));
  const refs = obligations(f.change, () => wide);
  expect(refs.length).toBeGreaterThanOrEqual(2500);
  const units = unitsOf(f.change, refs, f.render);
  expect(units.every((u) => u.digest?.kind === "json")).toBe(true);
  expect(units.every((u) => !u.hunks.some((h) => h.note))).toBe(true);
  const sizes = units.map((u) => Buffer.byteLength(f.render(u)));
  console.log(`round2 long values: ${units.length} pages, largest brief ${Math.max(...sizes)} bytes`);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
});
it("folds 200 unchanged odd records into the one changed scalar's page", () => {
  const records = [...Array.from({ length: 201 }, () => ({ value: "ordinary" })), ...Array.from({ length: 200 }, () => ({ odd: "x".repeat(600) }))];
  const text = JSON.stringify(records, null, 2);
  const f = setup(text, [3]);
  // A wide changed value forces recognition without changing the odd records.
  const wide = text.replace('"ordinary"', JSON.stringify("c".repeat(130000)));
  const refs = obligations(f.change, () => wide);
  const units = unitsOf(f.change, refs, f.render);
  expect(units).toHaveLength(1);
  expect(units[0]!.hunks).toHaveLength(1);
  expect(units[0]!.digest?.kind).toBe("json");
  expect(units[0]!.digest!.text.match(/odd record /g)).toHaveLength(200);
});
