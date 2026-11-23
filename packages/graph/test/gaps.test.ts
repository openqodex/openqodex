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
//  6. A floor set by a use as a value, a file not read, a partial build or
//     an escape search the budget cut names no place in `gaps`, so the
//     agent learns the list is short and not where to look.
//  7. An `impact` answer that is a floor carries no `gaps`.
//  8. A question stopped by its time budget, a language the build does not
//     read, or the review walk cut at its limit floors the answer with no
//     place in `gaps`.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, floorOf } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { NEXT, gap } from "../src/gap.js";
import { query } from "../src/query/engine.js";
import { checksBudget } from "../src/query/traverse.js";
import type { Answer, Request, Session } from "../src/query/answer.js";
import { readIndexFrom, writeIndex } from "../src/store/graph-files.js";
import { commitAll, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const session = (graph: Graph): Session => ({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false });
const ask = (graph: Graph, req: Omit<Request, "apiVersion">, checks?: number): Answer => query(session(graph), { apiVersion: 1, ...req } as Request, checks === undefined ? {} : { budget: checksBudget(checks) });
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

  it("floors an action's callers when the framework plugin stopped at a cap, where nothing else would (3)", async () => {
    // A Rails route names its action by a string, so no use as a value floors it.
    const nest = (body: string, depth: number): string => (depth === 0 ? body : `namespace :n${depth} do\n${nest(body, depth - 1)}end\n`);
    const root = makeRepo({
      Gemfile: 'source "https://rubygems.org"\n\ngem "rails"\n',
      "config/routes.rb": `Rails.application.routes.draw do\n${nest('get "deep", to: "users#deep"\n', 9)}get "top", to: "users#top"\nend\n`,
      "app/controllers/users_controller.rb": "class UsersController < ApplicationController\n  def deep\n  end\n\n  def top\n  end\nend\n",
    });
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const a = ask(graph, { kind: "callers", target: { name: "deep", file: "app/controllers/users_controller.rb" } });
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/the rails plugin gave up at config\/routes\.rb:\d+ \(fan-out-capped\): route blocks nested deeper than eight levels are not read/);
    expect(a.unknown.gaps).toContainEqual(expect.objectContaining({ cause: "fan-out-capped", file: "config/routes.rb", next: NEXT.framework }));
  }, 60_000);

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

  it("names the place of a use as a value, a file not read and an escape search cut, on callers and impact (6, 7)", async () => {
    const graph = await buildGraph({
      repoRoot: makeRepo({
        "a.ts": "export function f() {\n  return 1;\n}\n",
        "b.ts": 'import { f } from "./a";\nexport const list = [f];\n',
        "big.ts": `export const text = "${"x".repeat(400)}";\n`,
      }),
      store: null,
      maxFileBytes: 200,
    });
    expect(graph.status.status).toBe("partial");
    const a = ask(graph, { kind: "callers", target: { name: "f", file: "a.ts" } });
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps).toContainEqual({ cause: "dynamic", file: "b.ts", line: 2, next: NEXT.valueUse });
    expect(a.unknown.gaps).toContainEqual({ cause: "file-not-parsed", file: "big.ts", line: null, next: NEXT.notRead });
    const i = ask(graph, { kind: "impact", target: { name: "f", file: "a.ts" } });
    expect(i.error).toBeNull();
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.gaps).toContainEqual({ cause: "dynamic", file: "b.ts", line: 2, next: NEXT.valueUse });
    expect(i.unknown.gaps).toContainEqual({ cause: "file-not-parsed", file: "big.ts", line: null, next: NEXT.notRead });
    // The escape search the budget cut has no place of its own: it is said at the target.
    graph.escapes.cut = true;
    const cut = ask(graph, { kind: "callers", target: { name: "f", file: "a.ts" } });
    expect(cut.unknown.gaps).toContainEqual({ cause: "budget", file: "a.ts", line: 1, next: NEXT.escapesCut });
  }, 60_000);

  it("names where a question stopped at its time budget (8)", async () => {
    const callers = Array.from({ length: 30 }, (_, i) => `export function c${i}() {\n  return hub();\n}\n`).join("");
    const graph = await build({ "h.ts": `export function hub() {\n  return 1;\n}\n${callers}` });
    const req = { kind: "callers" as const, target: { name: "hub", file: "h.ts" }, depth: 2 };
    const whole = checksBudget(Number.MAX_SAFE_INTEGER);
    query(session(graph), { apiVersion: 1, ...req }, { budget: whole });
    // Stopped in the walk, past finding the target.
    const a = ask(graph, req, Math.floor(whole.checks * 0.8));
    expect(a.truncated.by).toBe("budget");
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps?.length ?? 0).toBeGreaterThan(0);
    expect(a.unknown.gaps?.every((x) => x.cause === "budget" && x.file === "h.ts" && x.line !== null && x.next === NEXT.questionStopped)).toBe(true);
  }, 60_000);

  it("names the target when a language the build does not read can call it (8)", async () => {
    const graph = await build({ "src/A.java": "class A {\n  void f() {}\n}\n", "src/B.kt": "class B { fun g() { A().f() } }\n" });
    expect(graph.status.unreadLanguages).toEqual([{ language: "kotlin", files: 1 }]);
    const a = ask(graph, { kind: "callers", target: { name: "f", file: "src/A.java" } });
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps).toContainEqual({ cause: "language-not-read", file: "src/A.java", line: 2, next: NEXT.unreadLanguage });
  }, 60_000);

  it("names the seed the review walk cut at its limit (8)", async () => {
    // 20 callers of the seed, each with 20 callers: past the walk's 200 symbols.
    const mids = Array.from({ length: 20 }, (_, i) => `export function m${i}() {\n  return seed();\n}\n`).join("");
    const tops = Array.from({ length: 20 }, (_, i) => Array.from({ length: 20 }, (_, j) => `export function t${i}_${j}() {\n  return m${i}();\n}\n`).join("")).join("");
    const graph = await build({ "s.ts": `export function seed() {\n  return 1;\n}\n${mids}`, "t.ts": `import { ${Array.from({ length: 20 }, (_, i) => `m${i}`).join(", ")} } from "./s";\n${tops}` });
    const i = ask(graph, { kind: "impact", target: { name: "seed", file: "s.ts" } });
    expect(i.error).toBeNull();
    expect(i.unknown.reasons.join(" ")).toMatch(/the walk stopped at 200 symbols/);
    expect(i.unknown.gaps).toContainEqual({ cause: "fan-out-capped", file: "s.ts", line: 1, next: NEXT.walkCut });
  }, 60_000);
});
