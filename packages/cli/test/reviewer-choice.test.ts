// Which reviewer `review` starts, and with which tools: the --reviewer flag,
// the project's review.reviewers and review.reviewer_web
// (.openqodex/config.yaml), and `auto`. The Codex and Cursor drivers are
// this repo's own modules; the reviewer model is the one stand-in, a driver
// object that answers with a recorded submission. What happens when a
// listed reviewer cannot start or cannot serve is reviewer-list.test.ts.
//
// Ways it could fail, written before the code:
//  1. `auto` picks a driver that is not enabled (Cursor).
//  2. `--reviewer codex` run from inside Codex's own sandbox, where a nested
//     Codex cannot start, crashes or hangs instead of saying "Full review
//     unavailable" with the reason and the fallback command.
//  8. `auto` inside Claude Code does not pick Claude Code, though Codex is
//     installed too.
//  9. `auto` with only Codex available does not pick Codex.
// 10. `auto` inside a Codex session does not pick Codex first.
// 13. `auto` inside a Cursor session does not try Cursor first, so the reasons
//     a review is unavailable do not start with the agent the developer is in.
// 11. A driver whose per-run boundary check fails (Codex's sandbox probe)
//     still starts the reviewer, or ends as "Review incomplete" instead of
//     "Full review unavailable" with the reason and the fallback.
//  3. The project's review.reviewers is ignored, or `auto` starts a reviewer
//     it does not list.
//  4. The flag does not win over the project's list.
//  5. The reviewer lacks its web tools with no config file, or keeps them
//     with review.reviewer_web: off.
//  6. A run that uses the web tools while they are on is failed by the
//     trace check.
//  7. A list entry naming a tool openqodex does not know is silently ignored.
// 12. `--reviewer-web off` (the GitHub Action passes it) loses to the
//     project's reviewer_web: on.
// 14. A list entry's model or effort does not reach every session of its
//     agent, Claude Code or Codex, or the report does not say which model
//     reviewed; or a reviewer with none is given an empty one.
// 15. `--reviewer <tool>:<model>` with --reviewer-effort does not replace the
//     list for the run, or a value the tool cannot take is passed on.
// 16. --reviewer-model, retired, is taken silently for some tool, or
//     --reviewer-effort is taken without a tool to give it to.
// 17. Claude Code's command line does not carry --model and --effort from
//     the entry, or carries them when the entry has none.
// 18. A value of a list entry that a tool cannot take (a model that reads as
//     a flag, an effort it does not have) reaches the agent instead of
//     stopping the run with the file and the key named.
import { stagedFake } from "../../review/test/staged-fake.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { reviewerLine } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { run as runCommand } from "../src/commands/review.js";
import { DEPTH_ENV, claudeArgs, cursorDriver } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// A repo with one commit and an uncommitted text file: no scanner candidate.
// `config`: the project's .openqodex/config.yaml, committed with the base.
function repo(config?: string): string {
  const dir = tempDir("oq-choice-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  if (config !== undefined) {
    mkdirSync(join(dir, ".openqodex"));
    writeFileSync(join(dir, ".openqodex", "config.yaml"), config);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  writeFileSync(join(dir, "notes.txt"), "one line\n");
  return dir;
}

type Fake = ReviewerDriver & { starts: { web: boolean; model?: string | null; effort?: string | null }[] };

// The model provider stand-in: reads the changed file, then answers with an
// empty, valid submission. `calls` adds tool calls to the answer. `name`
// and `available` make it stand in for another agent, or for one that is
// not installed.
function fake(calls: Turn["calls"] = [], name = "claude", available = true): Fake {
  const driver: Fake = {
    name,
    traced: name === "claude",
    starts: [],
    async detect() {
      return available ? { ok: true as const, version: "9.9.9", bin: `/fake/${name}` } : { ok: false as const, missing: `${name} is not installed`, fix: `install ${name}` };
    },
    start(opts): ReviewerSession {
      const { snapshotDir } = opts;
      // A key the run did not pass stays absent, so a test can tell it from null.
      driver.starts.push({ web: opts.web, ...("model" in opts ? { model: opts.model } : {}), ...("effort" in opts ? { effort: opts.effort } : {}) });
      return stagedFake({
        pid: 4242,
        async send(text: string): Promise<Turn> {
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds a notes file.", findings: [], dropped: [] });
          const read = { tool: "Read", input: { file_path: "notes.txt" }, ok: true, read: { path: "notes.txt", start: 1, lines: 1 } };
          return { finalText, calls: [read, ...calls], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "fake", failure: null };
        },
        async close() {},
      }, snapshotDir);
    },
  };
  return driver;
}

let out: string;
let err: string;
let home: string;
beforeEach(() => {
  out = "";
  err = "";
  home = tempDir("oq-choice-home-");
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  // The agent running the tests must not decide `auto`.
  vi.stubEnv("CLAUDECODE", "");
  vi.stubEnv("CODEX_THREAD_ID", "");
  vi.stubEnv("CODEX_SANDBOX", "");
  vi.stubEnv("CURSOR_AGENT", "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function review(drivers: ReviewerDriver[], reviewer?: string, config?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", repo(config), "--no-color", "--format", "json"], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", reviewer, timeoutMs: 60_000, drivers });
}

const listing = (...entries: string[]) => `version: 1\nreview:\n  reviewers:\n${entries.map((e) => `    - ${e}\n`).join("")}`;

describe("choosing the reviewer", () => {
  it("1. auto passes by Cursor, which is not enabled, and starts Claude Code", async () => {
    const claude = fake();
    expect(await review([cursorDriver, claude])).toBe(0);
    expect(claude.starts).toHaveLength(2);
    expect((JSON.parse(out) as Report).completion?.reviewer?.driver).toBe("claude");
  });

  it("8. auto inside Claude Code picks Claude Code, with Codex available too", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    const codex = fake([], "codex");
    const claude = fake();
    expect(await review([codex, claude])).toBe(0);
    expect(claude.starts).toHaveLength(2);
    expect(codex.starts).toHaveLength(0);
  });

  it("9. auto with only Codex available picks Codex, and the report names it", async () => {
    const codex = fake([], "codex");
    expect(await review([fake([], "claude", false), codex])).toBe(0);
    expect(codex.starts).toHaveLength(2);
    const completion = (JSON.parse(out) as Report).completion;
    expect(completion?.reviewer?.driver).toBe("codex");
    expect(completion?.trace_complete).toBe(false);
  });

  it("10. auto inside a Codex session picks Codex before Claude Code", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "00000000-0000-0000-0000-000000000001");
    const codex = fake([], "codex");
    const claude = fake();
    expect(await review([claude, codex])).toBe(0);
    expect(codex.starts).toHaveLength(2);
    expect(claude.starts).toHaveLength(0);
  });

  it("13. auto inside a Cursor session tries Cursor first, so its reason is the first one named", async () => {
    vi.stubEnv("CURSOR_AGENT", "1");
    expect(await review([fake([], "claude", false), cursorDriver])).toBe(2);
    const reasons = err.split("\n").filter((l) => l.startsWith("- "));
    expect(reasons[0]).toMatch(/^- cursor: not enabled/);
    expect(reasons[1]).toMatch(/^- claude: /);
  });

  it("3. the project's review.reviewers picks the driver, and a driver it does not list is never started", async () => {
    const claude = fake();
    const codex = fake([], "codex");
    expect(await review([claude, codex], undefined, listing("tool: codex"))).toBe(0);
    expect(codex.starts).toHaveLength(2);
    expect(claude.starts).toHaveLength(0);
    expect((JSON.parse(out) as Report).completion?.reviewer?.driver).toBe("codex");
  });

  it("4. --reviewer wins over the project's list", async () => {
    const claude = fake();
    const codex = fake([], "codex");
    expect(await review([claude, codex], "claude", listing("tool: codex"))).toBe(0);
    expect(claude.starts).toHaveLength(2);
    expect(codex.starts).toHaveLength(0);
  });

  it("7. a list entry naming a tool openqodex does not know stops the run and names the file and the key", async () => {
    await expect(review([fake()], undefined, listing("tool: gemini"))).rejects.toThrow(/\.openqodex\/config\.yaml: review\.reviewers\[0\]\.tool: /);
    await expect(review([fake()], undefined, "review:\n  reviewer_web: sometimes\n")).rejects.toThrow(/\.openqodex\/config\.yaml: review\.reviewer_web: /);
  });
});

describe("a list entry's model and reasoning effort", () => {
  it("14. a Codex entry's model and effort reach every Codex session, and the report names them", async () => {
    const codex = fake([], "codex");
    expect(await review([codex], undefined, listing("tool: codex\n      model: gpt-test-model\n      effort: high"))).toBe(0);
    expect(codex.starts.length).toBeGreaterThan(0);
    for (const start of codex.starts) expect(start).toEqual({ web: true, model: "gpt-test-model", effort: "high" });
    const report = JSON.parse(out) as Report;
    expect(report.completion?.reviewer).toMatchObject({ driver: "codex", model: "gpt-test-model", effort: "high" });
    expect(reviewerLine(report.completion?.reviewer ?? null)).toMatch(/^Reviewer: codex 9\.9\.9, model gpt-test-model, effort high, /);
  });

  it("14. a Claude Code entry's model and effort reach every Claude Code session, and the report names them", async () => {
    const claude = fake();
    expect(await review([claude], undefined, listing("tool: claude\n      model: sonnet[1m]\n      effort: max"))).toBe(0);
    expect(claude.starts.length).toBeGreaterThan(0);
    for (const start of claude.starts) expect(start).toEqual({ web: true, model: "sonnet[1m]", effort: "max" });
    expect((JSON.parse(out) as Report).completion?.reviewer).toMatchObject({ driver: "claude", model: "sonnet[1m]", effort: "max" });
  });

  it("14. an entry, a reviewer named alone and auto with no model give none, and the report names none", async () => {
    for (const [reviewer, config] of [[undefined, listing("tool: codex")], ["codex", undefined], [undefined, undefined]] as const) {
      const codex = fake([], "codex");
      out = "";
      expect(await review([codex], reviewer, config)).toBe(0);
      for (const start of codex.starts) expect(start).toStrictEqual({ web: true });
      const reviewerRecord = (JSON.parse(out) as Report).completion?.reviewer;
      expect(reviewerRecord).not.toHaveProperty("model");
      expect(reviewerRecord).not.toHaveProperty("effort");
    }
  });

  it("15. --reviewer <tool>:<model> with --reviewer-effort replaces the project's list for the run, and a value the tool cannot take is refused before anything runs", async () => {
    const claude = fake();
    const codex = fake([], "codex");
    const cwd = repo(listing("tool: claude\n      model: opus"));
    expect(await runCommand(["--cwd", cwd, "--no-color", "--format", "json", "--only", "sqllint", "--no-graph", "--reviewer", "codex:gpt-flag", "--reviewer-effort", "xhigh"], [claude, codex])).toBe(0);
    expect(claude.starts).toHaveLength(0);
    for (const start of codex.starts) expect(start).toEqual({ web: true, model: "gpt-flag", effort: "xhigh" });
    const unused = fake([], "codex");
    await expect(runCommand(["--cwd", cwd, "--reviewer", "codex", "--reviewer-effort", "max"], [unused])).rejects.toThrow(/^--reviewer-effort must be one of low, medium, high, xhigh for codex, not max$/);
    await expect(runCommand(["--cwd", cwd, "--reviewer", "codex:-m"], [unused])).rejects.toThrow(/^--reviewer codex:-m: the model must be a Codex model id/);
    await expect(runCommand(["--cwd", cwd, "--reviewer", "gemini:pro"], [unused])).rejects.toThrow(/^--reviewer must be auto, one of claude, codex, cursor, or <tool>:<model>/);
    expect(unused.starts).toHaveLength(0);
  });

  it("16. --reviewer-model is refused with the flag that replaces it, and --reviewer-effort needs a tool", async () => {
    const cwd = repo();
    const unused = fake([], "codex");
    await expect(runCommand(["--cwd", cwd, "--reviewer", "codex", "--reviewer-model", "gpt-5.5"], [unused])).rejects.toThrow(/^--reviewer-model is replaced by --reviewer <tool>:<model>, such as --reviewer codex:gpt-5\.5$/);
    await expect(runCommand(["--cwd", cwd, "--reviewer-effort", "low"], [unused])).rejects.toThrow(/^--reviewer-effort goes with --reviewer <tool>/);
    await expect(runCommand(["--cwd", cwd, "--reviewer", "auto", "--reviewer-effort", "low"], [unused])).rejects.toThrow(/not auto$/);
    expect(unused.starts).toHaveLength(0);
  });

  it("18. a list entry value the tool cannot take stops the run, naming the file and the key", async () => {
    for (const [entry, key] of [["tool: codex\n      model: '--yolo'", "model"], ["tool: codex\n      effort: max", "effort"], ["tool: codex\n      effort: minimal", "effort"], ["tool: claude\n      model: '-p'", "model"], ["tool: claude\n      effort: ultra", "effort"]] as const) {
      const codex = fake([], "codex");
      const claude = fake();
      await expect(review([claude, codex], undefined, listing(entry))).rejects.toThrow(new RegExp(`\\.openqodex/config\\.yaml: review\\.reviewers\\[0\\]\\.${key}: must be`));
      expect(codex.starts).toHaveLength(0);
      expect(claude.starts).toHaveLength(0);
    }
  });

  it("17. Claude Code's command line carries --model and --effort from the entry, and neither without one", () => {
    const args = claudeArgs(true, "opus", "high");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    const plain = claudeArgs(true);
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--effort");
  });
});

describe("the per-run boundary check", () => {
  it("11. a failed check never starts the reviewer and ends as Full review unavailable with the reason and the fallback", async () => {
    const codex = Object.assign(fake([], "codex"), { check: async () => "Codex's sandbox did not confine reads to the review copy; the review did not start (a file outside it could be read)" });
    expect(await review([codex], "codex")).toBe(2);
    expect(codex.starts).toHaveLength(0);
    expect(out).toBe("");
    expect(err).toContain("Full review unavailable");
    expect(err).toContain("codex: Codex's sandbox did not confine reads to the review copy; the review did not start");
    expect(err).toMatch(/review --agent/);
  });
});

describe("web tools", () => {
  it("5. with no config file the reviewer is started with web on and the Claude Code command line carries WebSearch and WebFetch", async () => {
    const claude = fake();
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: true }, { web: true }]);
    const args = claudeArgs(true);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,WebSearch,WebFetch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
  });

  it("5. the project's review.reviewer_web: off starts the reviewer without web tools, and the Claude Code command line names none", async () => {
    const claude = fake();
    expect(await review([claude], undefined, "review:\n  reviewer_web: off\n")).toBe(0);
    expect(claude.starts).toEqual([{ web: false }, { web: false }]);
    const args = claudeArgs(false);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args.join(" ")).not.toMatch(/WebSearch|WebFetch/);
  });

  it("6. with web on, a run that uses WebSearch completes", async () => {
    const web = [{ tool: "WebSearch", input: { query: "flask pagination" }, ok: true, read: null }];
    const claude = fake(web);
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: true }, { web: true }]);
    expect((JSON.parse(out) as Report).completion?.status).toBe("complete");
  });

  it("12, R26. --reviewer-web off wins over the project's reviewer_web: on, and the file stays as it was", async () => {
    const text = "review: {reviewer_web: on}\n";
    const cwd = repo(text);
    const claude = fake();
    const { global } = parseFlags(["--cwd", cwd, "--no-color", "--format", "json"], {});
    expect(await runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", timeoutMs: 60_000, drivers: [claude], web: false })).toBe(0);
    expect(claude.starts).toEqual([{ web: false }, { web: false }]);
    expect(readFileSync(join(cwd, ".openqodex", "config.yaml"), "utf8")).toBe(text);
    // Without the flag the same file turns the web tools on.
    const own = fake();
    expect(await review([own], undefined, text)).toBe(0);
    expect(own.starts).toEqual([{ web: true }, { web: true }]);
  });

  it("5. with review.reviewer_web: off, a web tool call makes the run incomplete", async () => {
    const web = [{ tool: "WebFetch", input: { url: "https://example.com", prompt: "read" }, ok: true, read: null }];
    expect(await review([fake(web)], undefined, "review:\n  reviewer_web: off\n")).toBe(2);
    expect((JSON.parse(out) as Report).completion?.missing.join("\n")).toContain("WebFetch");
  });
});
