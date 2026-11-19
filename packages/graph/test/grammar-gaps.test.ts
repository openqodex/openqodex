// Valid TypeScript that the pinned grammar reads with a missing node and no
// other damage: a route reader must read it as the core extractor does.
//
// Ways it could fail, written before the code:
//  1. A tagged template with type arguments (`sql<Row>`select``, also as
//     the last branch of a ternary) parses with a missing `!`, and every
//     route reader counts the file as one it could not read: a parse note
//     on every query file of a Kysely repository, and the floor of
//     `routes` is always true.
//  2. A cast to an import type with an array suffix (`x as
//     import('./t').T[]`) parses with a missing identifier, with the same
//     note.
//  3. A route registered in a handler or a file that holds either shape is
//     dropped (the reader skips any node with an error below it), now with
//     no note at all.
//  5. A node is said to hold a region it does not, or not to hold one it
//     does, when a file has many regions (the lookup that finds them).
//  4. A real syntax error, or a shape the grammar garbles beyond one
//     missing node (`f<typeof import('x')>()`), stops being a gap: a route
//     inside it would vanish with no floor.
import { afterAll, describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";
import { buildGraph } from "../src/index.js";
import { parserFor } from "../src/parser.js";
import { graceful, hasError } from "../src/walk.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Request } from "../src/query/answer.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const PKG = JSON.stringify({ name: "api", private: true, type: "module", dependencies: { hono: "^4.6.0", express: "^4.21.2", kysely: "^0.27.0" } });

const APP = 'import { Hono } from "hono";\nimport { list } from "./queries";\nexport const app = new Hono();\nexport async function rows(c: { json(v: unknown): Response }): Promise<Response> {\n  return c.json(await list(null));\n}\napp.get("/rows", rows);\n';

// Every gap the framework layer recorded for a file, by plugin and cause.
const gapsOf = (g: Graph, file: string) => (g.frameworks?.unknowns ?? []).filter((u) => u.site?.file === file || (u.scope && "file" in u.scope && u.scope.file === file)).map((u) => `${u.plugin} ${u.cause}`);
const routesOf = (g: Graph) => query({ graph: g, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "routes" } as Request);
type Route = { pattern: string | null; handler: { targets: string[] }; handles: unknown[] };

describe("valid TypeScript the grammar reads with a missing node", () => {
  it("reads a file of tagged templates with type arguments with no gap (1)", async () => {
    const queries = 'import { sql } from "kysely";\nexport async function list(_x: unknown): Promise<unknown[]> {\n  const rows = await sql<{ id: string }>`select id from t`.execute(db);\n  const ids = sql<number[]>`\'{}\'::bigint[]`;\n  const pick = { ids: rows ? null : sql<number[]>`b` };\n  return [rows, ids, pick];\n}\ndeclare const db: unknown;\n';
    const g = await buildGraph({ repoRoot: makeRepo({ "package.json": PKG, "src/app.ts": APP, "src/queries.ts": queries }), store: null });
    expect(gapsOf(g, "src/queries.ts")).toEqual([]);
    const a = routesOf(g);
    expect(a.unknown.reasons).toEqual([]);
    expect(a.unknown.floor).toBe(false);
    expect(a.items.length).toBe(1);
  }, 60_000);

  it("reads a cast to an import type with an array suffix with no gap (2)", async () => {
    const queries = "export function list(x: unknown): unknown[] {\n  return x as import('./types').Row[];\n}\n";
    const g = await buildGraph({ repoRoot: makeRepo({ "package.json": PKG, "src/app.ts": APP, "src/queries.ts": queries, "src/types.ts": "export type Row = { id: string };\n" }), store: null });
    expect(gapsOf(g, "src/queries.ts")).toEqual([]);
    expect(routesOf(g).unknown.reasons).toEqual([]);
    expect(routesOf(g).unknown.floor).toBe(false);
  }, 60_000);

  it("reads a route whose handler holds either shape, for Hono and Express (3)", async () => {
    const hono = 'import { Hono } from "hono";\nimport { sql } from "kysely";\ndeclare const db: unknown;\nexport const app = new Hono();\napp.get("/a", async (c) => {\n  const r = await sql<{ id: string }>`select 1`.execute(db);\n  return c.json(r as import(\'./types\').Row[]);\n});\n';
    const express = 'import express from "express";\nimport { sql } from "kysely";\ndeclare const db: unknown;\nexport const server = express();\nserver.get("/b", async (req, res) => {\n  res.json(await sql<{ id: string }>`select 1`.execute(db));\n});\n';
    const g = await buildGraph({ repoRoot: makeRepo({ "package.json": PKG, "src/hono.ts": hono, "src/express.ts": express, "src/types.ts": "export type Row = { id: string };\n" }), store: null });
    // The inline handlers are gaps of their own (no symbol); no file is one it could not read.
    expect(gapsOf(g, "src/hono.ts")).not.toContain("hono file-not-parsed");
    expect(gapsOf(g, "src/express.ts")).not.toContain("express file-not-parsed");
    const a = routesOf(g);
    expect(((a.items as Route[]).map((r) => r.pattern) as string[]).sort()).toEqual(["/a", "/b"]);
    expect(a.unknown.causes["file-not-parsed"]).toBeUndefined();
  }, 60_000);

  it("keeps the gap for a real syntax error and for a garbled import type, with the route in it unread (4)", async () => {
    const real = 'import { Hono } from "hono";\nexport const app = new Hono();\napp.get("/c", (c) => c.text(;\n';
    const garbled = 'import { Hono } from "hono";\nexport const other = new Hono();\nother.get("/d", async (c) => {\n  const m = await load<typeof import(\'./types\')>();\n  return c.json(m);\n});\ndeclare function load<T>(): Promise<T>;\n';
    // A missing node the grammar puts for a real error stays one too.
    const missing = 'import { Hono } from "hono";\nimport { sql } from "kysely";\nexport const third = new Hono();\nthird.get("/e", (c) => c.json(sql`x`.as<A>(y z)));\n';
    const g = await buildGraph({ repoRoot: makeRepo({ "package.json": PKG, "src/real.ts": real, "src/garbled.ts": garbled, "src/missing.ts": missing, "src/types.ts": "export type Row = { id: string };\n" }), store: null });
    expect(gapsOf(g, "src/real.ts")).toContain("hono file-not-parsed");
    expect(gapsOf(g, "src/garbled.ts")).toContain("hono file-not-parsed");
    expect(gapsOf(g, "src/missing.ts")).toContain("hono file-not-parsed");
    const a = routesOf(g);
    expect(a.unknown.floor).toBe(true);
    expect((a.items as Route[]).map((r) => r.pattern)).not.toContain("/d");
  }, 60_000);

  it("says a node holds a region exactly when one lies inside it, in a file of many (5)", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => [`app.get("/a${i}", (c) => { f(; });`, `const q${i} = sql<number[]>\`x\`;`, `app.get("/b${i}", (c) => c.json(x as import('./t').T[]));`, `const r${i} = g(${i});`][i % 4]).join("\n");
    const tree = (await parserFor("typescript")).parse(lines);
    if (!tree) throw new Error("no tree");
    // Every region, the slow way: any ERROR node, any missing node that is not graceful.
    const holds = (n: Node): boolean => n.type === "ERROR" || (n.isMissing && !graceful(n)) || n.children.some((c) => c !== null && holds(c));
    let checked = 0;
    let real = 0;
    const visit = (n: Node) => {
      expect(hasError(n), `${n.type} at ${n.startIndex}`).toBe(holds(n));
      checked++;
      if (holds(n)) real++;
      for (const c of n.children) if (c) visit(c);
    };
    visit(tree.rootNode);
    expect(real).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(real);
  });
});
