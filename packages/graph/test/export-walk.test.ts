// The walk that lists what a file exports through `export *`. Ways it could
// fail, each on a real repo built as two commits:
// 1. Two barrels that `export *` from each other make the walk recurse
//    until the stack overflows, so the review gets no graph.
// 2. A diamond of barrels (each level re-exports both barrels of the level
//    below) is walked once per path, which doubles with every level: 2,000
//    barrels never finish.
// 3. A walk stopped by its step budget drops the names past the stop with
//    nothing said.
// 4. A walk stopped by its step budget drops a name a module offers, so a
//    function past the stop reads as having every caller listed, though
//    the module is used as a value and a computed name may call it.
// 5. The fix for 4 floors names the module cannot give through the cut
//    star: a default export (no star brings it), a name the module's own
//    export shadows, or a sibling a named re-export leaves out.
import { afterAll, describe, expect, it } from "vitest";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Request } from "../src/query/answer.js";
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

  // Eight barrels that each `export *` from the other seven: no walk
  // through them finishes, so a walk from `r.ts` spends its whole budget
  // there before it reaches `end.ts`. `use.ts` uses `r.ts` as a value.
  // The names `r.ts` gives itself come before its stars, so looking them
  // up never enters the web.
  async function cutWeb() {
    const files: Record<string, string> = {
      "end.ts": "export function t(): void {}\nexport function mine(): void {}\nfunction d(): void {}\nexport default d;\n",
      "side.ts": "export function s(): void {}\nexport function sibling(): void {}\n",
      "r.ts": 'export { s } from "./side";\nexport function mine(): void {}\nexport * from "./mesh0";\nexport * from "./end";\n',
      "use.ts": 'import * as r from "./r";\nexport function go(k: string) {\n  (r as any)[k]();\n}\n',
    };
    for (let i = 0; i < 8; i++) files[`mesh${i}.ts`] = [0, 1, 2, 3, 4, 5, 6, 7].filter((j) => j !== i).map((j) => `export * from "./mesh${j}";\n`).join("") + `export function own${i}(): void {}\n`;
    const graph = await buildGraph({ repoRoot: makeRepo(files), store: null });
    expect(graph.status.cuts.some((c) => c.by === "export-walk"), "the walk passes its step budget").toBe(true);
    return (file: string, name: string) => query({ graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "callers", target: { id: symbol(graph, file, name) }, depth: 1 } as Request);
  }

  it("keeps the floor of a function the walk did not reach before its step budget ran out (4)", async () => {
    const callers = await cutWeb();
    const a = callers("end.ts", "t");
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toContain("its module is used as a value at use.ts:3");
    expect(callers("side.ts", "s").unknown.floor).toBe(true);
  }, 120_000);

  it("leaves whole a default export, a shadowed name and a sibling the cut module cannot give (5)", async () => {
    const callers = await cutWeb();
    for (const [file, name] of [["end.ts", "d"], ["end.ts", "mine"], ["side.ts", "sibling"]] as const) {
      const a = callers(file, name);
      expect(a.unknown.floor, `${file}#${name}: ${a.unknown.reasons.join("; ")}`).toBe(false);
    }
  }, 120_000);
});
