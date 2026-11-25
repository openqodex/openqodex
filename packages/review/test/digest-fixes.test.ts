// 1. JSON pages lose scalars, split odd records or credit unsent parts.
// 2. Truncated decoded secrets leak into summaries and saved units.
// 3. Rebuilding 200,000 old lines overflows the argument stack.
// 4. Repeated numeric keys take quadratic time.
// 5. Malformed old JSON refuses a valid new side or repeats reconstruction.
// 6. Missing old sides invent added records and known change counts.
// 7. Inserted or moved records cause false changes by array index.
// 8. A full store page overflows the verifier brief and abandons a finding.
// 9. Unbounded manifests and loose generated markers overflow every page.
// 10. Deleted store files count as binary; changed keys lose multiline values.
// 11. A long numeric value shows its first 120 digits before redaction.
// 12. A scalar or array that becomes an object gets no type change entry.
// 13. A POM manifest names its parent's coordinates instead of its own.
// 14. A verifier digest lists an omission once per page it spans.
// 15. A POM with many openers left unclosed, or a long run of spaces after
//     one, makes the manifest scan rescan the text: quadratic time.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, buildVerifyBrief, readCoverage, stagedDiffCache } from "@openqodex/core";
import type { FindAnswer, HunkRef, ReviewUnit, VerifyBatch } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { jsonDigest, storeSections } from "../src/digest.js";
import { MAX_BRIEF_BYTES, citedDigest, obligations, unitsOf } from "../src/units.js";
import { runStagedReview } from "../src/stages.js";
import { expectLinearRepeated, growthTests, repeatedCpuMs } from "../../graph/src/test-timing.js";
import { cleanupFixtures, fixture, candidate, verdict } from "./staged-fixture.js";
afterAll(cleanupFixtures);
const ref = (end: number): HunkRef => ({ id: "h1", path: "runs.json", start: 1, end, deletion: false });
function jsonFixture(text: string, status: "added" | "modified" = "added", diff?: string, secrets: string[] = []) {
  const f = fixture(["runs.json"]);
  writeFileSync(join(f.dir, "runs.json"), text);
  f.change.files[0]!.status = status;
  const n = text.trimEnd().split("\n").length;
  f.change.coverage.set("runs.json", makeLineSet(Array.from({ length: n }, (_, i) => i + 1)));
  f.change.diffs = diff === undefined ? [] : [{ path: "runs.json", text: diff }];
  const shared = { ...f, lenses: [], secrets };
  const render = (unit: ReviewUnit) => buildFindBrief(shared, unit, "local").text;
  const refs = obligations(f.change, () => text, stagedDiffCache(f.change, secrets));
  return { ...f, refs, render, units: unitsOf(f.change, refs, render) };
}
it("paginates 3000 records with every scalar once and credits only sent pages", async () => {
  const records = Array.from({ length: 3000 }, (_, i) => Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`key${k}`, `${i}-${k}`.padEnd(40, "x")])));
  const f = jsonFixture(JSON.stringify(records, null, 2));
  expect(f.units.length).toBeGreaterThan(1);
  expect(f.units.every((u) => u.digest?.kind === "json")).toBe(true);
  const rows = f.units.flatMap((u) => u.digest!.text.split("\n").filter((row) => /^\$\[\d+\]\.key\d+@/.test(row)));
  expect(rows).toHaveLength(30000);
  expect(new Set(rows).size).toBe(30000);
  expect(f.units.every((u) => Buffer.byteLength(f.render(u)) <= MAX_BRIEF_BYTES)).toBe(true);
  const all = f.units.flatMap((u) => u.hunks);
  expect(readCoverage({ change: f.change, obligations: f.refs, trace: [], digestCarried: all.slice(0, -1) }).unread.length).toBeGreaterThan(0);
  expect(readCoverage({ change: f.change, obligations: f.refs, trace: [], digestCarried: all }).unread).toEqual([]);
  const briefs = new Map<string, ReviewUnit>();
  const result = await runStagedReview({ ...f, snapshotDir: f.dir, inventory: f.refs, units: f.units, secrets: [], deadline: Date.now() + 60000, now: Date.now, traced: false, say: () => {},
    findBrief: (unit, pass) => { const b = buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, pass); briefs.set(b.text, unit); return b; },
    verifyBrief: () => { throw new Error("No candidate needs verification."); },
    openSession: () => ({ close() {}, async send(text) {
      const unit = briefs.get(text)!;
      return { finalText: JSON.stringify({ version: "find-1", change_id: f.change.id, unit: unit.id, examined: ["d1"], analysis: [{ hunk: "d1", changed: "Records changed.", could_break: "Values can be invalid." }], candidates: [] }), calls: [], failure: null, sessionId: null, usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: 0 } };
    } }),
  });
  expect(result.missing).toEqual([]);
  expect(result.sessions).toHaveLength(2 * f.units.length);
  expect(readCoverage({ change: f.change, obligations: result.obligations, trace: [], digestCarried: result.digestCarried }).unread).toEqual([]);
  console.log(`JSON pagination: 30000 scalar rows in, ${rows.length} unique rows out, ${f.units.length} pages, ${result.sessions.length} sent briefs`);
});
it("redacts a decoded 300-character secret before truncating scalar and odd-record text", () => {
  const token = "jwt/" + "a".repeat(296);
  const text = JSON.stringify([{ token, extra: "odd" }, { token: "safe" }, { token: "safe" }], null, 2).replaceAll("/", "\\/");
  const digest = jsonDigest("runs.json", text, [ref(30)], undefined, [token.replaceAll("/", "\\/")]);
  expect(digest.text).not.toContain(token.slice(0, 120));
  expect(digest.text).toContain("[redacted]");
  const large = JSON.stringify([{ token, extra: "odd" }, ...Array.from({ length: 1200 }, () => ({ token: "safe", value: "v".repeat(100) }))], null, 2).replaceAll("/", "\\/");
  const f = jsonFixture(large, "added", undefined, [token.replaceAll("/", "\\/")]);
  expect(f.units.every((u) => u.digest?.kind === "json")).toBe(true);
  for (const unit of f.units) {
    expect(JSON.stringify(unit)).not.toContain(token.slice(0, 120));
    expect(f.render(unit)).not.toContain(token.slice(0, 120));
  }
});
it("digests a modified 200000-line JSON snapshot without an argument-stack crash", () => {
  const text = "[\n" + " 1,\n".repeat(199997) + " 1\n]";
  const diff = "@@ -1,5000 +1,5000 @@\n" + text.split("\n").slice(0, 5000).map((row) => `+${row}`).join("\n") + "\n";
  const f = jsonFixture(text, "modified", diff);
  expect(f.units.every((u) => u.digest?.kind === "json")).toBe(true);
});
it("digests 200000 numbers in under two seconds", () => {
  const text = JSON.stringify(Array.from({ length: 200000 }, (_, i) => i));
  const start = performance.now();
  const digest = jsonDigest("runs.json", text, [ref(1)]);
  const ms = performance.now() - start;
  console.log(`200000-number array: ${ms.toFixed(1)} ms`);
  expect(digest.text).toContain("numeric $.[]: count 200000");
  expect(ms).toBeLessThan(2000);
});
it("digests a valid new JSON side even when reconstructed old JSON is malformed", () => {
  const text = JSON.stringify(Array.from({ length: 1200 }, (_, id) => ({ id, value: "v".repeat(100) })), null, 2);
  const f = jsonFixture(text, "modified", `@@ -1 +1,${text.split("\n").length} @@\n-not-json\n${text.split("\n").map((row) => `+${row}`).join("\n")}\n`);
  expect(f.units.every((u) => u.digest?.kind === "json")).toBe(true);
  expect(f.units[0]!.digest!.omitted.some((o) => o.why.includes("old side unavailable"))).toBe(true);
});
it("marks counts unknown when a modified JSON file has no old-side diff", () => {
  const f = jsonFixture(JSON.stringify(Array.from({ length: 1200 }, (_, id) => ({ id, value: "v".repeat(100) })), null, 2), "modified");
  expect(f.units[0]!.digest!.text).toContain("added unknown, removed unknown, changed unknown");
  expect(f.units[0]!.digest!.omitted.some((o) => o.why === "old side unavailable")).toBe(true);
});
it("matches equal records before array indices when an insertion moves all later records", () => {
  const before = [{ id: 1, value: 1 }, { id: 2, value: "two" }];
  const next = [{ id: 0, value: false }, ...before];
  const digest = jsonDigest("runs.json", JSON.stringify(next, null, 2), [ref(30)], JSON.stringify(before));
  expect(digest.text).toContain("records $.[]: added 1, removed 0, changed 0");
  expect(digest.text).not.toContain("type change");
  expect(digest.text).toContain("unmatched records are compared by index");
});
it("bounds 3000 manifest summaries and keeps ordinary generated comments out of markers", () => {
  const files = Array.from({ length: 3000 }, (_, i) => ({ path: `node_modules/p${i}/package.json`, text: JSON.stringify({ name: `pkg-${i}-${"x".repeat(60)}`, version: "1.0.0" }), status: "added" as const, changed: [{ ...ref(1), path: `node_modules/p${i}/package.json` }] }));
  files.push({ path: "node_modules/comment", text: "const a = 1;\n// generated values are used below", status: "added", changed: [] });
  const sections = storeSections("node_modules", files);
  expect(Buffer.byteLength(sections.summary)).toBeLessThan(20000);
  expect(sections.summary).toContain("Manifests: 3000 (first 50)");
  expect(sections.summary).not.toContain("generated/minified: node_modules/comment");
  expect(sections.entries[2999]!.text).toContain("pkg-2999-");
});
it("counts a deleted store file by status before sniffing absent text", () => {
  const sections = storeSections("node_modules", [{ path: "node_modules/deleted", status: "deleted", text: null, changed: [] }]);
  expect(sections.summary).toContain("deleted: 1");
  expect(sections.summary).not.toContain("binary: 1");
});
it("includes a scalar whose key changed on the line before its value", () => {
  const digest = jsonDigest("runs.json", '{\n "renamed":\n 42\n}', [{ ...ref(2), start: 2 }]);
  expect(digest.text).toContain("$.renamed@3 = 42");
});
it("verifies a store finding near the page bound using only its cited file entries", async () => {
  const f = fixture(["a.txt"]);
  const paths = Array.from({ length: 1100 }, (_, i) => `node_modules/${"directory/".repeat(8)}${i}`);
  f.change.files = paths.map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  f.change.changedPaths = paths;
  f.change.diffs = [];
  f.change.coverage = new Map(paths.map((path) => [path, makeLineSet(Array.from({ length: 31 }, (_, i) => i + 1))]));
  for (const path of paths) { mkdirSync(dirname(join(f.dir, path)), { recursive: true }); writeFileSync(join(f.dir, path), "unsafe operation\n".repeat(31)); }
  const shared = { ...f, lenses: [], secrets: [] };
  const mapped = new Map<string, { unit?: ReviewUnit; batch?: VerifyBatch }>();
  const verified: string[] = [];
  const result = await runStagedReview({ ...f, snapshotDir: f.dir, secrets: [], deadline: Date.now() + 60000, now: Date.now, traced: false, say: () => {},
    findBrief: (unit, pass) => { const b = buildFindBrief(shared, unit, pass); mapped.set(b.text, { unit }); return b; },
    verifyBrief: (batch) => { const b = buildVerifyBrief({ ...shared, neighbourhoodBlock: "context ".repeat(3000), instructions: "Repository convention.\n".repeat(4500) }, batch); mapped.set(b.text, { batch }); return b; },
    openSession: () => ({ close() {}, async send(text) {
      const b = mapped.get(text)!;
      if (b.unit) {
        const answer: FindAnswer = { version: "find-1", change_id: f.change.id, unit: b.unit.id, examined: ["d1"], analysis: [{ hunk: "d1", changed: "Store changed.", could_break: "Unsafe inputs." }], candidates: b.unit.files.includes(paths[0]!) ? [{ ...candidate(paths[0]!), evidence: [candidate(paths[0]!).evidence[0]!, { file_path: paths[1]!, line_number: 1, quote: "unsafe operation" }] }] : [] };
        return { finalText: JSON.stringify(answer), calls: [], failure: null, sessionId: null, usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: 0 } };
      }
      verified.push(text);
      return { finalText: JSON.stringify({ version: "verify-1", change_id: f.change.id, verdicts: b.batch!.candidates.map((c) => verdict(c)) }), calls: [], failure: null, sessionId: null, usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: 0 } };
    } }),
  });
  expect(result.missing).toEqual([]);
  expect(result.report.findings).toHaveLength(1);
  expect(verified).toHaveLength(1);
  expect(Buffer.byteLength(verified[0]!)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
  expect(verified[0]).toContain(paths[1]! + ":1-31");
  expect(verified[0]).not.toContain(paths[100]! + ":1-31");
});

it("redacts a 300-digit numeric value before showing its first 120 characters", () => {
  const digits = "7".repeat(300);
  const text = JSON.stringify([{ n: 1 }, { n: 1 }, { n: 1 }], null, 2).replace('"n": 1\n  },\n  {\n    "n": 1\n  }\n]', `"n": 1\n  },\n  {\n    "n": ${digits}\n  }\n]`);
  const digest = jsonDigest("runs.json", text, [ref(30)], undefined, [digits]);
  expect(digest.text).not.toContain(digits.slice(0, 120));
  expect(digest.text).toContain("[redacted]");
});

it("keeps a one-line 100 KB store file out of the complete text and names its omission", () => {
  const sections = storeSections("node_modules", [{ path: "node_modules/p/bundle.min.js", text: "x".repeat(100 * 1024), status: "added", changed: [{ ...ref(1), path: "node_modules/p/bundle.min.js" }] }]);
  expect(sections.entries[0]!.text).not.toContain("Complete text");
  expect(Buffer.byteLength(sections.entries[0]!.text)).toBeLessThan(2000);
  expect(sections.entries[0]!.omitted).toHaveLength(1);
});

it("reports a scalar or an array that becomes an object as a type change", () => {
  const next = '{\n "a": {\n  "b": 2\n }\n}';
  expect(jsonDigest("runs.json", next, [ref(5)], '{"a": 1}').text).toContain("type change $.a@2: number -> object");
  expect(jsonDigest("runs.json", next, [ref(5)], '{"a": [1]}').text).toContain("type change $.a@2: array -> object");
});

it("names a POM's own coordinates, not its parent's, and takes the parent version only when it has none", () => {
  const pom = (own: string, before = "") => ({ path: "node_modules/p/a.pom", text: `<project><parent><artifactId>parent-pkg</artifactId><version>9.9</version></parent>${before}<artifactId>java-pkg</artifactId>${own}</project>`, status: "added" as const, changed: [] });
  expect(storeSections("node_modules", [pom("<version>4.5</version>")]).summary).toContain("node_modules/p/a.pom: java-pkg 4.5");
  expect(storeSections("node_modules", [pom("")]).summary).toContain("node_modules/p/a.pom: java-pkg 9.9");
  // Nested blocks carry their own coordinates, before or after the project's.
  const dependency = "<dependencies><dependency><artifactId>dep-pkg</artifactId><version>1.2</version></dependency></dependencies>";
  expect(storeSections("node_modules", [pom(dependency)]).summary).toContain("node_modules/p/a.pom: java-pkg 9.9");
  expect(storeSections("node_modules", [pom("<version>4.5</version>", `<dependencyManagement>${dependency}</dependencyManagement><build><plugins><plugin><artifactId>plugin-pkg</artifactId><version>3.0</version></plugin></plugins></build>`)]).summary).toContain("node_modules/p/a.pom: java-pkg 4.5");
});

it("lists an omission that spans several pages once in a verifier digest", () => {
  const f = jsonFixture(JSON.stringify(Array.from({ length: 3000 }, (_, id) => ({ id, value: "v".repeat(100) })), null, 2), "modified");
  expect(f.units.length).toBeGreaterThan(1);
  const omitted = citedDigest(f.units, "runs.json", [[1, 12002]])!.omitted;
  expect(omitted).toEqual([{ path: "runs.json", lines: [1, 12002], why: "old side unavailable" }]);
});

it("reads a POM's coordinates past nested openers that are never closed", () => {
  const text = "<project><dependencies><build><parent><artifactId>java-pkg</artifactId><version>4.5</version></project>";
  expect(storeSections("node_modules", [{ path: "node_modules/p/a.pom", text, status: "added", changed: [] }]).summary).toContain("node_modules/p/a.pom: java-pkg 4.5");
});

growthTests("the POM manifest scan stays linear (15)", () => {
  const KB = 1024;
  const pom = (body: string) => ({ path: "node_modules/p/a.pom", text: Buffer.from(`<project>${body}</project>`, "utf8").toString("utf8"), status: "added" as const, changed: [] });
  const shapes: [string, (size: number) => string][] = [
    ["many openers never closed", (size) => "<parent><build><dependencies>".repeat(Math.ceil(size / 29))],
    ["one opener and a long run of spaces", (size) => `<artifactId>${" ".repeat(size)}`],
  ];
  it.each(shapes)("on a POM of %s", async (what, body) => {
    const at = (size: number) => { const file = pom(body(size)); return repeatedCpuMs(() => storeSections("node_modules", [file])); };
    await expectLinearRepeated(`a POM of ${what}, at 64 KB and at 256 KB`, at(64 * KB), at(256 * KB));
  }, 180_000);
});
