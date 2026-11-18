// TypeScript receivers whose type the graph lost, so real callers were
// missed and a caller list held only the test-side callers:
// 1. A member of an interface whose type is a class (`deps.sessions.create()`).
// 2. A member of a type alias of an object type, or of an object type
//    written in place; a method called on the object type itself stays a gap.
// 3. A name bound by destructuring (`const { a } = typed`, nested, renamed,
//    and a destructured parameter).
// 4. A receiver written `x!`, `x?.`, `(x as T)`, typed `Readonly<T>`,
//    `Partial<T>`, `Required<T>` or `A & B` (bound only when exactly one
//    side declares the member).
// 5. A member typed by the interface's type parameter (`Box<T>.value`).
// 6. A function with no declared result: its one provable result, an object
//    literal it returns, `async` and `await`, a result that is another call's.
// 7. The floor examples of a caller list: a same-name gap whose receiver may
//    be the class comes first.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Request } from "../src/query/engine.js";
import { at, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildGraph({ repoRoot: makeRepo(files), store: null });
}

// "file:line tier kind" of each site into `id`, calls and dispatches.
function into(graph: Graph, id: string): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === "calls" || e.kind === "dispatches_to")
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}${e.kind === "dispatches_to" ? " dispatch" : ""}`))
    .sort();
}

// The evidence kind of the site into `id` at `site`.
function evidenceAt(graph: Graph, id: string, site: string): string | undefined {
  for (const e of graph.in.get(id) ?? []) for (const s of e.sites) if (`${s.file}:${s.line}` === site) return s.evidence;
  return undefined;
}

const LIB = [
  "export class TurnHandle {",
  "  stream(): string { return 'e'; }",
  "}",
  "export class SessionHandle {",
  "  async createTurn(): Promise<TurnHandle> { return new TurnHandle(); }",
  "}",
  "export class Sessions {",
  "  async create(id: string): Promise<SessionHandle> { return new SessionHandle(); }",
  "  close() { return 1; }",
  "}",
  "export interface IResolver { resolve(name: string): string }",
  "export class Resolver implements IResolver { resolve(name: string) { return name; } }",
  "// The negative control: the same method names on a class nothing types.",
  "export class Other {",
  "  create(id: string) { return id; }",
  "  close() { return 2; }",
  "  resolve(n: string) { return n; }",
  "  stream() { return ''; }",
  "  async createTurn() { return 3; }",
  "}",
  "",
].join("\n");

const files: Record<string, string> = {
  "lib.ts": LIB,
  "iface.ts": [
    "import { IResolver, SessionHandle, Sessions } from './lib';",
    "export interface Base { sessions: Sessions }",
    "export interface Deps extends Base { readonly resolver?: IResolver; handle: SessionHandle | undefined }",
    "export interface Holder<T> { sessions: Sessions; tag: T }",
    "export function i1(d: Deps) { return d.sessions.close(); } // i1",
    "export function i2(d: Deps) { return d.resolver!.resolve('a'); } // i2",
    "export function i3(d: Holder<number>) { return d.sessions.close(); } // i3",
    "export async function i4(d: Deps) { return d.handle?.createTurn(); } // i4",
    "",
  ].join("\n"),
  "alias.ts": [
    "import { IResolver, Sessions } from './lib';",
    "type AliasDeps = { sessions: Sessions; save(): number };",
    "export function a1(d: AliasDeps) { return d.sessions.close(); } // a1",
    "export function a2(d: AliasDeps) { return d.save(); } // a2",
    "export function a3(input: { resolver: IResolver; names: string[] }) {",
    "  return input.names.map((n) => input.resolver.resolve(n)); // a3",
    "}",
    "export function a4(d: { close(): number }) { return d.close(); } // a4",
    "export function a5(d: { inner: { sessions: Sessions } }) { return d.inner.sessions.close(); } // a5",
    "",
  ].join("\n"),
  "destructure.ts": [
    "import { SessionHandle, Sessions } from './lib';",
    "import type { Deps } from './iface';",
    "export function d1({ sessions }: Deps) { return sessions.close(); } // d1",
    "export function d2(d: Deps) { const { sessions: s } = d; return s.close(); } // d2",
    "export function d3(w: { inner: Deps }) { const { inner: { sessions } } = w; return sessions.close(); } // d3",
    "export function d4({ sessions = new Sessions() }: Deps) { return sessions.close(); } // d4",
    "export async function d5(p: { session: SessionHandle }) {",
    "  const { session } = p;",
    "  const turn = await session.createTurn(); // d5a",
    "  return turn.stream(); // d5b",
    "}",
    "export function d6(d: Deps) { const { sessions, ...rest } = d; return rest.sessions.close(); } // d6",
    "",
  ].join("\n"),
  "wrappers.ts": [
    "import { Other, Sessions } from './lib';",
    "import type { Deps } from './iface';",
    "export function w1(d: Readonly<Deps>) { return d.sessions.close(); } // w1",
    "export function w2(d: Partial<Deps>) { return d.sessions?.close(); } // w2",
    "export function w3(d: Required<Deps>) { return d.resolver.resolve('x'); } // w3",
    "export function w4(d: Pick<Deps, 'sessions'> & { other: Other }) { return d.other.close(); } // w4",
    "export function w5(d: { a: Sessions } & { a: Other }) { return d.a.close(); } // w5",
    "export function w6(x: unknown) { return (x as Sessions).close(); } // w6",
    "export function w7(s: Sessions | null) { return (s)!.close(); } // w7",
    "export function w8(d: Sessions & { extra: number }) { return d.close(); } // w8",
    "export function w9(d: Sessions & Other) { return d.close(); } // w9",
    "type Both = Pick<Deps, 'sessions'> & { other: Other };",
    "export function w10(d: Both) { return d.sessions.close(); } // w10",
    "",
  ].join("\n"),
  "generic.ts": [
    "import { Sessions } from './lib';",
    "export interface Box<T> { value: T; label: string }",
    "export function g1(b: Box<Sessions>) { return b.value.close(); } // g1",
    "export function g2(b: Box<any>) { return b.value.close(); } // g2",
    "",
  ].join("\n"),
  "infer.ts": [
    "import { Other, Sessions } from './lib';",
    "const sessions = new Sessions();",
    "function mk() { return new Sessions(); }",
    "export function r1() { return mk().close(); } // r1",
    "async function mkInferred() { return sessions.create('a'); }",
    "export async function r2() { const s = await mkInferred(); return s.createTurn(); } // r2",
    "export async function r3() { return mkInferred().createTurn(); } // r3",
    "async function makeFixture() {",
    "  const store = new Sessions();",
    "  const session = await store.create('fx');",
    "  return { store, session };",
    "}",
    "export async function r4() {",
    "  const { session, store } = await makeFixture();",
    "  store.close(); // r4a",
    "  const turn = await session.createTurn(); // r4b",
    "  return turn.stream(); // r4c",
    "}",
    "function two(c: boolean) { if (c) return new Sessions(); return new Sessions(); }",
    "export function r5() { return two(true).close(); } // r5",
    "function mixed(c: boolean) { if (c) return new Sessions(); return new Other(); }",
    "export function r6() { return mixed(true).close(); } // r6",
    "function moved() { let s = new Sessions(); s = new Other() as any; return s; }",
    "export function r7() { return moved().close(); } // r7",
    "function fin() { try { return new Sessions(); } finally { return new Other(); } }",
    "export function r8() { return fin().close(); } // r8",
    "function rec(n: number) { return n > 0 ? rec(n - 1) : new Sessions(); }",
    "export function r9() { return rec(1).close(); } // r9",
    "export class Maker { make() { return new Sessions(); } }",
    "export function r10(m: Maker) { return m.make().close(); } // r10",
    "function loose(c: boolean) { if (c) return null; return new Sessions(); }",
    "export function r11() { return loose(true)!.close(); } // r11",
    "function self() { return self(); }",
    "export function r12() { return self().close(); } // r12",
    "declare function describe(name: string, fn: () => void): void;",
    "describe('x', () => {",
    "  async function createSession() { const store = new Sessions(); return { store }; }",
    "  async function use() { const { store } = await createSession(); return store.close(); } // r13",
    "});",
    "function spread(o: object) { return { ...o, store: new Sessions() }; }",
    "export function r14() { return spread({}).store.close(); } // r14",
    "",
  ].join("\n"),
};

const SITES = (path: string, ...markers: string[]) => markers.map((m) => at(files, path, `// ${m}`));

describe("receiver types", () => {
  let g: Graph;
  const lib = (name: string, owner: string) => symbol(g, "lib.ts", name, owner);
  const get = async () => (g ??= await graphOf(files));

  it("binds a member of an interface whose type is a class, through extends, readonly, optional and a generic interface (1)", async () => {
    await get();
    const close = into(g, lib("close", "Sessions"));
    for (const s of SITES("iface.ts", "i1", "i3")) expect(close).toContain(`${s} certain`);
    const [i2] = SITES("iface.ts", "i2");
    expect(into(g, symbol(g, "lib.ts", "resolve", "IResolver"))).toContain(`${i2} certain`);
    expect(into(g, lib("resolve", "Resolver"))).toContain(`${i2} possible dispatch`);
    const [i4] = SITES("iface.ts", "i4");
    expect(into(g, lib("createTurn", "SessionHandle"))).toContain(`${i4} certain`);
  });

  it("binds a path through a member of an alias or an in-place object type, never a method called on the object type itself (2)", async () => {
    await get();
    const close = into(g, lib("close", "Sessions"));
    for (const s of SITES("alias.ts", "a1", "a5")) expect(close).toContain(`${s} certain`);
    const [a3] = SITES("alias.ts", "a3");
    expect(into(g, symbol(g, "lib.ts", "resolve", "IResolver"))).toContain(`${a3} certain`);
    const gaps = g.unknowns.filter((u) => u.file === "alias.ts").map((u) => `${u.line} ${u.name} ${u.cause}`);
    const [a2, a4] = SITES("alias.ts", "a2", "a4").map((s) => Number(s.split(":")[1]));
    expect(gaps).toContain(`${a2} save untyped-receiver`);
    expect(gaps).toContain(`${a4} close untyped-receiver`);
    expect(close.some((s) => s.startsWith(`alias.ts:${a4} `))).toBe(false);
  });

  it("types names bound by destructuring: parameters, renames, nested patterns; a default or a rest stays a gap (3)", async () => {
    await get();
    const close = into(g, lib("close", "Sessions"));
    for (const s of SITES("destructure.ts", "d1", "d2", "d3")) expect(close).toContain(`${s} certain`);
    for (const s of SITES("destructure.ts", "d4", "d6")) expect(close.some((c) => c.startsWith(`${s} `))).toBe(false);
    const [d5a, d5b] = SITES("destructure.ts", "d5a", "d5b");
    expect(into(g, lib("createTurn", "SessionHandle"))).toContain(`${d5a} certain`);
    expect(into(g, lib("stream", "TurnHandle"))).toContain(`${d5b} certain`);
  });

  it("reads through non-null, optional chaining, casts, Readonly, Partial, Required, Pick and intersections (4)", async () => {
    await get();
    const close = into(g, lib("close", "Sessions"));
    for (const s of SITES("wrappers.ts", "w1", "w2", "w6", "w7", "w8", "w10")) expect(close).toContain(`${s} certain`);
    const [w3] = SITES("wrappers.ts", "w3");
    expect(into(g, symbol(g, "lib.ts", "resolve", "IResolver"))).toContain(`${w3} certain`);
    const [w4] = SITES("wrappers.ts", "w4");
    expect(into(g, lib("close", "Other"))).toContain(`${w4} certain`);
    // Both sides declare the member: no edge to either.
    for (const s of SITES("wrappers.ts", "w5", "w9")) {
      expect(close.some((c) => c.startsWith(`${s} `))).toBe(false);
      expect(into(g, lib("close", "Other")).some((c) => c.startsWith(`${s} `))).toBe(false);
    }
  });

  it("substitutes a type argument for a member typed by the interface's type parameter (5)", async () => {
    await get();
    const close = into(g, lib("close", "Sessions"));
    const [g1, g2] = SITES("generic.ts", "g1", "g2");
    expect(close).toContain(`${g1} certain`);
    expect(close.some((c) => c.startsWith(`${g2} `))).toBe(false);
    expect(g.unknowns.some((u) => u.file === "generic.ts" && `generic.ts:${u.line}` === g2 && u.name === "close")).toBe(true);
  });

  it("infers a result no annotation declares, only where it is proved (6)", async () => {
    await get();
    const close = into(g, lib("close", "Sessions"));
    const [r1, r5, r4a, r11, r13, r14] = SITES("infer.ts", "r1", "r5", "r4a", "r11", "r13", "r14");
    for (const s of [r1, r5, r4a, r11, r13, r14]) expect(close).toContain(`${s} certain`);
    expect(evidenceAt(g, lib("close", "Sessions"), r1 as string)).toBe("receiver-inferred");
    const [r2, r4b, r4c, r3] = SITES("infer.ts", "r2", "r4b", "r4c", "r3");
    expect(into(g, lib("createTurn", "SessionHandle"))).toContain(`${r2} certain`);
    expect(into(g, lib("createTurn", "SessionHandle"))).toContain(`${r4b} certain`);
    expect(into(g, lib("stream", "TurnHandle"))).toContain(`${r4c} certain`);
    // An unawaited promise is never its payload.
    expect(into(g, lib("createTurn", "SessionHandle")).some((c) => c.startsWith(`${r3} `))).toBe(false);
    // A method may be overridden: its body's result is likely, not certain.
    const [r10] = SITES("infer.ts", "r10");
    expect(close).toContain(`${r10} likely`);
    // Results that disagree, a reassigned local, a finally return, recursion: no edge.
    for (const s of SITES("infer.ts", "r6", "r7", "r8", "r9", "r12")) {
      expect(close.some((c) => c.startsWith(`${s} `))).toBe(false);
      expect(into(g, lib("close", "Other")).some((c) => c.startsWith(`${s} `))).toBe(false);
    }
  });

  it("never gives the unrelated class with the same method names a certain edge", async () => {
    await get();
    for (const name of ["create", "close", "resolve", "stream", "createTurn"]) {
      const certain = into(g, lib(name, "Other")).filter((s) => s.endsWith(" certain"));
      expect(certain.filter((s) => !s.startsWith("wrappers.ts:"))).toEqual([]);
    }
  });
});

describe("floor examples", () => {
  it("lists first the same-name gaps whose receiver may be the class (7)", async () => {
    const many: Record<string, string> = { "lib.ts": LIB };
    for (let i = 0; i < 6; i++) many[`a${i}.ts`] = `export function f${i}(thing: any) { return thing.close(); }\n`;
    many["z.ts"] = "export function z(sessions: any) { return sessions.close(); }\n";
    const graph = await graphOf(many);
    const s = { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
    const a = query(s, { apiVersion: 1, kind: "callers", target: { id: symbol(graph, "lib.ts", "close", "Sessions") } } as Request, {});
    expect(a.unknown.examples?.[0]?.file).toBe("z.ts");
    // The count stays every same-name gap in the repository.
    expect(a.unknown.causes["untyped-receiver"]).toBe(7);
  });
});

describe("structural lookups on cyclic types", () => {
  it("finishes fast on self-referencing, mutually recursive and long alias chains, and leaves an unknown", async () => {
    const chain = Array.from({ length: 60 }, (_, i) => `type C${i} = C${i + 1};`).join("\n");
    const g = await graphOf({
      "lib.ts": LIB,
      "cycles.ts": [
        "import { Sessions } from './lib';",
        "type A = { b: B; m(): void };",
        "type B = { a: A };",
        "interface I { j: J }",
        "interface J { i: I }",
        "type S = S;",
        "type T = T & T & T & T & T & T & T & T;",
        "type U = { u: U } & { u: U } & { u: U } & { u: U };",
        "type V = W & W; type W = V & V;",
        chain,
        "type C60 = { s: Sessions };",
        "type Loop0 = Loop1; type Loop1 = Loop0;",
        "interface Base extends Back { own: number }",
        "type Back = Base;",
        "export function f(x: A, y: I, s: S, t: T, u: U, v: V, c: C0, l: Loop0, b: Base) {",
        "  x.b.a.b.a.b.a.b.a.b.a.m(); // cyc-a",
        "  y.j.i.j.i.j.i.go(); // cyc-i",
        "  s.p.close(); // cyc-s",
        "  t.p.q.close(); // cyc-t",
        "  t.close(); // cyc-t2",
        "  u.u.u.u.u.u.u.u.close(); // cyc-u",
        "  v.p.close(); // cyc-v",
        "  v.close(); // cyc-v2",
        "  c.s.close(); // cyc-c",
        "  l.p.close(); // cyc-l",
        "  b.p.close(); // cyc-b",
        "  b.own.p.close(); // cyc-b2",
        "}",
        "",
      ].join("\n"),
    });
    const gaps = g.unknowns.filter((u) => u.file === "cycles.ts");
    // Every call on a cyclic type is a gap, none an edge.
    expect(gaps.filter((u) => u.name === "close").length).toBeGreaterThanOrEqual(9);
    const close = into(g, symbol(g, "lib.ts", "close", "Sessions"));
    expect(close.filter((c) => c.startsWith("cycles.ts:"))).toEqual([]);
  }, 20_000);
});
