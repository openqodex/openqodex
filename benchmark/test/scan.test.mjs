// Scanner-only runs: the scan score against the frozen planted specs, the
// external inputs a scan consumed (Semgrep rule packs, osv.dev advisories),
// and the check that two passes on one build are identical. The scanners'
// own output is data here: each candidate below is the one the real scanner
// printed on the planted case (tests/e2e/bench-scan.test.ts runs the real
// binaries through run.mjs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCase } from "../lib/cases.mjs";
import { externalOf, externalRefusals, inputDifferences, osvAdvisoriesOf, semgrepPacksOf } from "../lib/external.mjs";
import { comparePasses } from "../lib/identical.mjs";
import { SCAN_RULES, SCAN_RULES_VERSION, scanRuleCodeHash, scanRuleSources, scoreScanJob, summarizeScanJobs } from "../lib/scan-score.mjs";
import { names, rulesHash } from "../lib/score.mjs";
import { saveScore } from "../score.mjs";
import { acceptRefusals } from "../trend.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const candidate = (id, source, ruleId, filePath, lineStart, lineEnd, message, extra = {}) => ({ id, token: `${source}:${ruleId}`, source, ruleId, filePath, lineStart, lineEnd, severity: "medium", message, reference: null, reviewSeverity: "minor", ...extra });
const ran = (scanner) => ({ scanner, status: "ran", version: "1", rawCount: 1, keptCount: 1, durationMs: 1, reason: null });
const scanOf = (candidates, scanners = [...new Set(candidates.map((c) => c.source))].map(ran)) => ({ candidates, scanners, fixturesDropped: 0, secretFingerprints: [] });
const jobOf = (name) => ({ jobId: `planted/${name}@00000000/scan/1`, caseId: `planted/${name}@00000000`, case: name, config: "scan", repeat: 1 });

// Real candidates, as the pinned scanners printed them on the planted cases.
const SC2115 = candidate("c27", "shellcheck", "SC2115", "scripts/deploy.sh", 7, 7, 'Use "${var:?}" to ensure this never expands to / .');
const FLASK = [
  candidate("c1", "bandit", "B201", "files/app.py", 24, 24, "B201: A Flask app appears to be run with debug=True, which exposes the Werkzeug debugger and allows the execution of arbitrary code."),
  candidate("c2", "semgrep", "python.flask.security.audit.app-run-param-config.avoid_app_run_with_bad_host", "files/app.py", 24, 24, "Running flask app with host 0.0.0.0 could expose the server publicly."),
  candidate("c3", "semgrep", "python.flask.security.audit.debug-enabled.debug-enabled", "files/app.py", 24, 24, "Detected Flask app with debug=True. Do not deploy to production with this flag enabled as it will leak sensitive information."),
  candidate("c4", "bandit", "B104", "files/app.py", 24, 24, "B104: Possible binding to all interfaces."),
];

describe("the expected scanner's candidate on the planted lines counts as false because its message lacks the spec's words", () => {
  const spec = readCase("demo-polyglot");
  const bug = spec.bugs.find((b) => b.id === "shell-rm-unquoted");

  it("counts shellcheck's own candidate on the unquoted rm as finding it, though its text names none of the spec's words", () => {
    expect(bug.found_by).toContain("shellcheck");
    expect(names(bug.mentions, `${SC2115.ruleId} ${SC2115.message}`.toLowerCase())).toBe(false);
    const job = scoreScanJob({ job: jobOf("demo-polyglot"), spec, scan: scanOf([SC2115]), origin: "planted" });
    expect(job.candidates[0]).toMatchObject({ outcome: "hit", bug: "shell-rm-unquoted", evidence: "finder", evidenceKind: "frozen" });
    expect(job.bugs.find((b) => b.id === "shell-rm-unquoted").found).toBe(true);
    expect(job.precision).toEqual({ correct: 1, unresolved: 0, of: 1 });
  });

  it("finds nothing with another scanner's candidate on those lines that lacks the words: a location match, unresolved", () => {
    const other = candidate("c1", "semgrep", "bash.lang.best-practice.recursive-removal", "scripts/deploy.sh", 7, 7, "Recursive removal of a path built from a variable.");
    expect(bug.found_by).not.toContain("semgrep");
    const job = scoreScanJob({ job: jobOf("demo-polyglot"), spec, scan: scanOf([other]), origin: "planted" });
    expect(job.candidates[0]).toMatchObject({ outcome: "unresolved", evidenceKind: "location-only" });
    expect(job.bugs.find((b) => b.id === "shell-rm-unquoted").found).toBe(false);
  });

  it("counts another scanner's candidate on those lines that names the spec's words as finding it", () => {
    const worded = candidate("c1", "semgrep", "bash.lang.correctness.unquoted-rm", "scripts/deploy.sh", 7, 7, "An unquoted variable in rm can delete the wrong path.");
    const job = scoreScanJob({ job: jobOf("demo-polyglot"), spec, scan: scanOf([worded]), origin: "planted" });
    expect(job.candidates[0]).toMatchObject({ outcome: "hit", bug: "shell-rm-unquoted", evidence: "words" });
  });

  it("counts OpenQodex's own suppression candidate as the finder the spec names, suppression", () => {
    const s = readCase("suppression-comments");
    const own = candidate("c2", "semgrep", "openqodex.suppression-added", "web/server.js", 12, 12, "This change adds a comment that stops a scanner reporting what it covers.");
    const job = scoreScanJob({ job: jobOf("suppression-comments"), spec: s, scan: scanOf([own]), origin: "planted" });
    expect(job.candidates[0]).toMatchObject({ outcome: "hit", bug: "suppressed-eval", finder: "suppression", evidence: "finder" });
  });

  it("never credits a custom scanner whose rule is named openqodex.suppression-added to the product's own suppression finder", () => {
    const s = readCase("suppression-comments");
    const custom = candidate("c1", "custom:mine", "openqodex.suppression-added", "web/server.js", 12, 12, "Flagged.");
    const job = scoreScanJob({ job: jobOf("suppression-comments"), spec: s, scan: scanOf([custom]), origin: "planted" });
    expect(job.candidates[0]).toMatchObject({ finder: "custom:mine", finders: ["custom:mine"] });
    // Its rule id names the bug's word "suppress", so it finds the bug by words, never as the expected finder.
    expect(job.candidates[0]).toMatchObject({ outcome: "hit", evidence: "words" });
    expect(job.bugs.find((b) => b.id === "suppressed-eval").expected.suppression).toBe("missed");
    expect(Object.keys(summarizeScanJobs([job]).perScanner)).toEqual(["custom:mine", "suppression"]);
    // A rule id that names an inherited property of a plain object is no own rule either.
    const odd = candidate("c1", "semgrep", "constructor", "web/server.js", 12, 12, "Flagged.");
    expect(scoreScanJob({ job: jobOf("suppression-comments"), spec: s, scan: scanOf([odd]), origin: "planted" }).candidates[0]).toMatchObject({ finder: "semgrep", finders: ["semgrep"] });
  });
});

describe("a second candidate on one bug lowers precision", () => {
  const spec = readCase("flask-path-traversal");

  it("counts the later candidates on a bug already found as redundancy, never in precision", () => {
    const one = scoreScanJob({ job: jobOf("flask-path-traversal"), spec, scan: scanOf(FLASK.slice(0, 1)), origin: "planted" });
    const four = scoreScanJob({ job: jobOf("flask-path-traversal"), spec, scan: scanOf(FLASK), origin: "planted" });
    expect(four.candidates.map((c) => c.outcome)).toEqual(["hit", "duplicate", "duplicate", "duplicate"]);
    expect(four.precision).toEqual(one.precision);
    const sum = summarizeScanJobs([four]);
    expect(sum.precision.lower).toEqual({ hit: 1, of: 1 });
    expect(sum.precision.upper).toEqual({ hit: 1, of: 1 });
    expect(sum.redundancy).toEqual({ hit: 3, of: 4 });
    expect(sum.issueRecall.all).toEqual({ hit: 1, of: 2 });
  });

  it("still counts a candidate on a clean change as false, the control failing", () => {
    const clean = readCase("clean-python-feature");
    const assert = candidate("c1", "bandit", "B101", "tests/test_money.py", 21, 21, "B101: Use of assert detected.");
    const job = scoreScanJob({ job: jobOf("clean-python-feature"), spec: clean, scan: scanOf([assert]), origin: "planted" });
    expect(job.candidates[0].outcome).toBe("false");
    expect(job.controls).toEqual({ hit: 0, of: 1 });
    expect(summarizeScanJobs([job]).precision.lower).toEqual({ hit: 0, of: 1 });
  });
});

describe("the scan rules are versioned", () => {
  // One hash per scan rules version; a change to any scan rule, or to a
  // review rule the scan score calls, moves the hash and fails this test
  // until SCAN_RULES_VERSION is bumped and the new hash added here.
  const KNOWN_SCAN_RULES = {
    1: "32eb61eedf50150d6adbbbc8af02897f62b56f015c01a32512adc6217215507b",
    // W8-2: Greptile suite scoring through its board judge, denominator fixed at 50.
    // PR 229: scanner outside advisories are information; legacy untagged findings still count.
    2: "3260fdcec7129a5bcdc427285e210475fbb7c83ee16de25e2c9e7888bfad5d86",
    // lineMatches now reads a finding with no line number as the whole file either way (issue 153).
    3: "e0f94164cc2f6a717fcf6f4e9d2f599bf994f083c178b1cd593e45c9903f6e07",
  };

  it("pins the hash of the scan rules block, its matching code included, to its version", () => {
    expect(SCAN_RULES.version).toBe(SCAN_RULES_VERSION);
    expect(SCAN_RULES.hash).toBe(rulesHash(SCAN_RULES));
    expect(SCAN_RULES.hash, "a scan rule changed: bump SCAN_RULES_VERSION in lib/scan-score.mjs and add the new version's hash to KNOWN_SCAN_RULES").toBe(KNOWN_SCAN_RULES[SCAN_RULES_VERSION]);
  });

  it("hashes the code the scan score runs, the review helpers it calls included", () => {
    const ids = scanRuleSources().map((s) => s.id);
    expect(ids).toContain("scan-score.mjs#scoreScanJob");
    expect(ids).toContain("score.mjs#names");
    expect(ids).toContain("score.mjs#population");
    const read = (file) => readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
    const mutated = (file) => (file === "score.mjs" ? read(file).replace("export function names(words, text) {", "export function names(words, text) {\n  void 0;") : read(file));
    expect(scanRuleCodeHash(mutated)).not.toBe(scanRuleCodeHash(read));
  });
});

// The rule packs semgrep consumed, as the adapter records them.
const PACKS = (sha) => [
  { pack: "p/default", sha256: sha, bytes: 2195213 },
  { pack: "p/security-audit", sha256: "5509b33efc0c08e2134ccb76f2c7172065f7ba4a89f28799661029e274c306c7", bytes: 433040 },
  { pack: "p/secrets", sha256: "7c0b0163d7cbfe44f16cec78556662655bedeec1d41c6e091ddef5d85c1d5eff", bytes: 82768 },
];
const SHA_A = "0f73d6aaf812385878f945dad0fa829fe4fb5a934d4c4ae674ce2b1bd8ff66ed";
const SHA_B = "1f73d6aaf812385878f945dad0fa829fe4fb5a934d4c4ae674ce2b1bd8ff66ed";
// The same rules as PACKS, as an edge that serves p/default's YAML form
// records them: one sha256 of the rules, another raw size.
const PACKS_YAML = (sha) => PACKS(sha).map((p) => (p.pack === "p/default" ? { ...p, bytes: 2423491 } : p));
const withPacks = (rules) => ({ ...scanOf([]), scanners: [{ ...ran("semgrep"), ...(rules ? { rules } : {}) }] });
const named = (packs) => packs.map(({ pack, sha256 }) => ({ pack, sha256 })).sort((a, b) => (a.pack < b.pack ? -1 : 1));

describe("a run whose samples consumed different Semgrep rule packs is accepted", () => {
  it("names the packs when every sample consumed the same rules", () => {
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(PACKS(SHA_A))])).toEqual(named(PACKS(SHA_A)));
  });

  it("takes two samples whose packs have one sha256 and other sizes, the JSON and YAML forms of one rule set, as one rule set", () => {
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(PACKS_YAML(SHA_A))])).toEqual(named(PACKS(SHA_A)));
    expect(semgrepPacksOf([withPacks(PACKS_YAML(SHA_A)), withPacks(PACKS(SHA_A))])).toEqual(named(PACKS(SHA_A)));
    expect(semgrepPacksOf([withPacks([...PACKS(SHA_A), PACKS_YAML(SHA_A)[0]])])).toEqual(named(PACKS(SHA_A)));
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(PACKS_YAML(SHA_B))])).toBe("mixed");
  });

  it("marks the run mixed when two samples consumed different bytes of one pack, and unknown when a sample's packs were not recorded", () => {
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(PACKS(SHA_B))])).toBe("mixed");
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(null)])).toBe("unknown");
    // A run where semgrep never ran consumed no pack.
    expect(semgrepPacksOf([scanOf([])])).toEqual([]);
  });

  it("marks the run mixed when two samples consumed different sets of packs with the same bytes for the packs they share, and unknown when a sample recorded an empty set", () => {
    const [first] = PACKS(SHA_A);
    expect(semgrepPacksOf([withPacks([first]), withPacks(PACKS(SHA_A))])).toBe("mixed");
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks([first])])).toBe("mixed");
    expect(semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks([])])).toBe("unknown");
    expect(semgrepPacksOf([withPacks([])])).toBe("unknown");
    // One sample that read two versions of one pack mixes two rule sets on its own.
    expect(semgrepPacksOf([withPacks([...PACKS(SHA_A), { ...first, sha256: SHA_B }])])).toBe("mixed");
  });

  it("refuses to accept a mixed run, and a scan run whose packs are unknown", () => {
    expect(externalRefusals({ mode: "scan", external: { semgrepPacks: "mixed" } }).join("\n")).toMatch(/different Semgrep rule packs/);
    expect(externalRefusals({ mode: "review", external: { semgrepPacks: "mixed" } }).join("\n")).toMatch(/different Semgrep rule packs/);
    expect(externalRefusals({ mode: "scan", external: { semgrepPacks: "unknown" } }).join("\n")).toMatch(/not recorded/);
    expect(externalRefusals({ mode: "scan", external: { semgrepPacks: PACKS(SHA_A) } })).toEqual([]);
    // The accept step itself: a scan entry that is a baseline in every other way.
    const entry = { mode: "scan", legacy: false, accepted: false, draft: false, build: { dirty: false }, ended: { how: "finished", why: null }, scannersComplete: true, scores: {}, external: { semgrepPacks: semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(PACKS(SHA_A))]) } };
    expect(acceptRefusals(entry)).toEqual([]);
    const mixed = { ...entry, external: { semgrepPacks: semgrepPacksOf([withPacks(PACKS(SHA_A)), withPacks(PACKS(SHA_B))]) } };
    expect(acceptRefusals(mixed).join("\n")).toMatch(/different Semgrep rule packs/);
  });
});

// One planted case scanned twice: the same samples, then one input or one
// output changed in the second pass.
const OSV = candidate("c6", "osv-scanner", "GHSA-35jh-r3h4-6jhm", "package-lock.json", 11, 11, "lodash@4.17.15: GHSA-35jh-r3h4-6jhm (CVE-2021-23337). Command Injection in lodash");
const OSV_NEW = candidate("c7", "osv-scanner", "GHSA-xxxx-yyyy-zzzz", "package-lock.json", 11, 11, "lodash@4.17.15: GHSA-xxxx-yyyy-zzzz. A new advisory in lodash");
const trailOf = (cands) => cands.map((c) => ({ token: c.token, file: c.filePath, lineStart: c.lineStart, lineEnd: c.lineEnd, severity: c.severity, stage: "kept", id: c.id }));
const demoScan = ({ osv = [OSV], sha = SHA_A, shell = SC2115, packs = PACKS } = {}) => {
  const cands = [shell, ...osv];
  return { ...scanOf(cands, [{ ...ran("semgrep"), rules: packs(sha) }, ran("shellcheck"), ran("osv-scanner")]), trail: trailOf(cands) };
};

// The other files run.mjs saves in a sample, as a real scan of the demo
// writes them; the time in the markdown's scanner table varies between passes.
const sampleFiles = (name) => ({
  "receipt.txt": "Passed with warnings: 2 findings (1 major, 1 minor)\n",
  "stderr.txt": "Scanners: 3 ran, 0 had nothing to check, 2 candidates to check\n",
  "report/report.md": `# OpenQodex scan\n\n## Scanners\n\n| Scanner | Status | Version | Found | Kept | Time | Reason |\n|---|---|---|---|---|---|---|\n| semgrep | ran | 1.94.0 | 10 | 9 | ${(name.length / 10).toFixed(1)} s |  |\n| sqllint | ran |  | 0 | 0 | 0.0 s |  |\n`,
  "report/report.sarif": JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "openqodex" } }, results: [{ ruleId: "shellcheck:SC2115", message: { text: "Use a guard." } }] }] }),
});

function savePass(root, name, scan, change = (files) => files) {
  const out = join(root, name);
  const caseId = "planted/demo-polyglot@00000000";
  const jobs = [{ jobId: `${caseId}/scan/1`, caseId, config: "scan", repeat: 1 }];
  const write = (path, data) => {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
  };
  write("cases/demo-polyglot.json", readFileSync(new URL("../cases/demo-polyglot/case.json", import.meta.url), "utf8"));
  const sample = { jobId: jobs[0].jobId, caseId, firstAttempt: true, case: "demo-polyglot", config: "scan", reviewer: null, graph: "off", repeat: 1, attempt: 1, started_at: `2026-10-11T10:00:0${name.length % 10}Z`, exit: 0, signal: null, wallMs: 3000 + name.length, status: "complete" };
  write("samples/demo-polyglot/scan/1/sample.json", sample);
  write("samples/demo-polyglot/scan/1/report/scan.json", scan);
  for (const [file, text] of Object.entries(change(sampleFiles(name)))) write(`samples/demo-polyglot/scan/1/${file}`, text);
  const external = externalOf({ samples: [{ caseId, startedAt: sample.started_at, scan }], preflight: { toolchainHash: "a".repeat(64), scannerVersions: { semgrep: "1.94.0" }, missing: [] } });
  write("manifest.json", { version: 3, runId: "2026-10-11-abc1234-planted-scan-laptop", started_at: sample.started_at, mode: "scan", path: "laptop", suite: "planted", split: "dev", build: { commit: "b".repeat(40), short: "bbbbbbb", dirty: false, bundleHash: "c".repeat(64), cliVersion: "0.13.0" }, cases: ["demo-polyglot"], caseIds: [caseId], configs: ["scan"], repeat: 1, planned: 1, jobs, external, ended: { at: sample.started_at, how: "finished", why: null, elapsedMin: name.length / 100 } });
  saveScore(out);
  return out;
}

describe("two scanner-only runs differ and nobody notices", () => {
  it("finds two passes with the same samples identical, whatever their times", () => {
    const root = tempDir("oq-bench-identical-");
    const result = comparePasses(savePass(root, "one", demoScan()), savePass(root, "two-pass", demoScan()));
    expect(result).toMatchObject({ identical: true, cause: null, differences: [], inputs: [] });
  });

  it("names a changed candidate as a product difference when the inputs are the same", () => {
    const root = tempDir("oq-bench-identical-");
    const moved = { ...SC2115, lineStart: 8, lineEnd: 8 };
    const result = comparePasses(savePass(root, "one", demoScan()), savePass(root, "two", demoScan({ shell: moved })));
    expect(result.identical).toBe(false);
    expect(result.cause).toBe("product");
    expect(result.differences.join("\n")).toMatch(/samples\/demo-polyglot\/scan\/1\/report\/scan\.json/);
  });

  it("reads changed advisory data as an input change, not a product change", () => {
    const before = osvAdvisoriesOf([{ caseId: "planted/demo-polyglot@00000000", scan: demoScan() }]);
    const after = osvAdvisoriesOf([{ caseId: "planted/demo-polyglot@00000000", scan: demoScan({ osv: [OSV, OSV_NEW] }) }]);
    expect(before.sha256).not.toBe(after.sha256);
    expect(inputDifferences({ osvAdvisories: before }, { osvAdvisories: after }).join("\n")).toMatch(/osv\.dev advisory data/);
    const root = tempDir("oq-bench-identical-");
    const result = comparePasses(savePass(root, "one", demoScan()), savePass(root, "two", demoScan({ osv: [OSV, OSV_NEW] })));
    expect(result.identical).toBe(false);
    expect(result.cause).toBe("input");
    expect(result.inputs.join("\n")).toMatch(/osv\.dev advisory data/);
  });

  it("names a second pass whose SARIF, markdown, receipt or stderr changed, or is missing, while every JSON file is the same", () => {
    const root = tempDir("oq-bench-identical-");
    const first = savePass(root, "one", demoScan());
    const sarif = savePass(root, "sarif", demoScan(), (f) => ({ ...f, "report/report.sarif": f["report/report.sarif"].replace("Use a guard.", "Use another guard.") }));
    const md = savePass(root, "md", demoScan(), (f) => ({ ...f, "report/report.md": f["report/report.md"].replace("| 10 | 9 |", "| 10 | 8 |") }));
    const receipt = savePass(root, "receipt", demoScan(), (f) => ({ ...f, "receipt.txt": "Passed with warnings: 3 findings (1 major, 2 minor)\n" }));
    const lost = savePass(root, "lost", demoScan(), (f) => {
      const { "stderr.txt": gone, ...rest } = f;
      return gone === undefined ? f : rest;
    });
    for (const [folder, file] of [[sarif, "report/report.sarif"], [md, "report/report.md"], [receipt, "receipt.txt"], [lost, "stderr.txt"]]) {
      const result = comparePasses(first, folder);
      expect(result.identical, file).toBe(false);
      expect(result.cause).toBe("product");
      expect(result.differences.join("\n")).toContain(`samples/demo-polyglot/scan/1/${file}`);
    }
    // The scanner times in the markdown differ between the passes "one" and "two-pass" and are left out.
    expect(comparePasses(first, savePass(root, "two-pass", demoScan())).identical).toBe(true);
  });

  it("reads other Semgrep rules as an input change", () => {
    const root = tempDir("oq-bench-identical-");
    const result = comparePasses(savePass(root, "one", demoScan()), savePass(root, "two", demoScan({ sha: SHA_B })));
    expect(result.identical).toBe(false);
    expect(result.cause).toBe("input");
    expect(result.inputs.join("\n")).toMatch(/Semgrep rule packs/);
  });

  it("finds two passes identical when the registry served one rule set in two forms of other sizes", () => {
    const root = tempDir("oq-bench-identical-");
    const result = comparePasses(savePass(root, "one", demoScan()), savePass(root, "two", demoScan({ packs: PACKS_YAML })));
    expect(result).toMatchObject({ identical: true, cause: null, differences: [], inputs: [] });
  });
});
