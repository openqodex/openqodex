// 1. A deletion straddles a page boundary and loses folded odd records.
// 2. A new keyed record shape invents thousands of removed packages.
// 3. Under-budget JSON files rebuild old sides and take quadratic time.
// 4. A wide cited line abandons an otherwise bounded verifier batch.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildFindBrief, buildVerifyBrief } from "@openqodex/core";
import type { FindAnswer, HunkRef, ReviewUnit, VerifyBatch } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { jsonSections } from "../src/digest.js";
import { MAX_BRIEF_BYTES, obligations, unitsOf } from "../src/units.js";
import { runStagedReview } from "../src/stages.js";
import { cleanupFixtures, fixture, candidate, verdict } from "./staged-fixture.js";
// The 30,000 file test took about 400 ms measured alone; its bound is ten times that.
const ALONE_MS = 400;
afterAll(cleanupFixtures);

it("keeps all 50 unchanged odd records when a deletion ends at a page boundary", () => {
  const records = [...Array.from({ length: 100 }, () => ({ value: "v".repeat(100) })), ...Array.from({ length: 50 }, (_, i) => ({ odd: `${i}:` + "x".repeat(5000) }))];
  const text = JSON.stringify(records, null, 2).replace('"' + "v".repeat(100) + '"', JSON.stringify("c".repeat(130000)));
  const f = fixture(["runs.json"]);
  f.change.diffs = [];
  f.change.coverage.set("runs.json", makeLineSet(Array.from({ length: 300 }, (_, i) => i + 2)));
  const render = (unit: ReviewUnit) => buildFindBrief({ ...f, lenses: [], secrets: [] }, unit, "local").text;
  // The second anchor, line 434, starts a page without another change.
  const after = 433;
  f.change.deletionPoints.set("runs.json", [{ after, lines: 1, anchors: [after, after + 1] }]);
  const units = unitsOf(f.change, obligations(f.change, () => text), render);
  expect(units.every((u) => u.digest?.kind === "json")).toBe(true);
  const odd = units.flatMap((u) => u.digest!.text.split("\n").filter((row) => row.startsWith("odd record ")));
  expect(odd).toHaveLength(50);
  for (let i = 100; i < 150; i++) {
    expect(odd.some((row) => row.startsWith(`odd record $[${i}]@`))).toBe(true);
    expect(units.some((u) => u.digest!.omitted.some((o) => o.why.startsWith(`$[${i}]: odd record text after 2 KB`)))).toBe(true);
  }
});

it("reports one added package and zero removed after a new dev key changes its shape", () => {
  const packages = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0" }]));
  const previous = JSON.stringify({ name: "fixture", packages });
  const text = JSON.stringify({ name: "fixture", packages: { ...packages, "node_modules/new": { version: "1.0.0", dev: true } } }, null, 2);
  const changed: HunkRef[] = [{ id: "h1", path: "package-lock.json", start: 1, end: text.split("\n").length, deletion: false }];
  const sections = jsonSections("package-lock.json", text, changed, previous);
  expect(sections.fixed).toContain("records $.packages[*]: added 1, removed 0, changed 0; total 3001");
});

it("inventories 30000 under-budget JSON files with two reads each and no old-side recognition", () => {
  const f = fixture(["a.txt"]);
  const paths = Array.from({ length: 30000 }, (_, i) => `p${i}.json`);
  f.change.files = paths.map((path) => ({ path, status: "modified", oldPath: null, binary: false }));
  f.change.changedPaths = paths;
  f.change.coverage = new Map(paths.map((path) => [path, makeLineSet([1])]));
  f.change.diffs = paths.map((path) => ({ path, text: '@@ -1 +1 @@\n-{"old":true}\n+{"next":true}\n' }));
  const start = performance.now();
  let reads = 0;
  const refs = obligations(f.change, () => { reads++; return '{"next":true}\n'; });
  const ms = performance.now() - start;
  console.log(`round3 small JSON: ${ms.toFixed(1)} ms, ${paths.length} files in, ${refs.length} obligations out, ${reads} reads`);
  expect(refs).toHaveLength(30000);
  // The sizing pass and the paging pass each read a file once.
  expect(reads).toBeLessThanOrEqual(2 * 30000);
  expect(ms).toBeLessThan(ALONE_MS * 10);
});

it("verifies a candidate on a 100 KB cited line with 60 KB of fixed instructions", async () => {
  const f = fixture(["a.txt"]);
  const path = "node_modules/p/x";
  const other = "node_modules/p/y";
  const text = "unsafe operation" + "x".repeat(100 * 1024);
  mkdirSync(join(f.dir, "node_modules/p"), { recursive: true });
  writeFileSync(join(f.dir, path), text);
  writeFileSync(join(f.dir, other), "y".repeat(30 * 1024));
  f.change.files = [path, other].map((path) => ({ path, status: "added", oldPath: null, binary: false }));
  f.change.changedPaths = [path, other];
  f.change.diffs = [];
  f.change.coverage = new Map([path, other].map((path) => [path, makeLineSet([1])]));
  const shared = { ...f, lenses: [], secrets: [], instructions: "Repository convention.\n".repeat(2800) };
  const mapped = new Map<string, { unit?: ReviewUnit; batch?: VerifyBatch }>();
  const verified: string[] = [];
  const result = await runStagedReview({ ...f, snapshotDir: f.dir, secrets: [], deadline: Date.now() + 60000, now: Date.now, traced: false, say: () => {},
    findBrief: (unit, pass) => { const b = buildFindBrief(shared, unit, pass); mapped.set(b.text, { unit }); return b; },
    verifyBrief: (batch) => { const b = buildVerifyBrief(shared, batch); mapped.set(b.text, { batch }); return b; },
    openSession: () => ({ close() {}, async send(brief) {
      const b = mapped.get(brief)!;
      let answer: unknown;
      if (b.unit) {
        const ids = b.unit.digest ? ["d1"] : b.unit.hunks.map((h) => h.id);
        answer = { version: "find-1", change_id: f.change.id, unit: b.unit.id, examined: ids, analysis: ids.map((hunk) => ({ hunk, changed: "Values changed.", could_break: "Unsafe inputs." })), candidates: [candidate(path)] } satisfies FindAnswer;
      } else {
        verified.push(brief);
        answer = { version: "verify-1", change_id: f.change.id, verdicts: b.batch!.candidates.map((c) => verdict(c)) };
      }
      return { finalText: JSON.stringify(answer), calls: [], failure: null, sessionId: null, usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: 0 } };
    } }),
  });
  expect(result.missing).toEqual([]);
  expect(result.report.findings).toHaveLength(1);
  expect(verified).toHaveLength(1);
  expect(Buffer.byteLength(verified[0]!)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
  expect(verified[0]!.includes("read the cited lines with your tools")).toBe(true);
});
