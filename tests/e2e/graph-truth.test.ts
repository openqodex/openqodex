// The graph's TypeScript callers against the TypeScript checker, on a large
// public repo pinned to a commit. The failure it guards: the graph names a
// wrong caller as certain, or misses real callers an editor finds, and no
// hand-picked list shows it. The checker (TypeScript 5.9, no installed
// dependencies) resolves every call in the measured folders to its
// declaration; each call whose declaration is a function or a method of
// the repo is a truth site. The graph's outcome at each truth site is
// certain-correct, likely-correct, possible-correct (the target among the
// candidates), wrong-target, unbound (an unknown recorded) or absent (no
// edge and no unknown). A call the checker binds to an interface member is
// correct when the graph binds it to that member; the possible edges to the
// implementations are counted as candidate burden. The full table is
// printed; OPENQODEX_TRUTH_OUT=<file> also writes every scored site.
//
// The thresholds below are set by the owner, not by this test's author:
// (a) no certain edge into a wrong target, anywhere in the measured files;
// (b) the held-out sites must be found (expected to fail today, so each is
//     an `it.fails`: fixing it turns the test red until the marker goes);
// (c) production recall of certain plus likely edges, and the candidate
//     burden, are today's baseline: recall may not drop below it; burden
//     is printed against it (a call newly bound through an interface adds
//     possible edges by design, so a rise is not a failure).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph, openStore, query } from "../../packages/graph/src/index.js";
import type { Graph, Item, Session } from "../../packages/graph/src/index.js";
import { checkCertain, compilerTruth, OUTCOMES, SHAPES, score } from "./caller-truth.js";
import type { CertainCheck, Scored, Truth } from "./caller-truth.js";
import { cacheFolder, removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

const REPO = {
  name: "trueforge",
  url: "https://github.com/truefoundry/trueforge.git",
  sha: "033a3c1d1277c876b4c6b30f759d6a3dbe3c092a",
  scope: ["packages/trueforge", "packages/trueforge-core"],
  // The workspace packages as their `trueforge-dev` export condition maps
  // them (no node_modules: the repo's dependencies are not installed).
  paths: {
    "@truefoundry/trueforge-core": ["packages/trueforge-core/src/index.ts"],
    "@truefoundry/trueforge-core/*": ["packages/trueforge-core/src/*", "packages/trueforge-core/src/*/index.ts"],
    "@truefoundry/trueforge-sdk": ["packages/trueforge-sdk/src/index.ts"],
  },
};

// (a) Owner's threshold: certain edges into a target the checker does not name.
const MAX_WRONG_CERTAIN = 0;
// (c) Owner's baseline, recorded on 0a67e51f (tf-graph before any fix):
// production truth sites found certain or likely, of all production truth sites.
const BASELINE_PROD_RECALL = { found: 3617, of: 4021 };
// (c) Owner's baseline: possible edges at production truth sites into a
// target the checker does not name.
const BASELINE_PROD_BURDEN = 548;
// (b) Owner's held-out sites: each must resolve, by the checker, to the named
// declaration, and the graph must find it certain or likely.
const HELD_OUT = [
  { site: "packages/trueforge/src/apis/sessions.ts:563", name: "create", target: "Sessions.create" },
  { site: "packages/trueforge/src/apis/turns.ts:536", name: "stream", target: "TurnHandle.stream" },
  { site: "packages/trueforge-core/src/agent-session/SessionHandle.ts:415", name: "resolveAgentDefinition", target: "ITurnResourceResolver.resolveAgentDefinition", implementer: "TurnResourceResolver.resolveAgentDefinition" },
  { site: "packages/trueforge-core/src/agent-session/SessionHandle.ts:507", name: "resolveAgentDefinition", target: "ITurnResourceResolver.resolveAgentDefinition", implementer: "TurnResourceResolver.resolveAgentDefinition" },
];
const HELD_OUT_PATH = { from: "createSessionsRouter", to: "Sessions.create", site: "packages/trueforge/src/apis/sessions.ts:563" };

const CLONES = cacheFolder("openqodex-graph-acceptance");

// A shallow clone of exactly `sha`, reused when it is already there.
function clone(): string {
  const dir = join(CLONES, REPO.name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  if (existsSync(join(dir, ".git")) && git("rev-parse", "HEAD").trim() === REPO.sha) return dir;
  mkdirSync(dir, { recursive: true });
  git("init", "-q");
  git("fetch", "-q", "--depth", "1", REPO.url, REPO.sha);
  git("checkout", "-q", "--force", REPO.sha);
  return dir;
}

const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`);

// One row per group: the outcome counts, recall (certain plus likely) and burden.
function table(title: string, rows: Scored[], groupOf: (r: Scored) => string, order: readonly string[]): string[] {
  const groups = new Map<string, Scored[]>();
  for (const r of rows) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  const names = [...order.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !order.includes(g)).sort()];
  const head = ["group".padEnd(30), "sites".padStart(6), ...OUTCOMES.map((o) => o.padStart(o.length + 1)), "recall".padStart(8), "burden".padStart(7)].join("");
  const line = (g: string, rs: Scored[]) => {
    const n = (o: string) => rs.filter((r) => r.outcome === o).length;
    const found = n("certain-correct") + n("likely-correct");
    return [g.padEnd(30), String(rs.length).padStart(6), ...OUTCOMES.map((o) => String(n(o)).padStart(o.length + 1)), pct(found, rs.length).padStart(8), String(rs.reduce((s, r) => s + r.burden, 0)).padStart(7)].join("");
  };
  return [`${title}`, head, ...names.map((g) => line(g, groups.get(g) as Scored[])), line("all", rows)];
}

describe.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")(`callers against the TypeScript checker on ${REPO.name} at ${REPO.sha.slice(0, 12)}`, () => {
  let dir: string;
  let graph: Graph;
  let truth: Truth;
  let scored: Scored[];
  let certain: CertainCheck[];
  const sitesAt = (site: string, name: string) => scored.filter((r) => `${r.file}:${r.line}` === site && r.name === name);

  beforeAll(async () => {
    dir = clone();
    const opened = await openStore(dir, { home: tempDir("oq-e2e-truth-home-") });
    if (!opened.ok) throw new Error(opened.reason);
    // A partial graph would score as misses: the budget is wide (a loaded
    // machine parses slowly), and anything short of a whole build stops here.
    graph = await buildGraph({ repoRoot: dir, store: opened.store, budgetMs: 900_000, maxFiles: 100_000 });
    if (graph.status.status !== "ok") throw new Error(`the graph of ${REPO.name} is partial: ${graph.status.reasons.join("; ")}`);
    truth = compilerTruth({ root: dir, scope: REPO.scope, paths: REPO.paths });
    // Calls into the repo's functions and methods; calls of other values
    // of function type (parameters, variables) are printed apart.
    const all = score(graph, truth);
    scored = all.filter((r) => r.targets.some((t) => t.kind !== "callable property"));
    certain = checkCertain(graph, truth);
    const prod = scored.filter((r) => !r.test);
    const tests = scored.filter((r) => r.test);
    const unbound = (rs: Scored[]) => rs.filter((r) => r.outcome === "unbound");
    const verdicts = (v: CertainCheck["verdict"]) => certain.filter((c) => c.verdict === v).length;
    const others = all.filter((r) => r.resolved === "repo" && !scored.includes(r));
    // The problem report's count: calls through a dot into a repo member
    // (methods and properties), production meaning outside a tests folder,
    // and "unbound" meaning any unknown row at the site. A call bound
    // through an interface also leaves an unknown row (the interface may be
    // any object of its shape), so that count read bound calls as unbound.
    const reportCount = all.filter((r) => r.resolved === "repo" && r.shape !== "bare call" && r.targets.some((t) => t.kind !== "function") && !/\/tests?\//.test(r.file));
    const withRow = reportCount.filter((r) => r.cause !== null);
    const lines = [
      `${REPO.name} ${REPO.sha}: graph ${graph.status.filesParsed} files in ${graph.status.durationMs} ms (${Object.entries(graph.status.stages).map(([k, v]) => `${k} ${v}`).join(", ")}); checker ${truth.files.length} files in ${truth.ms} ms, ${truth.unresolvedImports} relative imports it could not resolve`,
      `calls the checker read: ${truth.calls.length}; into repo functions and methods: ${scored.length} (production ${prod.length}, test ${tests.length}); into other repo values of function type (parameters, variables): ${others.length}; outside the repo: ${truth.calls.filter((c) => c.resolved === "external").length}; not resolved: ${truth.calls.filter((c) => c.resolved === "none").length}`,
      `truth targets with no graph node: ${scored.filter((r) => !r.inGraph).length}`,
      `the problem report's count: ${reportCount.length} calls, ${withRow.length} with an unknown row at the site, of which ${withRow.filter((r) => r.outcome.endsWith("-correct")).length} are bound to the right target`,
      "",
      ...table("production, by receiver shape", prod, (r) => r.shape, SHAPES),
      "",
      ...table("test, by receiver shape", tests, (r) => r.shape, SHAPES),
      "",
      ...table("production unbound, by unknown cause", unbound(prod), (r) => r.cause ?? "none", []),
      "",
      ...table("test unbound, by unknown cause", unbound(tests), (r) => r.cause ?? "none", []),
      "",
      ...table("production, by target kind", prod, (r) => r.targets[0]?.kind ?? "?", []),
      "",
      `certain call edges in the measured files: ${certain.length}; agree ${verdicts("agree")}, wrong ${verdicts("wrong")}, checker could not resolve ${verdicts("unverifiable")}, no such call ${verdicts("no-call")}`,
      ...certain.filter((c) => c.verdict === "wrong").slice(0, 20).map((c) => `  wrong: ${c.site} -> ${c.to}`),
    ];
    process.stderr.write(`${lines.join("\n")}\n`);
    if (process.env.OPENQODEX_TRUTH_OUT) writeFileSync(process.env.OPENQODEX_TRUTH_OUT, JSON.stringify({ scored: all, certain }, null, 1));
  }, 1_200_000);

  it("names no certain edge into a target the checker does not name (owner's threshold a)", () => {
    const wrong = [...certain.filter((c) => c.verdict === "wrong").map((c) => `${c.site} -> ${c.to}`), ...scored.flatMap((r) => r.wrongCertain.map((to) => `${r.file}:${r.line}:${r.column} -> ${to}`))];
    expect(new Set(wrong).size, [...new Set(wrong)].slice(0, 20).join("\n")).toBeLessThanOrEqual(MAX_WRONG_CERTAIN);
  });

  it("finds production callers certain or likely at least as often as the baseline (owner's baseline c)", () => {
    const prod = scored.filter((r) => !r.test);
    const found = prod.filter((r) => r.outcome === "certain-correct" || r.outcome === "likely-correct").length;
    const burden = prod.reduce((s, r) => s + r.burden, 0);
    process.stderr.write(`production recall ${found}/${prod.length} (baseline ${BASELINE_PROD_RECALL.found}/${BASELINE_PROD_RECALL.of}); burden ${burden} (baseline ${BASELINE_PROD_BURDEN})\n`);
    expect(prod.length).toBeGreaterThan(0);
    expect(found / prod.length).toBeGreaterThanOrEqual(BASELINE_PROD_RECALL.found / BASELINE_PROD_RECALL.of);
  });

  it("resolves every held-out site, by the checker, to its named declaration", () => {
    for (const h of HELD_OUT) {
      const here = sitesAt(h.site, h.name);
      expect(here.map((r) => r.targets.map((t) => `${t.owner}.${t.name}`)).flat(), h.site).toContain(h.target);
    }
  });

  for (const h of HELD_OUT) {
    // Owner's threshold b: expected to fail until the graph reads this receiver.
    it.fails(`finds ${h.site} calling ${h.target} certain or likely${h.implementer ? `, and reaches ${h.implementer}` : ""} (owner's threshold b)`, () => {
      const here = sitesAt(h.site, h.name);
      expect(here.map((r) => r.outcome)).toContainEqual(expect.stringMatching(/^(certain|likely)-correct$/));
      if (h.implementer) {
        const [owner, name] = h.implementer.split(".");
        const reached = graph.edges.some((e) => {
          const to = graph.nodes.get(e.to);
          return to?.name === name && e.to.includes(`#${owner}.${name}@`) && e.sites.some((s) => `${s.file}:${s.line}` === h.site);
        });
        expect(reached, `${h.implementer} at ${h.site}`).toBe(true);
      }
    });
  }

  const askPath = () => {
    const s: Session = { graph, generation: "truth", treeSha: null, builtAt: null, laterEditsKnown: false };
    return query(s, { apiVersion: 1, kind: "path", target: { name: HELD_OUT_PATH.from }, to: { name: HELD_OUT_PATH.to } });
  };

  // Without this, the expected failure below could hold for the wrong reason.
  it(`names both ends of path ${HELD_OUT_PATH.from} -> ${HELD_OUT_PATH.to} without an error`, () => {
    expect(askPath().error).toBeNull();
  });

  it.fails(`answers path ${HELD_OUT_PATH.from} -> ${HELD_OUT_PATH.to} in one hop through ${HELD_OUT_PATH.site} (owner's threshold b)`, () => {
    const a = askPath();
    const hops = (a.items as Item[]).map((i) => `${i.site?.file}:${i.site?.line}`);
    expect(hops).toEqual([HELD_OUT_PATH.site]);
  });
});
