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

const MW = "export async function auth(_c: unknown, next: () => Promise<void>) {\n  await next();\n}\nexport async function log(_c: unknown, next: () => Promise<void>) {\n  await next();\n}\nexport async function cors(_c: unknown, next: () => Promise<void>) {\n  await next();\n}\n";
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "review", private: true, type: "module", dependencies: { hono: "^4.6.0" } }),
  "src/mw.ts": MW,
  // A middleware path read from the environment: the first argument of use may be a path, so auth's coverage is not known.
  // Two middleware with no path: both apply to every route (the negative control).
  "src/app.ts": ['import { Hono } from "hono";', 'import { auth, cors, log } from "./mw";', "const app = new Hono();", "app.use(process.env.AUTH_PATH, auth);", "app.use(log, cors);", 'app.get("/public", (c) => c.text("ok"));', "export default app;"].join("\n"),
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
});
