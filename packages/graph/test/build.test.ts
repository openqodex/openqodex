// Ways the build, the cache and the impact walk could fail, each checked
// below on a real repo in a temp folder:
// 1. A name defined in many files binds a call that has no evidence (the hub
//    rule), or a name defined in few files never binds as a lead.
// 2. A symbol with hundreds of callers floods the brief instead of listing
//    the 20 nearest, production code first, with the total.
// 3. The time budget does not stop the build, the result does not say it is
//    partial, or a pending timer keeps the process alive after the build.
// 4. A second build parses files that did not change.
// 5. A corrupt facts file crashes the build or is never rewritten.
// 6. Facts of a deleted file stay in the graph, or stay in the store after
//    no kept build names them.
// 8. A graph folder that cannot be used fails the build.
// 9. A named pipe in place of a facts file blocks the build forever.
// 7. A function the change removes is not reported, or its surviving
//    callers are lost because the old side is not parsed.
// 10. A deeply nested file takes time and memory that grow with the square
//     of its depth (each call kept a copy of every scope around it).
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, openStore, renderImpactBlock } from "../src/index.js";
import { at, callSites, commitAll, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";
import { cpuMs, expectLinear, growthTests } from "../src/test-timing.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const home = makeHome();
function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  return root;
}
async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

describe("hub names", () => {
  // Ruby is the one family where a call with no evidence may bind, as a lead.
  function rubyRepo(definers: number): Record<string, string> {
    const files: Record<string, string> = {
      "lib/helper.rb": "def helper\n  1\nend\n",
      "bin/run.rb": "helper() # CALL\n",
    };
    for (let i = 1; i < definers; i++) files[`lib/c${i}.rb`] = `class C${i}\n  def helper\n    ${i}\n  end\nend\n`;
    return files;
  }

  // The first build also writes to a cache path that cannot exist (failure 8).
  it("binds a bare Ruby call as likely when its name is defined in few files, and never when it is defined in more than 8", async () => {
    const few = rubyRepo(2);
    const g1 = await buildGraph({ repoRoot: repo(few), store: null });
    const edge = g1.in.get(symbol(g1, "lib/helper.rb", "helper"))?.[0];
    expect(callSites(g1, symbol(g1, "lib/helper.rb", "helper"))).toEqual([at(few, "bin/run.rb", "CALL")]);
    expect(edge?.tier).toBe("likely");

    const many = rubyRepo(9);
    const g2 = await buildGraph({ repoRoot: repo(many), store: null });
    expect(callSites(g2, symbol(g2, "lib/helper.rb", "helper"))).toEqual([]);
  });

  it("lists the 20 nearest production callers of a symbol with more than 40, and the total", async () => {
    const files: Record<string, string> = { "src/core.ts": "export function core(): number {\n  return 1;\n}\n" };
    for (let i = 0; i < 30; i++) files[`src/deep/p${i}.ts`] = `import { core } from "../core.js";\nexport function p${i}() {\n  return core();\n}\n`;
    for (let i = 0; i < 10; i++) files[`src/n${i}.ts`] = `import { core } from "./core.js";\nexport function n${i}() {\n  return core();\n}\n`;
    for (let i = 0; i < 5; i++) files[`src/n${i}.test.ts`] = `import { core } from "./core.js";\nexport function t${i}() {\n  return core();\n}\n`;
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "src/core.ts": "export function core(): number {\n  return 2;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths });
    const impact = detectImpact(g, change);
    expect(impact.hubs).toEqual([{ symbol: symbol(g, "src/core.ts", "core"), callers: 45, sites: 45, files: 45 }]);
    const shown = impact.callers.map((p) => p.edges[0].sites[0]?.file);
    expect(shown).toHaveLength(20);
    // The ten in the same folder first, then the deeper ones; no test file.
    expect(shown.slice(0, 10).every((f) => /^src\/n\d\.ts$/.test(f ?? ""))).toBe(true);
    expect(shown.some((f) => f?.includes(".test."))).toBe(false);
    expect(impact.risk).toBe("high");
  });
});

describe("budget", () => {
  it("stops reading past the budget, says the graph is partial with the counts, and leaves no timer behind", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`src/f${i}.ts`] = `export function f${i}() {\n  return ${i};\n}\n`;
    const root = repo(files);
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const g = await buildGraph({ repoRoot: root, store: null, budgetMs: 1 });
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(g.status.status).toBe("partial");
    expect(g.status.filesParsed).toBeLessThan(400);
    expect(g.status.filesParsed + g.status.filesSkipped).toBe(400);
    expect(g.status.reasons[0]).toMatch(/budget ran out with [\d,]+ files not read/);
    expect(g.status.cuts.find((c) => c.by === "budget")?.exact).toBe(true);
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);

    const block = renderImpactBlock(detectImpact(g, { files: [], coverage: new Map() }));
    expect(block).toMatch(/\nThe graph is partial: the 0\.001 s budget ran out/);
  });

  const n = 20_000;
  const nested = (depth: number) => repo({ "deep.ts": `export function f() {}\n${"{ f(); ".repeat(depth)}${"}".repeat(depth)}\n` });
  it("reads 20,000 nested blocks, leaving calls past the depth bound unresolved (10)", async () => {
    const g = await buildGraph({ repoRoot: nested(n), store: null, budgetMs: 60_000 });
    const bound = g.edges.reduce((k, e) => k + e.sites.length, 0);
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThan(n);
    expect(bound + g.status.unresolvedSites).toBe(n);
  }, 120_000);

  growthTests("in time that grows with the depth", () => {
    it("reads 20,000 nested blocks in time that grows with the depth (10)", async () => {
      const quarter = nested(n / 4);
      const root = nested(n);
      const small = await cpuMs(() => buildGraph({ repoRoot: quarter, store: null, budgetMs: 60_000 }));
      const large = await cpuMs(() => buildGraph({ repoRoot: root, store: null, budgetMs: 60_000 }));
      expectLinear("a build of 5,000 and of 20,000 nested blocks", small, large);
    }, 120_000);
  });

  it("caps the number of parses and parses the changed files first", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`src/f${String(i).padStart(2, "0")}.ts`] = `export function f${i}() {}\n`;
    const root = repo(files);
    const g = await buildGraph({ repoRoot: root, store: null, maxFiles: 5, files: ["src/f19.ts"] });
    expect(g.status.filesParsed).toBe(5);
    expect(g.status.reasons[0]).toBe("the 5 parses cap left out 15 files; run `openqodex graph build` once to complete it");
    expect(g.defsByFile.has("src/f19.ts")).toBe(true);
  });
});

describe("cache", () => {
  const files: Record<string, string> = {
    "a.py": "def a():\n    return b()\n\ndef b():\n    return 1\n",
    "c.py": "from a import a\n\ndef c():\n    return a()\n",
    "d.go": "package main\n\nfunc main() { helper() }\n\nfunc helper() {}\n",
  };
  const factsFiles = (root: string): string[] => {
    const dir = join(root, ".openqodex", "graph", "facts");
    return readdirSync(dir).flatMap((sub) => readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")).map((f) => join(dir, sub, f)));
  };

  it("parses nothing that did not change, rewrites a corrupt entry, and drops the facts of a deleted file once no kept build names them", async () => {
    const root = repo(files);
    const store = await storeOf(root);
    const first = await buildGraph({ repoRoot: root, store });
    expect(first.status.parses).toBe(3);

    const warm = await buildGraph({ repoRoot: root, store });
    expect(warm.status.parses).toBe(0);
    expect(warm.status.cacheHits).toBe(3);
    expect(callSites(warm, symbol(warm, "a.py", "a"))).toEqual(["c.py:4"]);

    writeFiles(root, { "c.py": "from a import a\n\ndef c():\n    x = 1\n    return a()\n" });
    const edited = await buildGraph({ repoRoot: root, store });
    expect(edited.status.parses).toBe(1);
    expect(callSites(edited, symbol(edited, "a.py", "a"))).toEqual(["c.py:5"]);

    // Every facts file corrupt: each one the build needs is parsed again and rewritten.
    for (const f of factsFiles(root)) writeFileSync(f, "{not json");
    const repaired = await buildGraph({ repoRoot: root, store });
    expect(repaired.status.parses).toBe(3);
    expect(callSites(repaired, symbol(repaired, "a.py", "a"))).toEqual(["c.py:5"]);
    expect(factsFiles(root).filter((f) => { try { JSON.parse(readFileSync(f, "utf8")); return true; } catch { return false; } })).toHaveLength(3);

    unlinkSync(join(root, "d.go"));
    const after = await buildGraph({ repoRoot: root, store });
    expect(after.nodes.has("d.go")).toBe(false);
    // Kept builds still name d.go's facts. Two later builds of other content
    // age those builds out; facts written in the last hour are protected, so
    // they are made older first.
    for (const edit of ["x = 1", "x = 2"]) {
      writeFiles(root, { "a.py": `def a():\n    return b()\n\ndef b():\n    ${edit}\n    return 1\n` });
      await buildGraph({ repoRoot: root, store });
    }
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const f of factsFiles(root)) utimesSync(f, old, old);
    const before = factsFiles(root).length;
    writeFiles(root, { "a.py": "def a():\n    return b()\n\ndef b():\n    return 3\n" });
    await buildGraph({ repoRoot: root, store });
    // Left: the two kept builds' a.py and their one c.py. The facts of d.go
    // and of the older versions are gone.
    expect(factsFiles(root).length).toBeLessThan(before);
    expect(factsFiles(root).length).toBe(3);
  });

  it("builds without saving anything when the graph folder cannot be used (8)", async () => {
    const root = repo(files);
    writeFileSync(join(root, ".openqodex"), "a file where the folder would be\n");
    const opened = await openStore(root, { home });
    expect(opened.ok).toBe(false);
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.status.filesParsed).toBe(3);
    expect(g.status.generation).toBeNull();
  });

  // A blocked open would freeze this process, so the build runs in a child
  // with a 20 second limit, from the built package.
  it("never blocks on a named pipe in place of a facts file", async () => {
    const root = repo(files);
    const store = await storeOf(root);
    await buildGraph({ repoRoot: root, store });
    const entry = factsFiles(root)[0] as string;
    unlinkSync(entry);
    execFileSync("mkfifo", [entry]);
    const built = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js")).href;
    const script = `const { buildGraph, openStore } = await import(${JSON.stringify(built)}); const s = await openStore(${JSON.stringify(root)}, { home: ${JSON.stringify(home)} }); const g = await buildGraph({ repoRoot: ${JSON.stringify(root)}, store: s.ok ? s.store : null }); process.stdout.write(String(g.status.parses));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("1");
  });
});

describe("removed symbols", () => {
  const files: Record<string, string> = {
    "src/a.ts": "export function gone(): number {\n  return 1;\n}\n\nexport function kept(): number {\n  return 2;\n}\n",
    "src/b.ts": 'import { gone, kept } from "./a.js";\n\nexport function user() {\n  gone(); // GONE\n  return kept(); // KEPT\n}\n',
  };

  it("lists a function the change removed with the call sites that still call it", async () => {
    const root = repo(files);
    commitAll(root);
    writeFiles(root, { "src/a.ts": "export function kept(): number {\n  return 3;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const removed = impact.symbols.filter((s) => impact.removed.includes(s.id));
    expect(removed.map((s) => [s.name, s.snapshot, s.startLine])).toEqual([["gone", "base", 1]]);
    const sites = impact.callers.filter((p) => p.seed === removed[0]?.id).flatMap((p) => p.edges[0].sites.map((s) => `${s.file}:${s.line}`));
    expect(sites).toEqual([at(files, "src/b.ts", "GONE")]);
    expect(impact.risk).toBe("high");
    expect(renderImpactBlock(impact)).toContain("`gone` (function), still called from 1 site");
  });

  it("lists every symbol of a deleted file with its surviving callers, without the file on disk", async () => {
    const root = repo(files);
    commitAll(root);
    unlinkSync(join(root, "src/a.ts"));
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const names = impact.symbols.filter((s) => impact.removed.includes(s.id)).map((s) => s.name);
    expect(names.sort()).toEqual(["gone", "kept"]);
    const sites = impact.callers.flatMap((p) => p.edges[0].sites.map((s) => `${s.file}:${s.line}`)).sort();
    expect(sites).toEqual([at(files, "src/b.ts", "GONE"), at(files, "src/b.ts", "KEPT")].sort());
  });
});
