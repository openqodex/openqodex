// A file's project is chosen among the roots of its own language family
// (issue #354). Ways it could fail, written before the code:
//  1. One .py file in src/scripts/ makes `src` a Python root, and every
//     TypeScript file under src/ takes it as its project, so the Express
//     reader sees no express dependency and reads no route.
//  2. The fix over-corrects and the .py file itself leaves its Python root.
//  3. A Go or Java file takes an npm root.
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph, openStore } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { commitAll, makeHome, makeRepo } from "./helpers.js";

const files: Record<string, string> = {
  "pkg/package.json": JSON.stringify({ name: "pkg", private: true, dependencies: { express: "^4.21.2" } }),
  "pkg/src/app.ts": `import express from "express";
export const app = express();
app.get("/health", (req, res) => {
  res.end();
});
`,
  "pkg/src/scripts/run.py": "print('hi')\n",
  "pkg/src/scripts/run.pyi": "",
  "svc/go.mod": "module example.com/svc\n\ngo 1.22\n",
  "svc/web/index.ts": "export const x = 1;\n",
  "svc/main.go": "package main\n\nfunc main() {}\n",
};

describe("projectFolder keeps to the file's own language (#354)", () => {
  let root: string;
  let home: string;
  let graph: Graph;
  beforeAll(async () => {
    root = makeRepo(files);
    home = makeHome();
    commitAll(root);
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    graph = await buildGraph({ repoRoot: root, store: opened.store, mode: "retained" });
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("gives a TypeScript file its npm project, not the Python root below it", () => {
    expect(graph.projectOf("pkg/src/app.ts")).toBe("pkg");
  });

  it("reads the Express route in that file", () => {
    const patterns = (graph.frameworks?.entities ?? [])
      .filter((e): e is Registration => e.kind === "registration" && e.plugin === "express")
      .map((r) => r.pattern);
    expect(patterns).toContain("/health");
  });

  it("negative control: the .py and .pyi files still belong to their Python root", () => {
    expect(graph.projectOf("pkg/src/scripts/run.py")).toBe("pkg/src");
    expect(graph.projectOf("pkg/src/scripts/run.pyi")).toBe("pkg/src");
  });

  it("negative control: a Go file keeps its module and a TypeScript file below it falls back to it", () => {
    expect(graph.projectOf("svc/main.go")).toBe("svc");
    expect(graph.projectOf("svc/web/index.ts")).toBe("svc");
  });
});
