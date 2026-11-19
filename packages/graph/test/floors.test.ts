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
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request, Session } from "../src/query/answer.js";
import { makeRepo } from "./helpers.js";
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
