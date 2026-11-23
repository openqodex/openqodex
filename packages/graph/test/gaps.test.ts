// Every place the graph gives up reaches the caller floors it can hide a
// caller from, through one record (gap.ts): what gave up, where, what a
// hidden call may run, and what to check. Ways it could fail, written
// before the code:
//  1. A call of what another call returns past the fan-out cap keeps a gap
//     with no name and file scope, so no floor finds it: the 40th function
//     returned reads as having no caller.
//  2. A star lookup that left a branch too deep to follow reads as one
//     plain definition, so escape analysis never visits the deep branch
//     and a definition there reads as having no caller (issue 448).
//  3. A framework plugin that stops at its cap hides the framework running
//     a handler, and the callers answer of the handler never says so.
//  4. A gap with no narrower target, or one that reaches a file or ids,
//     floors nothing, or floors only the answers of its own name.
//  5. The answer says where each gap is and what to check only in a
//     sentence, or loses that when the index is written and read back.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, floorOf } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { NEXT, gap } from "../src/gap.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request, Session } from "../src/query/answer.js";
import { readIndexFrom, writeIndex } from "../src/store/graph-files.js";
import { commitAll, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const session = (graph: Graph): Session => ({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false });
const ask = (graph: Graph, req: Omit<Request, "apiVersion">): Answer => query(session(graph), { apiVersion: 1, ...req } as Request);
const build = (files: Record<string, string>) => buildGraph({ repoRoot: makeRepo(files), store: null });

describe("a give-up reaches the floors it can hide a caller from", () => {
  it("floors a function returned past the fan-out cap, with the place and what to check (1, 5)", async () => {
    const n = 40;
    const graph = await build({
      "h.ts": Array.from({ length: n }, (_, i) => `export function h${i + 1}() { return ${i + 1}; }\n`).join(""),
      "m.ts": `import { ${Array.from({ length: n }, (_, i) => `h${i + 1}`).join(", ")} } from "./h";\nexport function pick(k: number) {\n${Array.from({ length: n - 1 }, (_, i) => `  if (k === ${i + 1}) return h${i + 1};\n`).join("")}  return h${n};\n}\nexport function go() {\n  return pick(3)();\n}\n`,
    });
    const last = ask(graph, { kind: "callers", target: { name: `h${n}`, file: "h.ts" } });
    expect(last.error).toBeNull();
    expect(last.unknown.floor).toBe(true);
    expect(last.unknown.reasons.join(" ")).toMatch(/pick returns 40 functions by name; the 8 past the first 32 are not listed/);
    expect(last.unknown.gaps).toContainEqual({ cause: "fan-out-capped", file: "m.ts", line: n + 5, next: NEXT.returnedCap });
    // A function the call lists as a possible target keeps its own floor; the gap does not reach it.
    const first = ask(graph, { kind: "callers", target: { name: "h1", file: "h.ts" } });
    expect(first.unknown.gaps ?? []).not.toContainEqual(expect.objectContaining({ cause: "fan-out-capped" }));
  }, 60_000);

  it("floors a definition behind an export * branch too deep to follow (2, issue 448)", async () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 10; i++) chain[`c${i}.ts`] = `export * from "./${i === 9 ? "t" : `c${i + 1}`}";\n`;
    const graph = await build({
      "f.ts": 'export * from "./s2";\nexport * from "./s1";\n',
      "s1.ts": "export function x() {}\n",
      "s2.ts": 'export * from "./c0";\n',
      ...chain,
      "t.ts": "export function x() {}\n",
      "use.ts": 'import * as r from "./f";\nexport function go(k: string) {\n  (r as any)[k]();\n}\n',
    });
    const a = ask(graph, { kind: "callers", target: { name: "x", file: "t.ts" } });
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
  }, 60_000);

  it("floors a handler's callers when the framework plugin stopped at its registration cap (3)", async () => {
    const root = makeRepo({
      "requirements.txt": "Django==5.0\n",
      "mysite/__init__.py": "",
      "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
      "mysite/urls.py": `from django.urls import include, path\n\nurlpatterns = [\n${Array.from({ length: 20 }, (_, i) => `    path("p${i}/", include("mysite.table")),\n`).join("")}]\n`,
      "mysite/table.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 600 }, (_, i) => `    path("r${i}/", views.page),\n`).join("")}]\n`,
      "mysite/views.py": "def page(request):\n    return None\n",
    });
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const a = ask(graph, { kind: "callers", target: { name: "page", file: "mysite/views.py" } });
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/the django plugin gave up/);
    expect(a.unknown.gaps).toContainEqual(expect.objectContaining({ cause: "fan-out-capped", next: NEXT.framework }));
  }, 120_000);

  it("joins a gap on what it reaches: ids, a file, the whole project, a name (4)", async () => {
    const files = {
      "a/package.json": '{"name": "a"}\n',
      "a/one.ts": "export function one() {}\nexport function two() {}\n",
      "a/three.ts": "export function three() {}\n",
      "b/package.json": '{"name": "b"}\n',
      "b/four.ts": "export function four() {}\n",
    };
    const floored = async (made: ReturnType<typeof gap>) => {
      const g = await build(files);
      g.unknowns.push(made);
      const at = (file: string, name: string) => floorOf(g, { id: symbol(g, file, name), name, file, kind: "function" }, new Set()).reasons.length > 0;
      return { one: at("a/one.ts", "one"), two: at("a/one.ts", "two"), three: at("a/three.ts", "three"), four: at("b/four.ts", "four") };
    };
    const place = { file: "a/three.ts", line: 1 };
    const g0 = await build(files);
    expect(await floored(gap({ cause: "unsupported-rule", place, reaches: { ids: [symbol(g0, "a/one.ts", "one")] }, next: NEXT.unbound }))).toEqual({ one: true, two: false, three: false, four: false });
    expect(await floored(gap({ cause: "unsupported-rule", place, reaches: { file: "a/one.ts" }, next: NEXT.unbound }))).toEqual({ one: true, two: true, three: false, four: false });
    expect(await floored(gap({ cause: "unsupported-rule", place, reaches: "scope", next: NEXT.unbound }))).toEqual({ one: true, two: true, three: true, four: false });
    expect(await floored(gap({ cause: "unsupported-rule", place, reaches: { names: ["four"] }, next: NEXT.unbound }))).toEqual({ one: false, two: false, three: false, four: true });
  }, 60_000);

  it("keeps what each gap reaches and what to check when the index is written and read back (5)", async () => {
    const graph = await build({
      "t.ts": "const table = { a: () => 1 };\nexport function go(k: string) {\n  return (table as any)[k]() + missing();\n}\n",
    });
    expect(graph.unknowns.length).toBeGreaterThan(0);
    const files = writeIndex(graph);
    const back = readIndexFrom((name) => files[name] ?? null, graph.repoRoot);
    expect(back?.unknowns).toEqual(graph.unknowns);
    expect(graph.unknowns.every((u) => u.next.length > 0 && u.reaches !== undefined)).toBe(true);
  }, 60_000);
});
