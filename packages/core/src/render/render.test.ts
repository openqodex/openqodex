// Ways the renderers could fail, written before the code:
// 1. Terminal output carries escape codes when colour is off.
// 2. The verdict line is not first, or warn mode with findings does not say
//    "Passed with warnings".
// 3. A section (outside the changed lines, not reviewed, dropped) is lost.
// 4. The coverage line misstates which scanners ran and why others did not.
// 5. A secret reaches any rendered output.
// 6. SARIF does not parse, is not 2.1.0, or mixes sources in one run.
// 7. Markdown breaks its table on a pipe in a title, or names the hosted
//    product more than once or in a scan report.
// 8. An incomplete review renders as an ordinary SARIF run with no results,
//    which a code scanning view reads as clean.
// 9. The blast radius line counts a symbol the change moved as removed.
// 10. The blast radius line says nothing when the graph could not see every
//     call (a floor), or leaves out the public names the change removed.
import { describe, expect, it } from "vitest";
import { DISABLED_REASON } from "../config.js";
import { finalizeReview, scanReport } from "../finalize.js";
import { SECRET, finding, makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "../test-fixtures.js";
import type { CompletionRecord, Config, ImpactSummary, Report } from "../types.js";
import { renderHtml, renderJson, renderMarkdown, renderSarif, renderTerminal } from "./index.js";
import { renderFindingDetails, renderReceipt, renderReview } from "./review.js";

// Failure case: an unverified candidate looks like a low-confidence finding.
it("renders a staged candidate's not verified reason in the receipt, terminal, markdown and html", () => {
  const report = review();
  report.low_confidence = [{ title: "Unchecked operation", file_path: "app/search.py", confidence: 0.8, floor: 0.7, reason: "not verified" }];
  for (const output of [renderReview(report, { format: "terminal", color: false }), renderTerminal(report, { color: false }), renderReview(report, { format: "markdown" }), renderMarkdown(report), renderHtml({ report, display: null })]) {
    expect(output).toContain("not verified");
  }
});

function review(submission = makeSubmission(), config: Partial<Config> = {}): Report {
  const change = makeChange();
  return finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig(config),
    submission,
  });
}

// A review that touches every section: a finding, one outside the change,
// one under the floor, a dropped candidate and a not-reviewed one.
function fullReview(config: Partial<Config> = {}): Report {
  return review(
    makeSubmission({
      summary: `Adds a settings module holding ${SECRET}.`,
      findings: [
        finding({ title: "SQL built | from input", description: `Injectable; seen next to ${SECRET}.` }),
        finding({ source: null, candidate: null, file_path: "app/other.py", title: "Elsewhere" }),
        finding({ source: null, candidate: null, confidence: 0.45, title: "Unsure" }),
      ],
    }),
    config,
  );
}

const ESC = String.fromCharCode(27);

describe("renderTerminal", () => {
  it("has no escape codes with colour off and puts the verdict first", () => {
    const out = renderTerminal(fullReview(), { color: false });
    expect(out).not.toContain(ESC);
    expect(out.split("\n")[0]).toBe("Passed with warnings: 2 findings (1 critical, 1 nitpick); 1 of 4 scanners did not run");
  });

  it("shows every section and the coverage line", () => {
    const out = renderTerminal(fullReview(), { color: false });
    expect(out).toContain("Critical (1)");
    expect(out).toContain("  app/search.py:14  SQL built | from input");
    expect(out).toContain(`    semgrep:python.lang.security.audit.formatted-sql-query`);
    expect(out).toContain("Outside the changed lines");
    expect(out).toContain("  app/other.py:14  Elsewhere");
    expect(out).toContain("Not reviewed by the agent\n  c3 [ruff:F401] app/settings.py:1 (nitpick)");
    expect(out).toContain("Dropped by the agent\n  c2 [gitleaks:generic-api-key] app/settings.py:3: a sample key");
    expect(out).toContain("Below the confidence floor");
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "3 scanners ran, 1 had nothing to check, 1 not included (brakeman: needs Ruby 2.7 or newer)",
    );
  });

  it("says Blocked when the threshold is met", () => {
    const out = renderTerminal(fullReview({ blockOnSeverity: "critical" }), { color: false });
    expect(out.split("\n")[0]).toBe("Blocked: 1 finding at or above critical (1 critical, 1 nitpick); 1 of 4 scanners did not run");
  });

  it("says Passed with no findings on a clean change", () => {
    const report = review(makeSubmission({ findings: [], dropped: [] }));
    const clean = { ...report, not_reviewed: [], scanners: report.scanners.filter((s) => s.status !== "not_installed") };
    expect(renderTerminal(clean, { color: false }).split("\n")[0]).toBe("Passed: no findings");
  });

  it("9. counts a symbol the change moved apart from one it removed in the blast radius line", () => {
    const base = { kind: "function" as const, startLine: 1, endLine: 3, snapshot: "base" as const };
    const impact = emptyImpactFixture();
    impact.risk = "low";
    impact.touched = ["b.ts#t@1:1"];
    impact.removed = ["base:a.ts#gone@1:17", "base:a.ts#place@5:17"];
    impact.symbols = [
      { id: "b.ts#t@1:1", file: "b.ts", name: "t", kind: "function", startLine: 1, endLine: 2, snapshot: "current" },
      { ...base, id: "base:a.ts#gone@1:17", file: "a.ts", name: "gone" },
      { ...base, id: "base:a.ts#place@5:17", file: "a.ts", name: "place", movedTo: { id: "c.ts#place@1:17", file: "c.ts", line: 1 } },
    ];
    const out = renderTerminal({ ...review(), impact }, { color: false });
    expect(out).toContain("Blast radius: risk low (1 symbol touched, 1 removed, 1 moved, 0 callers in 0 files)");
  });

  it("10. says when the callers are a floor and how many public names the change removed", () => {
    const impact = emptyImpactFixture();
    impact.risk = "high";
    impact.touched = ["b.ts#t@1:1"];
    impact.symbols = [{ id: "b.ts#t@1:1", file: "b.ts", name: "t", kind: "function", startLine: 1, endLine: 2, snapshot: "current" }];
    impact.exports = [{ file: "b.ts", name: "api", change: "removed", line: 3, before: null, after: null, consumers: [], consumersTotal: 0 }];
    impact.unknown = { ...impact.unknown, floor: true };
    const out = renderTerminal({ ...review(), impact }, { color: false });
    expect(out).toContain("Blast radius: risk high (1 symbol touched, 1 public name changed, 0 callers in 0 files, a floor: some calls the graph could not see)");
  });
});

function emptyImpactFixture(): ImpactSummary {
  return {
    version: 2,
    status: "ok",
    reasons: [],
    risk: "none",
    build: { durationMs: 1, cacheHits: 0, parses: 3, eligibleFiles: 3, parsedFiles: 3, omittedFiles: 0, unresolvedSites: 0, externalSites: 0, mode: "fresh", generation: null },
    symbols: [],
    touched: [],
    removed: [],
    callers: [],
    callees: [],
    importers: [],
    hubs: [],
    exports: [],
    unknown: { floor: false, seeds: [], causes: {}, near: [], nearTotal: 0, notRead: [], notReadTotal: 0 },
    cuts: [],
    truncated: { walk: false, inline: false, omittedSites: null },
    packet: null,
  };
}

describe("renderMarkdown", () => {
  it("renders the findings table with escaped pipes and one closing line", () => {
    const out = renderMarkdown(fullReview());
    expect(out).toContain("| critical | `app/search.py:14` | **SQL built \\| from input**");
    expect(out).toContain("## Outside the changed lines");
    expect(out).toContain("## Not reviewed by the agent");
    expect(out).toContain("## Dropped by the agent");
    expect(out).toContain("<details><summary>Scanner details</summary>");
    expect(out.match(/Made by Qodex/g)).toHaveLength(1);
    expect(out.trimEnd().endsWith("Made by Qodex: review on every pull request at https://qodex.ai")).toBe(true);
  });

  it("leaves the hosted product out of a scan report", () => {
    const out = renderMarkdown(scanReport({ change: makeChange(), scan: makeScan(), config: makeConfig() }));
    expect(out).not.toContain("Qodex:");
    expect(out).toContain("# OpenQodex scan");
  });
});

describe("renderSarif", () => {
  it("8. marks an incomplete review as a failed run that names what is missing and carries the completion record", () => {
    const completion: CompletionRecord = { version: 1, contract: "openqodex-review-2", status: "incomplete", missing: ["the reviewer timed out and was stopped"], reviewer: null, snapshot: { change_id: "x", tree: null, before: "b", after: "b" }, candidates: { total: 1, disposed: 0 }, coverage: { hunks: 1, covered: 0, unread: [], files_read: [], files_not_read: [] }, outside_reads: [], trace_complete: true };
    const report: Report = { ...review(), findings: [], verdict: "incomplete", completion };
    const run = JSON.parse(renderSarif(report)).runs[0];
    expect(run.tool.driver.name).toBe("openqodex");
    expect(run.invocations[0].executionSuccessful).toBe(false);
    expect(run.invocations[0].toolExecutionNotifications[0].message.text).toContain("the reviewer timed out and was stopped");
    expect(run.properties.completion.status).toBe("incomplete");
    const complete = JSON.parse(renderSarif({ ...review(), completion: { ...completion, status: "complete", missing: [] } })).runs[0];
    expect(complete.invocations[0].executionSuccessful).toBe(true);
  });

  it("parses as SARIF 2.1.0 with one run per source", () => {
    const sarif = JSON.parse(renderSarif(fullReview()));
    expect(sarif.version).toBe("2.1.0");
    const names = sarif.runs.map((r: { tool: { driver: { name: string } } }) => r.tool.driver.name);
    expect(names).toEqual(["openqodex", "ruff"]);
    expect(new Set(names).size).toBe(names.length);
    const agent = sarif.runs[0].results;
    expect(agent).toHaveLength(1);
    expect(agent[0].level).toBe("error");
    expect(agent[0].locations[0].physicalLocation.region.startLine).toBe(14);
  });

  it("gives each scanner its own run in a scan report, custom scanners included", () => {
    const custom = {
      ...makeScan().candidates[2]!,
      id: "c4",
      source: "custom:trivy" as const,
      token: "custom:trivy:DS002",
      ruleId: "DS002",
    };
    const scan = makeScan();
    const report = scanReport({
      change: makeChange(),
      scan: {
        ...scan,
        candidates: [...scan.candidates, custom],
        scanners: [
          ...scan.scanners,
          { scanner: "custom:trivy", status: "ran", version: "0.56.0", rawCount: 1, keptCount: 1, durationMs: 10, reason: null },
        ],
      },
      config: makeConfig(),
    });
    const sarif = JSON.parse(renderSarif(report));
    const runs = sarif.runs.map((r: { tool: { driver: { name: string } }; results: unknown[] }) => [
      r.tool.driver.name,
      r.results.length,
    ]);
    expect(runs).toEqual([
      ["openqodex", 0],
      ["semgrep", 1],
      ["gitleaks", 1],
      ["ruff", 1],
      ["custom:trivy", 1],
    ]);
  });
});

// Review round 1:
// R3. Terminal control characters or newlines in agent or scanner text reach
//     the terminal and can clear the screen or forge a verdict or section.
// R6. A lone carriage return, or a pipe or newline in a code cell, breaks the
//     markdown table or forges a heading.
// R7. SARIF uris carry unescaped file names.
describe("renderers: review round 1", () => {
  const ESC_CHAR = String.fromCharCode(27);
  const C1 = String.fromCharCode(0x9b);

  it("R3: terminal output carries no control characters from agent or scanner text", () => {
    const base = fullReview();
    const report: Report = {
      ...base,
      findings: base.findings.map((f) => ({ ...f, title: `x${ESC_CHAR}[2J${ESC_CHAR}[HPassed: no findings\nCritical (9)${C1}31m` })),
      not_reviewed: base.not_reviewed.map((c) => ({ ...c, message: `m\r\nBlocked: forged${ESC_CHAR}[0m` })),
      scanners: base.scanners.map((s) => (s.reason ? { ...s, reason: `r\n\tPassed${ESC_CHAR}]0;t${String.fromCharCode(7)}` } : s)),
    };
    const out = renderTerminal(report, { color: false });
    expect(out).not.toContain(ESC_CHAR);
    expect(out).not.toContain(C1);
    expect(out).not.toContain(String.fromCharCode(7));
    expect(out).not.toContain("\r");
    expect(out.split("\n").some((l) => l.startsWith("Blocked: forged") || l.startsWith("Critical (9)") || l.startsWith("Passed: no"))).toBe(false);
    expect(out).toContain("[2J[HPassed: no findings Critical (9)");
  });

  it("R6: markdown turns every line ending into a table-safe break and keeps code cells in their column", () => {
    const base = fullReview();
    const report: Report = {
      ...base,
      summary: "Fine.\r\r## Passed\r",
      findings: base.findings.map((f) => ({ ...f, title: "Problem\r\r## Passed\r\r", file_path: "app/a|b\n.py" })),
    };
    const out = renderMarkdown(report);
    expect(out).not.toContain("\r");
    expect(out.split("\n").some((l) => l.startsWith("## Passed"))).toBe(false);
    const row = out.split("\n").find((l) => l.startsWith("| critical |")) ?? "";
    expect(row.split(/(?<!\\)\|/).length).toBe(6);
  });

  it("R7: SARIF uris percent-encode each path segment and keep the slashes", () => {
    const base = fullReview();
    const report: Report = { ...base, findings: base.findings.map((f) => ({ ...f, file_path: "src/a#b c%?.ts" })) };
    const sarif = JSON.parse(renderSarif(report));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("src/a%23b%20c%25%3F.ts");
  });
});

describe("no rendered output contains a secret", () => {
  it("holds for all four renderers", () => {
    const report = fullReview();
    for (const out of [
      renderTerminal(report, { color: false }),
      renderMarkdown(report),
      renderJson(report),
      renderSarif(report),
    ]) {
      expect(out).not.toContain(SECRET);
    }
  });
});

// Failure cases: failed scanners say Passed; idle scanners inflate selected counts;
// a scanner disabled in the config counts as did not run; a scanner --offline
// skipped vanishes from the count as if disabled; finding verdicts lose their
// coverage clause; all-ran verdicts change; outputs disagree.
describe("verdict scanner coverage", () => {
  function outputs(r: Report): string[] {
    return [renderTerminal(r, { color: false }), renderMarkdown(r), renderHtml({ report: r, display: null, version: "test" })];
  }
  it("reports a failed scanner without claiming Passed or counting idle scanners", () => {
    const scan = makeScan({ candidates: [], scanners: makeScan().scanners.map((s) => s.scanner === "brakeman" ? { ...s, status: "failed", reason: "process exited 1" } : s) });
    const r = scanReport({ change: makeChange(), scan, config: makeConfig() });
    for (const output of outputs(r)) {
      expect(output).toContain("No findings from 3 of 4 scanners; 1 did not run (1 failed)");
      expect(output).not.toContain("Passed");
    }
    expect(r.verdict).toBe("passed");
  });
  it("lists only applicable reasons when missing and failed scanners occur together", () => {
    const r = review(makeSubmission({ findings: [], dropped: [] }));
    r.not_reviewed = [];
    r.scanners[0] = { ...r.scanners[0]!, status: "failed" };
    for (const output of outputs(r)) expect(output).toContain("No findings from 2 of 4 scanners; 2 did not run (1 not installed, 1 failed)");
  });
  it.each([
    ["Passed with warnings", () => fullReview()],
    ["Blocked", () => fullReview({ blockOnSeverity: "critical" })],
    ["Passed", () => review(makeSubmission({ findings: [finding({ severity: "minor" })] }), { blockOnSeverity: "major" })],
  ] as const)("keeps the %s verdict and appends how many scanners did not run", (word, make) => {
    const r = make();
    const line = renderTerminal(r, { color: false }).split("\n")[0]!;
    expect(line.startsWith(`${word}: `), line).toBe(true);
    expect(line.endsWith("; 1 of 4 scanners did not run"), line).toBe(true);
    for (const output of outputs(r)) expect(output).toContain(line);
  });
  it("leaves a scanner disabled in the config out of both numbers and counts one skipped offline", () => {
    const r = review(makeSubmission({ findings: [], dropped: [] }));
    r.not_reviewed = [];
    r.scanners.push({ ...r.scanners[0]!, scanner: "bandit", status: "disabled", version: null, reason: DISABLED_REASON });
    for (const output of outputs(r)) expect(output).toContain("No findings from 3 of 4 scanners; 1 did not run (1 not installed)");
    r.scanners = r.scanners.filter((s) => s.status !== "not_installed");
    for (const output of outputs(r)) expect(output).toContain("Passed: no findings");
    r.scanners.push({ ...r.scanners[0]!, scanner: "osv-scanner", status: "disabled", version: null, reason: "offline, dependency lookups are off" });
    for (const output of outputs(r)) {
      expect(output).toContain("No findings from 3 of 4 scanners; 1 did not run (1 skipped offline)");
      expect(output).not.toContain("Passed");
    }
  });
  it("keeps the verdict unchanged when every selected scanner ran", () => {
    const r = review(makeSubmission({ findings: [], dropped: [] }));
    r.not_reviewed = [];
    r.scanners = r.scanners.filter((s) => s.status !== "not_installed");
    for (const output of outputs(r)) expect(output).toContain("Passed: no findings");
  });
});

// Failure cases: formats omit possible items, reorder sections or reuse numbers.
it("prints possible issues after observations in every format and numbers them in receipts and details", () => {
  const report = review();
  report.observations = [{ ...report.findings[0]!, title: "Observation item" }];
  report.possible = [{ ...report.findings[0]!, title: "Possible item", confidence: 0.55 }];
  for (const output of [renderTerminal(report, { color: false }), renderMarkdown(report), renderHtml({ report, display: null }), renderReview(report, { format: "terminal", color: false }), renderReview(report, { format: "markdown" }), renderReceipt(report, { html: "report.html", md: "report.md" })]) {
    expect(output).toContain("Possible issues");
    expect(output.indexOf("Observation item")).toBeLessThan(output.indexOf("Possible item"));
  }
  expect(JSON.parse(renderJson(report)).possible).toHaveLength(1);
  const receipt = renderReceipt(report, { html: "report.html", md: "report.md" });
  expect(receipt).toContain("3. Critical security: Possible item");
  const details = renderFindingDetails(report, [3]);
  expect(details).toContain("Possible issues (1), not counted");
  expect(details).toContain("3. Critical security: Possible item");
  const html = renderHtml({ report, display: null });
  expect(html).toContain('id="f3"');
  expect(html).toContain('href="#possible"');
  const notes = JSON.parse(renderSarif(report)).runs[0].results;
  expect(notes.map((f: { level: string }) => f.level)).toEqual(["error", "note", "note"]);
  expect(notes[2].properties["openqodex.tier"]).toBe("possible");
});
it("renders reports without possible exactly as reports with an empty list", () => {
  const report = review();
  const { possible: _possible, ...old } = report;
  for (const render of [(r: Report) => renderTerminal(r, { color: false }), renderMarkdown, renderSarif, (r: Report) => renderHtml({ report: r, display: null }), (r: Report) => renderReview(r, { format: "markdown" }), (r: Report) => renderReceipt(r, { html: "report.html", md: "report.md" })]) {
    expect(render(old as Report)).toBe(render({ ...report, possible: [] }));
  }
});
