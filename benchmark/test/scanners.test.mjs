// The scanner tables say what each scanner contributed to a run, and the
// scanner loop keeps or reverts a scanner change on them, so each rule that
// would credit a scanner wrongly, or let a comparison judge what it cannot,
// is checked on scans shaped like the saved ones: a scanner that was not
// installed, a finding dedup merged into another scanner's candidate, one
// truth item under several candidates of one scanner, ratios over samples
// of different sizes, two runs that read other rule packs, a run from the
// held-out split, and a candidate that sits on a lost bug's lines but is
// about something else. The truth items are the frozen planted cases'
// own; the last test runs the command on two run folders written here.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { caseHash, readCase } from "../lib/cases.mjs";
import { analyseRun, judgeAgainst, runRefusals, scannerReport, toolchainRecord } from "../lib/scanners.mjs";
import { toolchainRecordAt } from "../scanners.mjs";
import { toolchainHash } from "../../packages/scanners/dist/index.js";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const repo = fileURLToPath(new URL("../..", import.meta.url));

const cand = (id, token, filePath, lineStart, lineEnd, message, extra = {}) => {
  const cut = token.indexOf(":");
  return { source: token.slice(0, cut), ruleId: token.slice(cut + 1), filePath, lineStart, lineEnd, severity: "high", message, reference: null, id, token, reviewSeverity: "major", ...extra };
};
const ran = (scanner, kept = 0, ms = 10) => ({ scanner, status: "ran", version: "1", rawCount: kept, keptCount: kept, durationMs: ms, reason: null });
const notInstalled = (scanner) => ({ scanner, status: "not_installed", version: null, rawCount: 0, keptCount: 0, durationMs: 1, reason: "needs Ruby 3.0 or newer" });
const scanOf = (candidates, scanners, extra = {}) => ({ candidates, scanners, fixturesDropped: 0, secretFingerprints: [], projects: [], ...extra });
const PACKS = [{ pack: "p/default", sha256: "a".repeat(64), bytes: 10 }];
const EXTERNAL = { toolchainHash: "t".repeat(64), semgrepPacks: PACKS, osvAdvisories: { sha256: "o".repeat(64), advisories: 0 }, scannerVersions: { semgrep: "1.94.0", trivy: "0.56.2", hadolint: "2.15.1" } };
const idOf = (name) => `planted/${name}@00000000`;
const manifestOf = (names, { split = "dev", mode = "scan", external = EXTERNAL, release = null, configs = ["scan"], repeat = 1 } = {}) => ({
  version: 3,
  runId: "t",
  suite: "planted",
  split,
  release,
  mode,
  cases: names,
  caseIds: names.map(idOf),
  configs,
  repeat,
  external,
});
const attempt = (name, scan, { report = null, config = "scan", repeat = 1, row = {} } = {}) => ({ case: name, config, repeat, attempt: 1, row: { wallMs: 1000, ...row }, report, scan });
// A run as the command reads it: the manifest, each first attempt and the specs, with the lines each case's change touched.
const runOf = (names, attempts, { changed = {}, toolchain = null, ...m } = {}) =>
  analyseRun({ name: "t", manifest: manifestOf(names, m), attempts, specs: Object.fromEntries(names.map((n) => [n, readCase(n)])), changedOf: (name) => changed[name] ?? null, toolchain });

const TOOLS = { semgrep: { version: "1.94.0", sha256: "s1" }, trivy: { version: "0.56.2", sha256: "t1" }, hadolint: { version: "2.15.1", sha256: "h1" } };
// A toolchain record built from a table and lock files, as the command builds one from a run's build commit.
const recordOf = (tools, locks = []) => toolchainRecord({ table: JSON.stringify({ schema: 1, tools }), locks: locks.map(([name, text]) => ({ name, bytes: text })) });

const RAILS = "rails-controller-model";
const RAILS_FILES = ["app/controllers/users_controller.rb", "app/models/user.rb"];
const RAILS_CHANGED = new Map([
  ["app/controllers/users_controller.rb", new Set([2, 6, 16, 20, 21, 22])],
  ["app/models/user.rb", new Set([4])],
]);
const RAILS_SQL = cand("c1", "semgrep:ruby.rails.security.audit.sqli.ruby-pg-sqli", "app/controllers/users_controller.rb", 6, 6, "Detected string concatenation in a SQL query: SQL injection.");

describe("a not-run scanner counted as a miss", () => {
  const selection = ["semgrep", "brakeman", "rubocop"].map((scanner) => ({ scanner, wanted: true, paths: RAILS_FILES, projects: [""], skip: null }));
  const scan = scanOf([RAILS_SQL], [ran("semgrep", 1), ran("gitleaks"), notInstalled("brakeman"), notInstalled("rubocop")], { selection, trail: [] });

  it("counts truth in a scanner's file remit that it never ran on as an infra miss, never a miss, and refuses to judge it", () => {
    const run = runOf([RAILS], [attempt(RAILS, scan)], { changed: { [RAILS]: RAILS_CHANGED } });
    const r = scannerReport(run);
    expect(r.scanners.brakeman.infraMisses).toBe(4);
    expect(r.scanners.brakeman.remit).toEqual({ hit: 0, of: 0, unknown: 0 });
    expect(r.misses.filter((m) => m.scanner === "brakeman")).toEqual([]);
    // semgrep ran: its remit holds all four, and it found the SQL injection by its words.
    expect(r.scanners.semgrep.remit).toEqual({ hit: 1, of: 4, unknown: 0 });
    expect(r.misses.filter((m) => m.scanner === "semgrep").map((m) => m.truth).sort()).toEqual(["destroy-skips-admin", "permit-all", "welcome-on-every-save"]);
    const j = judgeAgainst(run, run);
    expect(j.exit).toBe(2);
    expect(j.refusals.join("\n")).toMatch(/brakeman.*did not run/);
    expect(j.refusals.join("\n")).toMatch(/rubocop.*did not run/);
  });

  it("never guesses a remit when the scan recorded no selection: the remit is unknown, and judging is refused", () => {
    const old = scanOf([RAILS_SQL], [ran("semgrep", 1), ran("gitleaks"), notInstalled("brakeman"), notInstalled("rubocop")]);
    const run = runOf([RAILS], [attempt(RAILS, old)], { changed: { [RAILS]: RAILS_CHANGED } });
    const r = scannerReport(run);
    expect(r.missingFields).toContain("selection");
    expect(r.scanners.brakeman.infraMisses).toBeNull();
    expect(r.scanners.semgrep.remit).toEqual({ hit: 0, of: 0, unknown: 4 });
    expect(r.misses).toEqual([]);
    const j = judgeAgainst(run, run);
    expect(j.exit).toBe(2);
    expect(j.refusals.join("\n")).toMatch(/brakeman.*did not run.*no selection/);
  });
});

describe("a scanner missing from a scan that recorded no selection is judged as having looked", () => {
  const name = "demo-polyglot";
  const latest = cand("c1", "hadolint:DL3007", "Dockerfile", 1, 1, "Using latest is prone to errors if the image will ever update.");

  it("refuses to judge when the candidate scan names no status for hadolint and recorded no selection", () => {
    const before = runOf([name], [attempt(name, scanOf([latest], [ran("semgrep"), ran("hadolint", 1), ran("trivy")]))]);
    const after = runOf([name], [attempt(name, scanOf([], [ran("semgrep"), ran("trivy")]))]);
    const j = judgeAgainst(before, after);
    expect(j.exit).toBe(2);
    expect(j.k1).toBeNull();
    expect(j.refusals.join("\n")).toMatch(/hadolint has no status in 1 sample of t .*no selection/);
  });
});

describe("a merged entry lost", () => {
  const name = "demo-polyglot";
  const stripe = cand("c1", "semgrep:generic.secrets.security.detected-stripe-api-key.detected-stripe-api-key", "app/config.py", 2, 2, "Stripe API Key detected", { alsoReportedBy: ["gitleaks:stripe-access-token"] });
  const trail = [
    { token: stripe.token, file: "app/config.py", lineStart: 2, lineEnd: 2, severity: "high", stage: "kept", id: "c1" },
    { token: "gitleaks:stripe-access-token", file: "app/config.py", lineStart: 2, lineEnd: 2, severity: "high", stage: "merged", into: "c1" },
  ];

  it.each([
    ["with the trail", { trail }],
    ["from alsoReportedBy alone, in a scan saved before the trail", {}],
  ])("credits gitleaks, whose finding dedup merged into semgrep's candidate, %s", (_, extra) => {
    const run = runOf([name], [attempt(name, scanOf([stripe], [ran("semgrep", 1), { ...ran("gitleaks"), rawCount: 1 }], extra))]);
    const r = scannerReport(run);
    expect(r.scanners.gitleaks.found).toBe(1);
    expect(r.scanners.semgrep.found).toBe(1);
    expect(r.scanners.gitleaks.unique).toBe(0);
    // Without semgrep, gitleaks's finding comes back as a candidate: the secret keeps a finder and no candidate is saved.
    expect(r.scanners.semgrep.leaveOneOut).toEqual({ lost: [], candidatesSaved: 0 });
    expect(r.scanners.gitleaks.leaveOneOut).toEqual({ lost: [], candidatesSaved: 0 });
  });
});

describe("a merged finding is placed at the lines of the candidate it went into", () => {
  const name = "demo-polyglot";
  // gitleaks's finding sat on line 9; dedup folded it into semgrep's candidate on line 2, where the secret is.
  const stripe = cand("c1", "semgrep:generic.secrets.security.detected-stripe-api-key.detected-stripe-api-key", "app/config.py", 2, 2, "Stripe API Key detected", { alsoReportedBy: ["gitleaks:stripe-access-token"] });
  const trail = [
    { token: stripe.token, file: "app/config.py", lineStart: 2, lineEnd: 2, severity: "high", stage: "kept", id: "c1" },
    { token: "gitleaks:stripe-access-token", file: "app/config.py", lineStart: 9, lineEnd: 9, severity: "high", stage: "merged", into: "c1" },
  ];
  const scanners = [ran("semgrep", 1), { ...ran("gitleaks"), rawCount: 1 }];

  it("credits the merged finding only at the lines the trail recorded for it, so semgrep alone found the secret", () => {
    const r = scannerReport(runOf([name], [attempt(name, scanOf([stripe], scanners, { trail }))]));
    expect(r.scanners.gitleaks).toMatchObject({ found: 0, located: 0 });
    expect(r.scanners.semgrep.unique).toBe(1);
    expect(r.scanners.semgrep.leaveOneOut.lost).toEqual([{ caseId: idOf(name), truth: "secret", samples: 1 }]);
    expect(r.mergedAtCandidateLines).toBe(0);
  });

  it("falls back to the candidate's lines only where the scan saved no trail, and counts each such finding", () => {
    const r = scannerReport(runOf([name], [attempt(name, scanOf([stripe], scanners))]));
    expect(r.scanners.gitleaks.found).toBe(1);
    expect(r.mergedAtCandidateLines).toBe(1);
  });
});

describe("unique counted twice", () => {
  const name = "demo-polyglot";
  // Two advisories on the lodash entry of the lockfile and one on package.json, where the bug's `also` place is.
  const osv = [
    cand("c1", "osv-scanner:GHSA-35jh-r3h4-6jhm", "package-lock.json", 11, 11, "lodash 4.17.4: Command injection in lodash"),
    cand("c2", "osv-scanner:GHSA-p6mc-m468-83gw", "package-lock.json", 11, 11, "lodash 4.17.4: Prototype pollution in lodash"),
    cand("c3", "osv-scanner:GHSA-x5rq-j2xg-h7qm", "package.json", 7, 7, "lodash 4.17.4: ReDoS in lodash"),
  ];

  it("counts one truth item found by one scanner through three candidates and two places as one unique item", () => {
    const run = runOf([name], [attempt(name, scanOf(osv, [ran("osv-scanner", 3)]))]);
    const r = scannerReport(run);
    expect(r.scanners["osv-scanner"].found).toBe(1);
    expect(r.scanners["osv-scanner"].unique).toBe(1);
    expect(r.scanners["osv-scanner"].leaveOneOut.lost).toEqual([{ caseId: idOf(name), truth: "vulnerable-lodash", samples: 1 }]);
    expect(r.scanners["osv-scanner"].leaveOneOut.candidatesSaved).toBe(3);
    // No rule is the only one on it, so none is unique.
    expect(r.rules.filter((x) => x.token.startsWith("osv-scanner:")).map((x) => x.unique)).toEqual([0, 0, 0]);
  });

  it("counts an item two scanners found as unique to neither", () => {
    const sem = cand("c4", "semgrep:json.npm.security.vulnerable-lodash", "package.json", 7, 7, "A vulnerable lodash version is pinned.");
    const run = runOf([name], [attempt(name, scanOf([...osv, sem], [ran("osv-scanner", 3), ran("semgrep", 1)]))]);
    const r = scannerReport(run);
    expect(r.scanners["osv-scanner"].unique).toBe(0);
    expect(r.scanners.semgrep.unique).toBe(0);
    expect(r.scanners["osv-scanner"].leaveOneOut.lost).toEqual([]);
  });
});

describe("ratios averaged instead of summed", () => {
  const name = "flask-path-traversal";
  const debug = cand("c1", "bandit:B201", "files/app.py", 24, 24, "B201: A Flask app appears to be run with debug=True.");
  const noise = (id, line) => cand(id, "bandit:B105", "files/app.py", line, line, "B105: Possible hardcoded password.");

  it("sums hits and checks over samples, so a sample with three candidates weighs three times one with one", () => {
    const run = runOf(
      [name],
      [attempt(name, scanOf([debug], [ran("bandit", 1, 10)]), { config: "a" }), attempt(name, scanOf([noise("c1", 3), noise("c2", 4), noise("c3", 5)], [ran("bandit", 3, 30)]), { config: "b" })],
      { configs: ["a", "b"] },
    );
    const b = scannerReport(run).scanners.bandit;
    expect(b.kept).toBe(4);
    expect(b.precision).toEqual({ hit: 1, of: 4 });
    expect(b.locationPrecision).toEqual({ hit: 1, of: 4 });
    expect(b.ms).toMatchObject({ n: 2, max: 30 });
  });
});

describe("a comparison across rules hashes", () => {
  const name = "flask-path-traversal";
  const debug = cand("c1", "bandit:B201", "files/app.py", 24, 24, "B201: A Flask app appears to be run with debug=True.");
  const sel = (scanner) => ({ scanner, wanted: true, paths: ["files/app.py"], projects: [""], skip: null });
  const scan = scanOf([debug], [ran("bandit", 1), ran("semgrep")], { selection: [sel("bandit"), sel("semgrep")], trail: [] });
  const changed = { [name]: new Map([["files/app.py", new Set([16, 17, 18, 19, 20, 24])]]) };
  const runWith = (external) => runOf([name], [attempt(name, scan)], { changed, external });

  it("judges two runs that read the same packs on the same toolchain", () => {
    expect(judgeAgainst(runWith(EXTERNAL), runWith(EXTERNAL)).exit).toBe(0);
  });

  it("refuses two runs whose Semgrep rule packs differ, or are not recorded", () => {
    const other = { ...EXTERNAL, semgrepPacks: [{ ...PACKS[0], sha256: "b".repeat(64) }] };
    const j = judgeAgainst(runWith(EXTERNAL), runWith(other));
    expect(j.exit).toBe(2);
    expect(j.refusals.join("\n")).toMatch(/Semgrep rule packs differ/);
    expect(judgeAgainst(runWith(EXTERNAL), runWith(other), { inputChange: "semgrep-packs" }).exit).toBe(0);
    for (const packs of ["unknown", "mixed"]) expect(judgeAgainst(runWith(EXTERNAL), runWith({ ...EXTERNAL, semgrepPacks: packs })).exit).toBe(2);
    expect(judgeAgainst(runWith(EXTERNAL), runWith(null)).exit).toBe(2);
  });

  it("refuses a toolchain that differs beyond the one pin bump the change names", () => {
    const base = recordOf(TOOLS);
    const bumpedRecord = recordOf({ ...TOOLS, trivy: { version: "0.57.0", sha256: "t2" } });
    const runAt = (record, versions) => runOf([name], [attempt(name, scan)], { changed, external: { ...EXTERNAL, toolchainHash: record.hash, scannerVersions: versions }, toolchain: record });
    const before = runAt(base, EXTERNAL.scannerVersions);
    const bumped = runAt(bumpedRecord, { ...EXTERNAL.scannerVersions, trivy: "0.57.0" });
    expect(judgeAgainst(before, bumped).exit).toBe(2);
    expect(judgeAgainst(before, bumped, { inputChange: "pin-bump:trivy" }).exit).toBe(0);
    expect(judgeAgainst(before, bumped, { inputChange: "pin-bump:hadolint" }).exit).toBe(2);
    const twoRecord = recordOf({ ...TOOLS, trivy: { version: "0.57.0", sha256: "t2" }, hadolint: { version: "2.16.0", sha256: "h2" } });
    const two = runAt(twoRecord, { ...EXTERNAL.scannerVersions, trivy: "0.57.0", hadolint: "2.16.0" });
    expect(judgeAgainst(before, two, { inputChange: "pin-bump:trivy" }).exit).toBe(2);
  });
});

describe("a pin bump carries another scanner's toolchain change", () => {
  const name = "flask-path-traversal";
  const debug = cand("c1", "bandit:B201", "files/app.py", 24, 24, "B201: A Flask app appears to be run with debug=True.");
  const sel = (scanner) => ({ scanner, wanted: true, paths: ["files/app.py"], projects: [""], skip: null });
  const scan = scanOf([debug], [ran("bandit", 1), ran("semgrep")], { selection: [sel("bandit"), sel("semgrep")], trail: [] });
  const changed = { [name]: new Map([["files/app.py", new Set([16, 17, 18, 19, 20, 24])]]) };
  const versions = (trivy) => ({ ...EXTERNAL.scannerVersions, trivy });
  const runAt = (record, v, hash = record?.hash) => runOf([name], [attempt(name, scan)], { changed, external: { ...EXTERNAL, toolchainHash: hash, scannerVersions: v }, toolchain: record });
  const before = runAt(recordOf(TOOLS, [["hadolint-darwin-arm64.txt", "h"]]), versions("0.56.2"));
  const bump = { ...TOOLS, trivy: { version: "0.57.0", sha256: "t2" } };

  it("refuses a pin bump of trivy when hadolint's entry or lock file changed beside it, at the same version", () => {
    const checksum = runAt(recordOf({ ...bump, hadolint: { version: "2.15.1", sha256: "h-other" } }, [["hadolint-darwin-arm64.txt", "h"]]), versions("0.57.0"));
    const j = judgeAgainst(before, checksum, { inputChange: "pin-bump:trivy" });
    expect(j.exit).toBe(2);
    expect(j.refusals.join("\n")).toMatch(/beyond the pin bump of trivy.*hadolint/);
    const lock = runAt(recordOf(bump, [["hadolint-darwin-arm64.txt", "h-other"]]), versions("0.57.0"));
    expect(judgeAgainst(before, lock, { inputChange: "pin-bump:trivy" }).refusals.join("\n")).toMatch(/beyond the pin bump of trivy.*hadolint/);
    const alone = runAt(recordOf(bump, [["hadolint-darwin-arm64.txt", "h"]]), versions("0.57.0"));
    expect(judgeAgainst(before, alone, { inputChange: "pin-bump:trivy" }).exit).toBe(0);
  });

  it("refuses a pin bump it cannot check entry by entry: no record, or a record that is not the one the run hashed", () => {
    const noRecord = runAt(null, versions("0.57.0"), recordOf(bump, [["hadolint-darwin-arm64.txt", "h"]]).hash);
    expect(judgeAgainst(before, noRecord, { inputChange: "pin-bump:trivy" }).refusals.join("\n")).toMatch(/cannot be checked entry by entry/);
    const other = runAt(recordOf(bump, [["hadolint-darwin-arm64.txt", "h"]]), versions("0.57.0"), "f".repeat(64));
    expect(judgeAgainst(before, other, { inputChange: "pin-bump:trivy" }).exit).toBe(2);
  });

  it("reads a run's toolchain record from its build commit, the same bytes the toolchain hash covers", () => {
    const record = toolchainRecordAt("HEAD");
    expect(record.error).toBeUndefined();
    expect(record.hash).toBe(toolchainHash());
    expect(Object.keys(record.tools)).toContain("semgrep");
    expect(toolchainRecordAt("0".repeat(40)).error).toMatch(/cannot be read/);
  });
});

describe("a test-split run judged", () => {
  const name = "flask-path-traversal";
  const scan = scanOf([], [ran("bandit"), ran("semgrep")]);

  it("refuses a held-out run's tables without its release, and any comparison that reads one", () => {
    const heldOut = runOf([name], [attempt(name, scan)], { split: "test", release: "0.14.0" });
    const dev = runOf([name], [attempt(name, scan)]);
    expect(runRefusals(heldOut, {}).join("\n")).toMatch(/test split/);
    expect(runRefusals(heldOut, { release: "0.13.0" }).join("\n")).toMatch(/test split/);
    expect(runRefusals(heldOut, { release: "0.14.0" })).toEqual([]);
    expect(runRefusals(dev, {})).toEqual([]);
    for (const [a, b] of [[dev, heldOut], [heldOut, dev], [heldOut, heldOut]]) {
      const j = judgeAgainst(a, b);
      expect(j.exit).toBe(2);
      expect(j.refusals.join("\n")).toMatch(/test split/);
    }
  });
});

describe("a location match on the same lines counts as preserved coverage of a different issue", () => {
  const name = "demo-polyglot";
  const sql = cand("c1", "semgrep:python.lang.security.audit.formatted-sql-query.formatted-sql-query", "app/search.py", 14, 14, "Detected possible formatted SQL query. Use parameterized queries instead.");
  const long = cand("c1", "ruff:E501", "app/search.py", 14, 14, "Line too long (121 > 88)");

  it("fails K1 when the only candidate left on the lost bug's lines is about something else", () => {
    const selection = ["semgrep", "ruff", "trivy", "hadolint"].map((scanner) => ({ scanner, wanted: true, paths: scanner === "semgrep" || scanner === "ruff" ? ["app/search.py"] : [], projects: [""], skip: null }));
    const statuses = (semgrep, ruff) => [ran("semgrep", semgrep), ran("ruff", ruff), { ...ran("trivy"), status: "no_matching_files" }, { ...ran("hadolint"), status: "no_matching_files" }];
    const before = runOf([name], [attempt(name, scanOf([sql], statuses(1, 0), { selection, trail: [] }))]);
    const after = runOf([name], [attempt(name, scanOf([long], statuses(0, 1), { selection, trail: [] }))]);
    expect(scannerReport(after).scanners.ruff).toMatchObject({ found: 0, located: 1 });
    const j = judgeAgainst(before, after);
    expect(j.exit).toBe(1);
    expect(j.k1.pass).toBe(false);
    expect(j.k1.lost).toEqual([{ caseId: idOf(name), truth: "sql-injection", foundBefore: ["semgrep"], locatedNow: ["ruff"] }]);
    expect(judgeAgainst(before, before).k1).toEqual({ pass: true, lost: [], checked: 1 });
  });
});

describe("a candidate the final answer raised and finalize hid reads as unanswered", () => {
  const name = "demo-polyglot";
  const latest = cand("c1", "hadolint:DL3042", "Dockerfile", 7, 7, "Avoid use of cache directory with pip.");
  const shown = cand("c2", "hadolint:DL3007", "Dockerfile", 1, 1, "Using latest is prone to errors.");
  const finding = (c, extra = {}) => ({ severity: "minor", category: "maintainability", confidence: 0.9, file_path: c.filePath, line_number: c.lineStart, line_end: c.lineEnd, title: `About ${c.id}`, problem: "p", consequence: "c", fix: "f", suggested_change: null, source: c.token, candidate: c.id, ...extra });
  // The report lists what finalize hid by title and place only (low_confidence, below_threshold); the final answer names the candidate.
  const report = { findings: [finding(shown)], outside_change: [], possible: [], low_confidence: [], below_threshold: 1, dropped: [] };
  const submission = { findings: [finding(shown), finding(latest)] };

  it("counts a candidate the saved final answer raised, and the report does not show, as held", () => {
    const run = runOf([name], [{ ...attempt(name, scanOf([latest, shown], [ran("hadolint", 2)]), { report, config: "claude" }), submission }], { mode: "review", configs: ["claude"] });
    const r = scannerReport(run);
    expect(r.totals).toMatchObject({ raised: 1, held: 1, unanswered: 0 });
    expect(r.scanners.hadolint).toMatchObject({ raised: 1, held: 1, unanswered: 0 });
  });

  it("names the final answer as missing when a review saved none, and holds nothing it cannot see", () => {
    const run = runOf([name], [attempt(name, scanOf([latest, shown], [ran("hadolint", 2)]), { report, config: "claude" })], { mode: "review", configs: ["claude"] });
    const r = scannerReport(run);
    expect(r.missingFields).toContain("submission");
    expect(r.totals).toMatchObject({ raised: 1, held: 0, unanswered: 1 });
  });
});

describe("a language whose only language scanners did not run reads as a gap", () => {
  it("calls the gap unknown, not a gap with recall zero, when the language scanners in remit were not installed", () => {
    const selection = ["semgrep", "brakeman", "rubocop"].map((scanner) => ({ scanner, wanted: true, paths: RAILS_FILES, projects: [""], skip: null }));
    const scan = scanOf([RAILS_SQL], [ran("semgrep", 1), notInstalled("brakeman"), notInstalled("rubocop")], { selection, trail: [] });
    const r = scannerReport(runOf([RAILS], [attempt(RAILS, scan)], { changed: { [RAILS]: RAILS_CHANGED } }));
    const ruby = r.languages.find((l) => l.language === "ruby");
    expect(ruby.gap).toBeNull();
    expect(ruby.languageRecall).toEqual({ hit: 0, of: 0 });
    expect(r.scanners.brakeman.infraMisses).toBe(4);
  });
});

describe("the command exits 0, 1 or 2 on a pair of runs", () => {
  // Two scanner-only runs of the demo case, written the way run.mjs writes them, against the case's frozen spec.
  const name = "demo-polyglot";
  const hash = caseHash(name);
  const caseIdLive = `planted/${name}@${hash.slice(0, 8)}`;
  const sql = cand("c1", "semgrep:python.lang.security.audit.formatted-sql-query.formatted-sql-query", "app/search.py", 14, 14, "Detected possible formatted SQL query.");
  const long = cand("c1", "ruff:E501", "app/search.py", 14, 14, "Line too long (121 > 88)");
  const selection = ["semgrep", "ruff", "gitleaks"].map((scanner) => ({ scanner, wanted: true, paths: ["app/search.py"], projects: [""], skip: null }));
  const write = (dir, candidates, external = EXTERNAL) => {
    const manifest = { ...manifestOf([name], { external }), caseIds: [caseIdLive], caseHashes: { [name]: hash }, jobs: [{ jobId: `${caseIdLive}/scan/1`, caseId: caseIdLive, config: "scan", repeat: 1 }] };
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "cases", `${name}.json`), readFileSync(join(repo, "benchmark/cases", name, "case.json")));
    const sample = join(dir, "samples", name, "scan", "1");
    mkdirSync(join(sample, "report"), { recursive: true });
    writeFileSync(join(sample, "sample.json"), JSON.stringify({ jobId: `${caseIdLive}/scan/1`, case: name, config: "scan", repeat: 1, attempt: 1, wallMs: 4000, status: "complete" }));
    writeFileSync(join(sample, "report", "scan.json"), JSON.stringify(scanOf(candidates, [ran("semgrep", candidates.filter((c) => c.source === "semgrep").length), ran("ruff", candidates.filter((c) => c.source === "ruff").length), ran("gitleaks")], { selection, trail: [] })));
    return dir;
  };
  const root = tempDir("oq-bench-scanners-");
  const base = write(join(root, "base"), [sql]);
  const same = write(join(root, "same"), [sql]);
  const lost = write(join(root, "lost"), [long]);
  const drift = write(join(root, "drift"), [sql], { ...EXTERNAL, semgrepPacks: [{ ...PACKS[0], sha256: "c".repeat(64) }] });
  const cli = (...args) => spawnSync(process.execPath, [join(repo, "benchmark/scanners.mjs"), ...args], { cwd: repo, encoding: "utf8" });

  it("exits 0 when K1 holds, 1 naming K1 when a found item is lost, and 2 when the rule packs differ", () => {
    const ok = cli(same, "--against", base, "--out", join(root, "out-same"));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/K1 holds/);
    const bad = cli(lost, "--against", base, "--out", join(root, "out-lost"));
    expect(bad.status, bad.stderr).toBe(1);
    expect(bad.stdout).toMatch(/K1 fails/);
    expect(bad.stdout).toMatch(/sql-injection/);
    const refused = cli(drift, "--against", base, "--out", join(root, "out-drift"));
    expect(refused.status).toBe(2);
    expect(refused.stdout + refused.stderr).toMatch(/Semgrep rule packs differ/);
    // The run's own tables went to --out.
    expect(JSON.parse(readFileSync(join(root, "out-same", "scanners.json"), "utf8")).scanners.semgrep.found).toBe(1);
    expect(execFileSync("git", ["status", "--porcelain", "benchmark"], { cwd: repo, encoding: "utf8" })).not.toMatch(/scanners\.json/);
  });
});
