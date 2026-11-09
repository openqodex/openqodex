// Ways observations could fail, written before the implementation:
// 1. They enter the displayed verdict or severity count.
// 2. Absent or empty observations change existing output bytes.
// 3. Prose, attribution or suggested changes disappear from an output.
// 4. Severity, confidence or continued numbering differs between outputs.
// 5. The omitted count disappears, including when no observations remain.
// 6. HTML puts observations in the diff or interprets their text as markup.
// 7. SARIF gives an observation a blocking level or loses its tier.
// 8. JSON or the findings command drops observations.
// 9. The findings command includes observations in all.
// 10. A single omitted observation uses plural wording.
// 11. The legacy terminal uses a different capitalisation for an observation.
// 12. A suggested change label has an empty field with trailing whitespace.
// 13. Legacy markdown continues numbering without explaining the receipt.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { writeHomeLastReview } from "../../cli/src/receipts.js";
import { finalizeReview } from "../src/finalize.js";
import { countedSeverities, verdictLine } from "../src/render/common.js";
import { buildDisplay } from "../src/render/display.js";
import { renderFindingDetails, renderHtml, renderJson, renderMarkdown, renderReceipt, renderReview, renderSarif, renderTerminal } from "../src/render/index.js";
import { makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "../src/test-fixtures.js";
import type { Report, ReportFinding } from "../src/types.js";

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const paths = { html: "/r/report.html", md: "/r/report.md", color: false };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sample = JSON.parse(readFileSync(new URL("./fixtures/report-html/sample-report.json", import.meta.url), "utf8")) as Report;

function report(): Report {
  const change = makeChange();
  return finalizeReview({ change, config: makeConfig({ blockOnSeverity: "major", severityThreshold: "major" }), scan: makeScan({ candidates: [] }), manifest: makeManifest(change), submission: makeSubmission({ findings: [], dropped: [] }) });
}

function observation(over: Partial<ReportFinding> = {}): ReportFinding {
  return {
    origin: "agent", severity: "major", category: "maintainability", confidence: 0.8,
    file_path: "app/search.py", line_number: 14, line_end: 15,
    title: "Name the search input", description: "The variable is named q.",
    problem: "The variable is named q.", consequence: "Readers must infer its meaning.", fix: "Use searchInput.",
    suggested_change: "const searchInput = query;\nreturn searchInput;", source: "naming", candidate: null,
    found_by: ["local", "contracts"], notes: [], ...over,
  };
}

const outputs: Record<string, (r: Report) => string> = {
  markdown: renderMarkdown,
  html: (r) => renderHtml({ report: r, display: null }),
  sarif: renderSarif,
  receipt: (r) => renderReceipt(r, paths),
  terminal: (r) => renderTerminal(r, { color: false }),
  reviewMarkdown: (r) => renderReview(r, { format: "markdown" }),
  reviewTerminal: (r) => renderReview(r, { format: "terminal" }),
};

describe("observations stay outside the verdict", () => {
  it("does not add observation severities to countedSeverities", () => {
    const r = report();
    expect(countedSeverities({ ...r, observations: [observation({ severity: "critical" })] })).toEqual(countedSeverities(r));
  });
  it("does not change verdictLine for a critical observation", () => {
    const r = report();
    expect(verdictLine({ ...r, observations: [observation({ severity: "critical" })] })).toBe(verdictLine(r));
  });
});

describe("observations in reports", () => {
  it.each(Object.entries(outputs))("keeps %s bytes unchanged for an empty observations field", (_name, render) => {
    expect(render({ ...sample, observations: [] })).toBe(render(sample));
  });

  it("keeps the existing markdown bytes without observations", () => {
    expect(sha(renderMarkdown(sample))).toBe("7541d742ffdd8231b406e45fccb77ad2d562748b16f2c9de7d6e1da220d4aae9");
  });
  it("keeps the existing html bytes without observations", () => {
    expect(sha(outputs.html!(sample))).toBe("232e450d4ae2ae3807c525eca68b7b5470e3f7a63a8eb3bd6be0682f22961246");
  });
  it("keeps the existing sarif bytes without observations", () => {
    expect(sha(renderSarif(sample))).toBe("799e8690949407f48546da588ccd4975ea73ef9d1e5c6e67f380584778147bd9");
  });
  it("keeps the existing receipt bytes without observations", () => {
    expect(sha(renderReceipt(sample, paths))).toBe("b88433c2e378e4146291d79b5d9d93e99e31cd97604c3fad9370a347c0f99f42");
  });

  it.each(["markdown", "reviewMarkdown"])("keeps all observation fields in %s after findings and before coverage", (name) => {
    const r = { ...report(), observations: [observation()] };
    const out = outputs[name]!(r);
    const section = out.slice(out.indexOf("## Observations"));
    expect(section).toContain("These do not count toward the verdict.");
    for (const text of ["Major maintainability: Name the search input", "app/search.py:14-15", "The variable is named q.", "Readers must infer its meaning.", "Use searchInput.", "Suggested change", "const searchInput = query;", "return searchInput;", "naming", "local, contracts"]) expect(section).toContain(text);
    expect(out.indexOf("## Observations")).toBeGreaterThan(out.indexOf("## Findings"));
    expect(out.indexOf("## Observations")).toBeLessThan(out.indexOf("Scanners"));
  });

  it.each(["markdown", "reviewMarkdown", "receipt"])("orders %s observations by severity before confidence", (name) => {
    const r = { ...report(), observations: [observation({ title: "Lower severity", severity: "minor", confidence: 1 }), observation({ title: "Lower confidence", confidence: 0.7 }), observation({ title: "Higher confidence", confidence: 0.9 })] };
    const out = outputs[name]!(r);
    expect(out.indexOf("Higher confidence")).toBeLessThan(out.indexOf("Lower confidence"));
    expect(out.indexOf("Lower confidence")).toBeLessThan(out.indexOf("Lower severity"));
  });

  it("numbers receipt observations after the last finding", () => {
    const r = { ...report(), findings: [observation({ title: "A finding" }), observation({ title: "Another finding" })], observations: [observation()] };
    const out = renderReceipt(r, paths).split("\n");
    expect(out).toContain("Observations (do not count toward the verdict):");
    expect(out).toContain("3. Major maintainability: Name the search input (app/search.py:14-15)");
    expect(out.filter((line) => /^\d+\. /.test(line))).toHaveLength(3);
  });

  it("keeps observation severity and category visible in the legacy terminal output", () => {
    const out = renderTerminal({ ...report(), observations: [observation()] }, { color: false });
    expect(out).toContain("Major maintainability: Name the search input");
  });

  it("explains continued observation numbers below the legacy markdown heading", () => {
    const r = { ...report(), findings: [observation({ title: "A finding" }), observation({ title: "Another finding" })], observations: [observation()] };
    const out = renderMarkdown(r);
    expect(out).toContain("## Observations\n\nThe numbers continue the receipt's numbering.");
    expect(out).toContain("### 3. Major maintainability: Name the search input");
  });

  it("labels observation details selected by the continued receipt number", () => {
    const r = { ...report(), findings: [observation({ title: "A finding" })], observations: [observation()] };
    const out = renderFindingDetails(r, [2]);
    expect(out).toContain("Observations (do not count toward the verdict):");
    expect(out).toContain("2. Major maintainability: Name the search input");
    expect(out).not.toContain("A finding");
    expect(out).toContain("Suggested change:");
    expect(out).toContain("Found by: local, contracts");
  });

  it("keeps observations before coverage in a completed review", () => {
    const r: Report = { ...report(), observations: [observation()], completion: {
      version: 1, contract: "openqodex-review-2", status: "complete", missing: [], refused: [], reviewer: null,
      snapshot: { change_id: "x", tree: null, before: "a", after: "a" }, candidates: { total: 0, disposed: 0 },
      coverage: { hunks: 0, covered: 0, unread: [], files_read: [], files_not_read: [] }, outside_reads: [], trace_complete: true,
    } };
    const out = renderReview(r, { format: "markdown" });
    expect(out.indexOf("## Observations")).toBeGreaterThan(out.indexOf("## Findings"));
    expect(out.indexOf("## Observations")).toBeLessThan(out.indexOf("## Coverage"));
    expect(out.split("\n")[0]).toContain("No findings");
  });

  it.each(["markdown", "reviewMarkdown"])("keeps embedded fences inside the suggested change in %s", (name) => {
    const out = outputs[name]!({ ...report(), observations: [observation({ suggested_change: "```\n# Not a heading\n```" })] });
    expect(out).toContain("\n````\n```\n# Not a heading\n```\n````\n");
  });

  it.each(["markdown", "reviewMarkdown"])("preserves blank lines inside a suggested change in %s", (name) => {
    const code = 'const text = `first\n\n\nlast`;';
    const out = outputs[name]!({ ...report(), observations: [observation({ suggested_change: code })] });
    expect(out).toContain(`\n\`\`\`\n${code}\n\`\`\`\n`);
  });

  it.each(["markdown", "reviewMarkdown", "reviewTerminal"])("prints the suggested change label without an empty field in %s", (name) => {
    const out = outputs[name]!({ ...report(), observations: [observation()] });
    const label = out.split("\n").find((line) => line.includes("Suggested change:"));
    expect(label).toBe(name === "reviewTerminal" ? "   Suggested change:" : "- **Suggested change:**");
  });

  it.each(Object.entries(outputs).filter(([name]) => name != "sarif"))("prints omitted observations in %s", (_name, render) => {
    expect(render({ ...report(), observations: [observation()], observations_omitted: 3 })).toContain("3 more observations were left out.");
  });
  it.each(Object.entries(outputs).filter(([name]) => name != "sarif"))("uses singular wording for one omitted observation in %s", (_name, render) => {
    expect(render({ ...report(), observations: [observation()], observations_omitted: 1 })).toContain("1 more observation was left out.");
  });
  it.each(Object.entries(outputs).filter(([name]) => name != "sarif"))("keeps an omitted count visible in %s when no observations remain", (_name, render) => {
    expect(render({ ...report(), observations_omitted: 2 })).toContain("2 more observations were left out.");
  });

  it("keeps observation fields intact in json", () => {
    const r = { ...report(), observations: [observation()], observations_omitted: 3 };
    expect(JSON.parse(renderJson(r))).toEqual(r);
  });

  it("gives agent and scanner observations note level and an observation tier in sarif", () => {
    const r = { ...report(), findings: [observation({ severity: "critical" })], observations: [observation({ severity: "critical" }), observation({ origin: "scanner", severity: "major", source: "ruff:F401" })] };
    const sarif = JSON.parse(renderSarif(r));
    const results = sarif.runs.flatMap((run: { results: { level: string; properties: Record<string, unknown> }[] }) => run.results);
    expect(results[0].level).toBe("error");
    expect(results[0].properties).not.toHaveProperty("openqodex.tier");
    expect(results.slice(1).map((r: { level: string }) => r.level)).toEqual(["note", "note"]);
    for (const item of results.slice(1)) expect(item.properties["openqodex.tier"]).toBe("observation");
  });

  it("lists html observations once outside the per-file diff", () => {
    const change = makeChange();
    change.diffs = [{ path: "app/search.py", text: change.diff }];
    const r = { ...report(), findings: [observation({ title: "A finding" })], observations: [observation(), observation({ file_path: "observation-only.ts", title: "Only an observation" })] };
    const out = renderHtml({ report: r, display: buildDisplay({ change, secrets: [] }) });
    const section = /<section[^>]*id="observations"[^>]*>[\s\S]*?<\/section>/.exec(out)?.[0] ?? "";
    expect(section).toContain('<h2 class="muted">Observations</h2>');
    expect(section).toContain("These do not count toward the verdict.");
    expect(section).toContain('class="finding-card sev-major"');
    expect(section).toContain("Name the search input");
    expect(section).toContain("Found by: local, contracts");
    expect(section).toContain("Suggested change");
    expect(out.replace(section, "")).not.toContain("Name the search input");
    expect(out.replace(section, "")).not.toContain("observation-only.ts");
    expect(out.indexOf('id="observations"')).toBeGreaterThan(out.indexOf('id="findings"'));
  });

  it("escapes hostile observation fields in html", () => {
    const hostile = observation({ title: "<script>oops</script>", suggested_change: "</pre><script>oops</script>", found_by: ["<img src=x>"] });
    const out = outputs.html!({ ...report(), observations: [hostile] });
    expect(out).toContain("&lt;script&gt;oops&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x&gt;");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img src=x>");
  });
});

function findingsCommand(number: string) {
  const root = realpathSync(tempDir("oq-observations-"));
  const home = tempDir("oq-observations-home-");
  const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8" });
  expect(git.status, git.stderr).toBe(0);
  const dir = join(root, ".openqodex", "reviews", "observations");
  mkdirSync(dir, { recursive: true });
  const r = { ...report(), findings: [observation({ title: "A finding" }), observation({ title: "Another finding" })], observations: [observation()] };
  const text = renderJson(r);
  writeFileSync(join(dir, "report.json"), text, { mode: 0o600 });
  writeHomeLastReview(home, root, { dir, shown: dir, changeId: r.change_id, reportSha256: sha(text) });
  return spawnSync(process.execPath, [fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url)), "findings", number, "--cwd", root], {
    encoding: "utf8", env: { ...process.env, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0" }, timeout: 30_000,
  });
}

it("prints an observation selected by its continued number through the real findings command", () => {
  const result = findingsCommand("3");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("3. Major maintainability: Name the search input");
  expect(result.stdout).not.toContain("A finding");
});

it("keeps observations out of findings all", () => {
  const result = findingsCommand("all");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.split("\n").filter((line) => /^\d+\. /.test(line))).toEqual([
    "1. Major maintainability: A finding",
    "2. Major maintainability: Another finding",
  ]);
  expect(result.stdout).not.toContain("Name the search input");
  expect(result.stdout).not.toContain("Observations");
});

it("keeps observations apart from findings in a selection error", () => {
  const result = findingsCommand("4");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("2 findings and 1 observation, numbered 1 to 3");
});
