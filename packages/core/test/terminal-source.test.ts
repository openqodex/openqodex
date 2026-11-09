// Guards one failure: the terminal report prints a line holding only the
// word "agent" under a finding the agent raised from its own reading, while
// a scanner finding the agent verified must keep its scanner source line.
import { describe, expect, it } from "vitest";
import { renderTerminal } from "../src/render/index.js";
import type { Report, ReportFinding } from "../src/types.js";

function finding(over: Partial<ReportFinding>): ReportFinding {
  return {
    origin: "agent",
    severity: "major",
    category: "security",
    confidence: 0.9,
    file_path: "src/app.ts",
    line_number: 3,
    line_end: 3,
    title: "Query built from user input",
    description: "The id goes into the SQL text.",
    suggested_change: null,
    source: null,
    candidate: null,
    notes: [],
    ...over,
  };
}

function report(findings: ReportFinding[]): Report {
  return {
    version: 1,
    kind: "review",
    change_id: "c1",
    base: { ref: "origin/main", sha: "0".repeat(40) },
    generated_at: "2026-10-04T00:00:00.000Z",
    verdict: "passed",
    block_on_severity: null,
    summary: null,
    findings,
    below_threshold: 0,
    outside_change: [],
    possible: [], low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: [],
    impact: null,
    not_reviewed_paths: [],
    stats: { files: 1, additions: 1, deletions: 0 },
  };
}

describe("terminal report source line", () => {
  it("prints no stray 'agent' line under a finding from the agent's own reading", () => {
    const lines = renderTerminal(report([finding({})]), { color: false }).split("\n");
    expect(lines.map((l) => l.trim())).not.toContain("agent");
  });

  it("keeps the scanner source line under a scanner finding the agent verified", () => {
    const lines = renderTerminal(report([finding({ source: "semgrep:sql-injection", candidate: "c1" })]), {
      color: false,
    }).split("\n");
    expect(lines.map((l) => l.trim())).toContain("semgrep:sql-injection");
  });
});
