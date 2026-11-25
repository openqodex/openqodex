// The typed questions of the query layer (PLAN.md 3.3, phase 3), asked of
// the phase 1 corpus repositories and of small repositories built for the
// questions the corpus holds nothing for. Ways it could fail, written
// before the code:
//  1. An answer item carries no evidence: no tier, no evidence kind, or an
//     edge id that `explain` cannot read back.
//  2. A zero on a floor reads as "none": callers, callees, implementers,
//     a path or tests with a gap in scope must say floor true, and why.
//  3. A question this build cannot answer (references with no value
//     relations, routes with no framework layer) returns an empty success
//     instead of a capability boundary.
//  4. A walk stopped by its budget or a cancellation claims a count of what
//     lies past its frontier, or offers a cursor that pages through a list
//     it never finished instead of going on with the work.
//  5. A token budget cuts the counts, or returns no item and never moves.
//  6. A path hop has no edge, or "no path" is said where an unbound call in
//     the visited code could hold one, with no floor.
//  7. Calls from files named like tests are counted as tests, or called
//     coverage, while no test runner was read.
//  8. An import cycle is missed, or a chain without a cycle is listed.
//  9. `impact` through the query layer differs from the review's walk for
//     the same change.
// 10. An outline of a folder lists symbols of a folder that only shares
//     its name prefix.
// 11. `packages` says one project depends on another with no import
//     between them, or misses one that has.
// 12. An override is said to be certain when only a method name ties it to
//     the base method, or a subclass two levels down is missed. (The
//     resolver binds an override through the class's lookup order and the
//     inheritance it proved, so its tier is that proof's.)
// 13. Every question, asked of every corpus repository, breaks the answer
//     shape: no graph block, no unknown block, a count that is neither a
//     number nor null, an error with items, or a zero worded as "unused".
// 14. An override search stops at the depth asked and says nothing of the
//     overrides past it.
// 15. A class whose base is written as an expression (a call, a mixin) is
//     not tied to the base, and `implementers` of the base says nothing of
//     what it could not read: a short list with no floor. Or the floor is
//     said for every class of the language, though no class in the graph
//     names its base that way, so a whole list reads as a short one.
// 16. `impact` gives the summary's list of places that used a changed
//     public name, which keeps the first 200, as if it were whole: no
//     floor, no cut, and no page holds the rest.
// 17. The questions read only the calls profile of the graph and miss the
//     relations the resolver keeps apart (overrides, uses as a value or a
//     type): `references` answers unsupported or a short list,
//     `implementers` of a method lists no implementation of an interface
//     member, `explain` cannot read their edges back, and `impact` drops
//     the possible callers and the uses the review's brief shows.
// 18. A factory defines a handler and hands it to a router as a value, never
//     calling it: `path` from the factory to what the handler calls finds
//     nothing, or finds it and calls the hop a call. Or the nesting reaches
//     a function of the same name defined elsewhere, or stops one level
//     down when a closure sits inside a closure.
// 19. A change inside a handler a factory defines reaches nothing past the
//     handler: `impact` lists no caller, so the factory and what calls it
//     are missing from the blast radius. Or they come back as callers of
//     the handler, which never runs from there. Or `callees` of the factory
//     walks into the handler when nobody asked, or calls the hop a call.
// 20. `packages` counts one import site per importing file and module, so a
//     file that imports a package twice (a type import and a value import,
//     or an import and a re-export) loses every line after the first.
// 21. A walk more than one hop deep reads the floor of its target only: a
//     caller it lists whose own callers may be missing (a use as a value)
//     leaves the answer silent, though a caller of that caller is part of
//     the list. Or the answer floors but does not say which listed caller
//     the gap belongs to, or where.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSet, getChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Item, Request, Session } from "../src/query/engine.js";
import { findCases, matches } from "../corpus/score.js";
import type { Expected } from "../corpus/score.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const corpusRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
}

// A corpus case as the scorer builds it: the base committed, the change
// written over it and left uncommitted.
function caseRepo(dir: string): string {
  const root = tempDir("oq-query-case-");
  cpSync(join(dir, "base"), root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "corpus@example.com");
  git(root, "config", "user.name", "corpus");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  if (existsSync(join(dir, "change"))) cpSync(join(dir, "change"), root, { recursive: true, force: true });
  const del = join(dir, "delete.txt");
  if (existsSync(del)) for (const line of readFileSync(del, "utf8").split("\n")) if (line.trim() !== "") rmSync(join(root, line.trim()));
  return root;
}

type Built = { root: string; graph: Graph; change: Change; expected: Expected; s: Session; changes: { exports: Graph["exportChanges"]; removed: ReturnType<typeof detectImpact>["symbols"]; moved: ReturnType<typeof detectImpact>["symbols"] } };

const built = new Map<string, Built>();
async function build(name: string): Promise<Built> {
  const dir = join(corpusRoot, name);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  const root = caseRepo(dir);
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({
    repoRoot: root,
    store: null,
    files: change.changedPaths,
    base: { sha: change.baseSha, files: change.files },
    ...(expected.build?.maxFileBytes !== undefined ? { maxFileBytes: expected.build.maxFileBytes } : {}),
  });
  const impact = detectImpact(graph, change);
  const removed = impact.symbols.filter((x) => impact.removed.includes(x.id));
  const b: Built = {
    root,
    graph,
    change,
    expected,
    s: { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false },
    changes: { exports: graph.exportChanges, removed: removed.filter((x) => !x.movedTo), moved: removed.filter((x) => x.movedTo) },
  };
  built.set(name, b);
  return b;
}

const cases = findCases(corpusRoot).map((d) => relative(corpusRoot, d));

beforeAll(async () => {
  for (const c of cases) await build(c);
}, 180_000);

const ask = (b: Built, req: Omit<Request, "apiVersion">, extra: Parameters<typeof query>[2] = {}): Answer => query(b.s, { apiVersion: 1, ...req } as Request, { changes: b.changes, ...extra });
const idOf = (g: Graph, spec: string): string => {
  const hits = [...g.nodes.keys()].filter((id) => matches(spec, id));
  if (hits.length !== 1) throw new Error(`${hits.length} symbols match ${spec}`);
  return hits[0] as string;
};
const where = (i: Item) => `${i.site.file}:${i.site.line}`;
const get = (name: string): Built => {
  const b = built.get(name);
  if (!b) throw new Error(`${name} was not built`);
  return b;
};

describe("every question, against every corpus repository (13)", () => {
  it("finds every caller the corpus expects at its tier, each with an edge `explain` reads back (1)", () => {
    let checked = 0;
    for (const name of cases) {
      const b = get(name);
      if (b.expected.knownFailure) continue;
      for (const c of b.expected.callers ?? []) {
        const id = idOf(b.graph, c.to);
        const a = ask(b, { kind: "callers", target: { id }, depth: 1, limit: 500 });
        expect(a.error, `${name} ${c.to}`).toBeNull();
        const hit = (a.items as Item[]).find((i) => where(i) === c.site);
        expect(hit, `${name}: ${c.site} calls ${c.to}`).toBeDefined();
        expect(hit?.site.tier, `${name}: ${c.site}`).toBe(c.tier);
        if (c.note) expect(hit?.site.note ?? "", `${name}: ${c.site}`).toContain(c.note);
        const why = ask(b, { kind: "explain", target: { id: hit?.edge } });
        expect(why.error, `${name}: explain ${c.site}`).toBeNull();
        expect(why.items[0], `${name}: explain ${c.site}`).toMatchObject({ edge: hit?.edge, site: { tier: c.tier } });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("lists every unknown the corpus expects, and says floor false only where the corpus does (2)", () => {
    for (const name of cases) {
      const b = get(name);
      for (const u of b.expected.unknowns ?? []) {
        const a = ask(b, { kind: "unknowns", target: { file: u.file }, limit: 500 });
        expect((a.items as { line: number | null; cause: string }[]).some((x) => x.line === u.line && x.cause === u.cause), `${name}: ${u.file}:${u.line} ${u.cause}`).toBe(true);
      }
      for (const [spec, floor] of Object.entries(b.expected.floor ?? {})) {
        if (floor) continue;
        const a = ask(b, { kind: "callers", target: { id: idOf(b.graph, spec) } });
        expect(a.unknown.floor, `${name}: ${spec}`).toBe(false);
      }
    }
  });
});

describe("callers, callees and their gaps", () => {
  it("says a floor with the value-call reason when a computed member call could reach the symbol (2)", () => {
    const b = get("typescript/gaps/computed-member-call");
    const a = ask(b, { kind: "callers", target: { name: "onSave" } });
    // The table's entry is a possible caller, never a counted one, and the list stays a floor.
    expect((a.items as Item[]).map((i) => [i.fromName, i.kind, i.site.tier, i.site.evidence])).toEqual([["dispatch", "may_invoke", "possible", "value-table"]]);
    expect(a.counts).toEqual({ certain: 0, likely: 0, possible: 1 });
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/function value/);
    // What does `dispatch` call: each entry of the table as possible, and the computed call stays a gap of the answer.
    const out = ask(b, { kind: "callees", target: { name: "dispatch" } });
    expect((out.items as Item[]).map((i) => [i.toName, i.site.tier])).toEqual([
      ["onSave", "possible"],
      ["onDelete", "possible"],
    ]);
    expect(out.unknown.floor).toBe(true);
    expect(out.unknown.causes.dynamic).toBe(1);
  });

  it("says a floor when a file of the project was not read (2)", () => {
    const b = get("typescript/cuts/file-not-read");
    const a = ask(b, { kind: "callers", target: { name: "toCents" } });
    expect(a.items.map((i) => where(i as Item))).toEqual(["src/checkout.ts:4"]);
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/not read/);
    const u = ask(b, { kind: "unknowns", target: { file: "src/generated/prices.ts" } });
    expect(u.items).toContainEqual(expect.objectContaining({ file: "src/generated/prices.ts", cause: "file-not-parsed" }));
  });

  it("stops at the depth asked and names the frontier, without a count past it (4)", () => {
    const b = get("typescript/cuts/thirty-second-hop");
    const one = ask(b, { kind: "callers", target: { name: "baseRate" }, depth: 1 });
    expect(one.items.map((i) => where(i as Item))).toEqual(["src/quote.ts:4"]);
    expect(one.truncated).toMatchObject({ by: "depth", omitted: null, omittedExact: false, cursor: null });
    expect(one.truncated.frontier?.some((id) => id.includes("#quote@"))).toBe(true);
    const two = ask(b, { kind: "callers", target: { name: "baseRate" }, depth: 2, limit: 500 });
    expect((two.items as Item[]).filter((i) => i.depth === 2).length).toBeGreaterThanOrEqual(30);
  });

  it("stops a cancelled walk at once, with null counts and a cursor that goes on with the work (4)", () => {
    const b = get("typescript/cuts/thirty-second-hop");
    const abort = new AbortController();
    abort.abort();
    const req = { kind: "callers" as const, target: { name: "baseRate" }, depth: 3, limit: 500 };
    const a = ask(b, req, { signal: abort.signal });
    expect(a.error).toBeNull();
    expect(a.items).toEqual([]);
    expect(a.counts).toEqual({ certain: null, likely: null, possible: null });
    expect(a.truncated).toMatchObject({ by: "budget", omitted: null, omittedExact: false });
    expect(a.unknown.floor).toBe(true);
    // The cursor runs the stopped work on, to the answer a whole run gives.
    const rest = ask(b, { ...req, cursor: a.truncated.cursor as string });
    const whole = ask(b, req);
    expect(rest.truncated.by).toBe(whole.truncated.by);
    expect(rest.items).toEqual(whole.items);
    expect(rest.counts).toEqual(whole.counts);
  });

  it("pages a hub's 45 callers by cursor and cuts by tokens without touching the counts (5)", () => {
    const b = get("typescript/cuts/hub");
    const p1 = ask(b, { kind: "callers", target: { name: "logEvent" }, limit: 20 });
    expect(p1.items).toHaveLength(20);
    expect(p1.counts.certain).toBe(45);
    expect(p1.truncated).toMatchObject({ by: "limit", omitted: 25, omittedExact: true });
    const p2 = ask(b, { kind: "callers", target: { name: "logEvent" }, limit: 20, cursor: p1.truncated.cursor as string });
    const p3 = ask(b, { kind: "callers", target: { name: "logEvent" }, limit: 20, cursor: p2.truncated.cursor as string });
    expect(p3.items).toHaveLength(5);
    expect(p3.truncated.by).toBeNull();
    const all = new Set([...p1.items, ...p2.items, ...p3.items].map((i) => where(i as Item)));
    expect(all.size).toBe(45);
    const tiny = ask(b, { kind: "callers", target: { name: "logEvent" }, budget: { tokens: 1 } });
    expect(tiny.items).toHaveLength(1);
    expect(tiny.counts.certain).toBe(45);
    expect(tiny.truncated).toMatchObject({ by: "budget", omitted: 44, omittedExact: true });
    const next = ask(b, { kind: "callers", target: { name: "logEvent" }, budget: { tokens: 1 }, cursor: tiny.truncated.cursor as string });
    expect(next.items).toHaveLength(1);
    expect(where(next.items[0] as Item)).not.toBe(where(tiny.items[0] as Item));
  });
});

describe("changes, impact, path, outline and packages", () => {
  it("gives the review's own walk for the diff, and for one symbol (9)", () => {
    const b = get("typescript/cuts/thirty-second-hop");
    const summary = detectImpact(b.graph, b.change);
    const a = ask(b, { kind: "impact", limit: 500 }, { change: b.change });
    const callers = a.items.filter((x) => (x as { type: string }).type === "caller") as { seed: string; hops: Item[] }[];
    expect(callers.length).toBe(summary.callers.length);
    expect(callers.map((c) => c.hops.map(where).join(">")).sort()).toEqual(summary.callers.map((p) => p.edges.map((e) => `${e.sites[0]?.file}:${e.sites[0]?.line}`).join(">")).sort());
    expect(a.unknown.floor).toBe(summary.unknown.floor);
    for (const c of callers) for (const h of c.hops) expect(ask(b, { kind: "explain", target: { id: h.edge } }).error).toBeNull();
    const one = ask(b, { kind: "impact", target: { name: "baseRate" }, limit: 500 });
    expect(one.error).toBeNull();
    expect((one.items as { type: string; hops?: Item[] }[]).filter((x) => x.type === "caller").map((x) => where((x.hops as Item[])[0] as Item))).toContain("src/quote.ts:4");
  });

  it("explains every hop of a path, and says a floor when no path is found past an unbound call (6)", () => {
    const ws = get("typescript/workspace/workspace-package");
    const p = ask(ws, { kind: "path", target: { name: "start" }, to: { name: "greet" } });
    expect(p.error).toBeNull();
    expect(p.items.map((i) => [(i as Item).kind, where(i as Item)])).toEqual([["calls", "packages/app/src/main.ts:4"]]);
    expect(ask(ws, { kind: "explain", target: { id: (p.items[0] as Item).edge } }).error).toBeNull();
    const gap = get("typescript/gaps/computed-member-call");
    const none = ask(gap, { kind: "path", target: { name: "dispatch" }, to: { name: "onSave" } });
    expect(none.error).toBeNull();
    expect(none.items).toEqual([]);
    expect(none.unknown.floor).toBe(true);
    expect(none.unknown.reasons.join(" ")).toMatch(/could not be bound/);
  });

  it("names which packages depend on a package by their import lines, and no other (11)", () => {
    const b = get("typescript/workspace/workspace-package");
    const a = ask(b, { kind: "packages", target: { project: "packages/core" } });
    expect(a.error).toBeNull();
    expect(a.items).toEqual([expect.objectContaining({ project: "packages/app", sites: ["packages/app/src/main.ts:1"] })]);
    const app = ask(b, { kind: "packages", target: { project: "packages/app" } });
    expect(app.items).toEqual([]);
  });
});

describe("questions the corpus holds nothing for", () => {
  let repo: string;
  let s: Session;
  const files: Record<string, string> = {
    "src/shapes.ts": [
      "export class Base {",
      "  run(): number {",
      "    return 1;",
      "  }",
      "}",
      "export class Mid extends Base {",
      "  run(): number {",
      "    return 2;",
      "  }",
      "}",
      "export class Leaf extends Mid {}",
      "",
    ].join("\n"),
    "src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
    "src/b.ts": 'import { c } from "./c";\nexport function b(): number {\n  return c();\n}\n',
    "src/c.ts": 'import { a } from "./a";\nexport function c(): number {\n  return a.length;\n}\n',
    "src/d.ts": 'import { a } from "./a";\nexport function d(): number {\n  return a();\n}\n',
    "srcx/other.ts": "export function other(): number {\n  return 0;\n}\n",
    "test/b.test.ts": 'import { b } from "../src/b";\nexport function checksB(): boolean {\n  return b() === 1;\n}\n',
  };
  beforeAll(async () => {
    repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "q-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">) => query(s, { apiVersion: 1, ...req } as Request);

  it("lists subclasses two levels down, and an override at the tier of the inheritance that proves it (12)", () => {
    const a = q({ kind: "implementers", target: { name: "Base" } });
    expect(a.error).toBeNull();
    expect((a.items as Item[]).map((i) => [i.fromName, i.kind, i.depth, i.site.tier])).toEqual([
      ["Mid", "inherits", 1, "certain"],
      ["Leaf", "inherits", 2, "certain"],
    ]);
    const m = q({ kind: "implementers", target: { name: "Base.run" } });
    expect(m.error).toBeNull();
    const o = m.items as Item[];
    // `class Mid extends Base` in the same file proves the inheritance, and the lookup order the override.
    expect(o.map((i) => [i.from.includes("#Mid.run@"), i.kind, i.site.tier, i.site.evidence, i.site.rule])).toEqual([[true, "overrides", "certain", "same-scope", "override"]]);
    expect(q({ kind: "explain", target: { id: o[0]?.edge } }).error).toBeNull();
    // Calls through interfaces and base types are resolved, and no class of
    // this repository names its base with an expression: the answer is whole (15).
    expect(m.unknown.reasons.join(" ")).not.toMatch(/not resolved/);
    expect(m.unknown.floor).toBe(false);
    expect(q({ kind: "implementers", target: { name: "Base" } }).unknown.floor).toBe(false);
    expect(q({ kind: "implementers", target: { name: "other" } }).error?.code).toBe("bad-request");
  });

  it("finds the import cycle among a, b and c and nothing else (8)", () => {
    const a = q({ kind: "cycles", level: "files" });
    expect(a.error).toBeNull();
    expect(a.items).toEqual([expect.objectContaining({ members: ["src/a.ts", "src/b.ts", "src/c.ts"] })]);
    const edges = (a.items[0] as { edges: Item[] }).edges;
    expect(edges.map(where).sort()).toEqual(["src/a.ts:1", "src/b.ts:1", "src/c.ts:1"]);
  });

  it("names tests by their path as leads only, never counted and never coverage, with the floor (7)", () => {
    const a = q({ kind: "tests", target: { name: "b" } });
    expect(a.error).toBeNull();
    expect(a.items).toEqual([]);
    expect(a.counts).toEqual({ certain: null, likely: null, possible: null });
    expect(a.leads.map((l) => l.file)).toEqual(["test/b.test.ts"]);
    expect(a.unknown.floor).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/coverage|covered/i);
  });

  it("outlines a folder without a folder that shares its name prefix (10)", () => {
    const a = q({ kind: "outline", target: { file: "src" } });
    expect(a.error).toBeNull();
    const fileList = [...new Set((a.items as { file: string }[]).map((i) => i.file))].sort();
    expect(fileList).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/shapes.ts"]);
  });

  it("finds a path through two calls and back the other way when only that direction holds (6)", () => {
    const fwd = q({ kind: "path", target: { name: "d" }, to: { name: "c" } });
    expect(fwd.items.map((i) => (i as Item).toName)).toEqual(["a", "b", "c"]);
    const back = q({ kind: "path", target: { name: "c" }, to: { name: "d" } });
    expect(back.items.map((i) => (i as Item).toName)).toEqual(["a", "b", "c"]);
    expect((back.items as (Item & { direction?: string })[])[0]?.direction).toBe("reverse");
  });
});

describe("implementers at the edge of what the graph reads", () => {
  let s: Session;
  const files: Record<string, string> = {
    "src/base.ts": "export class Base {\n  run(): number {\n    return 0;\n  }\n}\n",
    "src/l1.ts": 'import { Base } from "./base";\nexport class L1 extends Base {}\n',
    "src/l2.ts": 'import { L1 } from "./l1";\nexport class L2 extends L1 {}\n',
    "src/l3.ts": 'import { L2 } from "./l2";\nexport class L3 extends L2 {}\n',
    "src/l4.ts": 'import { L3 } from "./l3";\nexport class L4 extends L3 {\n  run(): number {\n    return 4;\n  }\n}\n',
    "src/l5.ts": 'import { L4 } from "./l4";\nexport class L5 extends L4 {\n  run(): number {\n    return 5;\n  }\n}\n',
    "src/mixed.ts": 'import { Base } from "./base";\nfunction identity<T>(x: T): T {\n  return x;\n}\nexport class Child extends identity(Base) {}\n',
  };
  beforeAll(async () => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "edge-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">) => query(s, { apiVersion: 1, ...req } as Request);

  it("says the depth stopped an override search, and names the override past it (14)", () => {
    // L4.run overrides Base.run (no class between defines run), and L5.run overrides L4.run.
    const one = q({ kind: "implementers", target: { name: "Base.run" }, depth: 1 });
    expect(one.error).toBeNull();
    expect((one.items as Item[]).map((i) => i.from)).toEqual([expect.stringMatching(/#L4\.run@/)]);
    expect(one.truncated.by).toBe("depth");
    expect(one.truncated.frontier?.some((id) => id.includes("#L4.run@"))).toBe(true);
    const two = q({ kind: "implementers", target: { name: "Base.run" }, depth: 2 });
    expect((two.items as Item[]).map((i) => i.from)).toEqual([expect.stringMatching(/#L4\.run@/), expect.stringMatching(/#L5\.run@/)]);
    expect(two.truncated.by).toBeNull();
  });

  it("says a floor for a base written as an expression, and names the class that carries it (15)", () => {
    const a = q({ kind: "implementers", target: { name: "Base" } });
    expect(a.error).toBeNull();
    expect((a.items as Item[]).map((i) => i.fromName)).toEqual(["L1", "L2", "L3"]);
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/base with an expression/);
    expect(a.unknown.reasons.join(" ")).toMatch(/Child at src\/mixed\.ts:5/);
    expect(a.unknown.causes["dynamic-base"]).toBe(1);
    // The same boundary holds for the overrides of a method.
    expect(q({ kind: "implementers", target: { name: "Base.run" } }).unknown.causes["dynamic-base"]).toBe(1);
    // The gap is recorded on the class, where the unknowns question finds it.
    // Base, imported and passed only as a value, leaves the import's own gap:
    // no use of it in the file is read.
    const u = q({ kind: "unknowns", target: { file: "src/mixed.ts" } });
    expect((u.items as { cause: string; line: number | null }[]).map((x) => [x.cause, x.line])).toEqual([["dynamic-base", 5], ["unsupported-rule", 1]]);
  });
});

describe("impact of a public name used in more places than the summary keeps", () => {
  it("lists every place that used the removed alias, past the summary's 200 (16)", async () => {
    const uses = Array.from({ length: 200 }, (_, i) => `export const v${i} = total([${i}]);`).join("\n");
    const repo = makeRepo({
      "src/pricing.ts": "function computeTotal(items: number[]): number {\n  return items.length;\n}\n\nexport { computeTotal as total };\nexport { computeTotal };\n",
      "src/cart.ts": `import { total } from "./pricing";\n${uses}\n`,
    });
    commitAll(repo);
    writeFiles(repo, { "src/pricing.ts": "function computeTotal(items: number[]): number {\n  return items.length;\n}\n\nexport { computeTotal };\n" });
    const change = await getChange({ repoRoot: repo, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({ repoRoot: repo, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const t: Session = { graph, generation: "consumers-build", treeSha: null, builtAt: null, laterEditsKnown: false };
    const a = query(t, { apiVersion: 1, kind: "impact", limit: 500 }, { change });
    expect(a.error).toBeNull();
    const e = a.items.find((x) => (x as { type: string }).type === "export") as { name: string; consumers: unknown[] } | undefined;
    expect(e?.name).toBe("total");
    expect(e?.consumers).toHaveLength(201);
  });
});

describe("the relations the resolver keeps apart from calls", () => {
  let s: Session;
  const files: Record<string, string> = {
    "src/repo.ts": [
      "export interface Repo {",
      "  save(x: number): number;",
      "}",
      "export class SqlRepo implements Repo {",
      "  save(x: number): number {",
      "    return x;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "src/use.ts": [
      'import type { Repo } from "./repo";',
      "export function store(r: Repo): number {",
      "  return r.save(1);",
      "}",
      "",
    ].join("\n"),
    "src/handlers.ts": "export function onSave(): number {\n  return 1;\n}\n",
    "src/app.ts": 'import { onSave } from "./handlers";\nexport function register(add: (f: () => number) => void): void {\n  add(onSave);\n}\n',
  };
  beforeAll(async () => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "refs-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">) => query(s, { apiVersion: 1, ...req } as Request);

  it("answers references from the uses as a value and as a type, each with an edge explain reads back (17)", () => {
    const v = q({ kind: "references", target: { name: "onSave" } });
    expect(v.error).toBeNull();
    expect((v.items as Item[]).map((i) => [i.fromName, i.kind, where(i)])).toEqual([["register", "uses_value", "src/app.ts:3"]]);
    const t = q({ kind: "references", target: { name: "Repo" } });
    expect(t.error).toBeNull();
    expect((t.items as Item[]).map((i) => [i.fromName, i.kind])).toContainEqual(["store", "uses_type"]);
    for (const i of [...(v.items as Item[]), ...(t.items as Item[])]) expect(q({ kind: "explain", target: { id: i.edge } }).error).toBeNull();
  });

  it("lists the method that implements an interface member, and says a class of the same shape may be missing (17)", () => {
    const m = q({ kind: "implementers", target: { name: "Repo.save" } });
    expect(m.error).toBeNull();
    const items = m.items as Item[];
    expect(items.map((i) => [i.from.includes("#SqlRepo.save@"), i.kind])).toEqual([[true, "overrides"]]);
    expect(q({ kind: "explain", target: { id: items[0]?.edge } }).error).toBeNull();
    expect(m.unknown.floor).toBe(true);
    expect(m.unknown.reasons.join(" ")).toMatch(/by its shape/);
    const i = q({ kind: "implementers", target: { name: "Repo" } });
    expect((i.items as Item[]).map((x) => [x.fromName, x.kind])).toEqual([["SqlRepo", "implements"]]);
  });

  it("gives impact the possible callers the review's walk lists apart (17)", () => {
    const a = q({ kind: "impact", target: { name: "SqlRepo.save" }, limit: 500 });
    expect(a.error).toBeNull();
    const possible = (a.items as { type: string; hops?: Item[] }[]).filter((x) => x.type === "possible-caller");
    expect(possible.map((x) => (x.hops as Item[]).map((h) => [h.fromName, h.kind, h.site.tier]))).toEqual([[["store", "dispatches_to", "possible"]]]);
    expect(a.counts.possible).toBe(1);
  });
});

describe("a base written as an expression in Python and Ruby (15)", () => {
  const build = async (files: Record<string, string>): Promise<Session> => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    return { graph, generation: "bases-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  };
  const ask1 = (t: Session, req: Omit<Request, "apiVersion">) => query(t, { apiVersion: 1, ...req } as Request);

  it("says no floor for a Python class generic over a type, and one for a base made by a call", async () => {
    const typed = await build({
      "app/base.py": "from typing import Generic, TypeVar\n\nT = TypeVar(\"T\")\n\n\nclass Base:\n    def run(self):\n        return 0\n\n\nclass Box(Generic[T]):\n    pass\n\n\nclass Meta(Base, metaclass=type):\n    pass\n",
    });
    const whole = ask1(typed, { kind: "implementers", target: { name: "Base" } });
    expect((whole.items as Item[]).map((i) => i.fromName)).toEqual(["Meta"]);
    expect(whole.unknown.floor).toBe(false);
    const made = await build({
      "app/base.py": "class Base:\n    def run(self):\n        return 0\n\n\ndef make(b):\n    return b\n\n\nclass Child(make(Base)):\n    pass\n",
    });
    const short = ask1(made, { kind: "implementers", target: { name: "Base" } });
    expect(short.items).toEqual([]);
    expect(short.unknown.floor).toBe(true);
    expect(short.unknown.causes["dynamic-base"]).toBe(1);
  });

  it("records a Ruby superclass made by a call and an include of an expression, and not `extend self`", async () => {
    const t = await build({
      "lib/row.rb": "class Row < Struct.new(:a)\n  include Helpers.pick\nend\n\nmodule Tools\n  extend self\nend\n",
    });
    const u = ask1(t, { kind: "unknowns", target: { file: "lib/row.rb" } });
    expect((u.items as { cause: string; line: number | null }[]).filter((x) => x.cause === "dynamic-base").map((x) => x.line)).toEqual([1, 2]);
  });
});

describe("a path through the definitions a function holds (18)", () => {
  let s: Session;
  const files: Record<string, string> = {
    "src/deps.ts": [
      "export class Sessions {",
      "  create(name: string): string {",
      "    return name;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "src/router.ts": [
      'import { Sessions } from "./deps";',
      "type Router = { openapi(route: string, h: (c: string) => string): void };",
      "export function createRouter(router: Router, sessions: Sessions): void {",
      "  const createHandler = (c: string): string => {",
      "    return sessions.create(c);",
      "  };",
      '  router.openapi("/sessions", createHandler);',
      "}",
      "export function unrelated(sessions: Sessions): (c: string) => string {",
      "  const createHandler = (c: string): string => sessions.create(c);",
      "  return createHandler;",
      "}",
      "export function makeApp(sessions: Sessions): () => () => string {",
      "  function outer(): () => string {",
      '    const inner = (): string => sessions.create("x");',
      "    return inner;",
      "  }",
      "  return outer;",
      "}",
      "export function plain(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  };
  beforeAll(async () => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "nested-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">) => query(s, { apiVersion: 1, ...req } as Request);
  const hops = (a: Answer) => (a.items as Item[]).map((i) => [i.kind, i.fromName, i.toName, where(i), i.site.tier]);

  it("reaches what a registered handler calls through a defines hop, never a direct call", () => {
    const a = q({ kind: "path", target: { name: "createRouter" }, to: { name: "Sessions.create" } });
    expect(a.error).toBeNull();
    expect(hops(a)).toEqual([
      ["defines", "createRouter", "createHandler", "src/router.ts:4", "certain"],
      ["calls", "createHandler", "create", "src/router.ts:5", "certain"],
    ]);
    // The defines hop names the handler of createRouter, not the one of the same name in unrelated.
    expect((a.items as Item[])[0]?.to).toContain("#createRouter.createHandler@");
    for (const i of a.items as Item[]) expect(q({ kind: "explain", target: { id: i.edge } }).error).toBeNull();
  });

  it("follows a closure inside a closure, one defines hop a level", () => {
    const a = q({ kind: "path", target: { name: "makeApp" }, to: { name: "Sessions.create" } });
    expect(hops(a)).toEqual([
      ["defines", "makeApp", "outer", "src/router.ts:14", "certain"],
      ["defines", "outer", "inner", "src/router.ts:15", "certain"],
      ["calls", "inner", "create", "src/router.ts:15", "certain"],
    ]);
  });

  it("never reaches a handler of the same name that another function defines", () => {
    const other = q({ kind: "path", target: { name: "createRouter" }, to: { name: "unrelated.createHandler" } });
    expect(other.error).toBeNull();
    expect(other.items).toEqual([]);
    const none = q({ kind: "path", target: { name: "plain" }, to: { name: "Sessions.create" } });
    expect(none.items).toEqual([]);
  });

  it("walks defines hops only when they are asked for, and leaves callers as they were", () => {
    const callsOnly = q({ kind: "path", target: { name: "createRouter" }, to: { name: "Sessions.create" }, edges: ["calls"] });
    expect(callsOnly.items).toEqual([]);
    const callers = q({ kind: "callers", target: { name: "Sessions.create" } });
    expect((callers.items as Item[]).map((i) => i.fromName).sort()).toEqual(["createHandler", "createHandler", "inner"]);
  });
});

describe("impact of a change inside a definition a function holds (19)", () => {
  let s: Session;
  const files: Record<string, string> = {
    "src/service.ts": ["export function saveSession(name: string): string {", "  return name;", "}", ""].join("\n"),
    "src/factory.ts": [
      'import { saveSession } from "./service";',
      "type Router = { openapi(route: string, h: (c: string) => string): void };",
      "export function createSessionsRouter(router: Router): void {",
      "  const createSessionHandler = (c: string): string => {",
      "    return saveSession(c);",
      "  };",
      '  router.openapi("/sessions", createSessionHandler);',
      "}",
      "export function topLevel(c: string): string {",
      "  return saveSession(c);",
      "}",
      "",
    ].join("\n"),
    "src/main.ts": [
      'import { createSessionsRouter, topLevel } from "./factory";',
      "export function main(): string {",
      "  createSessionsRouter({ openapi: () => undefined });",
      '  return topLevel("x");',
      "}",
      "export function boot(): string {",
      "  return main();",
      "}",
      "",
    ].join("\n"),
  };
  beforeAll(async () => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "held-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  type Row = { type: string; seed: string; hops: Item[] };
  const q = (req: Omit<Request, "apiVersion">, extra: Parameters<typeof query>[2] = {}) => query(s, { apiVersion: 1, ...req } as Request, extra);
  const rows = (a: Answer, type: string) => (a.items as Row[]).filter((r) => r.type === type).map((r) => r.hops.map((h) => `${h.fromName} ${h.kind} ${h.toName} at ${where(h)}`).join(" < "));
  const insideHandler = { files: [{ path: "src/factory.ts", status: "modified" as const, oldPath: null, binary: false }], coverage: new Map([["src/factory.ts", new LineSet().add(5)]]) };

  it("lists the factory that holds the changed handler and the callers of the factory, apart from direct callers", () => {
    const a = q({ kind: "impact", limit: 500 }, { change: insideHandler });
    expect(a.error).toBeNull();
    // The handler is never called by name, so it has no direct caller.
    expect(rows(a, "caller")).toEqual([]);
    expect(rows(a, "held-by")).toEqual(["createSessionsRouter defines createSessionHandler at src/factory.ts:4"]);
    expect(rows(a, "held-by-caller")).toEqual([
      "createSessionsRouter defines createSessionHandler at src/factory.ts:4 < main calls createSessionsRouter at src/main.ts:3",
      "createSessionsRouter defines createSessionHandler at src/factory.ts:4 < main calls createSessionsRouter at src/main.ts:3 < boot calls main at src/main.ts:7",
    ]);
    const held = (a.items as Row[]).filter((r) => r.type.startsWith("held-by"));
    for (const r of held) expect(r.seed).toContain("#createSessionsRouter.createSessionHandler@");
    for (const r of held) for (const h of r.hops) expect(q({ kind: "explain", target: { id: h.edge } }).error).toBeNull();
    // The same answer for the handler named as a target.
    const one = q({ kind: "impact", target: { file: "src/factory.ts", line: 5 }, limit: 500 });
    expect(rows(one, "held-by-caller")).toEqual(rows(a, "held-by-caller"));
  });

  it("gives a top-level function no held-by group, and its callers as before", () => {
    const a = q({ kind: "impact", target: { name: "topLevel" }, limit: 500 });
    expect(a.error).toBeNull();
    expect((a.items as Row[]).filter((r) => r.type.startsWith("held-by"))).toEqual([]);
    expect(rows(a, "caller")).toEqual(["main calls topLevel at src/main.ts:4", "main calls topLevel at src/main.ts:4 < boot calls main at src/main.ts:7"]);
  });

  it("leaves the review's own walk as it was", () => {
    const sum = detectImpact(s.graph, insideHandler);
    expect(sum.callers).toEqual([]);
    expect(Object.keys(sum)).not.toContain("heldBy");
  });

  it("walks callees into the definitions a function holds only when defines is asked", () => {
    const plain = q({ kind: "callees", target: { name: "createSessionsRouter" }, depth: 2 });
    expect((plain.items as Item[]).filter((i) => i.kind === "defines")).toEqual([]);
    expect((plain.items as Item[]).map((i) => i.toName)).not.toContain("saveSession");
    const held = q({ kind: "callees", target: { name: "createSessionsRouter" }, depth: 2, edges: ["calls", "defines"] });
    expect(held.error).toBeNull();
    expect((held.items as Item[]).map((i) => `${i.fromName} ${i.kind} ${i.toName} at ${where(i)}`)).toEqual([
      "createSessionsRouter defines createSessionHandler at src/factory.ts:4",
      "createSessionHandler calls saveSession at src/factory.ts:5",
    ]);
    expect(q({ kind: "callees", target: { name: "createSessionsRouter" }, edges: ["imports"] }).error?.code).toBe("bad-request");
  });
});

describe("packages, one import site per import line (20)", () => {
  let s: Session;
  const manifest = (name: string, deps: Record<string, string>) => JSON.stringify({ name, version: "1.0.0", type: "module", ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}), exports: { ".": "./src/index.ts" } });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "acme", private: true }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/core/package.json": manifest("@acme/core", {}),
    "packages/core/src/index.ts": "export type Name = string;\nexport function greet(name: Name): string {\n  return name;\n}\nexport function bye(): string {\n  return \"bye\";\n}\n",
    "packages/app/package.json": manifest("@acme/app", { "@acme/core": "workspace:*" }),
    // Three lines name the package: a type import, a value import and a re-export.
    "packages/app/src/twice.ts": 'import type { Name } from "@acme/core";\nimport { greet } from "@acme/core";\nexport { bye } from "@acme/core";\nexport function hi(n: Name): string {\n  return greet(n);\n}\n',
    // One import of two names, written over four lines: one site.
    "packages/app/src/once.ts": 'import {\n  greet,\n  bye,\n} from "@acme/core";\nexport function both(): string {\n  return greet("a") + bye();\n}\n',
    // A file of core itself imports nothing from another package.
    "packages/core/src/self.ts": 'import { greet } from "./index";\nexport function me(): string {\n  return greet("me");\n}\n',
  };
  beforeAll(async () => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "packages-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">) => query(s, { apiVersion: 1, ...req } as Request);

  it("lists every line of a file that imports the package, and one site for one import of several names", () => {
    const a = q({ kind: "packages", target: { project: "packages/core" } });
    expect(a.error).toBeNull();
    expect(a.items).toEqual([expect.objectContaining({ project: "packages/app", importSites: 4 })]);
    expect((a.items[0] as { sites: string[] }).sites.sort()).toEqual(["packages/app/src/once.ts:1", "packages/app/src/twice.ts:1", "packages/app/src/twice.ts:2", "packages/app/src/twice.ts:3"]);
  });

  it("still lists a file once among the importers of the module it imports twice", () => {
    const a = q({ kind: "importers", target: { file: "packages/core/src/index.ts" } });
    expect(a.error).toBeNull();
    expect((a.items as Item[]).map((i) => i.from).sort()).toEqual(["packages/app/src/once.ts", "packages/app/src/twice.ts", "packages/core/src/self.ts"]);
  });
});

describe("a walk past one hop floors on every point it expanded (21)", () => {
  let s: Session;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
    "src/t.ts": "export function target(): number {\n  return 1;\n}\n",
    "src/a.ts": 'import { target } from "./t";\nexport function middle(cb: () => void): number {\n  cb();\n  return target();\n}\n',
    "src/b.ts": 'import { middle } from "./a";\nexport function top(): number {\n  return middle(() => {});\n}\nexport const handlers = { middle };\n',
  };
  beforeAll(async () => {
    const repo = makeRepo(files);
    const graph = await buildGraph({ repoRoot: repo, store: null });
    s = { graph, generation: "deep-floor-build", treeSha: null, builtAt: null, laterEditsKnown: false };
  });
  const q = (req: Omit<Request, "apiVersion">) => query(s, { apiVersion: 1, ...req } as Request);

  it("floors callers two hops deep when a caller it lists has a floor, naming that caller and its gap", () => {
    const one = q({ kind: "callers", target: { name: "target", file: "src/t.ts" } });
    expect(one.error).toBeNull();
    expect(one.unknown.floor).toBe(false);
    const two = q({ kind: "callers", target: { name: "target", file: "src/t.ts" }, depth: 2 });
    expect(two.error).toBeNull();
    expect((two.items as Item[]).map((i) => i.fromName).sort()).toEqual(["middle", "top"]);
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.reasons.join(" ")).toMatch(/callers of `middle` at src\/a\.ts:2, which this answer walks through, may be missing: it is used as a value in 1 place, first at src\/b\.ts:5/);
    expect(two.unknown.gaps).toContainEqual(expect.objectContaining({ file: "src/b.ts", line: 5 }));
  });

  it("floors callees two hops deep on a call it could not bind in a callee it lists", () => {
    expect(q({ kind: "callees", target: { name: "top", file: "src/b.ts" } }).unknown.floor).toBe(false);
    const two = q({ kind: "callees", target: { name: "top", file: "src/b.ts" }, depth: 2 });
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.gaps).toContainEqual(expect.objectContaining({ file: "src/a.ts", line: 3 }));
  });

  it("floors impact when a caller whose callers it lists has a floor, in the review's summary and the answer", () => {
    const change = { files: [{ path: "src/t.ts", status: "modified" as const, oldPath: null, binary: false }], coverage: new Map([["src/t.ts", new LineSet().add(2)]]) };
    const sum = detectImpact(s.graph, change);
    const seed = sum.unknown.seeds.find((x) => x.seed.includes("#target@"));
    expect(seed?.floor).toBe(true);
    expect(seed?.reasons.join(" ")).toMatch(/callers of `middle` at src\/a\.ts:2, which this answer walks through, may be missing: it is used as a value in 1 place, first at src\/b\.ts:5/);
    const a = query(s, { apiVersion: 1, kind: "impact", limit: 500 } as Request, { change });
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.gaps).toContainEqual(expect.objectContaining({ file: "src/b.ts", line: 5 }));
  });

  it("names at most 20 of the floors it walks through and counts the rest", async () => {
    const n = 25;
    const many: Record<string, string> = { "package.json": files["package.json"] as string, "src/t.ts": files["src/t.ts"] as string };
    for (let i = 0; i < n; i++) many[`src/m${i}.ts`] = `import { target } from "./t";\nexport function m${i}(): number {\n  return target();\n}\n`;
    many["src/h.ts"] = `${Array.from({ length: n }, (_, i) => `import { m${i} } from "./m${i}";\n`).join("")}export const hs = [${Array.from({ length: n }, (_, i) => `m${i}`).join(", ")}];\n`;
    const graph = await buildGraph({ repoRoot: makeRepo(many), store: null });
    const a = query({ graph, generation: "deep-floor-many", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "callers", target: { name: "target", file: "src/t.ts" }, depth: 2 } as Request);
    expect(a.error).toBeNull();
    expect(a.unknown.reasons.filter((r) => r.startsWith("callers of `m"))).toHaveLength(20);
    expect(a.unknown.reasons).toContain("5 more callers this answer walks through may have callers missing too; ask `callers` about each");
    expect((a.unknown.gaps ?? []).length).toBeLessThanOrEqual(20);
  }, 60_000);
});
