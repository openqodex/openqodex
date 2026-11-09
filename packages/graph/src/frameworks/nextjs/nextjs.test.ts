// The Next.js plugin on middleware matchers it can and cannot read. The
// sample application of the corpus (corpus/frameworks/nextjs/nextjs-app)
// proves its routes and middleware links.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph } from "../../index.js";
import { cpuMs, expectLinear, growthTests } from "../../test-timing.js";
import { intersects, parseMatcher, routeSegments } from "./resolve.js";

function commit(root: string): void {
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
}
const layer = (g: Graph): FrameworkLayer => {
  const l = frameworkLayer(g);
  if (!l) throw new Error("the graph has no framework layer");
  return l;
};

describe("the Next.js plugin reads matchers segment by segment", () => {
  it("selects a route under a matcher with a trailing wildcard, and its own folder", () => {
    const m = parseMatcher("/dashboard/:path*");
    expect(m).not.toBeNull();
    expect(intersects(m ?? [], routeSegments("/dashboard") ?? [])).toBe(true);
    expect(intersects(m ?? [], routeSegments("/dashboard/[id]/edit") ?? [])).toBe(true);
    expect(intersects(m ?? [], routeSegments("/") ?? [])).toBe(false);
    expect(intersects(m ?? [], routeSegments("/blog/[slug]") ?? [])).toBe(false);
  });

  it("matches a dynamic or catch-all route segment against a literal matcher segment", () => {
    expect(intersects(parseMatcher("/blog/intro") ?? [], routeSegments("/blog/[slug]") ?? [])).toBe(true);
    expect(intersects(parseMatcher("/docs/a/b/c") ?? [], routeSegments("/docs/[...rest]") ?? [])).toBe(true);
    expect(intersects(parseMatcher("/docs") ?? [], routeSegments("/docs/[...rest]") ?? [])).toBe(false);
    expect(intersects(parseMatcher("/docs") ?? [], routeSegments("/docs/[[...rest]]") ?? [])).toBe(true);
  });

  it("does not read a matcher with a regular expression group, so the plugin never compiles one", () => {
    expect(parseMatcher("/((?!api|_next/static).*)")).toBeNull();
  });

  const m = parseMatcher(`/${Array.from({ length: 60 }, (_, i) => `:p${i}*`).join("/")}/end`) ?? [];
  const route = (depth: number) => routeSegments(`/${Array.from({ length: depth }, (_, i) => `[...r${i}]`).join("/")}/x`) ?? [];
  it("matches a matcher of sixty wildcards against a deep route", () => {
    expect(intersects(m, route(60))).toBe(false);
  });

  growthTests("in time linear in the route's depth", () => {
    it("matches a matcher of sixty wildcards against a deep route in time linear in the route's depth", async () => {
      const quarter = route(15);
      const full = route(60);
      expectLinear("a matcher of sixty wildcards against routes 15 and 60 deep", await cpuMs(() => intersects(m, quarter)), await cpuMs(() => intersects(m, full)));
    });
  });
});

describe("the Next.js plugin on a middleware whose matcher it cannot read, or that is computed", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "mw", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } }),
      "app/page.tsx": "export default function Home() {\n  return null;\n}\n",
      "app/api/ping/route.ts": "// export function POST() {}\nexport function GET() {\n  return new Response(\"pong\");\n}\n",
      "middleware.ts": 'export function middleware() {\n  return undefined;\n}\nexport const config = { matcher: ["/((?!api).*)"] };\n',
      "other/package.json": JSON.stringify({ name: "mw2", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } }),
      "other/app/page.tsx": "export default function Other() {\n  return null;\n}\n",
      "other/middleware.ts": 'const paths = ["/a"];\nexport function middleware() {\n  return undefined;\n}\nexport const config = { matcher: paths };\n',
    };
    root = mkdtempSync(join(tmpdir(), "oq-next-mw-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    commit(root);
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("links a middleware whose matcher is a regular expression to every route as possible, with a note", () => {
    const edges = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "nextjs" && e.kind === "applies_middleware" && e.to.startsWith("middleware.ts#"));
    expect(edges.length).toBe(2);
    expect(edges.every((e) => e.evidence.tier === "possible" && (e.evidence.note ?? "").includes("does not read"))).toBe(true);
  });

  it("says a computed matcher is unknown and links the middleware to no route", () => {
    expect((graph.frameworks?.edges ?? []).some((e) => e.kind === "applies_middleware" && e.to.startsWith("other/middleware.ts#"))).toBe(false);
    expect(graph.frameworks?.unknowns.some((u) => u.plugin === "nextjs" && u.cause === "dynamic" && u.site?.file === "other/middleware.ts")).toBe(true);
  });

  it("registers no method that is written only in a comment", () => {
    const methods = layer(graph)
      .registrations()
      .filter((r) => r.site.file === "app/api/ping/route.ts")
      .flatMap((r) => r.methods);
    expect(methods).toEqual(["GET"]);
  });
});
