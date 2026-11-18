// A router imported with CommonJS keeps its mount prefix, as an ES import does.
// Each case below is one exporter form met by one importer form. A shape the
// plugin cannot follow must leave an unknown, never a silent loss.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../../index.js";
import type { FrameworkUnknown, Graph, Registration } from "../../index.js";

const ROUTER = ["const express = require('express');", "const r = express.Router();", "r.get('/:id', (req, res) => res.json({ id: req.params.id }));"];
const app = (requires: string[], uses: string[]) => ["const express = require('express');", ...requires, "const app = express();", ...uses, "module.exports = app;"].join("\n");
const router = (...exp: string[]) => [...ROUTER, ...exp].join("\n");
const mount = (name = "users") => app([`const { ${name} } = require('./users');`], [`app.use('/users', ${name});`]);
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "cjs", private: true, dependencies: { express: "^4.21.2" } }),
  // module.exports = router, required whole
  "whole/users.js": router("module.exports = r;"),
  "whole/app.js": app(["const users = require('./users');"], ["app.use('/users', users);"]),
  // module.exports.users = router, destructured
  "member/users.js": router("module.exports.users = r;"),
  "member/app.js": mount(),
  // exports.users = router, destructured
  "short/users.js": router("exports.users = r;"),
  "short/app.js": mount(),
  // module.exports = { users: router }, destructured
  "object/users.js": router("module.exports = { users: r };"),
  "object/app.js": mount(),
  // module.exports = { users } of a local
  "shorthand/users.js": router("const users = r;", "module.exports = { users };"),
  "shorthand/app.js": mount(),
  // negative control: the required module exports a function, not a router
  "plain/helper.js": "module.exports = function helper(req, res, next) { next(); };",
  "plain/app.js": app(["const helper = require('./helper');"], ["app.use('/helper', helper);", "app.get('/own', helper);"]),
  // dynamic require: the module is chosen at run time
  "dynamic/app.js": app(["const name = process.env.ROUTES;", "const r = require(name);", "const r2 = require('./' + name);"], ["app.use('/a', r);", "app.use('/b', r2);"]),
  // the module read off the whole require: m.users
  "member2/users.js": router("exports.users = r;"),
  "member2/app.js": app(["const m = require('./users');"], ["app.use('/users', m.users);"]),
  // a directory required by its index file
  "dir/routes/index.js": router("module.exports = r;"),
  "dir/app.js": app(["const users = require('./routes');"], ["app.use('/users', users);"]),
  // a router re-exported through another module: not followed
  "chain/users.js": router("module.exports = r;"),
  "chain/index.js": "module.exports = require('./users');",
  "chain/app.js": app(["const users = require('./index');"], ["app.use('/users', users);"]),
  // a require written inside the mount, a name assigned twice
  "inline/users.js": router("module.exports = r;"),
  "inline/app.js": app([], ["app.use('/users', require('./users'));"]),
  "twice/app.js": app(["let r = require('./a');", "r = require('./b');"], ["app.use('/users', r);"]),
};

let root: string;
let graph: Graph;
const regs = (file: string): Registration[] => (graph.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "express" && e.site.file === file);
const gaps = (file: string): FrameworkUnknown[] => (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "express" && u.site?.file === file);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oq-express-cjs-"));
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

describe("the Express plugin on a router required with CommonJS", () => {
  const cases: [string, string][] = [
    ["module.exports = router, required whole", "whole"],
    ["module.exports.users = router, destructured", "member"],
    ["exports.users = router, destructured", "short"],
    ["module.exports = { users: router }, destructured", "object"],
    ["module.exports = { users } of a local, destructured", "shorthand"],
    ["module.exports.users = router, read as m.users", "member2"],
  ];
  for (const [name, dir] of cases) {
    it(`composes the mount prefix and marks the route mounted: ${name}`, () => {
      const [route, ...rest] = regs(`${dir}/users.js`);
      expect(rest).toEqual([]);
      expect(route?.pattern).toBe("/users/:id");
      expect(route?.mounted).toBe(true);
    });
  }

  it("composes the prefix for a directory required by its index file", () => {
    const [route] = regs("dir/routes/index.js");
    expect(route?.pattern).toBe("/users/:id");
    expect(route?.mounted).toBe(true);
  });

  it("does not read a required function as a router, and leaves its routes as they were", () => {
    expect(regs("plain/helper.js")).toEqual([]);
    expect(regs("plain/app.js").map((r) => r.pattern)).toEqual(["/own"]);
    expect(gaps("plain/app.js").filter((u) => u.affects.includes("mounts"))).toEqual([]);
  });

  it("says a mount of a module chosen at run time is not followed", () => {
    const at = gaps("dynamic/app.js").filter((u) => u.affects.includes("mounts"));
    expect(at.map((u) => u.site?.line).sort()).toEqual([6, 7]);
    expect(at.every((u) => u.cause === "dynamic")).toBe(true);
  });

  it.each([
    ["a router re-exported with module.exports = require(...)", "chain/app.js", [4]],
    ["a require written inside the mount call", "inline/app.js", [3]],
    ["a name assigned more than once", "twice/app.js", [5]],
  ])("says the mount is not followed for %s", (_name, file, lines) => {
    const at = gaps(file).filter((u) => u.affects.includes("mounts"));
    expect(at.map((u) => u.site?.line)).toEqual(lines);
    expect(regs(file.replace("app.js", "users.js")).every((r) => r.mounted === false)).toBe(true);
  });
});
