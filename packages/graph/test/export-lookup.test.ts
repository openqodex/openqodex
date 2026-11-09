// Looking up one exported name through re-exports. Ways it could fail, each
// on a real repo:
// 1. A diamond of barrels (each barrel re-exports every barrel of the layer
//    below) is walked once per path for every name looked up: seven layers
//    of 20 barrels are 1.28 billion paths (43 seconds for one name measured
//    before the fix; five layers took 0.1 s, so they would prove nothing).
// 2. A web of `export *` cycles, which no cache can shorten, runs without a
//    bound, or stops with nothing said.
// 3. A barrel's `export *` from a module the graph cannot follow (a file
//    that is not there, a package outside the repository) is skipped, so a
//    name another branch brings binds certainly although the unfollowed
//    branch may bring it too.
// 4. A Python module's `from x import *` lines are read first-wins, though
//    Python binds the last one, and a later star the graph cannot follow
//    leaves the earlier binding certain.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { EXPORT_LOOKUP_STEPS } from "../src/resolve.js";
import { expectLinear, growthTests, stageCpuMs } from "../src/test-timing.js";
import { makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const buildOf = (root: string) => () => buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildOf(makeRepo(files))();
}

function tiers(graph: Graph, id: string): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === "calls")
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))
    .sort();
}

// Layers of `width` barrels; each barrel re-exports every barrel of the
// layer below (layer 1 re-exports x.ts). `extra` adds lines to every barrel.
function diamond(layers: number, width: number, extra = ""): Record<string, string> {
  const files: Record<string, string> = { "x.ts": "export function f() {\n  return 1;\n}\n" };
  for (let l = 1; l <= layers; l++) {
    for (let i = 0; i < width; i++) {
      const below = l === 1 ? ['export * from "./x";'] : Array.from({ length: width }, (_, j) => `export * from "./l${l - 1}b${j}";`);
      files[`l${l}b${i}.ts`] = `${below.join("\n")}\n${extra}`;
    }
  }
  files["use.ts"] = `import { f } from "./l${layers}b0";\nexport function run() {\n  return f();\n}\n`;
  return files;
}

describe("looking up an exported name", () => {
  it("binds through seven layers of 20 barrels (1)", async () => {
    const g = await buildOf(makeRepo(diamond(7, 20)))();
    expect(tiers(g, symbol(g, "x.ts", "f"))).toEqual(["use.ts:3 certain"]);
  }, 120_000);

  it("stops a web of export * cycles at its step budget and records the cut (2)", async () => {
    // Every barrel also re-exports the top barrel: every path meets a cycle.
    const g = await buildOf(makeRepo(diamond(5, 20, 'export * from "./l5b0";\n')))();
    const cut = g.status.cuts.find((c) => c.by === "export-walk");
    expect(cut?.note).toContain(EXPORT_LOOKUP_STEPS.toLocaleString("en-US"));
    expect(cut).toMatchObject({ exact: false, omitted: null });
  }, 120_000);

  growthTests("in time that grows with the re-exports", () => {
    it("binds through seven layers of 20 barrels in time that grows with the re-exports, not the paths (1)", async () => {
      // Ten barrels a layer are a quarter of the re-exports and 1/128 of the paths.
      expectLinear("the resolve stage on seven layers of 10 and of 20 barrels", await stageCpuMs(buildOf(makeRepo(diamond(7, 10))), "resolve"), await stageCpuMs(buildOf(makeRepo(diamond(7, 20))), "resolve"));
    }, 120_000);

    it("stops a web of export * cycles in time that grows with the re-exports (2)", async () => {
      const web = (width: number) => makeRepo(diamond(5, width, 'export * from "./l5b0";\n'));
      expectLinear("the resolve stage on webs of five layers of 10 and of 20 barrels", await stageCpuMs(buildOf(web(10)), "resolve"), await stageCpuMs(buildOf(web(20)), "resolve"));
    }, 120_000);
  });

  it("keeps a name another export * may also bring from being certain (3)", async () => {
    const g = await graphOf({
      "package.json": '{ "name": "app", "dependencies": { "left-pad": "^1.0.0" } }\n',
      "one.ts": "export function f() {\n  return 1;\n}\nexport function g() {\n  return 2;\n}\n",
      "gone.ts": 'export * from "./one";\nexport * from "./not-there";\n',
      "outside.ts": 'export * from "./one";\nexport * from "left-pad";\n',
      "use.ts":
        'import { f } from "./gone";\nimport { g } from "./outside";\nimport { pad } from "./outside";\nexport function run() {\n  return f() + g() + pad();\n}\n',
    });
    expect(tiers(g, symbol(g, "one.ts", "f"))).toEqual(["use.ts:5 possible"]);
    expect(tiers(g, symbol(g, "one.ts", "g"))).toEqual(["use.ts:5 possible"]);
    const site = (g.in.get(symbol(g, "one.ts", "f")) ?? []).flatMap((e) => e.sites)[0];
    expect(site?.note).toContain("./not-there");
    // A name only the package outside can bring is that package's.
    expect(g.unknowns.filter((u) => u.name === "pad")).toEqual([]);
  });

  it("binds a Python name to the last star import that brings it, and not certainly past one it cannot follow (4)", async () => {
    const g = await graphOf({
      "requirements.txt": "numpy\n",
      "pkg/__init__.py": "",
      "pkg/one.py": "def f():\n    return 1\n",
      "pkg/two.py": "def f():\n    return 2\n",
      "pkg/last.py": "from pkg.one import *\nfrom pkg.two import *\n\n\ndef run():\n    return f()\n",
      "pkg/open.py": "from pkg.one import *\nfrom numpy import *\n\n\ndef run():\n    return f()\n",
      "pkg/closed.py": "from numpy import *\nfrom pkg.one import *\n\n\ndef run():\n    return f()\n",
    });
    expect(tiers(g, symbol(g, "pkg/two.py", "f"))).toEqual(["pkg/last.py:6 certain"]);
    expect(tiers(g, symbol(g, "pkg/one.py", "f"))).toEqual(["pkg/closed.py:6 certain", "pkg/open.py:6 possible"]);
  });
});
