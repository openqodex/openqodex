// Failure cases: a rejected changed lockfile loses a valid tree's findings;
// a tree failure loses completed chunks, hides an error, or fails changed findings.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseConfig, scanReport } from "@openqodex/core";
import { createToolResolver } from "@openqodex/scanners";
import { makeChange } from "../../core/src/test-fixtures.js";
import { runOsvScanner } from "../src/adapters/osv-scanner.js";
import { runScanners } from "../src/run.js";
import { ARG_BUDGET_BYTES } from "../src/exec.js";

const dirs: string[] = [];
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const installedOnly = () => createToolResolver({ allowInstall: false, installBudgetMs: null });
const lock = JSON.stringify({ name: "tiny", lockfileVersion: 3, packages: { "": { name: "tiny" }, "node_modules/lodash": { version: "4.17.15" } } });
const rejected = "broken/package-lock.json";
function plant() {
  const repoDir = tempDir("oq-osv-failures-");
  writeFileSync(join(repoDir, "package-lock.json"), lock);
  mkdirSync(join(repoDir, "broken"));
  writeFileSync(join(repoDir, rejected), "{bad json");
  return repoDir;
}

it.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")("keeps tree advisories beside a rejected changed lockfile in the real adapter and report input", async () => {
  const repoDir = plant();
  const resolveTool = installedOnly();
  const resolved = await resolveTool("osv-scanner");
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.reason);
  const args = { repoDir, changedPaths: [rejected], treePaths: ["package-lock.json"], tool: resolved.tool };
  const result = await runOsvScanner(args);
  expect(result.error).toMatch(/osv-scanner exit|parse:/);
  expect(result.findings).toContainEqual(expect.objectContaining({ filePath: "package-lock.json", ruleId: "GHSA-35jh-r3h4-6jhm" }));
  const { scan } = await runScanners({ ...args, inventory: [rejected, "package-lock.json"], config: parseConfig("").config, resolveTool, only: ["osv-scanner"] });
  expect(scan.scanners[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("extraction failed") });
  expect(scan.outside).toContainEqual(expect.objectContaining({ filePath: "package-lock.json", ruleId: "GHSA-35jh-r3h4-6jhm" }));
  const report = scanReport({ change: makeChange({ changedPaths: [rejected] }), scan, config: parseConfig("").config });
  expect(report.outside_change).toContainEqual(expect.objectContaining({ title: "GHSA-35jh-r3h4-6jhm" }));
});

it.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")("keeps the pre-change scan without inventory when coverage misses advisories", async () => {
  // Line 1 misses the resolved lodash entry and must drop its advisories.
  // osv-scanner reads live advisory data, so how many it reports moves when
  // an advisory is withdrawn or merged upstream (issue 293): the test holds
  // the planted advisory's path through the stages, never a count.
  const repoDir = plant();
  writeFileSync(join(repoDir, "package-lock.json"), JSON.stringify(JSON.parse(lock), null, 2));
  const { scan } = await runScanners({ repoDir, changedPaths: ["package-lock.json"], coverage: new Map([["package-lock.json", new Set([1])]]), config: parseConfig("").config, resolveTool: installedOnly(), only: ["osv-scanner"] });
  expect(scan.trail).toContainEqual(expect.objectContaining({ token: "osv-scanner:GHSA-35jh-r3h4-6jhm", stage: "changed-lines" }));
  expect(scan).not.toHaveProperty("outside");
  expect(scan.trail?.some((t) => t.stage === "shown")).toBe(false);
  expect(scan.scanners[0]?.stages).not.toHaveProperty("shown");
  expect(scan.scanners[0]).toMatchObject({ scanner: "osv-scanner", status: "ran", keptCount: 0 });
  expect(scan.scanners[0]?.rawCount).toBeGreaterThanOrEqual(1);
  expect(scan.candidates).toEqual([]);
});

it.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")("keeps changed-lockfile candidates when inventory discovery throws", async () => {
  const { scan } = await runScanners({ repoDir: plant(), changedPaths: ["package-lock.json"], coverage: new Map([["package-lock.json", new Set([1])]]), config: parseConfig("").config, resolveTool: installedOnly(), only: ["osv-scanner"],
    inventory: async () => { throw new Error("git ls-files failed: inventory unavailable"); } });
  expect(scan.scanners[0]).toMatchObject({ status: "ran", reason: expect.stringContaining("Repository lockfiles: git ls-files failed: inventory unavailable") });
  expect(scan.candidates).toContainEqual(expect.objectContaining({ ruleId: "GHSA-35jh-r3h4-6jhm" }));
});

it.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1").each([false, true])("keeps completed tree chunks when a later chunk fails, changed lockfile: %s", async (hasChanged) => {
  const repoDir = plant();
  const rel = [...Array.from({ length: 3 }, () => "p".repeat(200)), "package-lock.json"].join("/");
  mkdirSync(dirname(join(repoDir, rel)), { recursive: true });
  writeFileSync(join(repoDir, rel), lock);
  // Fill the first chunk with a real, long path. The rejected file is in
  // the next chunk, so findings can survive only through `completed`.
  const treePaths = [...Array.from({ length: Math.ceil(ARG_BUDGET_BYTES / (Buffer.byteLength(rel) + 1)) }, () => rel), rejected];
  const resolved = await installedOnly()("osv-scanner");
  if (!resolved.ok) throw new Error(resolved.reason);
  const result = await runOsvScanner({ repoDir, changedPaths: hasChanged ? ["package-lock.json"] : [], treePaths, tool: resolved.tool });
  expect(result.findings).toContainEqual(expect.objectContaining({ filePath: rel, ruleId: "GHSA-35jh-r3h4-6jhm" }));
  if (hasChanged) {
    expect(result.error).toBeNull();
    expect(result.note).toMatch(/^Repository lockfiles:/);
    expect(result.findings).toContainEqual(expect.objectContaining({ filePath: "package-lock.json" }));
  } else expect(result.error).toMatch(/^Repository lockfiles:/);
});
