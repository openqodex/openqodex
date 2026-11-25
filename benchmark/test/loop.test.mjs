// The reviewer loop's driver (benchmark/loop.mjs) with its stage rules
// (loop/stages.mjs) and its ledger (loop/ledger.mjs). Each failure is
// guarded end to end: the driver is run as a person runs it.
//
// Two kinds of runs feed it. Where the driver must make runs, it invokes
// run.mjs, and run.mjs reviews with the scripted model, the only stand-in.
// The scripted model's script carries prices, so every review costs what a
// real model at those prices would cost, and the budget ledger, the daily
// cap and the spend in the reviewer ledger are the real ones. A scripted
// run is never evidence about a change, so where a test needs the rule to
// stop or decide, the runs are saved score sets: run folders written by the
// runner's own code (executeRun) with reports the test writes, their spend
// recorded by lib/budget.mjs, as the plan's check feeds the loop "saved
// adverse score sets".
//
// The checkout the driver runs is a clone of this repository at HEAD with
// the built CLI copied in and its provenance recorded, as
// benchmark/build-cli.mjs records it, so run.mjs runs the build it checks.
// Its runs read an empty scanner folder, so no scanner runs: these tests
// prove the driver, not the reviews.
//
// Failures guarded, written before the code:
// 1. An iteration behind after stage 1 spends through stage 3: a candidate
//    worse than its parent at stage 1 must stop there, with its look and
//    what it spent in the ledger, and no later step may run anything.
// 2. The loop reads a test-split run: a held-out run named as a parent or a
//    candidate must be refused before a sample of it is read, with nothing
//    run and nothing written.
// 3. Two iterations take one look number: two changes deciding at once must
//    take looks 1 and 2, each with its own alpha.
// 4. The daily cap is exceeded by a stage 2 decision that was forecast
//    under it: the room left of the day's 60 server dollars must bind the
//    run as a hard cap, so the day's spend stays inside it whatever the
//    forecast said.
// 5. A lever is chosen after the earliest-failure signal said stop: while
//    the last baseline's signal says stop, or no baseline carries one,
//    neither a proposal nor a step goes through.
// 6. The day's room leaves out spend already on disk: a candidate run that
//    spent before the ledger named it must count against the room before a
//    stage starts more reviews.
// 7. A second change enters stage 2 while one is there: the check must hold
//    at the moment the line is written, under the ledger lock.
// 8. A step that died leaves its run.mjs spending, and the next step takes
//    the run lock over: the lock is live while the run.mjs it names is.
// 9. A scripted screen stops a change as evidence: runs of the scripted
//    model record no evidence and neither stop nor pass a change.
// 10. run.mjs leaves its temp root (oq-bench-run-*) behind when it is
//    stopped (issue 237): SIGTERM before or during the reviews must leave
//    none. A forced kill cannot be caught, so every child these tests start
//    gets a temp folder of its own under the test's, removed once the child
//    has ended.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/cases.mjs";
import { openLedger } from "../lib/budget.mjs";
import { bundleHash, executeRun, planJobs, runManifest, sampleRecord, treeState } from "../lib/runner.mjs";
import { ruleHash } from "../loop/decide.mjs";
import { lockLedger } from "../loop/propose.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const LOOP = fileURLToPath(new URL("../loop.mjs", import.meta.url));
const CASE = "flask-path-traversal";
const LOSSES = { recall: 2, criticalMajorRecall: 2, precision: 2, severityAgreement: 3, incompleteRate: 2, redundancy: 5, cleanFindings: 0.1, costPerReview: 0.15, secondsPerReview: 0.2 };
// This case needs two finder calls and no verifier when findings are empty.
// Each fills its 30 token allowance at $500 per million, costing $0.015.
// The $0.03 review cap fits both calls so these tests reach the loop rules.
const SCRIPT = { version: 1, model: "scripted", served: "scripted-1", prices: { input: 0, cachedInput: 0, output: 500 }, summary: "The scripted model's answer.", findings: [], dropReason: "The scripted model drops every candidate; it reads no code.", reply: null };
const REVIEW_MAX_USD = 0.03;
const MAX_OUTPUT_TOKENS = 30;
// The reviewer of the saved score sets: a real deployment's name, no script.
const REAL = "model:gpt-6.1-sol";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const readLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeLines = (path, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
};
const appendLine = (path, line) => appendFileSync(path, `${JSON.stringify(line)}\n`);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const wait = (ms) => new Promise((wake) => setTimeout(wake, ms));

let root;
let checkout;
let head;
let script;
let tools;
let parentRun;

// A clone of this repository at HEAD with the build of this checkout copied
// in, its packages' node_modules linked, and benchmark/.build/provenance.json
// written the way benchmark/build-cli.mjs writes it.
function makeCheckout(dest) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", repoRoot, dest]);
  execFileSync("git", ["checkout", "-q", "--detach", head], { cwd: dest });
  const built = ["dist", "wasm", "lenses", "locks", "demo", "docs", "skills", "toolchain.json", "README.md", "LICENSE", "NOTICE"];
  for (const p of built) if (existsSync(join(repoRoot, "packages/cli", p))) cpSync(join(repoRoot, "packages/cli", p), join(dest, "packages/cli", p), { recursive: true });
  for (const pk of readdirSync(join(repoRoot, "packages"))) if (existsSync(join(repoRoot, "packages", pk, "dist")) && pk !== "cli") cpSync(join(repoRoot, "packages", pk, "dist"), join(dest, "packages", pk, "dist"), { recursive: true });
  appendFileSync(join(dest, ".git/info/exclude"), "node_modules\n");
  for (const d of [".", ...readdirSync(join(repoRoot, "packages")).map((p) => `packages/${p}`)]) if (existsSync(join(repoRoot, d, "node_modules"))) symlinkSync(join(repoRoot, d, "node_modules"), join(dest, d, "node_modules"));
  const t = treeState(dest);
  writeJson(join(dest, "benchmark/.build/provenance.json"), { version: 1, commit: t.commit, tree: t.tree, commitTree: t.commitTree, dirty: t.dirty, bundleHash: bundleHash(join(dest, "packages/cli")), builtAt: new Date().toISOString(), node: process.version });
  return t.commit;
}

// A temp folder for one child and every process it starts (its TMPDIR),
// under the test's own temp folder: `done` removes it once the child has
// ended, and a child killed mid-run leaves its folders there (failure 10).
function scratch() {
  mkdirSync(join(root, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, "tmp", "child-"));
  return { dir, env: { ...process.env, TMPDIR: dir }, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

// The arguments of one run of the checkout's run.mjs, the way the driver runs it.
const benchArgs = (out, args) => [join(checkout, "benchmark/run.mjs"), "--reviewers", "model:scripted", "--cases", CASE, "--max-usd", "1", "--max-minutes", "30", "--review-max-usd", String(REVIEW_MAX_USD), "--max-output-tokens", String(MAX_OUTPUT_TOKENS), "--model-script", script, "--install-root", tools, "--allow-missing-scanners", "--out", out, ...args];
function runBench(out, args) {
  const s = scratch();
  const p = spawnSync(process.execPath, benchArgs(out, args), { encoding: "utf8", cwd: checkout, env: s.env });
  s.done();
  if (p.status !== 0) throw new Error(`run.mjs failed (exit ${p.status}):\n${p.stdout}\n${p.stderr}`);
  return out;
}

// A copy of a run folder under a new run id, its manifest edited by `edit`.
function copyRun(from, runId, edit = (m) => m) {
  const to = join(root, "runs", runId);
  cpSync(from, to, { recursive: true });
  writeJson(join(to, "manifest.json"), edit({ ...readJson(join(to, "manifest.json")), runId }));
  return to;
}

// A saved score set: a run folder of `n` planted-style cases with one
// critical bug each and a clean one, written by the runner's own code
// (executeRun) on the server path with a real reviewer's name. `found(c, r)`
// says whether review r of case c finds its bug; `cleanFalse` puts a finding
// on the clean case in every review. Each review's cost is recorded in the
// run's budget ledger by lib/budget.mjs.
async function savedSet({ runId, commit = head, changeId = null, found, repeat = 3, cost = 0.01, n = 6, cleanFalse = false }) {
  const out = join(root, "sets", runId);
  const specs = join(root, "sets", `${runId}-specs`);
  const names = [...Array.from({ length: n }, (_, i) => `case-${String(i).padStart(2, "0")}`), "clean-00"];
  const hashes = Object.fromEntries(names.map((x) => [x, sha(x)]));
  const caseIds = Object.fromEntries(names.map((x) => [x, `planted/${x}@${hashes[x].slice(0, 8)}`]));
  for (const x of names) writeJson(join(specs, `${x}.json`), { id: x, guards: "g", language: "python", framework: "none", clean: x.startsWith("clean"), bugs: x.startsWith("clean") ? [] : [{ id: "b1", file: "app.py", lines: [10, 10], anchor: { line: 10, text: "x" }, mentions: ["flaw"], kind: ["bug"], severity: "critical", found_by: ["reasoning"], truth: "t" }] });
  const { configs, jobs } = planJobs({ cases: names, caseIds, reviewers: [REAL], graph: ["on"], repeat });
  const manifest = runManifest({
    startedAt: new Date().toISOString(),
    settings: { runId, mode: "review", path: "server", suite: "planted", split: "dev", build: { commit, short: commit.slice(0, 7), dirty: false, cliVersion: "0.12.0", bundleHash: "b".repeat(64) }, reviewers: { [REAL]: { name: REAL, kind: "model", model: "gpt-6.1-sol", settings: { effort: "low", maxOutputTokens: 32000 } } }, review: { web: "off", timeoutSeconds: 1800 }, cases: names, caseIds: names.map((x) => caseIds[x]), caseHashes: hashes, configs: configs.map((c) => c.id), repeat, concurrency: 1, scannersComplete: true, draft: false, changeId, budget: { hardCaps: { maxUsd: 10, reviewMaxUsd: 3 } } },
    jobs,
  });
  const budget = openLedger(out, { maxUsd: 10, reviewMaxUsd: 3 });
  await executeRun({
    out,
    manifest,
    jobs,
    copies: names.map((x) => [join(specs, `${x}.json`), `cases/${x}.json`]),
    runJob: async (job) => {
      const c = names.indexOf(job.case);
      const flaw = { origin: "agent", severity: "critical", category: "bug", confidence: 0.9, file_path: "app.py", line_number: 10, line_end: 10, title: "A flaw here", problem: "p", consequence: "c", fix: "f", candidate: null, source: null };
      // A finding on the clean case is false: with `cleanFalse`, every review of it shows one.
      const shown = job.case.startsWith("clean") ? (cleanFalse ? [flaw] : []) : found(c, job.repeat) ? [flaw] : [];
      const report = { findings: shown, outside_change: [], dropped: [], completion: { status: "complete", missing: [] } };
      const dir = join(out, "samples", job.case, job.config, String(job.repeat));
      writeJson(join(dir, "sample.json"), sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result: { code: 0, signal: null, wallMs: 20_000 }, report, who: null, startedAt: "t", failure: null, stopped: null }));
      writeJson(join(dir, "report", "report.json"), report);
      budget.noteLaunch(job.jobId);
      budget.spend(cost, job.jobId);
    },
  });
  return out;
}

// The lines every live ledger holds before a change: a passing validation
// of the rule as it stands, and a baseline whose signal says go.
const validation = () => ({ v: 1, id: "VAL-0001", at: "2026-10-11T00:00:00.000Z", event: "validation", ruleHash: ruleHash(), look: null, alpha: null, simulation: { sequences: 1000, looks: 10, accepted: 0, harm: { decision: "reverted" } }, saved: { falseAccepts: 0, missedHarms: 0 }, pass: true, reason: "test" });
const baseline = (stop = false, id = "RC-BASE-0001") => ({ v: 1, id, at: "2026-10-11T00:00:01.000Z", event: "baseline", look: null, alpha: null, runs: [], signal: { sameIssueAgreement: stop ? 0.5 : 0.9, unresolvedShare: 0.1, toolStressShare: 0.2, stop } });
const proposed = (id, over = {}) => ({ v: 1, id, at: "2026-10-11T00:00:02.000Z", event: "proposed", record: { lever: "brief.order-and-size", title: `change ${id}`, hypothesis: "h", branch: `b-${id}`, parent: head, commit: head, paths: ["server"], target: "server", aim: "quality", primary: { metric: "recall", better: "higher" }, acceptableLoss: { ...LOSSES }, capUsd: 40, capReviews: 240, proposedBy: "test", ...over }, runs: [], look: null, alpha: null, results: {}, strata: null, causes: {}, stage: null, decision: null, reason: null, spendUsd: 0, laptopReviews: 0, minutes: 0, pr: null });
// A stage line a change wrote earlier: `look` taken (stage 2 and 3 only),
// `done` when the stage passed without a decision, `spendRuns` the runs it
// recorded with their totals.
const stageLine = (id, { stage, look = null, done = false, spendUsd = 0, spendRuns = [], at = new Date().toISOString(), event = "stage", decision = null }) => ({ v: 1, id, at, event, stageDone: done, runs: [], look, alpha: look === null ? null : 0.05 / (look * (look + 1)), stage, decision, reason: "test", spend: { serverUsd: spendUsd, serverReviews: 0, laptopUsd: 0, laptopReviews: 0, runs: spendRuns }, spendUsd, laptopReviews: 0, minutes: 1, pr: null });

// The driver, run as a person runs it, on the test's checkout, results
// folder and ledger.
function loopArgs(ledger, results, args) {
  return [LOOP, ...args, "--ledger", ledger, "--results", results, "--checkout", checkout, "--model-script", script, "--install-root", tools, "--allow-missing-scanners"];
}
const loop = (ledger, results, args) => {
  const s = scratch();
  const r = spawnSync(process.execPath, loopArgs(ledger, results, args), { encoding: "utf8", cwd: repoRoot, env: s.env });
  s.done();
  return r;
};
const loopAsync = (ledger, results, args) =>
  new Promise((done) => {
    const s = scratch();
    const child = spawn(process.execPath, loopArgs(ledger, results, args), { cwd: repoRoot, env: s.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => {
      s.done();
      done({ status, out: out + err, stderr: err });
    });
  });

beforeAll(() => {
  root = tempDir("oq-bench-loop-");
  checkout = join(root, "checkout");
  head = makeCheckout(checkout);
  script = join(root, "script.json");
  writeJson(script, SCRIPT);
  tools = join(root, "home", "tools");
  mkdirSync(tools, { recursive: true });
  // The parent build's run: three repeats of the case, every review
  // scripted and priced.
  parentRun = runBench(join(root, "runs", "parent"), ["--repeat", "3"]);
}, 300_000);

describe("an iteration behind after stage 1 spends through stage 3", () => {
  it("stops the change at stage 1 with its look and spend in the ledger, and runs nothing after", async () => {
    // The parent finds every case's critical bug in every review; the
    // change's saved run finds none.
    const parent = await savedSet({ runId: "behind-parent", found: () => true });
    const candidate = await savedSet({ runId: "behind-candidate", changeId: "RC-0001", found: () => false, repeat: 1, cost: 0.02 });
    const ledger = join(root, "behind", "reviewer.jsonl");
    const results = join(root, "behind", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);

    const first = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent, "--candidate", candidate]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const line = readLines(ledger).at(-1);
    // Stage 1 can only stop, so it takes no look (plan clarification A2).
    expect(line).toMatchObject({ v: 1, id: "RC-0001", event: "decided", stage: 1, decision: "stopped-early", look: null, alpha: null });
    expect(line.reason).toMatch(/recall/);
    expect(line.screen.filter((r) => r.fired).map((r) => r.rule)).toEqual(expect.arrayContaining(["primary", "critical"]));
    // What the stage-1 run cost is the step's spend.
    expect(line.spend.serverUsd).toBeCloseTo(7 * 0.02, 9);
    expect(line.spend.serverReviews).toBe(7);

    // A later step is refused: nothing runs, nothing is written.
    const second = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/stopped-early|decided/);
    expect(readLines(ledger)).toHaveLength(4);
    expect(existsSync(results)).toBe(false);
  }, 120_000);
});

describe("the loop reads a test-split run", () => {
  // A held-out run whose samples cannot be scored at all (its spec copy is
  // gone): refusing it after scoring them would fail with another error.
  const heldOut = (runId) => {
    const folder = copyRun(parentRun, runId, (m) => ({ ...m, split: "test" }));
    renameSync(join(folder, "cases", `${CASE}.json`), join(folder, `${CASE}.spec-moved-away`));
    return folder;
  };

  it("refuses a held-out parent before reading a sample, and runs and writes nothing", () => {
    const parent = heldOut("parent-test-split");
    const ledger = join(root, "split-parent", "reviewer.jsonl");
    const results = join(root, "split-parent", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    const before = readFileSync(ledger, "utf8");
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/held-out|test split/);
    expect(r.stderr).not.toMatch(/spec is needed/);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(existsSync(results)).toBe(false);
  }, 300_000);

  it("refuses a held-out candidate the same way", () => {
    const candidate = heldOut("candidate-test-split");
    writeJson(join(candidate, "manifest.json"), { ...readJson(join(candidate, "manifest.json")), changeId: "RC-0001" });
    const ledger = join(root, "split-candidate", "reviewer.jsonl");
    const results = join(root, "split-candidate", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    const before = readFileSync(ledger, "utf8");
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun, "--candidate", candidate]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/held-out|test split/);
    expect(r.stderr).not.toMatch(/spec is needed/);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(existsSync(results)).toBe(false);
  }, 300_000);
});

describe("two iterations take one look number", () => {
  it("gives two changes deciding at stage 2 at once looks 1 and 2, each with its alpha", async () => {
    const ledger = join(root, "looks", "reviewer.jsonl");
    const results = join(root, "looks", "results");
    // Both changes passed their stage 1 screens. Each change's runs are
    // saved runs made for it, so nothing is run; each shows a finding on
    // the clean case in every review, a hard rule broken, so each stage 2
    // ends in a decision and the second change may follow the first.
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), proposed("RC-0002"), stageLine("RC-0001", { stage: 1, done: true }), stageLine("RC-0002", { stage: 1, done: true })]);
    const parent = await savedSet({ runId: "looks-parent", found: (c) => c < 3 });
    const a = await savedSet({ runId: "looks-a", changeId: "RC-0001", found: () => true, cleanFalse: true });
    const b = await savedSet({ runId: "looks-b", changeId: "RC-0002", found: () => true, cleanFalse: true });
    // The ledger's own lock is held while both steps start and score their
    // runs, so both reach their decision before either may write: a step
    // that reads its look outside the lock reads the same one as the other.
    const held = lockLedger(ledger);
    const both = Promise.all([loopAsync(ledger, results, ["step", "--change", "RC-0001", "--parent", parent, "--candidate", a]), loopAsync(ledger, results, ["step", "--change", "RC-0002", "--parent", parent, "--candidate", b])]);
    await wait(5000);
    held.release();
    const [x, y] = await both;
    expect(x.status, x.out).toBe(0);
    expect(y.status, y.out).toBe(0);
    const looks = readLines(ledger).filter((l) => l.look !== null);
    expect(looks.map((l) => [l.id, l.stage, l.decision]).sort()).toEqual([["RC-0001", 2, "reverted"], ["RC-0002", 2, "reverted"]]);
    expect(looks.map((l) => l.look).sort()).toEqual([1, 2]);
    for (const l of looks) expect(l.alpha).toBeCloseTo(0.05 / (l.look * (l.look + 1)), 15);
    expect(existsSync(results)).toBe(false);
  }, 120_000);
});

describe("a stage 1 screen takes a look, or a stage 3 acceptance takes none", () => {
  it("leaves t unchanged when a change passes its stage 1 screen", async () => {
    const ledger = join(root, "screen-look", "reviewer.jsonl");
    const results = join(root, "screen-look", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    const parent = await savedSet({ runId: "screen-parent", found: (c) => c < 3 });
    const candidate = await savedSet({ runId: "screen-candidate", changeId: "RC-0001", found: () => true, repeat: 1 });
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent, "--candidate", candidate]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const line = readLines(ledger).at(-1);
    expect(line).toMatchObject({ id: "RC-0001", event: "stage", stage: 1, decision: null, look: null, alpha: null });
    expect(line.screen.some((x) => x.fired)).toBe(false);
    const status = spawnSync(process.execPath, [LOOP, "status", "--ledger", ledger], { encoding: "utf8" });
    expect(status.stdout).toMatch(/next look 1;/);
    expect(status.stdout).toMatch(/RC-0001 .*stage 2 due/);
  }, 120_000);

  it("takes the next look for an acceptance at stage 3", async () => {
    const ledger = join(root, "stage3-look", "reviewer.jsonl");
    const results = join(root, "stage3-look", "results");
    // Stage 1 passed (no look) and stage 2 took look 1 with only the primary
    // open. At six repeats, twelve of fourteen cases go from missed in
    // every review to found in every review: an exact one-sided p of
    // 1/4096, inside look 2's share of 0.05 / 6 / 9.
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), stageLine("RC-0001", { stage: 1, done: true }), stageLine("RC-0001", { stage: 2, look: 1, done: true })]);
    const parent = await savedSet({ runId: "stage3-parent", n: 14, found: (c) => c < 2, repeat: 6 });
    const candidate = await savedSet({ runId: "stage3-candidate", n: 14, changeId: "RC-0001", found: () => true, repeat: 6 });
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parent, "--candidate", candidate]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const line = readLines(ledger).at(-1);
    expect(line).toMatchObject({ id: "RC-0001", event: "decided", stage: 3, decision: "accepted", look: 2 });
    expect(line.alpha).toBeCloseTo(0.05 / 6, 15);
    expect(existsSync(results)).toBe(false);
  }, 120_000);
});

describe("the daily cap is exceeded by a stage 2 decision that was forecast under it", () => {
  it("holds the stage 2 run to the day's room, so the day's server spend stays inside 60 dollars", () => {
    const ledger = join(root, "daily", "reviewer.jsonl");
    const results = join(root, "daily", "results");
    // RC-0001 passed stage 1 at $0.001 a review, so stage 2's three reviews
    // are forecast at $0.003. Another change spent $59.969 on the server
    // today; with stage 1's $0.001 that leaves $0.03, which one staged
    // review's $0.03 cap fits in. Three reviews at $0.03 each would pass
    // the daily cap.
    const stage1 = { ...stageLine("RC-0001", { stage: 1, done: true, spendUsd: 0.001 }), spend: { serverUsd: 0.001, serverReviews: 1, laptopUsd: 0, laptopReviews: 0, runs: [] } };
    const other = stageLine("RC-0002", { stage: 1, spendUsd: 59.969, event: "decided", decision: "stopped-early" });
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), proposed("RC-0002"), stage1, other]);

    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = readLines(ledger);
    const line = lines.at(-1);
    // The forecast said it fits; the hard cap stopped it, and no decision was taken on part of the runs.
    expect(line).toMatchObject({ id: "RC-0001", event: "stage", stage: 2, look: null, decision: null });
    expect(line.spend.forecastUsd).toBeLessThan(0.03);
    expect(line.reason).toMatch(/daily/);
    const today = new Date().toISOString().slice(0, 10);
    const spentToday = lines.filter((l) => l.spend && l.at.slice(0, 10) === today).reduce((s, l) => s + l.spend.serverUsd, 0);
    expect(spentToday).toBeLessThanOrEqual(60 + 1e-9);
    expect(line.spend.serverUsd).toBeGreaterThan(0);
    const manifest = readJson(join(results, `RC-0001-${basename(parentRun)}`, "manifest.json"));
    expect(manifest.budget.hardCaps.maxUsd).toBeLessThanOrEqual(0.03 + 1e-9);

    // The next step the same day finds no room for a review and runs nothing.
    const again = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/daily/);
    expect(readLines(ledger)).toHaveLength(lines.length);
  }, 300_000);
});

describe("the day's room leaves out spend already on disk", () => {
  it("counts a candidate run's unrecorded spend against the room before any review starts", () => {
    const ledger = join(root, "on-disk", "reviewer.jsonl");
    const results = join(root, "on-disk", "results");
    // Stage 1 of RC-0001 made its candidate run, $0.03 for one review, and
    // the ledger never recorded it. With $59.97 spent today the room is
    // $0.03 by the ledger, but zero with the run's own spend: less than
    // one review's $0.03 cap.
    const candidate = join(results, `RC-0001-${basename(parentRun)}`);
    runBench(candidate, ["--repeat", "1", "--change", "RC-0001"]);
    const stage1 = stageLine("RC-0001", { stage: 1, done: true });
    const other = stageLine("RC-0002", { stage: 1, spendUsd: 59.97, event: "decided", decision: "stopped-early" });
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), proposed("RC-0002"), stage1, other]);
    const before = readFileSync(ledger, "utf8");
    const budgetBefore = readFileSync(join(candidate, "budget.jsonl"), "utf8");

    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/daily/);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(readJson(join(candidate, "manifest.json")).repeat).toBe(1);
    expect(readFileSync(join(candidate, "budget.jsonl"), "utf8")).toBe(budgetBefore);
  }, 300_000);
});

describe("a second change enters stage 2 while one is there", () => {
  it("refuses at the moment of writing when another change entered stage 2 after the step began", async () => {
    const ledger = join(root, "one-at-a-time", "reviewer.jsonl");
    const results = join(root, "one-at-a-time", "results");
    const parent = await savedSet({ runId: "one-parent", found: (c) => c < 3 });
    const b = await savedSet({ runId: "one-b", changeId: "RC-0002", found: () => true });
    // Both changes passed stage 1; B's line recorded its run's whole spend,
    // so B's stage 2 spends nothing new.
    const bTotal = { runId: "one-b", role: "candidate", path: "server", usd: 21 * 0.01, reviews: 21 };
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001"), proposed("RC-0002"), stageLine("RC-0001", { stage: 1, done: true }), stageLine("RC-0002", { stage: 1, done: true, spendUsd: bTotal.usd, spendRuns: [bTotal] })]);
    // B's step starts with A still waiting for stage 2; while the ledger's
    // lock is held, A's stage 2 line lands.
    const held = lockLedger(ledger);
    const step = loopAsync(ledger, results, ["step", "--change", "RC-0002", "--parent", parent, "--candidate", b]);
    await wait(5000);
    appendLine(ledger, stageLine("RC-0001", { stage: 2, look: 1, done: true }));
    held.release();
    const r = await step;
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toMatch(/RC-0001/);
    const lines = readLines(ledger);
    expect(lines.at(-1)).toMatchObject({ id: "RC-0001", stage: 2, look: 1 });
    expect(lines.filter((l) => l.id === "RC-0002" && l.stage === 2)).toEqual([]);
  }, 120_000);
});

describe("a step that died leaves its run.mjs spending", () => {
  it("refuses while the run.mjs a dead step started still runs, and settles the dead step's spend once it has ended", async () => {
    const ledger = join(root, "dead-step", "reviewer.jsonl");
    const results = join(root, "dead-step", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    // The dead step: a process that has ended, and the run.mjs it started,
    // still running in its own process group.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
    const ended = new Promise((done) => child.on("exit", done));
    const abandoned = await savedSet({ runId: "dead-step-run", changeId: "RC-0001", found: () => false, repeat: 1, cost: 0.03 });
    writeFileSync(`${ledger}.run.lock`, `${dead}\n`);
    writeJson(`${ledger}.run.lock.json`, { pid: dead, at: new Date().toISOString(), change: "RC-0001", stage: 1, runs: [{ runId: "dead-step-run", folder: abandoned, path: "server", role: "candidate", before: { usd: 0, reviews: 0 } }], child: { pid: child.pid, pgid: child.pid } });
    const before = readFileSync(ledger, "utf8");

    const refused = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(refused.status, refused.stdout + refused.stderr).not.toBe(0);
    expect(refused.stderr).toMatch(new RegExp(`${child.pid}`));
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(existsSync(results)).toBe(false);

    process.kill(-child.pid, "SIGTERM");
    await ended;
    const settled = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(settled.status, settled.stdout + settled.stderr).toBe(0);
    const lines = readLines(ledger);
    const gone = lines.find((l) => l.event === "abandoned");
    expect(gone).toMatchObject({ id: "RC-0001", look: null });
    expect(gone.spend.serverUsd).toBeCloseTo(7 * 0.03, 9);
    expect(lines.indexOf(gone)).toBeLessThan(lines.length - 1);
    expect(existsSync(`${ledger}.run.lock`)).toBe(false);
  }, 300_000);
});

describe("a scripted screen stops a change as evidence", () => {
  it("records no evidence for the scripted model's runs: no look, no decision, the spend kept, stage 1 still due", () => {
    const ledger = join(root, "scripted", "reviewer.jsonl");
    const results = join(root, "scripted", "results");
    writeLines(ledger, [validation(), baseline(), proposed("RC-0001")]);
    // The parent's scripted runs and the change's, made now by run.mjs, find
    // the same nothing: a screen reading them would stop the change.
    const r = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const line = readLines(ledger).at(-1);
    expect(line).toMatchObject({ id: "RC-0001", event: "stage", stage: 1, look: null, decision: null });
    expect(line.reason).toMatch(/no evidence/);
    expect(line.reason).toMatch(/scripted/);
    expect(line.spend.serverUsd).toBeGreaterThan(0);
    const status = spawnSync(process.execPath, [LOOP, "status", "--ledger", ledger], { encoding: "utf8" });
    expect(status.stdout).toMatch(/RC-0001 .*stage 1 due/);
  }, 300_000);
});

describe("a lever is chosen after the earliest-failure signal said stop", () => {
  const record = () => {
    const file = join(root, "signal", "record.json");
    writeJson(file, { lever: "brief.order-and-size", title: "t", hypothesis: "h", branch: "b", parent: head, primary: { metric: "recall" }, acceptableLoss: { ...LOSSES }, proposedBy: "test" });
    return file;
  };

  it("refuses a proposal and a step while the last baseline's signal says stop, and before any baseline carries one", () => {
    for (const [name, lines] of [
      ["stop", [validation(), baseline(false, "RC-BASE-0001"), baseline(true, "RC-BASE-0002"), proposed("RC-0001")]],
      ["stop-line", [validation(), baseline(false), { v: 1, id: "STOP-0001", at: "2026-10-11T00:00:03.000Z", event: "stop", look: null, alpha: null, reason: "unresolved findings are 40 percent of displayed findings" }, proposed("RC-0001")]],
      ["no-signal", [validation(), { ...baseline(), signal: undefined }, proposed("RC-0001")]],
    ]) {
      const ledger = join(root, "signal", name, "reviewer.jsonl");
      const results = join(root, "signal", name, "results");
      writeLines(ledger, lines);
      const before = readFileSync(ledger, "utf8");
      const p = loop(ledger, results, ["propose", record()]);
      expect(p.status, `${name}: ${p.stdout}${p.stderr}`).toBe(1);
      expect(p.stderr).toMatch(/signal|stop/);
      const s = loop(ledger, results, ["step", "--change", "RC-0001", "--parent", parentRun]);
      expect(s.status, `${name}: ${s.stdout}${s.stderr}`).toBe(1);
      expect(s.stderr).toMatch(/signal|stop/);
      expect(readFileSync(ledger, "utf8")).toBe(before);
      expect(existsSync(results)).toBe(false);
    }
  }, 300_000);
});

describe("run.mjs leaves no temp root when it is stopped (10)", () => {
  const roots = (dir) => readdirSync(dir).filter((name) => name.startsWith("oq-bench-run-"));
  // run.mjs started with a temp folder of its own; `until` is polled every
  // 20 ms, and the run is sent `signal` once it holds.
  const stopped = (out, until, signal) =>
    new Promise((done, fail) => {
      const s = scratch();
      const child = spawn(process.execPath, benchArgs(out, ["--repeat", "3"]), { cwd: checkout, env: s.env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.stderr.on("data", (d) => (text += d));
      let seen = null;
      const poll = setInterval(() => {
        if (seen === null && until(s.dir, out)) {
          seen = roots(s.dir);
          child.kill(signal);
        }
      }, 20);
      child.on("error", fail);
      child.on("close", (code, killed) => {
        clearInterval(poll);
        done({ s, code, killed, text, seen, left: roots(s.dir) });
      });
    });

  it("removes its temp root on SIGTERM before the reviews start and while they run", async () => {
    const early = await stopped(join(root, "stopped", "early"), (dir) => roots(dir).length > 0, "SIGTERM");
    const during = await stopped(join(root, "stopped", "during"), (_, out) => existsSync(join(out, "samples")) && readdirSync(join(out, "samples"), { recursive: true }).some((f) => String(f).endsWith(".json")), "SIGTERM");
    for (const [when, r] of [["early", early], ["during", during]]) {
      r.s.done();
      // The signal reached a run that had a temp root and ended it.
      expect(r.seen, `${when}: ${r.text}`).toHaveLength(1);
      expect(r.code, `${when}: ${r.text}`).not.toBe(0);
      expect(r.left, `${when}: ${r.text}`).toEqual([]);
    }
    // Stopped while reviewing, the run halts by its own rule and says so.
    expect(during.text).toMatch(/stopped by SIGTERM/);
  }, 300_000);

  it("leaves its temp root on a forced kill, which cannot be caught, inside the folder the test removes", async () => {
    const r = await stopped(join(root, "stopped", "killed"), (dir) => roots(dir).length > 0, "SIGKILL");
    expect(r.killed).toBe("SIGKILL");
    expect(r.left).toEqual(r.seen);
    expect(r.left).toHaveLength(1);
    r.s.done();
    expect(existsSync(r.s.dir)).toBe(false);
  }, 300_000);
});
