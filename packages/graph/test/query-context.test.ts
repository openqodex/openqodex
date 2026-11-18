// Source lines around an answer's sites (`context`) and the compact form
// of its items (`compact`). Ways it could fail, written before the code:
// 1. The lines come from the work tree when the build is pinned, so they
//    disagree with the line numbers the answer gives after an edit, and
//    nothing says the file changed since.
// 2. A key written in the repository reaches the agent in a line.
// 3. A minified line of a megabyte comes back whole.
// 4. Sites inside impact hops, search leads and the target get no lines,
//    or one place gets its lines twice.
// 5. The compact form changes the list a cursor pages (the kept items are
//    the same objects), or drops what names a site: its file, line and tier.
// 6. `context: 0` or no shape changes the answer at all.
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Item, Session } from "../src/query/engine.js";
import { MAX_CONTEXT, shapeAnswer } from "../src/query/context.js";
import type { Shaped } from "../src/query/context.js";
import { commitAll, git, makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const files = {
  "core.ts": "export function core(): number {\n  return 1;\n}\n",
  "use.ts": `import { core } from "./core";\nexport function use(): number {\n  const key = "ghp_abcdefghijklmnopqrstuvwx1234";\n  return core();\n}\nexport const long = "${"x".repeat(2000)}";\n`,
  "deep.ts": 'import { use } from "./use";\nexport function deep(): number {\n  return use();\n}\n',
};

// A session on the committed tree, as a pinned build holds its capture.
async function session(withTree: boolean): Promise<{ root: string; s: Session }> {
  const root = makeRepo(files);
  commitAll(root);
  const graph = await buildGraph({ repoRoot: root, store: null });
  const treeSha = withTree ? git(root, "rev-parse", "HEAD^{tree}").trim() : null;
  return { root, s: { graph, generation: "test-build", treeSha, builtAt: null, laterEditsKnown: false } };
}

describe("context lines", () => {
  it("reads the build's lines, says when the work tree differs, and redacts keys (1, 2)", async () => {
    const { root, s } = await session(true);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" } });
    const before = (await shapeAnswer(a, s, { repoRoot: root, context: 1 })) as Shaped;
    const at = before.context?.snippets.find((x) => x.file === "use.ts");
    expect(at).toMatchObject({ file: "use.ts", line: 4, start: 3, from: "build", changedSince: false });
    expect(at?.lines[1]).toBe("  return core();");
    expect(at?.lines[0]).toMatch(/^ {2}const key = "\[redacted:[0-9a-f]{8}\]";$/);
    expect(JSON.stringify(before)).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234");
    // An edit after the build: the build's lines stay, and the snippet says so.
    writeFileSync(join(root, "use.ts"), `// moved down\n${files["use.ts"]}`);
    const after = (await shapeAnswer(a, s, { repoRoot: root, context: 1 })) as Shaped;
    const moved = after.context?.snippets.find((x) => x.file === "use.ts");
    expect(moved?.lines).toEqual(at?.lines);
    expect(moved).toMatchObject({ from: "build", changedSince: true });
  });

  it("reads the work tree when the build kept no capture, and cannot say whether it changed (1)", async () => {
    const { root, s } = await session(false);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" } });
    const out = (await shapeAnswer(a, s, { repoRoot: root, context: 2 })) as Shaped;
    expect(out.context?.snippets.find((x) => x.file === "use.ts")).toMatchObject({ from: "work-tree", changedSince: null, start: 2 });
  });

  it("cuts a long line and caps the lines asked (3)", async () => {
    const { root, s } = await session(true);
    const a = query(s, { apiVersion: 1, kind: "outline", target: { file: "use.ts" } });
    const out = (await shapeAnswer(a, s, { repoRoot: root, context: 99 })) as Shaped;
    expect(out.context?.around).toBe(MAX_CONTEXT);
    const long = out.context?.snippets.flatMap((x) => x.lines).find((l) => l.startsWith("export const long"));
    expect(long?.length).toBeLessThan(500);
    expect(long).toMatch(/\[cut\]$/);
  });

  it("gives lines for impact hops, search leads and the target, each place once (4)", async () => {
    const { root, s } = await session(true);
    const impact = query(s, { apiVersion: 1, kind: "impact", target: { name: "core" } });
    const i = (await shapeAnswer(impact, s, { repoRoot: root, context: 1 })) as Shaped;
    const places = i.context?.snippets.map((x) => `${x.file}:${x.line}`) ?? [];
    expect(places).toContain("use.ts:4");
    expect(places).toContain("deep.ts:3");
    expect(new Set(places).size).toBe(places.length);
    const search = query(s, { apiVersion: 1, kind: "search", text: "deep" });
    const found = (await shapeAnswer(search, s, { repoRoot: root, context: 1 })) as Shaped;
    expect(found.context?.snippets.map((x) => `${x.file}:${x.line}`)).toContain("deep.ts:2");
  });
});

describe("the compact form", () => {
  it("drops edge ids, columns, rules and import lines from items and hops, and nothing else (5)", async () => {
    const { root, s } = await session(true);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" } });
    const kept = JSON.stringify(a);
    const c = await shapeAnswer(a, s, { repoRoot: root, compact: true });
    expect(JSON.stringify(a)).toBe(kept);
    const item = c.items[0] as Record<string, unknown> & { site: Record<string, unknown> };
    expect(item).not.toHaveProperty("edge");
    expect(item.site).not.toHaveProperty("column");
    expect(item.site).not.toHaveProperty("via");
    expect(item.site).not.toHaveProperty("rule");
    const full = a.items[0] as Item;
    expect(item).toMatchObject({ from: full.from, to: full.to, kind: full.kind, fromName: full.fromName, site: { file: full.site.file, line: full.site.line, tier: full.site.tier, evidence: full.site.evidence } });
    expect(c.counts).toEqual(a.counts);
    const impact = query(s, { apiVersion: 1, kind: "impact", target: { name: "core" } });
    const ci = await shapeAnswer(impact, s, { repoRoot: root, compact: true });
    const hops = (ci.items as { hops?: Record<string, unknown>[] }[]).flatMap((x) => x.hops ?? []);
    expect(hops.length).toBeGreaterThan(0);
    for (const h of hops) expect(h).not.toHaveProperty("edge");
    expect(JSON.stringify(ci).length).toBeLessThan(JSON.stringify(impact).length);
  });

  it("leaves the answer as it is with no shape or `context: 0` (6)", async () => {
    const { root, s } = await session(true);
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" } });
    expect(JSON.stringify(await shapeAnswer(a, s, { repoRoot: root }))).toBe(JSON.stringify(a));
    expect(JSON.stringify(await shapeAnswer(a, s, { repoRoot: root, context: 0, compact: false }))).toBe(JSON.stringify(a));
  });
});

// A Hono app with a route and its handler, and a React test beside a
// plain test that calls the same function (the shapes the review of query
// answers raised: nested handles, evidence sites, many leads, encoded keys).
const HONO_FILES = {
  "package.json": '{"name":"hono-demo","version":"1.0.0","dependencies":{"hono":"^4.0.0"}}\n',
  "src/app.ts": "import { Hono } from 'hono';\nimport { users } from './users';\nconst app = new Hono();\napp.get('/healthz', c => c.text('ok'));\napp.route('/api/v1/users', users);\nexport default app;\n",
  "src/users.ts": "import { Hono } from 'hono';\nimport { getUser } from './handlers';\nexport const users = new Hono();\nusers.get('/:id', getUser);\nusers.post('/', c => c.json({}));\n",
  "src/handlers.ts": "export function getUser(c: { json(v: unknown): unknown }) {\n  return c.json({});\n}\n",
};

async function honoSession(): Promise<{ root: string; s: Session }> {
  const root = makeRepo(HONO_FILES);
  commitAll(root);
  const graph = await buildGraph({ repoRoot: root, store: null });
  return { root, s: { graph, generation: "test-build", treeSha: null, builtAt: null, laterEditsKnown: false } };
}

describe("nested sites in framework answers (2, 3)", () => {
  it("compacts the handles of a route answer like any other item (2)", async () => {
    const { root, s } = await honoSession();
    const a = query(s, { apiVersion: 1, kind: "routes" });
    const withHandles = (a.items as { handles: unknown[] }[]).filter((r) => r.handles.length > 0);
    expect(withHandles.length).toBeGreaterThan(0);
    const c = await shapeAnswer(a, s, { repoRoot: root, compact: true });
    for (const r of c.items as { handles: Record<string, unknown>[] }[]) {
      for (const h of r.handles) {
        expect(h).not.toHaveProperty("edge");
        expect(h.site).not.toHaveProperty("column");
        expect(h.site).not.toHaveProperty("via");
        expect(h.site).not.toHaveProperty("rule");
      }
    }
  }, 60_000);

  it("gives lines for the site of an explained framework edge and for route handle sites (3)", async () => {
    const { root, s } = await honoSession();
    const routes = query(s, { apiVersion: 1, kind: "routes" });
    const handles = (routes.items as { handles: { edge: string; site: { file: string; line: number } }[] }[]).flatMap((r) => r.handles);
    expect(handles.length).toBeGreaterThan(0);
    const shaped = (await shapeAnswer(routes, s, { repoRoot: root, context: 0 })) as Shaped;
    expect(shaped.context).toBeUndefined();
    const withLines = (await shapeAnswer(routes, s, { repoRoot: root, context: 1 })) as Shaped;
    const at = withLines.context?.snippets.map((x) => `${x.file}:${x.line}`) ?? [];
    for (const h of handles) expect(at).toContain(`${h.site.file}:${h.site.line}`);
    const explained = query(s, { apiVersion: 1, kind: "explain", target: { id: (handles[0] as { edge: string }).edge } });
    const site = (explained.items[0] as { evidence?: { site: { file: string; line: number } } }).evidence?.site;
    expect(site).toBeDefined();
    const e = (await shapeAnswer(explained, s, { repoRoot: root, context: 1 })) as Shaped;
    expect(e.context?.snippets.map((x) => `${x.file}:${x.line}`)).toContain(`${site?.file}:${site?.line}`);
  }, 60_000);
});

describe("an encoded key in a context line (4)", () => {
  it("redacts the whole line when its percent-decoded form holds a key", async () => {
    const root = makeRepo({
      "core.ts": "export function core(): number {\n  return 1;\n}\n",
      "use.ts": 'import { core } from "./core";\nexport function use(): number {\n  const u = "https://x.test/?t=ghp%5Fabcdefghijklmnopqrstuvwx";\n  return core();\n}\n',
    });
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const s: Session = { graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false };
    const a = query(s, { apiVersion: 1, kind: "callers", target: { name: "core" } });
    const out = (await shapeAnswer(a, s, { repoRoot: root, context: 1 })) as Shaped;
    const text = JSON.stringify(out);
    expect(text).not.toContain("ghp%5F");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwx");
    const lines = out.context?.snippets.find((x) => x.file === "use.ts")?.lines ?? [];
    expect(lines.some((l) => /^\[redacted:[0-9a-f]{8}\]$/.test(l))).toBe(true);
    expect(lines).toContain("  return core();");
  });
});
