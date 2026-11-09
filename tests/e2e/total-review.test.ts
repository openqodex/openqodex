// `openqodex review` as one run: the built CLI, the real scanners and, when
// they are installed and logged in, the real Claude Code and the real Codex
// as the reviewer. The cases with a real reviewer cost real usage, so there
// are five, and they run only in the model tier (pnpm gate:model, which sets
// OPENQODEX_MODEL_TESTS=1); anywhere else their groups skip with a printed
// reason. In the model tier a reviewer that cannot run fails the case.
//
// Ways it could fail, written before the code:
//  1. Scanner text reaches the printed report raw, or the report is not complete.
//  2. The semantic-only planted bug (the pagination offset in app/server.py,
//     which no scanner reports) is not found.
//  3. A clean change does not give a complete report with no findings.
//  4. With no reviewer it prints findings, or exits anything but 2.
//  5. A review started inside a reviewer starts another one.
//  6. The snapshot stays on disk after the run.
//  7. Asked for Codex from inside Codex's own sandbox, where a nested Codex
//     cannot start, it crashes or hangs instead of offering the fallback.
//  8. With Codex as the reviewer, the planted change gives no report, a
//     report that does not name Codex, or one that claims reads it never
//     measured.
//  9. The screen carries the whole report instead of the receipt: a
//     finding's problem or fix, no absolute path of report.html, or one that
//     names no file; or report.html misses a finding, shows one twice, holds
//     the planted secret or a script, or states another verdict.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Candidate, Report } from "@openqodex/core";
import "./global-setup.js";
import { baseline, codexMissing, demo, generatedSecret, modelTestsOff, readJson, reportDir, requireReviewer, reviewerMissing, root, run, noReviewerEnv, toolsHome } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

type Bug = { id: string; file: string; lines: [number, number] };
const expected = readJson<{ bugs: Bug[] }>(join(root, "examples/demo-repo/expected.json"));
const ours = () => (existsSync(join(toolsHome, "checkouts")) ? readdirSync(join(toolsHome, "checkouts")).filter((n) => n.startsWith("work-")) : []);

describe("without a reviewer", () => {
  it("4, 6. exits 2 with Full review unavailable, prints no finding and leaves no snapshot", () => {
    const dir = demo("total-none");
    const before = ours();
    const out = run("total-none", dir, ["review", "--format", "json"], { env: noReviewerEnv() });
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Full review unavailable");
    expect(out.stderr).toMatch(/Unchecked scanner candidates, not a review: \S+unchecked-candidates\.json/);
    expect(out.stderr).not.toContain(generatedSecret(dir));
    expect(ours()).toEqual(before);
  });
  it("7. --reviewer codex inside Codex's own sandbox exits 2 with Full review unavailable, the reason and the fallback", () => {
    const dir = demo("total-codex-sandbox");
    const out = run("total-codex-sandbox", dir, ["review", "--reviewer", "codex", "--format", "json"], { env: { CODEX_SANDBOX: "seatbelt" } });
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Full review unavailable");
    expect(out.stderr).toMatch(/codex: Codex cannot start a second Codex inside its own sandbox/);
    expect(out.stderr).toMatch(/review --agent/);
  });
  it("5. refuses inside a reviewer with one line", () => {
    const out = run("total-nested", baseline(), ["review"], { env: { OPENQODEX_REVIEW_DEPTH: "1" } });
    expect(out.status).toBe(2);
    expect(out.stderr.trim().split("\n")).toEqual(["openqodex: openqodex review cannot run inside an openqodex reviewer"]);
  });
});

describe.skipIf(modelTestsOff("total review with claude"))("with Claude Code as the reviewer", () => {
  let dir: string;
  let demoRun: ReturnType<typeof run>;
  let report: Report;
  // The review runs every verifier after the reviewer; it takes longer than
  // the helper's 300 s default (issue 283), so the run gets 900 s and the
  // hook more than that.
  beforeAll(() => {
    requireReviewer(reviewerMissing());
    dir = demo("total-claude");
    demoRun = run("total-claude", dir, ["review", "--no-color"], { home: process.env.HOME, timeout: 900_000 });
    report = readJson<Report>(join(reportDir(dir), "report.json"));
  }, 1_000_000);

  it("1, 6. the planted change gives a complete report where no scanner message appears raw", () => {
    expect(demoRun.status, demoRun.stderr).toBe(0);
    expect(report.completion?.status).toBe("complete");
    expect(report.completion?.reviewer?.driver).toBe("claude");
    const candidates = readJson<{ candidates: Candidate[] }>(join(reportDir(dir), "scan.json"));
    const raw = candidates.candidates.map((c) => c.message.replace(/\s+/g, " ").trim()).filter((m) => m.length > 20);
    expect(raw.filter((m) => demoRun.stdout.includes(m))).toEqual([]);
    const md = readFileSync(join(reportDir(dir), "report.md"), "utf8");
    // A rule id appears only on a Source line.
    for (const line of md.split("\n").filter((l) => /^- \*\*(Problem|Why it matters|Fix):\*\*/.test(l))) {
      for (const c of candidates.candidates) expect(line).not.toContain(c.token);
    }
    expect(demoRun.stdout).not.toContain(generatedSecret(dir));
    expect(md).toContain("**Why it matters:**");
    expect(ours()).toEqual([]);
  });

  it("9. the screen shows the receipt and report.html holds every finding under the code, with no secret and no script", () => {
    const lines = demoRun.stdout.trimEnd().split("\n");
    for (const prose of ["Problem:", "Why it matters:", "Fix:"]) expect(demoRun.stdout).not.toContain(prose);
    const html = /^Report: (\/.+\/report\.html)$/m.exec(demoRun.stdout)?.[1];
    expect(html, demoRun.stdout).toBeDefined();
    expect(html).toBe(join(realpathSync(reportDir(dir)), "report.html"));
    expect(lines.at(-1)).toBe(`Markdown: ${html!.replace(/report\.html$/, "report.md")}`);
    // The receipt numbers the findings, then the observations after them,
    // the numbers `openqodex findings <n>` takes.
    expect(lines.filter((l) => /^\d+\. (Critical|Major|Minor|Nitpick|Info) /.test(l))).toHaveLength(report.findings.length + (report.observations?.length ?? 0));
    const page = readFileSync(html!, "utf8");
    expect(statSync(html!).mode & 0o777).toBe(0o600);
    for (let n = 1; n <= report.findings.length; n++) expect(page.split(`id="f${n}"`).length - 1, `finding ${n}`).toBe(1);
    expect(page).not.toContain(generatedSecret(dir));
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain("app/search.py");
    expect(lines[0]).toMatch(report.verdict === "blocked" ? /^Blocked/ : /^Passed/);
  });

  it("2. finds the pagination offset bug that no scanner reports", () => {
    const bug = expected.bugs.find((b) => b.id === "pagination-off-by-one")!;
    const hit = report.findings.some((f) => f.file_path === bug.file && f.line_number <= bug.lines[1] + 2 && f.line_end >= bug.lines[0] - 2);
    expect(hit, JSON.stringify(report.findings.map((f) => `${f.file_path}:${f.line_number} ${f.title}`))).toBe(true);
  });

  it("3. a clean change gives a complete report with no findings", () => {
    const clean = baseline();
    writeFileSync(join(clean, "README.md"), "# Demo service\n\nA small Flask service used to try OpenQodex.\n");
    const out = run("total-clean", clean, ["review", "--format", "json"], { home: process.env.HOME });
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout) as Report;
    expect(r.completion?.status).toBe("complete");
    expect(r.findings).toEqual([]);
  });
});

describe.skipIf(modelTestsOff("total review with codex"))("with Codex as the reviewer", () => {
  it("8. the planted change gives a complete report that names Codex and says reads were not recorded", () => {
    requireReviewer(codexMissing());
    const dir = demo("total-codex");
    const out = run("total-codex", dir, ["review", "--reviewer", "codex", "--no-color"], { home: process.env.HOME, timeout: 900_000 });
    const report = readJson<Report>(join(reportDir(dir), "report.json"));
    expect(report.completion?.reviewer?.driver).toBe("codex");
    expect(report.completion?.trace_complete).toBe(false);
    const md = readFileSync(join(reportDir(dir), "report.md"), "utf8");
    expect(md).toMatch(/Reviewer: codex \d+\.\d+\.\d+/);
    expect(md).toContain("Files the reviewer opened:** not recorded by Codex");
    expect(md).not.toContain("Files not opened");
    expect(report.completion?.status, out.stderr).toBe("complete");
    expect(out.stdout).not.toContain(generatedSecret(dir));
    expect(readFileSync(join(reportDir(dir), "report.html"), "utf8")).not.toContain(generatedSecret(dir));
  }, 1_000_000);
});
