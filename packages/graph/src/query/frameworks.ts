// Routes and tests: the two questions the framework layer answers (PLAN.md
// 3.2.3, phase 4). The layer's output is read here and nowhere else in the
// query, by its documented shape (frameworks/plugin.ts: registrations as
// entities, `handles` and `tests` edges, each with its evidence, and the
// plugins' unknowns), from `graph.frameworks`.
//
// Each question decides for itself whether the build read what it asks
// about, from the plugins whose rules emit what it reads (a route
// registration, a test link), never from whether some other plugin found
// something. `routes` where no route reader found an application is a
// capability boundary that names the server frameworks the manifests
// declare and this build does not read; where some routes were read and
// such a framework is declared too, the list is a floor that names it.
//
// `tests` lists the framework's test links and, beside them, what the
// graph can prove without a test runner: calls into the symbol from files
// named like tests that no link already holds. Those are leads, never
// counted and never called tests or coverage, and where no link reaches
// the symbol the answer is a floor: a test that requests a route or
// renders a component reaches the symbol without a call.
//
// Each is a job (answer.ts): the layer's edges, registrations and gaps are
// read one at a time with the question's budget checked at each, and a
// stopped job goes on where it stopped.
import { normalisePy } from "../discovery/manifests.js";
import { PLUGINS } from "../frameworks/registry.js";
import { GAPS_SHOWN, isTestPath, joinGaps } from "../impact.js";
import { NEXT } from "../gap.js";
import type { GapPlace } from "../gap.js";
import type { Cause, Tier } from "../model/records.js";
import type { Graph, GraphNode, GraphSite } from "../types.js";
import { candidate, counts, empty, fail, isAnswer, listing, Point, stoppedAt } from "./answer.js";
import type { Answer, Candidate, Job, Request, Session } from "./answer.js";
import { edgeId } from "./ids.js";
import { limitOf } from "./page.js";
import { Pass, RANK, sortWithin, Walk } from "./traverse.js";
import type { Item } from "./traverse.js";

type FwSite = { file: string; line: number; column: number };
type FwEvidence = { kind: string; tier: Tier; site: FwSite; via: { file: string; line: number; spec: string | null } | null; premises: string[]; note: string | null; rule: { id: string; version: number } };
type FwRegistration = {
  kind: "registration";
  id: string;
  plugin: string;
  app: string | null;
  methods: string[];
  pattern: string | null;
  written: string | null;
  name: string | null;
  site: FwSite;
  mounted: boolean;
  handler: { written: string; status: string; targets: string[] };
};
type FwEdge = { from: string; to: string; kind: string; plugin: string; app: string | null; evidence: FwEvidence; category?: string; order?: number };
type FwUnknown = { plugin: string; site: FwSite | null; affects: string[]; cause: string; name: string | null; note: string; count: number | null; exact: boolean; symbol?: string };
type FwRun = { id: string; status: string; reason: string | null; apps?: number };
type FwApp = { id: string; site: FwSite };
type FwLayer = { registrations: FwRegistration[]; edges: FwEdge[]; unknowns: FwUnknown[]; runs: FwRun[]; apps: FwApp[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Each framework plugin's run in a build (frameworks/stage.ts, PluginRun).
function runsOf(g: Graph): FwRun[] {
  const f = (g as unknown as { frameworks?: unknown }).frameworks;
  if (!isObj(f) || !Array.isArray(f.plugins)) return [];
  return f.plugins.filter((p): p is FwRun => isObj(p) && typeof p.id === "string" && typeof p.status === "string" && (p.reason === null || typeof p.reason === "string"));
}

// The framework layer of a build, when it has one in the documented shape.
export function frameworkLayer(g: Graph): FwLayer | null {
  const f = (g as unknown as { frameworks?: unknown }).frameworks;
  if (!isObj(f) || !Array.isArray(f.entities) || !Array.isArray(f.edges) || !Array.isArray(f.unknowns)) return null;
  const runs = runsOf(g);
  const apps = Array.isArray(f.apps) ? f.apps.filter((a): a is FwApp => isObj(a) && typeof a.id === "string" && isObj(a.site) && typeof a.site.file === "string") : [];
  const registrations = f.entities.filter((e): e is FwRegistration => isObj(e) && e.kind === "registration" && isObj(e.site) && isObj(e.handler) && Array.isArray(e.methods));
  const edges = f.edges.filter((e): e is FwEdge => isObj(e) && typeof e.from === "string" && typeof e.to === "string" && typeof e.kind === "string" && isObj(e.evidence) && isObj(e.evidence.site));
  const unknowns = f.unknowns.filter((u): u is FwUnknown => isObj(u) && Array.isArray(u.affects) && typeof u.cause === "string");
  return { registrations, edges, unknowns, runs, apps };
}

// The framework relations that describe data and never run code. A
// React `renders` edge runs a component, but it repeats the JSX element
// the core graph reads as a call, so no callers row rests on it.
const DATA_KINDS = new Set(["renders", "declares_field", "changes_schema", "maps_to", "uses_type", "reads_config", "defines_config"]);

// Whether a framework gap of each cause can drop a registration, a
// middleware or a job of a function of the graph, so that function reads
// as having no caller. One row per cause: a cause added to Cause does not
// typecheck until it is classified here.
const DROPS: Record<Cause, boolean> = {
  external: false, // what it names is outside the repository: no function of the graph is dropped
  "no-receiver-type": true, // a registration on a receiver no rule types is not read
  "untyped-receiver": true,
  "not-exported": true, // the handler's name was not followed to its definition
  "metadata-unreadable": true, // the manifest that enables the plugin's rules was not read
  ambiguous: true, // the handler may be another of the definitions it could mean
  miss: true, // the handler named is not where the evidence points; the real one is not listed
  dynamic: true, // a computed path, handler, prefix or list: the route may not be listed
  "dynamic-base": true, // routes inherited from a computed base are not listed
  "fan-out-capped": true,
  "file-not-parsed": true,
  "unsupported-language": true,
  "unsupported-rule": true, // a form the plugin does not read: what it registers is not listed
  budget: true,
  "export-chain-too-deep": true,
  memory: true,
  "variant-excluded": true, // a file of another build variant may register it there
  redacted: true, // a value kept out of the facts: what it named is not known
};
// The plugins whose registrations name what they run only through the
// file's imports (a name bound by an import, a value an imported function
// returns, a file the router's own file is). A gap of one reaches a
// function in another project only when the gap's file reaches the
// function's file through imports. Any other plugin names code by a
// module path in a string (Django's include), by a constant Ruby loads on
// its own (Rails), or by a naming rule (JUnit), so its gap reaches the
// whole build; so does a plugin not listed here.
const BOUND_BY_IMPORTS: ReadonlySet<string> = new Set(["express", "fastapi", "gin", "go-http", "hono", "nest", "nextjs", "react"]);

// The files that import `file`, directly or through other imports; a Go
// file is imported through its package folder.
function importedBy(g: Graph, file: string): Set<string> {
  const keysOf = (f: string) => (f.endsWith(".go") ? [f, `go:${f.slice(0, Math.max(0, f.lastIndexOf("/")))}`] : [f]);
  const out = new Set<string>();
  const queue = keysOf(file);
  for (let i = 0; i < queue.length; i++) {
    for (const e of g.importers.get(queue[i] as string) ?? []) {
      if (out.has(e.from)) continue;
      out.add(e.from);
      queue.push(...keysOf(e.from));
    }
  }
  return out;
}

const drops = (cause: string): boolean => (DROPS as Record<string, boolean | undefined>)[cause] ?? true;

// How a framework gap reaches a function: the one function it names, every
// function of the build, those of a project, or those near a file (in its
// project, or in a file it imports, as a handler imported from another
// project is).
type FwReach = { symbol: string } | { all: true } | { project: string } | { near: string; project: string };
type Grouped = { reasons: string[]; ordered: FwUnknown[] };
// What frameworkCallerGaps reads of a build, worked out once per build: a
// deep callers question asks it for every caller it walks through. `gaps`:
// each gap that can hide a call (DROPS) of a relation that runs code, with
// its reach, in the layer's order. `byProject`: the reasons and the gaps in
// order of a function that only the gaps of its project's reach.
type Prepared = { runs: FwRun[]; gaps: { u: FwUnknown; reach: FwReach }[]; byProject: Map<string, Grouped> };
const preparedOf = new WeakMap<Graph, Prepared | null>();
function prepare(g: Graph): Prepared | null {
  if (preparedOf.has(g)) return preparedOf.get(g) ?? null;
  const layer = frameworkLayer(g);
  let out: Prepared | null = null;
  if (layer) {
    const appFile = new Map(layer.apps.map((a) => [a.id, a.site.file]));
    const near = (f: string): FwReach => ({ near: f, project: g.projectOf(f) });
    const reachOf = (u: FwUnknown): FwReach => {
      if (typeof u.symbol === "string") return { symbol: u.symbol };
      if (!BOUND_BY_IMPORTS.has(u.plugin)) return { all: true };
      const scope = (u as { scope?: unknown }).scope;
      if (isObj(scope)) {
        if (scope.build === true) return { all: true };
        if (typeof scope.project === "string") return { project: scope.project };
        if (typeof scope.app === "string") {
          const at = appFile.get(scope.app);
          return at === undefined ? { all: true } : near(at);
        }
        if (typeof scope.file === "string") return near(scope.file);
      }
      return u.site === null ? { all: true } : near(u.site.file);
    };
    // A cap, a budget, a computed value, a file the plugin did not read: each
    // may hide a registration, so the framework may run it there.
    const gaps = layer.unknowns.filter((u) => drops(u.cause) && (u.affects.length === 0 || u.affects.some((k) => !DATA_KINDS.has(k)))).map((u) => ({ u, reach: reachOf(u) }));
    out = { runs: layer.runs.filter((r) => r.status === "failed" || r.status === "stopped"), gaps, byProject: new Map() };
  }
  preparedOf.set(g, out);
  return out;
}

// One reason per plugin and cause, at the first place of each; a gap with
// no place (a stop for the whole build) is said before the others, and the
// first gap of each group leads the list.
function grouped(hit: readonly FwUnknown[]): Grouped {
  const ordered = [...hit].sort((a, b) => (a.site === null ? 0 : 1) - (b.site === null ? 0 : 1));
  const groups = new Map<string, FwUnknown[]>();
  for (const u of ordered) {
    const k = `${u.plugin}\u0000${u.cause}`;
    const list = groups.get(k);
    if (list) list.push(u);
    else groups.set(k, [u]);
  }
  const reasons: string[] = [];
  for (const [first, ...rest] of groups.values()) {
    const u = first as FwUnknown;
    const where = u.site ? ` at ${u.site.file}:${u.site.line}` : "";
    reasons.push(rest.length === 0 ? `the ${u.plugin} plugin gave up${where} (${u.cause}): ${u.note}; the framework may run it there` : `the ${u.plugin} plugin gave up at ${rest.length + 1} places (${u.cause}) where the framework may run it, first${where}: ${u.note}`);
  }
  const leading = [...groups.values()].map((list) => list[0] as FwUnknown);
  const lead = new Set(leading);
  return { reasons, ordered: [...leading, ...ordered.filter((u) => !lead.has(u))] };
}

// Where the framework layer gave up in a way that may hide it running a
// function of `file` (as a handler, a middleware, a job): each gap whose
// cause can drop a registration (DROPS) and that names a relation that
// runs code, or none, and reaches the function's project, and each plugin
// that failed or stopped. A gap that names one function (`symbol`) floors
// only that function. Its reasons and at most GAPS_SHOWN of its gaps, for
// a caller floor; the reasons hold the counts.
export function frameworkCallerGaps(g: Graph, file: string, id: string): { reasons: string[]; gaps: GapPlace[] } {
  const prep = prepare(g);
  if (!prep) return { reasons: [], gaps: [] };
  const project = g.projectOf(file);
  // A gap reaches the function when its place is in the function's
  // project, or imports the function's file (a handler imported from
  // another project), or when its plugin names code by other means.
  let importers: Set<string> | null = null;
  let importerProjects: Set<string> | null = null;
  const imports = (): Set<string> => (importers ??= importedBy(g, file));
  // Whether the gaps that reach the function are those of its project
  // alone, the same for every function there.
  let own = true;
  const hit: FwUnknown[] = [];
  for (const { u, reach } of prep.gaps) {
    let reaches: boolean;
    if ("symbol" in reach) reaches = reach.symbol === id;
    else if ("all" in reach) reaches = true;
    else if ("near" in reach) reaches = reach.project === project || imports().has(reach.near);
    else reaches = reach.project === project || (importerProjects ??= new Set([...imports()].map((f) => g.projectOf(f)))).has(reach.project);
    if (!reaches) continue;
    hit.push(u);
    if ("symbol" in reach || (("near" in reach || "project" in reach) && reach.project !== project)) own = false;
  }
  let group = own ? prep.byProject.get(project) : undefined;
  if (!group) {
    group = grouped(hit);
    if (own) prep.byProject.set(project, group);
  }
  const runs = prep.runs;
  const reasons = [...runs.map((r) => `the ${r.id} plugin ${r.status === "failed" ? "failed" : "stopped"} (${r.reason ?? r.status}), so what it runs is not listed and may call it`), ...group.reasons];
  // A plugin that failed or stopped names no place: its gap is said at the file asked about.
  const gaps: GapPlace[] = runs.map((r) => ({ cause: r.status === "failed" ? "unsupported-rule" : "budget", file, line: null, next: NEXT.frameworkRun }));
  // Each place once, the first GAPS_SHOWN: a caller floor shows no more (impact.ts, joinGaps).
  const seen = new Set(gaps.map((x) => `${x.cause}\u0000${x.file}\u0000${x.line}\u0000${x.next}`));
  for (const u of group.ordered) {
    if (seen.size >= GAPS_SHOWN) break;
    const x: GapPlace = { cause: u.cause, file: u.site?.file ?? file, line: u.site && u.site.line > 0 ? u.site.line : null, next: u.cause === "file-not-parsed" ? NEXT.frameworkFile : NEXT.framework };
    const k = `${x.cause}\u0000${x.file}\u0000${x.line}\u0000${x.next}`;
    if (seen.has(k)) continue;
    seen.add(k);
    gaps.push(x);
  }
  return { reasons, gaps: joinGaps(gaps) };
}

// The plugins of this build whose rules emit `kind` (a route
// registration, a test link), by id: the readers a question rests on, read
// from each plugin's own capabilities, so a reader added to the registry
// answers with no change here.
const emitting = new Map<string, Set<string>>();
function readersOf(kind: string): Set<string> {
  let ids = emitting.get(kind);
  if (!ids) {
    ids = new Set(PLUGINS.filter((p) => p.capabilities().rules.some((r) => (r.emits as string[]).includes(kind))).map((p) => p.id));
    emitting.set(kind, ids);
  }
  return ids;
}

// Whether a reader of `kind` read this repository: it found an application
// or made such output, or it failed or was stopped, so its part is a gap
// of the answer and not a question this build cannot answer.
function readBy(layer: FwLayer | null, kind: string): boolean {
  if (!layer) return false;
  const ids = readersOf(kind);
  const made = (id: string) => (kind === "registration" ? layer.registrations.some((r) => r.plugin === id) : layer.edges.some((e) => e.kind === kind && e.plugin === id));
  return layer.runs.some((r) => ids.has(r.id) && (r.status === "failed" || r.status === "stopped" || (r.status === "ok" && ((r.apps ?? 0) > 0 || made(r.id)))));
}

// Why no reader of `kind` answers, for a capability boundary or a floor.
function notRead(layer: FwLayer | null, kind: string, what: string): string {
  if (!layer) return "this build has no framework layer";
  const ids = [...readersOf(kind)];
  return ids.length > 0 ? `no ${what} of this build (${ids.join(", ")}) found an application in this repository` : `this build has no ${what}`;
}

// Server frameworks a manifest can declare, by the packages that name
// them. One is unread while no route reader lists any of its packages
// among the dependencies that enable it (frameworks/plugin.ts,
// PluginInputs), so a reader added for it takes it off this list.
const SERVER_FRAMEWORKS: { name: string; ecosystem: "npm" | "python" | "go"; packages: string[] }[] = [
  { name: "Hono", ecosystem: "npm", packages: ["hono", "@hono/zod-openapi"] },
  { name: "NestJS", ecosystem: "npm", packages: ["@nestjs/core"] },
  { name: "Fastify", ecosystem: "npm", packages: ["fastify"] },
  { name: "Koa", ecosystem: "npm", packages: ["koa"] },
  { name: "Flask", ecosystem: "python", packages: ["flask"] },
  { name: "Gin", ecosystem: "go", packages: ["github.com/gin-gonic/gin"] },
  { name: "Echo", ecosystem: "go", packages: ["github.com/labstack/echo"] },
  { name: "chi", ecosystem: "go", packages: ["github.com/go-chi/chi"] },
  { name: "Fiber", ecosystem: "go", packages: ["github.com/gofiber/fiber"] },
];

// The server frameworks this repository's manifests declare and no route
// reader of this build reads, each with the package that declares it.
function unreadServers(g: Graph): string[] {
  const readers = readersOf("registration");
  const read = new Set(PLUGINS.filter((p) => readers.has(p.id)).flatMap((p) => [...(p.inputs.dependencies.npm ?? []), ...(p.inputs.dependencies.python ?? []).map(normalisePy), ...(p.inputs.dependencies.go ?? [])]));
  const m = g.model;
  const declared = (ecosystem: string, name: string) => {
    if (ecosystem === "python") return m.pyDeclared.has(normalisePy(name));
    if (ecosystem === "go") return m.goRequires.some((r) => r === name || r.startsWith(`${name}/`));
    return m.node.some((p) => p.pkg.deps.has(name));
  };
  const out: string[] = [];
  for (const f of SERVER_FRAMEWORKS) {
    if (f.packages.some((n) => read.has(f.ecosystem === "python" ? normalisePy(n) : n))) continue;
    const hit = f.packages.find((n) => declared(f.ecosystem, n));
    if (hit) out.push(`${f.name} (${hit})`);
  }
  return out;
}

const declaresUnread = (servers: string[]) => `this repository declares ${servers.join(", ")}, which this build does not read`;

// Why `routes` is a capability boundary in this build, or null when a
// route reader read the repository.
export function routesUnsupported(g: Graph): string | null {
  const layer = frameworkLayer(g);
  if (readBy(layer, "registration")) return null;
  const servers = unreadServers(g);
  return `${notRead(layer, "registration", "route reader")}${servers.length > 0 ? `; ${declaresUnread(servers)}` : ""}`;
}

// Why `tests` has only leads in this build, or null when a test reader
// read the repository.
export function testsUnread(g: Graph): string | null {
  const layer = frameworkLayer(g);
  return readBy(layer, "tests") ? null : notRead(layer, "tests", "test reader");
}

function fwSite(e: FwEvidence): GraphSite {
  return { file: e.site.file, line: e.site.line, column: e.site.column, tier: e.tier, evidence: e.kind, via: e.via, note: e.note, rule: e.rule.id };
}

// The layer's gaps for one relation, gathered gap by gap, and the plugins
// that failed or ran out of budget, whose part of the layer is missing.
class Gaps {
  private readonly hit: FwUnknown[] = [];
  private readonly missing: string[];
  readonly pass: Pass<FwUnknown>;
  // `readers`: the plugins whose output the relation is; a plugin that
  // emits none of it hides nothing of it when it fails.
  constructor(layer: FwLayer, affects: string, readers: ReadonlySet<string>) {
    // A gap that names no relation may hide any of them.
    this.pass = new Pass(layer.unknowns, (u) => {
      if (u.affects.length === 0 || u.affects.includes(affects)) this.hit.push(u);
    });
    this.missing = layer.runs.filter((r) => readers.has(r.id) && (r.status === "failed" || r.status === "stopped")).map((r) => `${r.id}: ${r.reason ?? r.status}, so nothing of it is listed`);
  }
  // After the pass is whole: the answer's unknown block with the gaps.
  unknown(base: Answer): Answer["unknown"] {
    const causes: Record<string, number | null> = {};
    for (const u of this.hit) {
      const prev = causes[u.cause];
      causes[u.cause] = prev === null || u.count === null ? null : (prev ?? 0) + u.count;
    }
    const said = (u: FwUnknown) => `${u.plugin}: ${u.note}${u.site ? ` (${u.site.file}:${u.site.line})` : ""}`;
    const reasons = [...this.missing, ...this.hit.slice(0, 10).map(said)];
    if (this.hit.length > 10) reasons.push(`and ${this.hit.length - 10} more gaps of the framework layer`);
    // The same gaps by cause: the count `causes` gives, the places that
    // hold them, and the first two of each.
    const byCause = new Map<string, { cause: string; places: number; examples: string[] }>();
    for (const u of this.hit) {
      let g = byCause.get(u.cause);
      if (!g) byCause.set(u.cause, (g = { cause: u.cause, places: 0, examples: [] }));
      g.places++;
      if (g.examples.length < 2) g.examples.push(said(u));
    }
    const groups = [...byCause.values()].map((g) => ({ cause: g.cause, count: causes[g.cause] ?? null, places: g.places, examples: g.examples }));
    return { ...base.unknown, floor: base.unknown.floor || reasons.length > 0, reasons: [...reasons, ...base.unknown.reasons], causes, groups };
  }
}

type Route = {
  id: string;
  plugin: string;
  app: string | null;
  methods: string[];
  pattern: string | null;
  name: string | null;
  mounted: boolean;
  site: FwSite;
  handler: FwRegistration["handler"];
  handles: { to: string; site: GraphSite; premises: string[]; edge: string }[];
  // What runs before the handler, in order (FastAPI's Depends and
  // Security, a framework's middleware): the registration's
  // applies_middleware edges.
  dependencies: { to: string; order: number | null; site: GraphSite; premises: string[]; edge: string }[];
  // The route belongs to an application a test file builds (or, with no
  // application, is registered in a test file), by the graph's one rule
  // for test files.
  isTest: boolean;
};

// A target that names one point (an id, a name, a file and line), as
// against a whole listing narrowed by text.
const namesPoint = (t: Request["target"]) => Boolean(t && (t.id || t.name || (t.file && t.line !== undefined)));

export function routes(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const layer = frameworkLayer(g);
  const why = routesUnsupported(g);
  if (!layer || why !== null) return fail(s, "routes", "unsupported", `${why ?? notRead(layer, "registration", "route reader")}, so the graph knows no routes; \`callers\` and \`importers\` still answer for the handler code`);
  // Routes of a server framework this build does not read are missing from
  // the list: it is a floor that names them.
  const servers = unreadServers(g);
  const point = namesPoint(req.target) ? new Point(g, req.target) : null;
  const text = point ? undefined : req.text;
  let n: GraphNode | null = null;
  // The handles edges by the registration they leave, and the registrations
  // whose handler is the point.
  const handlesOf = new Map<string, FwEdge[]>();
  const depsOf = new Map<string, FwEdge[]>();
  const handlesPoint = new Set<string>();
  let edges: Pass<FwEdge> | null = null;
  const items: Route[] = [];
  let regs: Pass<FwRegistration> | null = null;
  let sorted = false;
  const gaps = new Gaps(layer, "handles", readersOf("registration"));
  const appFile = new Map(layer.apps.map((a) => [a.id, a.site.file]));
  return (budget) => {
    const base = empty(s, "routes");
    if (point && !n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, "routes");
      if (isAnswer(o)) return o;
      n = o;
    }
    const at = n;
    const target = at ? candidate(g, at, 1) : null;
    edges ??= new Pass(layer.edges, (e) => {
      if (e.kind === "applies_middleware") (depsOf.get(e.from) ?? depsOf.set(e.from, []).get(e.from))?.push(e);
      if (e.kind !== "handles") return;
      (handlesOf.get(e.from) ?? handlesOf.set(e.from, []).get(e.from))?.push(e);
      if (at && e.to === at.id) handlesPoint.add(e.from);
    });
    if (!edges.run(budget)) return stoppedAt({ ...base, target }, [], [], edges.left);
    regs ??= new Pass(layer.registrations, (r) => {
      if (at && !handlesPoint.has(r.id) && !r.handler.targets.includes(at.id)) return;
      if (text && !(r.pattern ?? r.written ?? "").includes(text) && r.name !== text) return;
      const isTest = isTestPath((r.app !== null ? appFile.get(r.app) : undefined) ?? r.site.file);
      if (isTest && req.excludeTests) return;
      const handles = (handlesOf.get(r.id) ?? []).map((e) => ({ to: e.to, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site) }));
      const dependencies = (depsOf.get(r.id) ?? []).map((e) => ({ to: e.to, order: e.order ?? null, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site) })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      items.push({ id: r.id, plugin: r.plugin, app: r.app, methods: r.methods, pattern: r.pattern, name: r.name, mounted: r.mounted, site: r.site, handler: r.handler, handles, dependencies, isTest });
    });
    if (!regs.run(budget)) return stoppedAt({ ...base, target }, items, [], regs.left);
    if (!sorted) {
      if (!sortWithin(items, (a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line, budget)) return stoppedAt({ ...base, target }, items, [], null);
      sorted = true;
    }
    if (!gaps.pass.run(budget)) return stoppedAt({ ...base, target }, items, [], gaps.pass.left);
    const unknown = gaps.unknown(base);
    if (servers.length > 0) {
      unknown.floor = true;
      unknown.reasons = [`${declaresUnread(servers)}, so its routes are not listed`, ...unknown.reasons];
      unknown.causes = { ...unknown.causes, "unsupported-rule": null };
    }
    return listing({ ...base, target, unknown }, items);
  };
}

type TestLink = { from: string; to: string; kind: "tests"; category: string | null; depth: number; site: GraphSite; premises: string[]; edge: string; fromName: string | null; toName: string | null };

// The floor of `tests` for a symbol no framework test link reaches.
const LEAD_REASONS = (g: Graph, name: string) => [
  `${testsUnread(g) ?? `no framework test link reaches \`${name}\``}, so files are taken for tests of \`${name}\` by their names only: these are leads, not test links`,
  "a test that requests a route, renders a component or reaches the code through a value calls nothing here",
];

export function tests(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job {
  const g = s.graph;
  const layer = frameworkLayer(g);
  const point = new Point(g, req.target);
  let n: GraphNode | null = null;
  // The layer's links: the routes the point handles, then the test edges
  // into the point or into one of them, sorted.
  const handled = new Set<string>();
  let handles: Pass<FwEdge> | null = null;
  const links: TestLink[] = [];
  let tested: Pass<FwEdge> | null = null;
  let sorted = false;
  const gaps = layer ? new Gaps(layer, "tests", readersOf("tests")) : null;
  // Beside them, whatever any plugin found: callers two hops out, from
  // files named like tests, that no link already holds.
  let walk: Walk | null = null;
  const seen = new Set<string>();
  const leads: Candidate[] = [];
  let picked: Pass<Item> | null = null;
  return (budget) => {
    const base = empty(s, "tests");
    if (!n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, "tests");
      if (isAnswer(o)) return o;
      n = o;
    }
    const at = n;
    const target = candidate(g, at, 1);
    if (layer && gaps) {
      handles ??= new Pass(layer.edges, (e) => {
        if (e.kind === "handles" && e.to === at.id) handled.add(e.from);
      });
      if (!handles.run(budget)) return stoppedAt({ ...base, target }, [], [], handles.left);
      tested ??= new Pass(layer.edges, (e) => {
        if (e.kind !== "tests" || (e.to !== at.id && !handled.has(e.to)) || !tiers.has(e.evidence.tier)) return;
        links.push({ from: e.from, to: e.to, kind: "tests", category: e.category ?? null, depth: 1, site: fwSite(e.evidence), premises: e.evidence.premises, edge: edgeId(e, e.evidence.site), fromName: g.nodes.get(e.from)?.name ?? null, toName: g.nodes.get(e.to)?.name ?? null });
      });
      if (!tested.run(budget)) return stoppedAt({ ...base, target }, links, [], tested.left);
      if (!sorted) {
        if (!sortWithin(links, (a, b) => RANK[a.site.tier] - RANK[b.site.tier] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line, budget)) return stoppedAt({ ...base, target }, links, [], null);
        sorted = true;
      }
      if (!gaps.pass.run(budget)) return stoppedAt({ ...base, target }, links, [], gaps.pass.left);
    }
    const unknown = gaps ? gaps.unknown(base) : { ...base.unknown };
    if (links.length === 0) Object.assign(unknown, { floor: true, reasons: [...LEAD_REASONS(g, at.name), ...unknown.reasons], causes: { ...unknown.causes, "unsupported-rule": null } });
    // With links the leads ride beside them, and the links are the page.
    const into = links.length > 0 ? "items" : "leads";
    const page = links.length > 0 ? links : leads;
    // The leads beside the links are one page long, not paged: every page
    // would repeat them. The rest are said, and `callers` lists them all.
    const cap = limitOf(req);
    const answer = (): Answer => ({ ...base, target, ...(links.length > 0 ? { counts: counts(links), leads: leads.slice(0, cap) } : {}), unknown });
    const linked = new Set(links.map((l) => l.from));
    walk ??= new Walk(g, at.id, "in", 2, tiers);
    if (!walk.run(budget)) return stoppedAt(answer(), page, walk.pending(), walk.pending().length, into);
    picked ??= new Pass(walk.items, (i) => {
      if (!isTestPath(i.site.file) || seen.has(i.from)) return;
      seen.add(i.from);
      if (linked.has(i.from)) return;
      const from = g.nodes.get(i.from);
      const score = i.depth === 1 ? 1 : 0.5;
      leads.push(from ? candidate(g, from, score) : { id: i.from, name: i.from, kind: "file", file: i.site.file, line: i.site.line, project: g.projectOf(i.site.file), score });
    });
    if (!picked.run(budget)) return stoppedAt(answer(), page, [], picked.left, into);
    // Calls from test files no link holds: the links are not every test.
    if (links.length > 0 && leads.length > 0) {
      const more = leads.length > cap ? `; the first ${cap} are listed, ${leads.length - cap} more are not: \`graph callers ${at.name} --depth 2\` lists them` : "";
      Object.assign(unknown, { floor: true, reasons: [`${leads.length} files or functions named like tests call into \`${at.name}\` and no framework test link holds them: they are leads, not test links${more}`, ...unknown.reasons] });
    }
    return listing(answer(), page, { into });
  };
}
