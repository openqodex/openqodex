#!/usr/bin/env node
// Runs the review benchmark: every case, every configuration, N times, with
// the real built CLI and the real reviewer. A script, never a model, decides
// what runs; the scores come later, from the saved files (score.mjs).
//
//   node benchmark/build-cli.mjs      build the CLI and record where it came from
//   node benchmark/run.mjs --max-usd <n> --max-minutes <n>
//                          [--max-tokens <n>] [--max-reviews <n>] [--allow-over]
//                          [--repeat 3] [--cases a,b] [--graph off,on]
//                          [--reviewers claude[,codex]|control] [--concurrency 1]
//                          [--timeout 900] [--out <folder>] [--resume]
//                          [--add-repeats <n>] [--change <RC-id>]
//                          [--model <id>] [--web off|on] [--dry-run]
//                          [--draft] [--allow-retired] [--allow-missing-scanners]
//   node benchmark/run.mjs --reviewers model:<deployment>|model:scripted
//                          --max-usd <n> --max-minutes <n> --review-max-usd <n>
//                          [--cases a,b | --cases <suite>/<name>,...]
//                          [--model-effort <level>] [--max-output-tokens <n>]
//                          [--model-script <file>] [--install-root <dir>/tools]
//                          [--concurrency 2] [--timeout <s>] [the flags above]
//   node benchmark/run.mjs --mode scan [--cases a,b] [--repeat 1]
//                          [--check-identical] [--scanner-config <file>]
//                          [--allow-missing-scanners] [--timeout 120]
//                          [--out <folder>] [--dry-run] [--draft]
//   either mode also takes --suite planted|conventions|aacr|clean|martian|greptile [--split dev]
//                          [--release <comparison> --split test --package local]
//                          [--subset <name>|all] [--cases <suite>/<name>,...]
//                          [--package local|npm:<version>|file:<path.tgz>]
//   a review run also takes --smoke, and --wave <id> (required unless every
//                          reviewer is model:scripted or it is a dry run)
//   node benchmark/run.mjs --materialise-only [--suite <suite>] [--split dev|test]
//                          [--subset <name>] [--cases a,b] [--out <folder>]
//                          [--reviewers <the run's reviewers> | --mode scan]
//
// --package names the build under test: local (the default) is the build
// benchmark/build-cli.mjs made of this checkout, recorded by its commit;
// npm:<version> is the published package, fetched once with npm pack into
// the clone cache; file:<path.tgz> is a packed build (a release candidate).
// A package build is recorded by its name, version, sha256 and integrity in
// the manifest's `package`, and its build names no commit (lib/package.mjs).
//
// --smoke is a run that checks the runner works, never a measurement: it
// takes development cases only (the test split and any held-out case are
// refused), at most 5 reviews per configuration (one repeat by default),
// and its manifest says smoke, so it is never indexed or published.
//
// --materialise-only builds every selected case through lib/suites.mjs
// materialise, in the shape the run would review it in (server for model
// reviewers, laptop otherwise), and writes the proof of each to
// <out>/proof.json (lib/materialise-only.mjs): tree ids, licence class and
// whether the merge base is an ancestor of the head. It runs no scanner, no
// reviewer and no CLI, reads no truth and spends nothing. It is the one way
// to build held-out cases (--split test) before a release: each suite's
// held-out cases get a line in benchmark/index/heldout-access.jsonl before
// any is built. Exit 0 when every case is proved, 1 when one is not.
//
// Without --cases, every case the lock does not mark retired runs. --suite
// names the suite the cases come from (planted unless --cases names pull
// request cases); for a real suite (aacr, clean), without --cases, every usable
// case on the development side of its split file runs, or the subset that
// --subset names there (dev-smoke, dev-laptop). The test split is held out
// and refused outside an accepted comparison release (lib/suites.mjs
// selectCases). The manifest records suite, split, splitHash and subset.
// A real suite's development cases run in scan mode and with laptop or
// model reviewers, scored against the same saved truth.
//
// --reviewers model:<id> is the server path (lib/server-review.mjs): each
// review is the library's reviewChange in the server profile, on the case
// materialised as two commits (lib/suites.mjs), with the model reviewer as
// the host's model, every call held by the run's budget ledger, scanners
// read from --install-root (default $OPENQODEX_HOME/tools or
// ~/.openqodex/tools, never installed) and a workDir of its own. <id> is
// `scripted` (the scripted model, lib/scripted-model.mjs, answering from
// --model-script, by default lib/scripted-model.json; no network), a
// deployment boards.json records as probed, or a name its aliases map
// points at one; anything else is refused. The server profile always builds
// the code graph and gives the reviewer no web tool, so --graph is on and
// --web off; reviews run 2 at a time unless --concurrency says otherwise;
// --review-max-usd is required. --cases may name pull request cases
// (<suite>/<name> or a full case id, development split only); their
// resolved truth is copied into the run's cases/ folder. Laptop and model
// reviewers never share a run.
//
// Exit codes: 0 finished; 1 stopped (a limit or login wall, the budget, the
// same failure twice, Ctrl-C); 2 refused (flags, build, lock, budget
// estimate, scanners) or the benchmark itself failed; 3 the two passes of a
// scanner-only run with --check-identical are not identical.
//
// --mode scan is the scanner-only run: per case, `openqodex scan
// --report-dir`, with no reviewer and no model, one case at a time, in the
// run's own OpenQodex home (its tool folders are links to the warm tools
// of $OPENQODEX_HOME or ~/.openqodex, so nothing installs during a pass and
// the developer's approvals are never read or written). The run refuses to
// start when a scanner is not ready, unless --allow-missing-scanners, and
// the manifest then lists each missing one. --scanner-config <file> passes
// --config <file> to every scan, after one `openqodex trust --yes` in the
// run's own home for the one repository path each case is built at in
// turn. At the end of a pass the manifest records `external` (the toolchain
// hash, the scanner versions, the Semgrep rule packs the scans consumed and
// a hash of the osv.dev advisories, lib/external.mjs) and the pass is scored
// (score.json, outcomes.jsonl, lib/scan-score.mjs). --check-identical runs
// a second pass on the same build into <out>-pass2, with fresh case
// repositories, and compares the two scores and every sample's files with
// the time fields left out (lib/identical.mjs); identical.json in both
// folders says how it went. A scanner-only run spends nothing, so it takes
// no budget flags.
//
// One results folder per run, benchmark/results/<date>-<commit>/ unless
// --out names another:
//   manifest.json                     the build and where it came from, the machine, the
//                                     reviewers with their versions and models, the
//                                     settings, every planned job with its id (`jobs`),
//                                     how the first invocation ended
//   resumes.jsonl                     one line when a resume starts and one when it ends
//   cases/<case>.json                 the specs this run used (the scorer reads these)
//   samples/<case>/<config>/<n>/      one attempt at one review: report/ (the CLI's
//                                     --report-dir), receipt.txt (what it printed),
//                                     stderr.txt, sample.json; a second attempt of the
//                                     same review is <n>-attempt2/
//   rows.jsonl                        one line per attempt
//
// Failure list, written before the code:
// 1. A stale or edited build is benchmarked under a commit it was not built
//    from: benchmark/build-cli.mjs records the commit, the tree the build
//    read and a hash of the bundle; the run refuses a bundle with another
//    hash, and "dirty" means that tree differs from the commit's.
// 2. The reviewer quietly falls back to another agent: --reviewer is always
//    passed, and the reviewer each review used is read from its reviewer.json.
// 3. A usage limit, a rate limit or a login wall turns every later review
//    into a failure: the reviewer is probed before the run, and again after
//    any review whose reviewer failed; a probe that fails stops the run at
//    once with its exact text.
// 4. A failed, timed-out or stopped review leaves no row, or a retry writes
//    over it: every attempt has its own folder and is saved as a scored
//    sample before anything halts. A reviewer failure gets one more
//    attempt; the same failure twice stops the run, and what is done is kept.
// 5. Two reviews share a repository or a graph cache: each attempt gets its
//    own freshly built repository, and --report-dir keeps every file of the
//    run out of that repository.
// 6. The developer's own settings shape the review (a repo config, custom
//    instructions, the reviewer or web choice in the user config): the
//    review runs with --report-dir (built-in defaults, no instructions) and
//    with --reviewer and --reviewer-web given.
// 7. Configurations always run in the same order, so drift (load, time of
//    day) lands on one of them: within each repeat the cases run in order
//    and the configurations alternate which goes first.
// 8. A saved file holds the generated secret or this machine's paths: the
//    receipt's paths are replaced by placeholders, and every saved file is
//    checked for the generated value; one found stops the run.
// 9. An earlier run is overwritten or mixed with a new one: a folder that
//    holds a manifest or samples is refused unless --resume, and one run
//    folder has one runner at a time (lib/runner.mjs executeRun); a resume
//    keeps every saved attempt, the specs the run copied and its manifest
//    untouched, runs the reviews that have no saved attempt (one whose first
//    attempt started and never saved runs in its next attempt folder, and
//    the crashed one stays), and is refused when the bundle, the machine, a
//    reviewer's version or model, web access, the timeout, the concurrency,
//    the cases, the configurations, the repeats, the scanners found missing
//    or the change differ. A resume names its own budget (a run stopped by
//    its budget is finished by resuming it with more), and --add-repeats
//    adds repeats to a finished run under lib/runner.mjs's rules.
// 10. Wall time includes building the case: the clock runs from the start
//    of the CLI to its exit only.
// 11. The run spends more than asked: more than three repeats needs
//    --allow-more, more than six is refused, and the plan is printed before
//    anything starts, with its estimate (lib/budget.mjs). Every run names
//    --max-usd and --max-minutes; one whose estimate passes either is
//    refused unless --allow-over. Before each review the launch rule asks
//    whether what is spent, plus the median review so far for each review
//    running and the next, would pass --max-usd, and whether the time gone
//    plus the median review time would pass --max-minutes; --max-tokens and
//    --max-reviews stop launches the same way. Claude Code and Codex report
//    their cost only after a review, so these are forecast stops: a run may
//    pass --max-usd by the reviews already running, and its manifest says
//    so (ended.how "budget", limitKind "forecast", spentUsd). Hard caps that
//    hold every model call before it is sent are lib/budget.mjs's, for the
//    model reviewers and the judge. On top of the run's own caps, a review
//    run that pays a model (any reviewer but model:scripted) names its wave
//    with --wave and reserves its forecast in the wave journal
//    (lib/wave.mjs) before it spends: the estimate when every review is
//    priced, else the run's --max-usd room. --allow-over never passes the
//    wave cap. At its end it settles with what its ledger says it spent
//    (the larger of that and the forecast, marked estimated, when a
//    reviewer reported no cost).
// 12. A review outlives the script after Ctrl-C: running reviews are
//    stopped, saved as stopped attempts, and the run says why it stopped.
// 13. Parallel reviews slow each other, which reads as a slower build: the
//    manifest records the concurrency, and the default is one at a time.
// 14. A model is recorded that the reviewer never used: Claude Code's model
//    is read from each review's usage record and must equal a requested one; Codex's is
//    read from the header Codex prints, or recorded as unknown.
// 15. A requested model is passed in a way the reviewer ignores: --model
//    reaches Claude Code through ANTHROPIC_MODEL, which its driver passes
//    on; Codex runs with --ignore-user-config and takes no model setting, so
//    --model with Codex is refused.
// 16. A case edited after a run is run again under its old name, so the two
//    runs compare across different code: a case whose files do not hash to
//    its entry in benchmark/cases.lock.json, or that has none, is refused
//    unless --draft (the manifest then says draft, and a draft run is never
//    accepted); a retired case is refused unless --allow-retired; a lock
//    that is there but unsound is refused for every run, a draft included;
//    the manifest lists every case's id, planted/<name>@<first 8 hex of its
//    hash>.
// 17. A case edited while the run goes is rebuilt from the live folders for
//    later attempts, while the manifest keeps the first hash and id: at the
//    start the run copies every folder its cases build from (the demo's
//    examples/demo-repo included) into its temp folder, and every hash,
//    lock check, spec copy and attempt comes from that copy.
// 18. A run on a machine that lacks a scanner its cases need (no Ruby for
//    brakeman and rubocop, no Go for golangci-lint) is taken for a run with
//    every scanner: before anything is spent, the CLI's own doctor is asked,
//    in each case's built repository, which scanners the case calls for and
//    whether each is installed; a missing one refuses the run unless
//    --allow-missing-scanners, and then the manifest records
//    scannersComplete false and each missing scanner, and the run is never
//    accepted.
// 19. The reviewer reads the cases' truth on the web (every case and its
//    discussion is public): web access is off unless --web on is given.
// 20. A run's reviews are compared under different loop changes: --change
//    records the reviewer-loop change id the run measures, and a resume
//    with another is refused.
// Scanner-only runs (--mode scan):
// 21. Two scanner-only passes on one build differ and nobody notices:
//    --check-identical runs the second pass and compares (lib/identical.mjs);
//    a difference exits 3 and names each file and field, and whether the
//    inputs changed (other Semgrep rule packs, other osv.dev advisories) or
//    the product did.
// 22. A scanner that is not installed reads as a scanner that found
//    nothing: `openqodex doctor --json` in the run's own home lists every
//    scanner first, and one that is not ready refuses the run unless
//    --allow-missing-scanners, with which the manifest names each one and
//    says scannersComplete false; scans run with --no-install, so no pass
//    installs a tool the other did not have.
// 23. An overlay scanner runs without the trust step, or the run reads or
//    changes the developer's own approvals: --scanner-config runs `openqodex
//    trust --yes` once, in the run's own home, for the one repository path
//    every case is built at in turn (one scan at a time); a trust step that
//    fails refuses the run before any scan, and the manifest records what
//    was approved.
// 24. A scan's numbers move with inputs the build does not fix: the
//    manifest's `external` records the toolchain hash, the scanner versions,
//    the Semgrep rule packs each sample consumed ("mixed" when two differ)
//    and a hash of the osv.dev advisories, read from the saved scans, never
//    downloaded again (lib/external.mjs).
// Model reviewers (the server path):
// 25. A model nobody probed is spent on: model:<id> is resolved against
//    boards.json before anything else (lib/server-review.mjs), and the
//    manifest records the deployment, the alias that named it, and the
//    settings (effort, maxOutputTokens, the scripted model's script).
//    A resume is refused when the endpoint, recorded as an HMAC-SHA256 of
//    its base URL keyed with the endpoint's key, differs from the run's.
// 26. The model recorded is not the one that answered: each sample records
//    the model asked for apart from the ones the provider named as
//    answering, and the manifest's model is the id that served the run's
//    first answered review (requestedModel is the one asked for); a review
//    served by another id stops the run.
// 27. A review writes outside its workDir, or the key or base URL of the
//    model endpoint lands in a saved file: either stops the run. An answer
//    that holds the key or the address is checked before anything of its
//    sample is written or printed, and only the refusal is saved.
// 28. The scanner preflight reads another tools folder than the reviews:
//    --install-root names the tools folder of an OpenQodex home, and the
//    doctor runs with that home.
// 29. A held-out (test split) case is run, or a case outside the subset a
//    run names is run under that subset's name: --split test is refused,
//    and every case comes from lib/suites.mjs selectCases, which refuses a
//    held-out, excluded or out-of-subset case before anything is fetched.
// 30. A real suite's run is scored as planted, or against all of its
//    comments: the manifest names the suite, split, split hash and subset,
//    and each case's truth copy holds the accepted comments its suite
//    entry counts, no more and no fewer (lib/suites.mjs specCopy).
// Outside runs (P4-04):
// 31. A run on a package build is credited to the checkout's commit: the
//    manifest's `package` names the package, version, sha256 and integrity,
//    and its build names no commit; a local run's `package` names the commit.
// 32. A model run spends on after its setup broke: after each review the
//    halt rules (lib/halts.mjs) are asked: the endpoint refusing the key,
//    the quota or the billing, a reviewer's served model changing, two
//    reviews in a row incomplete for one reason, and from the tenth review
//    more than 20% incomplete, a mean cost past 1.5 times the estimate or a
//    forecast past --max-usd, both from finished reviews' own spend. A
//    halt stops launches, lets the running reviews finish and save, records
//    { rule, why } in the end record, and --resume continues. A rate
//    limited review is tried once more after a wait of at most a minute. A
//    saved file holding this machine's home folder stops the run too.
// 33. A smoke run reads a held-out case, grows into a measurement, or is
//    indexed: --smoke refuses the test split and any held-out case, refuses
//    more than 5 reviews per configuration and --add-repeats, stops when
//    the reviewer was invoked 5 times for a configuration, retries
//    included, and its manifest says smoke, which publish-run.mjs refuses
//    and a resume keeps.
// 34. A held-out case is built before a release with no record, or truth is
//    read for it: only --materialise-only selects the test split, logs each
//    suite's held-out cases first, reads no truth and runs no review.
// 35. A board's run names no board revision: the manifest's `board` names
//    the board, its repository and the commit boards.json pins.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, homedir, totalmem, tmpdir, platform, arch, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { benchRoot, casesRoot, buildCase, caseHash, caseIdFromHash, generatedValue, git, listCases, loadRunLock, lockPath, lockRefusals, readCase, repoRoot, snapshotCases } from "./lib/cases.mjs";
import { estimateRun, loadPrices, manifestBudget, readLedger, runBudget, startRefusals } from "./lib/budget.mjs";
import { externalOf, toolchainOf } from "./lib/external.mjs";
import { haltRules, rateLimitRetry, smokeCap } from "./lib/halts.mjs";
import { comparePasses } from "./lib/identical.mjs";
import { heldOutAccessPath } from "./lib/index.mjs";
import { controlCaseData, controlEnv, controlSample, probeControl } from "./lib/claude-control.mjs";
import { materialiseOnly } from "./lib/materialise-only.mjs";
import { parsePackageSpec, preparePackage } from "./lib/package.mjs";
import { laptopMetered, probeReviewer, BLOCKED } from "./lib/reviewers.mjs";
import { attemptDir, bundleHash, CLAUDE_MODEL_FROM, claudeRunModels, executeRun, failureOf, jobState, laptopInvocation, planJobs, preflightRefusals, provenanceProblems, resumeProblems, runManifest, saveSampleRow, sampleRecord, savedSampleRows, scannerPreflight, scanSampleRecord } from "./lib/runner.mjs";
import { SCAN_CONFIG, SCAN_RULES_VERSION } from "./lib/scan-score.mjs";
import { createModelReviewer, isModelReviewer, makeWorkRoot, recordServed, resolveModelReviewer, SCRIPTED, serverAttempt } from "./lib/server-review.mjs";
import { DEFAULT_SCRIPT } from "./lib/scripted-model.mjs";
import { SUITES, materialise, selectCases, specCopy, truthOf } from "./lib/suites.mjs";
import { openWave, reserve, settle, waveState } from "./lib/wave.mjs";
import { renderScan, saveScore } from "./score.mjs";

// Authored suites use the same base/change folders. Only the published corpus has a frozen lock.
const AUTHORED_SUITES = {
  planted: { root: casesRoot, lock: lockPath, conventions: false },
  conventions: { root: join(benchRoot, "suites/conventions"), lock: null, conventions: true },
};

const USAGE = "usage: node benchmark/run.mjs --max-usd <n> --max-minutes <n> [--max-tokens <n>] [--max-reviews <n>] [--allow-over] [--repeat 3] [--cases a,b] [--graph off,on] [--reviewers claude[,codex]] [--concurrency 1] [--timeout 900] [--out <folder>] [--resume] [--add-repeats <n>] [--change <RC-id>] [--model <id>] [--web off|on] [--dry-run] [--draft] [--allow-retired] [--allow-missing-scanners]\n       node benchmark/run.mjs --reviewers model:<deployment>|model:scripted --max-usd <n> --max-minutes <n> --review-max-usd <n> [--cases a,b | <suite>/<name>,...] [--model-effort <level>] [--max-output-tokens <n>] [--model-script <file>] [--install-root <dir>/tools] [--concurrency 2] [--timeout <s>] [--repeat 3] [--out <folder>] [--resume] [--dry-run] [--allow-missing-scanners]\n       node benchmark/run.mjs --mode scan [--cases a,b] [--repeat 1] [--check-identical] [--scanner-config <file>] [--allow-missing-scanners] [--timeout 120] [--out <folder>] [--dry-run] [--draft] [--allow-retired]\n       either mode: [--suite planted|conventions|aacr|clean] [--split dev] [--subset <name>|all] [--cases <suite>/<name>,...] [--package local|npm:<version>|file:<path.tgz>]; a review run: [--smoke]\n       node benchmark/run.mjs --materialise-only [--suite <suite>] [--split dev|test] [--subset <name>] [--cases a,b] [--reviewers <names> | --mode scan] [--out <folder>]\n       a review run that pays a model (any reviewer but model:scripted) names its wave: --wave <id> (node benchmark/lib/wave.mjs --wave-new <id>)";

// Flags only a review run reads, flags only a scanner-only run reads, and
// flags only a model reviewer reads.
const REVIEW_ONLY = ["--reviewers", "--graph", "--web", "--model", "--resume", "--max-usd", "--max-minutes", "--max-tokens", "--max-reviews", "--review-max-usd", "--add-repeats", "--change", "--allow-over", "--model-effort", "--max-output-tokens", "--model-script", "--install-root", "--smoke", "--wave"];
const SCAN_ONLY = ["--scanner-config", "--check-identical"];
const MODEL_ONLY = ["--model-effort", "--max-output-tokens", "--model-script", "--install-root"];
// The flags --materialise-only reads: which cases, in which shape, and where the proof goes.
const MATERIALISE_FLAGS = ["--materialise-only", "--mode", "--suite", "--split", "--subset", "--cases", "--reviewers", "--out", "--draft", "--allow-retired", "--cli"];
// The most reviews a smoke run makes per configuration (P4-10's smoke: 5 pull requests per configuration).
const SMOKE_MAX_REVIEWS = 5;

// A --cases entry that names a pull request case: <suite>/<name> or a full
// case id, never a planted case's bare name.
const isRealRef = (c) => c.includes("/");

const positive = (flag, value, whole = false) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) throw new Error(`${flag} takes ${whole ? "a whole number" : "a number"} above 0`);
  return n;
};

function parseArgs(argv) {
  const o = { mode: "review", suite: null, split: null, subset: null, repeat: null, repeatGiven: false, cases: null, graph: null, reviewers: ["claude"], concurrency: null, timeout: null, out: null, resume: false, addRepeats: null, change: null, model: null, web: "off", dryRun: false, allowMore: false, draft: false, allowRetired: false, allowMissingScanners: false, allowOver: false, maxUsd: null, maxMinutes: null, maxTokens: null, maxReviews: null, reviewMaxUsd: null, scannerConfig: null, checkIdentical: false, modelEffort: undefined, maxOutputTokens: 32000, modelScript: DEFAULT_SCRIPT, installRoot: null, package: "local", smoke: false, materialiseOnly: false, cli: join(repoRoot, "packages/cli/dist/bin.js") };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    given.add(a);
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--mode") o.mode = next();
    else if (a === "--release") o.release = next();
    else if (a === "--wave") o.wave = next();
    else if (a === "--suite") o.suite = next();
    else if (a === "--split") o.split = next();
    else if (a === "--subset") o.subset = next();
    else if (a === "--scanner-config") o.scannerConfig = resolve(next());
    else if (a === "--check-identical") o.checkIdentical = true;
    else if (a === "--repeat") {
      o.repeat = Number(next());
      o.repeatGiven = true;
    } else if (a === "--max-usd") o.maxUsd = positive(a, next());
    else if (a === "--max-minutes") o.maxMinutes = positive(a, next());
    else if (a === "--max-tokens") o.maxTokens = positive(a, next(), true);
    else if (a === "--max-reviews") o.maxReviews = positive(a, next(), true);
    else if (a === "--review-max-usd") o.reviewMaxUsd = positive(a, next());
    else if (a === "--add-repeats") o.addRepeats = positive(a, next(), true);
    else if (a === "--change") o.change = next();
    else if (a === "--allow-over") o.allowOver = true;
    else if (a === "--allow-missing-scanners") o.allowMissingScanners = true;
    else if (a === "--cases") o.cases = next().split(",").filter(Boolean);
    else if (a === "--graph") o.graph = next().split(",").filter(Boolean);
    else if (a === "--reviewers") o.reviewers = next().split(",").filter(Boolean);
    else if (a === "--concurrency") o.concurrency = Number(next());
    else if (a === "--timeout") o.timeout = Number(next());
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--model") o.model = next();
    else if (a === "--model-effort") o.modelEffort = next();
    else if (a === "--max-output-tokens") o.maxOutputTokens = positive(a, next(), true);
    else if (a === "--model-script") o.modelScript = resolve(next());
    else if (a === "--install-root") o.installRoot = resolve(next());
    else if (a === "--web") o.web = next();
    else if (a === "--cli") o.cli = resolve(next());
    else if (a === "--resume") o.resume = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--allow-more") o.allowMore = true;
    else if (a === "--draft") o.draft = true;
    else if (a === "--allow-retired") o.allowRetired = true;
    else if (a === "--package") o.package = next();
    else if (a === "--smoke") o.smoke = true;
    else if (a === "--materialise-only") o.materialiseOnly = true;
    else throw new Error(`unknown flag ${a}`);
  }
  parsePackageSpec(o.package);
  if (o.mode !== "review" && o.mode !== "scan") throw new Error("--mode takes review or scan");
  const scan = o.mode === "scan";
  // Model reviewers are the server path; Claude Code and Codex the laptop path.
  const models = o.reviewers.filter(isModelReviewer);
  const server = !scan && models.length > 0;
  o.control = !scan && o.reviewers.includes("control");
  if (o.control && o.reviewers.length !== 1) throw new Error("the control reviewer runs on its own: use --reviewers control");
  o.path = server ? "server" : "laptop";
  const real = (o.cases ?? []).filter(isRealRef);
  o.realRefs = real.length > 0 ? real : null;
  // The suite: --suite, else the one the pull request cases --cases names, else planted.
  const named = [...new Set(real.map((r) => r.slice(0, r.indexOf("/"))))];
  if (named.length > 1) throw new Error(`--cases names cases of ${named.join(" and ")}; one run reviews one suite`);
  if (o.suite !== null && named.length === 1 && named[0] !== o.suite) throw new Error(`--cases names cases of ${named[0]}, and --suite names ${o.suite}`);
  o.suite ??= named[0] ?? "planted";
  if (!AUTHORED_SUITES[o.suite] && !SUITES[o.suite]) throw new Error(`--suite takes planted, conventions or ${Object.keys(SUITES).join(", ")}, not ${o.suite}`);
  o.real = !AUTHORED_SUITES[o.suite];
  // Authored cases live directly under the suite root. Resolve the suite
  // first, then remove its qualifier before validating or snapshotting names.
  if (!o.real) {
    o.cases = o.cases?.map((c) => c.startsWith(`${o.suite}/`) ? c.slice(o.suite.length + 1) : c) ?? null;
    o.realRefs = null;
  }
  if (!o.real && o.split !== null && o.split !== "dev") throw new Error(`--split ${o.split}: the planted suite has one split, dev`);
  if (!o.real && o.subset !== null) throw new Error(`--subset ${o.subset}: the planted suite has no subsets`);
  if (o.materialiseOnly) return materialiseArgs(o, given, real);
  if (o.smoke && o.split === "test") throw new Error("--smoke runs development cases only: the test split is held out, and no held-out case runs before a release");
  if (o.split === "test" && !o.release) throw new Error(`the ${o.suite} test split is held out: no held-out case runs before a release; use --release with an accepted comparison`);
  if (o.smoke && o.addRepeats !== null) throw new Error("--add-repeats grows a run into a measurement, and a smoke run is never one: it stays at most 5 reviews per configuration");
  o.split ??= "dev";
  // --subset all is the whole split, which a run with no subset names.
  if (o.subset === "all") o.subset = null;
  // A scan is deterministic (--check-identical proves it), so one repeat; a
  // scan has no reviewer to wait on; a smoke run checks the runner once.
  o.repeat ??= scan || o.smoke ? 1 : 3;
  o.timeout ??= scan ? 120 : o.real ? 1800 : 900;
  // The server profile always builds the code graph.
  o.graph ??= o.control ? ["off"] : server ? ["on"] : ["off", "on"];
  if (o.control && (o.graph.some((g) => g !== "off") || o.web !== "off")) throw new Error("the control reviewer uses no OpenQodex graph or web tools: use --graph off --web off");
  if (o.release && (o.smoke || o.draft || o.package !== "local" || o.split !== "test" || !o.real)) throw new Error("--release requires a comparison's local build and a real suite's test split, without --smoke or --draft");
  // Model reviews wait on the endpoint, not this machine, so two run at once.
  o.concurrency ??= server ? 2 : 1;
  const wrong = (scan ? REVIEW_ONLY : SCAN_ONLY).filter((f) => given.has(f));
  if (wrong.length > 0) {
    throw new Error(scan ? `${wrong.join(", ")}: a scanner-only run (--mode scan) runs no reviewer and spends nothing, and is run again rather than resumed` : `${wrong.join(", ")}: only a scanner-only run (--mode scan) reads ${wrong.length === 1 ? "it" : "them"}`);
  }
  if (scan && o.concurrency !== 1) throw new Error("--mode scan runs one scan at a time: every case is built at the one repository path the overlay's approval names, and scan times compare only at concurrency 1");
  if (!scan) modelChecks(o, given, models);
  if (o.real) {
    if (o.cases !== null && real.length !== o.cases.length) throw new Error(`--cases names planted cases in a run of the ${o.suite} suite; name pull request cases as ${o.suite}/<name> or a full case id`);
    for (const f of ["--draft", "--allow-retired"]) if (given.has(f)) throw new Error(`${f} is for planted cases, whose lock it reads; a pull request case is frozen by its suite entry`);
  }
  if (o.scannerConfig !== null && !existsSync(o.scannerConfig)) throw new Error(`--scanner-config: there is no file ${o.scannerConfig}`);
  if (!scan && (o.maxUsd === null || o.maxMinutes === null)) throw new Error("--max-usd and --max-minutes are required: every run names what it may spend and how long it may take");
  if (!Number.isInteger(o.repeat) || o.repeat < 1 || o.repeat > 6) throw new Error("--repeat takes a whole number from 1 to 6");
  if (o.repeat > 3 && !o.allowMore) throw new Error("--repeat over 3 spends more than the benchmark needs; add --allow-more to mean it");
  if (o.addRepeats !== null) {
    if (o.out === null) throw new Error("--add-repeats needs --out <folder>: the finished run to add repeats to");
    if (o.repeatGiven || o.resume) throw new Error("--add-repeats takes the run's own repeats and adds to them, and resumes it; leave out --repeat and --resume");
  }
  if (o.change !== null && !/^RC-\d{4}$/.test(o.change)) throw new Error("--change takes a reviewer-loop change id, RC-<4 digits>");
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error("--concurrency takes a whole number from 1");
  if (!Number.isInteger(o.timeout) || o.timeout < 60) throw new Error("--timeout takes whole seconds, at least 60");
  if (o.graph.some((g) => g !== "off" && g !== "on")) throw new Error("--graph takes off, on or off,on");
  if (o.reviewers.some((r) => r !== "claude" && r !== "codex" && r !== "control" && !isModelReviewer(r))) throw new Error("--reviewers takes claude, codex, control, or model reviewers (model:<deployment>, model:scripted)");
  if (o.web !== "on" && o.web !== "off") throw new Error("--web takes on or off");
  if (o.model !== null && o.reviewers.includes("codex")) {
    throw new Error("--model cannot be used with Codex: the Codex reviewer runs with --ignore-user-config and takes no model setting; run without --model, and the run records the model Codex names in its own output");
  }
  const all = listCases(AUTHORED_SUITES[o.suite]?.root);
  for (const c of o.real ? [] : (o.cases ?? [])) if (!all.includes(c)) throw new Error(`no case ${c}; cases: ${all.join(", ")}`);
  // The wave this run spends from (lib/wave.mjs): every reviewer but the
  // scripted model pays a model; a scan and a dry run spend nothing.
  o.paid = !scan && o.reviewers.some((r) => r !== SCRIPTED);
  if (o.paid && !o.dryRun && !o.wave) throw new Error("--wave <id> is required: a review run that pays a model reserves its forecast in the wave's journal before it spends (node benchmark/lib/wave.mjs --wave-new <id> starts one)");
  if (o.wave) o.waveJournal = openWave(o.wave);
  return o;
}

// The rules for --materialise-only (failure 34): it reads which cases and
// the shape their review would need, and nothing that runs or spends.
function materialiseArgs(o, given, real) {
  const extra = [...given].filter((f) => f.startsWith("--") && !MATERIALISE_FLAGS.includes(f));
  if (extra.length > 0) throw new Error(`${extra.join(", ")}: --materialise-only builds and proves the cases and runs no scanner, reviewer or model, so it reads only ${MATERIALISE_FLAGS.slice(1).join(", ")}`);
  o.split ??= "dev";
  if (o.split !== "dev" && o.split !== "test") throw new Error(`--split takes dev or test, not ${o.split}`);
  if (o.reviewers.some(isModelReviewer) && o.reviewers.some((r) => !isModelReviewer(r))) throw new Error("--reviewers mixes laptop reviewers (claude, codex) and model reviewers: the two paths run apart, one run each");
  // A model review reads the case as two commits; a laptop review and a scan read the change uncommitted.
  o.shape = o.mode === "review" && o.reviewers.some(isModelReviewer) ? "server" : "laptop";
  if (o.real && o.cases !== null && real.length !== o.cases.length) throw new Error(`--cases names planted cases in a run of the ${o.suite} suite; name pull request cases as ${o.suite}/<name> or a full case id`);
  const all = listCases(AUTHORED_SUITES[o.suite]?.root);
  for (const c of o.real ? [] : (o.cases ?? [])) if (!all.includes(c)) throw new Error(`no case ${c}; cases: ${all.join(", ")}`);
  return o;
}

// The rules for model reviewers, and against their flags elsewhere. Each
// model:<id> is resolved against boards.json here, before anything else runs
// (failure 25).
function modelChecks(o, given, models) {
  if (models.length === 0) {
    const wrong = MODEL_ONLY.filter((f) => given.has(f));
    if (wrong.length > 0) throw new Error(`${wrong.join(", ")}: only model reviewers (--reviewers model:<id>) read ${wrong.length === 1 ? "it" : "them"}`);
    return;
  }
  if (models.length !== o.reviewers.length) throw new Error("--reviewers mixes laptop reviewers (claude, codex) and model reviewers: the two paths run apart, one run each");
  if (new Set(o.reviewers).size !== o.reviewers.length) throw new Error("--reviewers names one model reviewer twice");
  o.modelReviewers = Object.fromEntries(models.map((name) => [name, resolveModelReviewer(name)]));
  if (o.graph.includes("off")) throw new Error("--graph off: the server profile always builds the code graph, so a model reviewer runs graph on only");
  if (o.web !== "off") throw new Error("--web on: the server profile gives the reviewer no web tool");
  if (o.model !== null) throw new Error("--model is Claude Code's; a model reviewer names its deployment in --reviewers model:<deployment>");
  if (o.reviewMaxUsd === null) throw new Error("--review-max-usd is required for model reviewers: every call is held to it before it is sent");
  if (o.modelEffort !== undefined && !/^[a-z]+$/.test(o.modelEffort)) throw new Error("--model-effort takes a reasoning effort level, such as low, medium or high");
  if (given.has("--model-script") && !models.includes(SCRIPTED)) throw new Error("--model-script is the scripted model's script; it needs --reviewers model:scripted");
  if (o.installRoot !== null && basename(o.installRoot) !== "tools") throw new Error("--install-root names the tools folder of an OpenQodex home (<home>/tools): the scanner preflight reads that home's doctor, so it must be the folder the reviews read");
}

// The pull request cases of a real suite this run uses (failure 29): the
// cases --cases names (<suite>/<name> or a full case id), or every usable
// case on the split's development side or in --subset, through
// lib/suites.mjs selectCases; then the truth each is scored against, read
// now from the pinned files, saved as the run's spec copy with the accepted
// comments only (failure 30, lib/suites.mjs specCopy). Exits 2 on a
// refusal, leaving no temp folder.
function realCases(o, { build, packageRecord, out } = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "oq-bench-run-"));
  const refuse = (lines) => {
    rmSync(tempRoot, { recursive: true, force: true });
    console.error("The run cannot start:");
    for (const r of lines) console.error(`- ${r}`);
    process.exit(2);
  };
  let picked = [];
  try {
    picked = selectCases({ suite: o.suite, split: o.split, subset: o.subset, refs: o.realRefs, release: o.release ?? null, build, packageRecord, runId: out ? basename(out) : null, by: gitUserName() });
  } catch (error) {
    refuse(error.message.split("\n"));
  }
  const byName = {};
  const problems = [];
  for (const c of picked) {
    try {
      const file = join(tempRoot, "specs", `${c.name}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(specCopy(c, truthOf(c)), null, 2)}\n`);
      byName[c.name] = { case: c, specFile: file };
    } catch (error) {
      problems.push(`${c.id}: ${error.message.split("\n")[0]}`);
    }
  }
  if (problems.length > 0) refuse(problems);
  return { tempRoot, byName, suite: o.suite, split: o.split, splitHash: picked[0]?.splitHash ?? null, subset: o.subset };
}

// The cases this run may use, copied once into a temp folder (failures 16
// and 17): the lock is checked against that copy, and every hash, spec and
// attempt comes from it. Exits 2 on a refusal, leaving no temp folder.
function lockedCases(o) {
  const authored = AUTHORED_SUITES[o.suite];
  let lock;
  try {
    lock = authored.lock === null ? null : loadRunLock(authored.lock, { draft: o.draft });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const cases = o.cases ?? listCases(authored.root).filter((c) => lock?.cases[c]?.retired !== true);
  const tempRoot = mkdtempSync(join(tmpdir(), "oq-bench-run-"));
  const refuse = (lines) => {
    rmSync(tempRoot, { recursive: true, force: true });
    console.error("The run cannot start:");
    for (const r of lines) console.error(`- ${r}`);
    process.exit(2);
  };
  let snap;
  let hashes;
  try {
    snap = snapshotCases(cases, join(tempRoot, "cases-snapshot"), { root: authored.root });
    hashes = Object.fromEntries(cases.map((c) => [c, caseHash(c, snap)]));
  } catch (error) {
    refuse([error.message]);
  }
  const refusals = lock === null ? [] : lockRefusals(cases, lock, { draft: o.draft, allowRetired: o.allowRetired }, snap);
  if (refusals.length > 0) refuse(refusals);
  return { cases, snap, hashes, tempRoot };
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// The build as benchmark/build-cli.mjs recorded it, checked against the
// bundle that is there now (failure 1).
function buildInfo(cli) {
  const provenance = readJson(join(benchRoot, ".build", "provenance.json"));
  const now = existsSync(cli) ? bundleHash(dirname(dirname(cli))) : null;
  const problems = now === null ? [`no built CLI at ${cli}; run node benchmark/build-cli.mjs`] : provenanceProblems(provenance, now);
  if (problems.length > 0) return { problems, build: null };
  let cliVersion = null;
  try {
    cliVersion = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    cliVersion = null;
  }
  return {
    problems: [],
    build: { commit: provenance.commit, short: provenance.commit.slice(0, 7), tree: provenance.tree, commitTree: provenance.commitTree, dirty: provenance.dirty, bundleHash: provenance.bundleHash, builtAt: provenance.builtAt, builtWithNode: provenance.node, cli: relative(repoRoot, cli), cliVersion },
  };
}

// A package build as a run's build record (failure 31): no commit, its
// version as the short name, and the hash of the bundle it holds.
function packageBuild(pkg) {
  let cliVersion = null;
  try {
    cliVersion = execFileSync(process.execPath, [pkg.cli, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    cliVersion = null;
  }
  return {
    problems: [],
    build: { package: pkg.record.spec, commit: null, short: `v${pkg.record.version}`, tree: null, commitTree: null, dirty: null, bundleHash: bundleHash(pkg.dir), builtAt: null, builtWithNode: null, cli: `${pkg.record.name}@${pkg.record.version}/dist/bin.js`, cliVersion },
  };
}

// Development cases are validated first. A comparison release needs its
// build validated before selecting held-out cases or reading their truth.
async function prepareRunBuild(o, date) {
  let pkg = null;
  try { pkg = await preparePackage(o.package); }
  catch (error) { throw new Error(`--package ${o.package}: ${error.message}`); }
  if (pkg) o.cli = pkg.cli;
  const controlBuild = o.control && !o.release ? { problems: [], build: { commit: git(repoRoot, "rev-parse", "HEAD").trim(), short: git(repoRoot, "rev-parse", "--short=7", "HEAD").trim(), bundleHash: null, cliVersion: null, dirty: git(repoRoot, "status", "--porcelain").trim() !== "" } } : null;
  const { problems, build } = controlBuild ?? (pkg ? packageBuild(pkg) : buildInfo(o.cli));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const packageRecord = pkg ? (({ files, ...rest }) => ({ ...rest, fileCount: Object.keys(files).length }))(pkg.record) : { spec: "local", commit: build.commit, dirty: build.dirty };
  const out = o.out ?? join(benchRoot, "results", o.mode === "scan" ? `${date}-${build.short}-${o.suite}-scan-laptop` : o.control ? `${date}-${build.short}-control` : o.path === "server" ? `${date}-${build.short}-${o.suite}-review-server` : `${date}-${build.short}`);
  return { pkg, build, packageRecord, out };
}

// The board a real suite's cases come from, at the commit boards.json pins (failure 35).
function boardOf(name) {
  const b = JSON.parse(readFileSync(join(benchRoot, "outside", "boards.json"), "utf8")).boards?.[name];
  return b ? { name, repo: b.repo, commit: b.commit } : { name, repo: null, commit: null };
}

function machine() {
  // No host name: the results are published, and the hardware is what compares.
  return { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), node: process.version };
}

// The run folder's rows.jsonl, one record per saved attempt.
const readRows = (out) => (existsSync(join(out, "rows.jsonl")) ? readFileSync(join(out, "rows.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// The served models each configuration's saved attempts named.
function servedByConfig(out) {
  const by = {};
  for (const r of readRows(out)) for (const m of r.servedModels ?? []) (by[r.config] ??= new Set()).add(m);
  return Object.fromEntries(Object.entries(by).map(([config, models]) => [config, [...models].sort()]));
}

function sanitize(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) if (from) out = out.split(from).join(to);
  return out;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const children = new Set();

function runCli(cli, args, env, cwd, timeoutMs, graceMs = 120_000, invocation = null) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(invocation?.command ?? process.execPath, invocation?.args ?? [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdin.on("error", () => {});
    child.stdin.end(invocation?.input ?? "");
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    // A review has its own reviewer deadline, so this one, graceMs past it,
    // catches a hang of the CLI itself; a scan has none, so its grace is 0.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // gone already
      }
    }, timeoutMs + graceMs);
    child.on("error", (e) => (stderr += `\ncould not start the CLI: ${e.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      done({ code, signal, stdout, stderr, wallMs: Date.now() - started });
    });
  });
}

function killAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
}

// --- scanner-only runs (--mode scan) ---

// A path as the manifest may hold it: the home folder written as ~.
const hideHome = (p) => (homedir() && p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

// A file the run was given, as the manifest names it: its path in this
// repository, or its name when it lies outside.
function shownPath(file) {
  const r = relative(repoRoot, file);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : basename(file);
}

// The run's own OpenQodex home, in the run's temp folder: each tool folder
// of the warm install root ($OPENQODEX_HOME/tools or ~/.openqodex/tools) is
// linked in, so the scans read the developer's installed scanners, while
// trust.json, the custom scanners an overlay installs and every cache are
// the run's own (failure 20). "cold" when there was nothing to link.
function runHome(tempRoot) {
  const warm = join(process.env.OPENQODEX_HOME ? resolve(process.env.OPENQODEX_HOME) : join(homedir(), ".openqodex"), "tools");
  const dir = join(tempRoot, "home");
  mkdirSync(join(dir, "tools"), { recursive: true });
  let linked = 0;
  if (existsSync(warm)) {
    for (const e of readdirSync(warm, { withFileTypes: true })) {
      if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name === "custom") continue;
      symlinkSync(join(warm, e.name), join(dir, "tools", e.name));
      linked++;
    }
  }
  return { dir, toolsHome: linked > 0 ? "warm" : "cold", installRoot: hideHome(warm) };
}

// The environment every CLI command of a scanner-only run gets: the run's
// own home, no update check, no colour, and none of the caller's git
// variables.
function cliEnv(home) {
  const env = { ...process.env, OPENQODEX_AUTO_UPDATE: "0", NO_COLOR: "1", OPENQODEX_HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k === "FORCE_COLOR") delete env[k];
  return env;
}

// `openqodex doctor --json` of the bundle the run uses, in the run's own
// home: it installs nothing and asks nothing of the network (failure 19).
function doctorRecord(cli, env, cwd) {
  const p = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", cwd], { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    return JSON.parse(p.stdout);
  } catch {
    throw new Error(`openqodex doctor --json gave no record (exit ${p.status ?? p.signal}): ${String(p.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
  }
}

// The overlay's trust step (failure 20): the file is copied into the run,
// an empty repository is made at the path every case is built at in turn,
// and `openqodex trust --yes --config <copy>` approves the overlay's custom
// scanners for that path, in the run's own home. The empty repository is
// then moved aside. Returns the copy to pass to every scan and what the
// manifest records, or why the step failed.
function trustOverlay({ cli, env, file, tempRoot, repoPath, home, hide }) {
  const copy = join(tempRoot, "overlay", basename(file));
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(file, copy);
  const sha256 = createHash("sha256").update(readFileSync(copy)).digest("hex");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init", "-q");
  const key = realpathSync(repoPath);
  const p = spawnSync(process.execPath, [cli, "trust", "--yes", "--no-color", "--config", copy, "--cwd", repoPath], { cwd: repoPath, env, encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const aside = join(tempRoot, "repos", "trust");
  mkdirSync(dirname(aside), { recursive: true });
  renameSync(repoPath, aside);
  if (p.status !== 0) {
    const why = hide(String(p.stderr ?? p.error ?? "")).trim().split("\n").slice(-4).join(" | ");
    return { error: `openqodex trust --yes --config ${shownPath(file)} failed (exit ${p.status ?? p.signal}), so no scanner of the overlay may run: ${why}` };
  }
  const records = readJson(join(home, "trust.json"))?.records ?? [];
  const trusted = records
    .filter((r) => r.repoRoot === key)
    .map((r) => ({ name: r.name, entryHash: r.entryHash, version: r.artifact?.version ?? null, sha256: r.artifact?.sha256 ?? null, checksumSource: r.artifact?.checksumSource ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { file: copy, record: { path: shownPath(file), sha256, trusted } };
}

// The first attempt of each planned job of a pass, as lib/external.mjs reads
// it: its case id, when it started and its saved scan.json.
function firstAttempts(folder, jobs) {
  return jobs.map((job) => {
    const dir = attemptDir(folder, job, 1);
    return { caseId: job.caseId, startedAt: readJson(join(dir, "sample.json"))?.started_at ?? null, scan: readJson(join(dir, "report", "scan.json")) };
  });
}

// A scanner-only run: the preflight, the overlay's trust step, one pass (or
// two with --check-identical), each scored, and the comparison.
async function scanMain(o, { cases, snap, hashes, tempRoot, build, leave, real, packageRecord, board, startedAt, out }) {
  const runId = basename(out);
  const folders = o.checkIdentical ? [out, `${out}-pass2`] : [out];
  const shown = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) || "." : p);
  const idOf = Object.fromEntries(cases.map((c) => [c, real ? real.byName[c].case.id : caseIdFromHash(c, hashes[c], o.suite)]));
  const { jobs } = planJobs({ cases, caseIds: idOf, repeat: o.repeat, mode: "scan" });
  for (const folder of folders) {
    if (existsSync(join(folder, "samples")) || existsSync(join(folder, "manifest.json"))) {
      console.error(`${folder} already holds a run (a manifest or samples); use --out for a new folder`);
      leave(2);
    }
  }
  console.log(`Scanner-only benchmark: ${cases.length} cases x ${o.repeat} repeats = ${jobs.length} scans, one at a time${o.checkIdentical ? ", in two passes that must be identical" : ""}.`);
  console.log(`Build ${build.short}${build.dirty ? ", built from a tree the commit does not hold (dirty)" : ""}, openqodex ${build.cliVersion}. Results: ${folders.map(shown).join(" and ")}`);
  console.log(`Cases: ${cases.map((c) => idOf[c]).join(", ")}`);
  if (o.draft) console.log("A draft run: its cases need not match the lock, and it is never accepted.");
  if (o.dryRun) {
    for (const j of jobs) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    leave(0);
  }

  const realTemp = realpathSync(tempRoot);
  const replacements = (more) => [...more, [join(realTemp, "scan-repo"), "<repo>"], [realTemp, "<temp>"], [tempRoot, "<temp>"], [process.env.HOME, "~"]];
  const hide = (text) => sanitize(text, replacements([]));
  const home = runHome(tempRoot);
  const env = cliEnv(home.dir);
  let preflight;
  try {
    preflight = toolchainOf(doctorRecord(o.cli, env, tempRoot));
  } catch (error) {
    console.error(`The run cannot start: ${error.message}`);
    leave(2);
  }
  if (preflight.missing.length > 0) {
    const list = preflight.missing.map((m) => `${m.scanner} (${m.detail ?? m.state})`).join(", ");
    if (!o.allowMissingScanners) {
      console.error(`The run cannot start: ${preflight.missing.length} scanners are not ready in ${home.installRoot}: ${list}. Install them with node ${relative(repoRoot, o.cli)} doctor --install --all-scanners (brakeman and rubocop need Ruby, golangci Go, cargo-deny Cargo), or pass --allow-missing-scanners to run without them: the manifest then names each one, and the run is never accepted.`);
      leave(2);
    }
    console.log(`Not ready, so not run (--allow-missing-scanners): ${list}`);
  }
  console.log(`Case repositories and the run's own OpenQodex home (tools linked from ${home.installRoot}): ${tempRoot}`);
  const repoPath = join(tempRoot, "scan-repo");
  let overlay = null;
  if (o.scannerConfig !== null) {
    overlay = trustOverlay({ cli: o.cli, env, file: o.scannerConfig, tempRoot, repoPath, home: home.dir, hide });
    if (overlay.error) {
      console.error(`The run cannot start: ${overlay.error}`);
      leave(2);
    }
    console.log(`Overlay ${overlay.record.path} (${overlay.record.sha256.slice(0, 12)}): approved in the run's own home: ${overlay.record.trusted.map((t) => `${t.name} ${t.version ?? ""}`.trim()).join(", ") || "no custom scanner"}`);
  }

  const settings = {
    runId,
    mode: "scan",
    ...(o.release ? { release: o.release, buildLabel: `local build ${build.commit}` } : {}),
    path: "laptop",
    suite: o.suite,
    split: o.split,
    splitHash: real?.splitHash ?? null,
    subset: o.subset,
    board,
    package: packageRecord,
    build,
    machine: machine(),
    reviewer: null,
    reviewers: {},
    scan: { timeoutSeconds: o.timeout, flags: `scan --cwd <repo> --report-dir <sample>/report --no-color --no-install${overlay ? " --config <overlay>" : ""}` },
    toolsHome: home.toolsHome,
    installRoot: home.installRoot,
    scannerOverlay: overlay?.record ?? null,
    scannersComplete: preflight.missing.length === 0,
    scannersMissing: preflight.missing,
    checkIdentical: o.checkIdentical,
    cases,
    caseIds: cases.map((c) => idOf[c]),
    caseHashes: hashes,
    draft: o.draft,
    configs: [SCAN_CONFIG],
    repeat: o.repeat,
    concurrency: 1,
  };
  const secrets = new Set();
  for (const c of real ? [] : cases) for (const g of readCase(c, snap).generated ?? []) secrets.add(generatedValue(c, g.file, g.kind));

  let stop = null;
  const halt = (why) => {
    if (stop !== null) return;
    stop = why;
    console.error(`Stopping the run: ${why}`);
    killAll();
  };
  process.on("SIGINT", () => halt("stopped by Ctrl-C"));
  process.on("SIGTERM", () => halt("stopped by SIGTERM"));

  // One pass into `folder`: every scan, then the external inputs into the manifest.
  const pass = async (folder, n) => {
    console.log(n === 1 ? `Pass 1 into ${shown(folder)}` : `Pass 2, on the same build with fresh case repositories, into ${shown(folder)}`);
    const manifest = { ...runManifest({ startedAt, settings: n === 1 ? settings : { ...settings, identicalPass: { pass: 2, of: runId } }, jobs }), rulesVersion: SCAN_RULES_VERSION };
    let failedBefore = null;
    const attempt = async (job, k) => {
      const dir = attemptDir(folder, job, k);
      mkdirSync(dir, { recursive: true });
      const reportDir = join(dir, "report");
      // Every case is built at the one path the overlay's approval names, and
      // moved aside after its scan; a pull request case in the laptop shape,
      // from the clone cache (lib/suites.mjs materialise).
      const { dir: repo } = real ? materialise(real.byName[job.case].case, repoPath, { shape: "laptop", heldOut: real.byName[job.case].case.split === "test" }) : buildCase(job.case, repoPath, snap);
      const args = ["scan", "--cwd", repo, "--report-dir", reportDir, "--no-color", "--no-install", ...(overlay ? ["--config", overlay.file] : [])];
      const startedAt = new Date().toISOString();
      let result;
      try {
        result = await runCli(o.cli, args, env, repo, o.timeout * 1000, 0);
      } finally {
        // A pull request case's checkout can be large and is built again from
        // the clone cache in seconds, so it is removed rather than kept.
        if (real) rmSync(repoPath, { recursive: true, force: true });
        else {
          const aside = join(tempRoot, "repos", `pass${n}`, `${job.case}-${job.repeat}-${k}`);
          mkdirSync(dirname(aside), { recursive: true });
          renameSync(repoPath, aside);
        }
      }
      const more = [[reportDir, "<sample>/report"], [folder, "<results>"]];
      writeFileSync(join(dir, "receipt.txt"), sanitize(result.stdout, replacements(more)));
      const stderr = sanitize(result.stderr, replacements(more));
      writeFileSync(join(dir, "stderr.txt"), stderr);
      const scan = readJson(join(reportDir, "scan.json"));
      const report = readJson(join(reportDir, "report.json"));
      const failure = scan ? null : { cause: stop !== null ? `stopped by the run: ${stop}` : `no scan.json (exit ${result.code ?? result.signal}): ${stderr.trim().split("\n").slice(-4).join(" | ")}` };
      const rec = scanSampleRecord({ job, attempt: k, result, scan, report, startedAt, failure, stopped: stop });
      saveSampleRow(folder, dir, rec);
      console.log(`  ${job.case} #${job.repeat}: ${rec.status}, ${rec.candidates ?? "no"} candidates, ${(rec.wallMs / 1000).toFixed(1)} s${failure ? ` (${failure.cause.slice(0, 200)})` : ""}`);
      for (const file of filesUnder(dir)) {
        const text = readFileSync(file, "utf8");
        for (const s of secrets) if (text.includes(s)) halt(`the generated secret is in ${relative(folder, file)}; nothing more runs until that is fixed`);
      }
      return failure;
    };
    const runJob = async (job, k) => {
      try {
        const failure = await attempt(job, k);
        // The same step failing twice stops the run.
        if (failure && failedBefore && stop === null) halt(`two scans in a row wrote no scan.json; the last: ${failure.cause}`);
        failedBefore = failure;
      } catch (error) {
        halt(`${job.case} #${job.repeat}: the benchmark itself failed: ${error.message}`);
      }
    };
    const { ended } = await executeRun({
      out: folder,
      manifest,
      copies: cases.map((c) => [real ? real.byName[c].specFile : join(snap, c, "case.json"), join("cases", `${c}.json`)]),
      jobs,
      concurrency: 1,
      runJob,
      stopReason: () => stop,
      // The inputs every first attempt consumed, read from its saved scan (failure 21).
      finish: () => ({ external: externalOf({ samples: firstAttempts(folder, jobs), preflight }) }),
    });
    console.log(`Pass ${n}: ${ended.reviewsWithAnAttempt} of ${jobs.length} scans saved in ${ended.elapsedMin} minutes`);
    return ended;
  };

  const ends = [];
  for (const [i, folder] of folders.entries()) {
    try {
      ends.push(await pass(folder, i + 1));
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    if (stop !== null) {
      console.log(`Stopped: ${stop}`);
      process.exit(1);
    }
    try {
      const { score, run } = saveScore(folder);
      if (i === 0) console.log(`\n${renderScan(score, run.manifest)}\n`);
    } catch (error) {
      console.error(`The scan of ${shown(folder)} could not be scored: ${error.message}`);
      process.exit(2);
    }
  }
  console.log(`Score: ${folders.map((f) => shown(join(f, "score.json"))).join(" and ")}`);
  // As on the review path: a real suite's case copies are removed once the
  // scan ends; a planted case's laptop repositories are kept to look at.
  if (real) rmSync(tempRoot, { recursive: true, force: true });
  if (!o.checkIdentical) process.exit(0);
  const cmp = comparePasses(folders[0], folders[1]);
  const record = { version: 1, runId, identical: cmp.identical, cause: cmp.cause, inputs: cmp.inputs, differences: cmp.differences, passes: folders.map((f, i) => ({ folder: basename(f), elapsedMin: ends[i].elapsedMin })) };
  for (const f of folders) writeFileSync(join(f, "identical.json"), `${JSON.stringify(record, null, 2)}\n`);
  const times = `pass 1 took ${ends[0].elapsedMin} minutes, pass 2 ${ends[1].elapsedMin}`;
  if (cmp.identical) {
    console.log(`The two passes are identical: the same scores and the same samples, time fields left out (${times}).${cmp.inputs.length > 0 ? ` Their inputs differed without changing anything: ${cmp.inputs.join("; ")}` : ""}`);
    process.exit(0);
  }
  console.error(`The two passes are not identical (${cmp.cause === "input" ? "their inputs differ, so this pass cannot tell whether the product is deterministic; run it again" : "with the same inputs: the product's output is not deterministic"}; ${times}):`);
  for (const line of cmp.inputs) console.error(`- ${line}`);
  for (const line of cmp.differences.slice(0, 20)) console.error(`- ${line}`);
  if (cmp.differences.length > 20) console.error(`- and ${cmp.differences.length - 20} more, in identical.json`);
  process.exit(3);
}

// The name a held-out access line gives for who built the cases: this
// repository's git user, or null.
function gitUserName() {
  const r = spawnSync("git", ["config", "user.name"], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
}

// --materialise-only (failure 34): every selected case built in the shape
// its review would need and proved, with no scanner, reviewer, CLI or model,
// and no truth read; held-out cases only here, logged before any is built.
function materialiseMain(o) {
  let tempRoot = null;
  let workRoot = null;
  const clean = () => {
    for (const dir of [tempRoot, workRoot]) if (dir) rmSync(dir, { recursive: true, force: true });
  };
  const refuse = (lines) => {
    clean();
    console.error("The cases cannot be materialised:");
    for (const l of lines) console.error(`- ${l}`);
    process.exit(2);
  };
  let cases = [];
  let casesDir;
  if (o.real) {
    try {
      cases = selectCases({ suite: o.suite, split: o.split, subset: o.subset, refs: o.realRefs, heldOut: true });
    } catch (error) {
      refuse(error.message.split("\n"));
    }
  } else {
    const locked = lockedCases(o);
    tempRoot = locked.tempRoot;
    casesDir = locked.snap;
    cases = locked.cases.map((name) => ({ id: caseIdFromHash(name, locked.hashes[name], o.suite), suite: o.suite, name, split: "dev", materialise: { kind: "folders" }, source: { kind: "authored" } }));
  }
  const out = o.out ?? join(benchRoot, "results", `${new Date().toISOString().slice(0, 10)}-${o.suite}-${o.split}-materialise-only`);
  if (["proof.json", "manifest.json", "samples"].some((f) => existsSync(join(out, f)))) refuse([`${out} already holds a run or a proof; use --out for a new folder`]);
  console.log(`Materialise only: ${cases.length} ${o.suite} cases from the ${o.split} split${o.subset ? `, subset ${o.subset}` : ""}, in the ${o.shape} shape. No scanner, reviewer or model runs.`);
  workRoot = mkdtempSync(join(tmpdir(), "oq-bench-materialise-"));
  let doc;
  try {
    doc = materialiseOnly({ cases, shape: o.shape, workRoot, accessLog: heldOutAccessPath(), by: gitUserName(), casesDir, log: (p) => console.log(`  ${p.caseId}: ${p.ok ? "proved" : `not proved: ${p.error}`}`) });
  } catch (error) {
    refuse([error.message]);
  }
  clean();
  const { version, purpose, ...rest } = doc;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "proof.json"), `${JSON.stringify({ version, purpose, suite: o.suite, split: o.split, subset: o.subset, ...rest }, null, 2)}\n`);
  console.log(`${doc.proved} of ${doc.cases.length} cases proved${doc.heldOut > 0 ? `; ${doc.heldOut} held-out cases logged in ${relative(repoRoot, heldOutAccessPath())} first` : ""}. Proof: ${join(out, "proof.json")}`);
  process.exit(doc.failed === 0 ? 0 : 1);
}

async function main() {
  const startedAt = new Date().toISOString();
  const date = startedAt.slice(0, 10);
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (o.materialiseOnly) return materialiseMain(o);
  // A dated --out names the day the run starts, as an index entry checks.
  // An undated folder, such as a loop candidate, is never published.
  const outDate = o.out === null ? null : /^(\d{4}-\d{2}-\d{2})-/.exec(basename(o.out))?.[1] ?? null;
  if (outDate !== null && outDate !== date && !o.resume && o.addRepeats === null) {
    console.error(`--out must start with ${date}, the UTC date this run starts, not ${outDate}`);
    process.exit(2);
  }
  let prepared = null;
  if (o.release) {
    try { prepared = await prepareRunBuild(o, date); }
    catch (error) { console.error(error.message); process.exit(2); }
  }
  // Planted cases come from a copy checked against the lock; pull request
  // cases from their suite, with their truth read now.
  const real = o.real ? realCases(o, prepared ?? {}) : null;
  const { cases, snap, hashes, tempRoot } = real
    ? { cases: Object.keys(real.byName), snap: null, hashes: Object.fromEntries(Object.entries(real.byName).map(([n, x]) => [n, x.case.hash])), tempRoot: real.tempRoot }
    : lockedCases(o);
  o.cases = cases;
  const suite = o.suite;
  const server = o.path === "server";
  // Every exit before the reviews start leaves no copy behind.
  // A wave reservation this run holds, settled on every exit but a kill.
  let settleWave = null;
  const leave = (code) => {
    settleWave?.();
    rmSync(tempRoot, { recursive: true, force: true });
    process.exit(code);
  };
  // A smoke run checks the runner on a few reviews, never more (failure 33).
  if (o.smoke && o.cases.length * o.repeat > SMOKE_MAX_REVIEWS) {
    console.error(`--smoke runs at most ${SMOKE_MAX_REVIEWS} reviews per configuration, and this plan has ${o.cases.length} cases x ${o.repeat} repeats; name at most ${SMOKE_MAX_REVIEWS} cases with --cases (or --subset), once each`);
    leave(2);
  }
  try { prepared ??= await prepareRunBuild(o, date); }
  catch (error) { console.error(error.message); leave(2); }
  const { pkg, build, packageRecord, out } = prepared;
  if (pkg) console.log(`Package ${pkg.record.name} ${pkg.record.version} (${pkg.record.spec}, sha256 ${pkg.record.sha256.slice(0, 12)})`);
  const board = real ? boardOf(SUITES[suite].board) : null;
  if (o.mode === "scan") return scanMain(o, { cases, snap, hashes, tempRoot, build, leave, real, packageRecord, board, startedAt, out });
  // The repository a review of the case reads, in the shape its path needs:
  // laptop, the change uncommitted; server, the base and the change as two
  // commits (lib/suites.mjs).
  const buildRepo = (name, into, shape) => {
    if (real) return materialise(real.byName[name].case, into, { shape, heldOut: real.byName[name].case.split === "test" });
    return materialise({ name, materialise: { kind: "folders" } }, into, { shape, casesDir: snap });
  };
  // The spec each case is scored against: a planted case's own, or a pull
  // request case with its resolved truth.
  const specFile = (name) => (real ? real.byName[name].specFile : join(snap, name, "case.json"));
  // --add-repeats: the run's own repeats plus the added ones, as a resume of
  // that run whose plan grows (lib/runner.mjs executeRun, failure 15 there).
  if (o.addRepeats !== null) {
    const earlier = readJson(join(out, "manifest.json"));
    if (!earlier) {
      console.error(`${out} holds no run to add repeats to`);
      leave(2);
    }
    o.repeat = earlier.repeat + o.addRepeats;
    o.resume = true;
    if (o.repeat > 6 || (o.repeat > 3 && !o.allowMore)) {
      console.error(`adding ${o.addRepeats} to the run's ${earlier.repeat} repeats gives ${o.repeat}; ${o.repeat > 6 ? "6 is the most" : "over 3 needs --allow-more"}`);
      leave(2);
    }
  }
  // The jobs in run order, each with its id (lib/runner.mjs planJobs; failure 7).
  const idOf = Object.fromEntries(o.cases.map((c) => [c, real ? real.byName[c].case.id : caseIdFromHash(c, hashes[c], o.suite)]));
  let configs;
  let jobs;
  try {
    ({ configs, jobs } = planJobs({ cases: o.cases, caseIds: idOf, reviewers: o.reviewers, graph: o.graph, repeat: o.repeat }));
  } catch (error) {
    console.error(error.message);
    leave(2);
  }
  const shown = (p) => (p.startsWith(process.cwd()) ? relative(process.cwd(), p) || "." : p);
  // Refused here before any probe is spent; executeRun refuses again under the folder's lock.
  if ((existsSync(join(out, "samples")) || existsSync(join(out, "manifest.json"))) && !o.resume) {
    console.error(`${out} already holds a run (a manifest or samples); pass --resume to finish it, or --out for a new folder`);
    leave(2);
  }
  // A review is done once any of its attempts is saved; one whose first attempt never saved runs again in its next attempt folder.
  const todo = jobs.filter((j) => !jobState(out, j).done);
  console.log(`Benchmark: ${o.cases.length} cases x ${configs.length} configurations (${configs.map((c) => c.id).join(", ")}) x ${o.repeat} repeats = ${jobs.length} reviews; ${todo.length} to run, ${o.concurrency} at a time.`);
  console.log(o.control ? `Claude Code native control. Results: ${shown(out)}` : `Build ${build.short}${build.dirty ? ", built from a tree the commit does not hold (dirty)" : ""}, openqodex ${build.cliVersion}. Results: ${shown(out)}`);
  const caseIds = o.cases.map((c) => idOf[c]);
  console.log(`Cases: ${caseIds.join(", ")}`);
  if (o.draft) console.log("A draft run: its cases need not match the lock, and it is never accepted.");
  if (o.web === "on") console.log("Web access is on: the reviewer may read each case and its discussion online.");

  // The environment every review, probe and doctor run gets.
  const env = { ...process.env, OPENQODEX_AUTO_UPDATE: "0", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k === "FORCE_COLOR") delete env[k];
  if (o.model) env.ANTHROPIC_MODEL = o.model;

  // The model reviewers, before anything is spent: each one's adapter and
  // what the manifest records about it (failure 25). The endpoint's settings
  // are read here and never printed.
  const models = {};
  if (server) {
    for (const name of o.reviewers) {
      try {
        models[name] = createModelReviewer(o.modelReviewers[name], { effort: o.modelEffort, maxOutputTokens: o.maxOutputTokens, scriptPath: o.modelScript });
      } catch (error) {
        console.error(`The ${name} reviewer cannot run: ${error.message}`);
        leave(2);
      }
      const r = models[name].record;
      console.log(`Reviewer ${name}: model ${r.requestedModel}${r.alias ? ` (the alias ${r.alias} in boards.json)` : ""}${r.script ? `, script ${r.script.file} (${r.script.sha256.slice(0, 12)})` : ""}, effort ${r.settings.effort ?? "the deployment's default"}, at most ${r.settings.maxOutputTokens} output tokens per call`);
    }
  }
  // The scanners a model review reads, never installed, and the doctor's
  // view of the same folder (failure 28).
  const installRoot = server ? (o.installRoot ?? join(process.env.OPENQODEX_HOME ? resolve(process.env.OPENQODEX_HOME) : join(homedir(), ".openqodex"), "tools")) : null;
  const doctorEnv = server ? { ...env, OPENQODEX_HOME: dirname(installRoot) } : env;

  // The budget, before anything is spent (failure 11): the estimate of what
  // is left to run, on top of what the run's ledger says is spent already.
  const caps = { maxUsd: o.maxUsd, reviewMaxUsd: o.reviewMaxUsd };
  const forecast = { maxMinutes: o.maxMinutes, maxTokens: o.maxTokens, maxReviews: o.maxReviews };
  const estimate = estimateRun({ jobs: todo, suite, path: o.path, concurrency: o.concurrency });
  const spentBefore = readLedger(out).spentUsd;
  const usd = (n) => `$${n.toFixed(2)}`;
  console.log(`Estimate: ${usd(estimate.usd)} for ${estimate.reviews - estimate.unpriced} reviews${estimate.unpriced > 0 ? ` (${estimate.unpriced} more ${server ? "with no measured cost yet" : "report tokens, not dollars"})` : ""}, about ${Math.ceil(estimate.minutes)} minutes; from ${[...new Set(Object.values(estimate.perConfig).map((p) => p.from))].join(" and ")}.`);
  if (server) console.log(`Budget: --max-usd ${usd(o.maxUsd)}${spentBefore > 0 ? ` (${usd(spentBefore)} spent already)` : ""}, --review-max-usd ${usd(o.reviewMaxUsd)}, --max-minutes ${o.maxMinutes}${o.maxReviews ? `, --max-reviews ${o.maxReviews}` : ""}. These are hard caps: each model review holds --review-max-usd against --max-usd before it starts, and each call reserves its worst case before it is sent.`);
  else console.log(`Budget: --max-usd ${usd(o.maxUsd)}${spentBefore > 0 ? ` (${usd(spentBefore)} spent already)` : ""}, --max-minutes ${o.maxMinutes}${o.maxTokens ? `, --max-tokens ${o.maxTokens}` : ""}${o.maxReviews ? `, --max-reviews ${o.maxReviews}` : ""}. Claude Code and Codex report their cost after each review, so these are forecast stops: no review starts once the next would pass a limit.`);
  const refusals = startRefusals({ estimate, caps, forecast, spentUsd: spentBefore, allowOver: o.allowOver, path: o.path });

  // The scanners each case needs, from the CLI's own doctor in each case's
  // repository (failure 18).
  let preflight;
  try {
    const repos = o.control ? [] : o.cases.map((c) => ({ case: c, dir: buildRepo(c, join(tempRoot, "preflight", c, "repo"), server ? "server" : "laptop").dir }));
    preflight = o.control ? { complete: true, missing: [] } : scannerPreflight({ cli: o.cli, repos, env: doctorEnv });
  } catch (error) {
    console.error(`The scanner preflight failed: ${error.message}`);
    leave(2);
  }
  // Only a planted case's laptop copy is kept: a pull request case's
  // checkout can be large, and the clone cache rebuilds it in seconds.
  if (server || real) rmSync(join(tempRoot, "preflight"), { recursive: true, force: true });
  if (o.control) console.log("Native control: no scanner preflight.");
  else if (preflight.complete) console.log(`Scanners: every scanner the cases call for is installed${server ? ` in ${hideHome(installRoot)}` : ""}.`);
  else {
    console.log(`Scanners missing: ${preflight.missing.map((m) => `${m.scanner} for ${m.case} (${m.state})`).join(", ")}.`);
    if (o.allowMissingScanners) console.log("--allow-missing-scanners: the run records scannersComplete false and is never accepted.");
  }
  refusals.push(...preflightRefusals(preflight, { allowMissing: o.allowMissingScanners }));
  if (refusals.length > 0) {
    console.error("The run cannot start:");
    for (const r of refusals) console.error(`- ${r}`);
    leave(2);
  }
  // The wave cap, after the run's own caps and --allow-over, and above them
  // (lib/wave.mjs): the estimate when every review is priced, else the room
  // --max-usd leaves this run. A run whose reviewers bill nothing per call
  // (Claude Code on the subscription, Codex on a ChatGPT login) reserves 0
  // and settles its reported dollars as not metered; a model reviewer
  // always bills, and a run with any billed reviewer counts as billed.
  const waveMetered = o.shape === "server" || o.reviewers.filter((r) => r !== SCRIPTED).some((r) => laptopMetered(r, env));
  const waveForecast = !waveMetered ? 0 : estimate.unpriced > 0 ? Math.max(estimate.usd, o.maxUsd - spentBefore) : estimate.usd;
  const waveId = basename(out);
  if (o.waveJournal) {
    const s = waveState(o.waveJournal);
    console.log(`Wave ${o.wave}: ${usd(s.settledUsd)} settled (metered), ${usd(s.unmeteredUsd)} reported but not metered, and ${usd(s.reservedUsd)} reserved of its ${usd(s.cap)} cap; this run reserves ${usd(waveForecast)}${!waveMetered ? " (its reviewers bill nothing per call, so its dollars are recorded as not metered)" : estimate.unpriced > 0 ? " (its --max-usd room, since some reviews have no measured cost)" : ""}.`);
  }
  if (o.dryRun) {
    for (const j of todo) console.log(`  ${j.case} ${j.config} #${j.repeat}`);
    leave(0);
  }
  let waveUnpriced = 0;
  if (o.waveJournal) {
    try {
      reserve(o.waveJournal, { id: waveId, path: process.env.OPENQODEX_WAVE_PATH === "loop" ? "loop" : "run", forecastUsd: waveForecast, metered: waveMetered });
    } catch (error) {
      console.error(`The run cannot start: ${error.message}`);
      leave(2);
    }
    // What the run's ledger says this invocation spent; when a reviewer
    // reported no cost, the larger of that and the forecast, estimated.
    settleWave = () => {
      settleWave = null;
      const spent = Math.max(0, readLedger(out).spentUsd - spentBefore);
      if (waveUnpriced > 0) settle(o.waveJournal, waveId, Math.max(spent, waveForecast), { estimated: true, metered: waveMetered });
      else settle(o.waveJournal, waveId, spent, { metered: waveMetered });
    };
  }

  // The reviewers, before anything is spent (failure 3), with the model each
  // one really answers with (failure 14). A model reviewer's served model is
  // recorded in each sample (failure 26).
  const reviewers = Object.fromEntries(Object.entries(models).map(([name, m]) => [name, m.record]));
  for (const name of server ? [] : o.reviewers) {
    const p = await (name === "control" ? probeControl({ env }) : probeReviewer(name, { env }));
    if (!p.ok) {
      console.error(`The ${name} reviewer cannot run: ${p.text}`);
      leave(2);
    }
    // The probe is no review's model, but a probe served by another model stops the run before anything is spent.
    if (o.model && name === "claude" && p.model !== o.model) {
      console.error(`Asked for the model ${o.model}, but Claude Code answered with ${JSON.stringify(p.model)}; nothing runs.`);
      leave(2);
    }
    const claude = name === "claude" || name === "control";
    reviewers[name] = { name, version: p.version, model: claude ? null : p.model, ...(claude ? { requestedModel: o.model } : {}), modelFrom: claude ? CLAUDE_MODEL_FROM : "the model line of the header Codex prints" };
    console.log(`Reviewer ${name} ${p.version}, model ${JSON.stringify(p.model)}`);
  }

  const settings = {
    runId: basename(out),
    mode: "review",
    ...(o.release ? { release: o.release, buildLabel: `local build ${build.commit}` } : {}),
    suite,
    split: o.split,
    splitHash: real?.splitHash ?? null,
    subset: o.subset,
    path: o.path,
    // A smoke run checks the runner and is never indexed (failure 33).
    smoke: o.smoke,
    board,
    package: packageRecord,
    build,
    machine: machine(),
    reviewer: o.reviewers.length === 1 ? reviewers[o.reviewers[0]] : null,
    reviewers,
    review: server
      ? { web: "off", timeoutSeconds: o.timeout, profile: "server", installRoot: hideHome(installRoot), flags: "reviewChange in the server profile: a workDir per review, the budget from the run's ledger, scanners preinstalled, tools { web: false, shell: false }" }
      : o.control ? { web: "off", timeoutSeconds: o.timeout, native: true, command: laptopInvocation({ job: { reviewer: "control" }, maxUsd: o.maxUsd }) }
      : { web: o.web, timeoutSeconds: o.timeout, reportDir: true, flags: "review --report-dir <sample>/report --reviewer <name> --reviewer-web <on|off> --timeout <s> [--no-graph]" },
    cases: o.cases,
    // The frozen ids (planted/<name>@<hash8>) that scores and the index key by.
    caseIds,
    // What each case was built from, so a comparison can tell an edited case from a product change.
    caseHashes: hashes,
    // A draft run used cases that need not match the lock; it is never accepted.
    draft: o.draft,
    configs: configs.map((c) => c.id),
    repeat: o.repeat,
    concurrency: o.concurrency,
    // The reviewer-loop change this run measures, if any.
    changeId: o.change,
    // Hard caps apart from forecast stops; on the laptop path --max-usd can
    // only be held as a forecast, and the end record says which stopped it.
    budget: manifestBudget({ caps, forecast, estimate, allowOver: o.allowOver }),
    // Whether every scanner the cases call for was installed (failure 18).
    scannersComplete: preflight.complete,
    scannersMissing: preflight.missing.map((m) => ({ case: m.case, scanner: m.scanner })),
  };
  // A resume is refused when any setting, or the spec copy of any case,
  // differs from the run's; adding repeats changes only the repeats.
  const checkResume = (earlier) => {
    const differ = resumeProblems(earlier, o.addRepeats !== null ? { ...settings, repeat: earlier.repeat } : settings);
    for (const c of o.cases) {
      const copy = join(out, "cases", `${c}.json`);
      if (existsSync(copy) && readFileSync(copy, "utf8") !== readFileSync(specFile(c), "utf8")) differ.push(`case ${c}: its spec differs from the copy the run saved`);
    }
    return differ;
  };

  if (!server && !real) console.log(`Case repositories: ${tempRoot}`);
  const secrets = new Set();
  if (!real) for (const c of o.cases) for (const g of readCase(c, snap).generated ?? []) secrets.add(generatedValue(c, g.file, g.kind));

  // Each stop names its rule, which the end record keeps (failure 32).
  let stop = null;
  let haltRecord = null;
  const halt = (why, rule) => {
    if (stop !== null) return;
    stop = why;
    haltRecord = { rule, why };
    console.error(`Stopping the run (${rule}): ${why}`);
    killAll();
  };
  process.on("SIGINT", () => halt("stopped by Ctrl-C", "signal"));
  process.on("SIGTERM", () => halt("stopped by SIGTERM", "signal"));

  // The run's ledger, in its folder: each review's reported cost, tokens and
  // time, which the launch rule reads before the next review (failure 11).
  // A model review's calls are priced from prices.json, and the scripted
  // model's from its script.
  const prices = server ? Object.assign(loadPrices(), ...Object.values(models).map((m) => m.prices)) : null;
  const budget = runBudget({ dir: out, caps, forecast, estimate, path: o.path, prices });
  // The halt rules of a model run, counting this invocation's reviews, with
  // the served models the run's earlier samples named (failure 32).
  const priced = estimate.reviews - estimate.unpriced;
  // A smoke run's cap on reviewer invocations, retries and earlier attempts included (failure 33).
  const cap = o.smoke ? smokeCap(SMOKE_MAX_REVIEWS, { rows: readRows(out) }) : null;
  const rules = server ? haltRules({ maxUsd: o.maxUsd, toRun: todo.length, estimatePerReview: priced > 0 ? estimate.usd / priced : null, servedBefore: servedByConfig(out), spentBefore }) : null;

  // Each saved file is checked for a generated secret and, for a model
  // endpoint, its key or base URL (failure 27), and on the server path,
  // where every saved text has its paths replaced, this machine's home
  // folder (failure 32).
  const home = homedir();
  const checkSaved = (dir) => {
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      for (const s of secrets) if (text.includes(s)) halt(`the generated secret is in ${relative(out, file)}; nothing more runs until that is fixed`, "saved-file");
      for (const [name, m] of Object.entries(models)) if (m.appearsIn?.(text)) halt(`the ${name} endpoint's key or base URL is in ${relative(out, file)}; nothing more runs until that is fixed`, "saved-file");
      if (server && home.length > 1 && text.includes(home)) halt(`this machine's home folder is in ${relative(out, file)}; nothing more runs until that is fixed`, "saved-file");
    }
  };

  // One model review (the server path), saved as its own scored sample
  // whatever happened (failure 4), in a workDir of its own under the run's
  // short work root; the attempt's clone is removed once the sample is saved.
  const lib = server ? await import(pathToFileURL(join(dirname(o.cli), "lib.js")).href) : null;
  const workRoot = server ? makeWorkRoot() : null;
  const serverJob = async (job, k, meter) => {
    const caseDir = join(tempRoot, `${job.case}-${job.config}-${job.repeat}-${k}`);
    const repo = buildRepo(job.case, join(caseDir, "repo"), "server");
    const replacements = [[tempRoot, "<temp>"], [realpathSync(tempRoot), "<temp>"], [out, "<results>"], [process.env.HOME, "~"]];
    let saved;
    try {
      saved = await serverAttempt({ reviewChange: lib.reviewChange, job, attempt: k, out, repo, config: AUTHORED_SUITES[suite]?.conventions ? lib.loadConfig(repo.dir).config : undefined, reviewer: models[job.reviewer].reviewer, meter, deadlineMs: o.timeout * 1000, workRoot, installRoot, hide: (t) => sanitize(t, replacements), stopped: () => stop, appearsIn: models[job.reviewer].appearsIn });
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
    const rec = saved.record;
    saveSampleRow(out, null, rec);
    const cost = rec.usage?.cost_usd;
    console.log(`  ${job.case} ${job.config} #${job.repeat}${k > 1 ? ` attempt ${k}` : ""}: ${rec.status}, ${rec.findings ?? "no"} findings, ${(rec.wallMs / 1000).toFixed(0)} s${typeof cost === "number" ? `, $${cost.toFixed(4)}` : ""}, served by ${rec.servedModel ?? (rec.servedModels.length > 0 ? rec.servedModels.join(" and ") : "a model the provider did not name")}${rec.failure ? ` (${rec.failure.slice(0, 160)})` : ""}`);
    checkSaved(attemptDir(out, job, k));
    if (rec.outside.length > 0) halt(`${job.case} ${job.config} #${job.repeat}: the review wrote outside its workDir: ${rec.outside.join("; ")}`, "outside-workdir");
    if (saved.error) halt(`${job.case} ${job.config} #${job.repeat}: the review threw: ${String(saved.error.message ?? saved.error).split("\n")[0]}`, "review-threw");
    if (saved.leaked) halt(`${job.case} ${job.config} #${job.repeat}: the provider's answer held the ${job.reviewer} endpoint's key or address; only the refusal was saved`, "saved-file");
    else {
      // The manifest names the model that served the run's first answered
      // review, on disk now and in the copy executeRun writes at the end; a
      // review served by another stops the run (failure 26).
      const served = recordServed({ manifestPath: join(out, "manifest.json"), name: job.reviewer, record: rec });
      settings.reviewers[job.reviewer].model = served.model;
      if (served.why) halt(`${job.case} ${job.config} #${job.repeat}: ${served.why}`, "served-model-changed");
    }
    // The review's own spend, from its envelope in the ledger (failure 32).
    meter.close();
    return { rec, ownUsd: meter.spentUsd ?? 0 };
  };

  // A model job (failure 32): its attempt, and when the provider rate
  // limited it (a 429 that is not a quota or billing refusal), one more
  // after a bounded wait, in its next attempt folder with a meter of its
  // own; then the halt rules, once per job, with what its attempts spent.
  // A smoke run counts every attempt against its cap (failure 33).
  const modelJob = async (job, k, ticket) => {
    let meter = ticket;
    let attemptNo = k;
    let ownUsd = 0;
    try {
      for (let retries = 0; ; retries++) {
        const capped = cap?.take(job.config, { retry: retries > 0 });
        if (capped) return halt(capped.why, capped.rule);
        const done = await serverJob(job, attemptNo, meter);
        ownUsd += done.ownUsd;
        const again = stop === null ? rateLimitRetry(done.rec, retries) : null;
        const next = again ? budget.openReview(job) : null;
        if (next?.ok) {
          console.log(`  ${job.case} ${job.config} #${job.repeat}: rate limited; waiting ${again.waitMs / 1000} s, then once more`);
          const until = Date.now() + again.waitMs;
          while (stop === null && Date.now() < until) await new Promise((wake) => setTimeout(wake, Math.min(500, until - Date.now())));
          meter = next.review;
          if (stop !== null) return;
          attemptNo = jobState(out, job).next;
          continue;
        }
        const h = rules.after(done.rec, { ownUsd, reservedUsd: budget.summary().reservedUsd });
        if (h) halt(`${job.case} ${job.config} #${job.repeat}: ${h.why}`, h.rule);
        return;
      }
    } finally {
      // A retry's meter is this job's to close; the first is closed already, and closing is idempotent.
      if (meter !== ticket) meter.close();
    }
  };

  // One attempt, saved as its own scored sample whatever happened (failure 4).
  const attempt = async (job, k) => {
    const dir = attemptDir(out, job, k);
    const caseDir = join(tempRoot, `${job.case}-${job.config}-${job.repeat}-${k}`);
    const { dir: repo, base } = buildRepo(job.case, join(caseDir, "repo"), "laptop");
    const reportDir = join(dir, "report");
    mkdirSync(dir, { recursive: true });
    const caseData = o.control ? controlCaseData(repo, readJson(specFile(job.case))) : undefined;
    const invocation = laptopInvocation({ cli: o.cli, repo, reportDir, job, web: o.web, timeout: o.timeout, maxUsd: Math.max(0, o.maxUsd - budget.summary().spentUsd) / o.concurrency, caseData, instructionsRef: AUTHORED_SUITES[suite]?.conventions ? base : undefined, configPath: AUTHORED_SUITES[suite]?.conventions ? join(repo, ".openqodex/config.yaml") : undefined });
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await runCli(o.cli, [], o.control ? controlEnv(env) : env, repo, o.timeout * 1000, o.control ? 0 : 120_000, invocation);
    } finally {
      if (real) rmSync(caseDir, { recursive: true, force: true });
    }
    const replacements = [[reportDir, "<sample>/report"], [repo, "<repo>"], [tempRoot, "<temp>"], [out, "<results>"], [process.env.HOME, "~"]];
    result.stdout = sanitize(result.stdout, replacements);
    writeFileSync(join(dir, "receipt.txt"), result.stdout);
    writeFileSync(join(dir, "stderr.txt"), sanitize(result.stderr, replacements));
    const report = readJson(join(reportDir, "report.json"));
    const who = readJson(join(reportDir, "reviewer.json"));
    const stoppedHere = stop;
    const failure = stoppedHere !== null && !report ? { cause: `stopped by the run: ${stoppedHere}`, infra: false, unavailable: false } : failureOf(result, report);
    const rec = o.control ? controlSample({ job, attempt: k, result, command: invocation, version: reviewers.control.version, startedAt, stopped: stoppedHere }) : sampleRecord({ job, attempt: k, result, report, who, startedAt, failure, stopped: stoppedHere, usageRecord: readJson(join(reportDir, "usage.json")) });
    if (o.control) {
      writeFileSync(join(dir, "native-output.json"), result.stdout);
      writeFileSync(join(dir, "usage.json"), `${JSON.stringify({ modelUsage: readJson(join(dir, "native-output.json"))?.modelUsage ?? {}, usage: rec.usage }, null, 2)}\n`);
    }
    saveSampleRow(out, attemptDir(out, job, k), rec);
    const tokens = Number.isInteger(rec.usage?.input_tokens) && Number.isInteger(rec.usage?.output_tokens) ? rec.usage.input_tokens + rec.usage.output_tokens : null;
    budget.recordReview({ jobId: job.jobId, usd: typeof rec.usage?.cost_usd === "number" ? rec.usage.cost_usd : null, tokens, wallMs: rec.wallMs });
    if (typeof rec.usage?.cost_usd !== "number") waveUnpriced++;
    const cost = rec.usage?.cost_usd;
    console.log(`  ${job.case} ${job.config} #${job.repeat}${k > 1 ? ` attempt ${k}` : ""}: ${rec.status}, ${rec.findings ?? "no"} findings, ${(rec.wallMs / 1000).toFixed(0)} s${typeof cost === "number" ? `, $${cost.toFixed(2)}` : ""}${rec.failure ? ` (${rec.failure.slice(0, 160)})` : ""}`);
    checkSaved(dir);
    if (o.control) return rec.status === "complete" ? null : { cause: rec.failure || result.stderr || `Claude Code exited ${result.code}`, infra: true, unavailable: false };
    return failure;
  };

  // One job's reviews: its next free attempt (a first attempt that started
  // and never saved is kept, and the work goes to the next folder), and one
  // more after a reviewer failure. A model review's ticket is its meter,
  // which holds its cap; it gets one more attempt only when rate limited
  // (modelJob).
  const runJob = async (job, k, ticket) => {
    if (server) {
      try {
        await modelJob(job, k, ticket);
      } catch (error) {
        halt(`${job.case} ${job.config} #${job.repeat}: the benchmark itself failed: ${error.message}`, "benchmark-failed");
      }
      return;
    }
    try {
      const capped = cap?.take(job.config);
      if (capped) return halt(capped.why, capped.rule);
      const first = await attempt(job, k);
      if (stop !== null) return;
      if (first?.unavailable) return halt(`${job.case} ${job.config}: ${first.cause}`, "reviewer-unavailable");
      if (!first?.infra) return;
      // A limit or a login wall in the failure itself stops the run at once, without a probe.
      if (BLOCKED.test(first.cause)) return halt(`${job.case} ${job.config}: ${first.cause}`, "reviewer-blocked");
      if (o.control) return halt(`${job.case} ${job.config}: ${first.cause}`, "control-failed");
      const p = await probeReviewer(job.reviewer, { env });
      if (!p.ok) return halt(`${job.case} ${job.config}: the reviewer failed (${first.cause}) and the probe says: ${p.text}${p.blocked ? " (a limit or login wall)" : ""}`, "reviewer-blocked");
      const cappedRetry = cap?.take(job.config, { retry: true });
      if (cappedRetry) return halt(cappedRetry.why, cappedRetry.rule);
      console.log(`  ${job.case} ${job.config} #${job.repeat}: reviewer failed (${first.cause}); running it once more`);
      const second = await attempt(job, jobState(out, job).next);
      if (stop !== null) return;
      if (second?.infra && second.cause.split(":")[0] === first.cause.split(":")[0]) halt(`${job.case} ${job.config}: the same reviewer failure twice: ${second.cause}`, "same-failure-twice");
    } catch (error) {
      halt(`${job.case} ${job.config} #${job.repeat}: the benchmark itself failed: ${error.message}`, "benchmark-failed");
    }
  };

  // The folder is taken, the manifest with every planned job written (or the
  // resume checked) and the specs copied before the first review starts
  // (lib/runner.mjs executeRun). The manifest is the first invocation's; a
  // resume never writes it, except to add repeats (failure 9). Before each
  // review the budget is asked; its stop ends the run as "budget".
  let ended;
  try {
    ({ ended } = await executeRun({
      out,
      manifest: o.resume ? null : runManifest({ startedAt, settings, jobs }),
      resume: o.resume,
      checkResume,
      copies: o.cases.map((c) => [specFile(c), join("cases", `${c}.json`)]),
      jobs,
      concurrency: o.concurrency,
      runJob,
      stopReason: () => stop,
      haltOf: () => haltRecord,
      // The models the provider named as answering, per configuration, over every saved attempt.
      finish: () => {
        if (server) return { servedModels: servedByConfig(out) };
        const name = o.control ? "control" : "claude";
        if (!reviewers[name]) return {};
        const observed = claudeRunModels(savedSampleRows(out), o.model, name);
        const actual = { ...reviewers, [name]: { ...reviewers[name], model: observed.model, models: observed.models } };
        return { reviewers: actual, reviewer: o.reviewers.length === 1 ? actual[o.reviewers[0]] : null, modelRefusal: observed.why };
      },
      budget,
      addRepeats: o.addRepeats !== null ? { repeat: o.repeat, at: new Date().toISOString() } : null,
      resumeNote: { budget: settings.budget },
      log: (done, total) => {
        if (done % 10 === 0) console.log(`${done} of ${total} reviews done`);
      },
    }));
  } catch (error) {
    console.error(error.message);
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    leave(2);
  }
  // A model review's clone and a pull request case's laptop checkout are
  // removed once the review ends, so those runs keep no temp folder; a
  // planted case's laptop repositories are kept to look at.
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
  if (server || real) rmSync(tempRoot, { recursive: true, force: true });
  const finished = ended.reviewsWithAnAttempt;
  const spent = typeof ended.spentUsd === "number" ? `; $${ended.spentUsd.toFixed(2)} spent` : "";
  if (ended.how === "finished") console.log(`Done: ${finished} reviews saved in ${shown(out)}${spent}`);
  else console.log(`Stopped${ended.how === "budget" ? " by the budget" : ended.halt ? ` by the halt rule ${ended.halt.rule}` : ""} after ${finished} of ${jobs.length} reviews${spent}: ${ended.why}${ended.how === "budget" ? `. Resume with --resume and a larger limit to finish it; until then it is not a full run.` : ended.halt && ended.halt.rule !== "signal" ? ". Every finished review is saved; look at the cause, then --resume runs the rest." : ""}`);
  console.log(`Score it: node benchmark/score.mjs ${shown(out)}`);
  settleWave?.();
  process.exit(ended.how === "finished" ? 0 : 1);
}

await main();
