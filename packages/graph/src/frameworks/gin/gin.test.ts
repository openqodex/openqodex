// The gin plugin on the sample application of the corpus
// (corpus/frameworks/gin/gin-app), built as a real git repository and run
// through the whole graph build: the `routes` question and the routes a
// review names for a change to a handler. Then small repositories for what
// the plugin cannot read, and a crafted repository that tries to hang or
// exhaust the build. Ways it could fail, written before the code:
//  1. `routes` on a gin service is still a capability boundary that names
//     gin as a framework this build does not read.
//  2. A route on a group loses the group's prefix, or a group's middleware
//     reaches the engine's own routes.
//  3. A route the plugin cannot place (a computed group prefix, a router held
//     in a struct field, a receiver whose type it does not read, a computed
//     method) vanishes with no unknown.
//  4. A crafted repository (thousands of routes, a group chain deeper than
//     the cap, thousands of Use calls, a file over the byte cap) hangs the
//     build or stops with no unknown.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getChange } from "@openqodex/core";
import type { ImpactSummary } from "@openqodex/core";
import { buildGraph, detectImpact } from "../../index.js";
import type { Graph, Registration } from "../../index.js";
import { query } from "../../query/engine.js";
import type { Request } from "../../query/engine.js";
import { expectLinear, growthTests, pluginCpuMs, readerCpuMs } from "../../test-timing.js";
import { MAX_SOURCE_BYTES } from "../go-http/facts.js";
import { readFacts } from "./facts.js";
import { MAX_GROUP_DEPTH, MAX_MIDDLEWARE_CHAIN, MAX_REGISTRATIONS } from "./resolve.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks", "gin");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function commitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-gin-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const routesOf = (graph: Graph) => query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "routes", limit: 500 } as Request);
const regs = (graph: Graph): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "gin");
const gaps = (graph: Graph) => (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "gin");

describe("the gin plugin on the sample application", () => {
  let root: string;
  let graph: Graph;
  let impact: ImpactSummary;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-gin-app-"));
    dirs.push(root);
    cpSync(join(corpus, "gin-app", "base"), root, { recursive: true });
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "test");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    cpSync(join(corpus, "gin-app", "change"), root, { recursive: true, force: true });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    impact = detectImpact(graph, change);
  }, 120_000);

  it("answers routes with every route of the engine and its groups, and no longer names gin as unread (1, 2)", () => {
    const a = routesOf(graph);
    expect(a.error).toBeNull();
    expect(a.unknown.reasons.join(" ")).not.toMatch(/Gin/);
    const listed = (a.items as { methods: string[]; pattern: string | null; app: string | null }[]).filter((r) => r.app !== null).map((r) => `${r.methods.join(",")} ${r.pattern}`);
    expect(listed.sort()).toEqual(["* /proxy", "DELETE /api/v1/staff/items/:id", "GET /api/v1/items/:id", "GET /api/v1/staff/stats", "GET /healthz", "GET /me", "POST /api/v1/items", "POST /login"].sort());
  });

  it("names the route a change to a handler reaches, with its full path", () => {
    const routes = impact.frameworks?.routes ?? [];
    expect(routes.some((r) => r.plugin === "gin" && r.pattern === "/api/v1/items/:id" && r.methods.includes("GET"))).toBe(true);
  });
});

describe("the gin plugin on small repositories", () => {
  const head = 'package main\n\nimport "github.com/gin-gonic/gin"\n\n';
  const mod = "module example.com/svc\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n";
  // The line of the first line holding `marker`.
  const lineOf = (source: string, marker: string): number => source.split("\n").findIndex((l) => l.includes(marker)) + 1;

  it("never lets a route vanish silently because its prefix, its receiver or its method cannot be read (3)", async () => {
    const main = [
          head.trimEnd(),
          "",
          "type server struct {",
          "\trouter *gin.Engine",
          "}",
          "",
          "func h(c *gin.Context) {}",
          "",
          "func routerFrom() interface{ GET(string, ...gin.HandlerFunc) } { return nil }",
          "",
          "func (s *server) routes(prefix string, method string) {",
          "\ts.router.GET(\"/field\", h)",
          "\tr := gin.New()",
          "\tg := r.Group(prefix)",
          '\tg.GET("/under", h)',
          '\tr.Handle(method, "/any", h)',
          '\troutes := routerFrom()',
          '\troutes.GET("/unknown", h)',
          "}",
          "",
        ].join("\n");
    const graph = await buildGraph({ repoRoot: commitRepo({ "go.mod": mod, "main.go": main }), store: null });
    const at = (marker: string) => regs(graph).find((r) => r.site.file === "main.go" && r.site.line === lineOf(main, marker));
    const gapAt = (marker: string) => gaps(graph).filter((u) => u.site?.file === "main.go" && u.site.line === lineOf(main, marker)).map((u) => u.cause);
    // A router held in a struct field: kept with no application, and an unknown says where it lands is decided elsewhere.
    expect(at("/field")?.app).toBeNull();
    expect(gapAt("/field")).toContain("dynamic");
    // A group whose prefix is computed: kept with no pattern, and an unknown at the group.
    expect(at("/under")?.pattern).toBeNull();
    expect(at("/under")?.app).not.toBeNull();
    expect(gapAt("r.Group(prefix)")).toContain("dynamic");
    // A computed method: no registration, an unknown.
    expect(at("/any")).toBeUndefined();
    expect(gapAt("/any")).toContain("dynamic");
    // A receiver whose type the plugin does not read: no registration, an unknown.
    expect(at("/unknown")).toBeUndefined();
    expect(gapAt("/unknown")).toEqual(["no-receiver-type"]);
  }, 60_000);

  it("applies a Use written after a route to nothing before it, and a Use from another function with tier possible (2)", async () => {
    const main = [
          head.trimEnd(),
          "",
          "func h(c *gin.Context) {}",
          "func early(c *gin.Context) {}",
          "func late(c *gin.Context) {}",
          "func elsewhere(c *gin.Context) {}",
          "",
          "var r = gin.New()",
          "",
          "func main() {",
          "\tr.Use(early)",
          '\tr.GET("/a", h)',
          "\tr.Use(late)",
          "}",
          "",
          "func init() {",
          "\tr.Use(elsewhere)",
          "}",
          "",
        ].join("\n");
    const graph = await buildGraph({ repoRoot: commitRepo({ "go.mod": mod, "main.go": main }), store: null });
    const reg = regs(graph).find((r) => r.site.line === lineOf(main, '"/a"'));
    expect(reg?.pattern).toBe("/a");
    const mw = (graph.frameworks?.edges ?? []).filter((e) => e.kind === "applies_middleware" && e.from === reg?.id).map((e) => `${graph.nodes.get(e.to)?.name} ${e.evidence.tier}`);
    expect(mw.sort()).toEqual(["early certain", "elsewhere possible"]);
  }, 60_000);
});

// ---------- a crafted repository ----------

const HEAD = 'package main\n\nimport "github.com/gin-gonic/gin"\n\n';

function pad(source: string, bytes: number): string {
  const filler = "\n// padding to reach the size of a large generated route file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}

// At scale 4; at scale 1 the same shapes at a quarter of the count and the size.
function crafted(scale: 1 | 4): Record<string, string> {
  const q = scale / 4;
  const files: Record<string, string> = {};
  files["go.mod"] = "module example.com/hostile\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n";
  files["h.go"] = `${HEAD}func h(c *gin.Context) {}\n\nvar R = gin.New()\n`;
  // Twelve thousand routes on one engine, over eight files.
  const per = 1500 * q;
  for (let k = 0; k < 8; k++) {
    const lines = [HEAD, "func init() {"];
    for (let i = 0; i < per; i++) lines.push(`\tR.GET("/b${k * per + i}/:id", h)`);
    lines.push("}");
    files[`zbig${k}.go`] = pad(lines.join("\n"), 100 * 1024 * q);
  }
  // A group chain deeper than the cap, and a route at its end.
  const deep = [HEAD, "func deep() {", "\tg0 := R.Group(\"/d\")"];
  for (let i = 1; i < 200; i++) deep.push(`\tg${i} := g${i - 1}.Group("/d")`);
  deep.push('\tg199.GET("/end", h)', "}");
  files["deep.go"] = deep.join("\n");
  // Thousands of Use calls on one engine before one route.
  const wide = [HEAD, "var W = gin.New()", "", "func wide() {"];
  for (let i = 0; i < 1000 * q; i++) wide.push("\tW.Use(h)");
  wide.push('\tW.GET("/wide", h)', "}");
  files["wide.go"] = wide.join("\n");
  // Over the byte cap: not read, and said so.
  files["huge.go"] = pad(`${HEAD}func huge() {\n\tR.GET("/huge", h)\n}\n`, MAX_SOURCE_BYTES + 64 * 1024);
  return files;
}

describe("the gin plugin on a crafted repository (4)", () => {
  const files = crafted(4);
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  const sources = (of: Record<string, string>) => Object.entries(of).filter(([path, content]) => path.endsWith(".go") && Buffer.byteLength(content) <= MAX_SOURCE_BYTES).map(([, content]) => content);
  let root: string;
  let quarter: string;
  let graph: Graph;
  beforeAll(async () => {
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    root = commitRepo(files);
    quarter = commitRepo(crafted(1));
    graph = await build(root)();
  }, 300_000);

  growthTests("in time that grows with it", () => {
    it("reads the facts of more than 1 MiB of crafted route files in time that grows with them and no faster", async () => {
      expectLinear("the gin fact reader on the crafted files", await readerCpuMs("go", sources(crafted(1)), readFacts), await readerCpuMs("go", sources(files), readFacts));
    }, 300_000);
    it("resolves a crafted repository in time that grows with it and no faster", async () => {
      expectLinear("the gin plugin on the crafted repository", await pluginCpuMs(build(quarter), "gin"), await pluginCpuMs(build(root), "gin"));
    }, 300_000);
  });

  it("resolves it, and stops at the registration cap with one unknown", () => {
    expect(graph.frameworks?.plugins.find((p) => p.id === "gin")?.status).toBe("ok");
    expect(regs(graph).length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    expect(gaps(graph).filter((u) => u.cause === "fan-out-capped" && u.note.includes(`registrations after ${MAX_REGISTRATIONS} `)).length).toBe(1);
  });

  it("stops a group chain deeper than the cap, and says so", () => {
    expect(regs(graph).some((r) => r.site.file === "deep.go")).toBe(false);
    expect(gaps(graph).some((u) => u.note.includes(`more than ${MAX_GROUP_DEPTH} levels deep`))).toBe(true);
  });

  it("keeps the first middleware of a route with thousands and says the rest are not listed", () => {
    const wide = regs(graph).find((r) => r.site.file === "wide.go");
    expect(wide).toBeDefined();
    const mw = (graph.frameworks?.edges ?? []).filter((e) => e.kind === "applies_middleware" && e.from === wide?.id);
    expect(mw.length).toBeLessThanOrEqual(MAX_MIDDLEWARE_CHAIN);
    expect(gaps(graph).some((u) => u.site?.file === "wide.go" && u.cause === "fan-out-capped")).toBe(true);
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    expect(regs(graph).some((r) => r.site.file === "huge.go")).toBe(false);
    expect(gaps(graph).find((u) => u.cause === "file-not-parsed" && u.site?.file === "huge.go")?.note).toContain(String(MAX_SOURCE_BYTES));
  });
});
