// The server path of the benchmark (benchmark/lib/server-review.mjs): one
// review of a materialised case through the library's server profile, the
// way a host runs it, saved as a sample the scorer reads; the scripted model
// (benchmark/lib/scripted-model.mjs); and the rule that names which models
// run.mjs may review with.
//
// The model provider is the only stand-in: the scripted model answers from
// its script, with no network. The library is the built package
// (packages/cli/dist/lib.js, the bundle a run's provenance covers), and git,
// the graph, the budget ledger and the scorer are the real ones. Scanners
// are read from an empty install root, so none runs: a review here proves
// the driver, not the scanners.
//
// Failures guarded, written before the code:
// 1. A server review writes outside its workDir: into the clone, the
//    results folder, HOME, TMPDIR or the OpenQodex home, or leaves its
//    workDir behind.
// 2. An incomplete server review is scored as complete.
// 3. The model recorded is not the one that answered: the sample names the
//    model asked for, or a model when the provider named none.
// 4. A model id that boards.json neither records as probed nor maps as an
//    alias is reviewed with.
// From the review of the first version:
// 5. The endpoint's key or address, in a provider's answer, reaches a saved
//    file, rows.jsonl or stdout before the run's check of the saved files.
// 6. The manifest names the model the run asked for, while the samples name
//    the one that answered, so the score and the index see a model that
//    never answered; and a run goes on when a later review is served by
//    another model.
// 7. A resume reaches another endpoint than the run's, because the settings
//    file now names another base URL for the same deployment.
// From issue 142:
// 8. A model review scores with no cost and no tokens, because the scorer
//    reads only the laptop's completion record, so the score, the index and
//    the forecast never see what a server run spent.
// 9. Staged answers lose a script finding through missing hunk analysis or
//    invalid evidence, or verify the wrong candidate. Check the saved
//    finding and the find/verify protocol fields, including scanner refutations.
// 10. A non-null reply stops being the answer in a staged or correction call.
// 11. A transport failure is final, two failures of one job do not halt,
//     a killed run loses its pending retry, or repeated resumes retry again.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchRoot, git, readLock, repoRoot } from "../lib/cases.mjs";
import { readLedger, runBudget } from "../lib/budget.mjs";
import { loadModelEnv } from "../lib/model-env.mjs";
import { attemptDir, executeRun, jobState, planJobs, resumeProblems, runManifest } from "../lib/runner.mjs";
import { newWave, settle } from "../lib/wave.mjs";
import { materialise } from "../lib/suites.mjs";
import { createModelReviewer, LEAK_REFUSED, recordServed, resolveModelReviewer, serverAttempt } from "../lib/server-review.mjs";
import { createScriptedReviewer, SCRIPTED_PRICES } from "../lib/scripted-model.mjs";
import { loadRun, renderV3, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const LIB = join(repoRoot, "packages/cli/dist/lib.js");
const { reviewChange } = await import(pathToFileURL(LIB).href);
const CASE = "flask-path-traversal";
const CASE_ID = `planted/${CASE}@${readLock().cases[CASE].hash.slice(0, 8)}`;
const CAPS = { maxUsd: 1, reviewMaxUsd: 0.5 };

// A script for the scripted model; every field is the script's own.
const script = (more = {}) => ({ version: 1, model: "scripted", served: "scripted-1", prices: { input: 0, cachedInput: 0, output: 0 }, summary: "Adds a download route.", findings: [], dropReason: "The candidate is not reachable from a request.", reply: null, ...more });
const pathFinding = { severity: "critical", category: "security", confidence: 1, file_path: "files/app.py", line_number: 17, title: "Download path traversal", problem: "The request name is joined to the upload folder without checking the resolved path.", consequence: "A caller can read files outside the upload folder.", fix: "Resolve the path and reject paths outside the upload folder.", source: null };

// The flask case in the server shape: the base and the change as two commits.
function serverRepo(root) {
  return materialise({ name: CASE, materialise: { kind: "folders" } }, join(root, "repo"), { shape: "server" });
}

// Every file under a folder, with its sha256, the .git folder left out.
function tree(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = relative(dir, join(e.parentPath, e.name));
    if (path === ".git" || path.startsWith(".git/")) continue;
    out[path] = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
  }
  return out;
}

const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort() : []);

// One server review of the flask case as run.mjs runs it: a run folder with
// its manifest, the spec copy and the budget ledger, and one job per repeat
// whose attempt is the driver's. Returns the run folder, the first job's
// sample and every job's sample.
async function oneRun(root, reviewer, { prices = { [reviewer.model]: SCRIPTED_PRICES }, appearsIn = null, repeat = 1 } = {}) {
  const out = join(root, "run");
  const repo = serverRepo(root);
  const workRoot = join(root, "w");
  mkdirSync(workRoot);
  const installRoot = join(root, "tools");
  mkdirSync(installRoot);
  const name = "model:scripted";
  const { configs, jobs } = planJobs({ cases: [CASE], caseIds: { [CASE]: CASE_ID }, reviewers: [name], graph: ["on"], repeat });
  const settings = { runId: "server-test", mode: "review", path: "server", suite: "planted", split: "dev", reviewers: { [name]: { name, kind: "model", model: reviewer.model } }, cases: [CASE], caseIds: [CASE_ID], configs: configs.map((c) => c.id), repeat, concurrency: 1 };
  const saved = [];
  await executeRun({
    out,
    manifest: runManifest({ startedAt: new Date().toISOString(), settings, jobs }),
    copies: [[join(benchRoot, "cases", CASE, "case.json"), join("cases", `${CASE}.json`)]],
    jobs,
    budget: runBudget({ dir: out, caps: CAPS, path: "server", prices }),
    runJob: async (job, k, meter) => {
      saved.push(await serverAttempt({ reviewChange, job, attempt: k, out, repo, reviewer, meter, deadlineMs: 120_000, workRoot, installRoot, appearsIn }));
    },
  });
  return { out, repo, workRoot, sample: saved[0] ?? null, samples: saved, job: jobs[0] };
}

describe("a server review writes outside its workDir", () => {
  it("leaves the clone, HOME, TMPDIR and the OpenQodex home as they were, saves only the sample's files and removes its workDir", { timeout: 180_000 }, () => {
    const root = tempDir("oq-server-out-");
    const repo = serverRepo(root);
    const sandbox = Object.fromEntries(["home", "tmp", "oqhome", "work"].map((k) => [k, join(root, "sandbox", k)]));
    for (const dir of Object.values(sandbox)) mkdirSync(dir, { recursive: true });
    mkdirSync(join(sandbox.oqhome, "tools"));
    const before = { files: tree(repo.dir), head: git(repo.dir, "rev-parse", "HEAD").trim(), refs: git(repo.dir, "for-each-ref").trim() };
    const out = join(root, "run");
    // The driver in a process of its own, whose HOME, TMPDIR and OpenQodex
    // home are empty folders this test reads afterwards.
    const code = `
      import { reviewChange } from ${JSON.stringify(pathToFileURL(LIB).href)};
      import { runBudget } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/budget.mjs")).href)};
      import { planJobs } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/runner.mjs")).href)};
      import { serverAttempt } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/server-review.mjs")).href)};
      import { createScriptedReviewer, SCRIPTED_PRICES } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/scripted-model.mjs")).href)};
      const a = JSON.parse(process.env.OQ_TEST_ARGS);
      const reviewer = createScriptedReviewer(a.script);
      const { jobs } = planJobs({ cases: [a.case], caseIds: { [a.case]: a.caseId }, reviewers: ["model:scripted"], graph: ["on"], repeat: 1 });
      const budget = runBudget({ dir: a.out, caps: a.caps, path: "server", prices: { scripted: SCRIPTED_PRICES } });
      const ticket = budget.admit(jobs[0]);
      // Whether the library's own result carried the scan record, read as it
      // returns, so the test knows whether the sample should hold scan.json.
      let scanned = null;
      const observed = async (...args) => {
        const result = await reviewChange(...args);
        scanned = result.scan !== undefined && result.scan !== null;
        return result;
      };
      const { record } = await serverAttempt({ reviewChange: observed, job: jobs[0], attempt: 1, out: a.out, repo: a.repo, reviewer, meter: ticket.review, deadlineMs: 120000, workRoot: a.workRoot, installRoot: a.installRoot });
      ticket.review.close();
      process.stdout.write(JSON.stringify({ record, scanned }));
    `;
    const env = { ...process.env, HOME: sandbox.home, TMPDIR: sandbox.tmp, OPENQODEX_HOME: sandbox.oqhome, OQ_TEST_ARGS: JSON.stringify({ script: script(), case: CASE, caseId: CASE_ID, out, caps: CAPS, repo, workRoot: sandbox.work, installRoot: join(sandbox.oqhome, "tools") }) };
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", cwd: root, maxBuffer: 64 * 1024 * 1024 });
    expect(p.status, p.stderr).toBe(0);
    const { record, scanned } = JSON.parse(p.stdout);
    expect(typeof scanned).toBe("boolean");
    expect(record.status).toBe("complete");
    expect(record.outside).toEqual([]);
    // The clone: the same files, the same head, the same refs.
    expect(tree(repo.dir)).toEqual(before.files);
    expect(git(repo.dir, "rev-parse", "HEAD").trim()).toBe(before.head);
    expect(git(repo.dir, "for-each-ref").trim()).toBe(before.refs);
    expect(git(repo.dir, "status", "--porcelain", "--ignored", "-uall").trim()).toBe("");
    // Nothing in HOME, TMPDIR or the OpenQodex home, and the workDir gone.
    expect(filesUnder(sandbox.home)).toEqual([]);
    expect(filesUnder(sandbox.tmp).filter((f) => !f.startsWith("node-compile-cache"))).toEqual([]);
    expect(filesUnder(sandbox.oqhome)).toEqual([]);
    expect(readdirSync(sandbox.work)).toEqual([]);
    // The results folder holds the sample's own files and the run's ledger,
    // and none of the reviewed code.
    const sampleDir = join("samples", CASE, "model-scripted-graph-on", "1");
    // report/scan.json is the library's scan record, which its result
    // carries since PR 135 (ReviewResult.scan) and the scorer reads to judge
    // who found each issue: the sample holds it exactly when the result does.
    const own = ["completion.json", "dispositions.json", "progress.txt", "report/report.json", "report/report.md", ...(scanned ? ["report/scan.json"] : []), "rounds.json", "sample.json", "usage.json"];
    expect(filesUnder(out)).toEqual(["budget.jsonl", ...own.map((f) => join(sampleDir, f))].sort());
    const app = readFileSync(join(repo.dir, "files", "app.py"), "utf8");
    for (const f of filesUnder(out)) expect(readFileSync(join(out, f), "utf8")).not.toContain(app.trim().split("\n").slice(0, 6).join("\n"));
  });

  it("refuses a work root inside the clone or the results folder before any review", async () => {
    const root = tempDir("oq-server-root-");
    const repo = serverRepo(root);
    const out = join(root, "run");
    const meter = { authorize: async () => true, wrap: (r) => r };
    const job = { jobId: `${CASE_ID}/model-scripted-graph-on/1`, caseId: CASE_ID, case: CASE, config: "model-scripted-graph-on", reviewer: "model:scripted", graph: true, repeat: 1 };
    const reviewer = createScriptedReviewer(script());
    let calls = 0;
    const counted = { ...reviewer, complete: async (r) => (calls++, reviewer.complete(r)) };
    for (const workRoot of [join(repo.dir, "work"), join(out, "work")]) {
      mkdirSync(workRoot, { recursive: true });
      await expect(serverAttempt({ reviewChange, job, attempt: 1, out, repo, reviewer: counted, meter, deadlineMs: 60_000, workRoot, installRoot: join(root, "tools") })).rejects.toThrow(/work root/);
    }
    expect(calls).toBe(0);
  });
});

describe("an incomplete server review is scored as complete", () => {
  it("saves a review whose answers never pass their checks as incomplete, and the score counts it so", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-incomplete-");
    const { out, sample } = await oneRun(root, createScriptedReviewer(script({ reply: "I read the change and it looks fine." })));
    expect(sample.record.status).toBe("incomplete");
    expect(sample.record.resultStatus).toBe("incomplete");
    expect(sample.record.failure).toMatch(/answer/);
    const saved = JSON.parse(readFileSync(join(out, "samples", CASE, "model-scripted-graph-on", "1", "sample.json"), "utf8"));
    expect(saved.status).toBe("incomplete");
    const report = JSON.parse(readFileSync(join(out, "samples", CASE, "model-scripted-graph-on", "1", "report", "report.json"), "utf8"));
    expect(report.completion.status).toBe("incomplete");
    const { score } = scoreRun(loadRun(out));
    expect(score.population).toMatchObject({ planned: 1, complete: 0, incomplete: 1, failed: 0, unstarted: 0 });
  });

  it("saves a review the budget refused as incomplete, and the score counts it failed: no model answered it (issue 284)", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-refused-");
    // Each call may cost more than the review's whole cap, so the first is refused.
    const pricey = { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 };
    const { out, sample } = await oneRun(root, createScriptedReviewer(script({ prices: pricey })), { prices: { scripted: pricey } });
    expect(sample.record.status).toBe("incomplete");
    expect(sample.record.failure).toMatch(/budget|refused/i);
    const { score } = scoreRun(loadRun(out));
    expect(score.population).toMatchObject({ planned: 1, complete: 0, incomplete: 0, failed: 1 });
  });

  it("saves a complete review as complete, and the score counts it so", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-complete-");
    const { out, sample } = await oneRun(root, createScriptedReviewer(script({ findings: [pathFinding] })));
    expect(sample.record.status).toBe("complete");
    const report = JSON.parse(readFileSync(join(out, "samples", CASE, "model-scripted-graph-on", "1", "report", "report.json"), "utf8"));
    expect(report.findings).toMatchObject([pathFinding]);
    const { score } = scoreRun(loadRun(out));
    expect(score.population).toMatchObject({ planned: 1, complete: 1, incomplete: 0 });
  });
});

describe("the model recorded is not the one that answered", () => {
  it("records the model the provider says answered, never the one asked for", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-served-");
    const { sample } = await oneRun(root, createScriptedReviewer(script({ model: "scripted", served: "scripted-answered-7" })));
    expect(sample.record.requestedModel).toBe("scripted");
    expect(sample.record.servedModel).toBe("scripted-answered-7");
    expect(sample.record.servedModels).toEqual(["scripted-answered-7"]);
  });

  it("records no served model when the provider named none", { timeout: 180_000 }, async () => {
    const root = tempDir("oq-server-unnamed-");
    const { sample } = await oneRun(root, createScriptedReviewer(script({ served: null })));
    expect(sample.record.status).toBe("complete");
    expect(sample.record.servedModel).toBeNull();
    expect(sample.record.servedModels).toEqual([]);
  });
});

describe("a model review scores with no cost and no tokens (issue 142)", () => {
  it("scores a saved scripted-model run with the cost, the tokens and the served model its samples record, summed per configuration", { timeout: 300_000 }, async () => {
    const root = tempDir("oq-server-usage-");
    // Prices that make every call cost something, well inside the review's cap.
    const prices = { input: 1, cachedInput: 0.1, output: 4 };
    const { out, samples } = await oneRun(root, createScriptedReviewer(script({ prices, served: "scripted-usage-3" })), { prices: { scripted: prices }, repeat: 2 });
    expect(samples.map((s) => s.record.status)).toEqual(["complete", "complete"]);
    // What each sample saved: the library's totals over every model call, and the model that answered them.
    const config = "model-scripted-graph-on";
    const rows = [1, 2].map((r) => JSON.parse(readFileSync(join(out, "samples", CASE, config, String(r), "sample.json"), "utf8")));
    for (const row of rows) {
      expect(row.usage.cost_usd).toBeGreaterThan(0);
      expect(row.usage.input_tokens).toBeGreaterThan(0);
      expect(row.usage.output_tokens).toBeGreaterThan(0);
      expect(row.servedModels).toEqual(["scripted-usage-3"]);
    }
    const sum = (k) => rows.reduce((a, row) => a + row.usage[k], 0);
    const { score } = scoreRun(loadRun(out));
    const c = score.byConfig[config];
    expect(c.costUsd.n).toBe(2);
    expect(c.costUsd.total).toBeCloseTo(sum("cost_usd"), 12);
    expect(c.inputTokens).toMatchObject({ n: 2, total: sum("input_tokens") });
    expect(c.outputTokens).toMatchObject({ n: 2, total: sum("output_tokens") });
    expect(c.servedModels).toEqual(["scripted-usage-3"]);
    // The table says what the reviews cost and which model served them, never n/a.
    const text = renderV3(score);
    expect(text).toMatch(/\| Cost per review, mean \| \$\d+\.\d{2} \|/);
    expect(text).toMatch(/\| Tokens in \/ out per review, mean \| \d+k \/ \d+k \|/);
    expect(text).toMatch(/\| Models that served the reviews \| scripted-usage-3 \|/);
  });
});

describe("a model id that boards.json neither records as probed nor maps as an alias is reviewed with", () => {
  const boards = JSON.parse(readFileSync(join(benchRoot, "outside", "boards.json"), "utf8"));
  const withAlias = (aliases) => ({ ...boards, aliases });

  it("refuses an id that is neither a probed deployment nor an alias", () => {
    expect(() => resolveModelReviewer("model:gpt-6.1", { boards: withAlias({}) })).toThrow(/refused: gpt-6\.1 .*alias/);
    const unprobed = structuredClone(boards);
    unprobed.deployments.reviewer.probed = null;
    expect(() => resolveModelReviewer("model:gpt-6.1-sol", { boards: unprobed })).toThrow(/not been probed/);
    expect(() => resolveModelReviewer("model:gpt-6.1", { boards: { ...unprobed, aliases: { "gpt-6.1": "gpt-6.1-sol" } } })).toThrow(/not been probed/);
    expect(() => resolveModelReviewer("model:gpt-6.1", { boards: withAlias({ "gpt-6.1": "gpt-9" }) })).toThrow(/gpt-9/);
  });

  it("takes a probed deployment, an alias to one, and the scripted model, and records the alias", () => {
    expect(resolveModelReviewer("model:gpt-6.1-sol", { boards })).toMatchObject({ name: "model:gpt-6.1-sol", kind: "deployment", deployment: "gpt-6.1-sol", alias: null });
    expect(resolveModelReviewer("model:gpt-6.1", { boards: withAlias({ "gpt-6.1": "gpt-6.1-sol" }) })).toMatchObject({ name: "model:gpt-6.1", kind: "deployment", deployment: "gpt-6.1-sol", alias: "gpt-6.1" });
    expect(resolveModelReviewer("model:scripted", { boards })).toMatchObject({ name: "model:scripted", kind: "scripted" });
  });

  it("run.mjs refuses --reviewers model:gpt-6.1 while boards.json maps no such alias, before anything runs", () => {
    expect(boards.aliases["gpt-6.1"]).toBeUndefined();
    const out = join(tempDir("oq-server-alias-"), "run");
    const p = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--reviewers", "model:gpt-6.1", "--cases", CASE, "--repeat", "1", "--max-usd", "1", "--max-minutes", "5", "--review-max-usd", "0.5", "--out", out], { encoding: "utf8", cwd: repoRoot });
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/gpt-6\.1.*alias/);
    expect(existsSync(out)).toBe(false);
  });
});

// A settings file for a deployment's endpoint: a loopback address, so no
// call could leave this machine, and a key made for this test.
function endpointSettings(dir, baseUrl = "http://127.0.0.1:9/openai/v1/", key = `test-endpoint-key-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`) {
  const file = join(dir, "azure.env");
  writeFileSync(file, `AZURE_OPENAI_BASE_URL=${baseUrl}\nAZURE_OPENAI_KEY=${key}\n`);
  return { file, key, baseUrl, env: { OPENQODEX_BENCH_MODEL_ENV: file } };
}

describe("the endpoint's key or address, in a provider's answer, reaches a saved file, rows.jsonl or stdout", () => {
  for (const [what, place] of [
    ["served model name", (s) => script({ served: s })],
    ["summary", (s) => script({ summary: `Reviewed against ${s}.` })],
  ]) {
    it(`writes nothing of a review whose ${what} holds it, and records only the refusal`, { timeout: 180_000 }, async () => {
      const root = tempDir("oq-server-leak-");
      // An address no case text holds, as a real endpoint's host is (the
      // flask case's own spec names 127.0.0.1).
      const settings = loadModelEnv({ env: endpointSettings(root, "http://[::1]:9/openai/v1/").env });
      for (const secret of [settings.apiKey, new URL(settings.baseUrl).host]) {
        const dir = join(root, secret === settings.apiKey ? "key" : "host");
        mkdirSync(dir);
        const { out, sample } = await oneRun(dir, createScriptedReviewer(place(secret)), { appearsIn: settings.appearsIn });
        expect(sample.leaked).toBe(true);
        expect(sample.record.failure).toBe(LEAK_REFUSED);
        expect(sample.record.status).toBe("failed");
        const sampleDir = join(out, "samples", CASE, "model-scripted-graph-on", "1");
        expect(filesUnder(sampleDir)).toEqual(["sample.json"]);
        for (const f of filesUnder(out)) expect(settings.appearsIn(readFileSync(join(out, f), "utf8")), f).toBe(false);
        expect(settings.appearsIn(JSON.stringify(sample.record))).toBe(false);
        // Nothing from the answer stays in the record.
        expect(sample.record).toMatchObject({ servedModel: null, servedModels: [], findings: null, usage: null });
      }
    });
  }
});

describe("the manifest names the model the run asked for as the one that answered", () => {
  const entry = () => ({ name: "model:gpt-6.1-sol", kind: "model", requestedModel: "gpt-6.1-sol", model: null, settings: { effort: "low", maxOutputTokens: 32000 } });
  const manifestAt = (dir) => {
    const path = join(dir, "manifest.json");
    writeFileSync(path, JSON.stringify({ version: 3, reviewer: entry(), reviewers: { "model:gpt-6.1-sol": entry() }, jobs: [] }));
    return path;
  };
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const served = (...ids) => ({ servedModel: ids.length === 1 ? ids[0] : null, servedModels: ids });

  it("sets the manifest's model to the id the first answered review was served by, and keeps the one asked for", () => {
    const path = manifestAt(tempDir("oq-server-manifest-"));
    expect(recordServed({ manifestPath: path, name: "model:gpt-6.1-sol", record: served() })).toEqual({ why: null, model: null });
    expect(read(path).reviewers["model:gpt-6.1-sol"].model).toBeNull();
    expect(recordServed({ manifestPath: path, name: "model:gpt-6.1-sol", record: served("gpt-6.1-sol-2026-10-01") })).toEqual({ why: null, model: "gpt-6.1-sol-2026-10-01" });
    const m = read(path);
    expect(m.reviewers["model:gpt-6.1-sol"]).toMatchObject({ requestedModel: "gpt-6.1-sol", model: "gpt-6.1-sol-2026-10-01" });
    expect(m.reviewer).toMatchObject({ requestedModel: "gpt-6.1-sol", model: "gpt-6.1-sol-2026-10-01" });
    expect(recordServed({ manifestPath: path, name: "model:gpt-6.1-sol", record: served("gpt-6.1-sol-2026-10-01") }).why).toBeNull();
  });

  it("refuses a later review served by another id, or by two, and leaves the manifest as it was", () => {
    const path = manifestAt(tempDir("oq-server-manifest-"));
    recordServed({ manifestPath: path, name: "model:gpt-6.1-sol", record: served("gpt-6.1-sol-2026-10-01") });
    const before = readFileSync(path, "utf8");
    expect(recordServed({ manifestPath: path, name: "model:gpt-6.1-sol", record: served("gpt-6.1-sol-2026-11-01") }).why).toMatch(/gpt-6\.1-sol-2026-11-01.*gpt-6\.1-sol-2026-10-01/);
    expect(recordServed({ manifestPath: path, name: "model:gpt-6.1-sol", record: served("gpt-6.1-sol-2026-10-01", "gpt-6.1-sol-2026-11-01") }).why).toMatch(/one served model/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("resumes a run whose manifest names the served model, and refuses one that asks for another", () => {
    const earlier = { reviewers: { "model:gpt-6.1-sol": { ...entry(), model: "gpt-6.1-sol-2026-10-01" } } };
    expect(resumeProblems(earlier, { reviewers: { "model:gpt-6.1-sol": entry() } })).toEqual([]);
    expect(resumeProblems(earlier, { reviewers: { "model:gpt-6.1-sol": { ...entry(), requestedModel: "gpt-6.2-sol" } } }).join("\n")).toMatch(/requested model/);
  });
});

// Every piece of a text at least `n` characters long.
const pieces = (text, n = 4) => Array.from({ length: Math.max(0, text.length - n + 1) }, (_, i) => text.slice(i, i + n));

describe("a resume reaches another endpoint than the run's", () => {
  // Two base URLs and two keys, every pairing of them in a settings file.
  const URL_A = "http://127.0.0.1:9/openai/v1/";
  const URL_B = "http://localhost:9/openai/v1";
  const KEY_A = "key-for-endpoint-one";
  const KEY_B = "key-for-endpoint-two";
  const records = () => {
    const dir = tempDir("oq-server-endpoint-");
    const resolved = resolveModelReviewer("model:gpt-6.1-sol");
    const make = (name, url, key) => {
      mkdirSync(join(dir, name));
      return createModelReviewer(resolved, { env: endpointSettings(join(dir, name), url, key).env }).record;
    };
    return { name: resolved.name, one: make("one", URL_A, KEY_A), again: make("again", URL_A, KEY_A), otherUrl: make("url", URL_B, KEY_A), otherKey: make("key", URL_A, KEY_B) };
  };

  it("keeps the endpoint as an identity the key alone can check: it changes with the URL or the key, and holds nothing of either", () => {
    const { one, again, otherUrl, otherKey } = records();
    expect(one.endpoint).toMatch(/^[0-9a-f]{64}$/);
    expect(again.endpoint).toBe(one.endpoint);
    expect(otherUrl.endpoint).not.toBe(one.endpoint);
    expect(otherKey.endpoint).not.toBe(one.endpoint);
    // Anyone who guesses the URL cannot match it: it is not the URL's own hash, with or without its trailing slash.
    for (const url of [URL_A, URL_A.replace(/\/+$/, "")]) expect(one.endpoint).not.toBe(createHash("sha256").update(url).digest("hex"));
    for (const r of [one, otherUrl, otherKey]) {
      // The identity holds no piece of either; the record holds neither, nor a host.
      for (const secret of [URL_A, URL_B, KEY_A, KEY_B]) for (const piece of pieces(secret)) expect(r.endpoint, piece).not.toContain(piece);
      const text = JSON.stringify(r);
      for (const secret of [URL_A, URL_A.replace(/\/+$/, ""), URL_B, KEY_A, KEY_B, "127.0.0.1", "localhost"]) expect(text).not.toContain(secret);
    }
    expect(one.requestedModel).toBe("gpt-6.1-sol");
    expect(one.model).toBeNull();
  });

  it("accepts a resume on the same URL and key, and refuses one on another URL or key with a line that names neither", () => {
    const { name, one, again, otherUrl, otherKey } = records();
    expect(resumeProblems({ reviewers: { [name]: one } }, { reviewers: { [name]: again } })).toEqual([]);
    for (const other of [otherUrl, otherKey]) {
      const problems = resumeProblems({ reviewers: { [name]: one } }, { reviewers: { [name]: other } });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/endpoint/);
      for (const secret of [URL_A, URL_B, KEY_A, KEY_B, "127.0.0.1", "localhost", one.endpoint, other.endpoint]) expect(problems[0]).not.toContain(secret);
    }
  });
});

// The scripted model answers from its script and nothing else.
describe("the scripted model", () => {
  it("answers with the change id and every candidate the brief names, and reports its usage", async () => {
    const reviewer = createScriptedReviewer(script({ served: "scripted-x" }));
    const brief = ["# OpenQodex review brief", "- `change_id`: `0123456789ab`, the change this brief is for.", "- c1 [semgrep:rule] files/app.py:17 (major) A path from a parameter."].join("\n");
    const answer = await reviewer.complete({ callId: "c-1", attempt: 1, purpose: "brief", messages: [{ role: "system", text: "s" }, { role: "user", text: brief }], tools: [], maxOutputTokens: 1000 });
    expect(answer.message.toolCalls).toEqual([]);
    expect(JSON.parse(answer.message.text)).toMatchObject({ version: 2, change_id: "0123456789ab", findings: [], dropped: [{ candidate: "c1", file_path: "files/app.py", line_number: 17 }] });
    expect(answer.usage).toMatchObject({ model: "scripted", servedModel: "scripted-x", costUsd: 0 });
    expect(answer.usage.inputTokens).toBeGreaterThan(0);
    // Writing a script file and reading it back gives the same script.
    const dir = tempDir("oq-scripted-");
    writeFileSync(join(dir, "s.json"), JSON.stringify(script()));
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", `import { readScript } from ${JSON.stringify(pathToFileURL(join(benchRoot, "lib/scripted-model.mjs")).href)}; process.stdout.write(JSON.stringify(readScript(${JSON.stringify(join(dir, "s.json"))}).script));`], { encoding: "utf8" })).toBe(JSON.stringify(script()));
  });
  it("finds only this unit's findings with every hunk analysed and the exact diff evidence", async () => {
    const reviewer = createScriptedReviewer(script({ findings: [pathFinding, { ...pathFinding, file_path: "other.py" }] }));
    const brief = ["# OpenQodex review brief: find pass", "- `change_id`: `0123456789ab`.", "Unit: u2", "### h4 files/app.py 16-17", "```diff", "--- a/files/app.py", "+++ b/files/app.py", "@@ -16,1 +16,2 @@", "-    path = old_path", "+    name = request.args.get('name', '')", "+    path = os.path.join(UPLOAD_DIR, name)", "```", "### h5 files/app.py 24-24", "```diff", "@@ -23,0 +24,1 @@", "+    app.run(debug=True)", "```", "## Answer", "# OpenQodex review brief: verify pass"].join("\n");
    const answer = await reviewer.complete({ messages: [{ role: "user", text: brief }, { role: "user", text: "Fix the previous answer." }], maxOutputTokens: 1000 });
    const value = JSON.parse(answer.message.text);
    expect(value).toMatchObject({ version: "find-1", change_id: "0123456789ab", unit: "u2", examined: ["h4", "h5"], candidates: [{ file_path: pathFinding.file_path, line_number: 17, claim: pathFinding.problem, evidence: [{ file_path: pathFinding.file_path, line_number: 17, quote: "    path = os.path.join(UPLOAD_DIR, name)" }] }] });
    expect(value.analysis.map((a) => a.hunk)).toEqual(["h4", "h5"]);
    for (const entry of value.analysis) {
      expect(entry.changed.length).toBeGreaterThan(0);
      expect(entry.could_break.length).toBeGreaterThan(0);
    }
    const empty = createScriptedReviewer(script());
    expect(JSON.parse((await empty.complete({ messages: [{ role: "user", text: brief }], maxOutputTokens: 1000 })).message.text).candidates).toEqual([]);
  });

  it("verifies every candidate by title then location, and refutes scanner candidates with the script reason", async () => {
    const other = { ...pathFinding, title: "Another claim", problem: "Another operation is unsafe." };
    const reviewer = createScriptedReviewer(script({ findings: [other, pathFinding] }));
    const brief = ["# OpenQodex review brief: verify pass", "- `change_id`: `0123456789ab`.", "### c1 (scanner)", "- Location: files/app.py:17", "- Severity: major", "- Category: security", "### k2 (finder)", "- Location: files/app.py:17-18", `- Title: ${pathFinding.title}`, "- Category: security", "### k3 (finder)", "- Location: files/app.py:17", "- Title: Renamed claim", "- Category: security"].join("\n");
    const answer = await reviewer.complete({ messages: [{ role: "user", text: brief }], maxOutputTokens: 1000 });
    const value = JSON.parse(answer.message.text);
    expect(value).toEqual({ version: "verify-1", change_id: "0123456789ab", verdicts: [
      { id: "c1", verdict: "refuted", reason: script().dropReason, severity: "major", category: "security", confidence: 1, file_path: "files/app.py", line_number: 17, line_end: 17, title: "", problem: "", consequence: "", fix: "", suggested_change: null, tier: "finding", duplicate_of: null },
      { id: "k2", verdict: "confirmed", reason: pathFinding.problem, severity: pathFinding.severity, category: pathFinding.category, confidence: 1, file_path: pathFinding.file_path, line_number: 17, line_end: 18, title: pathFinding.title, problem: pathFinding.problem, consequence: pathFinding.consequence, fix: pathFinding.fix, suggested_change: null, tier: "finding", duplicate_of: null },
      { id: "k3", verdict: "confirmed", reason: other.problem, severity: other.severity, category: other.category, confidence: 1, file_path: other.file_path, line_number: 17, line_end: 17, title: other.title, problem: other.problem, consequence: other.consequence, fix: other.fix, suggested_change: null, tier: "finding", duplicate_of: null },
    ] });
  });

  it("sends a non-null reply unchanged for every brief kind and correction", async () => {
    const reply = "The scripted broken answer.";
    const reviewer = createScriptedReviewer(script({ reply }));
    for (const heading of ["# OpenQodex review brief", "# OpenQodex review brief: find pass", "# OpenQodex review brief: verify pass"]) {
      const messages = [{ role: "user", text: heading }];
      expect((await reviewer.complete({ messages, maxOutputTokens: 1000 })).message.text).toBe(reply);
      messages.push({ role: "user", text: "Fix the previous answer." });
      expect((await reviewer.complete({ messages, maxOutputTokens: 1000 })).message.text).toBe(reply);
    }
  });
});

// A real run.mjs process on the packed build and a loopback provider. The
// provider resets every call of a failed attempt, including fresh finder
// sessions, so the library cannot turn that attempt into a success.
describe("the model path saves a transport failure as a final incomplete sample", () => {
  let tarball;
  beforeAll(() => {
    const dir = tempDir("oq-transport-pack-");
    const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: join(repoRoot, "packages/cli"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    tarball = join(dir, JSON.parse(packed)[0].filename);
  }, 120_000);

  async function fixture({ failures = 2, repeat = 1 } = {}) {
    const root = tempDir("oq-transport-run-");
    const out = join(root, "run");
    const config = "model-gpt-6.1-sol-graph-on";
    const job = { case: CASE, config, repeat: 1 };
    const sample = (n) => join(attemptDir(out, job, n), "sample.json");
    let requests = 0;
    let killing = false;
    const scripted = createScriptedReviewer(script());
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests++;
      // Hold any retry in flight until the parent kills the first run.
      if (killing && existsSync(sample(1))) return;
      const savedFailures = Array.from({ length: failures }, (_, i) => sample(i + 1)).filter(existsSync).length;
      if (savedFailures < failures) return req.socket.destroy();
      const body = JSON.parse(raw);
      const answer = await scripted.complete({ messages: body.input.filter((m) => m.type === "message").map((m) => ({ role: m.role, text: m.content })), tools: [], maxOutputTokens: body.max_output_tokens });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "completed", model: "gpt-6.1-sol", output: [{ type: "message", content: [{ type: "output_text", text: answer.message.text }] }], usage: { input_tokens: 10, output_tokens: 10 } }));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const settings = endpointSettings(root, `http://127.0.0.1:${server.address().port}/openai/v1/`);
    mkdirSync(join(root, "tools"));
    const wave = newWave("transport", { root });
    const env = { ...process.env, ...settings.env, OPENQODEX_BENCH_CACHE: join(root, "cache"), OPENQODEX_BENCH_WAVES: join(root, "index/waves"), TMPDIR: root, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    const args = [join(benchRoot, "run.mjs"), "--package", `file:${tarball}`, "--reviewers", "model:gpt-6.1-sol", "--install-root", join(root, "tools"), "--allow-missing-scanners", "--cases", CASE, "--repeat", String(repeat), "--concurrency", "1", "--max-usd", "2", "--review-max-usd", "0.5", "--max-minutes", "30", "--max-output-tokens", "1000", "--allow-over", "--wave", wave.id, "--out", out];
    const run = ({ resume = false, kill = false } = {}) => new Promise((done, reject) => {
      killing = kill;
      const child = spawn(process.execPath, [...args, ...(resume ? ["--resume"] : [])], { cwd: repoRoot, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (kill && stdout.includes(": incomplete") && existsSync(sample(1))) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status, signal) => done({ status, signal, stdout, stderr }));
    });
    const read = (path) => JSON.parse(readFileSync(path, "utf8"));
    const ended = () => existsSync(join(out, "resumes.jsonl")) ? readFileSync(join(out, "resumes.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1) : read(join(out, "manifest.json")).ended;
    const close = async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    };
    return { out, job, sample, run, read, ended, close, requests: () => requests, settleKilled: () => settle(wave, "run", readLedger(out).spentUsd) };
  }

  it("one reset leaves the model sample permanently incomplete", { timeout: 180_000 }, async () => {
    const f = await fixture({ failures: 1 });
    try {
      const r = await f.run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(existsSync(f.sample(2))).toBe(true);
      expect(f.read(f.sample(1)).status).toBe("incomplete");
      expect(f.read(f.sample(2)).status).toBe("complete");
      expect(existsSync(f.sample(3))).toBe(false);
      expect(f.ended()).toMatchObject({ how: "finished" });
      expect(f.ended().halt).toBeUndefined();
      expect(readLedger(f.out).events.filter((e) => e.op === "reserve" && e.kind === "review")).toHaveLength(2);
      expect(scoreRun(loadRun(f.out)).score.byConfig[f.job.config].population).toMatchObject({ complete: 0, incomplete: 0, failed: 1, retries: 1 });
    } finally { await f.close(); }
  });

  it("two resets of one job let the next job start", { timeout: 180_000 }, async () => {
    const f = await fixture({ repeat: 2 });
    try {
      const r = await f.run();
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(existsSync(f.sample(2))).toBe(true);
      expect(existsSync(f.sample(3))).toBe(false);
      expect(readLedger(f.out).events.filter((e) => e.op === "reserve" && e.kind === "review")).toHaveLength(2);
      expect(f.ended().halt).toMatchObject({ rule: "same-reason-twice" });
      expect(f.ended().halt.why).toContain(f.read(f.sample(1)).failure);
      expect(f.ended().halt.why).toContain(f.read(f.sample(2)).failure);
      expect(existsSync(attemptDir(f.out, { ...f.job, repeat: 2 }, 1))).toBe(false);
    } finally { await f.close(); }
  });

  for (const resumes of [1, 3]) it(resumes === 1 ? "a killed run skips the saved transport failure's pending retry" : "resuming an exhausted transport retry twice more sends new calls", { timeout: 180_000 }, async () => {
    const f = await fixture();
    try {
      const killed = await f.run({ kill: true });
      expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL");
      expect(f.read(f.sample(1)).status).toBe("incomplete");
      f.settleKilled();
      const next = jobState(f.out, f.job).next;
      const resumed = await f.run({ resume: true });
      expect(existsSync(f.sample(next)), resumed.stdout + resumed.stderr).toBe(true);
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(1);
      expect(f.read(f.sample(next)).status).toBe("incomplete");
      expect(f.ended().halt).toMatchObject({ rule: "same-reason-twice" });
      expect(f.ended().halt.why).toContain(f.read(f.sample(1)).failure);
      expect(f.ended().halt.why).toContain(f.read(f.sample(next)).failure);
      expect(existsSync(f.sample(next + 1))).toBe(false);
      const requests = f.requests();
      for (let i = 1; i < resumes; i++) {
        const r = await f.run({ resume: true });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(f.requests()).toBe(requests);
        expect(existsSync(f.sample(next + 1))).toBe(false);
      }
    } finally { await f.close(); }
  });
});
