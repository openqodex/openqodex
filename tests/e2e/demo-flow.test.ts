// The whole developer path on one demo repo, in the order a developer takes it:
// init, the push hook before a review, scan, review --agent, the agent's
// findings, review --finalize, the push hook after it. Each step runs once in
// beforeAll; each case below checks one thing that can break.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { changedFiles, demo, generatedSecret, git, inventory, readBrief, readJson, receipt, report, reportDir, root, run, skipNetwork, snapshot, submission, writeConfig } from "./support.js";
import type { Brief, Result, Snapshot } from "./support.js";

type Bug = { id: string; file: string; lines: [number, number]; detectors: { scanner: string; rule_id: string }[] | null };
const expected = readJson<{ bugs: Bug[] }>(join(root, "examples/demo-repo/expected.json"));
const pushInput = (cwd: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd });

let dir: string; let home: string; let secret: string; let planted: string[];
let homeAfterFirstInit: Record<string, string>; let homeAfterSecondInit: Record<string, string>;
let hookCommand: string; let hookBefore: Result; let hookAfter: Result; let hookBlocked: Result;
let init: Result; let scan: Result; let agent: Result; let finalize: Result;
let scanReport: Report; let brief: Brief; let finalReport: Report;
const snaps: Record<"start" | "init" | "scan" | "agent" | "finalize", Snapshot> = {} as never;

beforeAll(() => {
  dir = demo("flow"); home = mkdtempSync(join(tmpdir(), "oq-flow-home-"));
  secret = generatedSecret(dir);
  planted = git(dir, "ls-files", "--modified", "--others", "--exclude-standard").trim().split("\n");
  snaps.start = snapshot(dir);

  init = run("flow-init", dir, ["init", "--yes", "--agent", "all"], { home });
  snaps.init = snapshot(dir);
  homeAfterFirstInit = inventory(home, true);
  run("flow-init-again", dir, ["init", "--yes", "--agent", "all"], { home });
  homeAfterSecondInit = inventory(home, true);
  const settings = readJson<{ hooks: { PreToolUse: { hooks: { command: string }[] }[] } }>(join(home, ".claude/settings.json"));
  hookCommand = settings.hooks.PreToolUse.flatMap((h) => h.hooks)[0]!.command;
  hookBefore = run("flow-hook-unreviewed", dir, [hookCommand], { shell: true, home, input: pushInput(dir) });

  scan = run("flow-scan", dir, ["scan"], { home });
  snaps.scan = snapshot(dir);
  scanReport = report(dir);
  const out = reportDir(dir);
  for (const name of ["report.json", "report.md", "report.sarif"]) cpSync(join(out, name), join(receipt, "flow-scan", name));
  writeFileSync(join(receipt, "flow-scan", "terminal.txt"), scan.stdout);

  agent = run("flow-review-agent", dir, ["review", "--agent"], { home });
  snaps.agent = snapshot(dir);
  brief = readBrief(dir);
  const raised = [brief.candidates.find((c) => c.filePath === "app/config.py")!, brief.candidates.find((c) => c.filePath === "app/search.py")!];
  writeFileSync(join(brief.path, "agent-findings.json"), JSON.stringify(submission(brief.changeId, brief.candidates, raised)));
  finalize = run("flow-review-finalize", dir, ["review", "--finalize", "--format", "json"], { home });
  snaps.finalize = snapshot(dir);
  finalReport = report(dir);
  hookAfter = run("flow-hook-reviewed", dir, [hookCommand], { shell: true, home, input: pushInput(dir) });

  writeConfig(dir, "review:\n  block_on_severity: major\n");
  hookBlocked = run("flow-hook-blocked", dir, [hookCommand], { shell: true, home, input: pushInput(dir) });
}, 900_000);

describe("init", () => {
  it("writes every user-scope agent file into the home folder", () => {
    expect(init.status).toBe(0);
    for (const file of [".claude/skills/openqodex/SKILL.md", ".claude/settings.json", ".agents/skills/openqodex/SKILL.md", ".codex/hooks.json", ".cursor/skills/openqodex/SKILL.md", ".cline/skills/openqodex/SKILL.md", "Documents/Cline/Rules/openqodex.md"]) {
      expect(readFileSync(join(home, file), "utf8").length, file).toBeGreaterThan(0);
    }
  });
  it("run a second time changes no file in the home folder", () => {
    expect(homeAfterSecondInit).toEqual(homeAfterFirstInit);
  });
  // User scope puts the Cursor rule in the repo, hidden by .git/info/exclude
  // (templates/README.md, Cursor), and the team review section in CLAUDE.md
  // and AGENTS.md, which git status shows so the developer commits them.
  it("adds the git-excluded Cursor rule and the two visible team files, and leaves the index unchanged", () => {
    expect(changedFiles(snaps.start.files, snaps.init.files)).toEqual([".cursor/rules/openqodex.mdc", "AGENTS.md", "CLAUDE.md"]);
    expect(snaps.init.index).toBe(snaps.start.index);
    const lines = (status: string) => status.split("\n").filter(Boolean).sort();
    expect(lines(snaps.init.status)).toEqual([...lines(snaps.start.status), "?? AGENTS.md", "?? CLAUDE.md"].sort());
  });
});

describe("push hook written by init", () => {
  it("tells the agent an unreviewed change has not been reviewed, without denying the push", () => {
    expect(hookBefore.status).toBe(0);
    expect(hookBefore.stdout).toContain("has not reviewed this change");
    expect(hookBefore.stdout).not.toContain("permissionDecision");
  });
  it("abstains after a finalized review and never prints allow", () => {
    expect(hookAfter.status).toBe(0);
    expect(hookAfter.stdout).not.toContain("permissionDecision");
    expect(hookAfter.stdout).not.toContain('"allow"');
  });
  it("denies the push when block_on_severity is set and the current change has no passing review", () => {
    expect(hookBlocked.status).toBe(0);
    expect(hookBlocked.stdout).toContain('"permissionDecision":"deny"');
  });
});

describe("scan", () => {
  it("reports every planted scanner bug on its file and lines", () => {
    expect(scan.status).toBe(0);
    for (const bug of expected.bugs) {
      // null: no scanner can see it on a changed line (the logic bug, the root container).
      if (bug.detectors === null) continue;
      // A bug with several detectors is found by any one of them: cross-scanner
      // dedup keeps one finding per secret on a line.
      const detectors = bug.detectors.filter((d) => !(["semgrep", "osv-scanner"].includes(d.scanner) && skipNetwork(`${bug.id} by ${d.scanner}`)));
      if (detectors.length === 0) continue;
      const hit = scanReport.findings.some((f) => detectors.some((d) => f.source === `${d.scanner}:${d.rule_id}`) && f.file_path === bug.file && f.line_number <= bug.lines[1] && f.line_end >= bug.lines[0]);
      expect(hit, bug.id).toBe(true);
    }
  });
  it("reports nothing on a file the change did not touch", () => {
    expect(scanReport.findings.filter((f) => !planted.includes(f.file_path)).map((f) => `${f.file_path}:${f.source}`)).toEqual([]);
  });
  it("lists all thirteen builtin scanners and ran every scanner a planted bug names", () => {
    expect(scanReport.scanners).toHaveLength(13);
    const needed = new Set(expected.bugs.flatMap((b) => b.detectors ?? []).map((d) => d.scanner).filter((s) => !(["semgrep", "osv-scanner"].includes(s) && skipNetwork(s))));
    for (const name of needed) expect(scanReport.scanners.find((s) => s.scanner === name)?.status, name).toBe("ran");
  });
  it("finishes a warm scan within 30 seconds, so the process does not stay alive after its work", () => {
    expect(scan.ms).toBeLessThan(30_000);
  });
});

describe("review", () => {
  it("prints a brief with the change id, the findings path and candidates for the secret and the SQL injection", () => {
    expect(agent.status).toBe(0);
    expect(agent.stdout).toContain(brief.changeId);
    expect(agent.stdout).toContain(join(brief.path, "agent-findings.json"));
    expect(brief.candidates.some((c) => c.filePath === "app/config.py")).toBe(true);
    expect(brief.candidates.some((c) => c.filePath === "app/search.py")).toBe(true);
  });
  it("finalizes the two raised findings with nothing left unreviewed", () => {
    expect(finalize.status).toBe(0);
    expect(finalReport).toMatchObject({ kind: "review", not_reviewed: [] });
    expect(finalReport.findings.map((f) => f.file_path).sort()).toEqual(["app/config.py", "app/search.py"]);
  });
});

it("never shows the generated secret in the output of scan, review --agent or review --finalize, or in any file under .openqodex", () => {
  const leaks: string[] = [];
  for (const [name, r] of Object.entries({ scan, agent, finalize })) {
    if (r.stdout.includes(secret)) leaks.push(`${name} stdout`);
    if (r.stderr.includes(secret)) leaks.push(`${name} stderr`);
  }
  for (const file of Object.keys(inventory(join(dir, ".openqodex"), true))) {
    if (readFileSync(join(dir, ".openqodex", file), "utf8").includes(secret)) leaks.push(`.openqodex/${file}`);
  }
  expect(leaks).toEqual([]);
});

describe("the repository after each command", () => {
  const steps = [["scan", "init", "scan"], ["review --agent", "scan", "agent"], ["review --finalize", "agent", "finalize"]] as const;
  for (const [name, before, after] of steps) {
    it(`${name} leaves every file outside .openqodex, the index and git status (ignored files included) unchanged`, () => {
      expect(changedFiles(snaps[before].files, snaps[after].files)).toEqual([]);
      expect(snaps[after].index).toBe(snaps[before].index);
      // Run state comes and goes inside .openqodex, ignored by its .gitignore: a
      // scan writes only latest-scan.json, a review also the graph cache.
      const noReceipts = (text: string) => text.split("\n").filter((l) => !l.startsWith("!! .openqodex/")).join("\n");
      expect(noReceipts(snaps[after].ignored)).toBe(noReceipts(snaps[before].ignored));
    });
  }
});
