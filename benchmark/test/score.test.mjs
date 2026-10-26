// The scorer decides what the benchmark says about a build, so it is checked
// against hand-written reports whose right score is known: an exact hit, a
// finding in the right place about something else, a duplicate, a near miss
// by one line, a wrong kind, two bugs on one line, a bug found at its second
// location, an accepted side issue, a request for a test, a false finding, a
// clean change (complete, incomplete and missing), and what a brief did and
// did not say. Score format 3 is checked on runs made in temp folders by the
// runner's own code (executeRun, with the review step that would call a
// model replaced): its population of planned first attempts, its rules
// block, the planted-only precision kept apart, the severity each found bug
// was given against its own, and who found it, judged from the review's
// saved scan.json rather than from the spec's expected finder.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RULES, RULES_VERSION, classify, lineMatches, regressions, ruleCodeHash, ruleSources, rulesDifferences, rulesHash, runDifferences, scannerPlaces, scoreBrief, scoreJob, scoreSample, specDifferences, summarize, summarizeJobs, value } from "../lib/score.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { loadRun, renderV3, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const bug = (id, file, lines, anchorLine, kind, severity, mentions, extra = {}) => ({ id, file, lines, anchor: { line: anchorLine, text: "x" }, mentions, kind, severity, found_by: ["reasoning"], truth: "t", ...extra });

const spec = {
  id: "hand",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  graph: { gaps: [{ file: "src/router.js", line: 7, cause: "dynamic" }], floors: ["src/handlers.js#onSave"], callers: ["src/cart.ts:8"] },
  bugs: [
    bug("sqli", "app/search.py", [14, 14], 14, ["security"], "critical", ["sql", "injection"]),
    bug("off-by-one", "app/server.py", [23, 23], 23, ["bug"], "major", ["offset", "skip"]),
    bug("root", "Dockerfile", [3, 11], 11, ["security"], "major", ["root"]),
    bug("apt", "Dockerfile", [3, 3], 3, ["maintainability", "security"], "minor", ["apt", "-y"]),
    bug("lodash", "package-lock.json", [11, 17], 11, ["security"], "major", ["lodash"], { also: [{ file: "package.json", lines: [7, 7] }] }),
  ],
  extras: [{ file: "app/server.py", lines: [30, 32], mentions: ["connection"], why: "a real side issue" }],
};

const finding = (file_path, line_number, category, title, extra = {}) => ({ origin: "agent", severity: "major", category, confidence: 0.9, file_path, line_number, line_end: line_number, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: title, consequence: "c", fix: "f", ...extra });

const report = (findings, extra = {}) => ({
  version: 1,
  kind: "review",
  verdict: "passed",
  findings,
  outside_change: [],
  dropped: [],
  scanners: [],
  impact: { status: "ok", build: { durationMs: 100 } },
  completion: { status: "complete", missing: [], reviewer: { duration_ms: 60_000, rounds: 1, usage: { turns: 9, input_tokens: 100_000, output_tokens: 5_000, cost_usd: 0.5 } } },
  ...extra,
});

const brief = [
  "# Review brief",
  "",
  "## What this change reaches",
  "",
  "Call sites of the touched and removed code, certain first:",
  "- src/cart.ts:8 in `cartTotal` calls `formatPrice` (1 hop, certain)",
  "",
  "What the graph could not see:",
  "- The callers of `onSave` are a floor: 1 call goes through a value (a callback or a computed member) in the repository root project, and could reach it.",
  "- In the changed files and their callers' files, 1 call site could not be bound (1 no-receiver-type):",
  "  - src/handlers.js:7 `set`: no-receiver-type",
  "",
  "## The changed lines",
].join("\n");

describe("matching one finding to a planted bug", () => {
  it("counts a finding on the planted line, of a planted kind, that names the issue, as a hit", () => {
    expect(classify(finding("app/search.py", 14, "security", "SQL injection"), spec)).toEqual({ outcome: "hit", bug: "sqli" });
  });

  it("does not count a finding in the right place and of the right kind that is about something else", () => {
    expect(classify(finding("app/search.py", 14, "security", "Hardcoded timeout"), spec)).toEqual({ outcome: "false" });
  });

  it("never counts a hit for a plant that has no words to match, whatever the place and kind", () => {
    const bare = { ...spec, bugs: [{ ...spec.bugs[0], mentions: undefined }] };
    expect(classify(finding("app/search.py", 14, "security", "SQL injection"), bare).outcome).toBe("false");
  });

  it("calls a finding one line below the planted line a near miss, not a hit", () => {
    expect(classify(finding("app/server.py", 24, "bug", "page offset skips the first page"), spec)).toEqual({ outcome: "near", bug: "off-by-one", distance: 1 });
  });

  it("calls a finding on the planted line that names the issue with a kind the bug does not have a wrong kind, not a hit", () => {
    expect(classify(finding("app/search.py", 14, "performance", "slow SQL query"), spec)).toEqual({ outcome: "wrong-kind", bug: "sqli", expected: ["security"] });
  });

  it("gives a finding on a line two bugs share to the bug whose words it uses", () => {
    expect(classify(finding("Dockerfile", 3, "security", "The container runs as root"), spec).bug).toBe("root");
    expect(classify(finding("Dockerfile", 3, "maintainability", "apt-get install has no -y"), spec).bug).toBe("apt");
  });

  it("finds a bug at its second location, with the path written another way", () => {
    expect(classify(finding("./package.json", 7, "security", "lodash 4.17.15 is vulnerable"), spec)).toEqual({ outcome: "hit", bug: "lodash" });
  });

  it("leaves out a listed side issue that names its own words, and calls one without them false", () => {
    expect(classify(finding("app/server.py", 31, "bug", "connection leak"), spec).outcome).toBe("accepted");
    expect(classify(finding("app/server.py", 31, "bug", "variable naming"), spec).outcome).toBe("false");
    expect(classify(finding("app/other.py", 5, "style", "naming"), spec).outcome).toBe("false");
  });

  it("checks accepted side issues before plants, so one finding cannot be both", () => {
    const both = { ...spec, extras: [{ file: "app/search.py", lines: [14, 14], mentions: ["logged"], why: "the query is logged" }] };
    expect(classify(finding("app/search.py", 14, "security", "SQL injection text is logged"), both).outcome).toBe("accepted");
  });

  it("checks a request for a test first, by its words and its kind, even on a planted bug's lines", () => {
    expect(classify(finding("app/other.py", 5, "maintainability", "Changed formatting has no covering test"), spec).outcome).toBe("test-gap");
    expect(classify(finding("app/search.py", 9, "maintainability", "Missing tests for the SQL query", { line_end: 17 }), spec).outcome).toBe("test-gap");
    // The same words as a bug finding are not a request for a test.
    expect(classify(finding("app/search.py", 14, "bug", "Missing tests for the SQL query"), spec).outcome).toBe("wrong-kind");
  });

  it("calls a request for a test false on a clean case, which ships its tests", () => {
    expect(classify(finding("src/a.ts", 5, "maintainability", "Changed formatting has no covering test"), { ...spec, clean: true, bugs: [], extras: [] })).toEqual({ outcome: "false", testOnly: true });
  });
});

describe("scoring one review", () => {
  const findings = [
    finding("app/search.py", 14, "security", "SQL injection"),
    finding("app/search.py", 14, "security", "SQL injection again"),
    finding("app/server.py", 24, "bug", "page offset skips the first page"),
    finding("Dockerfile", 3, "security", "The container runs as root"),
    finding("Dockerfile", 3, "maintainability", "apt-get install has no -y"),
    finding("package.json", 7, "security", "lodash 4.17.15 is vulnerable", { candidate: "c3", source: "osv-scanner:GHSA" }),
    finding("app/server.py", 31, "bug", "connection leak"),
    finding("app/other.py", 5, "style", "naming"),
    finding("app/search.py", 14, "performance", "slow SQL query"),
  ];
  const s = scoreSample({ spec, report: report(findings), brief, row: { config: "claude-graph-on", repeat: 1, wallMs: 90_000 } });

  it("counts bugs found, not findings, and by severity", () => {
    expect(s.recall).toEqual({ hit: 4, of: 5 });
    expect(s.bySeverity.critical).toEqual({ hit: 1, of: 1 });
    expect(s.bySeverity.major).toEqual({ hit: 2, of: 3 });
    expect(s.bySeverity.minor).toEqual({ hit: 1, of: 1 });
  });

  it("counts a duplicate hit apart, so it never raises precision", () => {
    expect(s.precision).toEqual({ hit: 4, of: 7 });
    expect([s.duplicates, s.falseFindings, s.nearMisses, s.wrongKinds, s.accepted]).toEqual([1, 1, 1, 1, 1]);
    expect(s.findings.filter((f) => f.outcome === "duplicate").map((f) => f.title)).toEqual(["SQL injection again"]);
  });

  it("records how each bug was found or missed", () => {
    const by = Object.fromEntries(s.bugs.map((b) => [b.id, b]));
    expect(by.sqli).toMatchObject({ found: true, duplicates: 1, via: "reviewer", wrongKind: ["performance"] });
    expect(by["off-by-one"]).toMatchObject({ found: false, near: [1] });
    expect(by.lodash).toMatchObject({ found: true, via: "scanner" });
  });

  it("reads time, turns, tokens and cost from the saved report and row", () => {
    expect([s.wallMs, s.reviewerMs, s.turns, s.inputTokens, s.costUsd]).toEqual([90_000, 60_000, 9, 100_000, 0.5]);
  });

  it("scores a missing report as a review that missed every bug", () => {
    const failed = scoreSample({ spec, report: null, brief: null });
    expect(failed.status).toBe("failed");
    expect(failed.recall).toEqual({ hit: 0, of: 5 });
  });
});

describe("a clean change", () => {
  const clean = { id: "clean", guards: "g", language: "typescript", framework: "none", clean: true, bugs: [] };
  it("passes its control only when the review completed with no finding", () => {
    expect(scoreSample({ spec: clean, report: report([]), brief: null }).controls).toEqual({ hit: 1, of: 1 });
    const incomplete = report([], { completion: { status: "incomplete", missing: ["the reviewer timed out and was stopped"], reviewer: null } });
    expect(scoreSample({ spec: clean, report: incomplete, brief: null }).controls).toEqual({ hit: 0, of: 1 });
  });
  it("fails its control with any finding, which counts as false", () => {
    const one = scoreSample({ spec: clean, report: report([finding("src/a.ts", 3, "bug", "a guess")]), brief: null });
    expect(one.controls).toEqual({ hit: 0, of: 1 });
    expect(one.precision).toEqual({ hit: 0, of: 1 });
    expect(one.falseFindings).toBe(1);
  });
  it("fails its control when the review wrote no report", () => {
    expect(scoreSample({ spec: clean, report: null, brief: null }).controls).toEqual({ hit: 0, of: 1 });
  });
});

describe("what the brief told the reviewer", () => {
  it("counts a floor and a caller the brief names, and not a gap site it leaves out", () => {
    const b = scoreBrief(spec, brief);
    expect(b.graph).toBe("on");
    expect(b.gaps).toEqual({ hit: 1, of: 2 });
    expect(b.callers).toEqual({ hit: 1, of: 1 });
    expect(b.failures).toEqual(["the brief does not name the dynamic call at src/router.js:7 as unseen"]);
  });
  it("gives a brief with the graph off no credit", () => {
    const off = scoreBrief(spec, "## What this change reaches\n\nThe code graph is off for this review.\n");
    expect(off.graph).toBe("off");
    expect(off.gaps).toEqual({ hit: 0, of: 2 });
    expect(off.callers).toEqual({ hit: 0, of: 1 });
  });
});

describe("summing and comparing runs", () => {
  const sample = (found, config = "claude-graph-on") => scoreSample({ spec, report: report(found ? [finding("app/search.py", 14, "security", "SQL injection")] : []), brief, row: { config, repeat: 1, wallMs: 1000 } });

  it("sums ratios as hits over checks, never averages of averages", () => {
    const t = summarize([sample(true), sample(false), sample(false)]);
    expect(t.recall).toEqual({ hit: 1, of: 15 });
    expect(value(t.recall)).toBeCloseTo(1 / 15);
    expect(t.wallMs).toMatchObject({ n: 3, mean: 1000 });
  });

  it("reports a bug found in every earlier review and missed in two of three now as a regression, and one miss as no regression", () => {
    const before = [sample(true), sample(true), sample(true)];
    expect(regressions(before, [sample(true), sample(false), sample(false)]).map((r) => r.bug)).toContain("sqli");
    expect(regressions(before, [sample(true), sample(true), sample(false)]).map((r) => r.bug)).not.toContain("sqli");
  });

  const base = {
    reviewer: { name: "claude", version: "2.1.294", model: "m1" },
    reviewers: { claude: { name: "claude", version: "2.1.294", model: "m1" } },
    machine: { platform: "darwin", arch: "arm64", cpu: "M5", cpus: 15, memoryGb: 48, node: "v22.23.3" },
    review: { web: "on", timeoutSeconds: 900 },
    concurrency: 1,
    cases: ["a"],
    repeat: 3,
    configs: ["x"],
  };

  it("names every setting besides the build that differs, before any comparison", () => {
    expect(runDifferences(base, base)).toEqual([]);
    const other = {
      ...base,
      reviewers: { ...base.reviewers, codex: { name: "codex", version: "0.161.0", model: "gpt-6.1-sol" } },
      machine: { ...base.machine, cpu: "M4" },
      review: { web: "off", timeoutSeconds: 600 },
      concurrency: 3,
    };
    const said = runDifferences(base, other).join("\n");
    for (const word of ["reviewers", "machine", "concurrency", "web", "timeout"]) expect(said).toContain(word);
  });

  it("names an edited case, by its files or by its spec, before any comparison", () => {
    const a = { ...base, caseHashes: { x: "1" } };
    expect(runDifferences(a, { ...a, caseHashes: { x: "2" } })).toEqual(["the case x changed between the runs (its files or its spec)"]);
    expect(specDifferences({ x: spec }, { x: { ...spec, extras: [] } })).toEqual(["the spec of x differs between the runs"]);
    expect(specDifferences({ x: spec }, { x: spec })).toEqual([]);
  });
});

// --- score format 3 ---

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const HASH = "ab".repeat(32);
const CASE_ID = `planted/hand@${HASH.slice(0, 8)}`;
const CONFIG = "claude-graph-on";

// The jobs run.mjs plans for the hand case: one configuration, `repeat` repeats.
const planned = (repeat) => planJobs({ cases: ["hand"], caseIds: { hand: CASE_ID }, reviewers: ["claude"], graph: ["on"], repeat }).jobs;

// The manifest run.mjs writes for the hand case, from its settings and plan.
const handManifest = (jobs, repeat) =>
  runManifest({
    startedAt: "2026-10-10T10:00:00.000Z",
    settings: { build: { commit: "a".repeat(40), short: "aaaaaaa", dirty: false, cliVersion: "0.14.0" }, reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } }, cases: ["hand"], caseIds: [CASE_ID], caseHashes: { hand: HASH }, configs: [CONFIG], repeat },
    jobs,
  });

// A run of the hand case made by the runner's own code (executeRun writes
// the manifest and the spec copy), with each review replaced by the
// attempts given: one folder per attempt (a retry is <repeat>-attempt<n>),
// each with its sample.json and, when the review wrote one, its report. A
// repeat with no attempt given never starts.
async function savedRun({ repeat, attempts, caseSpec = spec }) {
  const root = tempDir("oq-bench-v3-");
  const out = join(root, "run");
  write(join(root, "hand.json"), JSON.stringify(caseSpec));
  const jobs = planned(repeat);
  await executeRun({ out, manifest: handManifest(jobs, repeat), jobs, copies: [[join(root, "hand.json"), "cases/hand.json"]], runJob: async (job) => {
    for (const a of attempts.filter((x) => x.repeat === job.repeat)) {
      const dir = attemptDir(out, job, a.attempt);
      const rec = sampleRecord({ job, attempt: a.attempt, result: { code: a.report ? 0 : 2, signal: null, wallMs: 30_000 }, report: a.report, who: null, startedAt: "t", failure: a.report ? null : { cause: "no report.json" }, stopped: null });
      write(join(dir, "sample.json"), JSON.stringify(rec));
      if (a.report) write(join(dir, "report", "report.json"), JSON.stringify(a.report));
      if (a.scan) write(join(dir, "report", "scan.json"), JSON.stringify(a.scan));
    }
  } });
  return out;
}

const SQLI = finding("app/search.py", 14, "security", "SQL injection");
const ASK = finding("app/other.py", 5, "maintainability", "Changed formatting has no covering test");

describe("a rule constant changes without a version bump, and old and new scores are compared as equal", () => {
  // One hash per rules version (both branch hashes for version 10), added and never
  // edited: a change to a constant, a list, the rule order or the matching
  // code changes the hash, and this test fails until RULES_VERSION is bumped
  // in lib/score.mjs and the new version's hash is added here.
  // A change of layout alone moves the hash too, and needs a bump all the same.
  const KNOWN_RULES = {
    // Scanner outside advisories are information; legacy untagged findings still count.
    9: "b6578e57058519e7bc379a35538cf57ca94be81bd4a830c2ab34d310922af96f",
    3: "b40f43b5367a2a50e37ac61c4135f801da2dbb3406425127f4ab45049ab1027d",
    // Severity agreement and the finder of each found truth item.
    4: "01790c27b9e182e7c6b4c142c8e04a0c020eb5f739bd0efab7c601b6877963db",
    // A person's rulings and the location match of an unlisted finding.
    5: "ff7b2ece2aff21df3b948e5bd849d872dfba298cfa928203e784780061050511",
    // Pull request truth: matched on its categories when it has no kind, and no severity tally without a severity.
    6: "b796da57c0aae63538f12bf8f3aa1139219da6a2f2a8ef7e4ccdd04c0b737536",
    // Issue 143: a custom scanner's rule is that scanner's whatever its id, and own rules are a map with no prototype.
    // Issue 142: a model review's cost and tokens are its sample record's usage.
    7: "6aaf49035cb10f73a3129b8abfe6d976eece2d29f70935432d07528432d17a48",
    // A ruling on a truth item names the spec version it judged (issue 163), and a same-issue ruling may name the item it joins (issue 139).
    8: "ceffd087b47c7882e4bcdf8023aac05a165c1f7b0c270af4e81c1637b1069520",
    // Version 10 existed independently on wave8 (Greptile) and main (observation tiers).
    10: ["e4582b7f4f7e8ed377e132c5f2db92403faeb9e9a975ff87b15eca07de0f7ef8", "db58981fc3b76ed4693dd1dccf178df33d8df2071f16263359b4bb927f2fec3f"],
    // Version 11 merges the two version-10 rule sets.
    11: "2b889794bb039585e502a3221d25890da2d1e2adf015a4be4462973de502da3e",
    // A finding with no line number (null or undefined) reads as the whole file, issue 153.
    12: "ae1fe1759e260551b95a195aa208f18c94c980d5e5394b8778c1db3341d8c79a",
  };

  it("pins the hash of the rules block, constants and matching code included, to its version", () => {
    expect(RULES.version).toBe(RULES_VERSION);
    expect(RULES.hash).toBe(rulesHash(RULES));
    expect(RULES.hash, "a scoring rule changed: bump RULES_VERSION in lib/score.mjs and add the new version's hash to KNOWN_RULES").toBe(KNOWN_RULES[RULES_VERSION]);
    // score.mjs runs in plain Node, not in the test runner, and must write the hash pinned here.
    const url = new URL("../lib/score.mjs", import.meta.url).href;
    const inNode = execFileSync(process.execPath, ["--input-type=module", "-e", `import { RULES } from ${JSON.stringify(url)}; process.stdout.write(RULES.hash);`], { encoding: "utf8" });
    expect(inNode).toBe(RULES.hash);
  });

  it("changes the hash when any rule changes: a constant, the test-only lists, the rule order, the precision table or the code", () => {
    const changes = [{ nearLines: 4 }, { aacrLineK: 2 }, { testOnly: { ...RULES.testOnly, kinds: ["style"] } }, { order: [...RULES.order].reverse() }, { precision: { ...RULES.precision, wrong: ["false", "near"] } }, { code: "0".repeat(64) }];
    for (const change of changes) expect(rulesHash({ ...RULES, ...change })).not.toBe(RULES.hash);
  });

  it("hashes the attempt selection and every helper a rule calls, in this file or one it imports, and moves the hash when any of them changes", () => {
    const here = dirname(fileURLToPath(new URL("../lib/score.mjs", import.meta.url)));
    const read = (file) => readFileSync(join(here, file), "utf8");
    const sources = ruleSources(read);
    const ids = sources.map((s) => s.id);
    // The word matcher's escape, the folder-name rule for first attempts and retries, the scoring of a run's attempts, and the case id parser in cases.mjs.
    for (const id of ["score.mjs#escape", "score.mjs#attemptOf", "score.mjs#scoreAttempts", "score.mjs#population", "cases.mjs#parseCaseId"]) expect(ids).toContain(id);
    expect(ruleCodeHash(read)).toBe(RULES.code);
    for (const { id, text } of sources) {
      const [file] = id.split("#");
      const first = text.split("\n")[0];
      const mutated = (f) => (f === file ? read(f).replace(first, `${first} void 0;`) : read(f));
      expect(ruleCodeHash(mutated), `a change to ${id} must move the rules hash`).not.toBe(RULES.code);
    }
  });

  it("never calls two scores comparable when their rules differ, under one version or two", () => {
    expect(rulesDifferences(RULES, RULES)).toEqual([]);
    const edited = { ...RULES, nearLines: 4 };
    edited.hash = rulesHash(edited);
    expect(rulesDifferences(RULES, edited).join("\n")).toMatch(/without a version bump/);
    expect(rulesDifferences(RULES, { ...edited, version: RULES_VERSION + 1 }).join("\n")).toMatch(new RegExp(`version ${RULES_VERSION} then ${RULES_VERSION + 1}`));
    // A score written before the rules block (format 2) has no rules to compare.
    expect(rulesDifferences(RULES, undefined)).not.toEqual([]);
  });

  it("writes the rules block into every score", async () => {
    const { score } = scoreRun(loadRun(await savedRun({ repeat: 1, attempts: [{ repeat: 1, attempt: 1, report: report([SQLI]) }] })));
    expect(score.version).toBe(3);
    expect(score.rules).toEqual(RULES);
  });
});

describe("a job that never started leaves the denominator", () => {
  it("has the runner write the full manifest, every planned job with its id, before the first review starts, and every attempt name its job", async () => {
    const root = tempDir("oq-bench-plan-");
    write(join(root, "hand.json"), JSON.stringify(spec));
    const { jobs } = planJobs({ cases: ["hand", "other"], caseIds: { hand: CASE_ID, other: "planted/other@12345678" }, reviewers: ["claude"], graph: ["off", "on"], repeat: 2 });
    expect(jobs[0]).toMatchObject({ jobId: `${CASE_ID}/claude-graph-off/1`, caseId: CASE_ID, case: "hand", config: "claude-graph-off", repeat: 1 });
    const out = join(root, "run");
    const seen = [];
    await executeRun({ out, manifest: handManifest(jobs, 2), jobs, copies: [[join(root, "hand.json"), "cases/hand.json"]], runJob: async () => {
      seen.push(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")));
    } });
    expect(seen).toHaveLength(8);
    expect(seen[0]).toMatchObject({ version: 3, rulesVersion: RULES_VERSION, planned: 8, ended: null });
    expect(seen[0].jobs).toEqual(jobs.map(({ jobId, caseId, config, repeat }) => ({ jobId, caseId, config, repeat })));
    const retry = sampleRecord({ job: jobs[0], attempt: 2, result: { code: 0, signal: null, wallMs: 1 }, report: null, who: null, startedAt: "t", failure: null, stopped: null });
    expect(retry).toMatchObject({ jobId: jobs[0].jobId, caseId: CASE_ID, firstAttempt: false });
  });

  it("counts a planned job with no attempt as unstarted: it misses every bug of its case and adds no finding", async () => {
    const { score, outcomes } = scoreRun(loadRun(await savedRun({ repeat: 2, attempts: [{ repeat: 1, attempt: 1, report: report([SQLI]) }] })));
    const c = score.byConfig[CONFIG];
    expect(c.population).toEqual({ planned: 2, complete: 1, incomplete: 0, failed: 0, unstarted: 1, retries: 0, retryCostUsd: 0 });
    expect(score.population).toMatchObject({ planned: 2, unstarted: 1, jobsFrom: "manifest" });
    // One case is too few clusters for an interval.
    expect(c.issueRecall.all).toEqual({ hit: 1, of: 10, ci: null });
    expect(c.precision.lower).toEqual({ hit: 1, of: 1, ci: null });
    expect(score.perBug[CONFIG][CASE_ID].sqli.found).toEqual([true, false]);
    expect(score.perCase[CONFIG][CASE_ID].issueRecall).toEqual({ hit: 1, of: 10 });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ jobId: `${CASE_ID}/${CONFIG}/1`, caseId: CASE_ID, outcome: "hit", truthId: "sqli", evidenceKind: "frozen" });
    expect(outcomes[0].findingId).toMatch(/^[0-9a-f]{64}$/);
    // Counting only the saved attempts, as format 2 did, the job vanishes; the difference is stated.
    expect(c.allAttempts.recall).toEqual({ hit: 1, of: 5 });
    expect(renderV3(score)).toMatch(/every saved attempt/);
  });
});

describe("a successful retry replaces a failed first attempt", () => {
  it("scores the failed first attempt as a miss, and the retry only as a diagnostic with its cost", async () => {
    const { score, outcomes } = scoreRun(loadRun(await savedRun({ repeat: 1, attempts: [{ repeat: 1, attempt: 1, report: null }, { repeat: 1, attempt: 2, report: report([SQLI]) }] })));
    const c = score.byConfig[CONFIG];
    expect(c.population).toEqual({ planned: 1, complete: 0, incomplete: 0, failed: 1, unstarted: 0, retries: 1, retryCostUsd: 0.5 });
    expect(c.issueRecall.all).toEqual({ hit: 0, of: 5, ci: null });
    expect(c.precision.lower).toEqual({ hit: 0, of: 0, ci: null });
    expect(score.perBug[CONFIG][CASE_ID].sqli.found).toEqual([false]);
    expect(outcomes).toEqual([]);
    // Format 2 scored both attempts; the difference is stated.
    expect(c.allAttempts.recall).toEqual({ hit: 1, of: 10 });
    expect(renderV3(score)).toMatch(/every saved attempt/);
  });
});

describe("a planted-only precision with test requests set apart is pooled with real-suite precision", () => {
  const job = (origin, repeat) => scoreJob({ job: { jobId: `${origin}/hand@abababab/c/${repeat}`, caseId: `${origin}/hand@abababab`, config: "c", repeat }, spec, report: report([SQLI, ASK]), brief: null, origin });

  it("keeps today's planted rule, with the planted case's test request, in its own labelled block", () => {
    const planted = summarizeJobs([job("planted", 1)]);
    expect(planted.plantedLegacy.precision).toEqual({ hit: 1, of: 1 });
    expect(planted.plantedLegacy.testGaps).toBe(1);
    expect(planted.plantedLegacy.label).toMatch(/planted/);
    expect(planted.outcomes["test-gap"]).toBe(1);
  });

  it("leaves the precision bounds untouched by a planted-suite test request, and widens them with a real-suite one", () => {
    const hitOnly = summarizeJobs([scoreJob({ job: { jobId: "planted/hand@abababab/c/1", caseId: "planted/hand@abababab", config: "c", repeat: 1 }, spec, report: report([SQLI]), brief: null, origin: "planted" })]);
    const planted = summarizeJobs([job("planted", 1)]);
    expect(planted.precision).toEqual(hitOnly.precision);
    expect(planted.uniqueIssuePrecision).toEqual(hitOnly.uniqueIssuePrecision);
    expect(planted.redundancy).toEqual(hitOnly.redundancy);
    // On a real pull request the request for a test is a shown finding nothing frozen rules on: wrong in the lower bound, right in the upper.
    const real = summarizeJobs([job("real", 1)]);
    expect(real.precision.lower).toEqual({ hit: 1, of: 2 });
    expect(real.precision.upper).toEqual({ hit: 2, of: 2 });
    expect(real.outcomes).toMatchObject({ hit: 1, unresolved: 1 });
  });

  it("gives a real suite no planted block, and pools planted and real findings under one rule", () => {
    const real = summarizeJobs([job("real", 1)]);
    expect(real.plantedLegacy).toBeNull();
    const pooled = summarizeJobs([job("planted", 1), job("real", 2)]);
    expect(pooled.precision.lower).toEqual({ hit: 2, of: 3 });
    expect(pooled.precision.upper).toEqual({ hit: 3, of: 3 });
    expect(pooled.plantedLegacy.precision).toEqual({ hit: 1, of: 1 });
    expect(pooled.plantedLegacy.testGaps).toBe(1);
  });
});

describe("a finding on a clean case that a listed side issue matches is counted correct, and the control passes", () => {
  it("makes every finding on a clean case false, and fails the control on any shown finding", () => {
    const clean = { id: "clean", guards: "g", language: "python", framework: "none", clean: true, bugs: [], extras: [{ file: "app/server.py", lines: [30, 32], mentions: ["connection"], why: "listed by mistake" }] };
    const j = scoreJob({ job: { jobId: "planted/clean@abababab/c/1", caseId: "planted/clean@abababab", config: "c", repeat: 1 }, spec: clean, report: report([finding("app/server.py", 31, "bug", "connection leak")]), brief: null, origin: "planted" });
    expect(j.findings.map((f) => f.outcome)).toEqual(["false"]);
    const s = summarizeJobs([j]);
    expect(s.precision.lower).toEqual({ hit: 0, of: 1 });
    expect(s.precision.upper).toEqual({ hit: 0, of: 1 });
    expect(s.controls).toEqual({ hit: 0, of: 1 });
    expect(s.cleanFindingsPerCase).toEqual({ findings: 1, cases: 1 });
  });
});

describe("a legacy run's published folder is written over through --out", () => {
  // A folder named for a legacy run (benchmark/legacy/recipes.json), with a run and the stored score its own scorer wrote.
  function legacyFolder(root, runId) {
    const out = join(root, runId);
    write(join(out, "manifest.json"), JSON.stringify({ version: 2, cases: ["hand"], configs: [CONFIG], repeat: 1 }));
    write(join(out, "cases", "hand.json"), JSON.stringify(spec));
    write(join(out, "samples", "hand", CONFIG, "1", "sample.json"), JSON.stringify({ case: "hand", config: CONFIG, repeat: 1, attempt: 1, status: "complete" }));
    write(join(out, "samples", "hand", CONFIG, "1", "report", "report.json"), JSON.stringify(report([SQLI])));
    write(join(out, "score.json"), "stored by its own scorer\n");
    return out;
  }
  const scoreMjs = fileURLToPath(new URL("../score.mjs", import.meta.url));
  const score = (...args) => spawnSync(process.execPath, [scoreMjs, ...args], { encoding: "utf8" });

  it("refuses --out at the run's own folder, inside it, or at another legacy run's folder, and writes nothing there", () => {
    const root = tempDir("oq-bench-legacy-");
    const run = legacyFolder(root, "2026-10-09-5227579");
    const other = legacyFolder(root, "2026-10-08-752b77f");
    for (const dest of [run, join(run, "v3"), other, join(run, "..", "2026-10-08-752b77f")]) {
      const r = score(run, "--out", dest);
      expect(r.status, dest).toBe(2);
      expect(r.stderr).toMatch(/legacy run/);
    }
    expect(score(run).status).toBe(2);
    expect(readFileSync(join(run, "score.json"), "utf8")).toBe("stored by its own scorer\n");
    expect(readFileSync(join(other, "score.json"), "utf8")).toBe("stored by its own scorer\n");
    const elsewhere = join(root, "v3-scores");
    expect(score(run, "--out", elsewhere).status).toBe(0);
    expect(JSON.parse(readFileSync(join(elsewhere, "score.json"), "utf8")).version).toBe(3);
  });
});

// --- severity agreement and the finder of each found bug (rules version 4) ---

// One review of one case, saved with its report and, when given, its scan.json.
const reviewed = async (caseSpec, rep, scan = null) => scoreRun(loadRun(await savedRun({ repeat: 1, caseSpec, attempts: [{ repeat: 1, attempt: 1, report: rep, scan }] })));

describe("a found bug rated two steps low counts as the right severity", () => {
  // The hand spec rates sqli critical, off-by-one major and apt minor.
  const rated = (severity, f) => ({ ...f, severity });
  const findings = [
    rated("minor", SQLI),
    rated("critical", finding("app/search.py", 14, "security", "SQL injection again")),
    rated("critical", finding("app/server.py", 23, "bug", "page offset skips the first page")),
    rated("minor", finding("Dockerfile", 3, "maintainability", "apt-get install has no -y")),
  ];

  it("calls a critical bug given minor two or more steps off and under-rated, per hit and in the score's matrix", async () => {
    const { score, outcomes } = await reviewed(spec, report(findings));
    const at = Object.fromEntries(outcomes.map((o) => [o.index, o]));
    expect(at[0]).toMatchObject({ outcome: "hit", truthId: "sqli", severity: "minor", severityExpected: "critical", severityAgreement: "off", severityDirection: "under" });
    // The first hit decides; a second finding on the same bug is never judged.
    expect(at[1]).toMatchObject({ outcome: "duplicate", severityAgreement: null, severityDirection: null });
    expect(at[2]).toMatchObject({ truthId: "off-by-one", severityAgreement: "one-off", severityDirection: "over" });
    expect(at[3]).toMatchObject({ truthId: "apt", severityAgreement: "exact", severityDirection: null });
    const s = score.byConfig[CONFIG].severity;
    expect(s.exact).toEqual({ hit: 1, of: 3 });
    expect(s.oneOff).toEqual({ hit: 1, of: 3 });
    expect(s.off).toEqual({ hit: 1, of: 3 });
    expect(s.withinOne).toEqual({ hit: 2, of: 3 });
    expect([s.over, s.under, s.unknown]).toEqual([1, 1, 0]);
    expect([s.matrix.critical.minor, s.matrix.major.critical, s.matrix.minor.minor, s.matrix.critical.critical]).toEqual([1, 1, 1, 0]);
    expect(score.perBug[CONFIG][CASE_ID].sqli.given).toEqual(["minor"]);
    expect(renderV3(score)).toMatch(/Severity as the spec rates it/);
  });
});

describe("a bug the spec expects from semgrep, found only by the reviewer, counts as a scanner find", () => {
  // The hand spec, with the SQL injection expected from one scanner.
  const expecting = (found_by) => ({ ...spec, bugs: spec.bugs.map((b) => (b.id === "sqli" ? { ...b, found_by } : b)) });
  const candidate = (id, source, ruleId, filePath, line, extra = {}) => ({ source, ruleId, filePath, lineStart: line, lineEnd: line, severity: "high", message: "m", reference: null, id, token: `${source}:${ruleId}`, reviewSeverity: "major", ...extra });
  const entry = (token, file, line, stage, extra = {}) => ({ token, file, lineStart: line, lineEnd: line, severity: "high", stage, ...extra });
  const raising = (id, token) => ({ ...SQLI, candidate: id, source: token });
  // bandit's own words for B608, which name the planted SQL injection.
  const B608 = { message: "Possible SQL injection vector through string-based query construction." };

  it("credits the reviewer when no semgrep finding that reached the review or merged into one sits on the bug's lines", async () => {
    // semgrep raised a candidate elsewhere, and a rule on the bug's lines that review.disabled_rules turned off.
    const scan = {
      candidates: [candidate("c1", "semgrep", "python.flask.debug", "app/other.py", 5)],
      trail: [entry("semgrep:python.flask.debug", "app/other.py", 5, "kept", { id: "c1" }), entry("semgrep:python.sqli.raw", "app/search.py", 14, "disabled-rule")],
    };
    const { score, outcomes } = await reviewed(expecting(["semgrep"]), report([SQLI]), scan);
    expect(outcomes[0]).toMatchObject({ outcome: "hit", truthId: "sqli", finder: "reviewer", locatedBy: [] });
    const f = score.byConfig[CONFIG].finder;
    expect(f.match).toEqual({ hit: 0, of: 1 });
    expect(f.byExpected).toEqual({ semgrep: { hit: 0, of: 1 } });
    expect(f.byFinder).toEqual({ scanner: 0, reviewer: 1 });
    expect([f.scannerExpectedReviewerFound, f.unjudged]).toEqual([1, 0]);
    expect(score.perBug[CONFIG][CASE_ID].sqli.finder).toEqual(["reviewer"]);
    expect(renderV3(score)).toMatch(/Found by whom the spec expects/);
  });

  it("credits semgrep when its finding was merged into another scanner's candidate on the bug's lines, so dedup never hides it", async () => {
    const scan = {
      candidates: [candidate("c1", "bandit", "B608", "app/search.py", 14, B608)],
      trail: [entry("bandit:B608", "app/search.py", 14, "kept", { id: "c1" }), entry("semgrep:python.sqli.raw", "app/search.py", 14, "merged", { into: "c1" })],
    };
    const { score, outcomes } = await reviewed(expecting(["semgrep"]), report([raising("c1", "bandit:B608")]), scan);
    expect(outcomes[0]).toMatchObject({ finder: "scanner", locatedBy: ["bandit", "semgrep"] });
    const f = score.byConfig[CONFIG].finder;
    expect([f.match, f.byExpected.semgrep, f.scannerExpectedReviewerFound]).toEqual([{ hit: 1, of: 1 }, { hit: 1, of: 1 }, 0]);
    // A scan saved before the trail names the merged scanners on the candidate itself.
    const older = { candidates: [candidate("c1", "bandit", "B608", "app/search.py", 14, { alsoReportedBy: ["semgrep:python.sqli.raw"] })] };
    expect((await reviewed(expecting(["semgrep"]), report([raising("c1", "bandit:B608")]), older)).score.byConfig[CONFIG].finder.byExpected.semgrep).toEqual({ hit: 1, of: 1 });
  });

  it("credits the reviewer when the semgrep finding on the bug's lines was merged into a candidate that never reached the review", async () => {
    // c1 was dropped before the review: it is not among the kept candidates, so nothing semgrep found reached the reviewer.
    const scan = { candidates: [], trail: [entry("semgrep:python.sqli.raw", "app/search.py", 14, "merged", { into: "c1" })] };
    const { score, outcomes } = await reviewed(expecting(["semgrep"]), report([SQLI]), scan);
    expect(outcomes[0]).toMatchObject({ finder: "reviewer", locatedBy: [] });
    const f = score.byConfig[CONFIG].finder;
    expect([f.match, f.byExpected.semgrep, f.scannerExpectedReviewerFound]).toEqual([{ hit: 0, of: 1 }, { hit: 0, of: 1 }, 1]);
  });

  it("credits a scanner, but not the expected one, when only another scanner located the bug and named it", async () => {
    const scan = { candidates: [candidate("c1", "bandit", "B608", "app/search.py", 14, B608)] };
    const { score, outcomes } = await reviewed(expecting(["semgrep"]), report([SQLI]), scan);
    expect(outcomes[0]).toMatchObject({ finder: "scanner", locatedBy: ["bandit"] });
    const f = score.byConfig[CONFIG].finder;
    expect([f.match, f.byExpected.semgrep, f.scannerExpectedReviewerFound]).toEqual([{ hit: 0, of: 1 }, { hit: 0, of: 1 }, 0]);
  });

  it("does not credit a scanner the spec does not expect whose finding inside the bug's lines is about something else", async () => {
    // The Dockerfile's root bug spans lines 3 to 11, where hadolint flags the apt install planted on line 3.
    const scan = { candidates: [candidate("c1", "hadolint", "DL3008", "Dockerfile", 3, { message: "Pin versions in apt get install." })] };
    const { score, outcomes } = await reviewed(spec, report([finding("Dockerfile", 10, "security", "The container runs as root")]), scan);
    expect(outcomes[0]).toMatchObject({ truthId: "root", finder: "reviewer", locatedBy: [] });
    expect(score.byConfig[CONFIG].finder.match).toEqual({ hit: 1, of: 1 });
    // The scanner the spec expects counts by its place alone, whatever its words.
    const fromHadolint = { ...spec, bugs: spec.bugs.map((b) => (b.id === "root" ? { ...b, found_by: ["hadolint"] } : b)) };
    expect((await reviewed(fromHadolint, report([finding("Dockerfile", 10, "security", "The container runs as root")]), scan)).outcomes[0]).toMatchObject({ finder: "scanner", locatedBy: ["hadolint"] });
  });

  it("does not count a dropped candidate about another issue, inside a wide bug's lines, as the reviewer dropping that bug's scanner find", async () => {
    // hadolint's apt finding on line 3 lies inside the root bug's lines 3 to 11; the reviewer dropped it.
    const apt = candidate("c1", "hadolint", "DL3008", "Dockerfile", 3, { message: "Pin versions in apt get install." });
    const { score } = await reviewed(spec, report([], { dropped: [{ candidate: apt, reason: "a size nitpick" }] }), { candidates: [apt] });
    // It names the apt bug it sits on, and only that one.
    expect(score.byConfig[CONFIG].finder.droppedCandidates).toBe(1);
  });

  it("counts OpenQodex's own suppression candidate as the suppression finder, never as the scanner whose comment it reads", async () => {
    const scan = { candidates: [candidate("c1", "bandit", "openqodex.suppression-added", "app/search.py", 14)] };
    const asBandit = (await reviewed(expecting(["bandit"]), report([SQLI]), scan)).score.byConfig[CONFIG].finder;
    expect(asBandit.byExpected).toEqual({ bandit: { hit: 0, of: 1 } });
    const asSuppression = await reviewed(expecting(["suppression"]), report([SQLI]), scan);
    expect(asSuppression.outcomes[0].locatedBy).toEqual(["suppression"]);
    expect(asSuppression.score.byConfig[CONFIG].finder.byExpected).toEqual({ suppression: { hit: 1, of: 1 } });
  });

  // Issue 143: only a built-in scanner's candidate is OpenQodex's own (core
  // finalize.ts isOwnCandidate), since a custom scanner may name a rule
  // anything; and a rule id that names a property every object inherits is
  // a rule id like any other, never a lookup into one.
  it("credits a custom scanner's rules named settings-file and constructor to that custom scanner, and OpenQodex's own settings check keeps its own credit (issue 143)", async () => {
    const scan = {
      candidates: [
        candidate("c1", "custom:mine", "settings-file", "app/search.py", 14, { message: "Possible SQL injection in the search query." }),
        candidate("c2", "custom:mine", "constructor", "app/server.py", 23, { message: "The page offset skips a row." }),
        candidate("c3", "bandit", "settings-file", "app/search.py", 14, { message: "This change edits a scanner settings file; findings of bandit, its SQL injection check among them, may be hidden by it" }),
        candidate("c4", "hadolint", "constructor", "Dockerfile", 3, { message: "apt-get install without -y." }),
      ],
    };
    const findings = [SQLI, finding("app/server.py", 23, "bug", "page offset skips the first page"), finding("Dockerfile", 3, "maintainability", "apt-get install has no -y")];
    const { score, outcomes } = await reviewed(spec, report(findings), scan);
    expect(outcomes.map((o) => [o.truthId, o.finder, o.locatedBy])).toEqual([
      ["sqli", "scanner", ["custom:mine", "settings"]],
      ["off-by-one", "scanner", ["custom:mine"]],
      ["apt", "scanner", ["hadolint"]],
    ]);
    expect(score.byConfig[CONFIG].finder.byFinder).toEqual({ scanner: 3, reviewer: 0 });
    // Every place a scanner's find is read from: a kept candidate, a token merged into one, and a merged trail entry.
    const places = scannerPlaces({
      candidates: [candidate("c1", "custom:mine", "settings-file", "a.py", 1, { alsoReportedBy: ["custom:mine:constructor", "custom:other:openqodex.suppression-added", "bandit:settings-file", "oxlint:toString", "ruff:__proto__"] })],
      trail: [entry("custom:mine:hasOwnProperty", "a.py", 1, "merged", { into: "c1" }), entry("semgrep:openqodex.suppression-added", "a.py", 1, "merged", { into: "c1" })],
    });
    expect(places.map((p) => p.name)).toEqual(["custom:mine", "custom:mine", "custom:other", "settings", "oxlint", "ruff", "custom:mine", "suppression"]);
  });

  it("leaves the finder unjudged, out of every ratio, when the review saved no scan", async () => {
    const { score, outcomes } = await reviewed(expecting(["semgrep"]), report([SQLI]));
    expect(outcomes[0]).toMatchObject({ finder: null, locatedBy: null });
    const f = score.byConfig[CONFIG].finder;
    expect([f.match, f.byExpected, f.scannerExpectedReviewerFound, f.unjudged]).toEqual([{ hit: 0, of: 0 }, {}, 0, 1]);
  });
});

describe("lineMatches reads a finding with no line number as the whole file (issue 153)", () => {
  const truth = [{ id: "c1", file: "src/a.ts", lines: [5, 6], side: "right", valid: true }];

  it("matches a finding whose line is undefined the same as one whose line is null", () => {
    const undefinedLine = lineMatches([{ file: "src/a.ts", line: undefined, end: undefined }], truth);
    const nullLine = lineMatches([{ file: "src/a.ts", line: null, end: null }], truth);
    expect(nullLine.matches).toBe(1);
    expect(nullLine).toEqual(undefinedLine);
  });

  it("still requires the file to match: a finding with no line in a different file is not near", () => {
    const { matches } = lineMatches([{ file: "src/b.ts", line: null, end: null }], truth);
    expect(matches).toBe(0);
  });

  it("still checks the line when one is given, further than k from the truth range", () => {
    const { matches } = lineMatches([{ file: "src/a.ts", line: 50, end: 50 }], truth);
    expect(matches).toBe(0);
  });
});
