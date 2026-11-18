// The Express plugin reads what a CommonJS file exports. Way it could fail,
// written before the code: once `module.exports = ...` replaces the exports
// object, `exports.x = r` changes only the old object that nothing
// requires, yet the plugin took it as the export and mounted a router the
// real `require` never reaches. A write through `module.exports.x` still
// lands on the new object and must keep counting.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Item } from "../src/query/engine.js";
import { commitAll, makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const app = ["const express = require('express');", "const app = express();", "app.use('/users', require('./users').router);", "module.exports = app;"].join("\n");
const users = (tail: string[]) => ["const express = require('express');", "const router = express.Router();", "function getUser(req, res) { res.json({}); }", "router.get('/:id', getUser);", ...tail].join("\n");

async function routes(tail: string[]) {
  const root = makeRepo({ "package.json": '{"name":"x","version":"1.0.0","dependencies":{"express":"^4.0.0"}}\n', "src/app.js": app, "src/users.js": users(tail) });
  commitAll(root);
  const graph = await buildGraph({ repoRoot: root, store: null });
  return query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "routes", limit: 50 });
}
const mounted = (a: { items: unknown[] }) => (a.items as (Item & { pattern?: string })[]).map((i) => i.pattern);

describe("what a CommonJS file exports after module.exports is replaced", () => {
  it("control: exports.router alone is the export, so the route is mounted under /users", async () => {
    expect(mounted(await routes(["exports.router = router;"]))).toContain("/users/:id");
  });
  it("control: module.exports.router after the replacement lands on the new object", async () => {
    expect(mounted(await routes(["module.exports = { other: 1 };", "module.exports.router = router;"]))).toContain("/users/:id");
  });
  it("exports.router written after module.exports is replaced is not the export", async () => {
    const a = await routes(["module.exports = { other: 1 };", "exports.router = router;"]);
    expect(mounted(a)).not.toContain("/users/:id");
  });
});
