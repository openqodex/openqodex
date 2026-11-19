// What counts as a gap. Ways the unknown records could mislead, each on a
// real repo:
// 1. A method called on a value of a built-in type (`d: Date`, a string, an
//    array) counts as an in-repo gap, so every repository function named
//    `trim` or `reduce` gets a false floor.
// 2. A method called on a value whose type the repository defines but no
//    rule can see into stays a gap (never turned into an external call). A
//    TypeScript interface's member now binds as declared, and the call
//    keeps a gap for the values of its shape that declare nothing when the
//    graph cannot list them: the interface extends a type outside it.
// 3. A method called on what a call returns is named in the brief as if the
//    call were a type ("the type Buffer.concat"), which misleads the reader.
// 4. A method called on what a package's own method returned
//    (`db.selectFrom("t").where(...)`, `z.string().min(1).optional()`, a
//    local given such a value) counts as an in-repo gap, so every
//    repository definition named `where` or `optional` gets a false floor.
// 5. Such a call is counted as external although the repository subclasses
//    or implements the package's type, or adds the member with `declare
//    module`: the value may be the repository's own object, so the call may
//    run repository code and hiding it would hide a caller. A method of the
//    same name on a class that is no such subtype does not stop the call
//    from being external.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, floorReasons } from "../src/index.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

describe("unknown records", () => {
  it("counts calls on values of built-in types as external, never as gaps (1)", async () => {
    const root = makeRepo({
      "src/text.ts": "export function trim(x: number) {\n  return x;\n}\nexport function reduce() {\n  return 0;\n}\n",
      "src/use.ts": "export function use(d: Date, s: string, items: number[]) {\n  return d.toISOString() + s.trim() + items.reduce((a, b) => a + b, 0);\n}\n",
      "py/m.py": "def strip():\n    return 1\n\ndef use(s: str, xs: list):\n    return s.strip() + xs.count(1)\n",
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    const gaps = g.unknowns.map((u) => `${u.file}:${u.line} ${u.name}`);
    expect(gaps).toEqual([]);
    expect(g.status.externalSites).toBeGreaterThanOrEqual(5);
    const trim = g.defsByFile.get("src/text.ts")?.find((n) => n.name === "trim");
    expect(floorReasons(g, { id: trim!.id, name: "trim", file: "src/text.ts" }, new Set())).toEqual([]);
  });

  it("keeps a call on a repository interface a gap when its shape is not all known (2)", async () => {
    const root = makeRepo({
      "package.json": JSON.stringify({ name: "x", dependencies: { "base-api": "1.0.0" } }),
      "src/repo.ts": 'import type { Base } from "base-api";\nexport interface Repo extends Base {\n  find(): number;\n}\n',
      "src/use.ts": 'import type { Repo } from "./repo";\nexport function use(r: Repo) {\n  return r.find();\n}\n',
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.unknowns.map((u) => `${u.file}:${u.line} ${u.name} ${u.cause}`)).toEqual(["src/use.ts:3 find unsupported-rule"]);
    expect(g.status.externalSites).toBe(0);
  });

  it("names a call's result as what the call returns, never as a type (3)", async () => {
    const root = makeRepo({
      "src/use.ts": "export function use(parts: Uint8Array[]) {\n  return Buffer.concat(parts).toString();\n}\n",
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.unknowns.map((u) => `${u.name}: ${u.note}`)).toEqual(["toString: what Buffer.concat returns is not known to the graph"]);
  });

  const pkg = JSON.stringify({ name: "x", dependencies: { kysely: "0.27.0", zod: "3.23.0", pino: "9.0.0" } });

  it("counts a call on what a package's method returned as external, never as a gap (4)", async () => {
    const root = makeRepo({
      "package.json": pkg,
      "src/text.ts": "export function where() {\n  return 0;\n}\nexport function optional() {\n  return 1;\n}\n",
      // A method named like the package's, on a class that is no subtype of a package's type.
      "src/job.ts": "export class Job {\n  execute(): number {\n    return 1;\n  }\n}\n",
      "src/db.ts": [
        'import type { Kysely } from "kysely";',
        'import { z } from "zod";',
        "export function q(db: Kysely<unknown>) {",
        '  return db.selectFrom("t").where("a", "=", 1).execute();',
        "}",
        "export const Name = z.string().min(1).optional();",
        "export function local(db: Kysely<unknown>) {",
        '  const rows = db.selectFrom("t").selectAll();',
        "  return rows.execute();",
        "}",
        "",
      ].join("\n"),
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    expect(g.unknowns.map((u) => `${u.file}:${u.line} ${u.name} ${u.cause}`)).toEqual([]);
    // selectFrom twice, where, execute twice, string, min, optional, selectAll.
    expect(g.status.externalSites).toBeGreaterThanOrEqual(9);
    for (const name of ["where", "optional"]) {
      const fn = g.defsByFile.get("src/text.ts")?.find((n) => n.name === name);
      expect(floorReasons(g, { id: fn!.id, name, file: "src/text.ts" }, new Set())).toEqual([]);
    }
    const execute = g.defsByFile.get("src/job.ts")?.find((n) => n.name === "execute");
    expect(floorReasons(g, { id: execute!.id, name: "execute", file: "src/job.ts" }, new Set())).toEqual([]);
  });

  it("keeps a gap on what a package returned when the repository subclasses, implements or augments the package's type (5)", async () => {
    const root = makeRepo({
      "package.json": pkg,
      "src/logger.ts": 'import type { Logger } from "pino";\nexport class FileLogger implements Logger {\n  flush(): void {}\n}\n',
      "src/run.ts": [
        'import pino from "pino";',
        "export function run() {",
        "  return pino().child({}).flush();",
        "}",
        "",
      ].join("\n"),
      "src/builder.ts": [
        'import { SelectQueryBuilder } from "kysely";',
        "export class Scoped extends SelectQueryBuilder<unknown, never, unknown> {",
        "  where(): this {",
        "    return this;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/augment.ts": [
        'declare module "kysely" {',
        "  interface SelectQueryBuilder<DB, TB, O> {",
        "    whereActive(): this;",
        "  }",
        "}",
        "export {};",
        "",
      ].join("\n"),
      "src/db.ts": [
        'import type { Kysely } from "kysely";',
        "export function q(db: Kysely<unknown>) {",
        '  return db.selectFrom("t").where("a", "=", 1).whereActive().orderBy("a");',
        "}",
        "",
      ].join("\n"),
    });
    const g = await buildGraph({ repoRoot: root, store: null });
    const gaps = g.unknowns.map((u) => `${u.file}:${u.line} ${u.name} ${u.cause}`);
    // orderBy runs on what whereActive returned, which may be repository code: no type is known.
    expect(gaps.sort()).toEqual(["src/db.ts:3 orderBy no-receiver-type", "src/db.ts:3 where no-receiver-type", "src/db.ts:3 whereActive no-receiver-type", "src/run.ts:3 flush no-receiver-type"]);
    const flush = g.defsByFile.get("src/logger.ts")?.find((n) => n.name === "flush");
    expect(floorReasons(g, { id: flush!.id, name: "flush", file: "src/logger.ts" }, new Set()).join(" ")).toMatch(/could not be bound/);
  });
});
