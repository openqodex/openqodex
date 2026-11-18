// The Hono plugin's resolve step: which values are Hono applications and
// routers, which calls on them register routes (`get`, `post`, `on`, `all`,
// `openapi`), mount routers (`route`) and add middleware (`use`), what each
// registration's handler is, and the full path each application serves.
//
// API identity: a value is Hono's only when it is made by `new` of the
// `Hono` export of hono (or hono/tiny, hono/quick), of the `OpenAPIHono`
// export of @hono/zod-openapi, or by `createApp()` of a factory made by
// `createFactory()` of hono/factory, and the module resolves outside the
// repository. An OpenAPI route's method and path are read from a
// `createRoute({ method, path })` of @hono/zod-openapi, in the same file or
// in another, through its import. A dependency enables the rules; it never
// proves a receiver.
//
// Hono code builds most routers in functions: a factory makes a router,
// registers routes on it and returns it, and `app.route(prefix, factory())`
// mounts what the call returns. A call is followed into the function it
// names when that function has exactly one return the plugin reads: the
// function's parameters are bound to the call's arguments, so a wrapper
// such as `withAuth(router, mw)` that makes a shell, adds `mw` and mounts
// `router` at "/" is read as written, and one that returns its parameter
// passes the router through. A function with several returns, one the
// plugin cannot find, or a value it cannot follow is an unknown at the
// mount, never a guess.
//
// Applications: every Hono value that no mount the plugin follows reaches
// is an application (Hono serves any of them). A router that only a mount
// the plugin could not follow reaches is kept with its routes relative and
// not served (`mounted` false), so a mount it could not follow never moves a
// route to a wrong full path.
//
// Hono copies a router's routes when it is mounted, so a route added to the
// router after the mount, in the same function, is not served under it.
//
// The route files are the repository's, so a stranger controls them. Every
// cap below counts the work done across the whole build and, once reached,
// stops that work with one unknown.
import type { Detection, Entity, FrameworkEdge, FrameworkEvidence, FrameworkEvidenceKind, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { Tier } from "../../model/records.js";
import type { Expr } from "../express/js.js";
import { evaluate, MAX_ITEMS, MAX_SOURCE_BYTES, show } from "../express/js.js";
import type { HExpr, HonoFact } from "./facts.js";
import { HTTP_METHODS, MAX_SCOPE_CHAIN } from "./facts.js";

export const PLUGIN = "hono";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// Caps on one item.
export const MAX_MOUNT_DEPTH = 8; // routers deep under an application
export const MAX_CALL_DEPTH = 8; // functions followed into, one inside another, for one value
export const MAX_MIDDLEWARE_CHAIN = 64; // middleware kept for one route

// Budgets for the whole build.
export const MAX_FACTS_READ = 400_000;
export const MAX_LOOKUPS = 200_000;
export const MAX_STEPS = 1_000_000; // values followed, every name and call together
export const MAX_MOUNTS = 2000;
export const MAX_REGISTRATIONS = 10000;
export const MAX_MIDDLEWARE_EDGES = 30_000;
export const MAX_UNKNOWNS = 5000;
export const MAX_APPS = 2000;
export const MAX_ROLES = 20_000;

type Spend = "facts" | "lookups" | "steps" | "mounts" | "registrations" | "middlewareEdges" | "apps" | "roles";
const LIMIT: Record<Spend, number> = { facts: MAX_FACTS_READ, lookups: MAX_LOOKUPS, steps: MAX_STEPS, mounts: MAX_MOUNTS, registrations: MAX_REGISTRATIONS, middlewareEdges: MAX_MIDDLEWARE_EDGES, apps: MAX_APPS, roles: MAX_ROLES };

type Fact<K extends HonoFact["kind"]> = Extract<HonoFact, { kind: K }>;

// One function call followed: the function's file and its scope key (the
// line it starts on, see facts.ts), its parameters bound to the call's
// arguments where the call was made, and a key naming the chain of calls
// that led here.
type Ctx = { file: string; fn: number; args: Map<string, { e: HExpr; w: Where }>; key: string; depth: number };
// Where an expression is read: its file, the function scope around it,
// and the call it was reached through (null: read as written, no call).
type Where = { file: string; scope: number; ctx: Ctx | null };

// A Hono value made at one site, reached through `ctx`. `bases`: the
// basePath paths of the chain it was reached through, outermost last.
type Inst = { key: string; file: string; line: number; column: number; ctx: Ctx | null; bases: { e: Expr; w: Where }[] };
type Gap = { k: "gap"; cause: FrameworkUnknown["cause"]; note: string; name: string | null; viaCall?: boolean };
type Res = { k: "inst"; inst: Inst } | { k: "param"; name: string; type: string | null; named: boolean } | Gap | { k: "none" };
type Deref = { k: "expr"; w: Where; e: HExpr } | { k: "param"; name: string; type: string | null; named: boolean } | Gap | { k: "none" };

type Identity = {
  ctors: Map<string, string>; // local name to the class it is: Hono, OpenAPIHono
  spaces: Map<string, string>; // namespace local to its module
  createRoute: Set<string>;
  createFactory: Set<string>;
  types: Set<string>; // locals of the Hono and OpenAPIHono types, for typed parameters
};

type FileIndex = {
  values: Map<string, Fact<"value">[]>;
  params: Map<string, Fact<"param">[]>;
  fns: Map<string, Fact<"fn">[]>;
  fnAt: Map<number, Fact<"fn">>;
  returns: Map<number, Fact<"return">[]>;
  calls: Fact<"call">[];
  tooLarge: Fact<"too-large"> | null;
  syntaxError: Fact<"syntax-error"> | null;
  scopes: Map<number, Fact<"scope">>;
  unread: boolean;
};

const METHOD_SET = new Set<string>(HTTP_METHODS);
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);
const HONO_MODULES = new Set(["hono", "hono/tiny", "hono/quick"]);
const OPENAPI_MODULE = "@hono/zod-openapi";
const FACTORY_MODULE = "hono/factory";

export type Analysis = { apps: Detection[]; output: PluginOutput };
const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<HonoFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

const showH = (e: HExpr): string => (e.t === "new" ? `new ${e.ctor?.join(".") ?? "a class"}()` : e.t === "via" ? `${show(e.base)}...` : show(e));

// An OpenAPI path as Hono serves it: each `/{name}` becomes `/:name`, as
// @hono/zod-openapi converts it (`replaceAll(/\/{(.+?)}/g, "/:$1")`: the
// name runs to the first `}` after at least one character). A linear scan
// of the text, no pattern: the next `}` is searched for only once the scan
// has passed the last one found.
export function honoPath(p: string): string {
  let out = "";
  // The next `}` from i + 3, and the next line break from i + 2 (the
  // library's `.` stops at one); each is searched again only once passed.
  const next = (ch: string, from: number, last: number): number => {
    if (last === Number.POSITIVE_INFINITY || last >= from) return last;
    const at = p.indexOf(ch, from);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  let close = -1;
  let br = -1;
  for (let i = 0; i < p.length; ) {
    if (p[i] === "/" && p[i + 1] === "{") {
      close = next("}", i + 3, close);
      br = next("\n", i + 2, br);
      if (close !== Number.POSITIVE_INFINITY && close < br) {
        out += `/:${p.slice(i + 2, close)}`;
        i = close + 1;
        continue;
      }
    }
    out += p[i];
    i++;
  }
  return out;
}

const segs = (p: string): string[] => p.split("/").filter((s) => s !== "");
export const joinPath = (a: string, b: string): string => `/${[...segs(a), ...segs(b)].join("/")}`;

// Whether a middleware path of `use` covers a route's full pattern: `*`
// covers every route, a path ending in `/*` the routes at or under it, any
// other path the route it names; a `:name` segment of the middleware path
// matches any one segment. A route segment the middleware path names by a
// literal must be the same literal.
function covers(use: string | null, route: string | null): boolean {
  if (use === null) return true;
  if (route === null) return false;
  const u = segs(use);
  const r = segs(route);
  const star = u[u.length - 1] === "*";
  const head = star ? u.slice(0, -1) : u;
  if (star ? r.length < head.length : r.length !== head.length) return false;
  return head.every((s, i) => s === r[i] || s === "*" || s.startsWith(":"));
}

function run(index: PluginIndex<HonoFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];
  const apps: Detection[] = [];

  const spent: Record<Spend, number> = { facts: 0, lookups: 0, steps: 0, mounts: 0, registrations: 0, middlewareEdges: 0, apps: 0, roles: 0 };
  const refused: Record<Spend, number> = { facts: 0, lookups: 0, steps: 0, mounts: 0, registrations: 0, middlewareEdges: 0, apps: 0, roles: 0 };
  const take = (k: Spend, n = 1): boolean => {
    if (spent[k] + n > LIMIT[k]) {
      refused[k] += n;
      return false;
    }
    spent[k] += n;
    return true;
  };
  const exhausted = (k: Spend): boolean => refused[k] > 0;
  let unknownsLeftOut = 0;
  const seenUnknown = new Set<string>();
  const addUnknown = (u: FrameworkUnknown) => {
    const key = `${u.cause}\0${u.site ? `${u.site.file}:${u.site.line}:${u.site.column}` : JSON.stringify(u.scope)}\0${u.note}`;
    if (seenUnknown.has(key)) return;
    seenUnknown.add(key);
    if (unknowns.length >= MAX_UNKNOWNS) unknownsLeftOut++;
    else unknowns.push(u);
  };
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (!take("lookups")) return { kind: "gap", cause: "budget", note: `the Hono plugin makes at most ${MAX_LOOKUPS} lookups in one build`, candidates: null };
    return index.lookup(file, path);
  };

  const npmProject = (file: string): string => index.projectOf(file);
  const enabled = new Map<string, boolean>();
  const isEnabled = (file: string): boolean => {
    const project = npmProject(file);
    let on = enabled.get(project);
    if (on === undefined) {
      on = index.declares(project, "npm", "hono") || index.declares(project, "npm", OPENAPI_MODULE);
      enabled.set(project, on);
    }
    return on;
  };

  const fileIndexes = new Map<string, FileIndex>();
  const fx = (file: string): FileIndex => {
    let f = fileIndexes.get(file);
    if (f) return f;
    f = { values: new Map(), params: new Map(), fns: new Map(), fnAt: new Map(), returns: new Map(), calls: [], tooLarge: null, syntaxError: null, scopes: new Map(), unread: false };
    fileIndexes.set(file, f);
    const list = isEnabled(file) ? index.factsOf(file) : [];
    if (!take("facts", list.length)) {
      f.unread = true;
      return f;
    }
    for (const fact of list) {
      switch (fact.kind) {
        case "value":
          push(f.values, fact.name, fact);
          break;
        case "param":
          push(f.params, fact.name, fact);
          break;
        case "fn":
          push(f.fns, fact.name, fact);
          if (!f.fnAt.has(fact.key)) f.fnAt.set(fact.key, fact);
          break;
        case "return":
          push(f.returns, fact.scope, fact);
          break;
        case "call":
          f.calls.push(fact);
          break;
        case "too-large":
          f.tooLarge = fact;
          break;
        case "syntax-error":
          f.syntaxError = fact;
          break;
        case "scope":
          if (!f.scopes.has(fact.key)) f.scopes.set(fact.key, fact);
          break;
      }
    }
    return f;
  };

  // ---------- bindings ----------
  const bindingScope = (file: string, scope: number, name: string): number => {
    let s = scope;
    for (let steps = 0; s !== 0; steps++) {
      if (steps >= MAX_SCOPE_CHAIN) return scope;
      const info = fx(file).scopes.get(s);
      if (!info) return s;
      if (info.all || info.names.includes(name)) return s;
      s = info.parent;
    }
    return 0;
  };
  const writesCache = new Map<string, Fact<"value">[]>();
  const writesOf = (file: string, name: string, at: number): Fact<"value">[] => {
    const key = `${file}\0${name}\0${at}`;
    const kept = writesCache.get(key);
    if (kept) return kept;
    const out = (fx(file).values.get(name) ?? []).filter((v) => (v.decl === "assign" ? bindingScope(file, v.scope, name) : v.scope) === at);
    writesCache.set(key, out);
    return out;
  };
  const constant = (file: string, scope: number) => (path: string[]): string | null => {
    if (path.length !== 1) return null;
    const name = path[0] as string;
    const writes = writesOf(file, name, bindingScope(file, scope, name));
    const only = writes.length === 1 ? (writes[0] as Fact<"value">) : null;
    return only && only.value.t === "str" ? only.value.v : null;
  };

  // ---------- which local names are Hono's ----------
  const identities = new Map<string, Identity>();
  const identity = (file: string): Identity => {
    let id = identities.get(file);
    if (id) return id;
    id = { ctors: new Map(), spaces: new Map(), createRoute: new Set(), createFactory: new Set(), types: new Set() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf) return id;
    const outside = (spec: string) => take("lookups") && index.module(file, spec).kind === "external";
    for (const imp of lf.imports) {
      if (imp.scoped) continue;
      const hono = HONO_MODULES.has(imp.spec);
      const openapi = imp.spec === OPENAPI_MODULE;
      const factory = imp.spec === FACTORY_MODULE;
      if ((!hono && !openapi && !factory) || !outside(imp.spec)) continue;
      if (imp.namespace) id.spaces.set(imp.namespace, imp.spec);
      for (const n of imp.names) {
        const cls = (hono && n.imported === "Hono") || (openapi && n.imported === "OpenAPIHono") ? n.imported : null;
        if (cls) {
          id.types.add(n.local);
          if (!imp.typeOnly) id.ctors.set(n.local, cls);
        }
        if (!imp.typeOnly && openapi && n.imported === "createRoute") id.createRoute.add(n.local);
        if (!imp.typeOnly && factory && n.imported === "createFactory") id.createFactory.add(n.local);
      }
    }
    return id;
  };
  // The class a callee path names in a file at a scope, when it is Hono's
  // own: a local name no function around it shadows, or `ns.Hono` of a
  // namespace import.
  const honoClass = (file: string, scope: number, path: readonly string[] | null): string | null => {
    if (!path || path.length === 0 || path.length > 2) return null;
    const id = identity(file);
    const head = path[0] as string;
    if (bindingScope(file, scope, head) !== 0) return null;
    if (path.length === 1) return id.ctors.get(head) ?? null;
    const spec = id.spaces.get(head);
    const name = path[1] as string;
    if (spec && HONO_MODULES.has(spec) && name === "Hono") return name;
    if (spec === OPENAPI_MODULE && name === "OpenAPIHono") return name;
    return null;
  };
  const importedFn = (file: string, scope: number, path: readonly string[], set: "createRoute" | "createFactory", spec: string): boolean => {
    const id = identity(file);
    const head = path[0] as string;
    if (bindingScope(file, scope, head) !== 0) return false;
    if (path.length === 1) return id[set].has(head);
    return path.length === 2 && id.spaces.get(head) === spec && path[1] === set;
  };

  // ---------- following a value ----------
  const gap = (cause: FrameworkUnknown["cause"], note: string, name: string | null = null): Gap => ({ k: "gap", cause, note, name });
  const outOfSteps = (): Gap => gap("budget", `the Hono plugin follows at most ${MAX_STEPS} values in one build`);

  const topValue = (file: string, name: string): Fact<"value"> | null => (fx(file).values.get(name) ?? []).find((v) => v.top) ?? null;
  // The value a module exports under a name, as written in that module.
  const exported = (file: string, name: string): Deref => {
    const lf = index.languageFacts(file);
    let local: string | null = null;
    if (name === "default") local = lf?.defaultExport ?? null;
    const direct = (fx(file).values.get(name) ?? []).find((v) => v.top && v.exported);
    if (direct) local = direct.name;
    local ??= lf?.exportsLocal.find((x) => x.exported === name)?.local ?? null;
    if (!local) return { k: "none" };
    const decl = topValue(file, local);
    return decl ? { k: "expr", w: { file, scope: 0, ctx: null }, e: { t: "ref", path: [local], line: decl.line, column: decl.column } } : { k: "none" };
  };
  // The file and name the one import of the file that binds `name` names.
  // The graph binds a value exported through a clause (`const app = new
  // Hono(); export { app }`) to nothing, since it is no definition, so its
  // import is followed here, to that module's own export table.
  const importedFrom = (file: string, name: string): { file: string; name: string } | null => {
    const imps = (index.languageFacts(file)?.imports ?? []).filter((i) => !i.scoped && !i.reexport && !i.typeOnly && i.names.some((n) => n.local === name));
    const imp = imps.length === 1 ? imps[0] : undefined;
    const imported = imp?.names.find((n) => n.local === name)?.imported;
    if (!imp || !imported || !take("lookups")) return null;
    const m = index.module(file, imp.spec);
    return m.kind === "module" ? { file: m.file, name: imported } : null;
  };
  const fromImport = (file: string, path: readonly string[]): Deref => {
    let found: Lookup = lookup(file, path);
    let target: { file: string; name: string } | null = null;
    if (found.kind === "miss") target = { file: found.target, name: found.name };
    else if (found.kind === "none" && path.length === 1) target = importedFrom(file, path[0] as string);
    else if (found.kind === "none" && path.length === 2) {
      found = lookup(file, [path[0] as string]);
      if (found.kind === "module") target = { file: found.file, name: path[1] as string };
    } else if (found.kind === "symbol") {
      // A definition the graph holds (a function, a class): its module's export of that name.
      const node = found.ids.length === 1 ? index.node(found.ids[0] as string) : null;
      if (node && !node.name.includes(".")) target = { file: node.file, name: node.name };
    } else if (found.kind === "external") return gap("external", `${path.join(".")} comes from a declared dependency`, path.join("."));
    else if (found.kind === "gap") return gap(found.cause, found.note, path.join("."));
    if (!target || !index.languageFacts(target.file)) return { k: "none" };
    return exported(target.file, target.name);
  };

  // An expression followed through the names it reads, to what is written
  // where the value is made: a single write of a local, a module value, an
  // import, or a parameter's argument at the call that was followed.
  const deref = (w: Where, e: HExpr, depth = 0): Deref => {
    if (!take("steps")) return outOfSteps();
    if (depth > MAX_MOUNT_DEPTH * 2) return gap("fan-out-capped", `the value ${showH(e)} is passed through more names than the plugin follows`, showH(e));
    if (e.t !== "ref") return { k: "expr", w, e };
    const name = e.path[0] as string;
    const at = bindingScope(w.file, w.scope, name);
    const writes = writesOf(w.file, name, at);
    if (e.path.length === 1 && writes.length > 0) {
      if (writes.length > 1) return gap("dynamic", `${name} is assigned more than once, so which value it holds is decided at run time`, name);
      const decl = writes[0] as Fact<"value">;
      if (decl.value.t === "ref" && decl.value.path.length === 1 && decl.value.path[0] === name) return { k: "none" };
      return deref({ file: w.file, scope: decl.scope, ctx: w.ctx }, decl.value, depth + 1);
    }
    if (at !== 0) {
      if (e.path.length !== 1) return { k: "none" };
      const ctx = w.ctx;
      if (ctx && ctx.file === w.file && ctx.fn === at) {
        const arg = ctx.args.get(name);
        if (arg) return deref(arg.w, arg.e, depth + 1);
        return { k: "none" };
      }
      const fn = fx(w.file).fnAt.get(at);
      if (fn && fn.params.includes(name)) {
        const typed = (fx(w.file).params.get(name) ?? []).find((p) => p.scope === at);
        const ids = identity(w.file);
        const honoTyped = typed && ((typed.type.length === 1 && ids.types.has(typed.type[0] as string)) || (typed.type.length === 2 && ids.spaces.has(typed.type[0] as string) && (typed.type[1] === "Hono" || typed.type[1] === "OpenAPIHono")));
        return { k: "param", name, type: honoTyped && typed ? typed.type.join(".") : null, named: typed !== undefined };
      }
      return { k: "none" };
    }
    if (writes.length > 0) return { k: "none" };
    const out = fromImport(w.file, e.path);
    return out.k === "expr" ? deref(out.w, out.e, depth + 1) : out;
  };

  // The function a callee names: a local or module function, or one an import brings.
  type FnRef = { k: "fn"; file: string; fn: Fact<"fn"> } | Gap;
  const fnOf = (w: Where, callee: Expr): FnRef => {
    if (callee.t !== "ref" || callee.path.length > 2) return gap("unsupported-rule", `the router is the value ${show(callee)}(...) returns, which the plugin does not follow`, show(callee));
    const name = callee.path[0] as string;
    if (callee.path.length === 1) {
      const at = bindingScope(w.file, w.scope, name);
      const declared = (fx(w.file).fns.get(name) ?? []).filter((f) => f.scope === at);
      if (declared.length === 1) return { k: "fn", file: w.file, fn: declared[0] as Fact<"fn"> };
      if (declared.length > 1) return gap("ambiguous", `${name} names ${declared.length} functions here`, name);
      if (at !== 0 || writesOf(w.file, name, 0).length > 0) return gap("dynamic", `${name} is a value the code computes, not a function the plugin can read`, name);
    }
    const found = lookup(w.file, callee.path);
    const label = callee.path.join(".");
    switch (found.kind) {
      case "symbol": {
        const node = found.ids.length === 1 ? index.node(found.ids[0] as string) : null;
        if (!node) return gap("ambiguous", `${label} binds to ${found.ids.length} definitions`, label);
        const last = node.name.split(".").pop() as string;
        const fns = (fx(node.file).fns.get(last) ?? []).filter((f) => f.scope === 0);
        const fn = fns.find((f) => f.line === node.startLine) ?? (fns.length === 1 ? fns[0] : undefined);
        return fn ? { k: "fn", file: node.file, fn } : gap("unsupported-rule", `${label} is not a function the plugin reads`, label);
      }
      case "miss": {
        const fns = (fx(found.target).fns.get(found.name) ?? []).filter((f) => f.scope === 0);
        if (fns.length === 1) return { k: "fn", file: found.target, fn: fns[0] as Fact<"fn"> };
        return gap("miss", `${label} names ${found.name} in ${found.target}, where no such function exists now`, label);
      }
      case "external":
        return gap("external", `${label} comes from a declared dependency, so the router it returns is not read`, label);
      case "gap":
        return gap(found.cause, found.note, label);
      default:
        return gap("miss", `no definition named ${label} is in scope`, label);
    }
  };

  // What an expression is: a Hono value made at one site (through the
  // chain, names and calls it was reached by), a parameter, a gap, or none
  // of these. `calls`: whether a function call may be followed into (a
  // receiver is read as written, so a router a call returns is no receiver).
  // `mark` hears of every Hono value the walk reaches, a function's every
  // return included, even where it then stops at a gap.
  const value = (w0: Where, e0: HExpr, calls: boolean, mark: ((i: Inst) => void) | null, depth = 0): Res => {
    const d = deref(w0, e0);
    if (d.k !== "expr") return d;
    const { w, e } = d;
    switch (e.t) {
      case "new": {
        if (!honoClass(w.file, w.scope, e.ctor)) return { k: "none" };
        const inst: Inst = { key: `${w.file}:${e.line}:${e.column}`, file: w.file, line: e.line, column: e.column, ctx: w.ctx, bases: e.bases.map((b) => ({ e: b, w })) };
        mark?.(inst);
        return { k: "inst", inst };
      }
      case "via": {
        const r = value(w, e.base, calls, mark, depth + 1);
        if (r.k !== "inst") return r;
        return { k: "inst", inst: { ...r.inst, bases: [...r.inst.bases, ...e.bases.map((b) => ({ e: b, w }))] } };
      }
      case "call": {
        // `factory.createApp()` of a factory made by hono/factory's createFactory().
        const fn = e.fn;
        if ((fn.t === "ref" && fn.path.length === 2 && fn.path[1] === "createApp") || (fn.t === "member" && fn.prop === "createApp")) {
          const made = fn.t === "ref" ? deref(w, { t: "ref", path: [fn.path[0] as string], line: fn.line, column: fn.column }) : ({ k: "expr", w, e: fn.obj } as Deref);
          if (made.k === "expr" && made.e.t === "call" && made.e.fn.t === "ref" && importedFn(made.w.file, made.w.scope, made.e.fn.path, "createFactory", FACTORY_MODULE)) {
            const inst: Inst = { key: `${w.file}:${e.line}:${e.column}`, file: w.file, line: e.line, column: e.column, ctx: w.ctx, bases: [] };
            mark?.(inst);
            return { k: "inst", inst };
          }
          return { k: "none" };
        }
        if (!calls) return { ...gap("unsupported-rule", `routes added to the router ${show(e)} returns are not read`, show(fn)), viaCall: true };
        const target = fnOf(w, fn);
        if (target.k === "gap") return target;
        const ctxDepth = (w.ctx?.depth ?? 0) + 1;
        if (ctxDepth > MAX_CALL_DEPTH || depth > MAX_CALL_DEPTH * 4) return gap("fan-out-capped", `the router passes through more than ${MAX_CALL_DEPTH} function calls, past what the plugin follows`, show(fn));
        const rets = fx(target.file).returns.get(target.fn.key) ?? [];
        const label = target.fn.name;
        const args = new Map<string, { e: HExpr; w: Where }>();
        target.fn.params.forEach((p, i) => {
          const a = e.args[i];
          if (p !== null && a) args.set(p, { e: a, w });
        });
        const ctx: Ctx = { file: target.file, fn: target.fn.key, args, key: `${w.ctx?.key ?? ""}@${w.file}:${e.line}:${e.column}`, depth: ctxDepth };
        const inner: Where = { file: target.file, scope: target.fn.key, ctx };
        if (rets.length !== 1) {
          for (const r of rets) value(inner, r.value, calls, mark, depth + 1);
          if (rets.length === 0) return gap("unsupported-rule", `${label} returns no value the plugin reads`, label);
          return gap("dynamic", `${label} returns from ${rets.length} places, so which router it gives is decided at run time`, label);
        }
        const out = value(inner, (rets[0] as Fact<"return">).value, calls, mark, depth + 1);
        if (out.k === "none" || out.k === "param") return gap("unsupported-rule", `${label} returns ${showH((rets[0] as Fact<"return">).value)}, which the plugin cannot follow to a Hono router`, label);
        return out;
      }
      default:
        return { k: "none" };
    }
  };

  // ---------- OpenAPI route definitions ----------
  type RouteDef = { method: string; path: Expr; w: Where };
  const routeDef = (w0: Where, e0: HExpr): RouteDef | Gap | null => {
    const d = deref(w0, e0);
    if (d.k === "gap") return d;
    if (d.k !== "expr") return null;
    const { w, e } = d;
    if (e.t !== "call" || e.fn.t !== "ref" || !importedFn(w.file, w.scope, e.fn.path, "createRoute", OPENAPI_MODULE)) return null;
    const obj = e.args[0];
    if (!obj || obj.t !== "object") return gap("dynamic", "the route definition is not an object written in place", null);
    const m = obj.props.find((p) => p.key === "method")?.value;
    const path = obj.props.find((p) => p.key === "path")?.value;
    const method = m ? evaluate(m, constant(w.file, w.scope)) : null;
    if (!method || !ROUTE_METHODS.has(method.toUpperCase()) || !path) return gap("dynamic", "the route definition's method is computed or missing", null);
    return { method: method.toUpperCase(), path, w };
  };

  // A path argument: a literal, a constant, or a computed string.
  const pathLike = (w: Where, e: HExpr | undefined): boolean => e !== undefined && (e.t === "str" || e.t === "dyn" || (e.t === "ref" && evaluate(e, constant(w.file, w.scope)) !== null));

  // ---------- events on each Hono value ----------
  type Base = { type: "route" | "use" | "openapi" | "mount" | "foreign"; file: string; site: Site; scope: number; f: Fact<"call">; bases: { e: Expr; w: Where }[] };
  const events = new Map<string, Base[]>();
  const sites = new Map<string, { inst: Inst; name: string | null }>();
  const noteSite = (inst: Inst, name: string | null) => {
    const had = sites.get(inst.key);
    if (!had) sites.set(inst.key, { inst: { ...inst, ctx: null, bases: [] }, name });
    else if (had.name === null && name !== null) had.name = name;
  };
  const paramRoutes: { name: string; type: string; ev: Base }[] = [];
  const typeOf = (prop: string): Base["type"] | null => (METHOD_SET.has(prop) || prop === "on" ? "route" : prop === "use" ? "use" : prop === "openapi" ? "openapi" : prop === "route" ? "mount" : prop === "mount" ? "foreign" : null);

  const files = index.factFiles().filter(isEnabled);
  let unreadFiles = 0;
  for (const file of files) {
    const fi = fx(file);
    if (fi.unread) {
      unreadFiles++;
      continue;
    }
    if (fi.tooLarge) {
      addUnknown({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "file-not-parsed", name: null, note: `the file is ${fi.tooLarge.bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte cap of the Hono plugin, so its routes were not read`, count: null, exact: false });
      continue;
    }
    if (fi.syntaxError) addUnknown({ plugin: PLUGIN, site: { file, line: fi.syntaxError.line, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "file-not-parsed", name: null, note: `the file has ${fi.syntaxError.regions} region(s) the parser could not read, the first at line ${fi.syntaxError.line}; no route was read from them`, count: fi.syntaxError.regions, exact: true });
    // Every Hono value a declaration or a return makes, with the name it is bound to.
    for (const list of fi.values.values()) for (const v of list) if (v.value.t === "new" || v.value.t === "via" || v.value.t === "call") {
      const r = value({ file, scope: v.scope, ctx: null }, v.value, false, null);
      if (r.k === "inst" && r.inst.file === file) noteSite(r.inst, v.name);
    }
    for (const list of fi.returns.values()) for (const ret of list) {
      if (ret.value.t !== "new" && ret.value.t !== "via") continue;
      const r = value({ file, scope: ret.scope, ctx: null }, ret.value, false, null);
      if (r.k === "inst") noteSite(r.inst, null);
    }
    for (const f of fi.calls) {
      const type = typeOf(f.prop);
      if (!type) continue;
      const site: Site = { file, line: f.line, column: f.column };
      const w: Where = { file, scope: f.scope, ctx: null };
      const r = value(w, f.recv, false, null);
      if (r.k === "inst") {
        noteSite(r.inst, null);
        push(events, r.inst.key, { type, file, site, scope: f.scope, f, bases: r.inst.bases });
        continue;
      }
      // A use on a parameter (typed or not), or on the router a call is proved
      // to return: which router it changes is decided where the value comes
      // from, which the plugin does not follow from here. The middleware is
      // applied to no route, and the chains it may change are unknown.
      if (type === "use" && (r.k === "param" || (r.k === "gap" && r.viaCall === true && value(w, f.recv, true, null).k === "inst"))) {
        const on = r.k === "param" ? `the parameter ${r.name}` : `the router ${showH(f.recv)} returns`;
        addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["applies_middleware"], cause: r.k === "param" ? "dynamic" : "unsupported-rule", name: showH(f.recv), note: `use is called on ${on}, which the plugin does not follow to a router, so the middleware it adds is applied to no route; the middleware chains of the routes it may cover are not known whole`, count: null, exact: false });
        continue;
      }
      // A route on a parameter with no type written as a name (none, `any`,
      // `unknown`): the caller decides which router it lands on, which the
      // plugin does not follow from here, so the route is not listed and is
      // an unknown. A call no route could be (`c.get("user")`, one
      // argument) is no route.
      if (r.k === "param" && !r.named && ((type === "route" && f.args.length >= (f.prop === "on" ? 3 : 2) && pathLike(w, f.args[f.prop === "on" ? 1 : 0])) || (type === "openapi" && f.args.length >= 2))) {
        addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["handles", "mounts"], cause: "dynamic", name: showH(f.recv), note: `a route is registered on the parameter ${r.name}, which has no type the plugin reads, so which router it lands on, and under which prefix, is decided by the caller; it is not listed as a route`, count: null, exact: false });
        continue;
      }
      if (r.k === "param" && r.type !== null) {
        if (type === "route" || type === "openapi") paramRoutes.push({ name: r.name, type: r.type, ev: { type, file, site, scope: f.scope, f, bases: [] } });
        continue;
      }
      // A route definition or a router on a receiver the plugin cannot follow.
      const proved = type === "openapi" && f.args[0] ? routeDef(w, f.args[0]) : type === "mount" && f.args[1] ? value(w, f.args[1], true, null) : null;
      const isRoute = proved !== null && "method" in proved;
      const isRouter = proved !== null && "k" in proved && proved.k === "inst";
      // A route on the router a call returns: said only when the call is proved to return one.
      const onReturned = r.k === "gap" && r.viaCall === true && type !== "use" && value(w, f.recv, true, null).k === "inst";
      if (isRoute || isRouter || onReturned) {
        const why = r.k === "gap" ? r.note : `the plugin cannot follow ${showH(f.recv)} to a Hono value`;
        addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["handles", "mounts"], cause: "unsupported-rule", name: showH(f.recv), note: `${isRoute ? "an OpenAPI route is registered" : isRouter ? "a router is mounted" : "a route is registered"} on ${showH(f.recv)}, and ${why}; the routes it adds are not listed`, count: null, exact: false });
      }
    }
  }
  for (const list of events.values()) list.sort((a, b) => (a.file === b.file ? a.site.line - b.site.line || a.site.column - b.site.column : a.file < b.file ? -1 : 1));

  // Every value a mount the plugin follows may reach, read as written (no
  // application around it): a router mounted, every return of a function
  // whose result is mounted, and every Hono value passed into one.
  const reachable = new Set<string>();
  // A router a mounted call returns through more calls than `value` follows
  // is still mounted, never an application: every function the call may
  // return through is visited once, with no depth cap and no arguments.
  const reachedFns = new Set<string>();
  const reach = (w0: Where, e0: HExpr) => {
    const work: { w: Where; e: HExpr }[] = [{ w: w0, e: e0 }];
    while (work.length > 0) {
      const { w, e } = work.pop() as { w: Where; e: HExpr };
      const d = deref(w, e);
      if (d.k !== "expr") continue;
      if (d.e.t === "new") reachable.add(`${d.w.file}:${d.e.line}:${d.e.column}`);
      else if (d.e.t === "via") work.push({ w: d.w, e: d.e.base });
      else if (d.e.t === "call") {
        const t = fnOf(d.w, d.e.fn);
        if (t.k === "gap" || reachedFns.has(`${t.file}:${t.fn.key}`)) continue;
        reachedFns.add(`${t.file}:${t.fn.key}`);
        for (const r of fx(t.file).returns.get(t.fn.key) ?? []) work.push({ w: { file: t.file, scope: t.fn.key, ctx: null }, e: r.value });
      }
    }
  };
  const markAll = (w: Where, e: HExpr, depth: number) => {
    if (depth > MAX_CALL_DEPTH) return;
    value(w, e, true, (i) => reachable.add(i.key));
    reach(w, e);
    const d = deref(w, e);
    if (d.k === "expr" && d.e.t === "call") for (const a of d.e.args) markAll(d.w, a, depth + 1);
  };
  for (const [key, list] of events) {
    for (const ev of list) {
      if (ev.type !== "mount" || !ev.f.args[1]) continue;
      const before = reachable.has(key);
      markAll({ file: ev.file, scope: ev.scope, ctx: null }, ev.f.args[1], 0);
      // A router mounting itself does not make it a mounted router.
      if (!before) reachable.delete(key);
    }
  }

  // ---------- handlers and middleware ----------
  type Bound = { status: HandlerStatus; targets: string[]; tier: Tier; kind: FrameworkEvidenceKind; via: FrameworkEvidence["via"]; note: string | null; why: { cause: FrameworkUnknown["cause"]; note: string; name: string | null } | null };
  const none = (status: HandlerStatus, cause: FrameworkUnknown["cause"], note: string, name: string | null): Bound => ({ status, targets: [], tier: "certain", kind: "route-call", via: null, note: null, why: { cause, note, name } });
  // The definition a local function's binding holds, by the line and name the graph gives it.
  const symbolAt = (file: string, line: number, name: string): string | null => index.symbols(file).find((n) => n.startLine === line && (n.name === name || n.name.endsWith(`.${name}`)))?.id ?? null;
  const bindFn = (w: Where, e: HExpr, role: "handler" | "middleware", depth = 0): Bound => {
    if (!take("steps")) return none("unresolved", "budget", `the Hono plugin follows at most ${MAX_STEPS} values in one build`, null);
    if (e.t === "fn") return none("unresolved", "unsupported-rule", `the ${role} is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it`, null);
    if (e.t === "call") {
      const inner = e.args.find((a) => a.t === "ref");
      if (role === "middleware") {
        const fn = e.fn.t === "ref" ? lookup(w.file, e.fn.path) : null;
        if (fn?.kind === "symbol") return { status: "bound", targets: fn.ids, tier: "possible", kind: "route-call", via: fn.via, note: `the middleware is the value ${show(e)} returns`, why: null };
        return none(fn?.kind === "external" ? "external" : "unresolved", fn?.kind === "external" ? "external" : "unsupported-rule", `the middleware is the value ${show(e)} returns`, null);
      }
      return none("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether ${show(e.fn)} calls ${inner ? showH(inner) : "what it is given"} is not proved, so the handler is not bound`, inner ? showH(inner) : show(e.fn));
    }
    if (e.t !== "ref") return none("dynamic", "dynamic", `the ${role} is computed (${showH(e)})`, null);
    const name = e.path[0] as string;
    const at = bindingScope(w.file, w.scope, name);
    if (at !== 0 && e.path.length === 1) {
      const ctx = w.ctx;
      const arg = ctx && ctx.file === w.file && ctx.fn === at ? ctx.args.get(name) : undefined;
      if (arg && depth < MAX_CALL_DEPTH) return bindFn(arg.w, arg.e, role, depth + 1);
      const writes = writesOf(w.file, name, at);
      const decl = writes.length === 1 ? (writes[0] as Fact<"value">) : null;
      if (decl && decl.value.t === "fn") {
        const id = symbolAt(w.file, decl.value.line, name);
        if (id) return { status: "bound", targets: [id], tier: "certain", kind: "route-call", via: null, note: null, why: null };
      }
      if (decl && (decl.value.t === "ref" || decl.value.t === "call") && depth < MAX_CALL_DEPTH) return bindFn({ file: w.file, scope: decl.scope, ctx: w.ctx }, decl.value, role, depth + 1);
      const fn = (fx(w.file).fns.get(name) ?? []).filter((f) => f.scope === at);
      if (writes.length === 0 && fn.length === 1) {
        const id = symbolAt(w.file, (fn[0] as Fact<"fn">).line, name);
        if (id) return { status: "bound", targets: [id], tier: "certain", kind: "route-call", via: null, note: null, why: null };
      }
      if (fx(w.file).fnAt.get(at)?.params.includes(name)) return none("dynamic", "dynamic", `the ${role} ${name} is a parameter, so the caller decides what it is`, name);
      return none("dynamic", "dynamic", `the ${role} ${name} is a value the code computes, not a definition`, name);
    }
    const found = lookup(w.file, e.path);
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, kind: "route-call", via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${role}'s binding is ${found.tier}`), why: null };
      case "miss":
        return none("missing", "miss", `the ${role} ${showH(e)} names ${found.name} in ${found.target}, where no such definition exists now`, showH(e));
      case "external":
        return none("external", "external", `${showH(e)} comes from a declared dependency`, showH(e));
      case "gap":
        return none(found.cause === "ambiguous" ? "ambiguous" : "unresolved", found.cause, found.note, showH(e));
      default: {
        const isLocal = fx(w.file).values.has(name) || fx(w.file).params.has(name);
        if (isLocal) return none("dynamic", "dynamic", `the ${role} ${showH(e)} is a value the code computes, not a definition`, showH(e));
        return none("missing", "miss", `no definition named ${showH(e)} is in scope`, showH(e));
      }
    }
  };

  // A middleware is bound once for each call context it is read in, not once
  // for every route it applies to.
  const boundMw = new Map<string, Bound>();
  const bindMw = (w: Where, e: HExpr): Bound => {
    const key = `${w.file}:${e.line}:${e.column}@${w.ctx?.key ?? ""}`;
    const known = boundMw.get(key);
    if (known) return known;
    const b = bindFn(w, e, "middleware");
    if (b.why?.cause !== "budget") boundMw.set(key, b);
    return b;
  };

  const middlewareGap = (site: Site, b: Bound) => {
    if (!b.why || b.status === "external") return;
    addUnknown({ plugin: PLUGIN, site, scope: { file: site.file }, affects: ["applies_middleware"], cause: b.why.cause, name: b.why.name, note: `a middleware of this chain is not bound: ${b.why.note}`, count: null, exact: false });
  };
  const cutGap = (file: string, site: Site, more: number) => {
    addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "fan-out-capped", name: null, note: `the call has ${more} more arguments than the ${MAX_ITEMS} the plugin reads, so the handler and the middleware past them were not read`, count: more, exact: true });
  };

  const roleSeen = new Set<string>();
  const addRole = (target: string, role: "route_handler" | "middleware", app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (!take("roles")) return;
    roles.push({ target, role, detail: "hono", app, evidence });
  };

  // ---------- composition ----------
  type Mw = { pattern: string | null; site: Site; w: Where; expr: HExpr };
  const scopeOf = (app: string | null, file: string): FrameworkUnknown["scope"] => (app ? { app } : { file });
  const halted = (): boolean => exhausted("mounts") || exhausted("registrations");
  const reached = new Set<string>();
  const depthCut = new Map<string, number>();
  let middlewareOmitted = 0;
  const instId = (key: string, app: string | null): string => {
    const s = sites.get(key);
    if (s && app === appId(PLUGIN, s.inst.file, s.inst.line) && roots.has(key)) return app;
    return s ? `fw:hono:router:${s.inst.file}:${s.inst.line}` : `fw:hono:router:${key}`;
  };
  const roots = new Set<string>();

  // The prefix a basePath chain adds, or null when one of its paths is computed.
  const basesOf = (bases: { e: Expr; w: Where }[]): string | null => {
    let out = "";
    for (const b of bases) {
      const v = evaluate(b.e, constant(b.w.file, b.w.scope));
      if (v === null) return null;
      out = joinPath(out, v);
    }
    return out;
  };

  const register = (app: string | null, ev: Base, w: Where, methods: string[], pattern: string | null, written: string | null, handler: HExpr | undefined, own: HExpr[], mw: Mw[], via: Site[], more: number, ruleId: string) => {
    if (!take("registrations")) return;
    const key = `${ev.file}:${ev.site.line}:${ev.site.column}${via.map((s) => `@${s.file}:${s.line}:${s.column}`).join("")}`;
    const id = entityId(PLUGIN, app, "registration", key);
    const cut = more > 0 || !handler;
    const bound: Bound = cut ? { status: "unresolved", targets: [], tier: "certain", kind: "route-call", via: null, note: null, why: null } : bindFn(w, handler as HExpr, "handler");
    if (more > 0) cutGap(ev.file, ev.site, more);
    registrations.push({ kind: "registration", id, plugin: PLUGIN, app, methods, pattern, written, name: null, site: ev.site, mountedVia: via, mounted: app !== null, handler: { written: cut ? "past the arguments read" : showH(handler as HExpr), status: bound.status, targets: bound.targets } });
    if (bound.why && handler) addUnknown({ plugin: PLUGIN, site: { file: ev.file, line: handler.line, column: handler.column }, scope: { file: ev.file }, affects: ["handles"], cause: bound.why.cause, name: bound.why.name, note: bound.why.note, count: null, exact: false });
    for (const t of bound.targets) {
      const evd: FrameworkEvidence = { kind: bound.kind, tier: bound.tier, site: ev.site, via: bound.via, premises: [], rule: rule(ruleId), note: bound.note };
      edges.push({ from: id, to: t, kind: "handles", plugin: PLUGIN, app, evidence: evd });
      addRole(t, "route_handler", app, evd);
    }
    const chain: Mw[] = [...mw.filter((m) => covers(m.pattern, pattern)), ...own.map((x) => ({ pattern: null, site: ev.site, w, expr: x }))];
    if (chain.length > MAX_MIDDLEWARE_CHAIN) middlewareOmitted += chain.length - MAX_MIDDLEWARE_CHAIN;
    let order = 0;
    for (const m of chain.slice(0, MAX_MIDDLEWARE_CHAIN)) {
      const b = bindMw(m.w, m.expr);
      middlewareGap({ file: m.w.file, line: m.expr.line, column: m.expr.column }, b);
      for (const t of b.targets) {
        const evd: FrameworkEvidence = { kind: "route-call", tier: b.tier, site: m.site, via: b.via, premises: [], rule: rule("hono-middleware"), note: b.note };
        addRole(t, "middleware", app, evd);
        if (take("middlewareEdges")) edges.push({ from: id, to: t, kind: "applies_middleware", plugin: PLUGIN, app, evidence: evd, order });
      }
      order++;
    }
  };

  const compose = (app: string | null, inst: Inst, prefix: string | null, inherited: Mw[], via: Site[], stack: readonly string[], depth: number, cut: { file: string; scope: number; line: number } | null) => {
    reached.add(inst.key);
    const self = instId(inst.key, app);
    const mw: Mw[] = [...inherited];
    for (const ev of events.get(inst.key) ?? []) {
      if (halted()) return;
      // Hono copies a router's routes when it is mounted: what is added after the mount, in the same function, is not served under it.
      if (cut && ev.file === cut.file && ev.scope === cut.scope && ev.site.line > cut.line) continue;
      const w: Where = { file: ev.file, scope: ev.scope, ctx: inst.ctx };
      const f = ev.f;
      const extra = basesOf(ev.bases);
      if (extra === null) {
        addUnknown({ plugin: PLUGIN, site: ev.site, scope: scopeOf(app, ev.file), affects: ["handles", "mounts", "applies_middleware"], cause: "dynamic", name: null, note: "a basePath of this value is computed at run time, so the routes registered through it have no known pattern", count: null, exact: false });
      }
      const at = prefix === null || extra === null ? null : joinPath(prefix, extra);
      if (f.more) {
        cutGap(ev.file, ev.site, f.more);
        if (ev.type !== "route" && ev.type !== "use") continue;
      }
      switch (ev.type) {
        case "foreign":
          addUnknown({ plugin: PLUGIN, site: ev.site, scope: scopeOf(app, ev.file), affects: ["mounts", "handles"], cause: "unsupported-rule", name: f.args[1] ? showH(f.args[1]) : null, note: "a handler of another framework is mounted here with mount(); the routes it serves are not read", count: null, exact: false });
          continue;
        case "use": {
          const hasPath = pathLike(w, f.args[0]);
          const own = hasPath ? evaluate(f.args[0] as Expr, constant(ev.file, ev.scope)) : null;
          if (hasPath && own === null) addUnknown({ plugin: PLUGIN, site: ev.site, scope: scopeOf(app, ev.file), affects: ["applies_middleware"], cause: "dynamic", name: showH(f.args[0] as HExpr), note: `the middleware path ${showH(f.args[0] as HExpr)} is computed at run time, so the routes it applies to are not known`, count: null, exact: false });
          // A first argument before others that is no function the plugin binds (`process.env.AUTH_PATH`, a parameter) may be a path.
          const first = f.args[0] as HExpr;
          const maybePath = !hasPath && f.args.length > 1 && (first.t === "member" || first.t === "other" || (first.t === "ref" && !["bound", "external"].includes(bindMw(w, first).status)));
          if (maybePath) addUnknown({ plugin: PLUGIN, site: ev.site, scope: scopeOf(app, ev.file), affects: ["applies_middleware"], cause: "dynamic", name: showH(first), note: `the first argument ${showH(first)} of use may be a path computed at run time, so the routes this middleware applies to are not known`, count: null, exact: false });
          const known = at !== null && (!hasPath || own !== null) && !maybePath;
          const pattern = !hasPath || own === "*" || own === "/*" ? (at === null || at === "/" || at === "" ? null : joinPath(at, "*")) : at === null || own === null ? null : joinPath(at, own);
          for (const a of hasPath ? f.args.slice(1) : f.args) {
            if (mw.length >= MAX_MIDDLEWARE_CHAIN) {
              middlewareOmitted++;
              continue;
            }
            if (known) mw.push({ pattern, site: ev.site, w, expr: a });
            const b = bindMw(w, a);
            middlewareGap({ file: ev.file, line: a.line, column: a.column }, b);
            for (const t of b.targets) addRole(t, "middleware", app, { kind: "route-call", tier: b.tier, site: ev.site, via: b.via, premises: [], rule: rule("hono-middleware"), note: b.note });
          }
          continue;
        }
        case "route": {
          const isOn = f.prop === "on";
          let methods: string[] | null;
          if (!isOn) methods = [f.prop === "all" ? "*" : f.prop.toUpperCase()];
          else {
            const m = f.args[0];
            const list = m?.t === "array" && !m.more ? m.items : m ? [m] : [];
            const read = list.map((x) => (x.t === "new" || x.t === "via" ? null : evaluate(x as Expr, constant(ev.file, ev.scope))));
            methods = list.length > 0 && read.every((x) => x !== null) ? (read as string[]).map((x) => x.toUpperCase()) : null;
          }
          const pathArg = f.args[isOn ? 1 : 0];
          const handlers = f.args.slice(isOn ? 2 : 1);
          if (!pathArg) continue;
          if (handlers.length === 0) {
            // `get(path)` only sets the path; `get(handler)` registers the handler at the last path set on the value, which the plugin does not track.
            if (!isOn && !pathLike(w, pathArg)) addUnknown({ plugin: PLUGIN, site: ev.site, scope: { file: ev.file }, affects: ["handles"], cause: "unsupported-rule", name: showH(pathArg), note: `${f.prop} is called with no path, so the route that ${showH(pathArg)} handles is at the last path set on this value, which the plugin does not track; it is not listed as a route`, count: null, exact: false });
            continue;
          }
          const written = pathArg.t === "new" || pathArg.t === "via" ? null : evaluate(pathArg, constant(ev.file, ev.scope));
          const h = handlers[handlers.length - 1] as HExpr;
          if (written === null || methods === null) {
            addUnknown({ plugin: PLUGIN, site: ev.site, scope: { file: ev.file }, affects: ["handles"], cause: "dynamic", name: showH(h), note: `the route ${methods === null ? "methods" : "path"} ${showH(methods === null ? (f.args[0] as HExpr) : pathArg)} ${methods === null ? "are" : "is"} computed at run time, so the route that ${showH(h)} handles is not known; it is not listed as a route`, count: null, exact: false });
            continue;
          }
          register(app, ev, w, methods, at === null ? null : joinPath(at, written), written, f.more ? undefined : h, f.more ? handlers : handlers.slice(0, -1), mw, via, f.more ?? 0, "hono-route");
          continue;
        }
        case "openapi": {
          const handler = f.args[1];
          const def = f.args[0] ? routeDef(w, f.args[0]) : null;
          if (def === null || "k" in def) {
            const note = def === null ? `the route ${f.args[0] ? showH(f.args[0]) : "argument"} is not a createRoute definition the plugin can follow` : def.note;
            addUnknown({ plugin: PLUGIN, site: ev.site, scope: { file: ev.file }, affects: ["handles"], cause: def === null ? "unsupported-rule" : def.cause, name: handler ? showH(handler) : null, note: `${note}, so the route that ${handler ? showH(handler) : "this call"} handles is not known; it is not listed as a route`, count: null, exact: false });
            continue;
          }
          const written = evaluate(def.path, constant(def.w.file, def.w.scope));
          if (written === null) {
            addUnknown({ plugin: PLUGIN, site: ev.site, scope: { file: ev.file }, affects: ["handles"], cause: "dynamic", name: handler ? showH(handler) : null, note: `the path of the route ${showH(f.args[0] as HExpr)} is computed at run time, so the route that ${handler ? showH(handler) : "this call"} handles is not known; it is not listed as a route`, count: null, exact: false });
            continue;
          }
          register(app, ev, w, [def.method], at === null ? null : joinPath(at, honoPath(written)), written, handler, [], mw, via, 0, "hono-openapi");
          continue;
        }
        case "mount": {
          const prefixArg = f.args[0];
          const targetArg = f.args[1];
          if (!prefixArg || !targetArg) continue;
          const own = prefixArg.t === "new" || prefixArg.t === "via" ? null : evaluate(prefixArg, constant(ev.file, ev.scope));
          if (own === null) addUnknown({ plugin: PLUGIN, site: ev.site, scope: scopeOf(app, ev.file), affects: ["mounts", "handles", "applies_middleware"], cause: "dynamic", name: showH(prefixArg), note: `the mount path ${showH(prefixArg)} is computed at run time, so the routes under it have no known pattern`, count: null, exact: false });
          const under = at === null || own === null ? null : joinPath(at, own);
          const target = value(w, targetArg, true, null);
          if (target.k !== "inst") {
            const why = target.k === "gap" ? target : target.k === "param" ? gap("dynamic", `${target.name} is a parameter, so the caller decides which router is mounted`, target.name) : gap("unsupported-rule", `the plugin cannot follow ${showH(targetArg)} to a Hono router`, showH(targetArg));
            addUnknown({ plugin: PLUGIN, site: ev.site, scope: scopeOf(app, ev.file), affects: ["mounts", "handles", "applies_middleware"], cause: why.cause, name: why.name ?? showH(targetArg), note: `the router mounted at ${showH(prefixArg)} is not known: ${why.note}; the routes under it are not listed`, count: null, exact: false });
            continue;
          }
          const child = target.inst;
          if (stack.includes(child.key)) continue;
          if (depth >= MAX_MOUNT_DEPTH) {
            const root = stack[0] as string;
            depthCut.set(root, (depthCut.get(root) ?? 0) + 1);
            continue;
          }
          if (!take("mounts")) return;
          const childId = instId(child.key, null);
          edges.push({ from: self, to: childId, kind: "mounts", plugin: PLUGIN, app, evidence: { kind: "mount", tier: "certain", site: ev.site, via: null, premises: [], rule: rule("hono-mount"), note: null } });
          compose(app, child, under, mw, [...via, ev.site], [...stack, child.key], depth + 1, { file: ev.file, scope: ev.scope, line: ev.site.line });
          continue;
        }
      }
    }
  };

  // Applications: the Hono values no mount the plugin follows reaches.
  const allKeys = [...sites.keys()].sort();
  for (const key of allKeys) if (!reachable.has(key)) roots.add(key);
  for (const key of allKeys) {
    if (!roots.has(key)) continue;
    const s = sites.get(key) as { inst: Inst; name: string | null };
    if (!take("apps")) continue;
    const id = appId(PLUGIN, s.inst.file, s.inst.line);
    compose(id, s.inst, "", [], [], [key], 0, null);
    const project = npmProject(s.inst.file);
    const deps = index.model().node.find((p) => p.dir === project)?.pkg.deps;
    apps.push({
      id,
      name: `${s.name ?? "a Hono application"} (${s.inst.file})`,
      project,
      root: project,
      site: { file: s.inst.file, line: s.inst.line, column: s.inst.column },
      evidence: [{ file: s.inst.file, line: s.inst.line, note: "made by Hono's own class, and mounted by no other Hono value the plugin follows" }],
      version: deps?.get("hono") ?? deps?.get(OPENAPI_MODULE) ?? null,
    });
  }
  // Routers only a mount the plugin could not follow reaches: their routes are kept, relative and not served.
  for (const key of allKeys) {
    if (roots.has(key) || reached.has(key)) continue;
    compose(null, (sites.get(key) as { inst: Inst }).inst, "", [], [], [key], 0, null);
  }
  // Routes on a parameter typed as a Hono value.
  for (const { name, type, ev } of paramRoutes) {
    const f = ev.f;
    const w: Where = { file: ev.file, scope: ev.scope, ctx: null };
    let methods: string[] | null = null;
    let written: string | null = null;
    let handler: HExpr | undefined;
    let own: HExpr[] = [];
    let ruleId = "hono-route";
    if (ev.type === "openapi") {
      const def = f.args[0] ? routeDef(w, f.args[0]) : null;
      if (def && !("k" in def)) {
        methods = [def.method];
        const p = evaluate(def.path, constant(def.w.file, def.w.scope));
        written = p === null ? null : honoPath(p);
      }
      handler = f.args[1];
      ruleId = "hono-openapi";
    } else if (f.prop !== "on") {
      methods = [f.prop === "all" ? "*" : f.prop.toUpperCase()];
      const p = f.args[0];
      written = p && p.t !== "new" && p.t !== "via" ? evaluate(p, constant(ev.file, ev.scope)) : null;
      const handlers = f.args.slice(1);
      handler = handlers[handlers.length - 1];
      own = handlers.slice(0, -1);
    }
    if (methods === null || written === null || !handler) {
      addUnknown({ plugin: PLUGIN, site: ev.site, scope: { file: ev.file }, affects: ["handles", "mounts"], cause: "dynamic", name, note: `a route is registered on the parameter ${name} (${type}) with a method or path the plugin cannot read; it is not listed as a route`, count: null, exact: false });
      continue;
    }
    register(null, ev, w, methods, written, written, f.more ? undefined : handler, own, [], [], f.more ?? 0, ruleId);
    addUnknown({ plugin: PLUGIN, site: ev.site, scope: { file: ev.file }, affects: ["handles", "mounts"], cause: "dynamic", name, note: `the route is registered on the parameter ${name} (${type}); which application it lands on, and under which prefix, is decided by the caller`, count: null, exact: false });
  }

  // ---------- what the caps and budgets left out ----------
  const whole = { build: true } as const;
  for (const [root, n] of depthCut) addUnknown({ plugin: PLUGIN, site: null, scope: whole, affects: ["mounts", "handles"], cause: "fan-out-capped", name: null, note: `routers mounted more than ${MAX_MOUNT_DEPTH} levels deep under ${root} were not followed (${n} mounts); their routes are not listed`, count: n, exact: true });
  const capped = (affects: FrameworkUnknown["affects"], cause: FrameworkUnknown["cause"], count: number | null, note: string) => unknowns.push({ plugin: PLUGIN, site: null, scope: whole, affects, cause, name: null, note, count, exact: count !== null });
  if (unreadFiles > 0) capped(["handles", "mounts", "applies_middleware"], "budget", unreadFiles, `${unreadFiles} files were not read: the Hono plugin reads at most ${MAX_FACTS_READ} facts in one build`);
  if (refused.lookups > 0) capped(["handles", "mounts", "applies_middleware"], "budget", refused.lookups, `${refused.lookups} names were not looked up: the Hono plugin makes at most ${MAX_LOOKUPS} lookups in one build`);
  if (refused.steps > 0) capped(["handles", "mounts", "applies_middleware"], "budget", null, `the Hono plugin stopped following values after ${MAX_STEPS} steps in this build; routes past it may be missing`);
  if (refused.mounts > 0) capped(["mounts", "handles", "applies_middleware"], "fan-out-capped", null, `the walk stopped after ${MAX_MOUNTS} router mounts in this build; the routes past it are not listed`);
  if (refused.registrations > 0) capped(["handles", "applies_middleware"], "fan-out-capped", null, `the walk stopped after ${MAX_REGISTRATIONS} registrations in this build; the routes past it are not listed`);
  if (refused.middlewareEdges > 0) capped(["applies_middleware"], "fan-out-capped", refused.middlewareEdges, `${refused.middlewareEdges} middleware edges were left out: the Hono plugin keeps at most ${MAX_MIDDLEWARE_EDGES} in one build`);
  if (middlewareOmitted > 0) capped(["applies_middleware"], "fan-out-capped", middlewareOmitted, `${middlewareOmitted} middleware entries past ${MAX_MIDDLEWARE_CHAIN} in one chain were left out`);
  if (refused.apps > 0) capped(["handles", "mounts", "applies_middleware"], "fan-out-capped", refused.apps, `${refused.apps} applications and their routes were left out: the Hono plugin keeps at most ${MAX_APPS} applications in one build`);
  if (refused.roles > 0) capped(["handles", "applies_middleware"], "fan-out-capped", refused.roles, `${refused.roles} roles were left out: the Hono plugin gives at most ${MAX_ROLES} roles in one build`);
  if (unknownsLeftOut > 0) unknowns.push({ plugin: PLUGIN, site: null, scope: whole, affects: ["handles", "mounts", "applies_middleware"], cause: "fan-out-capped", name: null, note: `${unknownsLeftOut} more unknowns past the first ${MAX_UNKNOWNS} were left out`, count: unknownsLeftOut, exact: true });
  const entities: Entity[] = registrations;
  return { apps, output: { roles, entities, edges, unknowns } };
}
