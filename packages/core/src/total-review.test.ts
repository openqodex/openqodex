// The core contract of the total review: submission version 2, its script
// checks, the coverage taken from the reviewer's trace, the completion
// record and the one standard report.
//
// Ways it could fail, written before the code:
//  1. A candidate with no disposition yields a passing or complete result.
//  2. Scanner text (a rule id or a scanner name) in problem, consequence or
//     fix is accepted, so it reaches the printed report.
//  3. A sentence over 20 words, an em dash or a control character in a
//     prose field is accepted.
//  4. A finding cited outside the change, or a dropped candidate cited on a
//     line that does not exist, is accepted.
//  5. A missing problem, consequence or fix field is accepted.
//  6. Rejections stop at the first one, or come without numbers, so the
//     reviewer cannot fix them all in one round.
//  7. The model's own `reviewer` claim reaches the report.
//  8. A changed hunk the trace never covered counts as reviewed; a deleted
//     region counts as read through the new file.
//  9. A read outside the snapshot, a tool beyond read, grep and glob, a
//     snapshot that changed, or a missing reviewer process still yields a
//     complete record.
// 10. Terminal and markdown say different things.
// 11. (moved: a legacy receipt is tested in push-gate.test.ts)
// 12. Text the reviewer wrote, or a repo path, makes structure in report.md:
//     an image (fetched when the report is viewed), a link, a heading, raw
//     HTML, a table cell, a fence, or a line that imitates a fixed label; or
//     a control character reaches the terminal.
// 13. A finding range that only overlaps a changed line is accepted: one that
//     starts on an unchanged line, ends past the end of the file, or spans
//     far beyond its start (`line_number: 1, line_end: 999999`).
// 15. An incomplete review throws away the findings that passed every check.
// 14. A changed file the change could not map (past the coverage line cap)
//     or could not put in the brief (past the diff budget) counts as read
//     when the reviewer never read it: the run completes by omission.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COVERAGE_MAX_LINES, DIFF_CAP_BYTES, getChange } from "./change.js";
import { changedHunks, completionRecord, readCoverage } from "./completion.js";
import type { TraceEntry } from "./completion.js";
import { checkSubmission } from "./finalize.js";
import { renderReview } from "./render/review.js";
import { KEY_CANDIDATE, LINT_CANDIDATE, SQL_CANDIDATE, makeChange, makeConfig, makeManifest, makeScan } from "./test-fixtures.js";
import type { CompletionRecord, Report, ReviewerRecord } from "./types.js";

const reviewer: ReviewerRecord = {
  driver: "claude",
  version: "2.1.289",
  pid: 4242,
  started_at: "2026-10-03T10:00:00.000Z",
  ended_at: "2026-10-03T10:01:12.000Z",
  duration_ms: 72_000,
  rounds: 1,
  usage: { turns: 10, input_tokens: 45_000, output_tokens: 3_000, cost_usd: 0.31 },
};

function v2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    change_id: "3f9a1c0b2d4e",
    summary: "Builds the search query from request input and adds a settings module.",
    findings: [
      {
        severity: "critical",
        category: "security",
        confidence: 0.9,
        file_path: "app/search.py",
        line_number: 14,
        title: "Query built from request input",
        problem: "The search query puts q from the request straight into the SQL text.",
        consequence: "Anyone who can call search can read or change every row.",
        fix: "Pass q as a bound parameter to cur.execute.",
        source: SQL_CANDIDATE.token,
        candidate: "c1",
      },
    ],
    dropped: [
      { candidate: "c2", reason: "The key is a documented local sample.", file_path: "app/settings.py", line_number: 3 },
      { candidate: "c3", reason: "The import is used by the next change.", file_path: "app/settings.py", line_number: 1 },
    ],
    ...over,
  };
}

// Built at run time: the em dash never appears in this file as a character.
const EM = String.fromCharCode(0x2014);
const BEL = String.fromCharCode(7);

const lineCount = (path: string) => (path === "app/search.py" ? 40 : path === "app/settings.py" ? 3 : null);

function check(submission: unknown) {
  const change = makeChange();
  return checkSubmission({ change, scan: makeScan(), manifest: makeManifest(change), config: makeConfig({ blockOnSeverity: "major" }), submission, lineCount });
}

function errorsOf(submission: unknown): string[] {
  const r = check(submission);
  if (r.ok) throw new Error("expected the submission to be rejected");
  return r.errors;
}

function withFinding(over: Record<string, unknown>): Record<string, unknown> {
  const base = (v2().findings as Record<string, unknown>[])[0]!;
  return v2({ findings: [{ ...base, ...over }] });
}

describe("submission version 2", () => {
  it("1. rejects a submission that leaves a candidate with no disposition", () => {
    const errors = errorsOf(v2({ dropped: [(v2().dropped as unknown[])[0]] }));
    expect(errors.join("\n")).toContain("c3");
    expect(errors.join("\n")).toMatch(/no disposition/);
  });
  it("1. rejects a candidate both raised and dropped", () => {
    const dropped = [...(v2().dropped as unknown[]), { candidate: "c1", reason: "Not real.", file_path: "app/search.py", line_number: 14 }];
    expect(errorsOf(v2({ dropped })).join("\n")).toMatch(/c1.*more than one disposition/);
  });
  it("2. rejects a rule id or a scanner name in a prose field", () => {
    expect(errorsOf(withFinding({ problem: `The rule ${SQL_CANDIDATE.ruleId} fired on this line.` })).join("\n")).toMatch(/problem.*rule id/);
    expect(errorsOf(withFinding({ consequence: "Semgrep says anyone can read every row." })).join("\n")).toMatch(/consequence.*scanner name/);
    expect(errorsOf(withFinding({ fix: `Silence ${LINT_CANDIDATE.token} and move on.` })).join("\n")).toMatch(/fix/);
  });
  it("3. rejects a sentence over 20 words, an em dash and a control character", () => {
    const long = "This sentence has far too many words in it because it keeps going on and on about the query that is built here.";
    expect(errorsOf(withFinding({ problem: long })).join("\n")).toMatch(/problem: sentence 1 has 2\d words; the limit is 20/);
    expect(errorsOf(withFinding({ fix: `Bind q ${EM} never format it.` })).join("\n")).toMatch(/fix.*em dash/);
    expect(errorsOf(withFinding({ consequence: `Anyone can read${BEL} every row.` })).join("\n")).toMatch(/consequence.*control character/);
  });
  it("4. rejects a finding cited outside the change and a dropped candidate cited on a line that does not exist", () => {
    expect(errorsOf(withFinding({ line_number: 3, file_path: "app/search.py" })).join("\n")).toMatch(/not a line this change added or modified/);
    const dropped = [{ candidate: "c2", reason: "A sample key.", file_path: "app/settings.py", line_number: 99 }, (v2().dropped as unknown[])[1]];
    expect(errorsOf(v2({ dropped })).join("\n")).toMatch(/line 99 of app\/settings.py, which has 3 lines/);
  });
  it("13. rejects a range that starts on an unchanged line, ends past the file or spans too far, though it overlaps a changed line", () => {
    expect(errorsOf(withFinding({ line_number: 1, line_end: 999_999 })).join("\n")).toMatch(/line 1 of app\/search.py is not a line this change added or modified/);
    expect(errorsOf(withFinding({ line_number: 14, line_end: 41 })).join("\n")).toMatch(/line 41 of app\/search.py does not exist; it has 40 lines/);
    const long = check(withFinding({ line_number: 14, line_end: 40 }));
    expect(long.ok).toBe(true);
    const lines = (path: string) => (path === "app/search.py" ? 1000 : lineCount(path));
    const change = makeChange();
    const wide = checkSubmission({ change, scan: makeScan(), manifest: makeManifest(change), config: makeConfig(), submission: withFinding({ line_number: 14, line_end: 300 }), lineCount: lines });
    expect(wide.ok ? [] : wide.errors.join("\n")).toMatch(/spans 287 lines; the limit is 200/);
  });
  it("13. accepts a range that starts on a deletion anchor", () => {
    const change = makeChange({ deletionPoints: new Map([["app/search.py", [{ after: 20, lines: 2, anchors: [20, 21] }]]]) });
    const r = checkSubmission({ change, scan: makeScan(), manifest: makeManifest(change), config: makeConfig(), submission: withFinding({ line_number: 21, line_end: 25 }), lineCount });
    expect(r.ok).toBe(true);
  });
  it("5. rejects a finding with no consequence", () => {
    const base = { ...(v2().findings as Record<string, unknown>[])[0]! };
    delete base.consequence;
    expect(errorsOf(v2({ findings: [base] })).join("\n")).toMatch(/findings\[0\]\.consequence/);
  });
  it("6. returns every rejection at once, numbered", () => {
    const errors = errorsOf(withFinding({ problem: `Bad ${EM} one.`, fix: `Also bad ${EM} two.` }));
    expect(errors.length).toBeGreaterThanOrEqual(2);
    errors.forEach((e, i) => expect(e.startsWith(`${i + 1}. `)).toBe(true));
  });
  it("7. ignores the model's own reviewer claim", () => {
    const r = check(v2({ reviewer: "subagent" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.report)).not.toContain("subagent");
  });
});

describe("coverage from the trace", () => {
  const read = (path: string, start: number, end: number): TraceEntry => ({ tool: "Read", path, inside: true, range: [start, end], ok: true });

  it("8. counts a hunk outside the brief's diff as unread until a read covers it", () => {
    const change = makeChange();
    const none = readCoverage({ change, briefFiles: new Set(["app/settings.py"]), trace: [] });
    expect(none.unread.map((h) => h.path)).toEqual(["app/search.py"]);
    const partial = readCoverage({ change, briefFiles: new Set(["app/settings.py"]), trace: [read("app/search.py", 1, 14)] });
    expect(partial.unread).toHaveLength(1);
    const full = readCoverage({ change, briefFiles: new Set(["app/settings.py"]), trace: [read("app/search.py", 10, 20)] });
    expect(full.unread).toEqual([]);
    expect(full.files_read).toEqual(["app/search.py"]);
    expect(full.files_not_read).toEqual(["app/settings.py"]);
  });
  it("8. a deletion point is covered only by the diff in the brief, never by reading the new file", () => {
    const change = makeChange({ deletionPoints: new Map([["app/search.py", [{ after: 20, lines: 2, anchors: [20, 21] }]]]) });
    expect(changedHunks(change).some((h) => h.deletion)).toBe(true);
    const c = readCoverage({ change, briefFiles: new Set(["app/settings.py"]), trace: [read("app/search.py", 1, 40)] });
    expect(c.unread).toEqual([{ path: "app/search.py", start: 20, end: 21, deletion: true }]);
  });
  it("8. a failed read covers nothing", () => {
    const change = makeChange();
    const c = readCoverage({ change, briefFiles: new Set(["app/settings.py"]), trace: [{ ...read("app/search.py", 1, 40), ok: false }] });
    expect(c.unread).toHaveLength(1);
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("14. files the change could not map or brief", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "oq-cover-"));
    roots.push(dir);
    git(dir, "init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "Base");
    return dir;
  };

  it("a file past the coverage line cap stays unread until a read covers all of it", async () => {
    const dir = repo({ "README.md": "hello\n" });
    const lines = COVERAGE_MAX_LINES + 1;
    writeFileSync(join(dir, "big.txt"), "x\n".repeat(lines));
    writeFileSync(join(dir, "small.py"), "x = 1\n");
    const change = await getChange({ repoRoot: dir, scope: { uncommitted: true }, exclude: [] });
    expect(change.notReviewed).toEqual(["big.txt"]);
    const lineCount = (path: string) => (path === "big.txt" ? lines : 1);
    const none = readCoverage({ change, briefFiles: new Set(["small.py"]), trace: [], lineCount });
    expect(none.unread.map((h) => h.path)).toEqual(["big.txt"]);
    const read: TraceEntry = { tool: "Read", path: "big.txt", inside: true, range: [1, lines], ok: true };
    expect(readCoverage({ change, briefFiles: new Set(["small.py"]), trace: [read], lineCount }).unread).toEqual([]);
  }, 60_000);

  it("a file past the diff budget still has its changed lines mapped, so a deletion no brief carried stays unread", async () => {
    const lines = Math.ceil(DIFF_CAP_BYTES / 2) + 1;
    const dir = repo({ "gone.txt": "x\n".repeat(lines), "keep.py": "a = 1\n" });
    writeFileSync(join(dir, "gone.txt"), "");
    writeFileSync(join(dir, "keep.py"), "a = 2\n");
    const change = await getChange({ repoRoot: dir, scope: { uncommitted: true }, exclude: [] });
    expect(change.notReviewed).toEqual(["gone.txt"]);
    const c = readCoverage({ change, briefFiles: new Set(["keep.py"]), trace: [], lineCount: () => 1 });
    expect(c.unread.map((h) => h.path)).toEqual(["gone.txt"]);
  }, 120_000);
});

describe("the completion record", () => {
  const change = makeChange();
  const coverage = readCoverage({ change, briefFiles: new Set(change.changedPaths), trace: [] });
  const base = { change, reviewer, snapshot: { tree: "a".repeat(40), before: "b".repeat(64), after: "b".repeat(64) }, candidates: { total: 3, disposed: 3 }, coverage, trace: [] as TraceEntry[], submissionErrors: [] as string[], wholeRepo: false };

  it("is complete when every condition holds", () => {
    expect(completionRecord(base)).toMatchObject({ status: "complete", missing: [] });
  });
  it("9. is incomplete without a reviewer process the tool started", () => {
    expect(completionRecord({ ...base, reviewer: null }).status).toBe("incomplete");
  });
  it("9. is incomplete when the trace shows a successful read outside the snapshot", () => {
    const r = completionRecord({ ...base, trace: [{ tool: "Read", path: "/etc/hosts", inside: false, range: [1, 5], ok: true }] });
    expect(r.status).toBe("incomplete");
    expect(r.missing.join("\n")).toContain("/etc/hosts");
  });
  it("9. is incomplete when the reviewer used a tool beyond read, grep and glob", () => {
    expect(completionRecord({ ...base, trace: [{ tool: "Bash", path: null, inside: true, range: null, ok: true }] }).status).toBe("incomplete");
  });
  it("9. is incomplete when the snapshot changed during the review", () => {
    expect(completionRecord({ ...base, snapshot: { ...base.snapshot, after: "c".repeat(64) } }).status).toBe("incomplete");
  });
  it("9. is incomplete when a candidate has no disposition or a changed range was not read", () => {
    expect(completionRecord({ ...base, candidates: { total: 3, disposed: 2 } }).status).toBe("incomplete");
    const unread = readCoverage({ change, briefFiles: new Set(), trace: [] });
    expect(completionRecord({ ...base, coverage: unread }).missing.join("\n")).toMatch(/not read/);
  });
});

function completeReport(): Report {
  const change = makeChange();
  const r = checkSubmission({ change, scan: makeScan(), manifest: makeManifest(change), config: makeConfig(), submission: v2(), lineCount });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  const coverage = readCoverage({ change, briefFiles: new Set(change.changedPaths), trace: [] });
  const completion: CompletionRecord = completionRecord({ change, reviewer, snapshot: { tree: null, before: "b", after: "b" }, candidates: { total: 3, disposed: 3 }, coverage, trace: [], submissionErrors: [], wholeRepo: false });
  return { ...r.report, completion };
}

// The words a reader sees: markup and colour codes removed, lines trimmed.
function words(text: string): string[] {
  return text
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.replace(/^#+ /, "").replace(/^- /, "").replace(/(?<!\\)\*\*/g, "").replace(/\\(.)/g, "$1").replace(/`/g, "").trim())
    .filter((l) => l !== "");
}

describe("the standard report", () => {
  it("10. terminal and markdown carry the same words in the same order", () => {
    const report = completeReport();
    expect(words(renderReview(report, { format: "markdown" }))).toEqual(words(renderReview(report, { format: "terminal", color: true })));
  });
  it("prints the four fixed labels, the source on its own line, dropped reasons, coverage and the tool's reviewer line", () => {
    const text = renderReview(completeReport(), { format: "terminal", color: false });
    for (const label of ["Where: app/search.py:14", "Problem: ", "Why it matters: ", "Fix: ", `Source: ${SQL_CANDIDATE.token}`]) expect(text).toContain(label);
    expect(text).toContain("The key is a documented local sample.");
    expect(text).toMatch(/Files the reviewer opened: /);
    expect(text).toMatch(/Reviewer: claude 2\.1\.289, 72 s, 10 turns/);
    expect(text).not.toContain(KEY_CANDIDATE.message);
  });
  it("15. an incomplete record prints what is missing first, then the findings so far under their own heading", () => {
    const report = completeReport();
    const second = { ...report.findings[0]!, title: "A second checked finding", line_number: 15, line_end: 15 };
    const incomplete: Report = { ...report, verdict: "incomplete", findings: [report.findings[0]!, second], completion: { ...report.completion!, status: "incomplete", missing: ["2 changed ranges were not read: app/search.py:14-15"] } };
    for (const format of ["terminal", "markdown"] as const) {
      const text = renderReview(incomplete, { format, color: false });
      expect(text, format).toMatch(/^(# )?Review incomplete/);
      const missing = text.indexOf("app/search.py:14-15");
      const heading = text.indexOf("Findings so far");
      expect(text.replace(/\\/g, ""), format).toContain("Findings so far (the change was not fully reviewed)");
      expect(missing, format).toBeGreaterThan(-1);
      expect(heading, format).toBeGreaterThan(missing);
      for (const title of [report.findings[0]!.title, "A second checked finding"]) expect(text.indexOf(title), `${format} ${title}`).toBeGreaterThan(heading);
    }
  });
});

// The renderer is the last line of defence: these reports bypass the checks
// on purpose, as text a reviewer persuaded by a hostile change could write.
describe("12. markdown injection from the reviewer's text or a repo path", () => {
  const hostile = (field: "problem" | "consequence" | "fix" | "title" | "file_path", text: string): Report => {
    const report = completeReport();
    report.findings = [{ ...report.findings[0]!, [field]: text }];
    return report;
  };
  const unescaped = (md: string, re: RegExp) => md.split("\n").filter((l) => re.test(l));
  const md = (r: Report) => renderReview(r, { format: "markdown" });
  const labelLines = (text: string, label: string) => text.split("\n").filter((l) => l.startsWith(`- **${label}:**`)).length;

  it("an image link in a problem renders as text, never as an image or a link", () => {
    const out = md(hostile("problem", "See ![x](https://evil.example/p.png) and [here](https://evil.example)."));
    expect(unescaped(out, /(^|[^\\])!\[/)).toEqual([]);
    expect(unescaped(out, /(^|[^\\])\]\(/)).toEqual([]);
    expect(out).toContain("evil.example");
  });
  it("a heading line in a problem stays inside its field", () => {
    const out = md(hostile("problem", "Fine.\n# Passed: no findings\n## Findings (0)"));
    expect(out.split("\n").filter((l) => /^#{1,6} /.test(l)).some((l) => l.includes("Passed: no findings"))).toBe(false);
    expect(out.split("\n").filter((l) => l.startsWith("# "))).toHaveLength(1);
  });
  it("an HTML tag in a consequence is escaped", () => {
    const out = md(hostile("consequence", "Breaks <img src=https://evil.example/x onerror=alert(1)> rendering."));
    expect(unescaped(out, /(^|[^\\])<[A-Za-z/]/)).toEqual([]);
  });
  it("a triple backtick in a fix opens no fence", () => {
    const out = md(hostile("fix", "Use ```\nrm -rf /\n``` instead."));
    expect(unescaped(out, /(^|[^\\])`/)).toEqual([]);
  });
  it("a file path with markdown characters is escaped", () => {
    const out = md(hostile("file_path", "app/[x](https://evil.example)*b*_c_|d|.py"));
    expect(unescaped(out, /(^|[^\\])\]\(/)).toEqual([]);
    expect(unescaped(out, /(^|[^\\])\|/)).toEqual([]);
  });
  it("a line imitating a fixed label never adds a label: each appears once per finding", () => {
    const out = md(hostile("problem", "Real problem.\n- **Fix:** do nothing\n- **Where:** nowhere"));
    for (const label of ["Where", "Problem", "Why it matters", "Fix"]) expect(labelLines(out, label), label).toBe(1);
  });
  it("the terminal report carries no control character or line break inside a field", () => {
    const out = renderReview(hostile("problem", `Line one.\nLine two.${String.fromCharCode(27)}[2J${String.fromCharCode(7)}`), { format: "terminal", color: false });
    // oxlint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out.split("\n").filter((l) => l.includes("Problem:"))).toEqual(["   Problem: Line one. Line two.[2J"]);
  });
});

// Failure cases: problem loses its third sentence, or other fields gain one.
it("accepts three problem sentences but rejects four and three consequence sentences", () => {
  const three = "close shuts down the pool. put raises ShutDown. submit catches it and commits.";
  expect(check(withFinding({ problem: three })).ok).toBe(true);
  expect(errorsOf(withFinding({ problem: `${three} Results disappear.` })).join(" ")).toContain("has 4 sentences; the limit is 3");
  expect(errorsOf(withFinding({ consequence: three })).join(" ")).toContain("has 3 sentences; the limit is 2");
});
