// Failure cases: unused inventories are read, discovery errors escape the
// scanner guard; unreadable or budget-skipped lockfiles inherit a sibling's
// path; tree reads exceed the budget or stop changed-file reads; argument
// escaping leaks into the selected repository paths.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import { runScanners } from "../src/run.js";
import { repoInventory, selectScanners } from "../src/select.js";
import { readLockfileLines, parseOsvScannerJson } from "../src/adapters/osv-scanner.js";
import { overlapsCoverage } from "../src/filter.js";

const dirs: string[] = [];
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const config = parseConfig("").config;
const resolveTool = async () => { throw new Error("no external scanner should start"); };

it.each(["disabled", "skip", "only", "offline"])("does not discover inventory when the tree adapter is %s", async (mode) => {
  const repoDir = tempDir("oq-lazy-tree-");
  writeFileSync(join(repoDir, "readme.txt"), "edit\n");
  let calls = 0;
  const before = process.env.OPENQODEX_OFFLINE;
  if (mode === "offline") process.env.OPENQODEX_OFFLINE = "1";
  try {
    await runScanners({ repoDir, changedPaths: ["readme.txt"], config: { ...config, disabledScanners: mode === "disabled" ? ["osv-scanner"] : [] }, resolveTool,
      ...(mode === "skip" ? { skip: ["osv-scanner"] } : {}), only: mode === "only" ? ["sqllint"] : ["osv-scanner"],
      inventory: async () => { calls++; throw new Error("inventory should stay lazy"); } });
    expect(calls).toBe(0);
  } finally {
    if (before === undefined) delete process.env.OPENQODEX_OFFLINE;
    else process.env.OPENQODEX_OFFLINE = before;
  }
});

it("records a real git inventory failure on the tree adapter", async () => {
  const repoDir = tempDir("oq-inventory-failure-");
  const { scan } = await runScanners({ repoDir, changedPaths: [], config, resolveTool, only: ["osv-scanner"], inventory: () => repoInventory(repoDir, config) });
  expect(scan.scanners).toContainEqual(expect.objectContaining({ scanner: "osv-scanner", status: "failed", reason: expect.stringContaining("git ls-files failed") }));
});

const lock = '{\n  "lodash": "2.6.0"\n}\n';
function put(repoDir: string, rel: string, content = lock) {
  mkdirSync(dirname(join(repoDir, rel)), { recursive: true });
  writeFileSync(join(repoDir, rel), content);
}
function advisories(repoDir: string, paths: string[], lines: Map<string, string[]>) {
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/osv-lodash-2.6.0.json", import.meta.url), "utf8"));
  const json = JSON.stringify({ ...recorded, results: paths.map((rel) => ({ ...recorded.results[0], source: { path: join(repoDir, rel) } })) });
  return parseOsvScannerJson(json, lines, { repoDir, coverage: new Map([["package-lock.json", makeLineSet([2])]]) });
}

it("retains the identity of an oversized nested lockfile beside a changed root lockfile", async () => {
  const repoDir = tempDir("oq-unreadable-tree-");
  const nested = "service/package-lock.json";
  put(repoDir, "package-lock.json");
  put(repoDir, nested, lock.repeat(2));
  const lines = await readLockfileLines(repoDir, ["package-lock.json"], [nested], { fileBytes: Buffer.byteLength(lock) });
  expect([...lines.keys()]).toEqual(["package-lock.json", nested]);
  expect(lines.get(nested)).toEqual([]);
  const found = advisories(repoDir, ["package-lock.json", nested], lines);
  const nestedFindings = found.filter((f) => f.filePath === nested);
  expect(nestedFindings.length).toBeGreaterThan(0);
  expect(nestedFindings.every((f) => f.lineStart === 1 && f.lineEnd === 1)).toBe(true);
  const coverage = new Map([["package-lock.json", makeLineSet([2])]]);
  expect(found.filter((f) => overlapsCoverage(f, coverage)).every((f) => f.filePath === "package-lock.json")).toBe(true);
  expect(nestedFindings.some((f) => overlapsCoverage(f, coverage))).toBe(false);
});

it("stops tree line mapping at its text budget while always mapping changed lockfiles", async () => {
  const repoDir = tempDir("oq-tree-budget-");
  const paths = ["package-lock.json", "one/package-lock.json", "two/package-lock.json", "three/package-lock.json"];
  for (const rel of paths) put(repoDir, rel);
  const lines = await readLockfileLines(repoDir, [paths[0]], paths.slice(1), { treeBytes: Buffer.byteLength(lock) });
  expect([...lines.keys()]).toEqual(paths);
  expect(lines.get(paths[0])).toEqual(lock.split("\n"));
  expect(lines.get(paths[1])).toEqual(lock.split("\n"));
  for (const rel of paths.slice(2)) expect(lines.get(rel)).toEqual([]);
  const found = advisories(repoDir, paths, lines);
  for (const rel of paths.slice(2)) {
    expect(found).toContainEqual(expect.objectContaining({ filePath: rel, lineStart: 1, lineEnd: 1 }));
  }
  const noTree = await readLockfileLines(repoDir, [paths[0]], paths.slice(1), { treeBytes: 0 });
  expect(noTree.get(paths[0])).toEqual(lock.split("\n"));
  for (const rel of paths.slice(1)) expect(noTree.get(rel)).toEqual([]);
});

it("does not partly read a tree lockfile that exceeds the remaining budget", async () => {
  const repoDir = tempDir("oq-tree-budget-remainder-");
  const paths = ["one/package-lock.json", "two/package-lock.json", "three/package-lock.json"];
  for (const rel of paths) put(repoDir, rel);
  const lines = await readLockfileLines(repoDir, [], paths, { treeBytes: Buffer.byteLength(lock) + 1 });
  expect(lines.get(paths[0])).toEqual(lock.split("\n"));
  expect(lines.get(paths[1])).toEqual([]);
  expect(lines.get(paths[2])).toEqual([]);
});

it("keeps a leading-dash folder as a repository path in tree selection and parsed advisories", async () => {
  const repoDir = tempDir("oq-dash-tree-");
  const rel = "-deps/package-lock.json";
  put(repoDir, rel);
  const choice = selectScanners({ repoDir, paths: [], inventory: [rel], config }).find((c) => c.scanner === "osv-scanner")!;
  expect(choice.paths).toEqual([rel]);
  const lines = await readLockfileLines(repoDir, [], choice.paths);
  const found = advisories(repoDir, [rel], lines);
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((f) => choice.paths.includes(f.filePath))).toBe(true);
});
