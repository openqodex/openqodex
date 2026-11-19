// Six small dead ends of the graph answers (the trueforge report, problems
// 4, 10, 11, 12 and 13). Ways it could fail, written before the code:
//  1. A callers answer with same-name calls the graph could not bind says
//     so only on its last line, so an agent reads the rows as the whole list;
//     or a list with no such calls gets a warning it should not have.
//  2. `implementers` on a file says "not found" or "is a file" and offers
//     nothing to ask next; or a bare name that is a file's stem
//     (`implementers IMCPServer` for IMCPServer.ts) is not found, or wins
//     over a symbol of that name.
//  3. `unknowns --file` lists rows of other files with no word on why.
//  4. `search` for a name with one exact definition gives no target, or
//     gives a prefix match as the target; or puts every hit in `leads` and
//     none in `items`, or calls any name match certain (a name match
//     alone is never certain).
//  5. `outline .` or an empty path is refused or finds nothing.
//  6. A truncated JSON or MCP answer has no sentence saying how to go on.
//  7. The outline of the repository root lists no file that was not read
//     and sets no floor, so a partial outline reads as whole.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Session } from "../src/query/engine.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function session(files: Record<string, string>): Promise<Session> {
  const graph = await buildGraph({ repoRoot: makeRepo(files), store: null });
  return { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
}

const repo = {
  "svc/a.ts": "export function save() {\n  return 1;\n}\nexport function load() {\n  return 2;\n}\n",
  "svc/b.ts": 'import { save } from "./a";\nexport function go(h: any) {\n  h.save();\n  return save();\n}\n',
  "svc/c.ts": "export function dyn(t: any, k: string) {\n  return t[k]();\n}\n",
  "svc/types.ts": "export interface IThing {\n  run(): void;\n}\nexport class Thing implements IThing {\n  run() {}\n}\nexport function helper() {}\nexport const x = 1;\n",
  "other/z.ts": "export function z() {\n  return 1;\n}\n",
};

describe("dead ends of the graph answers", () => {
  it("1. callers warns first when same-name calls could not be bound, and not otherwise", async () => {
    const s = await session(repo);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "save" } });
    expect(a.warning).toBe("1 call named save could not be bound; this list may be missing callers. See: openqodex graph unknowns --name save");
    expect(a.unknown.floor).toBe(true);
    const clean = query(s, { apiVersion: 1, kind: "callers", target: { name: "z" } });
    expect(clean.warning).toBeUndefined();
    expect(query(s, { apiVersion: 1, kind: "callees", target: { name: "go" } }).warning).toBeUndefined();
  });

  it("2. implementers on a file name answers with the classes and interfaces the file defines", async () => {
    const s = await session(repo);
    for (const target of [{ name: "svc/types.ts" }, { file: "svc/types.ts" }]) {
      const a = query(s, { apiVersion: 1, kind: "implementers", target });
      expect(a.error?.code).toBe("ambiguous");
      expect((a.target as { name: string }[]).map((c) => c.name).sort()).toEqual(["IThing", "Thing"]);
      expect((a.target as { file: string; line: number }[]).map((c) => `${c.file}:${c.line}`).sort()).toEqual(["svc/types.ts:1", "svc/types.ts:4"]);
    }
    // A file with no class or interface stays an error with no candidates.
    const none = query(s, { apiVersion: 1, kind: "implementers", target: { name: "other/z.ts" } });
    expect(none.error).not.toBeNull();
    expect(none.target).toBeNull();
    // A bare name that is only a file's stem answers as the path does.
    const stem = query(s, { apiVersion: 1, kind: "implementers", target: { name: "types" } });
    expect(stem.error?.code).toBe("ambiguous");
    expect((stem.target as { name: string }[]).map((c) => c.name).sort()).toEqual(["IThing", "Thing"]);
    expect(query(s, { apiVersion: 1, kind: "implementers", target: { name: "z" } }).error?.code).toBe("bad-request");
  });

  it("2. implementers of a bare name takes the symbol before a file of that stem, and lists files that share a stem", async () => {
    const s = await session({
      "Widget.ts": "export class Widget {}\n",
      "Sub.ts": 'import { Widget } from "./Widget";\nexport class Sub extends Widget {}\n',
      "a/defs.ts": "export class A {}\n",
      "b/defs.ts": "export class B {}\n",
      "c/defs.ts": "export function f() {}\n",
      "x/util.ts": "export class U {}\n",
      "y/util.ts": "export function u() {}\n",
    });
    const widget = query(s, { apiVersion: 1, kind: "implementers", target: { name: "Widget" } });
    expect(widget.error).toBeNull();
    expect((widget.items as { site: { file: string } }[]).map((i) => i.site.file)).toEqual(["Sub.ts"]);
    const shared = query(s, { apiVersion: 1, kind: "implementers", target: { name: "defs" } });
    expect(shared.error?.code).toBe("ambiguous");
    // A file that defines no class or interface is no candidate.
    expect((shared.target as { file: string; kind: string }[]).map((c) => `${c.kind} ${c.file}`).sort()).toEqual(["file a/defs.ts", "file b/defs.ts"]);
    const one = query(s, { apiVersion: 1, kind: "implementers", target: { name: "util" } });
    expect(one.error?.code).toBe("ambiguous");
    expect((one.target as { name: string; file: string }[]).map((c) => `${c.name} ${c.file}`)).toEqual(["U x/util.ts"]);
    expect(query(s, { apiVersion: 1, kind: "implementers", target: { name: "nothing" } }).error?.code).toBe("not-found");
  });

  it("3. unknowns --file says how many rows come from other files of the package", async () => {
    const s = await session(repo);
    const a = query(s, { apiVersion: 1, kind: "unknowns", target: { file: "svc/b.ts" } });
    const rows = a.items as { file: string; scope: string }[];
    expect(rows.some((r) => r.file === "svc/c.ts" && r.scope === "project")).toBe(true);
    const others = rows.filter((r) => r.file !== "svc/b.ts").length;
    expect(a.unknown.reasons).toEqual([`${others} of these ${rows.length} rows come from other files of the same package: a call through a value there could reach this file, so they are listed (scope project)`]);
    // By name there is no file to compare with: no such line.
    expect(query(s, { apiVersion: 1, kind: "unknowns", target: { name: "save" } }).unknown.reasons).toEqual([]);
  });

  it("4. search puts one exact name match in target, never a prefix match; exact and prefix matches are items, the rest leads", async () => {
    const s = await session(repo);
    const one = query(s, { apiVersion: 1, kind: "search", text: "helper" });
    expect(one.target).toMatchObject({ name: "helper", file: "svc/types.ts", score: 1 });
    expect(one.items).toEqual([expect.objectContaining({ name: "helper", file: "svc/types.ts", score: 1, tier: "likely" })]);
    expect(one.leads).toEqual([]);
    expect(one.counts).toEqual({ certain: null, likely: null, possible: null });
    // Prefix only: no target, an item never certain.
    const prefix = query(s, { apiVersion: 1, kind: "search", text: "hel" });
    expect(prefix.target).toBeNull();
    expect(prefix.items).toEqual([expect.objectContaining({ name: "helper", tier: "possible" })]);
    // A name that only holds the text, and a file path, stay leads.
    const inside = query(s, { apiVersion: 1, kind: "search", text: "elpe" });
    expect(inside.items).toEqual([]);
    expect(inside.leads.map((l) => l.name)).toEqual(["helper"]);
    const path = query(s, { apiVersion: 1, kind: "search", text: "svc/a" });
    expect(path.items).toEqual([]);
    expect(path.leads.map((l) => l.file)).toEqual(["svc/a.ts"]);
    // Two exact matches: no target.
    const two = await session({ "a.ts": "export function run() {}\n", "b.ts": "export function run() {}\n" });
    expect(query(two, { apiVersion: 1, kind: "search", text: "run" }).target).toBeNull();
    // A file path hit is not a symbol match.
    expect(query(s, { apiVersion: 1, kind: "search", text: "svc/a.ts" }).target).toBeNull();
  });

  it("5. outline of . , ./ and an empty path is the repository root", async () => {
    const s = await session(repo);
    const all = query(s, { apiVersion: 1, kind: "outline", target: { file: "svc" } });
    const root = query(s, { apiVersion: 1, kind: "outline", target: { file: "." }, limit: 500 });
    expect(root.error).toBeNull();
    const files = [...new Set((root.items as { file: string }[]).map((i) => i.file))].sort();
    expect(files).toEqual(["other/z.ts", "svc/a.ts", "svc/b.ts", "svc/c.ts", "svc/types.ts"]);
    expect(all.error).toBeNull();
    for (const file of ["", "./", "/", "././", ".//", "./."]) expect(query(s, { apiVersion: 1, kind: "outline", target: { file }, limit: 500 }).items).toEqual(root.items);
    expect(query(s, { apiVersion: 1, kind: "outline", target: { file: "./svc" }, limit: 500 }).items).toEqual(all.items);
    for (const file of ["svc/./", "./svc/./", "svc/.", "svc//."]) expect(query(s, { apiVersion: 1, kind: "outline", target: { file }, limit: 500 }).items).toEqual(all.items);
  });

  it("6. a truncated answer carries the paging sentence the CLI prints", async () => {
    const s = await session(repo);
    const a = query(s, { apiVersion: 1, kind: "search", text: "s", limit: 1 });
    expect(a.truncated.by).toBe("limit");
    expect(a.truncated.note).toBe(`truncated by limit: ${a.truncated.omitted} more; --cursor ${a.truncated.cursor}`);
    expect(query(s, { apiVersion: 1, kind: "search", text: "helper" }).truncated.note).toBeUndefined();
  });

  it("7. the root outline names a file that was not read and sets the floor", async () => {
    const root = makeRepo({ "svc/a.ts": "export function save() {\n  return 1;\n}\n", "svc/big.ts": `export function big() {\n  return 1;\n}\n${"// pad\n".repeat(400)}` });
    const graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 1024 });
    const s: Session = { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false };
    for (const file of ["svc", "."]) {
      const a = query(s, { apiVersion: 1, kind: "outline", target: { file }, limit: 500 });
      expect(a.unknown.floor, file).toBe(true);
      expect(a.unknown.reasons.join(" "), file).toMatch(/1 file here was not read: svc\/big\.ts/);
    }
  });
});
