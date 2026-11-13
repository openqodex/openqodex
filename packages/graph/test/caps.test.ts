// Every cap of a build holds on the quantity it names, at the point the
// resource is used, and a build that reaches one says so with the cause.
// Ways a cap could be passed, one test each, with an input just over it:
// 1. The parse cap: the changed files are parsed past it because they come
//    first.
// 2. The time budget: a changed file is admitted after it ran out.
// 3. The memory bound: a changed file is admitted past it, or the heap is
//    checked only every so many files.
// 4. The size cap: a file one byte over it is read, in the change or as
//    the base version of a changed file.
// 5. The graph folder's bound: facts written during a build pass it, since
//    the bound was enforced only when a build is published.
// 6. One file whose parse runs away (tree-sitter on an unclosed comment)
//    holds the build past every budget.
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, openStore } from "../src/index.js";
import { growthTests, LOOSE_BOUND_MS, onceOnCpu } from "../src/test-timing.js";
import { commitAll, makeHome, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const home = makeHome();
function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  return root;
}
const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${i}.ts`, `export function f${i}() {\n  return ${i};\n}\n`]));

function folderBytes(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderBytes(p) : statSync(p).size;
  }
  return total;
}

describe("the caps of a build", () => {
  it("parses no more than the parse cap, changed files included, and records the rest (1)", async () => {
    const root = repo(many(3));
    const g = await buildGraph({ repoRoot: root, store: null, maxFiles: 2, files: ["src/f0.ts", "src/f1.ts", "src/f2.ts"] });
    expect(g.status.parses).toBe(2);
    expect(g.status.notRead).toEqual([{ file: "src/f2.ts", reason: "parse-cap" }]);
    expect(g.status.cuts.find((c) => c.by === "parse-cap")).toMatchObject({ omitted: 1, exact: true });
  });

  it("admits no file, changed or not, once the budget has run out, and records each (2)", async () => {
    const root = repo(many(3));
    const g = await buildGraph({ repoRoot: root, store: null, budgetMs: 0, files: ["src/f0.ts"] });
    expect(g.status.filesParsed).toBe(0);
    expect(g.status.notRead.map((n) => n.reason)).toEqual(["budget", "budget", "budget"]);
    expect(g.status.status).toBe("partial");
  });

  it("admits no file past the memory bound, checked before each file, and records each (3)", async () => {
    const root = repo(many(3));
    const g = await buildGraph({ repoRoot: root, store: null, maxHeapMb: 1, files: ["src/f0.ts"] });
    expect(g.status.filesParsed).toBe(0);
    expect(g.status.notRead.map((n) => n.reason)).toEqual(["memory", "memory", "memory"]);
    expect(g.status.cuts.find((c) => c.by === "memory")).toMatchObject({ omitted: 3, exact: true });
  });

  it("reads no file one byte over the size cap, current or base, and records it (4)", async () => {
    const small = "export function a() {\n  return 1;\n}\n";
    const root = repo({ "a.ts": small, "b.ts": "export function b() {\n  return 1;\n}\n", "c.ts": "export function c() {\n  return 12;\n}\n" });
    commitAll(root);
    const cap = small.length;
    // b.ts: one byte over now. a.ts: its base version is at the cap, its new one one byte over.
    // c.ts: its base version one byte over, its new one under.
    writeFiles(root, { "b.ts": "export function b() {\n  return 12;\n}\n", "a.ts": "export function a() {\n  return 12;\n}\n", "c.ts": "export function c() {\n  return 3;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, maxFileBytes: cap, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    expect(g.status.notRead.filter((n) => n.reason === "size").map((n) => n.file).sort()).toEqual(["a.ts", "b.ts"]);
    expect(g.status.cuts.find((c) => c.by === "size")).toMatchObject({ omitted: 2, exact: true });
    expect(g.status.reasons).toContain("removed symbols were not checked in 1 changed file");
  });

  it("writes no facts past the graph folder's bound during a build, and records what it did not save (5)", async () => {
    const root = repo(many(400));
    const opened = await openStore(root, { home, maxCacheMb: 0.05 });
    if (!opened.ok) throw new Error(opened.reason);
    const g = await buildGraph({ repoRoot: root, store: opened.store });
    expect(g.status.filesParsed).toBe(400);
    expect(folderBytes(join(root, ".openqodex", "graph", "facts"))).toBeLessThanOrEqual(0.05 * 1024 * 1024);
    expect(g.status.cuts.find((c) => c.by === "storage")?.omitted).toBeGreaterThan(0);
    expect(g.status.reasons.join(" ")).toMatch(/bound/);
  });

  // The parser takes the square of this file's length (an unclosed comment
  // full of openers), so its time cannot grow linearly: the build stops it
  // at MAX_PARSE_MS and the whole build stays under the loose bound.
  const runaway = () => repo({ "slow.ts": `export function f() {\n  return 1; ${"/* x ".repeat(100_000)}\n}\n`, "ok.ts": "export function ok() {}\n" });
  const buildRunaway = (root: string) => buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 60_000 });
  it("stops one runaway parse at its time limit and records the file (6)", async () => {
    const g = await buildRunaway(runaway());
    expect(g.status.notRead).toEqual([{ file: "slow.ts", reason: "slow-parse" }]);
    expect(g.defsByFile.has("ok.ts")).toBe(true);
  });

  growthTests("under the loose bound", () => {
    it("stops one runaway parse with the whole build under the loose bound (6)", async () => {
      const root = runaway();
      const { cpuMs } = await onceOnCpu(() => buildRunaway(root));
      expect(cpuMs, `${cpuMs.toFixed(0)} ms of CPU time`).toBeLessThan(LOOSE_BOUND_MS);
    });
  });
});
