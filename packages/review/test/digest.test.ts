// 1. JSON summaries hide short values, shapes, type changes or positions.
// 2. Names, markers and small changes bypass the measured digest gate.
// 3. Store summaries lose kinds, manifests, short files or paginated files.
// 4. A digest brief renders rows or accepts summary text as evidence.
// 5. Scalar thresholds, paired old rows and combined store budgets are misread.
// 6. Source content that resembles a section marker is silently truncated.
// 7. Long unchanged strings and Unicode scalar lengths are misreported.
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, buildVerifyBrief } from "@openqodex/core";
import type { HunkRef, ReviewUnit } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { jsonDigest, recognise, storeDigest } from "../src/digest.js";
import { MAX_BRIEF_BYTES, obligations, unitsOf } from "../src/units.js";
import { cleanupFixtures, fixture, candidate } from "./staged-fixture.js";

afterAll(cleanupFixtures);
const range = (path: string, end: number): HunkRef => ({ id: "h1", path, start: 1, end, deletion: false });
function setup(text: string, path = "runs.json") {
  const f = fixture(["a.txt"]);
  const count = text.replace(/\n$/, "").split("\n").length;
  f.change.files = [{ path, status: "added", oldPath: null, binary: false }];
  f.change.changedPaths = [path];
  f.change.coverage = new Map([[path, makeLineSet(Array.from({ length: count }, (_, i) => i + 1))]]);
  f.change.diffs = [{ path, text: `@@ -0,0 +1,${count} @@\n${text.replace(/\n$/, "").split("\n").map((r) => `+${r}`).join("\n")}\n` }];
  const args = { ...f, lenses: [], secrets: [] };
  const render = (unit: ReviewUnit) => buildFindBrief(args, unit, "local").text;
  const refs = obligations(f.change, () => text);
  return { ...f, args, refs, render, units: unitsOf(f.change, refs, render) };
}

it("names all 300 records' changed short scalars, long groups, odd records and numeric outliers", () => {
  const records = Array.from({ length: 300 }, (_, i) => ({ caseIds: [i], splitHash: `hash-${i}`, duration: i === 299 ? -10000 : 10, details: "long".repeat(i % 2 ? 70 : 80) }));
  const odd = { splitHash: "wrong", duration: "invalid" };
  const before = JSON.stringify([...records.slice(0, 299), { ...records[299], duration: 10 }], null, 2);
  const text = JSON.stringify([...records.slice(0, 299), odd], null, 2);
  const digest = jsonDigest("runs.data", text, [range("runs.data", text.split("\n").length)], before);
  expect(digest.kind).toBe("json");
  expect(digest.text).toContain("array length 300");
  for (let i = 0; i < 299; i++) {
    const line = text.split("\n").findIndex((r) => r.includes(`"hash-${i}"`)) + 1;
    expect(digest.text).toContain(`$[${i}].splitHash@${line} = "hash-${i}"`);
  }
  expect(digest.text).toContain("length 280-320");
  expect(digest.text).toContain("count 299");
  expect(digest.text).toContain('odd record $[299]');
  expect(digest.text).toContain(JSON.stringify(odd));
  expect(digest.text).toContain("number -> string");
  expect(digest.text).toContain("min 10, max 10");
  expect(digest.text).toContain("records $.[]: added 0, removed 0, changed 1");
  const outlier = jsonDigest("n", JSON.stringify(records), [range("n", 1)]);
  expect(outlier.text).toContain("outlier $[299].duration@1 = -10000");
  expect(outlier.processed).toEqual([range("n", 1)]);
  expect(digest.omitted.some((o) => o.why.includes("120"))).toBe(true);
});
it("tracks escaped strings and multiline values without guessing JSON line numbers", () => {
  const text = '{\n "a\\nb": [\n "escaped\\nline",\n "' + "x".repeat(2100) + '"\n ]\n}';
  const digest = jsonDigest("x", text, [range("x", 6)]);
  expect(digest.text).toContain('$["a\\nb"][0]@3 = "escaped\\nline"');
  expect(digest.text).toContain("string over 2000 characters");
  expect(digest.text).toContain("@4");
  expect(() => jsonDigest("bad", "{", [])).toThrow();
});
it.each([
  ["bad.json", "{\n".repeat(5000)],
  ["small.json", '{"ok":true}\n'],
  ["big.yaml", "key: value\n".repeat(5000)],
  ["big.ts", "// @generated\n" + "const x = 1;\n".repeat(5000)],
  ["vendor/x.go", "package x\n".repeat(5000)],
])("keeps %s on the parts route", (path, text) => {
  const f = setup(text, path);
  expect(f.units.length).toBeGreaterThan(0);
  expect(f.units.every((u) => !u.digest)).toBe(true);
});
it("uses a successful parse independent of extension and routes node_modules through the store gate", () => {
  expect(recognise("not.json", "{" )).toBeNull();
  expect(recognise("values.data", "[1,2]")).toBe("json");
  for (const path of ["node_modules/p/x", "a/.pnpm-store/v11/x", ".pnpm/x", ".yarn/cache/x", "site-packages/x", ".cargo/registry/x", ".m2/repository/x"]) expect(recognise(path, "code")).toBe("store");
  for (const path of ["vendor/x.go", "my_node_modules/x", ".yarn/caches/x", ".cargo/other/x"]) expect(recognise(path, "code")).toBeNull();
  const f = setup("module.exports = 1;\n".repeat(5000), "node_modules/p/x");
  expect(f.units.every((u) => u.digest?.kind === "store")).toBe(true);
});
it("renders a JSON summary with processed ranges, omissions and digest ids, without diff rows", () => {
  const f = setup(JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, value: "a".repeat(180), description: "b".repeat(180) })), null, 2));
  expect(f.units.length).toBeGreaterThan(1);
  const unit = f.units[0]!;
  expect(unit.digest?.kind).toBe("json");
  const brief = f.render(unit);
  expect(brief).toContain("### d1 runs.json (structural summary: json)");
  expect(brief).toContain('"examined": [\n    "d1"');
  expect(brief).toContain("Processed ranges:");
  expect(brief).not.toContain("```diff");
  expect(brief).not.toContain("### h1");
  const c = { ...candidate("runs.json"), line_number: 4 };
  const verified = buildVerifyBrief(f.args, { file: "runs.json", hunks: unit.hunks, candidates: [{ id: "k1", kind: "finder", candidate: c, foundBy: [] }], digest: unit.digest, citedText: "runs.json:4\nreal snapshot line" }).text;
  expect(verified).toContain("structural summary: json");
  expect(verified).toContain("real snapshot line");
});
it("counts store content and manifests and preserves complete short files and all ranges", () => {
  const files = [
    ["package.json", '{"name":"widget","version":"2.3.4"}'],
    ["map", '{"version":3,"sources":[],"mappings":""}'],
    ["code", "// @generated\nmodule.exports = 1;"],
    ["LICENSE", "Copyright example\nLicence text"],
    ["bin", "\u0000\u0001"],
    ["PKG-INFO", "Name: python-pkg\nVersion: 1.2"],
    ["Cargo.toml", '[package]\nname = "rust-pkg"\nversion = "3.4"'],
    ["a.pom", '<project><name>java-pkg</name><version>4.5</version></project>'],
  ].map(([name, text]) => ({ path: `node_modules/p/${name}`, text: text!, status: "added" as const, changed: [range(`node_modules/p/${name}`, text!.split("\n").length)] }));
  const digest = storeDigest("node_modules", files);
  expect(digest.text).toContain("files added 8, modified 0, deleted 0");
  for (const kind of ["JSON: 1", "source map: 1", "JavaScript or other code: 1", "binary: 1"]) expect(digest.text).toContain(kind);
  for (const manifest of ["widget 2.3.4", "python-pkg 1.2", "rust-pkg 3.4", "java-pkg 4.5"]) expect(digest.text).toContain(manifest);
  for (const file of files) expect(digest.text).toContain(`${file.path}:1-${file.changed[0]!.end}`);
  expect(digest.text).toContain("Licence text");
  expect(digest.text).toContain("generated/minified: node_modules/p/code");
  expect(digest.processed).toHaveLength(files.length);
});
it("paginates an over-budget store with every file owned once and each whole brief bounded", () => {
  const f = fixture(["a.txt"]);
  const paths = Array.from({ length: 1700 }, (_, i) => `.pnpm-store/${"directory/".repeat(9)}${i}`);
  f.change.files = paths.map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  f.change.changedPaths = paths;
  f.change.coverage = new Map(paths.map((path) => [path, makeLineSet(Array.from({ length: 31 }, (_, i) => i + 1))]));
  f.change.diffs = [];
  const refs = obligations(f.change, () => "licence text\n".repeat(31));
  const render = (unit: ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  const units = unitsOf(f.change, refs, render);
  expect(units.length).toBeGreaterThan(1);
  expect(units.every((u) => u.digest?.kind === "store")).toBe(true);
  expect(units.flatMap((u) => u.files).sort()).toEqual(paths.sort());
  expect(units.flatMap((u) => u.digest!.processed).sort()).toEqual(refs.map((h) => h.id).sort());
  expect(units.every((u) => Buffer.byteLength(render(u)) <= MAX_BRIEF_BYTES)).toBe(true);
});


it("shows a 199-character string in full, groups 200 characters and preserves numeric source values", () => {
  const text = JSON.stringify({ short: "s".repeat(199), long: "l".repeat(200) }).slice(0, -1) + ',"overflow":1e999,"negativeZero":-0}';
  const digest = jsonDigest("x", text, [range("x", 1)]);
  expect(digest.text).toContain(`$.short@1 = "${"s".repeat(199)}"`);
  expect(digest.text).toContain("long values $.long: count 1, length 200-200");
  expect(digest.text).toContain("$.overflow@1 = 1e999");
  expect(digest.text).toContain("$.negativeZero@1 = -0");
});
it("reads a type change from paired removed and added rows at the routing boundary", () => {
  const before = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, value: "a".repeat(180), other: "b".repeat(180) })), null, 2);
  const after = before.replace('"id": 15,', '"id": "fifteen",');
  const f = setup(after);
  f.change.files[0]!.status = "modified";
  f.change.diffs = [{ path: "runs.json", text: `@@ -1,${before.split("\n").length} +1,${after.split("\n").length} @@\n${before.split("\n").map((r) => `-${r}`).join("\n")}\n${after.split("\n").map((r) => `+${r}`).join("\n")}\n` }];
  const refs = obligations(f.change, () => after);
  const units = unitsOf(f.change, refs, f.render);
  expect(units[0]!.digest?.text).toContain("number -> string");
  expect(units[0]!.digest?.text).toContain("records $.[]: added 0, removed 0, changed 1");
});
it("keeps a small store on rows but digests its files when their combined rendered size exceeds the budget", () => {
  expect(setup("module.exports = 1;\n", "node_modules/p/x").units[0]!.digest).toBeUndefined();
  const f = fixture(["a.txt"]);
  const paths = ["node_modules/p/a", "node_modules/p/b"];
  f.change.files = paths.map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  f.change.coverage = new Map(paths.map((path) => [path, makeLineSet(Array.from({ length: 2500 }, (_, i) => i + 1))]));
  f.change.diffs = [];
  const refs = obligations(f.change, () => "licence text\n".repeat(2500));
  const units = unitsOf(f.change, refs);
  expect(units.every((u) => u.digest?.kind === "store")).toBe(true);
  expect(units.flatMap((u) => u.files)).toEqual(paths);
});
it("does not truncate a short store file that contains the summary's own section marker", () => {
  const f = fixture(["a.txt"]);
  const paths = ["node_modules/p/big", "node_modules/p/short"];
  f.change.files = paths.map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  f.change.coverage = new Map(paths.map((path) => [path, makeLineSet(Array.from({ length: path.endsWith("short") ? 3 : 5000 }, (_, i) => i + 1))]));
  f.change.diffs = [];
  const refs = obligations(f.change, (path) => path.endsWith("short") ? "before\nFile list:\nafter-marker" : "source text\n".repeat(5000));
  const units = unitsOf(f.change, refs);
  expect(units.find((u) => u.files.includes(paths[1]!))!.digest!.text).toContain("after-marker");
});
it("names long strings outside the changed scalar ranges without claiming their values changed", () => {
  const text = `{\n "unchanged": "${"x".repeat(2101)}",\n "changed": 2\n}`;
  const digest = jsonDigest("x", text, [{ ...range("x", 3), start: 3 }]);
  expect(digest.text).toContain("string over 2000 characters: $.unchanged@2");
  expect(digest.text).not.toContain("long values $.unchanged");
});
it("counts scalar characters without cutting a Unicode character in half", () => {
  const value = String.fromCodePoint(0x1f642).repeat(150);
  const digest = jsonDigest("x", JSON.stringify({ value }), [range("x", 1)]);
  expect(digest.text).toContain(`$.value@1 = ${JSON.stringify(value)}`);
  expect(digest.omitted).toEqual([]);
});
