// The Hono plugin on the sample application of the corpus
// (corpus/frameworks/hono/hono-openapi, the prospect's layout: createRoute
// constants in one file, a router factory in another, mounted through a
// wrapper that adds middleware), built as a real git repository and run
// through the whole graph build: the `routes` question, and the routes a
// review names for a change to a handler. Then a Hono server beside a React
// client, which must not read as a server the build does not read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getChange } from "@openqodex/core";
import type { ImpactSummary } from "@openqodex/core";
import { buildGraph, detectImpact } from "../../index.js";
import type { Graph, Registration } from "../../index.js";
import { query } from "../../query/engine.js";
import type { Request } from "../../query/engine.js";
import { honoPath } from "./resolve.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks", "hono");

// The corpus case's base, committed, with its change written over it.
async function sample(name: string): Promise<{ root: string; graph: Graph; impact: ImpactSummary }> {
  const root = mkdtempSync(join(tmpdir(), "oq-hono-"));
  cpSync(join(corpus, name, "base"), root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  cpSync(join(corpus, name, "change"), root, { recursive: true, force: true });
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
  return { root, graph, impact: detectImpact(graph, change) };
}
const routesOf = (graph: Graph) => query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "routes", limit: 500 } as Request);
const regs = (graph: Graph): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "hono");

describe("the Hono plugin on the prospect's layout", () => {
  let s: Awaited<ReturnType<typeof sample>>;
  beforeAll(async () => {
    s = await sample("hono-openapi");
  }, 120_000);
  afterAll(() => rmSync(s.root, { recursive: true, force: true }));

  it("lists each route once, with its method, full path and application, and each OpenAPI {id} served as :id", () => {
    const listed = regs(s.graph).map((r) => `${r.methods.join(",")} ${r.pattern} ${r.site.file}:${r.site.line}`);
    expect(new Set(listed).size).toBe(listed.length);
    const users = regs(s.graph).filter((r) => r.site.file === "src/apis/users.ts" && r.pattern !== null);
    // The users router is mounted twice: by the application, and by the settings router under /members.
    expect(users.map((r) => `${r.methods.join(",")} ${r.pattern} ${r.written}`).sort()).toEqual([
      "DELETE /api/v1/settings/members/:user_id/sessions/:session_id /{user_id}/sessions/{session_id}",
      "DELETE /api/v1/users/:user_id/sessions/:session_id /{user_id}/sessions/{session_id}",
      "GET /api/v1/settings/members /",
      "GET /api/v1/settings/members/:user_id /{user_id}",
      "GET /api/v1/users /",
      "GET /api/v1/users/:user_id /{user_id}",
    ]);
    expect(new Set(users.map((r) => r.app))).toEqual(new Set(["fw:hono:app:src/app.ts:21"]));
  });

  it("puts no route under a prefix whose router the wrapper drops", () => {
    expect(regs(s.graph).filter((r) => r.pattern?.startsWith("/api/v1/other") || r.pattern?.startsWith("/api/v1/remote"))).toEqual([]);
  });

  it("answers routes as a floor, with the route it could not read named at its site", () => {
    const a = routesOf(s.graph);
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    const gaps = (s.graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "hono").map((u) => `${u.cause} ${u.site?.file}:${u.site?.line}`);
    expect(gaps).toEqual(expect.arrayContaining(["dynamic src/apis/users.ts:15", "miss src/app.ts:26"]));
  });

  it("names the route a change to a handler reaches, with its full path", () => {
    const routes = s.impact.frameworks?.routes ?? [];
    expect(routes.some((r) => r.plugin === "hono" && r.pattern === "/api/v1/users" && r.methods.includes("GET"))).toBe(true);
  });

  it("serves each {name} of an OpenAPI path as :name and leaves the rest as written", () => {
    expect(honoPath("/{a}/x/{b_c}")).toBe("/:a/x/:b_c");
    expect(honoPath("/{")).toBe("/{");
    expect(honoPath("/{}")).toBe("/{}");
    expect(honoPath("/a{b}")).toBe("/a{b}");
    // As the library's pattern reads them: the name runs to the first } after one character.
    expect(honoPath("/{a/b}")).toBe("/:a/b");
    expect(honoPath("/{}}/x")).toBe("/:}/x");
    expect(honoPath("/{a\nb}/{c}")).toBe("/{a\nb}/:c");
    // The same answer as the library's own pattern on random paths of these characters.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 5000; k++) {
      const p = Array.from({ length: rand(16) }, () => "/{}a\n"[rand(5)]).join("");
      expect(honoPath(p), JSON.stringify(p)).toBe(p.replaceAll(/\/{(.+?)}/g, "/:$1"));
    }
    // A path of thousands of unclosed braces is read in one pass.
    const open = "/{".repeat(200_000);
    const t = performance.now();
    expect(honoPath(open)).toBe(open);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("the Hono plugin beside a React client", () => {
  let s: Awaited<ReturnType<typeof sample>>;
  beforeAll(async () => {
    s = await sample("hono-react-repro");
  }, 120_000);
  afterAll(() => rmSync(s.root, { recursive: true, force: true }));

  it("lists the server's routes and does not call Hono a server the build does not read", () => {
    const a = routesOf(s.graph);
    expect(a.error).toBeNull();
    expect(a.items.length).toBeGreaterThan(0);
    expect(regs(s.graph).length).toBeGreaterThan(0);
    expect(a.unknown.reasons.join(" ")).not.toMatch(/does not read/);
  });
});
