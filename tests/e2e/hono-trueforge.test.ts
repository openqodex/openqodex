// The Hono plugin on a real application. An open source TypeScript
// service on Hono and @hono/zod-openapi is pinned to a commit;
// a separate script (hono-truth.mjs) reads the routes its application
// serves with the TypeScript compiler's own name binding, and this test
// requires the graph to list exactly those routes for that application:
// the registration site, the method, the full path with each `{id}` served
// as `:id`, the path as written, and the handler's definition. A handler
// written in place is bound to the definition the graph makes for it at its
// own line. Where the handler is a call or a computed value, the graph must
// bind nothing and name an unknown at the site instead. Every route call the
// truth lists must belong to the application, never to an orphan router, so
// a missing mount cannot hide behind a relative path.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../../packages/graph/src/index.js";
import { pinnedClone } from "./pinned-clone.js";
import { cacheFolder, removeTempDirs } from "../temp-dirs.mjs";
// @ts-expect-error: a plain script with no type declarations
import { honoTruth } from "./hono-truth.mjs";

afterAll(removeTempDirs);

const REPO = { name: "trueforge", url: "https://github.com/truefoundry/trueforge.git", sha: "033a3c1d1277c876b4c6b30f759d6a3dbe3c092a" };
const CLONES = cacheFolder("openqodex-graph-acceptance");

// A shallow clone of exactly the pinned commit, reused when it is already
// there (the same helper as graph.test.ts, same cache folder).
function clone(): string {
  return pinnedClone(join(CLONES, REPO.name), REPO.url, REPO.sha);
}

type TruthRoute = { site: string; method: string; path: string; written: string; handler: string; app: string };

describe.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")("Hono routes on trueforge", () => {
  it(`trueforge at ${REPO.sha.slice(0, 12)}: the application's routes match the compiler's truth exactly`, async () => {
    const dir = clone();
    const truth = honoTruth(dir) as { app: string; routes: TruthRoute[]; unread: unknown[] };
    // The truth reads everything on the way; a shape it cannot read would
    // make the comparison weaker, so it fails here first.
    expect(truth.unread).toEqual([]);
    expect(truth.routes.length).toBe(85);

    // No store: other tests share this clone and its graph folder, and the
    // answer must come from this build's own reading of the files.
    const g = await buildGraph({ repoRoot: dir, store: null, budgetMs: 120_000, maxFiles: 100_000 });
    const fw = g.frameworks;
    if (!fw) throw new Error("the build has no framework layer");
    const app = `fw:hono:app:${truth.app}`;
    expect(fw.apps.filter((a) => a.plugin === "hono").map((a) => a.id)).toContain(app);

    const handles = new Map<string, string[]>();
    for (const e of fw.edges) if (e.kind === "handles" && e.plugin === "hono") (handles.get(e.from) ?? handles.set(e.from, []).get(e.from))?.push(e.to);
    const unknownAt = new Set(fw.unknowns.filter((u) => u.plugin === "hono" && u.site && u.affects.includes("handles")).map((u) => `${u.site?.file}:${u.site?.line}`));
    const at = (id: string) => {
      const n = g.nodes.get(id);
      return n ? `${n.file}:${n.startLine}` : `missing node ${id}`;
    };
    const seen = fw.entities
      .filter((r) => r.kind === "registration" && r.plugin === "hono" && r.app === app)
      .map((r) => {
        const site = `${r.site.file}:${r.site.line}`;
        const to = handles.get(r.id) ?? [];
        const handler = to.length === 1 ? at(to[0] as string) : to.length === 0 && unknownAt.has(site) ? "unbound, with an unknown" : `bound to ${to.length}`;
        return { site, method: r.methods.join(","), path: r.pattern, written: r.written, handler };
      });
    const expected = truth.routes.map((t) => ({
      site: t.site,
      method: t.method,
      path: t.path,
      written: t.written,
      handler: /:\d+$/.test(t.handler) ? t.handler : "unbound, with an unknown",
    }));
    const order = (a: { site: string; path: string | null }, b: { site: string; path: string | null }) => a.site.localeCompare(b.site) || String(a.path).localeCompare(String(b.path));
    expect(seen.sort(order)).toEqual(expected.sort(order));

    // No route call the truth lists is left on an orphan router.
    const sites = new Set(truth.routes.map((t) => t.site));
    const orphans = fw.entities.filter((r) => r.kind === "registration" && r.plugin === "hono" && r.app === null && sites.has(`${r.site.file}:${r.site.line}`));
    expect(orphans.map((r) => `${r.site.file}:${r.site.line}`)).toEqual([]);
  });
});
