// The redaction pass over the scan before it is kept or written.
// Ways it could fail, written before the code:
// 1. A matched secret in a string other than the message (a file name, a
//    rule id, a reference) survives into scan.json or candidates.json.
// 2. The pass rewrites a candidate id or token, so the agent's citations no
//    longer match and finalize rejects a valid submission.
// The end-to-end stream holds the same check through real gitleaks output
// (a key in a file name, then scan.json and candidates.json searched for it).
import type { Candidate, Change, Config, RunManifest, ScanResult } from "@openqodex/core";
import { fingerprintSecrets, finalizeReview } from "@openqodex/core";
import { describe, expect, it } from "vitest";
import { redactStored } from "@openqodex/review";

const SECRET = ["sk", "live", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"].join("_");
const file = `keys/${SECRET}.txt`;

const candidate: Candidate = {
  id: "c1",
  token: "gitleaks:stripe-access-token",
  source: "gitleaks",
  ruleId: "stripe-access-token",
  filePath: file,
  lineStart: 1,
  lineEnd: 1,
  severity: "high",
  message: "Found a Stripe key",
  reference: `https://example.invalid/${SECRET}`,
  reviewSeverity: "major",
};

const scan: ScanResult = {
  candidates: [candidate],
  scanners: [],
  fixturesDropped: 0,
  secretFingerprints: fingerprintSecrets([SECRET]),
};

const change: Change = {
  repoRoot: "/repo",
  baseRef: "HEAD",
  baseSha: "0".repeat(40),
  id: "a".repeat(64),
  shortId: "a".repeat(12),
  files: [{ path: file, status: "added", oldPath: null, binary: false }],
  changedPaths: [file],
  coverage: new Map([[file, new Set([1])]]),
  deletionPoints: new Map(),
  diff: "",
  notReviewed: [],
  stats: { files: 1, additions: 1, deletions: 0 },
};

const config: Config = {
  blockOnSeverity: "major",
  exclude: [],
  disabledRules: [],
  includeFixtures: false,
  disabledScanners: [],
  custom: [],
};

const manifest: RunManifest = { version: 1, change_id: change.id, config_hash: "x", created_at: "", lenses: [] };

describe("redactStored", () => {
  it("a matched secret in a file name or reference is kept in the stored scan", () => {
    const stored = JSON.stringify(redactStored(scan, [SECRET]));
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("[redacted]");
  });

  it("the pass rewrites a candidate id or token, so finalize rejects a valid citation", () => {
    const stored = redactStored(scan, [SECRET]);
    expect(stored.candidates[0]?.id).toBe("c1");
    expect(stored.candidates[0]?.token).toBe("gitleaks:stripe-access-token");
    const report = finalizeReview({
      change,
      scan: stored,
      manifest,
      config,
      submission: { version: 1, change_id: change.id, summary: "", findings: [], dropped: [{ candidate: "c1", reason: "test key" }] },
    });
    expect(report.dropped.map((d) => d.candidate.id)).toEqual(["c1"]);
    expect(report.verdict).toBe("passed");
  });
});
