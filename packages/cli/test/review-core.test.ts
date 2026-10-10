// The review core (`runReviewCore` in @openqodex/review) run with the
// laptop's own parts, as `review` passes them: the snapshot maker of
// checkout.ts, the real tool resolver with installs off and the owners'
// instructions reader. The reviewer is the one stand-in: a model provider
// driver that answers with a recorded submission. The run folder, the
// receipts, the signal handlers and every printed line are the CLI's work,
// done from what the core hands back; the core does none of it by itself.
//
// Ways it could fail, written before the code:
//  1. The core creates or writes something under .openqodex/ in the
//     repository (the team files, a run folder, latest.json).
//  2. The core writes in the openqodex home by itself (a receipt, a
//     last-review record), or leaves behind the snapshot it made through
//     the snapshot maker.
//  3. The core registers a SIGINT or SIGTERM handler, which in a host
//     process would call process.exit.
//  4. The core writes process.env.
//  5. The core prints to stdout or stderr instead of handing every line to
//     the progress callback.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "@openqodex/core";
import { DEPTH_ENV, runReviewCore } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { parseFlags } from "../src/flags.js";
import { laptopParts } from "../src/review-run.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// One commit, then an uncommitted SQL function: one sqllint candidate.
function repo(): string {
  const dir = tempDir("oq-core-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  mkdirSync(join(dir, "db"));
  writeFileSync(join(dir, "db/x.sql"), "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n");
  return dir;
}

// What the run looked like while the reviewer worked.
type During = { sigint: number; sigterm: number; env: Record<string, string | undefined>; checkouts: number };

// The model provider stand-in: reads the file, drops every candidate, and
// notes the process state at the moment the review is under way.
function standIn(home: string, during: During[]): ReviewerDriver {
  return {
    name: "claude",
    traced: true,
    detect: async () => ({ ok: true, version: "9.9.9", bin: "/fake/claude" }),
    start(): ReviewerSession {
      let brief: string | null = null;
      return {
        pid: 1,
        async send(text: string): Promise<Turn> {
          during.push({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM"), env: { ...process.env }, checkouts: readdirSync(join(home, "checkouts")).length });
          brief ??= text;
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
          const candidates = [...new Set([...brief.matchAll(/^- (c\d+) \[/gm)].map((m) => m[1]))];
          const dropped = candidates.map((c) => ({ candidate: c, reason: "the function is internal and never exposed", file_path: "db/x.sql", line_number: 1 }));
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds an SQL function.", findings: [], dropped });
          return { finalText, calls: [{ tool: "Read", input: { file_path: "db/x.sql" }, ok: true, read: { path: "db/x.sql", start: 1, lines: 2 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "s", failure: null };
        },
        async close() {},
      };
    },
  };
}

type Run = { repo: string; home: string; during: During[]; lines: string[]; ended: string };

// The core with the laptop's parts and `driver` as the only reviewer. Every
// line it hands over, and every stop it offers, is kept here.
async function runCore(dir: string, driver: ReviewerDriver): Promise<{ lines: string[]; ended: string }> {
  const { global } = parseFlags(["--cwd", dir, "--no-color", "--no-install", "--format", "json"], {});
  const config = structuredClone(DEFAULT_CONFIG);
  const parts = laptopParts({ flags: global, scope: {}, noGraph: true, timeoutMs: 60_000, drivers: [driver] }, dir, config);
  const lines: string[] = [];
  const stops: (() => void)[] = [];
  const result = await runReviewCore(
    { repoRoot: dir, config, scope: {}, only: ["sqllint"], noGraph: true, reviewer: "auto", web: false, timeoutMs: 60_000, runtimeVersion: "0.0.0-test" },
    { ...parts, onEvent: (e) => (e.type === "progress" || e.type === "warning" ? lines.push(e.line) : undefined), onStop: (stop) => stops.push(stop) },
  );
  expect(stops).toHaveLength(1);
  return { lines, ended: result.ended === "reviewed" && result.completion.status === "complete" ? "reviewed" : result.ended };
}

let written: string[] = [];
let home = "";
beforeEach(() => {
  written = [];
  home = tempDir("oq-core-home-");
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (written.push(`stdout: ${String(s)}`), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (written.push(`stderr: ${String(s)}`), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function review(): Promise<Run & { before: { sigint: number; sigterm: number; env: Record<string, string | undefined> } }> {
  const dir = repo();
  const during: During[] = [];
  const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM"), env: { ...process.env } };
  const { lines, ended } = await runCore(dir, standIn(home, during));
  return { repo: dir, home, during, lines, ended, before };
}

describe("the review core with the laptop's parts", () => {
  it("1. creates and writes nothing under .openqodex/ in the repository", async () => {
    const r = await review();
    expect(r.ended).toBe("reviewed");
    expect(existsSync(join(r.repo, ".openqodex"))).toBe(false);
  });

  it("2. writes nothing in the openqodex home itself, and the snapshot made through the maker is gone at the end", async () => {
    const r = await review();
    expect(r.ended).toBe("reviewed");
    // The snapshot was made, through the maker, while the reviewer worked.
    expect(r.during.map((d) => d.checkouts)).toEqual([1]);
    expect(readdirSync(join(r.home, "checkouts"))).toEqual([]);
    expect(readdirSync(r.home).sort()).toEqual(["checkouts"]);
  });

  it("3. registers no SIGINT or SIGTERM handler", async () => {
    const r = await review();
    expect(r.during).toHaveLength(1);
    expect(r.during[0]).toMatchObject({ sigint: r.before.sigint, sigterm: r.before.sigterm });
    expect(process.listenerCount("SIGINT")).toBe(r.before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(r.before.sigterm);
  });

  it("4. writes no process.env, while the review runs or after", async () => {
    const r = await review();
    expect(r.during).toHaveLength(1);
    expect(r.during[0]!.env).toEqual(r.before.env);
    expect({ ...process.env }).toEqual(r.before.env);
  });

  it("5. prints nothing: every line reaches the progress callback instead", async () => {
    const r = await review();
    expect(written).toEqual([]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^Scanners: 1 ran, \d+ had nothing to check, [1-9]\d* candidates? to check$/));
    expect(r.lines).toContain("Reviewer: claude 9.9.9 started (process 1); this takes one to three minutes");
  });
});
