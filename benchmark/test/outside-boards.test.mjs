// Each test names the saved-output failure it guards. No judge is called.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { boardReview, greptileInput } from "../lib/board-reviews.mjs";
import { entryProblems, hashFolder, sha256 } from "../lib/index.mjs";
import { BOARDS, outsideProblems } from "../lib/outside-boards.mjs";
import { readGreptileOutside } from "../lib/greptile-board.mjs";
import { boardConfigOf, boardToolName, martianEvaluations, readMartianOutside } from "../lib/martian-board.mjs";
import { attemptDir, planJobs, sampleRecord } from "../lib/runner.mjs";
import { martianFindings, martianGolden, nativeFindingId, readMartianEvaluation } from "../lib/score.mjs";
import { martianTruth, readCase, readSuite, specCopy, truthOf } from "../lib/suites.mjs";
import { extractAsset } from "../fetch-run.mjs";
import { ALLOWED, packageRun, publishRun } from "../publish-run.mjs";
import { convertRun } from "../outside/convert/martian.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { CLAUDE, FIXTURES, MODEL, convertOpts, finding, fixturePlan, fixtureReport, report, savedRun, suite } from "./martian-board-fixture.mjs";
import { boardSuiteFixture } from "./board-suite-fixture.mjs";

afterAll(removeTempDirs);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const pins = read(join(benchRoot, "outside/boards.json"));
const judgeModel = pins.deployments[pins.boards.martian.judge.deployment].id;
const tool = "openqodex-cli-claude-r1";
const boardPath = (folder, board, path) => join(folder, "outside", board, path);
const boardOptions = new Map();
const readBlock = (folder, board) => { const run = loadRun(folder); return BOARDS[board](folder, scoreRun(run).jobs, run.specs, boardOptions.get(folder)); };
const options = (folder) => ({ boardOptions: boardOptions.get(folder), runs: tempDir("oq-outside-index-"), out: tempDir("oq-outside-asset-"), env: { OPENQODEX_BENCH_MODEL_ENV: join(benchRoot, "test/fixtures/no-model.env") }, dryRun: true, writeIndex: true });
const greptileBlock = (folder) => readGreptileOutside(folder, read(join(folder, "manifest.json")).jobs, {}, boardOptions.get(folder));

async function martianRun({ native = null, empty = false, accessLog } = {}) {
  const ctx = await suite();
  const selected = empty ? { ...ctx, ids: new Map([...ctx.ids].slice(0, 2)) } : ctx;
  const config = native === null ? CLAUDE : "control-graph-off";
  const name = native === null ? tool : "claude-code-control-r1";
  const plan = { [`${config}/1`]: native === null ? fixturePlan()[`${MODEL}/1`] : Object.fromEntries([...ctx.ids.keys()].map((c) => [c, { reviewer: "control", status: "complete", nativeBody: native }])) };
  if (empty) plan[`${config}/1`] = Object.fromEntries([...selected.ids.keys()].map((c, i) => [c, i === 0 ? { reviewer: "control", status: "failed", nativeBody: "", failure: "No saved native review" } : "unstarted"]));
  const saved = await savedRun(selected, { configs: [config], plan, settings: { path: "laptop", build: { commit: "a".repeat(40), short: "aaaaaaa", dirty: false }, reviewers: { claude: { version: "fixture", model: "fixture" } } } });
  const folder = join(dirname(saved), "2026-10-11-aaaaaaa");
  renameSync(saved, folder);
  boardOptions.set(folder, { root: ctx.root, cache: ctx.cache });
  for (const [name, id] of ctx.ids) write(join(folder, "cases", `${name}.json`), specCopy(readCase(id, { root: ctx.root }), truthOf(readCase(id, { root: ctx.root }), { cache: ctx.cache })));
  const { data } = await convertRun(folder, convertOpts(ctx, accessLog ? { accessLog } : {}));
  const r = (file) => JSON.parse(readFileSync(join(FIXTURES, "recorded", file), "utf8").replaceAll("openqodex-library-r1", name));
  const evaluations = empty ? Object.fromEntries(Object.entries(data).map(([url, e]) => [url, { [name]: { total_candidates: 0, total_golden: e.golden_comments.length, errors_count: 0, true_positives: [], false_positives: [] } }])) : r("evaluations.json");
  const totals = r("totals.json");
  if (empty) for (const profile of ["strict", "core", "all"]) totals.profiles[profile][name] = { precision: 0, recall: 0, f1: 0, fbeta: 0, tp: 0, fp: 0, fn: profile === "strict" ? 4 : 5, prs: 3 };
  const result = martianEvaluations({ data, candidates: empty ? {} : r("candidates.json"), dedup: empty ? {} : r("dedup_groups.json"), evaluations, totals, judge: { model: judgeModel, served: judgeModel }, model: judgeModel });
  expect(result.problems).toEqual([]);
  expect(result.tools[0].problems).toEqual([]);
  const evaluation = result.tools[0].evaluation;
  write(boardPath(folder, "martian", `${name}/evaluation.json`), evaluation);
  write(boardPath(folder, "martian", "eval.json"), { version: 1, board: "martian", repo: pins.boards.martian.repo, commit: pins.boards.martian.commit, judge: { deployment: judgeModel }, tools: [{ tool: name, evaluation: `${name}/evaluation.json`, core: evaluation.totals.core, problems: [] }], problems: [] });
  const run = loadRun(folder);
  const scored = scoreRun(run);
  write(join(folder, "score.json"), { ...scored.score, outside: { martian: readMartianOutside(folder, scored.jobs, run.specs, boardOptions.get(folder)) } });
  return { folder, evaluation, data };
}

function greptileRun({ held = false, comments = true, caseCount = 50 } = {}) {
  const folder = tempDir("oq-outside-greptile-");
  const ctx = boardSuiteFixture("greptile", undefined, caseCount);
  boardOptions.set(folder, ctx);
  const suite = readSuite("greptile", ctx);
  const ids = suite.file.cases.map((c) => c.id);
  const first = suite.file.cases[0];
  const { jobs } = planJobs({ cases: [first.name], caseIds: { [first.name]: first.id }, reviewers: ["claude"], graph: ["on"], repeat: 1 });
  const manifest = { suite: "greptile", splitHash: suite.splitHash, caseHashes: { [first.name]: first.hash }, jobs };
  const c = readCase(first.id, ctx);
  write(join(folder, "cases", `${first.name}.json`), specCopy(c, truthOf(c, ctx)));
  const rep = report({ findings: comments ? [finding(held ? { fix: " " } : {})] : [] });
  const dir = attemptDir(folder, jobs[0], 1);
  write(join(dir, "sample.json"), sampleRecord({ job: jobs[0], attempt: 1, result: { code: 0, wallMs: 1 }, report: rep, startedAt: "2026-10-24T00:00:00Z" }));
  write(join(dir, "report/report.json"), rep);
  write(join(folder, "manifest.json"), manifest);
  const manifestSha256 = sha256(readFileSync(join(folder, "manifest.json")));
  const input = greptileInput(folder, "greptile", ctx);
  const hold = input.tools[0].held;
  write(boardPath(folder, "greptile", "input.json"), input);
  const pin = pins.boards.greptile;
  const judgeModel = pins.deployments[pin.judge.deployment].id;
  const perTool = { [tool]: { config: CLAUDE, boardConfig: "cli-claude", ...(held ? { held: hold } : {}), caught: held ? null : comments ? 1 : 0, missed: held ? null : ids.length - (comments ? 1 : 0), of: ids.length, planned: 1, notRun: ids.length - 1, rate: held ? null : comments ? 1 / ids.length : 0 } };
  write(boardPath(folder, "greptile", "eval.json"), { version: 1, board: { name: "greptile", repository: pin.repo, commit: pin.commit, judgeModel, promptHash: pin.judge.prompt.sha256 }, truthSet: "greptile", judgeModel: held || !comments ? null : judgeModel, promptHash: pin.judge.prompt.sha256, manifestSha256, splitHash: suite.splitHash, relay: null, perTool });
  if (!held) write(boardPath(folder, "greptile", `${tool}/verdicts.json`), ids.map((id, i) => ({ id, label: i === 0 && comments ? "caught" : "missed", reason: i === 0 ? comments ? "judge" : "empty" : "not-run" })));
  return folder;
}

it("AACR board files cannot change a previously published package list", async () => {
  const { folder } = await martianRun();
  const opts = options(folder);
  const before = await packageRun(folder, opts);
  const paths = ["outside/aacr/convert.json", "outside/aacr/eval.json"];
  for (const path of paths) write(join(folder, path), { version: 1 });
  const metrics = join(benchRoot, "test/fixtures/aacr-board/metrics");
  for (const file of readdirSync(metrics)) {
    const [, config, repeat] = /^(.*)-r(\d+)\.json$/.exec(file);
    const path = `outside/aacr/${config}/r${repeat}/metrics_ocr_fixture.json`;
    paths.push(path);
    write(join(folder, path), read(join(metrics, file)));
  }
  const after = await packageRun(folder, opts);
  expect(after.files).toBe(before.files);
  expect(after.listHash).toBe(before.listHash);
  expect(after.sha256).toBe(before.sha256);
  for (const path of paths) expect(ALLOWED.some((pattern) => pattern.test(path)), path).toBe(false);
});

it("a superseded Martian match is neither a winning match nor an official false positive", () => {
  const saved = read(join(benchRoot, "test/fixtures/martian/superseded-match.json"));
  const caseId = "martian/grafana__grafana-94942@aaaaaaaa";
  const findings = martianFindings(caseId, report({ findings: saved.candidates.map((c) => finding({ title: c.text })) }));
  const data = { [saved.url]: { golden_comments: saved.golden, openqodex: { caseId }, reviews: [{ tool: saved.tool, review_comments: saved.candidates.map((c) => ({ body: c.text })), openqodex: { findingIds: findings.map((f) => f.findingId) } }] } };
  const counts = { tp: saved.evaluation.tp, fp: saved.evaluation.fp, fn: saved.evaluation.fn, prs: 1, precision: 0.5, recall: 0.5, f1: 0.5, fbeta: 0.5 };
  const totals = { beta: 2, profiles: Object.fromEntries(["strict", "core", "all"].map((p) => [p, { [saved.tool]: counts }])) };
  const result = martianEvaluations({ data, candidates: { [saved.url]: { [saved.tool]: saved.candidates } }, dedup: { [saved.url]: { [saved.tool]: saved.dedup } }, evaluations: { [saved.url]: { [saved.tool]: saved.evaluation } }, totals, judge: { model: judgeModel }, model: judgeModel });
  expect(result.problems).toEqual([]);
  expect(result.tools[0].problems).toEqual([]);
  const evaluation = result.tools[0].evaluation;
  expect(evaluation.candidates.map((c) => c.officialFp)).toEqual([false, false, true]);
  expect(evaluation.matches.map((m) => m.candidateId)).toEqual([`${saved.url}#1`]);
  const golden = martianGolden(caseId, martianTruth({ comments: saved.golden }));
  expect(readMartianEvaluation(evaluation, { findings, golden }).official.core).toMatchObject({ tp: 1, fp: 1, fn: 1, f1: 0.5 });
});

it("Martian refuses a winning candidate flagged as an official false positive", async () => {
  const { folder, evaluation } = await martianRun();
  evaluation.candidates.find((c) => c.candidateId === evaluation.matches[0].candidateId).officialFp = true;
  write(boardPath(folder, "martian", `${tool}/evaluation.json`), evaluation);
  expect(() => readBlock(folder, "martian")).toThrow(/official false positive.*(match|sibling)/);
});

it("Martian refuses a winning candidate's dedup sibling flagged as an official false positive", async () => {
  const { folder, evaluation } = await martianRun();
  const winners = new Set(evaluation.matches.map((m) => m.candidateId));
  const sibling = evaluation.candidates.find((c) => !winners.has(c.candidateId) && evaluation.candidates.some((w) => winners.has(w.candidateId) && w.prUrl === c.prUrl && w.dedupGroup === c.dedupGroup));
  expect(sibling).toBeDefined();
  sibling.officialFp = true;
  write(boardPath(folder, "martian", `${tool}/evaluation.json`), evaluation);
  expect(() => readBlock(folder, "martian")).toThrow(/official false positive.*(match|sibling)/);
});

it("Martian refuses a candidate missing its official false positive verdict", async () => {
  const { folder, evaluation } = await martianRun();
  delete evaluation.candidates[0].officialFp;
  write(boardPath(folder, "martian", `${tool}/evaluation.json`), evaluation);
  expect(() => readBlock(folder, "martian")).toThrow(/candidate.*official.*verdict/);
});

it("a held Martian tool preserves the judged tool's numbers in the same block", async () => {
  const ctx = await suite();
  const plan = fixturePlan();
  plan[`${CLAUDE}/1`] = { "oq-fixture__shop-12": report({ findings: [finding({ fix: " " })] }) };
  const folder = await savedRun(ctx, { plan, configs: [MODEL, CLAUDE] });
  const { record, data } = await convertRun(folder, convertOpts(ctx));
  const r = (file) => read(join(FIXTURES, "recorded", file));
  const judged = martianEvaluations({ data, candidates: r("candidates.json"), dedup: r("dedup_groups.json"), evaluations: r("evaluations.json"), totals: r("totals.json"), judge: { model: judgeModel }, model: judgeModel });
  expect(judged.tools[0].problems).toEqual([]);
  const evaluation = judged.tools[0].evaluation;
  write(boardPath(folder, "martian", "openqodex-library-r1/evaluation.json"), evaluation);
  const held = record.tools.find((t) => t.held);
  write(boardPath(folder, "martian", "eval.json"), { version: 1, board: "martian", repo: pins.boards.martian.repo, commit: pins.boards.martian.commit, judge: { deployment: judgeModel }, tools: [{ tool: "openqodex-library-r1", evaluation: "openqodex-library-r1/evaluation.json", core: evaluation.totals.core, problems: [] }, { tool: held.tool, evaluation: null, core: null, problems: [`held by the converter: ${held.why}`] }], problems: [] });
  const block = readMartianOutside(folder, read(join(folder, "manifest.json")).jobs, {}, { root: ctx.root, cache: ctx.cache });
  expect(Object.keys(block.perTool).sort()).toEqual([tool, "openqodex-library-r1"]);
  expect(block.perTool[tool]).toMatchObject({ config: CLAUDE, boardConfig: "cli-claude", repeat: 1, held: held.why, official: null });
  expect(block.perTool["openqodex-library-r1"].official.core).toEqual(evaluation.totals.core);
  expect(outsideProblems({ martian: block })).toEqual([]);
});

const martianRead = (folder) => spawnSync(process.execPath, ["--input-type=module", "-e", 'import { readOutside } from "./benchmark/lib/outside-boards.mjs"; readOutside(process.argv[1], [], {}, ["martian"], JSON.parse(process.argv[2]));', folder, JSON.stringify(boardOptions.get(folder) ?? {})], { encoding: "utf8" });

it("a Martian run without board output names the conversion command in one line", () => {
  const folder = tempDir("oq-outside-missing-");
  const result = martianRead(folder);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe(`outside.martian is null: ${boardPath(folder, "martian", "")} holds no convert.json; convert the run first (benchmark/outside/boards/martian.sh <run>)\n`);
});

it("a converted Martian run without an evaluation names the judging command in one line", async () => {
  const ctx = await suite();
  const folder = await savedRun(ctx, { plan: fixturePlan() });
  await convertRun(folder, convertOpts(ctx));
  const result = martianRead(folder);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe(`outside.martian is null: ${boardPath(folder, "martian", "")} holds no eval.json; judge the run first (benchmark/outside/boards/martian.sh <run>)\n`);
});

it("Greptile refuses board tools when the run planned no jobs", () => {
  const folder = greptileRun();
  expect(() => readGreptileOutside(folder, [], {}, boardOptions.get(folder))).toThrow(/tools differ from the run's planned jobs/);
});

it("native Martian sources follow the caller's eligibility predicate without assuming control names", () => {
  const config = "caller-owned-config";
  const toolName = "caller-owned-tool";
  const caseId = "martian/native@aaaaaaaa";
  const text = "The loop reads past the array.";
  const findingId = nativeFindingId(caseId, config, 2, text);
  const findings = [{ findingId, caseId, config, repeat: 2, index: 0, severity: null, source: "native", text }];
  const golden = [{ goldenId: `${caseId}#g1`, caseId, rawCategory: "bug" }];
  const totals = { precision: 1, recall: 1, f1: 1, fbeta: 1, tp: 1, fp: 0, fn: 0, prs: 1 };
  const evaluation = { version: 1, toolName, judge: { model: judgeModel }, totals: { beta: 2, strict: totals, core: totals, all: totals }, candidates: [{ candidateId: "candidate", extractedText: text, officialFp: false, sourceFindingIds: [findingId], extraction: {}, dedupGroup: 0 }], matches: [{ candidateId: "candidate", goldenId: golden[0].goldenId, verdict: "match" }] };
  const isNative = (f) => f.config === config && f.repeat === 2 && evaluation.toolName === toolName;
  expect(readMartianEvaluation(evaluation, { findings, golden, isNative }).ours.findings).toEqual({ sent: 1, matched: 1 });
  expect(() => readMartianEvaluation(evaluation, { findings, golden, isNative: () => false })).toThrow(/without what it reads/);
});

it("a martian block edited by hand in score.json refuses the publish", async () => {
  const { folder } = await martianRun();
  const opts = options(folder);
  const first = await publishRun(folder, opts);
  const before = readFileSync(first.written, "utf8");
  const score = read(join(folder, "score.json"));
  score.outside.martian.perTool[tool].official.core.f1 = 0.123;
  write(join(folder, "score.json"), score);
  await expect(publishRun(folder, opts)).rejects.toThrow(/board numbers in score.json are not the ones its board output gives/);
  expect(readFileSync(first.written, "utf8")).toBe(before);
});

it("a martian core F1 that does not follow from its matches is refused", async () => {
  const { folder, evaluation } = await martianRun();
  for (const [field, wrong] of [["f1", 0.123], ["tp", 4], ["fp", 2], ["fn", 1]]) {
    const edited = structuredClone(evaluation);
    edited.totals.core[field] = wrong;
    write(boardPath(folder, "martian", `${tool}/evaluation.json`), edited);
    expect(() => readBlock(folder, "martian"), field).toThrow(/core.*(matches|candidates)/);
  }
});

it("an entry with a board key the registry does not know is invalid", async () => {
  const { folder } = await martianRun();
  const { entry } = await publishRun(folder, options(folder));
  expect(entryProblems(entry)).toEqual([]);
  expect(entryProblems({ ...entry, outside: { borrowed: entry.outside.martian } }).join("\n")).toMatch(/outside.borrowed.*registry/);
});

it("a board block without its evidence hash or tool identity is invalid", async () => {
  const { folder } = await martianRun();
  const { entry } = await publishRun(folder, options(folder));
  for (const field of ["config", "boardConfig"]) {
    const edited = structuredClone(entry);
    delete edited.outside.martian.perTool[tool][field];
    expect(entryProblems(edited).join("\n")).toContain(field);
  }
  const edited = structuredClone(entry);
  delete edited.outside.martian.evidenceHash;
  expect(entryProblems(edited).join("\n")).toContain("evidenceHash");
});

it("an input.json that differs from its first-attempt rebuild is refused", () => {
  const folder = greptileRun();
  const file = boardPath(folder, "greptile", "input.json");
  const input = read(file);
  input.cases[1].comments = ["Invented review"];
  write(file, input);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { readOutside } from "./benchmark/lib/outside-boards.mjs"; readOutside(process.argv[1], JSON.parse(process.argv[2]), {}, ["greptile"], JSON.parse(process.argv[3]));', folder, JSON.stringify(read(join(folder, "manifest.json")).jobs), JSON.stringify(boardOptions.get(folder))], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/^outside\.greptile is null: Greptile input\.json differs from the run's first attempt rebuild\n$/);
});

it("Greptile refuses a verdict that marks a not-run case caught", () => {
  const folder = greptileRun();
  const file = boardPath(folder, "greptile", `${tool}/verdicts.json`);
  const verdicts = read(file); verdicts[1].label = "caught"; write(file, verdicts);
  expect(() => greptileBlock(folder)).toThrow(/not-run|empty case/);
});

// Failure: a judge writes an em dash in a reason, the score and the index entry copy it, and the scrub fails the gate.
it("a judge reason with an em dash enters the block with a comma, so the index entry passes the scrub", () => {
  const folder = greptileRun();
  const file = boardPath(folder, "greptile", `${tool}/verdicts.json`);
  const verdicts = read(file); verdicts[0].reason = "Golden bug is a null check \u2014 none of the comments mention it"; write(file, verdicts);
  const label = greptileBlock(folder).perTool[tool].labels[0];
  expect(label.reason).toBe("Golden bug is a null check, none of the comments mention it");
  expect(JSON.stringify(greptileBlock(folder))).not.toContain("\u2014");
});

it("Greptile reads back the saved input when one tool plans both cases and another plans one", () => {
  const folder = greptileRun({ caseCount: 2 });
  const ctx = boardOptions.get(folder);
  const cases = readSuite("greptile", ctx).file.cases;
  const { jobs: allJobs } = planJobs({ cases: cases.map((c) => c.name), caseIds: Object.fromEntries(cases.map((c) => [c.name, c.id])), reviewers: ["claude"], graph: ["on"], repeat: 2 });
  const jobs = allJobs.filter((j) => j.repeat === 1 || j.caseId === cases[0].id);
  const manifest = read(join(folder, "manifest.json"));
  manifest.jobs = jobs;
  manifest.caseHashes = Object.fromEntries(cases.map((c) => [c.name, c.hash]));
  write(join(folder, "manifest.json"), manifest);
  for (const entry of cases) {
    const c = readCase(entry.id, ctx);
    write(join(folder, "cases", `${c.name}.json`), specCopy(c, truthOf(c, ctx)));
  }
  const rep = report({ findings: [finding()] });
  for (const job of jobs) {
    const dir = attemptDir(folder, job, 1);
    write(join(dir, "sample.json"), sampleRecord({ job, attempt: 1, result: { code: 0, wallMs: 1 }, report: rep, startedAt: "2026-10-24T00:00:00Z" }));
    write(join(dir, "report/report.json"), rep);
  }
  const input = greptileInput(folder, "greptile", ctx);
  write(boardPath(folder, "greptile", "input.json"), input);
  const evaluation = read(boardPath(folder, "greptile", "eval.json"));
  evaluation.manifestSha256 = input.manifestSha256;
  const expected = {};
  for (const t of input.tools) {
    const mine = input.cases.filter((c) => c.tool === t.tool);
    const caught = mine.filter((c) => c.status === "complete").length;
    const labels = mine.map((c) => ({ id: c.id, label: c.status === "not-run" ? "missed" : "caught", reason: c.status === "not-run" ? "not-run" : "judge" }));
    evaluation.perTool[t.tool] = { config: t.config, boardConfig: t.boardConfig, caught, missed: 2 - caught, of: 2, planned: caught, notRun: 2 - caught, rate: caught / 2 };
    write(boardPath(folder, "greptile", `${t.tool}/verdicts.json`), labels);
    expected[t.tool] = { ...evaluation.perTool[t.tool], labels };
  }
  write(boardPath(folder, "greptile", "eval.json"), evaluation);
  const copies = input.cases.filter((c) => c.caseId === cases[1].id);
  expect(copies.map((c) => c.status)).toEqual(["complete", "not-run"]);
  expect(Object.keys(copies[0].truthSets.greptile).sort()).toEqual(["file", "hash", "items", "kind", "sha256", "source"]);
  expect(Object.keys(copies[1].truthSets.greptile).sort()).toEqual(["items", "kind", "source"]);
  expect(greptileBlock(folder).perTool).toEqual(expected);
  expect(read(boardPath(folder, "greptile", "input.json"))).toEqual(input);
});

it("Greptile refuses an added key in not-run truth in one line", () => {
  const folder = greptileRun({ caseCount: 2 });
  const path = boardPath(folder, "greptile", "input.json");
  const input = read(path);
  const c = input.cases.find((c) => c.status === "not-run");
  c.truthSets.greptile.unexpected = true;
  write(path, input);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { readOutside } from "./benchmark/lib/outside-boards.mjs"; readOutside(process.argv[1], JSON.parse(process.argv[2]), {}, ["greptile"], JSON.parse(process.argv[3]));', folder, JSON.stringify(read(join(folder, "manifest.json")).jobs), JSON.stringify(boardOptions.get(folder))], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toBe(`outside.greptile is null: ${c.caseId}: greptile truth differs from the frozen suite\n`);
});

it("Greptile fixture truth uses the corrected title instead of the case name", () => {
  const ctx = boardSuiteFixture("greptile");
  const cases = readSuite("greptile", ctx).file.cases;
  expect(cases.map((c) => c.correctedTitle)).toEqual(readSuite("greptile").file.cases.map((c) => c.correctedTitle));
  expect(cases.every((c) => c.correctedTitle !== c.name)).toBe(true);
  const c = readCase(cases[0].id, ctx);
  expect(truthOf(c, ctx).sets.augment.items[0].text).toBe(`Fixture defect in ${c.name}.`);
});

it("the Greptile readback reads no pinned truth", () => {
  const folder = greptileRun({ caseCount: 2 });
  const saved = greptileBlock(folder);
  write(join(folder, "score.json"), { outside: { greptile: saved } });
  expect(saved.perTool[tool]).toMatchObject({ of: 2, planned: 1, notRun: 1 });
  const cache = tempDir("oq-greptile-readback-no-truth-");
  const before = process.env.OPENQODEX_BENCH_CACHE;
  process.env.OPENQODEX_BENCH_CACHE = cache;
  try {
    const block = readGreptileOutside(folder, read(join(folder, "manifest.json")).jobs, {}, { root: boardOptions.get(folder).root });
    expect(block).toEqual(read(join(folder, "score.json")).outside.greptile);
    expect(readdirSync(cache)).toEqual([]);
  } finally {
    if (before === undefined) delete process.env.OPENQODEX_BENCH_CACHE;
    else process.env.OPENQODEX_BENCH_CACHE = before;
  }
});

for (const name of ["greptile", "augment"]) for (const field of ["items", "hash", "file", "sha256", "source", "kind"]) it(`Greptile refuses not-run ${name} truth whose ${field} differs from the frozen suite`, () => {
  const folder = greptileRun({ caseCount: 2 });
  const path = boardPath(folder, "greptile", "input.json");
  const input = read(path);
  const set = input.cases.find((c) => c.status === "not-run").truthSets[name];
  if (field === "items") set.items[0].text += " Changed truth.";
  else if (field === "source") set.source.url += "/changed";
  else set[field] = "changed";
  write(path, input);
  expect(() => greptileBlock(folder)).toThrow(/truth.*frozen/);
});

it("Martian readback uses frozen hashes without reading pinned truth or logging held-out access", async () => {
  const accessLog = join(tempDir("oq-martian-readback-access-"), "heldout-access.jsonl");
  const { folder } = await martianRun({ accessLog });
  const logged = readFileSync(accessLog, "utf8");
  expect(logged.trim().split("\n")).toHaveLength(1);
  const cache = tempDir("oq-martian-readback-no-truth-");
  const before = process.env.OPENQODEX_BENCH_ACCESS_LOG;
  process.env.OPENQODEX_BENCH_ACCESS_LOG = accessLog;
  try {
    const run = loadRun(folder);
    const block = readMartianOutside(folder, scoreRun(run).jobs, run.specs, { ...boardOptions.get(folder), cache });
    expect(block).toEqual(read(join(folder, "score.json")).outside.martian);
    expect(readdirSync(cache)).toEqual([]);
    expect(readFileSync(accessLog, "utf8")).toBe(logged);
  } finally {
    if (before === undefined) delete process.env.OPENQODEX_BENCH_ACCESS_LOG;
    else process.env.OPENQODEX_BENCH_ACCESS_LOG = before;
  }
});

it("Martian refuses a changed golden comment in one line naming its case", async () => {
  const { folder, data } = await martianRun();
  const entry = Object.values(data)[0];
  entry.golden_comments[0].comment += " Changed truth.";
  write(boardPath(folder, "martian", "benchmark_data.json"), data);
  const result = martianRead(folder);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain(entry.openqodex.caseId);
  expect(result.stderr).toMatch(/golden comments.*frozen truth hash/);
});

it("Martian refuses an added review comment in benchmark_data.json", async () => {
  const { folder, data } = await martianRun();
  Object.values(data)[0].reviews[0].review_comments.push({ body: "Invented review" });
  write(boardPath(folder, "martian", "benchmark_data.json"), data);
  expect(() => readBlock(folder, "martian")).toThrow(/benchmark_data.json.*conversion/);
});

it("a greptile eval.json whose summary differs from its verdicts is refused", () => {
  const folder = greptileRun();
  const block = greptileBlock(folder);
  expect(block.perTool[tool]).toMatchObject({ caught: 1, rate: 1 / readSuite("greptile").file.cases.length });
  const file = boardPath(folder, "greptile", "eval.json");
  const evaluation = read(file);
  evaluation.perTool[tool].caught++;
  write(file, evaluation);
  expect(() => greptileBlock(folder)).toThrow(/summary.*verdicts/);
});

it("board output of another run (manifest hash) is refused", async () => {
  for (const [board, folder] of [["martian", (await martianRun()).folder], ["greptile", greptileRun()]]) {
    const path = join(folder, "manifest.json");
    write(path, { ...read(path), runId: "another-run" });
    expect(() => BOARDS[board](folder, [], {})).toThrow(/manifest.*(hash|sha256)/);
  }
});

it("a control evaluation reads through the native source without four sentences", async () => {
  const caseId = "martian/native@aaaaaaaa";
  const config = "control-graph-off";
  const body = 'Native review: [{"summary":"The loop reads past the array."}]';
  const review = boardReview({ caseId, config, repeat: 1, first: { row: { reviewer: "control", status: "complete", nativeBody: body }, report: null } });
  const findings = [{ findingId: review.findingIds[0], caseId, config, repeat: 1, index: 0, severity: null, source: "native", text: body }];
  const totals = { precision: 1, recall: 1, f1: 1, fbeta: 1, tp: 1, fp: 0, fn: 0, prs: 1 };
  const evaluation = { version: 1, toolName: "claude-code-control-r1", judge: { model: judgeModel }, totals: { beta: 2, strict: totals, core: totals, all: totals }, candidates: [{ candidateId: "candidate", prUrl: "fixture", extractedText: body, officialFp: false, sourceFindingIds: review.findingIds, extraction: {}, dedupGroup: 0 }], matches: [{ candidateId: "candidate", goldenId: `${caseId}#g1`, verdict: "match" }] };
  const golden = [{ goldenId: `${caseId}#g1`, caseId, rawCategory: "bug" }];
  const isNative = (f) => boardConfigOf(f.config) === "control" && boardToolName(f.config, f.repeat) === evaluation.toolName;
  expect(readMartianEvaluation(evaluation, { findings, golden, isNative }).ours.golden).toEqual({ found: 1, of: 1 });
  expect(() => readMartianEvaluation(evaluation, { findings: [{ ...findings[0], text: "Another body" }], golden, isNative })).toThrow(/native.*(id|source)/);
  expect(() => readMartianEvaluation(evaluation, { findings: [findings[0], findings[0]], golden, isNative })).toThrow(/one native source/);
  expect(() => readMartianEvaluation({ ...evaluation, toolName: tool }, { findings, golden })).toThrow(/without what it reads/);
  const { folder } = await martianRun({ native: body });
  expect(readBlock(folder, "martian").perTool["claude-code-control-r1"].ours.findings).toEqual({ sent: 3, matched: 3 });
});

it("Martian keeps the reasons every unreviewed case was sent empty", async () => {
  const { folder } = await martianRun({ native: "", empty: true });
  const t = readBlock(folder, "martian").perTool["claude-code-control-r1"];
  expect(t.official.core).toMatchObject({ tp: 0, fp: 0, fn: 5, prs: 3, f1: 0 });
  expect(t.ours.golden).toEqual({ found: 0, of: 5 });
  expect(t.empty.map((c) => c.reason).sort()).toEqual(["failed", "not-run", "unstarted"]);
  expect(t.empty.find((c) => c.reason === "failed").failure).toBe("No saved native review");
});

it("Martian core excludes style goldens from its true positive count", async () => {
  const { evaluation, data } = await martianRun();
  const findings = Object.values(data).flatMap((e) => martianFindings(e.openqodex.caseId, fixtureReport(e.openqodex.case)));
  const golden = Object.values(data).flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  golden[0].rawCategory = "style";
  evaluation.totals.core = { ...evaluation.totals.core, tp: 4, precision: 4 / 5, f1: 8 / 9, fbeta: 20 / 21 };
  expect(readMartianEvaluation(evaluation, { findings, golden }).official.core).toMatchObject({ tp: 4, fp: 1, fn: 0, f1: 8 / 9 });
});

it("Martian counts duplicate unmatched candidate text as one false positive", async () => {
  const { evaluation, data } = await martianRun();
  const findings = Object.values(data).flatMap((e) => martianFindings(e.openqodex.caseId, fixtureReport(e.openqodex.case)));
  const golden = Object.values(data).flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  const unmatched = evaluation.candidates.find((c) => c.extractedText.includes("Vague constant"));
  expect(unmatched).toBeDefined();
  evaluation.candidates.push({ ...unmatched, candidateId: `${unmatched.candidateId}-duplicate` });
  expect(readMartianEvaluation(evaluation, { findings, golden }).official.core.fp).toBe(1);
});

it("Martian refuses a candidate without the saved text its false positive count needs", async () => {
  const { evaluation, data } = await martianRun();
  const findings = Object.values(data).flatMap((e) => martianFindings(e.openqodex.caseId, fixtureReport(e.openqodex.case)));
  const golden = Object.values(data).flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  delete evaluation.candidates[0].extractedText;
  expect(() => readMartianEvaluation(evaluation, { findings, golden })).toThrow(/candidate.*text/);
});

it("the published asset keeps the board files and leaves the Martian work folder out", async () => {
  const { folder } = await martianRun();
  const kept = ["outside/martian/convert.json", "outside/martian/eval.json", "outside/martian/benchmark_data.json", `outside/martian/${tool}/evaluation.json`, "outside/greptile/input.json", "outside/greptile/eval.json", `outside/greptile/${tool}/verdicts.json`];
  for (const path of kept.filter((p) => p.startsWith("outside/greptile/"))) write(join(folder, path), { saved: true });
  const left = ["outside/martian/work/results/evaluations.json", "outside/greptile.pending-2026-10-24/input.json", "outside/greptile.pending-2026-10-24/eval.json", `outside/greptile.pending-2026-10-24/${tool}/verdicts.json`, "outside/greptile.superseded-2026-10-24/input.json", "outside/greptile.superseded-2026-10-24/eval.json", `outside/greptile.superseded-2026-10-24/${tool}/verdicts.json`];
  for (const path of left) write(join(folder, path), { path: join(homedir(), "private") });
  const asset = await packageRun(folder, options(folder));
  const back = extractAsset(asset.tarPath, asset, tempDir("oq-outside-back-"), asset.runId);
  boardOptions.set(back, boardOptions.get(folder));
  for (const path of kept) expect(readFileSync(join(back, path))).toEqual(readFileSync(join(folder, path)));
  for (const path of left) expect(asset.left).toContain(path);
  expect(read(join(folder, "score.json")).outside.martian.evidenceHash).toBe(hashFolder(back, kept.filter((p) => p.startsWith("outside/martian/"))).listHash);
  expect(readBlock(back, "martian")).toEqual(read(join(folder, "score.json")).outside.martian);
});

it("the publisher still inspects packaged board input for private paths", async () => {
  const { folder } = await martianRun();
  // This machine's home folder is rewritten to a placeholder at publish; another machine's is a hit.
  write(boardPath(folder, "greptile", "input.json"), { path: "/home/someone/private" });
  await expect(packageRun(folder, options(folder))).rejects.toThrow(/hit.*files to publish/);
});

it("Greptile labels remain readable after packaging without the source run", async () => {
  const folder = greptileRun();
  const block = greptileBlock(folder);
  const asset = await packageRun(folder, options(folder));
  const back = extractAsset(asset.tarPath, asset, tempDir("oq-outside-back-"), asset.runId);
  boardOptions.set(back, boardOptions.get(folder));
  expect(greptileBlock(back)).toEqual(block);
  expect(block.evidenceHash).toBe(hashFolder(back, ["outside/greptile/input.json", "outside/greptile/eval.json", `outside/greptile/${tool}/verdicts.json`]).listHash);
});

it("Martian refuses a conversion commit or evaluation judge that differs from its pin", async () => {
  const { folder } = await martianRun();
  for (const [file, edit] of [["convert.json", (v) => { v.commit = "0".repeat(40); }], ["eval.json", (v) => { v.judge.deployment = "wrong"; }], [`${tool}/evaluation.json`, (v) => { v.judge.model = "wrong"; }]]) {
    const path = boardPath(folder, "martian", file);
    const original = read(path);
    const changed = structuredClone(original);
    edit(changed);
    write(path, changed);
    expect(() => readBlock(folder, "martian")).toThrow(/pins|boards.json/);
    write(path, original);
  }
});

it("a held Greptile tool keeps its hold without a verdict file", () => {
  const held = greptileBlock(greptileRun({ held: true })).perTool[tool];
  expect(held).toMatchObject({ caught: null, missed: null, rate: null, held: [{ lacking: ["fix"] }] });
});

it("an empty Greptile tool needs no judge model", () => {
  const empty = greptileBlock(greptileRun({ comments: false })).perTool[tool];
  expect(empty).toMatchObject({ caught: 0, rate: 0 });
});

it("a Greptile tool with comments cannot lose its judge model", () => {
  const folder = greptileRun();
  const file = boardPath(folder, "greptile", "eval.json");
  write(file, { ...read(file), judgeModel: null });
  expect(() => greptileBlock(folder)).toThrow(/judge model/);
});

it("Greptile refuses a shortened suite and changed board pins", () => {
  for (const field of ["commit", "promptHash", "judgeModel", "of"]) {
    const folder = greptileRun();
    const file = boardPath(folder, "greptile", "eval.json");
    const edited = read(file);
    if (field === "commit") edited.board.commit = "0".repeat(40);
    else if (field === "of") edited.perTool[tool].of--;
    else edited[field] = "wrong";
    write(file, edited);
    expect(() => greptileBlock(folder), field).toThrow();
  }
});

it("repeated outside flags and all preserve every requested board during an in-place refresh", async () => {
  const { folder } = await martianRun();
  const before = read(join(folder, "score.json"));
  before.marker = "keep the reviewed score";
  write(join(folder, "score.json"), before);
  const root = join(tempDir("oq-outside-score-cli-"), "benchmark");
  const fixtureOptions = boardOptions.get(folder);
  for (const file of ["score.mjs", "lib", "legacy", "outside/boards.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(benchRoot, file), join(root, file), { recursive: true });
  }
  for (const file of ["suites", "splits"]) cpSync(join(fixtureOptions.root, file), join(root, file), { recursive: true });
  mkdirSync(join(root, "../packages"), { recursive: true });
  symlinkSync(join(benchRoot, "../packages/scanners"), join(root, "../packages/scanners"));
  const script = join(root, "score.mjs");
  for (const flags of [["--outside", "martian,aacr", "--outside", "greptile"], ["--outside", "all"]]) {
    const result = spawnSync(process.execPath, [script, folder, ...flags], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: fixtureOptions.cache } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim().split("\n")).toHaveLength(2);
    const after = read(join(folder, "score.json"));
    expect(Object.keys(after.outside).sort()).toEqual(Object.keys(BOARDS).sort());
    expect(after.outside.martian).toEqual(before.outside.martian);
    expect(after.outside.aacr).toBeNull();
    expect(after.outside.greptile).toBeNull();
    delete after.outside;
    const { outside: _outside, ...rest } = before;
    expect(after).toEqual(rest);
    expect(result.stdout).toContain("Martian");
  }
});
