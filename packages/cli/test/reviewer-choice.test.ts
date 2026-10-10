// Which reviewer `review` starts, and with which tools: the --reviewer flag,
// the `reviewer:` and `reviewer_web:` keys of the user config
// (<openqodex home>/config.yaml), and `auto`. The Codex and Cursor drivers
// are this repo's own modules; the reviewer model is the one stand-in, a
// driver object that answers with a recorded submission.
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
//  3. The config's `reviewer:` key is ignored.
//  4. The flag does not win over the config.
//  5. The reviewer lacks its web tools with no config file, or keeps them
//     with `reviewer_web: off`.
//  6. A run that uses the web tools while they are on is failed by the
//     trace check.
//  7. A config value that is neither a known reviewer nor on or off is
//     silently ignored.
// 12. `--reviewer-web off` (the GitHub Action passes it) loses to the user
//     config, or needs the file edited: a config written as a flow mapping
//     breaks, and a run that dies leaves the file changed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { DEPTH_ENV, claudeArgs, codexDriver, cursorDriver } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { DEFAULT_REVIEWER_WEB } from "../src/reviewers/settings.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// A repo with one commit and an uncommitted text file: no scanner candidate.
function repo(): string {
  const dir = tempDir("oq-choice-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  writeFileSync(join(dir, "notes.txt"), "one line\n");
  return dir;
}

type Fake = ReviewerDriver & { starts: { web: boolean }[] };

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
      driver.starts.push({ web: opts.web });
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds a notes file.", findings: [], dropped: [] });
          const read = { tool: "Read", input: { file_path: "notes.txt" }, ok: true, read: { path: "notes.txt", start: 1, lines: 1 } };
          return { finalText, calls: [read, ...calls], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "fake", failure: null };
        },
        async close() {},
      };
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

function userConfig(text: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), text);
}

function review(drivers: ReviewerDriver[], reviewer?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", repo(), "--no-color", "--format", "json"], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", reviewer, timeoutMs: 60_000, drivers });
}

describe("choosing the reviewer", () => {
  it("1. auto passes by Cursor, which is not enabled, and starts Claude Code", async () => {
    const claude = fake();
    expect(await review([cursorDriver, claude])).toBe(0);
    expect(claude.starts).toHaveLength(1);
    expect((JSON.parse(out) as Report).completion?.reviewer?.driver).toBe("claude");
  });

  it("8. auto inside Claude Code picks Claude Code, with Codex available too", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    const codex = fake([], "codex");
    const claude = fake();
    expect(await review([codex, claude])).toBe(0);
    expect(claude.starts).toHaveLength(1);
    expect(codex.starts).toHaveLength(0);
  });

  it("9. auto with only Codex available picks Codex, and the report names it", async () => {
    const codex = fake([], "codex");
    expect(await review([fake([], "claude", false), codex])).toBe(0);
    expect(codex.starts).toHaveLength(1);
    const completion = (JSON.parse(out) as Report).completion;
    expect(completion?.reviewer?.driver).toBe("codex");
    expect(completion?.trace_complete).toBe(false);
  });

  it("10. auto inside a Codex session picks Codex before Claude Code", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "00000000-0000-0000-0000-000000000001");
    const codex = fake([], "codex");
    const claude = fake();
    expect(await review([claude, codex])).toBe(0);
    expect(codex.starts).toHaveLength(1);
    expect(claude.starts).toHaveLength(0);
  });

  it("13. auto inside a Cursor session tries Cursor first, so its reason is the first one named", async () => {
    vi.stubEnv("CURSOR_AGENT", "1");
    expect(await review([fake([], "claude", false), cursorDriver])).toBe(2);
    const reasons = err.split("\n").filter((l) => l.startsWith("- "));
    expect(reasons[0]).toMatch(/^- cursor: not enabled/);
    expect(reasons[1]).toMatch(/^- claude: /);
  });

  it("3. the config's reviewer: key picks the driver", async () => {
    userConfig("reviewer: cursor\n");
    const claude = fake();
    expect(await review([codexDriver, cursorDriver, claude])).toBe(2);
    expect(claude.starts).toHaveLength(0);
    expect(err).toMatch(/cursor: not enabled/);
  });

  it("4. --reviewer wins over the config", async () => {
    userConfig("reviewer: codex\n");
    const claude = fake();
    expect(await review([codexDriver, claude], "claude")).toBe(0);
    expect(claude.starts).toHaveLength(1);
  });

  it("7. a reviewer: or reviewer_web: value openqodex does not know stops the run and names the file", async () => {
    userConfig("reviewer: gemini\n");
    await expect(review([fake()])).rejects.toThrow(/config\.yaml.*reviewer/);
    userConfig("reviewer_web: sometimes\n");
    await expect(review([fake()])).rejects.toThrow(/config\.yaml.*reviewer_web/);
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
    expect(DEFAULT_REVIEWER_WEB).toBe("on");
    const claude = fake();
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: true }]);
    const args = claudeArgs(true);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,WebSearch,WebFetch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
  });

  it("5. reviewer_web: off starts the reviewer without web tools, and the Claude Code command line names none", async () => {
    userConfig("reviewer_web: off\n");
    const claude = fake();
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: false }]);
    const args = claudeArgs(false);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args.join(" ")).not.toMatch(/WebSearch|WebFetch/);
  });

  it("6. with web on, a run that uses WebSearch completes", async () => {
    const web = [{ tool: "WebSearch", input: { query: "flask pagination" }, ok: true, read: null }];
    const claude = fake(web);
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: true }]);
    expect((JSON.parse(out) as Report).completion?.status).toBe("complete");
  });

  it("12, R26. --reviewer-web off wins over reviewer_web: on in a user config written as a flow mapping, and the file stays as it was", async () => {
    const text = "{reviewer: auto, reviewer_web: on}\n";
    userConfig(text);
    const claude = fake();
    const { global } = parseFlags(["--cwd", repo(), "--no-color", "--format", "json"], {});
    expect(await runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", timeoutMs: 60_000, drivers: [claude], web: false })).toBe(0);
    expect(claude.starts).toEqual([{ web: false }]);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(text);
    // Without the flag the same file turns the web tools on.
    const own = fake();
    expect(await review([own])).toBe(0);
    expect(own.starts).toEqual([{ web: true }]);
  });

  it("5. with reviewer_web: off, a web tool call makes the run incomplete", async () => {
    userConfig("reviewer_web: off\n");
    const web = [{ tool: "WebFetch", input: { url: "https://example.com", prompt: "read" }, ok: true, read: null }];
    expect(await review([fake(web)])).toBe(2);
    expect((JSON.parse(out) as Report).completion?.missing.join("\n")).toContain("WebFetch");
  });
});
