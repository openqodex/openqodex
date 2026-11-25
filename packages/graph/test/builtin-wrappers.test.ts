// TypeScript's own generic types the extractor reads through, and the
// types it reads at all, each a way a reviewer found to a wrong certain
// edge or a crash:
// 1. `Pick<T, K>` and `Omit<T, K>` were read as T, so a member the wrapper
//    drops bound certain to T's member; a Pick or Omit the file declares or
//    imports was read the same way. Only the built-in is read through, and
//    only the members it keeps. A side of an intersection that is itself an
//    intersection (`A & B & C`, or a Pick) never hides a second side that
//    declares the method.
// 2. `Map<K, V>.values()` was read as V's elements even when the file
//    declares or imports its own Map, whose values() may return anything.
// 3. An object type nested thousands deep was read by recursion with no
//    limit, so one hostile file could stop the build with a RangeError.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { at, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildGraph({ repoRoot: makeRepo(files), store: null });
}

// "file:line tier" of each call site into `id`.
function into(graph: Graph, id: string): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === "calls" || e.kind === "dispatches_to")
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))
    .sort();
}

const LIB = [
  "export class Api {",
  "  read(): number { return 1; }",
  "  write(): void {}",
  "}",
  "export class Sessions {",
  "  close(): number { return 1; }",
  "}",
  "export class Other {",
  "  close(): number { return 2; }",
  "}",
  "export interface Deps {",
  "  sessions: Sessions;",
  "  other: Other;",
  "}",
  "export class A {",
  "  run(): number { return 1; }",
  "}",
  "export class B {",
  "  run(): number { return 2; }",
  "}",
  "export class Factory {",
  "  make(): A { return new A(); }",
  "  drop(): B { return new B(); }",
  "  async later(): Promise<string> { return 'a'; }",
  "}",
  "",
].join("\n");

describe("Pick and Omit keep only the members they keep (1)", () => {
  const files: Record<string, string> = {
    "src/lib.ts": LIB,
    "src/use.ts": [
      'import { Api, Deps, Factory, Other } from "./lib";',
      'type Selected = Pick<Api, "read">;',
      "export function p1(s: Selected) { return s.read(); } // p1",
      "export function p2(s: Selected) { return s.write(); } // p2",
      'export function p3(s: Pick<Api, "read" | "nope">) { return s.write(); } // p3',
      'export function o1(s: Omit<Api, "write">) { return s.read(); } // o1',
      'export function o2(s: Omit<Api, "write">) { return s.write(); } // o2',
      "export function d1(d: Pick<Deps, 'sessions'>) { return d.sessions.close(); } // d1",
      "export function d2(d: Pick<Deps, 'sessions'>) { return d.other.close(); } // d2",
      "export function d3(d: Omit<Deps, 'other'>) { return d.other.close(); } // d3",
      "export function d4(d: Omit<Deps, 'other'>) { return d.sessions.close(); } // d4",
      "export function d5(d: Pick<Deps, 'sessions'> & { other: Other }) { return d.other.close(); } // d5",
      "export function k1<K extends keyof Api>(s: Pick<Api, K>) { return s.write(); } // k1",
      "export class Holder {",
      "  constructor(private client: Selected) {}",
      "  f1() { return this.client.read(); } // f1",
      "  f2() { return this.client.write(); } // f2",
      "}",
      "export function h1(h: { client: Selected }) { return h.client.read(); } // h1",
      "export function h2(h: { client: Selected }) { return h.client.write(); } // h2",
      "interface Ops { read: () => number; write: () => void }",
      "export function r1(o: Pick<Ops, 'read'>) { return o.read(); } // r1",
      "export function r2(o: Pick<Ops, 'read'>) { return o.write(); } // r2",
      "export function q1(s: Pick<Api, keyof Deps | 'read'>) { return s.read(); } // q1",
      "export function q2(s: Pick<Api, keyof Deps | 'read'>) { return s.write(); } // q2",
      "export function q3(s: Pick<Api, keyof Deps | 'read'> & { write(): void }) { return s.write(); } // q3",
      "export function q4(s: Omit<Api, keyof Deps | 'write'>) { return s.read(); } // q4",
      "export function b1(s: Pick<Api, 'write'> & Api) { return s.write(); } // b1",
      "export function n1(s: Pick<Pick<Api, 'read' | 'write'>, 'read'>) { return s.read(); } // n1",
      "export function n2(s: Pick<Pick<Api, 'read' | 'write'>, 'read'>) { return s.write(); } // n2",
      "export function x1(f: Pick<Factory, 'make' | 'later'>) { return f.make().run(); } // x1",
      "export function x2(f: Pick<Factory, 'make' | 'later'>) { return f.drop().run(); } // x2",
      "export function x3(f: Pick<Factory, 'make' | 'later'>) { return f.later().catch(() => 'b'); } // x3",
      "export interface Roles { roles: string[]; other: Other }",
      "export function e1(r: Pick<Roles, 'roles'>) { return r.roles.includes('x'); } // e1",
      "",
    ].join("\n"),
    "src/local.ts": [
      'import { Api } from "./lib";',
      "type Pick<T, K> = { other: T };",
      "interface Omit<T, K> { inner: T }",
      'export function l1(s: Pick<Api, "read">) { return s.read(); } // l1',
      'export function l2(s: Omit<Api, "x">) { return s.write(); } // l2',
      "",
    ].join("\n"),
    "src/mine.ts": "export interface Pick<T, K> { write(): void }\n",
    "src/imported.ts": [
      'import { Api } from "./lib";',
      'import { Pick } from "./mine";',
      'export function i1(s: Pick<Api, "write">) { return s.write(); } // i1',
      "",
    ].join("\n"),
  };
  const SITES = (path: string, ...markers: string[]) => markers.map((m) => at(files, path, `// ${m}`));

  it("binds a member the wrapper keeps and leaves a member it drops unbound", async () => {
    const g = await graphOf(files);
    const lib = (name: string, owner: string) => into(g, symbol(g, "src/lib.ts", name, owner));
    // A member outside the kept keys: no edge at any tier.
    // q3: a Pick whose keys are not all written out may keep write too; b1: both sides declare it.
    const dropped = SITES("src/use.ts", "p2", "p3", "o2", "k1", "f2", "h2", "q2", "q3", "b1", "n2");
    expect(into(g, symbol(g, "src/use.ts", "write", "Ops")).filter((c) => c.startsWith(`${SITES("src/use.ts", "r2")[0]} `))).toEqual([]);
    for (const s of dropped) expect(lib("write", "Api").filter((c) => c.startsWith(`${s} `))).toEqual([]);
    // The gap says why.
    const [p2] = SITES("src/use.ts", "p2");
    expect(g.unknowns.find((u) => `${u.file}:${u.line}` === p2 && u.name === "write")?.note).toBe("a Pick or an Omit that does not show it keeps this member");
    for (const s of SITES("src/use.ts", "d2", "d3")) expect(lib("close", "Other").some((c) => c.startsWith(`${s} `))).toBe(false);
    const [p1, o1, d1, d4, d5] = SITES("src/use.ts", "p1", "o1", "d1", "d4", "d5");
    const [f1, h1, q1, n1, r1] = SITES("src/use.ts", "f1", "h1", "q1", "n1", "r1");
    expect(lib("read", "Api")).toEqual(expect.arrayContaining([`${p1} certain`, `${o1} certain`, `${f1} certain`, `${h1} certain`, `${q1} certain`, `${n1} certain`]));
    // A property typed by a function type is a member Pick keeps.
    expect(into(g, symbol(g, "src/use.ts", "read", "Ops"))).toContain(`${r1} certain`);
    // What a kept method returns types the next call; a dropped one's does not.
    const [x1, x2] = SITES("src/use.ts", "x1", "x2");
    expect(lib("run", "A")).toContain(`${x1} certain`);
    expect(lib("run", "B").filter((c) => c.startsWith(`${x2} `))).toEqual([]);
    // A built-in method at the end of a path through a Pick, or on a promise
    // a kept method returns, is the language's own: no unknown.
    for (const s of SITES("src/use.ts", "e1", "x3")) expect(g.unknowns.filter((u) => `${u.file}:${u.line}` === s)).toEqual([]);
    // An Omit whose keys are not all written out is not read.
    expect(lib("read", "Api").filter((c) => c.startsWith(`${SITES("src/use.ts", "q4")[0]} `))).toEqual([]);
    expect(lib("close", "Sessions")).toEqual(expect.arrayContaining([`${d1} certain`, `${d4} certain`]));
    expect(lib("close", "Other")).toContain(`${d5} certain`);
  });

  it("never binds a method two sides of a nested intersection declare", async () => {
    const g = await graphOf({
      "src/lib.ts": "export class A { m(): number { return 1; } }\nexport class B { x(): number { return 2; } }\nexport class C { m(): number { return 3; } }\n",
      "src/use.ts": 'import { A, B, C } from "./lib";\nexport function t(v: A & B & C) { return v.m(); }\n',
    });
    for (const owner of ["A", "C"]) expect(into(g, symbol(g, "src/lib.ts", "m", owner))).toEqual([]);
  });

  it("never reads a Pick or Omit the file declares or imports as the built-in", async () => {
    const g = await graphOf(files);
    const lib = (name: string, owner: string) => into(g, symbol(g, "src/lib.ts", name, owner));
    for (const s of SITES("src/local.ts", "l1")) expect(lib("read", "Api").concat(lib("write", "Api")).filter((c) => c.startsWith(`${s} `))).toEqual([]);
    for (const s of SITES("src/local.ts", "l2")) expect(lib("write", "Api").some((c) => c.startsWith(`${s} `))).toBe(false);
    // The imported Pick is the repository's own interface. Api has its one
    // member, write, so Api matches it by shape: possible, never certain.
    const [i1] = SITES("src/imported.ts", "i1");
    expect(into(g, symbol(g, "src/mine.ts", "write", "Pick"))).toContain(`${i1} certain`);
    expect(lib("read", "Api").filter((c) => c.startsWith(`${i1} `))).toEqual([]);
    expect(lib("write", "Api").filter((c) => c.startsWith(`${i1} `))).toEqual([`${i1} possible`]);
  });
});

describe("a Map's values() is the built-in's only for the built-in Map (2)", () => {
  const files: Record<string, string> = {
    "src/lib.ts": LIB,
    "src/builtin.ts": [
      'import { A } from "./lib";',
      "export function m0(m: Map<string, A>) { for (const x of m.values()) x.run(); } // m0",
      "",
    ].join("\n"),
    "src/local.ts": [
      'import { A, B } from "./lib";',
      "class Map<K, V> {",
      "  values(): B[] { return []; }",
      "}",
      "export function m1(m: Map<string, A>) { for (const x of m.values()) x.run(); } // m1",
      "",
    ].join("\n"),
    "src/mymap.ts": [
      'import { B } from "./lib";',
      "export class ReadonlyMap<K, V> {",
      "  values(): B[] { return []; }",
      "}",
      "",
    ].join("\n"),
    "src/imported.ts": [
      'import { A } from "./lib";',
      'import { ReadonlyMap } from "./mymap";',
      "export function m2(m: ReadonlyMap<string, A>) { for (const x of m.values()) x.run(); } // m2",
      "",
    ].join("\n"),
  };
  const SITES = (path: string, ...markers: string[]) => markers.map((m) => at(files, path, `// ${m}`));

  it("types the loop by the repository's own Map, never by its second type argument", async () => {
    const g = await graphOf(files);
    const runA = into(g, symbol(g, "src/lib.ts", "run", "A"));
    const [m0] = SITES("src/builtin.ts", "m0");
    expect(runA).toContain(`${m0} certain`);
    const [m1, m2] = [...SITES("src/local.ts", "m1"), ...SITES("src/imported.ts", "m2")];
    for (const s of [m1, m2]) expect(runA.filter((c) => c.startsWith(`${s} `))).toEqual([]);
    // The declared values() result types the loop instead.
    expect(into(g, symbol(g, "src/lib.ts", "run", "B"))).toEqual(expect.arrayContaining([`${m1} certain`, `${m2} certain`]));
  });
});

describe("a type nested thousands deep (3)", () => {
  it("builds without a stack overflow, quickly, and still binds a shallow type in the same file", async () => {
    const depth = 3_000;
    const nested = `${"{ next: ".repeat(depth)}{ end: Sessions }${" }".repeat(depth)}`;
    const literal = `${"{ next: ".repeat(depth)}new Sessions()${" }".repeat(depth)}`;
    const files: Record<string, string> = {
      "src/lib.ts": LIB,
      "src/deep.ts": [
        'import { Sessions } from "./lib";',
        `export type Deep = ${nested};`,
        `export function f(d: ${nested}) { return d.next.next.next; }`,
        `export interface I { d: ${nested} }`,
        `export function g() { return ${literal}; }`,
        "export function h(d: { next: { s: Sessions } }) { return d.next.s.close(); } // shallow",
        "",
      ].join("\n"),
    };
    const started = Date.now();
    const g = await graphOf(files);
    expect(Date.now() - started).toBeLessThan(30_000);
    // A shallow type in the same file still binds.
    expect(into(g, symbol(g, "src/lib.ts", "close", "Sessions"))).toContain(`${at(files, "src/deep.ts", "// shallow")} certain`);
  }, 60_000);
});
