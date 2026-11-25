// A repository can be written to attack the Hono plugin: the plugin reads
// route files a stranger controls, and follows function calls to find the
// routers they return. These tests build a hostile repository of more than
// 1 MiB (a mount chain that loops, a diamond of routers that triples at
// every level, a factory that calls itself, thousands of routes on one
// router mounted six times, a file over the byte cap) and check that the
// plugin stops at each cap, says so with an unknown, and takes time that
// grows with the repository and no faster.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph, Registration } from "../../index.js";
import { expectLinear, growthTests, pluginCpuMs, readerCpuMs } from "../../test-timing.js";
import { MAX_SOURCE_BYTES } from "../express/js.js";
import { readFacts } from "./facts.js";
import { MAX_MOUNT_DEPTH, MAX_MOUNTS, MAX_REGISTRATIONS } from "./resolve.js";

const HEAD = 'import { Hono } from "hono";\nimport { h } from "./h.js";\n';

// Hundreds of routers in a chain, the last mounting the first again.
function chain(n: number): string {
  const lines = [HEAD, "export const app = new Hono();"];
  for (let i = 0; i < n; i++) lines.push(`const c${i} = new Hono();`);
  lines.push(`c${n - 1}.get("/end", h);`, `c${n - 1}.route("/loop", c0);`);
  for (let i = n - 2; i >= 0; i--) lines.push(`c${i}.route("/c", c${i + 1});`);
  lines.push('app.route("/", c0);');
  return lines.join("\n");
}

// A diamond: every router mounts the next one three times, so the routes triple at every level.
function diamond(levels: number): string {
  const lines = [HEAD, "export const dapp = new Hono();"];
  for (let i = 0; i <= levels; i++) lines.push(`const d${i} = new Hono();`);
  for (let i = 0; i < 40; i++) lines.push(`d${levels}.get("/r${i}", h);`);
  for (let i = levels - 1; i >= 0; i--) lines.push(`d${i}.route("/p", d${i + 1});`, `d${i}.route("/q", d${i + 1});`, `d${i}.route("/r", d${i + 1});`);
  lines.push('dapp.route("/", d0);');
  return lines.join("\n");
}

// A factory that calls itself to make its router, and one that wraps the
// router in hundreds of functions, each returning the next.
function recursive(n: number): string {
  const lines = [HEAD, "export const rapp = new Hono();", "function self(): Hono { return self(); }", 'rapp.route("/self", self());'];
  lines.push("function w0() { const r = new Hono(); r.get('/deep', h); return r; }");
  for (let i = 1; i < n; i++) lines.push(`function w${i}() { return w${i - 1}(); }`);
  lines.push(`rapp.route("/wrapped", w${n - 1}());`);
  return lines.join("\n");
}

// A thousand routes on one router, mounted six times, with hundreds of middleware.
function wide(routes: number, middleware: number): string {
  const lines = [HEAD, "export const wapp = new Hono();", "const w = new Hono();"];
  for (let i = 0; i < middleware; i++) lines.push("wapp.use(h);");
  for (let i = 0; i < routes; i++) lines.push(`w.get("/w${i}/:id", h);`);
  for (const m of ["a", "b", "c", "d", "e", "f"]) lines.push(`wapp.route("/${m}", w);`);
  return lines.join("\n");
}

function pad(source: string, bytes: number): string {
  const filler = "\n// padding to reach the size of a large generated route file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}

// The hostile repository at scale 4; at scale 1 the same shapes at a
// quarter of the count and the size, which the timing tests compare it with.
function hostile(scale: 1 | 4): Record<string, string> {
  const q = scale / 4;
  const kib = (n: number) => n * q * 1024;
  const files: Record<string, string> = {};
  files["package.json"] = JSON.stringify({ name: "hostile", private: true, type: "module", dependencies: { hono: "^4.6.0" } });
  files["src/h.ts"] = "export function h(): Response { return new Response(); }\n";
  files["src/chain.ts"] = pad(chain(600 * q), kib(200));
  files["src/chain2.ts"] = pad(chain(600 * q), kib(200));
  files["src/diamond.ts"] = pad(diamond(30), kib(120));
  // Before the diamond in path order, so it is walked before the diamond spends the mount budget.
  // Before the diamond in path order, so it is walked before the diamond spends the mount budget.
  files["src/ab-recursive.ts"] = pad(recursive(400 * q), kib(160));
  files["src/aa-wide.ts"] = pad(wide(1000 * q, 300 * q), kib(240));
  files["src/padding.ts"] = pad(HEAD, kib(200));
  // Over the byte cap: the plugin must not read it, and must say so.
  files["src/huge.ts"] = pad(wide(100, 1), MAX_SOURCE_BYTES + 64 * 1024);
  return files;
}

function commitRepo(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "hostile");
  return dir;
}

const files = hostile(4);
const sources = (of: Record<string, string>) => Object.entries(of).filter(([path, content]) => path.endsWith(".ts") && Buffer.byteLength(content) <= MAX_SOURCE_BYTES).map(([, content]) => content);
const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
let root: string;
let quarter: string;
let graph: Graph;
const hono = () => ({
  regs: (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "hono"),
  mounts: (graph.frameworks?.edges ?? []).filter((e) => e.kind === "mounts" && e.plugin === "hono"),
  unknowns: (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "hono"),
});

beforeAll(async () => {
  const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
  expect(total).toBeGreaterThan(1024 * 1024);
  root = commitRepo("oq-hono-hostile-", files);
  quarter = commitRepo("oq-hono-hostile-", hostile(1));
  graph = await build(root)();
}, 600_000);
afterAll(() => {
  for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("the Hono plugin on a hostile repository", () => {
  growthTests("in time that grows with it", () => {
    it("reads the facts of more than 1 MiB of crafted route files in time that grows with their size and no faster", async () => {
      expectLinear("the Hono fact reader on the hostile files", await readerCpuMs("typescript", sources(hostile(1)), readFacts), await readerCpuMs("typescript", sources(files), readFacts));
    }, 300_000);

    it("resolves a crafted repository in time that grows with it and no faster, so a route file cannot hang the build", async () => {
      expectLinear("the Hono plugin on the hostile repository", await pluginCpuMs(build(quarter), "hono"), await pluginCpuMs(build(root), "hono"));
    }, 300_000);
  });

  it("resolves a crafted repository", () => {
    expect(graph.frameworks?.plugins.find((p) => p.id === "hono")?.status).toBe("ok");
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = hono().unknowns.find((u) => u.cause === "file-not-parsed" && u.site?.file === "src/huge.ts");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
    expect(hono().regs.some((e) => e.site.file === "src/huge.ts")).toBe(false);
  });

  it("stops the diamond and the router mounted six times at the build's caps, and says so", () => {
    const { regs, mounts, unknowns } = hono();
    expect(regs.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    expect(mounts.length).toBeLessThanOrEqual(MAX_MOUNTS);
    const notes = unknowns.filter((u) => u.cause === "fan-out-capped").map((u) => u.note).join("\n");
    expect(notes.includes(`${MAX_MOUNTS} router mounts`) || notes.includes(`${MAX_REGISTRATIONS} registrations`) || notes.includes(`more than ${MAX_MOUNT_DEPTH} levels deep`)).toBe(true);
  });

  it("stops a mount chain that loops back on itself, and says the routers past the depth cap were not followed", () => {
    const { regs, unknowns } = hono();
    expect(regs.filter((e) => e.site.file === "src/chain.ts" && e.app !== null).length).toBe(0);
    expect(unknowns.some((u) => u.cause === "fan-out-capped" && u.note.includes(`more than ${MAX_MOUNT_DEPTH} levels deep`))).toBe(true);
  });

  it("stops a factory that calls itself or hides its router under hundreds of calls, and names an unknown at each mount", () => {
    const { regs, unknowns } = hono();
    // The router made under the calls is mounted, so it is no application of its own.
    expect(graph.frameworks?.apps.filter((a) => a.plugin === "hono" && a.site.file === "src/ab-recursive.ts").map((a) => a.site.line)).toEqual([4]);
    expect(regs.some((e) => e.site.file === "src/ab-recursive.ts" && e.app !== null)).toBe(false);
    const at = unknowns.filter((u) => u.site?.file === "src/ab-recursive.ts" && u.cause === "fan-out-capped").map((u) => u.site?.line);
    expect(at).toEqual([6, 7 + 400]);
  });
});
