// A review whose snapshot cannot be removed at the end: something in it (a
// trusted custom scanner, here the model provider stand-in) left a folder
// that cannot be written, so removing the snapshot fails with EACCES. The
// review the run already did must not be lost to its cleanup.
//
// Ways it could fail, written before the code:
//  1. The cleanup runs before the report files, the receipts and the printed
//     report, so its failure leaves the run folder without a report and the
//     push hooks without a record.
//  2. On the unavailable path, the cleanup failure loses the status files
//     (unchecked-candidates.json, report.html) and the reasons on stderr.
//  3. The cleanup failure is swallowed: the run ends as if all went well.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPTH_ENV } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// One commit, then an uncommitted SQL function: one sqllint candidate.
function repo(): string {
  const dir = tempDir("oq-cleanup-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  mkdirSync(join(dir, "db"));
  writeFileSync(join(dir, "db/x.sql"), "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n");
  return dir;
}

// A folder holding a file, then made read-only: its file cannot be removed.
function plantReadOnly(snapshotDir: string): void {
  mkdirSync(join(snapshotDir, "locked"));
  writeFileSync(join(snapshotDir, "locked/kept.txt"), "kept\n");
  chmodSync(join(snapshotDir, "locked"), 0o555);
}

// The model provider stand-in: plants the folder while it reviews, then
// drops every candidate after reading the file.
const reviewer: ReviewerDriver = {
  name: "claude",
  traced: true,
  detect: async () => ({ ok: true, version: "9.9.9", bin: "/fake/claude" }),
  start({ snapshotDir }): ReviewerSession {
    let brief: string | null = null;
    return {
      pid: 1,
      async send(text: string): Promise<Turn> {
        brief ??= text;
        if (!existsSync(join(snapshotDir, "locked"))) plantReadOnly(snapshotDir);
        const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";
        const dropped = [...new Set([...brief.matchAll(/^- (c\d+) \[/gm)].map((m) => m[1]))].map((c) => ({ candidate: c, reason: "the function is internal and never exposed", file_path: "db/x.sql", line_number: 1 }));
        const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds an SQL function.", findings: [], dropped });
        return { finalText, calls: [{ tool: "Read", input: { file_path: "db/x.sql" }, ok: true, read: { path: "db/x.sql", start: 1, lines: 2 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "s", failure: null };
      },
      async close() {},
    };
  },
};

// A driver whose per-run boundary check plants the folder and refuses.
const refusing: ReviewerDriver = {
  ...reviewer,
  async check({ snapshotDir }) {
    plantReadOnly(snapshotDir);
    return "the boundary could not be shown";
  },
};

let out = "";
let err = "";
let home = "";
const homes: string[] = [];
beforeEach(() => {
  out = "";
  err = "";
  home = tempDir("oq-cleanup-home-");
  homes.push(home);
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
// The planted folders become writable again, so every temp folder goes.
afterAll(() => {
  for (const h of homes) if (existsSync(join(h, "checkouts"))) spawnSync("chmod", ["-R", "u+w", join(h, "checkouts")]);
  removeTempDirs();
});

function runFolder(dir: string): string {
  const runs = readdirSync(join(dir, ".openqodex/reviews"));
  expect(runs).toHaveLength(1);
  return join(dir, ".openqodex/reviews", runs[0]!);
}

describe("a snapshot the run cannot remove", () => {
  it("1, 3. the review's files, receipts and printed report are all there, and the cleanup failure still fails the run", async () => {
    const dir = repo();
    const { global } = parseFlags(["--cwd", dir, "--no-color", "--no-install", "--format", "json"], {});
    await expect(runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", timeoutMs: 60_000, drivers: [reviewer] })).rejects.toThrow(/EACCES|permission denied/i);
    const folder = runFolder(dir);
    for (const name of ["manifest.json", "scan.json", "brief.md", "impact.json", "report.md", "report.json", "report.sarif", "report.html", "submission.json", "trace.json"]) {
      expect(existsSync(join(folder, name)), name).toBe(true);
    }
    expect(existsSync(join(dir, ".openqodex/latest.json"))).toBe(true);
    const ids = readdirSync(join(home, "receipts"));
    expect(ids).toHaveLength(1);
    expect(readdirSync(join(home, "receipts", ids[0]!))).toContain("latest.json");
    expect(existsSync(join(home, "last-review", ids[0]!, "last-review.json"))).toBe(true);
    expect(JSON.parse(out)).toMatchObject({ kind: "review" });
  });

  it("2, 3. on the unavailable path the status files and the reasons are there, and the cleanup failure still fails the run", async () => {
    const dir = repo();
    const { global } = parseFlags(["--cwd", dir, "--no-color", "--no-install", "--format", "json"], {});
    await expect(runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", timeoutMs: 60_000, drivers: [refusing] })).rejects.toThrow(/EACCES|permission denied/i);
    const folder = runFolder(dir);
    expect(existsSync(join(folder, "unchecked-candidates.json"))).toBe(true);
    expect(existsSync(join(folder, "report.html"))).toBe(true);
    expect(err).toContain("Full review unavailable: openqodex could not start a reviewer.");
    expect(err).toContain("- claude: the boundary could not be shown");
  });
});
