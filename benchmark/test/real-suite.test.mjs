// Runs of pull request cases (a real suite such as aacr): how run.mjs
// selects them by suite, split and subset, the truth copy each run saves in
// its cases/ folder, and how score.mjs reads such a run. The cases are the
// committed suite's own entries; their truth comments are written here in
// AACR-Bench's row shape, so no test reads the pinned dataset files or the
// network. Five failures are guarded:
//
// 1. A held-out (test split) case is run by a scanner-only run.
// 2. A run whose manifest names no suite is scored as planted.
// 3. A real case's truth copy lacks a comment the suite lists.
// 4. A saved sample of a pull request case cannot be scored (issue 141:
//    a truth item with no severity and no kind).
// 5. Fixing 4 changes the score of a planted sample.
// 6. Keying rulings on the spec version (issues 163 and 139) changes the
//    score of a planted sample beyond what the rulings themselves do.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord, scanSampleRecord } from "../lib/runner.mjs";
import { aacrTruth, listCases, readCase, readSuite, selectCases, specCopy } from "../lib/suites.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const RUN = join(benchRoot, "run.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, "fixtures", "planted-score.json");

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// The committed suite and split: a usable held-out case, the dev-smoke
// subset and a development case outside it.
const suite = readSuite("aacr");
const usable = (name) => suite.byName.get(name)?.status === "usable";
const heldOut = suite.split.cases.test.find(usable);
const smoke = suite.split.subsets["dev-smoke"];
const devOutsideSmoke = suite.split.cases.dev.find((n) => usable(n) && !smoke.includes(n));
const smokeCase = readCase(listCases({ suite: "aacr", subset: "dev-smoke" })[0]);

// A truth for `c` in AACR-Bench's row shape: as many accepted comments as
// its suite entry lists, and as many rejected ones, each on its own lines of
// one file.
function truthFor(c, { leaveOut = null } = {}) {
  const comment = (n, side = "right") => ({ path: "src/app.ts", from_line: 10 * n, to_line: 10 * n + 2, side, note: `comment ${n}`, category: "Code Defect", context: "Diff Level", is_ai_comment: false, source_model: "" });
  const accepted = Array.from({ length: c.truthCount.accepted }, (_, i) => comment(i + 1));
  const rejected = Array.from({ length: c.truthCount.rejected }, (_, i) => comment(100 + i));
  const truth = aacrTruth({ comments: accepted }, { comments: rejected });
  if (leaveOut !== null) truth.items = truth.items.filter((t) => t.id !== leaveOut);
  return truth;
}

const BUILD = { commit: "a".repeat(40), short: "aaaaaaa", dirty: false, cliVersion: "0.14.0" };

// A run folder made by the runner's own code: the manifest, the spec copy
// of each case and the attempts given, each with its sample.json and the
// files the review or scan wrote.
async function savedRun({ settings, cases, specs, jobs, attempts }) {
  const root = tempDir("oq-bench-real-");
  const out = join(root, "run");
  for (const [name, spec] of Object.entries(specs)) write(join(root, "specs", `${name}.json`), `${JSON.stringify(spec, null, 2)}\n`);
  await executeRun({
    out,
    manifest: runManifest({ startedAt: "2026-10-11T10:00:00.000Z", settings, jobs }),
    jobs,
    copies: cases.map((name) => [join(root, "specs", `${name}.json`), join("cases", `${name}.json`)]),
    runJob: async (job) => {
      for (const a of attempts.filter((x) => x.case === job.case && x.repeat === job.repeat)) {
        const dir = attemptDir(out, job, 1);
        const result = { code: 0, signal: null, wallMs: 1000 };
        const rec = a.scan ? scanSampleRecord({ job, attempt: 1, result, scan: a.scan, report: null, startedAt: "t", failure: null, stopped: null }) : sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result, report: a.report, who: null, startedAt: "t", failure: null, stopped: null });
        write(join(dir, "sample.json"), JSON.stringify(rec));
        if (a.report) write(join(dir, "report", "report.json"), JSON.stringify(a.report));
        if (a.scan) write(join(dir, "report", "scan.json"), JSON.stringify(a.scan));
      }
    },
  });
  return out;
}

// A scanner-only run of one pull request case, with one candidate on its
// first accepted comment's lines. `suite` null writes no suite.
function scanRun(c, spec, { suite: named = "aacr" } = {}) {
  const { jobs } = planJobs({ cases: [c.name], caseIds: { [c.name]: c.id }, repeat: 1, mode: "scan" });
  const settings = { runId: "real-scan", mode: "scan", path: "laptop", ...(named === null ? {} : { suite: named, split: "dev", splitHash: c.splitHash }), build: BUILD, cases: [c.name], caseIds: [c.id], caseHashes: { [c.name]: c.hash }, configs: ["scan"], repeat: 1, concurrency: 1 };
  const candidate = { id: "c1", token: "semgrep:rule", source: "semgrep", ruleId: "rule", filePath: "src/app.ts", lineStart: 11, lineEnd: 11, severity: "medium", message: "Something on the first comment's lines.", reference: null, reviewSeverity: "minor" };
  const scan = { candidates: [candidate], scanners: [{ scanner: "semgrep", status: "ran", version: "1", rawCount: 1, keptCount: 1, durationMs: 1, reason: null }], fixturesDropped: 0, secretFingerprints: [] };
  return savedRun({ settings, cases: [c.name], specs: { [c.name]: spec }, jobs, attempts: [{ case: c.name, repeat: 1, scan }] });
}

// run.mjs as a developer runs it, with an empty clone cache.
function runCli(args) {
  const cache = tempDir("oq-bench-real-cache-");
  const r = spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: cache }, timeout: 60_000 });
  return { ...r, cacheEntries: existsSync(cache) ? readdirSync(cache) : [] };
}

describe("a held-out (test split) case is run by a scanner-only run", () => {
  it("has a held-out case and a development case outside dev-smoke to test with", () => {
    expect(heldOut).toBeTruthy();
    expect(devOutsideSmoke).toBeTruthy();
  });

  it("refuses --split test before anything is fetched, built or logged", () => {
    const r = runCli(["--mode", "scan", "--suite", "aacr", "--split", "test"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/held out/);
    expect(r.cacheEntries).toEqual([]);
  });

  it("refuses a held-out case named in --cases, with or without --suite", () => {
    for (const args of [["--mode", "scan", "--suite", "aacr", "--cases", `aacr/${heldOut}`], ["--mode", "scan", "--cases", `aacr/${heldOut}`]]) {
      const r = runCli(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(heldOut);
      expect(r.stderr).toMatch(/held out/);
      expect(r.cacheEntries).toEqual([]);
    }
  });

  it("selects exactly the development cases a subset lists, and refuses a case outside the subset or an unknown subset", () => {
    expect(selectCases({ suite: "aacr", split: "dev", subset: "dev-smoke" }).map((c) => c.name)).toEqual([...smoke].sort());
    expect(selectCases({ suite: "aacr", split: "dev" }).every((c) => c.split === "dev")).toBe(true);
    expect(() => selectCases({ suite: "aacr", split: "test" })).toThrow(/held out/);
    expect(() => selectCases({ suite: "aacr", split: "dev", subset: "dev-smoke", refs: [`aacr/${devOutsideSmoke}`] })).toThrow(new RegExp(`${devOutsideSmoke}.*dev-smoke`));
    expect(() => selectCases({ suite: "aacr", split: "dev", subset: "nope" })).toThrow(/dev-laptop, dev-smoke/);
    const r = runCli(["--mode", "scan", "--suite", "aacr", "--subset", "dev-smoke", "--cases", `aacr/${devOutsideSmoke}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(devOutsideSmoke);
  });

  it("refuses a split or a subset on the planted suite, which has one split and no subsets", () => {
    for (const args of [["--mode", "scan", "--split", "test"], ["--mode", "scan", "--subset", "dev-smoke"]]) {
      const r = runCli(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/the planted suite has (one split|no subsets)/);
    }
  });
});

describe("a run whose manifest names no suite is scored as planted", () => {
  it("refuses a run whose manifest names no suite while its jobs are pull request cases", async () => {
    const out = await scanRun(smokeCase, specCopy(smokeCase, truthFor(smokeCase)), { suite: null });
    expect(() => loadRun(out)).toThrow(/names no suite.*planted.*aacr/s);
  });

  it("refuses a run whose manifest names another suite than its jobs", async () => {
    const out = await scanRun(smokeCase, specCopy(smokeCase, truthFor(smokeCase)), { suite: "planted" });
    expect(() => loadRun(out)).toThrow(/planted.*aacr/s);
  });

  it("scores a scanner-only run of a pull request case against its accepted comments, with the line rule as a location diagnostic", async () => {
    const out = await scanRun(smokeCase, specCopy(smokeCase, truthFor(smokeCase)));
    const { score, outcomes } = scoreRun(loadRun(out));
    const n = smokeCase.truthCount.accepted;
    expect(score).toMatchObject({ suite: "aacr", split: "dev", splitHash: smokeCase.splitHash, mode: "scan" });
    const c = score.byConfig.scan;
    expect(c.issueRecall.all).toMatchObject({ hit: 0, of: n });
    expect(c.location).toMatchObject({ matches: 1, generated: 1, expected: n, knownNoise: 0 });
    expect(outcomes).toEqual([expect.objectContaining({ outcome: "unresolved", truthId: "c1", evidenceKind: "location-only" })]);
  });
});

describe("a real case's truth copy lacks a comment the suite lists", () => {
  it("copies every accepted comment and no rejected one", () => {
    const copy = specCopy(smokeCase, truthFor(smokeCase));
    expect(copy.bugs.map((b) => b.id)).toEqual(Array.from({ length: smokeCase.truthCount.accepted }, (_, i) => `c${i + 1}`));
    expect(copy.bugs.every((b) => b.valid === true)).toBe(true);
    expect(copy).toMatchObject({ id: smokeCase.id, suite: "aacr", origin: "real", repoGroup: smokeCase.repoGroup, truthHash: smokeCase.truthHash, clean: false });
  });

  it("refuses to copy a truth that lacks an accepted comment the suite lists", () => {
    expect(() => specCopy(smokeCase, truthFor(smokeCase, { leaveOut: "c1" }))).toThrow(new RegExp(`${smokeCase.truthCount.accepted} accepted`));
  });

  it("refuses to score a run whose truth copy lacks a comment the suite lists", async () => {
    const full = specCopy(smokeCase, truthFor(smokeCase));
    const short = { ...full, bugs: full.bugs.filter((b) => b.id !== "c1") };
    const out = await scanRun(smokeCase, short);
    expect(() => loadRun(out)).toThrow(/c1/);
    // A rejected comment in the copy is refused too: it would enter the recall denominator.
    const rejected = specCopy(smokeCase, truthFor(smokeCase));
    rejected.bugs.push({ ...rejected.bugs[0], id: "r1", valid: false });
    const out2 = await scanRun(smokeCase, rejected);
    expect(() => loadRun(out2)).toThrow(/r1/);
  });
});

// A review of a pull request case on the server path, as run.mjs saves it.
function reviewReport(findings) {
  return { version: 1, kind: "review", verdict: "passed", findings, outside_change: [], dropped: [], scanners: [], impact: { status: "ok", build: { durationMs: 100 } }, completion: { status: "complete", missing: [], reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 10, output_tokens: 10, cost_usd: 0.01 } } } };
}
const finding = (file_path, line_number, category, title, extra = {}) => ({ origin: "agent", severity: "major", category, confidence: 0.9, file_path, line_number, line_end: line_number, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: title, consequence: "c", fix: "f", ...extra });

describe("a saved sample of a pull request case cannot be scored (issue 141)", () => {
  it("scores a server review of a pull request case whose truth has no severity and no kind", async () => {
    const c = smokeCase;
    const config = "model-scripted-graph-on";
    const { jobs } = planJobs({ cases: [c.name], caseIds: { [c.name]: c.id }, reviewers: ["model:scripted"], graph: ["on"], repeat: 1 });
    const settings = { runId: "real-review", mode: "review", path: "server", suite: "aacr", split: "dev", splitHash: c.splitHash, build: BUILD, reviewers: { "model:scripted": { name: "model:scripted", kind: "model", model: "scripted" } }, cases: [c.name], caseIds: [c.id], caseHashes: { [c.name]: c.hash }, configs: [config], repeat: 1, concurrency: 1 };
    // On the first comment's lines, two lines from the second (inside the near window), and elsewhere.
    const report = reviewReport([finding("src/app.ts", 11, "bug", "An off-by-one in the loop"), finding("src/app.ts", 24, "bug", "A second issue nearby"), finding("src/other.ts", 3, "security", "Unrelated")]);
    const out = await savedRun({ settings, cases: [c.name], specs: { [c.name]: specCopy(c, truthFor(c)) }, jobs, attempts: [{ case: c.name, repeat: 1, report }] });
    const { score, outcomes } = scoreRun(loadRun(out));
    const s = score.byConfig[config];
    expect(s.population).toMatchObject({ planned: 1, complete: 1 });
    expect(s.issueRecall.all).toMatchObject({ hit: 0, of: c.truthCount.accepted });
    expect(s.location).toMatchObject({ matches: 1, generated: 3, expected: c.truthCount.accepted });
    expect(outcomes.find((o) => o.index === 0)).toMatchObject({ outcome: "unresolved", truthId: "c1", evidenceKind: "location-only" });
    expect(s.plantedLegacy).toBeNull();
  });
});

// The hand case of score.test.mjs: five planted bugs and an accepted side
// issue, with findings that reach every rule the fix for issue 141 touches
// (a hit, a duplicate, a near miss, a wrong kind, an accepted side issue, a
// request for a test, a false finding), in every severity.
const bug = (id, file, lines, anchorLine, kind, severity, mentions, extra = {}) => ({ id, file, lines, anchor: { line: anchorLine, text: "x" }, mentions, kind, severity, found_by: ["reasoning"], truth: "t", ...extra });
const hand = {
  id: "hand",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  bugs: [
    bug("sqli", "app/search.py", [14, 14], 14, ["security"], "critical", ["sql", "injection"]),
    bug("off-by-one", "app/server.py", [23, 23], 23, ["bug"], "major", ["offset", "skip"]),
    bug("root", "Dockerfile", [3, 11], 11, ["security"], "major", ["root"]),
    bug("apt", "Dockerfile", [3, 3], 3, ["maintainability", "security"], "minor", ["apt", "-y"]),
    bug("lodash", "package-lock.json", [11, 17], 11, ["security"], "major", ["lodash"], { also: [{ file: "package.json", lines: [7, 7] }] }),
    bug("log", "app/log.py", [5, 5], 5, ["style"], "nitpick", ["log"]),
    bug("doc", "README.md", [2, 2], 2, ["style"], "info", ["typo"]),
  ],
  extras: [{ file: "app/server.py", lines: [30, 32], mentions: ["connection"], why: "a real side issue" }],
};

async function plantedScore(decisions = [], people = []) {
  const HASH = "ab".repeat(32);
  const id = `planted/hand@${HASH.slice(0, 8)}`;
  const config = "claude-graph-on";
  const { jobs } = planJobs({ cases: ["hand"], caseIds: { hand: id }, reviewers: ["claude"], graph: ["on"], repeat: 2 });
  const settings = { runId: "planted-golden", build: BUILD, reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } }, cases: ["hand"], caseIds: [id], caseHashes: { hand: HASH }, configs: [config], repeat: 2 };
  const one = reviewReport([
    finding("app/search.py", 14, "security", "SQL injection", { severity: "critical" }),
    finding("app/search.py", 14, "security", "SQL injection again", { severity: "major" }),
    finding("app/server.py", 25, "bug", "The offset skips a row", { severity: "minor" }),
    finding("Dockerfile", 11, "bug", "Runs as root", { severity: "major" }),
    finding("app/server.py", 31, "bug", "The connection is never closed", { severity: "minor" }),
    finding("app/other.py", 5, "maintainability", "Changed formatting has no covering test", { severity: "info" }),
    finding("app/nowhere.py", 1, "bug", "Something else", { severity: "nitpick" }),
    finding("app/log.py", 5, "style", "A log line", { severity: "nitpick" }),
  ]);
  const two = reviewReport([finding("package.json", 7, "security", "A vulnerable lodash", { severity: "major" }), finding("README.md", 2, "style", "A typo", { severity: "minor" })]);
  const out = await savedRun({ settings, cases: ["hand"], specs: { hand }, jobs, attempts: [{ case: "hand", repeat: 1, report: one }, { case: "hand", repeat: 2, report: two }] });
  const { score, outcomes, unresolved } = scoreRun(loadRun(out), { decisions, people });
  // The rules block names its version and hash, the run its folder and the
  // end record the clock; none of them is a score.
  const { rules: _rules, run: _run, ended: _ended, ...rest } = score;
  return JSON.parse(JSON.stringify({ score: rest, outcomes, unresolved }));
}

// The fields a queue item gained with rules version 8 (the spec version it
// was scored against, the lines of it the change added, and the truth items
// of that spec with their files). They are what decide checks a ruling
// against, never a score, so the golden, recorded before them, lacks them.
const QUEUE_FIELDS_8 = ["specHash", "changedLines", "truthItems"];
const withoutQueueFields8 = (items) => items.map((i) => Object.fromEntries(Object.entries(i).filter(([k]) => !QUEUE_FIELDS_8.includes(k))));

describe("fixing issue 141 changes the score of a planted sample", () => {
  it("scores the planted hand case exactly as rules version 5 did, every number, outcome and question", async () => {
    const now = await plantedScore();
    // Recorded once with rules version 5, before the fix: OQ_RECORD_PLANTED_SCORE=1.
    if (process.env.OQ_RECORD_PLANTED_SCORE === "1") write(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    expect(existsSync(GOLDEN), `${GOLDEN} is missing; it is recorded with rules version 5 only`).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    // The samples name their served model: a review whose record names none is unhealthy (issue 284).
    golden.score.reviewers.claude.model = "claude-opus-5-5";
    expect({ ...now, unresolved: withoutQueueFields8(now.unresolved) }).toEqual(golden);
    for (const item of now.unresolved) for (const k of QUEUE_FIELDS_8) expect(item, k).toHaveProperty(k);
  });
});

// The hand case's spec version, as the rulings name it: the sha256 of its
// JSON with the keys of every object in sorted order.
const sorted = (v) => (Array.isArray(v) ? `[${v.map(sorted).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sorted(v[k])}`).join(",")}}` : JSON.stringify(v));
const HAND_SPEC = createHash("sha256").update(sorted(hand)).digest("hex");

// The leaf paths at which two JSON values differ.
function differ(a, b, at = "") {
  if (a === b) return [];
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return [at];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differ(a[k], b[k], `${at}.${k}`));
}

describe("keying rulings on the spec version changes the score of a planted sample beyond what the rulings themselves do", () => {
  // Two rulings as queue.mjs decide writes them: the near miss on the
  // off-by-one is that item, and the root item is wrong.
  const rulings = (specHash) =>
    [
      { target: { kind: "match", findingId: "near", truthId: "off-by-one", specHash }, status: "same-issue" },
      { target: { kind: "bug", id: "root", specHash }, status: "disputed" },
    ].map((r, i) => ({ v: 1, caseId: "planted/hand@abababab", fromSheet: null, ...r, by: "Sid", at: `2026-10-11T10:0${i}:00.000Z`, note: "", evidence: null }));
  // The near miss's finding id, from the golden's outcomes.
  const golden = () => {
    const saved = JSON.parse(readFileSync(GOLDEN, "utf8"));
    saved.score.reviewers.claude.model = "claude-opus-5-5";
    return saved;
  };
  const nearId = () => golden().outcomes.find((o) => o.outcome === "near").findingId;
  const lines = (specHash) => rulings(specHash).map((l) => (l.target.findingId ? { ...l, target: { ...l.target, findingId: nearId() } } : l));

  it("scores byte for byte as rules version 6 did when the rulings name another spec version", async () => {
    const other = await plantedScore(lines("0".repeat(64)), ["Sid"]);
    const g = golden();
    const { rulings: read, ...score } = other.score;
    const { rulings: _none, ...goldenScore } = g.score;
    expect(read).toEqual({ read: 2, ignored: [], people: ["Sid"] });
    expect(JSON.stringify(score)).toBe(JSON.stringify(goldenScore));
    expect(JSON.stringify(other.outcomes)).toBe(JSON.stringify(g.outcomes));
    expect(JSON.stringify(withoutQueueFields8(other.unresolved))).toBe(JSON.stringify(g.unresolved));
  });

  it("changes only the ruled finding, the two ruled items and the sums over them when the rulings name the hand case's spec version", async () => {
    const ruled = await plantedScore(lines(HAND_SPEC), ["Sid"]);
    const g = golden();
    const config = "claude-graph-on";
    const caseId = "planted/hand@abababab";
    // The ruled finding finds the off-by-one; every other finding is as it was.
    const at = g.outcomes.findIndex((o) => o.outcome === "near");
    expect(ruled.outcomes[at]).toMatchObject({ outcome: "hit", truthId: "off-by-one", evidenceKind: "ruling" });
    expect(ruled.outcomes.filter((_, i) => i !== at)).toEqual(g.outcomes.filter((_, i) => i !== at));
    // The off-by-one is found in the first review, and the root item is labelled and its misses read as disputed.
    expect(ruled.score.perBug[config][caseId]["off-by-one"].found).toEqual([true, false]);
    expect(ruled.score.perBug[config][caseId].root).toMatchObject({ ruling: "disputed", cause: ["spec-disputed", "spec-disputed"] });
    for (const id of Object.keys(g.score.perBug[config][caseId]).filter((x) => x !== "off-by-one" && x !== "root")) expect(ruled.score.perBug[config][caseId][id]).toEqual(g.score.perBug[config][caseId][id]);
    // The ruled finding asks nothing more; the other questions stay.
    expect(withoutQueueFields8(ruled.unresolved)).toEqual(g.unresolved.filter((i) => i.findingId !== nearId()));
    // The sums move by the one found item and the one correct finding, and nothing else in the score moves.
    const c = ruled.score.byConfig[config];
    const gc = g.score.byConfig[config];
    expect(c.issueRecall.all.hit).toBe(gc.issueRecall.all.hit + 1);
    expect(c.precision.lower.hit).toBe(gc.precision.lower.hit + 1);
    expect(c.precision.upper).toEqual(gc.precision.upper);
    const moved = differ({ ...ruled.score, rulings: null }, { ...g.score, rulings: null });
    const allowed = [`.perBug.${config}.${caseId}.off-by-one.`, `.perBug.${config}.${caseId}.root.`, `.byConfig.${config}.`, `.perCase.${config}.${caseId}.`, ".intervals."];
    expect(moved.filter((p) => !allowed.some((a) => p.startsWith(a)))).toEqual([]);
  });
});
