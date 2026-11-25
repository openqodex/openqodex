// What the graph and its framework plugins state as certain, or as served,
// must rest on what they read. Ways it could fail, written before the code:
//  1. The per-file fact cap drops a file's scope records, and a name whose
//     scope is missing is read as the module's: a parameter named like the
//     module's application becomes it, and its route a certain one.
//  2. A base written as an expression is left out of the lookup order, so a
//     method found past it is bound as certain though the unknown base may
//     define it first.
//  3. The brief says a route has "no handler now" when its handler is only
//     wrapped, computed or ambiguous.
//  4. The Django field ancestry walk is neither budgeted nor remembered, so
//     a lattice of field classes takes exponential time.
//  5. A Django URL list a later statement replaces still serves the router
//     joined into it; a list joined by `+` is read at its final state, with
//     items appended after the join; an item written by index leaves the old
//     route served with no gap.
//  6. A registration's path loses its own text ("#" read as a fragment), so
//     a request matches a route it cannot reach.
//  7. A relative test client request is joined to "/" though the client's
//     base URL names another path (#81).
import { getChange } from "@openqodex/core";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, detectImpact, renderImpactBlock } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { expectLinear, growthTests, stageCpuMs } from "../src/test-timing.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

async function built(files: Record<string, string>): Promise<Graph> {
  const root = makeRepo(files);
  return buildGraph({ repoRoot: root, store: null, budgetMs: 60_000 });
}
const regs = (g: Graph, plugin: string): Registration[] => (g.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === plugin);
const EXPRESS_PKG = JSON.stringify({ name: "js", private: true, type: "module", dependencies: { express: "^4.21.2" } });
const DJANGO = {
  "requirements.txt": "Django==5.0\ndjangorestframework==3.15\n",
  "manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
  "mysite/__init__.py": "",
  "mysite/settings.py": 'INSTALLED_APPS = ["mysite"]\nROOT_URLCONF = "mysite.urls"\n',
};

describe("what the graph states as certain or served", () => {
  it("never reads a parameter as the module's application when the fact cap dropped the scope records (1)", async () => {
    const filler = Array.from({ length: 2100 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const g = await built({
      "package.json": EXPRESS_PKG,
      "src/server.js": `import express from "express";\nexport const app = express();\nfunction h(req, res) {\n  res.end();\n}\nexport function register(app) {\n  app.get("/fake", h);\n}\n${filler}\n`,
    });
    const fake = regs(g, "express").filter((r) => r.written === "/fake" && r.app !== null);
    expect(fake).toEqual([]);
  }, 60_000);

  it("never binds a method as certain past a base written as an expression (2)", async () => {
    const g = await built({
      "app/__init__.py": "",
      "app/m.py": "class A:\n    def run(self):\n        return 1\n\n\nclass B:\n    def run(self):\n        return 2\n\n\ndef make(x):\n    return x\n\n\nclass Child(make(A), B):\n    pass\n\n\ndef use():\n    return Child().run()\n",
    });
    const edges = (g.in.get([...g.nodes.keys()].find((id) => id.includes("app/m.py#B.run@")) as string) ?? []).filter((e) => e.kind === "calls");
    const tiers = edges.flatMap((e) => e.sites.map((s) => s.tier));
    expect(tiers).not.toContain("certain");
  }, 60_000);

  it("says no handler now only for a handler that is missing (3)", async () => {
    const root = makeRepo({
      "package.json": EXPRESS_PKG,
      "src/server.js": 'import express from "express";\nimport { h } from "./h.js";\n\nexport const app = express();\n',
      "src/h.js": "export function h(req, res) {\n  res.end();\n}\n",
    });
    commitAll(root);
    writeFiles(root, { "src/server.js": 'import express from "express";\nimport { h } from "./h.js";\nimport { asyncHandler } from "./wrap.js";\n\nexport const app = express();\napp.get("/x", asyncHandler(h));\n', "src/wrap.js": "export function asyncHandler(f) {\n  return f;\n}\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const route = impact.frameworks?.routes.find((r) => r.site.file === "src/server.js" && r.site.line === 6);
    expect(route).toBeDefined();
    expect(route?.status).not.toBe("missing");
    const row = renderImpactBlock(impact).split("\n").find((l) => l.startsWith("| `GET /x`"));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/no handler now/);
  }, 60_000);

  // Nine layers of `width` classes, each inheriting every class of the layer
  // below: twelve wide is 12^8 paths to the depth cut, six wide a quarter of
  // the bases and 1/256 of the paths.
  const lattice = (width: number) => {
    const layers: string[] = ["class L0_0(models.IntegerField):\n    pass\n"];
    for (let l = 1; l <= 9; l++) {
      const prev = l === 1 ? ["L0_0"] : Array.from({ length: width }, (_, i) => `L${l - 1}_${i}`);
      for (let i = 0; i < width; i++) layers.push(`class L${l}_${i}(${prev.join(", ")}):\n    pass\n`);
    }
    return { ...DJANGO, "mysite/models.py": `from django.db import models\n\n\n${layers.join("\n\n")}\n\nclass Thing(models.Model):\n    value = L9_0()\n` };
  };

  growthTests("in time that grows with the lattice", () => {
    it("walks a lattice of Django field classes in time that grows with its bases, not its paths (4)", async () => {
      const build = (files: Record<string, string>) => {
        const root = makeRepo(files);
        return () => buildGraph({ repoRoot: root, store: null, budgetMs: 60_000 });
      };
      expectLinear("the frameworks stage on lattices six and twelve classes wide", await stageCpuMs(build(lattice(6)), "frameworks"), await stageCpuMs(build(lattice(12)), "frameworks"));
    }, 120_000);
  });

  it("walks a lattice of Django field classes within its budget (4)", async () => {
    const g = await built(lattice(12));
    expect((g.frameworks?.plugins ?? []).find((p) => p.id === "django")?.status).toBe("ok");
    expect((g.frameworks?.unknowns ?? []).some((u) => u.plugin === "django" && u.affects.includes("declares_field"))).toBe(true);
  }, 120_000);

  it("serves no router a later replacement of urlpatterns drops, no item appended after a join, and says an item written by index (5)", async () => {
    const g = await built({
      ...DJANGO,
      "mysite/views.py": "from rest_framework import viewsets\n\n\nclass ItemViewSet(viewsets.ModelViewSet):\n    pass\n\n\ndef old(request):\n    return None\n\n\ndef late(request):\n    return None\n\n\ndef new(request):\n    return None\n",
      "mysite/urls.py": 'from django.urls import path\nfrom rest_framework.routers import DefaultRouter\n\nfrom mysite import views\n\nrouter = DefaultRouter()\nrouter.register("items", views.ItemViewSet)\nurlpatterns = router.urls\nextra = [path("old/", views.old)]\nurlpatterns = [] + extra\nextra.append(path("late/", views.late))\nurlpatterns[0] = path("new/", views.new)\n',
    });
    const served = regs(g, "django").filter((r) => r.mounted);
    expect(served.filter((r) => (r.pattern ?? r.written ?? "").includes("items"))).toEqual([]);
    expect(served.filter((r) => r.written === "late/")).toEqual([]);
    expect((g.frameworks?.unknowns ?? []).some((u) => u.plugin === "django" && u.cause === "dynamic" && u.site?.file === "mysite/urls.py" && u.site.line === 12)).toBe(true);
  }, 60_000);

  it("keeps a FastAPI registration path as written, and joins a relative request to the client's base path (6, 7)", async () => {
    const g = await built({
      "pyproject.toml": '[project]\nname = "py"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n',
      "app/__init__.py": "",
      "app/main.py": 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/a#b")\ndef ab():\n    return 1\n\n\n@app.get("/items")\ndef items():\n    return []\n\n\n@app.get("/api/items")\ndef api_items():\n    return []\n',
      "app/test_main.py": 'import os\n\nfrom fastapi.testclient import TestClient\n\nfrom app.main import app\n\n\ndef test_it():\n    client = TestClient(app, base_url="http://testserver/api/")\n    client.get("items")\n    TestClient(app).get("/a")\n    other = TestClient(app, base_url=os.environ["BASE"])\n    other.get("items")\n',
    });
    const reg = (pattern: string) => regs(g, "fastapi").find((r) => r.pattern === pattern);
    expect(reg("/a#b")).toBeDefined();
    const links = (g.frameworks?.edges ?? []).filter((e) => e.kind === "tests" && e.plugin === "fastapi");
    const to = (line: number) => links.filter((e) => e.evidence.site.line === line).map((e) => e.to);
    expect(to(10)).toEqual([reg("/api/items")?.id]);
    expect(to(11)).toEqual([]);
    expect(to(13)).toEqual([]);
    expect((g.frameworks?.unknowns ?? []).some((u) => u.plugin === "fastapi" && u.site?.line === 13 && u.cause === "dynamic")).toBe(true);
  }, 60_000);
});
