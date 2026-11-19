// A route handler written inline is a definition of its own: the route's
// `handles` edge points at it, and the calls it makes have it as their
// caller. Ways it could fail, written before the code:
//  1. An inline Hono handler stays unbound: the route names no handler and
//     lists an unknown, so a change inside the handler reaches no route.
//  2. The calls an inline handler makes are counted under the function
//     around it, so `callers` names the router factory, not the handler.
//  3. The handler's definition hides the function that holds it: no
//     `defines` hop leads from the factory to the handler.
//  4. A callback that is no route handler (an event listener, a map
//     callback) becomes a definition, and the calls in it change caller.
//  5. An arrow inside a class method becomes a definition, and a call on
//     `this` inside it loses the class it runs on.
//  6. An inline Express handler is left with a note that says its calls are
//     counted under the code around it, which is no longer true.
//  7. An inline gin handler (a Go function literal) stays unbound, and its
//     calls are counted under the function that registers it.
//  8. An ordinary callback shaped like a route (`cache.get(key, () => ...)`,
//     `store.delete(id, function () {...})`, a Go `m.GET(k, func() {...})`)
//     becomes a definition no route binds: the calls in it get a caller
//     that nothing calls, and a walk of callers stops there instead of
//     reaching the function around it and that function's callers.
//  9. A changed file with such a callback reports the callback's
//     definition as a removed symbol.
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { buildGraph, detectImpact } from "../src/index.js";
import type { Graph, GraphNode, Registration } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Request } from "../src/query/engine.js";
import { commitAll, makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function build(files: Record<string, string>): Promise<Graph> {
  const root = makeRepo(files);
  commitAll(root);
  return buildGraph({ repoRoot: root, store: null });
}

const session = (graph: Graph) => ({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false });
const ask = (graph: Graph, req: Omit<Request, "apiVersion">) => query(session(graph), { apiVersion: 1, ...req } as Request);
const regs = (graph: Graph, plugin: string): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === plugin);
const regAt = (graph: Graph, plugin: string, site: string): Registration => {
  const r = regs(graph, plugin).find((x) => `${x.site.file}:${x.site.line}` === site);
  if (!r) throw new Error(`no ${plugin} registration at ${site}`);
  return r;
};
const handlesOf = (graph: Graph, reg: Registration): GraphNode[] =>
  (graph.frameworks?.edges ?? []).filter((e) => e.kind === "handles" && e.from === reg.id).map((e) => graph.nodes.get(e.to) as GraphNode);
// The callers of a symbol, each as "name file:line" of the caller's definition.
const callersOf = (graph: Graph, name: string): string[] => {
  const a = ask(graph, { kind: "callers", target: { name } });
  expect(a.error).toBeNull();
  return (a.items as { from: string }[]).map((i) => {
    const n = graph.nodes.get(i.from);
    return n ? `${n.name} ${n.file}:${n.startLine}` : i.from;
  });
};

const honoFiles: Record<string, string> = {
  "package.json": '{ "name": "svc", "dependencies": { "hono": "4.6.0", "@hono/zod-openapi": "0.18.0" } }\n',
  "src/audit.ts": "export function audit(what: string): void {}\nexport function work(n: number): number {\n  return n;\n}\nexport function format(n: number): string {\n  return String(n);\n}\nexport function save(): void {}\n",
  "src/routes.ts": [
    'import { Hono } from "hono";',
    'import { OpenAPIHono, createRoute } from "@hono/zod-openapi";',
    'import { EventEmitter } from "node:events";',
    'import { audit, work, format, save } from "./audit";',
    "",
    'const loginRoute = createRoute({ method: "get", path: "/login", responses: {} });',
    "",
    "export function createRouter() {",
    "  const router = new OpenAPIHono();",
    "  router.openapi(loginRoute, async (c) => {",
    '    audit("login");',
    '    return c.text("ok");',
    "  });",
    '  router.get("/health", (c) => c.json({ n: work(1) }));',
    "  const bus = new EventEmitter();",
    '  bus.on("tick", (n: number) => work(n));',
    "  const labels = [1, 2].map((n) => format(n));",
    "  return { router, labels };",
    "}",
    "",
    "export class Routes {",
    "  save(): void {",
    "    save();",
    "  }",
    "  register(app: Hono): void {",
    '    app.post("/save", (c) => {',
    "      this.save();",
    '      return c.text("saved");',
    "    });",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/app.ts": ['import { Hono } from "hono";', 'import { createRouter } from "./routes";', "", "export const app = new Hono();", 'app.route("/api", createRouter().router);', ""].join("\n"),
};

describe("inline Hono handlers", () => {
  let g: Graph;
  it("builds", async () => {
    g = await build(honoFiles);
  }, 60_000);

  it("binds each inline handler to a definition at its own line (1)", () => {
    const login = handlesOf(g, regAt(g, "hono", "src/routes.ts:10"));
    expect(login.map((n) => `${n.kind} ${n.file}:${n.startLine}`)).toEqual(["function src/routes.ts:10"]);
    const health = handlesOf(g, regAt(g, "hono", "src/routes.ts:14"));
    expect(health.map((n) => `${n.kind} ${n.file}:${n.startLine}`)).toEqual(["function src/routes.ts:14"]);
    expect(regAt(g, "hono", "src/routes.ts:14").handler.status).toBe("bound");
    const gaps = (g.frameworks?.unknowns ?? []).filter((u) => u.plugin === "hono" && u.affects.includes("handles") && u.site?.file === "src/routes.ts" && (u.site.line === 10 || u.site.line === 14));
    expect(gaps).toEqual([]);
  });

  it("makes the inline handler the caller of the calls inside it (2)", () => {
    const login = handlesOf(g, regAt(g, "hono", "src/routes.ts:10"))[0] as GraphNode;
    expect(callersOf(g, "audit")).toEqual([`${login.name} src/routes.ts:10`]);
  });

  it("keeps a defines hop from the factory to the handler (3)", () => {
    const login = handlesOf(g, regAt(g, "hono", "src/routes.ts:10"))[0] as GraphNode;
    const a = ask(g, { kind: "callees", target: { name: "createRouter" }, edges: ["defines"] });
    expect(a.error).toBeNull();
    expect((a.items as { to: string }[]).map((i) => i.to)).toContain(login.id);
  });

  it("leaves an event listener and a map callback to the code around them (4)", () => {
    // work is called by the inline /health handler and by the listener; the listener's call stays the factory's.
    expect(callersOf(g, "work").sort()).toEqual([`createRouter src/routes.ts:8`, `${(handlesOf(g, regAt(g, "hono", "src/routes.ts:14"))[0] as GraphNode).name} src/routes.ts:14`].sort());
    expect(callersOf(g, "format")).toEqual(["createRouter src/routes.ts:8"]);
    expect((g.defsByFile.get("src/routes.ts") ?? []).filter((n) => n.startLine === 16 || n.startLine === 17)).toEqual([]);
  });

  it("keeps a call on this inside a method's arrow bound to the class (5)", () => {
    expect(callersOf(g, "Routes.save")).toEqual(["register src/routes.ts:25"]);
  });

  it("answers routes with the inline handler named", () => {
    const a = ask(g, { kind: "routes", limit: 50 });
    expect(a.error).toBeNull();
    const health = (a.items as { site: { line: number }; handles: { to: string }[] }[]).find((r) => r.site.line === 14);
    expect(health?.handles.map((h) => g.nodes.get(h.to)?.startLine)).toEqual([14]);
  });
});

describe("inline Express handlers", () => {
  it("binds an inline Express handler to its definition, and no note says its calls are counted elsewhere (6)", async () => {
    const g = await build({
      "package.json": '{ "name": "web", "dependencies": { "express": "4.19.2" } }\n',
      "src/audit.ts": "export function audit(): void {}\n",
      "src/app.ts": ['import express from "express";', 'import { audit } from "./audit";', "", "const app = express();", 'app.get("/items", (req, res) => {', "  audit();", '  res.send("ok");', "});", "app.listen(3000);", ""].join("\n"),
    });
    const reg = regAt(g, "express", "src/app.ts:5");
    expect(handlesOf(g, reg).map((n) => `${n.kind} ${n.file}:${n.startLine}`)).toEqual(["function src/app.ts:5"]);
    expect(callersOf(g, "audit")).toEqual([`${(handlesOf(g, reg)[0] as GraphNode).name} src/app.ts:5`]);
    expect((g.frameworks?.unknowns ?? []).filter((u) => u.note.includes("counted under the code around it"))).toEqual([]);
  });
});

describe("inline gin handlers", () => {
  it("binds a gin function literal to its definition, and makes it the caller of its calls (7)", async () => {
    const g = await build({
      "go.mod": "module example.com/svc\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "audit.go": "package main\n\nfunc audit() {}\n",
      "main.go": ["package main", "", 'import "github.com/gin-gonic/gin"', "", "func main() {", "\tr := gin.Default()", '\tr.GET("/ping", func(c *gin.Context) {', "\t\taudit()", '\t\tc.String(200, "pong")', "\t})", '\tr.Run(":8080")', "}", ""].join("\n"),
    });
    const reg = regAt(g, "gin", "main.go:7");
    expect(reg.pattern).toBe("/ping");
    expect(handlesOf(g, reg).map((n) => `${n.kind} ${n.file}:${n.startLine}`)).toEqual(["function main.go:7"]);
    expect(callersOf(g, "audit")).toEqual([`${(handlesOf(g, reg)[0] as GraphNode).name} main.go:7`]);
  });
});

describe("callbacks no route binds", () => {
  it("leaves the calls of an ordinary callback to the function around it, and a depth-2 walk reaches that function's callers (8)", async () => {
    const g = await build({
      "package.json": '{ "name": "lib" }\n',
      "src/cache.ts": [
        "export function audit(): void {}",
        "export function work(): number {",
        "  return 1;",
        "}",
        "export function refill(cache: Map<string, number>, store: { delete(id: string, cb: () => void): void; get(k: string, f: () => number): number }) {",
        '  store.get("key", () => work());',
        '  store.delete("id", function () {',
        "    audit();",
        "  });",
        "}",
        "export function run(): void {",
        "  refill(new Map(), { delete() {}, get: () => 0 });",
        "}",
        'const bus = { on(a: string, b: string, f: () => void) {} };',
        'bus.on("a", "b", () => audit());',
        "",
      ].join("\n"),
    });
    expect(callersOf(g, "work")).toEqual(["refill src/cache.ts:5"]);
    expect(callersOf(g, "audit").sort()).toEqual(["cache.ts src/cache.ts:1", "refill src/cache.ts:5"]);
    const deep = ask(g, { kind: "callers", target: { name: "work" }, depth: 2 });
    expect(deep.error).toBeNull();
    expect((deep.items as { from: string; depth: number }[]).map((i) => `${g.nodes.get(i.from)?.name ?? i.from} ${i.depth}`)).toEqual(["refill 1", "run 2"]);
    expect([...g.nodes.values()].filter((n) => n.name.startsWith("<"))).toEqual([]);
  }, 60_000);

  it("leaves the calls of a Go function literal no route binds to the function around it (8)", async () => {
    const g = await build({
      "go.mod": "module example.com/lib\n\ngo 1.22\n",
      "main.go": ["package main", "", "type table struct{}", "", "func (t table) GET(k string, f func()) {}", "", "func audit() {}", "", "func fill(t table) {", '\tt.GET("k", func() {', "\t\taudit()", "\t})", "}", ""].join("\n"),
    });
    expect(callersOf(g, "audit")).toEqual(["fill main.go:9"]);
    expect([...g.nodes.values()].filter((n) => n.name.startsWith("<"))).toEqual([]);
  }, 60_000);

  it("reports no removed symbol for a callback in a changed file (9)", async () => {
    const files = {
      "package.json": '{ "name": "lib" }\n',
      "src/a.ts": ["export function audit(): void {}", "export function fill(store: { get(k: string, f: () => void): void }) {", '  store.get("k", () => audit());', "}", ""].join("\n"),
    };
    const root = makeRepo(files);
    commitAll(root);
    writeFileSync(join(root, "src/a.ts"), files["src/a.ts"].replace("audit());", "audit());\n  audit();"));
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.symbols.filter((s) => impact.removed.includes(s.id)).map((s) => s.name)).toEqual([]);
  }, 60_000);
});
