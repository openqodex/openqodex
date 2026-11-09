// Failures guarded:
// 1. Eleven unread ranges lose a name in JSON, Markdown, HTML or SARIF.
// 2. The receipt shows all unread ranges instead of ten and a report pointer.
// 3. Per-file coverage omits a file or loses brief, page or read labels.
// 4. A complete review omits the receipt's coverage line or its zero counts.
// 5. Digested-only files are omitted or described as line reads.
// 6. Legacy receipts invent coverage labels that were never recorded.
// 7. Split coverage pieces inflate the inventory range counts.
// 8. Deletion fragments sort by source instead of old-line position.
// 9. Files without ranges disappear and Markdown file lines join a bullet.
import { expect, it } from "vitest";
import { completionRecord, readCoverage } from "../../src/completion.js";
import type { Hunk } from "../../src/completion.js";
import { finalizeReview } from "../../src/finalize.js";
import { renderHtml } from "../../src/render/html.js";
import { renderJson } from "../../src/render/json.js";
import { renderReceipt, renderReview } from "../../src/render/review.js";
import { renderSarif } from "../../src/render/sarif.js";
import { makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "../../src/test-fixtures.js";
import type { CompletionRecord, Report, ReviewerRecord } from "../../src/types.js";

const reviewer: ReviewerRecord = { driver: "claude", version: "test", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
const paths = { html: "/r/report.html", md: "/r/report.md" };

function report(coverage: CompletionRecord["coverage"]): Report {
  const change = makeChange();
  const completion = completionRecord({ change, reviewer, coverage, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false });
  return { ...finalizeReview({ change, manifest: makeManifest(change), submission: makeSubmission({ findings: [], dropped: [] }), scan: makeScan({ candidates: [], scanners: [] }), config: makeConfig() }), completion, verdict: completion.status === "complete" ? "passed" : "incomplete" };
}

function unreadReport(): Report {
  const obligations: Hunk[] = Array.from({ length: 11 }, (_, i) => ({ path: `src/file${i + 1}.ts`, start: 1, end: 5, deletion: false }));
  return report(readCoverage({ change: makeChange(), obligations, trace: [] }));
}

it("7k. eleven unread ranges lose their own entries in JSON, Markdown, HTML or SARIF", () => {
  const r = unreadReport();
  const expected = ["11 changed ranges were not examined", ...Array.from({ length: 11 }, (_, i) => `src/file${i + 1}.ts:1-5`)];
  expect(JSON.parse(renderJson(r)).completion.missing).toEqual(expected);
  const md = renderReview(r, { format: "markdown" });
  const html = renderHtml({ report: r, display: null });
  for (const label of expected) {
    expect(md).toContain(`### ${label}\n`);
    expect(html).toContain(`<li>${label}</li>`);
  }
  const sarif = JSON.parse(renderSarif(r)).runs[0];
  expect(sarif.properties.completion.missing).toEqual(expected);
  expect(sarif.invocations[0].executionSuccessful).toBe(false);
  expect(sarif.invocations[0].toolExecutionNotifications[0].message.text).not.toContain("src/file11.ts:1-5");
  expect(sarif.invocations[0].toolExecutionNotifications[0].message.text).toContain("and 1 more; the report names each one");
});

it("7k. the receipt limits eleven unread entries to ten and names the report", () => {
  const receipt = renderReceipt(unreadReport(), paths);
  expect(receipt).toContain("11 changed ranges were not examined");
  for (let n = 1; n <= 10; n++) expect(receipt).toContain(`src/file${n}.ts:1-5`);
  expect(receipt).not.toContain("src/file11.ts:1-5");
  expect(receipt).toContain("and 1 more; the report names each one");
  expect(receipt).toContain("Changed ranges: 0 in a finder's brief, 0 structural summary, 0 by page, 0 read by the reviewer, 11 not examined");
});

it("3. per-file coverage loses brief, page or read labels or files past the tenth", () => {
  const hunk = { path: "src/big.ts", start: 1, end: 7000, deletion: false };
  const extra = Array.from({ length: 11 }, (_, i) => ({ path: `src/extra${i + 1}.ts`, start: 1, end: 2, deletion: false }));
  const coverage = readCoverage({ change: makeChange(), obligations: [{ ...hunk, end: 3000 }, { ...hunk, start: 3001, end: 6000 }, { ...hunk, start: 6001 }, ...extra], briefCarried: [{ ...hunk, end: 3000 }, { ...hunk, start: 3001, end: 6000 }, ...extra], delivered: [{ ...hunk, start: 6001, end: 6400 }], trace: [{ tool: "Read", path: hunk.path, range: [1, 7000], ok: true, inside: true }] });
  const r = report(coverage);
  expect(renderReceipt(r, paths)).toContain("Changed ranges: 13 in a finder's brief, 0 structural summary, 1 by page, 0 read by the reviewer, 0 not examined");
  const expected = "src/big.ts: 1-3000 brief, 3001-6000 brief, 6001-6400 page, 6401-7000 read";
  const md = renderReview(r, { format: "markdown" });
  const html = renderHtml({ report: r, display: null });
  expect(md).toContain(expected);
  expect(html).toContain(expected);
  expect(md.indexOf(expected)).toBeGreaterThan(md.indexOf("Changed ranges given to the reviewer"));
  for (let n = 1; n <= 11; n++) {
    expect(md).toContain(`src/extra${n}.ts: 1-2 brief`);
    expect(html).toContain(`src/extra${n}.ts: 1-2 brief`);
  }
});

it("4. a complete review loses the receipt coverage line with zero structural summaries and unread ranges", () => {
  const refs = ["brief.ts", "page.ts", "read.ts"].map((path) => ({ path, start: 1, end: 2, deletion: false }));
  const coverage = readCoverage({ change: makeChange(), obligations: refs, briefCarried: [refs[0]!], delivered: [refs[1]!], trace: [{ tool: "Read", path: "read.ts", range: [1, 2], ok: true, inside: true }] });
  const receipt = renderReceipt(report(coverage), paths);
  expect(receipt.split("\n").filter((line) => line.startsWith("Changed ranges:"))).toEqual(["Changed ranges: 1 in a finder's brief, 0 structural summary, 1 by page, 1 read by the reviewer, 0 not examined"]);
});

it("5. digested-only files lose their structural summary label", () => {
  const ref = { path: "runs/x.json", start: 1, end: 11710, deletion: false };
  const r = report(readCoverage({ change: makeChange(), obligations: [ref], digestCarried: [ref], trace: [] }));
  expect(renderReview(r, { format: "markdown" })).toContain("runs/x.json: 1-11710 structural summary");
  expect(renderHtml({ report: r, display: null })).toContain("runs/x.json: 1-11710 structural summary");
  expect(renderReceipt(r, paths)).toContain("Changed ranges: 0 in a finder's brief, 1 structural summary, 0 by page, 0 read by the reviewer, 0 not examined");
});

it("6. legacy receipts invent source counts without coverage labels", () => {
  const r = report({ hunks: 2, covered: 2, unread: [], files_read: [], files_not_read: [] });
  expect(renderReceipt(r, paths)).toContain("Changed ranges: 2 examined, 0 not examined; coverage labels not recorded");
  delete r.completion;
  expect(renderReceipt(r, paths)).toContain("Changed ranges: not recorded in this report");
});

it("C3 fix 1. separated brief pieces count as one range before fallback reads", () => {
  const h = { path: "a.py", start: 1, end: 10, deletion: false };
  const coverage = readCoverage({ change: makeChange(), obligations: [h], briefCarried: [{ ...h, end: 3 }, { ...h, start: 7 }], trace: [{ tool: "Read", path: h.path, range: [4, 6], ok: true, inside: true }] });
  expect(renderReceipt(report(coverage), paths)).toContain("Changed ranges: 1 in a finder's brief, 0 structural summary, 0 by page, 0 read by the reviewer, 0 not examined");
});

it("C3 fix 4. unread deletion fragment prints before a later brief fragment", () => {
  const refs: Hunk[] = [21, 26].map((oldStart, i) => ({ path: "a.py", start: 4, end: 5, deletion: { id: "a.py#0", oldStart, oldEnd: oldStart + 4 }, part: { n: i + 1, of: 2, whole: "h1" } }));
  const r = report(readCoverage({ change: makeChange(), obligations: refs, briefCarried: [refs[1]!], trace: [] }));
  const expected = "a.py: 4-5 (deletion a.py#0, old lines 21-25) (part 1 of 2) not examined, 4-5 (deletion a.py#0, old lines 26-30) (part 2 of 2) brief";
  expect(renderReview(r, { format: "terminal" })).toContain(expected);
  expect(renderHtml({ report: r, display: null })).toContain(expected);
});

it("C3 fix 5. files without changed lines keep their status outside the Markdown bullet", () => {
  const change = makeChange({ files: [
    { path: "a.png", status: "modified", oldPath: null, binary: true },
    { path: "b.py", status: "renamed", oldPath: "old.py", binary: false },
    { path: "c.sh", status: "modified", oldPath: null, binary: false },
  ], coverage: new Map(), deletionPoints: new Map() });
  const r = report(readCoverage({ change, trace: [] }));
  const md = renderReview(r, { format: "markdown" });
  const html = renderHtml({ report: r, display: null });
  const expected = ["a.png: binary, not reviewed by line", "b.py: renamed, no changed lines", "c.sh: mode change only"];
  for (const line of expected) {
    expect(md).toContain(line);
    expect(html).toContain(line);
  }
  expect(md).toContain("- **Changed ranges given to the reviewer:** 0 of 0\n\na.png:");
});
