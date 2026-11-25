// Each question decides for itself whether this build can answer it.
// `routes` rests on the plugins that read route registrations, `tests` on
// the test links and the calls from files named like tests, and neither on
// whether some other plugin found something else in the repository. Ways
// it could fail, written before the code:
//  1. A React package next to an unread Koa app turns `routes` into a
//     clean empty success (no items, floor false), because the React
//     plugin found components.
//  2. `routes` says unsupported without naming the server framework the
//     manifests declare and this build does not read.
//  3. A repository with routes this build reads and an unread server
//     framework beside them lists the read routes as the whole answer.
//  4. A plugin that does not read routes (React) makes a route answer a
//     floor when it fails, or a route reader's failure is dropped.
//  5. One plugin finding anything switches off the name-based leads of
//     `tests`, so a test file that calls the symbol is lost and the answer
//     is a clean zero.
//  6. One framework test link hides a call from another file named like a
//     test, or a lead is listed twice.
//  7. `capabilities` says routes are answered because a component reader
//     found components.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Answer, Request, Session } from "../src/query/engine.js";
import { makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const session = (graph: Graph): Session => ({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false });
const ask = (graph: Graph, req: Omit<Request, "apiVersion">): Answer => query(session(graph), { apiVersion: 1, ...req } as Request);
const built = (files: Record<string, string>): Promise<Graph> => buildGraph({ repoRoot: makeRepo(files), store: null });
const routeKeys = (a: Answer) => (a.items as { methods: string[]; pattern: string | null }[]).map((r) => `${r.methods.join(",")} ${r.pattern}`).sort();
// What a `capabilities` answer says this build cannot answer, by question.
const unsupported = (a: Answer): Record<string, string> => (a.items[0] as { unsupported?: Record<string, string> } | undefined)?.unsupported ?? {};

// Copies of the repro repositories of the trueforge report
// (engine-routes/synth/hono, hono-react; engine-callers/synth-tests).
const HONO_APP = {
  "src/app.ts": "import { Hono } from 'hono';\nimport { users } from './users';\nconst app = new Hono();\napp.get('/healthz', c => c.text('ok'));\napp.route('/api/v1/users', users);\nexport default app;\n",
  "src/users.ts": "import { Hono } from 'hono';\nexport const users = new Hono();\nusers.get('/:id', c => c.json({ id: c.req.param('id') }));\nusers.post('/', c => c.json({}));\n",
};
const HONO = { "package.json": '{"name":"hono-demo","version":"1.0.0","dependencies":{"hono":"^4.0.0"}}\n', ...HONO_APP };
const HONO_REACT = {
  "package.json": '{"name":"root","private":true,"workspaces":["ui","."],"dependencies":{"hono":"^4.0.0"}}\n',
  "ui/package.json": '{"name":"ui","version":"1.0.0","dependencies":{"react":"^19.0.0"}}\n',
  "ui/App.tsx": "import React from 'react';\nexport function App() { return <div>hi</div>; }\n",
  ...HONO_APP,
};
const SYNTH_TESTS = {
  "tests/iface.test.ts": "import { Store, type IStore } from '../src/store';\n// The test holds the store as its interface type: the call is a possible call of Store.finish.\nit('iface', () => { const s: IStore = new Store(); expect(s.finish('done')).toBe(true); });\n",
  "tests/suite.ts": "import type { IStore } from '../src/store';\n// Shared contract suite: the store arrives as the interface type (like storeContractSuite.ts).\nexport function contract(makeStore: () => IStore) {\n  const store = makeStore();\n  return store.finish('done');\n}\n",
  "src/store.ts": "export function isNonTerminal(state: string): boolean { return state !== 'done'; }\nexport interface IStore { finish(state: string): boolean }\nexport class Store implements IStore {\n  finish(state: string) { return !isNonTerminal(state); }\n}\n",
};
// A server framework no route reader of this build reads.
const KOA_APP = { "src/server.ts": "import Koa from 'koa';\nconst app = new Koa();\napp.use((ctx) => { ctx.body = 'ok'; });\napp.listen(3000);\n" };
const KOA = { "package.json": '{"name":"koa-demo","version":"1.0.0","dependencies":{"koa":"^2.15.0"}}\n', ...KOA_APP };
const KOA_REACT = {
  "package.json": '{"name":"root","private":true,"workspaces":["ui","."],"dependencies":{"koa":"^2.15.0"}}\n',
  "ui/package.json": '{"name":"ui","version":"1.0.0","dependencies":{"react":"^19.0.0"}}\n',
  "ui/App.tsx": "import React from 'react';\nexport function App() { return <div>hi</div>; }\n",
  ...KOA_APP,
};
const REACT_PKG = { "package.json": '{ "name": "synth", "dependencies": { "react": "18.3.1" } }\n', "src/App.tsx": "import React from 'react';\nexport function App() { return <div>hi</div>; }\n" };

const FASTAPI = {
  "pyproject.toml": '[project]\nname = "svc"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n',
  "svc/__init__.py": "",
  "svc/main.py": 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/items")\ndef list_items():\n    return []\n',
};
const EXPRESS = {
  "package.json": JSON.stringify({ name: "js", private: true, type: "module", dependencies: { express: "^4.21.2" } }),
  "src/server.js": 'import express from "express";\nexport const app = express();\nfunction show(req, res) {\n  res.end();\n}\napp.get("/items", show);\n',
};

describe("routes rest on the route readers alone", () => {
  it("answers unsupported for a Koa app and names Koa (2)", async () => {
    const a = ask(await built(KOA), { kind: "routes" });
    expect(a.error?.code).toBe("unsupported");
    expect(a.error?.message).toMatch(/Koa/);
  }, 60_000);

  it("answers the same for Koa with a React package beside it, never an empty success (1)", async () => {
    const g = await built(KOA_REACT);
    expect((g.frameworks?.plugins ?? []).find((p) => p.id === "react")?.status).toBe("ok");
    const a = ask(g, { kind: "routes" });
    expect(a.error?.code).toBe("unsupported");
    expect(a.error?.message).toMatch(/Koa/);
    expect(a.items).toEqual([]);
  }, 60_000);

  it("lists the routes of the Hono repro, alone and with a React package beside it, and names no unread server", async () => {
    for (const files of [HONO, HONO_REACT]) {
      const a = ask(await built(files), { kind: "routes" });
      expect(a.error).toBeNull();
      expect(routeKeys(a)).toEqual(["GET /api/v1/users/:id", "GET /healthz", "POST /api/v1/users"]);
      expect(a.unknown.reasons.join(" ")).not.toMatch(/does not read/);
    }
  }, 60_000);

  it("answers unsupported for a React-only repository, naming no framework it does not declare (1)", async () => {
    const a = ask(await built({ ...REACT_PKG, ...SYNTH_TESTS }), { kind: "routes" });
    expect(a.error?.code).toBe("unsupported");
    expect(a.error?.message).not.toMatch(/Hono|Nest|declares/);
  }, 60_000);

  it("names a Go server framework from go.mod that this build does not read (2)", async () => {
    const a = ask(
      await built({
        "go.mod": "module example.com/svc\n\ngo 1.22\n\nrequire github.com/labstack/echo/v4 v4.12.0\n",
        "main.go": 'package main\n\nimport "github.com/labstack/echo/v4"\n\nfunc main() {\n\te := echo.New()\n\te.GET("/ping", func(c echo.Context) error { return nil })\n\te.Start(":8080")\n}\n',
      }),
      { kind: "routes" },
    );
    expect(a.error?.code).toBe("unsupported");
    expect(a.error?.message).toMatch(/Echo \(github\.com\/labstack\/echo\)/);
  }, 60_000);

  it("lists the FastAPI routes of a repository with a Koa package too, as a floor that names Koa (3)", async () => {
    const a = ask(await built({ ...FASTAPI, "web/package.json": '{"name":"web","dependencies":{"koa":"^2.15.0"}}\n', "web/src/server.ts": KOA_APP["src/server.ts"] }), { kind: "routes" });
    expect(a.error).toBeNull();
    expect(routeKeys(a)).toEqual(["GET /items"]);
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/Koa/);
  }, 60_000);

  it("leaves the routes of an Express or FastAPI app unchanged when a React package is added (1, 4)", async () => {
    for (const app of [EXPRESS, FASTAPI]) {
      const alone = ask(await built(app), { kind: "routes" });
      const withReact = ask(await built({ ...app, "ui/package.json": '{"name":"ui","dependencies":{"react":"^19.0.0"}}\n', "ui/App.tsx": REACT_PKG["src/App.tsx"] }), { kind: "routes" });
      expect(alone.error).toBeNull();
      expect(withReact.error).toBeNull();
      expect(routeKeys(withReact)).toEqual(routeKeys(alone));
      expect(routeKeys(alone).length).toBe(1);
      expect(withReact.unknown.floor).toBe(alone.unknown.floor);
      expect(withReact.unknown.floor).toBe(false);
    }
  }, 120_000);

  it("keeps a route reader's failure as a floor, and ignores a failure of a plugin that reads no routes (4)", async () => {
    const g = await built({ ...FASTAPI, ...EXPRESS, "ui/package.json": '{"name":"ui","dependencies":{"react":"^19.0.0"}}\n', "ui/App.tsx": REACT_PKG["src/App.tsx"] });
    const fw = g.frameworks;
    if (!fw) throw new Error("the build ran no framework stage");
    expect(routeKeys(ask(g, { kind: "routes" }))).toEqual(["GET /items", "GET /items"]);
    // React fails: nothing of routes is missing.
    const react = fw.plugins.find((p) => p.id === "react");
    if (!react) throw new Error("no React run");
    Object.assign(react, { status: "failed", reason: "the react plugin failed: boom" });
    const reactDown = ask(g, { kind: "routes" });
    expect(reactDown.unknown.floor).toBe(false);
    // Express was stopped by the budget: its part is missing, FastAPI's is listed (partial output).
    const express = fw.plugins.find((p) => p.id === "express");
    if (!express) throw new Error("no Express run");
    Object.assign(express, { status: "stopped", reason: "the budget ran out before this plugin ran" });
    fw.entities = fw.entities.filter((e) => !("plugin" in e) || e.plugin !== "express");
    fw.edges = fw.edges.filter((e) => e.plugin !== "express");
    const partial = ask(g, { kind: "routes" });
    expect(partial.error).toBeNull();
    expect(routeKeys(partial)).toEqual(["GET /items"]);
    expect(partial.unknown.floor).toBe(true);
    expect(partial.unknown.reasons.join(" ")).toMatch(/express: the budget ran out/);
    // Every route reader failed: nothing was read, and the answer says so rather than unsupported.
    for (const p of fw.plugins) if (p.id === "fastapi") Object.assign(p, { status: "failed", reason: "the fastapi plugin failed: boom" });
    fw.entities = fw.entities.filter((e) => !("plugin" in e) || e.plugin !== "fastapi");
    fw.edges = fw.edges.filter((e) => e.plugin !== "fastapi");
    const down = ask(g, { kind: "routes" });
    expect(down.error).toBeNull();
    expect(down.items).toEqual([]);
    expect(down.unknown.floor).toBe(true);
    expect(down.unknown.reasons.join(" ")).toMatch(/fastapi plugin failed/);
  }, 60_000);
});

describe("tests keep their name-based leads whatever else a plugin found (5, 6)", () => {
  it("gives the same leads for the synth-tests repro with and without a React package, as a floor naming the symbol (5)", async () => {
    const without = ask(await built(SYNTH_TESTS), { kind: "tests", target: { name: "isNonTerminal" } });
    const withReact = ask(await built({ ...SYNTH_TESTS, ...REACT_PKG }), { kind: "tests", target: { name: "isNonTerminal" } });
    for (const a of [without, withReact]) {
      expect(a.error).toBeNull();
      expect(a.items).toEqual([]);
      expect(a.counts).toEqual({ certain: null, likely: null, possible: null });
      expect(a.leads.map((l) => l.file)).toEqual(["tests/iface.test.ts"]);
      expect(a.unknown.floor).toBe(true);
      expect(a.unknown.reasons.join(" ")).toMatch(/isNonTerminal/);
    }
  }, 60_000);

  it("says a floor naming the symbol when no test reaches it at all, with a plugin that found something", async () => {
    const a = ask(await built({ ...REACT_PKG, "src/lonely.ts": "export function lonely(): number {\n  return 1;\n}\n" }), { kind: "tests", target: { name: "lonely" } });
    expect(a.error).toBeNull();
    expect(a.items).toEqual([]);
    expect(a.leads).toEqual([]);
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/lonely/);
  }, 60_000);

  it("lists a framework test link and a call from another test file as a lead, each once (6)", async () => {
    const g = await built({
      "package.json": '{ "name": "ui", "dependencies": { "react": "18.3.1" }, "devDependencies": { "@testing-library/react": "16.0.0", "vitest": "2.1.0" } }\n',
      "src/fmt.ts": "export function fmt(n: number): string {\n  return String(n);\n}\n",
      "src/Card.tsx": 'import { fmt } from "./fmt";\nexport function Card({ n }: { n: number }) {\n  return <div>{fmt(n)}</div>;\n}\n',
      "src/Card.test.tsx": 'import { render } from "@testing-library/react";\nimport { describe, expect, it } from "vitest";\nimport { Card } from "./Card";\nimport { fmt } from "./fmt";\n\ndescribe("Card", () => {\n  it("shows the number", () => {\n    render(<Card n={1} />);\n    expect(fmt(1)).toBe("1");\n  });\n});\n',
      "test/fmt.test.ts": 'import { fmt } from "../src/fmt";\nexport function checksFmt(): boolean {\n  return fmt(2) === "2";\n}\n',
    });
    const a = ask(g, { kind: "tests", target: { name: "fmt" } });
    expect(a.error).toBeNull();
    const linked = (a.items as { site: { file: string } }[]).map((i) => i.site.file);
    expect(linked).toContain("src/Card.test.tsx");
    const leads = a.leads.map((l) => l.file);
    expect(leads).toContain("test/fmt.test.ts");
    // A test the framework already links is not listed again as a lead.
    const linkedFrom = new Set((a.items as { from: string }[]).map((i) => i.from));
    expect(a.leads.filter((l) => linkedFrom.has(l.id))).toEqual([]);
    expect(new Set(a.leads.map((l) => l.id)).size).toBe(a.leads.length);
    // A lead is never counted.
    expect(a.counts.certain! + (a.counts.likely ?? 0) + (a.counts.possible ?? 0)).toBe(a.items.length);
    expect(a.unknown.floor).toBe(true);
  }, 60_000);
});

describe("capabilities say per question what this build cannot answer (7)", () => {
  it("lists routes as unsupported for Koa with React, naming Koa, and not for Hono or FastAPI with React", async () => {
    const koa = unsupported(ask(await built(KOA_REACT), { kind: "capabilities" }));
    expect(koa.routes).toMatch(/Koa/);
    expect(unsupported(ask(await built(HONO_REACT), { kind: "capabilities" })).routes).toBeUndefined();
    const fastapi = unsupported(ask(await built({ ...FASTAPI, "ui/package.json": '{"name":"ui","dependencies":{"react":"^19.0.0"}}\n', "ui/App.tsx": REACT_PKG["src/App.tsx"] }), { kind: "capabilities" }));
    expect(fastapi.routes).toBeUndefined();
  }, 60_000);
});

describe("tests answer with many leads (review of query answers, 1)", () => {
  it("caps the leads at the page limit, says how many more there are, and repeats nothing on a later page", async () => {
    const calls: Record<string, string> = {};
    for (let i = 0; i < 12; i++) calls[`test/extra${i}.test.ts`] = `import { fmt } from "../src/fmt";\nexport function checks${i}(): boolean {\n  return fmt(${i}) === "${i}";\n}\n`;
    const g = await built({
      "package.json": '{ "name": "ui", "dependencies": { "react": "18.3.1" }, "devDependencies": { "@testing-library/react": "16.0.0", "vitest": "2.1.0" } }\n',
      "src/fmt.ts": "export function fmt(n: number): string {\n  return String(n);\n}\n",
      "src/Card.tsx": 'import { fmt } from "./fmt";\nexport function Card({ n }: { n: number }) {\n  return <div>{fmt(n)}</div>;\n}\n',
      "src/Card.test.tsx": 'import { render } from "@testing-library/react";\nimport { describe, expect, it } from "vitest";\nimport { Card } from "./Card";\nimport { fmt } from "./fmt";\n\ndescribe("Card", () => {\n  it("shows the number", () => {\n    render(<Card n={1} />);\n    expect(fmt(1)).toBe("1");\n  });\n});\n',
      ...calls,
    });
    const a = ask(g, { kind: "tests", target: { name: "fmt" }, limit: 3 });
    expect(a.error).toBeNull();
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.leads.length).toBeLessThanOrEqual(3);
    expect(a.unknown.reasons.join(" ")).toMatch(/12 files or functions/);
    expect(a.unknown.reasons.join(" ")).toMatch(/9 more/);
    expect(a.unknown.reasons.join(" ")).toMatch(/callers/);
  }, 60_000);
});
