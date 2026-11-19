// `references` of a TypeScript type, read from every place a type can be
// named. Ways it could fail, written before the code:
//  1. A type named only in a declaration that is not a function (an
//     interface property, a type alias, a union or an intersection member)
//     has no row: a service's deps interface is the usual place an injected
//     store is named, and it is the one the list leaves out.
//  2. A type named as a generic argument (`new Map<string, T>()`,
//     `pick<T>()`, `extends Holder<T>`, sql<T[]>`...`) or in a type
//     parameter's constraint or default has no row.
//  3. A class that declares `implements T` is not listed, though it names T.
//  4. A same-named type of another folder is linked by its name, or a type
//     parameter that shadows the imported name is taken for the import.
//  4b. A mapped type's key (`[K in keyof T]`) or an `infer X` name is
//     taken for a type of the repository of the same name.
//  5. A file that imports the type and has no row for it says nothing: the
//     list reads as whole (floor false) when a use may be missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Item, Request, Session } from "../src/query/engine.js";
import { at, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const files: Record<string, string> = {
  "src/store.ts": "export interface ISessionStore {\n  get(id: string): string;\n}\n",
  "src/index.ts": 'export type { ISessionStore } from "./store";\n',
  "src/deps.ts": ['import type { ISessionStore } from "./index";', "", "export interface Deps {", "  sessionStore: ISessionStore; // deps-property", "}", ""].join("\n"),
  "src/input.ts": [
    'import type { ISessionStore } from "./index";',
    "",
    "type Base = { tenant: string };",
    "",
    "export type Input =",
    "  | (Base & { kind: \"session\"; store: ISessionStore }) // alias-union",
    "  | (Base & { kind: \"tenant\" });",
    "",
    "export type Shadow<ISessionStore> = { value: ISessionStore }; // shadowed",
    "",
  ].join("\n"),
  "src/registry.ts": [
    'import type { ISessionStore } from "./index";',
    "",
    "function pick<T>(xs: unknown[]): T {",
    "  return xs[0] as T;",
    "}",
    "",
    "export function registry(): number {",
    "  const stores = new Map<string, ISessionStore>(); // new-generic",
    "  return stores.size;",
    "}",
    "",
    "// One row per definition and type: a second function for the call.",
    "export function first(xs: unknown[]): void {",
    "  pick<ISessionStore>(xs); // call-generic",
    "}",
    "",
  ].join("\n"),
  "src/holder.ts": [
    'import type { ISessionStore } from "./index";',
    "",
    "interface Holder<T> {",
    "  value: T;",
    "}",
    "",
    "export interface StoreHolder extends Holder<ISessionStore> { // extends-generic",
    "  name: string;",
    "}",
    "",
    "class Base<T> {",
    "  item?: T;",
    "}",
    "",
    "export class Wrapped extends Base<ISessionStore> {} // class-extends-generic",
    "",
  ].join("\n"),
  "src/memory.ts": [
    'import type { ISessionStore } from "./index";',
    "",
    "export class MemoryStore implements ISessionStore { // implements",
    "  get(id: string): string {",
    "    return id;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/generic.ts": [
    'import type { ISessionStore } from "./index";',
    "",
    "declare function sql<T>(parts: TemplateStringsArray): T;",
    "",
    "export function make<S extends ISessionStore = ISessionStore>(s: S): S { // param-constraint",
    "  return s;",
    "}",
    "",
    "export const rows = sql<ISessionStore[]>`select 1`; // tagged-template",
    "",
    "export function both<ISessionStore, U extends ISessionStore>(u: U): U { // param-shadowed",
    "  return u;",
    "}",
    "",
  ].join("\n"),
  "src/fn.ts": ['import type { ISessionStore } from "./index";', "", "export function read(store: ISessionStore): string { // param", '  return store.get("a");', "}", ""].join("\n"),
  // The same name, another type: never linked to src/store.ts.
  "src/other/store.ts": "export interface ISessionStore {\n  other(): void;\n}\n",
  "src/other/deps.ts": ['import type { ISessionStore } from "./store";', "", "export interface OtherDeps {", "  store: ISessionStore; // other-property", "}", ""].join("\n"),
  // Types named K and X, and names a type binds locally with the same spelling.
  "src/letters.ts": "export interface K {\n  k: 1;\n}\n\nexport interface X {\n  x: 1;\n}\n",
  "src/mapped.ts": [
    'import type { K, X } from "./letters";',
    "",
    "export function both(k: K, x: X): void {} // real-uses",
    "",
    "export type Opt<T> = { [K in keyof T]?: T[K] }; // mapped-key",
    "",
    "export type Elem<T> = T extends Array<infer X> ? X : never; // infer-var",
    "",
    "export function keys(a: { [K in string]: K }): void {} // mapped-param",
    "",
  ].join("\n"),
  // Imported and named nowhere the graph reads: a use may be missing.
  "src/unused.ts": ['import type { ISessionStore } from "./index";', "", "export const unused = 1;", ""].join("\n"),
};

describe("references of a TypeScript type", () => {
  let s: Session;
  let graph: Graph;
  beforeAll(async () => {
    const repo = makeRepo(files);
    graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "refs-types", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">): Answer => query(s, { apiVersion: 1, ...req } as Request) as Answer;
  const where = (i: Item) => `${i.site.file}:${i.site.line}`;

  it("lists a type named in an interface property, a type alias, a generic argument, a type parameter's constraint and an implements clause (1, 2, 3)", () => {
    const a = q({ kind: "references", target: { id: symbol(graph, "src/store.ts", "ISessionStore") } });
    expect(a.error).toBeNull();
    const rows = (a.items as Item[]).map((i) => [where(i), i.kind, i.site.tier]);
    for (const [path, marker, kind] of [
      ["src/deps.ts", "deps-property", "uses_type"],
      ["src/input.ts", "alias-union", "uses_type"],
      ["src/registry.ts", "new-generic", "uses_type"],
      ["src/registry.ts", "call-generic", "uses_type"],
      ["src/holder.ts", "extends-generic", "uses_type"],
      ["src/holder.ts", "class-extends-generic", "uses_type"],
      ["src/memory.ts", "implements", "implements"],
      ["src/generic.ts", "param-constraint", "uses_type"],
      ["src/generic.ts", "tagged-template", "uses_type"],
      ["src/fn.ts", "param", "uses_type"],
    ] as const) {
      expect(rows).toContainEqual([at(files, path, marker), kind, "certain"]);
    }
  });

  it("links no same-named type of another folder and no type parameter that shadows the import (4)", () => {
    const a = q({ kind: "references", target: { id: symbol(graph, "src/store.ts", "ISessionStore") } });
    const sites = (a.items as Item[]).map(where);
    expect(sites).not.toContain(at(files, "src/other/deps.ts", "other-property"));
    expect(sites).not.toContain(at(files, "src/input.ts", "shadowed"));
    expect(sites).not.toContain(at(files, "src/generic.ts", "param-shadowed"));
    const o = q({ kind: "references", target: { id: symbol(graph, "src/other/store.ts", "ISessionStore") } });
    expect((o.items as Item[]).map((i) => [where(i), i.kind, i.site.tier])).toEqual([[at(files, "src/other/deps.ts", "other-property"), "uses_type", "certain"]]);
    // Every file that imports the other type has a row: the list is whole.
    expect(o.unknown.floor).toBe(false);
  });

  it("takes no mapped type key and no infer name for a type of the same name (4b)", () => {
    for (const name of ["K", "X"]) {
      const a = q({ kind: "references", target: { id: symbol(graph, "src/letters.ts", name) } });
      const sites = (a.items as Item[]).map(where);
      expect(sites).toContain(at(files, "src/mapped.ts", "real-uses"));
      for (const marker of ["mapped-key", "infer-var", "mapped-param"]) expect(sites).not.toContain(at(files, "src/mapped.ts", marker));
    }
  });

  it("sets the floor, naming the file, when a file imports the type and has no row for it (5)", () => {
    const a = q({ kind: "references", target: { id: symbol(graph, "src/store.ts", "ISessionStore") } });
    expect(a.unknown.floor).toBe(true);
    const text = a.unknown.reasons.join(" ");
    expect(text).toMatch(/src\/unused\.ts/);
    // Only the file with no row is named.
    for (const f of ["src/deps.ts", "src/input.ts", "src/registry.ts", "src/holder.ts", "src/memory.ts", "src/generic.ts", "src/fn.ts"]) expect(text).not.toContain(f);
  });
});
