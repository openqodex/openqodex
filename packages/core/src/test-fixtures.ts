// Plain values of the frozen types, built by hand for the review-brain tests.
// They are real input to the functions under test, not stand-ins for code.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { fingerprintSecrets } from "./redact.js";
import type { Candidate, Change, Config, RunManifest, ScanResult } from "./types.js";

// Built from parts so this file never holds the secret as one literal.
export const SECRET = ["sk", "live", "Qw3rTy7890uIoPaSdF1234zx"].join("_");

const DIFF = [
  "diff --git a/app/search.py b/app/search.py",
  "index 1111111..2222222 100644",
  "--- a/app/search.py",
  "+++ b/app/search.py",
  "@@ -12,3 +12,4 @@ def search(request):",
  "     q = request.args.get(\"q\")",
  "     cur = db.cursor()",
  "-    cur.execute(\"SELECT * FROM items WHERE name = %s\", (q,))",
  "+    cur.execute(f\"SELECT * FROM items WHERE name = '{q}'\")",
  "+    return cur.fetchall()",
  "diff --git a/app/settings.py b/app/settings.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/app/settings.py",
  "@@ -0,0 +1,3 @@",
  "+import os",
  "+",
  `+API_KEY = "${SECRET}"`,
  "",
].join("\n");

export function makeChange(over: Partial<Change> = {}): Change {
  return {
    repoRoot: "/tmp/repo",
    baseRef: "origin/main",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    id: "3f9a1c0b2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4",
    shortId: "3f9a1c0b2d4e",
    files: [
      { path: "app/search.py", status: "modified", oldPath: null, binary: false },
      { path: "app/settings.py", status: "added", oldPath: null, binary: false },
    ],
    changedPaths: ["app/search.py", "app/settings.py"],
    coverage: new Map([
      ["app/search.py", makeLineSet([14, 15])],
      ["app/settings.py", makeLineSet([1, 2, 3])],
    ]),
    deletionPoints: new Map(),
    diff: DIFF,
    notReviewed: [],
    stats: { files: 2, additions: 5, deletions: 1 },
    ...over,
  };
}

export function makeConfig(over: Partial<Config> = {}): Config {
  return {
    blockOnSeverity: null,
    severityThreshold: "info",
    defaultBase: null,
    graph: { enabled: true, budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 512 * 1024, maxCacheMb: 512, maxHeapMb: 1536 },
    exclude: [],
    disabledRules: [],
    includeFixtures: false,
    instructionsFiles: [],
    stages: true,
    disabledScanners: [],
    custom: [],
    ...over,
  };
}

export const SQL_CANDIDATE: Candidate = {
  id: "c1",
  token: "semgrep:python.lang.security.audit.formatted-sql-query",
  source: "semgrep",
  ruleId: "python.lang.security.audit.formatted-sql-query",
  filePath: "app/search.py",
  lineStart: 14,
  lineEnd: 14,
  severity: "high",
  reviewSeverity: "major",
  message: "Detected possible formatted SQL query. Use parameterized queries instead.",
  reference: "https://semgrep.dev/r/python.lang.security.audit.formatted-sql-query",
};

export const KEY_CANDIDATE: Candidate = {
  id: "c2",
  token: "gitleaks:generic-api-key",
  source: "gitleaks",
  ruleId: "generic-api-key",
  filePath: "app/settings.py",
  lineStart: 3,
  lineEnd: 3,
  severity: "critical",
  reviewSeverity: "critical",
  message: "Detected a Generic API Key, potentially exposing access to various services.",
  reference: null,
};

export const LINT_CANDIDATE: Candidate = {
  id: "c3",
  token: "ruff:F401",
  source: "ruff",
  ruleId: "F401",
  filePath: "app/settings.py",
  lineStart: 1,
  lineEnd: 1,
  severity: "low",
  reviewSeverity: "nitpick",
  message: "`os` imported but unused",
  reference: null,
};

export function makeScan(over: Partial<ScanResult> = {}): ScanResult {
  return {
    candidates: [SQL_CANDIDATE, KEY_CANDIDATE, LINT_CANDIDATE],
    scanners: [
      { scanner: "semgrep", status: "ran", version: "1.94.0", rawCount: 1, keptCount: 1, durationMs: 4100, reason: null },
      { scanner: "gitleaks", status: "ran", version: "8.21.2", rawCount: 1, keptCount: 1, durationMs: 300, reason: null },
      { scanner: "ruff", status: "ran", version: "0.7.0", rawCount: 2, keptCount: 1, durationMs: 90, reason: null },
      { scanner: "hadolint", status: "no_matching_files", version: null, rawCount: 0, keptCount: 0, durationMs: 0, reason: null },
      {
        scanner: "brakeman",
        status: "not_installed",
        version: null,
        rawCount: 0,
        keptCount: 0,
        durationMs: 0,
        reason: "needs Ruby 2.7 or newer",
      },
    ],
    fixturesDropped: 0,
    secretFingerprints: fingerprintSecrets([SECRET]),
    ...over,
  };
}

export function makeManifest(change: Change, over: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    change_id: change.id,
    config_hash: "0".repeat(64),
    created_at: "2026-10-01T12:00:00.000Z",
    lenses: [{ name: "sql-string-concatenation", confidenceFloor: 0.75 }],
    ...over,
  };
}

// A valid submission that raises c1, drops c2 and leaves c3 alone.
export function makeSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    change_id: "3f9a1c0b2d4e",
    summary: "Builds the search query from request input and adds a settings module.",
    findings: [
      {
        severity: "critical",
        category: "security",
        confidence: 0.9,
        file_path: "app/search.py",
        line_number: 14,
        line_end: 14,
        title: "SQL built from request input",
        description: "q comes from the request and is formatted into the query, so it can inject SQL.",
        suggested_change: 'cur.execute("SELECT * FROM items WHERE name = %s", (q,))',
        source: SQL_CANDIDATE.token,
        candidate: "c1",
      },
    ],
    dropped: [{ candidate: "c2", reason: "a sample key in a local settings file" }],
    ...over,
  };
}

// One finding with fields replaced, for submissions that differ in one place.
export function finding(over: Record<string, unknown>): Record<string, unknown> {
  const base = (makeSubmission().findings as Record<string, unknown>[])[0] ?? {};
  return { ...base, ...over };
}
