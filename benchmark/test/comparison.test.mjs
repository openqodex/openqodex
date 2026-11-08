// Failure list, written before implementation:
// 1. A changed case hash, case file or split keeps a frozen comparison valid.
// 2. A changed build commit, tree, bundle or version keeps acceptance valid.
// 3. A changed board judge, prompt, metric or profile keeps acceptance valid.
// 4. The acceptance hash leaves out a field, including the signer or date.
// 5. Empty acceptance is mistaken for a person's acceptance.
// 6. A named run or calibration file is missing, changed or from another build.
// 7. Missing or malformed record fields pass validation.
// 8. A vendor row lacks provenance, dataset identity or a measurement field.
// 9. Duplicate vendor rows or invalid numbers and dates pass validation.
// 10. Complete vendor rows cannot be validated and printed by the real command.
// 11. A name outside people.json or a model accepts a signed comparison.
// 12. Missing effort or output-token pins, or different manifest settings, match.
// 13. A local manifest supplies a build tree without a verified run folder.
// 14. A vendor page snapshot is missing or its bytes differ from the row's hash.
// 15. Calibration build identity or agreement differs from the reference.
// 16. Calibration agreement is below 90 percent on either class without a ruling.
// 17. A matching person's ruling cannot admit a calibration below the bar.
// 18. A ruling's percentages differ from the saved calibration.
// 19. A ruling names someone missing from people.json, or no person at all.
// 20. A ruling names a board without a calibration record.
// 21. Page data loses per-class agreement or requires a ruling above the bar.
// 22. Two calibration files for one board overwrite its agreement.
// 23. A partial run silently drops cases from the frozen suite.
// 24. Board output changes the reviewed-run hash or a null board attaches.
// 25. Missing tools, incomplete board accounting or edited evidence attaches.
// 26. A control is pinned to the product build instead of its version and model.
// 27. Attachment keeps acceptance, overwrites a duplicate or writes on refusal.
// 28. A held board tool attaches without a score.
// 29. AACR problems or an unjudged folder attach as semantic recall.
// 30. A run's truth profile, board commit, prompt or judge differs from its pin.
// 31. Greptile names a different not-run case with the same count.
// 32. Attachment pins entry bytes that are not committed at HEAD.
// 33. A later checkout's build prevents attaching the record's own build.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, caseHash, git } from "../lib/cases.mjs";
import { comparisonHash, freezeComparison, validateComparison, validateOutsideRows, validateRunManifest } from "../lib/comparison.mjs";
import { entryProblems, hashFolder, hashReviewedFolder, sha256 } from "../lib/index.mjs";
import { toolName } from "../lib/aacr-board.mjs";
import { boardConfigOf, boardToolName } from "../lib/martian-board.mjs";
import { BOARDS } from "../lib/outside-boards.mjs";
import { greptileInput, martianConversion, readBoardReviews } from "../lib/board-reviews.mjs";
import { planJobs } from "../lib/runner.mjs";
import { readCase, specCopy, truthOf } from "../lib/suites.mjs";
import { caseSetHash } from "../lib/score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { boardSuiteFixture } from "./board-suite-fixture.mjs";

afterAll(removeTempDirs);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const reviewers = { library: { path: "server", reviewer: "model:gpt-6.1-sol", model: "gpt-6.1-sol", graph: "on", web: "off", effort: "high", maxOutputTokens: 32000 } };

for (const field of ["path", "web", "graph"]) it(`manifest preflight refuses a ${field} mismatch with the reviewer pin`, () => {
  const pin = reviewers.library;
  const build = { commit: "a".repeat(40), tree: "b".repeat(40), bundleHash: "c".repeat(64), version: "0.14.0" };
  const manifest = { path: pin.path, web: pin.web, configs: [`model-gpt-6.1-sol-graph-${pin.graph}`], build, reviewers: { [pin.reviewer]: { model: pin.model, settings: { effort: pin.effort, maxOutputTokens: pin.maxOutputTokens } } } };
  if (field === "graph") manifest.configs = ["model-gpt-6.1-sol-graph-off"];
  else manifest[field] = field === "path" ? "laptop" : "on";
  expect(() => validateRunManifest(manifest, { reviewers, build })).toThrow(new RegExp(field));
});

it("manifest preflight refuses a config naming a different reviewer", () => {
  const pin = reviewers.library;
  const build = { commit: "a".repeat(40), tree: "b".repeat(40), bundleHash: "c".repeat(64), version: "0.14.0" };
  const manifest = { path: pin.path, configs: [{ id: "model-gpt-6.1-sol-graph-on" }, { id: "claude-graph-on" }], build, reviewers: { [pin.reviewer]: { model: pin.model, settings: { effort: pin.effort, maxOutputTokens: pin.maxOutputTokens } } } };
  expect(() => validateRunManifest(manifest, { reviewers, build })).toThrow(/config/);
});

it("manifest preflight accepts object configs when web was not recorded", () => {
  const pin = reviewers.library;
  const build = { commit: "a".repeat(40), tree: "b".repeat(40), bundleHash: "c".repeat(64), version: "0.14.0" };
  const manifest = { path: pin.path, configs: [{ id: "model-gpt-6.1-sol-graph-on" }], build, reviewers: { [pin.reviewer]: { model: pin.model, settings: { effort: pin.effort, maxOutputTokens: pin.maxOutputTokens } } } };
  expect(() => validateRunManifest(manifest, { reviewers, build })).not.toThrow();
});
function fixture(suite = "aacr", cli = false) {
  const root = join(realpathSync(tempDir("oq-comparison-")), "benchmark");
  for (const file of new Set(["outside/boards.json", "suites/aacr/cases.json", "splits/aacr-v1.json", `suites/${suite}/cases.json`, `splits/${suite}-v1.json`, "review-queue/people.json"])) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(benchRoot, file), join(root, file));
  }
  const build = { commit: "a".repeat(40), tree: "b".repeat(40), bundleHash: "c".repeat(64), version: "0.12.0" };
  if (cli) {
    for (const file of ["lib", "score.mjs", "legacy"]) cpSync(join(benchRoot, file), join(root, file), { recursive: true });
    mkdirSync(join(root, "../packages"), { recursive: true });
    for (const name of ["cli", "scanners"]) symlinkSync(join(benchRoot, "../packages", name), join(root, "../packages", name));
  }
  write(join(root, ".build/provenance.json"), { ...build, cliVersion: build.version });
  if (cli) git(join(root, ".."), "init", "-q");
  const truth = suite === "aacr" ? {} : boardSuiteFixture(suite, root);
  const options = { root, build };
  const record = freezeComparison({ release: "compare-2026-10", suites: [suite], boards: [suite], reviewers: structuredClone(reviewers), capUsd: 100 }, options);
  return { root, build, options, record, cache: truth.cache };
}
const sign = (record) => { record.acceptance = { person: "Sid", date: "2026-10-14", hash: "" }; record.acceptance.hash = comparisonHash(record); return record; };
function calibrationFixture(f) {
  const calibration = { version: 1, board: f.record.boards.aacr, vendor: "fixture", labelUnit: "golden comment", judgeModel: f.record.boards.aacr.judgeModel, promptHash: f.record.boards.aacr.promptHash, costUsd: 0, build: { ...f.build }, agreement: { positive: 1, negative: 1 }, counts: { total: 20, agree: 20, disagree: 0, byClass: { positive: { total: 10, agree: 10, disagree: 0 }, negative: { total: 10, agree: 10, disagree: 0 } } } };
  const file = "index/calibration/check.json";
  write(join(f.root, file), calibration);
  f.record.calibrations = [{ file, sha256: sha256(readFileSync(join(f.root, file))), ...structuredClone(calibration) }];
  return calibration;
}
function ruledCalibrationFixture() {
  const f = fixture();
  const calibration = read(join(benchRoot, "index/calibration/greptile-2026-10-21.json"));
  calibration.build = { ...f.build };
  f.record.boards.greptile = calibration.board;
  const file = "index/calibration/greptile.json";
  write(join(f.root, file), calibration);
  f.record.calibrations = [{ file, sha256: sha256(readFileSync(join(f.root, file))), build: calibration.build, agreement: calibration.agreement }];
  f.record.calibrationRulings = [{ board: "greptile", decidedBy: "Sid", decidedOn: "2026-10-22", agreement: { caught: 85.37, missed: 88.89 } }];
  return f;
}
function runFixture(f, tree = true, list = "private", reviewer = "library") {
  const entry = read(join(benchRoot, "index/runs/2026-10-12-b43b25b-aacr-gpt61.json"));
  const suite = Object.keys(f.record.suites)[0];
  const ids = Object.entries(f.record.suites[suite].caseHashes).map(([name, h]) => `${suite}/${name}@${h.slice(0, 8)}`);
  const settings = f.record.reviewers[reviewer];
  const config = `${settings.reviewer.replace(/:/g, "-")}-graph-${settings.graph}`;
  entry.suite = suite; entry.splitHash = f.record.suites[suite].splitHash;
  entry.caseIds = ids; entry.caseSetHash = caseSetHash(ids);
  entry.perCase = {}; entry.perBug = {}; entry.intervals = { ...entry.intervals, cluster: "case", groups: null };
  entry.scores = { [config]: Object.values(entry.scores)[0] }; entry.configs = [config];
  entry.path = settings.path; entry.web = settings.web;
  entry.reviewers = { [settings.reviewer]: { model: settings.model, version: settings.version ?? "fixture" } };
  entry.repeat = 1;
  entry.build = { ...entry.build, ...f.build, short: f.build.commit.slice(0, 7), cliVersion: f.build.version };
  if (!tree) delete entry.build.tree;
  const folder = join(f.root, "results", entry.runId);
  const manifest = { suite, splitHash: entry.splitHash, build: { ...f.build }, reviewers: { [settings.reviewer]: { ...entry.reviewers[settings.reviewer], settings: { effort: settings.effort, maxOutputTokens: settings.maxOutputTokens } } } };
  const saveEntry = () => {
    entry.caseSetHash = caseSetHash(entry.caseIds);
    if (list === "private") entry.privateListHash = hashReviewedFolder(folder).listHash;
    else entry.asset.listHash = hashReviewedFolder(folder).listHash;
    write(join(f.root, "index/runs", `${entry.runId}.json`), entry);
    f.record.runs = [{ runId: entry.runId, sha256: sha256(readFileSync(join(f.root, "index/runs", `${entry.runId}.json`))), reviewer, casesNotRun: ids.filter((id) => !entry.caseIds.includes(id)) }];
  };
  const save = () => {
    if (suite !== "aacr") {
      const selected = entry.caseIds.map((id) => readCase(id, { root: f.root }));
      const { jobs } = planJobs({ cases: selected.map((c) => c.name), caseIds: Object.fromEntries(selected.map((c) => [c.name, c.id])), reviewers: [settings.reviewer], graph: [settings.graph], repeat: 1 });
      Object.assign(manifest, { cases: selected.map((c) => c.name), caseHashes: Object.fromEntries(selected.map((c) => [c.name, c.hash])), jobs });
      for (const c of selected) write(join(folder, "cases", `${c.name}.json`), specCopy(c, truthOf(c, { cache: f.cache })));
    }
    write(join(folder, "manifest.json"), manifest);
    const out = join(folder, "outside", suite);
    const tool = suite === "aacr" ? toolName(config, 1) : boardToolName(config, 1);
    if (suite === "aacr") {
      const dir = `${config}/r1`;
      write(join(out, "convert.json"), { reader: "ocr", lineK: null, references: {}, withoutLine: [], folders: [{ config, repeat: 1, tool, dir, files: entry.caseIds.length }] });
      write(join(out, "eval.json"), { judge: { deployment: f.record.boards.aacr.judgeModel }, folders: [{ config, repeat: 1, mode: "llm", judgeErrors: 0, metrics: ["metrics_ocr_fixture.json"] }] });
      write(join(out, dir, "metrics_ocr_fixture.json"), { summary: { evaluated_instances: entry.caseIds.length, missing_instances: 0, expected_notes: 0, generated_notes: 0, matched_line_notes: 0, matched_semantic_notes: 0 } });
      entry.outside = { aacr: BOARDS.aacr(folder, [], {}) };
    } else if (suite === "greptile") {
      const pin = read(join(f.root, "outside/boards.json"));
      const board = pin.boards.greptile;
      const judgeModel = pin.deployments[board.judge.deployment].id;
      const manifestSha256 = sha256(readFileSync(join(folder, "manifest.json")));
      const input = greptileInput(folder, "greptile", { root: f.root, cache: f.cache });
      const cases = input.cases;
      write(join(out, "input.json"), input);
      write(join(out, "eval.json"), { version: 1, board: { name: suite, repository: board.repo, commit: board.commit, judgeModel, promptHash: board.judge.prompt.sha256 }, truthSet: "greptile", judgeModel: null, promptHash: board.judge.prompt.sha256, manifestSha256, splitHash: entry.splitHash, perTool: { [tool]: { config, boardConfig: boardConfigOf(config), caught: 0, missed: ids.length, of: ids.length, planned: entry.caseIds.length, notRun: ids.length - entry.caseIds.length, rate: 0 } } });
      write(join(out, tool, "verdicts.json"), cases.map((c) => ({ id: c.id, label: "missed", reason: c.status })));
      entry.outside = { greptile: BOARDS.greptile(folder, [{ config, repeat: 1 }], {}, { root: f.root, cache: f.cache }) };
    } else {
      const run = readBoardReviews(folder, { root: f.root });
      const fresh = martianConversion(run, { cache: f.cache });
      const pins = read(join(f.root, "outside/boards.json"));
      const pin = pins.boards.martian;
      const model = pins.deployments[pin.judge.deployment].id;
      const coreCategories = new Set(["bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect"]);
      const golden = Object.values(fresh.data).flatMap((e) => e.golden_comments);
      const counts = (fn) => ({ tp: 0, fp: 0, fn, prs: ids.length, precision: 0, recall: 0, f1: 0, fbeta: 0 });
      const totals = { beta: 2, strict: counts(golden.length), core: counts(golden.filter((g) => coreCategories.has(g.category)).length), all: counts(golden.length) };
      write(join(out, "benchmark_data.json"), fresh.data);
      write(join(out, "convert.json"), { version: 1, board: "martian", repo: pin.repo, commit: pin.commit, manifestSha256: run.manifestSha256, splitHash: entry.splitHash, cases: fresh.caseRows, tools: fresh.toolRows, notRun: run.reviews.filter((r) => r.status === "not-run").map((r) => ({ tool: r.tool, caseId: r.caseId })) });
      write(join(out, `${tool}/evaluation.json`), { version: 1, toolName: tool, config, repeat: 1, board: { repo: pin.repo, commit: pin.commit }, judge: { model }, totals, candidates: [], matches: [] });
      write(join(out, "eval.json"), { version: 1, board: "martian", repo: pin.repo, commit: pin.commit, judge: { deployment: model }, problems: [], tools: [{ tool, evaluation: `${tool}/evaluation.json`, core: totals.core, problems: [] }] });
      entry.outside = { martian: BOARDS.martian(folder, manifest.jobs, {}, { root: f.root }) };
    }
    write(join(folder, "score.json"), { outside: entry.outside });
    saveEntry();
  };
  save();
  return { entry, manifest, folder, save, saveEntry };
}
function commitEntry(f, run) {
  const repo = join(f.root, "..");
  git(repo, "add", `benchmark/index/runs/${run.entry.runId}.json`);
  git(repo, "commit", "-qm", "Save run entry");
}

describe("frozen comparisons", () => {
  const attach = (f, runId, reviewer = "library") => spawnSync(process.execPath, [join(f.root, "lib/comparison.mjs"), "--attach", join(f.root, "comparison.json"), runId, reviewer], { encoding: "utf8" });
  it("attaching a run of another build is refused", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    run.entry.build.commit = "d".repeat(40); run.entry.build.short = "ddddddd";
    run.manifest.build.commit = run.entry.build.commit; run.save();
    commitEntry(f, run);
    f.record.runs = []; write(join(f.root, "comparison.json"), sign(f.record));
    const before = readFileSync(join(f.root, "comparison.json"), "utf8");
    const result = attach(f, run.entry.runId);
    expect(result.status).toBe(1); expect(result.stderr).toContain("build differs from the comparison build");
    expect(readFileSync(join(f.root, "comparison.json"), "utf8")).toBe(before);
  });
  it("a stopped run is refused: its planned case list would count unreviewed cases as misses", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    run.entry.ended = { ...run.entry.ended, how: "stopped", why: "the benchmark itself failed on one case" }; run.save();
    commitEntry(f, run);
    f.record.runs = []; write(join(f.root, "comparison.json"), sign(f.record));
    const before = readFileSync(join(f.root, "comparison.json"), "utf8");
    const result = attach(f, run.entry.runId);
    expect(result.status).toBe(1); expect(result.stderr).toContain("ended stopped; only a finished run attaches");
    expect(readFileSync(join(f.root, "comparison.json"), "utf8")).toBe(before);
  });
  it("a run that covers 49 of 50 cases is refused unless it names the case it did not run", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    const missing = run.entry.caseIds.at(-1);
    run.entry.caseIds = run.entry.caseIds.slice(0, -1); run.save();
    expect(run.entry.caseIds).toHaveLength(49);
    for (const casesNotRun of [undefined, [], [missing, missing], [run.entry.caseIds[0]], ["greptile/unknown@aaaaaaaa"]]) {
      f.record.runs[0].casesNotRun = casesNotRun;
      expect(() => validateComparison(f.record, f.options)).toThrow(/casesNotRun/);
    }
    f.record.runs[0].casesNotRun = [missing];
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
  });
  it("a judged run (with outside/) attaches", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    run.entry.caseIds = run.entry.caseIds.slice(0, -1); run.save();
    const casesNotRun = f.record.runs[0].casesNotRun;
    commitEntry(f, run);
    f.record.runs = []; write(join(f.root, "comparison.json"), sign(f.record));
    const result = attach(f, run.entry.runId);
    expect(result.status, result.stderr).toBe(0);
    const attached = read(join(f.root, "comparison.json"));
    expect(attached.runs).toEqual([{ runId: run.entry.runId, sha256: sha256(readFileSync(join(f.root, "index/runs", `${run.entry.runId}.json`))), reviewer: "library", casesNotRun }]);
    expect(attached.acceptance).toEqual({ person: "", date: "", hash: "" });
    expect(validateComparison(attached, f.options).accepted).toBe(false);
    const before = readFileSync(join(f.root, "comparison.json"), "utf8");
    const duplicate = attach(f, run.entry.runId);
    expect(duplicate.status).toBe(1); expect(duplicate.stderr).toContain(`duplicate run ${run.entry.runId}`);
    expect(readFileSync(join(f.root, "comparison.json"), "utf8")).toBe(before);
  });
  it("a run with a null board block does not attach", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    run.entry.outside.greptile = null; run.saveEntry();
    commitEntry(f, run);
    expect(entryProblems(run.entry)).toEqual([]);
    expect(() => validateComparison(f.record, f.options)).toThrow(/non-null outside.greptile/);
    f.record.runs = []; write(join(f.root, "comparison.json"), f.record);
    const before = readFileSync(join(f.root, "comparison.json"), "utf8");
    const result = attach(f, run.entry.runId);
    expect(result.status).toBe(1); expect(result.stderr).toContain("non-null outside.greptile");
    expect(readFileSync(join(f.root, "comparison.json"), "utf8")).toBe(before);
  });
  it("an entry whose outside block differs from its recomputation does not attach", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    const t = run.entry.outside.greptile.perTool["openqodex-library-r1"];
    t.caught = 1; t.missed--; t.rate = 1 / t.of; t.labels[0].label = "caught";
    run.saveEntry();
    expect(entryProblems(run.entry)).toEqual([]);
    expect(() => validateComparison(f.record, f.options)).toThrow(/board numbers.*board output/);
  });
  for (const field of ["version", "model"]) it(`an entry whose reviewer ${field} differs from its manifest does not attach`, () => {
    const f = fixture("greptile"); const run = runFixture(f);
    f.record.reviewers.library[field] = "another-value";
    run.entry.reviewers["model:gpt-6.1-sol"][field] = "another-value";
    run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/reviewer.*manifest/);
  });
  it("a verdict edited after attachment fails validation", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    sign(f.record); expect(validateComparison(f.record, f.options).accepted).toBe(true);
    const path = join(run.folder, "outside/greptile/openqodex-library-r1/verdicts.json");
    const verdicts = read(path); verdicts[0].label = "caught"; write(path, verdicts);
    expect(hashReviewedFolder(run.folder).listHash).toBe(run.entry.privateListHash);
    expect(() => validateComparison(f.record, f.options)).toThrow(/evidence hash/);
  });
  it("a control run attaches on its Claude Code version and model, and a control run on another Claude Code version is refused", () => {
    const f = fixture("greptile");
    f.record.reviewers.control = { path: "laptop", reviewer: "control", model: "claude-opus-5-5", version: "2.1.310", graph: "off", web: "off", effort: null, maxOutputTokens: null };
    const run = runFixture(f, true, "private", "control");
    run.entry.build = { ...run.entry.build, commit: "d".repeat(40), short: "ddddddd", bundleHash: null, cliVersion: null };
    run.manifest.build = { ...run.manifest.build, commit: run.entry.build.commit, bundleHash: null }; run.save();
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    run.entry.reviewers.control.version = "2.1.296"; run.save();
    expect(() => validateComparison(f.record, f.options)).toThrow(/reviewer settings/);
    run.entry.reviewers.control.version = "2.1.310"; run.save();
    delete f.record.reviewers.control.version;
    expect(() => validateComparison(f.record, f.options)).toThrow(/control.*version/);
    f.record.reviewers.control.version = "2.1.310";
    run.entry.reviewers.control.model = "another-model"; run.save();
    expect(() => validateComparison(f.record, f.options)).toThrow(/reviewer settings/);
  });
  it("a board block missing a planned tool does not attach", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    run.entry.repeat = 2; run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/tool.*r2/);
  });
  it("a Greptile block that counts fewer cases than the frozen suite does not attach", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    const t = run.entry.outside.greptile.perTool["openqodex-library-r1"];
    t.planned--; t.of--; t.missed--; t.labels.pop(); run.saveEntry();
    expect(entryProblems(run.entry)).toEqual([]);
    expect(() => validateComparison(f.record, f.options)).toThrow(/case accounting/);
  });
  it("a Martian block that drops a suite case does not attach", () => {
    const f = fixture("martian"); const run = runFixture(f);
    run.entry.caseIds = run.entry.caseIds.slice(0, -1); run.save();
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    const path = join(run.folder, "outside/martian/convert.json");
    const convert = read(path); convert.cases.pop(); write(path, convert);
    run.entry.outside.martian.evidenceHash = hashFolder(run.folder, ["convert.json", "eval.json", "benchmark_data.json", "openqodex-library-r1/evaluation.json"].map((p) => `outside/martian/${p}`)).listHash;
    run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/case accounting/);
  });
  it("a held Greptile tool does not attach", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    const out = join(run.folder, "outside/greptile");
    const input = read(join(out, "input.json"));
    const hold = [{ case: "fixture-case", index: 0, lacking: ["fix"] }];
    input.tools[0].held = hold; write(join(out, "input.json"), input);
    const evaluation = read(join(out, "eval.json"));
    Object.assign(evaluation.perTool["openqodex-library-r1"], { held: hold, caught: null, missed: null, rate: null });
    write(join(out, "eval.json"), evaluation);
    rmSync(join(out, "openqodex-library-r1/verdicts.json"));
    Object.assign(run.entry.outside.greptile.perTool["openqodex-library-r1"], { held: hold, caught: null, missed: null, rate: null });
    run.saveEntry();
    expect(entryProblems(run.entry)).toEqual([]);
    expect(() => validateComparison(f.record, f.options)).toThrow("tool openqodex-library-r1 is held by the judge: fixture-case index 0: lacks fix");
  });
  it("a held Martian tool does not attach", () => {
    const f = fixture("martian"); const run = runFixture(f);
    const block = run.entry.outside.martian;
    Object.assign(block.perTool["openqodex-library-r1"], { held: "fixture-case index 0: lacks fix", official: null, ours: null });
    rmSync(join(run.folder, "outside/martian/openqodex-library-r1/evaluation.json"));
    block.evidenceHash = hashFolder(run.folder, ["convert.json", "eval.json", "benchmark_data.json"].map((p) => `outside/martian/${p}`)).listHash;
    run.saveEntry();
    expect(entryProblems(run.entry)).toEqual([]);
    expect(() => validateComparison(f.record, f.options)).toThrow("tool openqodex-library-r1 is held by the judge: fixture-case index 0: lacks fix");
  });
  it("an AACR block with one problem does not attach", () => {
    const f = fixture(); const run = runFixture(f);
    const path = join(run.folder, "outside/aacr", run.entry.configs[0], "r1/metrics_ocr_fixture.json");
    const metrics = read(path); metrics.summary.generated_notes = 1; write(path, metrics);
    run.entry.outside.aacr = BOARDS.aacr(run.folder, [], {}); run.saveEntry();
    expect(run.entry.outside.aacr.problems).toHaveLength(1);
    expect(() => validateComparison(f.record, f.options)).toThrow(/outside.aacr.*problems/);
  });
  it("an AACR folder with no semantic judgment does not attach", () => {
    const f = fixture(); const run = runFixture(f);
    const path = join(run.folder, "outside/aacr/eval.json");
    const evaluation = read(path); evaluation.folders[0].mode = "mock"; write(path, evaluation);
    run.entry.outside.aacr = BOARDS.aacr(run.folder, [], {}); run.saveEntry();
    expect(run.entry.outside.aacr.problems).toEqual([]);
    expect(run.entry.outside.aacr.folders[0].semantic).toBeNull();
    expect(() => validateComparison(f.record, f.options)).toThrow(/tool.*not judged/);
  });
  it("a Greptile run judged on the augment set does not attach", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    for (const file of ["input.json", "eval.json"]) {
      const path = join(run.folder, "outside/greptile", file);
      const value = read(path); value.truthSet = "augment"; write(path, value);
    }
    run.entry.outside.greptile = BOARDS.greptile(run.folder, [{ config: run.entry.configs[0], repeat: 1 }], {}, { root: f.root });
    run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/truth set.*profile/);
  });
  for (const field of ["commit", "promptHash", "judgeModel"]) it(`a Greptile block whose board ${field} differs from the pin does not attach`, () => {
    const f = fixture("greptile"); const run = runFixture(f);
    run.entry.outside.greptile.board[field] = "changed"; run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/board.*pin/);
  });
  for (const suite of ["greptile", "martian", "aacr"]) it(`a ${suite} block whose judge model differs from the pin does not attach`, () => {
    const f = fixture(suite); const run = runFixture(f);
    const block = run.entry.outside[suite];
    if (suite === "greptile") block.judgeModel = "another-model";
    else block.judge.deployment = "another-model";
    run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/judge model.*pin/);
  });
  it("a Greptile block that marks a different case not-run than the one the entry misses does not attach", () => {
    const f = fixture("greptile"); const run = runFixture(f);
    run.entry.caseIds = run.entry.caseIds.slice(0, -1); run.save();
    const out = join(run.folder, "outside/greptile");
    const input = read(join(out, "input.json"));
    input.cases[0].status = "not-run"; input.cases.at(-1).status = "complete";
    write(join(out, "input.json"), input);
    const path = join(out, "openqodex-library-r1/verdicts.json");
    const verdicts = read(path); verdicts[0].reason = "not-run"; verdicts.at(-1).reason = "empty"; write(path, verdicts);
    run.entry.outside.greptile.perTool["openqodex-library-r1"].labels = verdicts;
    run.entry.outside.greptile.evidenceHash = hashFolder(run.folder, ["input.json", "eval.json", "openqodex-library-r1/verdicts.json"].map((p) => `outside/greptile/${p}`)).listHash;
    run.saveEntry();
    expect(() => validateComparison(f.record, f.options)).toThrow(/case accounting/);
  });
  it("attaching an entry that differs from HEAD is refused", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    commitEntry(f, run);
    const path = join(f.root, "index/runs", `${run.entry.runId}.json`);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    f.record.runs = []; write(join(f.root, "comparison.json"), sign(f.record));
    const before = readFileSync(join(f.root, "comparison.json"), "utf8");
    const result = attach(f, run.entry.runId);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`run ${run.entry.runId} entry is not committed at HEAD; commit it before attaching`);
    expect(readFileSync(join(f.root, "comparison.json"), "utf8")).toBe(before);
  });
  it("attaching an entry absent from HEAD is refused", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    git(join(f.root, ".."), "commit", "--allow-empty", "-qm", "Start fixture");
    f.record.runs = []; write(join(f.root, "comparison.json"), sign(f.record));
    const result = attach(f, run.entry.runId);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`run ${run.entry.runId} entry is not committed at HEAD; commit it before attaching`);
  });
  it("attaching from a different checkout build succeeds when the entry matches the record build", () => {
    const f = fixture("greptile", true); const run = runFixture(f);
    commitEntry(f, run);
    write(join(f.root, ".build/provenance.json"), { ...f.build, commit: "d".repeat(40) });
    expect(read(join(f.root, ".build/provenance.json")).commit).not.toBe(f.record.build.commit);
    f.record.runs = []; write(join(f.root, "comparison.json"), sign(f.record));
    const result = attach(f, run.entry.runId);
    expect(result.status, result.stderr).toBe(0);
    const attached = read(join(f.root, "comparison.json"));
    expect(attached.runs).toHaveLength(1);
    expect(validateComparison(attached, f.options).accepted).toBe(false);
  });
  it("refuses edited planted case bytes even when the lock was not updated", () => {
    const { root, options } = fixture();
    const name = "clean-python-feature";
    cpSync(join(benchRoot, "cases", name), join(root, "cases", name), { recursive: true });
    write(join(root, "cases.lock.json"), { version: 1, cases: { [name]: { hash: caseHash(name, join(root, "cases")), frozenAt: "2026-10-14", history: null, retired: false } } });
    const record = freezeComparison({ release: "compare-2026-10", suites: ["planted"], boards: ["aacr"], reviewers, capUsd: 100 }, options);
    sign(record);
    const file = join(root, "cases", name, "case.json"); writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    expect(() => validateComparison(record, options)).toThrow(/case|hash/);
  });
  it("refuses a changed case hash and a changed split", () => {
    for (const file of ["suites/aacr/cases.json", "splits/aacr-v1.json"]) {
      const { root, options, record } = fixture(); sign(record);
      const data = read(join(root, file));
      if (data.cases instanceof Array) data.cases[0].hash = "d".repeat(64);
      else data.salt = "changed";
      write(join(root, file), data);
      expect(() => validateComparison(record, options)).toThrow(/suite|hash|split/);
    }
  });
  for (const field of ["commit", "tree", "bundleHash", "version"]) it(`refuses a changed build ${field}`, () => {
    const { options, record } = fixture(); sign(record);
    expect(() => validateComparison(record, { ...options, build: { ...options.build, [field]: field === "version" ? "0.13.0" : "d".repeat(field === "bundleHash" ? 64 : 40) } })).toThrow(/build/);
  });
  it("refuses changed board judge and prompt pins", () => {
    const { root, options, record } = fixture(); sign(record);
    const boards = read(join(root, "outside/boards.json")); boards.deployments.judge.served = "another-model";
    write(join(root, "outside/boards.json"), boards);
    expect(() => validateComparison(record, options)).toThrow(/board|judge/);
    for (const field of ["promptHash", "metric", "profile"]) {
      const f = fixture(); f.record.boards.aacr[field] = "changed";
      expect(() => validateComparison(f.record, f.options)).toThrow(/board/);
    }
  });
  it("hashes every field including acceptance identity, date and unknown future fields", () => {
    const { options, record } = fixture(); sign(record);
    expect(validateComparison(record, options).accepted).toBe(true);
    function leaves(value, path = []) {
      return value && typeof value === "object" ? Object.entries(value).flatMap(([key, v]) => leaves(v, [...path, key])) : [path];
    }
    for (const path of leaves(record).filter((p) => p.join(".") !== "acceptance.hash")) {
      const changed = structuredClone(record); let target = changed;
      for (const key of path.slice(0, -1)) target = target[key];
      const key = path.at(-1); target[key] = `${target[key]} changed`;
      expect(comparisonHash(changed), path.join(".")).not.toBe(record.acceptance.hash);
      expect(() => validateComparison(changed, options)).toThrow();
    }
    const changed = { ...record, future: "covered" };
    expect(() => validateComparison(changed, options)).toThrow(/acceptance/);
  });
  it("treats empty acceptance as not accepted and refuses partial acceptance", () => {
    const { options, record } = fixture();
    expect(validateComparison(record, options).accepted).toBe(false);
    record.acceptance.person = "Sid";
    expect(() => validateComparison(record, options)).toThrow(/acceptance/);
  });
  for (const person of ["Unlisted person", "Codex"]) it(`refuses acceptance by ${person.toLowerCase()}`, () => {
    const { options, record } = fixture(); sign(record);
    record.acceptance.person = person; record.acceptance.hash = comparisonHash(record);
    expect(() => validateComparison(record, options)).toThrow(/person|acceptance/);
  });
  for (const field of ["effort", "maxOutputTokens"]) {
    it(`refuses a reviewer without a ${field} pin`, () => {
      const { options, record } = fixture(); record.reviewers = structuredClone(reviewers); delete record.reviewers.library[field];
      expect(() => validateComparison(record, options)).toThrow(/reviewer/);
    });
    it(`refuses a run with different ${field}`, () => {
      const f = fixture(); const run = runFixture(f);
      expect(validateComparison(f.record, f.options).accepted).toBe(false);
      run.manifest.reviewers["model:gpt-6.1-sol"].settings[field] = field === "effort" ? "low" : 16000; run.save();
      expect(() => validateComparison(f.record, f.options)).toThrow(/reviewer settings/);
    });
  }
  for (const list of ["asset", "private"]) it(`refuses an edited legacy manifest after verifying the ${list} list hash`, () => {
    const f = fixture(); const run = runFixture(f, false, list);
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    write(join(run.folder, "manifest.json"), { ...run.manifest, edited: true });
    expect(() => validateComparison(f.record, f.options)).toThrow(/list hash/);
  });
  it("refuses a legacy tree changed locally to match the comparison", () => {
    const f = fixture(); const run = runFixture(f, false);
    run.manifest.build.tree = "d".repeat(40); run.save();
    expect(() => validateComparison(f.record, f.options)).toThrow(/build/);
    run.manifest.build.tree = f.build.tree; write(join(run.folder, "manifest.json"), run.manifest);
    expect(() => validateComparison(f.record, f.options)).toThrow(/list hash/);
  });
  it("refuses missing and changed calibration files", () => {
    const f = fixture(); const { root, options, record } = f;
    const calibration = calibrationFixture(f);
    const bytes = `${JSON.stringify(calibration, null, 2)}\n`;
    record.calibrations = [{ file: "index/calibration/missing.json", sha256: sha256(bytes), ...calibration }];
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
    const path = join(root, record.calibrations[0].file); writeFileSyncAfterMkdir(path, bytes); sign(record);
    expect(validateComparison(record, options).accepted).toBe(true);
    writeFileSync(path, "{\"changed\":true}\n");
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
  });
  it("refuses a calibration reference from another build", () => {
    const f = fixture(); calibrationFixture(f);
    f.record.calibrations[0].build.tree = "d".repeat(40);
    expect(() => validateComparison(f.record, f.options)).toThrow(/calibration.*build/);
  });
  it("refuses two calibration files for the same board", () => {
    const f = fixture(); const calibration = calibrationFixture(f);
    const file = "index/calibration/duplicate-board.json";
    write(join(f.root, file), calibration);
    f.record.calibrations.push({ ...structuredClone(f.record.calibrations[0]), file });
    expect(() => validateComparison(f.record, f.options)).toThrow("duplicate calibration board aacr");
  });
  it("refuses a calibration file from another build even with its correct hash", () => {
    const f = fixture(); const calibration = calibrationFixture(f);
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    calibration.build.bundleHash = "d".repeat(64);
    const c = f.record.calibrations[0]; write(join(f.root, c.file), calibration); c.sha256 = sha256(readFileSync(join(f.root, c.file)));
    expect(() => validateComparison(f.record, f.options)).toThrow(/calibration.*build/);
  });
  it("refuses claimed calibration agreement that differs from the saved numbers", () => {
    const f = fixture(); calibrationFixture(f); f.record.calibrations[0].agreement.positive = 0.95;
    expect(() => validateComparison(f.record, f.options)).toThrow(/calibration.*agreement/);
  });
  for (const name of ["positive", "negative"]) it(`refuses a calibration below 90 percent on ${name} without a ruling`, () => {
    const f = fixture(); const calibration = calibrationFixture(f);
    calibration.counts.byClass[name] = { total: 10, agree: 8, disagree: 2 };
    calibration.counts.agree = 18; calibration.counts.disagree = 2; calibration.agreement[name] = 0.8;
    const c = f.record.calibrations[0]; Object.assign(c, structuredClone(calibration));
    write(join(f.root, c.file), calibration); c.sha256 = sha256(readFileSync(join(f.root, c.file)));
    expect(() => validateComparison(f.record, f.options)).toThrow(/90 percent/);
  });
  it("refuses the sub-bar Greptile calibration without a ruling", () => {
    const f = ruledCalibrationFixture(); delete f.record.calibrationRulings;
    expect(() => validateComparison(f.record, f.options)).toThrow(/90 percent/);
  });
  it("accepts the sub-bar calibration with matching ruling percentages and exposes them to the page", () => {
    const f = ruledCalibrationFixture(); sign(f.record);
    const result = validateComparison(f.record, f.options);
    expect(result.accepted).toBe(true);
    expect(result.boards.greptile.judgeAgreement).toEqual({ caught: 85.37, missed: 88.89 });
    expect(result.boards.aacr.judgeAgreement).toBeNull();
  });
  for (const name of ["caught", "missed"]) it(`refuses a ruling whose ${name} percentage differs from the calibration record`, () => {
    const f = ruledCalibrationFixture(); f.record.calibrationRulings[0].agreement[name] += 0.01;
    sign(f.record);
    expect(() => validateComparison(f.record, f.options)).toThrow(/ruling.*agreement/);
  });
  for (const name of ["Unlisted person", "", "Codex"]) it(`refuses a calibration ruling by ${name || "a missing person"}`, () => {
    const f = ruledCalibrationFixture(); f.record.calibrationRulings[0].decidedBy = name;
    expect(() => validateComparison(f.record, f.options)).toThrow(/ruling.*person/);
  });
  for (const board of ["aacr", "unknown"]) it(`refuses a ruling for ${board} without a calibration record`, () => {
    const f = ruledCalibrationFixture(); f.record.calibrationRulings[0].board = board;
    f.record.calibrations = [];
    expect(() => validateComparison(f.record, f.options)).toThrow(/ruling.*calibration record/);
  });
  it("accepts the saved Martian calibration with one excluded deduplication item and exposes both agreement classes", () => {
    const f = fixture();
    const calibration = read(join(benchRoot, "index/calibration/martian-2026-10-21.json"));
    expect(calibration.status).toBe("complete");
    expect(calibration.excluded).toEqual({ count: 1, reason: expect.stringMatching(/deduplication.*three invalid.*two.*labels/i) });
    expect(calibration.judgeFailures).toMatchObject({ items: 1, labels: 2 });
    calibration.build = { ...f.build };
    f.record.boards.martian = calibration.board;
    const file = "index/calibration/martian.json";
    write(join(f.root, file), calibration);
    f.record.calibrations = [{ file, sha256: sha256(readFileSync(join(f.root, file))), build: calibration.build, agreement: calibration.agreement }];
    sign(f.record);
    const result = validateComparison(f.record, f.options);
    expect(result.accepted).toBe(true);
    expect(result.boards.martian.judgeAgreement).toEqual({ positive: 92.45, negative: 96.92 });
  });
  it("refuses reference paths outside the benchmark folder", () => {
    const { options, record } = fixture();
    record.calibrations = [{ file: "../package.json", sha256: "a".repeat(64), build: record.build, agreement: { exact: 1 } }];
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
    record.calibrations = []; record.runs = [{ runId: "../outside", sha256: "a".repeat(64), reviewer: "library" }];
    expect(() => validateComparison(record, options)).toThrow(/run/);
  });
  it("refuses missing runs, edited runs and runs from another build", () => {
    const f = fixture(); const { root, options, record } = f;
    const { entry } = runFixture(f);
    entry.runId = "2026-10-12-comparison-missing";
    record.runs[0].runId = entry.runId; record.runs[0].sha256 = sha256(JSON.stringify(entry));
    expect(() => validateComparison(record, options)).toThrow(/run/);
    entry.runId = "2026-10-12-b43b25b-aacr-gpt61"; record.runs[0].runId = entry.runId; record.runs[0].sha256 = sha256(JSON.stringify(entry));
    const path = join(root, "index/runs", `${entry.runId}.json`); writeFileSyncAfterMkdir(path, JSON.stringify(entry));
    expect(validateComparison(record, options).accepted).toBe(false);
    entry.scores.changed = {}; writeFileSyncAfterMkdir(path, JSON.stringify(entry));
    expect(() => validateComparison(record, options)).toThrow(/run/);
    delete entry.scores.changed;
    entry.build.bundleHash = "d".repeat(64); writeFileSyncAfterMkdir(path, JSON.stringify(entry)); record.runs[0].sha256 = sha256(JSON.stringify(entry));
    expect(() => validateComparison(record, options)).toThrow(/build/);
  });
  for (const field of ["release", "boards", "suites", "build", "reviewers", "capUsd", "runs", "calibrations", "acceptance"]) it(`refuses missing ${field}`, () => {
    const { options, record } = fixture(); delete record[field];
    expect(() => validateComparison(record, options)).toThrow();
  });
});
function writeFileSyncAfterMkdir(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }

describe("pinned vendor rows", () => {
  const data = () => read(join(benchRoot, "index/outside-rows.json"));
  for (const field of ["board", "product", "metric", "value", "measuredBy", "measurementDate", "source", "readDate", "goldenSet"]) it(`refuses a vendor row without ${field}`, () => {
    const rows = data(); delete rows.rows[0][field];
    expect(() => validateOutsideRows(rows)).toThrow(new RegExp(field));
  });
  it("refuses duplicate rows, invalid measurements and impossible dates", () => {
    const rows = data(); rows.rows.push(structuredClone(rows.rows[0])); expect(() => validateOutsideRows(rows)).toThrow(/duplicate/);
    for (const change of [{ value: -1 }, { value: null }, { source: "no URL" }, { measurementDate: "2025-02-30" }, { goldenSet: {} }]) {
      const rows = data(); Object.assign(rows.rows[0], change); expect(() => validateOutsideRows(rows)).toThrow();
    }
  });
  for (const board of ["greptile-original", "augment-corrected"]) {
    it(`refuses ${board} without a source snapshot`, () => {
      const rows = data(); rows.rows = rows.rows.filter((r) => r.board === board); delete rows.rows[0].snapshot;
      expect(() => validateOutsideRows(rows)).toThrow(/snapshot/);
    });
    it(`refuses ${board} when the snapshot bytes change`, () => {
      const root = join(tempDir("oq-outside-snapshot-"), "benchmark");
      const rows = data(); rows.rows = [rows.rows.find((r) => r.board === board)];
      const file = `index/outside-sources/${board}.txt`; const path = join(root, file);
      writeFileSyncAfterMkdir(path, "Saved page\n"); rows.rows[0].snapshot = { file, sha256: sha256(readFileSync(path)) };
      expect(validateOutsideRows(rows, { root })).toEqual(rows.rows);
      writeFileSync(path, "Edited page\n");
      expect(() => validateOutsideRows(rows, { root })).toThrow(/snapshot.*hash/);
    });
  }
  it("prints every complete pinned row through the real validator command", () => {
    const rows = data(); expect(validateOutsideRows(rows)).toEqual(rows.rows);
    const r = spawnSync(process.execPath, [join(benchRoot, "lib/comparison.mjs"), "--outside-rows", join(benchRoot, "index/outside-rows.json")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toEqual(rows.rows);
  });
});
