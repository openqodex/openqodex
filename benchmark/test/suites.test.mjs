// Round 1 and 2 failure list: greptile-failures.md, items 9, 10 and 13.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { attemptDir, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { rawPath, readCase, realSpecProblems, specCopy, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const suite = JSON.parse(readFileSync(join(benchRoot, "suites/greptile/cases.json"), "utf8"));
const c = readCase(suite.cases[0].id);
const cache = cacheRoot();
const hasTruth = Object.values(c.truthSets).every((set) => existsSync(rawPath(cache, "greptile", { path: set.file })));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function savedRun(spec = null) {
  const folder = tempDir("oq-greptile-score-");
  const { jobs, configs } = planJobs({ cases: [c.name], caseIds: { [c.name]: c.id }, reviewers: ["model:scripted"], graph: ["on"], repeat: 1 });
  const settings = { runId: "greptile-regression", suite: "greptile", mode: "review", cases: [c.name], caseIds: [c.id], caseHashes: { [c.name]: c.hash }, configs, repeat: 1 };
  write(join(folder, "manifest.json"), runManifest({ startedAt: "2026-10-14T00:00:00Z", settings, jobs }));
  if (spec !== null) {
    mkdirSync(join(folder, "cases"));
    write(join(folder, "cases", `${c.name}.json`), spec);
    const report = { completion: { status: "complete" }, findings: [], outside_change: [] };
    const dir = attemptDir(folder, jobs[0], 1);
    mkdirSync(join(dir, "report"), { recursive: true });
    write(join(dir, "report/report.json"), report);
    write(join(dir, "sample.json"), sampleRecord({ job: jobs[0], attempt: 1, result: { code: 0, wallMs: 1 }, report, startedAt: "2026-10-14T00:00:00Z" }));
  }
  return folder;
}

it.skipIf(!hasTruth)("scores a Greptile run with empty line truth and saves both judge set identities (needs pinned Greptile truth in the bench cache; skipped without it)", () => {
  const truth = truthOf(c, { cache });
  expect(truth.kind).toBe("lines");
  expect(truth.items).toEqual([]);
  const copy = specCopy(c, truth);
  expect(copy.bugs).toEqual([]);
  const folder = savedRun(copy);
  const result = spawnSync(process.execPath, [join(benchRoot, "score.mjs"), folder], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const score = JSON.parse(readFileSync(join(folder, "score.json"), "utf8"));
  expect(score.suite).toBe("greptile");
  const config = Object.values(score.byConfig)[0];
  expect(config.population).toMatchObject({ planned: 1, complete: 1 });
  expect(config.issueRecall.all).toMatchObject({ hit: 0, of: 0 });
  const saved = JSON.parse(readFileSync(join(folder, "cases", `${c.name}.json`), "utf8"));
  expect(Object.keys(saved.truthSets).sort()).toEqual(["augment", "greptile"]);
  for (const name of ["greptile", "augment"]) {
    expect(saved.truthSets[name]).toMatchObject({ ...truth.sets[name], hash: c.truthSets[name].hash, file: c.truthSets[name].file, sha256: c.truthSets[name].sha256 });
  }
});

const martianSuite = JSON.parse(readFileSync(join(benchRoot, "suites/martian/cases.json"), "utf8"));
const m = readCase(martianSuite.cases[0].id);
const hasMartianTruth = existsSync(rawPath(cache, "martian", { path: m.source.dataset.file }));

it.skipIf(!hasMartianTruth)("a Martian truth copy carries no line truth and matches its suite's golden comment count (needs the pinned Martian golden file in the bench cache; skipped without it)", () => {
  const truth = truthOf(m, { cache });
  expect(truth.kind).toBe("prose");
  expect(truth.items.map((t) => t.id)).toEqual(truth.items.map((_, i) => `g${i + 1}`));
  const copy = specCopy(m, truth);
  expect(copy.bugs).toEqual([]);
  expect(copy.truthCount).toEqual({ kind: "prose", items: truth.items.length });
  expect(realSpecProblems(JSON.parse(JSON.stringify(copy)), m.name, { suite: "martian" })).toEqual([]);
  // A suite that lists another count would score the copy against another set.
  expect(() => specCopy({ ...m, truthCount: { kind: "prose", items: truth.items.length + 1 } }, truth)).toThrow(/lists \d+ golden comments, and the truth read holds g1/);
  expect(() => specCopy({ ...m, truthCount: { kind: "lines", accepted: 2 } }, truth)).toThrow(/lists no count of golden comments/);
  // Line truth smuggled into a prose copy would enter the recall denominator.
  expect(realSpecProblems({ ...copy, bugs: [{ id: "c1" }] }, m.name, { suite: "martian" })).toEqual([`${m.name}: prose truth carries no line truth: bugs must be empty; the board judge reads the golden comments from the pinned file`]);
  expect(realSpecProblems({ ...copy, truthCount: { kind: "prose", items: truth.items.length + 1 } }, m.name, { suite: "martian" })).toEqual([`${m.name}: the suite lists ${truth.items.length} golden comments, and the copy says ${truth.items.length + 1}`]);
});

it.each(["aacr", "martian"])("the %s converter refuses Greptile with one line naming its board judge", (board) => {
  const folder = savedRun();
  const result = spawnSync(process.execPath, [join(benchRoot, `outside/convert/${board}.mjs`), "convert", folder], { encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/Greptile.*benchmark\/outside\/boards\/greptile-run\.mjs/);
  expect(existsSync(join(folder, "outside"))).toBe(false);
});
