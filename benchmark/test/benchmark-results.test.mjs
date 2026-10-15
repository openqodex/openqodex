// Failure list, written before the code:
// 1. A hand-edited README number passes --check.
// 2. Missing board numbers are presented as measured numbers.
// 3. A results folder supplies a number absent from the index.
// 4. A stale full page passes --check, or checking rewrites it.
// 5. Historical accepted runs appear instead of the current group pointers.
// 6. Board metrics and A/A noise are lost or mixed with issue recall.
// 7. A run whose findings all wait for a ruling shows 0% issue recall as if measured.
// 8. The README shows an AACR-Bench row with no board numbers and no ruled hit, or the page drops it.
// 9. The README admits a board-scored row but drops its six board metrics.
// 10. An accepted entry's board numbers are edited after they were recorded, and the page shows them.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { boardHash, groupKeys, scoreHash } from "../lib/index.mjs";

afterAll(removeTempDirs);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repo, "scripts/benchmark-results.mjs");
function fixture() {
  const root = tempDir("benchmark-results-");
  mkdirSync(join(root, "docs"));
  cpSync(join(repo, "benchmark/index"), join(root, "benchmark/index"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Test\n\n<!-- benchmark-results:start -->\n<!-- benchmark-results:end -->\n");
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
const page = (root) => readFileSync(join(root, "docs/benchmark-results.md"), "utf8");
// The tests read the accepted pointer, so a newly accepted run does not break them.
const pointer = (root) => JSON.parse(readFileSync(join(root, "benchmark/index/accepted.json"), "utf8"));
const entryFile = (root, runId) => join(root, "benchmark/index/runs", `${runId}.json`);
// Writes an edited entry and records its board numbers in the pointer, as accept or a board refresh would.
const putRecorded = (root, entry) => {
  writeFileSync(entryFile(root, entry.runId), JSON.stringify(entry));
  const accepted = pointer(root);
  for (const a of [accepted, ...Object.values(accepted.groups)]) {
    if (a.runId !== entry.runId) continue;
    if (entry.outside === undefined) delete a.boardHash;
    else a.boardHash = boardHash(entry);
  }
  writeFileSync(join(root, "benchmark/index/accepted.json"), JSON.stringify(accepted));
};
const aacrGroup = (root, { boarded = false } = {}) => {
  const accepted = pointer(root);
  const key = Object.keys(accepted.groups).find((k) => k.startsWith("aacr|") && (!boarded || accepted.groups[k].boardHash));
  expect(key).toBeDefined();
  const { runId } = pointer(root).groups[key];
  const entry = JSON.parse(readFileSync(entryFile(root, runId), "utf8"));
  return { runId, config: groupKeys(entry).find((g) => g.key === key).config };
};

it("rejects a hand-edited README number and names its first differing line", () => {
  const root = fixture();
  expect(run(root).status).toBe(0);
  expect(run(root, "--check").status).toBe(0);
  const path = join(root, "README.md");
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  const index = lines.findIndex((l) => /^\| .*\d+\.\d%/.test(l));
  expect(index).toBeGreaterThan(-1);
  lines[index] = lines[index].replace(/(\d+)\.(\d)%/, (_, whole, tenth) => `${whole}.${(Number(tenth) + 1) % 10}%`);
  const edited = lines.join("\n");
  expect(edited).not.toBe(original);
  writeFileSync(path, edited);
  const result = run(root, "--check");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`README.md:${index + 1}`);
  expect(readFileSync(path, "utf8")).toBe(edited);
});

it("labels an accepted AACR row without board numbers as not yet board-scored", () => {
  const root = fixture();
  const { runId } = aacrGroup(root);
  const entry = JSON.parse(readFileSync(entryFile(root, runId), "utf8"));
  delete entry.outside;
  putRecorded(root, entry);
  expect(run(root).status).toBe(0);
  const line = page(root).split("\n").find((l) => l.startsWith(`[${runId}]`));
  expect(line).toContain("not yet board-scored");
  expect(line).not.toMatch(/\d%/);
});

it("never takes a number from a results folder", () => {
  const root = fixture();
  expect(run(root).status).toBe(0);
  const before = page(root);
  const results = join(root, "benchmark/results", pointer(root).runId);
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "score.json"), JSON.stringify({ outside: { aacr: { precision: 0.123456 } } }));
  expect(run(root, "--check").status).toBe(0);
  expect(run(root).status).toBe(0);
  expect(page(root)).toBe(before);
});

it("rejects a stale full page without rewriting it", () => {
  const root = fixture();
  expect(run(root).status).toBe(0);
  const path = join(root, "docs/benchmark-results.md");
  writeFileSync(path, "wrong\n");
  const result = run(root, "--check");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("docs/benchmark-results.md:1");
  expect(page(root)).toBe("wrong\n");
});

it("publishes only the current accepted groups", () => {
  const root = fixture();
  expect(run(root).status).toBe(0);
  const groups = Object.values(pointer(root).groups);
  // One full-page row per accepted group; each row links its run.
  expect(page(root).split("\n").filter((l) => l.startsWith("| ") && l.includes("/releases/download/")).length).toBe(groups.length);
  for (const { runId } of groups) expect(page(root)).toContain(`[${runId}]`);
  // A legacy run that no group points at.
  expect(page(root)).not.toContain("2026-10-08-752b77f");
});

it("keeps indexed board metrics and A/A issue noise separate", () => {
  const root = fixture();
  const { runId, config: aacrConfig } = aacrGroup(root);
  const path = entryFile(root, runId);
  const entry = JSON.parse(readFileSync(path, "utf8"));
  entry.outside = { aacr: { byConfig: { [aacrConfig]: { mean: {
    semantic: { precision: 0.2, recall: 0.3, f1: 0.24, noiseRate: 0.8 },
    line: { precision: 0.4, recall: 0.5 },
  } } } } };
  putRecorded(root, entry);
  // An A/A twin of an accepted run with at least three issues found, three issues apart.
  const accepted = Object.entries(pointer(root).groups).map(([key, a]) => {
    const e = JSON.parse(readFileSync(entryFile(root, a.runId), "utf8"));
    return { e, config: groupKeys(e).find((g) => g.key === key).config };
  });
  const { e: parent, config } = accepted.find(({ e, config }) => e.scores[config].issueRecall.all.hit >= 3);
  const twin = structuredClone(parent);
  twin.runId = `${parent.runId}-aa`;
  twin.asset.url = parent.asset.url.replace(`/${parent.runId}.tar.gz`, `/${twin.runId}.tar.gz`);
  Object.assign(twin, { accepted: false, acceptedAt: null, acceptedBy: null });
  twin.scores[config].issueRecall.all.hit -= 3;
  writeFileSync(entryFile(root, twin.runId), JSON.stringify(twin));
  expect(run(root).status).toBe(0);
  expect(page(root)).toContain("20.0% | 30.0% | 24.0% | 80.0% | 40.0% | 50.0%");
  const headline = readFileSync(join(root, "README.md"), "utf8");
  expect(headline).toContain("Semantic precision");
  expect(headline.split("\n").find((l) => l.includes(`(${aacrConfig})`) && l.includes("AACR-Bench"))).toContain("20.0% | 30.0% | 24.0% | 80.0% | 40.0% | 50.0%");
  expect(page(root)).toContain(`The difference is 3 issues across ${parent.repeat} repeats`);
});

it("shows a run whose findings all wait for a ruling as not yet ruled, never as 0%", () => {
  const root = fixture();
  const accepted = pointer(root);
  const [key, { runId }] = Object.entries(accepted.groups).find(([k]) => k.startsWith("planted|") && k.includes("|review|"));
  const entry = JSON.parse(readFileSync(entryFile(root, runId), "utf8"));
  const { config } = groupKeys(entry).find((g) => g.key === key);
  const s = entry.scores[config];
  s.issueRecall.all.hit = 0;
  s.precision.lower.hit = 0;
  s.precision.upper.hit = s.precision.upper.of;
  writeFileSync(entryFile(root, runId), JSON.stringify(entry));
  // The pointer records the changed numbers, as an accept of this entry would.
  for (const a of [accepted, ...Object.values(accepted.groups)]) if (a.runId === runId) a.scoreHash = scoreHash(entry);
  writeFileSync(join(root, "benchmark/index/accepted.json"), JSON.stringify(accepted));
  expect(run(root).status).toBe(0);
  const row = readFileSync(join(root, "README.md"), "utf8").split("\n").find((l) => l.includes(`(${config})`));
  expect(row).toContain("not yet ruled");
  expect(row).not.toContain(`0/${s.issueRecall.all.of}`);
});

it("keeps an AACR-Bench row with no board numbers and no ruled hit off the README, and on the page", () => {
  const root = fixture();
  const { runId, config } = aacrGroup(root);
  const entry = JSON.parse(readFileSync(entryFile(root, runId), "utf8"));
  delete entry.outside;
  expect(entry.scores[config].issueRecall.all.hit).toBe(0);
  putRecorded(root, entry);
  expect(run(root).status).toBe(0);
  const block = (r) => readFileSync(join(r, "README.md"), "utf8").split("\n").filter((l) => l.startsWith("| "));
  expect(block(root).some((l) => l.includes(`(${config})`) && l.includes("AACR-Bench"))).toBe(false);
  expect(page(root).split("\n").some((l) => l.startsWith("| ") && l.includes(`[${runId}]`))).toBe(true);
  // The same row with board numbers is on the README.
  entry.outside = { aacr: { byConfig: { [config]: { mean: { semantic: null, line: { precision: 0.4, recall: 0.5 } } } } } };
  putRecorded(root, entry);
  expect(run(root).status).toBe(0);
  expect(block(root).some((l) => l.includes(`(${config})`) && l.includes("AACR-Bench"))).toBe(true);
});

it("rejects an accepted entry whose board numbers were edited after they were recorded", () => {
  const root = fixture();
  const { runId, config } = aacrGroup(root, { boarded: true });
  const entry = JSON.parse(readFileSync(entryFile(root, runId), "utf8"));
  expect(pointer(root).boardHash ?? Object.values(pointer(root).groups).find((a) => a.runId === runId).boardHash).toBe(boardHash(entry));
  entry.outside.aacr.byConfig[config].mean.semantic.precision = 0.9;
  writeFileSync(entryFile(root, runId), JSON.stringify(entry));
  for (const args of [[], ["--check"]]) {
    const result = run(root, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the board numbers of ${runId} are not the ones recorded`);
  }
});
