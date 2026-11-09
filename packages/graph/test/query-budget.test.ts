// The time budget of a question, its resumption, and the floors of a walk.
// Ways it could fail, written before the code:
//  1. The budget is not seen while a name is looked up, while a hub's edges
//     are expanded, while the points past the depth are checked, while a
//     list is aggregated (packages, cycles) or sorted, so a question runs
//     on past its budget.
//  2. Work the budget stopped is presented as whole: no floor, no frontier.
//  3. A cursor redoes the walk: the next page computes the list again, and
//     a walk the budget stopped starts again from nothing instead of from
//     where it stopped.
//  4. A resumed walk gives a different answer from one that ran whole.
//  5. What a walk two hops out calls is a floor only for gaps at its first
//     point: an unbound call at the second hop is not said.
//  6. The work tree changed in a file the graph reads besides source (a
//     package.json exports map, a tsconfig paths alias), and the answer
//     says no edit is known.
//  7. A cancellation that arrives while the work runs is not seen until
//     the work ends: the whole walk runs in one turn of the event loop.
//  8. A page read from a kept list carries the graph block of the moment
//     the list was made, so edits the session has learned of since are
//     not said.
//  9. Work that a slice of the MCP server stops starts again from its first
//     element instead of where it stopped (outline of a large folder), so
//     slices never finish and pile up duplicates until the deadline.
// 10. Work runs between two budget checks in proportion to the input, with
//     no check inside: listing the overrides of thousands of subclasses of
//     one file, or expanding one point with thousands of edges in a path
//     search, runs past the budget and cannot be cancelled.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, laterEdits, pinWorkTree } from "../src/index.js";
import { query, querySliced } from "../src/query/engine.js";
import type { Answer, Item, Request, Session } from "../src/query/engine.js";
import { checksBudget } from "../src/query/traverse.js";
import { cpuMs, expectLinear, growthTests } from "../src/test-timing.js";
import { commitAll, makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

// A hub with 300 callers, each called by two more, and a project of two packages.
function hubRepo(callers = 300): Record<string, string> {
  const files: Record<string, string> = { "src/hub.ts": "export function hub(): number {\n  return 1;\n}\n" };
  for (let i = 0; i < callers; i++) {
    files[`src/c${i}.ts`] = `import { hub } from "./hub";\nexport function c${i}(): number {\n  return hub();\n}\nexport function d${i}(): number {\n  return c${i}() + c${i}();\n}\n`;
  }
  return files;
}

let s: Session;
// The same with 75 callers, for the timing check of (9).
let quarter: Session;
beforeAll(async () => {
  const session = async (callers: number): Promise<Session> => ({ graph: await buildGraph({ repoRoot: makeRepo(hubRepo(callers)), store: null }), generation: "budget-build", treeSha: null, builtAt: null, laterEditsKnown: false });
  s = await session(300);
  quarter = await session(75);
}, 120_000);

const ask = (req: Omit<Request, "apiVersion">, checks?: number): Answer => query(s, { apiVersion: 1, ...req } as Request, checks === undefined ? {} : { budget: checksBudget(checks) });
const where = (i: Item) => `${i.site.file}:${i.site.line}:${i.from}`;

// How many budget checks a question makes when it runs whole.
function checksOf(req: Omit<Request, "apiVersion">): number {
  const b = checksBudget(Number.MAX_SAFE_INTEGER);
  query(s, { apiVersion: 1, ...req } as Request, { budget: b });
  return b.checks;
}

describe("the budget of a question", () => {
  it("is seen inside the name lookup, the hub's edges, the frontier check and the sort, and stops there (1, 2)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, depth: 2, limit: 500 };
    const whole = checksOf(req);
    expect(whole).toBeGreaterThan(600);
    // Stopped while the name is looked up: no target yet, a floor and a resume.
    const early = ask(req, 1);
    expect(early.error).toBeNull();
    expect(early.truncated).toMatchObject({ by: "budget", omitted: null, omittedExact: false });
    expect(early.truncated.cursor).not.toBeNull();
    expect(early.unknown.floor).toBe(true);
    // Stopped in the middle of the hub's 300 callers: past the name lookup
    // (what a question about the symbol alone costs) and 150 edges on.
    const lookup = checksOf({ kind: "symbol", target: { name: "hub" } });
    expect(lookup).toBeLessThan(whole / 2);
    const mid = ask(req, lookup + 150);
    expect(mid.truncated.by).toBe("budget");
    expect(mid.items.length).toBeLessThan(900);
    expect(mid.truncated.frontierTotal ?? 0).toBeGreaterThan(0);
    expect(mid.unknown.floor).toBe(true);
    expect(mid.unknown.reasons.join(" ")).toMatch(/time budget/);
    // Every stop point up to the whole run is a stop, never a silent short answer.
    for (const n of [2, 10, Math.floor(whole / 2), whole - 2]) {
      const a = ask(req, n);
      expect(a.truncated.by, `stopped after ${n} checks`).toBe("budget");
      expect(a.unknown.floor, `stopped after ${n} checks`).toBe(true);
    }
  });

  it("stops the package aggregation and the cycle search at the budget, as a floor (1, 2)", () => {
    // All asked first with a small budget: a whole run keeps what it
    // gathered for the graph, and a later question no longer needs the work.
    const reqs = [{ kind: "packages" as const }, { kind: "cycles" as const }, { kind: "cycles" as const, level: "projects" as const }];
    for (const req of reqs) {
      const name = JSON.stringify(req);
      const a = ask(req, 50);
      expect(a.truncated.by, name).toBe("budget");
      expect(a.unknown.floor, name).toBe(true);
      expect(a.counts, name).toEqual({ certain: null, likely: null, possible: null });
    }
    for (const req of reqs) {
      const name = JSON.stringify(req);
      const done = ask(req);
      expect(done.truncated.by, name).toBeNull();
    }
  });

  it("resumes a stopped walk from where it stopped, and gives the whole walk's answer (3, 4)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, depth: 2, limit: 500 };
    const whole = checksOf(req);
    // 900 items: the first page of 500 is cut by the limit, not the budget.
    const full = ask(req);
    expect(full.truncated.by).toBe("limit");
    const half = Math.ceil(whole / 2);
    const first = ask(req, half);
    expect(first.truncated.by).toBe("budget");
    // The rest of the walk fits in what is left; a walk from nothing would not.
    const rest = ask({ ...req, cursor: first.truncated.cursor as string }, whole - half + 20);
    expect(rest.truncated.by).toBe("limit");
    expect(rest.items.map((i) => where(i as Item))).toEqual(full.items.map((i) => where(i as Item)));
    expect(rest.counts).toEqual(full.counts);
    expect(ask(req, whole - half + 20).truncated.by).toBe("budget");
  });

  it("reads the next page from the list it saved, without walking again (3)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, depth: 2, limit: 100 };
    const p1 = ask(req);
    expect(p1.truncated).toMatchObject({ by: "limit", omittedExact: true });
    // One budget check is not enough to walk again; the saved list needs none.
    const p2 = ask({ ...req, cursor: p1.truncated.cursor as string }, 1);
    expect(p2.truncated.by).toBe("limit");
    expect(p2.items).toHaveLength(100);
    expect(p2.items.map((i) => where(i as Item))).not.toEqual(p1.items.map((i) => where(i as Item)));
  });
});

describe("a question worked in slices", () => {
  it("sees a cancellation that arrives while the walk runs, and stops there (7)", async () => {
    const req: Request = { apiVersion: 1, kind: "callers", target: { name: "hub" }, depth: 2, limit: 500 };
    const abort = new AbortController();
    // Queued before the question: it runs at the first turn the work gives back.
    setImmediate(() => abort.abort());
    const cancelled = await querySliced(s, req, { signal: abort.signal }, 100);
    expect(cancelled.truncated.by).toBe("budget");
    expect(cancelled.unknown.floor).toBe(true);
    expect(cancelled.counts).toEqual({ certain: null, likely: null, possible: null });
    // Not cancelled, the slices give the answer one run gives.
    const sliced = await querySliced(s, req, {}, 100);
    const whole = ask(req);
    expect(sliced.truncated.by).toBe("limit");
    expect(sliced.items.map((i) => where(i as Item))).toEqual(whole.items.map((i) => where(i as Item)));
    expect(sliced.counts).toEqual(whole.counts);
  });
});

describe("the floor of a walk", () => {
  it("says a floor when a call two hops out could not be bound, and not at one hop (5)", async () => {
    const root = makeRepo({
      "src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
      "src/b.ts": "const table: Record<string, () => number> = {};\nexport function b(): number {\n  return table.x ? 1 : table[String(Date.now())]();\n}\n",
    });
    const graph = await buildGraph({ repoRoot: root, store: null });
    const t: Session = { graph, generation: null, treeSha: null, builtAt: null, laterEditsKnown: false };
    const one = query(t, { apiVersion: 1, kind: "callees", target: { name: "a" }, depth: 1 });
    expect(one.unknown.floor).toBe(false);
    const two = query(t, { apiVersion: 1, kind: "callees", target: { name: "a" }, depth: 2 });
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.causes.dynamic).toBe(1);
    expect(two.unknown.reasons.join(" ")).toMatch(/could not be bound/);
  });
});

describe("edits since the held build", () => {
  it("are said on a page read from the kept list, not only on the first page (8)", () => {
    const req = { kind: "callers" as const, target: { name: "hub" }, limit: 100 };
    const p1 = ask(req);
    expect(p1.truncated.by).toBe("limit");
    expect(p1.graph.freshness.laterEditsKnown).toBe(false);
    s.laterEditsKnown = true;
    try {
      const p2 = ask({ ...req, cursor: p1.truncated.cursor as string }, 1);
      expect(p2.items).toHaveLength(100);
      expect(p2.graph.freshness.laterEditsKnown).toBe(true);
    } finally {
      s.laterEditsKnown = false;
    }
  });

  const settings = { budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 512 * 1024, maxHeapMb: 1536 };
  const files = {
    "package.json": '{ "name": "root", "private": true }\n',
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }\n',
    "src/lib/x.ts": "export function x(): number {\n  return 1;\n}\n",
    "src/use.ts": 'import { x } from "@lib/x";\nexport function use(): number {\n  return x();\n}\n',
    "README.md": "# readme\n",
  };

  it("are known for a changed tsconfig alias and a changed manifest, and not for a file the graph never reads (6)", async () => {
    const root = makeRepo(files);
    commitAll(root);
    const pinned = await pinWorkTree({ repoRoot: root, store: null, settings, purpose: "cli" });
    try {
      expect(pinned.reference).not.toBeNull();
      const ref = pinned.reference as NonNullable<typeof pinned.reference>;
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(false);
      writeFileSync(join(root, "README.md"), "# readme, edited\n");
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(false);
      writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/other/*"] } } }\n');
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(true);
      writeFileSync(join(root, "tsconfig.json"), files["tsconfig.json"]);
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(false);
      writeFileSync(join(root, "package.json"), '{ "name": "root", "private": true, "exports": { ".": "./src/use.ts" } }\n');
      expect(await laterEdits(root, ref, settings.maxFileBytes)).toBe(true);
    } finally {
      pinned.release();
    }
  });
});

describe("work that resumes where a slice stopped it", () => {
  const req: Request = { apiVersion: 1, kind: "outline", target: { file: "src" }, limit: 500, budget: { ms: 10_000 } };
  it("outlines a folder of 301 files in slices of 100 checks, each symbol once (9)", async () => {
    const sliced = await querySliced(s, req, {}, 100);
    const whole = ask({ kind: "outline", target: { file: "src" }, limit: 500 });
    expect(whole.truncated.by).toBe("limit");
    expect(sliced.truncated.by).toBe("limit");
    const ids = (a: Answer) => (a.items as { id: string }[]).map((i) => i.id);
    expect(new Set(ids(sliced)).size).toBe(ids(sliced).length);
    expect(ids(sliced)).toEqual(ids(whole));
    expect(sliced.truncated.omitted).toBe(whole.truncated.omitted);
  });

  growthTests("well inside its budget", () => {
    it("outlines a folder of 301 files in slices in time that grows with the folder (9)", async () => {
      // A slice that started over would redo every slice before it, so its
      // time would grow with the square of the folder, up to the deadline.
      expectLinear("a sliced outline of folders of 76 and of 301 files", await cpuMs(() => querySliced(quarter, req, {}, 100)), await cpuMs(() => querySliced(s, req, {}, 100)));
    });
  });
});

describe("work with a budget check inside each element (10)", () => {
  let t: Session;
  // The same files at a quarter of each count, for the timing check.
  let tq: Session;
  // As many subclasses of Base in one file as stay under the 512 KB file cap.
  const SUBCLASSES = 6000;
  const CALLEES = 3000;
  const idOf = (name: string, in_: Session = t): string => {
    const a = query(in_, { apiVersion: 1, kind: "symbol", target: { name } });
    return (a.target as { id: string }).id;
  };
  beforeAll(async () => {
    const wide = async (subclasses: number, callees: number): Promise<Session> => {
      const classes = ["export class Base {", "  run(): number {", "    return 0;", "  }", "}"];
      for (let i = 0; i < subclasses; i++) classes.push(`export class S${i} extends Base {`, "  run(): number {", `    return ${i};`, "  }", "}");
      const fns: string[] = [];
      for (let i = 0; i < callees; i++) fns.push(`function f${i}(): number {\n  return ${i};\n}`);
      const calls = Array.from({ length: callees }, (_, i) => `f${i}()`).join(" + ");
      const root = makeRepo({
        "src/shapes.ts": `${classes.join("\n")}\n`,
        "src/fan.ts": `${fns.join("\n")}\nexport function fan(): number {\n  return ${calls};\n}\n`,
        "src/far.ts": "export function far(): number {\n  return 0;\n}\n",
      });
      // A long build budget: a busy machine must not leave the wide files out.
      const graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
      expect(graph.status.notRead).toEqual([]);
      return { graph, generation: "wide-build", treeSha: null, builtAt: null, laterEditsKnown: false };
    };
    t = await wide(SUBCLASSES, CALLEES);
    tq = await wide(SUBCLASSES / 4, CALLEES / 4);
  }, 180_000);

  const overrides = (): Request => ({ apiVersion: 1, kind: "implementers", target: { id: idOf("Base.run") }, depth: 1, limit: 500, budget: { ms: 100 } });
  growthTests("in time that grows with the subclasses", () => {
    it("lists the overrides of 6,000 subclasses of one file in time that grows with them", async () => {
      const req = overrides();
      // A listing that scans the file once per subclass grows with the square
      // of the subclasses: the whole listing of 1,500 and of 6,000.
      const all = (in_: Session) => () => query(in_, { ...req, target: { id: idOf("Base.run", in_) }, budget: { ms: 60_000 } });
      expectLinear("listing the overrides of 1,500 and of 6,000 subclasses", await cpuMs(all(tq)), await cpuMs(all(t)));
    });
  });

  it("lists the overrides of 6,000 subclasses of one file inside a small time budget, and in full when it has time", async () => {
    const req = overrides();
    const a = query(t, req);
    if (a.truncated.by === "budget") expect(a.unknown.floor).toBe(true);
    const full = query(t, { ...req, budget: { ms: 60_000 } });
    expect(full.truncated.by).toBe("limit");
    // Each override is bound in the same file as its base: certain.
    expect(full.counts.certain).toBe(SUBCLASSES);
    // The walk reads each override's edge and checks each past the depth,
    // so a cancellation is seen at every one.
    const b = checksBudget(Number.MAX_SAFE_INTEGER);
    query(t, req, { budget: b });
    expect(b.checks).toBeGreaterThan(2 * SUBCLASSES);
  });

  it("stops a path search inside a point with 3,000 edges, and goes on from there to the whole answer", () => {
    const req: Request = { apiVersion: 1, kind: "path", target: { id: idOf("fan") }, to: { id: idOf("far") }, edges: ["calls"], depth: 2 };
    const whole = query(t, req);
    expect(whole.error).toBeNull();
    expect(whole.items).toEqual([]);
    // Ten checks in: still inside the first point's edges, so a few of its
    // callees wait, never all of them.
    const early = query(t, req, { budget: checksBudget(10) });
    expect(early.truncated.by).toBe("budget");
    expect(early.truncated.frontierTotal ?? 0).toBeGreaterThan(0);
    expect(early.truncated.frontierTotal ?? 0).toBeLessThan(20);
    const b = checksBudget(Number.MAX_SAFE_INTEGER);
    query(t, req, { budget: b });
    expect(b.checks).toBeGreaterThan(2 * CALLEES);
    const rest = query(t, { ...req, cursor: early.truncated.cursor as string });
    expect(rest.truncated.by).toBe(whole.truncated.by);
    expect(rest.unknown).toEqual(whole.unknown);
  });
});
