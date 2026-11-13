#!/usr/bin/env node
// The release check: the published package against the build about to be
// released, on the same cases, before every release. Sid, 2026-10-11: the
// benchmark must never break things for existing users and must show the
// product getting better, not worse.
//
//   node benchmark/release-check.mjs [--base npm:<version>|file:<path.tgz>|local]
//        [--candidate local|file:<path.tgz>|npm:<version>]
//        [--suites planted,aacr] [--subset dev-laptop] [--cases a,b]
//        [--allow-missing-scanners] [--install-scanners]
//        [--reviewers <names> --max-usd <n> --max-minutes <n>
//         [--review-max-usd <n>] [--repeat <n>] [--wave <id>]]
//        [--out <folder>] [--summary <file>]
//
// --base is the published package by default: the version the registry's
// latest tag names, read from https://registry.npmjs.org itself, as
// lib/package.mjs reads every published package. --candidate is this
// checkout's build by default (node benchmark/build-cli.mjs). Both take
// run.mjs's --package values.
//
// For each suite (planted and AACR-Bench's development subset dev-laptop by
// default), each build runs the scanner-only benchmark twice
// (run.mjs --mode scan --check-identical): no reviewer and no model, so the
// check costs nothing. The two builds' scores are compared case by case, as
// the scanner-only trend gate compares a run with its accepted run
// (trend.mjs compareScan): a scanner-only score does not vary from run to
// run, so every bug the base found and the candidate misses, every clean
// control lost, every extra false or unresolved candidate and every scan
// lost is a loss, whatever its size.
//
// --reviewers adds review runs, which the caller names and pays for: each
// build reviews each suite those reviewers review (Claude Code and Codex the
// planted cases, model reviewers any suite), with --max-usd, --max-minutes,
// --review-max-usd, --repeat and --wave passed to each run as they are
// (--wave is required unless every reviewer is model:scripted: each run
// reserves its forecast in the wave journal, lib/wave.mjs). The two
// runs are compared by loop/compare.mjs (the paired sign-flip test over
// clusters, at its family alpha), and a gate metric is a loss when its
// change is shown past the acceptable loss benchmark/loop/levers.json
// declares for it, by decide.mjs's guard rule, or when a hard rule breaks.
//
// It writes release-check.md (the report) and release-check.json beside the
// runs, in --out (benchmark/results/<date>-release-check-<base>-<candidate>
// by default), prints the report, and appends it to --summary <file> (a CI
// job summary) when given.
//
// --install-scanners first runs each build's own `doctor --install
// --all-scanners`, so a scanner one build pins at another version is
// installed for both. --allow-missing-scanners lets a run go on without
// scanners this machine cannot install; both builds must then miss the
// same ones, and the report names them as compared by neither.
//
// Exit codes: 0 no change or a gain (or a change that is neither); 1 a
// loss, each one named; 2 the check could not run (a refused flag, a
// package that is not there, a run that failed or stopped, two passes that
// differ, runs or a review metric that cannot be compared), and nothing is
// concluded.
//
// Failure list, written before the code:
// 1. A build whose scanner finds one fewer planted bug passes the check:
//    the scanner-only comparison is exact, case by case and bug by bug.
// 2. Two builds of the same code read as a change, so every release is
//    refused: each build's two passes must be identical, and only a
//    difference of the scores (times and intervals left out) is a change.
// 3. A package that is missing, or a run that failed, reads as "no change":
//    any run that does not finish, or that cannot be compared, ends the
//    check with exit 2 and the reason, and the report says nothing was
//    concluded.
// 4. A scanner one build pins at a version that is not installed is missing
//    from that build's scans only, and its bugs read as a loss or a gain of
//    the product: both builds must miss exactly the same scanners.
// 5. A review the caller names and pays for is run but left out of the
//    verdict: its comparison is loop/compare.mjs's, and its losses, gains
//    and changes join the scans'.
// 6. The check quietly compares something else than the release: the base
//    is the registry's latest version by default, read from the registry
//    itself, and the report names both builds as the runs recorded them.
// 7. A review metric one build measures and the other does not reads as no
//    change: it cannot be compared, so the check exits 2 naming it, or 1
//    when a loss is shown besides (reviewOutcome, decideVerdict).
// 8. The published package's code runs with the caller's keys: its install
//    step and the scanner-only runs get only the variables buildEnv lets
//    through. A review run keeps the caller's environment, because its
//    reviewers need their accounts, and a model review loads the package's
//    library inside run.mjs; the caller who names --reviewers runs that.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "../scripts/self-update-check-lib.mjs";
import { benchRoot, repoRoot } from "./lib/cases.mjs";
import { inputDifferences } from "./lib/external.mjs";
import { buildEntry, resultsRoot } from "./lib/index.mjs";
import { PACKAGE_NAME, REGISTRY_HOST, parsePackageSpec, preparePackage } from "./lib/package.mjs";
import { isModelReviewer } from "./lib/server-review.mjs";
import { SUITES } from "./lib/suites.mjs";
import { GATE_METRICS, METRICS, changeVerdict, comparePairs, loadSides, lossIn, pairsOf, readRulings, renderComparison } from "./loop/compare.mjs";
import { guardVerdict } from "./loop/decide.mjs";
import { compareScan } from "./trend.mjs";

const USAGE = "usage: node benchmark/release-check.mjs [--base npm:<version>|file:<path.tgz>|local] [--candidate local|file:<path.tgz>|npm:<version>] [--suites planted,aacr] [--subset dev-laptop] [--cases a,b] [--allow-missing-scanners] [--install-scanners] [--reviewers <names> --max-usd <n> --max-minutes <n> [--review-max-usd <n>] [--repeat <n>] [--wave <id>]] [--out <folder>] [--summary <file>]";
// The AACR-Bench subset a release check scans unless --subset names another.
const DEFAULT_SUBSET = "dev-laptop";
// The family error of a review comparison, split as compare.mjs splits it.
const FAMILY_ALPHA = 0.05;
// The acceptable loss of each gate metric, declared before any run.
const LEVERS = JSON.parse(readFileSync(join(benchRoot, "loop", "levers.json"), "utf8"));
const LAPTOP = ["claude", "codex"];

class CannotRun extends Error {}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

function parseArgs(argv) {
  const o = { base: null, candidate: "local", suites: ["planted", "aacr"], subset: null, cases: null, allowMissing: false, install: false, reviewers: null, maxUsd: null, maxMinutes: null, reviewMaxUsd: null, repeat: null, wave: null, out: null, summary: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--base") o.base = next();
    else if (a === "--candidate") o.candidate = next();
    else if (a === "--suites") o.suites = next().split(",").filter(Boolean);
    else if (a === "--subset") o.subset = next();
    else if (a === "--cases") o.cases = next();
    else if (a === "--allow-missing-scanners") o.allowMissing = true;
    else if (a === "--install-scanners") o.install = true;
    else if (a === "--reviewers") o.reviewers = next().split(",").filter(Boolean);
    else if (a === "--max-usd") o.maxUsd = next();
    else if (a === "--max-minutes") o.maxMinutes = next();
    else if (a === "--review-max-usd") o.reviewMaxUsd = next();
    else if (a === "--repeat") o.repeat = next();
    else if (a === "--wave") o.wave = next();
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--summary") o.summary = resolve(next());
    else throw new Error(`unknown flag ${a}`);
  }
  // A suite whose cases are all held out (martian) never runs before a release.
  const open = ["planted", ...Object.keys(SUITES).filter((s) => !SUITES[s].heldOutOnly)];
  for (const s of o.suites) if (!open.includes(s)) throw new Error(`--suites takes ${open.join(" and ")}, not ${s}`);
  if (o.suites.length === 0) throw new Error("--suites names no suite");
  if (o.subset !== null && !o.suites.some((s) => s !== "planted")) throw new Error("--subset names a subset of a pull request suite, and --suites holds none");
  if (o.cases !== null && o.suites.length !== 1) throw new Error("--cases names cases of one suite; name that suite alone in --suites");
  for (const spec of [o.base, o.candidate]) if (spec !== null) parsePackageSpec(spec);
  if (o.base !== null && o.base === o.candidate) throw new Error(`--base and --candidate both name ${o.base}; a build compared with itself shows nothing`);
  const paid = [["--max-usd", o.maxUsd], ["--max-minutes", o.maxMinutes], ["--review-max-usd", o.reviewMaxUsd], ["--repeat", o.repeat], ["--wave", o.wave]].filter(([, v]) => v !== null).map(([f]) => f);
  if (o.reviewers === null) {
    if (paid.length > 0) throw new Error(`${paid.join(", ")}: only review runs read ${paid.length === 1 ? "it" : "them"}; name the reviewers with --reviewers`);
  } else {
    if (o.reviewers.length === 0) throw new Error("--reviewers names no reviewer");
    const models = o.reviewers.filter(isModelReviewer);
    if (models.length > 0 && models.length !== o.reviewers.length) throw new Error("--reviewers mixes laptop reviewers (claude, codex) and model reviewers; run.mjs runs them apart, so name one kind per check");
    for (const r of o.reviewers) if (!isModelReviewer(r) && !LAPTOP.includes(r)) throw new Error(`--reviewers takes claude, codex or model:<deployment>, not ${r}`);
    if (o.maxUsd === null || o.maxMinutes === null) throw new Error("--reviewers needs --max-usd and --max-minutes: each review run names what it may spend and how long it may take");
    if (models.length > 0 && o.reviewMaxUsd === null) throw new Error("model reviewers need --review-max-usd: every call is held to it before it is sent");
    if (o.wave === null && o.reviewers.some((r) => r !== "model:scripted")) throw new Error("--reviewers that pay a model need --wave <id>: each review run reserves its forecast in the wave's journal (node benchmark/lib/wave.mjs --wave-new <id> starts one)");
  }
  return o;
}

// The version the registry's latest tag names, from the registry itself.
async function latestVersion() {
  const url = `https://${REGISTRY_HOST}/${PACKAGE_NAME}`;
  let body;
  try {
    const response = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" }, redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new CannotRun(`the published version could not be read from ${url}: ${error?.cause?.code ?? error.message}`);
  }
  const v = body?.["dist-tags"]?.latest;
  if (typeof v !== "string") throw new CannotRun(`${url} names no latest version`);
  return v;
}

// What a build is, before it runs: its spec, the CLI it runs, and a label.
async function describeBuild(spec) {
  if (spec === "local") {
    const p = readJson(join(benchRoot, ".build", "provenance.json"));
    const cli = join(repoRoot, "packages", "cli", "dist", "bin.js");
    return { spec, cli, slug: "local", label: p?.commit ? `this checkout's build ${p.commit.slice(0, 7)}${p.dirty ? ", built from a tree the commit does not hold" : ""}` : "this checkout's build" };
  }
  let pkg;
  try {
    pkg = await preparePackage(spec);
  } catch (error) {
    throw new CannotRun(`--package ${spec}: ${error.message}`);
  }
  const r = pkg.record;
  const from = spec.startsWith("npm:") ? "from npm" : `from ${basename(spec.slice(5))}`;
  return { spec, cli: pkg.cli, slug: spec.startsWith("npm:") ? `v${r.version}` : `file-${r.sha256.slice(0, 8)}`, label: `${r.name} ${r.version} ${from} (sha256 ${r.sha256.slice(0, 12)})` };
}

// The variables a package build's install step and a scanner-only run may
// read, and nothing else (failure 8): what node, git and tar need
// (scripts/self-update-check-lib.mjs ALLOWED_ENV, LC_*), HOME, the OpenQodex
// home and the benchmark's cache, and what the scanners' runtimes read (Go,
// Cargo and rustup, Ruby gems). No API key, token, cloud variable or
// endpoint of the caller reaches the published package's code.
const BUILD_ENV = ["HOME", "OPENQODEX_HOME", "OPENQODEX_BENCH_CACHE", "GOROOT", "GOPATH", "GOTOOLCHAIN", "CARGO_HOME", "RUSTUP_HOME", "GEM_HOME", "GEM_PATH"];
export function buildEnv(base = process.env) {
  const kept = Object.fromEntries(BUILD_ENV.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]));
  return cleanEnv(base, { ...kept, OPENQODEX_AUTO_UPDATE: "0", NO_COLOR: "1" });
}

// One run.mjs invocation: its output goes to the log file and to stderr. A
// scanner-only run gets buildEnv; a review run the caller's environment,
// because its reviewers need their accounts.
function bench(args, log, env = process.env) {
  return new Promise((done) => {
    const file = createWriteStream(log);
    const child = spawn(process.execPath, [join(benchRoot, "run.mjs"), ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk) => {
      file.write(chunk);
      process.stderr.write(chunk);
      tail = (tail + chunk).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("error", (e) => keep(`could not start run.mjs: ${e.message}\n`));
    child.on("close", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      file.end(() => done({ code, signal, tail }));
    });
  });
}

const lastLines = (text, n = 6) => text.trim().split("\n").filter(Boolean).slice(-n).join(" | ");

// One build's run of one suite, which must finish (exit 0).
async function runOne({ o, ctx, suite, side, mode, build }) {
  const name = `${suite}-${mode}-${side}`;
  const folder = join(ctx.out, name);
  const args = ["--suite", suite, "--package", build.spec, "--out", folder];
  if (suite !== "planted" && o.cases === null) args.push("--subset", o.subset ?? DEFAULT_SUBSET);
  if (o.cases !== null) args.push("--cases", o.cases);
  if (o.allowMissing) args.push("--allow-missing-scanners");
  if (mode === "scan") args.push("--mode", "scan", "--check-identical");
  else {
    args.push("--reviewers", o.reviewers.join(","), "--max-usd", o.maxUsd, "--max-minutes", o.maxMinutes);
    if (o.reviewMaxUsd !== null) args.push("--review-max-usd", o.reviewMaxUsd);
    if (o.repeat !== null) args.push("--repeat", o.repeat);
    if (o.wave !== null) args.push("--wave", o.wave);
  }
  process.stderr.write(`\n== ${name}: ${build.label} ==\n`);
  ctx.runs.push({ suite, mode, side, folder: relative(ctx.out, folder) });
  const r = await bench(args, join(ctx.out, "logs", `${name}.log`), mode === "scan" ? buildEnv() : process.env);
  if (r.code === 0) return folder;
  const why = r.code === 3 ? "its two passes are not identical, so its score is not one number" : r.code === 1 ? "it stopped before it finished" : r.signal ? `it was ended by ${r.signal}` : "it was refused or failed";
  throw new CannotRun(`the ${side} build's ${mode === "scan" ? "scanner-only" : "review"} run of ${suite} exited ${r.code ?? r.signal}: ${why}. Its last lines: ${lastLines(r.tail)}`);
}

// The two builds' scanner-only runs of one suite, compared case by case.
function compareScans(suite, baseFolder, candFolder) {
  const load = (folder, side) => {
    const manifest = readJson(join(folder, "manifest.json"));
    const score = readJson(join(folder, "score.json"));
    const identical = readJson(join(folder, "identical.json"));
    if (!manifest || !score) throw new CannotRun(`the ${side} build's scan of ${suite} saved no manifest or score`);
    if (identical?.identical !== true) throw new CannotRun(`the ${side} build's two passes of ${suite} were not found identical`);
    return { manifest, score, entry: buildEntry({ runId: basename(folder), manifest, resumes: [], score, asset: null, privateListHash: null }) };
  };
  const a = load(baseFolder, "base");
  const b = load(candFolder, "candidate");
  const missing = (m) => (m.scannersMissing ?? []).map((x) => x.scanner).sort();
  const ma = missing(a.manifest);
  const mb = missing(b.manifest);
  const onlyA = ma.filter((s) => !mb.includes(s));
  const onlyB = mb.filter((s) => !ma.includes(s));
  if (onlyA.length > 0 || onlyB.length > 0) {
    const say = (list, side) => (list.length > 0 ? `${list.join(", ")} not ready for the ${side} build only` : null);
    throw new CannotRun(`${suite}: the two builds did not run the same scanners (${[say(onlyA, "base"), say(onlyB, "candidate")].filter(Boolean).join("; ")}), so those scanners' bugs would read as the product's loss or gain. A build that pins a scanner at another version needs that version installed: run the check again with --install-scanners.`);
  }
  if (a.score.rules?.hash !== b.score.rules?.hash) throw new CannotRun(`${suite}: the two runs were scored under different scan rules`);
  if (JSON.stringify(a.score.caseIds) !== JSON.stringify(b.score.caseIds)) throw new CannotRun(`${suite}: the two runs scanned different cases`);
  const c = compareScan(a.entry, b.entry, "scan", { was: "the base", now: "by the candidate", before: "in the base" });
  const at = (l) => `${suite}: ${l}`;
  const notes = [];
  if (ma.length > 0) notes.push(at(`not installed, so run by neither build and not compared: ${ma.join(", ")}`));
  const inputs = inputDifferences(a.manifest.external ?? null, b.manifest.external ?? null);
  for (const d of inputs) notes.push(at(d));
  const packsMoved = JSON.stringify(a.manifest.external?.semgrepPacks ?? null) !== JSON.stringify(b.manifest.external?.semgrepPacks ?? null);
  if (packsMoved && c.worse.length > 0) notes.push(at("the Semgrep rule packs differ between the two runs, so a lost semgrep finding may be the registry's; run the check again before reading it as the product's"));
  return {
    losses: c.worse.map(at),
    gains: c.better.map(at),
    changes: c.other.map(at),
    notes,
    compared: `${suite}${a.manifest.subset ? ` (${a.manifest.subset})` : ""}: ${a.score.caseIds.length} ${a.score.caseIds.length === 1 ? "case" : "cases"}, scanner-only, two identical passes per build`,
  };
}

const pctOf = (x) => `${(x * 100).toFixed(1)}%`;
function fmt(m, x) {
  const sign = x < 0 ? "-" : "+";
  const a = Math.abs(x);
  if (m.unit === "points") return `${sign}${(a * 100).toFixed(1)} points`;
  if (m.name === "costPerReview") return `${sign}$${a.toFixed(3)}`;
  if (m.name === "secondsPerReview") return `${sign}${a.toFixed(1)} s`;
  return `${sign}${a.toFixed(2)}`;
}
const value = (m, x) => (m.unit === "points" ? pctOf(x) : m.name === "costPerReview" ? `$${x.toFixed(3)}` : m.name === "secondsPerReview" ? `${x.toFixed(1)} s` : x.toFixed(2));

// The two builds' review runs of one suite, through loop/compare.mjs.
function compareReviews(suite, baseFolder, candFolder) {
  let result;
  const alpha = FAMILY_ALPHA / (2 * GATE_METRICS.length);
  try {
    const decisions = readRulings();
    const pairs = pairsOf(loadSides({ run: baseFolder, decisions }), loadSides({ run: candFolder, decisions }));
    result = comparePairs(pairs, { alpha, seed: `release-check|${suite}|${basename(baseFolder)}|${basename(candFolder)}` });
  } catch (error) {
    throw new CannotRun(`${suite}: the review runs could not be compared: ${error.message}`);
  }
  if (result.problems.length > 0) throw new CannotRun(`${suite}: the review runs cannot be paired: ${result.problems.join("; ")}`);
  return { ...reviewOutcome(result, { suite, alpha }), table: renderComparison(result, { alpha }), alpha };
}

// What a compare.mjs result says for the release: { losses, gains,
// changes, notes, incomparable }. A gate metric one side measures and the
// other does not (a review with no cost on one side) cannot be compared, and
// is listed in incomparable (failure 7), never read as no change.
export function reviewOutcome(result, { suite, alpha }) {
  const out = { losses: [], gains: [], changes: [], notes: [], incomparable: [] };
  for (const cell of result.cells) {
    const where = `${suite} ${cell.path} ${cell.reviewer}`;
    for (const [stratum, s] of Object.entries(cell.strata)) {
      if (s === null || (stratum === "pooled" && (s === cell.strata.planted || s === cell.strata.real))) continue;
      for (const name of GATE_METRICS) {
        const m = METRICS.find((x) => x.name === name);
        const r = s.metrics[name];
        if (!r) continue;
        const declared = LEVERS.metrics[name].loss;
        const lossAbs = lossIn(name, declared, r.parent);
        const guard = guardVerdict(name, r, lossAbs);
        const change = changeVerdict(r, alpha);
        // A loss is a change in the worse direction. guardVerdict alone reads
        // a zero change against a zero loss (a fraction of a parent value of
        // 0, such as the scripted model's cost) as breaking.
        const moved = (r.like ? [r.like.lower, r.like.upper] : [r]).every((x) => (m.better === "higher" ? x.delta < 0 : x.delta > 0));
        if (r.measured && !r.comparable) {
          out.incomparable.push(`${where}, ${stratum}: ${m.label} is measured over ${r.parentSums.of} in the base and over ${r.candidateSums.of} in the candidate, so the two cannot be compared`);
          continue;
        }
        const line = `${where}, ${stratum}: ${m.label} ${r.measured ? `${value(m, r.parent)} to ${value(m, r.candidate)} (change ${fmt(m, r.delta)}, bounds ${fmt(m, r.lo)} to ${fmt(m, r.hi)}, acceptable loss ${fmt(m, m.better === "higher" ? -lossAbs : lossAbs)})` : "not measured"}`;
        if (guard === "breaks" && moved) out.losses.push(`${line}: past the acceptable loss`);
        else if (change === "better") out.gains.push(`${line}: better`);
        else if (change === "worse" || change === "mixed") out.changes.push(`${line}: ${change}, not shown past the acceptable loss`);
        else if (guard === "unclear" && r.measured) out.notes.push(`${line}: no change shown, but the bound passes the acceptable loss, so a loss of that size is not ruled out; more repeats or cases would tell`);
      }
    }
    for (const h of cell.hard.broken) out.losses.push(`${where}: hard rule broken: ${h}`);
    for (const h of cell.hard.unresolved) out.notes.push(`${where}: hard rule open until a person rules: ${h}`);
  }
  return out;
}

// The verdict and exit code of what was compared. A loss is named whatever
// else holds (exit 1). Otherwise a metric that could not be compared means
// nothing is concluded (exit 2), never "no change".
export function decideVerdict({ losses = [], gains = [], changes = [], incomparable = [] }) {
  if (losses.length > 0) return { verdict: "loss", code: 1 };
  if (incomparable.length > 0) return { verdict: "could not run", code: 2, why: `these metrics could not be compared: ${incomparable.join("; ")}` };
  if (gains.length > 0) return { verdict: "gain", code: 0 };
  if (changes.length > 0) return { verdict: "changed", code: 0 };
  return { verdict: "no change", code: 0 };
}

const VERDICT_TEXT = {
  loss: "the candidate loses what the base had, as each loss below says. Fix each one before the release.",
  gain: "the candidate gains, and loses nothing the comparison can see.",
  changed: "the candidate differs from the base, neither better nor worse by the rules below.",
  "no change": "the candidate scores what the base scores on every case compared.",
  "could not run": "nothing was compared, so this check says nothing about the release.",
};

function render(doc) {
  const list = (title, lines) => (lines.length === 0 ? [] : [`## ${title}`, "", ...lines.map((l) => `- ${l}`), ""]);
  const out = [`# Release check: ${doc.base.label} against ${doc.candidate.label}`, "", `Verdict: ${doc.verdict}; ${VERDICT_TEXT[doc.verdict]}`, ""];
  if (doc.why) out.push(`Why: ${doc.why}`, "");
  out.push(`Base: ${doc.base.label} (${doc.base.spec}). Candidate: ${doc.candidate.label} (${doc.candidate.spec}).`, "");
  if (doc.compared.length > 0) out.push("Compared:", "", ...doc.compared.map((c) => `- ${c}`), "");
  out.push(...list("Losses", doc.losses), ...list("Gains", doc.gains), ...list("Other changes", doc.changes), ...list("Notes", doc.notes));
  for (const t of doc.reviewTables) out.push(`## Reviews: ${t.suite}`, "", `loop/compare.mjs, candidate minus base, one-sided alpha ${t.alpha.toPrecision(3)} per metric and direction; a gate metric is a loss when decide.mjs's guard rule shows it past the acceptable loss in benchmark/loop/levers.json.`, "", t.table.trim(), "");
  if (doc.runs.length > 0) out.push("## Runs", "", "| Suite | Mode | Build | Folder |", "|---|---|---|---|", ...doc.runs.map((r) => `| ${r.suite} | ${r.mode === "scan" ? "scanner-only, two passes" : "review"} | ${r.side} | ${r.folder} |`), "");
  return `${out.join("\n").trim()}\n`;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const doc = { version: 1, startedAt: new Date().toISOString(), base: { spec: o.base ?? "npm:<latest>", label: o.base ?? "the published package" }, candidate: { spec: o.candidate, label: o.candidate }, verdict: null, exitCode: null, why: null, losses: [], gains: [], changes: [], notes: [], incomparable: [], compared: [], reviewTables: [], runs: [] };
  const ctx = { out: null, runs: doc.runs };
  const finish = (code) => {
    doc.exitCode = code;
    doc.endedAt = new Date().toISOString();
    const text = render(doc);
    if (ctx.out) {
      writeFileSync(join(ctx.out, "release-check.md"), text);
      const { reviewTables, ...json } = doc;
      writeFileSync(join(ctx.out, "release-check.json"), `${JSON.stringify({ ...json, reviews: reviewTables.map(({ suite, alpha }) => ({ suite, alpha })) }, null, 2)}\n`);
    }
    if (o.summary) appendFileSync(o.summary, `${text}\n`);
    process.stdout.write(`\n${text}`);
    const shown = (p) => (p.startsWith(`${process.cwd()}/`) ? relative(process.cwd(), p) : p);
    if (ctx.out) process.stdout.write(`\nReport: ${shown(join(ctx.out, "release-check.md"))}\n`);
    process.exit(code);
  };
  // The folder a failed check still reports into, when --out names it.
  const claim = (folder) => {
    if (existsSync(join(folder, "release-check.json"))) throw new CannotRun(`${folder} already holds a release check; name a new folder with --out`);
    mkdirSync(join(folder, "logs"), { recursive: true });
    ctx.out = folder;
  };
  try {
    if (o.out) claim(o.out);
    const baseSpec = o.base ?? `npm:${await latestVersion()}`;
    if (baseSpec === o.candidate) throw new CannotRun(`the base and the candidate are both ${baseSpec}`);
    const base = await describeBuild(baseSpec);
    const candidate = await describeBuild(o.candidate);
    doc.base = { spec: base.spec, label: base.label };
    doc.candidate = { spec: candidate.spec, label: candidate.label };
    if (!ctx.out) claim(join(resultsRoot, `${new Date().toISOString().slice(0, 10)}-release-check-${base.slug}-${candidate.slug}`));
    const reviewSuites = o.reviewers === null ? [] : o.suites.filter((s) => s === "planted" || o.reviewers.every(isModelReviewer));
    process.stderr.write(`Release check: ${base.label} (base) against ${candidate.label} (candidate). Scanner-only on ${o.suites.map((s) => (s === "planted" ? s : `${s} ${o.cases ? "cases named" : (o.subset ?? DEFAULT_SUBSET)}`)).join(" and ")}, two passes per build${reviewSuites.length > 0 ? `; reviews by ${o.reviewers.join(", ")} on ${reviewSuites.join(" and ")}, each run held to --max-usd ${o.maxUsd} and --max-minutes ${o.maxMinutes}` : ""}. Results: ${ctx.out}\n`);
    if (o.reviewers !== null) for (const s of o.suites.filter((x) => !reviewSuites.includes(x))) doc.notes.push(`${s}: scanned, not reviewed; Claude Code and Codex review the planted cases only here`);
    if (o.install) {
      for (const [side, b] of [["base", base], ["candidate", candidate]]) {
        process.stderr.write(`\n== installing the ${side} build's scanners: doctor --install --all-scanners ==\n`);
        const p = spawnSync(process.execPath, [b.cli, "doctor", "--install", "--all-scanners"], { cwd: repoRoot, env: buildEnv(), stdio: ["ignore", 2, 2], timeout: 1_800_000 });
        if (p.status !== 0) throw new CannotRun(`the ${side} build's doctor --install --all-scanners exited ${p.status ?? p.signal}`);
      }
    }
    const merge = (r) => {
      for (const k of ["losses", "gains", "changes", "notes", "incomparable"]) doc[k].push(...(r[k] ?? []));
    };
    for (const suite of o.suites) {
      const folders = {};
      for (const [side, b] of [["base", base], ["candidate", candidate]]) folders[side] = await runOne({ o, ctx, suite, side, mode: "scan", build: b });
      const r = compareScans(suite, folders.base, folders.candidate);
      merge(r);
      doc.compared.push(r.compared);
    }
    for (const suite of reviewSuites) {
      const folders = {};
      for (const [side, b] of [["base", base], ["candidate", candidate]]) folders[side] = await runOne({ o, ctx, suite, side, mode: "review", build: b });
      const r = compareReviews(suite, folders.base, folders.candidate);
      merge(r);
      doc.reviewTables.push({ suite, table: r.table, alpha: r.alpha });
      doc.compared.push(`${suite}: reviewed by ${o.reviewers.join(", ")} on each build, compared by loop/compare.mjs`);
    }
  } catch (error) {
    if (!(error instanceof CannotRun)) error.message = `the release check itself failed: ${error.stack ?? error.message}`;
    doc.verdict = "could not run";
    doc.why = error.message;
    // Nothing compared before the failure stands: the report keeps the why and the runs.
    for (const k of ["losses", "gains", "changes", "notes", "incomparable", "compared", "reviewTables"]) doc[k] = [];
    console.error(`\nThe release check could not run: ${error.message}`);
    finish(2);
  }
  const v = decideVerdict(doc);
  doc.verdict = v.verdict;
  if (v.code === 2) {
    doc.why = v.why;
    console.error(`\nThe release check could not conclude: ${v.why}`);
    for (const k of ["losses", "gains", "changes", "notes", "compared", "reviewTables"]) doc[k] = [];
  } else for (const l of doc.incomparable) doc.notes.push(`not comparable: ${l}`);
  finish(v.code);
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
