// The gin plugin's resolve step: which values are gin engines and router
// groups, which calls register routes on them, each route's full path with
// its groups' prefixes composed in, its handler and its middleware.
//
// API identity: `gin` is github.com/gin-gonic/gin only when the file imports
// it under that name, the import resolves outside the repository, the
// project declares the module, and no declaration inside the function
// shadows the name where it is used. An engine is a value made by
// `gin.Default()` or `gin.New()`, with or without options; a group is a
// value made by `Group` on an engine or a group. A method named GET on any
// other value is no route.
//
// Every engine is an application of its own. A route on a group carries
// the prefixes of every group between it and its engine, outermost first.
// A route registered on a parameter, a struct field or a call's result
// typed as a gin router is kept with no application, and an unknown says
// that the caller decides where it lands.
//
// Middleware follows gin's order: the engine's `Use`, then each group's own
// middleware and its `Use`, then the route's own handlers before its last.
// gin copies the middleware a router has when a group is made or a route is
// registered, so a `Use` written later in the same function applies to
// nothing before it; a `Use` in another function applies with tier
// possible, since the order is not proved.
//
// Registrations are kept apart from their handlers: a handler that is
// missing, a call's result, computed or external leaves the registration in
// place with the handler's status and an unknown that says why. A handler
// written in place is bound to the definition the language extractor makes
// for it. A route whose own path is computed at run time is no
// registration: it is an unknown of cause "dynamic" at the call.
//
// Every kind of work is capped per build, and each cap, once reached, adds
// one unknown and stops that kind of work.
import type { Cause, Tier } from "../../model/records.js";
import type { DefFact, GraphNode, TypeRef } from "../../types.js";
import type { Detection, FrameworkEdge, FrameworkEdgeKind, FrameworkEvidence, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import { inlineHandler } from "../shared/inline.js";
import type { Expr } from "../go-http/facts.js";
import { evaluate, isCut, MAX_ARGS, MAX_SOURCE_BYTES, show } from "../go-http/facts.js";
import { METHOD_CONSTANTS } from "../go-http/resolve.js";
import type { GinFact } from "./facts.js";
import { VERBS } from "./facts.js";

export const PLUGIN = "gin";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });
export const MODULE = "github.com/gin-gonic/gin";

// The caps, per build.
export const MAX_REGISTRATIONS = 10_000;
export const MAX_APPS = 5000;
export const MAX_ROLES = 10_000;
export const MAX_EDGES = 60_000;
export const MAX_UNKNOWNS = 10_000;
export const MAX_LOOKUPS = 100_000;
export const MAX_STEPS = 1_000_000; // routers and values followed in one build
// The caps per item.
export const MAX_GROUP_DEPTH = 32; // groups between a route and its engine
export const MAX_MIDDLEWARE_CHAIN = 64;
const MAX_VALUE_STEPS = 8; // `a := b` hops followed to reach a router or a handler

// The gin types a router value can be declared with.
const ROUTER_TYPES = new Set(["Engine", "RouterGroup", "IRouter", "IRoutes"]);
const REGISTERS = new Set([...VERBS, "Any", "Handle", "Match"]);

type Fact<K extends GinFact["kind"]> = Extract<GinFact, { kind: K }>;
type Call = Fact<"call">;
type Via = FrameworkEvidence["via"];
type Decl = { kind: "value"; file: string; fact: Fact<"value"> } | { kind: "param"; file: string; fact: Fact<"param"> };

type Engine = { id: string; file: string; name: string; line: number; column: number; project: string };
// A router: an engine; a group made by a Group call on another router; or a
// router the plugin cannot name (a parameter, a struct field or a call's
// result declared as a gin router).
type Router =
  | { t: "engine"; key: string; engine: Engine }
  | { t: "group"; key: string; parent: Router; file: string; call: Call; depth: number }
  | { t: "unnamed"; key: string; what: "parameter" | "field" | "result"; file: string; name: string; type: string };

type Res = { status: HandlerStatus; targets: string[]; tier: Tier; via: Via; note: string | null; why: { cause: Cause; note: string; name: string | null; at: { line: number; column: number } } | null };

const dirOf = (file: string): string => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
};
const lastOf = (spec: string): string => spec.slice(spec.lastIndexOf("/") + 1);
const siteKey = (s: Site): string => `${s.file}:${s.line}:${s.column}`;

export type Analysis = { apps: Detection[]; output: PluginOutput };
const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<GinFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

function run(index: PluginIndex<GinFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];

  // ---------- caps ----------
  const used = { registrations: 0, lookups: 0, steps: 0 };
  const stopped = new Map<string, FrameworkUnknown>();
  const stop = (key: string, cause: Cause, site: Site | null, affects: FrameworkEdgeKind[], note: string): FrameworkUnknown => {
    const kept = stopped.get(key);
    if (kept) return kept;
    const u: FrameworkUnknown = { plugin: PLUGIN, site, scope: { build: true }, affects, cause, name: null, note, count: null, exact: false };
    stopped.set(key, u);
    unknowns.push(u);
    return u;
  };
  let listed = 0;
  const seenGaps = new Set<string>();
  const gap = (u: FrameworkUnknown) => {
    const k = `${u.cause}\0${u.site ? siteKey(u.site) : ""}\0${u.name ?? ""}\0${u.note}`;
    if (seenGaps.has(k)) return;
    seenGaps.add(k);
    if (listed >= MAX_UNKNOWNS) {
      const cap = stop("unknowns", "fan-out-capped", u.site, [], `the plugin stopped listing unknowns after ${MAX_UNKNOWNS} in this build; the count is of the gaps left out`);
      cap.count = (cap.count ?? 0) + 1;
      return;
    }
    listed++;
    unknowns.push(u);
  };
  const step = (site: Site): boolean => {
    if (used.steps >= MAX_STEPS) {
      stop("steps", "budget", site, ["handles", "applies_middleware"], `the plugin stopped following routers and values after ${MAX_STEPS} steps in this build`);
      return false;
    }
    used.steps++;
    return true;
  };
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (used.lookups >= MAX_LOOKUPS) {
      stop("lookups", "budget", { file, line: 1, column: 1 }, ["handles", "applies_middleware"], `the plugin stopped looking names up after ${MAX_LOOKUPS} lookups in this build; handlers met after that are not bound`);
      return { kind: "gap", cause: "budget", note: `the lookup budget of ${MAX_LOOKUPS} ran out`, candidates: null };
    }
    used.lookups++;
    return index.lookup(file, path);
  };

  // ---------- files, packages and their facts ----------
  const files = index.factFiles();
  const goFiles = new Map<string, string[]>();
  for (const p of index.paths()) {
    if (!p.endsWith(".go")) continue;
    const d = dirOf(p);
    (goFiles.get(d) ?? goFiles.set(d, []).get(d))?.push(p);
  }
  const pkgName = (file: string): string => index.languageFacts(file)?.goPackage ?? "";
  const dirPackages = new Map<string, string>();
  const pkgOfDir = (dir: string): string => {
    const kept = dirPackages.get(dir);
    if (kept !== undefined) return kept;
    const found = (goFiles.get(dir) ?? []).map(pkgName).find((p) => p !== "" && !p.endsWith("_test")) ?? "";
    dirPackages.set(dir, found);
    return found;
  };
  const of = <K extends GinFact["kind"]>(file: string, kind: K): Fact<K>[] => index.factsOf(file).filter((f): f is Fact<K> => f.kind === kind);

  type FileIndex = { byDecl: Map<string, Fact<"value">[]>; paramByDecl: Map<string, Fact<"param">>; consts: Map<string, string>; calls: Map<string, Call> };
  const fileIndexes = new Map<string, FileIndex>();
  const fileIndex = (file: string): FileIndex => {
    let fi = fileIndexes.get(file);
    if (fi) return fi;
    fi = { byDecl: new Map(), paramByDecl: new Map(), consts: new Map(), calls: new Map() };
    for (const f of index.factsOf(file)) {
      if (f.kind === "value" && f.decl !== null) (fi.byDecl.get(f.decl) ?? fi.byDecl.set(f.decl, []).get(f.decl))?.push(f);
      else if (f.kind === "param") fi.paramByDecl.set(f.decl, f);
      else if (f.kind === "const") fi.consts.set(f.name, f.value);
      else if (f.kind === "call") fi.calls.set(`${f.line}:${f.column}`, f);
    }
    fileIndexes.set(file, fi);
    return fi;
  };
  const topValues = new Map<string, Decl[]>();
  for (const file of files) {
    for (const v of of(file, "value")) {
      if (v.decl !== null) continue;
      const k = `${dirOf(file)}\0${pkgName(file)}\0${v.name}`;
      (topValues.get(k) ?? topValues.set(k, []).get(k))?.push({ kind: "value", file, fact: v });
    }
  }
  const topValue = (dir: string, pkg: string, name: string): Decl | null => topValues.get(`${dir}\0${pkg}\0${name}`)?.[0] ?? null;
  const constantOf = (file: string) => (name: string) => fileIndex(file).consts.get(name) ?? null;

  // ---------- which local names are gin ----------
  const identities = new Map<string, Set<string>>();
  const identity = (file: string): Set<string> => {
    let id = identities.get(file);
    if (id) return id;
    id = new Set();
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf || lf.lang !== "go" || !index.declares(index.projectOf(file), "go", MODULE)) return id;
    for (const imp of lf.imports) {
      if (imp.scoped || imp.star || imp.spec !== MODULE || index.module(file, imp.spec).kind !== "external") continue;
      const local = imp.namespace ?? lastOf(imp.spec);
      if (local !== "_" && local !== "") id.add(local);
    }
    // A package-level definition of the same name would not compile; it never passes for the package.
    for (const d of lf.defs) if (d.topLevel) id.delete(d.name);
    return id;
  };
  // The local names of net/http in a file, by the same rule: its method
  // constants (`http.MethodGet`) are the only names Handle's method is read from.
  const httpNames = new Map<string, Set<string>>();
  const netHttp = (file: string): Set<string> => {
    let id = httpNames.get(file);
    if (id) return id;
    id = new Set();
    httpNames.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf || lf.lang !== "go") return id;
    for (const imp of lf.imports) {
      if (imp.scoped || imp.star || imp.spec !== "net/http" || index.module(file, imp.spec).kind !== "external") continue;
      const local = imp.namespace ?? "http";
      if (local !== "_" && local !== "") id.add(local);
    }
    for (const d of lf.defs) if (d.topLevel) id.delete(d.name);
    return id;
  };
  // A method given to Handle: a literal or a constant of the file, or a net/http method constant.
  const methodOf = (file: string, e: Expr): string | null =>
    e.t === "ref" && !e.local && e.path.length === 2 && netHttp(file).has(e.path[0] as string) ? (METHOD_CONSTANTS[e.path[1] as string] ?? null) : evaluate(e, constantOf(file));
  const isGin = (file: string, e: Expr, member: string | null): boolean =>
    e.t === "ref" && !e.local && e.path.length === (member === null ? 1 : 2) && identity(file).has(e.path[0] as string) && (member === null || e.path[1] === member);
  const ginPkg = (file: string, e: Expr): boolean => e.t === "ref" && !e.local && e.path.length === 2 && identity(file).has(e.path[0] as string);
  // A declared type that is a gin router, read in the file that declares it.
  const routerType = (file: string, path: readonly string[]): boolean => path.length === 2 && identity(file).has(path[0] as string) && ROUTER_TYPES.has(path[1] as string);
  const routerTypeRef = (file: string, t: TypeRef | null | undefined): boolean => !!t && t.qualifier !== null && identity(file).has(t.qualifier) && ROUTER_TYPES.has(t.name);

  // ---------- names and values ----------
  const declOf = (file: string, name: string, decl: string | null, line: number, strict: boolean): Decl | null => {
    if (decl === null) return topValue(dirOf(file), pkgName(file), name);
    const fi = fileIndex(file);
    let best: Fact<"value"> | null = null;
    for (const v of fi.byDecl.get(decl) ?? []) if ((strict ? v.line < line : v.line <= line) && (!best || v.line > best.line)) best = v;
    if (best) return { kind: "value", file, fact: best };
    const p = fi.paramByDecl.get(decl);
    return p ? { kind: "param", file, fact: p } : null;
  };
  const declPath = (file: string, path: readonly string[], decl: string | null, line: number, strict: boolean): { decl: Decl; rest: string[] } | null => {
    const head = path[0] as string;
    const d = declOf(file, head, decl, line, strict);
    if (d) return { decl: d, rest: path.slice(1) };
    if (decl !== null || path.length < 2) return null;
    const m = lookup(file, [head]);
    if (m.kind !== "module") return null;
    const v = topValue(m.file, pkgOfDir(m.file), path[1] as string);
    return v ? { decl: v, rest: path.slice(2) } : null;
  };

  // Each file's definitions (language facts) by name and line.
  const defsByPlace = new Map<string, Map<string, DefFact>>();
  const defOf = (node: GraphNode): DefFact | null => {
    let m = defsByPlace.get(node.file);
    if (!m) {
      m = new Map();
      for (const d of index.languageFacts(node.file)?.defs ?? []) m.set(`${d.name}\0${d.line}`, d);
      defsByPlace.set(node.file, m);
    }
    return m.get(`${node.name}\0${node.startLine}`) ?? null;
  };
  const typeNode = (file: string, path: readonly string[]): { node: GraphNode; found: Extract<Lookup, { kind: "symbol" }> } | { found: Lookup } => {
    const found = lookup(file, path);
    if (found.kind !== "symbol") return { found };
    const node = found.ids.map((id) => index.node(id)).find((n): n is GraphNode => n !== null && n.kind === "type");
    return node ? { node, found } : { found };
  };
  // The function a call names, and its declared first result.
  const resultOf = (file: string, call: Extract<Expr, { t: "call" }>): { file: string; type: TypeRef } | "external" | null => {
    const fn = call.fn;
    if (fn.t !== "ref" || fn.local) return null;
    const found = lookup(file, fn.path);
    if (found.kind === "external") return "external";
    const node = found.kind === "symbol" ? index.node(found.ids[0] as string) : null;
    const r = node ? defOf(node)?.results?.[0] : null;
    return node && r ? { file: node.file, type: r } : null;
  };

  // ---------- routers ----------
  const engines = new Map<string, Engine>();
  const leftApps = new Set<string>();
  const engineAt = (file: string, at: { line: number; column: number }, name: string): Engine | null => {
    const id = appId(PLUGIN, file, at.line);
    let e = engines.get(id);
    if (e) return e;
    if (engines.size >= MAX_APPS) {
      leftApps.add(id);
      const cap = stop("apps", "fan-out-capped", { file, line: at.line, column: at.column }, ["handles"], `the plugin stopped listing applications after ${MAX_APPS} engines in this build; the routes of the engines past that are not listed`);
      cap.count = leftApps.size;
      cap.exact = true;
      return null;
    }
    e = { id, file, name, line: at.line, column: at.column, project: index.projectOf(file) };
    engines.set(id, e);
    return e;
  };
  // Options (`gin.New(opt)`, `gin.Default(opt)`) change no route the plugin reads: the engine is the same.
  const makesEngine = (file: string, e: Expr): boolean => e.t === "call" && (isGin(file, e.fn, "Default") || isGin(file, e.fn, "New"));
  // Every engine made anywhere is an application, registered on or not.
  for (const file of files) for (const v of of(file, "value")) if (makesEngine(file, v.value)) engineAt(file, v.value, v.name);

  // What a value is as a router: a router, "other" for a value known not to
  // be one, null when the plugin cannot tell. `steps` counts the value hops
  // within one group level, `depth` the groups below the one asked about.
  const receiverOf = (file: string, e: Expr, line: number): Router | "other" | null => routerOf(file, e, line, false, 0, null, 0);
  const routerOf = (file: string, e: Expr, line: number, strict: boolean, steps: number, name: string | null, depth: number): Router | "other" | null => {
    if (steps > MAX_VALUE_STEPS) {
      gap({ plugin: PLUGIN, site: { file, line: e.line, column: e.column }, scope: { file }, affects: ["handles", "applies_middleware"], cause: "fan-out-capped", name: show(e), note: `${show(e)} is reached through more than ${MAX_VALUE_STEPS} assignments (\`a := b\`), which the plugin does not follow; if it is a gin router, the routes and middleware on it are not listed`, count: null, exact: false });
      return null;
    }
    if (!step({ file, line: e.line, column: e.column })) return null;
    if (e.t === "call") {
      if (makesEngine(file, e)) {
        const eng = engineAt(file, e, name ?? show(e));
        return eng ? { t: "engine", key: eng.id, engine: eng } : null;
      }
      const fn = e.fn;
      if (fn.t === "ref" && fn.path.length >= 2 && fn.path[fn.path.length - 1] === "Group") {
        const call = fileIndex(file).calls.get(`${e.line}:${e.column}`);
        if (!call || call.prop !== "Group") return null;
        if (depth >= MAX_GROUP_DEPTH) {
          stop("depth", "fan-out-capped", { file, line: call.line, column: call.column }, ["handles", "applies_middleware"], `groups nested more than ${MAX_GROUP_DEPTH} levels deep are not followed`);
          return null;
        }
        // A group made in a value (`g = g.Group("/x")`) is made from what
        // the name held before that line: never from the value itself.
        const parent = routerOf(file, call.recv, call.line, strict, 0, null, depth + 1);
        if (parent === null || parent === "other") return parent;
        return { t: "group", key: `group:${file}:${call.line}:${call.column}`, parent, file, call, depth: parent.t === "group" ? parent.depth + 1 : 1 };
      }
      if (ginPkg(file, fn)) return "other";
      const r = resultOf(file, e);
      if (r === "external") return "other";
      if (!r) return null;
      return routerTypeRef(r.file, r.type) ? { t: "unnamed", key: `result:${file}:${e.line}:${e.column}`, what: "result", file, name: show(e), type: `${r.type.qualifier}.${r.type.name}` } : "other";
    }
    if (e.t !== "ref") return null;
    const found = declPath(file, e.path, e.decl, line, strict);
    if (!found) {
      if (e.decl !== null) return null;
      const m = lookup(file, e.path);
      return m.kind === "module" || m.kind === "external" ? "other" : null;
    }
    const d = found.decl;
    if (found.rest.length === 0) {
      if (d.kind === "param") {
        if (d.fact.func) return "other";
        return routerType(d.file, d.fact.type) ? { t: "unnamed", key: `parameter:${d.file}:${d.fact.decl}`, what: "parameter", file: d.file, name: d.fact.name, type: `${d.fact.pointer ? "*" : ""}${d.fact.type.join(".")}` } : "other";
      }
      const v = d.fact.value;
      if (v.t === "ref" || v.t === "call") return routerOf(d.file, v, d.fact.line, true, steps + 1, d.fact.name, depth);
      return v.t === "other" ? null : "other";
    }
    if (found.rest.length !== 1) return null;
    // A field: its declared type, read from the struct that declares it.
    const t = typeOfDecl(d);
    if (!t) return null;
    const tn = typeNode(t.file, t.path);
    if (!("node" in tn)) return tn.found.kind === "external" ? "other" : null;
    const field = defOf(tn.node)?.fields[found.rest[0] as string];
    if (!field) return null;
    return routerTypeRef(tn.node.file, field) ? { t: "unnamed", key: `field:${tn.node.id}:${found.rest[0]}`, what: "field", file, name: show(e), type: `${field.qualifier}.${field.name}` } : "other";
  };

  // The type a value has, read from its declaration: a parameter's declared
  // type, a composite literal's type, or a called function's declared result.
  function typeOfDecl(d: Decl): { file: string; path: string[] } | null {
    if (d.kind === "param") return d.fact.func ? null : { file: d.file, path: d.fact.type };
    const v = d.fact.value;
    if (v.t === "lit" && v.type) return { file: d.file, path: v.type };
    if (v.t === "call") {
      const r = resultOf(d.file, v);
      if (r && r !== "external") return { file: r.file, path: r.type.qualifier ? [r.type.qualifier, r.type.name] : [r.type.name] };
    }
    return null;
  }

  // ---------- handlers and middleware ----------
  const packageMethods = new Map<string, Map<string, string[]>>();
  const methodsOn = (type: GraphNode, name: string): string[] => {
    const dir = dirOf(type.file);
    const pkg = pkgName(type.file);
    const k = `${dir}\0${pkg}`;
    let m = packageMethods.get(k);
    if (!m) {
      m = new Map();
      for (const f of goFiles.get(dir) ?? []) {
        if (pkgName(f) !== pkg) continue;
        for (const s of index.symbols(f)) {
          if (s.kind !== "method") continue;
          const hash = s.id.indexOf("#");
          const at = s.id.lastIndexOf("@");
          if (hash < 0 || at < hash) continue;
          const key = s.id.slice(hash + 1, at);
          (m.get(key) ?? m.set(key, []).get(key))?.push(s.id);
        }
      }
      packageMethods.set(k, m);
    }
    return m.get(`${type.name}.${name}`) ?? [];
  };

  const fail = (status: HandlerStatus, cause: Cause, note: string, name: string | null, at: Expr): Res => ({ status, targets: [], tier: "certain", via: null, note: null, why: { cause, note, name, at: { line: at.line, column: at.column } } });
  const fromLookup = (found: Lookup, e: Expr, what: string): Res => {
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${what}'s binding is ${found.tier}`), why: null };
      case "external":
        return fail("external", "external", `${show(e)} comes from a declared dependency`, show(e), e);
      case "gap":
        return fail(found.cause === "ambiguous" ? "ambiguous" : found.cause === "miss" ? "missing" : "unresolved", found.cause, found.note, show(e), e);
      case "miss":
        return fail("missing", "miss", `the ${what} ${show(e)} names ${found.name} in ${found.target.startsWith("go:") ? found.target.slice(3) : found.target}, where no such definition exists now`, show(e), e);
      default:
        return fail("missing", "miss", `no definition named ${show(e)} is in scope`, show(e), e);
    }
  };
  // A method value `x.m` whose receiver's type is declared: the method m of that type.
  const methodValue = (d: Decl, method: string, e: Expr, what: string): Res => {
    const t = typeOfDecl(d);
    if (!t) return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a method of a value whose type no rule reads`, show(e), e);
    const tn = typeNode(t.file, t.path);
    if (!("node" in tn)) return tn.found.kind === "symbol" ? fail("unresolved", "unsupported-rule", `${t.path.join(".")} is not a type declared in the repository`, show(e), e) : fromLookup(tn.found, e, what);
    const ids = methodsOn(tn.node, method);
    if (ids.length === 0) return fail("unresolved", "unsupported-rule", `${t.path.join(".")} declares no method ${method} in its package; a promoted method or a field of function type is not followed`, show(e), e);
    const f = tn.found;
    return { status: "bound", targets: ids, tier: f.tier, via: f.via, note: f.tier === "certain" ? `the ${what} is the method value ${show(e)} of ${t.path.join(".")}` : (f.note ?? `the type's binding is ${f.tier}`), why: null };
  };
  // A name used as a handler or a middleware.
  const bindRef = (file: string, e: Extract<Expr, { t: "ref" }>, line: number, what: string, steps: number): Res => {
    if (ginPkg(file, e)) return fail("external", "external", `${show(e)} is gin's own`, show(e), e);
    const symbol = e.local ? null : lookup(file, e.path);
    if (symbol?.kind === "symbol") return fromLookup(symbol, e, what);
    const found = declPath(file, e.path, e.decl, line, false);
    if (found && found.rest.length === 1) return methodValue(found.decl, found.rest[0] as string, e, what);
    if (found && found.rest.length === 0 && found.decl.kind === "value") {
      const v = found.decl.fact.value;
      if (v.t === "ref") {
        if (steps < MAX_VALUE_STEPS) return bind(found.decl.file, v, found.decl.fact.line, what, steps + 1);
        return fail("unresolved", "fan-out-capped", `the ${what} ${show(e)} is reached through more than ${MAX_VALUE_STEPS} assignments (\`a := b\`), which the plugin does not follow, so the ${what} is not bound`, show(e), e);
      }
      if (v.t === "fn") return fail("unresolved", "unsupported-rule", `the ${what} ${show(e)} is a function held in a value; only a function written in place at the route or a named function is bound`, show(e), e);
    }
    if (found?.decl.kind === "param") return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a parameter, so the caller decides what it is`, show(e), e);
    if (found || e.local) return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a value the code computes, not a definition`, show(e), e);
    return fromLookup(symbol ?? { kind: "none" }, e, what);
  };
  // The last handler of a route.
  const bind = (file: string, e: Expr, line: number, what: string, steps: number): Res => {
    switch (e.t) {
      case "fn": {
        const inline = inlineHandler(index, file, e);
        if (inline) return { status: "bound", targets: [inline], tier: "certain", via: null, note: null, why: null };
        return fail("unresolved", "unsupported-rule", `the ${what} is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it`, null, e);
      }
      case "ref":
        return bindRef(file, e, line, what, steps);
      case "call":
        if (ginPkg(file, e.fn)) return fail("external", "external", `the ${what} is ${show(e)}, which gin builds`, show(e), e);
        return fail("unresolved", "unsupported-rule", `the ${what} is the value ${show(e)} returns; no rule reads what it returns, so the ${what} is not bound`, show(e.fn), e);
      default:
        if (isCut(e)) return fail("unresolved", "fan-out-capped", `the ${what} expression is longer than the plugin reads, so the ${what} is not known`, null, e);
        return fail("dynamic", "dynamic", `the ${what} is computed (${show(e)})`, null, e);
    }
  };
  // A middleware: a handler, or the value a named function returns (tier possible).
  const bindMw = (file: string, e: Expr, line: number): Res => {
    if (e.t === "fn") return fail("unresolved", "unsupported-rule", "the middleware is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it", null, e);
    if (e.t !== "call") return bind(file, e, line, "middleware", 0);
    const fn = e.fn;
    if (ginPkg(file, fn)) return fail("external", "external", `the middleware is ${show(e)}, which gin builds`, show(e), e);
    if (fn.t !== "ref") return fail("dynamic", "dynamic", `the middleware is computed (${show(e)})`, null, e);
    const r = bindRef(file, fn, line, "middleware", 0);
    if (r.status !== "bound") return r.status === "external" ? r : fail(r.status, r.why?.cause ?? "unsupported-rule", `the middleware is the value ${show(e)} returns; ${r.why?.note ?? "its function is not bound"}`, show(fn), e);
    return { ...r, tier: "possible", note: `the middleware is the value ${show(e)} returns` };
  };

  // A middleware is bound once for each place it is written, not once for every route it applies to.
  const mwBound = new Map<string, Res>();
  const boundMw = (file: string, e: Expr, line: number): Res => {
    const k = `${file}:${e.line}:${e.column}`;
    let r = mwBound.get(k);
    if (!r) {
      r = bindMw(file, e, line);
      mwBound.set(k, r);
    }
    return r;
  };

  // ---------- roles and edges ----------
  const roleSeen = new Set<string>();
  const addRole = (target: string, role: "route_handler" | "middleware", app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (roles.length >= MAX_ROLES) {
      const cap = stop("roles", "fan-out-capped", evidence.site, [], `the plugin stopped listing roles after ${MAX_ROLES} in this build; the count is of the roles left out`);
      cap.count = (cap.count ?? 0) + 1;
      cap.exact = true;
      return;
    }
    roles.push({ target, role, detail: "gin", app, evidence });
  };
  const edgeSeen = new Set<string>();
  const addEdge = (e: FrameworkEdge): boolean => {
    if (edges.length >= MAX_EDGES) {
      stop("edges", "fan-out-capped", e.evidence.site, ["handles", "applies_middleware"], `the plugin stopped listing edges after ${MAX_EDGES} in this build`);
      return false;
    }
    const k = `${e.kind}\0${e.app ?? ""}\0${e.from}\0${e.to}\0${siteKey(e.evidence.site)}\0${e.order ?? ""}`;
    if (edgeSeen.has(k)) return false;
    edgeSeen.add(k);
    edges.push(e);
    return true;
  };
  const why = (file: string, r: Res, affects: FrameworkEdgeKind[]) => {
    if (!r.why || r.status === "external") return;
    gap({ plugin: PLUGIN, site: { file, line: r.why.at.line, column: r.why.at.column }, scope: { file }, affects, cause: r.why.cause, name: r.why.name, note: r.why.note, count: null, exact: false });
  };

  // ---------- Use calls, by the router they are made on ----------
  type Use = { file: string; call: Call };
  const uses = new Map<string, Use[]>();
  for (const file of files) {
    for (const f of of(file, "call")) {
      if (f.prop !== "Use") continue;
      const r = receiverOf(file, f.recv, f.line);
      if (r === null || r === "other") continue;
      (uses.get(r.key) ?? uses.set(r.key, []).get(r.key))?.push({ file, call: f });
    }
  }
  // Whether a Use call has run before a step (a Group call or a
  // registration): the same function and earlier, certain; another
  // function, possible; the same function and later, not at all.
  const before = (u: Use, file: string, at: Call): Tier | null => {
    if (u.file === file && (u.call.scopes[0] ?? 0) === (at.scopes[0] ?? 0)) return u.call.line < at.line || (u.call.line === at.line && u.call.column < at.column) ? "certain" : null;
    return "possible";
  };

  // ---------- registrations ----------
  const chainOf = (r: Router): Router[] => {
    const out: Router[] = [];
    for (let cur: Router | null = r; cur; cur = cur.t === "group" ? cur.parent : null) out.push(cur);
    return out.reverse();
  };
  const takeRegistration = (site: Site): boolean => {
    if (used.registrations >= MAX_REGISTRATIONS) {
      stop("registrations", "fan-out-capped", site, ["handles"], `the plugin stopped listing registrations after ${MAX_REGISTRATIONS} in this build; the routes past that are not listed`);
      return false;
    }
    used.registrations++;
    return true;
  };

  for (const file of files) {
    for (const f of of(file, "call")) {
      if (!REGISTERS.has(f.prop)) continue;
      const site: Site = { file, line: f.line, column: f.column };
      const router = receiverOf(file, f.recv, f.line);
      if (router === "other") continue;
      if (router === null) {
        if (identity(file).size > 0) gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "no-receiver-type", name: show(f.recv), note: `${f.prop} is called on ${show(f.recv)}, a value whose type the plugin does not read; if it is a gin router, this route is not listed`, count: null, exact: false });
        continue;
      }
      if (f.omitted) {
        gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles", "applies_middleware"], cause: "fan-out-capped", name: null, note: `the call has more than ${MAX_ARGS} arguments; the ${f.omitted} past that were not read, so it is not listed as a registration`, count: f.omitted, exact: true });
        continue;
      }
      if (f.prop === "Match") {
        gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "unsupported-rule", name: null, note: "Match takes its methods as a list, which the plugin does not read, so this route is not listed", count: null, exact: false });
        continue;
      }
      let methods: string[];
      let at = 1;
      if (f.prop === "Handle") {
        const m = f.args[0] ? methodOf(file, f.args[0]) : null;
        if (m === null) {
          gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "dynamic", name: null, note: "the method Handle is given is computed at run time, so this call is not listed as a registration", count: null, exact: false });
          continue;
        }
        // gin takes a method of upper-case letters only, and panics on any other.
        if (!/^[A-Z]+$/.test(m)) {
          gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "unsupported-rule", name: null, note: `gin refuses the method ${JSON.stringify(m)} (it takes upper-case letters only) and panics at this call, so it registers no route`, count: null, exact: false });
          continue;
        }
        methods = [m];
        at = 2;
      } else methods = f.prop === "Any" ? ["*"] : [f.prop];
      const pathArg = f.args[at - 1];
      const handlers = f.args.slice(at);
      const last = handlers[handlers.length - 1];
      if (!pathArg || !last) continue; // gin refuses a route with no handler
      const written = evaluate(pathArg, constantOf(file));
      if (written === null) {
        gap(
          isCut(pathArg)
            ? { plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "fan-out-capped", name: show(last), note: `the route path is longer than the plugin reads, so this call is not listed as a registration; its handler is ${show(last)}`, count: null, exact: false }
            : { plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "dynamic", name: show(last), note: `the route path ${show(pathArg)} is computed at run time, so this call is not listed as a registration; its handler is ${show(last)}`, count: null, exact: false },
        );
        continue;
      }
      if (!takeRegistration(site)) continue;
      const chain = chainOf(router);
      const root = chain[0] as Router;
      const app = root.t === "engine" ? root.engine.id : null;
      // The prefix every group adds, outermost first; null when one is computed.
      let prefix: string | null = "";
      const via: Site[] = [];
      for (const r of chain) {
        if (r.t !== "group") continue;
        via.push({ file: r.file, line: r.call.line, column: r.call.column });
        const p = r.call.args[0] ? evaluate(r.call.args[0], constantOf(r.file)) : null;
        if (p === null) {
          gap({ plugin: PLUGIN, site: { file: r.file, line: r.call.line, column: r.call.column }, scope: { file: r.file }, affects: ["handles"], cause: "dynamic", name: null, note: "the prefix this group adds is computed at run time, so the routes under it have no known path", count: null, exact: false });
          prefix = null;
        } else if (prefix !== null) prefix = join(prefix, p);
      }
      const pattern = prefix === null ? null : join(prefix, written);
      if (root.t === "unnamed") gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles", "applies_middleware"], cause: "dynamic", name: root.name, note: `the route is registered on the ${root.what} ${root.name} (${root.type}); which application it lands on, and under which prefix, is decided ${root.what === "parameter" ? "by the caller" : "where that router is made"}`, count: null, exact: false });
      const b = bind(file, last, f.line, "handler", 0);
      const id = entityId(PLUGIN, app, "registration", siteKey(site));
      registrations.push({ kind: "registration", id, plugin: PLUGIN, app, methods, pattern, written, name: null, site, mountedVia: via, mounted: app !== null, handler: { written: show(last), status: b.status, targets: b.targets } });
      why(file, b, ["handles"]);
      for (const t of b.targets) {
        const ev: FrameworkEvidence = { kind: "route-call", tier: b.tier, site, via: b.via, premises: [], rule: rule("gin-route"), note: b.note };
        addEdge({ from: id, to: t, kind: "handles", plugin: PLUGIN, app, evidence: ev });
        addRole(t, "route_handler", app, ev);
      }
      // The middleware chain: each level's own middleware and its Use calls, then the route's own.
      const chainMw: { file: string; e: Expr; tier: Tier; note: string | null; site: Site }[] = [];
      // Past MAX_MIDDLEWARE_CHAIN the rest is neither kept nor counted: the
      // work per route stays bounded however many Use calls a router has.
      let more = false;
      const addMw = (m: (typeof chainMw)[number]): boolean => {
        if (chainMw.length >= MAX_MIDDLEWARE_CHAIN) more = true;
        else chainMw.push(m);
        return !more;
      };
      levels: for (let i = 0; i < chain.length; i++) {
        const r = chain[i] as Router;
        const next = chain[i + 1];
        const stepFile = next?.t === "group" ? next.file : file;
        const stepCall = next?.t === "group" ? next.call : f;
        if (r.t === "group") for (const m of r.call.args.slice(1)) if (!addMw({ file: r.file, e: m, tier: "certain", note: null, site: { file: r.file, line: r.call.line, column: r.call.column } })) break levels;
        for (const u of uses.get(r.key) ?? []) {
          if (!step(site)) {
            more = true;
            break levels;
          }
          const tier = before(u, stepFile, stepCall);
          if (tier === null) continue;
          const note = tier === "possible" ? "gin applies Use only to the routes registered after it, and this Use call is in another function than the route, so the order is not proved" : null;
          for (const m of u.call.args) if (!addMw({ file: u.file, e: m, tier, note, site: { file: u.file, line: u.call.line, column: u.call.column } })) break levels;
        }
      }
      for (const m of handlers.slice(0, -1)) if (!addMw({ file, e: m, tier: "certain", note: null, site })) break;
      if (more) gap({ plugin: PLUGIN, site, scope: { file }, affects: ["applies_middleware"], cause: "fan-out-capped", name: null, note: `the route has more than ${MAX_MIDDLEWARE_CHAIN} middleware; those past the first ${MAX_MIDDLEWARE_CHAIN} are not listed`, count: null, exact: false });
      chainMw.forEach((m, order) => {
        const r = boundMw(m.file, m.e, m.site.line);
        why(m.file, r, ["applies_middleware"]);
        const tier: Tier = r.tier === "possible" || m.tier === "possible" ? "possible" : r.tier;
        for (const t of r.targets) {
          const ev: FrameworkEvidence = { kind: "route-call", tier, site: m.site, via: r.via, premises: [], rule: rule("gin-middleware"), note: m.note ?? r.note ?? (tier === "certain" ? null : `the middleware's binding is ${tier}`) };
          addEdge({ from: id, to: t, kind: "applies_middleware", plugin: PLUGIN, app, evidence: ev, order });
          addRole(t, "middleware", app, ev);
        }
      });
    }
  }

  // ---------- files not read ----------
  for (const file of files) {
    for (const f of index.factsOf(file)) {
      if (f.kind === "too-large" && identity(file).size > 0) {
        gap({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "applies_middleware"], cause: "file-not-parsed", name: null, note: `the file is ${f.bytes} bytes, over the ${MAX_SOURCE_BYTES} byte cap of the gin plugin, so its routes were not read`, count: null, exact: false });
      } else if (f.kind === "parse-error" && identity(file).size > 0) {
        gap({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "applies_middleware"], cause: "file-not-parsed", name: null, note: "the file has a syntax error; calls inside the broken regions were not read", count: null, exact: false });
      }
    }
  }

  const apps: Detection[] = [...engines.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({ id: e.id, name: `${e.name} (${e.file})`, project: e.project, root: e.project, site: { file: e.file, line: e.line, column: e.column }, evidence: [{ file: e.file, line: e.line, note: "made by gin's Default or New" }], version: null }));
  return { apps, output: { roles, entities: registrations, edges, unknowns } };
}

// A group's prefix and a path, as gin joins them: one slash between them,
// and the path's trailing slash kept.
export function join(prefix: string, path: string): string {
  if (path === "") return prefix === "" ? "/" : prefix;
  if (prefix === "" || prefix === "/") return path.startsWith("/") ? path : `/${path}`;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path.startsWith("/") ? `${p}${path}` : `${p}/${path}`;
}
