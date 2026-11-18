// The truth script of the Hono acceptance test (hono-truth.mjs) on shapes
// it once lost without a word: a router whose `new` is wrapped (`new Hono()
// as Hono`), and a route chained on another (`app.get(...).post(...)`). A
// truth that drops a route hides a route the graph misses, so each shape is
// either read or listed under `unread`, never skipped.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";
// @ts-expect-error: a plain script with no type declarations
import { honoTruth } from "./hono-truth.mjs";

afterAll(removeTempDirs);

const files: Record<string, string> = {
  "src/handlers.ts": "export const health = (c: unknown) => c;\n",
  "src/users.ts": ['import { Hono } from "hono";', 'import { health } from "./handlers";', "export function makeUsers() {", "  const router = (new Hono() as Hono);", '  router.get("/list", health);', "  return router;", "}"].join("\n"),
  "src/bare.ts": ['import { Hono } from "hono";', "export function bare() {", "  return (new Hono());", "}"].join("\n"),
  "src/app.ts": [
    'import { Hono } from "hono";',
    'import { health } from "./handlers";',
    'import { makeUsers } from "./users";',
    'import { bare } from "./bare";',
    "export function createServerApp() {",
    "  const app = new Hono();",
    '  app.get("/a", health).post("/b", health);',
    '  app.route("/u", makeUsers());',
    '  app.route("/bare", bare());',
    '  app.basePath("/v").get("/c", health);',
    "  return app;",
    "}",
  ].join("\n"),
};

describe("the Hono truth script", () => {
  it("reads a wrapped construction and chained routes, and lists what it cannot read", () => {
    const root = tempDir("oq-hono-truth-");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const truth = honoTruth(root, "src", "src/app.ts", "createServerApp") as { routes: { site: string; method: string; path: string }[]; unread: { site: string; why: string }[] };
    expect(truth.routes.map((r) => `${r.method} ${r.path} ${r.site}`).sort()).toEqual(["GET /a src/app.ts:7", "GET /u/list src/users.ts:5", "POST /b src/app.ts:7"]);
    // basePath makes a value of its own: the call on it and the route chained on it are both unread.
    // The router bare() returns is bound to no variable, so its calls cannot be found.
    expect(truth.unread.map((u) => u.site).sort()).toEqual(["src/app.ts:10", "src/app.ts:10", "src/bare.ts:3"]);
  });
});
