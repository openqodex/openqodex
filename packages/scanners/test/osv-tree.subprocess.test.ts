// Failure cases: a rejected changed lockfile loses a valid tree's findings;
// a tree failure loses completed chunks, hides an error, or fails changed findings.
//
// Every case runs the real osv-scanner on a fixed advisory database, never on
// osv.dev: live advisories are withdrawn and merged upstream, and a count read
// from them moved with no change here (issue 293). osv-scanner's own offline
// mode (--offline-vulnerabilities) reads the database from
// $OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY/osv-scalibr/npm/all.zip. The database
// is fixtures/osv-db/npm.json, two lodash advisories that both affect 4.17.15,
// zipped at the start of the file. The adapter's command line is unchanged:
// a two-line script before the binary adds the one flag after `scan source`.
// That nothing but osv.dev is opened in the adapter's own mode stays with
// adapters.subprocess.test.ts.
import { makeLineSet } from "../../../tests/line-set.mjs";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseConfig, scanReport } from "@openqodex/core";
import type { ResolvedTool, ToolResolution } from "@openqodex/core";
import { createToolResolver } from "@openqodex/scanners";
import { makeChange } from "../../core/src/test-fixtures.js";
import { runOsvScanner } from "../src/adapters/osv-scanner.js";
import { runScanners } from "../src/run.js";
import { ARG_BUDGET_BYTES } from "../src/exec.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// CRC-32 of the stored zip entry. node:zlib has crc32 only from Node 22.2,
// and the package allows Node 22.0.
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

afterAll(removeTempDirs);

// The osv-scanner version the toolchain table pins, as the scan row reports it.
const PINNED = (JSON.parse(readFileSync(new URL("../toolchain.json", import.meta.url), "utf8")) as { tools: { "osv-scanner": { version: string } } }).tools["osv-scanner"].version;

// The two advisories of the fixed database, both on lodash 4.17.15.
const ADVISORIES = ["GHSA-35jh-r3h4-6jhm", "GHSA-p6mc-m468-83gw"];

// A zip archive of `files`, stored without compression: the format
// osv-scanner reads its offline database in.
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let offlineTool: (tool: ResolvedTool) => ResolvedTool = () => { throw new Error("the fixed advisory database is not set up"); };
beforeAll(() => {
  const advisories = JSON.parse(readFileSync(new URL("./fixtures/osv-db/npm.json", import.meta.url), "utf8")) as { id: string }[];
  const db = tempDir("oq-osv-db-");
  mkdirSync(join(db, "osv-scalibr", "npm"), { recursive: true });
  writeFileSync(join(db, "osv-scalibr", "npm", "all.zip"), storedZip(Object.fromEntries(advisories.map((a) => [`${a.id}.json`, JSON.stringify(a)]))));
  const bin = tempDir("oq-osv-bin-");
  offlineTool = (tool) => {
    const script = join(bin, "osv-scanner");
    // The flag goes after `scan source`, the only command line the adapter
    // writes; any other line fails loudly (97) instead of going online.
    if (tool.path.includes("'")) throw new Error(`the osv-scanner path holds a single quote: ${tool.path}`);
    writeFileSync(script, `#!/bin/sh\n[ "$1" = scan ] && [ "$2" = source ] || exit 97\nshift 2\nexec '${tool.path}' scan source --offline-vulnerabilities "$@"\n`);
    chmodSync(script, 0o755);
    return { ...tool, path: script, env: { ...tool.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db } };
  };
});
const installed = createToolResolver({ allowInstall: false, installBudgetMs: null });
// The installed osv-scanner, reading the fixed database.
const installedOnly = () => async (name: Parameters<typeof installed>[0]): Promise<ToolResolution> => {
  const resolved = await installed(name);
  return resolved.ok && name === "osv-scanner" ? { ok: true, tool: offlineTool(resolved.tool) } : resolved;
};
const lock = JSON.stringify({ name: "tiny", lockfileVersion: 3, packages: { "": { name: "tiny" }, "node_modules/lodash": { version: "4.17.15" } } });
const rejected = "broken/package-lock.json";
function plant() {
  const repoDir = tempDir("oq-osv-failures-");
  writeFileSync(join(repoDir, "package-lock.json"), lock);
  mkdirSync(join(repoDir, "broken"));
  writeFileSync(join(repoDir, rejected), "{bad json");
  return repoDir;
}

it("keeps tree advisories beside a rejected changed lockfile in the real adapter and report input", async () => {
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

it("keeps the pre-change scan without inventory when coverage misses advisories", async () => {
  // Line 1 misses the resolved lodash entry and must drop its advisories:
  // both advisories of the fixed database stop at the changed-lines stage.
  const repoDir = plant();
  writeFileSync(join(repoDir, "package-lock.json"), JSON.stringify(JSON.parse(lock), null, 2));
  const { scan } = await runScanners({ repoDir, changedPaths: ["package-lock.json"], coverage: new Map([["package-lock.json", makeLineSet([1])]]), config: parseConfig("").config, resolveTool: installedOnly(), only: ["osv-scanner"] });
  expect(scan.trail).toEqual(ADVISORIES.map((id) => ({ token: `osv-scanner:${id}`, file: "package-lock.json", lineStart: 8, lineEnd: 9, severity: "high", stage: "changed-lines" })));
  expect(scan).not.toHaveProperty("outside");
  const { durationMs: _duration, resolveMs: _resolve, ...row } = scan.scanners[0]!;
  expect(row).toEqual({ scanner: "osv-scanner", status: "ran", version: PINNED, rawCount: 2, keptCount: 0, files: 1, reason: null, stages: { changedLines: 2, fixtures: 0, rules: 0, merged: 0 } });
  expect(scan.candidates).toEqual([]);
});

it("keeps changed-lockfile candidates when inventory discovery throws", async () => {
  const { scan } = await runScanners({ repoDir: plant(), changedPaths: ["package-lock.json"], coverage: new Map([["package-lock.json", makeLineSet([1])]]), config: parseConfig("").config, resolveTool: installedOnly(), only: ["osv-scanner"],
    inventory: async () => { throw new Error("git ls-files failed: inventory unavailable"); } });
  expect(scan.scanners[0]).toMatchObject({ status: "ran", reason: expect.stringContaining("Repository lockfiles: git ls-files failed: inventory unavailable") });
  expect(scan.candidates).toContainEqual(expect.objectContaining({ ruleId: "GHSA-35jh-r3h4-6jhm" }));
});

it.each([false, true])("keeps completed tree chunks when a later chunk fails, changed lockfile: %s", async (hasChanged) => {
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
