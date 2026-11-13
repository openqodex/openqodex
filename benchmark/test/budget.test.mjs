// The run's budget (benchmark/lib/budget.mjs): hard caps that bind every
// model call the harness makes, a reservation ledger every process of a run
// shares, and forecast stops kept apart from the caps; and the scanner
// preflight that says whether a run had every scanner its cases need.
//
// The model provider is the only stand-in: a local HTTP server that answers
// in the Responses shape and bills each request as the most it could cost:
// its input tokens are the UTF-8 bytes it received (no tokenizer yields more
// tokens than bytes) and its output is the whole max_output_tokens
// allowance. The brain's own call loop (callModel, from the built package)
// asks the budget before every call, and the real adapter sends it. The
// scanner preflight runs the real CLI's doctor on real planted cases.
//
// Failures guarded, written before the code:
// 1. A run spends past its hard cap.
// 2. Two concurrent reviews both authorise against the same remaining budget.
// 3. The worst-case token count is below the real count.
// 4. Judge calls are left out of the run cap.
// 5. A run stopped by budget is accepted as a full run.
// 6. A model run on a machine without Ruby or Go is accepted as having every
//    scanner.
// From the review of the first version: a dead process's lock taken over by
// two processes at once; the manifest saying judge calls are inside the cap
// while judge.mjs sends them outside it; calls still reserved and sent after
// one overran its worst case; a scanner switched off by offline mode counted
// as present; an index entry accepted after a budget stop or without every
// scanner; and the Ruby and Go case tested with Ruby and Go still on PATH.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { callModel, MODEL_SYSTEM } from "../../packages/review/dist/index.js";
import { buildCase, repoRoot } from "../lib/cases.mjs";
import { buildEntry, entryProblems } from "../lib/index.mjs";
import { BudgetRefused, estimateRun, manifestBudget, meteredComplete, openLedger, openRunLedger, readLedger, runBudget, startRefusals, worstCaseUsd } from "../lib/budget.mjs";
import { createOpenAIReviewer } from "../lib/openai-reviewer.mjs";
import { attemptDir, executeRun, planJobs, preflightRefusals, runManifest, sampleRecord, scannerPreflight } from "../lib/runner.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const PRICES = JSON.parse(readFileSync(new URL("../outside/prices.json", import.meta.url), "utf8")).models;
const SOL = PRICES["gpt-6.1-sol"];
const KEY = `test-model-key-${randomBytes(16).toString("hex")}`;
const budgetModule = new URL("../lib/budget.mjs", import.meta.url).href;

// --- the model provider stand-in ---

const servers = [];
// Bills every request at the most it could cost, and remembers each bill.
async function provider({ delayMs = 0, inflate = 1 } = {}) {
  const bills = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = Buffer.byteLength(raw, "utf8") * inflate;
    const output = body.max_output_tokens;
    const rates = PRICES[body.model];
    bills.push({ model: body.model, input, output, usd: (input * rates.input + output * rates.output) / 1e6 });
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `resp_${randomBytes(6).toString("hex")}`,
        object: "response",
        status: "completed",
        model: `${body.model}-served`,
        output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
        usage: { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output },
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const billed = () => bills.reduce((sum, b) => sum + b.usd, 0);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/openai/v1`, bills, billed };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

const adapter = (baseUrl, model = "gpt-6.1-sol", maxOutputTokens = 2000) => createOpenAIReviewer({ model, baseUrl, apiKey: KEY, authHeader: "api-key", maxOutputTokens, allowUnprobed: true });
const messages = (text) => [{ role: "system", text: MODEL_SYSTEM }, { role: "user", text }];
const BRIEF = `Review the change. ${"The handler reads the path from the query string and opens it. ".repeat(60)}`;

// --- a run folder, as run.mjs gives executeRun ---

const spec = (name) => ({ id: name, guards: "g", language: "python", framework: "none", clean: false, bugs: [{ id: "sqli", file: "app.py", lines: [4, 4], anchor: { line: 4, text: "x" }, mentions: ["sql"], kind: ["security"], severity: "critical", found_by: ["reasoning"], truth: "t" }] });
const report = (status, missing = []) => ({ findings: [], outside_change: [], dropped: [], completion: { status, missing } });

function runInputs({ cases = 6, reviewers = ["model"], budget }) {
  const root = tempDir("oq-bench-budget-");
  const names = Array.from({ length: cases }, (_, i) => `case${i + 1}`);
  const caseIds = Object.fromEntries(names.map((n, i) => [n, `planted/${n}@${String(i + 1).repeat(8)}`]));
  const copies = names.map((n) => {
    const file = join(root, `${n}.json`);
    writeFileSync(file, JSON.stringify(spec(n)));
    return [file, `cases/${n}.json`];
  });
  const { configs, jobs } = planJobs({ cases: names, caseIds, reviewers, graph: ["on"], repeat: 1 });
  const manifest = runManifest({ startedAt: "2026-10-11T10:00:00.000Z", settings: { cases: names, caseIds: names.map((n) => caseIds[n]), configs: configs.map((c) => c.id), repeat: 1, budget, scannersComplete: true }, jobs });
  return { out: join(root, "run"), jobs, manifest, copies };
}

function saveAttempt(out, job, attempt, rep, usage = null) {
  const dir = attemptDir(out, job, attempt);
  mkdirSync(join(dir, "report"), { recursive: true });
  const withUsage = usage ? { ...rep, completion: { ...rep.completion, reviewer: { usage } } } : rep;
  writeFileSync(join(dir, "sample.json"), JSON.stringify(sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt, result: { code: 0, signal: null, wallMs: 1000 }, report: withUsage, who: null, startedAt: "t", failure: null, stopped: null })));
  writeFileSync(join(dir, "report", "report.json"), JSON.stringify(withUsage));
}

// One model review the way the server path makes it: the brain's call loop,
// asking the review's budget before each call, through the metered adapter.
// `calls` calls; the review ends incomplete at the first refusal.
const modelReview = (fake, out, calls) => async (job, attempt, review) => {
  const caller = callModel({ reviewer: review.wrap(adapter(fake.baseUrl)), role: "primary", budget: { authorize: review.authorize, deadlineMs: 60_000 }, now: Date.now });
  for (let i = 0; i < calls; i++) {
    const answer = await caller.call("brief", messages(BRIEF), () => {});
    if (answer.failure) return saveAttempt(out, job, attempt, report("incomplete", [answer.failure]));
  }
  saveAttempt(out, job, attempt, report("complete"));
};

const hard = (maxUsd, reviewMaxUsd) => ({ hardCaps: { maxUsd, reviewMaxUsd }, forecastStops: { maxMinutes: 60, maxTokens: null, maxReviews: null, estimate: null }, judgeIncluded: true });

describe("a run spends past its hard cap", () => {
  it("stops with --max-usd 0.3 as a budget stop, and spent plus reserved never passes 0.3 while two reviews run at once", async () => {
    const fake = await provider({ delayMs: 30 });
    const { out, jobs, manifest, copies } = runInputs({ cases: 6, budget: hard(0.3, 0.12) });
    const budget = runBudget({ dir: out, caps: { maxUsd: 0.3, reviewMaxUsd: 0.12 }, forecast: { maxMinutes: 60 }, path: "server", prices: PRICES });
    const { ended } = await executeRun({ out, manifest, jobs, copies, concurrency: 2, budget, runJob: modelReview(fake, out, 2) });
    expect(ended).toMatchObject({ how: "budget", limit: "max-usd", limitKind: "hard" });
    expect(ended.why).toMatch(/0\.3/);
    // The ledger, replayed event by event, never held more than the cap, and every bill is in it.
    const ledger = readLedger(out);
    expect(ledger.peakUsd).toBeLessThanOrEqual(0.3);
    expect(ledger.reservedUsd).toBe(0);
    expect(fake.billed()).toBeLessThanOrEqual(0.3);
    expect(ledger.spentUsd).toBeCloseTo(fake.billed(), 6);
    expect(ended.spentUsd).toBeCloseTo(fake.billed(), 6);
    expect(ended.reservedUsd).toBe(0);
    // The cap stopped the launches, not a review half way: every saved review completed.
    const saved = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(saved.ended.how).toBe("budget");
    const run = loadRun(out);
    expect(run.samples.length).toBeGreaterThan(0);
    expect(run.samples.length).toBeLessThan(jobs.length);
    expect(run.samples.every((s) => s.status === "complete")).toBe(true);
  });

  it("refuses a call whose worst case does not fit, keeps the whole reservation of a call that reports no cost or throws, and refuses a run that cannot hold one review", () => {
    const dir = tempDir("oq-bench-ledger-");
    const ledger = openLedger(dir, { maxUsd: 1, reviewMaxUsd: 0.5 });
    const review = ledger.openReview({ jobId: "j1", attempt: 1 });
    expect(review.ok).toBe(true);
    const id = review.reserveCall("primary-1", 0.3);
    expect(id).not.toBeNull();
    // Over the review's cap: refused, nothing reserved.
    expect(review.reserveCall("primary-2", 0.3)).toBeNull();
    // No cost reported: the whole reservation counts as spent.
    review.settleCall("primary-1", null);
    expect(ledger.state().spentUsd).toBeCloseTo(0.3, 9);
    review.close();
    expect(ledger.state()).toMatchObject({ reservedUsd: 0 });
    // The run's cap cannot hold one more review: a stop, not a wait.
    const again = openLedger(dir, { maxUsd: 0.6, reviewMaxUsd: 0.5 }).openReview({ jobId: "j2", attempt: 1 });
    expect(again).toMatchObject({ ok: false, wait: false });
    // An estimate over the hard cap refuses the run before it starts; --allow-over passes a forecast, never the cap one review needs.
    const estimate = estimateRun({ jobs: [{ config: "claude-graph-on" }, { config: "claude-graph-on" }], suite: "planted", path: "laptop", concurrency: 1, index: [] });
    expect(estimate.usd).toBeGreaterThan(0);
    expect(startRefusals({ estimate, caps: { maxUsd: estimate.usd / 2 }, forecast: { maxMinutes: 600 }, spentUsd: 0 }).join("\n")).toMatch(/--max-usd/);
    expect(startRefusals({ estimate, caps: { maxUsd: estimate.usd / 2 }, forecast: { maxMinutes: 600 }, spentUsd: 0, allowOver: true })).toEqual([]);
    expect(startRefusals({ estimate, caps: { maxUsd: 1, reviewMaxUsd: 3 }, forecast: { maxMinutes: 600 }, spentUsd: 0, allowOver: true, path: "server" }).join("\n")).toMatch(/--review-max-usd/);
  });
});

describe("two concurrent reviews both authorise against the same remaining budget", () => {
  it("lets one of three processes reserve the last room in the run's ledger, never two", async () => {
    const dir = tempDir("oq-bench-race-");
    const go = join(dir, "go");
    const done = join(dir, "done");
    // Each process stays alive until all have answered: a reservation of a process that has ended is given back, rightly.
    const child = () =>
      new Promise((finished) => {
        const code = `
          import { existsSync, writeFileSync } from "node:fs";
          import { openLedger } from ${JSON.stringify(budgetModule)};
          const ledger = openLedger(${JSON.stringify(dir)}, { maxUsd: 1, reviewMaxUsd: 0.6 });
          while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 1));
          const r = ledger.openReview({ jobId: "j" + process.pid });
          writeFileSync(${JSON.stringify(dir)} + "/answer-" + process.pid, JSON.stringify({ ok: r.ok === true }));
          while (!existsSync(${JSON.stringify(done)})) await new Promise((r) => setTimeout(r, 5));
        `;
        const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", () => finished({ pid: p.pid, stderr }));
      });
    const runs = [child(), child(), child()];
    await new Promise((wake) => setTimeout(wake, 300));
    writeFileSync(go, "");
    const answerFiles = () => readdirSync(dir).filter((f) => f.startsWith("answer-"));
    for (let i = 0; i < 1000 && answerFiles().length < 3; i++) await new Promise((wake) => setTimeout(wake, 10));
    const answers = answerFiles().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    writeFileSync(done, "");
    for (const r of await Promise.all(runs)) expect(r.stderr).toBe("");
    expect(answers).toHaveLength(3);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(readLedger(dir).peakUsd).toBeLessThanOrEqual(1);
  });

  it("lets exactly one of the processes that find a dead process's lock take it over, so no two hold the ledger at once", async () => {
    // Several trials, each a lock left by a process that has ended and six
    // processes that start together; each holds the ledger for 15 ms and
    // logs when it enters and leaves. Every hold must end before the next.
    for (let trial = 0; trial < 6; trial++) {
      const dir = tempDir("oq-bench-stale-");
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      writeFileSync(join(dir, "budget.lock"), `${dead}\n`);
      const go = join(dir, "go");
      const log = join(dir, "holds.log");
      const child = () =>
        new Promise((finished) => {
          const code = `
            import { appendFileSync, existsSync } from "node:fs";
            import { openLedger } from ${JSON.stringify(budgetModule)};
            const ledger = openLedger(${JSON.stringify(dir)}, { maxUsd: 1, reviewMaxUsd: 0.6 });
            while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 1));
            ledger.step(() => {
              appendFileSync(${JSON.stringify(log)}, "in " + process.pid + "\\n");
              const until = Date.now() + 15;
              while (Date.now() < until) {}
              appendFileSync(${JSON.stringify(log)}, "out " + process.pid + "\\n");
            });
          `;
          const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          p.stderr.on("data", (d) => (stderr += d));
          p.on("close", () => finished(stderr));
        });
      const runs = Array.from({ length: 6 }, child);
      await new Promise((wake) => setTimeout(wake, 300));
      writeFileSync(go, "");
      for (const stderr of await Promise.all(runs)) expect(stderr).toBe("");
      const holds = readFileSync(log, "utf8").trim().split("\n");
      expect(holds).toHaveLength(12);
      for (let i = 0; i < holds.length; i += 2) expect([holds[i], holds[i + 1]]).toEqual([holds[i], holds[i].replace(/^in /, "out ")]);
    }
  });

  it("holds two reviews' calls inside one run cap when both run at once against a slow provider", async () => {
    const fake = await provider({ delayMs: 50 });
    const out = tempDir("oq-bench-two-");
    const ledger = openLedger(out, { maxUsd: 0.25, reviewMaxUsd: 0.12 });
    const a = ledger.openReview({ jobId: "a", attempt: 1 });
    const b = ledger.openReview({ jobId: "b", attempt: 1 });
    expect(a.ok && b.ok).toBe(true);
    // A third review finds no room while the two hold theirs: it waits rather than stopping the run.
    expect(ledger.openReview({ jobId: "c", attempt: 1 })).toMatchObject({ ok: false, wait: true });
    const run = async (review) => {
      const caller = callModel({ reviewer: review.wrap(adapter(fake.baseUrl)), role: "primary", budget: { authorize: review.authorize, deadlineMs: 60_000 }, now: Date.now });
      const outcomes = [];
      for (let i = 0; i < 4; i++) outcomes.push(await caller.call("brief", messages(BRIEF), () => {}));
      review.close();
      return outcomes;
    };
    const [ra, rb] = await Promise.all([run(a), run(b)]);
    // Each review stopped at its own cap; together they never passed the run's.
    for (const outcomes of [ra, rb]) expect(outcomes.some((o) => /budget/i.test(o.failure ?? ""))).toBe(true);
    expect(fake.billed()).toBeLessThanOrEqual(0.25);
    expect(readLedger(out).peakUsd).toBeLessThanOrEqual(0.25);
  });
});

describe("the worst-case token count is below the real count", () => {
  it("reserves at least what a request of non-ASCII text can be billed, where a count of characters would fall short", async () => {
    const fake = await provider();
    const out = tempDir("oq-bench-bytes-");
    const ledger = openLedger(out, { maxUsd: 5, reviewMaxUsd: 2 });
    const review = ledger.openReview({ jobId: "j", attempt: 1 });
    const text = `检查这个处理函数：路径来自查询字符串。🔒🔑 ${"读取文件前没有检查路径。".repeat(400)}`;
    let asked = null;
    const authorize = async (call) => {
      asked = call;
      return review.authorize(call);
    };
    const caller = callModel({ reviewer: review.wrap(adapter(fake.baseUrl)), role: "primary", budget: { authorize, deadlineMs: 60_000 }, now: Date.now });
    const answer = await caller.call("brief", messages(text), () => {});
    expect(answer.failure).toBeUndefined();
    const bill = fake.bills[0];
    const reserved = readLedger(out).events.find((e) => e.op === "reserve" && e.kind === "call");
    // The reservation covers the bill; counting characters as tokens would not have.
    expect(reserved.usd).toBeGreaterThanOrEqual(bill.usd);
    expect(worstCaseUsd({ requestBytes: asked.requestChars, maxOutputTokens: asked.maxOutputTokens, rates: SOL })).toBeLessThan(bill.usd);
    expect(readLedger(out).overruns).toEqual([]);
    review.close();
  });

  it("refuses every later reservation and every unsent call once a call reserved at 0.10 reports 0.20 inside a 0.60 envelope, the judge's included", async () => {
    const dir = tempDir("oq-bench-overrun-");
    const ledger = openLedger(dir, { maxUsd: 2, reviewMaxUsd: 0.6 });
    const review = ledger.openReview({ jobId: "j" });
    expect(review.reserveCall("primary-1", 0.1)).not.toBeNull();
    // Reserved before the overrun, not sent yet.
    expect(review.reserveCall("primary-2", 0.1)).not.toBeNull();
    review.settleCall("primary-1", 0.2);
    expect(readLedger(dir).overruns).toHaveLength(1);
    // The envelope has room left (0.20 spent, 0.10 held of 0.60), and still nothing more is reserved or sent.
    expect(review.reserveCall("primary-3", 0.05)).toBeNull();
    let sent = 0;
    const provider = { kind: "model", model: "gpt-6.1-sol", maxOutputTokens: 100, complete: async () => (sent++, { message: { text: "x", toolCalls: [] }, usage: { model: "gpt-6.1-sol", inputTokens: 1, outputTokens: 1, costUsd: 0.00001 } }) };
    const call = (callId) => ({ callId, attempt: 1, purpose: "brief", messages: messages("x"), tools: [], maxOutputTokens: 100 });
    await expect(review.wrap(provider).complete(call("primary-2"))).rejects.toThrow(/worst case/);
    expect(ledger.reserve({ usd: 0.01, kind: "judge" })).toBeNull();
    await expect(meteredComplete(ledger, provider, call("judge-1"), { prices: PRICES })).rejects.toThrow(BudgetRefused);
    expect(ledger.openReview({ jobId: "k" })).toMatchObject({ ok: false, wait: false });
    expect(sent).toBe(0);
    review.close();
    // The unsent call gave its reservation back; only what was billed counts as spent.
    expect(readLedger(dir)).toMatchObject({ reservedUsd: 0 });
    expect(readLedger(dir).spentUsd).toBeCloseTo(0.2, 9);
  });

  it("stops the run when a call costs more than its worst case, since the bound is wrong", async () => {
    const fake = await provider({ inflate: 4 });
    const { out, jobs, manifest, copies } = runInputs({ cases: 2, budget: hard(5, 2) });
    const budget = runBudget({ dir: out, caps: { maxUsd: 5, reviewMaxUsd: 2 }, forecast: { maxMinutes: 60 }, path: "server", prices: PRICES });
    const { ended } = await executeRun({ out, manifest, jobs, copies, budget, runJob: modelReview(fake, out, 1) });
    expect(ended).toMatchObject({ how: "budget", limitKind: "hard" });
    expect(ended.why).toMatch(/more than its worst case/);
    expect(readLedger(out).overruns).toHaveLength(1);
  });
});

describe("judge calls are left out of the run cap", () => {
  it("counts a judge call made later, by another script, against the run's cap, and refuses one whose worst case does not fit", async () => {
    const fake = await provider();
    const { out, jobs, manifest, copies } = runInputs({ cases: 2, budget: hard(0.2, 0.08) });
    const budget = runBudget({ dir: out, caps: { maxUsd: 0.2, reviewMaxUsd: 0.08 }, forecast: { maxMinutes: 60 }, path: "server", prices: PRICES });
    await executeRun({ out, manifest, jobs, copies, budget, runJob: modelReview(fake, out, 1) });
    const afterReviews = readLedger(out).spentUsd;
    expect(afterReviews).toBeGreaterThan(0);
    // The judge opens the run's ledger from the run folder, with the run's caps.
    const judge = adapter(fake.baseUrl, "gpt-5.2", 1000);
    const small = { callId: "judge-1", attempt: 1, purpose: "brief", messages: messages("Is the sentence plain? The path is not checked."), tools: [], maxOutputTokens: 1000 };
    const answered = await meteredComplete(openRunLedger(out), judge, small, { prices: PRICES, what: "wording judge" });
    expect(answered.message.text).toBe("done");
    expect(readLedger(out).spentUsd).toBeCloseTo(afterReviews + fake.bills.at(-1).usd, 6);
    // A judge call whose worst case passes the cap is refused before anything is sent.
    const sent = fake.bills.length;
    const big = { ...small, callId: "judge-2", maxOutputTokens: 20_000 };
    await expect(meteredComplete(openRunLedger(out), adapter(fake.baseUrl, "gpt-5.2", 20_000), big, { prices: PRICES, what: "wording judge" })).rejects.toThrow(BudgetRefused);
    expect(fake.bills.length).toBe(sent);
    expect(readLedger(out).peakUsd).toBeLessThanOrEqual(0.2);
  });
});

// A laptop run stopped by its forecast on --max-usd 0.3: 0.12 a review, so
// two start and three never do. Its saved manifest and its score.
async function stoppedRun() {
  const { out, jobs, manifest, copies } = runInputs({ cases: 5, reviewers: ["claude"], budget: hard(0.3, null) });
  const estimate = estimateRun({ jobs, suite: "planted", path: "laptop", concurrency: 1, index: [] });
  const budget = runBudget({ dir: out, caps: { maxUsd: 0.3 }, forecast: { maxMinutes: 60 }, estimate, path: "laptop", prices: PRICES });
  const runJob = async (job, attempt) => {
    saveAttempt(out, job, attempt, report("complete"), { cost_usd: 0.12, input_tokens: 1000, output_tokens: 100 });
    budget.recordReview({ jobId: job.jobId, usd: 0.12, tokens: 1100, wallMs: 1000 });
  };
  const { ended } = await executeRun({ out, manifest, jobs, copies, budget, runJob });
  const saved = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  const { score } = scoreRun(loadRun(out));
  return { ended, saved, score };
}

describe("judge calls are left out of the run cap, while the manifest says they are in", () => {
  it("records judgeIncluded true only when benchmark/judge.mjs sends its calls through the run's ledger", () => {
    const judge = readFileSync(new URL("../judge.mjs", import.meta.url), "utf8");
    const usesLedger = /import\s*\{[^}]*\bmeteredComplete\b[^}]*\}\s*from\s*"\.\/lib\/budget\.mjs"/.test(judge);
    expect(manifestBudget({ caps: { maxUsd: 1, reviewMaxUsd: null }, forecast: { maxMinutes: 10 }, estimate: null }).judgeIncluded).toBe(usesLedger);
  });
});

describe("a run stopped by budget is accepted as a full run", () => {
  it("records a forecast stop as ended budget in the manifest, the index entry and the score, with the reviews never started counted", async () => {
    const { ended, saved, score } = await stoppedRun();
    // 0.12 + 0.12 spent; a third at the median would pass 0.3, so none starts.
    expect(ended).toMatchObject({ how: "budget", limit: "max-usd", limitKind: "forecast", reviewsWithAnAttempt: 2 });
    expect(ended.spentUsd).toBeCloseTo(0.24, 9);
    expect(saved.ended.how).toBe("budget");
    expect(score.byConfig["claude-graph-on"].population).toMatchObject({ planned: 5, unstarted: 3 });
    const entry = buildEntry({ runId: "2026-10-11-abcdef0", manifest: saved, resumes: [], score, asset: null, privateListHash: null });
    expect(entry.ended.how).toBe("budget");
    expect(entry.ended.how).not.toBe("finished");
  });

  it("rejects an index entry marked accepted that ended by its budget, or without every scanner, and takes one that finished with all of them", async () => {
    const { saved, score } = await stoppedRun();
    const entry = buildEntry({ runId: "2026-10-11-abcdef0", manifest: saved, resumes: [], score, asset: null, privateListHash: null });
    const accepted = { ...entry, accepted: true, acceptedAt: "2026-10-11T12:00:00.000Z", acceptedBy: "Sid" };
    const about = (e, re) => entryProblems(e).filter((p) => re.test(p));
    expect(about({ ...accepted, ended: { how: "budget", why: "forecast stop --max-usd $0.3" }, scannersComplete: true }, /finished/)).toHaveLength(1);
    expect(about({ ...accepted, ended: { how: "finished", why: null }, scannersComplete: false }, /scanner/)).toHaveLength(1);
    expect(about({ ...accepted, ended: { how: "finished", why: null }, scannersComplete: null }, /scanner/)).toHaveLength(1);
    const full = { ...accepted, ended: { how: "finished", why: null }, scannersComplete: true };
    expect(about(full, /finished|scanner/)).toEqual([]);
    // Not accepted, a stopped run is a sound entry: it is listed, never a baseline.
    expect(about({ ...entry, scannersComplete: false }, /finished|scanner/)).toEqual([]);
  });
});

// Where git lives on this machine, to put it alone on a bare PATH.
const gitPath = () => (process.env.PATH ?? "").split(":").map((d) => join(d, "git")).find((p) => existsSync(p));

describe("a model run on a machine without Ruby or Go is accepted as having every scanner", () => {
  it("finds the Ruby and Go scanners a Rails and a Go case need missing, refuses the run, and with --allow-missing-scanners records it incomplete", () => {
    const cli = join(repoRoot, "packages/cli/dist/bin.js");
    expect(existsSync(cli)).toBe(true);
    const root = tempDir("oq-bench-preflight-");
    const home = join(root, "home");
    mkdirSync(home);
    const repos = ["rails-controller-model", "go-http-handler"].map((c) => ({ case: c, dir: buildCase(c, join(root, c, "repo")).dir }));
    // A real machine without Ruby or Go: a PATH that holds node and git and
    // nothing else (no system, rvm or Homebrew ruby, no go), none of the
    // Ruby variables, and an empty tools folder.
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(gitPath(), join(bin, "git"));
    const env = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: bin, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0" };
    expect(spawnSync("ruby", ["--version"], { env }).error?.code).toBe("ENOENT");
    expect(spawnSync("go", ["version"], { env }).error?.code).toBe("ENOENT");
    const preflight = scannerPreflight({ cli, repos, env });
    expect(preflight.complete).toBe(false);
    const state = (c, s) => preflight.missing.find((m) => m.case === c && m.scanner === s)?.state;
    expect(state("rails-controller-model", "brakeman")).toBe("needs_runtime");
    expect(state("rails-controller-model", "rubocop")).toBe("needs_runtime");
    expect(state("go-http-handler", "golangci")).toBe("needs_runtime");
    expect(preflight.needed["rails-controller-model"]).toEqual(expect.arrayContaining(["brakeman", "rubocop"]));
    const refusals = preflightRefusals(preflight, { allowMissing: false });
    expect(refusals.join("\n")).toMatch(/brakeman, which is missing its runtime/);
    expect(refusals.join("\n")).toMatch(/--allow-missing-scanners/);
    expect(preflightRefusals(preflight, { allowMissing: true })).toEqual([]);
    // Let through, the run says so in its manifest and its index entry.
    const manifest = runManifest({ startedAt: "2026-10-11T10:00:00.000Z", settings: { scannersComplete: preflight.complete, scannersMissing: preflight.missing }, jobs: [] });
    expect(manifest.scannersComplete).toBe(false);
    const entry = buildEntry({ runId: "2026-10-11-abcdef0", manifest, resumes: [], score: { byConfig: {} }, asset: null, privateListHash: null });
    expect(entry.scannersComplete).toBe(false);
  });

  it("counts a scanner the case calls for as missing when offline mode switches it off (OPENQODEX_OFFLINE=1, osv-scanner)", () => {
    const cli = join(repoRoot, "packages/cli/dist/bin.js");
    const root = tempDir("oq-bench-offline-");
    const home = join(root, "home");
    mkdirSync(home);
    // demo-polyglot holds a lockfile, so its files call for osv-scanner.
    const repos = [{ case: "demo-polyglot", dir: buildCase("demo-polyglot", join(root, "demo-polyglot", "repo")).dir }];
    const env = { ...process.env, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0", OPENQODEX_OFFLINE: "1" };
    const preflight = scannerPreflight({ cli, repos, env });
    expect(preflight.needed["demo-polyglot"]).toContain("osv-scanner");
    expect(preflight.missing.find((m) => m.scanner === "osv-scanner")).toMatchObject({ case: "demo-polyglot", state: "offline" });
    expect(preflight.complete).toBe(false);
    expect(preflightRefusals(preflight, { allowMissing: false }).join("\n")).toMatch(/osv-scanner, which offline mode switches off/);
  });
});
