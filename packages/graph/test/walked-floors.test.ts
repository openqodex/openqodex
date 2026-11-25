// A callers or impact answer is silent only when every path it covers was
// followed: the floor of each caller it walks through counts, not only the
// target's. Ways it could fail, written before the code:
//  1. A caller the answer walks through has a framework floor (a Next.js
//     middleware whose matcher is computed, a route registered by a computed
//     path in its project), and the answer reads only the core gaps of that
//     caller: it says nothing, though the framework may run the caller from
//     a place the graph does not list.
//  2. The floor of a caller at the last hop, whose callers the answer does
//     not list, floors the answer anyway: every deep answer floors, and the
//     warning means nothing.
//  3. A caller three hops deep is not read: only the first hop's are.
//  4. The time budget stops the question while it reads those floors, and
//     the answer it gives is short and silent.
//  5. A React component reached by a JSX element reads as having no caller
//     when the React plugin leaves its renders edge out: the plugin's caps
//     are excused from the caller floor (query/frameworks.ts DATA_KINDS).
//
// Each source of a floor, by where it sits in the answer. "target" is the
// symbol asked about (the seed of an impact); "hop 2" a caller one hop from
// the target, whose callers the answer lists as its second hop; "hop 3" a
// caller two hops from the target in a depth-3 walk. A framework gap
// reaches a walked caller through the same function as the target
// (callerFloor, query/frameworks.ts), so one plugin per way a gap is scoped
// stands for every plugin with that scope; the escape corpus holds a case
// per plugin cap at the target. A gap for the whole build, a plugin that
// failed or stopped, and a partial build floor every answer, the target's
// included, so a walked caller adds nothing there. An impact question
// checks its budget once, before it starts, and then runs whole.
//
// | source                       | callers target       | callers hop 2       | callers hop 3        | impact target        | impact hop 2         |
// |------------------------------|----------------------|---------------------|----------------------|----------------------|----------------------|
// | core gap (value use)         | gaps.test.ts 6       | query-questions 21  | here (core 3)        | gaps.test.ts 6       | query-questions 21   |
// | framework, one symbol        | here (nextjs)        | here (nextjs)       | here (nextjs)        | here (nextjs)        | here (nextjs)        |
// | framework, its project       | here (express)       | here (express)      | same path as hop 2   | here (express)       | here (express)       |
// | framework, the whole build   | here (whole build)   | as target           | as target            | here (whole build)   | as impact target     |
// | plugin failed or stopped     | here (failed)        | as target           | as target            | here (failed)        | as impact target     |
// | partial build                | here (partial)       | here (partial)      | as hop 2             | here (partial)       | as impact target     |
// | walk cut: time budget        | query-budget 1, 2    | here (budget)       | here (budget)        | n/a: runs whole      | n/a: runs whole      |
// | walk cut: impact second hop  |                      |                     |                      | here (second hop)    | here (second hop)    |
// | walk cut: impact walk limit  |                      |                     |                      | gaps.test.ts 8       | gaps.test.ts 8       |
// | React renders (5)            | here (react)         | here (react)        | as hop 2             | here (react)         | as hop 2             |
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LineSet } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Item, Request, Session } from "../src/query/engine.js";
import { checksBudget } from "../src/query/traverse.js";
import { commitAll, makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const session = (graph: Graph, generation: string): Session => ({ graph, generation, treeSha: null, builtAt: null, laterEditsKnown: false });
const committed = async (files: Record<string, string>, more: Partial<Parameters<typeof buildGraph>[0]> = {}): Promise<Graph> => {
  const root = makeRepo(files);
  commitAll(root);
  return buildGraph({ repoRoot: root, store: null, ...more });
};
const ask = (s: Session, req: Omit<Request, "apiVersion">, checks?: number): Answer => query(s, { apiVersion: 1, limit: 500, ...req } as Request, checks === undefined ? {} : { budget: checksBudget(checks) });
// An impact answer for a change of the lines given in one file.
const changeAt = (file: string, ...lines: number[]) => {
  const set = new LineSet();
  for (const l of lines) set.add(l);
  return { files: [{ path: file, status: "modified" as const, oldPath: null, binary: false }], coverage: new Map([[file, set]]) };
};
const impactOf = (s: Session, file: string, line: number): Answer => query(s, { apiVersion: 1, kind: "impact", limit: 500 } as Request, { change: changeAt(file, line) });
const fromNames = (a: Answer) => [...new Set((a.items as Item[]).map((i) => i.fromName))].sort();

// A Next.js app whose middleware has a computed matcher and calls `a`, which calls `target`.
const NEXT_APP: Record<string, string> = {
  "package.json": '{"name":"web","dependencies":{"next":"14.0.0"}}\n',
  "lib/t.ts": "export function target() {\n  return 1;\n}\n",
  "lib/a.ts": 'import { target } from "./t";\n\nexport function a() {\n  return target();\n}\n',
  "middleware.ts": 'import { NextResponse } from "next/server";\nimport { a } from "./lib/a";\n\nconst base = "/api";\n\nexport function middleware() {\n  a();\n  return NextResponse.next();\n}\n\nexport const config = { matcher: [`${base}/:path*`] };\n',
  "app/page.tsx": "export default function Page() {\n  return null;\n}\n",
};

describe("a framework gap of one symbol, at each place the answer walks through (1, 2, 3)", () => {
  let s: Session;
  beforeAll(async () => {
    s = session(await committed(NEXT_APP), "walked-nextjs");
  }, 60_000);

  it("floors the middleware's own callers (target)", () => {
    const m = ask(s, { kind: "callers", target: { name: "middleware", file: "middleware.ts" } });
    expect(m.unknown.floor).toBe(true);
    expect(m.unknown.reasons.join(" ")).toMatch(/matcher is computed/);
  });

  it("floors callers two hops deep through the middleware, and not one hop deep (hop 2)", () => {
    expect(ask(s, { kind: "callers", target: { name: "a", file: "lib/a.ts" } }).unknown.floor).toBe(false);
    const two = ask(s, { kind: "callers", target: { name: "a", file: "lib/a.ts" }, depth: 2 });
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.reasons.join(" ")).toMatch(/callers of `middleware` at middleware\.ts:6, which this answer walks through, may be missing: .*matcher is computed/);
    expect(two.unknown.gaps).toContainEqual(expect.objectContaining({ cause: "dynamic", file: "middleware.ts", line: 11 }));
  });

  it("floors callers three hops deep when the middleware is two hops out, and not two hops deep (hop 3)", () => {
    const two = ask(s, { kind: "callers", target: { name: "target", file: "lib/t.ts" }, depth: 2 });
    expect(fromNames(two)).toEqual(["a", "middleware"]);
    expect(two.unknown.floor).toBe(false);
    const three = ask(s, { kind: "callers", target: { name: "target", file: "lib/t.ts" }, depth: 3 });
    expect(three.unknown.floor).toBe(true);
    expect(three.unknown.reasons.join(" ")).toMatch(/callers of `middleware` at middleware\.ts:6, which this answer walks through/);
  });

  it("floors the impact of a change to the middleware (impact target)", () => {
    const i = impactOf(s, "middleware.ts", 7);
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.reasons.join(" ")).toMatch(/matcher is computed/);
    expect(i.unknown.gaps).toContainEqual(expect.objectContaining({ cause: "dynamic", file: "middleware.ts", line: 11 }));
  });

  it("floors the impact of a change that the middleware calls, at its second hop (impact hop 2)", () => {
    const i = impactOf(s, "lib/a.ts", 4);
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.reasons.join(" ")).toMatch(/callers of `middleware` at middleware\.ts:6, which this answer walks through, may be missing: .*matcher is computed/);
    expect(i.unknown.gaps).toContainEqual(expect.objectContaining({ cause: "dynamic", file: "middleware.ts", line: 11 }));
    // The change one hop further out reaches the middleware at its last hop only: no floor from it.
    expect(impactOf(s, "lib/t.ts", 2).unknown.floor).toBe(false);
  });

  it("stops while it reads the floors of the callers it walked as a floor, and gives the whole answer when the budget allows (4)", () => {
    const req = { kind: "callers" as const, target: { name: "target", file: "lib/t.ts" }, depth: 3 };
    const b = checksBudget(Number.MAX_SAFE_INTEGER);
    const whole = query(s, { apiVersion: 1, limit: 500, ...req } as Request, { budget: b });
    for (let n = 1; n < b.checks; n++) {
      const a = ask(s, req, n);
      expect(a.truncated.by, `stopped after ${n} checks`).toBe("budget");
      expect(a.unknown.floor, `stopped after ${n} checks`).toBe(true);
    }
    expect(ask(s, req, b.checks).unknown).toEqual(whole.unknown);
  });
});

describe("a framework gap of the whole build, and a plugin that failed", () => {
  type Layer = { unknowns: unknown[]; plugins: { id: string; status: string; reason: string | null }[] };
  const layerOf = (g: Graph) => (g as unknown as { frameworks: Layer }).frameworks;
  const everywhere = (s: Session, why: RegExp) => {
    for (const [name, file] of [["target", "lib/t.ts"], ["a", "lib/a.ts"]] as const) {
      const one = ask(s, { kind: "callers", target: { name, file } });
      expect(one.unknown.floor, name).toBe(true);
      expect(one.unknown.reasons.join(" "), name).toMatch(why);
    }
    const i = impactOf(s, "lib/t.ts", 2);
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.reasons.join(" ")).toMatch(why);
  };

  it("floors every callers and impact answer on a gap of the whole build (target, impact target)", async () => {
    const g = await committed(NEXT_APP);
    layerOf(g).unknowns.push({ plugin: "rails", site: null, scope: { build: true }, affects: [], cause: "budget", name: null, note: "the Rails plugin ran out of its work budget", count: null, exact: false });
    everywhere(session(g, "walked-build-gap"), /the rails plugin gave up \(budget\): the Rails plugin ran out of its work budget/);
  }, 60_000);

  it("floors every callers and impact answer when a plugin failed (target, impact target)", async () => {
    const g = await committed(NEXT_APP);
    const run = layerOf(g).plugins.find((p) => p.id === "nextjs");
    expect(run).toBeDefined();
    Object.assign(run as object, { status: "failed", reason: "boom" });
    everywhere(session(g, "walked-plugin-failed"), /the nextjs plugin failed \(boom\)/);
  }, 60_000);
});

describe("a framework gap of a project, reaching a caller in it and not the target in another (1)", () => {
  let s: Session;
  beforeAll(async () => {
    s = session(
      await committed({
        "package.json": '{"name":"root","private":true}\n',
        "lib/package.json": '{"name":"lib"}\n',
        "lib/src/t.ts": "export function target(): number {\n  return 1;\n}\n",
        "api/package.json": '{"name":"api","dependencies":{"express":"^4.18.0"}}\n',
        "api/src/use.ts": 'import { target } from "../../lib/src/t";\n\nexport function useT(): number {\n  return target();\n}\n',
        "api/src/app.ts": 'import express from "express";\n\nfunction pathFor(): string {\n  return "/x";\n}\nexport const app = express();\napp.get(pathFor(), (_req: unknown, _res: unknown) => undefined);\n',
      }),
      "walked-express",
    );
  }, 60_000);

  it("floors the caller in the project with the gap (target), and leaves the target in the other project whole", () => {
    expect(ask(s, { kind: "callers", target: { name: "useT", file: "api/src/use.ts" } }).unknown.floor).toBe(true);
    expect(ask(s, { kind: "callers", target: { name: "target", file: "lib/src/t.ts" } }).unknown.floor).toBe(false);
  });

  it("floors callers two hops deep, and the impact's second hop, on the caller's project gap (hop 2, impact hop 2)", () => {
    const two = ask(s, { kind: "callers", target: { name: "target", file: "lib/src/t.ts" }, depth: 2 });
    expect(two.unknown.floor).toBe(true);
    expect(two.unknown.reasons.join(" ")).toMatch(/callers of `useT` at api\/src\/use\.ts:3, which this answer walks through, may be missing: the express plugin gave up at api\/src\/app\.ts:7/);
    const i = impactOf(s, "lib/src/t.ts", 2);
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.gaps).toContainEqual(expect.objectContaining({ file: "api/src/app.ts", line: 7 }));
  });

  it("floors the impact of a change to the caller in the project with the gap (impact target)", () => {
    const i = impactOf(s, "api/src/use.ts", 4);
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.reasons.join(" ")).toMatch(/the express plugin gave up at api\/src\/app\.ts:7/);
  });
});

describe("a core gap three hops out, and a partial build (3)", () => {
  const files = {
    "package.json": '{"name":"app","private":true,"type":"module"}\n',
    "src/t.ts": "export function t(): number {\n  return 1;\n}\n",
    "src/a.ts": 'import { t } from "./t";\nexport function a(): number {\n  return t();\n}\n',
    "src/b.ts": 'import { a } from "./a";\nexport function b(): number {\n  return a();\n}\nexport const hs = [b];\n',
  };

  it("floors callers three hops deep on the use as a value of the caller two hops out, and not two hops deep (hop 3)", async () => {
    const s = session(await committed(files), "walked-core");
    expect(ask(s, { kind: "callers", target: { name: "t", file: "src/t.ts" }, depth: 2 }).unknown.floor).toBe(false);
    const three = ask(s, { kind: "callers", target: { name: "t", file: "src/t.ts" }, depth: 3 });
    expect(three.unknown.floor).toBe(true);
    expect(three.unknown.reasons.join(" ")).toMatch(/callers of `b` at src\/b\.ts:2, which this answer walks through, may be missing: it is used as a value/);
  }, 60_000);

  it("floors every answer of a partial build (target, hop 2, impact target)", async () => {
    const g = await committed(files, { maxFiles: 2 });
    expect(g.status.status).toBe("partial");
    const s = session(g, "walked-partial");
    for (const depth of [1, 2]) expect(ask(s, { kind: "callers", target: { name: "t", file: "src/t.ts" }, depth }).unknown.floor, `depth ${depth}`).toBe(true);
    expect(impactOf(s, "src/t.ts", 2).unknown.floor).toBe(true);
  }, 60_000);
});

describe("the impact walk's second-hop cut", () => {
  it("floors the seed whose caller had more callers than the second hop keeps (impact target, impact hop 2)", async () => {
    const n = 21;
    const files: Record<string, string> = {
      "package.json": '{"name":"app","private":true,"type":"module"}\n',
      "src/t.ts": "export function t(): number {\n  return 1;\n}\n",
      "src/a.ts": 'import { t } from "./t";\nexport function a(): number {\n  return t();\n}\n',
    };
    for (let i = 0; i < n; i++) files[`src/c${i}.ts`] = `import { a } from "./a";\nexport function c${i}(): number {\n  return a();\n}\n`;
    const s = session(await committed(files), "walked-second-hop");
    const sum = detectImpact(s.graph, changeAt("src/t.ts", 2));
    expect(sum.cuts.some((c) => c.by === "second-hop")).toBe(true);
    const i = impactOf(s, "src/t.ts", 2);
    expect(i.unknown.floor).toBe(true);
    expect(i.unknown.reasons.join(" ")).toMatch(/the second hop keeps 20 callers of each caller/);
  }, 60_000);
});

describe("a React component reached by a JSX element (5)", () => {
  let s: Session;
  let g: Graph;
  beforeAll(async () => {
    g = await committed({
      "package.json": '{"name":"ui","dependencies":{"react":"^18.2.0"}}\n',
      "src/Badge.tsx": "export function Badge() {\n  return <span>b</span>;\n}\n",
      "src/Card.tsx": 'import { Badge } from "./Badge";\n\nexport function Card() {\n  return <Badge />;\n}\n',
      "src/Page.tsx": 'import { Card } from "./Card";\n\nexport function Page() {\n  return <Card />;\n}\n',
      "src/Pick.tsx": 'import { memo } from "react";\nimport { Card } from "./Card";\n\nconst Shown = memo(Card);\nexport function Pick() {\n  return <Shown />;\n}\n',
    });
    s = session(g, "walked-react");
  }, 60_000);

  it("lists the element as a call of the core graph, which no React cap can leave out (target, hop 2)", () => {
    const badge = ask(s, { kind: "callers", target: { name: "Badge", file: "src/Badge.tsx" }, depth: 2 });
    expect((badge.items as Item[]).map((i) => [i.fromName, i.site.file, i.site.line, i.kind])).toEqual(expect.arrayContaining([["Card", "src/Card.tsx", 4, "calls"]]));
    // The same rows with the framework layer gone: no row of a callers answer rests on a React edge.
    const bare = session({ ...g, frameworks: undefined } as unknown as Graph, "walked-react-bare");
    expect(ask(bare, { kind: "callers", target: { name: "Badge", file: "src/Badge.tsx" }, depth: 2 }).items).toEqual(badge.items);
    expect(ask(bare, { kind: "callers", target: { name: "Card", file: "src/Card.tsx" }, depth: 2 }).items).toEqual(ask(s, { kind: "callers", target: { name: "Card", file: "src/Card.tsx" }, depth: 2 }).items);
  });

  it("floors a component an element reaches through a value the React plugin cannot name, on its use as a value (target, hop 2, impact target)", () => {
    const card = ask(s, { kind: "callers", target: { name: "Card", file: "src/Card.tsx" } });
    expect(card.unknown.floor).toBe(true);
    expect(card.unknown.reasons.join(" ")).toMatch(/used as a value/);
    const badge = ask(s, { kind: "callers", target: { name: "Badge", file: "src/Badge.tsx" }, depth: 2 });
    expect(badge.unknown.reasons.join(" ")).toMatch(/callers of `Card` at src\/Card\.tsx:3, which this answer walks through, may be missing: it is used as a value/);
    expect(impactOf(s, "src/Card.tsx", 4).unknown.floor).toBe(true);
  });
});
