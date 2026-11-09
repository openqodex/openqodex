// Cases a review of the React plugin found: a hook proved through a name a
// parameter shadows, roles that grew past what the build can append, and a
// component lookup that scanned a file's symbols once per component.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { Graph } from "../../index.js";
import { expectLinear, growthTests, pluginCpuMs } from "../../test-timing.js";
import { MAX_ROLES } from "./resolve.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-react-review-"));
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
  return root;
}
const PKG = JSON.stringify({ name: "review", private: true, dependencies: { react: "^19.0.0" } });

describe("the React plugin on a hook named through a shadowing parameter", () => {
  let root: string;
  let graph: Graph;
  beforeAll(async () => {
    root = repo({
      "package.json": PKG,
      "src/hooks.ts": [
        'import { useState } from "react";',
        "// The parameter shadows React's useState: this calls whatever the caller passes.",
        "export function useShadowed(useState: (n: number) => number[]): number[] {",
        "  return useState(0);",
        "}",
        "export function useReal(): number {",
        "  const [n] = useState(0);",
        "  return n;",
        "}",
      ].join("\n"),
    });
    graph = await buildGraph({ repoRoot: root, store: null });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("calls a function a hook only when the hook it calls is React's at that place, not a parameter of the same name", () => {
    const hooks = (graph.frameworks?.roles ?? []).filter((r) => r.plugin === "react" && r.role === "hook").map((r) => r.target.replace(/@.*$/, ""));
    expect(hooks).toEqual(["src/hooks.ts#useReal"]);
  });
});

describe("the React plugin on tens of thousands of components", () => {
  let root: string;
  let quarter: string;
  let graph: Graph;
  // 12 files of `each` components.
  const components = (each: number): Record<string, string> => {
    const files: Record<string, string> = { "package.json": PKG };
    for (let f = 0; f < 12; f++) files[`src/c${f}.tsx`] = Array.from({ length: each }, (_, i) => `export function C${f}x${i}() {\n  return <i />;\n}`).join("\n");
    return files;
  };
  const build = (repoRoot: string) => () => buildGraph({ repoRoot, store: null, budgetMs: 120_000 });
  beforeAll(async () => {
    // 12 files of 1,900 components each: more components than roles the build keeps.
    root = repo(components(1900));
    quarter = repo(components(475));
    graph = await build(root)();
  }, 600_000);
  afterAll(() => {
    for (const dir of [root, quarter]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("keeps at most the build's roles and says how many were left out, so the stage never fails on its output", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "react");
    expect(run?.status).toBe("ok");
    const roles = (graph.frameworks?.roles ?? []).filter((r) => r.plugin === "react");
    expect(roles.length).toBe(MAX_ROLES);
    const cut = graph.frameworks?.unknowns.find((u) => u.plugin === "react" && u.note.includes(`${MAX_ROLES} roles`));
    expect(cut?.count).toBe(12 * 1900 - MAX_ROLES);
  });

  growthTests("in constant time", () => {
    it("finds each component's definition in constant time, so thousands of components in one file stay linear", async () => {
      expectLinear("the React plugin on files of 475 and of 1,900 components", await pluginCpuMs(build(quarter), "react"), await pluginCpuMs(build(root), "react"));
    }, 300_000);
  });
});
