// A repository can be written to attack the React plugin: it reads
// components a stranger controls. These tests build a hostile repository of
// more than 1 MiB (thousands of components each rendering the next, an
// element nested thousands deep, thousands of nested arrow functions, two
// hooks that call each other, a file over the byte cap) and a repository
// that splits its elements over a hundred files, and check that the plugin's
// time grows with the repository and no faster, that it stops at each
// budget, and that it says so.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph } from "../../index.js";
import { expectLinear, growthTests, pluginCpuMs, readerCpuMs } from "../../test-timing.js";
import { MAX_SOURCE_BYTES } from "../express/js.js";
import { readFacts } from "./facts.js";
import { MAX_RENDER_EDGES } from "./resolve.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-react-hostile-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const run = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  run("add", "-A");
  run("commit", "-q", "-m", "hostile");
  return root;
}

function pad(source: string, bytes: number): string {
  const filler = "\n// padding to reach the size of a large generated component file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}

// Components each rendering the next (the core keeps 2,000 facts of one file).
function chain(prefix: string, n: number): string {
  const lines = ['import { useState } from "react";'];
  for (let i = 0; i < n; i++) lines.push(`export function ${prefix}${i}() {\n  return <${prefix}${i + 1} />;\n}`);
  lines.push(`export function ${prefix}${n}() {\n  const [v] = useState(0);\n  return <b>{v}</b>;\n}`);
  return lines.join("\n");
}

const PKG = JSON.stringify({ name: "hostile", private: true, dependencies: { react: "^19.0.0" } });

describe("the React plugin on a hostile repository", () => {
  // The hostile repository at scale 4; at scale 1 the same shapes at a
  // quarter of the count, the depth and the size, which the timing tests
  // compare it with. The file over the byte cap stays over it.
  function hostile(scale: 1 | 4): Record<string, string> {
    const q = scale / 4;
    const files: Record<string, string> = { "package.json": PKG };
    for (let f = 0; f < 4; f++) files[`src/chain${f}.tsx`] = pad(chain(`C${f}x`, 600 * q), 180 * 1024 * q);
    // An element nested 1,500 deep.
    files["src/deep.tsx"] = pad(`export function Box(p: { children?: unknown }) {\n  return <i>{String(p.children)}</i>;\n}\nexport function Deep() {\n  return ${"<Box>".repeat(1500 * q)}x${"</Box>".repeat(1500 * q)};\n}`, 150 * 1024 * q);
    // Arrow functions nested 2,000 deep, the innermost returning an element.
    files["src/arrows.tsx"] = pad(`import { Box } from "./deep";\nexport const Arrows = ${"() => ".repeat(2000 * q)}<Box />;`, 150 * 1024 * q);
    // Two hooks that call each other: neither proves the other.
    files["src/hooks.ts"] = "export function useA(): number {\n  return useB();\n}\nexport function useB(): number {\n  return useA();\n}\n";
    files["src/huge.tsx"] = pad(chain("H", 50), MAX_SOURCE_BYTES + 64 * 1024);
    return files;
  }
  const files = hostile(4);
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  // The sources the reader is timed on: the file over the byte cap is the same
  // at both scales and the plugin never reads it, so it is left out.
  const sources = (of: Record<string, string>) => Object.entries(of).filter(([path, content]) => (path.endsWith(".tsx") || path.endsWith(".ts")) && Buffer.byteLength(content) <= MAX_SOURCE_BYTES).map(([, content]) => content);
  let root: string;
  let quarter: string;
  let graph: Graph;
  beforeAll(async () => {
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    root = repo(files);
    quarter = repo(hostile(1));
    graph = await build(root)();
  }, 600_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  growthTests("in time that grows with it", () => {
    it("reads the facts of more than 1 MiB of crafted components in time that grows with them and no faster", async () => {
      expectLinear("the React fact reader on the hostile files", await readerCpuMs("tsx", sources(hostile(1)), readFacts), await readerCpuMs("tsx", sources(files), readFacts));
    }, 300_000);

    it("resolves a crafted repository in time that grows with it and no faster, so a component file cannot hang the build", async () => {
      expectLinear("the React plugin on the hostile repository", await pluginCpuMs(build(quarter), "react"), await pluginCpuMs(build(root), "react"));
    }, 300_000);
  });

  it("resolves a crafted repository", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "react");
    expect(run?.status).toBe("ok");
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = graph.frameworks?.unknowns.find((u) => u.plugin === "react" && u.cause === "file-not-parsed" && u.site?.file === "src/huge.tsx");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
  });

  it("calls neither of two hooks that only call each other a hook", () => {
    const hooks = (graph.frameworks?.roles ?? []).filter((r) => r.plugin === "react" && r.role === "hook").map((r) => r.target);
    expect(hooks.some((t) => t.startsWith("src/hooks.ts#"))).toBe(false);
  });
});

describe("the React plugin on elements split over a hundred files", () => {
  let root: string;
  let quarter: string;
  let graph: Graph;
  // `count` files of 500 elements each.
  const split = (count: number): Record<string, string> => {
    const files: Record<string, string> = { "package.json": PKG, "src/Badge.tsx": "export function Badge() {\n  return <span />;\n}\n" };
    for (let f = 0; f < count; f++) files[`src/split/p${f}.tsx`] = `import { Badge } from "../Badge";\nexport function P${f}() {\n  return <div>${"<Badge />".repeat(500)}</div>;\n}\n`;
    return files;
  };
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, budgetMs: 120_000 });
  beforeAll(async () => {
    // 120 files of 500 elements each: 60,000 elements, far below any cap one file could reach.
    root = repo(split(120));
    quarter = repo(split(30));
    graph = await build(root)();
  }, 600_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("stops at the build's renders budget, though no file alone comes near it, and says so", () => {
    const renders = (graph.frameworks?.edges ?? []).filter((e) => e.plugin === "react" && e.kind === "renders");
    expect(renders.length).toBe(MAX_RENDER_EDGES);
    const cut = graph.frameworks?.unknowns.find((u) => u.plugin === "react" && u.cause === "fan-out-capped" && u.note.includes(String(MAX_RENDER_EDGES)));
    expect(cut?.count).toBe(60_000 - MAX_RENDER_EDGES);
  });

  growthTests("in time that grows with the files", () => {
    it("finishes the split work in time that grows with the files and no faster", async () => {
      expectLinear("the React plugin on 30 and on 120 files of elements", await pluginCpuMs(build(quarter), "react"), await pluginCpuMs(build(root), "react"));
    }, 300_000);
  });
});
