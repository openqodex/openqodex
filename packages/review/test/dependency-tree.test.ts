// 3. An unsendable staged inventory falls back to an oversized single pass.
// Failure cases: scanChange tries git or scans beyond the supplied inventory;
// a server review reads the snapshot inventory with its tree scanner disabled.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createToolResolver } from "@openqodex/scanners";
import { makeChange, makeConfig } from "../../core/src/test-fixtures.js";
import { scanChange } from "../src/pipeline.js";
import { runReviewCore } from "../src/review-change.js";
import { serverScope } from "../src/scoped.js";
import { decideIncremental } from "../src/incremental.js";
const dirs: string[] = [];
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
it("scanChange honours a given inventory without calling git", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "oq-scoped-tree-")); dirs.push(workDir);
  writeFileSync(join(workDir, "package-lock.json"), "{}");
  writeFileSync(join(workDir, "admitted.txt"), "a harmless edit\n");
  const p = await scanChange({ repoRoot: join(workDir, "absent-clone"), workDir, inventory: ["admitted.txt"], change: makeChange({ changedPaths: ["admitted.txt"], coverage: new Map([["admitted.txt", new Set([1])]]) }), config: makeConfig(), host: { resolveTool: createToolResolver({ allowInstall: false, installBudgetMs: null }), onProgress: () => {} } });
  expect(p.scan?.selection?.find((s) => s.scanner === "osv-scanner")?.wanted).toBe(false);
  expect(p.scan?.scanners.find((s) => s.scanner === "osv-scanner")).toMatchObject({ status: "no_matching_files", reason: null });
  expect(p.scan?.outside ?? []).toEqual([]);
});

it("a server review never reads the inventory when osv-scanner is disabled", async () => {
  const dir = tempDir("oq-lazy-server-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "readme.txt"), "before\n");
  git("add", "."); git("commit", "-qm", "Base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "readme.txt"), "after\n");
  git("add", "."); git("commit", "-qm", "Edit");
  const repo = { dir, base, head: git("rev-parse", "HEAD") };
  const config = makeConfig({ disabledScanners: ["osv-scanner"] });
  const decision = await decideIncremental({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head });
  if (!decision.ok) throw new Error(decision.reason);
  const server = serverScope({ clonePath: repo.dir, workDir: tempDir("oq-lazy-server-"), exclude: [], decision });
  let calls = 0;
  const result = await runReviewCore(
    { repoRoot: repo.dir, config, scope: {}, target: repo.head, only: ["osv-scanner"], noGraph: true, reviewer: "auto", web: false, timeoutMs: 30_000, runtimeVersion: "0.0.0-test" },
    {
      drivers: [],
      snapshots: server.snapshots,
      scoped: { ...server.scoped, inventory: (tree) => { calls++; return server.scoped.inventory(tree); } },
      resolveTool: async () => { throw new Error("disabled scanners must not resolve tools"); },
      resolveTarget: async () => ({ headSha: repo.head, baseRef: "main", baseSource: "the host", baseSha: repo.base, mergeBase: repo.base, notes: [], release: async () => {} }),
      instructions: () => ({ text: "", hash: null }),
      onEvent: () => {},
      now: Date.now,
    },
  );
  expect(result.ended).toBe("unavailable");
  if (result.ended !== "unavailable") throw new Error(`review ended ${result.ended}`);
  expect(result.scan.scanners[0]).toMatchObject({ scanner: "osv-scanner", status: "disabled" });
  expect(calls).toBe(0);
});

it("does not send an oversized fixed-block brief when no staged entry fits", async () => {
  const dir = tempDir("oq-fixed-block-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "readme.txt"), "before\n");
  git("add", "."); git("commit", "-qm", "Base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "readme.txt"), "after\n");
  git("add", "."); git("commit", "-qm", "Edit");
  const head = git("rev-parse", "HEAD");
  const decision = await decideIncremental({ clonePath: dir, mergeBaseSha: base, headSha: head });
  if (!decision.ok) throw new Error(decision.reason);
  const server = serverScope({ clonePath: dir, workDir: tempDir("oq-fixed-block-work-"), exclude: [], decision });
  let calls = 0;
  const result = await runReviewCore(
    { repoRoot: dir, config: makeConfig({ stages: true }), scope: {}, target: head, only: ["osv-scanner"], noGraph: true, reviewer: "auto", web: false, timeoutMs: 30_000, runtimeVersion: "test" },
    {
      drivers: [], snapshots: server.snapshots, scoped: server.scoped,
      resolveTool: async () => { throw new Error("no matching scanner"); },
      resolveTarget: async () => ({ headSha: head, baseRef: "main", baseSource: "the host", baseSha: base, mergeBase: base, notes: [], release: async () => {} }),
      instructions: () => ({ text: "convention\n".repeat(30000), hash: null }),
      model: { reviewer: { kind: "model", model: "fixture", maxOutputTokens: 100, async complete() { calls++; throw new Error("oversized brief sent"); } } },
      onEvent: () => {}, now: Date.now,
    },
  );
  expect(calls).toBe(0);
  expect(result.ended).toBe("model-reviewed");
  if (result.ended !== "model-reviewed") throw new Error(result.ended);
  expect(result.evidence.coverage.unread).toContainEqual(expect.objectContaining({ path: "readme.txt", start: 1, end: 1 }));
  expect(result.report.notes?.join(" ")).toContain("MAX_BRIEF_BYTES");
});
