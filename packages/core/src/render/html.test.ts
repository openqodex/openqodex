// report.html, the display model it is drawn from, and the receipt the
// terminal prints instead of the whole report.
//
// Ways it could fail, written before the code:
//  1. Text from the change, a scanner or the reviewer reaches the page as
//     markup: a finding title holding <script>, a file name holding quotes
//     or angle brackets, a suggested change holding a tag.
//  2. The page loads or runs something: a script element, a src or an
//     outgoing href, an inline style attribute, or a policy that allows more
//     than the one stylesheet in the page.
//  3. A secret the scanners found shows on either side of the diff: one
//     that spans several lines (a private key) is split by the diff's +, -
//     and space prefixes and escapes a plain search, or only part of it
//     falls inside a hunk; or redacting it moves the line numbers.
//  4. A finding is shown twice, not at all, or under another line than the
//     one it cites.
//  5. A finding on a line the page does not show is put under an unrelated
//     line instead of a labelled group of its file.
//  6. A review with no findings gets no page, or a page that claims findings.
//  7. An incomplete review reads as a review: what is missing is not shown
//     first, or its findings are not labelled as findings so far.
//  8. A source line that looks like a diff header (a removed "-- x" or an
//     added "++ y") ends the hunk or shifts the numbers below it.
//  9. A binary, renamed-only or too-large file drops out of the page instead
//     of getting a section with a note.
// 10. The display keeps more source rows than its bound.
// 11. A display saved for the two-step review is used for another change,
//     or one that is not in the saved shape is used at all.
// 12. The receipt carries a finding's problem or fix, misses a finding, uses
//     other numbers than the report, or names the report by a relative path.
// 13. The coverage labels say "Files not read" beside a full coverage, which
//     reads as a hole in the review.
// 14. The reviewer's summary is kept in report.json but never shown.
// 15. The port drifts from the designer's reference renderer (render.py):
//     for the same sample it gives another element, class, id, link, line
//     number or text, or other code in a diff cell.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { getChange } from "../change.js";
import { makeChange, makeScan } from "../test-fixtures.js";
import type { Change, CompletionRecord, Report, ReportFinding } from "../types.js";
import { DISPLAY_MAX_BYTES, DISPLAY_MAX_ROWS, buildDisplay, buildExcerptDisplay, checkDisplay, displayJson } from "./display.js";
import type { Display, DisplayRow } from "./display.js";
import { renderHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import { renderReceipt, renderReview } from "./review.js";

const PEM_LINES = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAq7BFUpkGp3+LQmlQBmpP2Wvs7Y0dQ9XDu1cJx0j4Q2PbTnZ5",
  "x4yWm9lHk1oNn2E8sR7dQwUy3aXhY5tTq6Ff0yG7bLc9dK1mN2pQ3rS4tU5vW6xY",
  "Z7aB8cD9eF0gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0aB1cD2eF3gH4iJ5kL6mN7oP",
  "-----END RSA PRIVATE KEY-----",
];
const PEM = PEM_LINES.join("\n");
const BODY = PEM_LINES.slice(1, 4);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// A real repository whose one change goes from `before` to `after` in each file.
async function changeOf(files: Record<string, [string, string]>): Promise<Change> {
  const dir = mkdtempSync(join(tmpdir(), "oq-html-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [path, [before]] of Object.entries(files)) writeFileSync(join(dir, path), before);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  for (const [path, [, after]] of Object.entries(files)) writeFileSync(join(dir, path), after);
  return getChange({ repoRoot: dir, scope: { uncommitted: true }, exclude: [], defaultBase: null });
}

const COMPLETE: CompletionRecord = {
  version: 1,
  contract: "openqodex-review-2",
  status: "complete",
  missing: [],
  reviewer: { driver: "claude", version: "2.1.293", pid: 1, started_at: "2026-10-07T10:00:00.000Z", ended_at: "2026-10-07T10:01:00.000Z", duration_ms: 60_000, rounds: 1, usage: { turns: 4, input_tokens: 1000, output_tokens: 200, cost_usd: 0.1 } },
  snapshot: { change_id: "x", tree: null, before: "a", after: "a" },
  candidates: { total: 1, disposed: 1 },
  coverage: { hunks: 2, covered: 2, unread: [], files_read: ["app/search.py"], files_not_read: ["app/settings.py"] },
  outside_reads: [],
  trace_complete: true,
};

function agentFinding(over: Partial<ReportFinding>): ReportFinding {
  return {
    origin: "agent",
    severity: "major",
    category: "security",
    confidence: 0.9,
    file_path: "app/search.py",
    line_number: 14,
    line_end: 14,
    title: "Search query built from request input",
    description: "Problem. Consequence. Fix.",
    suggested_change: null,
    source: "the reviewer",
    candidate: null,
    notes: [],
    problem: "The query interpolates the q request parameter.",
    consequence: "Any caller can inject SQL.",
    fix: "Pass q as a bound parameter.",
    ...over,
  };
}

function report(change: Change, over: Partial<Report> = {}): Report {
  return {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: "2026-10-07T10:01:00.000Z",
    verdict: "passed",
    block_on_severity: null,
    summary: "Builds the search query from the request and adds a settings module.",
    findings: [agentFinding({})],
    below_threshold: 0,
    outside_change: [],
    possible: [], low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: makeScan().scanners,
    impact: null,
    not_reviewed_paths: [],
    stats: change.stats,
    completion: { ...COMPLETE, snapshot: { ...COMPLETE.snapshot, change_id: change.id } },
    ...over,
  };
}

// The fixture change split per file, as the change source gives it.
function fixtureChange(): Change {
  const c = makeChange();
  const parts = c.diff.split(/(?=^diff --git )/m);
  return { ...c, diffs: [{ path: "app/search.py", text: parts[0] ?? "" }, { path: "app/settings.py", text: parts[1] ?? "" }] };
}

const page = (r: Report, change: Change, secrets: string[] = []) => renderHtml({ report: r, display: buildDisplay({ change, secrets }), version: "0.0.0-test" });
const count = (text: string, part: string) => text.split(part).length - 1;

describe("report.html", () => {
  it("1. renders hostile text from the reviewer, a scanner and the change as text", () => {
    const change = fixtureChange();
    const hostile = agentFinding({
      title: "<script>alert(1)</script>",
      problem: `"><img src=x onerror=alert(2)>`,
      suggested_change: "</code></pre><script>alert(3)</script>",
      source: "lens:<b>x</b>",
    });
    const html = page(report(change, { findings: [hostile], summary: "<iframe src=//evil>" }), change);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");

    const named = { ...change, files: [{ path: `app/a"b'<c>.py`, status: "added" as const, oldPath: null, binary: false }], diffs: [] };
    const out = page(report(named, { findings: [agentFinding({ file_path: `app/a"b'<c>.py`, line_number: 1, line_end: 1 })] }), named);
    expect(out).toContain("app/a&quot;b&#x27;&lt;c&gt;.py");
    expect(out).not.toContain(`a"b'<c>`);
    // Anchors are generated, never built from a path.
    expect(out).not.toMatch(/id="[^"]*app\//);
  });

  it("2. loads nothing and runs nothing: no script, no source, one outgoing link with no referrer, no style attribute, a policy that allows its own stylesheet only", () => {
    const change = fixtureChange();
    const html = page(report(change), change);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<form|<base/i);
    expect(html).not.toMatch(/\s(src|action|formaction|srcset)=/i);
    // The closing line's link is the one address on the page, and it sends no referrer.
    expect(html.match(/href="(?!#)[^"]*"/g)).toEqual(['href="https://qodex.ai"']);
    expect(html).toContain('<a href="https://qodex.ai" rel="noreferrer">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(count(html, "<style>")).toBe(1);
    const hash = createHash("sha256").update(css, "utf8").digest("base64");
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`style-src 'sha256-${hash}'`);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).toContain("script-src 'none'");
    // Every other href is an anchor in the page.
    for (const href of html.match(/href="#([^"]*)"/g) ?? []) expect(href).toMatch(/^href="#[a-z0-9-]+"$/);
  });

  it("3. redacts a multi-line secret on both sides of the diff, keeping every line number", async () => {
    // The key moves from the top of the file to the bottom, past eight
    // lines: removed as lines 2 to 6 of the old side, added as lines 10 to
    // 14 of the new side.
    const middle = Array.from({ length: 8 }, (_, i) => `v${i} = ${i}\n`).join("");
    const before = `top = 1\nKEY = """${PEM}"""\n${middle}end = 1\n`;
    const after = `top = 1\n${middle}KEY = """${PEM}"""\nend = 1\n`;
    const change = await changeOf({ "conf.py": [before, after] });
    const display = buildDisplay({ change, secrets: [PEM] });
    const html = renderHtml({ report: report(change, { findings: [] }), display, version: "0.0.0-test" });
    for (const line of BODY) expect(html).not.toContain(line);
    expect(JSON.stringify(display)).not.toContain(BODY[0]);
    const hunks = display.files[0]?.hunks ?? [];
    const rows = hunks.flatMap((h) => h.rows);
    // Within each hunk the numbers on both sides run on with no gap, as in the file.
    for (const h of hunks) {
      const olds = h.rows.filter((r) => r.old !== null).map((r) => r.old);
      const news = h.rows.filter((r) => r.new !== null).map((r) => r.new);
      expect(olds).toEqual(Array.from({ length: olds.length }, (_, i) => h.old_start + i));
      expect(news).toEqual(Array.from({ length: news.length }, (_, i) => h.new_start + i));
    }
    expect(rows.filter((r) => r.kind === "del").map((r) => r.old)).toEqual([2, 3, 4, 5, 6]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.new)).toEqual([10, 11, 12, 13, 14]);
    expect(rows.filter((r) => r.kind === "del" && r.text.includes("[redacted]")).length).toBe(5);
    expect(rows.filter((r) => r.kind === "add" && r.text.includes("[redacted]")).length).toBe(5);
  });

  it("3. redacts the lines of a multi-line secret that only partly falls inside a hunk", async () => {
    const body = `KEY = """${PEM}"""\n`;
    const before = `${body}x = 1\ny = 2\nz = 3\n`;
    const after = `${body}x = 1\ny = 20\nz = 3\n`;
    const change = await changeOf({ "conf.py": [before, after] });
    const display = buildDisplay({ change, secrets: [PEM] });
    const shown = display.files[0]?.hunks.flatMap((h) => h.rows).map((r) => r.text) ?? [];
    // The context above y reaches into the key: its last body line is there, redacted.
    expect(shown.some((t) => t.includes("[redacted]"))).toBe(true);
    for (const line of BODY) expect(shown.join("\n")).not.toContain(line);
  });

  it("3. redacts the whole of a secret line at a hunk edge when a shorter secret overlaps it", async () => {
    // The hunk's context holds only the last body line of the key, and a
    // second secret the scanners matched is the end of that same line.
    const last = BODY[2]!;
    const body = `KEY = """${PEM}"""\n`;
    const change = await changeOf({ "conf.py": [`${body}x = 1\ny = 2\nz = 3\n`, `${body}x = 1\ny = 20\nz = 3\n`] });
    const display = buildDisplay({ change, secrets: [last.slice(20), PEM] });
    const shown = display.files[0]?.hunks.flatMap((h) => h.rows).map((r) => r.text).join("\n") ?? "";
    expect(shown).toContain("[redacted]");
    expect(shown).not.toContain(last.slice(0, 12));
    const html = renderHtml({ report: report(change, { findings: [] }), display, version: "0.0.0-test" });
    expect(html).not.toContain(last.slice(0, 12));
  });

  it("4. shows each finding once, right under the line it cites", () => {
    const change = fixtureChange();
    const html = page(report(change), change);
    expect(count(html, 'id="f1"')).toBe(1);
    const row = html.indexOf('num-new" data-n="14"');
    const card = html.indexOf('id="f1"');
    expect(row).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(row);
    expect(html.indexOf('num-new" data-n="15"')).toBeGreaterThan(card);
    // The cited line is marked with the finding's severity.
    expect(html).toMatch(/<tr class="line line-add line-flagged sev-major"><td class="num num-old"><\/td><td class="num num-new" data-n="14">/);
  });

  it("5. puts a finding on a line the page does not show in a labelled group of its file", () => {
    const change = fixtureChange();
    const html = page(report(change, { findings: [agentFinding({ line_number: 40, line_end: 41 })] }), change);
    expect(count(html, 'id="f1"')).toBe(1);
    const group = html.indexOf("Not on a line shown above");
    expect(group).toBeGreaterThan(html.indexOf('num-new" data-n="15"'));
    expect(html.indexOf('id="f1"')).toBeGreaterThan(group);
    expect(html).toContain("app/search.py:40-41");
  });

  it("6. writes a page for a review with no findings that says so", () => {
    const change = fixtureChange();
    const html = page(report(change, { findings: [] }), change);
    expect(html).toContain("No findings from 3 of 4 scanners; 1 did not run (1 not installed)");
    expect(html).toContain("No findings on the changed lines.");
    expect(html).not.toContain('id="f1"');
    expect(html).toContain('id="file-1"');
  });

  it("7. shows what an incomplete review is missing first, and its findings as findings so far", () => {
    const change = fixtureChange();
    const completion: CompletionRecord = { ...COMPLETE, status: "incomplete", missing: ["the reviewer timed out and was stopped"] };
    const html = page(report(change, { verdict: "incomplete", completion }), change);
    const verdict = html.indexOf("Review incomplete");
    const missing = html.indexOf("the reviewer timed out and was stopped");
    expect(verdict).toBeGreaterThan(-1);
    expect(missing).toBeGreaterThan(verdict);
    expect(missing).toBeLessThan(html.indexOf("Findings so far"));
  });

  it("8. reads a removed line that looks like a header as a removed line", async () => {
    const change = await changeOf({ "notes.md": ["a\n-- x\nb\n", "a\n++ y\nb\n"] });
    const rows = buildDisplay({ change, secrets: [] }).files[0]?.hunks.flatMap((h) => h.rows) ?? [];
    expect(rows.map((r) => [r.kind, r.old, r.new, r.text])).toEqual([
      ["context", 1, 1, "a"],
      ["del", 2, null, "-- x"],
      ["add", null, 2, "++ y"],
      ["context", 3, 3, "b"],
    ]);
  });

  it("9. keeps a binary file, a renamed file and a file over the size cap, each with a note", () => {
    const change: Change = {
      ...fixtureChange(),
      files: [
        { path: "logo.png", status: "modified", oldPath: null, binary: true },
        { path: "new/name.py", status: "renamed", oldPath: "old/name.py", binary: false },
        { path: "big.json", status: "modified", oldPath: null, binary: false },
      ],
      diffs: [{ path: "new/name.py", text: "diff --git a/old/name.py b/new/name.py\nsimilarity index 100%\nrename from old/name.py\nrename to new/name.py\n" }],
      notReviewed: ["big.json"],
    };
    const html = page(report(change, { findings: [] }), change);
    for (const path of ["logo.png", "new/name.py", "old/name.py", "big.json"]) expect(html).toContain(path);
    expect(html).toContain("Diff not shown: binary file");
    expect(html).toContain("renamed from old/name.py");
    expect(html).toContain("Diff not shown: the change to this file is over the size the review takes");
  });

  it("10. keeps no more source rows than its bound and names the files left out", () => {
    const lines = Array.from({ length: DISPLAY_MAX_ROWS + 10 }, (_, i) => `+line ${i}`);
    const text = `diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${lines.length} @@\n${lines.join("\n")}\n`;
    const change: Change = { ...fixtureChange(), diffs: [fixtureChange().diffs![0]!, { path: "big.txt", text }], files: [{ path: "app/search.py", status: "modified", oldPath: null, binary: false }, { path: "big.txt", status: "added", oldPath: null, binary: false }] };
    const display = buildDisplay({ change, secrets: [] });
    expect(display.rows).toBeLessThanOrEqual(DISPLAY_MAX_ROWS);
    expect(display.files[1]?.hunks).toEqual([]);
    expect(display.files[1]?.note).toMatch(/display limit/);
    expect(display.files[0]?.hunks.length).toBe(1);
  });

  it("11. refuses a saved display of another change or not in the saved shape", () => {
    const change = fixtureChange();
    const saved = JSON.parse(JSON.stringify(buildDisplay({ change, secrets: [] }))) as unknown;
    expect(checkDisplay(saved, change.id)).not.toBeNull();
    expect(checkDisplay(saved, "f".repeat(64))).toBeNull();
    expect(checkDisplay({ ...(saved as object), files: "x" }, change.id)).toBeNull();
    expect(checkDisplay({ ...(saved as object), version: 2 }, change.id)).toBeNull();
    expect(checkDisplay(null, change.id)).toBeNull();
  });

  it("14. shows the reviewer's summary under the verdict", () => {
    const change = fixtureChange();
    const html = page(report(change), change);
    expect(html.indexOf("Builds the search query from the request")).toBeGreaterThan(html.indexOf("Passed with warnings"));
  });
});

describe("the receipt", () => {
  const paths = { html: "/abs/repo/.openqodex/reviews/run/report.html", md: "/abs/repo/.openqodex/reviews/run/report.md" };

  it("12. names the verdict, each finding by number, severity, category, title and place, the summary and both absolute paths, and nothing of a finding's prose", () => {
    const change = fixtureChange();
    const r = report(change, {
      findings: [agentFinding({ severity: "minor", title: "Second", line_number: 15, line_end: 15 }), agentFinding({ severity: "critical", title: "First" })],
    });
    const out = renderReceipt(r, { ...paths, color: false }).trimEnd().split("\n");
    expect(out[0]).toBe("Passed with warnings: 2 findings (1 critical, 1 minor); 1 of 4 scanners did not run");
    expect(out).toContain("Summary: Builds the search query from the request and adds a settings module.");
    expect(out).toContain("1. Critical security: First (app/search.py:14)");
    expect(out).toContain("2. Minor security: Second (app/search.py:15)");
    expect(out.slice(-2)).toEqual([`Report: ${paths.html}`, `Markdown: ${paths.md}`]);
    const text = out.join("\n");
    for (const prose of ["interpolates the q request", "Any caller can inject", "bound parameter"]) expect(text).not.toContain(prose);
    // The same numbers as the full report.
    const full = renderReview(r, { format: "terminal" });
    expect(full).toContain("1. Critical security: First");
    expect(full).toContain("2. Minor security: Second");
  });

  it("12. says what an incomplete review is missing in one line", () => {
    const change = fixtureChange();
    const completion: CompletionRecord = { ...COMPLETE, status: "incomplete", missing: ["the reviewer timed out and was stopped", "1 scanner candidate has no disposition"] };
    const out = renderReceipt(report(change, { verdict: "incomplete", completion, findings: [] }), { ...paths, color: false }).split("\n");
    expect(out[0]).toBe("Review incomplete: this is not a review of the change");
    expect(out).toContain("Missing: the reviewer timed out and was stopped; 1 scanner candidate has no disposition");
  });

  it("12. says when there is nothing to fix", () => {
    const change = fixtureChange();
    const out = renderReceipt(report(change, { findings: [] }), { ...paths, color: false });
    expect(out.split("\n")[0]).toBe("No findings from 3 of 4 scanners; 1 did not run (1 not installed)");
    expect(out).toContain("No findings on the changed lines.");
  });
});

describe("the standard report", () => {
  it("13. labels the files the reviewer opened, and those whose changed lines were in the brief", () => {
    const change = fixtureChange();
    const out = renderReview(report(change), { format: "terminal" });
    expect(out).toContain("Files the reviewer opened: app/search.py");
    expect(out).toContain("Files not opened (their changed lines were in the brief): app/settings.py");
    expect(out).not.toContain("Files not read");
  });

  it("14. prints the reviewer's summary after the change line", () => {
    const change = fixtureChange();
    const out = renderReview(report(change), { format: "markdown" }).split("\n").filter((l) => l !== "");
    const at = out.findIndex((l) => l.startsWith("Change "));
    expect(out[at + 1]).toBe("Summary: Builds the search query from the request and adds a settings module.");
  });
});

// Bounds. Ways it could fail, written before the code:
// 16. A finding's line range is walked line by line: a legacy finding that
//     cites twenty million lines on a one-line diff takes seconds or the heap.
// 17. A review of the whole repository reads every row of a huge file
//     before it finds the file is past the display limit.
// 18. File names alone take the saved display past its cap: 60,000 empty
//     added files with long names give a display.json finalize cannot read.
// 19. Each excerpt walks the file from its start: 5,000 citations near line
//     two million of a 2.5 million line file cost ten billion steps.
describe("bounds", () => {
  const ms = (f: () => void): number => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it("16. renders a legacy finding that cites twenty million lines on a one-line diff in well under a second, its one shown line flagged", () => {
    // The one changed line is line 20,000,000; the finding cites lines 1 to it.
    const text = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -20000000 +20000000 @@\n-old\n+new\n";
    const change: Change = { ...fixtureChange(), files: [{ path: "a.txt", status: "modified", oldPath: null, binary: false }], diffs: [{ path: "a.txt", text }] };
    const wide = agentFinding({ file_path: "a.txt", line_number: 1, line_end: 20_000_000, problem: undefined, consequence: undefined, fix: undefined });
    let html = "";
    expect(ms(() => (html = renderHtml({ report: report(change, { findings: [wide] }), display: buildDisplay({ change, secrets: [] }), version: "0.0.0-test" })))).toBeLessThan(1000);
    expect(html.split('id="f1"').length - 1).toBe(1);
    expect(html).toMatch(/<tr class="line line-add line-flagged sev-major"><td class="num num-old"><\/td><td class="num num-new" data-n="20000000">/);
    expect(html).not.toMatch(/line-del line-flagged/);
  });

  it("17. leaves out a 2.5 million blank-line file of a whole-repository review at once, in well under a second, within the cap", () => {
    let display: Display | null = null;
    const blank = "\n".repeat(2_500_000);
    expect(ms(() => (display = buildExcerptDisplay({ changeId: "x".repeat(64), cited: [{ file_path: "blank.txt", line_number: 1, line_end: 2_500_000 }], read: () => blank, secrets: [] })))).toBeLessThan(1000);
    const d = display as unknown as Display;
    expect(d.rows).toBe(0);
    expect(d.files[0]?.hunks).toEqual([]);
    expect(d.files[0]?.note).toMatch(/display limit/);
    expect(Buffer.byteLength(displayJson(d))).toBeLessThan(DISPLAY_MAX_BYTES);
  });

  it("19. cuts out 5,000 cited spans near line two million of a 2.5 million line file in one pass, in well under a second", () => {
    const text = "\n".repeat(2_500_000);
    const cited = Array.from({ length: 5_000 }, (_, i) => ({ file_path: "big.txt", line_number: 2_000_000 + i * 10, line_end: 2_000_000 + i * 10 }));
    let display: Display | null = null;
    expect(ms(() => (display = buildExcerptDisplay({ changeId: "x".repeat(64), cited, read: () => text, secrets: [] })))).toBeLessThan(1000);
    const d = display as unknown as Display;
    expect(d.rows).toBe(5_000 * 7);
    expect(d.files[0]?.hunks).toHaveLength(5_000);
    expect(d.files[0]?.hunks[4_999]?.rows.map((r) => r.new)).toEqual(Array.from({ length: 7 }, (_, k) => 2_049_990 - 3 + k));
  });

  it("18. keeps the saved display of 60,000 empty added files within its cap, counting the files it leaves out, in well under a second", () => {
    const n = 60_000;
    const paths = Array.from({ length: n }, (_, i) => `assets/generated/${"deep/".repeat(30)}file-${String(i).padStart(6, "0")}.txt`);
    const change: Change = {
      ...fixtureChange(),
      files: paths.map((path) => ({ path, status: "added" as const, oldPath: null, binary: false })),
      diffs: paths.map((path) => ({ path, text: `diff --git a/${path} b/${path}\nnew file mode 100644\n` })),
      stats: { files: n, additions: 0, deletions: 0 },
    };
    let text = "";
    let d: Display | null = null;
    expect(ms(() => (text = displayJson((d = buildDisplay({ change, secrets: [] })))))).toBeLessThan(1000);
    expect(Buffer.byteLength(text)).toBeLessThan(DISPLAY_MAX_BYTES);
    const display = d as unknown as Display;
    expect(display.files.length + display.omitted_files).toBe(n);
    expect(display.omitted_files).toBeGreaterThan(0);
    expect(checkDisplay(JSON.parse(text), change.id)).not.toBeNull();
    let html = "";
    expect(ms(() => (html = renderHtml({ report: report(change, { findings: [] }), display, version: "0.0.0-test" })))).toBeLessThan(1000);
    expect(html).toContain(`Diffs for ${(n - display.files.length).toLocaleString("en-US")} other changed files are not in this report.`);
  });
});

// The designer's sample, in test/fixtures/report-html: a review of this
// repository (sample-report.json, its blast radius cut to a slice), the diff
// fixture the designer's reference renderer reads (sample-diff.json), and
// that renderer's own output for the two (expected.html), written by
// `python3 render.py sample-report.json sample-diff.json expected.html`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "report-html");

type SampleDiff = {
  report_md?: string;
  files: { path: string; old_path: string | null; status: "added" | "modified" | "deleted" | "renamed"; omitted: string | null; hunks: { old_start: number; new_start: number; context?: string; lines: [string, string][] }[] }[];
};

// The fixture's files as the display model, numbered the way render.py
// numbers them (its number_hunk).
function displayOf(diff: SampleDiff, changeId: string): Display {
  const files = diff.files.map((f) => ({
    path: f.path,
    old_path: f.old_path,
    status: f.status,
    binary: false,
    additions: null,
    deletions: null,
    note: f.omitted,
    hunks: f.hunks.map((h) => {
      let old = h.old_start;
      let nu = h.new_start;
      const rows: DisplayRow[] = h.lines.map(([sign, line]): DisplayRow =>
        sign === "+" ? { kind: "add", old: null, new: nu++, text: line } : sign === "-" ? { kind: "del", old: old++, new: null, text: line } : { kind: "context", old: old++, new: nu++, text: line },
      );
      return { old_start: h.old_start, old_lines: rows.filter((r) => r.old !== null).length, new_start: h.new_start, new_lines: rows.filter((r) => r.new !== null).length, section: h.context ?? "", rows };
    }),
  }));
  return { version: 1, change_id: changeId, kind: "change", files, omitted_files: 0, rows: files.reduce((n, f) => n + f.hunks.reduce((k, h) => k + h.rows.length, 0), 0) };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot);/gi, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (NAMED[e.toLowerCase()] ?? e)));

// The body as a list of start tags (with the attributes that carry meaning:
// class, id, href, rel, colspan, data-n, aria-label), end tags and text,
// whitespace runs folded; the stylesheet and the title are compared apart.
function structure(html: string): string[] {
  const body = html.slice(html.indexOf("<body>"), html.indexOf("</body>") + "</body>".length);
  const keep = new Set(["class", "id", "href", "rel", "colspan", "data-n", "aria-label"]);
  const out: string[] = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      const t = decode(m[4]).replace(/\s+/g, " ").trim();
      if (t !== "") out.push(`text: ${t}`);
    } else if (m[1] === "/") {
      out.push(`</${m[2]}>`);
    } else {
      const attrs = [...(m[3] ?? "").matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].filter((a) => keep.has(a[1]!)).map((a) => `${a[1]}="${decode(a[2]!)}"`).sort();
      out.push(`<${m[2]}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>`);
    }
  }
  return out;
}

const codeCells = (html: string): string[] => [...html.matchAll(/<td class="code">([\s\S]*?)<\/td>/g)].map((m) => m[1]!);
const styleOf = (html: string): string | undefined => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];

describe("the port of the designer's page", () => {
  it("15. renders the designer's sample with the same elements, classes, ids, links, line numbers and text as render.py, and the same stylesheet", () => {
    const sample = JSON.parse(readFileSync(join(FIXTURES, "sample-report.json"), "utf8")) as Report;
    const diff = JSON.parse(readFileSync(join(FIXTURES, "sample-diff.json"), "utf8")) as SampleDiff;
    const expected = readFileSync(join(FIXTURES, "expected.html"), "utf8");
    const ours = renderHtml({ report: sample, display: displayOf(diff, sample.change_id), reportMd: diff.report_md });
    // One wording differs on purpose: the coverage label says "opened", since
    // the changed lines were in the brief whether or not the reviewer opened a file.
    const want = structure(expected).map((t) => (t === "text: Files the reviewer read" ? "text: Files the reviewer opened" : t));
    // The whole page is compared: every file, card and table of the sample.
    expect(want.length).toBeGreaterThan(2000);
    expect(want.filter((t) => t.startsWith("<article")).length).toBe(4);
    expect(structure(ours)).toEqual(want);
    // The code in every diff cell, exactly, indentation included.
    expect(codeCells(ours)).toEqual(codeCells(expected));
    // The stylesheet is the designer's, byte for byte, and so is the title.
    expect(styleOf(ours)).toBe(styleOf(expected));
    expect(/<title>(.*)<\/title>/.exec(ours)?.[1]).toBe(/<title>(.*)<\/title>/.exec(expected)?.[1]);
  });
});

it("keeps supplied and omitted convention notes in HTML without interpreting their markup", () => {
  const change = makeChange();
  const html = renderHtml({ report: report(change, { notes: ["Conventions supplied: rules.md", "Convention omitted: <script>rules</script> is missing"] }), display: null, version: "test" });
  expect(html).toContain("Conventions supplied: rules.md");
  expect(html).toContain("Convention omitted: &lt;script&gt;rules&lt;/script&gt; is missing");
  expect(html).not.toContain("<script>rules</script>");
});

it("keeps supplied and omitted convention notes in Markdown without creating markup", () => {
  const markdown = renderMarkdown(report(makeChange(), { notes: ["Conventions supplied: rules.md", "Convention omitted: <script>rules</script> [link](https://example.test)\n# Heading"] }));
  expect(markdown).toContain("## Review notes\n\n- Conventions supplied: rules.md");
  expect(markdown).toContain("Convention omitted:");
  expect(markdown).not.toContain("<script>");
  expect(markdown).not.toContain("[link](https://example.test)");
  expect(markdown).not.toContain("\n# Heading");
});
