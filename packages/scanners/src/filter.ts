// Two filters applied to static-analysis findings before they reach
// the review: (1) keep only what overlaps changed lines (a reviewer
// cares about what THIS change did, pre-existing hits on untouched code
// are noise), and (2) drop findings inside test fixtures / mocks /
// snapshots (hardcoded secrets and intentionally-vulnerable patterns
// are the POINT of those files; flagging them wastes reviewer
// attention and bloats the noise budget).

import type { DiffCoverage, StaticFinding } from "@openqodex/core";

// Keeps the findings whose line range touches a changed line.
export function filterToChangedLines(
  findings: StaticFinding[],
  coverage: DiffCoverage,
): StaticFinding[] {
  return findings.filter((f) => overlapsCoverage(f, coverage));
}

function overlapsCoverage(f: StaticFinding, coverage: DiffCoverage): boolean {
  const lines = coverage.get(f.filePath);
  if (!lines || lines.size === 0) return false;
  // Walk the changed lines, not the span: a scanner's report can carry any
  // line number, and past 2^53 a counter over the span never advances.
  for (const line of lines) {
    if (f.lineStart <= line && line <= f.lineEnd) return true;
  }
  return false;
}

// Conservative fixture-path patterns. Match directory segments
// (fixtures, __fixtures__, mocks, __mocks__, snapshots,
// __snapshots__, fakes, stubs) and file-suffix flavours (.fixture.,
// .mock., .stub.). DELIBERATELY does NOT match `*.test.` /
// `*.spec.` / `**/test*/**` / `**/__tests__/**`: those are real
// test sources where a security finding (SQL injection in
// integration setup, hardcoded admin token in a test runner) is
// genuinely worth surfacing. Only paths whose primary purpose is
// "throwaway data shaped like the production thing" get filtered.
const FIXTURE_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)__fixtures__\//i,
  /(?:^|\/)fixtures\//i,
  /(?:^|\/)__mocks__\//i,
  /(?:^|\/)mocks\//i,
  /(?:^|\/)__snapshots__\//i,
  /(?:^|\/)snapshots\//i,
  /(?:^|\/)fakes\//i,
  /(?:^|\/)stubs\//i,
  /(?:^|\/)testdata\//i,
  /\.fixture\./i,
  /\.fixtures\./i,
  /\.mock\./i,
  /\.mocks\./i,
  /\.stub\./i,
  /\.stubs\./i,
  // Jest snapshot output. Generated, not hand-written; always noise.
  /\.snap$/i,
];

// True when the path looks like a test fixture / mock / snapshot. The scan
// reaches it through dropFixtureFindings; the library exports it for a host
// that sorts findings the same way.
export function isFixturePath(path: string): boolean {
  return FIXTURE_PATH_PATTERNS.some((re) => re.test(path));
}

export type FixtureFilterResult = {
  kept: StaticFinding[];
  droppedCount: number;
};

// Drop findings whose filePath matches a fixture pattern. Returns
// the survivors plus the drop count for the report. Called
// before cross-linter dedup so the dedup and the rank both ignore
// findings that wouldn't get a real human comment.
export function dropFixtureFindings(
  findings: StaticFinding[],
): FixtureFilterResult {
  const kept: StaticFinding[] = [];
  let droppedCount = 0;
  for (const f of findings) {
    if (isFixturePath(f.filePath)) {
      droppedCount++;
      continue;
    }
    kept.push(f);
  }
  return { kept, droppedCount };
}
