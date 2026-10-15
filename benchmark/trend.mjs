#!/usr/bin/env node
// The trend over the committed index, its regression alarm, and the accept
// step:
//
//   node benchmark/trend.mjs [--suite <suite>] [--mode review|scan] [--config <config>] [--alpha 0.05] [--index <folder>]
//   node benchmark/trend.mjs --accept <run-id> --by <name> [--index <folder>] [--results <folder>]
//   node benchmark/trend.mjs --mode scan --against-run <run folder> [--summary <file>] [--index <folder>] [--branch-index <folder>]
//
// The trend reads every entry under benchmark/index/runs (or <folder>/runs)
// and the accepted pointer benchmark/index/accepted.json, groups the runs by
// suite, split, split hash, mode, path, reviewer, model, configuration and
// rules version, and the subset when the run named one (lib/index.mjs
// groupKeys), and prints each group's runs by
// start time with their issue-level numbers and intervals. Legacy runs are
// listed with their own scorer's numbers and no interval. In every group
// with an accepted run, the newest run is compared with it on the cases
// both hold, and the alarm is raised when:
// - an issue-level ratio (issue recall, critical and major issue recall,
//   and each precision bound against the same bound) drops outside the
//   noise: the paired sign-flip test over clusters (lib/interval.mjs
//   pairedBounds) puts the change's one-sided upper bound below zero at
//   the alarm's alpha split equally across those four ratios, and the drop
//   is at least MIN_DROP; or
// - a hard rule breaks: a critical issue found in two or more reviews of
//   the accepted run is found in at most one now (with at least two
//   reviews), or a clean change fails its control in two or more reviews
//   where it failed in at most one before.
// Location metrics are printed as diagnostics and never raise the alarm.
// A scanner-only group is compared exactly instead (compareScan): its
// scores do not vary from run to run, so one lost bug is a regression.
//
// --against-run is the scanner-only gate the bench-scan CI job runs: a
// scored scanner-only run folder (run.mjs --mode scan --check-identical),
// which is not in the index, is compared exactly with the accepted entry of
// its group (scanGate). It passes (exit 0) when the two scores are equal,
// time fields and intervals left out, whatever the Semgrep rule packs, and
// when the score is higher or merely changed while the packs differ from
// the accepted run's, which turns those differences into a warning.
// Anything else fails (exit 1): a regression, whatever the packs; a better
// score the index does not hold yet (the golden pattern: the pull request
// that moves the score carries the new accepted entry); no accepted entry
// for the group; or two passes that differ. --summary <file> appends the
// trend table and the verdict to that file as markdown (the job's
// $GITHUB_STEP_SUMMARY), the same text the gate prints.
//
// --accept first checks the entry against its run: the run folder
// <results>/<run-id> (benchmark/results unless --results names another)
// must be the folder the run was published from or a copy fetched from its
// asset, and the entry built again from it must equal the committed one.
// Then it marks the entry accepted and points every group the run holds at
// it in accepted.json, with the run id, its build commit and the entry's
// score hash (lib/index.mjs scoreHash); the top level names the run
// accepted last. The reviewer loop's base is the commit of the review run
// accepted last (loop/propose.mjs). Commit both
// files in the pull request that carries the decision.
//
// Exit codes: 0 no regression (or accepted); 1 a regression against an
// accepted run; 2 refused or failed (an unsound entry or pointer, an
// accepted entry edited after it was accepted, two runs of one group under
// different rules, a run that cannot be accepted).
//
// Failure list, written before the code:
// 1. A drop inside the noise fails the trend: a ratio's drop counts only
//    when the paired sign-flip test over clusters (cases, or repository
//    groups on real suites, with every repeat kept in its cluster) rejects
//    no change at the split alpha, and it is at least MIN_DROP. A bootstrap
//    is not used here: it calls a drop carried by a few cases significant
//    at any number of cases (lib/interval.mjs says why).
// 2. A real drop passes it: every issue-level ratio is compared, and each
//    precision bound against the same bound of the accepted run, so a drop
//    in confirmed findings raises the alarm though unresolved ones hide it
//    in the upper bound. (Comparing the candidate's lower bound with the
//    accepted run's upper bound, as an acceptance decision does, would
//    raise the alarm on unresolved findings alone.)
// 3. A critical issue lost in two reviews, or a clean change that starts
//    drawing findings, passes because it is small next to the whole run:
//    the hard rules apply whatever the interval reads.
// 4. The trend compares against numbers nobody accepted: the pointer's
//    score hash must match the accepted entry, or the trend stops.
// 5. Runs scored under different rules, by different models or on another
//    split are compared: they are in different groups, and one group under
//    two rules hashes stops the trend.
// 6. A run that cannot be a baseline is accepted: a legacy run, a run
//    already accepted, a draft, a dirty build, a run that did not finish or
//    has planned reviews that never started, a run that does not record
//    every scanner installed, a run whose samples consumed different
//    Semgrep rule packs ("mixed"), and a scanner-only run whose packs are
//    not recorded are refused (lib/external.mjs externalRefusals).
// 7. A rerun of the trend draws other numbers: every sampled test is
//    seeded from the two run ids, the configuration and the metric.
// 8. An entry edited before it is accepted, so its numbers no longer match
//    the run's published score, is accepted all the same: --accept hashes
//    the run folder and checks it against the entry's list hashes, builds
//    the entry again from the folder's manifest, resumes and score.json
//    the way publish-run.mjs does, and refuses on any difference, before
//    it writes either file.
// The scanner-only gate (--against-run), and scanner-only groups:
// 9. A scanner change lowers the scanner-only score and CI stays green:
//    the comparison is exact, case by case: a bug found before and missed
//    now, more unresolved or false candidates, a clean control lost or a
//    scan that saved nothing is a regression, whatever its size.
// 10. A scanner change raises the score and the index keeps the old
//    number, so a later fall back to it passes: any other change of the
//    score fails the gate too, with the steps that record the run.
// 11. The gate passes because there is nothing to compare with: no
//    accepted entry for the run's group (a new rules version included)
//    fails it.
// 12. A Semgrep registry update reads as a product regression and turns
//    every pull request red: when the packs differ from the accepted run's
//    and the score is not lower, every difference is printed as a warning
//    and the gate passes. The bytes of p/default differed five times in an
//    hour of bench-scan runs (2026-10-11) with equal scores, so a drop is
//    never excused by the packs: it fails the gate, and the verdict says
//    the packs differ. Other osv.dev data excuses nothing: its hash also
//    covers the osv-scanner adapter's own messages.
// 13. Two passes that differ are judged by the first: a scored run with no
//    identical.json, or one whose identical.json says the passes differ, is
//    refused (exit 2) with the reason; only identical.json saying equal lets
//    the gate judge.
// 14. A red job does not say why: the summary holds the trend table, the
//    verdict, each difference and the steps that record the run.
// 15. A regression against a newer entry accepted on main passes, because a
//    pull request's head carries its own older copy of the index: in CI,
//    --index is main's copy and --branch-index the branch's. When the
//    branch accepts another run, the gate says so and still compares with
//    main's; a changed score passes only when the branch's accepted run has
//    exactly this run's scores, and a drop against main always fails.
// 16. A model, or anyone people.json does not list, accepts a baseline:
//    --accept refuses a --by that is not a person named in
//    benchmark/review-queue/people.json (lib/rulings.mjs isPersonName).
// 17. An entry's board numbers (outside) are accepted unchecked, or edited
//    after accept: accept refuses numbers that differ from the run's
//    score.json, refuses a copy of the asset (which has none) for an entry
//    that has them, and records their hash (boardHash) beside the score hash.

import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, repoRoot } from "./lib/cases.mjs";
import { externalRefusals, inputDifferences } from "./lib/external.mjs";
import { ACCEPTED_VERSION, acceptedPath, acceptedProblems, boardHash, buildEntry, entryProblems, groupKeys, hashFolder, hashReviewedFolder, indexRoot, listEntries, resultsRoot, scoreHash, writeEntry } from "./lib/index.mjs";
import { ISSUE_METRICS, RESAMPLES, clusterFn, pairedBounds, pairedSums, seedOf } from "./lib/interval.mjs";
import { isPersonName, readPeople } from "./lib/rulings.mjs";
import { claudeRunModels, savedSampleRows } from "./lib/runner.mjs";
import { canonical, rulesDifferences } from "./lib/score.mjs";

// Who may accept a run: the people of the adjudication file's folder.
const peopleFolder = join(benchRoot, "review-queue");

// The alarm's one-sided error over the four issue-level ratios, split
// equally across them, and the smallest drop it names (3 points).
export const ALPHA = 0.05;
export const MIN_DROP = 0.03;

const ratioOf = (r) => (r.of === 0 ? 1 : r.hit / r.of);
const sumSide = (pairs, side) => pairs.reduce((t, p) => ({ hit: t.hit + p[side].hit, of: t.of + p[side].of }), { hit: 0, of: 0 });

// The hard rules (failure 3), from each run's per-bug results and per-case
// clean controls, on the cases both hold. One line per broken rule.
export function hardRules(accepted, candidate, config) {
  const out = [];
  const bugsBefore = accepted.perBug?.[config] ?? {};
  const bugsNow = candidate.perBug?.[config] ?? {};
  for (const id of Object.keys(bugsBefore).sort()) {
    for (const bug of Object.keys(bugsBefore[id]).sort()) {
      const b = bugsBefore[id][bug];
      const a = bugsNow[id]?.[bug];
      if (!a || b.severity !== "critical") continue;
      const before = b.found.filter((f) => f === true).length;
      const now = a.found.filter((f) => f === true).length;
      if (before >= 2 && a.found.length >= 2 && now <= 1) out.push(`${id} ${bug} (critical): found in ${before} of ${b.found.length} reviews of the accepted run, in ${now} of ${a.found.length} now`);
    }
  }
  const casesBefore = accepted.perCase?.[config] ?? {};
  const casesNow = candidate.perCase?.[config] ?? {};
  for (const id of Object.keys(casesBefore).sort()) {
    const b = casesBefore[id].controls;
    const a = casesNow[id]?.controls;
    if (!a || b.of === 0 || a.of === 0) continue;
    const before = b.of - b.hit;
    const now = a.of - a.hit;
    if (now >= 2 && before <= 1) out.push(`${id}: a clean change fails its control (a finding, or no complete review) in ${now} of ${a.of} reviews now, in ${before} of ${b.of} before`);
  }
  return out;
}

// One configuration of a candidate run against the accepted run of its
// group: each issue-level ratio's paired change with its one-sided upper
// bound, the hard rules, and whether the alarm is raised. Each run is an
// index entry, or anything with its runId, perCase, perBug and intervals.
export function compareConfig(accepted, candidate, config, { alpha = ALPHA, resamples = RESAMPLES, minDrop = MIN_DROP } = {}) {
  const groups = candidate.intervals?.groups ?? accepted.intervals?.groups ?? null;
  const clusterOf = clusterFn(groups);
  const before = accepted.perCase?.[config] ?? {};
  const now = candidate.perCase?.[config] ?? {};
  const shared = Object.keys(before).filter((id) => now[id] !== undefined).sort();
  const share = alpha / ISSUE_METRICS.length;
  const metrics = ISSUE_METRICS.map((m) => {
    const pick = (cases) => Object.fromEntries(shared.map((id) => [id, m.perCase(cases[id])]));
    const pairs = pairedSums(pick(before), pick(now), clusterOf);
    const r = pairedBounds({ pairs, seed: seedOf("trend", accepted.runId, candidate.runId, config, m.name), alpha: share, resamples });
    const alarm = r.upper < 0 && r.delta <= -minDrop;
    return { name: m.name, label: m.label, before: ratioOf(sumSide(pairs, "a")), after: ratioOf(sumSide(pairs, "b")), delta: r.delta, upper: r.upper, pLower: r.pLower, method: r.method, changed: r.changed, clusters: r.clusters, alarm };
  });
  const hard = hardRules(accepted, candidate, config);
  return { config, shared: shared.length, unit: groups === null ? "cases" : "repository groups", alpha: share, metrics, hard, regressed: hard.length > 0 || metrics.some((m) => m.alarm) };
}

// One case's scanner-only counts, from the per-case sums an entry holds:
// candidates scored false (every candidate on a clean change), candidates
// with no frozen evidence (unresolved), and the clean control.
const scanCounts = (c) => ({ false: c.precision.upper.of - c.precision.upper.hit, unresolved: c.precision.upper.hit - c.precision.lower.hit, controls: c.controls });

// Every number of a configuration's headline as a dotted path, the
// intervals (seeded from the run id), the times, the costs and f1 (drawn
// from the ratios) left out.
const NOT_COMPARED = new Set(["ci", "wallMsMean", "costUsdMean", "costUsdTotal", "f1"]);
function leaves(v, at = "", out = new Map()) {
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v).sort()) if (!NOT_COMPARED.has(k)) leaves(v[k], at === "" ? k : `${at}.${k}`, out);
  } else out.set(at, v);
  return out;
}

// One configuration of a scanner-only run against the accepted run of its
// group, exactly (failures 9 and 10): each line names the case and what
// moved. `worse` lowers the score, `better` raises it, and `other` is a
// change of anything else the score holds (a case only one run scanned, a
// second candidate on a found bug). Each run is an index entry, or a run
// folder's entry built the same way. `words` names the two runs in the
// lines: `was` the first, `now` the second, and `before` the first
// after a count (the release check names a base and a candidate).
export function compareScan(accepted, candidate, config, { was = "the accepted run", now = "now", before = "before" } = {}) {
  const worse = [];
  const better = [];
  const other = [];
  const casesBefore = accepted.perCase?.[config] ?? {};
  const casesNow = candidate.perCase?.[config] ?? {};
  const bugsBefore = accepted.perBug?.[config] ?? {};
  const bugsNow = candidate.perBug?.[config] ?? {};
  for (const id of [...new Set([...Object.keys(casesBefore), ...Object.keys(casesNow)])].sort()) {
    if (!casesBefore[id] || !casesNow[id]) {
      other.push(`${id}: ${casesBefore[id] ? `scanned by ${was} only` : `not scanned by ${was}`}`);
      continue;
    }
    const bb = bugsBefore[id] ?? {};
    const bn = bugsNow[id] ?? {};
    for (const bug of [...new Set([...Object.keys(bb), ...Object.keys(bn)])].sort()) {
      const fb = bb[bug]?.found ?? [];
      const fn = bn[bug]?.found ?? [];
      const n = Math.max(fb.length, fn.length);
      for (let r = 0; r < n; r++) {
        const at = `${id} ${bug}${n > 1 ? ` (scan ${r + 1})` : ""}`;
        const severity = (bb[bug] ?? bn[bug])?.severity;
        if (fb[r] === true && fn[r] !== true) worse.push(`${at}${severity ? `, ${severity}` : ""}: found by ${was}, missed ${now}`);
        else if (fb[r] !== true && fn[r] === true) better.push(`${at}${severity ? `, ${severity}` : ""}: missed by ${was}, found ${now}`);
      }
    }
    const a = scanCounts(casesBefore[id]);
    const b = scanCounts(casesNow[id]);
    const count = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
    if (b.unresolved !== a.unresolved) (b.unresolved > a.unresolved ? worse : better).push(`${id}: ${count(b.unresolved, "unresolved candidate")} (no frozen evidence), ${a.unresolved} ${before}`);
    if (b.false !== a.false) (b.false > a.false ? worse : better).push(`${id}: ${count(b.false, "false candidate")}, ${a.false} ${before}`);
    if (b.controls.hit !== a.controls.hit) (b.controls.hit < a.controls.hit ? worse : better).push(`${id}: the clean change passes its control (no candidate) in ${b.controls.hit} of ${b.controls.of} scans, ${a.controls.hit} of ${a.controls.of} ${before}`);
  }
  const sb = accepted.scores?.[config]?.population ?? {};
  const sn = candidate.scores?.[config]?.population ?? {};
  const lostScans = (sn.failed ?? 0) + (sn.unstarted ?? 0) - ((sb.failed ?? 0) + (sb.unstarted ?? 0));
  if (lostScans > 0) worse.push(`${lostScans} more ${lostScans === 1 ? "scan" : "scans"} saved no scan.json (failed or never started) than in ${was}`);
  // What the per-case lines do not show, such as a second candidate on a found bug.
  if (worse.length === 0 && better.length === 0 && other.length === 0) {
    const lb = leaves(accepted.scores?.[config] ?? null);
    const ln = leaves(candidate.scores?.[config] ?? null);
    for (const path of [...new Set([...lb.keys(), ...ln.keys()])].sort()) {
      if (canonical(lb.get(path) ?? null) !== canonical(ln.get(path) ?? null)) other.push(`${path}: ${JSON.stringify(lb.get(path) ?? null)} in ${was}, ${JSON.stringify(ln.get(path) ?? null)} ${now}`);
    }
  }
  return { config, worse, better, other, same: worse.length === 0 && better.length === 0 && other.length === 0 };
}

// The steps that record a scanner-only run as the accepted one, as
// markdown lines (failure 10). The run folder is wherever the person put
// it, so it is written <results>/<run-id>.
function acceptSteps(runId, intended = false) {
  return [
    `${intended ? "If the drop is intended: to" : "To"} record ${runId} as the accepted scanner-only run, a person with the run folder at <results>/${runId} runs:`,
    "",
    `1. \`node benchmark/publish-run.mjs <results>/${runId} --dry-run --write-index\` (writes benchmark/index/runs/${runId}.json)`,
    `2. \`node benchmark/trend.mjs --accept ${runId} --by <name> --results <results>\``,
    `3. Commits benchmark/index/runs/${runId}.json and benchmark/index/accepted.json in the pull request; the session uploads the asset with \`node benchmark/publish-run.mjs <results>/${runId}\`.`,
  ];
}

function scanRow(e, config, status) {
  const s = e.scores[config];
  const c = scanCounts(s);
  const time = typeof s.wallMsMean === "number" ? `${(s.wallMsMean / 1000).toFixed(1)} s` : "n/a";
  // The line rule's recall, a diagnostic: on a pull request case no
  // candidate finds a comment, so it is the one number such a scan moves.
  const location = s.location?.recall ? pct(s.location.recall) : "n/a";
  return [startOf(e), e.runId, `${e.build.short} (${e.build.cliVersion ?? "unknown"})`, pct(s.issueRecall.all), pct(s.issueRecall.criticalMajor), `${pct(s.precision.lower)} to ${pct(s.precision.upper)}`, String(c.unresolved), String(c.false), pct(s.controls), String(s.redundancy.of), location, time, status];
}

const readJsonOrNull = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

// The scanner-only gate (failures 9 to 16): the run folder `folder`
// against the accepted entry of its group in `index` (in CI, main's copy of
// the index). `branchIndex`, when given, is the pull request's own index:
// when it accepts another run for the group, the gate says so, still
// compares with main's, and lets a changed score pass only when the
// branch's accepted run has exactly this run's scores. Returns the exit
// code and the markdown lines it printed.
export function scanGate({ index = indexRoot, branchIndex = null, folder }) {
  const manifest = readJsonOrNull(join(folder, "manifest.json"));
  if (manifest === null) throw new Refusal(`${folder} has no manifest.json; it is not a benchmark run`);
  if (manifest.mode !== "scan") throw new Refusal(`${folder} is a ${manifest.mode ?? "review"} run; --against-run compares a scanner-only run (run.mjs --mode scan), and a review run is compared through its index entry`);
  const score = readJsonOrNull(join(folder, "score.json"));
  if (score === null) throw new Refusal(`${folder} has no score.json: the run did not finish a scored pass`);
  const runId = basename(folder);
  // Only a run whose two passes were compared and found equal is judged (failure 13).
  const identical = readJsonOrNull(join(folder, "identical.json"));
  if (identical === null) throw new Refusal(`${runId} has no identical.json: it was scored from one pass that no second pass checked, so its score may not be one number. Run it with node benchmark/run.mjs --mode scan --check-identical.`);
  if (identical.identical !== true) {
    const why = [...(identical.inputs ?? []), ...(identical.differences ?? [])].slice(0, 20).map((d) => `- ${d}`);
    throw new Refusal([`the two passes of ${runId} differ (identical.json, ${identical.cause === "input" ? "their inputs differ" : "with the same inputs"}), so its score is not one number:`, ...why].join("\n"));
  }
  const run = buildEntry({ runId, manifest, resumes: [], score, asset: null, privateListHash: null });
  const main = readIndex(index);
  const branch = branchIndex === null ? null : readIndex(branchIndex);
  const out = [`## Scanner-only benchmark: ${runId}`, ""];
  let code = 0;
  const list = (title, lines) => (lines.length === 0 ? [] : [title, "", ...lines.map((l) => `- ${l}`), ""]);
  for (const g of groupKeys(run)) {
    const mainId = main.pointer?.groups?.[g.key]?.runId ?? null;
    const accepted = mainId === null ? null : main.byId.get(mainId);
    const branchId = branch === null ? mainId : (branch.pointer?.groups?.[g.key]?.runId ?? null);
    const branchDiffers = branch !== null && branchId !== mainId;
    const branchAccepted = branchDiffers && branchId !== null ? branch.byId.get(branchId) : null;
    for (const [e, id] of [[accepted, mainId], [branchAccepted, branchId]]) {
      if (!e) continue;
      const rules = rulesDifferences({ version: e.rulesVersion, hash: e.rulesHash }, { version: run.rulesVersion, hash: run.rulesHash });
      if (rules.length > 0) throw new Refusal(`${runId} cannot be compared with the accepted run ${id}: ${rules.join("; ")}`);
    }
    const against = branch === null ? `the accepted run ${mainId}` : `the run main accepts, ${mainId}`;
    const group = main.entries.filter((e) => groupKeys(e).some((k) => k.key === g.key));
    if (branchAccepted && !group.some((e) => e.runId === branchId)) group.push(branchAccepted);
    group.sort(byStart);
    const status = (e) => (e.runId === mainId ? (branch === null ? "accepted" : "accepted on main") : e.runId === branchId ? "accepted on this branch" : e.accepted ? "accepted before" : "");
    out.push(`${groupLabel(run, g)}. Build ${run.build.short} (openqodex ${run.build.cliVersion ?? "unknown"})${accepted ? `, against ${against} (build ${accepted.build.short})` : ""}.`, "");
    if (branchDiffers) out.push(`This branch's index accepts ${branchId ?? "no run"} for this group, and main's accepts ${mainId ?? "none"}; the gate compares this run with main's.`, "");
    const head = ["Started", "Run", "Build", "Issue recall", "Critical and major recall", "Precision, lower to upper", "Unresolved", "False", "Clean controls", "Candidates", "Location recall (diagnostic)", "Time per scan", "Status"];
    out.push(table(head, [...group.map((e) => scanRow(e, g.config, status(e))), scanRow(run, g.config, "this run")]), "");
    const unsound = externalRefusals(run);
    // A scanner that was not installed would read as that scanner's bugs lost.
    if (run.scannersComplete !== true) unsound.push(`it ran without scanners its cases need, so their bugs would read as lost: ${(manifest.scannersMissing ?? []).map((m) => `${m.scanner} (${String(m.state ?? "not ready").replace(/_/g, " ")})`).join(", ") || "scannersComplete is not true"}`);
    if (unsound.length > 0) {
      code = 1;
      out.push(`Verdict: this run cannot be compared: ${unsound.join("; ")}.`, "");
      continue;
    }
    // The branch's accepted run, when it has exactly this run's scores.
    const branchMatches = branchAccepted !== null && compareScan(branchAccepted, run, g.config).same;
    if (!accepted) {
      if (branchAccepted) {
        const b = compareScan(branchAccepted, run, g.config);
        if (b.same) out.push(`Verdict: main accepts no scanner-only run for this group yet; this branch's index accepts ${branchId}, and this run's scores equal it.`, "");
        else {
          code = 1;
          out.push(`Verdict: main accepts no scanner-only run for this group yet, and this run does not match the run this branch's index accepts, ${branchId}.`, "", ...list("Lower than that run:", b.worse), ...list("Higher than that run:", b.better), ...list("Also changed:", b.other), ...acceptSteps(runId), "");
        }
        continue;
      }
      code = 1;
      out.push("Verdict: no scanner-only run is accepted for this group, so the gate cannot judge this run.", "", ...acceptSteps(runId), "");
      continue;
    }
    const c = compareScan(accepted, run, g.config);
    const inputs = inputDifferences(accepted.external ?? null, run.external ?? null);
    const packsMoved = canonical(accepted.external?.semgrepPacks ?? null) !== canonical(run.external?.semgrepPacks ?? null);
    if (c.same) {
      out.push(`Verdict: the scores equal the accepted run's (${mainId}${branch === null ? "" : ", the run main accepts"}; times and intervals left out). No regression.`, "");
      out.push(...list("These inputs differ and changed no score:", inputs));
      continue;
    }
    let steps = true;
    if (c.worse.length > 0) {
      code = 1;
      out.push(`Verdict: regression against ${against}.${packsMoved ? " The Semgrep rule packs differ from the accepted run's too, so a lost semgrep finding may be the registry's: if every line below is, record this run as the accepted one." : ""}${branchDiffers ? " A drop fails against main whatever this branch's index accepts." : ""}`, "");
    } else if (branchMatches) {
      steps = false;
      out.push(`Verdict: the score changed against ${against}, and this branch's index accepts this run's scores (${branchId}), so the change is recorded. No regression.`, "");
    } else if (packsMoved) {
      out.push(`Verdict: warning, the gate passes. The score is not lower, and the Semgrep rule packs differ from the accepted run's, so a higher or changed score cannot be told from a registry change. Record a new accepted run so the gate judges the next change against it.`, "");
    } else {
      code = 1;
      out.push(branchAccepted ? `Verdict: the score changed against ${against}, and the run this branch's index accepts, ${branchId}, does not match this run.` : `Verdict: the score changed against ${against}, and the index still holds the old number. If the change is wanted, record this run as the accepted one.`, "");
    }
    out.push(...list("Lower than the accepted run:", c.worse), ...list("Higher than the accepted run:", c.better), ...list("Also changed:", c.other), ...list("Inputs that differ from the accepted run's:", inputs));
    if (steps) out.push(...acceptSteps(runId, c.worse.length > 0), "");
  }
  return { code, lines: out };
}

const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const points = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} points`;
const pct = (r) => `${r.hit}/${r.of}${r.of > 0 ? ` (${Math.round((r.hit / r.of) * 100)}%)` : ""}`;
const withCi = (r) => `${pct(r)}${Array.isArray(r.ci) ? ` [${Math.round(r.ci[0] * 100)}%, ${Math.round(r.ci[1] * 100)}%]` : ""}`;
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const startOf = (e) => e.startedAt ?? e.date;
const byStart = (a, b) => (startOf(a) < startOf(b) ? -1 : startOf(a) > startOf(b) ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

function verdict(m) {
  if (m.alarm) return "outside the noise";
  if (m.upper < 0) return `a drop smaller than ${Math.round(MIN_DROP * 100)} points`;
  return "inside the noise";
}

function groupLabel(e, g) {
  const split = `${e.split} split${e.splitHash ? ` ${e.splitHash.slice(0, 8)}` : ""}${e.subset ? `, subset ${e.subset}` : ""}`;
  if (e.mode === "scan") return `${e.suite}, ${split}, scanner-only (no reviewer), ${e.path} path, scan rules version ${e.rulesVersion}`;
  const rules = e.rulesVersion === null || e.rulesVersion === undefined ? "legacy rules (each run scored by its own scorer)" : `rules version ${e.rulesVersion}`;
  return `${e.suite}, ${split}, ${e.mode}, ${e.path} path, ${g.reviewer} (${g.model}), ${g.config}, ${rules}`;
}

function row(e, config, current) {
  const s = e.scores[config];
  const cost = typeof s.costUsdMean === "number" ? `$${s.costUsdMean.toFixed(2)}` : "n/a";
  const time = typeof s.wallMsMean === "number" ? `${Math.round(s.wallMsMean / 1000)} s` : "n/a";
  const build = `${e.build.short} (${e.build.cliVersion ?? "unknown"})`;
  if (e.legacy) return [startOf(e), e.runId, build, pct(s.recall), "n/a", `${pct(s.precision)}, one value by its scorer's rule`, pct(s.controls), "n/a", cost, time, "legacy: its own scorer, no interval"];
  const status = [current ? "accepted" : e.accepted ? "accepted before" : null, e.draft ? "draft" : null, e.release ? `release ${e.release}` : null].filter(Boolean).join(", ");
  const loc = `precision ${pct(s.location.precision)}, recall ${pct(s.location.recall)}`;
  return [startOf(e), e.runId, build, withCi(s.issueRecall.all), withCi(s.issueRecall.criticalMajor), `${withCi(s.precision.lower)} to ${withCi(s.precision.upper)}`, pct(s.controls), loc, cost, time, status];
}

class Refusal extends Error {}

// The index under `index`: every entry, checked, and the accepted pointer,
// checked against them (null when no run is accepted yet).
function readIndex(index) {
  const entries = listEntries(join(index, "runs")).map(({ entry }) => entry);
  const problems = entries.flatMap((e) => entryProblems(e));
  if (problems.length > 0) throw new Refusal(`the index holds unsound entries:\n${problems.join("\n")}`);
  const byId = new Map(entries.map((e) => [e.runId, e]));
  const path = acceptedPath(index);
  if (!existsSync(path)) return { entries, byId, pointer: null };
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Refusal(`${path} is not JSON: ${error.message}`);
  }
  const wrong = acceptedProblems(pointer, byId);
  if (wrong.length > 0) throw new Refusal(wrong.join("\n"));
  return { entries, byId, pointer };
}

// Prints the trend and returns whether any group regressed.
export function runTrend({ index = indexRoot, suite = null, mode = null, config = null, alpha = ALPHA, log = console.log } = {}) {
  const { entries, byId, pointer } = readIndex(index);
  const groups = new Map();
  for (const e of entries) {
    if ((suite && e.suite !== suite) || (mode && e.mode !== mode)) continue;
    for (const g of groupKeys(e)) {
      if (config && g.config !== config) continue;
      if (!groups.has(g.key)) groups.set(g.key, { label: groupLabel(e, g), config: g.config, entries: [] });
      groups.get(g.key).entries.push(e);
    }
  }
  const shown = relative(repoRoot, index).startsWith("..") ? index : relative(repoRoot, index) || ".";
  log(`Trend over ${entries.length} runs in ${shown}, in ${groups.size} ${groups.size === 1 ? "group" : "groups"}${suite || mode || config ? " (filtered)" : ""}.`);
  if (pointer === null) log("No run is accepted yet, so nothing is compared and no alarm can be raised.");
  const regressed = [];
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    const runs = [...g.entries].sort(byStart);
    const acceptedId = pointer?.groups?.[key]?.runId ?? null;
    log("");
    log(g.label);
    log("");
    log(table(["Started", "Run", "Build", "Issue recall", "Critical and major recall", "Precision, lower to upper", "Clean controls", "Location (diagnostic)", "Cost per review", "Time per review", "Status"], runs.map((e) => row(e, g.config, e.runId === acceptedId))));
    if (acceptedId === null) continue;
    const accepted = byId.get(acceptedId);
    const newest = runs[runs.length - 1];
    log("");
    if (newest.runId === acceptedId) {
      log(`The accepted run ${acceptedId} is the newest of this group.`);
      continue;
    }
    if (newest.perCase === null || accepted.perCase === null) {
      log(`Held-out entries hold aggregates only, so ${newest.runId} is not paired with ${acceptedId}.`);
      continue;
    }
    const rules = rulesDifferences({ version: accepted.rulesVersion, hash: accepted.rulesHash }, { version: newest.rulesVersion, hash: newest.rulesHash });
    if (rules.length > 0) throw new Refusal(`${newest.runId} cannot be compared with the accepted run ${acceptedId}: ${rules.join("; ")}`);
    // A scanner-only group is compared exactly (failure 9); a drop is a regression whatever the Semgrep rule packs (failure 12).
    if (newest.mode === "scan") {
      const s = compareScan(accepted, newest, g.config);
      const packsMoved = canonical(accepted.external?.semgrepPacks ?? null) !== canonical(newest.external?.semgrepPacks ?? null);
      log(s.same ? `The newest run ${newest.runId} has the scores of the accepted run ${acceptedId}.` : `The newest run ${newest.runId} against the accepted run ${acceptedId}, compared exactly${packsMoved ? " (their Semgrep rule packs differ, so a change may be the registry's)" : ""}:`);
      for (const [title, lines] of [["Lower", s.worse], ["Higher", s.better], ["Also changed", s.other]]) for (const l of lines) log(`- ${title}: ${l}`);
      if (s.worse.length > 0) regressed.push(`${g.label}: ${newest.runId} against ${acceptedId}`);
      continue;
    }
    const c = compareConfig(accepted, newest, g.config, { alpha });
    log(`The newest run ${newest.runId} against the accepted run ${acceptedId}, on ${c.shared} shared cases (paired sign-flip test over ${c.unit}, one-sided, alpha ${c.alpha} per ratio):`);
    for (const m of c.metrics) {
      const how = `${m.method}, ${m.changed} changed ${m.changed === 1 ? c.unit.replace(/s$/, "") : c.unit}`;
      log(`- ${m.label}: ${pct1(m.after)} against ${pct1(m.before)}, a change of ${points(m.delta)}; upper bound ${points(m.upper)}, one-sided p ${(m.pLower * 100).toFixed(2)}% (${how}): ${verdict(m)}`);
    }
    if (c.hard.length > 0) {
      log("Hard rules broken:");
      for (const h of c.hard) log(`- ${h}`);
    }
    const la = accepted.scores[g.config].location;
    const ln = newest.scores[g.config].location;
    log(`Location, a diagnostic only: precision ${pct(ln.precision)} against ${pct(la.precision)}, recall ${pct(ln.recall)} against ${pct(la.recall)}.`);
    if (c.regressed) regressed.push(`${g.label}: ${newest.runId} against ${acceptedId}`);
  }
  log("");
  if (regressed.length === 0) log(pointer === null ? "No alarm." : "No regression against the accepted runs.");
  else {
    log("Regression against the accepted run:");
    for (const r of regressed) log(`- ${r}`);
  }
  return regressed.length > 0;
}

// Why an entry cannot be a baseline (failure 6); empty when it can.
export function acceptRefusals(e) {
  const out = [];
  if (e.legacy) out.push("it is a legacy run, scored by its own scorer before score format 3; legacy runs are listed, never accepted");
  if (e.accepted) out.push(`it is already accepted (${e.acceptedAt} by ${e.acceptedBy})`);
  if (e.draft === true) out.push("it is a draft run, whose cases need not match the lock");
  if (e.build?.dirty !== false) out.push("its build is dirty: the commit does not hold the tree the reviewed CLI was built from");
  if (e.ended?.how !== "finished") out.push(`it ended as "${e.ended?.how ?? "unknown"}"${e.ended?.why ? ` (${e.ended.why})` : ""}, not finished`);
  // Unknown counts as missing: a run made before run.mjs records its scanner
  // preflight (P1-T13) may have lacked Ruby or Go scanners, so no such run
  // becomes a baseline.
  if (e.scannersComplete !== true) out.push("it does not record every scanner its cases need as installed (scannersComplete is not true)");
  for (const [config, s] of Object.entries(e.scores ?? {})) if ((s.population?.unstarted ?? 0) > 0) out.push(`${config}: ${s.population.unstarted} planned reviews never started`);
  // What its scans consumed: one rule set for every sample, and recorded.
  out.push(...externalRefusals(e));
  return out;
}

// Why a committed entry is not the one its run gives (failure 8); empty
// when it is. The folder <results>/<run-id> must be the one the run was
// published from (its file list hash is the entry's privateListHash) or a
// copy fetched from the asset (its list hash is the asset's), and the entry
// built from its files the way publish-run.mjs builds it must equal the
// committed one, the accepted mark aside.
export function runMismatch(entry, results) {
  const folder = join(results, entry.runId);
  if (!existsSync(join(folder, "manifest.json"))) return [`the run folder ${folder} is missing: fetch it with node benchmark/fetch-run.mjs ${entry.runId}, or name the folder that holds it with --results`];
  const { listHash: hash } = hashFolder(folder);
  const reviewed = hashReviewedFolder(folder).listHash;
  if (hash !== entry.privateListHash && hash !== entry.asset.listHash && reviewed !== entry.privateListHash && reviewed !== entry.asset.listHash) return [`${folder} is neither the published asset nor the folder it was published from (its file list hash is ${hash}): fetch the run again into an empty folder`];
  // The asset carries no board numbers, so only the folder the run was published from can check them.
  if (hash === entry.asset.listHash && entry.outside !== undefined) return [`${folder} is a copy of the published asset, which carries no board numbers, so it cannot check the entry's: name the folder the run was published from with --results`];
  let rebuilt;
  try {
    const read = (file) => JSON.parse(readFileSync(join(folder, file), "utf8"));
    const resumes = existsSync(join(folder, "resumes.jsonl")) ? readFileSync(join(folder, "resumes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    rebuilt = buildEntry({ runId: entry.runId, manifest: read("manifest.json"), resumes, score: read("score.json"), asset: entry.asset, privateListHash: entry.privateListHash });
  } catch (error) {
    return [`the entry cannot be built again from ${folder}: ${error.message}`];
  }
  if (canonical(rebuilt.outside ?? null) !== canonical(entry.outside ?? null)) throw new Refusal(`refused: ${entry.runId}'s board numbers (outside) differ from those in its score.json`);
  const committed = { ...entry, accepted: false, acceptedAt: null, acceptedBy: null };
  const differ = [...new Set([...Object.keys(rebuilt), ...Object.keys(committed)])].filter((k) => canonical(rebuilt[k] ?? null) !== canonical(committed[k] ?? null)).sort();
  const out = entryProblems(rebuilt);
  if (differ.length > 0) out.push(`the entry does not match its run: ${differ.join(", ")} differ from what ${folder} gives`);
  return out;
}

// Marks one run accepted and points every group it holds at it.
export function acceptRun({ index = indexRoot, results = resultsRoot, runId, by, people = readPeople(peopleFolder), now = new Date().toISOString(), log = console.log }) {
  if (typeof by !== "string" || by.trim() === "") throw new Refusal("--accept needs --by <name>: who accepts the run");
  // A person accepts a baseline, never a model or an agent (failure 16).
  if (!isPersonName(by, people)) throw new Refusal(`refused: --by ${JSON.stringify(by)} is not a person named in ${relative(repoRoot, join(peopleFolder, "people.json"))} (${people.join(", ") || "it names nobody"}); a model or an agent never accepts a run`);
  const { byId, pointer } = readIndex(index);
  const entry = byId.get(runId);
  if (!entry) throw new Refusal(`refused: the index holds no entry ${runId}`);
  const why = acceptRefusals(entry);
  if (why.length === 0) why.push(...runMismatch(entry, results));
  if (why.length > 0) throw new Refusal(`refused: ${runId} cannot be accepted:\n${why.map((w) => `- ${w}`).join("\n")}`);
  if (entry.mode !== "scan" && entry.reviewers?.claude) {
    // The index entry keeps no requested model; the run folder's manifest, checked above, does.
    const requested = JSON.parse(readFileSync(join(results, runId, "manifest.json"), "utf8")).reviewers?.claude?.requestedModel ?? null;
    const observed = claudeRunModels(savedSampleRows(join(results, runId)), requested);
    if (observed.why) throw new Refusal(`refused: ${runId} cannot be accepted: ${observed.why}`);
  }
  const marked = { ...entry, accepted: true, acceptedAt: now, acceptedBy: by };
  const written = writeEntry(marked, join(index, "runs"));
  const board = boardHash(marked);
  const record = { runId, commit: entry.build.commit, scoreHash: scoreHash(marked), ...(board === null ? {} : { boardHash: board }), acceptedAt: now, acceptedBy: by };
  const groups = { ...pointer?.groups };
  const keys = groupKeys(marked).map((g) => g.key);
  for (const key of keys) groups[key] = record;
  const next = { version: ACCEPTED_VERSION, ...record, groups: Object.fromEntries(Object.keys(groups).sort().map((k) => [k, groups[k]])) };
  writeFileSync(acceptedPath(index), `${JSON.stringify(next, null, 2)}\n`);
  log(`Accepted ${runId} (commit ${entry.build.commit}) by ${by} for ${keys.length} ${keys.length === 1 ? "group" : "groups"}:`);
  for (const key of keys) log(`- ${key}`);
  log(`Commit ${acceptedPath(index)} and ${written} in the pull request that carries the decision.`);
}

const USAGE = "usage: node benchmark/trend.mjs [--suite <suite>] [--mode review|scan] [--config <config>] [--alpha 0.05] [--index <folder>]\n       node benchmark/trend.mjs --accept <run-id> --by <name> [--index <folder>] [--results <folder>]\n       node benchmark/trend.mjs --mode scan --against-run <run folder> [--summary <file>] [--index <folder>] [--branch-index <folder>]";

function main() {
  const args = process.argv.slice(2);
  const o = { index: indexRoot, results: resultsRoot, suite: null, mode: null, config: null, alpha: ALPHA, accept: null, by: null, againstRun: null, summary: null, branchIndex: null };
  const value = (i) => {
    if (i + 1 >= args.length) throw new Refusal(`${args[i]} needs a value`);
    return args[i + 1];
  };
  // The summary file gets what the gate printed, or why it could not run (failure 14).
  const toSummary = (lines) => {
    if (o.summary !== null) appendFileSync(o.summary, `${lines.join("\n")}\n`);
  };
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--index") o.index = resolve(value(i++));
      else if (a === "--suite") o.suite = value(i++);
      else if (a === "--mode") o.mode = value(i++);
      else if (a === "--config") o.config = value(i++);
      else if (a === "--accept") o.accept = value(i++);
      else if (a === "--by") o.by = value(i++);
      else if (a === "--results") o.results = resolve(value(i++));
      else if (a === "--against-run") o.againstRun = resolve(value(i++));
      else if (a === "--summary") o.summary = resolve(value(i++));
      else if (a === "--branch-index") o.branchIndex = resolve(value(i++));
      else if (a === "--alpha") {
        o.alpha = Number(value(i++));
        if (!(o.alpha > 0 && o.alpha < 1)) throw new Refusal("--alpha must be a number between 0 and 1");
      } else throw new Refusal(`unknown argument ${a}\n${USAGE}`);
    }
    if (o.againstRun !== null) {
      if (o.accept !== null || o.suite !== null || o.config !== null || (o.mode !== null && o.mode !== "scan")) throw new Refusal(`--against-run compares one scanner-only run with its accepted entry and takes --mode scan, --summary, --index and --branch-index only\n${USAGE}`);
      const { code, lines } = scanGate({ index: o.index, branchIndex: o.branchIndex, folder: o.againstRun });
      console.log(lines.join("\n"));
      toSummary(lines);
      process.exit(code);
    }
    if (o.summary !== null || o.branchIndex !== null) throw new Refusal(`--summary and --branch-index go with --against-run\n${USAGE}`);
    if (o.accept !== null) {
      acceptRun({ index: o.index, results: o.results, runId: o.accept, by: o.by });
      process.exit(0);
    }
    process.exit(runTrend(o) ? 1 : 0);
  } catch (error) {
    const message = error instanceof Refusal ? error.message : error.stack;
    console.error(message);
    try {
      toSummary(["## Scanner-only benchmark", "", "The trend could not be computed:", "", "```", message, "```"]);
    } catch (e) {
      console.error(`the summary file could not be written: ${e.message}`);
    }
    process.exit(2);
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
