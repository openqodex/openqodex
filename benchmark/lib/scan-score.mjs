// Scores a scanner-only run (run.mjs --mode scan) against the frozen specs
// of its cases, from the saved scan.json of each first attempt. No reviewer
// runs, so what is scored is what the scanners hand the reviewer: every
// candidate in scan.json, in its order (c1, c2, ...).
//
// A candidate is matched to a truth item by location: its lines,
// [lineStart, max(lineEnd, lineStart)], overlap one of the item's locations
// (its file and lines, or an entry of `also`), paths normalised. On those
// lines it finds the item when either holds:
//   - the item's found_by names one of the candidate's finders: its scanner,
//     a scanner whose finding dedup merged into it (alsoReportedBy), or the
//     OpenQodex rule it is (OWN_RULES); the scanner the spec expects needs no
//     words, since a scanner speaks in rule text, not in the spec's prose;
//   - its rule id, its message or a merged token names one of the item's
//     mentions by the review scorer's word rule (lib/score.mjs names).
// The checks run in this order, and the first that holds decides:
//   1. accepted    a side issue the spec lists in `extras`, by place and words
//   2. hit         a planted bug, by place and finder or words; a later hit on
//                  a bug (or a side issue) already found in the same scan is a
//                  duplicate: redundancy, never precision
//   3. near        finder or words, 1 to NEAR_LINES lines away: unresolved
//   4. unresolved  anything else on a planted case; on a bug's lines it is a
//                  location match with no frozen evidence (location-only)
//   5. false       every candidate on a clean case
// Precision is a pair of bounds, as in score format 3: unresolved candidates
// count wrong in the lower bound and right in the upper.
//
// Failure list, written before the code:
// 1. The expected scanner's candidate on the planted lines counts as false
//    because its message lacks the spec's words: the finder rule above.
// 2. A second candidate on one bug lowers precision: it is a duplicate,
//    counted in redundancy and kept out of precision.
// 3. Another scanner's candidate on the planted lines that names nothing of
//    the bug is read as finding it: it is unresolved, location-only, and
//    finds nothing.
// 4. A scanner that did not run reads as missing the bugs it was expected to
//    find: per scanner, such a bug is counted apart as not run, never as a
//    miss.
// 5. A scan that never ran, or wrote no scan.json, looks clean: every
//    planned job's first attempt is the population (lib/score.mjs
//    population); a job with no attempt or no scan misses every bug of its
//    case and adds no candidate.
// 6. A clean change scores well because it has nothing to miss: every
//    candidate there is false, and its control passes only with none.
// 7. A rule changes and two scan scores compare as equal: SCAN_RULES carries
//    a version and a hash over its constants and the text of every
//    declaration the scoring reaches, here and in the modules it imports
//    from; a test pins the hash to SCAN_RULES_VERSION.
// 8. A custom scanner that names a rule openqodex.suppression-added is
//    credited as the product's own suppression finder: an own rule counts
//    only for a built-in scanner's candidate, and only a rule id OWN_RULES
//    itself holds (never one a plain object inherits, such as constructor).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AACR_LINE_K, LOCATION_LABEL, NEAR_LINES, lineMatches, names, normPath, normText, originOf, population, ratio, rulesHash, stats, topLevel, value } from "./score.mjs";

// Scan rules version 2 (W8-2): Greptile suite scoring through its board judge, denominator fixed at 50.
// Merged PR 229: scanner outside advisories are information; legacy untagged findings still count.
// Scan rules version 3: lib/score.mjs's lineMatches, which scanRuleSources()
// reaches, now reads a finding with no line number as the whole file the
// same way whether it is null or undefined (score.mjs rules version 12,
// issue 153), moving this file's own hash even though nothing here changed.
export const SCAN_RULES_VERSION = 3;
// The one configuration of a scanner-only run.
export const SCAN_CONFIG = "scan";
// Finders a spec names that are the reviewer, never a candidate.
export const REVIEWER_FINDERS = ["reasoning", "graph"];
// OpenQodex's own candidates, by rule id, and the finder each counts as.
// Only a built-in scanner's candidate can be one (core finalize.ts
// isOwnCandidate): a custom scanner may name a rule anything.
export const OWN_RULES = { "openqodex.suppression-added": "suppression", "settings-file": "settings" };
export const SCAN_OUTCOME_ORDER = ["accepted", "hit", "near", "unresolved", "false"];
// How each outcome counts: a duplicate is set apart from precision and
// counted in redundancy.
export const SCAN_PRECISION = { correct: ["hit", "accepted"], wrong: ["false"], unresolved: ["near", "unresolved"], apart: ["duplicate"] };
// Statuses of a scanner that looked at the change.
export const LOOKED = ["ran", "no_matching_files"];
const FROZEN_OUTCOMES = new Set(["hit", "duplicate", "accepted", "false"]);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const plus = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });

// The scanner and the rule of a token, "<source>:<ruleId>", where a custom
// scanner's source is "custom:<name>".
function splitToken(token) {
  const t = String(token);
  const at = t.startsWith("custom:") ? t.indexOf(":", "custom:".length) : t.indexOf(":");
  return at === -1 ? { source: t, ruleId: "" } : { source: t.slice(0, at), ruleId: t.slice(at + 1) };
}

const finderName = (source, ruleId) => (!String(source).startsWith("custom:") && Object.hasOwn(OWN_RULES, ruleId) ? OWN_RULES[ruleId] : source);

// Every finder a candidate speaks for: its own, then each scanner whose
// finding dedup merged into it.
export function findersOf(c) {
  const merged = (c.alsoReportedBy ?? []).map((t) => splitToken(t)).map((t) => finderName(t.source, t.ruleId));
  return [...new Set([finderName(c.source, c.ruleId), ...merged])];
}

// The text the words are looked for in: the rule id, the message and every
// merged token, lower case.
function candidateText(c) {
  return [c.ruleId, c.message, ...(c.alsoReportedBy ?? [])].filter((x) => typeof x === "string").join("\n").toLowerCase();
}

function placesOf(item) {
  return [{ file: item.file, lines: item.lines }, ...(item.also ?? [])].map((l) => ({ file: normPath(l.file), lines: l.lines }));
}

// Lines between a candidate's span and a location's range: 0 when they overlap.
function linesApart(start, end, lines) {
  if (end < lines[0]) return lines[0] - end;
  if (start > lines[1]) return start - lines[1];
  return 0;
}

// The fewest lines between a candidate and a truth item, or null when the
// candidate is in none of the item's files.
function distanceTo(c, item) {
  const file = normPath(c.filePath);
  const start = c.lineStart;
  const end = Math.max(c.lineEnd ?? start, start);
  const ds = placesOf(item).filter((l) => l.file === file && Array.isArray(l.lines)).map((l) => linesApart(start, end, l.lines));
  return ds.length === 0 ? null : Math.min(...ds);
}

const expectedOf = (bug) => bug.found_by ?? bug.expectedFinder ?? [];

// The outcome of one candidate against a spec. Duplicates are decided per
// scan (scoreScanJob), since they depend on the candidates before.
export function classifyCandidate(c, spec) {
  if (spec.clean) return { outcome: "false" };
  const text = candidateText(c);
  const finders = findersOf(c);
  const extras = spec.extras ?? [];
  const at = extras.findIndex((x) => distanceTo(c, x) === 0 && names(x.mentions, text));
  if (at !== -1) return { outcome: "accepted", extra: at, evidence: "words" };
  const bugs = spec.bugs ?? [];
  const expected = (bug) => expectedOf(bug).some((f) => finders.includes(f));
  const said = (bug) => names(bug.mentions, text);
  const on = bugs.map((bug, order) => ({ bug, order, d: distanceTo(c, bug) }));
  const hits = on.filter(({ bug, d }) => d === 0 && (expected(bug) || said(bug)));
  if (hits.length > 0) {
    const file = normPath(c.filePath);
    const anchorGap = (bug) => (normPath(bug.file) === file && bug.anchor ? Math.abs(c.lineStart - bug.anchor.line) : 0);
    hits.sort((a, b) => anchorGap(a.bug) - anchorGap(b.bug) || a.order - b.order);
    const bug = hits[0].bug;
    return { outcome: "hit", bug: bug.id, evidence: expected(bug) ? "finder" : "words" };
  }
  const near = on.filter(({ bug, d }) => d !== null && d > 0 && d <= NEAR_LINES && (expected(bug) || said(bug))).sort((a, b) => a.d - b.d)[0];
  if (near) return { outcome: "near", bug: near.bug.id, distance: near.d };
  const located = on.find(({ d }) => d === 0);
  return located ? { outcome: "unresolved", bug: located.bug.id } : { outcome: "unresolved" };
}

// The identity of a candidate across runs: the case, its lines, its token
// and its whitespace-normalised message.
export function candidateIdOf(caseId, c) {
  const start = Number.isInteger(c.lineStart) ? c.lineStart : null;
  const end = start === null ? null : Math.max(c.lineEnd ?? start, start);
  return sha256(JSON.stringify([caseId, normPath(c.filePath), start, end, c.token, normText(c.message)]));
}

const treatment = (outcome) => (SCAN_PRECISION.correct.includes(outcome) ? "correct" : SCAN_PRECISION.wrong.includes(outcome) ? "wrong" : SCAN_PRECISION.apart.includes(outcome) ? "apart" : "unresolved");

// The issue a candidate raises: the truth item or side issue it finds, or
// itself.
function issueOf(c) {
  if (c.outcome === "hit" || (c.outcome === "duplicate" && c.extra === undefined)) return `truth:${c.bug}`;
  if (c.outcome === "accepted" || c.outcome === "duplicate") return `extra:${c.extra}`;
  return `candidate:${c.candidateId}`;
}

// One planned job of a scanner-only run, scored from its first attempt:
// `scan` is that attempt's scan.json (null when it wrote none), `row` its
// sample.json, and `started` false for a job with no attempt.
export function scoreScanJob({ job, spec, scan, row = {}, origin = "planted", started = true }) {
  const list = scan?.candidates ?? [];
  const candidates = list.map((c, index) => ({
    index,
    id: c.id ?? null,
    token: c.token ?? `${c.source}:${c.ruleId}`,
    finder: finderName(c.source, c.ruleId),
    finders: findersOf(c),
    file: normPath(c.filePath),
    line: c.lineStart,
    end: Math.max(c.lineEnd ?? c.lineStart, c.lineStart),
    severity: c.severity ?? null,
    candidateId: candidateIdOf(job.caseId, c),
    onBugs: (spec.bugs ?? []).filter((bug) => distanceTo(c, bug) === 0).map((bug) => bug.id),
    ...classifyCandidate(c, spec),
  }));
  // A later candidate on a bug or a side issue already found is a duplicate.
  const found = new Set();
  for (const c of candidates) {
    const key = c.outcome === "hit" ? `truth:${c.bug}` : c.outcome === "accepted" ? `extra:${c.extra}` : null;
    if (key === null) continue;
    if (found.has(key)) c.outcome = "duplicate";
    else found.add(key);
  }
  for (const c of candidates) {
    c.issue = issueOf(c);
    c.evidenceKind = FROZEN_OUTCOMES.has(c.outcome) ? "frozen" : c.outcome === "unresolved" && c.bug !== undefined ? "location-only" : null;
  }
  const status = !started ? "unstarted" : scan ? "complete" : "failed";
  const statuses = Object.fromEntries((scan?.scanners ?? []).map((s) => [s.scanner, s.status]));
  const bugs = (spec.bugs ?? []).map((bug) => {
    const mine = candidates.filter((c) => c.bug === bug.id && (c.outcome === "hit" || c.outcome === "duplicate"));
    // Each scanner the spec expects: located (a candidate it speaks for lies
    // on the bug), not run (it did not look at the change), or missed.
    const expected = {};
    for (const name of expectedOf(bug).filter((f) => !REVIEWER_FINDERS.includes(f))) {
      const located = candidates.some((c) => c.finders.includes(name) && c.onBugs.includes(bug.id));
      const looked = scan !== null && (statuses[name] === undefined ? Object.values(OWN_RULES).includes(name) : LOOKED.includes(statuses[name]));
      expected[name] = located ? "located" : looked ? "missed" : "not-run";
    }
    return { id: bug.id, severity: bug.severity ?? null, found: mine.length > 0, duplicates: Math.max(0, mine.length - 1), foundBy: [...new Set(mine.flatMap((c) => c.finders))].sort(), expected, reachable: Object.keys(expected).length > 0 };
  });
  const inPrecision = candidates.filter((c) => treatment(c.outcome) !== "apart");
  const counted = (list) => ({ correct: list.filter((x) => x === "correct").length, unresolved: list.filter((x) => x === "unresolved").length, of: list.length });
  const issues = new Map();
  for (const c of inPrecision) if (!issues.has(c.issue)) issues.set(c.issue, treatment(c.outcome));
  const recall = { hit: bugs.filter((b) => b.found).length, of: bugs.length };
  const major = bugs.filter((b) => b.severity === "critical" || b.severity === "major");
  const reachable = bugs.filter((b) => b.reachable);
  return {
    jobId: job.jobId,
    caseId: job.caseId,
    case: job.case ?? spec.id,
    config: job.config,
    repeat: job.repeat,
    origin,
    clean: spec.clean === true,
    status,
    bugs,
    candidates,
    controls: spec.clean ? { hit: status === "complete" && candidates.length === 0 ? 1 : 0, of: 1 } : ratio(),
    issueRecall: { all: recall, criticalMajor: { hit: major.filter((b) => b.found).length, of: major.length } },
    scannerRecall: { hit: reachable.filter((b) => b.found).length, of: reachable.length },
    precision: counted(inPrecision.map((c) => treatment(c.outcome))),
    issues: counted([...issues.values()]),
    redundancy: { hit: candidates.length - issues.size, of: candidates.length },
    location: lineMatches(candidates, spec.bugs ?? [], AACR_LINE_K),
    statuses,
    wallMs: row.wallMs ?? null,
    scanMs: row.timings?.scan_ms ?? null,
  };
}

// Per finder over scored jobs: its candidates by outcome, and the bugs it
// was expected to find, located over looked at, with the samples where it
// did not run counted apart.
function perScannerOf(jobs) {
  const out = {};
  const row = (name) => (out[name] ??= { candidates: 0, hits: 0, duplicates: 0, accepted: 0, unresolved: 0, false: 0, expected: ratio(), notRun: 0 });
  const bucket = { hit: "hits", duplicate: "duplicates", accepted: "accepted", near: "unresolved", unresolved: "unresolved", false: "false" };
  for (const j of jobs) {
    for (const c of j.candidates) {
      const r = row(c.finder);
      r.candidates++;
      r[bucket[c.outcome]]++;
    }
    for (const b of j.bugs) {
      for (const [name, how] of Object.entries(b.expected)) {
        const r = row(name);
        if (how === "not-run") r.notRun++;
        else r.expected = plus(r.expected, { hit: how === "located" ? 1 : 0, of: 1 });
      }
    }
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

// Sums scored scan jobs as ratios of sums, in the shape of score format 3's
// configuration block, plus the scanner-only numbers. `retries` counts the
// attempts after a first one, which a scanner-only run never makes.
export function summarizeScanJobs(jobs, retries = 0) {
  const count = (status) => jobs.filter((j) => j.status === status).length;
  const total = (f) => jobs.reduce((a, j) => plus(a, f(j)), ratio());
  const sum = (list, f) => list.reduce((a, j) => a + f(j), 0);
  const correct = sum(jobs, (j) => j.precision.correct);
  const unresolved = sum(jobs, (j) => j.precision.unresolved);
  const counted = sum(jobs, (j) => j.precision.of);
  const issuesCorrect = sum(jobs, (j) => j.issues.correct);
  const issuesUnresolved = sum(jobs, (j) => j.issues.unresolved);
  const distinct = sum(jobs, (j) => j.issues.of);
  const candidates = sum(jobs, (j) => j.candidates.length);
  const recall = total((j) => j.issueRecall.all);
  const lower = { hit: correct, of: counted };
  const p = value(lower);
  const r = value(recall);
  const matches = sum(jobs, (j) => j.location.matches);
  const generated = sum(jobs, (j) => j.location.generated);
  const expected = sum(jobs, (j) => j.location.expected);
  const clean = jobs.filter((j) => j.clean);
  const outcomes = {};
  for (const o of [...SCAN_OUTCOME_ORDER, "duplicate"]) {
    const n = sum(jobs, (j) => j.candidates.filter((c) => c.outcome === o).length);
    if (n > 0) outcomes[o] = n;
  }
  const notRun = {};
  for (const j of jobs) for (const [scanner, status] of Object.entries(j.statuses)) if (!LOOKED.includes(status)) notRun[scanner] = (notRun[scanner] ?? 0) + 1;
  return {
    population: { planned: jobs.length, complete: count("complete"), incomplete: 0, failed: count("failed"), unstarted: count("unstarted"), retries, retryCostUsd: 0 },
    issueRecall: { all: recall, criticalMajor: total((j) => j.issueRecall.criticalMajor) },
    scannerRecall: total((j) => j.scannerRecall),
    precision: { lower, upper: { hit: correct + unresolved, of: counted }, unresolved },
    uniqueIssuePrecision: { lower: { hit: issuesCorrect, of: distinct }, upper: { hit: issuesCorrect + issuesUnresolved, of: distinct } },
    redundancy: { hit: candidates - distinct, of: candidates },
    f1: p + r === 0 ? 0 : (2 * p * r) / (p + r),
    cleanFindingsPerCase: { findings: sum(clean, (j) => j.candidates.length), cases: clean.length },
    controls: total((j) => j.controls),
    location: { label: LOCATION_LABEL, precision: { hit: matches, of: generated }, recall: { hit: matches, of: expected }, matches, generated, expected, knownNoise: sum(jobs, (j) => j.location.knownNoise) },
    plantedLegacy: null,
    outcomes,
    candidates,
    perScanner: perScannerOf(jobs),
    scannersNotRun: Object.fromEntries(Object.keys(notRun).sort().map((k) => [k, notRun[k]])),
    wallMs: stats(jobs.map((j) => j.wallMs)),
    scanMs: stats(jobs.map((j) => j.scanMs)),
    costUsd: stats([]),
  };
}

// A scanner-only run's saved attempts scored: the population from the
// manifest, each planned job by its first attempt's scan.json, the sums per
// configuration, case and bug, and one outcome line per candidate.
// `attempts` are { case, config, repeat, attempt, row, scan }, and `specs`
// the specs by case name. The same top-level shape as lib/score.mjs
// scoreAttempts, so score.mjs, the index and the trend read either.
export function scoreScanAttempts({ manifest, attempts, specs }) {
  const suite = manifest.suite ?? "planted";
  const origin = originOf(suite);
  if (origin === null) throw new Error(`the run names the suite ${suite}, which the scorer does not know`);
  const pop = population(manifest, attempts);
  if (pop.problems.length > 0) throw new Error(`the run's samples do not match its plan:\n${pop.problems.join("\n")}`);
  const jobs = pop.jobs.map((j) => scoreScanJob({ job: j, spec: specs[j.case], scan: j.first?.scan ?? null, row: j.first?.row ?? {}, origin, started: j.first !== null }));
  const configs = [...new Set(jobs.map((j) => j.config))].sort();
  const byConfig = {};
  for (const config of configs) byConfig[config] = summarizeScanJobs(jobs.filter((j) => j.config === config), pop.retries.filter((a) => a.config === config).length);
  const perCase = {};
  const perBug = {};
  for (const j of jobs) {
    perCase[j.config] ??= {};
    const c = (perCase[j.config][j.caseId] ??= { issueRecall: ratio(), precision: { lower: ratio(), upper: ratio() }, findings: 0 });
    c.issueRecall = plus(c.issueRecall, j.issueRecall.all);
    c.precision.lower = plus(c.precision.lower, { hit: j.precision.correct, of: j.precision.of });
    c.precision.upper = plus(c.precision.upper, { hit: j.precision.correct + j.precision.unresolved, of: j.precision.of });
    c.findings += j.candidates.length;
    perBug[j.config] ??= {};
    const bugs = (perBug[j.config][j.caseId] ??= {});
    for (const b of j.bugs) {
      const x = (bugs[b.id] ??= { found: [], severity: b.severity, cause: null });
      x.found[j.repeat - 1] = b.found;
    }
  }
  const outcomes = jobs.flatMap((j) =>
    j.candidates.map((c) => ({ jobId: j.jobId, caseId: j.caseId, config: j.config, repeat: j.repeat, index: c.id ?? c.index, candidateId: c.candidateId, token: c.token, finder: c.finder, outcome: c.outcome, truthId: c.bug ?? null, extra: c.extra ?? null, evidence: c.evidence ?? null, evidenceKind: c.evidenceKind, distance: c.distance ?? null, severity: c.severity })),
  );
  return {
    suite,
    jobs,
    caseIds: [...new Set(jobs.map((j) => j.caseId))].sort(),
    population: { ...summarizeScanJobs(jobs, pop.retries.length).population, jobsFrom: pop.from, unplanned: pop.unplanned.map((a) => `${a.case}/${a.config}/${a.repeat}`) },
    byConfig,
    perCase,
    perBug,
    briefFailures: {},
    outcomes,
  };
}

// Bugs an earlier scanner-only run found that a later one does not, per
// configuration and case: scanner-only scores are deterministic, so one
// lost bug is a regression.
export function scanRegressions(olderJobs, newerJobs) {
  const key = (j, b) => `${j.config}\0${j.caseId}\0${j.repeat}\0${b.id}`;
  const before = new Map(olderJobs.flatMap((j) => j.bugs.map((b) => [key(j, b), b.found])));
  const out = [];
  for (const j of newerJobs) for (const b of j.bugs) if (before.get(key(j, b)) === true && !b.found) out.push({ config: j.config, case: j.caseId, bug: b.id, before: "found", after: "missed" });
  return out;
}

// The scan rules block. Its hash covers each constant and list, and the
// text of every top-level declaration the scoring reaches from
// scoreScanAttempts, transitively, in this file and in the modules beside
// it that this file imports from (the population, the word rule and the
// location rule in score.mjs, the case id parser in cases.mjs), read with
// score.mjs topLevel. Formatting counts: a change of layout alone moves the
// hash and needs a version bump.
const SCAN_ROOTS = ["scoreScanAttempts"];
const NOT_SCAN_RULES = new Set(["SCAN_RULES", "SCAN_RULES_BLOCK", "SCAN_ROOTS", "NOT_SCAN_RULES", "scanRuleSources", "scanRuleCodeHash", "readHere", "rulesHash", "topLevel", "scanRegressions"]);
const readHere = (file) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

// Every declaration the scan score depends on, as { id: "<file>#<name>",
// text }, sorted by id. `read(file)` gives the source of a module of this
// folder.
export function scanRuleSources(read = readHere) {
  const modules = new Map();
  const mod = (file) => {
    if (!modules.has(file)) modules.set(file, topLevel(read(file)));
    return modules.get(file);
  };
  const seen = new Map();
  const visit = (file, name) => {
    if (NOT_SCAN_RULES.has(name)) return;
    const m = mod(file);
    const text = m.decls.get(name);
    if (text === undefined) {
      if (m.imports.has(name)) visit(m.imports.get(name), name);
      return;
    }
    const id = `${file}#${name}`;
    if (seen.has(id)) return;
    seen.set(id, text);
    for (const token of new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])) if (token !== name && (m.decls.has(token) || m.imports.has(token))) visit(file, token);
  };
  for (const root of SCAN_ROOTS) visit("scan-score.mjs", root);
  return [...seen].map(([id, text]) => ({ id, text })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const scanRuleCodeHash = (read = readHere) => sha256(scanRuleSources(read).map(({ id, text }) => `${id}\n${text.replace(/\s+/g, " ").trim()}`).join("\n"));

const SCAN_RULES_BLOCK = {
  version: SCAN_RULES_VERSION,
  kind: "scan",
  nearLines: NEAR_LINES,
  lineK: AACR_LINE_K,
  candidates: "Every candidate in each first attempt's scan.json, in its order; no reviewer runs.",
  overlap: "A candidate's lines are [lineStart, max(lineEnd, lineStart)]. On a truth item means a gap of 0 to one of its locations (its file and lines, or an entry of also), paths normalised.",
  hit: "On a bug's lines, and either the bug's found_by names one of the candidate's finders (its scanner, a scanner in alsoReportedBy, or the own rule it is), or its rule id, message and merged tokens name one of the bug's mentions by the word rule. When it is a hit for two bugs, the one whose anchor line is nearest wins, then the first.",
  words: { rule: "A mention matches case-insensitively, without stemming, at the start of the text or after a character that is not a letter or digit.", fields: ["ruleId", "message", "alsoReportedBy"] },
  reviewerFinders: REVIEWER_FINDERS,
  own: OWN_RULES,
  order: SCAN_OUTCOME_ORDER,
  precision: SCAN_PRECISION,
  population: "Every planned job's first attempt. A job with no attempt is unstarted, one with no scan.json failed; either misses every truth item of its case and adds no candidate.",
  issues: "Candidates that find one truth item are one issue, and so are candidates on one accepted side issue; the first is counted in precision and each later one is a duplicate, counted in redundancy only. Any other candidate is its own issue.",
  code: scanRuleCodeHash(),
};
export const SCAN_RULES = Object.freeze({ ...SCAN_RULES_BLOCK, hash: rulesHash(SCAN_RULES_BLOCK) });
