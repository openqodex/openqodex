// The reviewer loop's paired comparison and acceptance rule (PLAN-benchmark
// 4.11): benchmark/loop/compare.mjs, decide.mjs and validate.mjs. Each
// failure is guarded on a controlled dataset whose effect is known:
//
// 1. A bootstrap treating repeats as independent cases accepts a null
//    change: a few whole cases flip between two runs of one build, every
//    repeat of a case agreeing, and a resample of reviews reads that as a
//    gain far outside the noise. The rule pairs whole cases and accepts
//    nothing the paired sign-flip test over cases does not support.
// 2. A guard failing on the other path lets the change through: a change
//    aimed at the server that costs the laptop path its precision is kept,
//    because only the target path was read.
// 3. A noisy A/A pair widens the permitted loss: the margin becomes the
//    larger of the predeclared loss and the A/A half-width, so a noisy
//    baseline lets a real loss pass.
// 4. A later look uses the same bound as the first: every decision is tested
//    at alpha 0.05 / 2 instead of 0.05 / (t (t + 1)), so a loop that looks
//    often accepts noise sooner or later.
// The checks the plan names (P3-04) are tests too: a constructed null pair
// is never accepted over 1,000 simulated look sequences, a constructed
// harmful pair is reverted, and the validation run on saved data writes its
// ledger line with no false accept and no missed harm.
// 5. A zero parent fraction guard reverts or blocks an A/A comparison.
// 6. Ignoring zero parents also disables positive parent fraction guards.
// 7. An absolute guard with a zero parent is mistakenly ignored.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mulberry32, seedOf } from "../lib/interval.mjs";
import { executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { changeVerdict, comparePairs, lossIn, makeSide } from "../loop/compare.mjs";
import { alphaAt, appendLedgerLine, decide, guardVerdict, lookOf, ruleHash } from "../loop/decide.mjs";
import { changeState } from "../loop/stages.mjs";
import { HASH_AT_LOAD, SIM_DEFAULTS, simulateHarm, simulateNull, simulatePower, simulatedWorld, drawSide, validateSaved, validationLine, writeValidationLine } from "../loop/validate.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const DECIDE = fileURLToPath(new URL("../loop/decide.mjs", import.meta.url));
const VALIDATE = fileURLToPath(new URL("../loop/validate.mjs", import.meta.url));
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
const readLines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// The predeclared losses of PLAN question 20, as benchmark/loop/levers.json
// gives them.
const LOSSES = { recall: 2, criticalMajorRecall: 2, precision: 2, severityAgreement: 3, incompleteRate: 2, redundancy: 5, cleanFindings: 0.1, costPerReview: 0.15, secondsPerReview: 0.2 };
const record = (over = {}) => ({ lever: "brief.diff-numbers", title: "t", hypothesis: "h", branch: "b", parent: "p".repeat(40), commit: "c".repeat(40), paths: ["server"], target: "server", aim: "quality", primary: { metric: "recall", better: "higher" }, acceptableLoss: { ...LOSSES }, ...over });

// One scored review in the shape lib/score.mjs scoreJob gives, with the
// fields the comparison reads. `bugs` are [id, severity, found]; `wrong`
// findings a person ruled false; `unresolved` findings nobody ruled on.
function review({ caseId, repeat, config, bugs = [], wrong = 0, unresolved = 0, clean = false, status = "complete", cost = 0.1, seconds = 30 }) {
  const hits = bugs.filter(([, , found]) => found).map(([id, severity]) => ({ outcome: "hit", bug: id, severity, severityAgreement: "exact" }));
  const findings = [...hits, ...Array.from({ length: wrong }, () => ({ outcome: "ruled-false", bug: null, severityAgreement: null })), ...Array.from({ length: unresolved }, () => ({ outcome: "unresolved", bug: null, severityAgreement: null }))];
  const cm = bugs.filter(([, s]) => s === "critical" || s === "major");
  return {
    jobId: `${caseId}/${config}/${repeat}`,
    caseId,
    case: caseId,
    config,
    repeat,
    origin: "planted",
    clean,
    status,
    bugs: bugs.map(([id, severity, found]) => ({ id, severity, found })),
    findings,
    issueRecall: { all: { hit: hits.length, of: bugs.length }, criticalMajor: { hit: cm.filter(([, , f]) => f).length, of: cm.length } },
    precision: { correct: hits.length, unresolved, of: findings.length },
    issues: { correct: hits.length, unresolved, of: findings.length },
    costUsd: cost,
    wallMs: seconds * 1000,
    budgetRefused: false,
    undeliveredComplete: false,
  };
}

// The reviews of one side: `n` cases of one minor bug each and a clean case,
// `repeats` reviews per case; `found(c, r)` says whether review r of case c
// finds its bug, `wrong(c, r)` how many false findings it shows and
// `cost(c, r)` what it cost.
function sideOf({ runId, path = "server", reviewer = "model:scripted", n = 12, repeats = 3, found, wrong = () => 0, cost = () => 0.1, commit = "c".repeat(40) }) {
  const config = `${reviewer}-graph-on`;
  const jobs = [];
  for (let r = 1; r <= repeats; r++) {
    for (let c = 0; c < n; c++) jobs.push(review({ caseId: `planted/case-${String(c).padStart(2, "0")}@00000000`, repeat: r, config, bugs: [["b1", "minor", found(c, r)]], wrong: wrong(c, r), cost: cost(c, r) }));
    jobs.push(review({ caseId: "planted/clean-00@00000000", repeat: r, config, clean: true }));
  }
  return makeSide({ runId, suite: "planted", split: "dev", path, reviewer, model: reviewer, config, rules: { version: 5, hash: "r".repeat(64) }, build: { commit }, jobs });
}

// A pair where ten of twelve cases go from never found to found in every
// review and the other two are found in both: an exact one-sided p of
// 1/1024 for the gain in recall, with every other metric unchanged.
const tenOfTwelve = (over = {}) => ({
  parent: sideOf({ runId: "parent", found: (c) => c >= 10, commit: "p".repeat(40), ...over }),
  candidate: sideOf({ runId: "candidate", found: () => true, ...over }),
});

const cellOf = (result, path, reviewer) => result.cells.find((c) => c.path === path && c.reviewer === reviewer);

describe("a bootstrap treating repeats as independent cases accepts a null change", () => {
  it("accepts nothing the paired test over cases does not support, where a resample of reviews puts the gain far outside the noise", () => {
    // Sixteen cases: seven flip from never found to found in all three
    // reviews and one flips back. Whole cases flipping, every repeat of a
    // case agreeing, is what two runs of one build show (lib/interval.mjs):
    // over cases the exact one-sided p is 9/256, 3.5 percent.
    const up = new Set([8, 9, 10, 11, 12, 13, 14]);
    const parent = sideOf({ runId: "parent", n: 16, found: (c) => c < 8 || c === 15, commit: "p".repeat(40) });
    const candidate = sideOf({ runId: "candidate", n: 16, found: (c) => c < 8 || up.has(c) });
    const look = 1;
    const share = alphaAt(look) / Object.keys(LOSSES).length;

    // The failure, shown: resampling reviews as if each were its own case.
    const pairs = parent.jobs.filter((j) => !j.clean).map((p) => ({ a: p.issueRecall.all, b: candidate.jobs.find((c) => c.caseId === p.caseId && c.repeat === p.repeat).issueRecall.all }));
    const rand = mulberry32(seedOf("a resample of reviews"));
    const draws = [];
    for (let i = 0; i < 10_000; i++) {
      let ah = 0;
      let ao = 0;
      let bh = 0;
      let bo = 0;
      for (let k = 0; k < pairs.length; k++) {
        const u = pairs[Math.floor(rand() * pairs.length)];
        ah += u.a.hit;
        ao += u.a.of;
        bh += u.b.hit;
        bo += u.b.of;
      }
      draws.push(bh / bo - ah / ao);
    }
    draws.sort((x, y) => x - y);
    const reviewLower = draws[Math.ceil(share * draws.length) - 1];
    expect(reviewLower).toBeGreaterThan(0);

    const out = decide({ id: "RC-0001", record: record(), pairs: [{ parent, candidate }], look, stage: 3 });
    const cell = cellOf(out, "server", "model:scripted");
    const recall = cell.strata.pooled.metrics.recall;
    expect(recall.delta).toBeCloseTo(18 / 48, 12);
    expect(recall.method).toBe("exact");
    expect(recall.changed).toBe(8);
    expect(recall.pBetter).toBeCloseTo(9 / 256, 12);
    expect(cell.verdicts.pooled.recall).toBe("unclear");
    // Every guard holds, so the primary's test over cases is what refuses.
    for (const [metric, v] of Object.entries(cell.verdicts.pooled)) if (metric !== "recall") expect(["holds", "not measured"], metric).toContain(v);
    expect(out.decision).toBe("inconclusive-reverted");
  });
});

describe("a guard failing on the other path lets the change through", () => {
  // The laptop path's reviews: every case found in every review; on codex
  // the candidate also shows two false findings in every review.
  const laptop = (reviewer, wrongInCandidate) => ({
    parent: sideOf({ runId: `${reviewer}-parent`, path: "laptop", reviewer, found: () => true, commit: "p".repeat(40) }),
    candidate: sideOf({ runId: `${reviewer}-candidate`, path: "laptop", reviewer, found: () => true, wrong: () => wrongInCandidate }),
  });
  const rec = record({ paths: ["laptop", "server"], target: "server" });

  it("reverts a change that wins on the server and loses precision on the laptop path", () => {
    const out = decide({ id: "RC-0002", record: rec, pairs: [tenOfTwelve(), laptop("claude", 0), laptop("codex", 2)], look: 1, stage: 3 });
    expect(cellOf(out, "server", "model:scripted").verdicts.pooled.recall).toBe("better");
    expect(cellOf(out, "laptop", "codex").verdicts.pooled.precision).toBe("breaks");
    expect(out.decision).toBe("reverted");
    expect(out.reason).toMatch(/laptop.*codex.*precision/);
  });

  it("accepts the same server result when the laptop path holds, so the other path is what refused it", () => {
    const out = decide({ id: "RC-0003", record: rec, pairs: [tenOfTwelve(), laptop("claude", 0), laptop("codex", 0)], look: 1, stage: 3 });
    expect(out.decision).toBe("accepted");
  });

  it("does not accept a change whose other path was never run", () => {
    const out = decide({ id: "RC-0004", record: rec, pairs: [tenOfTwelve(), laptop("claude", 0)], look: 1, stage: 3 });
    expect(out.decision).toBe("inconclusive-reverted");
    expect(out.reason).toMatch(/codex/);
  });
});

describe("a noisy A/A pair widens the permitted loss", () => {
  // Forty cases; ten gain their bug in every review, and every review of the
  // candidate costs a quarter more: a cost rise known to be past the
  // predeclared 15 percent at some bound, and inside a noisy 40 percent.
  const n = 40;
  const pair = () => ({
    parent: sideOf({ runId: "parent", n, found: (c) => c >= 10, commit: "p".repeat(40) }),
    candidate: sideOf({ runId: "candidate", n, found: () => true, cost: () => 0.125 }),
  });
  // An A/A pair of the parent build whose costs swing from case to case.
  const aa = () => ({
    parent: sideOf({ runId: "aa-a", n, found: (c) => c >= 10, cost: () => 0.1, commit: "p".repeat(40) }),
    candidate: sideOf({ runId: "aa-b", n, found: (c) => c >= 10, cost: (c) => (c % 2 === 0 ? 0.02 : 0.3), commit: "p".repeat(40) }),
  });

  it("keeps the predeclared loss, and calls the comparison underpowered instead of accepting", () => {
    const without = decide({ id: "RC-0005", record: record(), pairs: [pair()], look: 1, stage: 3 });
    const cost = cellOf(without, "server", "model:scripted").strata.pooled.metrics.costPerReview;
    expect(cellOf(without, "server", "model:scripted").verdicts.pooled.recall).toBe("better");
    // The cost rise is past 15 percent of the parent at its upper bound.
    expect(cost.hi).toBeGreaterThan(0.15 * cost.parent);
    expect(without.decision).not.toBe("accepted");

    const withAa = decide({ id: "RC-0005", record: record(), pairs: [pair()], aaPairs: [aa()], look: 1, stage: 3 });
    const cell = cellOf(withAa, "server", "model:scripted");
    // The A/A is noisy: its half-width is far past the loss, and past the
    // bound the candidate reached, so a margin taken from it would pass.
    expect(cell.aa.costPerReview.halfWidth).toBeGreaterThan(cost.hi);
    expect(cell.aa.costPerReview.underpowered).toBe(true);
    expect(cell.aa.costPerReview.clustersNeeded).toBeGreaterThan(cell.aa.costPerReview.clusters);
    expect(cell.losses.costPerReview).toBeCloseTo(0.15 * cost.parent, 12);
    expect(withAa.acceptableLoss).toEqual(LOSSES);
    expect(cell.verdicts.pooled.costPerReview).toBe(without.cells[0].verdicts.pooled.costPerReview);
    expect(withAa.decision).toBe("inconclusive-reverted");
    expect(withAa.reason).toMatch(/A\/A/);
  });
});

// A saved run written by the runner's own code (executeRun), the review step
// replaced by a report the test writes: `found(c, r)` says whether review r
// of case c finds its one minor bug; `cost(c, r)` what it cost.
async function savedRun({ parent, runId, commit, n = 12, repeat = 3, found, cost = () => 0.1, reviewer = "model:scripted", path = "server" }) {
  const out = join(parent, runId);
  const specsDir = join(parent, `${runId}-specs`);
  const names = [...Array.from({ length: n }, (_, i) => `case-${String(i).padStart(2, "0")}`), "clean-00"];
  const hashes = Object.fromEntries(names.map((x) => [x, sha(x)]));
  const caseIds = Object.fromEntries(names.map((x) => [x, `planted/${x}@${hashes[x].slice(0, 8)}`]));
  const spec = (x) => ({ id: x, guards: "g", language: "python", framework: "none", clean: x.startsWith("clean"), bugs: x.startsWith("clean") ? [] : [{ id: "b1", file: "app.py", lines: [10, 10], anchor: { line: 10, text: "x" }, mentions: ["flaw"], kind: ["bug"], severity: "minor", found_by: ["reasoning"], truth: "t" }] });
  for (const x of names) write(join(specsDir, `${x}.json`), JSON.stringify(spec(x)));
  const { jobs } = planJobs({ cases: names, caseIds, reviewers: [reviewer], graph: ["on"], repeat });
  const manifest = runManifest({
    startedAt: "2026-10-11T08:00:00.000Z",
    settings: { path, suite: "planted", split: "dev", build: { commit, short: commit.slice(0, 7), dirty: false, cliVersion: "0.14.0", bundleHash: "b".repeat(64) }, reviewers: { [reviewer]: { name: reviewer, version: "1", model: "scripted" } }, review: { web: "off" }, cases: names, caseIds: names.map((x) => caseIds[x]), caseHashes: hashes, configs: [`${reviewer}-graph-on`], repeat, scannersComplete: true, draft: false },
    jobs,
  });
  await executeRun({
    out,
    manifest,
    jobs,
    copies: names.map((x) => [join(specsDir, `${x}.json`), `cases/${x}.json`]),
    runJob: async (job) => {
      const c = names.indexOf(job.case);
      const shown = !job.case.startsWith("clean") && found(c, job.repeat) ? [{ origin: "agent", severity: "minor", category: "bug", confidence: 0.9, file_path: "app.py", line_number: 10, line_end: 10, title: "A flaw here", problem: "p", consequence: "c", fix: "f", candidate: null, source: null }] : [];
      const report = { findings: shown, outside_change: [], dropped: [], completion: { status: "complete", missing: [], reviewer: { usage: { cost_usd: cost(c, job.repeat) } } } };
      const dir = join(out, "samples", job.case, job.config, String(job.repeat));
      write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result: { code: 0, signal: null, wallMs: 20_000 }, report, who: null, startedAt: "t", failure: null, stopped: null })));
      write(join(dir, "report", "report.json"), JSON.stringify(report));
    },
  });
  return out;
}

// A validation line for the rule as it stands, so a live decision may run.
const passingValidation = () => ({ v: 1, id: "VAL-0001", at: "2026-10-11T00:00:00.000Z", event: "validation", ruleHash: ruleHash(), look: null, alpha: null, simulation: { sequences: 1000, looks: 10, nullAccepted: 0, harm: { decision: "reverted" } }, saved: { falseAccepts: 0, missedHarms: 0 }, pass: true, reason: "test" });
const proposed = (id, commit) => ({ v: 1, id, at: "2026-10-11T00:00:00.000Z", event: "proposed", record: record({ commit, parent: "p".repeat(40) }), runs: [], look: null, alpha: null, results: {}, strata: null, causes: {}, stage: null, decision: null, reason: null, spendUsd: 0, laptopReviews: 0, minutes: 0, pr: null });

describe("a later look uses the same bound as the first", () => {
  let root;
  let parentRun;
  let candidateRun;
  beforeAll(async () => {
    root = tempDir("oq-bench-decide-");
    parentRun = await savedRun({ parent: root, runId: "2026-10-11-ppppppp-parent", commit: "p".repeat(40), found: (c) => c >= 10 });
    candidateRun = await savedRun({ parent: root, runId: "2026-10-11-ccccccc-candidate", commit: "c".repeat(40), found: () => true });
  });

  it("tests look t at 0.05 / (t (t + 1)), read from the ledger, so a gain accepted at the first look is not at the second", () => {
    const first = decide({ id: "RC-0001", record: record(), pairs: [tenOfTwelve()], look: 1, stage: 3 });
    const second = decide({ id: "RC-0001", record: record(), pairs: [tenOfTwelve()], look: 2, stage: 3 });
    expect(first.alpha).toBeCloseTo(0.05 / 2, 15);
    expect(second.alpha).toBeCloseTo(0.05 / 6, 15);
    expect(cellOf(first, "server", "model:scripted").strata.pooled.metrics.recall.pBetter).toBeCloseTo(1 / 1024, 15);
    expect(first.decision).toBe("accepted");
    expect(second.decision).toBe("inconclusive-reverted");
  });

  it("reads the look number from the ledger and writes it with its alpha, from saved runs through the scorer", () => {
    const pair = ["--pair", `${parentRun}=${candidateRun}`];
    // The first look of the loop: accepted.
    const one = join(root, "one.jsonl");
    write(one, [passingValidation(), proposed("RC-0001", "c".repeat(40))].map((l) => `${JSON.stringify(l)}\n`).join(""));
    const inodeBefore = statSync(one).ino;
    const a = node(DECIDE, ["--change", "RC-0001", ...pair, "--stage", "3", "--ledger", one]);
    expect(a.status, a.stdout + a.stderr).toBe(0);
    // The line went in by replacing the whole ledger, never by an append in place.
    expect(statSync(one).ino).not.toBe(inodeBefore);
    const lineA = readLines(one).at(-1);
    expect(lineA).toMatchObject({ v: 1, id: "RC-0001", event: "decided", look: 1, decision: "accepted" });
    expect(lineA.alpha).toBeCloseTo(0.05 / 2, 15);

    // The same change after another change's look: the second look of the loop.
    const two = join(root, "two.jsonl");
    const earlier = { ...proposed("RC-0001", "e".repeat(40)), event: "stage", look: 1, alpha: 0.05 / 2, stage: 1, record: undefined };
    write(two, [passingValidation(), proposed("RC-0001", "e".repeat(40)), earlier, proposed("RC-0002", "c".repeat(40))].map((l) => `${JSON.stringify(l)}\n`).join(""));
    const b = node(DECIDE, ["--change", "RC-0002", ...pair, "--stage", "3", "--ledger", two]);
    expect(b.status, b.stdout + b.stderr).toBe(0);
    const lineB = readLines(two).at(-1);
    expect(lineB).toMatchObject({ id: "RC-0002", event: "decided", look: 2, decision: "inconclusive-reverted" });
    expect(lineB.alpha).toBeCloseTo(0.05 / 6, 15);
  });

  it("refuses a live decision when the ledger holds no passing validation of this rule", () => {
    const none = join(root, "none.jsonl");
    write(none, `${JSON.stringify(proposed("RC-0001", "c".repeat(40)))}\n`);
    const r = node(DECIDE, ["--change", "RC-0001", "--pair", `${parentRun}=${candidateRun}`, "--stage", "3", "--ledger", none]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/validation/);
    const stale = join(root, "stale.jsonl");
    write(stale, [{ ...passingValidation(), ruleHash: "0".repeat(64) }, proposed("RC-0001", "c".repeat(40))].map((l) => `${JSON.stringify(l)}\n`).join(""));
    expect(node(DECIDE, ["--change", "RC-0001", "--pair", `${parentRun}=${candidateRun}`, "--stage", "3", "--ledger", stale]).status).toBe(2);
    expect(readLines(stale)).toHaveLength(2);
  });
});

// Plan amendment A2: a look is a point where a change can be accepted.
// Stage 1 can only stop a change, so a stage 1 line spends no error budget.
describe("stage 1 leaves the look counter unchanged", () => {
  let root;
  let parentRun;
  let candidateRun;
  beforeAll(async () => {
    root = tempDir("oq-bench-decide-stage1-");
    parentRun = await savedRun({ parent: root, runId: "2026-10-11-ppppppp-parent", commit: "p".repeat(40), found: (c) => c >= 10 });
    candidateRun = await savedRun({ parent: root, runId: "2026-10-11-ccccccc-candidate", commit: "c".repeat(40), found: () => true });
  });

  it("writes the stage 1 line with no look, read at the alpha of the look that is due, and the next decision takes that look", () => {
    const ledger = join(root, "ledger.jsonl");
    write(ledger, [passingValidation(), proposed("RC-0001", "c".repeat(40))].map((l) => `${JSON.stringify(l)}\n`).join(""));
    expect(lookOf(readLines(ledger))).toBe(1);
    const pair = ["--pair", `${parentRun}=${candidateRun}`];

    const one = node(DECIDE, ["--change", "RC-0001", ...pair, "--stage", "1", "--ledger", ledger]);
    expect(one.status, one.stdout + one.stderr).toBe(0);
    const line = readLines(ledger).at(-1);
    expect(line).toMatchObject({ id: "RC-0001", stage: 1, look: null, alpha: null });
    expect(line.screenAlpha).toBeCloseTo(0.05 / 2, 15);
    expect(lookOf(readLines(ledger))).toBe(1);
    // Taking no look still finishes stage 1: the loop moves the change on to stage 2.
    expect(changeState(readLines(ledger), "RC-0001").due).toBe(2);

    const two = node(DECIDE, ["--change", "RC-0001", ...pair, "--stage", "3", "--ledger", ledger]);
    expect(two.status, two.stdout + two.stderr).toBe(0);
    expect(readLines(ledger).at(-1)).toMatchObject({ id: "RC-0001", event: "decided", look: 1, decision: "accepted" });
  });
});

describe("a constructed null pair is never accepted, and a constructed harmful pair is reverted", () => {
  let nullRun;
  let power;
  let harm;
  beforeAll(() => {
    nullRun = simulateNull({ sequences: 1000, looks: SIM_DEFAULTS.looks, seed: SIM_DEFAULTS.seed });
    power = simulatePower({ pairs: 40, seed: SIM_DEFAULTS.seed });
    harm = simulateHarm({ seed: SIM_DEFAULTS.seed });
  }, 300_000);

  it("accepts no null change over 1,000 simulated look sequences", () => {
    expect(nullRun.sequences).toBe(1000);
    expect(nullRun.looks).toBe(SIM_DEFAULTS.looks);
    expect(nullRun.accepted).toBe(0);
  });

  it("is a world where a resample of reviews does accept null changes, so the zero is the rule's doing", () => {
    // The same world's null pairs at the first look, read by a bootstrap that
    // treats every review as its own case.
    const world = simulatedWorld({ seed: SIM_DEFAULTS.seed });
    const rand = mulberry32(seedOf("naive", SIM_DEFAULTS.seed));
    const share = alphaAt(1) / Object.keys(LOSSES).length;
    let naive = 0;
    for (let s = 0; s < 200; s++) {
      const a = drawSide(world, rand, { runId: "a" });
      const b = drawSide(world, rand, { runId: "b" });
      const units = a.jobs.filter((j) => !j.clean).map((j) => ({ a: j.issueRecall.all, b: b.jobs.find((k) => k.caseId === j.caseId && k.repeat === j.repeat).issueRecall.all }));
      const draws = [];
      for (let i = 0; i < 2000; i++) {
        let ah = 0;
        let ao = 0;
        let bh = 0;
        let bo = 0;
        for (let k = 0; k < units.length; k++) {
          const u = units[Math.floor(rand() * units.length)];
          ah += u.a.hit;
          ao += u.a.of;
          bh += u.b.hit;
          bo += u.b.of;
        }
        draws.push(bh / bo - ah / ao);
      }
      draws.sort((x, y) => x - y);
      if (draws[Math.max(0, Math.ceil(share * draws.length) - 1)] > 0) naive++;
    }
    expect(naive).toBeGreaterThan(0);
  });

  it("accepts a real gain in the same world, so the rule is not one that accepts nothing", () => {
    // A world the size of the laptop acceptance population leaves the rule
    // little power at the predeclared losses (the precision and severity
    // guards are wide there): some, not none.
    expect(power.of).toBe(40);
    expect(power.accepted).toBeGreaterThan(0);
  });

  it("reverts a constructed harmful pair", () => {
    expect(harm.decision).toBe("reverted");
  });

  it("writes the validation line from saved runs with no false accept and no missed harm", async () => {
    const root = tempDir("oq-bench-validate-");
    // A saved run of one build whose reviews vary from repeat to repeat.
    const folder = await savedRun({ parent: root, runId: "2026-10-11-sssssss-saved", commit: "s".repeat(40), found: (c, r) => (c * 5 + r * 3) % 7 !== 0, cost: (c, r) => 0.08 + ((c + r) % 4) * 0.01 });
    const saved = validateSaved({ runs: [{ folder, specs: null }] });
    expect(saved.nullPairs.length).toBeGreaterThan(0);
    expect(saved.harmPairs.length).toBeGreaterThan(0);
    expect(saved.falseAccepts).toBe(0);
    expect(saved.missedHarms).toBe(0);
    const line = validationLine({ simulation: { ...nullRun, harm, power }, saved, at: "2026-10-11T00:00:00.000Z", id: "VAL-0001" });
    expect(line).toMatchObject({ v: 1, event: "validation", ruleHash: ruleHash(), pass: true });

    // The command writes the same kind of line into the ledger it is given.
    const ledger = join(root, "reviewer.jsonl");
    const done = node(VALIDATE, ["--run", folder, "--ledger", ledger, "--sequences", "20", "--looks", "2"]);
    // Written, and failing: fewer than 1,000 sequences never counts.
    expect(done.status, done.stdout + done.stderr).toBe(1);
    const written = readLines(ledger);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ v: 1, id: "VAL-0001", event: "validation", ruleHash: ruleHash(), saved: { falseAccepts: 0, missedHarms: 0 } });
    expect(written[0].pass).toBe(false);
    expect(written[0].reason).toMatch(/fewer than 1000/);
  }, 120_000);
});

describe("the comparison pairs only what can be paired", () => {
  it("refuses runs under other rules, on other cases, on the held-out split, or the same reviews on both sides", () => {
    const { parent, candidate } = tenOfTwelve();
    const refused = (p, c) => comparePairs([{ parent: p, candidate: c }], { alpha: 0.01 }).problems;
    expect(refused({ ...parent, rules: { version: 5, hash: "x".repeat(64) } }, candidate).join("\n")).toMatch(/rules/);
    expect(refused(parent, { ...candidate, caseIds: candidate.caseIds.slice(1) }).join("\n")).toMatch(/case/);
    expect(refused(parent, { ...candidate, split: "test" }).join("\n")).toMatch(/held-out|test split/);
    expect(refused(parent, { ...parent }).join("\n")).toMatch(/same reviews/);
  });

  it("counts unresolved findings against the candidate and for the parent", () => {
    const parent = sideOf({ runId: "parent", found: () => true, commit: "p".repeat(40) });
    const candidate = sideOf({ runId: "candidate", found: () => true });
    for (const s of [parent, candidate]) for (const j of s.jobs) if (!j.clean) Object.assign(j, review({ caseId: j.caseId, repeat: j.repeat, config: j.config, bugs: [["b1", "minor", true]], unresolved: 1 }));
    const out = comparePairs([{ parent, candidate }], { alpha: 0.01 });
    const p = out.cells[0].strata.pooled.metrics.precision;
    // Identical reviews: no change like for like, half the findings apart in the decision.
    expect(p.like.lower.delta).toBe(0);
    expect(p.parent).toBe(1);
    expect(p.candidate).toBe(0.5);
  });
});

// Review findings on the first version (sol, PR 152), each guarded here:
// 5. A guard holds at exactly its predeclared loss, and the rounding
//    allowance widens what passes: a reading at the loss fails the guard,
//    and the allowance may only shrink what passes.
// 6. A metric with two bounds gets two chances to reject no change within
//    one share, one per like for like reading: each reading is tested at
//    half the share (one test at the whole share when both bounds are the
//    same sums).
// 7. A reader of the ledger sees a half written line: a line goes in by
//    writing the whole ledger to a temp file and renaming it into place.
// 8. The validation line names the hash of files other than the code that
//    ran: the hash is taken before the rule's modules load and again before
//    the line is written, and a difference refuses the write.
describe("a guard holds at exactly its predeclared loss", () => {
  it("fails a guard whose bound sits on the loss, or inside it by less than rounding", () => {
    const at = (lo, hi) => ({ measured: true, comparable: true, lo, hi, like: null });
    expect(guardVerdict("recall", at(-0.02, 0.01), 0.02)).not.toBe("holds");
    expect(guardVerdict("recall", at(-0.02 + 1e-13, 0.01), 0.02)).not.toBe("holds");
    expect(guardVerdict("recall", at(-0.019, 0.01), 0.02)).toBe("holds");
    expect(guardVerdict("costPerReview", at(-0.01, 0.015), 0.015)).not.toBe("holds");
    expect(guardVerdict("costPerReview", at(-0.01, 0.0149), 0.015)).toBe("holds");
    // A better bound on the loss is a loss of at least that much.
    expect(guardVerdict("recall", at(-0.05, -0.02), 0.02)).toBe("breaks");
    expect(guardVerdict("costPerReview", at(0.015, 0.05), 0.015)).toBe("breaks");
  });
});

describe("a metric with two bounds gets two chances to reject within one share", () => {
  const two = (lower, upper, same = false) => ({ measured: true, comparable: true, like: { same, lower: { comparable: true, ...lower }, upper: { comparable: true, ...upper } } });
  it("tests each like for like reading at half the share", () => {
    expect(changeVerdict(two({ pBetter: 0.0015, pWorse: 1 }, { pBetter: 1, pWorse: 1 }), 0.002)).toBe("no change");
    expect(changeVerdict(two({ pBetter: 1, pWorse: 1 }, { pBetter: 1, pWorse: 0.0015 }), 0.002)).toBe("no change");
    expect(changeVerdict(two({ pBetter: 0.0009, pWorse: 1 }, { pBetter: 1, pWorse: 1 }), 0.002)).toBe("better");
    expect(changeVerdict(two({ pBetter: 0.0009, pWorse: 1 }, { pBetter: 1, pWorse: 0.0009 }), 0.002)).toBe("mixed");
  });
  it("tests once at the whole share when the two bounds are the same sums, or the metric has one", () => {
    expect(changeVerdict(two({ pBetter: 0.0015, pWorse: 1 }, { pBetter: 0.0015, pWorse: 1 }, true), 0.002)).toBe("better");
    expect(changeVerdict({ measured: true, comparable: true, pBetter: 1, pWorse: 0.0015, like: null }, 0.002)).toBe("worse");
  });
  it("marks the two readings as the same sums when nothing is unresolved", () => {
    const { parent, candidate } = tenOfTwelve();
    const p = comparePairs([{ parent, candidate }], { alpha: 0.01 }).cells[0].strata.pooled.metrics.recall;
    expect(p.like.same).toBe(true);
  });
});

describe("a reader of the ledger sees a half written line", () => {
  it("replaces the ledger whole through a temp file, and leaves a ledger cut mid-line as it is", () => {
    const dir = tempDir("oq-bench-ledger-");
    const ledger = join(dir, "reviewer.jsonl");
    write(ledger, `${JSON.stringify({ v: 1, id: "A" })}\n`);
    const before = statSync(ledger).ino;
    appendLedgerLine(ledger, { v: 1, id: "B", big: "x".repeat(200_000) });
    expect(statSync(ledger).ino).not.toBe(before);
    expect(readLines(ledger).map((l) => l.id)).toEqual(["A", "B"]);
    expect(readdirSync(dir)).toEqual(["reviewer.jsonl"]);
    const cut = `${JSON.stringify({ v: 1, id: "A" })}\n{"v":1,"id":`;
    write(ledger, cut);
    expect(() => appendLedgerLine(ledger, { v: 1, id: "C" })).toThrow(/newline/);
    expect(readFileSync(ledger, "utf8")).toBe(cut);
    expect(readdirSync(dir)).toEqual(["reviewer.jsonl"]);
  });
});

describe("the validation line names the hash of files other than the code that ran", () => {
  it("hashes the rule's files before it loads them: its static imports load none of them", () => {
    const src = readFileSync(VALIDATE, "utf8");
    const statics = [...src.matchAll(/^import [^;]* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(statics.length).toBeGreaterThan(0);
    for (const s of statics) expect(s.startsWith("node:") || s === "./rule-hash.mjs", s).toBe(true);
    expect(HASH_AT_LOAD).toBe(ruleHash());
  });

  it("refuses to write the line when the rule's files changed after they were loaded", () => {
    const dir = tempDir("oq-bench-ledger-");
    const ledger = join(dir, "reviewer.jsonl");
    const build = (id) => ({ v: 1, id, event: "validation", ruleHash: "0".repeat(64), pass: true });
    expect(() => writeValidationLine({ ledger, build, hashAtLoad: "0".repeat(64) })).toThrow(/changed/);
    expect(existsSync(ledger)).toBe(false);
    const line = writeValidationLine({ ledger, build: (id) => ({ ...build(id), ruleHash: HASH_AT_LOAD }), hashAtLoad: HASH_AT_LOAD });
    expect(line.id).toBe("VAL-0001");
    expect(readLines(ledger)).toHaveLength(1);
  });
});

describe("a zero parent fraction guard reverts or blocks a comparison", () => {
  it("does not judge a fraction guard without a parent baseline", () => {
    for (const metric of ["costPerReview", "secondsPerReview"]) {
      for (const candidate of [0, 1]) {
        const reading = { measured: true, comparable: true, parent: 0, candidate, delta: candidate, lo: candidate, hi: candidate, like: null };
        expect(guardVerdict(metric, reading, lossIn(metric, LOSSES[metric], 0))).toBe("not measured");
      }
    }
  });

  it("accepts a primary gain with zero parent cost, including an A/A comparison", () => {
    const pair = tenOfTwelve();
    for (const side of [pair.parent, pair.candidate]) for (const job of side.jobs) job.costUsd = 0;
    const out = decide({ id: "zero-cost", record: record(), pairs: [pair], aaPairs: [{ parent: pair.parent, candidate: { ...pair.parent, runId: "parent-aa" } }], look: 1, stage: 3 });
    expect(out.decision).toBe("accepted");
    expect(out.cells[0].verdicts.pooled.costPerReview).toBe("not measured");
    expect(out.cells[0].aa.costPerReview).toBeUndefined();
    expect(out.reason).toContain("cost not measured on the parent");
    expect(out.harms).toEqual([]);
    expect(out.open).toEqual([]);
    const harmful = tenOfTwelve({ wrong: () => 2 });
    harmful.parent = pair.parent;
    for (const job of harmful.candidate.jobs) job.costUsd = 0;
    expect(decide({ id: "zero-cost-harm", record: record(), pairs: [harmful], look: 1, stage: 3 }).decision).toBe("reverted");
  });

  it("still enforces positive parent fraction guards and zero parent absolute guards", () => {
    const reading = { measured: true, comparable: true, parent: 1, candidate: 2, delta: 1, lo: 1, hi: 1, like: null };
    expect(guardVerdict("costPerReview", reading, lossIn("costPerReview", 0.15, 1))).toBe("breaks");
    expect(guardVerdict("cleanFindings", { ...reading, parent: 0 }, 0.1)).toBe("breaks");
  });
});
