// Cases a review of the Express plugin found, each a way the plugin could
// state a route, a pattern or a chain as proved when the code does not
// prove it, or drop a gap without saying so. Each file of the repository
// below plants one; each test names the failure it guards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { FrameworkUnknown, Graph, Registration } from "../../index.js";
import { MAX_APPS, MAX_MATCH_WORK, MAX_MOUNT_DEPTH, MAX_STRING_WRITES, MAX_TEST_REQUESTS } from "./resolve.js";

const H = 'import { h } from "./h.js";';
const many = (n: number) => Array.from({ length: n }, () => "h").join(", ");
const deep = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`).join("/");
// Each router's mount line, the path its route is requested at with no
// prefix and, under a computed prefix, the name the unknown gives it.
const UNDER_COMPUTED = [
  ["app.use(PREFIX, byName);", "/by-name", "PREFIX"],
  ["app.use(process.env.API_PREFIX, byEnv);", "/by-env", "process.env.API_PREFIX"],
  ['app.use(process.env["API_PREFIX"], byIndex);', "/by-index", "process.env.API_PREFIX"],
  ["app.use(`/${version}`, byTemplate);", "/by-template", "`/${version}`"],
  ["app.use(`/${Date.now()}`, byCallTemplate);", "/by-call-template", "a computed string"],
  ["app.use(IMPORTED, byImport);", "/by-import", "IMPORTED"],
  ["app.use(CLAUSE, byClause);", "/by-clause", "CLAUSE"],
  ["app.use(WRAPPED, byWrapped);", "/by-wrapped", "WRAPPED"],
  ["app.use(DEFAULTED, byDefault);", "/by-default", "DEFAULTED"],
  ["app.use(String(process.env.API_PREFIX), byString);", "/by-string", "String(process.env.API_PREFIX)"],
] as const;
// A literal prefix, a template with no substitution, and first arguments
// that may be middleware: a function, a name holding a call's result, a
// member of a required module and a parameter. Each keeps its pattern.
const KEPT = [
  ['app.use("/v1", literal);', "/v1/by-literal"],
  ["app.use(`/v2`, plain);", "/v2/by-plain"],
  ["app.use(h, guarded);", "/by-guard"],
  ["app.use(auth, byCall);", "/by-call"],
  ["app.use(guard.required, byRequired);", "/by-required"],
  ["app.use(REPLACED, byReplaced);", "/by-replaced"],
  ["app.use(LATER, byLater);", "/by-later"],
  ["  app.use(requireAuth, byParam);", "/by-param"],
] as const;
const routerOf = (mount: string) => /, (\w+)\);$/.exec(mount)?.[1] as string;
const COMPUTED = [
  'import express, { Router } from "express";',
  'import { chooseAuth, h } from "./h.js";',
  'import { PREFIX as IMPORTED } from "./config.js";',
  'import { CLAUSE } from "./clause.js";',
  'import DEFAULTED from "./default-prefix.js";',
  'import REPLACED from "./replaced.js";',
  'import LATER from "./later.js";',
  'const WRAPPED = (process.env["API_PREFIX"] as string)!;',
  'const guard = require("./guard.js");',
  'const PREFIX = "/" + process.env.API_PREFIX;',
  "const version = process.env.VERSION;",
  "const auth = chooseAuth();",
  "export const app = express();",
  ...[...UNDER_COMPUTED, ...KEPT].flatMap(([mount, path]) => [`const ${routerOf(mount)} = Router();`, `${routerOf(mount)}.get("${path.replace(/^\/v\d/, "")}", h);`]),
  ...UNDER_COMPUTED.map(([mount]) => mount),
  ...KEPT.slice(0, -1).map(([mount]) => mount),
  "export function mountWith(requireAuth: unknown): void {",
  KEPT[KEPT.length - 1][0],
  "}",
];
const lineOf = (text: string) => COMPUTED.indexOf(text) + 1;

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "review", private: true, type: "module", dependencies: { express: "^4.21.2", supertest: "^7.1.0" }, devDependencies: { vitest: "^3.2.4" } }),
  "src/h.ts": "export function h(_req: unknown, _res: unknown, next?: () => void): void {\n  next?.();\n}\nexport function last(_req: unknown, _res: unknown): void {}\nexport function chooseAuth(): (req: unknown, res: unknown, next: () => void) => void {\n  return (_q, _s, next) => next();\n}\n",
  // A factory parameter named express shadows the import: its call makes no Express application.
  "src/shadow.ts": ['import express from "express";', H, "export function build(express: () => { get(p: string, f: unknown): void }) {", "  const app = express();", '  app.get("/shadowed", h);', "  return app;", "}", "export const real = express();"].join("\n"),
  // A mount under a computed prefix, then a literal mount below it.
  "src/nested.ts": ['import express, { Router } from "express";', H, "const tenant = process.env.TENANT;", "export const app = express();", "const r = Router();", "const child = Router();", 'child.get("/x", h);', 'r.use("/v1", child);', "app.use(`/${tenant}`, r);"].join("\n"),
  // Routers mounted under prefixes the code computes, beside the first
  // arguments that are no prefix the graph can show, and a test that
  // requests the path each route would have with no prefix.
  "src/config.ts": "export const PREFIX = process.env.API_PREFIX;\n",
  "src/clause.ts": "const BASE = process.env.API_BASE;\nexport { BASE as CLAUSE };\n",
  "src/default-prefix.ts": "const prefix = process.env.API_PREFIX;\nexport default prefix;\n",
  // A string exported as the default, then replaced by middleware.
  "src/replaced.js": "const prefix = process.env.API_PREFIX;\nmodule.exports = prefix;\nmodule.exports = function guard(_req, _res, next) {\n  next();\n};\n",
  // A default export of a binding before its string is written: it exports undefined.
  "src/later.ts": "let prefix: string | undefined;\nexport default prefix;\nprefix = process.env.API_PREFIX;\n",
  // Module-level names String and process that a destructuring declares:
  // the module's own, so String() is a call of middleware and
  // process.env is no environment.
  "src/destructured.ts": ['import express, { Router } from "express";', H, 'import { helpers } from "./helpers.js";', "const { String, process } = helpers;", "export const app = express();", "const called = Router();", 'called.get("/by-call", h);', "const env = Router();", 'env.get("/by-env", h);', "app.use(String(), called);", "app.use(process.env.guard, env);"].join("\n"),
  "src/helpers.ts": [H, "export const helpers = { String: () => h, process: { env: { guard: h } } };"].join("\n"),
  // An object of the repository's own named process: its env is no environment.
  "src/own-process.ts": ['import express, { Router } from "express";', H, 'import { process } from "./process-like.js";', "export const app = express();", "const r = Router();", 'r.get("/own", h);', "app.use(process.env.guard, r);"].join("\n"),
  "src/process-like.ts": ['import { h } from "./h.js";', "export const process = { env: { guard: h } };"].join("\n"),
  // Middleware alone under a prefix from the environment, then a route outside it.
  "src/env-middleware.ts": ['import express from "express";', H, "export const app = express();", "app.use(process.env.ADMIN, h);", 'app.get("/health", h);'].join("\n"),
  // An alias chain longer than the depth the plugin follows, mounted before
  // a mount of one of its short tails: each mount's answer is its own.
  "src/order.ts": ['import express, { Router } from "express";', H, ...Array.from({ length: 10 }, (_, i) => `const a${i} = ${i === 9 ? "process.env.API_PREFIX" : `a${i + 1}`};`), "export const app = express();", "const long = Router();", 'long.get("/long", h);', "const short = Router();", 'short.get("/short", h);', "app.use(a0, long);", "app.use(a8, short);"].join("\n"),
  "src/guard.js": "exports.required = function required(_req, _res, next) {\n  next();\n};\n",
  "src/computed.ts": COMPUTED.join("\n"),
  "src/computed.test.ts": ['import request from "supertest";', 'import { it } from "vitest";', 'import { app } from "./computed.js";', 'it("requests each route without its prefix", async () => {', ...[...UNDER_COMPUTED, ...KEPT].map(([, path]) => `  await request(app).get("${path}");`), "});"].join("\n"),
  // A path held in a binding that changes: no literal proves which path is registered.
  "src/mutable.ts": ['import express from "express";', H, "export const app = express();", 'let path = "/old";', 'path = "/new";', "app.get(path, h);", 'const FIXED = "/fixed";', "export function inner(FIXED: string) {", "  app.get(FIXED, h);", "}", "app.get(FIXED, h);"].join("\n"),
  // A route with more arguments than the reader keeps: the handler is past the cut.
  "src/wide.ts": ['import express from "express";', 'import { h, last } from "./h.js";', "export const app = express();", `app.get("/wide", ${many(30)}, last);`].join("\n"),
  // Middleware whose function is a value the code computes.
  "src/auth.ts": ['import express from "express";', 'import { chooseAuth, h } from "./h.js";', "export const app = express();", "const auth = chooseAuth();", "app.use(auth);", 'app.get("/guarded", h);'].join("\n"),
  // An application mounted on another with use: a sub-application, whose routes the plugin does not compose under the mount.
  "src/subapp.ts": ['import express from "express";', H, "const admin = express();", 'admin.get("/stats", h);', "export const app = express();", 'app.use("/admin", admin);'].join("\n"),
  // A route deeper than the matcher reads, a route it cannot read, and the test requests for both.
  "src/long.ts": ['import express from "express";', H, "export const app = express();", `app.get("/${deep(70)}", h);`, 'app.get("/re/:id(\\\\d+)", h);'].join("\n"),
  "src/long.test.ts": ['import request from "supertest";', 'import { it } from "vitest";', 'import { app } from "./long.js";', 'it("reaches the long route", async () => {', `  await request(app).get("/${deep(70)}");`, '  await request(app).get("/re/42");', "});"].join("\n"),
};

let root: string;
let graph: Graph;
const regs = (file: string): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "express" && e.site.file === file);
const gaps = (file: string): FrameworkUnknown[] => (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "express" && u.site?.file === file);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oq-express-review-"));
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

describe("the Express plugin on what a review found", () => {
  it("makes no application from a call of a parameter that shadows the express import", () => {
    expect(regs("src/shadow.ts")).toEqual([]);
    expect(graph.frameworks?.apps.filter((a) => a.plugin === "express" && a.site.file === "src/shadow.ts").map((a) => a.site.line)).toEqual([8]);
  });

  it("keeps the pattern unknown under every mount below a computed prefix, never restarting from the literal mount", () => {
    const x = regs("src/nested.ts");
    expect(x.map((r) => r.pattern)).toEqual([null]);
  });

  it("never states a pattern without its prefix for a router mounted under a computed prefix, and says the prefix is computed", () => {
    const byPath = new Map(regs("src/computed.ts").map((r) => [r.written, r]));
    for (const [mount, path, name] of UNDER_COMPUTED) {
      expect(byPath.get(path)?.pattern, mount).toBeNull();
      const gap = gaps("src/computed.ts").find((u) => u.site?.line === lineOf(mount) && u.affects.includes("mounts"));
      expect(gap?.cause, mount).toBe("dynamic");
      expect(gap?.name, mount).toBe(name);
    }
  });

  it("keeps the pattern of a route under a literal prefix, or under a first argument the graph cannot show is a string", () => {
    const byPath = new Map(regs("src/computed.ts").map((r) => [r.written, r]));
    for (const [mount, path] of KEPT) {
      expect(byPath.get(path.replace(/^\/v\d/, ""))?.pattern, mount).toBe(path);
      expect(gaps("src/computed.ts").filter((u) => u.site?.line === lineOf(mount) && u.affects.includes("mounts")), mount).toEqual([]);
    }
  });

  it("reads process.env as the environment only when no name of the file's own is called process", () => {
    expect(regs("src/own-process.ts").map((r) => r.pattern)).toEqual(["/own"]);
  });

  it("reads String and process as the globals only when no module-level destructuring of the file declares them", () => {
    expect(regs("src/destructured.ts").map((r) => r.pattern).sort()).toEqual(["/by-call", "/by-env"]);
    expect(gaps("src/destructured.ts").filter((u) => u.affects.includes("mounts"))).toEqual([]);
  });

  it("does not apply middleware given under a prefix from the environment to a route outside that prefix", () => {
    const [health] = regs("src/env-middleware.ts");
    expect(health?.pattern).toBe("/health");
    expect((graph.frameworks?.edges ?? []).filter((e) => e.kind === "applies_middleware" && e.from === health?.id)).toEqual([]);
  });

  it("gives a mount the same answer whatever mount of the same names was read before it", () => {
    const byPath = new Map(regs("src/order.ts").map((r) => [r.written, r.pattern]));
    // a8 is two names from a string, inside the depth the plugin follows; a0 is ten, past it.
    expect(byPath.get("/short")).toBeNull();
    expect(byPath.get("/long")).toBe("/long");
  });

  it("links a test request only to a route whose whole pattern is known, never to one under a computed prefix", () => {
    const linked = new Set((graph.frameworks?.edges ?? []).filter((e) => e.kind === "tests" && e.plugin === "express" && e.evidence.site.file === "src/computed.test.ts").map((e) => e.to));
    const patterns = regs("src/computed.ts").filter((r) => linked.has(r.id)).map((r) => r.pattern);
    expect(patterns.sort()).toEqual(KEPT.map(([, path]) => path).sort());
  });

  it("does not take a path from a binding that is reassigned or shadowed: each such route is a dynamic unknown", () => {
    const patterns = regs("src/mutable.ts").map((r) => r.pattern);
    expect(patterns).not.toContain("/old");
    expect(patterns).not.toContain("/new");
    expect(gaps("src/mutable.ts").some((u) => u.site?.line === 6 && u.cause === "dynamic")).toBe(true);
    // The module constant at module level is a literal; the parameter that shadows it is not.
    expect(patterns).toEqual(["/fixed"]);
    expect(gaps("src/mutable.ts").some((u) => u.site?.line === 9 && u.cause === "dynamic")).toBe(true);
  });

  it("never names a middleware as the handler when the reader cut the argument list, and says the list was cut", () => {
    const [wide] = regs("src/wide.ts");
    expect(wide?.handler.status).toBe("unresolved");
    expect(wide?.handler.targets).toEqual([]);
    expect(gaps("src/wide.ts").some((u) => u.cause === "fan-out-capped")).toBe(true);
  });

  it("says when a middleware in a route's chain cannot be bound, rather than leaving it out silently", () => {
    const gap = gaps("src/auth.ts").find((u) => u.affects.includes("applies_middleware"));
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("auth");
  });

  it("says where an application is mounted as a sub-application, whose routes it does not list under that mount", () => {
    const gap = gaps("src/subapp.ts").find((u) => u.site?.line === 6);
    expect(gap?.affects).toEqual(expect.arrayContaining(["mounts", "handles"]));
    expect(gap?.name).toBe("admin");
    expect(regs("src/subapp.ts").map((r) => r.pattern)).toEqual(["/stats"]);
  });

  it("keeps at most the build's applications and says how many were left out, so the stage can always append them", async () => {
    const many: Record<string, string> = { "package.json": files["package.json"] as string, "src/h.ts": files["src/h.ts"] as string };
    for (let f = 0; f < 2; f++) many[`src/apps${f}.ts`] = ['import express from "express";', ...Array.from({ length: 1100 }, (_, i) => `export const a${i} = express();`)].join("\n");
    const at = mkdtempSync(join(tmpdir(), "oq-express-apps-"));
    try {
      for (const [path, content] of Object.entries(many)) {
        mkdirSync(dirname(join(at, path)), { recursive: true });
        writeFileSync(join(at, path), content);
      }
      const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: at, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "test");
      run("add", "-A");
      run("commit", "-q", "-m", "apps");
      const g = await buildGraph({ repoRoot: at, store: null });
      expect(g.frameworks?.apps.filter((a) => a.plugin === "express").length).toBe(MAX_APPS);
      expect(g.frameworks?.unknowns.find((u) => u.plugin === "express" && u.note.includes(`${MAX_APPS} applications`))?.count).toBe(2200 - MAX_APPS);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }, 120_000);

  // A repository of its own for each budget, so one cap's unknown cannot be
  // mistaken for the other's.
  async function buildRepo(prefix: string, own: Record<string, string>): Promise<Graph> {
    const at = mkdtempSync(join(tmpdir(), prefix));
    try {
      for (const [path, content] of Object.entries({ "package.json": files["package.json"] as string, "src/h.ts": files["src/h.ts"] as string, ...own })) {
        mkdirSync(dirname(join(at, path)), { recursive: true });
        writeFileSync(join(at, path), content);
      }
      const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: at, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "test");
      run("add", "-A");
      run("commit", "-q", "-m", "budget");
      return await buildGraph({ repoRoot: at, store: null });
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }
  const testFile = (requests: string[]) => ['import request from "supertest";', 'import { it } from "vitest";', 'import { app } from "./app.js";', 'it("requests", async () => {', ...requests.map((p) => `  await request(app).get("${p}");`), "});"].join("\n");
  const unmatched = (g: Graph) => (g.frameworks?.unknowns ?? []).filter((u) => u.plugin === "express" && u.affects.includes("tests") && u.site === null);

  it("names the pattern-step budget, not the request cap, when matching runs out of steps", async () => {
    // 100 routes and requests of 60 segments: each request costs about 370,000 steps.
    const params = Array.from({ length: 60 }, (_, i) => `:p${i}`).join("/");
    const path = `/${Array.from({ length: 60 }, (_, i) => `v${i}`).join("/")}`;
    const app = ['import express from "express";', H, "export const app = express();", ...Array.from({ length: 100 }, (_, i) => `app.get("/${params}", h); // ${i}`)].join("\n");
    const g = await buildRepo("oq-express-steps-", { "src/app.ts": app, "src/app.test.ts": testFile(Array.from({ length: 30 }, () => path)) });
    const cut = unmatched(g);
    expect(cut.map((u) => u.cause)).toEqual(["budget"]);
    expect(cut[0]?.note).toContain(String(MAX_MATCH_WORK));
    expect(cut[0]?.note).not.toContain(String(MAX_TEST_REQUESTS));
    expect(cut[0]?.count).toBeGreaterThan(0);
  }, 120_000);

  it("names the request cap, not the pattern-step budget, when a build has more test requests than it matches", async () => {
    const app = ['import express from "express";', H, "export const app = express();", 'app.get("/x", h);'].join("\n");
    // Spread over three files, each under the facts the stage keeps per file.
    const tests: Record<string, string> = {};
    for (let f = 0; f < 3; f++) tests[`src/app${f}.test.ts`] = testFile(Array.from({ length: (MAX_TEST_REQUESTS + 100) / 3 }, () => "/x"));
    const g = await buildRepo("oq-express-requests-", { "src/app.ts": app, ...tests });
    const cut = unmatched(g);
    expect(cut.map((u) => u.count)).toEqual([100]);
    expect(cut[0]?.note).toContain(String(MAX_TEST_REQUESTS));
    expect(cut[0]?.note).not.toContain(String(MAX_MATCH_WORK));
  }, 120_000);

  it("reads a prefix through names written many times each in steps that grow with the writes, and reads no name past the write cap", async () => {
    // Each name is written 20 times with the next one, down to a string: read
    // path by path, that is 20 to the power of the layers.
    const layers = MAX_MOUNT_DEPTH;
    const chain = Array.from({ length: layers }, (_, i) => {
      const value = i === layers - 1 ? '"/p"' : `x${i + 1}`;
      return [`let x${i} = ${value};`, ...Array.from({ length: 19 }, () => `x${i} = ${value};`)];
    }).flat();
    const wide = ['let wide = "/w";', ...Array.from({ length: MAX_STRING_WRITES }, () => 'wide = "/w";')];
    const app = ['import express, { Router } from "express";', H, ...chain, ...wide, "export const app = express();", "const deep = Router();", 'deep.get("/deep", h);', "const many = Router();", 'many.get("/many", h);', "app.use(x0, deep);", "app.use(wide, many);"];
    const g = await buildRepo("oq-express-fanout-", { "src/app.ts": app.join("\n") });
    const reg = (written: string) => (g.frameworks?.entities ?? []).find((e): e is Registration => e.kind === "registration" && e.written === written);
    const mountGap = (text: string) => (g.frameworks?.unknowns ?? []).find((u) => u.plugin === "express" && u.site?.line === app.indexOf(text) + 1 && u.affects.includes("mounts"));
    // The chain ends in a string: a computed prefix, so the route has no pattern.
    expect(reg("/deep")?.pattern).toBeNull();
    expect(mountGap("app.use(x0, deep);")?.name).toBe("x0");
    // A name written more often than the cap is not read: middleware, as before this rule.
    expect(reg("/many")?.pattern).toBe("/many");
    expect(mountGap("app.use(wide, many);")).toBeUndefined();
  }, 60_000);

  it("says when a test request could not be matched because the route or the request is beyond what the matcher reads", () => {
    const atRequests = gaps("src/long.test.ts").filter((u) => u.affects.includes("tests"));
    expect(atRequests.map((u) => u.site?.line).sort()).toEqual([5, 6]);
  });
});
