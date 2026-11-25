// 1. The scan pipeline leaks spilled patches after the caller returns.
// 2. Hook identity checks build and retain diff payloads.
// 3. A stopped review leaves a patch behind before its finally block runs.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { cleanupDiffs, DEFAULT_CONFIG, getChange, getTreeChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { runReviewCore } from "@openqodex/review";
import type { ReviewerDriver } from "@openqodex/review";
import { parseFlags } from "../src/flags.js";
import { runPipeline } from "../src/pipeline.js";
import { laptopParts } from "../src/review-run.js";
import { git } from "../../review/test/repos.js";
import { adoptTempDir, removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";
function repo() {
  const dir = tempDir("oq-diff-cleanup-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "small.txt"), "before\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "large.txt"), "line contents\n".repeat(480_000));
  return { dir, base };
}
function own(c: Change) {
  for (const d of c.diffs ?? []) if (d.file) adoptTempDir(dirname(dirname(dirname(d.file))));
}

it("1. the scan pipeline removes every spilled patch before returning", async () => {
  const { dir } = repo();
  const { global } = parseFlags(["--cwd", dir, "--no-install", "--quiet"], {});
  const p = await runPipeline({ flags: global, scope: {}, only: [] });
  own(p.change);
  try {
    expect(p.change.diffs!.some((d) => d.file)).toBe(true);
    for (const entry of p.change.diffs ?? []) if (entry.file) expect(existsSync(entry.file)).toBe(false);
  } finally { cleanupDiffs(p.change); }
});

it("2. hook identity mode matches normal ids without producing patch text or files", async () => {
  const { dir, base } = repo();
  const root = tempDir("oq-hook-diffs-");
  const full = await getChange({ repoRoot: dir, scope: {}, exclude: [], tempRoot: root });
  try {
    const id = await getChange({ repoRoot: dir, scope: {}, exclude: [], tempRoot: root, idOnly: true });
    own(id);
    try {
      expect(id.id).toBe(full.id);
      expect(id.diff).toBe("");
      expect(id.diffs).toEqual([]);
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "Head");
      const head = git(dir, "rev-parse", "HEAD");
      const tree = await getTreeChange({ repoRoot: dir, baseRef: "HEAD", baseSha: base, headSha: head, exclude: [], tempRoot: root, idOnly: true });
      own(tree);
      try { expect(tree.id).toBe(full.id); expect(tree.diffs).toEqual([]); }
      finally { cleanupDiffs(tree); }
    } finally { cleanupDiffs(id); }
  } finally { cleanupDiffs(full); }
  expect(readdirSync(root)).toEqual([]);
});

it("3. onStop removes spilled patches synchronously while a reviewer is active", async () => {
  const { dir } = repo();
  const home = tempDir("oq-stop-home-");
  vi.stubEnv("OPENQODEX_HOME", home);
  const { global } = parseFlags(["--cwd", dir, "--no-install", "--quiet"], {});
  let stop!: () => void;
  let change!: Change;
  const driver: ReviewerDriver = {
    name: "claude", traced: true, detect: async () => ({ ok: true, version: "test", bin: "/stand-in" }),
    start: () => ({ pid: 1, close: async () => {}, send: async () => {
      const files = (change.diffs ?? []).flatMap((d) => d.file ? [d.file] : []);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every(existsSync)).toBe(true);
      stop();
      expect(files.some(existsSync)).toBe(false);
      return { finalText: "", calls: [], usage: { turns: 1, input_tokens: 0, output_tokens: 0, cost_usd: null }, sessionId: null, failure: "stopped" };
    } }),
  };
  const config = { ...structuredClone(DEFAULT_CONFIG), stages: false };
  const parts = laptopParts({ flags: global, scope: {}, noGraph: true, timeoutMs: 30_000, drivers: [driver] }, dir, config);
  try {
    await runReviewCore({ repoRoot: dir, config, scope: {}, only: [], noGraph: true, reviewer: "auto", web: false, timeoutMs: 30_000, runtimeVersion: "test" }, { ...parts, onStop: (f) => { stop = f; }, onEvent: (e) => { if (e.type === "prepared") { change = e.change; own(change); } } }).catch((error: unknown) => {
      if (!(error instanceof Error) || !/ENOENT/.test(error.message)) throw error;
    });
    for (const d of change.diffs ?? []) if (d.file) expect(existsSync(d.file)).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});
