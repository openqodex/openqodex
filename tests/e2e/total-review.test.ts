// `openqodex review` as one run: the built CLI, the real scanners and, when
// they are installed and logged in, the real Claude Code and the real Codex
// as the reviewer. The cases with a real reviewer cost real usage, so there
// are four; each one skips with a printed reason when the reviewer cannot
// run here.
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
//  9. A target review with --report-dir follows caller symlinks, fails to
//     write fallback artifacts, or leaves a checkout.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Candidate, Report } from "@openqodex/core";
import "./global-setup.js";
import { baseline, codexMissing, demo, generatedSecret, git, readJson, reportDir, reviewerMissing, root, run, noReviewerEnv, snapshot, toolsHome } from "./support.js";

type Bug = { id: string; file: string; lines: [number, number] };
const expected = readJson<{ bugs: Bug[] }>(join(root, "examples/demo-repo/expected.json"));
const ours = () => (existsSync(join(toolsHome, "checkouts")) ? readdirSync(join(toolsHome, "checkouts")).filter((n) => n.startsWith("work-")) : []);

describe("without a reviewer", () => {
  it("9. a target review with --report-dir ignores caller symlinks, writes fallback artifacts and removes its checkout", () => {
    const dir = baseline();
    const outside = mkdtempSync(join(tmpdir(), "oq-total-target-"));
    const home = join(outside, "home");
    const folder = join(outside, "report");
    const canary = join(outside, "canary.md");
    const canaryText = "Harmless outside instructions.\n";
    const invalidConfig = "review: [\n";
    writeFileSync(canary, canaryText);
    git(dir, "branch", "-M", "main");
    git(dir, "switch", "-c", "feature");
    const code = join(dir, "app/server.py");
    writeFileSync(code, `${readFileSync(code, "utf8")}\ndef greeting(name):\n    return f"Hello {name}"\n`);
    mkdirSync(join(dir, ".openqodex"));
    writeFileSync(join(dir, ".openqodex/config.yaml"), invalidConfig);
    symlinkSync(canary, join(dir, ".openqodex/custom-instructions.md"));
    git(dir, "add", "-f", "app/server.py", ".openqodex/config.yaml", ".openqodex/custom-instructions.md");
    git(dir, "commit", "-qm", "Add greeting and unsafe target settings");
    git(dir, "switch", "main");
    mkdirSync(join(dir, ".openqodex"));
    writeFileSync(join(dir, ".openqodex/config.yaml"), invalidConfig);
    symlinkSync(canary, join(dir, ".openqodex/custom-instructions.md"));
    const before = snapshot(dir);
    const worktrees = git(dir, "worktree", "list", "--porcelain");

    const out = run("total-target-report-dir", dir, [
      "review", "feature", "--base", "main", "--report-dir", folder,
      "--offline", "--only", "hadolint", "--no-install", "--no-graph",
    ], { tools: home, env: noReviewerEnv() });

    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(join(dir, ".openqodex")).sort()).toEqual(["config.yaml", "custom-instructions.md"]);
    expect(lstatSync(join(dir, ".openqodex/custom-instructions.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, ".openqodex/custom-instructions.md"))).toBe(canary);
    expect(readFileSync(canary, "utf8")).toBe(canaryText);
    expect(readFileSync(join(dir, ".openqodex/config.yaml"), "utf8")).toBe(invalidConfig);
    expect(readdirSync(join(home, "checkouts"))).toEqual([]);
    expect(git(dir, "worktree", "list", "--porcelain")).toBe(worktrees);
    expect(out.status, out.stderr).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain("symbolic link");
    expect(out.stderr).toContain("Full review unavailable");
    expect(readdirSync(folder).sort()).toEqual(["reviewer.json", "unchecked-candidates.json"]);
    const reviewer = readJson<{ started: boolean; reasons: string[] }>(join(folder, "reviewer.json"));
    expect(reviewer.started).toBe(false);
    expect(reviewer.reasons.length).toBeGreaterThan(0);
    const unchecked = readJson<{ label: string; change_id: string; candidates: Candidate[] }>(join(folder, "unchecked-candidates.json"));
    expect(unchecked.label).toBe("unchecked scanner candidates, not a review: no reviewer checked them");
    expect(unchecked.change_id).not.toBe("");
    expect(unchecked.candidates).toEqual([]);
  });

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

describe("with Claude Code as the reviewer", () => {
  const missing = reviewerMissing();
  let dir: string;
  let demoRun: ReturnType<typeof run>;
  let report: Report;
  beforeAll(() => {
    if (missing !== null) return;
    dir = demo("total-claude");
    demoRun = run("total-claude", dir, ["review", "--no-color"], { home: process.env.HOME });
    report = readJson<Report>(join(reportDir(dir), "report.json"));
  }, 700_000);

  it("1, 6. the planted change gives a complete report where no scanner message appears raw", () => {
    if (missing !== null) return void process.stdout.write(`total review with claude: skipped, ${missing}\n`);
    expect(demoRun.status, demoRun.stderr).toBe(0);
    expect(report.completion?.status).toBe("complete");
    expect(report.completion?.reviewer?.driver).toBe("claude");
    const candidates = readJson<{ candidates: Candidate[] }>(join(reportDir(dir), "scan.json"));
    const raw = candidates.candidates.map((c) => c.message.replace(/\s+/g, " ").trim()).filter((m) => m.length > 20);
    expect(raw.filter((m) => demoRun.stdout.includes(m))).toEqual([]);
    // A rule id appears only on a Source line.
    for (const line of demoRun.stdout.split("\n").filter((l) => /^\s+(Problem|Why it matters|Fix):/.test(l))) {
      for (const c of candidates.candidates) expect(line).not.toContain(c.token);
    }
    expect(demoRun.stdout).not.toContain(generatedSecret(dir));
    expect(readFileSync(join(reportDir(dir), "report.md"), "utf8")).toContain("**Why it matters:**");
    expect(ours()).toEqual([]);
  });

  it("2. finds the pagination offset bug that no scanner reports", () => {
    if (missing !== null) return void process.stdout.write(`total review with claude: skipped, ${missing}\n`);
    const bug = expected.bugs.find((b) => b.id === "pagination-off-by-one")!;
    const hit = report.findings.some((f) => f.file_path === bug.file && f.line_number <= bug.lines[1] + 2 && f.line_end >= bug.lines[0] - 2);
    expect(hit, JSON.stringify(report.findings.map((f) => `${f.file_path}:${f.line_number} ${f.title}`))).toBe(true);
  });

  it("3. a clean change gives a complete report with no findings", () => {
    if (missing !== null) return void process.stdout.write(`total review with claude: skipped, ${missing}\n`);
    const clean = baseline();
    writeFileSync(join(clean, "README.md"), "# Demo service\n\nA small Flask service used to try OpenQodex.\n");
    const out = run("total-clean", clean, ["review", "--format", "json"], { home: process.env.HOME });
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout) as Report;
    expect(r.completion?.status).toBe("complete");
    expect(r.findings).toEqual([]);
  });
});

describe("with Codex as the reviewer", () => {
  const missing = codexMissing();
  it("8. the planted change gives a complete report that names Codex and says reads were not recorded", () => {
    if (missing !== null) return void process.stdout.write(`total review with codex: skipped, ${missing}\n`);
    const dir = demo("total-codex");
    const out = run("total-codex", dir, ["review", "--reviewer", "codex", "--no-color"], { home: process.env.HOME, timeout: 900_000 });
    const report = readJson<Report>(join(reportDir(dir), "report.json"));
    expect(report.completion?.reviewer?.driver).toBe("codex");
    expect(report.completion?.trace_complete).toBe(false);
    expect(out.stdout).toMatch(/Reviewer: codex \d+\.\d+\.\d+/);
    expect(out.stdout).toContain("Files read: not recorded by Codex");
    expect(out.stdout).not.toContain("Files not read");
    expect(report.completion?.status, out.stderr).toBe("complete");
    expect(out.stdout).not.toContain(generatedSecret(dir));
  }, 1_000_000);
});
