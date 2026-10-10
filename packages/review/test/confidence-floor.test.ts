// The confidence floor as one policy value: the brief tells the reviewer
// the floor and the check applies the same floor, while a lens's own higher
// floor still wins. The laptop passes no floor and must get the brief and
// the check it gets today.
//
// Ways it could fail, written before the code:
//  1. The laptop's brief changes by a byte when no floor is passed.
//  2. A server floor reaches the brief but not the check, or the other way.
//  3. A server floor below a lens's floor lowers that lens's floor.
//  4. A floor below 0.7 is clamped back to 0.7.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, buildReviewerBrief, checkSubmission } from "@openqodex/core";
import type { Change, RunManifest, ScanResult } from "@openqodex/core";

const change: Change = {
  repoRoot: "/r",
  baseRef: "main",
  baseSha: "a".repeat(40),
  id: "b".repeat(64),
  shortId: "bbbbbbbbbbbb",
  files: [{ path: "src/a.ts", oldPath: null, status: "modified", binary: false }],
  changedPaths: ["src/a.ts"],
  coverage: new Map([["src/a.ts", new Set([2])]]),
  deletionPoints: new Map(),
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-x\n+y\n",
  notReviewed: [],
  stats: { files: 1, additions: 1, deletions: 1 },
};
const scan = { candidates: [], scanners: [], secretFingerprints: [] } as unknown as ScanResult;
const manifest = (lensFloor: number): RunManifest => ({
  version: 3,
  change_id: change.id,
  config_hash: "h",
  created_at: "t",
  lenses: [{ name: "auth", confidenceFloor: lensFloor }],
  instructions_hash: null,
  runtime_version: "0",
});

const finding = (confidence: number, source: string | null = null) => ({
  severity: "major",
  category: "bug",
  confidence,
  file_path: "src/a.ts",
  line_number: 2,
  title: "Wrong value",
  problem: "The line returns y.",
  consequence: "Callers get the wrong value.",
  fix: "Return x.",
  source,
  candidate: null,
});

function check(confidence: number, opts: { floor?: number; lensFloor?: number; source?: string | null } = {}) {
  const r = checkSubmission({
    change,
    scan,
    manifest: manifest(opts.lensFloor ?? 0.7),
    config: DEFAULT_CONFIG,
    submission: { version: 2, change_id: change.shortId, summary: "s", findings: [finding(confidence, opts.source ?? null)], dropped: [] },
    lineCount: () => 3,
    ...(opts.floor !== undefined ? { confidenceFloor: opts.floor } : {}),
  });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.report;
}

const brief = (floor?: number) => buildReviewerBrief({ change, scan, lenses: [], config: DEFAULT_CONFIG, secrets: [], ...(floor !== undefined ? { confidenceFloor: floor } : {}) }).text;

describe("the confidence floor", () => {
  it("1. without a floor, the brief is the one the laptop gets today, with 0.7 in both places", () => {
    const text = brief();
    expect(text).toBe(brief(0.7));
    expect(text).toContain("5. Raise only real problems on lines this change added or modified, or next to a deletion, with confidence 0.7 or higher.");
    expect(text).toContain("- `confidence`: 0 to 1, set honestly. Findings under 0.7, or under a cited lens's floor, are not counted.");
  });

  it("2. a floor reaches both lines of the brief", () => {
    for (const floor of [0.5, 0.85]) {
      const text = brief(floor);
      expect(text).toContain(`with confidence ${floor} or higher.`);
      expect(text).toContain(`Findings under ${floor}, or under a cited lens's floor, are not counted.`);
      expect(text).not.toContain("0.7");
    }
  });

  it("2. the check applies the same floor: without one at 0.7, above and below it as given", () => {
    expect(check(0.65).findings).toEqual([]);
    expect(check(0.65).low_confidence).toEqual([expect.objectContaining({ confidence: 0.65, floor: 0.7 })]);
    expect(check(0.75).findings).toHaveLength(1);
    // 4. a floor below 0.7 is kept as given.
    expect(check(0.65, { floor: 0.5 }).findings).toHaveLength(1);
    expect(check(0.75, { floor: 0.8 }).findings).toEqual([]);
    expect(check(0.75, { floor: 0.8 }).low_confidence).toEqual([expect.objectContaining({ floor: 0.8 })]);
  });

  it("3. a lens's higher floor still wins over the server floor", () => {
    const low = check(0.85, { floor: 0.8, lensFloor: 0.9, source: "lens:auth" });
    expect(low.findings).toEqual([]);
    expect(low.low_confidence).toEqual([expect.objectContaining({ confidence: 0.85, floor: 0.9 })]);
    expect(check(0.95, { floor: 0.8, lensFloor: 0.9, source: "lens:auth" }).findings).toHaveLength(1);
    // A lens floor under the server floor does not lower it.
    expect(check(0.75, { floor: 0.8, lensFloor: 0.6, source: "lens:auth" }).findings).toEqual([]);
  });
});
