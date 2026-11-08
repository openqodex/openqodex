// Failures guarded: suite cases dropped from the denominator, incomplete
// findings lost, native bodies split, held tools partly judged, truth pins
// ignored, empty reviews sent to the model, and an unbounded priced run.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { comparisonHash } from "../lib/comparison.mjs";
import { hash } from "../lib/calibration.mjs";
import { attemptDir, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { rawPath, readCase, readSuite, specCopy, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { convertOpts, finding, fixturePlan, savedRun as martianRun, suite as martianSuite } from "./martian-board-fixture.mjs";
import { main as judgeMartian } from "../outside/boards/martian-judge.mjs";
import { convertRun } from "../outside/convert/martian.mjs";

afterAll(removeTempDirs);
const suite = readSuite("greptile");
const cases = suite.file.cases.map((e) => readCase(e.id));
const cache = cacheRoot();
const hasTruth = cases.every((c) => Object.values(c.truthSets).every((set) => existsSync(rawPath(cache, "greptile", { path: set.file }))));
const needsTruth = " (needs pinned Greptile truth in the bench cache; skipped without it)";
const test = (name, fn) => it.skipIf(!hasTruth)(name + needsTruth, fn);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const tool = "openqodex-library-r1";
const fixtureBuild = read(join(benchRoot, "index/comparisons/compare-2026-10.json")).build;
const fixtureReviewers = {
  library: { path: "server", reviewer: "model:scripted", model: "scripted", version: "fixture", graph: "on", web: "off", effort: "high", maxOutputTokens: 32000 },
  control: { path: "laptop", reviewer: "control", model: "claude-opus-5-5", version: "fixture", graph: "off", web: "off", effort: null, maxOutputTokens: null },
};
const boardPath = (folder, file) => join(folder, "outside/greptile", file);
const report = (findings = [], status = "complete", extra = {}) => ({ completion: { status }, findings, outside_change: [], ...extra });

function savedRun({ planned = cases.slice(0, 2), reviewers = ["model:scripted"], reports = [report([finding()]), report()], native = null } = {}) {
  const folder = tempDir("oq-greptile-board-");
  const { jobs, configs } = planJobs({ cases: planned.map((c) => c.name), caseIds: Object.fromEntries(planned.map((c) => [c.name, c.id])), reviewers, graph: native === null ? ["on"] : ["off"], repeat: 1 });
  const pins = Object.values(fixtureReviewers).filter((r) => reviewers.includes(r.reviewer));
  const settings = { path: pins[0].path, web: pins[0].web, build: { ...fixtureBuild, cliVersion: fixtureBuild.version }, reviewers: Object.fromEntries(pins.map((r) => [r.reviewer, { model: r.model, version: r.version, settings: { effort: r.effort, maxOutputTokens: r.maxOutputTokens } }])), runId: "greptile-board-test", mode: "review", suite: "greptile", split: "dev", splitHash: suite.splitHash, cases: planned.map((c) => c.name), caseIds: planned.map((c) => c.id), caseHashes: Object.fromEntries(planned.map((c) => [c.name, c.hash])), configs, repeat: 1 };
  write(join(folder, "manifest.json"), runManifest({ startedAt: "2026-10-24T00:00:00Z", settings, jobs }));
  for (const c of planned) write(join(folder, "cases", `${c.name}.json`), specCopy(c, truthOf(c, { cache })));
  for (const job of jobs) {
    const index = planned.findIndex((c) => c.id === job.caseId);
    const rep = reports[index];
    if (rep === "unstarted") continue;
    const dir = attemptDir(folder, job, 1);
    const row = sampleRecord({ job, attempt: 1, result: { code: rep === null ? 1 : 0, wallMs: 1 }, report: rep, startedAt: "2026-10-24T00:00:00Z" });
    write(join(dir, "sample.json"), native === null ? row : { ...row, reviewer: "control", status: "complete", nativeBody: native });
    if (native === null && rep !== null) write(join(dir, "report/report.json"), rep);
  }
  return folder;
}

// A scripted model provider is the only stand-in. The CLI starts its real
// uncached relay, whose connection probe is counted apart from judge calls.
async function provider({ fail = false } = {}) {
  const seen = [];
  const calls = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const request = JSON.parse(text);
      calls.push(request);
      const probe = request.messages?.at(-1)?.content === "Reply yes.";
      if (!probe) seen.push(request);
      if (!probe && fail) { res.writeHead(400); res.end("scripted provider failure"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-5.2", choices: [{ message: { content: probe ? "yes" : JSON.stringify({ match: true, reasoning: "Scripted match." }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const envFile = join(tempDir("oq-greptile-provider-"), "model.env");
  writeFileSync(envFile, `AZURE_OPENAI_BASE_URL=http://127.0.0.1:${server.address().port}/v1\nAZURE_OPENAI_KEY=scripted-provider-key\n`);
  return { seen, calls, envFile, close: () => new Promise((resolve) => server.close(resolve)) };
}

function recordFixture() {
  const root = tempDir("oq-greptile-record-");
  for (const file of ["outside/boards.json", "suites/greptile/cases.json", "splits/greptile-v1.json", "review-queue/people.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(benchRoot, file), join(root, file));
  }
  const record = read(join(benchRoot, "index/comparisons/compare-2026-10.json"));
  record.release = "fixture-release";
  record.reviewers = structuredClone(fixtureReviewers);
  record.runs = [];
  record.boards = { greptile: record.boards.greptile };
  record.suites = { greptile: record.suites.greptile };
  record.calibrationRulings = record.calibrationRulings.filter((r) => r.board === "greptile");
  const ref = record.calibrations.find((c) => read(join(benchRoot, c.file)).board.name === "greptile");
  const calibration = read(join(benchRoot, ref.file));
  calibration.costUsd = 0.5;
  ref.file = "index/calibration/fixture-calibration.json";
  write(join(root, ref.file), calibration);
  ref.sha256 = hash(readFileSync(join(root, ref.file)));
  record.calibrations = [ref];
  // The fixture signs its own copy, so the live record's signature state never decides these tests.
  record.acceptance = { person: read(join(root, "review-queue/people.json")).people[0], date: "2026-10-24", hash: "" };
  record.acceptance.hash = comparisonHash(record);
  write(join(root, "index/comparisons", `${record.release}.json`), record);
  return { root, record, calibration };
}

async function cli(folder, args = [], model = null, { root = null, record = null, release = "compare-2026-10" } = {}) {
  return new Promise((resolve, reject) => {
    const script = join(benchRoot, "outside/boards/greptile-run.mjs");
    const argv = [folder, ...(release === null ? [] : ["--release", release]), ...args];
    const module = JSON.stringify(pathToFileURL(script).href);
    const call = record ? `judgeRun(${JSON.stringify({ folder, dryRun: false, force: false, maxUsd: 1 })}, ${JSON.stringify(record)}, { root: ${JSON.stringify(root)} })` : `main(${JSON.stringify(argv)}, { root: ${JSON.stringify(root)} })`;
    const invocation = record || root ? ["--input-type=module", "--eval", `import { ${record ? "judgeRun" : "main"} } from ${module}; ${call}.catch((e) => { console.error(e.message.replaceAll("\\n", " ")); process.exitCode = 2; });`] : [script, ...argv];
    const child = spawn(process.execPath, invocation, { env: { ...process.env, ...(model ? { OPENQODEX_BENCH_MODEL_ENV: model.envFile } : { OPENQODEX_BENCH_MODEL_ENV: join(folder, "must-not-read-model.env") }) } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a case the run never reviewed is counted missed, not dropped", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code, result.stderr).toBe(0);
    const input = read(boardPath(folder, "input.json"));
    expect(input.suite).toEqual({ name: "greptile", cases: cases.map((c) => c.id) });
    expect(input.cases).toHaveLength(cases.length);
    expect(input.cases[2]).toMatchObject({ caseId: cases[2].id, comments: [], status: "not-run", truthSets: truthOf(cases[2], { cache }).sets });
    expect(read(boardPath(folder, "eval.json")).perTool[tool]).toMatchObject({ caught: 1, missed: cases.length - 1, of: cases.length, planned: 2, notRun: cases.length - 2, rate: 1 / cases.length });
    const verdicts = read(boardPath(folder, `${tool}/verdicts.json`));
    expect(verdicts.map((v) => v.id)).toEqual(cases.map((c) => c.id));
    expect(verdicts[2]).toEqual({ id: cases[2].id, label: "missed", reason: "not-run" });
  } finally { await model.close(); }

  const ctx = await martianSuite();
  const partial = { ...ctx, ids: new Map([...ctx.ids].slice(0, 2)) };
  const { data, record } = await convertRun(await martianRun(partial, { plan: fixturePlan() }), convertOpts(ctx));
  expect(Object.keys(data)).toHaveLength(ctx.ids.size);
  expect(record.notRun).toEqual([{ tool, caseId: [...ctx.ids.values()][2] }]);
  const missing = Object.values(data).find((entry) => entry.openqodex.caseId === [...ctx.ids.values()][2]);
  expect(missing.reviews[0]).toMatchObject({ review_comments: [], openqodex: { status: "not-run" } });
});

test("an incomplete review sends what the developer was shown, as Martian does", async () => {
  const fixture = recordFixture();
  const f = finding();
  const observation = finding({ title: "An observation", line_number: null });
  const folder = savedRun({ reports: [report([f], "incomplete", { observations: [observation] }), report()] });
  const manifest = read(join(folder, "manifest.json"));
  const config = manifest.configs[0].id;
  const retry = attemptDir(folder, { case: cases[0].name, config, repeat: 1 }, 2);
  write(join(retry, "sample.json"), { case: cases[0].name, config, repeat: 1, attempt: 2 });
  write(join(retry, "report/report.json"), report([finding({ title: "Retry must not replace first" })]));
  const result = await cli(folder, ["--dry-run"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code, result.stderr).toBe(0);
  const first = read(boardPath(folder, "input.json")).cases[0];
  expect(first.status).toBe("incomplete");
  expect(first.comments).toEqual([
    "src/a.ts:10: Index read past the end. The loop reads one element past the array. It throws at run time. Fix: Stop the loop one element earlier.",
    "src/a.ts: An observation. The loop reads one element past the array. It throws at run time. Fix: Stop the loop one element earlier.",
  ]);
  expect(existsSync(boardPath(folder, "eval.json"))).toBe(false);
});

test("a control review becomes one comment and a finding without a fix sentence holds its tool name, not just the finding", async () => {
  const fixture = recordFixture();
  const body = "Native review.\n```json\n[{\"summary\":\"The loop overruns\"}]\n```";
  const native = savedRun({ reviewers: ["control"], native: body });
  expect((await cli(native, ["--dry-run"], null, { root: fixture.root, release: fixture.record.release })).code).toBe(0);
  expect(read(boardPath(native, "input.json")).cases[0]).toMatchObject({ tool: "claude-code-control-r1", comments: [body] });
  const folder = savedRun({ reports: [report([finding({ fix: " " })]), report([finding()])] });
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Held, not sent: ${tool}`);
    expect(model.seen).toHaveLength(0);
    const evaluation = read(boardPath(folder, "eval.json"));
    expect(evaluation.perTool[tool]).toEqual({ config: "model-scripted-graph-on", boardConfig: "library", held: [{ case: cases[0].name, index: 0, lacking: ["fix"] }], caught: null, missed: null, of: cases.length, planned: 2, notRun: cases.length - 2, rate: null });
    expect(evaluation).toMatchObject({ judgeModel: null, relay: null });
    expect(read(boardPath(folder, "input.json")).tools).toContainEqual({ tool, config: "model-scripted-graph-on", boardConfig: "library", held: [{ case: cases[0].name, index: 0, lacking: ["fix"] }] });
    expect(existsSync(boardPath(folder, `${tool}/verdicts.json`))).toBe(false);
  } finally { await model.close(); }
});

test("the judge is sent the golden texts of the record's profile", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  fixture.record.boards.greptile.profile = "augment";
  const model = await provider();
  try {
    const result = await cli(folder, [], model, { ...fixture, release: fixture.record.release });
    expect(result.code, result.stderr).toBe(0);
    expect(model.seen).toHaveLength(1);
    const sent = JSON.parse(model.seen[0].messages.find((m) => m.role === "user").content);
    expect(sent.golden).toEqual(truthOf(cases[0], { cache }).sets.augment.items.map((g) => g.text));
    expect(sent.golden).not.toEqual(truthOf(cases[0], { cache }).sets.greptile.items.map((g) => g.text));
    expect(read(boardPath(folder, "eval.json")).truthSet).toBe("augment");
  } finally { await model.close(); }
});

it("an unknown record truth profile refuses in one line before any model call", async () => {
  const folder = tempDir("oq-greptile-truth-refusal-");
  const fixture = recordFixture();
  fixture.record.boards.greptile.profile = "unknown";
  const result = await cli(folder, [], null, { ...fixture, release: fixture.record.release });
  expect(result.code).toBe(2);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/profile unknown.*greptile or augment/);
  expect(existsSync(boardPath(folder, "input.json"))).toBe(false);
});

test("a case with no comment is missed without a model call", async () => {
  const folder = savedRun({ planned: cases.slice(0, 4), reports: [report([finding()]), null, "unstarted", report()] });
  const fixture = recordFixture();
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code, result.stderr).toBe(0);
    expect(model.seen).toHaveLength(1);
    expect(read(boardPath(folder, `${tool}/verdicts.json`)).slice(1, 4)).toEqual(cases.slice(1, 4).map((c, i) => ({ id: c.id, label: "missed", reason: ["failed", "unstarted", "empty"][i] })));
  } finally { await model.close(); }
});

test("a priced run requires a cap and refuses a forecast above it before contacting a provider", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  for (const [args, why] of [[[], /--max-usd.*required/], [["--max-usd", "0"], /forecast.*exceeds/]]) {
    const result = await cli(folder, args, null, { root: fixture.root, release: fixture.record.release });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(why);
    expect(existsSync(boardPath(folder, "eval.json"))).toBe(false);
  }
});

it("Martian refuses another comparison build before reading model settings or calling its pipeline", async () => {
  const fixture = recordFixture();
  const folder = tempDir("oq-martian-preflight-");
  const manifest = { release: fixture.record.release, package: { spec: "local" }, build: { ...fixtureBuild, commit: "d".repeat(40) }, reviewers: { "model:scripted": { model: "scripted", version: "fixture", settings: { effort: "high", maxOutputTokens: 32000 } } } };
  write(join(folder, "manifest.json"), manifest);
  write(join(folder, "outside/martian/convert.json"), { commit: read(join(benchRoot, "outside/boards.json")).boards.martian.commit, manifestSha256: hash(readFileSync(join(folder, "manifest.json"))) });
  await expect(judgeMartian([folder, "--checkout", folder, "--python", join(folder, "must-not-start")], { root: fixture.root })).rejects.toThrow(/build.*comparison/);
});

test("a run of another build is refused before any relay call", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  const manifest = read(join(folder, "manifest.json"));
  manifest.build.commit = "d".repeat(40); write(join(folder, "manifest.json"), manifest);
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/build.*comparison/);
    expect(model.calls).toHaveLength(0);
  } finally { await model.close(); }
});

test("a max-usd above the record cap is refused before any relay call", async () => {
  const folder = savedRun(); const fixture = recordFixture();
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", String(fixture.record.capUsd + 1)], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/--max-usd.*record cap/);
    expect(model.calls).toHaveLength(0);
  } finally { await model.close(); }
});

for (const field of ["path", "web", "graph"]) test(`a run whose ${field} setting differs from the pin is refused before any relay call`, async () => {
  const folder = savedRun(); const fixture = recordFixture();
  const pin = fixture.record.reviewers.library;
  pin[field] = field === "path" ? "laptop" : pin[field] === "on" ? "off" : "on";
  fixture.record.acceptance.hash = comparisonHash(fixture.record);
  write(join(fixture.root, "index/comparisons", `${fixture.record.release}.json`), fixture.record);
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(field);
    expect(model.calls).toHaveLength(0);
    expect(existsSync(boardPath(folder, "eval.json"))).toBe(false);
  } finally { await model.close(); }
});

for (const field of ["model", "version", "effort", "maxOutputTokens"]) test(`a run with another reviewer ${field} is refused before any relay call`, async () => {
  const folder = savedRun(); const fixture = recordFixture();
  const manifest = read(join(folder, "manifest.json"));
  const reviewer = manifest.reviewers["model:scripted"];
  if (["effort", "maxOutputTokens"].includes(field)) reviewer.settings[field] = field === "effort" ? "low" : 1;
  else reviewer[field] = "another-value";
  write(join(folder, "manifest.json"), manifest);
  const model = await provider();
  try {
    const result = await cli(folder, ["--max-usd", "1"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(field);
    expect(model.calls).toHaveLength(0);
  } finally { await model.close(); }
});

test("a failed priced forced run leaves the old evaluation active and keeps pending output", async () => {
  const folder = savedRun(); const fixture = recordFixture();
  write(boardPath(folder, "input.json"), { saved: "input" });
  write(boardPath(folder, "eval.json"), { saved: true });
  const model = await provider({ fail: true });
  try {
    const result = await cli(folder, ["--max-usd", "1", "--force"], model, { root: fixture.root, release: fixture.record.release });
    expect(result.code).toBe(2);
    expect(model.seen.length).toBeGreaterThan(0);
    expect(read(boardPath(folder, "eval.json"))).toEqual({ saved: true });
    expect(read(boardPath(folder, "input.json"))).toEqual({ saved: "input" });
    const pending = readdirSync(join(folder, "outside")).filter((name) => name.startsWith("greptile.pending-"));
    expect(pending).toHaveLength(1);
    expect(existsSync(join(folder, "outside", pending[0], "input.json"))).toBe(true);
    expect(readdirSync(join(folder, "outside")).some((name) => name.startsWith("greptile.superseded-"))).toBe(false);
  } finally { await model.close(); }
});

test("a dry run refuses a folder that holds a judged evaluation", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  write(boardPath(folder, "input.json"), { saved: "input" });
  write(boardPath(folder, "eval.json"), { saved: true });
  for (const args of [["--dry-run"], ["--dry-run", "--force"]]) {
    const refused = await cli(folder, args, null, { root: fixture.root, release: fixture.record.release });
    expect(refused.code).toBe(2);
    expect(refused.stderr.trim().split("\n")).toHaveLength(1);
    expect(refused.stderr).toMatch(/dry run|priced run/);
    expect(read(boardPath(folder, "input.json"))).toEqual({ saved: "input" });
    expect(read(boardPath(folder, "eval.json"))).toEqual({ saved: true });
    expect(readdirSync(join(folder, "outside"))).toEqual(["greptile"]);
  }

  const refused = await cli(savedRun(), ["--dry-run", "--force"], null, { root: fixture.root, release: fixture.record.release });
  expect(refused.code).toBe(2);
  expect(refused.stderr).toMatch(/--force.*priced run/);
});

test("a forced priced run moves the old evaluation aside after the checks pass and a refused forced run leaves it in place", async () => {
  const fixture = recordFixture();
  const refusals = [
    { args: [], why: /--max-usd.*required/ },
    { args: ["--max-usd", "0"], why: /forecast.*exceeds/ },
    { manifest: { suite: "martian" }, why: /suite martian/ },
    { manifest: { mode: "scan" }, why: /scanner-only/ },
    { manifest: { splitHash: "0".repeat(64) }, why: /split hash/ },
    { manifest: { caseHashes: { [cases[0].name]: "0".repeat(64) } }, why: /case hash.*suite/ },
    { change: (folder) => {
      const file = join(folder, "cases", `${cases[0].name}.json`);
      write(file, { ...read(file), hash: "0".repeat(64) });
    }, why: /saved case differs/ },
  ];
  for (const { args = ["--max-usd", "1"], manifest, change, why } of refusals) {
    const folder = savedRun();
    write(boardPath(folder, "input.json"), { saved: "input" });
    write(boardPath(folder, "eval.json"), { saved: true });
    write(boardPath(folder, `${tool}/verdicts.json`), [{ saved: "verdict" }]);
    if (manifest) write(join(folder, "manifest.json"), { ...read(join(folder, "manifest.json")), ...manifest });
    if (change) change(folder);
    const result = await cli(folder, [...args, "--force"], null, { root: fixture.root, release: fixture.record.release });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(why);
    expect(read(boardPath(folder, "input.json"))).toEqual({ saved: "input" });
    expect(read(boardPath(folder, "eval.json"))).toEqual({ saved: true });
    expect(read(boardPath(folder, `${tool}/verdicts.json`))).toEqual([{ saved: "verdict" }]);
    expect(readdirSync(join(folder, "outside"))).toEqual(["greptile"]);
  }

  const folder = savedRun({ reports: [report([finding({ fix: " " })]), report()] });
  write(boardPath(folder, "input.json"), { saved: "input" });
  write(boardPath(folder, "eval.json"), { saved: true });
  write(boardPath(folder, `${tool}/verdicts.json`), [{ id: cases[0].id, label: "caught" }]);
  write(boardPath(folder, "obsolete/nested.json"), { stale: true });
  const result = await cli(folder, ["--max-usd", "0", "--force"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code, result.stderr).toBe(0);
  const superseded = readdirSync(join(folder, "outside")).filter((name) => name !== "greptile");
  expect(superseded).toHaveLength(1);
  expect(superseded[0]).toMatch(/^greptile\.superseded-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  const old = join(folder, "outside", superseded[0]);
  expect(read(join(old, "input.json"))).toEqual({ saved: "input" });
  expect(read(join(old, "eval.json"))).toEqual({ saved: true });
  expect(read(join(old, tool, "verdicts.json"))).toEqual([{ id: cases[0].id, label: "caught" }]);
  expect(read(join(old, "obsolete/nested.json"))).toEqual({ stale: true });
  expect(existsSync(boardPath(folder, `${tool}/verdicts.json`))).toBe(false);
  expect(existsSync(boardPath(folder, "obsolete"))).toBe(false);
  expect(read(boardPath(folder, "eval.json")).perTool[tool].caught).toBeNull();
});

test("an entirely empty run records no served model or relay counts", async () => {
  const folder = savedRun({ reports: [report(), report()] });
  const fixture = recordFixture();
  const result = await cli(folder, ["--max-usd", "0"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code, result.stderr).toBe(0);
  expect(read(boardPath(folder, "eval.json"))).toMatchObject({ judgeModel: null, relay: null, perTool: { [tool]: { caught: 0, missed: cases.length } } });
});

test("a finding without a path sends only its body even when it has a line", async () => {
  const folder = savedRun({ reports: [report([finding({ file_path: null }), finding({ file_path: "", line_number: null }), finding({ line_number: null })]), report()] });
  const fixture = recordFixture();
  const result = await cli(folder, ["--dry-run"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code, result.stderr).toBe(0);
  const body = "Index read past the end. The loop reads one element past the array. It throws at run time. Fix: Stop the loop one element earlier.";
  expect(read(boardPath(folder, "input.json")).cases[0].comments).toEqual([body, body, `src/a.ts: ${body}`]);
});

test("the forecast charges each judged case once even when it has several comments", async () => {
  const folder = savedRun({ reports: [report([finding(), finding({ line_number: 20 })]), report([finding()])] });
  const fixture = recordFixture();
  const unit = fixture.calibration.costUsd / fixture.calibration.counts.total;
  const result = await cli(folder, ["--dry-run"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Forecast: USD ${(2 * unit).toFixed(6)} for 2 judged cases at USD ${unit.toFixed(8)} per case from calibration.`);
});

it("the script requires a release name instead of selecting a comparison itself", async () => {
  const fixture = recordFixture();
  const result = await cli(tempDir("oq-greptile-no-release-"), ["--dry-run"], null, { root: fixture.root, release: null });
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/--release.*required/);
});

it("the script rejects the removed truth-set flag", async () => {
  const fixture = recordFixture();
  const result = await cli(tempDir("oq-greptile-old-flag-"), ["--truth-set", "augment"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/unknown.*--truth-set/);
});

it("the Martian converter refuses a planned case outside the frozen suite", async () => {
  const ctx = await martianSuite();
  const folder = await martianRun(ctx, { plan: fixturePlan() });
  const manifest = read(join(folder, "manifest.json"));
  manifest.jobs[0].caseId = "martian/not-in-suite@12345678";
  write(join(folder, "manifest.json"), manifest);
  await expect(convertRun(folder, convertOpts(ctx))).rejects.toThrow(/not-in-suite.*not in.*suite/);
});

test("the Greptile converter refuses a planned case outside the frozen suite in one line", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  const manifest = read(join(folder, "manifest.json"));
  manifest.jobs[0].caseId = "greptile/not-in-suite@12345678";
  write(join(folder, "manifest.json"), manifest);
  const result = await cli(folder, ["--dry-run"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code).toBe(2);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toMatch(/not converted for Greptile's board:.*not-in-suite.*not in.*suite/);
});

test("a changed planned case hash refuses conversion before writing input", async () => {
  const folder = savedRun();
  const fixture = recordFixture();
  const manifest = read(join(folder, "manifest.json"));
  manifest.caseHashes[cases[0].name] = "0".repeat(64);
  write(join(folder, "manifest.json"), manifest);
  const result = await cli(folder, ["--dry-run"], null, { root: fixture.root, release: fixture.record.release });
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/case hash.*suite/);
  expect(existsSync(boardPath(folder, "input.json"))).toBe(false);
});
