// What bounds the work of dispatch and of function values, and what keeps
// their answers honest. Ways it could fail, each on a real repo:
// 1. Interfaces that each extend every interface of the layer below make
//    a member lookup walk every path through the lattice (ten to the eighth
//    and more for ten layers of ten), so one call stalls the build.
// 2. A literal table of thousands of functions called by a computed key
//    from thousands of places makes a site per entry per call (sixteen
//    million for 4,000 of each), so one file stalls the build and its
//    memory.
// 3. The time budget is checked only between files, so one file that
//    holds such work runs past the budget with nothing recorded.
// 4. Escape analysis, which runs after every file is resolved, runs on
//    once the budget is spent, or stops with its escapes read as whole
//    (issue 420).
// 5. A caller list built from escapes the budget cut reads as whole, or
//    the index of such a graph does not read back, or reads back whole.
// 6. A budget that runs out during the last step of escape analysis, the
//    sum of member reads, goes unnoticed, so the pass reads as whole.
// 7. Each eval site of a file walks every definition and import of the
//    file again, so a file of many functions and many evals takes time
//    that grows with their product, unchecked by the budget in between.
// 8. The walk of `export *` for escape analysis opens file after file with
//    no check of the budget, so a build runs on past its deadline to the
//    end of the walk.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, floorReasons } from "../src/index.js";
import { discoverProjects } from "../src/discovery/projects.js";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { createWorld } from "../src/resolve.js";
import { readIndexFrom, writeIndex } from "../src/store/graph-files.js";
import { RepoReader } from "../src/safe-fs.js";
import type { FileFacts } from "../src/types.js";
import { cpuMs, expectLinear, growthTests } from "../src/test-timing.js";
import { makeRepo, symbol } from "./helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  return root;
}

// Ten layers of `width` interfaces; each interface of a layer extends every one of the layer below.
function lattice(width: number): string {
  const lines: string[] = [];
  for (let layer = 0; layer < 10; layer++) {
    for (let i = 0; i < width; i++) {
      const ext = layer === 0 ? "" : ` extends ${Array.from({ length: width }, (_, j) => `L${layer - 1}_${j}`).join(", ")}`;
      const member = layer === 0 && i === 0 ? " base(): number;" : "";
      lines.push(`export interface L${layer}_${i}${ext} {${member} }`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// 4,000 functions, a table of all of them, and 4,000 functions that call the table by a computed key.
function bigTable(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`function f${i}() { return ${i}; }`);
  out.push(`const handlers = { ${Array.from({ length: n }, (_, i) => `k${i}: f${i}`).join(", ")} };`);
  for (let i = 0; i < n; i++) out.push(`export function c${i}(k: string) { return handlers[k](); }`);
  return `${out.join("\n")}\n`;
}

describe("the limits of dispatch and function values", () => {
  const latticeRepo = (width: number) =>
    repo({
      "src/layers.ts": lattice(width),
      "src/use.ts": 'import type { L9_0 } from "./layers";\nexport function use(x: L9_0) {\n  return x.absent() + x.base();\n}\n',
    });
  const build = (at: string) => () => buildGraph({ repoRoot: at, store: null, budgetMs: 60_000 });
  const n = 4_000;

  growthTests("in linear time", () => {
    it("looks a member up through a lattice of interfaces in linear time (1)", async () => {
      // Five interfaces a layer are a quarter of the extends and 1/512 of the paths.
      expectLinear("a build of lattices five and ten interfaces wide", await cpuMs(build(latticeRepo(5))), await cpuMs(build(latticeRepo(10))));
    });

    it("builds a large table in time that grows with it (2)", async () => {
      expectLinear("a build of tables of 1,000 and of 4,000 functions", await cpuMs(build(repo({ "src/table.ts": bigTable(n / 4) }))), await cpuMs(build(repo({ "src/table.ts": bigTable(n) }))));
    });
  });

  it("looks a member up through a lattice of interfaces, absent or present (1)", async () => {
    const g = await build(latticeRepo(10))();
    const base = [...g.nodes.values()].find((n) => n.id.includes("#L0_0.base@"));
    expect(base).toBeDefined();
    expect((g.in.get(base?.id ?? "") ?? []).flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))).toEqual(["src/use.ts:3 certain"]);
  });

  it("keeps at most 32 entries of a large table per call and says how many it left out (2)", async () => {
    const g = await build(repo({ "src/table.ts": bigTable(n) }))();
    const sites = g.edges.filter((e) => e.kind === "may_invoke").reduce((k, e) => k + e.sites.length, 0);
    expect(sites).toBe(n * 32);
    const gaps = g.unknowns.filter((u) => u.cause === "dynamic" && u.file === "src/table.ts");
    expect(gaps).toHaveLength(n);
    expect(gaps[0]?.note).toContain("4,000 entries");
    expect(gaps[0]?.note).toContain("3,968");
  });

  it("stops inside a file when the budget runs out and lists the file as cut, never running on to its end (3)", async () => {
    const files = { "src/table.ts": bigTable(300) };
    const root = repo(files);
    const parser = await parserFor("typescript");
    const tree = parser.parse(readFileSync(join(root, "src/table.ts"), "utf8"));
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, "typescript");
    let asked = 0;
    // The budget runs out after a few checks: the first is the one made before the file.
    const world = createWorld({
      files: [{ path: "src/table.ts", facts }],
      known: new Set(Object.keys(files)),
      model: discoverProjects(Object.keys(files), new RepoReader(root)),
      goModules: [],
      stop: () => ++asked > 3,
    });
    const resolved = world.resolveAll();
    expect(resolved.budgetFiles).toEqual(["src/table.ts"]);
    expect(asked).toBeGreaterThan(3);
    // Some calls of the file were resolved before the stop, never all 300.
    const calls = new Set(resolved.edges.filter((e) => e.kind === "may_invoke").flatMap((e) => e.sites.map((s) => s.line)));
    expect(calls.size).toBeGreaterThan(0);
    expect(calls.size).toBeLessThan(300);
  });

  // Files whose escapes analysis reads: a computed load, an eval, a module.
  const escaping = {
    "src/a.js": "function f() {}\nexport function g() {\n  return f;\n}\n",
    "src/load.js": "require(process.argv[2]);\n",
    "src/run.js": "eval(location.hash);\n",
  };
  // `edit` changes each file's facts before the world is made.
  const worldOf = async (stop: () => boolean, edit: (facts: FileFacts) => void = () => {}) => {
    const root = repo(escaping);
    const parser = await parserFor("javascript");
    try {
      const files = Object.entries(escaping).map(([path, source]) => {
        const tree = parser.parse(source);
        if (!tree) throw new Error("no tree");
        try {
          const facts = extract(tree, "javascript");
          edit(facts);
          return { path, facts };
        } finally {
          tree.delete();
        }
      });
      return createWorld({ files, known: new Set(Object.keys(escaping)), model: discoverProjects(Object.keys(escaping), new RepoReader(root)), goModules: [], stop });
    } finally {
      parser.delete();
    }
  };

  it("does not start escape analysis once the budget is spent, and says its escapes are cut (4)", async () => {
    const resolved = (await worldOf(() => true)).resolveAll();
    expect(resolved.budgetFiles.length).toBeGreaterThan(0);
    expect(resolved.escapesCut).toBe(true);
    expect(resolved.escapes.loadAny).toEqual([]);
  });

  it("stops escape analysis when the budget runs out after every file is resolved, and says its escapes are cut (4)", async () => {
    // The fewest checks the budget allows that leave no file unresolved:
    // the next check is one escape analysis makes.
    const run = async (allowed: number) => {
      let asked = 0;
      return (await worldOf(() => ++asked > allowed)).resolveAll();
    };
    let allowed = 0;
    // A bounded search: a resolver that never finishes these files fails below.
    while ((await run(allowed)).budgetFiles.length > 0 && allowed < 100) allowed++;
    const resolved = await run(allowed);
    expect(resolved.budgetFiles).toEqual([]);
    expect(resolved.escapesCut).toBe(true);
    expect(resolved.escapes.loadAny).toEqual([]);
    // With a budget that never runs out, the same files are whole.
    const whole = (await worldOf(() => false)).resolveAll();
    expect(whole.escapesCut).toBe(false);
    expect(whole.escapes.loadAny.length).toBeGreaterThan(0);
  });

  it("floors every caller list of a graph whose escape analysis the budget cut (5)", async () => {
    const g = await buildGraph({ repoRoot: repo(escaping), store: null, budgetMs: 60_000 });
    const seed = { id: symbol(g, "src/a.js", "g"), name: "g", file: "src/a.js", kind: "function" as const };
    const cut = (await worldOf(() => true)).resolveAll();
    expect(cut.escapesCut).toBe(true);
    const cutGraph = { ...g, escapes: cut.escapes };
    expect(floorReasons(cutGraph, seed, new Set())).toContainEqual(expect.stringMatching(/budget ran out before every way a function escapes was found/));
    const files = writeIndex(cutGraph);
    const back = readIndexFrom((name) => files[name] ?? null, g.repoRoot);
    expect(back?.nodes.size).toBe(g.nodes.size);
    expect(back?.escapes.uses.size).toBe(cut.escapes.uses.size);
    expect(floorReasons(back as typeof g, seed, new Set())).toContainEqual(expect.stringMatching(/budget ran out before every way a function escapes was found/));
  });

  it("cuts escape analysis when the budget runs out while member reads are summed (6)", async () => {
    // The budget runs out when the facts of a file's member reads are read:
    // the last step of the pass, after every file is resolved.
    let summing = false;
    const world = await worldOf(() => summing, (facts) => {
      const members = facts.looseMembers;
      Object.defineProperty(facts, "looseMembers", { get: () => ((summing = true), members) });
    });
    const resolved = world.resolveAll();
    expect(summing).toBe(true);
    expect(resolved.budgetFiles).toEqual([]);
    expect(resolved.escapesCut).toBe(true);
  });

  // A file of `count` functions and as many eval sites, its facts read once:
  // the time taken is the resolver's.
  const evalsWorld = async (count: number) => {
    const source = `${Array.from({ length: count }, (_, i) => `function f${i}() {}\n`).join("")}${"eval(location.hash);\n".repeat(count)}`;
    const files = { "src/evals.js": source };
    const root = repo(files);
    const parser = await parserFor("javascript");
    const tree = parser.parse(source);
    if (!tree) throw new Error("no tree");
    const facts = extract(tree, "javascript");
    tree.delete();
    parser.delete();
    return () => createWorld({ files: [{ path: "src/evals.js", facts }], known: new Set(Object.keys(files)), model: discoverProjects(Object.keys(files), new RepoReader(root)), goModules: [] }).resolveAll();
  };

  growthTests("in time that grows with the eval sites", () => {
    it("reads 8,000 eval sites among 8,000 functions in time that grows with the count (7)", async () => {
      const small = await evalsWorld(2_000);
      const large = await evalsWorld(8_000);
      // The last function is still reached by an eval of its file.
      const whole = large();
      const last = [...whole.nodes.keys()].find((id) => id.includes("#f7999@")) ?? "";
      expect(whole.escapes.reach.get(last)).toEqual([expect.objectContaining({ why: "eval", file: "src/evals.js" })]);
      expectLinear("escape analysis of 2,000 and of 8,000 eval sites among as many functions", await cpuMs(small), await cpuMs(large));
    }, 120_000);
  });

  // Each read of a barrel's local exports is counted. The budget runs out
  // at 40 reads spread over a whole run, so some land inside the walks:
  // the most barrels read after it, over all of those runs.
  const mostReadAfterTheBudget = async (files: Record<string, string>) => {
    // The facts are made here, so the project model reads only an empty
    // folder: no repository to set up.
    const root = tempDir("oq-graph-");
    const parser = await parserFor("typescript");
    const facts = Object.entries(files).map(([path, source]) => {
      const tree = parser.parse(source);
      if (!tree) throw new Error("no tree");
      const f = extract(tree, path.endsWith(".js") ? "javascript" : "typescript");
      tree.delete();
      return { path, facts: f };
    });
    parser.delete();
    const run = (expireAt: number) => {
      let reads = 0;
      let expiredAt: number | null = null;
      const counted = facts.map(({ path, facts: f }) => {
        const copy = { ...f };
        const exportsLocal = f.exportsLocal;
        Object.defineProperty(copy, "exportsLocal", { get: () => (++reads === expireAt && (expiredAt = reads), exportsLocal) });
        return { path, facts: copy };
      });
      const resolved = createWorld({ files: counted, known: new Set(Object.keys(files)), model: discoverProjects(Object.keys(files), new RepoReader(root)), goModules: [], stop: () => expiredAt !== null }).resolveAll();
      return { resolved, reads, after: expiredAt === null ? 0 : reads - expiredAt };
    };
    const whole = run(-1);
    expect(whole.resolved.escapesCut).toBe(false);
    let most = 0;
    for (let at = 1; at < whole.reads; at += Math.max(1, Math.floor(whole.reads / 40))) {
      const cut = run(at);
      expect(cut.resolved.escapesCut).toBe(true);
      most = Math.max(most, cut.after);
    }
    return most;
  };

  it("stops escape analysis soon after the budget runs out in its walk of export * (8)", async () => {
    // A ring of 30 barrels, each re-exporting the next: no walk of it is
    // kept, so a computed load makes escape analysis walk the whole ring
    // again from each barrel (the check in the walk).
    const ring: Record<string, string> = { "load.js": "require(process.argv[2]);\n" };
    for (let i = 0; i < 30; i++) ring[`r${i}.ts`] = `export * from "./r${(i + 1) % 30}";\nexport function f${i}() {\n  return ${i};\n}\n`;
    // A chain of 60 barrels, its top listed first: the first barrel escape
    // analysis lists offers 60 names, each looked up in turn (the check at
    // each name).
    const chain: Record<string, string> = {};
    for (let i = 60; i >= 1; i--) chain[`c${i}.ts`] = `export * from "./c${i - 1}";\nexport function f${i}() {\n  return ${i};\n}\n`;
    chain["c0.ts"] = "export function f0() {\n  return 0;\n}\n";
    chain["load.js"] = "require(process.argv[2]);\n";
    // One lookup of a name may finish its own short walk; neither the walk
    // nor the list of names may run on.
    expect(await mostReadAfterTheBudget(ring)).toBeLessThan(10);
    expect(await mostReadAfterTheBudget(chain)).toBeLessThan(10);
  });
});
