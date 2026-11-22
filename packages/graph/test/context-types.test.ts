// Types a TypeScript call takes from where it stands, each from trueforge:
// 1. `this.m()` in an instance field initializer runs on the instance. Read
//    as static, it missed the instance method, or bound certain to a static
//    method of the same name (Sandbox.ts:236). A static field initializer
//    stays static, and a Ruby class body keeps calling class methods.
// 2. A function-valued const declared inside an anonymous callback (a test
//    body) or in a block at the top of a module is a definition of that
//    scope, so a bare call of it binds instead of reading as dynamic. A
//    `let` given another value stays unbound.
// 3. A callback handed to an array's own iteration method takes the
//    element type as its first parameter, and a for-of loop over a call,
//    a field of `this` or a Map's values() takes the element, only when
//    the collection is declared as an array, a set or (for values()) a
//    Map. Anything else stays unknown.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildGraph({ repoRoot: makeRepo(files), store: null });
}

// "file:line tier" of each call site into `id`.
function tiers(graph: Graph, id: string): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === "calls")
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))
    .sort();
}

// The id of the definition named `name` at `line` of `file`.
function defAt(graph: Graph, file: string, name: string, line: number): string {
  const hit = (graph.defsByFile.get(file) ?? []).find((n) => n.name === name && n.id.includes(`@${line}:`));
  if (!hit) throw new Error(`no ${name} at ${file}:${line}`);
  return hit.id;
}

describe("this in a field initializer (1)", () => {
  it("binds an instance field initializer to the instance method and a static one to the static method", async () => {
    const g = await graphOf({
      "src/box.ts": [
        "export class Box {",
        "  private all = [() => this.open()];",
        "  static presets = [() => this.open()];",
        "  handler = () => this.open();",
        "  open(): number {",
        "    return 1;",
        "  }",
        "  static open(): number {",
        "    return 2;",
        "  }",
        "  table = { go() { return this.open(); } };",
        "}",
        "",
      ].join("\n"),
    });
    expect(tiers(g, defAt(g, "src/box.ts", "open", 5))).toEqual(["src/box.ts:2 certain", "src/box.ts:4 certain"]);
    // `this` in the object's own method is the object: neither side of the class.
    expect(tiers(g, defAt(g, "src/box.ts", "open", 8))).toEqual(["src/box.ts:3 certain"]);
  });

  it("never binds this in a function or an object method nested in a class to the class, and keeps arrows bound", async () => {
    const g = await graphOf({
      "src/a.ts": [
        "export class A {",
        "  run(): number {",
        "    const o = { go() { return this.x(); } };",
        "    const f = function () { return this.x(); };",
        "    function g() { return this.x(); }",
        "    const h = () => this.x();",
        "    [1].forEach(() => this.x());",
        "    const k = function () { return () => this.x(); };",
        "    return o.go() + f() + g() + h() + k()();",
        "  }",
        "  x(): number {",
        "    return 1;",
        "  }",
        "  static x(): number {",
        "    return 2;",
        "  }",
        "  static presets = [{ go() { return this.x(); } }, function () { return this.x(); }];",
        "  static arrows = [() => this.x()];",
        "  later = function () { return this.x(); };",
        "}",
        "",
      ].join("\n"),
    });
    // Line 6 is an arrow too, but a const arrow is a definition of its own,
    // whose `this` the resolver does not follow yet: unbound, never wrong.
    expect(tiers(g, defAt(g, "src/a.ts", "x", 11))).toEqual(["src/a.ts:19 certain", "src/a.ts:7 certain"]);
    expect(tiers(g, defAt(g, "src/a.ts", "x", 14))).toEqual(["src/a.ts:18 certain"]);
    const unknown = g.unknowns.filter((u) => u.name === "x").map((u) => u.line);
    for (const line of [3, 4, 5, 8, 17]) expect(unknown).toContain(line);
  });

  it("keeps a class nested in an instance initializer reading its own static fields as static", async () => {
    const g = await graphOf({
      "src/outer.ts": [
        "export class Outer {",
        "  kind = class Inner {",
        "    static made = this.make();",
        "    static make(): number {",
        "      return 1;",
        "    }",
        "    make(): number {",
        "      return 2;",
        "    }",
        "  };",
        "}",
        "",
      ].join("\n"),
    });
    expect(tiers(g, defAt(g, "src/outer.ts", "make", 7))).toEqual([]);
  });

  it("leaves a Ruby class body calling the class method", async () => {
    const g = await graphOf({
      "app/model.rb": ["class Model", "  def self.configure", "    1", "  end", "", "  def configure", "    2", "  end", "", "  configure", "end", ""].join("\n"),
    });
    expect(tiers(g, defAt(g, "app/model.rb", "configure", 2))).toEqual(["app/model.rb:10 certain"]);
    expect(tiers(g, defAt(g, "app/model.rb", "configure", 6))).toEqual([]);
  });
});

describe("a function-valued const in a callback or a module block (2)", () => {
  const files = {
    "src/run.test.ts": [
      "declare function it(name: string, fn: () => void): void;",
      "export function work(): number {",
      "  return 1;",
      "}",
      'it("a", () => {',
      "  const run = () => work();",
      "  run();",
      "});",
      'it("b", () => {',
      "  const run = () => work() + 1;",
      "  run();",
      "  let step = () => work();",
      "  step = () => 2;",
      "  step();",
      "});",
      "if (process.env.CI) {",
      "  const shutdown = () => work();",
      "  shutdown();",
      "}",
      "",
    ].join("\n"),
  };

  it("binds each call to the const of its own callback or block", async () => {
    const g = await graphOf(files);
    expect(tiers(g, defAt(g, "src/run.test.ts", "run", 6))).toEqual(["src/run.test.ts:7 certain"]);
    expect(tiers(g, defAt(g, "src/run.test.ts", "run", 10))).toEqual(["src/run.test.ts:11 certain"]);
    expect(tiers(g, defAt(g, "src/run.test.ts", "shutdown", 17))).toEqual(["src/run.test.ts:18 certain"]);
    const dynamic = g.unknowns.filter((u) => u.cause === "dynamic").map((u) => `${u.line} ${u.name}`);
    expect(dynamic).not.toContain("7 run");
    expect(dynamic).not.toContain("18 shutdown");
  });

  it("never binds a let given another value, and keeps the defs out of the module's names", async () => {
    const g = await graphOf({ ...files, "src/other.ts": 'import { run } from "./run.test";\nexport const x = run();\n' });
    const fns = (g.defsByFile.get("src/run.test.ts") ?? []).map((n) => n.name);
    expect(fns).not.toContain("step");
    expect(g.unknowns.some((u) => u.line === 14 && u.name === "step")).toBe(true);
    const runs = (g.defsByFile.get("src/run.test.ts") ?? []).filter((n) => n.name === "run").map((n) => n.id);
    for (const id of runs) expect(tiers(g, id).filter((s) => s.startsWith("src/other.ts"))).toEqual([]);
  });
});

describe("callback parameters and loop variables (3)", () => {
  const server = [
    "export class Server {",
    "  listTools(): string[] {",
    "    return [];",
    "  }",
    "}",
    "export class Coll {",
    "  forEach(fn: (s: Server) => void): void {}",
    "}",
    "export class Registry {",
    "  all(): Server[] {",
    "    return [];",
    "  }",
    "  set(): Set<Server> {",
    "    return new Set();",
    "  }",
    "  one(): Server {",
    "    return new Server();",
    "  }",
    "  async later(): Promise<Server[]> {",
    "    return [];",
    "  }",
    "  coll(): Coll {",
    "    return new Coll();",
    "  }",
    "  byName(): Map<string, Server> {",
    "    return new Map();",
    "  }",
    "}",
    "export function getServers(): ReadonlyArray<Server> {",
    "  return [];",
    "}",
    "",
  ].join("\n");

  it("types the element of a declared array or set, from a parameter, a local or a call", async () => {
    const g = await graphOf({
      "src/server.ts": server,
      "src/use.ts": [
        'import { Registry, Server, getServers } from "./server";',
        "export function use(servers: Server[], registry: Registry, pool: Set<Server>): void {",
        "  servers.forEach((s) => s.listTools());",
        "  servers.filter(function (s) { return s.listTools().length > 0; });",
        "  pool.forEach((s) => s.listTools());",
        "  registry.all().map((s) => s.listTools());",
        "  for (const s of getServers()) s.listTools();",
        "  for (const s of registry.set()) s.listTools();",
        "  const all = registry.all();",
        "  all.some((s) => s.listTools());",
        "}",
        "",
      ].join("\n"),
    });
    const id = symbol(g, "src/server.ts", "listTools", "Server");
    expect(tiers(g, id)).toEqual([3, 4, 5, 6, 7, 8, 10].map((l) => `src/use.ts:${l} certain`).sort());
  });

  it("leaves anything not declared as an array or a set unknown", async () => {
    const g = await graphOf({
      "src/server.ts": server,
      "src/use.ts": [
        'import { Registry, Server } from "./server";',
        "export async function use(registry: Registry, items, servers: Server[]): Promise<void> {",
        "  items.forEach((s) => s.listTools());",
        "  for (const s of registry.one()) s.listTools();",
        "  for (const s of await registry.later()) s.listTools();",
        "  registry.coll().forEach((s) => s.listTools());",
        "  for (const s of registry.byName().values()) s.listTools();",
        "  servers.reduce((acc, s) => acc.listTools(), servers[0]);",
        "  servers.map((s, i) => i.listTools());",
        "}",
        "",
      ].join("\n"),
    });
    const id = symbol(g, "src/server.ts", "listTools", "Server");
    // Only the declared Coll.forEach binds; nothing reaches Server.listTools
    // certain (a Map a call returns is not followed into its values).
    expect(tiers(g, id).filter((s) => s.endsWith("certain"))).toEqual([]);
  });

  it("types the element of a field of this and of a declared Map's values(), and nothing else of a Map", async () => {
    const g = await graphOf({
      "src/server.ts": server,
      "src/pool.ts": [
        'import { Server } from "./server";',
        "export class Pool {",
        "  private servers: Server[] = [];",
        "  private byName: Map<string, Server> = new Map();",
        "  private groups: Map<string, Server[]> = new Map();",
        "  run(local: ReadonlyMap<string, Server>): void {",
        "    for (const s of this.servers) s.listTools();",
        "    this.servers.forEach((s) => s.listTools());",
        "    for (const s of this.byName.values()) s.listTools();",
        "    for (const s of local.values()) s.listTools();",
        "    for (const e of this.byName) e.listTools();",
        "    for (const s of this.groups.values()) s.listTools();",
        "    this.byName.forEach((s) => s.listTools());",
        "  }",
        "  static all(): void {",
        "    for (const s of this.servers) s.listTools();",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    const id = symbol(g, "src/server.ts", "listTools", "Server");
    expect(tiers(g, id)).toEqual([10, 7, 8, 9].map((l) => `src/pool.ts:${l} certain`));
  });
});

describe("a callback's parameters from the declared function type it is passed as (4)", () => {
  const tracing = [
    "export interface Span {",
    "  setOutput(o: string): void;",
    "}",
    "export interface Tracing {",
    "  withSpan<T>(name: string, operation: (span: Span) => Promise<T>): Promise<T>;",
    "  generic<S>(operation: (s: S) => void): void;",
    "  loose(operation: Function): void;",
    "}",
    "export function span<T>(name: string, fn: (s: Span, depth: number) => T): T {",
    "  return fn({ setOutput() {} }, 0);",
    "}",
    "export class Box<V> {",
    "  each(fn: (v: V) => void): void {}",
    "}",
    "export class Item {",
    "  setOutput(o: string): void {}",
    "}",
    "// A class that shares a type parameter's name: never what `S` means in generic.",
    "export class S {",
    "  setOutput(o: string): void {}",
    "}",
    "",
  ].join("\n");

  it("types each untyped parameter of the callback by the declared function type", async () => {
    const g = await graphOf({
      "src/tracing.ts": tracing,
      "src/use.ts": [
        'import { span, type Tracing } from "./tracing";',
        "export class Tool {",
        "  constructor(private tracing: Tracing) {}",
        "  run(): Promise<number> {",
        '    return this.tracing.withSpan("x", async (span) => {',
        '      span.setOutput("a");',
        "      return 1;",
        "    });",
        "  }",
        "}",
        'export function plain(): void {',
        '  span("y", (s) => s.setOutput("b"));',
        "}",
        "",
      ].join("\n"),
    });
    const id = symbol(g, "src/tracing.ts", "setOutput", "Span");
    expect(tiers(g, id)).toEqual(["src/use.ts:12 certain", "src/use.ts:6 certain"]);
  });

  it("leaves a parameter typed by a type parameter, a loose function type or an unknown callee unbound", async () => {
    const g = await graphOf({
      "src/tracing.ts": tracing,
      "src/use.ts": [
        'import { Box, Item, type Tracing } from "./tracing";',
        "declare function external(fn: (s: unknown) => void): void;",
        "export function use(tracing: Tracing, box: Box<Item>, other): void {",
        "  tracing.generic((s) => s.setOutput(\"a\"));",
        "  tracing.loose((s) => s.setOutput(\"b\"));",
        "  box.each((v) => v.setOutput(\"c\"));",
        "  other.withSpan(\"x\", (s) => s.setOutput(\"d\"));",
        "  external((s) => s.setOutput(\"e\"));",
        "  tracing.withSpan(\"x\", (s, extra) => extra.setOutput(\"f\"));",
        "}",
        "",
      ].join("\n"),
    });
    for (const owner of ["Span", "Item", "S"]) {
      const id = symbol(g, "src/tracing.ts", "setOutput", owner);
      expect(tiers(g, id).filter((s) => s.startsWith("src/use.ts") && s.endsWith("certain"))).toEqual([]);
    }
  });
});
