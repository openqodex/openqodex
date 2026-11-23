// The Next.js plugin's resolve step: the routes a project serves from its
// file tree, each bound to the function that handles it, the conventions'
// roles (layouts, loading and error boundaries, client components), the
// middleware and the routes its matcher selects, and server actions.
//
// Detection: a project whose manifest declares `next` and that has an `app`
// or a `pages` folder (at its root, else under `src`). The app router and
// the pages router are two applications: their routes never merge. A
// dependency without either folder is no application.
//
// Routes come from paths by Next.js's own rules, read as text segments,
// never as patterns: a route group `(name)` is dropped, a private folder
// `_name` serves nothing, `[id]`, `[...rest]` and `[[...rest]]` are kept as
// written. Parallel slots `@name` and intercepting segments `(.)name` are
// not followed yet: each is an unknown, never a guessed route. A handler is
// the file's own export (the default export of a page, the exported GET,
// POST, ... of a route handler), bound by its definition in that file; a
// route whose file has no such definition keeps its registration with the
// handler's status and an unknown.
//
// Every budget counts the work of the whole build, is checked where the work
// is done, and once reached stops that work with one unknown.
import type { Detection, FrameworkEdge, FrameworkEvidence, FrameworkUnknown, HandlerStatus, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { GraphNode } from "../../types.js";
import { MAX_SOURCE_BYTES } from "../express/js.js";
import type { NextFact } from "./facts.js";

export const PLUGIN = "nextjs";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// Caps on one item.
export const MAX_PATTERN_SEGMENTS = 64; // segments of one route path or matcher read

// Budgets for the whole build.
export const MAX_FACTS_READ = 400_000;
export const MAX_PATHS = 1_000_000; // capture paths examined
export const MAX_REGISTRATIONS = 10000;
export const MAX_MIDDLEWARE_EDGES = 30_000;
export const MAX_MATCH_WORK = 4_000_000; // matcher-by-route steps
export const MAX_ROLES = 20_000; // roles given
export const MAX_UNKNOWNS = 5000;

type Spend = "facts" | "paths" | "registrations" | "middlewareEdges" | "matchWork" | "roles" | "unknowns";
const LIMIT: Record<Spend, number> = { facts: MAX_FACTS_READ, paths: MAX_PATHS, registrations: MAX_REGISTRATIONS, middlewareEdges: MAX_MIDDLEWARE_EDGES, matchWork: MAX_MATCH_WORK, roles: MAX_ROLES, unknowns: MAX_UNKNOWNS };

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
const EXTS = new Set(["js", "jsx", "ts", "tsx"]);
// The app router's file conventions that are no route of their own, with the detail of their role.
const APP_ROLES: Record<string, string> = { layout: "layout", template: "template", loading: "loading", error: "error", "global-error": "global-error", "not-found": "not-found", default: "default" };

type Router = { id: string; kind: "app" | "pages"; dir: string; project: string };

type Fact<K extends NextFact["kind"]> = Extract<NextFact, { kind: K }>;

export type Analysis = { apps: Detection[]; output: PluginOutput };

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<NextFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

// A file name split into its base and extension: "page.tsx" is page and tsx.
function nameParts(file: string): { base: string; ext: string } | null {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = file.slice(dot + 1);
  return EXTS.has(ext) ? { base: file.slice(0, dot), ext } : null;
}

function run(index: PluginIndex<NextFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];
  const apps: Detection[] = [];

  // ---------- the build's budgets ----------
  const spent: Record<Spend, number> = { facts: 0, paths: 0, registrations: 0, middlewareEdges: 0, matchWork: 0, roles: 0, unknowns: 0 };
  const refused: Record<Spend, number> = { facts: 0, paths: 0, registrations: 0, middlewareEdges: 0, matchWork: 0, roles: 0, unknowns: 0 };
  const take = (k: Spend, n = 1): boolean => {
    if (spent[k] + n > LIMIT[k]) {
      refused[k] += n;
      return false;
    }
    spent[k] += n;
    return true;
  };
  const addUnknown = (u: FrameworkUnknown) => {
    if (take("unknowns")) unknowns.push(u);
  };

  // Each file's facts, read once against the budget.
  const factCache = new Map<string, NextFact[] | null>();
  const factsOf = (file: string): NextFact[] | null => {
    if (factCache.has(file)) return factCache.get(file) ?? null;
    const list = index.factsOf(file);
    const out = take("facts", list.length) ? [...list] : null;
    factCache.set(file, out);
    return out;
  };
  const of = <K extends NextFact["kind"]>(file: string, kind: K): Fact<K>[] => (factsOf(file) ?? []).filter((f): f is Fact<K> => f.kind === kind);

  // ---------- the routers ----------
  const paths = index.paths();
  const hasDir = (dir: string): boolean => {
    const prefix = dir === "" ? "" : `${dir}/`;
    // Sorted paths: the first path at or after the prefix tells.
    let lo = 0;
    let hi = paths.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((paths[mid] as string) < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo < paths.length && (paths[lo] as string).startsWith(prefix);
  };
  const join = (a: string, b: string) => (a === "" ? b : `${a}/${b}`);
  const routers: Router[] = [];
  for (const p of index.model().node) {
    if (!p.pkg.deps.has("next") || !index.declares(p.dir, "npm", "next")) continue;
    for (const kind of ["app", "pages"] as const) {
      const dir = hasDir(join(p.dir, kind)) ? join(p.dir, kind) : hasDir(join(p.dir, `src/${kind}`)) ? join(p.dir, `src/${kind}`) : null;
      if (dir === null) continue;
      routers.push({ id: appId(PLUGIN, `${dir}/`, 1), kind, dir, project: p.dir });
      apps.push({
        id: appId(PLUGIN, `${dir}/`, 1),
        name: `${kind === "app" ? "app router" : "pages router"} (${dir})`,
        project: p.dir,
        root: dir,
        site: { file: p.file, line: 1, column: 1 },
        evidence: [{ file: p.file, line: 1, note: `declares next; the ${dir} folder holds the routes` }],
        version: p.pkg.deps.get("next") ?? null,
      });
    }
  }

  // ---------- handlers ----------
  const symbolsOf = (file: string): readonly GraphNode[] => index.symbols(file);
  // Each file's definitions by name and line, built once, so a file of
  // thousands of server actions is not scanned once per action.
  const placed = new Map<string, Map<string, GraphNode>>();
  const symbolAt = (file: string, name: string, line: number): GraphNode | null => {
    let m = placed.get(file);
    if (!m) {
      m = new Map();
      for (const n of symbolsOf(file)) if (!m.has(`${n.name}\0${n.startLine}`)) m.set(`${n.name}\0${n.startLine}`, n);
      placed.set(file, m);
    }
    return m.get(`${name}\0${line}`) ?? null;
  };
  // A definition at the top of a file (no owner): its id is
  // `<file>#<name>@<line>:<column>`. Each file's are indexed by name once.
  const tops = new Map<string, Map<string, GraphNode>>();
  const topSymbol = (file: string, name: string): GraphNode | null => {
    let byName = tops.get(file);
    if (!byName) {
      byName = new Map();
      for (const n of symbolsOf(file)) if (n.id.startsWith(`${file}#${n.name}@`) && !byName.has(n.name)) byName.set(n.name, n);
      tops.set(file, byName);
    }
    return byName.get(name) ?? null;
  };
  // The definition behind an exported name: a declaration exported as itself, or `export { local as name }`.
  const exportedSymbol = (file: string, name: string): GraphNode | null => {
    const lf = index.languageFacts(file);
    const local = lf?.exportsLocal.find((x) => x.exported === name)?.local ?? null;
    if (local) return topSymbol(file, local);
    const own = topSymbol(file, name);
    return own && own.exported ? own : null;
  };
  type Bound = { status: HandlerStatus; target: GraphNode | null; why: string | null; cause: FrameworkUnknown["cause"] };
  const defaultHandler = (file: string): Bound => {
    const lf = index.languageFacts(file);
    if (!lf) return { status: "unresolved", target: null, why: "the file was not read, so its default export is not known", cause: "file-not-parsed" };
    if (lf.defaultExport === null) return { status: "unresolved", target: null, why: "the file has no named default export, so the page has no symbol of its own", cause: "unsupported-rule" };
    const s = topSymbol(file, lf.defaultExport);
    return s ? { status: "bound", target: s, why: null, cause: "miss" } : { status: "dynamic", target: null, why: `the default export ${lf.defaultExport} is a value the code computes, not a definition`, cause: "dynamic" };
  };

  const roleSeen = new Set<string>();
  const addRole = (target: string, role: RoleAssignment["role"], detail: string, app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}\0${detail}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (!take("roles")) return;
    roles.push({ target, role, detail, app, evidence });
  };
  const at = (file: string, n: GraphNode | null): Site => ({ file, line: n?.startLine ?? 1, column: 1 });

  // A server action has no URL of its own (Next.js serves it on the page that
  // posts it): its pattern is null.
  const register = (router: Router, file: string, methods: string[], pattern: string | null, b: Bound, site: Site, detail: string) => {
    if (!take("registrations")) return;
    const id = entityId(PLUGIN, router.id, "registration", `${file}:${site.line}:${methods.join(",")}`);
    registrations.push({ kind: "registration", id, plugin: PLUGIN, app: router.id, methods, pattern, written: pattern, name: null, site, mountedVia: [], mounted: true, handler: { written: b.target?.name ?? "default export", status: b.status, targets: b.target ? [b.target.id] : [] } });
    if (b.target) {
      const ev: FrameworkEvidence = { kind: "route-path", tier: "certain", site, via: null, premises: [], rule: rule(`nextjs-${router.kind}-${detail}`), note: null };
      edges.push({ from: id, to: b.target.id, kind: "handles", plugin: PLUGIN, app: router.id, evidence: ev });
      addRole(b.target.id, "route_handler", detail, router.id, ev);
    } else if (b.why) addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: b.cause, name: null, note: b.why, count: null, exact: false });
  };

  // ---------- routes from the file tree ----------
  let segmentsCut = 0;
  for (const path of paths) {
    if (routers.length === 0) break;
    if (!take("paths")) break;
    const router = routers.find((r) => path.startsWith(`${r.dir}/`));
    if (!router) continue;
    const parts = path.slice(router.dir.length + 1).split("/");
    if (parts.length > MAX_PATTERN_SEGMENTS) {
      segmentsCut++;
      continue;
    }
    const n = nameParts(parts[parts.length - 1] as string);
    if (!n || index.projectOf(path) !== router.project) continue;
    const dirs = parts.slice(0, -1);
    const facts = factsOf(path);
    const big = facts?.find((f): f is Fact<"too-large"> => f.kind === "too-large");
    if (big) addUnknown({ plugin: PLUGIN, site: { file: path, line: 1, column: 1 }, scope: { file: path }, affects: ["handles"], cause: "file-not-parsed", name: null, note: `the file is ${big.bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte cap of the Next.js plugin, so its directives were not read`, count: null, exact: false });
    const broken = facts?.find((f): f is Fact<"syntax-error"> => f.kind === "syntax-error");
    if (broken) addUnknown({ plugin: PLUGIN, site: { file: path, line: broken.line, column: 1 }, scope: { file: path }, affects: ["handles"], cause: "file-not-parsed", name: null, note: `the file has ${broken.regions} region(s) the parser could not read, the first at line ${broken.line}`, count: broken.regions, exact: true });

    if (router.kind === "app") {
      const kept: string[] = [];
      let skip: string | null = null;
      for (const seg of dirs) {
        if (seg.startsWith("_")) {
          skip = "private";
          break;
        }
        if (seg.startsWith("@")) {
          skip = `the parallel route slot ${seg}`;
          break;
        }
        if (seg.startsWith("(.)") || seg.startsWith("(..)") || seg.startsWith("(...)")) {
          skip = `the intercepting route ${seg}`;
          break;
        }
        if (seg.startsWith("(") && seg.endsWith(")")) continue; // a route group
        kept.push(seg);
      }
      const isRoute = n.base === "page" || n.base === "route";
      if (skip === "private") continue;
      if (skip !== null) {
        if (isRoute) addUnknown({ plugin: PLUGIN, site: { file: path, line: 1, column: 1 }, scope: { file: path }, affects: ["handles"], cause: "unsupported-rule", name: null, note: `${skip} is not followed yet, so the URL this file serves is not known`, count: null, exact: false });
        continue;
      }
      const pattern = `/${kept.join("/")}`;
      if (n.base === "page") {
        const b = defaultHandler(path);
        register(router, path, ["GET"], pattern, b, at(path, b.target), "page");
      } else if (n.base === "route") {
        const lf = index.languageFacts(path);
        const methods = new Set<string>();
        for (const s of symbolsOf(path)) if (s.exported && HTTP_METHODS.has(s.name)) methods.add(s.name);
        for (const x of lf?.exportsLocal ?? []) if (HTTP_METHODS.has(x.exported)) methods.add(x.exported);
        if (!lf) addUnknown({ plugin: PLUGIN, site: { file: path, line: 1, column: 1 }, scope: { file: path }, affects: ["handles"], cause: "file-not-parsed", name: null, note: "the route handler file was not read, so the methods it exports are not known", count: null, exact: false });
        for (const m of [...methods].sort()) {
          const s = exportedSymbol(path, m);
          register(router, path, [m], pattern, s ? { status: "bound", target: s, why: null, cause: "miss" } : { status: "dynamic", target: null, why: `the exported ${m} is a value the code computes, not a definition`, cause: "dynamic" }, at(path, s), "route");
        }
      } else if (APP_ROLES[n.base]) {
        const b = defaultHandler(path);
        if (b.target) addRole(b.target.id, "component", APP_ROLES[n.base] as string, router.id, { kind: "role-path", tier: "certain", site: at(path, b.target), via: null, premises: [], rule: rule("nextjs-app-convention"), note: null });
      }
      continue;
    }

    // The pages router.
    const top = dirs.length === 0;
    if (top && (n.base === "_app" || n.base === "_document" || n.base === "_error")) {
      const b = defaultHandler(path);
      if (b.target) addRole(b.target.id, "component", n.base.slice(1), router.id, { kind: "role-path", tier: "certain", site: at(path, b.target), via: null, premises: [], rule: rule("nextjs-pages-convention"), note: null });
      continue;
    }
    const segs = [...dirs, n.base === "index" ? "" : n.base].filter((s) => s !== "");
    const pattern = `/${segs.join("/")}`;
    const api = dirs[0] === "api";
    const b = defaultHandler(path);
    register(router, path, api ? ["*"] : ["GET"], pattern, b, at(path, b.target), api ? "api" : "page");
  }

  // ---------- server actions and client components ----------
  const appRouterOf = (file: string): Router | null => {
    const project = index.projectOf(file);
    return routers.find((r) => r.project === project && r.kind === "app") ?? routers.find((r) => r.project === project) ?? null;
  };
  for (const file of index.factFiles()) {
    const router = appRouterOf(file);
    if (!router) continue;
    const directives = of(file, "directive").map((d) => d.value);
    if (directives.includes("use server")) {
      for (const s of symbolsOf(file)) {
        if (!s.exported || s.kind !== "function") continue;
        register(router, file, ["POST"], null, { status: "bound", target: s, why: null, cause: "miss" }, at(file, s), "server-action");
      }
    }
    for (const a of of(file, "action")) {
      const s = symbolAt(file, a.name, a.line) ?? topSymbol(file, a.name);
      if (s) register(router, file, ["POST"], null, { status: "bound", target: s, why: null, cause: "miss" }, at(file, s), "server-action");
    }
    if (directives.includes("use client")) {
      const lf = index.languageFacts(file);
      const names = new Set<string>();
      if (lf?.defaultExport) names.add(lf.defaultExport);
      for (const s of symbolsOf(file)) if (s.exported && s.kind === "function" && s.name.charCodeAt(0) >= 65 && s.name.charCodeAt(0) <= 90) names.add(s.name);
      for (const name of names) {
        const s = topSymbol(file, name);
        if (s) addRole(s.id, "component", "client", router.id, { kind: "declaration", tier: "certain", site: at(file, s), via: null, premises: [], rule: rule("nextjs-client-component"), note: null });
      }
    }
  }

  // ---------- middleware ----------
  for (const project of new Set(routers.map((r) => r.project))) {
    // One middleware file per project: at its root, or under src.
    const file = ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"].map((f) => join(project, f)).find((f) => index.languageFacts(f) !== null);
    if (!file) continue;
    const fn = exportedSymbol(file, "middleware") ?? defaultHandler(file).target;
    if (!fn) {
      addUnknown({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { project }, affects: ["applies_middleware"], cause: "dynamic", name: "middleware", note: "the middleware file exports no function definition named middleware and no named default export, so which routes its middleware runs for is not known", count: null, exact: false });
      continue;
    }
    const own = new Set(routers.filter((r) => r.project === project).map((r) => r.id));
    const matcher = of(file, "matcher")[0];
    const site = at(file, fn);
    addRole(fn.id, "middleware", "nextjs", null, { kind: "role-path", tier: "certain", site, via: null, premises: [], rule: rule("nextjs-middleware"), note: null });
    const parsed = matcher?.values?.map((m) => readMatcher(m)) ?? null;
    if (matcher && matcher.values === null) {
      addUnknown({ plugin: PLUGIN, site: { file, line: matcher.line, column: matcher.column }, scope: { project }, affects: ["applies_middleware"], cause: "dynamic", name: "matcher", note: "the middleware's matcher is computed, so the routes it runs for are not known", count: null, exact: false });
      continue;
    }
    // A cut list: a route no entry read selects may be selected by one past the cut.
    const cutList = matcher?.more ?? 0;
    if (cutList > 0) addUnknown({ plugin: PLUGIN, site: { file, line: matcher?.line ?? 1, column: matcher?.column ?? 1 }, scope: { project }, affects: ["applies_middleware"], cause: "fan-out-capped", name: "matcher", note: `the matcher list has ${cutList} entries past the ${matcher?.values?.length ?? 0} the plugin reads, so a route only those entries select is linked as possible`, count: cutList, exact: true });
    const tooLong = parsed?.filter((m) => m === "cap").length ?? 0;
    if (tooLong > 0) addUnknown({ plugin: PLUGIN, site: { file, line: matcher?.line ?? 1, column: matcher?.column ?? 1 }, scope: { project }, affects: ["applies_middleware"], cause: "fan-out-capped", name: "matcher", note: `${tooLong} matcher entries have more than ${MAX_PATTERN_SEGMENTS} segments, which the plugin does not compare, so a route they may select is linked as possible`, count: tooLong, exact: true });
    for (const reg of registrations) {
      if (reg.app === null || !own.has(reg.app) || reg.pattern === null) continue;
      let tier: "certain" | "possible" | null = null;
      let why: string | null = null;
      if (!parsed) tier = "certain"; // no matcher: every request
      else {
        // Once the matching budget is gone nothing more is matched; one unknown says so below.
        if (refused.matchWork > 0) break;
        const route = routeSegments(reg.pattern);
        for (const m of parsed) {
          if (m === null) {
            tier ??= "possible";
            why ??= "the middleware's matcher is a pattern the plugin does not read, so it may run for this route";
            continue;
          }
          if (m === "cap") {
            tier ??= "possible";
            why ??= `the middleware's matcher has an entry of more than ${MAX_PATTERN_SEGMENTS} segments, which the plugin does not compare, so it may run for this route`;
            continue;
          }
          if (!route) {
            tier ??= "possible";
            why ??= `the route has more segments than the ${MAX_PATTERN_SEGMENTS} the matcher reads, so the middleware may run for it`;
            continue;
          }
          if (!take("matchWork", (m.length + 1) * (route.length + 1))) break;
          if (intersects(m, route)) {
            tier = "certain";
            break;
          }
        }
        if (refused.matchWork > 0 && tier !== "certain") continue;
        if (tier === null && cutList > 0) {
          tier = "possible";
          why = `no matcher entry the plugin reads selects this route, but the list has ${cutList} entries past them`;
        }
      }
      if (tier === null || !take("middlewareEdges")) continue;
      edges.push({ from: reg.id, to: fn.id, kind: "applies_middleware", plugin: PLUGIN, app: reg.app, order: 0, evidence: { kind: "route-path", tier, site, via: null, premises: [], rule: rule("nextjs-middleware"), note: tier === "certain" ? null : why } });
    }
  }

  // ---------- what the budgets left out ----------
  // A budget or a cap counted across the whole build.
  const whole = { build: true } as const;
  const cut = (affects: FrameworkUnknown["affects"], cause: FrameworkUnknown["cause"], count: number | null, note: string) => unknowns.push({ plugin: PLUGIN, site: null, scope: whole, affects, cause, name: null, note, count, exact: count !== null });
  if (segmentsCut > 0) cut(["handles"], "fan-out-capped", segmentsCut, `${segmentsCut} files more than ${MAX_PATTERN_SEGMENTS} folders deep were not read as routes`);
  // Each build budget's record of what it cut, the only place a refused
  // take is said: a record over every budget, so a budget added without
  // one does not typecheck. Each floors every caller of the build
  // (escape-corpus/cap-fw-nextjs-build-budgets.json trips one).
  const unread = [...factCache.values()].filter((v) => v === null).length;
  const spentOut: Record<Spend, () => void> = {
    facts: () => cut(["handles"], "budget", unread, `${unread} files were not read: the Next.js plugin reads at most ${MAX_FACTS_READ} facts in one build`),
    paths: () => cut(["handles"], "budget", null, `the Next.js plugin examines at most ${MAX_PATHS} paths in one build; the routes past it are not listed`),
    registrations: () => cut(["handles"], "fan-out-capped", refused.registrations, `${refused.registrations} routes were left out: the Next.js plugin keeps at most ${MAX_REGISTRATIONS} in one build`),
    middlewareEdges: () => cut(["applies_middleware"], "fan-out-capped", refused.middlewareEdges, `${refused.middlewareEdges} middleware edges were left out: the Next.js plugin keeps at most ${MAX_MIDDLEWARE_EDGES} in one build`),
    matchWork: () => cut(["applies_middleware"], "budget", null, `the plugin stopped matching middleware to routes after ${MAX_MATCH_WORK} steps in this build; the routes past it are not linked to their middleware`),
    roles: () => cut(["handles"], "fan-out-capped", refused.roles, `${refused.roles} roles were left out: the Next.js plugin gives at most ${MAX_ROLES} roles in one build`),
    unknowns: () => cut(["handles"], "fan-out-capped", refused.unknowns, `${refused.unknowns} more unknowns past the first ${MAX_UNKNOWNS} were left out`),
  };
  for (const k of Object.keys(spentOut) as Spend[]) if (refused[k] > 0) spentOut[k]();

  return { apps, output: { roles, entities: registrations, edges, unknowns } };
}

// ---------- matching a middleware matcher against a route ----------

// A matcher segment: a literal, `:name` (one segment), `:name?` (zero or
// one), `:name*` (zero or more). `:name+` is read as `:name` then `:name*`.
type MSeg = { t: "lit"; v: string } | { t: "one" } | { t: "opt" } | { t: "any" };
// A route segment: a literal, `[id]` (one segment), `[[...rest]]` (zero or
// more). `[...rest]` is read as `[id]` then `[[...rest]]`.
type RSeg = { t: "lit"; v: string } | { t: "one" } | { t: "any" };

const isWordChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isName = (s: string): boolean => {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) if (!isWordChar(s.charCodeAt(i))) return false;
  return true;
};

// A matcher parsed into segments, "cap" when it has more than
// MAX_PATTERN_SEGMENTS segments, or null for a form this plugin does not
// read (a regular expression group, a modifier inside a segment).
function readMatcher(matcher: string): MSeg[] | "cap" | null {
  if (matcher.split("/").filter((s) => s !== "").length > MAX_PATTERN_SEGMENTS) return "cap";
  return parseMatcher(matcher);
}

// A matcher parsed into segments, or null for a form this plugin does not
// read (a regular expression group, a modifier inside a segment) or one
// longer than MAX_PATTERN_SEGMENTS segments.
export function parseMatcher(matcher: string): MSeg[] | null {
  const parts = matcher.split("/").filter((s) => s !== "");
  if (parts.length > MAX_PATTERN_SEGMENTS) return null;
  const out: MSeg[] = [];
  for (const s of parts) {
    if (s.charCodeAt(0) === 58) {
      const last = s[s.length - 1];
      const mod = last === "*" || last === "+" || last === "?" ? last : null;
      if (!isName(mod ? s.slice(1, -1) : s.slice(1))) return null;
      if (mod === "*") out.push({ t: "any" });
      else if (mod === "+") out.push({ t: "one" }, { t: "any" });
      else if (mod === "?") out.push({ t: "opt" });
      else out.push({ t: "one" });
      continue;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === ")" || c === "*" || c === "+" || c === "?" || c === ":" || c === "{" || c === "}") return null;
    }
    out.push({ t: "lit", v: s });
  }
  return out;
}

export function routeSegments(pattern: string): RSeg[] | null {
  const parts = pattern.split("/").filter((s) => s !== "");
  if (parts.length > MAX_PATTERN_SEGMENTS) return null;
  const out: RSeg[] = [];
  for (const s of parts) {
    if (s.startsWith("[[...") && s.endsWith("]]")) out.push({ t: "any" });
    else if (s.startsWith("[...") && s.endsWith("]")) out.push({ t: "one" }, { t: "any" });
    else if (s.startsWith("[") && s.endsWith("]")) out.push({ t: "one" });
    else out.push({ t: "lit", v: s });
  }
  return out;
}

// Whether some request path both matches the matcher and is served by the
// route: one pass over a grid of (matcher position, route position), each
// cell visited once, so the work is at most (m + 1) times (r + 1) cells.
export function intersects(m: readonly MSeg[], r: readonly RSeg[]): boolean {
  const width = r.length + 1;
  const seen = new Uint8Array((m.length + 1) * width);
  const stack: number[] = [0];
  seen[0] = 1;
  const go = (i: number, j: number) => {
    const k = i * width + j;
    if (i <= m.length && j <= r.length && !seen[k]) {
      seen[k] = 1;
      stack.push(k);
    }
  };
  while (stack.length > 0) {
    const k = stack.pop() as number;
    const i = Math.floor(k / width);
    const j = k % width;
    if (i === m.length && j === r.length) return true;
    const a = m[i];
    const b = r[j];
    // Zero-width moves: an optional or any-length segment on either side may match nothing.
    if (a && (a.t === "opt" || a.t === "any")) go(i + 1, j);
    if (b && b.t === "any") go(i, j + 1);
    if (!a || !b) continue;
    // One request segment matched by both sides.
    const fits = a.t !== "lit" || b.t !== "lit" || a.v === b.v;
    if (!fits) continue;
    const nextI = a.t === "any" ? i : i + 1;
    const nextJ = b.t === "any" ? j : j + 1;
    go(nextI, nextJ);
    if (a.t === "any") go(i + 1, j + 1);
    if (b.t === "any") go(i + 1, j + 1);
  }
  return false;
}
