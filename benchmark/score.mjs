#!/usr/bin/env node
// Scores a saved benchmark run, from its files only, and compares it with
// an earlier run when asked:
//
//   node benchmark/score.mjs <results folder> [--against <earlier folder>]
//                            [--specs <folder of <case>.json>] [--judge <judge.json>]
//                            [--out <folder>] [--decisions <file>] [--outside aacr] [--json]
//
// The specs are the run's own copies (cases/ in the run). --specs scores the
// saved reviews against other specs, such as an amended copy; the output and
// the score file then name that folder and every case whose spec differs
// from the run's own. No review is run again either way.
//
// Writes score format 3: score.json (the population of planned first
// attempts, issue recall, precision as bounds, unique-issue precision,
// redundancy, severity agreement and who found each bug (from each review's
// own scan.json), the location and planted-rule blocks, per-case ratios,
// per-bug results with the cause of each miss (lib/causes.mjs), the rules
// block, a 95% cluster bootstrap interval on each issue-level ratio,
// lib/interval.mjs, seeded from the run id so a rescore draws the same
// interval, and each configuration's wording verdict from the run's
// judge.json, or the file --judge names, which no rule reads),
// outcomes.jsonl (one line per finding of every first attempt, with the
// cause of each counted non-hit) and unresolved.jsonl (each finding that
// still asks a person a question, with its text and the code it cites, for
// queue.mjs add), into the results folder or --out. It applies the rulings
// in the adjudication file, benchmark/review-queue/decisions.jsonl unless
// --decisions names another, and records that file's sha256. A legacy run (one
// with a recipe in benchmark/legacy/recipes.json) keeps the score its own
// scorer wrote: its folder is the published original, so its format 3 score
// is written only with --out. Prints markdown tables (or, with --json, the
// score as JSON). The exit code is information, never a gate on its own: 0
// scored, 1 the comparison shows a regression (a bug missed in two or more
// reviews that the earlier run found more often, or more clean changes with
// findings), 2 the folder cannot be scored.
//
// Failure list, written before the code (the matching rules and their own
// failure list are in lib/score.mjs):
// 1. A review leaves no row and the run looks better than it was: every
//    attempt folder is read, and one the runner never finished recording
//    (no sample.json) is a review that happened, counted apart as
//    unrecorded; a planned review with no folder at all is unstarted and
//    counts as a miss (format 3).
// 2. The specs of today are used for an old run without saying so: the
//    specs come from the run's own cases/ folder unless --specs names
//    another, and then every difference is printed and saved.
// 3. A spec that breaks the matching rules (a plant without its words) is
//    scored anyway: every spec is checked first, and one that fails stops
//    the scoring with its problems.
// 4. Two runs with different models or case sets are compared as builds:
//    every difference is printed above the comparison.
// 5. A table hides how many samples a number rests on: every ratio is
//    printed as hits/checks, every time and cost with its count.
// 6. A legacy run's published folder is written over, so it stops being
//    the original its index entry names: the folder the files go to, the
//    run's own or --out, is checked by its canonical path, and is refused
//    when it is, or lies in, a folder named for any legacy run.
// 7. A scanner-only run is scored by the review rules, which read findings
//    a reviewer wrote: a run whose manifest says mode "scan" is scored by
//    lib/scan-score.mjs from each sample's scan.json, under its own rules
//    block, into the same score format.
// 8. Two runs whose scans read other Semgrep rule packs or other osv.dev
//    advisories are compared as builds: every difference in their external
//    inputs is printed above the comparison, labelled as an input.
// 9. The wording verdict changes the score or its exit code: it is added to
//    each configuration after the scoring (lib/score.mjs wordingBlock), and
//    a judge file (the run's own or --judge's) that cannot be read, or does
//    not hold what judge.mjs writes, leaves the wording null with one line
//    on stderr naming it, never a failed scoring.
// 10. A run whose manifest names no suite (or another suite than its jobs)
//    is scored as planted: the suite the manifest names, planted when it
//    names none, must be the suite of every job's case id, or the run is
//    refused.
// 11. A pull request case's spec is refused by the planted spec rules, or a
//    truth copy that lacks an accepted comment its suite lists is scored:
//    a real suite's spec copy is checked with lib/suites.mjs
//    realSpecProblems, against its own count and the committed suite.
// 12. An outside board's numbers change our score: --outside aacr reads what
//    AACR-Bench's own evaluator wrote under <run>/outside/aacr/
//    (lib/aacr-board.mjs readAacrOutside) after the run is scored, and adds
//    it as outside.aacr only; every other field of score.json, the rules
//    block and the exit code are what they are without the flag. Their
//    files that cannot be read leave outside.aacr null, with one line on
//    stderr naming why, never a failed scoring.
// 13. Adding board diagnostics replaces a reviewed score or its queue files:
//    an existing score gets only the outside block on an in-place board refresh.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, parseCaseId, repoRoot, specProblems } from "./lib/cases.mjs";
import { realSpecProblems } from "./lib/suites.mjs";
import { CAUSES_VERSION, MISS_CAUSES, NON_HIT_CAUSES, countCauses, runCauses } from "./lib/causes.mjs";
import { inputDifferences } from "./lib/external.mjs";
import { runIntervals } from "./lib/interval.mjs";
import { unresolvedItems } from "./lib/queue.mjs";
import { readDecisions, resolveRulings } from "./lib/rulings.mjs";
import { SCAN_RULES, scanRegressions, scoreScanAttempts } from "./lib/scan-score.mjs";
import { RULES, SEVERITY_ORDER, attemptOf, bugStability, caseSetHash, groupBy, originOf, regressions, runDifferences, scoreAttempts, scoreSample, specDifferences, summarize, value, wordingBlock } from "./lib/score.mjs";
import { readRecipes } from "./legacy/rescore.mjs";
import { readAacrOutside } from "./lib/aacr-board.mjs";
import { claudeRunModels } from "./lib/runner.mjs";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

// The cases a run planned, by name: the manifest's case list, and the cases
// its `jobs` name.
function plannedCases(manifest) {
  const names = new Set(manifest.cases ?? []);
  for (const j of manifest.jobs ?? []) names.add(parseCaseId(j.caseId)?.name ?? j.caseId);
  return [...names];
}

// A path as a score shows it: relative to the repository when it lies in
// it, or relative to it for an external folder, so no machine path is published.
const shownPath = (p) => {
  const r = relative(repoRoot, p);
  return r !== "" && !isAbsolute(r) ? r : basename(p);
};

export function loadRun(folder, { specsDir = null, judgeFile = null } = {}) {
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  // The suite decides the rules every spec is read by (failure 10).
  const suite = manifest.suite ?? "planted";
  const others = [...new Set((manifest.jobs ?? []).map((j) => parseCaseId(j.caseId)?.suite).filter((s) => s && s !== suite))];
  if (others.length > 0) throw new Error(`${folder}: the manifest ${manifest.suite === undefined ? "names no suite, which reads as planted" : `names the suite ${suite}`}, but its jobs are cases of ${others.join(", ")}; a run is scored by its own suite's rules, so it is not scored`);
  const planted = originOf(suite) === "planted";
  const from = specsDir ?? join(folder, "cases");
  const specs = {};
  const ownSpecs = {};
  const problems = [];
  const samples = [];
  const attempts = [];
  let unrecorded = 0;
  const specOf = (c) => {
    if (specs[c]) return specs[c];
    const spec = readJson(join(from, `${c}.json`));
    if (!spec) throw new Error(`${join(from, `${c}.json`)} is missing; a spec is needed to score ${c}`);
    // The matching rules only: the scorer reads no label, and runs made before the freeze saved specs without them.
    // A pull request case's spec is its truth copy, checked by its suite's rules (failure 11).
    problems.push(...(planted ? specProblems(spec, c, { labels: false }) : realSpecProblems(spec, c, { suite })));
    specs[c] = spec;
    ownSpecs[c] = readJson(join(folder, "cases", `${c}.json`));
    return spec;
  };
  for (const c of dirs(join(folder, "samples"))) {
    const spec = specOf(c);
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        // The folder says which job and which attempt this is (lib/score.mjs attemptOf).
        const which = attemptOf(n);
        if (which === null) throw new Error(`${dir} is not an attempt folder (<repeat> or <repeat>-attempt<n>)`);
        let row = readJson(join(dir, "sample.json"));
        // An attempt the runner never finished recording is still a review that happened.
        if (!row) {
          unrecorded++;
          row = { case: c, config, repeat: which.repeat, attempt: which.attempt, unrecorded: true };
        }
        const report = readJson(join(dir, "report", "report.json"));
        const brief = readText(join(dir, "report", "brief.md"));
        // The scanners' own record, which decides who found each bug (null when
        // the review saved none), and what a scanner-only run scores.
        const scan = readJson(join(dir, "report", "scan.json"));
        // What the reviewer answered, the tool calls it made and the correction rounds, for the causes of its misses (lib/causes.mjs).
        const submission = readJson(join(dir, "report", "submission.json"));
        const trace = readJson(join(dir, "report", "trace.json"));
        const rounds = readJson(join(dir, "report", "rounds.json"));
        const sample = scoreSample({ spec, report, brief, row });
        samples.push(sample);
        attempts.push({ case: c, config, ...which, row, report, brief, scan, submission, trace, rounds, sample });
      }
    }
  }
  // A planned case with no folder at all still needs its spec: its jobs never started, and miss its bugs.
  for (const c of plannedCases(manifest)) specOf(c);
  if (problems.length > 0) throw new Error(`the specs in ${from} cannot be scored with:\n${problems.join("\n")}${specsDir ? "" : "\nScore against amended specs with --specs <folder>."}`);
  const resumes = existsSync(join(folder, "resumes.jsonl")) ? readFileSync(join(folder, "resumes.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const specsDiffer = specsDir ? Object.keys(specs).filter((c) => JSON.stringify(specs[c]) !== JSON.stringify(ownSpecs[c])) : [];
  // Shown and saved relative to the repository when the run lies in it, so no machine path is published.
  const name = shownPath(folder);
  const specsName = specsDir === null ? null : shownPath(specsDir);
  // The wording verdict: the run's own judge.json, or the file --judge names.
  const judgePath = judgeFile ?? join(folder, "judge.json");
  const judge = existsSync(judgePath) ? readJson(judgePath) : null;
  // A judge file that cannot be read is named, and never fails the scoring.
  const judgeProblem = judge === null && (judgeFile !== null || existsSync(judgePath)) ? `${shownPath(judgePath)} cannot be read as a judge.json, so the score carries no wording verdict` : null;
  const judgeFrom = judgeFile === null ? "judge.json" : shownPath(judgeFile);
  return { folder, name, manifest, specs, samples, attempts, unrecorded, resumes, specsFrom: specsName, specsDiffer, judge, judgeFrom, judgeProblem };
}

const pct = (r) => `${r.hit}/${r.of}${r.of > 0 ? ` (${Math.round(value(r) * 100)}%)` : ""}`;
const secs = (s) => (s.n === 0 ? "n/a" : `${(s.mean / 1000).toFixed(0)} s`);
const usd = (s) => (s.n === 0 ? "n/a" : `$${s.mean.toFixed(2)}`);
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

// Score format 2: every saved attempt as a sample. Kept for the comparison
// format 3 states, and for anyone reading a legacy run with today's code.
export function summary(run) {
  const byConfig = {};
  for (const [config, samples] of groupBy(run.samples, (s) => s.config)) byConfig[config] = summarize(samples);
  const byCase = {};
  for (const [key, samples] of groupBy(run.samples, (s) => `${s.case}\0${s.config}`)) {
    const [c, config] = key.split("\0");
    byCase[c] ??= {};
    byCase[c][config] = summarize(samples);
  }
  const stability = {};
  for (const [config, samples] of groupBy(run.samples, (s) => s.config)) stability[config] = bugStability(samples);
  const briefFailures = {};
  for (const [config, samples] of groupBy(run.samples, (s) => s.config)) {
    const seen = new Map();
    for (const s of samples) for (const f of s.failures) seen.set(`${s.case}: ${f}`, (seen.get(`${s.case}: ${f}`) ?? 0) + 1);
    briefFailures[config] = [...seen].map(([what, n]) => ({ what, samples: n }));
  }
  const falseFindings = run.samples.flatMap((s) => s.findings.filter((f) => ["false", "near", "wrong-kind"].includes(f.outcome)).map((f) => ({ case: s.case, config: s.config, repeat: s.repeat, outcome: f.outcome, file: f.file, line: f.line, category: f.category, severity: f.severity, title: f.title, bug: f.bug ?? null, distance: f.distance ?? null })));
  return {
    run: run.name,
    build: run.manifest.build,
    reviewer: run.manifest.reviewer ?? run.manifest.reviewers,
    repeat: run.manifest.repeat,
    planned: run.manifest.planned,
    saved: run.samples.length,
    secondAttempts: run.samples.filter((x) => x.attempt > 1).length,
    unrecorded: run.unrecorded,
    ended: run.manifest.ended,
    resumes: run.resumes,
    specsFrom: run.specsFrom ?? "the run's own cases/",
    specsDiffer: run.specsDiffer,
    byConfig,
    byCase,
    stability,
    briefFailures,
    falseFindings,
  };
}

// The per-case sums the intervals and the trend pair on: the rules' own
// per-case ratios, plus critical and major recall and the clean control,
// summed over every repeat of the case from the scored jobs. A sum of the
// jobs' numbers, so no scoring rule lives here.
function caseSums(perCase, jobs) {
  const out = structuredClone(perCase);
  const plus = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });
  for (const config of Object.keys(out)) for (const c of Object.values(out[config])) Object.assign(c, { criticalMajor: { hit: 0, of: 0 }, controls: { hit: 0, of: 0 } });
  for (const j of jobs) {
    const c = out[j.config][j.caseId];
    c.criticalMajor = plus(c.criticalMajor, j.issueRecall.criticalMajor);
    c.controls = plus(c.controls, j.controls);
  }
  return out;
}

// The repository group of each real case, from its spec: the cluster its
// interval draws. Null on a planted suite, where the case is the cluster. A
// real case without one would count its pull requests as independent of
// their repository's others, so it stops the scoring.
function repoGroups(origin, jobs, specs) {
  if (origin === "planted") return null;
  const out = {};
  for (const j of jobs) {
    const group = specs[j.case]?.repoGroup;
    if (typeof group !== "string" || group === "") throw new Error(`the ${origin} case ${j.caseId} names no repoGroup, so its interval cannot keep a repository's pull requests together`);
    out[j.caseId] = group;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Score format 3 of a loaded run under the rulings in `decisions` (the
// adjudication file's lines, lib/rulings.mjs readDecisions): `score` is
// score.json, `outcomes` the lines of outcomes.jsonl, `unresolved` those of
// unresolved.jsonl, `jobs` the scored jobs (for a comparison).
export function scoreRun(run, { decisionsHash = null, decisions = [], people = [] } = {}) {
  const m = run.manifest;
  // The scoring itself, attempt selection and rulings included, is
  // lib/score.mjs scoreAttempts, which the rules hash covers, or for a
  // scanner-only run lib/scan-score.mjs scoreScanAttempts, which the scan
  // rules hash covers and which reads no ruling: rulings are on reviewers'
  // findings, by finding id.
  const scan = m.mode === "scan";
  const s = scan ? scoreScanAttempts({ manifest: m, attempts: run.attempts, specs: run.specs }) : scoreAttempts({ manifest: m, attempts: run.attempts, specs: run.specs, decisions, people });
  // The intervals are seeded from the run id, the folder's name, never its
  // path, so a copy elsewhere draws the same intervals. A scanner-only run's
  // second pass (run.mjs --check-identical) carries its first pass's run id.
  const perCase = caseSums(s.perCase, s.jobs);
  const { byConfig, intervals } = runIntervals({ runId: m.runId ?? basename(run.folder), byConfig: s.byConfig, perCase, groups: repoGroups(originOf(s.suite), s.jobs, run.specs) });
  // The wording verdict, added after the scoring: report only. A judge.json
  // that does not hold what the judge writes leaves every block null, with
  // the problem named, and never fails the scoring.
  let wordingProblem = null;
  let wording = Object.fromEntries(Object.keys(byConfig).map((config) => [config, null]));
  if (run.judge) {
    try {
      wording = Object.fromEntries(Object.keys(byConfig).map((config) => [config, wordingBlock(run.judge, config, run.judgeFrom)]));
    } catch (error) {
      wordingProblem = `${run.judgeFrom} does not hold what judge.mjs writes (${String(error.message).split("\n")[0]}), so the score carries no wording verdict`;
    }
  }
  for (const config of Object.keys(byConfig)) byConfig[config].wording = wording[config];
  // Why each truth item was missed and each counted finding is not a hit
  // (lib/causes.mjs): a cause per repeat in perBug, one per finding in
  // outcomes.jsonl, and the counts per configuration. The causes are the
  // reviewer's, so a scanner-only run, which has no reviewer, gets none.
  const causes = scan ? null : runCauses({ jobs: s.jobs, attempts: run.attempts, specs: run.specs, rulings: resolveRulings(decisions, people) });
  for (const j of causes ? s.jobs : []) {
    const c = causes.byJob.get(j.jobId);
    for (const b of j.bugs) {
      const x = s.perBug[j.config][j.caseId][b.id];
      if (!Array.isArray(x.cause)) x.cause = [];
      x.cause[j.repeat - 1] = c.bugs[b.id]?.cause ?? null;
    }
  }
  for (const o of causes ? s.outcomes : []) o.cause = causes.byJob.get(o.jobId).findings[o.index]?.cause ?? null;
  for (const [config, x] of causes ? Object.entries(byConfig) : []) {
    const mine = (rows) => rows.filter((r) => r.config === config);
    x.causes = { version: CAUSES_VERSION, misses: countCauses(mine(causes.misses), MISS_CAUSES), nonHits: countCauses(mine(causes.nonHits), NON_HIT_CAUSES) };
  }
  const score = {
    version: 3,
    rules: scan ? SCAN_RULES : RULES,
    run: run.name,
    suite: s.suite,
    split: m.split ?? "dev",
    splitHash: m.splitHash ?? null,
    mode: m.mode ?? "review",
    path: m.path ?? "laptop",
    build: m.build ?? null,
    reviewers: (() => {
      const reviewers = m.reviewers ?? (m.reviewer ? { [m.reviewer.name]: m.reviewer } : null);
      if (!reviewers?.claude) return reviewers;
      return { ...reviewers, claude: { ...reviewers.claude, model: claudeRunModels(run.attempts.map((a) => a.row)).model } };
    })(),
    caseIds: s.caseIds,
    caseSetHash: s.caseIds.every((id) => parseCaseId(id) !== null) ? caseSetHash(s.caseIds) : null,
    decisionsHash,
    rulings: s.rulings ?? null,
    external: m.external ?? null,
    repeat: m.repeat ?? null,
    population: { ...s.population, unrecorded: run.unrecorded },
    ended: m.ended ?? null,
    resumes: run.resumes,
    specsFrom: run.specsFrom ?? "the run's own cases/",
    specsDiffer: run.specsDiffer,
    byConfig,
    intervals,
    perCase,
    perBug: s.perBug,
    briefFailures: s.briefFailures,
  };
  // A scanner-only run's candidates enter the review queue only from real
  // pull requests (P1-T8 and P2), so its queue file is empty.
  const unresolved = scan ? [] : unresolvedItems({ runId: m.runId ?? basename(run.folder), build: m.build?.short ?? null, commit: m.build?.commit ?? null, suite: s.suite, split: score.split, specsFrom: run.specsFrom ?? null, jobs: s.jobs, attempts: run.attempts, specs: run.specs });
  return { score, outcomes: s.outcomes, unresolved, jobs: s.jobs, causes, wordingProblem };
}

// The legacy run whose folder `path` is or lies in, wherever it is, by the
// canonical path (symbolic links and `..` resolved): a folder named for a
// run in benchmark/legacy/recipes.json. Null when there is none.
export function legacyFolderOf(path, recipes) {
  let head = resolve(path);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  const canonical = join(realpathSync(head), ...rest);
  return canonical.split(sep).find((part) => recipes.runs[part] !== undefined) ?? null;
}

const bounds = (b) => (b.lower.of === 0 ? "n/a" : `${pct(b.lower)} to ${pct(b.upper)}`);

// The wording blocks of a score's configurations as a table, or null when
// no configuration has one. Report only.
export function renderWording(byConfig) {
  const rows = Object.entries(byConfig).filter(([, w]) => w);
  if (rows.length === 0) return null;
  const models = [...new Set(rows.map(([, w]) => w.model))].join(", ");
  const served = [...new Set(rows.flatMap(([, w]) => w.servedModels))].join(", ");
  const from = [...new Set(rows.map(([, w]) => w.from))].join(", ");
  const pair = (s) => `${pct(s.plain)} / ${pct(s.correct)}`;
  const cost = (w) => `$${w.costUsd.toFixed(2)}${w.costUnknown > 0 ? ` (${w.costUnknown} reviews with no cost reported)` : ""}`;
  return [
    `Wording, judged by ${models}${served ? ` (answered as ${served})` : ""}, from ${from}. Report only: it never changes a hit, a count, an exit code or an accept.`,
    "",
    table(["Configuration", "Findings", "Problem plain / correct", "Consequence plain / correct", "Fix plain / correct", "Unparsed", "Judge cost"], rows.map(([c, w]) => [c, String(w.findings), pair(w.problem), pair(w.consequence), pair(w.fix), String(w.unparsed), cost(w)])),
  ].join("\n");
}

// A ratio with its interval, when the score carries one.
const ci = (r) => (Array.isArray(r.ci) ? ` [${Math.round(r.ci[0] * 100)}%, ${Math.round(r.ci[1] * 100)}%]` : "");
const withCi = (r) => `${pct(r)}${ci(r)}`;
const boundsCi = (b) => (b.lower.of === 0 ? "n/a" : `${withCi(b.lower)} to ${withCi(b.upper)}`);

export function renderV3(s) {
  const configs = Object.keys(s.byConfig);
  const out = [];
  const p = s.population;
  out.push(`Run ${s.run}`);
  out.push(`Build ${s.build?.short ?? "unknown"} (openqodex ${s.build?.cliVersion ?? "unknown"}${s.build?.dirty ? ", built from a tree the commit does not hold" : ""}); suite ${s.suite}, split ${s.split}; scoring rules version ${s.rules.version} (${s.rules.hash.slice(0, 12)}).`);
  if (s.reviewers?.claude) out.push(`Claude Code model: ${s.reviewers.claude.model ?? "unknown"}.`);
  out.push(`Population: ${p.planned} planned reviews (${p.jobsFrom === "manifest" ? "from the manifest's jobs" : "derived from the manifest's cases, configurations and repeats, since it lists no jobs"}), each scored by its first attempt: ${p.complete} complete, ${p.incomplete} incomplete, ${p.failed} failed, ${p.unstarted} never started. ${p.retries} retries, scored apart${p.retries > 0 ? ` (cost ${p.retryCostUsd === null ? "unknown" : `$${p.retryCostUsd.toFixed(2)}`})` : ""}.`);
  if (p.unplanned.length > 0) out.push(`Left out: ${p.unplanned.length} first attempts of no planned review (${p.unplanned.join(", ")}).`);
  if (p.unrecorded > 0) out.push(`${p.unrecorded} attempts the runner never finished recording are scored from their folders.`);
  if (s.specsFrom !== "the run's own cases/") out.push(`Scored against the specs in ${s.specsFrom}, not the run's own; they differ for: ${s.specsDiffer.join(", ") || "no case"}.`);
  const r = s.rulings ?? { read: 0, ignored: [] };
  out.push(`Rulings: ${r.read} lines of the adjudication file read${s.decisionsHash ? ` (sha256 ${s.decisionsHash.slice(0, 12)})` : ""}, ${r.ignored.length} ignored${r.ignored.length > 0 ? `: ${r.ignored.map((x) => `line ${x.line}, ${x.why}`).join("; ")}` : ""}.`);
  // The difference from score format 2, which counted every saved attempt.
  for (const c of configs) {
    const x = s.byConfig[c];
    const a = x.allAttempts;
    const legacy = x.plantedLegacy?.precision ?? null;
    const same = a.recall.hit === x.issueRecall.all.hit && a.recall.of === x.issueRecall.all.of && (legacy === null || (a.precision.hit === legacy.hit && a.precision.of === legacy.of));
    if (same && x.population.retries === 0 && x.population.unstarted === 0) continue;
    out.push(`${c}: counting every saved attempt, as score format 2 did, gives recall ${pct(a.recall)} and planted-rule precision ${pct(a.precision)} over ${a.samples} attempts; this score counts the first attempt of each of ${x.population.planned} planned reviews (${x.population.retries} retries left out, ${x.population.unstarted} never started), so recall is ${pct(x.issueRecall.all)}${legacy ? ` and planted-rule precision ${pct(legacy)}` : ""}.`);
  }
  const iv = s.intervals;
  if (iv) out.push(`Intervals in brackets: ${Math.round(iv.level * 100)}% percentile bootstrap over ${iv.cluster === "case" ? "cases" : "repository groups"}, ${iv.resamples} resamples, seeded from the run id ${iv.runId}; none with fewer than ${iv.minClusters} ${iv.cluster === "case" ? "cases" : "groups"} to count.`);
  out.push("");
  const loc = (c) => `precision ${pct(c.location.precision)}, recall ${pct(c.location.recall)}${c.location.knownNoise > 0 ? `, ${c.location.knownNoise} known noise` : ""}`;
  const rows = [
    ["Issue recall, all", (c) => withCi(c.issueRecall.all)],
    ["Issue recall, critical and major", (c) => withCi(c.issueRecall.criticalMajor)],
    ["Precision, lower to upper bound", (c) => boundsCi(c.precision)],
    ["Unresolved findings (no ruling yet)", (c) => String(c.precision.unresolved)],
    ["Unique-issue precision, lower to upper", (c) => bounds(c.uniqueIssuePrecision)],
    ["Redundancy (findings beyond one per issue)", (c) => pct(c.redundancy)],
    ["F1 (on the lower precision bound)", (c) => c.f1.toFixed(2)],
    ["Clean changes with no finding", (c) => pct(c.controls)],
    ["Findings per clean change", (c) => (c.cleanFindingsPerCase.cases === 0 ? "n/a" : (c.cleanFindingsPerCase.findings / c.cleanFindingsPerCase.cases).toFixed(2))],
    ["Reviews complete / incomplete / failed / never started", (c) => `${c.population.complete} / ${c.population.incomplete} / ${c.population.failed} / ${c.population.unstarted}`],
    ["Severity as the spec rates it, of found issues", (c) => pct(c.severity.exact)],
    ["Severity one step off / two or more off", (c) => `${pct(c.severity.oneOff)} / ${pct(c.severity.off)}`],
    ["Severity rated higher / lower than the spec", (c) => `${c.severity.over} / ${c.severity.under}`],
    ["Found by whom the spec expects", (c) => pct(c.finder.match)],
    ["Found issues a scanner located / the reviewer alone", (c) => `${c.finder.byFinder.scanner} / ${c.finder.byFinder.reviewer}${c.finder.unjudged > 0 ? ` (${c.finder.unjudged} with no saved scan)` : ""}`],
    ["Expected from a scanner, found by the reviewer alone", (c) => String(c.finder.scannerExpectedReviewerFound)],
    ["Truth items with a scanner candidate the reviewer dropped", (c) => String(c.finder.droppedCandidates)],
    ["Planted-rule precision (format 2 rule, planted only)", (c) => (c.plantedLegacy ? pct(c.plantedLegacy.precision) : "n/a")],
    ["Requests for a test on planted cases (out of both bounds)", (c) => (c.plantedLegacy ? String(c.plantedLegacy.testGaps) : "n/a")],
    ["Location diagnostic (line rule, K=1)", loc],
    ["Graph gaps disclosed in the brief", (c) => pct(c.brief.gaps)],
    ["Callers listed in the brief", (c) => pct(c.brief.callers)],
    ["Time per review, mean (median)", (c) => (c.wallMs.n === 0 ? "n/a" : `${secs(c.wallMs)} (${(c.wallMs.median / 1000).toFixed(0)} s)`)],
    ["Cost per review, mean", (c) => usd(c.costUsd)],
    ["Cost, total (retries apart)", (c) => (c.costUsd.n === 0 ? "n/a" : `$${c.costUsd.total.toFixed(2)}`)],
    ["Tokens in / out per review, mean", (c) => (c.inputTokens.n === 0 ? "n/a" : `${Math.round(c.inputTokens.mean / 1000)}k / ${Math.round(c.outputTokens.mean / 1000)}k`)],
    // Model reviews only: the models the provider named as serving them.
    ...(configs.some((c) => Array.isArray(s.byConfig[c].servedModels)) ? [["Models that served the reviews", (c) => (Array.isArray(c.servedModels) ? c.servedModels.join(", ") || "none named" : "n/a")]] : []),
  ];
  out.push(table(["Measure", ...configs], rows.map(([label, f]) => [label, ...configs.map((c) => f(s.byConfig[c]))])));
  out.push("");
  const wording = renderWording(Object.fromEntries(configs.map((c) => [c, s.byConfig[c].wording ?? null])));
  if (wording !== null) out.push(wording, "");
  for (const c of configs) {
    const m = s.byConfig[c].severity.matrix;
    out.push(`Severity given (columns) against the spec's (rows), found issues (${c}):`);
    out.push("");
    out.push(table(["Spec", ...SEVERITY_ORDER], SEVERITY_ORDER.map((e) => [e, ...SEVERITY_ORDER.map((g) => String(m[e][g]))])));
    out.push("");
  }
  const expected = [...new Set(configs.flatMap((c) => Object.keys(s.byConfig[c].finder.byExpected)))].sort();
  if (expected.length > 0) {
    out.push("Found issues by the finder the spec expects (a scanner: it located the issue; reasoning or graph: no scanner located it):");
    out.push("");
    out.push(table(["Expected finder", ...configs], expected.map((name) => [name, ...configs.map((c) => (s.byConfig[c].finder.byExpected[name] ? pct(s.byConfig[c].finder.byExpected[name]) : "n/a"))])));
    out.push("");
  }
  out.push("Per case (issue recall; precision bounds):");
  out.push("");
  const caseIds = [...new Set(configs.flatMap((c) => Object.keys(s.perCase[c] ?? {})))].sort();
  out.push(table(["Case", ...configs], caseIds.map((id) => [id, ...configs.map((c) => {
    const x = s.perCase[c]?.[id];
    return x ? `${pct(x.issueRecall)}; ${bounds(x.precision)}` : "n/a";
  })])));
  out.push("");
  const missed = configs.flatMap((c) => Object.entries(s.perBug[c] ?? {}).flatMap(([id, bugs]) => Object.entries(bugs).filter(([, b]) => b.found.some((f) => !f)).map(([bug, b]) => [c, id, bug, b.severity, `${b.found.filter(Boolean).length}/${b.found.length}`])));
  if (missed.length > 0) {
    out.push("Truth items not found in every planned review:");
    out.push("");
    out.push(table(["Configuration", "Case", "Bug", "Severity", "Found"], missed));
    out.push("");
  }
  for (const c of configs) {
    if ((s.briefFailures[c] ?? []).length === 0) continue;
    out.push(`What the brief did not say (${c}):`);
    for (const f of s.briefFailures[c]) out.push(`- ${f.what} (${f.reviews} reviews)`);
    out.push("");
  }
  return out.join("\n");
}

// The outside.aacr block as text: AACR-Bench's own numbers per
// configuration, beside our location numbers. A board output only.
export function renderAacrOutside(b) {
  const p = (x) => `${Math.round(x * 1000) / 10}%`;
  const out = [`AACR-Bench's own evaluator (${b.board.repo} at ${b.board.commit.slice(0, 12)}, reader ${b.reader}, line tolerance ${b.lineK}${b.judge ? `, judge ${b.judge.deployment}, ${b.judge.rounds} rounds` : ", no judged evaluation"}). A board output, never an acceptance metric.`];
  out.push(`Left-side references: ${b.references.left} of ${b.references.total} (${p(b.references.share)}), which no finding can match by line. Findings held with no line: ${b.withoutLine}.`);
  out.push("");
  const rows = Object.entries(b.byConfig).map(([config, c]) => {
    const l = c.mean.line;
    const s = c.mean.semantic;
    const equal = c.repeats.every((r) => r.lineEqual);
    return [config, `${l.matches}/${l.generated} (${p(l.precision)})`, `${l.matches}/${l.expected} (${p(l.recall)})`, equal ? "equal" : "differ", s ? `${p(s.precision)} / ${p(s.recall)} / ${s.f1.toFixed(2)}` : `not reported (${c.repeats.find((r) => r.why)?.why ?? "no judge"})`, s ? p(s.noiseRate) : "n/a"];
  });
  out.push(table(["Configuration", "Line precision", "Line recall", "Line counts against ours", "Semantic precision / recall / F1", "Noise rate"], rows));
  for (const problem of b.problems) out.push(`- ${problem}`);
  return out.join("\n");
}

// Everything besides the build that differs between two runs, the
// external inputs their scans consumed included.
export function differences(older, newer) {
  return [...runDifferences(older.manifest, newer.manifest), ...specDifferences(older.specs, newer.specs), ...inputDifferences(older.manifest.external ?? null, newer.manifest.external ?? null)];
}

export function renderCompare(older, newer, so, sn, regs) {
  const out = [];
  const diffs = differences(older, newer);
  out.push(`Comparing ${older.name} (build ${older.manifest.build?.short}) with ${newer.name} (build ${newer.manifest.build?.short}), both scored with these rules.`);
  if (diffs.length > 0) {
    out.push("These differ besides the build, so a change below may not be the product's:");
    for (const d of diffs) out.push(`- ${d}`);
  }
  out.push("");
  const configs = [...new Set([...Object.keys(so.byConfig), ...Object.keys(sn.byConfig)])].sort();
  const cell = (s, cfg, f) => (s.byConfig[cfg] ? f(s.byConfig[cfg]) : "n/a");
  const rows = [];
  for (const cfg of configs) {
    rows.push([cfg, "issue recall", cell(so, cfg, (c) => pct(c.issueRecall.all)), cell(sn, cfg, (c) => pct(c.issueRecall.all))]);
    rows.push([cfg, "precision bounds", cell(so, cfg, (c) => bounds(c.precision)), cell(sn, cfg, (c) => bounds(c.precision))]);
    rows.push([cfg, "clean controls", cell(so, cfg, (c) => pct(c.controls)), cell(sn, cfg, (c) => pct(c.controls))]);
    rows.push([cfg, "never started or failed", cell(so, cfg, (c) => String(c.population.unstarted + c.population.failed)), cell(sn, cfg, (c) => String(c.population.unstarted + c.population.failed))]);
    rows.push([cfg, "graph gaps", cell(so, cfg, (c) => pct(c.brief.gaps)), cell(sn, cfg, (c) => pct(c.brief.gaps))]);
    rows.push([cfg, "time per review", cell(so, cfg, (c) => secs(c.wallMs)), cell(sn, cfg, (c) => secs(c.wallMs))]);
    rows.push([cfg, "cost per review", cell(so, cfg, (c) => usd(c.costUsd)), cell(sn, cfg, (c) => usd(c.costUsd))]);
  }
  out.push(table(["Configuration", "Measure", `Before (${older.manifest.build?.short})`, `After (${newer.manifest.build?.short})`], rows));
  out.push("");
  if (regs.length === 0) out.push("No regression: no truth item is missed in two or more reviews more often than before.");
  else {
    out.push("Regressions (missed in two or more reviews, more often than before):");
    for (const r of regs) out.push(`- ${r.config} ${r.case} ${r.bug}: found ${r.before} before, ${r.after} after`);
  }
  return out.join("\n");
}

// The adjudication file the scorer reads unless --decisions names another.
export const decisionsPath = join(benchRoot, "review-queue", "decisions.jsonl");

const ciText = (r) => (Array.isArray(r?.ci) ? ` [${Math.round(r.ci[0] * 100)}%, ${Math.round(r.ci[1] * 100)}%]` : "");
const describePacks = (p) => (Array.isArray(p) ? (p.length === 0 ? "none consumed" : p.map((x) => `${x.pack} ${x.sha256.slice(0, 12)}`).join(", ")) : `${p ?? "not recorded"}`);

// A scanner-only run's score as markdown tables: the headline numbers, the
// inputs the scans consumed, each scanner, each case and every bug missed.
export function renderScan(s, manifest = {}) {
  const configs = Object.keys(s.byConfig);
  const out = [];
  const p = s.population;
  const x = s.external;
  out.push(`Run ${s.run}`);
  out.push(`Build ${s.build?.short ?? "unknown"} (openqodex ${s.build?.cliVersion ?? "unknown"}${s.build?.dirty ? ", built from a tree the commit does not hold" : ""}); suite ${s.suite}, split ${s.split}; scanner-only, no reviewer; scan rules version ${s.rules.version} (${s.rules.hash.slice(0, 12)}).`);
  out.push(`Population: ${p.planned} planned scans, each scored by its first attempt: ${p.complete} complete, ${p.failed} failed, ${p.unstarted} never started.`);
  if (x) out.push(`Inputs: scanner toolchain ${x.toolchainHash.slice(0, 12)}; Semgrep rule packs ${describePacks(x.semgrepPacks)}; osv.dev advisories ${x.osvAdvisories.advisories} (${x.osvAdvisories.sha256.slice(0, 12)}).`);
  const missing = manifest.scannersMissing ?? [];
  if (missing.length > 0) out.push(`Not installed on this machine, so not run: ${missing.map((m) => `${m.scanner} (${m.detail ?? m.state})`).join(", ")}.`);
  const iv = s.intervals;
  if (iv) out.push(`Intervals in brackets: ${Math.round(iv.level * 100)}% percentile bootstrap over ${iv.cluster === "case" ? "cases" : "repository groups"}, ${iv.resamples} resamples, seeded from the run id ${iv.runId}; none with fewer than ${iv.minClusters} ${iv.cluster === "case" ? "cases" : "groups"} to count.`);
  out.push("");
  const rows = [
    ["Issue recall, all", (c) => `${pct(c.issueRecall.all)}${ciText(c.issueRecall.all)}`],
    ["Issue recall, critical and major", (c) => `${pct(c.issueRecall.criticalMajor)}${ciText(c.issueRecall.criticalMajor)}`],
    ["Recall on bugs a scanner is expected to find", (c) => pct(c.scannerRecall)],
    ["Precision, lower to upper bound", (c) => (c.precision.lower.of === 0 ? "n/a" : `${pct(c.precision.lower)} to ${pct(c.precision.upper)}`)],
    ["Unresolved candidates (no frozen evidence)", (c) => String(c.precision.unresolved)],
    ["Redundancy (candidates beyond one per issue)", (c) => pct(c.redundancy)],
    ["Clean changes with no candidate", (c) => pct(c.controls)],
    ["Candidates per clean change", (c) => (c.cleanFindingsPerCase.cases === 0 ? "n/a" : (c.cleanFindingsPerCase.findings / c.cleanFindingsPerCase.cases).toFixed(2))],
    ["Location diagnostic (line rule, K=1)", (c) => `precision ${pct(c.location.precision)}, recall ${pct(c.location.recall)}`],
    ["Time per scan, mean (median)", (c) => (c.wallMs.n === 0 ? "n/a" : `${(c.wallMs.mean / 1000).toFixed(1)} s (${(c.wallMs.median / 1000).toFixed(1)} s)`)],
  ];
  out.push(table(["Measure", ...configs], rows.map(([label, f]) => [label, ...configs.map((c) => f(s.byConfig[c]))])));
  for (const config of configs) {
    const per = s.byConfig[config].perScanner;
    out.push("");
    out.push(`Each finder (${config}): its candidates by outcome, and the bugs it was expected to find, located over looked at, with the scans where it did not run apart:`);
    out.push("");
    out.push(table(["Finder", "Candidates", "Hits", "Duplicates", "Unresolved", "False", "Expected bugs located", "Not run"], Object.entries(per).map(([name, r]) => [name, r.candidates, r.hits, r.duplicates, r.unresolved, r.false, pct(r.expected), r.notRun].map(String))));
  }
  out.push("");
  out.push("Per case (issue recall; precision bounds):");
  out.push("");
  const caseIds = [...new Set(configs.flatMap((c) => Object.keys(s.perCase[c] ?? {})))].sort();
  out.push(table(["Case", ...configs], caseIds.map((id) => [id, ...configs.map((c) => {
    const r = s.perCase[c]?.[id];
    return r ? `${pct(r.issueRecall)}; ${bounds(r.precision)}` : "n/a";
  })])));
  const missed = configs.flatMap((c) => Object.entries(s.perBug[c] ?? {}).flatMap(([id, bugs]) => Object.entries(bugs).filter(([, b]) => b.found.some((f) => !f)).map(([bug, b]) => [c, id, bug, b.severity ?? "n/a", `${b.found.filter(Boolean).length}/${b.found.length}`])));
  if (missed.length > 0) {
    out.push("");
    out.push("Truth items no scanner found:");
    out.push("");
    out.push(table(["Configuration", "Case", "Bug", "Severity", "Found"], missed));
  }
  return out.join("\n");
}

// Two scanner-only runs compared: every difference besides the build, then
// each bug the earlier run found and the later one does not.
export function renderScanCompare(older, newer, regs) {
  const out = [`Comparing ${older.name} (build ${older.manifest.build?.short}) with ${newer.name} (build ${newer.manifest.build?.short}).`];
  const diffs = differences(older, newer);
  if (diffs.length > 0) {
    out.push("These differ besides the build, so a change below may not be the product's:");
    for (const d of diffs) out.push(`- ${d}`);
  }
  if (regs.length === 0) out.push("No regression: every bug the earlier run found is still found.");
  else {
    out.push("Regressions (found before, missed now):");
    for (const r of regs) out.push(`- ${r.config} ${r.case} ${r.bug}`);
  }
  return out.join("\n");
}

// Scores a run folder and writes score.json, outcomes.jsonl and
// unresolved.jsonl into it, as node benchmark/score.mjs <folder> does with
// no other option; run.mjs calls it at the end of a scanner-only pass.
// Returns the score and the run.
export function saveScore(folder) {
  const run = loadRun(resolve(folder));
  const legacy = legacyFolderOf(run.folder, readRecipes());
  if (legacy !== null) throw new Error(`${run.folder} is, or lies in, the folder of the legacy run ${legacy}; its score is the one its own scorer wrote`);
  const d = readDecisions(decisionsPath);
  const { score, outcomes, unresolved } = scoreRun(run, { decisionsHash: d.hash, decisions: d.lines, people: d.people });
  writeFileSync(join(run.folder, "score.json"), `${JSON.stringify({ ...score, comparedWith: null }, null, 2)}\n`);
  writeFileSync(join(run.folder, "outcomes.jsonl"), outcomes.map((o) => `${JSON.stringify(o)}\n`).join(""));
  writeFileSync(join(run.folder, "unresolved.jsonl"), unresolved.map((o) => `${JSON.stringify(o)}\n`).join(""));
  return { score, run };
}

function main() {
  const args = process.argv.slice(2);
  let against = null;
  let specsDir = null;
  let judgeFile = null;
  let outDir = null;
  let decisionsFile = decisionsPath;
  let json = false;
  let outside = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--against") against = args[++i];
    else if (args[i] === "--outside") outside = args[++i];
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--specs") specsDir = args[++i];
    else if (args[i] === "--judge") judgeFile = args[++i];
    else if (args[i] === "--out") outDir = args[++i];
    else if (args[i] === "--decisions") decisionsFile = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || against === undefined || specsDir === undefined || judgeFile === undefined || outDir === undefined || decisionsFile === undefined || (outside !== null && outside !== "aacr")) {
    console.error("usage: node benchmark/score.mjs <results folder> [--against <earlier results folder>] [--specs <folder of <case>.json>] [--judge <judge.json>] [--out <folder>] [--decisions <file>] [--outside aacr] [--json]");
    process.exit(2);
  }
  let run;
  let older = null;
  let scored;
  let olderScored = null;
  let dest;
  try {
    run = loadRun(resolve(pos[0]), { specsDir: specsDir === null ? null : resolve(specsDir), judgeFile: judgeFile === null ? null : resolve(judgeFile) });
    if (run.judgeProblem !== null) console.error(run.judgeProblem);
    // Where the files go, checked by its canonical path: never a legacy run's folder or a folder in one, this run's or another's.
    dest = outDir === null ? run.folder : resolve(outDir);
    const legacy = legacyFolderOf(dest, readRecipes());
    if (legacy !== null) {
      throw new Error(`${dest} is, or lies in, the folder of the legacy run ${legacy}, which is the published original and holds the scores its own scorers wrote. Write the format 3 score into another folder with --out <folder>.`);
    }
    if (against) older = loadRun(resolve(against));
    const d = readDecisions(resolve(decisionsFile));
    scored = scoreRun(run, { decisionsHash: d.hash, decisions: d.lines, people: d.people });
    if (scored.wordingProblem !== null) console.error(scored.wordingProblem);
    if (older) olderScored = scoreRun(older, { decisionsHash: d.hash, decisions: d.lines, people: d.people });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { score, outcomes, unresolved, jobs } = scored;
  const scanOnly = score.mode === "scan";
  if (older && (older.manifest.mode ?? "review") !== score.mode) {
    console.error(`${older.name} is a ${older.manifest.mode ?? "review"} run and ${run.name} a ${score.mode} run; compare runs of one mode`);
    process.exit(2);
  }
  const regs = older ? (scanOnly ? scanRegressions(olderScored.jobs, jobs) : regressions(olderScored.jobs, jobs)) : [];
  const boardOnly = outside === "aacr" && against === null && specsDir === null && judgeFile === null && outDir === null && decisionsFile === decisionsPath && existsSync(join(dest, "score.json"));
  const doc = boardOnly ? readJson(join(dest, "score.json")) : { ...score, comparedWith: older ? { run: older.name, build: older.manifest.build, differences: differences(older, run), regressions: regs } : null };
  // An outside board's own evaluator, read after the scoring and added beside it (failure 12).
  if (outside === "aacr") {
    try {
      doc.outside = { aacr: readAacrOutside(run.folder, jobs, run.specs) };
    } catch (error) {
      doc.outside = { aacr: null };
      console.error(`outside.aacr is null: ${String(error.message).split("\n")[0]}`);
    }
  }
  // Scored against other specs, the score gets its own files, so the score
  // against the run's own specs is never overwritten.
  const suffix = specsDir === null ? "" : `-${basename(resolve(specsDir))}`;
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, `score${suffix}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  if (!boardOnly) {
    writeFileSync(join(dest, `outcomes${suffix}.jsonl`), outcomes.map((o) => `${JSON.stringify(o)}\n`).join(""));
    writeFileSync(join(dest, `unresolved${suffix}.jsonl`), unresolved.map((o) => `${JSON.stringify(o)}\n`).join(""));
  }
  const shown = (p) => (relative(repoRoot, p).startsWith("..") ? p : relative(repoRoot, p));
  if (json) console.log(JSON.stringify(doc, null, 2));
  else if (boardOnly) {
    // The fresh score is not the saved one, so only the board numbers are shown.
    if (doc.outside.aacr) console.log(renderAacrOutside(doc.outside.aacr));
    console.log(`\nBoard numbers added to ${shown(join(dest, "score.json"))}. The rest of the score and its queue files are unchanged.`);
  } else {
    console.log(scanOnly ? renderScan(score, run.manifest) : renderV3(score));
    if (doc.outside?.aacr) console.log(`\n${renderAacrOutside(doc.outside.aacr)}`);
    if (older) console.log(`\n${scanOnly ? renderScanCompare(older, run, regs) : renderCompare(older, run, olderScored.score, score, regs)}`);
    console.log(`\nScore saved: ${shown(join(dest, `score${suffix}.json`))}, with ${outcomes.length} finding outcomes in ${shown(join(dest, `outcomes${suffix}.jsonl`))} and ${unresolved.length} findings for the review queue in ${shown(join(dest, `unresolved${suffix}.jsonl`))} (node benchmark/queue.mjs add ${shown(join(dest, `unresolved${suffix}.jsonl`))})`);
  }
  process.exit(regs.length > 0 ? 1 : 0);
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
