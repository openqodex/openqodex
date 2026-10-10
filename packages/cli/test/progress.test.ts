// What `review` prints while it runs: stage lines on stderr, the report
// alone on stdout.
//
// Ways it could fail, written before the code:
//  1. Progress lines land on stdout and break --format json.
//  2. The scanner stage prints one line per scanner with raw finding counts
//     instead of one compact stage line.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { DEPTH_ENV } from "@openqodex/review";
import type { ReviewerDriver, ReviewerSession, Turn } from "@openqodex/review";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// The model provider stand-in: drops every candidate after reading the file.
const driver: ReviewerDriver = {
  name: "claude",
  traced: true,
  detect: async () => ({ ok: true, version: "9.9.9", bin: "/fake/claude" }),
  start(): ReviewerSession {
    return {
      pid: 1,
      async send(text: string): Promise<Turn> {
        const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
        const candidates = [...text.matchAll(/\b(c\d+)\b/g)].map((m) => m[1]);
        const dropped = [...new Set(candidates)].map((c) => ({ candidate: c, reason: "the function is internal and never exposed", evidence: { file_path: "db/x.sql", line_number: 1 } }));
        const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds an SQL function.", findings: [], dropped });
        return { finalText, calls: [{ tool: "Read", input: { file_path: "db/x.sql" }, ok: true, read: { path: "db/x.sql", start: 1, lines: 2 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "f", failure: null };
      },
      async close() {},
    };
  },
};

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.stubEnv("OPENQODEX_HOME", tempDir("oq-progress-home-"));
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("progress", () => {
  it("1, 2. one scanner stage line on stderr, no raw counts, and stdout holds the JSON report only", async () => {
    const dir = tempDir("oq-progress-");
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "Base");
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/x.sql"), "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n");
    const { global } = parseFlags(["--cwd", dir, "--no-color", "--format", "json", "--no-install"], {});
    await runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", timeoutMs: 60_000, drivers: [driver] });
    expect((JSON.parse(out) as Report).kind).toBe("review");
    expect(err).toMatch(/^Scanners: 1 ran, 0 had nothing to check, [1-9]\d* candidates? to check$/m);
    expect(err).not.toContain("raw finding");
    expect(err).not.toMatch(/^sqllint:/m);
  });
});
