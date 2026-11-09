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
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { discoverProjects } from "../src/discovery/projects.js";
import { extract } from "../src/extract.js";
import { parserFor } from "../src/parser.js";
import { createWorld } from "../src/resolve.js";
import { RepoReader } from "../src/safe-fs.js";
import { cpuMs, expectLinear, growthTests } from "../src/test-timing.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

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
});
