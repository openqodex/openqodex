// A host program keeps a graph outside the graph folder: it builds one with
// the library, saves the files `writeIndex` returns wherever it likes, reads
// them back later with `readIndexFrom` and asks questions over the result.
// Everything here comes from the built library (dist/lib.js), the way a
// program gets it. Build first (`pnpm build`).
//
// Ways this could fail, written before the code:
// 1. `writeIndex` leaves out a file `readIndexFrom` needs (the project
//    model), so a graph saved from the library alone never loads again.
// 2. The graph read back answers a question differently from the graph it
//    was written from: a caller, an importer or a path is lost on the way.
// 3. The graph read back does not know its repository root.
// 4. A question needs an index the loaded graph has not prepared, so the
//    first question after a load throws or answers from nothing.
// 5. A program calls `assemble` the way 0.22.0 allowed, without the escape
//    facts: it throws, or every caller list it answers says complete.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

type Lib = typeof import("../src/lib.js");
type Session = import("../src/lib.js").Session;
type Request = import("../src/lib.js").Request;
type Answer = import("../src/lib.js").Answer;
type Item = import("../src/lib.js").Item;

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(dirname(here), "dist", "lib.js");

// Three TypeScript files and one Python file: a call chain handle > checkout
// > chargeCard across files, a call inside one file, and a Python chain the
// TypeScript one never reaches.
const FILES: Record<string, string> = {
  "src/payments.ts": "export function chargeCard(amount: number): number {\n  return amount * 100;\n}\n\nexport function refund(amount: number): number {\n  return chargeCard(-amount);\n}\n",
  "src/checkout.ts": 'import { chargeCard } from "./payments.js";\n\nexport function checkout(total: number): number {\n  return chargeCard(total);\n}\n',
  "src/api.ts": 'import { checkout } from "./checkout.js";\n\nexport function handle(req: { total: number }): number {\n  return checkout(req.total);\n}\n',
  "billing.py": "def charge_card(amount):\n    return amount\n\n\ndef bill(amount):\n    return charge_card(amount)\n",
};

function makeRepo(): string {
  const root = tempDir("oq-lib-graph-");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "test"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
  return root;
}

const where = (i: Item) => `${i.site.file}:${i.site.line}`;

// One request per operation, so the fresh and the loaded graph are compared
// on every question the engine answers, not only on the eight asserted below.
function requestFor(kind: Request["kind"]): Request {
  const base: Request = { apiVersion: 1, kind, limit: 500 };
  switch (kind) {
    case "search":
      return { ...base, text: "charge" };
    case "outline":
      return { ...base, target: { file: "src" } };
    case "importers":
      return { ...base, target: { file: "src/payments.ts" } };
    case "path":
      return { ...base, target: { name: "handle" }, to: { name: "chargeCard" } };
    case "packages":
      return { ...base, target: { project: "." } };
    case "explain":
      return { ...base, target: { id: "none" } };
    case "status":
    case "capabilities":
    case "cycles":
    case "changes":
    case "unknowns":
      return base;
    default:
      return { ...base, target: { name: "chargeCard" } };
  }
}

describe("a graph kept outside the graph folder through the library", () => {
  let lib: Lib;
  let fresh: Session;
  let loaded: Session;
  let root: string;
  let files: Record<string, string>;

  beforeAll(async () => {
    lib = (await import(libPath)) as Lib;
    root = makeRepo();
    // 1. Build.
    const g = await lib.graph.buildGraph({ repoRoot: root, store: null, budgetMs: 20_000, maxFiles: 50 });
    expect(g.status.filesParsed).toBe(4);
    // 2. The files, saved anywhere: here, a plain object.
    files = lib.graph.writeIndex(g);
    const saved: Record<string, string> = { ...files };
    // 3. Later: read back and prepare.
    const g2 = lib.graph.readIndexFrom((name) => saved[name] ?? null, root);
    expect(g2, "the saved files did not load back into a graph").not.toBeNull();
    if (!g2) throw new Error("no graph");
    lib.graph.prepareIndexes(g);
    lib.graph.prepareIndexes(g2);
    const session = (graph: typeof g): Session => ({ graph, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false });
    fresh = session(g);
    loaded = session(g2);
  });

  const ask = (s: Session, req: Partial<Request> & Pick<Request, "kind">): Promise<Answer> => lib.graph.querySliced(s, { apiVersion: 1, limit: 500, ...req });

  it("writes every file the read needs, including the project model (1)", () => {
    expect(Object.keys(files)).toContain("projects.json");
    expect(Object.keys(files)).toContain("index/format.json");
    expect(lib.graph.readIndexFrom((name) => (name === "projects.json" ? null : (files[name] ?? null)), root)).toBeNull();
  });

  it("knows its repository root after the load (3)", () => {
    expect(loaded.graph.repoRoot).toBe(root);
    expect(loaded.graph.nodes.size).toBe(fresh.graph.nodes.size);
    expect(loaded.graph.edges.length).toBe(fresh.graph.edges.length);
  });

  it("answers outline, symbol, callers, callees, importers, path, impact and search from the loaded graph (2, 4)", async () => {
    const outline = await ask(loaded, { kind: "outline", target: { file: "src" } });
    expect(outline.error).toBeNull();
    expect([...new Set((outline.items as { file: string }[]).map((i) => i.file))].sort()).toEqual(["src/api.ts", "src/checkout.ts", "src/payments.ts"]);

    const symbol = await ask(loaded, { kind: "symbol", target: { name: "chargeCard" } });
    expect(symbol.error).toBeNull();
    expect(symbol.target).toMatchObject({ name: "chargeCard", file: "src/payments.ts", line: 1 });
    expect((symbol.items[0] as { callerSites: number }).callerSites).toBe(2);

    const callers = await ask(loaded, { kind: "callers", target: { name: "chargeCard" } });
    expect(callers.error).toBeNull();
    expect((callers.items as Item[]).map(where).sort()).toEqual(["src/checkout.ts:4", "src/payments.ts:6"]);
    expect(callers.counts.certain).toBe(2);

    const callees = await ask(loaded, { kind: "callees", target: { name: "checkout" } });
    expect(callees.error).toBeNull();
    expect((callees.items as Item[]).map((i) => i.toName)).toEqual(["chargeCard"]);

    const importers = await ask(loaded, { kind: "importers", target: { file: "src/payments.ts" } });
    expect(importers.error).toBeNull();
    expect((importers.items as Item[]).map((i) => i.site.file)).toEqual(["src/checkout.ts"]);

    const path = await ask(loaded, { kind: "path", target: { name: "handle" }, to: { name: "chargeCard" } });
    expect(path.error).toBeNull();
    expect((path.items as Item[]).map((i) => i.toName)).toEqual(["checkout", "chargeCard"]);

    const impact = await ask(loaded, { kind: "impact", target: { name: "chargeCard" } });
    expect(impact.error).toBeNull();
    const hops = (impact.items as { type: string; hops?: Item[] }[]).filter((x) => x.type === "caller").map((x) => where((x.hops as Item[])[0] as Item));
    // One path per caller chain: checkout, handle through checkout, and refund.
    expect(hops.length).toBe(3);
    expect([...new Set(hops)].sort()).toEqual(["src/checkout.ts:4", "src/payments.ts:6"]);

    const search = await ask(loaded, { kind: "search", text: "charge" });
    expect(search.error).toBeNull();
    // Prefix matches are items, never certain and never counted as callers.
    expect((search.items as { name: string; tier: string }[]).map((l) => `${l.name} ${l.tier}`).sort()).toEqual(["chargeCard possible", "charge_card possible"]);
    expect(search.counts).toEqual({ certain: null, likely: null, possible: null });

    const python = await ask(loaded, { kind: "callers", target: { name: "charge_card" } });
    expect((python.items as Item[]).map(where)).toEqual(["billing.py:6"]);
  });

  it("gives the same answer as the graph it was written from, for every operation (2)", async () => {
    for (const kind of lib.graph.OPERATIONS) {
      const req = requestFor(kind);
      const a = await lib.graph.querySliced(fresh, req);
      const b = await lib.graph.querySliced(loaded, req);
      expect(b, `operation ${kind}`).toEqual(a);
    }
  });

  it("assembles a graph called the 0.22.0 way, with no escape facts, and keeps every floor (5)", async () => {
    const g = fresh.graph;
    const whole = await ask(fresh, { kind: "callers", target: { name: "chargeCard" } });
    expect(whole.unknown.floor, "the graph built whole should know every caller of chargeCard").toBe(false);
    const args = [[...g.nodes.values()], g.edges, [...g.importers.values()].flat(), g.misses, g.unknowns, g.status, g.model, g.goModules] as const;
    // The 0.22.0 signature: eight arguments, or a ninth without `escapes`.
    const assembled = [
      (lib.graph.assemble as (...a: unknown[]) => ReturnType<Lib["graph"]["assemble"]>)(...args),
      (lib.graph.assemble as (...a: unknown[]) => ReturnType<Lib["graph"]["assemble"]>)(...args, { references: g.references, dispatch: g.dispatch, summaries: g.summaries }),
    ];
    for (const a of assembled) {
      a.repoRoot = root;
      lib.graph.prepareIndexes(a);
      const s: Session = { graph: a, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false };
      const callers = await ask(s, { kind: "callers", target: { name: "chargeCard" } });
      expect(callers.error).toBeNull();
      expect(callers.unknown.floor).toBe(true);
      expect(callers.unknown.reasons.join(" ")).toMatch(/escape facts were not given/);
      const seed = g.nodes.get((callers.target as { id: string }).id);
      if (!seed) throw new Error("no seed");
      expect(lib.graph.floorReasons(a, { id: seed.id, name: seed.name, file: seed.file, kind: seed.kind as "function" }, new Set())).toContainEqual(expect.stringMatching(/escape facts were not given/));
      // Saved and read back, it never loads as a graph that knows its escapes.
      const kept = lib.graph.writeIndex(a);
      expect(lib.graph.readIndexFrom((name) => kept[name] ?? null, root)).toBeNull();
    }
  });
});
