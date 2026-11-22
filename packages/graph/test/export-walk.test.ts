// The walk that lists what a file exports through `export *`. Ways it could
// fail, each on a real repo built as two commits:
// 1. Two barrels that `export *` from each other make the walk recurse
//    until the stack overflows, so the review gets no graph.
// 2. A diamond of barrels (each level re-exports both barrels of the level
//    below) is walked once per path, which doubles with every level: 2,000
//    barrels never finish.
// 3. A walk stopped by its step budget drops the names past the stop with
//    nothing said.
// 4. Escape analysis, which lists what every module offers when a module is
//    loaded by a computed path, spends the step budget the comparison of
//    the change needs, so a changed barrel is said not compared (issue 421).
// 5. Escape analysis's own walk stops at its step budget, and a function
//    re-exported past the stop by a module used as a value keeps a caller
//    list that reads as whole.
import { afterAll, describe, expect, it } from "vitest";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, floorReasons } from "../src/index.js";
import { EXPORT_WALK_STEPS } from "../src/resolve.js";
import { expectLinear, growthTests, stageCpuMs } from "../src/test-timing.js";
import { commitAll, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// A repo of `before`, committed, with `after` written over it: its change,
// and a build of its graph against the commit.
async function prepared(before: Record<string, string>, after: Record<string, string>) {
  const root = makeRepo(before);
  commitAll(root);
  writeFiles(root, after);
  const c = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const build = () => buildGraph({ repoRoot: root, store: null, files: c.changedPaths, base: { sha: c.baseSha, files: c.files }, budgetMs: 60_000, maxFiles: 100_000 });
  return { c, build };
}

async function change(before: Record<string, string>, after: Record<string, string>) {
  const { c, build } = await prepared(before, after);
  const graph = await build();
  return { graph, impact: detectImpact(graph, c) };
}

// The CPU time of the stage that compares the two export surfaces.
async function compareCpuMs(before: Record<string, string>, after: Record<string, string>): Promise<number> {
  return stageCpuMs((await prepared(before, after)).build, "compare");
}

// A ring of `n` barrels, each re-exporting the next and the last the first,
// each with a name of its own; the change removes the first barrel's export.
function ring(n: number): [Record<string, string>, Record<string, string>] {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`r${i}.ts`] = `export * from "./r${(i + 1) % n}";\nexport function f${i}() {\n  return ${i};\n}\n`;
  return [files, { "r0.ts": `export * from "./r1";\nfunction f0() {\n  return 0;\n}\n` }];
}

// Levels of two barrels, each re-exporting both barrels of the level below;
// `top.ts` re-exports the last level and has a name of its own.
function diamond(levels: number, own: string): Record<string, string> {
  const files: Record<string, string> = { "x.ts": "export function target() {\n  return 1;\n}\n" };
  for (let i = 1; i <= levels; i++) {
    const below = i === 1 ? ['export * from "./x";\n'] : [`export * from "./d${i - 1}a";\n`, `export * from "./d${i - 1}b";\n`];
    files[`d${i}a.ts`] = below.join("");
    files[`d${i}b.ts`] = below.join("");
  }
  files["top.ts"] = `export * from "./d${levels}a";\nexport * from "./d${levels}b";\n${own}`;
  return files;
}

describe("the export walk", () => {
  it("finishes on two barrels that export * from each other (1)", async () => {
    const { impact } = await change(
      {
        "a.ts": 'export * from "./b";\nexport function fa() {\n  return 1;\n}\n',
        "b.ts": 'export * from "./a";\nexport function fb() {\n  return 2;\n}\n',
        "use.ts": 'import { fa } from "./b";\nexport function run() {\n  return fa();\n}\n',
      },
      { "a.ts": 'export * from "./b";\nfunction fa() {\n  return 1;\n}\n' },
    );
    const removed = impact.exports.find((e) => e.name === "fa");
    expect(removed?.consumers.map((c) => `${c.file}:${c.now}`)).toContain("use.ts:broken");
  });

  const own = "export function mine() {\n  return 2;\n}\n";
  const after = (levels: number) => ({ "top.ts": diamond(levels, "function mine() {\n  return 2;\n}\n")["top.ts"] as string });
  it("walks a 2,000-barrel diamond (2)", async () => {
    const { impact } = await change(diamond(1000, own), after(1000));
    expect(impact.exports.find((e) => e.name === "mine")).toMatchObject({ file: "top.ts", change: "removed" });
  }, 300_000);

  growthTests("in time that grows with the barrels", () => {
    it("finishes a ring of barrels that export * from each other in time that grows with the ring (1)", async () => {
      // Rings of 2 and of 8 such barrels: the walk's time grows with the ring.
      expectLinear("the compare stage on rings of 2 and of 8 barrels", await compareCpuMs(...ring(2)), await compareCpuMs(...ring(8)));
    });

    it("walks a 2,000-barrel diamond in time that grows with the barrels, not the paths (2)", async () => {
      expectLinear("the compare stage on diamonds of 500 and of 2,000 barrels", await compareCpuMs(diamond(250, own), after(250)), await compareCpuMs(diamond(1000, own), after(1000)));
    }, 300_000);
  });

  it("compares a changed barrel with a step budget of its own after escape analysis walked every module (4)", async () => {
    // A ring's walks are kept by no one (each meets the ring's cycle), so
    // listing what each of 70 barrels offers takes 70 times 69 steps, past
    // the budget; the comparison of top.ts needs 70 more.
    const [files] = ring(70);
    files["load.js"] = "const name = process.argv[2];\nrequire(name);\n";
    files["top.ts"] = 'export * from "./r0";\nexport function mine() {\n  return 2;\n}\n';
    expect(70 * 69).toBeGreaterThan(EXPORT_WALK_STEPS);
    const { graph, impact } = await change(files, { "top.ts": 'export * from "./r0";\nfunction mine() {\n  return 2;\n}\n' });
    expect(impact.exports.find((e) => e.name === "mine")).toMatchObject({ file: "top.ts", change: "removed" });
    const notes = graph.status.cuts.filter((c) => c.by === "export-walk").map((c) => c.note);
    expect(notes, notes.join("; ")).toEqual(expect.arrayContaining([expect.stringContaining("export * for escape analysis stopped")]));
    expect(notes.filter((note) => note.includes("not compared")), notes.join("; ")).toEqual([]);
  }, 300_000);

  it("records a cut when the walk passes its step budget (3)", async () => {
    const levels = Math.ceil(EXPORT_WALK_STEPS / 2) + 5;
    const files: Record<string, string> = { "x.ts": "export function target() {\n  return 1;\n}\n" };
    // A chain, one barrel a level: every step is a new file.
    for (let i = 1; i <= 2 * levels; i++) files[`c${i}.ts`] = i === 1 ? 'export * from "./x";\n' : `export * from "./c${i - 1}";\n`;
    files["top.ts"] = `export * from "./c${2 * levels}";\nexport function mine() {\n  return 2;\n}\n`;
    const { graph } = await change(files, { "top.ts": `export * from "./c${2 * levels}";\nfunction mine() {\n  return 2;\n}\n` });
    const cut = graph.status.cuts.find((c) => c.by === "export-walk");
    expect(cut).toMatchObject({ by: "export-walk", exact: false, omitted: null, unit: "files" });
    expect(cut?.note).toMatch(/export \*/);
  }, 300_000);

  it("floors a function re-exported past the escape walk's stop by a module used as a value (5)", async () => {
    // A chain longer than the step budget, one barrel a level, ends at x.ts.
    const levels = EXPORT_WALK_STEPS + 10;
    const files: Record<string, string> = { "x.ts": "export function target() {\n  return 1;\n}\n" };
    for (let i = 1; i <= levels; i++) files[`c${i}.ts`] = i === 1 ? 'export * from "./x";\n' : `export * from "./c${i - 1}";\n`;
    files["use.ts"] = `import * as all from "./c${levels}";\nexport function run(k: string) {\n  return (all as Record<string, () => number>)[k]();\n}\n`;
    const g = await buildGraph({ repoRoot: makeRepo(files), store: null, budgetMs: 120_000, maxFiles: 100_000 });
    expect(g.status.cuts.map((c) => c.note)).toContainEqual(expect.stringContaining("export * for escape analysis stopped"));
    const reasons = floorReasons(g, { id: symbol(g, "x.ts", "target"), name: "target", file: "x.ts", kind: "function" }, new Set());
    expect(reasons).toContainEqual(expect.stringMatching(/its module is used as a value at use\.ts:/));
  }, 300_000);
});
