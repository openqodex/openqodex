#!/usr/bin/env node
// The reviewer loop's driver (P3-05): one iteration takes one change from
// its record through the three stages of loop/stages.mjs, one step at a
// time, and writes one line per step to benchmark/index/ledger/reviewer.jsonl.
//
//   node benchmark/loop.mjs propose <record.json> [--repo <dir>] [--ledger <file>]
//   node benchmark/loop.mjs step --change <RC-id> --parent <run> [--parent <run> ...]
//        [--candidate <run> ...] [--checkout <dir>] [--parent-checkout <dir>]
//        [--results <dir>] [--ledger <file>] [--decisions <file>]
//        [--model-script <file>] [--install-root <dir>/tools]
//        [--allow-missing-scanners] [--max-minutes 600] [--wave <id>]
//   node benchmark/loop.mjs status [--ledger <file>]
//
// propose is the lever door (loop/propose.mjs), refused while the
// earliest-failure signal says stop. step runs the stage the ledger says is
// due: it reads the parent's saved runs (--parent, one per path and
// reviewer group the change runs on), makes or grows the candidate's runs by
// invoking run.mjs from --checkout (a checkout of the change's commit, built
// with node benchmark/build-cli.mjs; this repository by default) with the
// parent's own settings, decides through decide.mjs and writes the line.
// --candidate names a saved run made for the change (run.mjs --change
// <RC-id>) to use instead of running one; a stage whose runs all exist
// already costs nothing. The driver never calls a model: run.mjs does, with
// the reviewer the parent's runs used (model:scripted in tests, whose script
// prices its tokens, so what it records is what a real run would cost).
//
// A server run gets the day's room as its hard cap: --max-usd is what its
// folder spent before plus the smaller of the day's room (60 dollars a day,
// less what the ledger's lines record today) and what is left of the
// change's own cap. lib/budget.mjs holds every model call to it before the
// call is sent. A laptop run is held by --max-reviews to what is left of the
// change's laptop reviews. A step that runs a reviewer other than the
// scripted model names its wave with --wave, which each run.mjs it starts
// gets: each run reserves its forecast in the wave journal (lib/wave.mjs)
// and settles it, one run at a time under the wave's lock.
//
// Exit codes: 0 a line is written; 1 refused (nothing run, nothing
// written); 2 the step failed.
//
// Failure list, written before the code:
// 1. An iteration behind after stage 1 spends through stage 3: stage 1's
//    screen stops it (loop/stages.mjs), the stop is a decision, and a
//    decided change is refused before anything runs.
// 2. The loop reads a test-split run: every run it is named or makes is read
//    by its manifest first, and a held-out one (test split, a held-out
//    suite) is refused before any sample of any run is read.
// 3. Two iterations take one look number: the look is read and the line
//    written under one hold of the ledger lock (loop/ledger.mjs).
// 4. The daily cap is exceeded by a stage 2 decision that was forecast under
//    it: the forecast only decides whether to start; the room is the run's
//    hard cap.
// 5. A lever is chosen after the earliest-failure signal said stop, or
//    before it said go: propose and step are refused.
// 6. A decision runs on a rule nobody validated, or a candidate built from
//    another commit: the last validation line must pass for this rule, and
//    the checkout's provenance must name the change's commit, clean.
// 7. A parent is reused across a change of reviewer, model, script, machine
//    or settings, or after a week: those runs are not compared; the line
//    says why and the person re-runs the parent.
// 8. A candidate run that spent before the ledger named it is left out of
//    the day's room, so the day ends past its cap: what the step's runs
//    spent and the ledger has not recorded counts against the room first.
// 9. A second change enters stage 2 between this step's check and its line:
//    the check runs again under the ledger lock, as the line is written.
// 10. A step that dies leaves its run.mjs spending: run.mjs runs in a
//    process group of its own, named in the run lock (loop/ledger.mjs).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/cases.mjs";
import { resultsRoot } from "./lib/index.mjs";
import { jobState, resumeProblems } from "./lib/runner.mjs";
import { originOf } from "./lib/score.mjs";
import { decisionsPath } from "./score.mjs";
import { loadSides, pairsOf, readRulings, runFolder } from "./loop/compare.mjs";
import { REQUIRED_REVIEWERS, Refusal, decide, decisionLine, lookOf, validationProblems } from "./loop/decide.mjs";
import { ToolError } from "./loop/leak-check.mjs";
import { DAILY_SERVER_USD, changeSpend, dailyRoom, folderSpend, signalRefusal, stepSpend, takeRunLock, withLedger } from "./loop/ledger.mjs";
import { LEDGER, propose, readLedger } from "./loop/propose.mjs";
import { PARENT_MAX_AGE_DAYS, STAGES, changeState, inDecision, repeatsFor, screen, scriptedReviewers, stageOutcome } from "./loop/stages.mjs";

const USAGE = "usage: node benchmark/loop.mjs propose <record.json> [--repo <dir>] [--ledger <file>]\n       node benchmark/loop.mjs step --change <RC-id> --parent <run> [--parent <run> ...] [--candidate <run> ...] [--checkout <dir>] [--parent-checkout <dir>] [--results <dir>] [--ledger <file>] [--decisions <file>] [--model-script <file>] [--install-root <dir>/tools] [--allow-missing-scanners] [--max-minutes 600] [--wave <id>]\n       node benchmark/loop.mjs status [--ledger <file>]";

// A laptop run's --max-usd is a forecast stop on account usage, not money:
// this many dollars per review it may start (P1's table puts a real pull
// request review by Claude Code at about one dollar).
const LAPTOP_USD_PER_REVIEW = 2;
const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const o = { command: argv[0] ?? null, positional: [], change: null, parents: [], candidates: [], checkout: repoRoot, parentCheckout: null, results: resultsRoot, ledger: LEDGER, decisions: decisionsPath, modelScript: null, installRoot: null, allowMissingScanners: false, maxMinutes: 600, repo: repoRoot, wave: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Refusal(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--change") o.change = value();
    else if (a === "--parent") o.parents.push(resolve(runFolder(value())));
    else if (a === "--candidate") o.candidates.push(resolve(runFolder(value())));
    else if (a === "--checkout") o.checkout = resolve(value());
    else if (a === "--parent-checkout") o.parentCheckout = resolve(value());
    else if (a === "--results") o.results = resolve(value());
    else if (a === "--ledger") o.ledger = resolve(value());
    else if (a === "--decisions") o.decisions = resolve(value());
    else if (a === "--model-script") o.modelScript = resolve(value());
    else if (a === "--install-root") o.installRoot = resolve(value());
    else if (a === "--repo") o.repo = resolve(value());
    else if (a === "--wave") o.wave = value();
    else if (a === "--allow-missing-scanners") o.allowMissingScanners = true;
    else if (a === "--max-minutes") {
      o.maxMinutes = Number(value());
      if (!(o.maxMinutes > 0)) throw new Refusal("--max-minutes takes a number above 0");
    } else if (a.startsWith("--")) throw new Refusal(`unknown flag ${a}\n${USAGE}`);
    else o.positional.push(a);
  }
  if (!["propose", "step", "status"].includes(o.command)) throw new Refusal(USAGE);
  return o;
}

// ---------------------------------------------------------------------------
// Runs, read by their manifest only.

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const readJsonLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// A run as the loop knows it before any sample is read: its folder, id,
// manifest, path, suite and how it last ended.
function runOf(folder, role) {
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) throw new Refusal(`${folder} holds no manifest.json, so it is not a run the loop can read`);
  const last = [...readJsonLines(join(folder, "resumes.jsonl"))].reverse().find((r) => r.event === "ended") ?? manifest.ended ?? null;
  return { folder, role, runId: manifest.runId ?? basename(folder), manifest, path: manifest.path ?? "laptop", suite: manifest.suite ?? "planted", reviewers: Object.keys(manifest.reviewers ?? {}), configs: manifest.configs ?? [], ended: last };
}

// Why a run is held out of the loop (failure 2): the test split, a suite
// the loop never reads, or not a review run.
function heldOut(run) {
  const m = run.manifest;
  const out = [];
  if ((m.split ?? "dev") !== "dev") out.push(`${run.runId} is a held-out (test split) run; the loop reads development runs only, and a held-out run is read only by a release (PLAN 4.10)`);
  const origin = originOf(run.suite);
  if (origin === null || origin === "injected") out.push(`${run.runId} is a run of the ${run.suite} suite, which is held out of the loop`);
  if ((m.mode ?? "review") !== "review") out.push(`${run.runId} is a ${m.mode} run; the reviewer loop compares review runs`);
  return out;
}

// What a parent run must be to be compared with a candidate now (failure 7):
// built at the record's parent, under a week old, not a draft, with every
// scanner unless the step allows missing ones.
function parentProblems(run, record, o, now) {
  const m = run.manifest;
  const out = [];
  if (m.build?.commit !== record.parent) out.push(`${run.runId} was built from ${String(m.build?.commit).slice(0, 8)}, not the change's parent ${record.parent.slice(0, 8)}`);
  if (m.build?.dirty) out.push(`${run.runId} was built from a tree its commit does not hold (dirty)`);
  const started = Date.parse(m.started_at ?? "");
  if (!(now - started <= PARENT_MAX_AGE_DAYS * DAY_MS)) out.push(`${run.runId} started ${m.started_at ?? "at an unknown time"}, more than ${PARENT_MAX_AGE_DAYS} days ago; re-run the parent`);
  if (m.draft) out.push(`${run.runId} is a draft run, which is never compared`);
  if (m.scannersComplete === false && !o.allowMissingScanners) out.push(`${run.runId} ran without every scanner; --allow-missing-scanners compares it anyway (such a run is never accepted into the index)`);
  if (run.ended?.how !== "finished") out.push(`${run.runId} ended "${run.ended?.how ?? "never"}", not finished; resume it first`);
  return out;
}

// What a candidate run must be: made for this change, from its commit.
function candidateProblems(run, id, record) {
  const m = run.manifest;
  const out = [];
  if (m.changeId !== id) out.push(`${run.runId} was made for ${m.changeId ?? "no change"}, not ${id} (run.mjs --change ${id})`);
  if (m.build?.commit !== record.commit) out.push(`${run.runId} was built from ${String(m.build?.commit).slice(0, 8)}, not the change's commit ${record.commit.slice(0, 8)}`);
  if (m.build?.dirty) out.push(`${run.runId} was built from a tree its commit does not hold (dirty)`);
  if (m.draft) out.push(`${run.runId} is a draft run, which is never compared`);
  return out;
}

const sameGroup = (a, b) => a.suite === b.suite && a.path === b.path && JSON.stringify(a.configs) === JSON.stringify(b.configs);

// Settings that differ between a parent and its candidate beyond the build,
// the repeats and the change id (lib/runner.mjs resumeProblems).
const settingsDiffer = (parent, candidate) => resumeProblems(parent.manifest, candidate.manifest).filter((d) => !/^(CLI bundle|repeats|change):/.test(d));

// ---------------------------------------------------------------------------
// run.mjs, invoked with the parent's own settings.

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const expandHome = (p) => (typeof p === "string" && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// The flags that make a run of the parent's population with the parent's
// settings. Refuses when a model script or scanner folder cannot be found as
// the parent recorded it.
function runFlags(parent, o, checkout) {
  const m = parent.manifest;
  const first = parent.reviewers[0];
  const prefix = `${first.replace(/:/g, "-")}-graph-`;
  const graph = parent.configs.filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length));
  const cases = parent.suite === "planted" ? m.cases : m.cases.map((n) => `${parent.suite}/${n}`);
  const flags = ["--reviewers", parent.reviewers.join(","), "--cases", cases.join(","), "--graph", graph.join(","), "--timeout", String(m.review?.timeoutSeconds), "--concurrency", String(m.concurrency)];
  if (parent.suite !== "planted") flags.push("--suite", parent.suite, "--split", "dev");
  if (m.subset) flags.push("--subset", m.subset);
  if (m.scannersComplete === false) flags.push("--allow-missing-scanners");
  if (parent.path === "laptop") return [...flags, "--web", m.review?.web ?? "off"];
  const r = m.reviewers[first];
  if (r.settings?.effort) flags.push("--model-effort", r.settings.effort);
  flags.push("--max-output-tokens", String(r.settings?.maxOutputTokens), "--review-max-usd", String(m.budget?.hardCaps?.reviewMaxUsd));
  const scripted = parent.reviewers.map((n) => m.reviewers[n]).find((x) => x.script);
  if (scripted) {
    const file = o.modelScript ?? join(checkout, scripted.script.file);
    if (!existsSync(file)) throw new Refusal(`${parent.runId} was reviewed by the scripted model with ${scripted.script.file}, which is not in ${checkout}; name it with --model-script`);
    if (sha256File(file) !== scripted.script.sha256) throw new Refusal(`${file} is not the script ${parent.runId} was reviewed with (sha256 ${scripted.script.sha256.slice(0, 12)})`);
    flags.push("--model-script", file);
  }
  const tools = o.installRoot ?? expandHome(m.review?.installRoot);
  if (tools) flags.push("--install-root", tools);
  return flags;
}

// The checkout a run is made from must hold the build of `commit`, clean
// (failure 6).
function checkoutProblems(dir, commit, what) {
  const p = readJson(join(dir, "benchmark", ".build", "provenance.json"));
  if (!p) return [`${dir} has no benchmark/.build/provenance.json; build the ${what} there with node benchmark/build-cli.mjs`];
  const out = [];
  if (p.commit !== commit) out.push(`the build in ${dir} is of ${String(p.commit).slice(0, 8)}, not the ${what} ${commit.slice(0, 8)}`);
  if (p.dirty) out.push(`the build in ${dir} was made from a tree its commit does not hold (dirty)`);
  return out;
}

// The reviews one repeat of a run holds: every case under every configuration.
const perRepeat = (m) => (m.cases?.length ?? 0) * (m.configs?.length ?? 0);

// What a run folder needs before a stage can read `repeats` of it: nothing,
// a new run of the parent's population, a resume of an unfinished one, more
// repeats, or a resume and then more repeats. `reviews` is how many reviews
// that starts.
function workFor(run, repeats, parent) {
  if (!run.manifest) return { reviews: perRepeat(parent.manifest) * repeats, actions: [{ kind: "new", repeats }] };
  const m = run.manifest;
  const actions = [];
  let reviews = 0;
  if (run.ended?.how !== "finished") {
    actions.push({ kind: "resume" });
    reviews += (m.jobs ?? []).filter((j) => !jobState(run.folder, { ...j, case: j.caseId.replace(/^[^/]+\//, "").replace(/@[0-9a-f]+$/, "") }).done).length;
  }
  if ((m.repeat ?? 0) < repeats) {
    actions.push({ kind: "add", add: repeats - m.repeat, to: repeats });
    reviews += perRepeat(m) * (repeats - m.repeat);
  }
  return { reviews, actions };
}

// One invocation of run.mjs from `checkout`, in a process group of its own
// whose number goes into the run lock before the run starts spending
// (`started`), so a lock left by a step that dies stays live while the run
// does. Ctrl-C and SIGTERM to this step are passed on to that group. Its
// output goes to this process's stdout. Resolves to its exit and how the
// run says it ended.
function invokeRun({ checkout, flags, folder, started }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(checkout, "benchmark", "run.mjs"), ...flags, "--out", folder], { cwd: checkout, env: { ...process.env, OPENQODEX_WAVE_PATH: "loop" }, stdio: ["ignore", 1, 1], detached: true });
    const pass = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // gone already
      }
    };
    process.on("SIGINT", pass);
    process.on("SIGTERM", pass);
    if (child.pid !== undefined) started({ pid: child.pid, pgid: child.pid });
    let failed = null;
    child.on("error", (error) => (failed = error));
    child.on("close", (status, signal) => {
      process.off("SIGINT", pass);
      process.off("SIGTERM", pass);
      const run = existsSync(join(folder, "manifest.json")) ? runOf(folder, null) : null;
      done({ status: failed ? 2 : status, signal, ended: run?.ended ?? null });
    });
  });
}

// ---------------------------------------------------------------------------
// The step.

const money = (usd) => `$${usd.toFixed(4)}`;

async function step(o) {
  const id = o.change;
  if (!/^RC-\d{4}$/.test(id ?? "")) throw new Refusal("name the change with --change RC-<4 digits>");
  if (o.parents.length === 0) throw new Refusal("name the parent's saved runs with --parent <run>, one per path and reviewer group the change runs on");
  const started = Date.now();
  const lines = readLedger(o.ledger);
  const state = changeState(lines, id);
  if (!state.record) throw new Refusal(`the ledger ${o.ledger} holds no proposed change ${id}`);
  if (state.decided) throw new Refusal(`${id} is decided: ${state.decided.decision} at stage ${state.decided.stage} (look ${state.decided.look}); nothing more runs for it`);
  const signal = signalRefusal(lines);
  if (signal) throw new Refusal(`refused: ${signal}`);
  const invalid = validationProblems(lines);
  if (invalid.length > 0) throw new Refusal(`refused: no decision before a passing validation of the rule:\n${invalid.map((p) => `- ${p}`).join("\n")}`);
  const stage = state.due;
  const record = state.record;
  if (stage >= 2) {
    const other = inDecision(lines, id);
    if (other) throw new Refusal(`${other} is in stage 2 or 3; one change is decided at a time, so ${id} waits until ${other} is decided`);
  }

  // Every run named, by its manifest only (failure 2).
  const parents = o.parents.map((f) => runOf(f, "parent"));
  const fed = o.candidates.map((f) => runOf(f, "candidate"));
  const held = [...parents, ...fed].flatMap(heldOut);
  if (held.length > 0) throw new Refusal(`refused, nothing read or run:\n${held.map((h) => `- ${h}`).join("\n")}`);
  const now = Date.now();
  const bad = [...parents.flatMap((p) => parentProblems(p, record, o, now)), ...fed.flatMap((c) => candidateProblems(c, id, record))];
  if (bad.length > 0) throw new Refusal(`refused, nothing run:\n${bad.map((b) => `- ${b}`).join("\n")}`);

  // The parent runs this stage reads: the target path at stage 1, every
  // path the change runs on after it.
  const wanted = stage === 1 ? [record.target] : record.paths;
  const used = parents.filter((p) => wanted.includes(p.path));
  const missing = [];
  for (const path of wanted) {
    const here = used.filter((p) => p.path === path);
    if (here.length === 0) missing.push(`the ${path} path, which stage ${stage} reads, has no --parent run`);
    if (stage >= 2) for (const r of REQUIRED_REVIEWERS[path] ?? []) if (!here.some((p) => p.reviewers.includes(r))) missing.push(`the ${path} path has no --parent run by ${r}, which a decision needs`);
  }
  // One pair per suite, path and reviewer (compare.mjs), and every saved
  // candidate the parent of one of them.
  for (const [i, a] of used.entries()) for (const b of used.slice(i + 1)) if (a.suite === b.suite && a.path === b.path && a.reviewers.some((r) => b.reviewers.includes(r))) missing.push(`${a.runId} and ${b.runId} are both ${a.suite} runs of ${a.reviewers.filter((r) => b.reviewers.includes(r)).join(", ")} on the ${a.path} path; name one parent per suite, path and reviewer`);
  for (const c of fed) if (!parents.some((p) => sameGroup(c, p))) missing.push(`--candidate ${c.runId} matches no --parent run (the same suite, path and configurations)`);
  if (missing.length > 0) throw new Refusal(`refused, nothing run:\n${missing.map((m) => `- ${m}`).join("\n")}`);

  // Each parent's candidate: a saved run named with --candidate, else the
  // loop's own folder for it.
  const pairs = used.map((parent) => {
    const given = fed.filter((c) => sameGroup(c, parent));
    if (given.length > 1) throw new Refusal(`${given.map((c) => c.runId).join(" and ")} both match the parent ${parent.runId}; name one`);
    const folder = given[0]?.folder ?? join(o.results, `${id}-${parent.runId}`);
    const candidate = given[0] ?? (existsSync(join(folder, "manifest.json")) ? runOf(folder, "candidate") : { folder, role: "candidate", runId: basename(folder), manifest: null, path: parent.path });
    if (candidate.manifest) {
      const problems = [...heldOut(candidate), ...candidateProblems(candidate, id, record)];
      if (problems.length > 0) throw new Refusal(`refused, nothing run:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    }
    const repeats = repeatsFor(stage, parent.path, record.target);
    return { parent, candidate, repeats, candidateWork: workFor(candidate, repeats, parent), parentWork: (parent.manifest.repeat ?? 0) < repeats ? workFor(parent, repeats, parent) : { reviews: 0, actions: [] } };
  });
  for (const p of pairs) if (p.parentWork.actions.length > 0 && o.parentCheckout === null) throw new Refusal(`stage ${stage} reads ${p.repeats} repeats of the parent ${p.parent.runId}, which holds ${p.parent.manifest.repeat}; name the parent's build with --parent-checkout so the loop adds them`);

  // Every run the step names, with what each had spent when it began.
  const runs = pairs.flatMap((p) => [p.parent, p.candidate]).map((r) => ({ runId: r.runId, folder: r.folder, path: r.path, role: r.role, before: r.role === "parent" ? folderSpend(r.folder) : { usd: 0, reviews: 0 } }));
  const work = pairs.flatMap((p) => [
    ...(p.parentWork.actions.length > 0 ? [{ run: p.parent, parent: p.parent, work: p.parentWork, checkout: o.parentCheckout }] : []),
    ...(p.candidateWork.actions.length > 0 ? [{ run: p.candidate, parent: p.parent, work: p.candidateWork, checkout: o.checkout }] : []),
  ]);
  // The target path first: a stop there ends the step before the other paths spend.
  work.sort((a, b) => (a.run.path === record.target ? 0 : 1) - (b.run.path === record.target ? 0 : 1));

  let lock = null;
  let ran = { finished: true, reason: null, forecastUsd: 0, bound: null, roomUsd: null };
  try {
    if (work.length > 0) {
      const checks = [...new Set(work.map((w) => w.checkout))].flatMap((dir) => checkoutProblems(dir, dir === o.checkout ? record.commit : record.parent, dir === o.checkout ? "change's commit" : "change's parent"));
      if (checks.length > 0) throw new Refusal(`refused, nothing run:\n${checks.map((c) => `- ${c}`).join("\n")}`);
      for (const w of work) w.flags = runFlags(w.parent, o, w.checkout);
      // A reviewer other than the scripted model pays a model, so its runs need the wave.
      const paid = work.filter((w) => w.parent.reviewers.some((r) => r !== "model:scripted"));
      if (paid.length > 0 && o.wave === null) throw new Refusal(`refused, nothing run: ${paid.map((w) => w.run.runId).join(", ")} would pay a model; name the wave with --wave <id> (node benchmark/lib/wave.mjs --wave-new <id> starts one)`);
      if (o.wave !== null) for (const w of work) w.flags.push("--wave", o.wave);
      lock = takeRunLock(o.ledger, { change: id, stage, runs });
      if (lock.stale) settleAbandoned(o.ledger, lock.stale);
      ran = await runWork({ o, id, stage, record, work, runs, lock });
      if (ran.refusal) throw new Refusal(ran.refusal);
    }
    const out = writeLine({ o, id, stage, record, pairs, runs, ran, started });
    // Nothing was spent and nothing decided: no line, and the step says why.
    if (out.refusal) throw ran.failed ? new ToolError(out.refusal) : new Refusal(out.refusal);
    return out.line;
  } finally {
    lock?.release();
  }
}

// The line for what a dead step's runs spent (loop/ledger.mjs failure 5).
function settleAbandoned(ledger, stale) {
  withLedger(ledger, (lines) => {
    const spend = stepSpend(lines, stale.runs ?? []);
    const line = { v: 1, id: stale.change, at: new Date().toISOString(), event: "abandoned", stage: stale.stage ?? null, look: null, alpha: null, decision: null, runs: [], reason: `the step that ran stage ${stale.stage} of ${stale.change} (process ${stale.pid}, since ${stale.at}) ended without its line; this records what its runs spent`, spend, spendUsd: spend.serverUsd + spend.laptopUsd, laptopReviews: spend.laptopReviews, minutes: null, pr: null };
    return { write: [line] };
  });
}

// Runs the stage's work, server runs held to the day's room. Returns
// whether every run finished, and why not. What the step's runs spent that
// the ledger has not recorded yet (a candidate run made before the step, a
// run a dead step left) counts against the day and the change first.
async function runWork({ o, id, stage, record, work, runs, lock }) {
  const lines = readLedger(o.ledger);
  const ledgerDay = dailyRoom(lines);
  const pending = stepSpend(lines, runs);
  const day = { ...ledgerDay, roomUsd: Math.max(0, ledgerDay.roomUsd - pending.serverUsd), pendingUsd: pending.serverUsd };
  const change = changeSpend(lines, id);
  const capLeftUsd = Math.max(0, record.capUsd - change.serverUsd - pending.serverUsd);
  const capLeftReviews = Math.max(0, record.capReviews - change.laptopReviews - pending.laptopReviews);
  const server = work.filter((w) => w.run.path === "server");
  const laptop = work.filter((w) => w.run.path === "laptop");
  const serverReviews = server.reduce((n, w) => n + w.work.reviews, 0);
  const laptopReviews = laptop.reduce((n, w) => n + w.work.reviews, 0);
  // What a server review has cost: this change's so far, else its parents'.
  const parentCost = server.map((w) => folderSpend(w.parent.folder)).reduce((t, s) => ({ usd: t.usd + s.usd, reviews: t.reviews + s.reviews }), { usd: 0, reviews: 0 });
  const perReview = change.serverReviews > 0 ? change.serverUsd / change.serverReviews : parentCost.reviews > 0 ? parentCost.usd / parentCost.reviews : 0;
  const forecastUsd = serverReviews * perReview;
  const bound = day.roomUsd <= capLeftUsd ? "daily" : "change";
  let allowedUsd = Math.min(day.roomUsd, capLeftUsd);
  const reviewCap = Math.max(0, ...server.map((w) => w.parent.manifest.budget?.hardCaps?.reviewMaxUsd ?? 0));
  const base = { forecastUsd, bound, roomUsd: day.roomUsd, capLeftUsd };
  if (server.length > 0) {
    if (allowedUsd < reviewCap || forecastUsd > allowedUsd) {
      const why = allowedUsd < reviewCap ? `one review may spend up to ${money(reviewCap)}` : `stage ${stage}'s ${serverReviews} server reviews are forecast at ${money(forecastUsd)}`;
      if (bound === "daily") return { ...base, refusal: `refused, nothing run: the daily server cap of $${DAILY_SERVER_USD} leaves ${money(day.roomUsd)} on ${day.day} (${money(day.spentUsd)} recorded in the ledger${day.pendingUsd > 0 ? `, and ${money(day.pendingUsd)} this step's runs spent that it has not recorded yet` : ""}), and ${why}; step again on a later day` };
      return { ...base, finished: false, capped: true, reason: `the change's server cap of $${record.capUsd} leaves ${money(capLeftUsd)}, and ${why}` };
    }
  }
  if (laptopReviews > capLeftReviews) return { ...base, finished: false, capped: true, reason: `the change's cap of ${record.capReviews} laptop reviews leaves ${capLeftReviews}, and stage ${stage} needs ${laptopReviews}` };
  console.log(`${id} stage ${stage} (${STAGES[stage].name}): ${work.length} runs to make or grow; ${serverReviews} server reviews forecast at ${money(forecastUsd)}, held to ${money(allowedUsd)} (the ${bound === "daily" ? `day's room of $${DAILY_SERVER_USD}` : "change's cap"}); ${laptopReviews} laptop reviews.`);

  for (const w of work) {
    for (const action of w.work.actions) {
      const spent = folderSpend(w.run.folder);
      const flags = [...w.flags, "--max-minutes", String(o.maxMinutes)];
      // A parent keeps the change id it was made with (none, for a baseline): run.mjs refuses a resume that changes it.
      const changeId = w.run.role === "candidate" ? id : (w.run.manifest.changeId ?? null);
      if (changeId) flags.push("--change", changeId);
      if (w.run.path === "server") flags.push("--max-usd", String(Math.round((spent.usd + allowedUsd) * 1e9) / 1e9));
      else flags.push("--max-usd", String(spent.usd + LAPTOP_USD_PER_REVIEW * Math.max(1, w.work.reviews)), "--max-reviews", String(spent.reviews + Math.min(capLeftReviews, Math.max(1, Math.ceil(w.work.reviews)))));
      if (action.kind === "new") flags.push("--repeat", String(action.repeats), ...(action.repeats > 3 ? ["--allow-more"] : []));
      else if (action.kind === "resume") flags.push("--resume");
      else flags.push("--add-repeats", String(action.add), ...(action.to > 3 ? ["--allow-more"] : []));
      const r = await invokeRun({ checkout: w.checkout, flags, folder: w.run.folder, started: (child) => lock.update({ child }) });
      lock.update({ child: null });
      if (w.run.path === "server") allowedUsd = Math.max(0, allowedUsd - (folderSpend(w.run.folder).usd - spent.usd));
      if (r.status === 0 && r.ended?.how === "finished") continue;
      const why = r.ended && r.ended.how !== "finished" ? `${r.ended.how}${r.ended.why ? `: ${r.ended.why}` : ""}` : `run.mjs exited ${r.status ?? r.signal} before the run ended`;
      const byBudget = r.ended?.how === "budget" && r.ended?.limit === "max-usd" && w.run.path === "server";
      const byReviews = r.ended?.how === "budget" && r.ended?.limit === "max-reviews" && w.run.path === "laptop";
      if (byBudget && bound === "daily") return { ...base, finished: false, reason: `paused by the daily server cap of $${DAILY_SERVER_USD}: ${w.run.runId} stopped (${why}); the next step on a later day finishes stage ${stage}` };
      if (byBudget || byReviews) return { ...base, finished: false, capped: true, reason: `the change's cap stopped ${w.run.runId} (${why})` };
      // Exit 2: run.mjs refused or failed (its reasons are printed above).
      return { ...base, finished: false, failed: r.status === 2, reason: `${w.run.runId} did not finish (${why}); the next step finishes stage ${stage}` };
    }
  }
  return { ...base, finished: true };
}

// Scores the stage's runs, decides under the ledger lock with the look
// that is due, and writes the one line of the step. Returns { line } or,
// when the step spent nothing and decided nothing, { refusal } with no line
// written. A step that spent and could not decide writes a line without a
// look, so the day's spend is never missing from the ledger.
function writeLine({ o, id, stage, record, pairs, runs, ran, started }) {
  const minutes = Math.round((Date.now() - started) / 600) / 100;
  let sides = null;
  // Why the runs cannot be decided now: settings that differ beyond the
  // build, or runs the scorer or the pairing refuses.
  let problems = [];
  if (ran.finished) {
    // Read again: a run made now has its manifest.
    const fresh = pairs.map((p) => ({ ...p, candidate: runOf(p.candidate.folder, "candidate"), parent: runOf(p.parent.folder, "parent") }));
    const differ = fresh.flatMap((p) => settingsDiffer(p.parent, p.candidate).map((d) => `${p.parent.runId} against ${p.candidate.runId}: ${d}`));
    const scripted = scriptedReviewers(fresh.flatMap((p) => [p.parent, p.candidate]));
    if (scripted.length > 0) problems = [`no evidence: the runs were reviewed by the scripted model (${scripted.join(", ")}), which reads no code, so they neither stop nor pass a change; only a real reviewer's runs decide. The spend is recorded`];
    else if (differ.length > 0) problems = [`the parent's runs differ from the candidate's beyond the build, so a difference would not be the change's; re-run the parent at ${record.parent.slice(0, 8)} and step again`, ...differ];
    else {
      try {
        const decisions = readRulings(o.decisions);
        sides = fresh.flatMap((p) => {
          const parentSides = loadSides({ run: p.parent.folder, decisions });
          const candidateSides = loadSides({ run: p.candidate.folder, repeats: Array.from({ length: p.repeats }, (_, i) => i + 1), decisions });
          return pairsOf(parentSides, candidateSides);
        });
      } catch (error) {
        problems = [`the runs cannot be scored and paired: ${error.message}`];
      }
    }
  }
  return withLedger(o.ledger, (lines) => {
    const spend = stepSpend(lines, runs);
    const spent = changeSpend(lines, id);
    const toDate = { serverUsd: spent.serverUsd + spend.serverUsd, laptopReviews: spent.laptopReviews + spend.laptopReviews };
    const day = dailyRoom(lines);
    const spendBlock = { ...spend, forecastUsd: ran.forecastUsd ?? 0, dayServerUsd: day.spentUsd + spend.serverUsd, changeServerUsd: toDate.serverUsd, changeLaptopReviews: toDate.laptopReviews };
    const plain = (event, decision, reason) => ({ v: 1, id, at: new Date().toISOString(), event, stage, look: null, alpha: null, decision, runs: runs.map(({ runId, role, path }) => ({ runId, role, path })), reason, spend: spendBlock, spendUsd: spend.serverUsd + spend.laptopUsd, laptopReviews: spend.laptopReviews, minutes, pr: null });
    const spentNothing = spend.serverUsd === 0 && spend.serverReviews === 0 && spend.laptopUsd === 0 && spend.laptopReviews === 0;
    let line;
    if (!ran.finished) {
      if (ran.failed && spentNothing) return { result: { refusal: ran.reason } };
      line = ran.capped ? plain("decided", "inconclusive-reverted", `inconclusive, so reverted: ${ran.reason}; nothing more may be spent on it`) : plain("stage", null, ran.reason);
    } else {
      let result = null;
      // One change at a time in stage 2 or 3, checked again as the line is
      // written: another change may have entered since the step began.
      const other = stage >= 2 && problems.length === 0 ? inDecision(lines, id) : null;
      if (other) problems = [`${other} entered stage 2 or 3 while this step ran; one change is decided at a time, so ${id} waits until ${other} is decided`];
      if (problems.length === 0) {
        try {
          result = decide({ id, record, pairs: sides, look: lookOf(lines), stage, final: stage === 3 });
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          problems = [error.message];
        }
      }
      if (result === null) {
        const why = `no look taken at stage ${stage}: ${problems.join("\n- ")}`;
        if (spentNothing) return { result: { refusal: `refused, nothing written: ${why}` } };
        line = plain("stage", null, why);
      } else {
        const rules = stage === 1 ? screen({ result, pairs: sides, record, spent: toDate }) : [];
        const outcome = stageOutcome(stage, result, rules);
        // Stage 1 can only stop, so it takes no look (A2): its line records
        // look null, and the alpha its reading used as screenAlpha.
        const looks = stage === 1 ? { look: null, alpha: null, share: null, screenAlpha: result.alpha } : {};
        line = { ...decisionLine(result, { pairs: sides }), ...looks, event: outcome.event, stageDone: outcome.event === "stage", decision: outcome.decision, reason: outcome.reason, ...(stage === 1 ? { screen: rules } : {}), spend: spendBlock, spendUsd: spend.serverUsd + spend.laptopUsd, laptopReviews: spend.laptopReviews, minutes };
      }
    }
    return { write: [line], result: { line } };
  });
}

// ---------------------------------------------------------------------------
// propose and status.

function proposeCommand(o) {
  if (o.positional.length !== 1) throw new Refusal("usage: node benchmark/loop.mjs propose <record.json> [--repo <dir>] [--ledger <file>]");
  const signal = signalRefusal(readLedger(o.ledger));
  if (signal) throw new Refusal(`refused, nothing written: ${signal}`);
  let record;
  try {
    record = JSON.parse(readFileSync(o.positional[0], "utf8"));
  } catch (error) {
    throw new ToolError(`the record ${o.positional[0]} cannot be read as JSON (${error.message})`);
  }
  const { refusals, line } = propose(record, { repo: o.repo, ledger: o.ledger });
  if (refusals.length > 0) throw new Refusal(`refused, nothing written:\n${refusals.map((r) => `- ${r}`).join("\n")}`);
  const r = line.record;
  console.log(`${line.id} proposed: lever ${r.lever}, branch ${r.branch} at ${r.commit.slice(0, 8)} from ${r.parent.slice(0, 8)}, runs on ${r.paths.join(" and ")}, target ${r.target}, primary ${r.primary.metric}; written to ${o.ledger}`);
  return 0;
}

function statusCommand(o) {
  const lines = readLedger(o.ledger);
  const day = dailyRoom(lines);
  console.log(`Ledger ${o.ledger}: next look ${lookOf(lines)}; server spend on ${day.day} ${money(day.spentUsd)} of $${DAILY_SERVER_USD}.`);
  const signal = signalRefusal(lines);
  console.log(signal ? `Levers are refused: ${signal}` : "The earliest-failure signal says go.");
  for (const p of lines.filter((l) => l.event === "proposed")) {
    const s = changeState(lines, p.id);
    const spent = changeSpend(lines, p.id);
    console.log(`- ${p.id} ${p.record.lever} (${p.record.title}): ${s.decided ? `${s.decided.decision} at stage ${s.decided.stage}` : `stage ${s.due} due`}; ${money(spent.serverUsd)} of $${p.record.capUsd} on the server, ${spent.laptopReviews} of ${p.record.capReviews} laptop reviews`);
  }
  return 0;
}

async function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.command === "propose") return proposeCommand(o);
    if (o.command === "status") return statusCommand(o);
    const line = await step(o);
    console.log(`${line.id} stage ${line.stage}: ${line.decision ?? (line.stageDone ? `passed, stage ${line.stage + 1} next` : "no decision")}${line.look !== null ? ` at look ${line.look} (alpha ${line.alpha.toPrecision(3)})` : ""}; spent ${money(line.spend.serverUsd)} on the server and ${line.spend.laptopReviews} laptop reviews. ${line.reason}\nWritten to ${o.ledger}.`);
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(error.message);
      return 1;
    }
    console.error(error instanceof ToolError ? error.message : error.stack);
    return 2;
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
