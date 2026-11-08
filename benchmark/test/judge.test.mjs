// The wording judge (benchmark/judge.mjs) and its verdict in score.json
// (benchmark/score.mjs): the judge sends one call per review to the GPT-5.2
// deployment through the model adapter, reads where to send it from the
// model settings file only, holds every call to the run's budget ledger,
// and writes judge.json; the scorer folds judge.json's totals into each
// configuration's `wording`, which never changes a hit, a count, an exit
// code or an accept.
//
// The model provider is the only stand-in: a local HTTP server that answers
// in the Responses shape with a scripted verdict for every finding the
// prompt names, bills each request by the bytes it received, and remembers
// every request. The judge, the adapter, the settings loader, the ledger,
// the runner that makes the run folder and the scorer are the real ones,
// run as the commands are run.
//
// Failures guarded, written before the code:
// 1. A judge run without the settings file reaches a model anyway (through
//    Azure or OpenAI settings in the environment), or says why in more than
//    one plain line.
// 2. A judge call is left out of the run's ledger, or a run whose cap has
//    no room left sends a call before it stops.
// 3. The wording totals in score.json differ from the judge.json they came
//    from, a legacy judge.json included.
// 4. A judge verdict changes `found`, a count, an exit code or an accept.
// 5. The judge's key or base URL is saved in the run folder or printed,
//    the provider's own error message included.
// From the review of the first version:
// 6. A write cut off part way leaves judge.json half written, so the
//    verdicts already paid for are lost and --resume refuses the file.
// 7. A resumed pass sends and charges again a review whose answer was
//    saved in judge-raw/ before its verdict reached judge.json.
// 8. Two judges on one run both send calls and write over each other.
// 9. A malformed judge.json changes the score command's exit or its score.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { manifestBudget, openLedger, readLedger } from "../lib/budget.mjs";
import { buildEntry, scoreHash } from "../lib/index.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { newWave } from "../lib/wave.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const JUDGE = fileURLToPath(new URL("../judge.mjs", import.meta.url));
const SCORE = fileURLToPath(new URL("../score.mjs", import.meta.url));
const PRICES = JSON.parse(readFileSync(new URL("../outside/prices.json", import.meta.url), "utf8")).models;
// Made at run time, so no secret scanner reading this file takes it for a real key.
const KEY = `test-model-key-${randomBytes(16).toString("hex")}`;
const SERVED = "gpt-5.2-2025-12-11";

// --- the model provider stand-in ---

const servers = [];
const ALL_TRUE = () => ({ problem: { plain: true, correct: true }, consequence: { plain: true, correct: true }, fix: { plain: true, correct: true } });
const ALL_FALSE = () => ({ problem: { plain: false, correct: false }, consequence: { plain: false, correct: false }, fix: { plain: false, correct: false } });

// `verdict(id)` scripts the answer for each finding the prompt names; `fail`
// answers every request with an HTTP 401 whose message echoes the key and
// the address it was sent to, as some providers do.
async function provider({ verdict = ALL_TRUE, fail = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const text = body.input.map((i) => i.content ?? "").join("\n");
    const ids = [...text.matchAll(/^Finding (f\d+)$/gm)].map((m) => m[1]);
    const input = Buffer.byteLength(raw, "utf8");
    const output = 300;
    const usd = (input * PRICES[body.model].input + output * PRICES[body.model].output) / 1e6;
    requests.push({ model: body.model, headers: req.headers, ids, usd });
    if (fail) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "401", message: `Access denied for key ${req.headers["api-key"]} at http://${req.headers.host}${req.url}` } }));
      return;
    }
    const answer = JSON.stringify({ verdicts: ids.map((id) => ({ id, ...verdict(id), note: "scripted" })) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `resp_${randomBytes(6).toString("hex")}`,
        object: "response",
        status: "completed",
        model: SERVED,
        output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }],
        usage: { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output },
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const host = `127.0.0.1:${server.address().port}`;
  return { host, baseUrl: `http://${host}/openai/v1`, requests, billed: () => requests.reduce((s, r) => s + r.usd, 0) };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

// The model settings file, as Sid's ~/.config/openqodex-bench/azure.env holds it.
function settingsFile(baseUrl) {
  const path = join(tempDir("oq-judge-env-"), "azure.env");
  writeFileSync(path, `AZURE_OPENAI_BASE_URL=${baseUrl}\nAZURE_OPENAI_KEY=${KEY}\n`);
  return path;
}

// --- a run folder, made by the runner's own code ---

const bug = (id, file, line, kind, mentions, truth) => ({ id, file, lines: [line, line], anchor: { line, text: "x" }, mentions, kind, severity: "critical", found_by: ["reasoning"], truth });
const SPEC = {
  id: "hand",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  bugs: [bug("sqli", "app/search.py", 14, ["security"], ["sql", "injection"], "The search query is built from request text."), bug("root", "Dockerfile", 11, ["security"], ["root"], "The container runs as root.")],
};
const finding = (file_path, line_number, title) => ({ origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path, line_number, line_end: line_number, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: `${title}.`, consequence: "An attacker reads the data.", fix: "Use a bound parameter." });
const BASE_REPORT = {
  version: 1,
  kind: "review",
  verdict: "blocked",
  findings: [finding("app/search.py", 14, "SQL injection in the search"), finding("Dockerfile", 11, "Container runs as root"), finding("app/other.py", 3, "Unused import")],
  outside_change: [],
  dropped: [],
  scanners: [],
  impact: { status: "ok", build: { durationMs: 100 } },
  completion: { status: "complete", missing: [], reviewer: { duration_ms: 30_000, rounds: 1, usage: { turns: 4, input_tokens: 1000, output_tokens: 100, cost_usd: 0.1 } } },
};
const HASH = "cd".repeat(32);
const CASE_ID = `planted/hand@${HASH.slice(0, 8)}`;
const CONFIG = "claude-graph-on";

// Two reviews of the hand case, each with two findings on planted bugs and
// one that is not, under a run cap of `maxUsd` dollars.
async function savedRun({ maxUsd = 1, report: REPORT = BASE_REPORT } = {}) {
  const root = tempDir("oq-judge-run-");
  const out = join(root, "2026-10-11-judge01");
  writeFileSync(join(root, "hand.json"), JSON.stringify(SPEC));
  const { jobs } = planJobs({ cases: ["hand"], caseIds: { hand: CASE_ID }, reviewers: ["claude"], graph: ["on"], repeat: 2 });
  const budget = manifestBudget({ caps: { maxUsd, reviewMaxUsd: null }, forecast: { maxMinutes: 60 }, estimate: null });
  const manifest = runManifest({
    startedAt: "2026-10-11T10:00:00.000Z",
    settings: { build: { commit: "c".repeat(40), short: "ccccccc", dirty: false, cliVersion: "0.14.0" }, reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } }, cases: ["hand"], caseIds: [CASE_ID], caseHashes: { hand: HASH }, configs: [CONFIG], repeat: 2, budget, scannersComplete: true },
    jobs,
  });
  await executeRun({ out, manifest, jobs, copies: [[join(root, "hand.json"), "cases/hand.json"]], runJob: async (job) => {
    const dir = attemptDir(out, job, 1);
    mkdirSync(join(dir, "report"), { recursive: true });
    writeFileSync(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job, attempt: 1, result: { code: 0, signal: null, wallMs: 30_000 }, report: REPORT, who: null, startedAt: "t", failure: null, stopped: null })));
    writeFileSync(join(dir, "report", "report.json"), JSON.stringify(REPORT));
  } });
  return out;
}

// The judge as a command, in its own process. Async, so the stand-in in
// this process can answer while it runs. `fileLimitKb` starts it under a
// shell's file size limit, so a write past that size fails part way, as a
// full disk would make it. Each pass gets a wave of its own in a temporary
// journal folder (lib/wave.mjs), so no pass is refused by another's spend.
const waveRoot = tempDir("oq-judge-waves-");
let waves = 0;
function judge(out, { env = {}, args = [], fileLimitKb = null } = {}) {
  const wave = newWave(`judge-${++waves}`, { root: waveRoot }).id;
  args = [...args, "--wave", wave];
  return new Promise((done) => {
    const command = fileLimitKb === null ? [process.execPath, JUDGE, out, ...args] : ["/bin/bash", "-c", `ulimit -f ${fileLimitKb} && exec "$0" "$@"`, process.execPath, JUDGE, out, ...args];
    const child = spawn(command[0], command.slice(1), { env: { ...process.env, OPENQODEX_BENCH_WAVES: join(waveRoot, "index/waves"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const filesIn = (dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile());
const oneLine = (text) => text.trim() !== "" && !text.trim().includes("\n");

describe("a judge run without the settings file reaches a model", () => {
  it("fails closed with one plain line and sends nothing, though the environment names an Azure endpoint and an OpenAI key", async () => {
    const fake = await provider();
    const out = await savedRun();
    const missing = join(tempDir("oq-judge-none-"), "azure.env");
    const r = await judge(out, { env: { OPENQODEX_BENCH_MODEL_ENV: missing, AZURE_OPENAI_BASE_URL: fake.baseUrl, AZURE_OPENAI_KEY: KEY, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseUrl } });
    expect(r.code).toBe(2);
    expect(oneLine(r.stderr), r.stderr).toBe(true);
    expect(r.stderr).toMatch(/^refused: the model settings file .* cannot be read/);
    expect(r.stdout).toBe("");
    expect(fake.requests).toHaveLength(0);
    expect(existsSync(join(out, "judge.json"))).toBe(false);
    expect(existsSync(join(out, "budget.jsonl"))).toBe(false);
  });
});

describe("a judge call is left out of the run's ledger", () => {
  it("reserves each call's worst case against the run's cap and settles it at what the provider billed, with the served model recorded", async () => {
    const fake = await provider();
    const out = await savedRun({ maxUsd: 1 });
    const r = await judge(out, { env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) } });
    expect(r.code, r.stderr).toBe(0);
    // One call per review, to the GPT-5.2 deployment, with the key in an api-key header.
    expect(fake.requests.map((q) => q.model)).toEqual(["gpt-5.2", "gpt-5.2"]);
    expect(fake.requests.every((q) => q.headers["api-key"] === KEY && q.headers.authorization === undefined)).toBe(true);
    expect(fake.requests.map((q) => q.ids)).toEqual([["f1", "f2"], ["f1", "f2"]]);
    const ledger = readLedger(out);
    const reserved = ledger.events.filter((e) => e.op === "reserve");
    expect(reserved).toHaveLength(2);
    expect(reserved.every((e) => e.kind === "judge")).toBe(true);
    expect(ledger.events.filter((e) => e.op === "settle").map((e) => e.how)).toEqual(["reported", "reported"]);
    expect(ledger.spentUsd).toBeCloseTo(fake.billed(), 8);
    expect(ledger.reservedUsd).toBe(0);
    const doc = readJson(join(out, "judge.json"));
    expect(doc).toMatchObject({ model: "gpt-5.2", servedModels: [SERVED] });
    expect(doc.samples.map((s) => s.servedModel)).toEqual([SERVED, SERVED]);
    expect(doc.totals[CONFIG].costUsd).toBeCloseTo(fake.billed(), 12);
  });

  it("stops before the first call when the run's cap is zero or already spent", async () => {
    const fake = await provider();
    const env = { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) };
    // A manifest whose cap is zero holds no call at all.
    const zero = await savedRun({ maxUsd: 0 });
    const refused = await judge(zero, { env });
    expect(refused.code).toBe(2);
    expect(oneLine(refused.stderr), refused.stderr).toBe(true);
    expect(refused.stderr).toMatch(/hard cap/);
    // A run that spent its whole cap on its reviews has no room for the judge.
    const spent = await savedRun({ maxUsd: 0.5 });
    openLedger(spent, { maxUsd: 0.5 }).spend(0.5, "the reviews");
    const stopped = await judge(spent, { env });
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toMatch(/hard cap --max-usd/);
    expect(fake.requests).toHaveLength(0);
    expect(readLedger(spent).peakUsd).toBeLessThanOrEqual(0.5);
    expect(existsSync(join(spent, "judge.json"))).toBe(false);
  });
});

// Each sentence's plain and correct counts, the findings, the unparsed ones
// and the cost, as judge.json's totals hold them.
const TOTAL_KEYS = ["findings", "unparsed", "costUsd", "problem", "consequence", "fix"];
const totalsOf = (wording) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, wording[k]]));

describe("the wording totals in score.json differ from the judge.json they came from", () => {
  it("writes each configuration's totals from the run's judge.json, with the judge model named", async () => {
    const fake = await provider({ verdict: (id) => (id === "f1" ? ALL_TRUE() : { problem: { plain: false, correct: true }, consequence: { plain: true, correct: false }, fix: { plain: false, correct: false } }) });
    const out = await savedRun();
    expect((await judge(out, { env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) } })).code).toBe(0);
    const doc = readJson(join(out, "judge.json"));
    const scoreDir = tempDir("oq-judge-score-");
    const r = spawnSync(process.execPath, [SCORE, out, "--out", scoreDir], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const wording = readJson(join(scoreDir, "score.json")).byConfig[CONFIG].wording;
    expect(totalsOf(wording)).toEqual(totalsOf(doc.totals[CONFIG]));
    expect(wording).toMatchObject({ model: "gpt-5.2", servedModels: [SERVED], findings: 4, unparsed: 0, problem: { plain: { hit: 2, of: 4 }, correct: { hit: 4, of: 4 } }, fix: { plain: { hit: 2, of: 4 }, correct: { hit: 2, of: 4 } } });
    expect(r.stdout).toMatch(/Wording, judged by gpt-5\.2/);
  });

  it("counts a legacy judge.json given with --judge the way its own judge did: an unparsed answer out of every ratio, an unknown cost as nothing", async () => {
    const out = await savedRun();
    const v = (plain, correct) => ({ plain, correct });
    const legacy = {
      version: 1,
      model: "claude-sonnet-5",
      reviewerModel: "claude-opus-5-5",
      at: "2026-10-08T20:02:46.441Z",
      samples: [
        { case: "hand", config: CONFIG, repeat: 1, costUsd: 0.25, parsed: true, findings: [{ bug: "sqli", title: "a", verdict: { problem: v(true, true), consequence: v(false, true), fix: v(true, false), note: "n" } }, { bug: "root", title: "b", verdict: { problem: v(false, true), consequence: v(true, true), fix: v(true, true), note: "n" } }] },
        { case: "hand", config: CONFIG, repeat: 2, costUsd: null, parsed: false, findings: [{ bug: "sqli", title: "a", verdict: null }] },
      ],
      totals: { [CONFIG]: { findings: 3, unparsed: 1, costUsd: 0.25, problem: { plain: { hit: 1, of: 2 }, correct: { hit: 2, of: 2 } }, consequence: { plain: { hit: 1, of: 2 }, correct: { hit: 2, of: 2 } }, fix: { plain: { hit: 2, of: 2 }, correct: { hit: 1, of: 2 } } } },
    };
    const file = join(tempDir("oq-judge-legacy-"), "judge.json");
    writeFileSync(file, JSON.stringify(legacy));
    const wording = scoreRun(loadRun(out, { judgeFile: file })).score.byConfig[CONFIG].wording;
    expect(totalsOf(wording)).toEqual(legacy.totals[CONFIG]);
    expect(wording).toMatchObject({ model: "claude-sonnet-5", servedModels: [], costUnknown: 1 });
  });
});

describe("a judge verdict changes found, a count, an exit code or an accept", () => {
  it("scores the run the same with every sentence judged wrong as with no judge at all, wording apart", async () => {
    const fake = await provider({ verdict: ALL_FALSE });
    const out = await savedRun();
    const scoreDir = (name) => {
      const dir = join(tempDir("oq-judge-same-"), name);
      return { dir, r: spawnSync(process.execPath, [SCORE, out, "--out", dir], { encoding: "utf8" }) };
    };
    const before = scoreRun(loadRun(out));
    const beforeCli = scoreDir("before");
    expect((await judge(out, { env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) } })).code).toBe(0);
    const after = scoreRun(loadRun(out));
    const afterCli = scoreDir("after");
    expect(before.score.byConfig[CONFIG].wording).toBeNull();
    expect(after.score.byConfig[CONFIG].wording.problem.plain).toEqual({ hit: 0, of: 4 });
    // Every number but the wording is the same: found, every count, the outcomes.
    const withoutWording = (score) => ({ ...score, byConfig: Object.fromEntries(Object.entries(score.byConfig).map(([c, x]) => [c, { ...x, wording: undefined }])) });
    expect(withoutWording(after.score)).toEqual(withoutWording(before.score));
    expect(after.jobs.map((j) => j.bugs.map((b) => b.found))).toEqual(before.jobs.map((j) => j.bugs.map((b) => b.found)));
    expect(after.jobs.map((j) => j.bugs.map((b) => b.found))).toEqual([[true, true], [true, true]]);
    expect(after.outcomes).toEqual(before.outcomes);
    // The command's exit code and the index entry an accept is checked against.
    expect([afterCli.r.status, beforeCli.r.status]).toEqual([0, 0]);
    expect(readFileSync(join(afterCli.dir, "outcomes.jsonl"), "utf8")).toBe(readFileSync(join(beforeCli.dir, "outcomes.jsonl"), "utf8"));
    const manifest = readJson(join(out, "manifest.json"));
    const entry = (score) => buildEntry({ runId: "2026-10-11-judge01", manifest, resumes: [], score, asset: null, privateListHash: null });
    expect(entry(after.score)).toEqual(entry(before.score));
    expect(scoreHash(entry(after.score))).toBe(scoreHash(entry(before.score)));
  });
});

describe("the judge's key or base URL is saved", () => {
  it("keeps the key, the base URL and its host out of every file in the run folder and out of what it prints, the provider's own error included", async () => {
    const secrets = (fake) => [KEY, fake.baseUrl, fake.host];
    const leaks = (fake, out, r) => {
      const texts = [r.stdout, r.stderr, ...filesIn(out).map((f) => readFileSync(f, "utf8"))];
      return secrets(fake).filter((s) => texts.some((t) => t.includes(s)));
    };
    const good = await provider();
    const out = await savedRun();
    const ok = await judge(out, { env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(good.baseUrl) } });
    expect(ok.code).toBe(0);
    expect(leaks(good, out, ok)).toEqual([]);
    // A provider that echoes the key and its own address in its refusal.
    const echo = await provider({ fail: true });
    const out2 = await savedRun();
    const failed = await judge(out2, { env: { OPENQODEX_BENCH_MODEL_ENV: settingsFile(echo.baseUrl) } });
    expect(failed.code).toBe(1);
    expect(echo.requests).toHaveLength(1);
    expect(failed.stderr).toMatch(/HTTP 401/);
    expect(leaks(echo, out2, failed)).toEqual([]);
    // The failed call keeps its whole reservation as spent.
    expect(readLedger(out2).events.filter((e) => e.op === "settle").map((e) => e.how)).toEqual(["kept"]);
  });
});

describe("a write cut off part way leaves judge.json half written", () => {
  it("keeps the last whole judge.json and leaves no temporary file when a write fails part way", async () => {
    const fake = await provider();
    // Long titles make judge.json the one file of the pass that outgrows the size limit.
    const long = (title) => `${title} ${"q".repeat(3000)}`;
    const report = { ...BASE_REPORT, findings: [finding("app/search.py", 14, long("SQL injection in the search")), finding("Dockerfile", 11, long("Container runs as root"))] };
    const out = await savedRun({ report });
    const env = { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) };
    expect((await judge(out, { env, args: ["--limit", "1"] })).code).toBe(0);
    const first = readFileSync(join(out, "judge.json"), "utf8");
    expect(Buffer.byteLength(first)).toBeGreaterThan(4 * 1024);
    // The second review's verdict makes judge.json larger than 4 KB can hold.
    const cut = await judge(out, { env, args: ["--resume"], fileLimitKb: 4 });
    expect(cut.code).toBe(1);
    expect(cut.stderr).toMatch(/^Stopped: .*judge\.json/m);
    expect(readFileSync(join(out, "judge.json"), "utf8")).toBe(first);
    expect(readJson(join(out, "judge.json")).samples).toHaveLength(1);
    expect(filesIn(out).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a resumed pass sends and charges again a review whose answer was saved in judge-raw/", () => {
  it("takes the saved answer into judge.json with no call and no ledger line", async () => {
    const fake = await provider({ verdict: (id) => (id === "f1" ? ALL_TRUE() : ALL_FALSE()) });
    const out = await savedRun();
    const env = { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) };
    expect((await judge(out, { env })).code).toBe(0);
    const whole = readJson(join(out, "judge.json"));
    // A pass killed after it saved the second answer and before judge.json took its verdict.
    writeFileSync(join(out, "judge.json"), JSON.stringify({ ...whole, samples: whole.samples.slice(0, 1) }));
    const calls = fake.requests.length;
    const lines = readLedger(out).events.length;
    const resumed = await judge(out, { env, args: ["--resume"] });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(fake.requests.length).toBe(calls);
    expect(readLedger(out).events.length).toBe(lines);
    const after = readJson(join(out, "judge.json"));
    expect(after.samples).toEqual(whole.samples);
    expect(after.totals).toEqual(whole.totals);
  });
});

describe("two judges on one run both send calls and write over each other", () => {
  it("refuses a second judge while the first holds the run's judge lock, before any call, and gives the lock back on exit", async () => {
    const fake = await provider();
    const env = { OPENQODEX_BENCH_MODEL_ENV: settingsFile(fake.baseUrl) };
    const held = await savedRun();
    // This test's own process is alive, so its lock is held.
    writeFileSync(join(held, "judge.lock"), `${process.pid}\n`);
    const second = await judge(held, { env });
    expect(second.code).toBe(2);
    expect(oneLine(second.stderr), second.stderr).toBe(true);
    expect(second.stderr).toMatch(/^refused: .*another judge/);
    expect(fake.requests).toHaveLength(0);
    expect(readFileSync(join(held, "judge.lock"), "utf8").trim()).toBe(String(process.pid));
    const free = await savedRun();
    expect((await judge(free, { env })).code).toBe(0);
    expect(existsSync(join(free, "judge.lock"))).toBe(false);
  });
});

describe("a malformed judge.json changes the score command's exit or its score", () => {
  it("scores a run whose judge.json does not hold samples the same as a run with none, with the wording null and one line naming the file", async () => {
    const out = await savedRun();
    const score = (name, args = []) => {
      const dir = join(tempDir("oq-judge-bad-"), name);
      const r = spawnSync(process.execPath, [SCORE, out, "--out", dir, ...args], { encoding: "utf8" });
      return { r, text: existsSync(join(dir, "score.json")) ? readFileSync(join(dir, "score.json"), "utf8") : null };
    };
    const none = score("none");
    writeFileSync(join(out, "judge.json"), JSON.stringify({ samples: [null] }));
    const bad = score("bad");
    expect([bad.r.status, none.r.status]).toEqual([0, 0]);
    expect(bad.text).toBe(none.text);
    expect(JSON.parse(bad.text).byConfig[CONFIG].wording).toBeNull();
    expect(oneLine(bad.r.stderr), bad.r.stderr).toBe(true);
    expect(bad.r.stderr).toMatch(/judge\.json/);
    expect(() => scoreRun(loadRun(out))).not.toThrow();
    // A --judge file that cannot be read is the same: a warning, never another exit.
    const missing = score("missing", ["--judge", join(tempDir("oq-judge-none-"), "judge.json")]);
    expect(missing.r.status).toBe(0);
    expect(missing.text).toBe(none.text);
  });
});

