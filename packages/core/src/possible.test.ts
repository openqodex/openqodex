// Failure cases: possible items lose text, affect verdicts or counts, bypass
// severity filters, replace counted findings, or skip legacy change routing.
import { expect, it } from "vitest";
import { checkSubmission, finalizeReview } from "./finalize.js";
import { finding, makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "./test-fixtures.js";
import type { Config } from "./types.js";

function run(version: number, entries: Record<string, unknown>[], config: Partial<Config> = {}) {
  const change = makeChange();
  const args = { change, scan: makeScan({ candidates: [] }), manifest: makeManifest(change), config: makeConfig({ blockOnSeverity: "major", ...config }) };
  const findings = entries.map((entry) => ({ ...finding({ source: null, candidate: null }), problem: "The pool closes.", consequence: "put raises ShutDown.", fix: "Create a new pool.", ...entry }));
  if (version === 1) return finalizeReview({ ...args, submission: makeSubmission({ findings, dropped: [] }) });
  const checked = checkSubmission({ ...args, lineCount: () => 100, submission: { version: 2, change_id: change.id, summary: "Checked.", findings, dropped: [] } });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  return checked.report;
}
it.each([1, 2])("version %i shows a confirmed 0.55 issue with full text and ignores it in the verdict", (version) => {
  const report = run(version, [{ confidence: 0.55 }]);
  expect(report.possible).toEqual([expect.objectContaining({ confidence: 0.55, title: "SQL built from request input", suggested_change: expect.anything() })]);
  expect(report.possible[0].description).toContain(version === 2 ? "ShutDown" : "request");
  expect(report.findings).toEqual([]);
  expect(report.low_confidence).toEqual([]);
  expect(report.verdict).toBe("passed");
  expect(report.below_threshold).toBe(0);
});
it.each([1, 2])("version %i keeps a 0.45 issue under the floor with title only", (version) => {
  const report = run(version, [{ confidence: 0.45 }]);
  expect(report.possible).toEqual([]);
  expect(report.low_confidence).toEqual([{ title: "SQL built from request input", file_path: "app/search.py", confidence: 0.45, floor: 0.7 }]);
});
it.each([1, 2])("version %i retains the low-confidence trace of a possible item hidden by severity", (version) => {
  const report = run(version, [{ confidence: 0.55, severity: "minor" }], { severityThreshold: "major" });
  expect(report.possible).toEqual([]);
  expect(report.below_threshold).toBe(0);
  expect(report.low_confidence).toEqual([{ title: "SQL built from request input", file_path: "app/search.py", confidence: 0.55, floor: 0.7 }]);
});
it.each([1, 2])("version %i shows 0.75 under a 0.8 lens floor as possible", (version) => {
  // The fixture lens has a floor of 0.75. Raise it for this check below.
  const change = makeChange();
  const manifest = makeManifest(change);
  manifest.lenses[0]!.confidenceFloor = 0.8;
  const entry = { ...finding({ source: `lens:${manifest.lenses[0]!.name}`, candidate: null, confidence: 0.75 }), problem: "Wrong value.", consequence: "Wrong output.", fix: "Fix the value." };
  const args = { change, manifest, scan: makeScan({ candidates: [] }), config: makeConfig() };
  const checked = version === 1 ? { ok: true as const, report: finalizeReview({ ...args, submission: makeSubmission({ findings: [entry], dropped: [] }) }) } : checkSubmission({ ...args, lineCount: () => 100, submission: { version: 2, change_id: change.id, summary: "Checked.", findings: [entry], dropped: [] } });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  expect(checked.report.possible).toHaveLength(1);
  expect(checked.report.findings).toEqual([]);
});
it.each([1, 2])("version %i folds possible duplicates and never replaces a major counted item with a critical possible item", (version) => {
  for (const entries of [[{ confidence: 0.55, severity: "critical" }, { confidence: 0.9, severity: "major" }], [{ confidence: 0.9, severity: "major" }, { confidence: 0.55, severity: "critical" }]]) {
    const report = run(version, entries);
    expect(report.findings.map((f) => f.severity)).toEqual(["major"]);
    expect(report.possible).toEqual([]);
  }
  const report = run(version, [{ confidence: 0.55, severity: "minor" }, { confidence: 0.6, severity: "major" }]);
  expect(report.possible.map((f) => f.severity)).toEqual(["major"]);
});
it("labels legacy outside-change possible items with their confidence floor", () => {
  const report = run(1, [{ confidence: 0.55, file_path: "elsewhere.py" }]);
  expect(report.possible).toEqual([]);
  expect(report.outside_change).toEqual([expect.objectContaining({ confidence: 0.55, floor: 0.7, notes: ["the file is not in this change", "confidence under the floor, not counted"] })]);
});
