// What an answer says it could not see: the files of a language the build
// does not read, its gaps grouped by cause, and whether its list is whole.
//
// Ways it could fail, written before the code:
//  1. A question about Rust code (a name defined only in a .rs file, or
//     the file itself) answers not-found, or an empty search, with floor
//     false: an agent reads "no such code" where the build never read the
//     code. Every question that takes a name or a file, `symbol` and
//     `importers` included.
//  2. A listing that is not about one symbol (search, routes) leaves the
//     unread files out of its floor, though a hit or a route may be there.
//  3. Every answer of a mixed repository carries the Rust files, so a
//     TypeScript caller list in a repository with one Rust crate is always
//     a floor and agents learn to ignore it. Rust code cannot call a
//     TypeScript function by name; Kotlin and Scala code can call Java.
//  4. A Java symbol's callers in a repository with Kotlin files are
//     answered as whole, though Kotlin code calls Java methods by name.
//  5. A long list of gaps reaches the reader as ten sentences and "and N
//     more", with no count per cause; or the grouping replaces the old
//     fields, so a reader of `reasons` or `causes` breaks; or a group's
//     count disagrees with `causes` for the same cause.
//  6. A list on a floor gives no field that says the list is incomplete,
//     so a reader of the counts takes "2 certain" as every caller.
//
// The list floor of a function or method (the escape corpus holds the
// shapes of a function that escapes; these hold the narrowing and the
// change):
//  7. A plain function is a floor because of a member call on a typed
//     value (`items.push(1)` on an array) or a parameter of its name (a
//     Promise executor's `resolve`), though neither can run it; or a class
//     method of the same name loses its floor with it (test 10).
//  8. A call in another language makes a TypeScript function a floor: an
//     unbound `x.get()` in Go cannot call a TypeScript `get` (test 11).
//  9. A family the new rules do not read yet (Python, Ruby) loses its
//     floor: a decorated function, a function passed as a callback, or a
//     method a Rails callback names by a symbol (test 13).
// 10. A change removes a function still passed as a value, and the removed
//     function reads as having no hidden caller (test 16); or the module
//     gave it out under another name (`export { f as g }`), so the current
//     export table no longer holds the name that escapes.
// 11. The review brief keeps the old noise (a function with no caller and
//     no value use is a floor), or loses a real one (a function passed
//     through a ternary reads as having no caller) (test 17).
// 12. A floor whose hidden callers can only be in test files loses its
//     floor, so a zero reads as "unused"; or one place in product code
//     beside them still reads as "complete in product code"; or a place in
//     a folder named like tooling (`scripts/`, `benchmark/`, a package's
//     `scripts/` or `corpus/`) reads as outside product code, though it can
//     hold an entry point that ships.
// 13. A Ruby `respond_to?(:save)`, which only asks whether the method is
//     there, is read as a call of `save`, so `save` reads as maybe called.
// 14. A script's function keeps one reach row per place that builds a name
//     at run time, so many such places make the build and its index grow
//     with places times functions, though the reason names the first.
import { afterAll, describe, expect, it } from "vitest";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact, renderImpactBlock } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request, Session } from "../src/query/answer.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

type Floored = Answer & { listIncomplete?: boolean; unknown: Answer["unknown"] & { groups?: { cause: string; count: number | null; places?: number; examples: string[] }[] } };

const MIXED = {
  "package.json": JSON.stringify({ name: "mixed", private: true, type: "module", dependencies: { hono: "^4.6.0" }, devDependencies: { vitest: "^2.0.0" } }),
  "src/app.ts": 'import { Hono } from "hono";\nimport { load } from "./load";\nexport const app = new Hono();\napp.get("/users", (c) => c.json(load()));\n',
  "src/load.ts": "export class Store {\n  get(): number {\n    return 1;\n  }\n}\nexport class Disk extends Store {\n  get(): number {\n    return 2;\n  }\n}\nexport function load(): number {\n  return helper();\n}\nexport function helper(): number {\n  return new Disk().get();\n}\n",
  "src/load.test.ts": 'import { it } from "vitest";\nimport { load } from "./load";\nit("loads", () => {\n  load();\n});\n',
  "core/Cargo.toml": '[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n',
  "core/src/lib.rs": "pub fn get_user(id: u32) -> u32 { id }\npub fn rust_helper() -> u32 { get_user(1) }\n",
  "core/src/main.rs": "use core::rust_helper;\nfn main() { let _ = rust_helper(); }\n",
};
const RUST_REASON = "2 Rust files not read: Rust is not supported by this build";

async function sessionOf(files: Record<string, string>): Promise<Session> {
  const graph = await buildGraph({ repoRoot: makeRepo(files), store: null });
  return { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
}
const ask = (s: Session, req: Omit<Request, "apiVersion">): Floored => query(s, { apiVersion: 1, ...req } as Request) as Floored;

describe("files of a language the build does not read", () => {
  it("sets the floor with the count on every question about code the build did not read (1)", async () => {
    const s = await sessionOf(MIXED);
    const asked: Omit<Request, "apiVersion">[] = [
      { kind: "callers", target: { name: "get_user" } },
      { kind: "callees", target: { name: "get_user" } },
      { kind: "impact", target: { name: "get_user" } },
      { kind: "references", target: { name: "get_user" } },
      { kind: "implementers", target: { name: "get_user" } },
      { kind: "tests", target: { name: "get_user" } },
      { kind: "path", target: { name: "rust_helper" }, to: { name: "get_user" } },
      { kind: "symbol", target: { name: "get_user" } },
      { kind: "importers", target: { file: "core/src/lib.rs" } },
      { kind: "outline", target: { file: "core/src" } },
      { kind: "search", text: "get_user" },
    ];
    for (const req of asked) {
      const a = ask(s, req);
      expect(a.error?.code ?? null, req.kind).toBe(req.kind === "search" ? null : "not-found");
      expect(a.unknown.floor, req.kind).toBe(true);
      expect(a.unknown.reasons, req.kind).toContain(RUST_REASON);
      expect(a.unknown.causes["language-not-read"], req.kind).toBe(2);
    }
  }, 60_000);

  it("sets the floor on listings that are not about one symbol: search hits and routes (2)", async () => {
    const s = await sessionOf(MIXED);
    const search = ask(s, { kind: "search", text: "load" });
    expect(search.leads.length).toBeGreaterThan(0);
    expect(search.unknown.reasons).toContain(RUST_REASON);
    const routes = ask(s, { kind: "routes" });
    expect(routes.error).toBeNull();
    expect(routes.items.length).toBe(1);
    expect(routes.unknown.floor).toBe(true);
    expect(routes.unknown.reasons).toContain(RUST_REASON);
  }, 60_000);

  it("leaves a TypeScript symbol's answers whole: Rust code cannot call it by name (3)", async () => {
    const s = await sessionOf(MIXED);
    const asked: Omit<Request, "apiVersion">[] = [
      { kind: "callers", target: { name: "load" } },
      { kind: "callees", target: { name: "load" } },
      { kind: "impact", target: { name: "load" } },
      { kind: "references", target: { name: "load" } },
      { kind: "implementers", target: { name: "Store" } },
      { kind: "tests", target: { name: "load" } },
      { kind: "path", target: { name: "load" }, to: { name: "helper" } },
      { kind: "routes", target: { name: "load" } },
    ];
    for (const req of asked) {
      const a = ask(s, req);
      expect(a.error, req.kind).toBeNull();
      expect(a.unknown.reasons.join(" "), req.kind).not.toMatch(/Rust/);
      expect(a.unknown.causes["language-not-read"], req.kind).toBeUndefined();
    }
    // The same build answers whole where nothing else is unknown.
    expect(ask(s, { kind: "callers", target: { name: "helper" } }).unknown.floor).toBe(false);
  }, 60_000);

  it("sets the floor on a Java symbol's callers when Kotlin or Scala files were not read, and not for Rust (4)", async () => {
    const java = {
      "src/main/java/demo/A.java": "package demo;\npublic class A {\n  public int run() {\n    return 1;\n  }\n  public int twice() {\n    return run() + run();\n  }\n}\n",
      "src/main/kotlin/demo/B.kt": "package demo\nfun b() = A().run()\n",
      "native/lib.rs": "pub fn n() {}\n",
    };
    const s = await sessionOf(java);
    const a = ask(s, { kind: "callers", target: { name: "A.run" } });
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons).toContain("1 Kotlin file not read: Kotlin is not supported by this build");
    expect(a.unknown.reasons.join(" ")).not.toMatch(/Rust/);
  }, 60_000);
});

describe("the gaps of an answer grouped by cause", () => {
  it("groups the gaps with one count and at most two examples each, and keeps reasons and causes (5)", async () => {
    // Three files with a region no parser can read: three gaps of one cause.
    const broken = Object.fromEntries([1, 2, 3].map((i) => [`src/broken${i}.ts`, `export function b${i}( {\n  return ;\n}\nexport const c${i} = f(;\nexport const d${i} = g(;\n`]));
    const s = await sessionOf({ ...MIXED, ...broken });
    const routes = ask(s, { kind: "routes" });
    expect(routes.unknown.reasons.length).toBeGreaterThan(0);
    expect(Object.keys(routes.unknown.causes)).toContain("file-not-parsed");
    const groups = routes.unknown.groups ?? [];
    for (const g of groups) expect(g.count, g.cause).toBe(routes.unknown.causes[g.cause] ?? null);
    const parse = groups.find((g) => g.cause === "file-not-parsed");
    expect(parse?.count).toBeGreaterThanOrEqual(3);
    // One place per broken file, whatever its regions.
    expect(parse?.places).toBe(3);
    expect(parse?.examples.length).toBe(2);
    expect(parse?.examples[0]).toMatch(/src\/broken\d\.ts:\d+/);
    expect(groups.find((g) => g.cause === "language-not-read")).toEqual({ cause: "language-not-read", count: 2, examples: [RUST_REASON] });
    // Each cause once.
    expect(new Set(groups.map((g) => g.cause)).size).toBe(groups.length);
  }, 60_000);

  it("groups a caller list's unbound calls by their cause (5)", async () => {
    const s = await sessionOf({
      "src/a.ts": "export function save(): number {\n  return 1;\n}\n",
      "src/b.ts": "export function run(x: any, y: any, z: any): void {\n  x.save();\n  y.save();\n  z.save();\n}\n",
    });
    const a = ask(s, { kind: "callers", target: { name: "save" } });
    expect(a.unknown.floor).toBe(true);
    const total = Object.values(a.unknown.causes).reduce<number>((k, v) => k + (v ?? 0), 0);
    const groups = a.unknown.groups ?? [];
    expect(groups.length).toBe(Object.keys(a.unknown.causes).length);
    expect(groups.reduce((k, g) => k + (g.count ?? 0), 0)).toBe(total);
    for (const g of groups) expect(g.examples.length).toBeLessThanOrEqual(2);
    expect(groups.some((g) => g.examples.some((e) => e.startsWith("src/b.ts:")))).toBe(true);
  }, 60_000);
});

describe("a list on a floor", () => {
  it("says the list is incomplete beside the counts, and whole when it is (6)", async () => {
    const s = await sessionOf(MIXED);
    const whole = ask(s, { kind: "callers", target: { name: "helper" } });
    expect(whole.counts.certain).toBe(1);
    expect(whole.listIncomplete).toBe(false);
    const floor = ask(s, { kind: "routes" });
    expect(floor.unknown.floor).toBe(true);
    expect(floor.listIncomplete).toBe(true);
    // The tiers are untouched.
    expect(Object.keys(floor.counts).sort()).toEqual(["certain", "likely", "possible"]);
  }, 60_000);
});

// A change on a real repository: the graph of the current files with the base.
async function changed(before: Record<string, string>, after: Record<string, string>) {
  const root = makeRepo(before);
  commitAll(root);
  writeFiles(root, after);
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
  return detectImpact(graph, change);
}
const seedOf = (impact: Awaited<ReturnType<typeof changed>>, name: string) => impact.unknown.seeds.find((s) => s.seed.includes(`#${name}@`));

describe("the list floor of a function", () => {
  it("clears a plain function whose name is only called on a typed array or as a parameter, and keeps the method of that name (7)", async () => {
    const s = await sessionOf({
      "src/a.ts": "export function push(n: number): number {\n  return n;\n}\nexport function resolve(): number {\n  return 1;\n}\nexport class Stack {\n  push(n: number): void {}\n}\n",
      "src/b.ts": "export function fill(): Promise<number> {\n  const items: number[] = [];\n  items.push(1);\n  return new Promise<number>((resolve) => resolve(items.length));\n}\n",
    });
    expect(ask(s, { kind: "callers", target: { name: "push" } }).unknown.floor).toBe(false);
    expect(ask(s, { kind: "callers", target: { name: "resolve" } }).unknown.floor).toBe(false);
    expect(ask(s, { kind: "callers", target: { name: "Stack.push" } }).unknown.floor).toBe(true);
  }, 60_000);

  it("clears a TypeScript function that a Go call of the same name cannot reach (8)", async () => {
    const s = await sessionOf({
      "src/a.ts": "export function get(): number {\n  return 1;\n}\n",
      "src/b.ts": 'import { get } from "./a";\nexport function use(): number {\n  return get();\n}\n',
      "go.mod": "module demo\n\ngo 1.21\n",
      "main.go": "package main\n\ntype getter interface{ get() int }\n\nfunc run(x getter) int {\n\treturn x.get()\n}\n",
    });
    const a = ask(s, { kind: "callers", target: { name: "get", file: "src/a.ts" } } as Omit<Request, "apiVersion">);
    expect(a.counts.certain).toBe(1);
    expect(a.unknown.floor, a.unknown.reasons.join("; ")).toBe(false);
  }, 60_000);

  it("keeps a decorated Python function and a Python callback on the floor with the reason they had (9)", async () => {
    const s = await sessionOf({
      "app.py": "def wrap(fn):\n    return fn\n\n\n@wrap\ndef handler():\n    return 1\n\n\ndef call(cb):\n    return cb()\n\n\ndef target():\n    return 2\n\n\ncall(target)\n",
    });
    for (const name of ["handler", "target"]) {
      const a = ask(s, { kind: "callers", target: { name } });
      expect(a.unknown.floor, name).toBe(true);
      expect(a.unknown.reasons.join(" "), name).toMatch(/through a value \(a callback or a computed member\) in the repository root project, and could reach it/);
    }
  }, 60_000);

  it("keeps a Ruby method a callback names by a symbol on the floor with the reason it had (9)", async () => {
    const s = await sessionOf({
      "app/controllers/posts_controller.rb": "class PostsController\n  before_action :set_post\n\n  def show\n    @post\n  end\n\n  def set_post\n    @post = 1\n  end\nend\n",
      "web/run.js": "export function run(f) {\n  return f();\n}\n",
    });
    const a = ask(s, { kind: "callers", target: { name: "PostsController.set_post" } });
    expect(a.unknown.floor, a.unknown.reasons.join("; ")).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/through a value \(a callback or a computed member\) in the repository root project, and could reach it/);
  }, 60_000);

  it("reads no call in a Ruby respond_to? (13)", async () => {
    const s = await sessionOf({
      "app/models/store.rb": "class Store\n  def save\n    1\n  end\nend\n",
      "app/check.rb": "def check(x)\n  x.respond_to?(:save)\nend\n",
    });
    const a = ask(s, { kind: "callers", target: { name: "Store.save" } });
    expect(a.unknown.floor, a.unknown.reasons.join("; ")).toBe(false);
  }, 60_000);

  it("keeps one reach row of each kind for a script's function, however many places build a name at run time (14)", async () => {
    const evals = Array.from({ length: 40 }, (_, i) => `window[location.hash + "${i}"]();\neval(location.hash + "${i}");\n`).join("");
    const s = await sessionOf({ "public/a.js": "function f() {}\nfunction g() {}\n", "public/b.js": evals });
    for (const name of ["f", "g"]) {
      const a = ask(s, { kind: "callers", target: { name, file: "public/a.js" } } as Omit<Request, "apiVersion">);
      expect(a.unknown.floor).toBe(true);
      expect(a.unknown.reasons.join(" ")).toContain("public/b.js:1 reaches the global scope by a name built at run time, and it can see this function");
      const id = (a as { target?: { id: string } }).target?.id as string;
      const rows = s.graph.escapes.reach.get(id) ?? [];
      expect(rows.length, JSON.stringify(rows)).toBeLessThanOrEqual(3);
      expect(new Set(rows.map((r) => r.why)).size).toBe(rows.length);
    }
  }, 60_000);

  it("keeps a removed function on the floor while its name is still passed as a value (10)", async () => {
    const impact = await changed(
      { "src/a.ts": "export function f(): void {}\nexport function g(): void {}\n", "src/b.ts": 'import { f } from "./a";\nexport function run(cb: () => void): void {\n  cb();\n}\nexport function main(): void {\n  run(f);\n}\n' },
      { "src/a.ts": "export function g(): void {}\n" },
    );
    const f = seedOf(impact, "f");
    expect(f?.floor).toBe(true);
    expect(f?.reasons.join(" ")).toMatch(/1 use of the name `f` as a value could not be bound to one definition, first at src\/b\.ts:6/);
  }, 60_000);

  it("keeps a removed function on the floor when its module gave it out under another name (10)", async () => {
    const impact = await changed(
      { "src/a.ts": "function f(): void {}\nexport { f as g };\n", "src/b.ts": 'import { g } from "./a";\nexport function run(cb: () => void): void {\n  cb();\n}\nexport function main(): void {\n  run(g);\n}\n' },
      { "src/a.ts": "export const other = 1;\n" },
    );
    const f = seedOf(impact, "f");
    expect(f?.floor).toBe(true);
    expect(f?.reasons.join(" ")).toMatch(/its module is used as a value at src\/b\.ts:\d+/);
  }, 60_000);

  it("leaves a function with no caller and no value use quiet in the brief, and keeps a function passed through a ternary loud (11)", async () => {
    const before = {
      "src/a.ts": "export function quiet(): number {\n  return 1;\n}\nexport function loud(): number {\n  return 2;\n}\nexport function other(): number {\n  return 3;\n}\n",
      "src/b.ts": 'import { loud, other } from "./a";\nexport function run(cb: () => number): number {\n  return cb();\n}\nexport function start(flag: boolean): number {\n  const pick = flag ? loud : other;\n  return run(pick);\n}\n',
    };
    const quiet = "export function quiet(): number {\n  return 10;\n}\n";
    const loud = "export function loud(): number {\n  return 20;\n}\n";
    const rest = "export function other(): number {\n  return 3;\n}\n";
    const both = await changed(before, { "src/a.ts": quiet + loud + rest });
    expect(seedOf(both, "quiet")).toEqual(expect.objectContaining({ floor: false, reasons: [] }));
    expect(seedOf(both, "loud")?.floor).toBe(true);
    expect(seedOf(both, "loud")?.reasons.join(" ")).toMatch(/used as a value in 1 place, first at src\/b\.ts:6/);
    expect(both.unknown.floor).toBe(true);

    const onlyQuiet = renderImpactBlock(await changed(before, { "src/a.ts": quiet + "export function loud(): number {\n  return 2;\n}\n" + rest }));
    expect(onlyQuiet).toContain("No caller of the touched code was found in the graph.");
    expect(onlyQuiet).not.toContain(", a floor");

    const onlyLoud = renderImpactBlock(await changed(before, { "src/a.ts": "export function quiet(): number {\n  return 1;\n}\n" + loud + rest }));
    expect(onlyLoud).toContain("the list is a floor (below), so callers may exist.");
    expect(onlyLoud).toMatch(/The callers of `loud` are a floor: .*src\/b\.ts:6/);
  }, 60_000);
});

describe("where a floor's hidden callers can be", () => {
  // Each `export const v = X` reads a free name, so its file cannot be read
  // whole and could call `f` by a path the graph does not see.
  const BASE = {
    "app/package.json": '{"name": "app"}\n',
    "app/a.ts": "export function f() {}\n",
    "app/b.ts": 'import { f } from "./a";\nf();\n',
    "app/a.test.ts": 'import { f } from "./a";\nexport const v = X1;\nf();\n',
    "app/fixtures/run.ts": 'import { f } from "../a";\nexport const v = X2;\nf();\n',
    "test/build.ts": 'import { f } from "../app/a";\nexport const v = X4;\nf();\n',
  };

  it("says complete in product code when every place is a test file, and keeps the floor (12)", async () => {
    const a = ask(await sessionOf(BASE), { kind: "callers", target: { name: "f", file: "app/a.ts" } });
    expect(a.unknown.floor).toBe(true);
    expect(a.listIncomplete).toBe(true);
    expect(a.unknown.scope).toBe("tests");
    expect(a.unknown.note).toBe("Complete in product code. Only test files could hide a caller: app/a.test.ts:2, app/fixtures/run.ts:2, test/build.ts:2.");
    expect(a.unknown.reasons.join(" ")).toContain("3 files the graph cannot read whole could call it");
  }, 60_000);

  it("keeps the full floor when one place is product code beside the test ones (12)", async () => {
    const a = ask(await sessionOf({ ...BASE, "app/c.ts": 'import { f } from "./a";\nexport const v = X3;\nf();\n' }), { kind: "callers", target: { name: "f", file: "app/a.ts" } });
    expect(a.unknown.floor).toBe(true);
    expect(a.listIncomplete).toBe(true);
    expect(a.unknown.scope).toBe("all");
    expect(a.unknown.note).toBeUndefined();
    expect(a.unknown.reasons.join(" ")).toMatch(/4 files the graph cannot read whole could call it by a path it does not see: .*app\/c\.ts:2/);
  }, 60_000);

  it("keeps the full floor when one place is in a scripts, benchmark or corpus folder beside the test ones (12)", async () => {
    for (const file of ["scripts/start.js", "benchmark/run.ts", "packages/tool/scripts/x.ts", "packages/tool/corpus/x.ts"]) {
      const up = "../".repeat(file.split("/").length - 1);
      const a = ask(await sessionOf({ ...BASE, [file]: `import { f } from "${up}app/a";\nexport const v = X5;\nf();\n` }), { kind: "callers", target: { name: "f", file: "app/a.ts" } });
      expect(a.unknown.floor, file).toBe(true);
      expect(a.unknown.scope, file).toBe("all");
      expect(a.unknown.note, file).toBeUndefined();
      expect(a.unknown.reasons.join(" "), file).toContain(`${file}:2`);
    }
  }, 120_000);

  it("gives no scope to a whole list, and scope all to a floor that does not name each place (12)", async () => {
    const s = await sessionOf({ ...BASE, "app/a.test.ts": 'import { f } from "./a";\nf();\n', "app/fixtures/run.ts": 'import { f } from "../a";\nf();\n', "test/build.ts": 'import { f } from "../app/a";\nf();\n', "app/d.ts": 'import { f } from "./a";\nexport const g = [f, f];\n', "app/e.ts": "export function e() {}\n" });
    const whole = ask(s, { kind: "callers", target: { name: "e", file: "app/e.ts" } });
    expect(whole.error).toBeNull();
    expect(whole.unknown.floor).toBe(false);
    expect(whole.unknown.scope).toBeUndefined();
    const used = ask(s, { kind: "callers", target: { name: "f", file: "app/a.ts" } });
    expect(used.unknown.floor).toBe(true);
    expect(used.unknown.reasons.join(" ")).toContain("it is used as a value in 2 places");
    expect(used.unknown.scope).toBe("all");
  }, 60_000);
});
