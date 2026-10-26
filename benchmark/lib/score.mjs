// Scores saved reviews against the planted bugs of their case specs.
// Nothing here starts a reviewer or reads anything but saved files.
//
// The vocabulary is the graph corpus's (packages/graph/corpus/score.ts): a
// score is a Ratio { hit, of }, `value` reads no checks as 1, and the names
// are the same where the meaning is the same: precision, recall, gaps,
// controls, failures.
//
// A finding matches a planted bug only when three things hold: its place
// (same file, line ranges that overlap), its kind (a category the bug lists)
// and its words (the finding's text names one of the bug's `mentions` at the
// start of a word; case does not matter). Every plant and every accepted side
// issue lists `mentions`; one without them can never be matched. The checks
// run in this order, and the first that holds decides:
//   1. test-only   a finding of kind maintainability or style whose title
//                  asks for a test ("has no covering test", "lacks tests",
//                  "untested"). On a planted case it is true and not
//                  planted (the planted cases ship no tests by design), so it
//                  is counted apart, as test-gap, and left out of precision.
//                  On a clean case, which ships its tests, it is false.
//   2. accepted    a side issue the spec lists in `extras` (real, not
//                  planted), matched by place and words (and kind, when the
//                  extra lists kinds): left out of precision
//   3. hit         a planted bug, matched by place, kind and words. A second
//                  hit on a bug already hit in the same review is a
//                  duplicate: reported apart, never counted in precision.
//   4. near        a hit in every way but the lines: within NEAR_LINES lines
//      wrong-kind  of the range, not on it; or a hit in every way but the
//                  kind. Neither is a hit; both count against precision.
//   5. false       anything else; on a clean case every finding is false.
// A bug's `also` locations count as its own. When a finding is a hit for two
// bugs, the bug whose anchor line is nearest wins, then the first.
//
// Failure list, written before the code:
// 1. A finding one line off counts as found, or silently as false: it is a
//    near miss, listed with its distance, and not a hit.
// 2. A finding on the right line about something else counts as found: it
//    must name the issue (its words) and be of a planted kind; a wrong kind
//    is a wrong-kind, other words are false.
// 3. One finding is counted for two bugs whose ranges overlap: each finding
//    goes to one bug at most, by the order above.
// 4. Two findings for one bug count as two bugs found, or raise precision:
//    recall counts bugs; the second finding is a duplicate, left out of
//    precision and reported apart.
// 5. A real issue the spec did not plant counts as false although the spec
//    lists it: extras are matched first and left out of precision.
// 6. A request for a test is scored as a wrong kind or a near miss of the
//    plant whose lines it spans: requests for tests are checked first.
// 7. A clean case scores well because it has nothing to miss: every finding
//    there is false, and its control passes only when the review completed
//    with no finding; an incomplete or missing review fails it.
// 8. A missing or incomplete report is left out, so a crash looks perfect:
//    a missing report misses every bug and is counted as failed; an
//    incomplete one is scored on what it holds and counted as incomplete.
// 9. Gap disclosure is read from data the reviewer never saw: it is read
//    from the saved brief, the text the reviewer was given.
// 10. A run with the graph off gets credit for gaps its brief never named:
//    gaps are counted from the brief's text only, so graph off scores 0.
// 11. A spec edited after a run changes that run's score: the scorer takes
//    the specs the run copied into its own folder, unless told otherwise,
//    and then says so.
// 12. Paths written differently (./a.py, a\b.py) do not match: both sides
//    are normalised.
// 13. Averages of averages over different sample counts mislead: ratios are
//    summed hits over summed checks; times and costs carry their count.
// 14. Two runs with different models, reviewers, machines or settings read
//    as a product change: the comparison names every such difference above
//    its table.
// Score format 3 adds its own failure list, below the format 2 code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCaseId } from "./cases.mjs";
import { bugRuling, issueOf, matchRuling, realRuling, resolveRulings, sameIssueAs, specHashOf } from "./rulings.mjs";

export const NEAR_LINES = 3;
export const SEVERITY_ORDER = ["critical", "major", "minor", "nitpick", "info"];

export const ratio = () => ({ hit: 0, of: 0 });
export const value = (r) => (r.of === 0 ? 1 : r.hit / r.of);
const add = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });

export const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findingText(f) {
  return [f.title, f.problem, f.consequence, f.fix, f.description, f.suggested_change].filter((x) => typeof x === "string").join("\n").toLowerCase();
}

function locations(bug) {
  return [{ file: bug.file, lines: bug.lines }, ...(bug.also ?? [])].map((l) => ({ file: normPath(l.file), lines: l.lines }));
}

// Lines between a finding's range and a location's range: 0 when they overlap.
function gap(start, end, lines) {
  if (end < lines[0]) return lines[0] - end;
  if (start > lines[1]) return start - lines[1];
  return 0;
}

// Whether the text names one of the words, each at the start of a word.
// No words, no match: a plant without its words can never be found.
export function names(words, text) {
  if (!Array.isArray(words) || words.length === 0) return false;
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${escape(w.toLowerCase())}`).test(text));
}

// A title that asks for a test, and the kinds such a request comes in.
export const TEST_ONLY = /\b(no|missing|lacks?|lacking|without|needs?|add)\b[^.]{0,60}\btests?\b|\buntested\b|\btest coverage\b|\bnot covered by (any |a )?tests?\b/i;
export const TEST_ONLY_KINDS = ["maintainability", "style"];

// The outcome of one finding against a spec. Duplicates are decided per
// review (scoreSample), since they depend on the other findings. The
// test-only rule holds for planted cases, which ship no tests by design;
// `testOnly: false` (a real pull request) skips it.
export function classify(finding, spec, { testOnly = true } = {}) {
  const file = normPath(finding.file_path);
  const start = finding.line_number;
  const end = Math.max(finding.line_end ?? start, start);
  const text = findingText(finding);
  const bugs = spec.bugs ?? [];

  if (testOnly && TEST_ONLY_KINDS.includes(finding.category) && TEST_ONLY.test(String(finding.title ?? ""))) {
    return spec.clean ? { outcome: "false", testOnly: true } : { outcome: "test-gap" };
  }

  const extras = spec.extras ?? [];
  const at = extras.findIndex((x) => normPath(x.file) === file && gap(start, end, x.lines) === 0 && names(x.mentions, text) && (!x.kind || x.kind.includes(finding.category)));
  if (at !== -1) return { outcome: "accepted", why: extras[at].why, extra: at };

  const dist = (bug) => {
    const ds = locations(bug).filter((l) => l.file === file).map((l) => gap(start, end, l.lines));
    return ds.length === 0 ? null : Math.min(...ds);
  };
  const kindOk = (bug) => kindsOf(bug).includes(finding.category);
  const said = (bug) => names(bug.mentions, text);
  const hits = bugs
    .map((bug, order) => ({ bug, order, d: dist(bug) }))
    .filter(({ bug, d }) => d === 0 && kindOk(bug) && said(bug));
  if (hits.length > 0) {
    const anchorGap = (bug) => (normPath(bug.file) === file ? Math.abs(start - bug.anchor.line) : 0);
    hits.sort((a, b) => anchorGap(a.bug) - anchorGap(b.bug) || a.order - b.order);
    return { outcome: "hit", bug: hits[0].bug.id };
  }

  const near = bugs
    .map((bug) => ({ bug, d: dist(bug) }))
    .filter(({ bug, d }) => d !== null && d > 0 && d <= NEAR_LINES && kindOk(bug) && said(bug))
    .sort((a, b) => a.d - b.d)[0];
  const wrong = bugs.find((bug) => dist(bug) === 0 && said(bug) && !kindOk(bug));
  if (wrong) return { outcome: "wrong-kind", bug: wrong.id, expected: kindsOf(wrong) };
  if (near) return { outcome: "near", bug: near.bug.id, distance: near.d };
  return { outcome: "false" };
}

// The kinds a truth item lists: a planted bug's kind, or the categories a
// pull request comment names (lib/suites.mjs), which has no kind.
const kindsOf = (bug) => bug.kind ?? bug.categories ?? [];

// Outcomes left out of precision.
const UNCOUNTED = new Set(["accepted", "test-gap", "duplicate"]);


// The part of the brief the code graph wrote, or null when the graph did
// not run (its block then starts with a line saying so).
export function graphBlock(brief) {
  if (typeof brief !== "string") return null;
  const at = brief.indexOf("## What this change reaches");
  if (at === -1) return null;
  const next = brief.indexOf("\n## ", at + 5);
  const block = brief.slice(at, next === -1 ? undefined : next);
  return /The code graph (is off|was skipped|could not be built)/.test(block) ? null : block;
}

// What the brief told the reviewer: each expected gap site with its cause,
// each expected floor, each expected caller site.
export function scoreBrief(spec, brief) {
  const g = spec.graph ?? {};
  const block = graphBlock(brief);
  const gaps = ratio();
  const callers = ratio();
  const failures = [];
  const unseen = block === null ? "" : (block.split("What the graph could not see:")[1] ?? "");
  for (const u of g.gaps ?? []) {
    gaps.of++;
    const re = new RegExp(`^\\s*- ${escape(`${u.file}:${u.line}`)}\\b.*: ${escape(u.cause)}\\b`, "m");
    if (re.test(unseen)) gaps.hit++;
    else failures.push(`the brief does not name the ${u.cause} call at ${u.file}:${u.line} as unseen`);
  }
  for (const f of g.floors ?? []) {
    gaps.of++;
    const name = f.slice(f.indexOf("#") + 1);
    if (unseen.includes(`The callers of \`${name}\` are a floor`)) gaps.hit++;
    else failures.push(`the brief does not say the callers of ${name} are a floor`);
  }
  for (const site of g.callers ?? []) {
    callers.of++;
    if (block !== null && new RegExp(`^- ${escape(site)} `, "m").test(block)) callers.hit++;
    else failures.push(`the brief does not list the caller at ${site}`);
  }
  return { graph: block === null ? "off" : "on", gaps, callers, failures };
}

// Every finding the developer is shown: on the change, outside it (except
// scanner information), and the observations of a staged review (shown
// apart, never counted toward the verdict, judged here all the same because
// the developer reads them). Each carries `tier`: "finding" or "observation".
export function shownFindings(report) {
  if (!report) return [];
  return [
    ...(report.findings ?? []).map((f) => ({ ...f, tier: "finding" })),
    ...(report.outside_change ?? []).filter((f) => f.origin !== "scanner").map((f) => ({ ...f, tier: "finding" })),
    ...(report.observations ?? []).map((f) => ({ ...f, tier: "observation" })),
  ];
}

// One saved review of one case: `report` is report.json (null when the run
// wrote none), `brief` is brief.md (null when absent), `row` is run.mjs's
// record of the run (time, exit code).
export function scoreSample({ spec, report, brief, row = {}, testOnly = true }) {
  const findings = shownFindings(report).map((f) => ({
    file: normPath(f.file_path),
    line: f.line_number,
    end: f.line_end ?? f.line_number,
    category: f.category,
    severity: f.severity,
    origin: f.origin,
    raised: f.candidate ?? null,
    source: f.source ?? null,
    tier: f.tier ?? "finding",
    title: f.title,
    ...classify(f, spec, { testOnly }),
  }));
  // A second hit on a bug already hit in this review is a duplicate.
  const hitBugs = new Set();
  for (const f of findings) {
    if (f.outcome !== "hit") continue;
    if (hitBugs.has(f.bug)) f.outcome = "duplicate";
    else hitBugs.add(f.bug);
  }
  const status = report === null ? "failed" : report.completion?.status === "complete" ? "complete" : "incomplete";
  const recall = ratio();
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, ratio()]));
  const bugs = (spec.bugs ?? []).map((bug) => {
    const mine = findings.filter((f) => f.bug === bug.id);
    const hits = mine.filter((f) => f.outcome === "hit" || f.outcome === "duplicate");
    const found = hits.length > 0;
    // A truth item with no severity on the scale (a pull request comment
    // has none) counts in recall and in no severity's tally.
    const tally = Object.hasOwn(bySeverity, bug.severity) ? bySeverity[bug.severity] : null;
    recall.of++;
    if (tally) tally.of++;
    if (found) {
      recall.hit++;
      if (tally) tally.hit++;
    }
    const dropped = (report?.dropped ?? []).filter((d) => {
      const c = d.candidate ?? {};
      return locations(bug).some((l) => l.file === normPath(c.filePath) && gap(c.lineStart, Math.max(c.lineEnd ?? c.lineStart, c.lineStart), l.lines) === 0);
    });
    return {
      id: bug.id,
      severity: bug.severity,
      found,
      duplicates: mine.filter((f) => f.outcome === "duplicate").length,
      // The severity the reviewer gave the first finding that found it.
      given: found ? hits[0].severity : null,
      // Raised from a scanner candidate, or the reviewer's own.
      via: found ? (hits.some((h) => h.raised !== null) ? "scanner" : "reviewer") : null,
      near: mine.filter((f) => f.outcome === "near").map((f) => f.distance),
      wrongKind: mine.filter((f) => f.outcome === "wrong-kind").map((f) => f.category),
      // Scanner candidates on this bug that the reviewer dropped.
      droppedCandidates: dropped.map((d) => d.candidate?.token ?? "unknown"),
    };
  });
  const precision = ratio();
  for (const f of findings) {
    if (UNCOUNTED.has(f.outcome)) continue;
    precision.of++;
    if (f.outcome === "hit") precision.hit++;
  }
  const counted = findings.filter((f) => !UNCOUNTED.has(f.outcome)).length;
  // A clean change passes only a review that completed with no finding.
  const controls = spec.clean ? { hit: status === "complete" && counted === 0 ? 1 : 0, of: 1 } : ratio();
  const brief_ = scoreBrief(spec, brief);
  // What the review used. A laptop reviewer's completion record holds it. A
  // model review's record holds none: its sample record (lib/server-review.mjs)
  // holds the library's totals over every model call, and the models the
  // provider named as answering them.
  const server = row.path === "server";
  const usage = report?.completion?.reviewer?.usage ?? (server ? row.usage : null) ?? null;
  return {
    case: spec.id,
    config: row.config ?? null,
    repeat: row.repeat ?? null,
    attempt: row.attempt ?? 1,
    status,
    verdict: report?.verdict ?? null,
    exit: row.exit ?? null,
    graph: report?.impact?.status ?? null,
    brief: brief_.graph,
    bugs,
    findings,
    recall,
    bySeverity,
    precision,
    falseFindings: findings.filter((f) => f.outcome === "false").length,
    nearMisses: findings.filter((f) => f.outcome === "near").length,
    wrongKinds: findings.filter((f) => f.outcome === "wrong-kind").length,
    accepted: findings.filter((f) => f.outcome === "accepted").length,
    duplicates: findings.filter((f) => f.outcome === "duplicate").length,
    testGaps: findings.filter((f) => f.outcome === "test-gap").length,
    controls,
    gaps: brief_.gaps,
    callers: brief_.callers,
    failures: brief_.failures,
    wallMs: row.wallMs ?? null,
    reviewerMs: report?.completion?.reviewer?.duration_ms ?? null,
    graphMs: report?.impact?.build?.durationMs ?? null,
    turns: usage?.turns ?? null,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    costUsd: usage?.cost_usd ?? null,
    // Null for a laptop review, whose record names no served model.
    servedModels: server ? (Array.isArray(row.servedModels) ? row.servedModels : []) : null,
    rounds: report?.completion?.reviewer?.rounds ?? null,
  };
}

const nums = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x));
export function stats(xs) {
  const v = nums(xs).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, mean: null, median: null, total: null };
  const total = v.reduce((a, b) => a + b, 0);
  const mid = Math.floor(v.length / 2);
  return { n: v.length, mean: total / v.length, median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, total };
}

// Sums a set of sample scores: ratios as hits over checks, times and money
// as means and medians with their count.
export function summarize(samples) {
  const out = {
    samples: samples.length,
    complete: samples.filter((s) => s.status === "complete").length,
    incomplete: samples.filter((s) => s.status === "incomplete").length,
    failed: samples.filter((s) => s.status === "failed").length,
    recall: ratio(),
    bySeverity: Object.fromEntries(SEVERITY_ORDER.map((s) => [s, ratio()])),
    precision: ratio(),
    controls: ratio(),
    gaps: ratio(),
    callers: ratio(),
    falseFindings: 0,
    nearMisses: 0,
    wrongKinds: 0,
    accepted: 0,
    duplicates: 0,
    testGaps: 0,
    wallMs: stats(samples.map((s) => s.wallMs)),
    reviewerMs: stats(samples.map((s) => s.reviewerMs)),
    costUsd: stats(samples.map((s) => s.costUsd)),
    turns: stats(samples.map((s) => s.turns)),
    inputTokens: stats(samples.map((s) => s.inputTokens)),
    outputTokens: stats(samples.map((s) => s.outputTokens)),
  };
  for (const s of samples) {
    out.recall = add(out.recall, s.recall);
    for (const k of SEVERITY_ORDER) out.bySeverity[k] = add(out.bySeverity[k], s.bySeverity[k]);
    out.precision = add(out.precision, s.precision);
    out.controls = add(out.controls, s.controls);
    out.gaps = add(out.gaps, s.gaps);
    out.callers = add(out.callers, s.callers);
    out.falseFindings += s.falseFindings;
    out.nearMisses += s.nearMisses;
    out.wrongKinds += s.wrongKinds;
    out.accepted += s.accepted;
    out.duplicates += s.duplicates;
    out.testGaps += s.testGaps;
  }
  return out;
}

// Per bug across repeats: in how many samples of a config it was found.
export function bugStability(samples) {
  const out = {};
  for (const s of samples) {
    for (const b of s.bugs) {
      const key = `${s.case}/${b.id}`;
      out[key] ??= { case: s.case, bug: b.id, severity: b.severity, found: 0, of: 0, via: {}, near: 0, wrongKind: 0, dropped: 0 };
      const x = out[key];
      x.of++;
      if (b.found) {
        x.found++;
        x.via[b.via] = (x.via[b.via] ?? 0) + 1;
      }
      if (b.near.length > 0) x.near++;
      if (b.wrongKind.length > 0) x.wrongKind++;
      if (b.droppedCandidates.length > 0) x.dropped++;
    }
  }
  return Object.values(out);
}

// Groups sample scores by a key function.
export function groupBy(samples, key) {
  const out = new Map();
  for (const s of samples) {
    const k = key(s);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(s);
  }
  return out;
}

// What differs between two runs other than the build: printed above any
// comparison so a model change is not read as a product change.
export function runDifferences(a, b) {
  const out = [];
  const same = (label, x, y) => {
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) out.push(`${label}: ${JSON.stringify(x ?? null)} then ${JSON.stringify(y ?? null)}`);
  };
  // Every reviewer with its version and model, the machine and the review settings.
  const reviewers = (m) => m.reviewers ?? (m.reviewer ? { [m.reviewer.name]: m.reviewer } : null);
  same("reviewers (name, version, model)", reviewers(a), reviewers(b));
  same("machine", a.machine, b.machine);
  same("concurrency", a.concurrency, b.concurrency);
  same("reviewer web access", a.review?.web, b.review?.web);
  same("review timeout in seconds", a.review?.timeoutSeconds, b.review?.timeoutSeconds);
  same("cases", [...(a.cases ?? [])].sort(), [...(b.cases ?? [])].sort());
  same("repeats", a.repeat, b.repeat);
  same("configurations", a.configs, b.configs);
  // An edited case: compared where both runs recorded what the case was built from.
  for (const [id, hash] of Object.entries(a.caseHashes ?? {})) {
    const other = b.caseHashes?.[id];
    if (other !== undefined && other !== hash) out.push(`the case ${id} changed between the runs (its files or its spec)`);
  }
  return out;
}

// Cases whose spec differs between two runs' own copies: the same review
// can score differently under them.
export function specDifferences(aSpecs, bSpecs) {
  return Object.keys(aSpecs)
    .filter((id) => bSpecs[id] !== undefined && JSON.stringify(aSpecs[id]) !== JSON.stringify(bSpecs[id]))
    .map((id) => `the spec of ${id} differs between the runs`);
}

// Bugs a config found in at least two samples of the old run and in at most
// one sample of the new: a regression by the repo's rule (one red sample is
// a reason to look; two in a row is a bug).
export function regressions(oldSamples, newSamples) {
  const index = (samples) => new Map(bugStability(samples).map((b) => [`${b.case}/${b.bug}`, b]));
  const out = [];
  for (const [config, olds] of groupBy(oldSamples, (s) => s.config)) {
    const news = newSamples.filter((s) => s.config === config);
    if (news.length === 0) continue;
    const before = index(olds);
    const after = index(news);
    for (const [key, b] of before) {
      const a = after.get(key);
      if (!a) continue;
      const missedBefore = b.of - b.found;
      const missedAfter = a.of - a.found;
      if (missedAfter >= 2 && missedAfter > missedBefore) out.push({ config, case: b.case, bug: b.bug, before: `${b.found}/${b.of}`, after: `${a.found}/${a.of}` });
    }
    const cleanBefore = olds.filter((s) => s.controls.of > 0 && s.controls.hit === 0).length;
    const cleanAfter = news.filter((s) => s.controls.of > 0 && s.controls.hit === 0).length;
    if (cleanAfter >= 2 && cleanAfter > cleanBefore) out.push({ config, case: "clean controls", bug: "a finding on a clean change", before: `${cleanBefore} samples`, after: `${cleanAfter} samples` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Score format 3: the population of planned first attempts, issue-level
// precision as bounds, unique-issue precision and redundancy, the location
// and planted-rule blocks kept apart and labelled, and the rules block. The
// format 2 functions above stay as they are: format 3 is built on them, and
// format 2 numbers (every saved attempt) are still computed beside it.
//
// Failure list, written before the code:
// 15. A planned review that never started, or failed, leaves the
//     denominator, so a crash looks like a better run: the population is
//     every planned job's first attempt, from the manifest's `jobs` (or, for
//     a run made before that list, from its cases, configurations and
//     repeats); a job with no attempt is unstarted, and an unstarted or
//     failed job misses every truth item of its case and adds no finding.
// 16. A retry that succeeded replaces the failure before it, so a rerun
//     picks the better result: a retry never enters the population; retries
//     are counted apart with their cost.
// 17. An unlisted finding counts as false, so a true issue nobody planted
//     lowers precision for good, or as true, so noise raises it: nothing
//     frozen rules on it, so it is unresolved, and precision is a pair of
//     bounds (unresolved counted wrong, then right) until a person rules.
//     A finding on a clean case is false, since the case is clean by spec,
//     even one a side issue listed on that spec matches, and the clean
//     control fails on any shown finding.
// 18. Two findings on one issue raise precision: precision counts every
//     displayed finding, unique-issue precision counts each issue once, and
//     redundancy is the share of displayed findings beyond one per issue.
// 19. Today's planted precision, with test requests set apart, is pooled
//     with real-suite numbers: it is kept in its own labelled block, over
//     planted cases only, with the planted cases' requests for a test
//     counted there and kept out of both bounds; on a real suite a request
//     for a test is an unlisted finding and widens the bounds like any other.
// 20. A line match is read as finding the issue: the location block (AACR's
//     line rule) is labelled a diagnostic and never decides anything.
// 21. A rule changes and old and new scores are compared as equal: every
//     constant, list and the matching code are in a hashed rules block that
//     each score carries, a test pins the hash to RULES_VERSION, and
//     rulesDifferences() names any difference between two scores.
// Rules version 4 adds severity agreement and the finder of each found
// truth item. Failure list, written before the code:
// 22. A found bug rated two steps low counts as the right severity: each hit
//     compares the severity it gave with its truth item's on the ordinal
//     scale SEVERITY_ORDER, as exact, one-off or off (two steps or more),
//     over-rated or under-rated, and the score keeps the full matrix.
// 23. A second finding on a found bug changes its severity: the first hit in
//     report order decides, and a duplicate is never judged.
// 24. A bug the spec expects from a scanner, found only by the reviewer,
//     counts as a scanner find: the finder is judged from the attempt's own
//     scan.json, by location, and never from the spec's found_by alone,
//     which is the expectation the finder is compared with.
// 25. A scanner the spec does not expect is credited with a bug whose wide
//     range holds its finding about another issue: such a finding locates
//     the bug only when its words name the bug's mentions (rule S1 of the
//     scanner-only mode); the expected scanner's finding needs only its place.
// 26. Dedup hides a scanner's work: a finding merged into another candidate
//     (a merged trail entry, or a token in a candidate's alsoReportedBy)
//     counts for its own scanner. And the reverse: a finding merged into a
//     candidate that never reached the reviewer counts as a find; a merged
//     entry counts only when the candidate it went into is kept and on the
//     item's lines, or raised by a shown finding.
// 27. OpenQodex's own candidate about an added suppression comment or a
//     changed settings file counts as a find of the scanner it names: it
//     counts as "suppression" or "settings".
// 28. A review whose scan was not saved reads as found by the reviewer: its
//     finder is unjudged, counted apart and left out of every finder ratio.
// Rules version 5 reads a person's rulings (lib/rulings.mjs) and names the
// truth item an unlisted finding sits on. Failure list, written before the
// code:
// 29. A repeated unresolved finding raises precision: recurrence decides
//     nothing; a finding stays unresolved, in every review that shows it,
//     until a person rules on it.
// 30. A ruling on one finding transfers to a different issue on the same
//     lines: a ruling reaches only the findingId it names; a finding on a
//     truth item's lines is only a location match (its truthId with
//     evidenceKind location-only), and finds the item only through a
//     person's same-issue ruling.
// 31. Two findings are merged into one issue without a person's
//     consolidate line: unique-issue precision counts each finding as its
//     own issue until a person's consolidate line groups them.
// 32. A ruling overrides the frozen spec, so a person tunes a planted
//     case's truth without a new case version: rulings act only on a
//     finding nothing frozen decides (unresolved, near or wrong kind); a
//     disputed truth item is labelled and keeps its recall.
// Rules version 6 reads the truth of pull request cases, whose items have
// no kind and no severity. Failure list, written before the code:
// 35. A saved sample of a pull request case cannot be scored: a truth item
//     with no kind is matched on the categories it names, and one with no
//     severity on the scale is left out of the per-severity tally of format
//     2 (issue 141). A planted case scores exactly as under version 5.
// Rules version 7 fixes how saved files are read. Failure list, written
// before the code:
// 40. A custom scanner's rule named like one of OpenQodex's own
//     (settings-file) counts as OpenQodex's own check, and a rule id that
//     names a property every object inherits (constructor) gives a function
//     as its finder (issue 143): only a built-in scanner's candidate is
//     OpenQodex's own, and own rules are a map with no prototype.
// 41. A model review scores with no cost and no tokens, since its completion
//     record holds none (issue 142): a server sample's cost and tokens are
//     its sample record's usage, the library's totals over every call, and
//     each configuration of model reviews names the models that served them.
//     A laptop review's are read as before.
// Rules version 8 keys every ruling on a truth item to the spec version it
// judged. Failure list, written before the code:
// 42. A ruling on a truth item labels it in every later version of its
//     case (issue 163): a bug or match ruling names the sha256 of the spec
//     it judged (lib/rulings.mjs specHashOf), and applies only to a job
//     scored against a spec with that hash; a line that names none applies
//     to no version. With no ruling, or only rulings on other versions, a
//     score is the same as under version 7.
// 43. A planted bug found at a place its spec does not list can never be
//     ruled found (issue 139): queue.mjs decide records a same-issue ruling
//     that names the truth item, for a finding on a line the change added in
//     that item's file; it scores as any same-issue ruling does, a hit on
//     that item on that spec version.
// Rules version 9 (PR 229): scanner outside advisories are information; legacy untagged findings still count.
// Rules version 10: wave8 adds Greptile scoring with a fixed denominator of 50; main scores observations with tiers.
// Rules version 11 (2026-10-22): merge of the two version-10 rule sets.
// Failure list, written before the code:
// 44. An observation of a staged review is shown to the developer and never
//     judged: shownFindings() lists report.observations after the findings,
//     each marked tier "observation", so every score, board file and judge
//     export sees it like a finding. A report without the field, or with an
//     empty list, scores exactly as under version 9.
// Rules version 12 reads a finding with no line number the same way
// whichever of null or undefined it is written as. Failure list, written
// before the code:
// 45. A finding's missing line number is read as line 0 when it is null, so
//     it matches only a truth item starting at line 1, but as any line when
//     it is undefined, so it matches any truth item in its file: lineMatches
//     (AACR's line rule) now reads either as "no line", matching any truth
//     location in the finding's file, the same way AACR-Bench's own
//     evaluator reads a comment with no line.
export const RULES_VERSION = 12;
export const AACR_LINE_K = 1;
// The order classify() tries the rules in; the first that holds decides.
export const OUTCOME_ORDER = ["test-gap", "accepted", "hit", "wrong-kind", "near", "false"];
// How each outcome counts in precision. Correct and wrong count the same in
// both bounds; an unresolved one, which nothing frozen decides and no person
// has ruled on, is wrong in the lower bound and right in the upper. A
// person's ruling makes it ruled-true or ruled-false, or, ruled the same
// issue as a truth item, a hit. A near miss and a wrong kind are unresolved
// and find a truth item only through such a ruling. A
// request for a test on a planted case (test-gap) is set apart: it stays out
// of both bounds and is counted in the labelled planted-rule block. On a
// real pull request the test-only rule does not apply, so such a request is
// an unlisted finding like any other.
export const PRECISION = { correct: ["hit", "duplicate", "accepted", "ruled-true"], wrong: ["false", "ruled-false"], unresolved: ["unresolved", "near", "wrong-kind"], apart: ["test-gap"] };
const OUTCOMES = [...PRECISION.correct, ...PRECISION.unresolved, ...PRECISION.wrong, ...PRECISION.apart];
// The evidence behind an outcome that the frozen spec decides.
const FROZEN = new Set(["hit", "duplicate", "accepted", "false"]);

export const LOCATION_LABEL = "Location diagnostic: AACR's line rule (same file and side, lines overlapping or at most AACR_LINE_K apart). A board output; never an acceptance metric.";
export const PLANTED_LEGACY_LABEL = "Only planted cases: the format 2 rule, with duplicates, accepted side issues and requests for a test set apart; testGaps counts the requests for a test, which stay out of both precision bounds. Never pooled with real-suite precision.";
export const ALL_ATTEMPTS_LABEL = "Every saved attempt, retries included and unstarted jobs left out, as score format 2 counted them. A diagnostic only.";
export const SEVERITY_LABEL = "Each found truth item once, by the first finding that hit it: the severity it gave against the truth item's, on the scale critical, major, minor, nitpick, info. Off is two steps or more; the matrix is truth severity, then given severity.";
export const FINDER_LABEL = "Each found truth item once, judged from the review's own scan.json: a scanner found it when one of its candidates, or a finding merged into one, sits on the item's lines and is either from a scanner found_by names or names the item's words; else the reviewer found it alone. found_by is the expectation: a scanner it names is met when that scanner located the item, reasoning and graph when no scanner did.";

// The kind of case a suite holds.
const ORIGINS = { planted: "planted", aacr: "real", clean: "real", martian: "injected", greptile: "injected" };
export const originOf = (suite) => ORIGINS[suite ?? "planted"] ?? null;

// Register authored suites separately from the frozen scoring rules.
// Their case hashes identify the fixtures; they use the same planted rules.
ORIGINS.conventions = "planted";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const jobIdOf = (caseId, config, repeat) => `${caseId}/${config}/${repeat}`;
export const caseSetHash = (ids) => sha256([...ids].sort().join("\n"));

// The identity of a finding across runs: the case, the cited lines and the
// whitespace-normalised text. The same text on the same lines of the same
// case is the same finding; anything else is a different one. A finding
// from before the structured prose fields (no problem, consequence or fix)
// says what it is in its description and suggested change, so those are
// its text; a finding with the structured fields keeps the id it had.
export const normText = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
export function findingId(caseId, f) {
  const start = Number.isInteger(f.line_number) ? f.line_number : null;
  const end = start === null ? null : Math.max(f.line_end ?? start, start);
  const prose = [normText(f.problem), normText(f.consequence), normText(f.fix)];
  const legacy = prose.every((p) => p === "") ? [normText(f.description), normText(f.suggested_change)] : [];
  return sha256(JSON.stringify([caseId, normPath(f.file_path), start, end, normText(f.title), ...prose, ...legacy]));
}

// Format 3's outcome from classify()'s: on a clean case every finding is
// false, whatever it matches (an extras entry on a clean spec included);
// elsewhere an unlisted finding is unresolved.
export function outcomeOf(outcome, spec) {
  if (spec.clean) return "false";
  return outcome === "false" ? "unresolved" : outcome;
}

const treatment = (outcome) => (PRECISION.correct.includes(outcome) ? "correct" : PRECISION.wrong.includes(outcome) ? "wrong" : PRECISION.apart.includes(outcome) ? "apart" : "unresolved");

// The issue a finding raises: the truth item it finds, the side issue it
// names, the issue a person consolidated it into, or else itself (by
// findingId).
export function issueKey(f) {
  if (f.outcome === "hit" || f.outcome === "duplicate") return `truth:${f.bug}`;
  if (f.outcome === "accepted") return `extra:${f.extra}`;
  if (f.issueId) return `issue:${f.issueId}`;
  return `finding:${f.findingId}`;
}

// The truth item an unlisted finding sits on by AACR's line rule (the same
// file and side, lines overlapping or at most `k` apart), nearest first,
// then in truth order: a location match, never evidence that the finding is
// that issue. Null when it sits on none.
export function locationMatch(f, spec, k = AACR_LINE_K) {
  const end = Math.max(f.end ?? f.line, f.line);
  const near = (spec.bugs ?? [])
    .map((t, order) => ({ t, order, d: Math.min(Infinity, ...locations(t).filter((l) => l.file === f.file && (f.side ?? "right") === (t.side ?? "right")).map((l) => gap(f.line, end, l.lines))) }))
    .filter(({ t, d }) => t.valid !== false && d <= k)
    .sort((a, b) => a.d - b.d || a.order - b.order);
  return near.length === 0 ? null : near[0].t.id;
}

// Outcomes nothing frozen decides, on which a person's ruling may act.
const UNSETTLED = new Set(["unresolved", "near", "wrong-kind"]);

// A finding's outcome after the rulings in force (lib/rulings.mjs): its
// issue, and for one nothing frozen decides, a hit on the truth item a
// person ruled it to be on this spec version (`specHash`), else ruled-true
// or ruled-false, else unresolved still. `bug` is then the truth item it is a hit on, or the one it is
// still a candidate for (a near miss, a wrong kind or a location match no
// person has ruled out); evidenceKind says what decided the outcome.
function ruled(g, spec, specHash, R) {
  const issueId = issueOf(g.findingId, R);
  if (!UNSETTLED.has(g.outcome)) return { issueId, evidenceKind: FROZEN.has(g.outcome) ? "frozen" : null };
  const candidate = g.outcome === "unresolved" ? locationMatch(g, spec) : g.bug;
  const same = sameIssueAs(g.findingId, (spec.bugs ?? []).map((b) => b.id), specHash, R);
  const real = realRuling(g.findingId, R);
  if (same !== null && !(real?.status === "false" && real.n > same.n)) return { outcome: "hit", bug: same.truthId, evidenceKind: "ruling", issueId };
  const open = candidate !== null && real?.status !== "false" && matchRuling(g.findingId, candidate, specHash, R)?.status !== "different-issue" ? candidate : null;
  if (real !== null) return { outcome: real.status === "true" ? "ruled-true" : "ruled-false", bug: open, evidenceKind: "ruling", issueId };
  return { bug: open, evidenceKind: open !== null && g.outcome === "unresolved" ? "location-only" : null, issueId };
}

// The questions a finding still puts to a person: whether it is a real
// issue (real), while nothing decides its precision, and whether it is the
// truth item it is a candidate for (match).
export function asksOf(f) {
  const out = [];
  if (UNSETTLED.has(f.outcome)) out.push("real");
  if (f.bug && f.outcome !== "hit" && f.outcome !== "duplicate") out.push("match");
  return out;
}

// AACR's line rule (L1), as a location diagnostic: a finding matches a truth
// item on the same side of the same file when their lines overlap or lie at
// most `k` lines apart. A finding with no line number (`null` or `undefined`)
// reads as the whole file, as AACR-Bench's own evaluator does, so it matches
// any location in that file. Greedy in truth order, then finding order; each
// takes at most one of the other. knownNoise counts the findings that match
// only rejected truth (valid: false).
export function lineMatches(findings, truth, k = AACR_LINE_K) {
  const hasLine = (f) => f.line !== null && f.line !== undefined;
  const near = (f, t) => (f.side ?? "right") === (t.side ?? "right") && locations(t).some((l) => l.file === f.file && (!hasLine(f) || gap(f.line, Math.max(f.end ?? f.line, f.line), l.lines) <= k));
  const positive = truth.filter((t) => t.valid !== false);
  const rejected = truth.filter((t) => t.valid === false);
  const used = new Set();
  let matches = 0;
  for (const t of positive) {
    const i = findings.findIndex((f, j) => !used.has(j) && near(f, t));
    if (i === -1) continue;
    used.add(i);
    matches++;
  }
  const knownNoise = findings.filter((f) => rejected.some((t) => near(f, t)) && !positive.some((t) => near(f, t))).length;
  return { matches, generated: findings.length, expected: positive.length, knownNoise };
}

// The severity a hit gave against its truth item's, on SEVERITY_ORDER: exact,
// one-off or off (two steps or more), and over (rated more severe) or under.
// Unknown, with nulls, when either side is not on the scale (AACR truth has
// no severity).
export function severityAgreement(given, expected) {
  const g = SEVERITY_ORDER.indexOf(given);
  const e = SEVERITY_ORDER.indexOf(expected);
  if (g === -1 || e === -1) return { agreement: null, direction: null };
  const steps = g - e;
  return { agreement: steps === 0 ? "exact" : Math.abs(steps) === 1 ? "one-off" : "off", direction: steps === 0 ? null : steps > 0 ? "under" : "over" };
}

// Expected finders that are the reviewer, not a scanner: its reading of the
// diff, and its reading helped by the code graph's caller list. The data
// cannot tell the two apart, so both are met by a find no scanner located.
export const REVIEWER_FINDERS = ["reasoning", "graph"];
// OpenQodex's own candidates, by rule id, and the finder each counts as. A
// map with no prototype, so no rule id reads an inherited property.
export const OWN_RULES = Object.freeze({ __proto__: null, "openqodex.suppression-added": "suppression", "settings-file": "settings" });

// The scanner and rule of a token "<source>:<ruleId>"; a custom scanner's
// source is "custom:<name>".
function tokenParts(token) {
  const t = String(token ?? "");
  const cut = t.indexOf(":", t.startsWith("custom:") ? 7 : 0);
  return cut === -1 ? { source: t, ruleId: "" } : { source: t.slice(0, cut), ruleId: t.slice(cut + 1) };
}

// Only a built-in scanner's candidate can be OpenQodex's own (core
// finalize.ts isOwnCandidate): a custom scanner may name a rule anything.
const finderName = (source, ruleId) => (!String(source).startsWith("custom:") && Object.hasOwn(OWN_RULES, ruleId) ? OWN_RULES[ruleId] : source);

// Where each scanner put a finding that reached the reviewer or was merged
// into one, with its words: every kept candidate (its id, rule id and
// message), every token a candidate names as merged into it (on the
// candidate's lines, since dedup merges only the same lines), and every
// merged trail entry on its own lines with the candidate it went `into`
// (the rule id alone: the trail keeps no message). Null when the attempt
// saved no scan.
export function scannerPlaces(scan) {
  if (!scan || typeof scan !== "object") return null;
  const place = (name, file, start, end, text, link = {}) => ({ name, file: normPath(file), start, end: Math.max(end ?? start, start), text: String(text ?? "").toLowerCase(), ...link });
  const out = [];
  for (const c of scan.candidates ?? []) {
    out.push(place(finderName(c.source, c.ruleId), c.filePath, c.lineStart, c.lineEnd, `${c.ruleId} ${c.message ?? ""}`, { id: c.id }));
    for (const token of c.alsoReportedBy ?? []) {
      const t = tokenParts(token);
      out.push(place(finderName(t.source, t.ruleId), c.filePath, c.lineStart, c.lineEnd, t.ruleId));
    }
  }
  for (const e of scan.trail ?? []) {
    if (e.stage !== "merged") continue;
    const t = tokenParts(e.token);
    out.push(place(finderName(t.source, t.ruleId), e.file, e.lineStart, e.lineEnd, t.ruleId, { into: e.into ?? null }));
  }
  return out;
}

// The scanners that located a truth item, sorted. A place locates it when
// it lies on one of the item's locations with overlapping lines, and either
// its scanner is one the item expects or its words name the item's
// mentions: the scanner-only rule S1, so a scanner the spec does not expect
// is not credited with a bug whose wide range holds its finding about
// something else. A merged trail entry reached the reviewer only through
// the candidate it went into, so it counts only when that candidate is a
// kept one on the item's lines or one a shown finding raised (`raised`, a
// set of candidate ids). Null when the scan was not saved.
export function locatedBy(places, bug, expected = [], raised = new Set()) {
  if (places === null) return null;
  const at = locations(bug);
  const on = (p) => at.some((l) => l.file === p.file && gap(p.start, p.end, l.lines) === 0);
  const reached = new Set(places.filter((p) => p.id !== undefined && (on(p) || raised.has(p.id))).map((p) => p.id));
  const through = (p) => p.into === undefined || reached.has(p.into);
  return [...new Set(places.filter((p) => through(p) && on(p) && (expected.includes(p.name) || names(bug.mentions, p.text))).map((p) => p.name))].sort();
}

// Who found a found truth item, from the data: "scanner" when a scanner
// located it (locatedBy), "reviewer" when none did, null when the scan was
// not saved. `met` lists the expected finders the find meets: a scanner
// that located it, or reasoning and graph when no scanner did.
export function finderOf(located, expected) {
  if (located === null) return { finder: null, met: [] };
  const finder = located.length > 0 ? "scanner" : "reviewer";
  return { finder, met: (expected ?? []).filter((name) => (REVIEWER_FINDERS.includes(name) ? finder === "reviewer" : located.includes(name))) };
}

// Whom a truth item's spec expects to find it: a planted bug's found_by, or
// a suite truth item's expectedFinder.
const expectedOf = (bug) => bug.found_by ?? bug.expectedFinder ?? [];

// One hit judged: the severity it gave against its truth item's, and who
// found the item. Every other outcome is judged by neither.
function judgeHit(f, bug, places, raised) {
  if (f.outcome !== "hit" || !bug) return { severityExpected: null, severityAgreement: null, severityDirection: null, finder: null, locatedBy: null, expectedFinder: null, met: null };
  const s = severityAgreement(f.severity, bug.severity);
  const expectedFinder = expectedOf(bug);
  const located = locatedBy(places, bug, expectedFinder, raised);
  return { severityExpected: bug.severity ?? null, severityAgreement: s.agreement, severityDirection: s.direction, locatedBy: located, expectedFinder, ...finderOf(located, expectedFinder) };
}

// The severity of every hit against its truth item's: exact, one-off, off and
// within one as ratios over the judged hits, the over- and under-rated
// counts, and the matrix (truth severity, then given severity).
function severitySummary(hits) {
  const judged = hits.filter((h) => h.severityAgreement !== null);
  const n = (a) => judged.filter((h) => h.severityAgreement === a).length;
  const matrix = Object.fromEntries(SEVERITY_ORDER.map((e) => [e, Object.fromEntries(SEVERITY_ORDER.map((g) => [g, 0]))]));
  for (const h of judged) matrix[h.severityExpected][h.severity]++;
  const of = judged.length;
  return {
    label: SEVERITY_LABEL,
    exact: { hit: n("exact"), of },
    oneOff: { hit: n("one-off"), of },
    off: { hit: n("off"), of },
    withinOne: { hit: n("exact") + n("one-off"), of },
    over: judged.filter((h) => h.severityDirection === "over").length,
    under: judged.filter((h) => h.severityDirection === "under").length,
    unknown: hits.length - of,
    matrix,
  };
}

// Who found every hit's truth item, against whom its spec expects: the
// match, each expected finder as a ratio, the finds a scanner located and
// the reviewer's alone, the finds the spec expected from a scanner that no
// scanner located, the hits with no saved scan, and `dropped`, the truth
// items, found or not, that a scanner candidate the reviewer dropped had
// located.
function finderSummary(hits, dropped) {
  const judged = hits.filter((h) => h.finder !== null);
  const expecting = judged.filter((h) => h.expectedFinder.length > 0);
  const byExpected = {};
  for (const h of expecting) {
    for (const name of h.expectedFinder) {
      byExpected[name] ??= ratio();
      byExpected[name].of++;
      if (h.met.includes(name)) byExpected[name].hit++;
    }
  }
  return {
    label: FINDER_LABEL,
    match: { hit: expecting.filter((h) => h.met.length > 0).length, of: expecting.length },
    byExpected: Object.fromEntries(Object.keys(byExpected).sort().map((k) => [k, byExpected[k]])),
    byFinder: { scanner: judged.filter((h) => h.finder === "scanner").length, reviewer: judged.filter((h) => h.finder === "reviewer").length },
    scannerExpectedReviewerFound: expecting.filter((h) => h.finder === "reviewer" && h.expectedFinder.some((name) => !REVIEWER_FINDERS.includes(name))).length,
    unjudged: hits.length - judged.length,
    droppedCandidates: dropped,
  };
}

// The jobs a run planned: the manifest's `jobs` when it has them, else (a
// run made before the list existed) every repeat of every case and
// configuration it names, with the saved attempts filling in what it does
// not name. `attempts` are the saved attempts: { case, config, repeat }.
export function plannedJobs(manifest, attempts) {
  if (Array.isArray(manifest.jobs)) {
    return { from: "manifest", jobs: manifest.jobs.map((j) => ({ jobId: j.jobId, caseId: j.caseId, case: parseCaseId(j.caseId)?.name ?? j.caseId, config: j.config, repeat: j.repeat })) };
  }
  const suite = manifest.suite ?? "planted";
  const seen = (k) => [...new Set(attempts.map((a) => a[k]))].sort();
  const cases = manifest.cases ?? seen("case");
  const configs = manifest.configs ?? seen("config");
  const repeat = manifest.repeat ?? Math.max(0, ...attempts.map((a) => a.repeat));
  const idOf = (name) => (manifest.caseIds ?? []).find((id) => parseCaseId(id)?.name === name) ?? (manifest.caseHashes?.[name] ? `${suite}/${name}@${manifest.caseHashes[name].slice(0, 8)}` : `${suite}/${name}`);
  const jobs = [];
  for (let r = 1; r <= repeat; r++) for (const c of cases) for (const config of configs) jobs.push({ jobId: jobIdOf(idOf(c), config, r), caseId: idOf(c), case: c, config, repeat: r });
  return { from: "derived", jobs };
}

// Which attempt a sample folder holds, from its name: <repeat> is the first
// attempt of that repeat, <repeat>-attempt<n> its n-th.
export function attemptOf(folder) {
  const m = /^(\d+)(?:-attempt(\d+))?$/.exec(folder);
  return m ? { repeat: Number(m[1]), attempt: m[2] === undefined ? 1 : Number(m[2]) } : null;
}

// The population of a run: each planned job with its first attempt (null
// when it never started). Retries, and first attempts of no planned job,
// are kept apart; a saved attempt that names another job than its folder is
// a problem.
export function population(manifest, attempts) {
  const { from, jobs } = plannedJobs(manifest, attempts);
  const key = (x) => `${x.case}\0${x.config}\0${x.repeat}`;
  const firsts = new Map(attempts.filter((a) => a.attempt === 1).map((a) => [key(a), a]));
  const planned = new Set(jobs.map(key));
  const problems = [];
  const out = jobs.map((job) => {
    const first = firsts.get(key(job)) ?? null;
    if (typeof first?.row?.jobId === "string" && first.row.jobId !== job.jobId) problems.push(`${job.case}/${job.config}/${job.repeat}: its sample.json names the job ${first.row.jobId}, but the manifest plans ${job.jobId} there`);
    return { ...job, first };
  });
  return { from, jobs: out, retries: attempts.filter((a) => a.attempt > 1), unplanned: attempts.filter((a) => a.attempt === 1 && !planned.has(key(a))), problems };
}

// One planned job, scored from its first attempt: `report`, `brief` and
// `scan` are that attempt's (null when it wrote none), and `started` is
// false for a job with no attempt. `origin` is the kind of case (originOf),
// and `rulings` the rulings in force (lib/rulings.mjs resolveRulings).
export function scoreJob({ job, spec, report = null, brief = null, scan = null, row = {}, origin = "planted", started = true, rulings = resolveRulings([]) }) {
  const planted = origin === "planted";
  const base = scoreSample({ spec, report, brief, row: { ...row, config: job.config, repeat: job.repeat, attempt: 1 }, testOnly: planted });
  const shown = shownFindings(report);
  const places = scannerPlaces(scan);
  const raised = new Set(base.findings.map((f) => f.raised).filter((id) => typeof id === "string"));
  const truth = new Map((spec.bugs ?? []).map((b) => [b.id, b]));
  // A ruling on a truth item applies only to the spec version it judged.
  const specHash = specHashOf(spec);
  const findings = base.findings.map((f, index) => {
    const g = { ...f, index, legacyOutcome: f.outcome, outcome: outcomeOf(f.outcome, spec), findingId: findingId(job.caseId, shown[index]), confidence: shown[index].confidence ?? null };
    // A ruled hit is judged like a frozen one: the truth item it finds is the one the ruling names.
    const r = { ...g, ...ruled(g, spec, specHash, rulings) };
    return { ...r, ...judgeHit(r, truth.get(r.bug), places, raised), issue: issueKey(r) };
  });
  // A hit by ruling on a truth item this review already found is a
  // duplicate, never judged; one on an item it missed finds that item.
  const found = new Set(base.bugs.filter((b) => b.found).map((b) => b.id));
  const byRuling = new Map();
  for (const f of findings.filter((x) => x.outcome === "hit" && x.evidenceKind === "ruling")) {
    if (found.has(f.bug)) {
      f.outcome = "duplicate";
      Object.assign(f, judgeHit(f, null, places, raised), { issue: issueKey(f) });
    } else {
      found.add(f.bug);
      byRuling.set(f.bug, f);
    }
  }
  const bugs = base.bugs.map((b) => (byRuling.has(b.id) ? { ...b, found: true, given: byRuling.get(b.id).severity, via: byRuling.get(b.id).raised !== null ? "scanner" : "reviewer" } : b));
  const recallOf = (list) => ({ hit: list.filter((b) => b.found).length, of: list.length });
  // The truth items, found or not, that a scanner candidate the reviewer dropped had located (by the same rule as a find).
  const droppedPlaces = scannerPlaces({ candidates: (report?.dropped ?? []).map((d) => d?.candidate).filter((c) => c && typeof c === "object") });
  const droppedOn = (spec.bugs ?? []).filter((b) => locatedBy(droppedPlaces, b, expectedOf(b)).length > 0).length;
  // Precision, issues and redundancy count every shown finding but the ones set apart.
  const inPrecision = findings.filter((f) => treatment(f.outcome) !== "apart");
  const counted = (list) => ({ correct: list.filter((x) => x === "correct").length, unresolved: list.filter((x) => x === "unresolved").length, of: list.length });
  // An issue's findings count as one: correct or wrong when they all are, else unresolved.
  const issues = new Map();
  for (const f of inPrecision) {
    const t = treatment(f.outcome);
    issues.set(f.issue, issues.has(f.issue) && issues.get(f.issue) !== t ? "unresolved" : t);
  }
  return {
    jobId: job.jobId,
    caseId: job.caseId,
    case: job.case ?? spec.id,
    config: job.config,
    repeat: job.repeat,
    origin,
    clean: spec.clean === true,
    status: started ? base.status : "unstarted",
    bugs,
    findings,
    // A clean change passes only a review that completed with no shown finding at all.
    controls: spec.clean ? { hit: base.status === "complete" && findings.length === 0 ? 1 : 0, of: 1 } : ratio(),
    issueRecall: { all: recallOf(bugs), criticalMajor: recallOf(bugs.filter((b) => b.severity === "critical" || b.severity === "major")) },
    precision: counted(inPrecision.map((f) => treatment(f.outcome))),
    issues: counted([...issues.values()]),
    location: lineMatches(base.findings, spec.bugs ?? []),
    plantedLegacy: planted ? base.precision : null,
    testGaps: findings.length - inPrecision.length,
    droppedOn,
    gaps: base.gaps,
    callers: base.callers,
    failures: started ? base.failures : [],
    wallMs: base.wallMs,
    reviewerMs: base.reviewerMs,
    costUsd: base.costUsd,
    turns: base.turns,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    servedModels: base.servedModels,
  };
}

// Sums scored jobs (scoreJob) as ratios of sums; `retries` are the format 2
// samples of the retries, counted with their cost and nothing else.
export function summarizeJobs(jobs, retries = []) {
  const count = (status) => jobs.filter((j) => j.status === status).length;
  const total = (f) => jobs.reduce((a, j) => add(a, f(j)), ratio());
  const sum = (list, f) => list.reduce((a, j) => a + f(j), 0);
  const correct = sum(jobs, (j) => j.precision.correct);
  const unresolved = sum(jobs, (j) => j.precision.unresolved);
  const displayed = sum(jobs, (j) => j.precision.of);
  const issuesCorrect = sum(jobs, (j) => j.issues.correct);
  const issuesUnresolved = sum(jobs, (j) => j.issues.unresolved);
  const distinct = sum(jobs, (j) => j.issues.of);
  const recall = total((j) => j.issueRecall.all);
  const lower = { hit: correct, of: displayed };
  const p = value(lower);
  const r = value(recall);
  const matches = sum(jobs, (j) => j.location.matches);
  const generated = sum(jobs, (j) => j.location.generated);
  const expected = sum(jobs, (j) => j.location.expected);
  const planted = jobs.filter((j) => j.origin === "planted");
  const clean = jobs.filter((j) => j.clean);
  const retryCosts = nums(retries.map((s) => s.costUsd));
  // The jobs whose sample record names the models that served them: a model review's.
  const served = jobs.filter((j) => Array.isArray(j.servedModels));
  const hits = jobs.flatMap((j) => j.findings.filter((f) => f.outcome === "hit"));
  const outcomes = {};
  for (const o of OUTCOMES) {
    const n = sum(jobs, (j) => j.findings.filter((f) => f.outcome === o).length);
    if (n > 0) outcomes[o] = n;
  }
  return {
    population: {
      planned: jobs.length,
      complete: count("complete"),
      incomplete: count("incomplete"),
      failed: count("failed"),
      unstarted: count("unstarted"),
      retries: retries.length,
      retryCostUsd: retries.length > 0 && retryCosts.length === 0 ? null : retryCosts.reduce((a, b) => a + b, 0),
    },
    issueRecall: { all: recall, criticalMajor: total((j) => j.issueRecall.criticalMajor) },
    precision: { lower, upper: { hit: correct + unresolved, of: displayed }, unresolved },
    uniqueIssuePrecision: { lower: { hit: issuesCorrect, of: distinct }, upper: { hit: issuesCorrect + issuesUnresolved, of: distinct } },
    redundancy: { hit: displayed - distinct, of: displayed },
    f1: p + r === 0 ? 0 : (2 * p * r) / (p + r),
    cleanFindingsPerCase: { findings: sum(clean, (j) => j.precision.of), cases: clean.length },
    controls: total((j) => j.controls),
    location: { label: LOCATION_LABEL, precision: { hit: matches, of: generated }, recall: { hit: matches, of: expected }, matches, generated, expected, knownNoise: sum(jobs, (j) => j.location.knownNoise) },
    plantedLegacy: planted.length === 0 ? null : { label: PLANTED_LEGACY_LABEL, precision: planted.reduce((a, j) => add(a, j.plantedLegacy), ratio()), testGaps: sum(planted, (j) => j.testGaps) },
    severity: severitySummary(hits),
    finder: finderSummary(hits, sum(jobs, (j) => j.droppedOn)),
    outcomes,
    brief: { gaps: total((j) => j.gaps), callers: total((j) => j.callers) },
    causes: null,
    wallMs: stats(jobs.map((j) => j.wallMs)),
    reviewerMs: stats(jobs.map((j) => j.reviewerMs)),
    costUsd: stats(jobs.map((j) => j.costUsd)),
    turns: stats(jobs.map((j) => j.turns)),
    inputTokens: stats(jobs.map((j) => j.inputTokens)),
    outputTokens: stats(jobs.map((j) => j.outputTokens)),
    // Model reviews only: every model the provider named as serving them. A laptop configuration has no such list.
    ...(served.length > 0 ? { servedModels: [...new Set(served.flatMap((j) => j.servedModels))].sort() } : {}),
  };
}

// A run's saved attempts scored by format 3: the population from the
// manifest, each planned job by its first attempt, the sums per
// configuration, case and bug, and one outcome line per finding of every
// first attempt. `attempts` are { case, config, repeat, attempt, row,
// report, brief, sample } (sample: the attempt scored by format 2),
// `specs` the specs by case name, and `decisions` the lines of the
// adjudication file with `people`, the names in people.json beside it
// (lib/rulings.mjs readDecisions).
export function scoreAttempts({ manifest, attempts, specs, decisions = [], people = [] }) {
  const suite = manifest.suite ?? "planted";
  const origin = originOf(suite);
  if (origin === null) throw new Error(`the run names the suite ${suite}, which the scorer does not know`);
  const pop = population(manifest, attempts);
  if (pop.problems.length > 0) throw new Error(`the run's samples do not match its plan:\n${pop.problems.join("\n")}`);
  const rulings = resolveRulings(decisions, people);
  // The version of each case's spec, which a ruling on one of its truth items names.
  const specHashes = new Map(Object.entries(specs).map(([name, spec]) => [name, specHashOf(spec)]));
  const jobs = pop.jobs.map((j) => scoreJob({ job: j, spec: specs[j.case], report: j.first?.report ?? null, brief: j.first?.brief ?? null, scan: j.first?.scan ?? null, row: j.first?.row ?? {}, origin, started: j.first !== null, rulings }));
  const configs = [...new Set(jobs.map((j) => j.config))].sort();
  const byConfig = {};
  for (const config of configs) {
    const all = summarize(attempts.filter((a) => a.config === config).map((a) => a.sample));
    byConfig[config] = {
      ...summarizeJobs(jobs.filter((j) => j.config === config), pop.retries.filter((a) => a.config === config).map((a) => a.sample)),
      allAttempts: { label: ALL_ATTEMPTS_LABEL, samples: all.samples, recall: all.recall, precision: all.precision },
    };
  }
  const perCase = {};
  const perBug = {};
  for (const j of jobs) {
    perCase[j.config] ??= {};
    const c = (perCase[j.config][j.caseId] ??= { issueRecall: ratio(), precision: { lower: ratio(), upper: ratio() }, findings: 0 });
    c.issueRecall = add(c.issueRecall, j.issueRecall.all);
    c.precision.lower = add(c.precision.lower, { hit: j.precision.correct, of: j.precision.of });
    c.precision.upper = add(c.precision.upper, { hit: j.precision.correct + j.precision.unresolved, of: j.precision.of });
    c.findings += j.findings.length;
    perBug[j.config] ??= {};
    const bugs = (perBug[j.config][j.caseId] ??= {});
    for (const b of j.bugs) {
      // Per repeat: whether it was found, the severity its first hit gave, and who found it; and a person's ruling on the item in this spec version.
      const x = (bugs[b.id] ??= { found: [], severity: b.severity, given: [], finder: [], cause: null, ruling: bugRuling(j.caseId, b.id, specHashes.get(j.case), rulings) });
      const hit = j.findings.find((f) => f.outcome === "hit" && f.bug === b.id);
      x.found[j.repeat - 1] = b.found;
      x.given[j.repeat - 1] = hit?.severity ?? null;
      x.finder[j.repeat - 1] = hit?.finder ?? null;
    }
  }
  const briefFailures = {};
  for (const config of configs) {
    const seen = new Map();
    for (const j of jobs.filter((x) => x.config === config)) for (const f of j.failures) seen.set(`${j.case}: ${f}`, (seen.get(`${j.case}: ${f}`) ?? 0) + 1);
    briefFailures[config] = [...seen].map(([what, n]) => ({ what, reviews: n }));
  }
  const outcomes = jobs.flatMap((j) =>
    j.findings.map((f) => ({ jobId: j.jobId, caseId: j.caseId, config: j.config, repeat: j.repeat, index: f.index, findingId: f.findingId, issueId: f.issueId, outcome: f.outcome, truthId: f.bug ?? null, evidenceKind: f.evidenceKind, cause: null, confidence: f.confidence, severity: f.severity ?? null, severityExpected: f.severityExpected, severityAgreement: f.severityAgreement, severityDirection: f.severityDirection, finder: f.finder, locatedBy: f.locatedBy, wording: null })),
  );
  return {
    suite,
    jobs,
    caseIds: [...new Set(jobs.map((j) => j.caseId))].sort(),
    population: { ...summarizeJobs(jobs, pop.retries.map((a) => a.sample)).population, jobsFrom: pop.from, unplanned: pop.unplanned.map((a) => `${a.case}/${a.config}/${a.repeat}`) },
    byConfig,
    perCase,
    perBug,
    briefFailures,
    outcomes,
    rulings: { read: rulings.read, ignored: rulings.ignored, people: rulings.people },
  };
}

// ---------------------------------------------------------------------------
// The wording verdict: what benchmark/judge.mjs's model said about the
// sentences of each finding the script matched to a planted bug, read from
// judge.json and reported beside the score. It is not a scoring rule: no
// rule reads it, so it never changes a hit, a count, an exit code or an
// accept, and it lies outside the rules hash.
//
// Failure list, written before the code:
// 33. The totals in score.json differ from the judge.json they came from:
//     the judge and the scorer both count them with wordingTotals, from the
//     file's saved verdicts, the way the judge has counted them from the
//     start: an unparsed answer is left out of every ratio, and an unknown
//     cost adds nothing to costUsd and is counted in costUnknown.
// 34. A verdict changes a score: the scorer adds the block to each
//     configuration after the configuration is scored.
export const WORDING_SENTENCES = ["problem", "consequence", "fix"];
export const WORDING_LABEL = "A model's verdict on the wording of each finding the script matched to a planted bug: whether its problem, consequence and fix sentences are plain and correct. Report only: it never changes a hit, a count, an exit code or an accept.";

/** judge.json's totals per configuration, counted from its samples' verdicts. */
export function wordingTotals(samples) {
  const totals = {};
  for (const s of samples) {
    const t = (totals[s.config] ??= { findings: 0, unparsed: 0, costUsd: 0, costUnknown: 0, ...Object.fromEntries(WORDING_SENTENCES.map((k) => [k, { plain: ratio(), correct: ratio() }])) });
    if (typeof s.costUsd === "number") t.costUsd += s.costUsd;
    else t.costUnknown++;
    for (const f of s.findings ?? []) {
      t.findings++;
      if (!f.verdict) {
        t.unparsed++;
        continue;
      }
      for (const k of WORDING_SENTENCES) {
        t[k].plain.of++;
        t[k].correct.of++;
        if (f.verdict[k]?.plain === true) t[k].plain.hit++;
        if (f.verdict[k]?.correct === true) t[k].correct.hit++;
      }
    }
  }
  return totals;
}

/**
 * One configuration's wording block for score.json, from a judge.json
 * document (`from` says which file): the judge model, the models that
 * answered, the specs it judged by and the totals. Null when the document
 * judged no review of that configuration.
 */
export function wordingBlock(doc, config, from = "judge.json") {
  if (!Array.isArray(doc?.samples)) return null;
  const totals = wordingTotals(doc.samples)[config];
  if (totals === undefined) return null;
  const served = [...new Set(doc.samples.filter((s) => s.config === config).map((s) => s.servedModel).filter((m) => typeof m === "string" && m !== ""))].sort();
  return { label: WORDING_LABEL, model: doc.model ?? null, servedModels: served, specs: doc.specs ?? null, from, ...totals };
}

// Why two scores' numbers cannot be compared as they stand: their rules
// differ, by version or, under one version, by hash. Empty when the rules
// are the same.
export function rulesDifferences(a, b) {
  const va = a?.version ?? null;
  const vb = b?.version ?? null;
  const ha = a?.hash ?? null;
  const hb = b?.hash ?? null;
  const rescore = "rescore both runs with one scorer before comparing them";
  if (va !== vb) return [`the scoring rules differ: version ${va} then ${vb}; ${rescore}`];
  if (ha === null || hb === null) return [`the scoring rules of one score are not recorded; ${rescore}`];
  if (ha !== hb) return [`the scoring rules differ under one version (${va}): a rule changed without a version bump; ${rescore}`];
  return [];
}

// The rules block every format 3 score carries. Its hash covers each
// constant and list, and the source of everything the scoring of a run
// depends on: from the roots below (which attempt of each job counts, and
// the scoring of a run's attempts), every top-level declaration they name,
// transitively, in this file or in a module beside it that this file
// imports from (the case id parser in cases.mjs). So a change to any rule,
// any helper a rule calls or the attempt selection moves the hash. The
// source is read from the files on disk, not from Function.toString(),
// because a test runner rewrites imported names inside a loaded function,
// and the tests and the command must hash the same text. Formatting counts
// too: a change of layout alone moves the hash and needs a version bump
// (accepted as the price of hashing the text).
const RULE_ROOTS = ["attemptOf", "scoreAttempts"];
// The hashing and comparing itself, which no rule calls.
const NOT_RULES = new Set(["RULES", "RULES_BLOCK", "RULE_ROOTS", "NOT_RULES", "ruleSources", "ruleCodeHash", "rulesHash", "rulesDifferences", "canonical", "topLevel", "readOwn"]);

// One module's top-level declarations (a declaration ending its first line
// with a semicolon is that line; any other runs to the next line that opens
// with a closing brace, bracket or parenthesis at column 0), and the names
// it imports from modules beside it.
export function topLevel(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const decls = new Map();
  for (const [i, line] of lines.entries()) {
    const m = /^(?:export )?(?:async )?(?:function\*? ?|const |let )([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) continue;
    let end = i;
    if (!/;\s*$/.test(line)) {
      end = lines.findIndex((l, j) => j > i && /^[}\])]/.test(l));
      if (end === -1) end = lines.length - 1;
    }
    decls.set(m[1], lines.slice(i, end + 1).join("\n"));
  }
  const imports = new Map();
  for (const m of source.matchAll(/^import \{([^}]*)\} from "\.\/([^"]+)";/gm)) {
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imports.set(name, m[2]);
  }
  return { decls, imports };
}

const readOwn = (file) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

// Every declaration the scoring depends on, as { id: "<file>#<name>", text },
// sorted by id. `read(file)` gives the source of a module of this folder.
export function ruleSources(read = readOwn) {
  const modules = new Map();
  const mod = (file) => {
    if (!modules.has(file)) modules.set(file, topLevel(read(file)));
    return modules.get(file);
  };
  const seen = new Map();
  const visit = (file, name) => {
    if (NOT_RULES.has(name)) return;
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
  for (const root of RULE_ROOTS) visit("score.mjs", root);
  return [...seen].map(([id, text]) => ({ id, text })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const ruleCodeHash = (read = readOwn) => sha256(ruleSources(read).map(({ id, text }) => `${id}\n${text.replace(/\s+/g, " ").trim()}`).join("\n"));

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function rulesHash(block) {
  const rest = { ...block };
  delete rest.hash;
  return sha256(canonical(rest));
}

const RULES_BLOCK = {
  version: RULES_VERSION,
  nearLines: NEAR_LINES,
  aacrLineK: AACR_LINE_K,
  overlap: "A finding's lines are [line_number, max(line_end, line_number)]. A hit needs a gap of 0 between them and one of the truth item's locations (its file and lines, or an entry of also), paths normalised.",
  words: { rule: "A mention matches case-insensitively, without stemming, at the start of the text or after a character that is not a letter or digit.", fields: ["title", "problem", "consequence", "fix", "description", "suggested_change"] },
  testOnly: { pattern: TEST_ONLY.source, flags: TEST_ONLY.flags, kinds: TEST_ONLY_KINDS, applies: "planted cases only, where such a finding is set apart from precision; on a clean case it is false" },
  order: OUTCOME_ORDER,
  precision: PRECISION,
  population: "Every planned job's first attempt. A job with no attempt is unstarted; an unstarted or failed job misses every truth item of its case and adds no finding. Retries are diagnostics only.",
  issues: "Findings that find one truth item are one issue, and so are findings on one accepted side issue and findings a person's consolidate line groups; any other finding is its own issue, by findingId. Overlap, category, rule id and recurrence never group findings. An issue counts correct or wrong when all its findings do, else unresolved.",
  // Version 4.
  severity: { order: SEVERITY_ORDER, rule: "Each hit, the first finding in report order to find its truth item, compares its severity with the truth item's on the order above: exact, one-off, or off at two steps or more; over when it is more severe, under when less. A duplicate is not judged; a side without a severity on the scale is unknown." },
  finder: { reviewer: REVIEWER_FINDERS, own: OWN_RULES, rule: "Each hit's truth item is located by a scanner when a kept candidate of that scanner, a token in a candidate's alsoReportedBy, or a merged trail entry of it in the attempt's scan.json lies on one of the item's locations with a gap of 0 (a merged entry only when the candidate it went into is a kept one on those lines or one a shown finding raised), and either found_by names that scanner or its rule id and message (the rule id alone for a merged token or entry) name one of the item's mentions by the word rule. A built-in scanner's rule whose id is a key of own counts as the finder named there; a custom scanner's rule counts as that custom scanner, whatever its id. The finder is scanner when any scanner located it, reviewer when none did, and unjudged when the attempt saved no scan. found_by is the expectation: a scanner it names is met when that scanner located the item; a reviewer finder is met when no scanner did." },
  // Version 5.
  identity: "A finding's id is the sha256 of its case id, path, lines and whitespace-normalised title, problem, consequence and fix; a finding with none of problem, consequence and fix adds its description and suggested change. Rulings key on it.",
  locationMatch: "An unresolved finding is a location match to the nearest truth item by AACR's line rule (same file and side, lines overlapping or at most AACR_LINE_K apart), then the first in truth order. A location match never finds the item; outcomes.jsonl names it with evidenceKind location-only.",
  rulings: "A ruling counts only from a line of the adjudication file whose by is a name in people.json beside it and names no model, agent or tool (lib/rulings.mjs); spec-candidate-accepted and spec-candidate-rejected are true and false; the latest line per target wins, and a finding in a consolidated issue takes the later of its own and its issue's ruling. Rulings act only on findings nothing frozen decides: same-issue makes a hit on that truth item (a duplicate when the review already found it) unless a later false ruling stands; true makes ruled-true; false makes ruled-false and closes its match; different-issue closes the match. A bug ruling labels the item in perBug and leaves recall unchanged. A ruled hit is judged for severity and finder like any hit.",
  // Version 6.
  truthWithoutKind: "A truth item with no kind, a pull request comment, is matched on the categories it names; one with no severity on the scale counts in recall and in no severity's tally.",
  // Version 7.
  usage: "A review's cost and tokens are its laptop completion record's usage; a model review's, whose completion record holds none, are its sample record's usage, the library's totals over every model call. No rule reads them.",
  // Version 8.
  specVersion: "A bug ruling and a match ruling (same-issue, different-issue) name the spec version they judged as specHash, the sha256 of the spec's JSON with every object's keys sorted, and apply only to a job whose case is scored against a spec with that hash, the run's own copy or the one --specs names; a line that names none applies to no version and is listed as ignored. A same-issue ruling may name a truth item the finding does not sit on by the location rule: queue.mjs decide records it only when the finding is on a line the change added in a file of that item, and it scores as any same-issue ruling.",
  code: ruleCodeHash(),
};
export const RULES = Object.freeze({ ...RULES_BLOCK, hash: rulesHash(RULES_BLOCK) });

// ---------------------------------------------------------------------------
// Martian's offline board, read back (PLAN-benchmark 4.5). Martian's own
// pipeline (step 2 extracts issues from the findings we send, step 2.5
// groups duplicates, step 3 judges each issue against each golden comment,
// score_profiles sums them) decides the official numbers. Its result, as
// benchmark/outside/martian/evaluation.json keeps it:
//   { version: 1, board: { repo, commit }, toolName, judge: { model, served },
//     candidates: [{ candidateId, sourceFindingIds: [findingId],
//       extractedText, extraction: { model, step, file }, dedupGroup }],
//     matches: [{ candidateId, goldenId: "<case id>#g<n>", verdict }],
//     totals: { strict, core, all: { precision, recall, f1, fbeta, tp, fp,
//       fn, prs }, beta } }
// The reader keeps all of it as it is and adds, beside it, numbers of our
// own computed by script from the matches. Nothing here is in the rules
// block: it scores no run of ours, and it never gates.
//
// Failure list, written before the code:
// 33. A finding without problem, consequence or fix is saved for the judge,
//     which then judges less than the review wrote, and the run is scored
//     silently: martianFindings refuses to render such a finding, naming
//     its case, index and what it lacks, and the reader refuses an
//     evaluation whose sent findings include one.
// 34. One finding extracted into two issues, or one candidate matched to two
//     golden comments, loses a match (a map from a finding or a candidate to
//     one golden comment keeps only the last) or counts twice (a sum over
//     match lines): every match line is kept as given; golden comments found
//     are counted by distinct golden id, findings matched by distinct
//     finding id, and each found golden comment is judged once, by the first
//     finding in report order behind a candidate matched to it.
// 35. The official numbers are altered, or recomputed by our rules: totals,
//     candidates and matches are returned as given (a copy), and our numbers
//     sit in their own labelled block.
// 36. A conversion drops a match, so our numbers rest on fewer matches than
//     the official ones: the distinct golden comments the matches name must
//     equal the official all-profile true positives (every golden category
//     is in the all profile, and Martian counts a found golden comment
//     once), or the reader refuses.
// 37. A candidate names a finding the run never sent, or a match names a
//     candidate or golden comment that does not exist, and is dropped
//     quietly: the reader refuses it.
// 38. Official totals missing a field (a profile, a ratio, a count, the
//     beta) are returned as official: every field of the shape
//     score_profiles writes is checked, and a missing or mistyped one is
//     refused by its path.
// 39. A match links a candidate of one pull request to a golden comment of
//     another, and both ids exist, so it counts: the case of the findings
//     behind the candidate must be the golden comment's case, or the reader
//     refuses with both ids; a candidate whose findings come from two cases
//     is refused too.
export const MARTIAN_LABEL = "Martian's offline board, read back. official, candidates and matches are Martian's pipeline's own (its extraction, dedup and judge, and score_profiles' totals), unchanged. ours is computed by script from those matches: golden comments found (distinct), findings behind a matched candidate (distinct), and each found golden comment's severity against the severity of the first finding in report order behind a candidate matched to it, on the scale critical, major, minor, nitpick, info (Critical critical, High major, Medium minor, Low nitpick). A board output, labelled with its judge; never an acceptance metric.";
export const MARTIAN_VERDICTS = ["match", "no-match"];
// What Martian's judge reads of a finding.
export const JUDGE_FIELDS = ["title", "problem", "consequence", "fix"];

// Re-exported by board-reviews for converters and native readback alike.
export const nativeFindingId = (caseId, config, repeat, nativeBody) => createHash("sha256").update(JSON.stringify({ caseId, config, repeat, attempt: 1, nativeBody })).digest("hex");

export const judgeFieldsMissing = (f) => JUDGE_FIELDS.filter((k) => typeof f?.[k] !== "string" || f[k].trim() === "");
const lackingLines = (findings) =>
  findings
    .map((f) => ({ f, missing: judgeFieldsMissing(f) }))
    .filter((x) => x.missing.length > 0)
    .map(({ f, missing }) => `  ${f.caseId} finding (index ${f.index}, ${String(f.findingId).slice(0, 12)}) has no ${missing.join(", ")}`);

// One saved review's findings as Martian's judge reads them, in report
// order, each with its identity and severity. A finding without a title,
// problem, consequence or fix is refused, never sent.
export function martianFindings(caseId, report) {
  const out = shownFindings(report).map((f, index) => ({ findingId: findingId(caseId, f), caseId, index, severity: f.severity ?? null, category: f.category ?? null, tier: f.tier ?? "finding", title: f.title, problem: f.problem, consequence: f.consequence, fix: f.fix }));
  const lacking = lackingLines(out);
  if (lacking.length > 0) throw new Error(`these findings cannot be saved for Martian's judge, which reads title, problem, consequence and fix:\n${lacking.join("\n")}`);
  return out;
}

// One case's prose truth (lib/suites.mjs truthOf) as the golden comments an
// evaluation's matches name: "<case id>#<truth id>".
export function martianGolden(caseId, truth) {
  if (truth?.kind !== "prose") throw new Error(`${caseId}: Martian's golden comments are prose truth, not ${truth?.kind}`);
  return truth.items.map((t) => ({ goldenId: `${caseId}#${t.id}`, caseId, truthId: t.id, severity: t.severity, rawSeverity: t.rawSeverity, category: t.category, rawCategory: t.rawCategory }));
}

// Martian's official totals as score_profiles computes them for one tool:
// the beta of its F-beta, and per profile the ratios and the counts.
export const MARTIAN_TOTALS = Object.freeze({ profiles: ["strict", "core", "all"], ratios: ["precision", "recall", "f1", "fbeta"], counts: ["tp", "fp", "fn", "prs"] });

// Every field of the totals' shape that is missing or of the wrong kind,
// named by its path.
function totalsProblems(totals) {
  if (!totals || typeof totals !== "object") return ["totals is missing"];
  const out = [];
  const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
  if (!isNumber(totals.beta)) out.push(`totals.beta is ${totals.beta === undefined ? "missing" : "not a number"}`);
  for (const p of MARTIAN_TOTALS.profiles) {
    const t = totals[p];
    if (!t || typeof t !== "object") {
      out.push(`totals.${p} is missing`);
      continue;
    }
    for (const k of MARTIAN_TOTALS.ratios) if (!isNumber(t[k])) out.push(`totals.${p}.${k} is ${t[k] === undefined ? "missing" : "not a number"}`);
    for (const k of MARTIAN_TOTALS.counts) if (!Number.isInteger(t[k]) || t[k] < 0) out.push(`totals.${p}.${k} is ${t[k] === undefined ? "missing" : "not a count"}`);
  }
  return out;
}

// An evaluation.json read back: `findings` are every finding the run sent
// for this tool name (martianFindings, in report order), `golden` the golden
// comments of the cases it covers (martianGolden). Returns { toolName,
// board, judge, official, candidates, matches } as given, and `ours`.
export function readMartianEvaluation(evaluation, { findings, golden, isNative = () => false }) {
  const e = evaluation;
  const shape = [];
  if (!e || typeof e !== "object") throw new Error("the evaluation is not an object");
  if (e.version !== 1) shape.push(`its version is ${JSON.stringify(e.version)}, not 1`);
  if (typeof e.toolName !== "string" || e.toolName === "") shape.push("it names no toolName");
  if (typeof e.judge?.model !== "string") shape.push("it names no judge model");
  if (!Array.isArray(e.candidates)) shape.push("its candidates are not a list");
  if (!Array.isArray(e.matches)) shape.push("its matches are not a list");
  shape.push(...totalsProblems(e.totals));
  if (shape.length > 0) throw new Error(`the evaluation is not in Martian's shape (PLAN-benchmark 4.5): ${shape.join("; ")}`);

  const native = findings.filter((f) => f.source === "native" && isNative(f));
  if (new Set(native.map((f) => f.caseId)).size !== native.length) throw new Error("a control review must have one native source per case");
  for (const f of native) {
    if (typeof f.text !== "string" || !f.text.trim() || f.findingId !== nativeFindingId(f.caseId, f.config, f.repeat, f.text)) throw new Error(`the native source id of ${f.caseId} does not match its body or tool`);
  }
  const lacking = lackingLines(findings.filter((f) => !native.includes(f)));
  if (lacking.length > 0) throw new Error(`the evaluation of ${e.toolName} is not scored: these findings were saved for Martian's judge without what it reads:\n${lacking.join("\n")}`);
  const byFinding = new Map();
  for (const f of findings) if (!byFinding.has(f.findingId)) byFinding.set(f.findingId, f);
  const order = new Map([...byFinding.keys()].map((id, i) => [id, i]));
  const byGolden = new Map(golden.map((g) => [g.goldenId, g]));

  const problems = [];
  const byCandidate = new Map();
  for (const c of e.candidates) {
    const id = c?.candidateId;
    if (typeof id !== "string" || id === "") {
      problems.push(`a candidate has no candidateId (${JSON.stringify(c).slice(0, 80)})`);
      continue;
    }
    if (byCandidate.has(id)) problems.push(`candidate ${id} is listed twice`);
    if (typeof c.extractedText !== "string" || !c.extractedText.trim()) problems.push(`candidate ${id} has no saved text`);
    if (typeof c.officialFp !== "boolean") problems.push(`candidate ${id} has no official false positive verdict`);
    if (!Array.isArray(c.sourceFindingIds) || c.sourceFindingIds.length === 0) problems.push(`candidate ${id} names no source finding`);
    for (const f of Array.isArray(c.sourceFindingIds) ? c.sourceFindingIds : []) if (!byFinding.has(f)) problems.push(`candidate ${id} names finding ${String(f).slice(0, 12)}, which the run did not send`);
    if (!c.extraction || typeof c.extraction !== "object") problems.push(`candidate ${id} has no extraction provenance`);
    byCandidate.set(id, c);
  }
  // The case a candidate came from: the case of every finding it names.
  const caseOfCandidate = (c) => [...new Set((Array.isArray(c.sourceFindingIds) ? c.sourceFindingIds : []).map((f) => byFinding.get(f)?.caseId).filter(Boolean))];
  for (const c of byCandidate.values()) if (caseOfCandidate(c).length > 1) problems.push(`candidate ${c.candidateId} names findings of more than one case (${caseOfCandidate(c).join(", ")})`);
  for (const m of e.matches) {
    if (!byCandidate.has(m?.candidateId)) problems.push(`a match names candidate ${JSON.stringify(m?.candidateId)}, which is not among the candidates`);
    if (!byGolden.has(m?.goldenId)) problems.push(`a match names golden comment ${JSON.stringify(m?.goldenId)}, which is not among the golden comments given`);
    if (!MARTIAN_VERDICTS.includes(m?.verdict)) problems.push(`a match has the verdict ${JSON.stringify(m?.verdict)}, not one of ${MARTIAN_VERDICTS.join(", ")}`);
    if (byCandidate.has(m?.candidateId) && byGolden.has(m?.goldenId)) {
      const from = caseOfCandidate(byCandidate.get(m.candidateId));
      const to = byGolden.get(m.goldenId).caseId;
      if (from.length === 1 && from[0] !== to) problems.push(`a match links candidate ${m.candidateId} (findings of ${from[0]}) to golden comment ${m.goldenId} of another pull request (${to})`);
    }
  }
  if (problems.length > 0) throw new Error(`the evaluation of ${e.toolName} does not hold together:\n  ${problems.join("\n  ")}`);

  // The findings behind each found golden comment, by distinct id.
  const behind = new Map();
  const matched = new Set();
  for (const m of e.matches.filter((x) => x.verdict === "match")) {
    if (!behind.has(m.goldenId)) behind.set(m.goldenId, new Set());
    for (const f of byCandidate.get(m.candidateId).sourceFindingIds) {
      behind.get(m.goldenId).add(f);
      matched.add(f);
    }
  }
  if (behind.size !== e.totals.all.tp) throw new Error(`the official totals count ${e.totals.all.tp} golden comments found (all profile), but the matches name ${behind.size}: a match was lost or added on the way from Martian's evaluations, so our numbers would not rest on the official matches`);
  // withmartian/code-review-benchmark@e616e849755441da38f18bf3adba2c9583b03803:
  // offline/analysis/score_profiles.py:19-25,103-120 includes only core
  // golden categories in TP/FN, and every FP, even a match outside core.
  // offline/code_review_benchmark/step3_judge_comments.py:304-331,357-358
  // keys candidates by text within a PR and spares matched dedup siblings.
  // A superseded winner also stays matched, so FP verdicts come from
  // Martian's saved false_positives, not just the final winning matches.
  const coreCategories = new Set(["bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect"]);
  const coreGolden = golden.filter((g) => coreCategories.has(g.rawCategory));
  const tp = coreGolden.filter((g) => behind.has(g.goldenId)).length;
  const fn = coreGolden.length - tp;
  const foundCandidates = new Set(e.matches.filter((m) => m.verdict === "match").map((m) => m.candidateId));
  const sameCase = (a, b) => caseOfCandidate(a)[0] === caseOfCandidate(b)[0];
  const falsePositives = e.candidates.filter((c) => c.officialFp);
  for (const c of falsePositives) {
    if (e.candidates.some((m) => foundCandidates.has(m.candidateId) && sameCase(c, m) && (m.extractedText === c.extractedText || (m.dedupGroup !== null && m.dedupGroup !== undefined && m.dedupGroup === c.dedupGroup)))) throw new Error(`candidate ${c.candidateId} is an official false positive but is a winning match or its dedup sibling`);
  }
  const fp = new Set(falsePositives.map((c) => JSON.stringify([caseOfCandidate(c)[0], c.extractedText]))).size;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  for (const [key, count] of Object.entries({ tp, fp, fn, precision, recall, f1 })) {
    if (Math.abs(e.totals.core[key] - count) > 1e-12) throw new Error(`the core ${key} is ${e.totals.core[key]}, but the saved matches and candidates give ${count}`);
  }
  const judged = golden
    .filter((g) => behind.has(g.goldenId))
    .map((g) => {
      const first = [...behind.get(g.goldenId)].sort((a, b) => order.get(a) - order.get(b))[0];
      const f = byFinding.get(first);
      const s = severityAgreement(f.severity, g.severity);
      return { goldenId: g.goldenId, caseId: g.caseId, truthId: g.truthId, severity: g.severity, findingId: first, findingIndex: f.index, given: f.severity, severityAgreement: s.agreement, severityDirection: s.direction };
    });
  const copy = (v) => (v === undefined ? null : structuredClone(v));
  return {
    toolName: e.toolName,
    board: copy(e.board),
    judge: copy(e.judge),
    official: copy(e.totals),
    candidates: copy(e.candidates),
    matches: copy(e.matches),
    ours: {
      label: MARTIAN_LABEL,
      judge: copy(e.judge),
      golden: { found: behind.size, of: golden.length },
      findings: { sent: byFinding.size, matched: matched.size },
      candidates: { extracted: e.candidates.length, findings: byFinding.size },
      severity: severitySummary(judged.map((j) => ({ severity: j.given, severityExpected: j.severity, severityAgreement: j.severityAgreement, severityDirection: j.severityDirection }))),
      byGolden: judged,
    },
  };
}
