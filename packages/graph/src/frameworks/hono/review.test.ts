// Cases a review of the Hono plugin found, each a way the plugin could
// state a middleware chain as proved when the code does not prove it. Each
// file of the repository below plants one; each test names the failure it
// guards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { FrameworkUnknown, Graph, Registration } from "../../index.js";
import { parserFor } from "../../parser.js";
import { readFacts } from "./facts.js";

const MW = "export async function auth(_c: unknown, next: () => Promise<void>) {\n  await next();\n}\nexport async function log(_c: unknown, next: () => Promise<void>) {\n  await next();\n}\nexport async function cors(_c: unknown, next: () => Promise<void>) {\n  await next();\n}\n";
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "review", private: true, type: "module", dependencies: { hono: "^4.6.0", "@hono/zod-openapi": "^0.18.0" } }),
  "src/mw.ts": MW,
  // A middleware path read from the environment: the first argument of use may be a path, so auth's coverage is not known.
  // Two middleware with no path: both apply to every route (the negative control).
  "src/app.ts": ['import { Hono } from "hono";', 'import { auth, cors, log } from "./mw";', "const app = new Hono();", "app.use(process.env.AUTH_PATH, auth);", "app.use(log, cors);", 'app.get("/public", (c) => c.text("ok"));', "export default app;"].join("\n"),
  "src/handlers.ts": 'export function health(c: { text(s: string): unknown }) {\n  return c.text("ok");\n}\n',
  // Router factories written on one line: an inline handler's return on the
  // factory's line is not a return of the factory, and two factories on one
  // line are two functions. The last factory returns from two places on its
  // one line, so which router it gives stays unknown (the negative control).
  "src/one.ts": [
    'import { Hono } from "hono";',
    'import { health } from "./handlers";',
    'export const oneLine = () => new Hono().get("/one", (c) => c.json({ ok: true }));',
    'export const first = () => new Hono().get("/f", health), second = () => new Hono().get("/s", health);',
    'export const either = (f: boolean) => { if (f) return new Hono().get("/e1", health); return new Hono().get("/e2", health); };',
  ].join("\n"),
  "src/users.ts": ['import { Hono } from "hono";', 'import { health } from "./handlers";', "export const users = new Hono();", 'users.get("/list", health);'].join("\n"),
  // Files that import nothing of Hono: a wrapper that passes a router
  // through, and a route on an imported router whose handler is a function
  // declared inside another.
  "src/pass.ts": "export const passThrough = (r: unknown) => r;\n",
  "src/setup.ts": ['import { users } from "./users";', "export function setup() {", "  function nested(c: { text(s: string): unknown }) {", '    return c.text("n");', "  }", '  users.get("/nested", nested);', "}"].join("\n"),
  "src/main.ts": [
    'import { Hono } from "hono";',
    'import { health } from "./handlers";',
    'import { either, first, oneLine, second } from "./one";',
    'import { passThrough } from "./pass";',
    'import { users } from "./users";',
    "const main = new Hono();",
    'main.route("/r", oneLine());',
    'main.route("/a", first());',
    'main.route("/b", second());',
    'main.route("/e", either(true));',
    'main.route("/p", passThrough(users));',
    // A method call with no path registers at the last path set on the value.
    'main.get("/x", health).post(health);',
    "main.get(health);",
    // A path with no handler only sets the path: nothing is registered, nothing is unknown.
    'main.get("/only");',
    "export default main;",
  ].join("\n"),
  // A router and a createRoute constant exported through an export clause
  // (`export { name }`), which the graph binds to no definition, and a
  // router exported under another name. Unfollowed, each router was an
  // application of its own at its relative path.
  "src/clause.ts": ['import { Hono } from "hono";', 'import { health } from "./handlers";', "const clause = new Hono();", 'clause.get("/c", health);', "export { clause };"].join("\n"),
  "src/defs.ts": ['import { createRoute } from "@hono/zod-openapi";', 'const listRoute = createRoute({ method: "get", path: "/listed" });', "export { listRoute };"].join("\n"),
  "src/api.ts": ['import { OpenAPIHono } from "@hono/zod-openapi";', 'import { health } from "./handlers";', 'import { listRoute } from "./defs";', "export const api = new OpenAPIHono();", "api.openapi(listRoute, health);"].join("\n"),
  "src/alias.ts": ['import { Hono } from "hono";', 'import { health } from "./handlers";', "const inner = new Hono();", 'inner.get("/al", health);', "export { inner as aliased };"].join("\n"),
  "src/clauses.ts": [
    'import { Hono } from "hono";',
    'import { clause } from "./clause";',
    'import { api } from "./api";',
    'import { aliased } from "./alias";',
    "const site = new Hono();",
    'site.route("/clause", clause);',
    'site.route("/api", api);',
    'site.route("/alias", aliased);',
    "export default site;",
  ].join("\n"),
  // Wrappers that add middleware to the router they are given: untyped in a
  // file that imports nothing of Hono, and typed as Hono. The plugin does
  // not bind a use on a parameter, so each is an unknown on the middleware
  // chains it may change. The application's own use applies (the control).
  "src/guard.ts": ['import { auth } from "./mw";', "export function guard(r: any) {", "  r.use(auth);", "  return r;", "}"].join("\n"),
  "src/guard2.ts": ['import type { Hono } from "hono";', 'import { auth } from "./mw";', "export function guardTyped(r: Hono) {", "  r.use(auth);", "  return r;", "}"].join("\n"),
  "src/guarded.ts": [
    'import { Hono } from "hono";',
    'import { log } from "./mw";',
    'import { health } from "./handlers";',
    'import { guard } from "./guard";',
    'import { guardTyped } from "./guard2";',
    "const g = new Hono();",
    "g.use(log);",
    "const inner = new Hono();",
    'inner.get("/in", health);',
    "const typed = new Hono();",
    'typed.get("/ty", health);',
    'g.route("/g", guard(inner));',
    'g.route("/t", guardTyped(typed));',
    "export default g;",
  ].join("\n"),
  // A wrapper that registers a route on the router it is given, untyped:
  // the route is an unknown at its line. A Map's get and a one-argument get
  // on an untyped parameter are no routes and stay quiet (the controls).
  "src/add.ts": [
    'import { health } from "./handlers";',
    "export function add(r) {",
    '  r.get("/x", health);',
    "  return r;",
    "}",
    "export function read(m: Map<string, string>, c) {",
    '  m.get("k");',
    '  return c.get("user");',
    "}",
  ].join("\n"),
  "src/added.ts": ['import { Hono } from "hono";', 'import { health } from "./handlers";', 'import { add } from "./add";', "const a = new Hono();", 'a.get("/own", health);', "const inner = new Hono();", 'a.route("/add", add(inner));', "export default a;"].join("\n"),
  // A file that imports nothing of Hono: a route on a parameter typed with
  // another name (an Express Router) is no Hono route and stays quiet; a
  // route on an untyped parameter of the same file is an unknown (the control).
  "src/express-like.ts": [
    'import type { Router } from "express";',
    'import { health } from "./handlers";',
    "export function mountExpress(router: Router) {",
    '  router.get("/ex", health);',
    "}",
    "export function untyped(r) {",
    '  r.get("/un", health);',
    "}",
  ].join("\n"),
  // A router mounted on a parameter typed Hono, on an untyped parameter, and
  // on a value of a dependency: which prefix it is served under is decided
  // where the receiver comes from, so it is no application of its own. A
  // router mounted on an application the plugin follows is composed (the control).
  "src/register.ts": [
    'import { Hono } from "hono";',
    'import { other } from "some-dependency";',
    'import { health } from "./handlers";',
    "export function registerTyped(app: Hono) {",
    "  const typedSub = new Hono();",
    '  typedSub.get("/ts", health);',
    '  app.route("/typed", typedSub);',
    "}",
    "export function registerUntyped(app) {",
    "  const untypedSub = new Hono();",
    '  untypedSub.get("/us", health);',
    '  app.route("/untyped", untypedSub);',
    "}",
    "const depSub = new Hono();",
    'depSub.get("/ds", health);',
    'other.route("/dep", depSub);',
    "const host = new Hono();",
    "const okSub = new Hono();",
    'okSub.get("/ok", health);',
    'host.route("/host", okSub);',
    "export default host;",
  ].join("\n"),
  // Exported values in files that import nothing of Hono: a router a local
  // factory makes, and a basePath of an imported application. Other files
  // register routes on them.
  "src/factory.ts": ['import { Hono } from "hono";', "export function createRouter() {", "  return new Hono();", "}"].join("\n"),
  "src/made.ts": ['import { createRouter } from "./factory";', "export const made = createRouter();"].join("\n"),
  "src/base.ts": ['import { Hono } from "hono";', "export const base = new Hono();", "export default base;"].join("\n"),
  "src/v1.ts": ['import { base } from "./base";', 'export const v1 = base.basePath("/v1");'].join("\n"),
  "src/on-exported.ts": ['import { made } from "./made";', 'import { v1 } from "./v1";', 'import { health } from "./handlers";', 'made.get("/m", health);', 'v1.get("/r", health);'].join("\n"),
};

let root: string;
let graph: Graph;
const regs = (file: string): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "hono" && e.site.file === file);
const gaps = (file: string): FrameworkUnknown[] => (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "hono" && u.site?.file === file);
// The names of the middleware applied to a registration, in order.
const chain = (r: Registration): string[] =>
  (graph.frameworks?.edges ?? [])
    .filter((e) => e.kind === "applies_middleware" && e.from === r.id)
    .map((e) => /#([^@]+)/.exec(e.to)?.[1] ?? e.to);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oq-hono-review-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  graph = await buildGraph({ repoRoot: root, store: null });
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the Hono plugin on what a review found", () => {
  it("never applies a middleware to every route when the first argument of use may be a computed path, and says so", () => {
    const [route, ...rest] = regs("src/app.ts");
    expect(rest).toEqual([]);
    expect(route?.pattern).toBe("/public");
    // log and cors have no path: they apply to every route.
    expect(chain(route as Registration)).toEqual(["log", "cors"]);
    expect(gaps("src/app.ts").some((u) => u.site?.line === 4 && u.cause === "dynamic" && u.affects.includes("applies_middleware"))).toBe(true);
  });

  const MAIN = "fw:hono:app:src/main.ts:6";
  const listed = (file: string) => regs(file).map((r) => `${r.methods.join(",")} ${r.pattern} ${r.app ?? "unmounted"}`).sort();

  it("reads a one-line router factory's own return, not its inline handler's, and keeps two factories on one line apart", () => {
    expect(listed("src/one.ts").filter((r) => !r.includes("/e"))).toEqual([`GET /a/f ${MAIN}`, `GET /b/s ${MAIN}`, `GET /r/one ${MAIN}`]);
    expect(gaps("src/main.ts").filter((u) => u.site?.line !== undefined && u.site.line >= 7 && u.site.line <= 9)).toEqual([]);
  });

  it("still never mounts a one-line factory that returns from two places", () => {
    expect(listed("src/one.ts").filter((r) => r.includes("/e"))).toEqual(["GET /e1 unmounted", "GET /e2 unmounted"]);
    expect(gaps("src/main.ts").some((u) => u.site?.line === 10 && u.cause === "dynamic" && u.affects.includes("mounts"))).toBe(true);
  });

  it("names a route registered with no path as unknown instead of dropping it, and stays quiet on a path with no handler", () => {
    expect(listed("src/main.ts")).toEqual([`GET /x ${MAIN}`]);
    const noPath = gaps("src/main.ts").filter((u) => u.affects.includes("handles") && /no path/.test(u.note));
    expect(noPath.map((u) => u.site?.line).sort()).toEqual([12, 13]);
    expect(gaps("src/main.ts").filter((u) => u.site?.line === 14)).toEqual([]);
  });

  it("follows a wrapper and binds a nested handler in files that import nothing of Hono", () => {
    expect(gaps("src/main.ts").filter((u) => u.site?.line === 11)).toEqual([]);
    expect(listed("src/users.ts")).toEqual([`GET /p/list ${MAIN}`]);
    const [nested, ...rest] = regs("src/setup.ts");
    expect(rest).toEqual([]);
    expect(`${nested?.pattern} ${nested?.app}`).toBe(`/p/nested ${MAIN}`);
    expect(nested?.handler.status).toBe("bound");
    expect(nested?.handler.targets).toEqual(["src/setup.ts#setup.nested@3:12"]);
  });

  it("follows a router and a createRoute constant exported through an export clause, aliased or not", () => {
    const SITE = "fw:hono:app:src/clauses.ts:5";
    expect(listed("src/clause.ts")).toEqual([`GET /clause/c ${SITE}`]);
    expect(listed("src/api.ts")).toEqual([`GET /api/listed ${SITE}`]);
    expect(gaps("src/clauses.ts").filter((u) => u.site?.line === 6 || u.site?.line === 7)).toEqual([]);
    expect(gaps("src/api.ts")).toEqual([]);
    // The aliased router is read through the module's export table: `aliased` is `inner`.
    expect(listed("src/alias.ts")).toEqual([`GET /alias/al ${SITE}`]);
    expect(gaps("src/clauses.ts")).toEqual([]);
  });

  it("names a use on a router parameter as an unknown on the middleware chains, while the application's own use applies", () => {
    const G = "fw:hono:app:src/guarded.ts:6";
    const routes = regs("src/guarded.ts");
    expect(routes.map((r) => `${r.pattern} ${r.app}`).sort()).toEqual([`/g/in ${G}`, `/t/ty ${G}`]);
    for (const r of routes) expect(chain(r)).toEqual(["log"]);
    for (const [file, line] of [["src/guard.ts", 3], ["src/guard2.ts", 4]] as const) {
      expect(gaps(file).filter((u) => u.site?.line === line && u.affects.includes("applies_middleware") && /use/.test(u.note))).toHaveLength(1);
    }
    expect(gaps("src/guarded.ts")).toEqual([]);
  });

  it("names a route on an untyped router parameter as an unknown, while a route on a router it follows is listed", () => {
    expect(listed("src/added.ts")).toEqual(["GET /own fw:hono:app:src/added.ts:4"]);
    expect(regs("src/add.ts")).toEqual([]);
    expect(gaps("src/add.ts").filter((u) => u.site?.line === 3 && u.affects.includes("handles"))).toHaveLength(1);
    expect(gaps("src/add.ts").filter((u) => u.site?.line !== 3)).toEqual([]);
    expect(gaps("src/added.ts")).toEqual([]);
  });
});

describe("the Hono plugin on a second review's findings", () => {
  const listed = (file: string) => regs(file).map((r) => `${r.methods.join(",")} ${r.pattern} ${r.app ?? "unmounted"}`).sort();

  it("reads a parameter's type in a file that imports nothing of Hono, so a route on an Express router is no Hono unknown", () => {
    expect(regs("src/express-like.ts")).toEqual([]);
    expect(gaps("src/express-like.ts").filter((u) => u.site?.line === 4)).toEqual([]);
    // The untyped parameter of the same file is still an unknown.
    expect(gaps("src/express-like.ts").filter((u) => u.site?.line === 7 && u.affects.includes("handles"))).toHaveLength(1);
  });

  it("never lists a router mounted on a typed parameter, an untyped parameter or a dependency's value as an application of its own", () => {
    expect(listed("src/register.ts")).toEqual(["GET /ds unmounted", "GET /host/ok fw:hono:app:src/register.ts:17", "GET /ts unmounted", "GET /us unmounted"]);
    for (const line of [7, 12, 16]) expect(gaps("src/register.ts").filter((u) => u.site?.line === line && u.affects.includes("mounts"))).toHaveLength(1);
    expect(gaps("src/register.ts").filter((u) => u.site?.line === 20)).toEqual([]);
    const apps = (graph.frameworks?.apps ?? []).filter((a) => a.id.startsWith("fw:hono:app:src/register.ts"));
    expect(apps.map((a) => a.id)).toEqual(["fw:hono:app:src/register.ts:17"]);
  });

  it("follows an exported value of a file that imports nothing of Hono, or says it cannot", () => {
    // The basePath of an imported application: the route is served under it.
    expect(listed("src/on-exported.ts").filter((r) => r.includes("/r"))).toEqual(["GET /v1/r fw:hono:app:src/base.ts:2"]);
    // A router a factory returns, held in an exported constant: an unknown at the route, never silence.
    expect(gaps("src/on-exported.ts").filter((u) => u.site?.line === 4 && u.affects.includes("handles"))).toHaveLength(1);
    expect(gaps("src/on-exported.ts").filter((u) => u.site?.line === 5)).toEqual([]);
  });

  // A file that imports nothing of Hono keeps only what resolve may read, so
  // ordinary files do not fill the plugin's fact budget.
  const kept = async (text: string): Promise<string[]> => {
    const tree = (await parserFor("typescript")).parse(text);
    if (!tree) throw new Error("no tree");
    try {
      return readFacts(tree.rootNode).map((f) => (f.kind === "value" || f.kind === "param" ? `${f.kind} ${f.name}` : f.kind));
    } finally {
      tree.delete();
    }
  };
  it("keeps no fact of an ordinary file, and only the read parameters and exported values of a file resolve may read", async () => {
    expect(await kept(["export const total = 5;", "export const store = new Map();", 'export const label = "x";', "export function twice(n: number) {", "  return n * 2;", "}", "const local = makeThing();"].join("\n"))).toEqual([]);
    expect(await kept(files["src/express-like.ts"] as string)).toContain("param router");
    expect((await kept(files["src/express-like.ts"] as string)).filter((k) => k.startsWith("value"))).toEqual([]);
    expect(await kept(files["src/made.ts"] as string)).toEqual(["value made"]);
  });
});
