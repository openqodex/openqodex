// The Go net/http plugin's resolve step: which values are muxes, which calls
// register routes on them, what each registration's handler is, which muxes
// are mounted under which others, which muxes are served, and which test
// requests may reach which route.
//
// API identity: `http` is net/http only when the file imports "net/http"
// under that name, the import resolves outside the repository (the standard
// library), and no declaration inside the function shadows the name where it
// is used. A mux is a value made by `http.NewServeMux()` (or a
// `http.ServeMux{}` literal); the default mux is reached through
// `http.Handle`, `http.HandleFunc` and `http.DefaultServeMux`. A method
// named HandleFunc on any other value is no registration.
//
// Every mux is an application of its own, and so is the default mux of each
// Go project that registers on it. A mux mounted under another (`Handle` with
// a mux as the handler, directly or through `http.StripPrefix`) has its
// routes composed into the outer application as well, with the stripped
// prefix in front. Two applications never share a registration.
//
// Registrations are kept apart from their handlers: a handler that is
// missing, inline, wrapped, computed or external leaves the registration in
// place with the handler's status and an unknown that says why. A route
// whose own pattern is computed at run time is no registration: it is an
// unknown of cause "dynamic" at the call.
//
// Every kind of work is capped per build, never per application or file:
// registrations, mount expansions, middleware edges, test requests, pattern
// match steps, composition steps and lookups. Each cap, once reached, adds
// one unknown and stops that kind of work for the rest of the build.
import type { Cause, Tier } from "../../model/records.js";
import type { DefFact, GraphNode, TypeRef } from "../../types.js";
import type { Detection, FrameworkEdge, FrameworkEdgeKind, FrameworkEvidence, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { Expr, GoHttpFact } from "./facts.js";
import { evaluate, isCut, MAX_ARGS, MAX_EXPR_DEPTH, MAX_SOURCE_BYTES, show } from "./facts.js";

export const PLUGIN = "go-http";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// The caps, per build.
export const MAX_REGISTRATIONS = 10_000; // registrations created
export const MAX_MOUNTS = 2000; // sub-mux expansions followed
// Kept well below what the framework stage can append in one call.
export const MAX_MIDDLEWARE_EDGES = 30_000; // applies_middleware edges
export const MAX_TEST_REQUESTS = 2000; // httptest requests matched
export const MAX_TEST_LINKS = 10_000; // tests edges made from requests
export const MAX_MATCH_WORK = 4_000_000; // pattern segments compared
export const MAX_COMPOSE_STEPS = 1_000_000; // registration calls visited while composing muxes
export const MAX_LOOKUPS = 100_000; // names looked up through the index
// Every list the plugin returns, so none can overflow the stage that appends it.
export const MAX_APPS = 5000; // muxes and default muxes
export const MAX_ROLES = 10_000;
export const MAX_EDGES = 60_000; // all kinds together
export const MAX_UNKNOWNS = 10_000; // besides the one unknown each cap adds when it stops
// The caps per item: a registration's wrapper chain, a branch of mounts, a pattern.
export const MAX_MIDDLEWARE_CHAIN = 64;
export const MAX_MOUNT_DEPTH = 8;
export const MAX_PATTERN_SEGMENTS = 64;
const MAX_VALUE_STEPS = 8; // `a := b` hops followed to reach a mux or a handler

type Fact<K extends GoHttpFact["kind"]> = Extract<GoHttpFact, { kind: K }>;
type Via = FrameworkEvidence["via"];

// A mux: an application. `dflt` marks a project's default mux.
type Mux = { kind: "mux"; id: string; file: string; name: string; line: number; column: number; project: string; dflt: boolean; served: Site[]; first: Site | null };
// A registration's receiver typed as a mux the plugin cannot name: a
// parameter (the caller decides which), a struct field or a call's declared
// result (the code sets it elsewhere).
type ParamMux = { kind: "param"; what: "parameter" | "field" | "result"; file: string; name: string; type: string; line: number };

type Event = { file: string; site: Site; prop: "Handle" | "HandleFunc"; pattern: Expr; handler: Expr };

type Why = { cause: Cause; note: string; name: string | null; at: { line: number; column: number }; affects: FrameworkEdgeKind[] };
type Wrapper = { targets: string[]; tier: Tier; via: Via; note: string | null };
type Bound = {
  status: HandlerStatus;
  targets: string[];
  tier: Tier;
  via: Via;
  note: string | null;
  why: Why | null;
  wrappers: Wrapper[]; // outermost first
  // More wrappers than MAX_MIDDLEWARE_CHAIN: how many past it were left out,
  // exact unless the chain itself ran past a read limit.
  wrapCut: { count: number; exact: boolean } | null;
  mount: { mux: Mux; strip: string | null | undefined } | null; // strip: undefined none, null computed
};

type Decl = { kind: "value"; file: string; fact: Fact<"value"> } | { kind: "param"; file: string; fact: Fact<"param"> };

type Identity = { http: Set<string>; httptest: Set<string>; testing: Set<string> };

type FileIndex = {
  byDecl: Map<string, Fact<"value">[]>; // the values bound to each local declaration
  paramByDecl: Map<string, Fact<"param">>;
  paramsOf: Map<number, Fact<"param">[]>; // by the line of the function that declares them
  consts: Map<string, string>;
  serveHttp: Map<string, Fact<"serve-http">>; // by receiver type and line
};

// The standard library's handler wrappers whose first argument is the handler they serve.
const STDLIB_WRAPPERS = new Set(["TimeoutHandler", "MaxBytesHandler", "AllowQuerySemicolons"]);
export const METHOD_CONSTANTS: Record<string, string> = {
  MethodGet: "GET",
  MethodHead: "HEAD",
  MethodPost: "POST",
  MethodPut: "PUT",
  MethodPatch: "PATCH",
  MethodDelete: "DELETE",
  MethodConnect: "CONNECT",
  MethodOptions: "OPTIONS",
  MethodTrace: "TRACE",
};
const SERVE_ARG: Record<string, number> = { ListenAndServe: 1, ListenAndServeTLS: 3, Serve: 1, ServeTLS: 1 };
// What a wrapper no rule binds hides: the handler and the middleware.
const WRAPPED: FrameworkEdgeKind[] = ["handles", "applies_middleware"];

const dirOf = (file: string): string => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
};
const lastOf = (spec: string): string => spec.slice(spec.lastIndexOf("/") + 1);
const siteKey = (s: Site): string => `${s.file}:${s.line}:${s.column}`;

export type Analysis = { apps: Detection[]; output: PluginOutput };

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<GoHttpFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

function run(index: PluginIndex<GoHttpFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];

  // ---------- caps ----------
  const used = { registrations: 0, mounts: 0, middleware: 0, requests: 0, testLinks: 0, match: 0, steps: 0, lookups: 0 };
  // The one unknown each cap adds when it stops, by cap; it is never counted
  // against MAX_UNKNOWNS, so a cap is always said.
  const stopped = new Map<string, FrameworkUnknown>();
  const stop = (key: keyof typeof used | "depth" | "apps" | "roles" | "edges" | "unknowns", cause: Cause, site: Site | null, affects: FrameworkEdgeKind[], note: string): FrameworkUnknown => {
    const kept = stopped.get(key);
    if (kept) return kept;
    const u: FrameworkUnknown = { plugin: PLUGIN, site, scope: { build: true }, affects, cause, name: null, note, count: null, exact: false };
    stopped.set(key, u);
    unknowns.push(u);
    return u;
  };
  // Every other unknown, at most MAX_UNKNOWNS; past that only counted, with
  // no check for repeats, so the count is a bound and not exact.
  let listedUnknowns = 0;
  const addUnknown = (u: FrameworkUnknown) => {
    if (listedUnknowns >= MAX_UNKNOWNS) {
      const cap = stop("unknowns", "fan-out-capped", u.site, [], `the plugin stopped listing unknowns after ${MAX_UNKNOWNS} in this build; the count is of the gaps left out`);
      cap.count = (cap.count ?? 0) + 1;
      return;
    }
    listedUnknowns++;
    unknowns.push(u);
  };
  const seenGaps = new Set<string>();
  const gap = (u: FrameworkUnknown) => {
    if (listedUnknowns >= MAX_UNKNOWNS) return addUnknown(u);
    const k = `${u.cause}\0${u.site ? siteKey(u.site) : ""}\0${u.name ?? ""}\0${"file" in u.scope ? u.scope.file : ""}`;
    if (seenGaps.has(k)) return;
    seenGaps.add(k);
    addUnknown(u);
  };
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (used.lookups >= MAX_LOOKUPS) {
      stop("lookups", "budget", { file, line: 1, column: 1 }, ["handles", "mounts", "applies_middleware"], `the plugin stopped looking names up after ${MAX_LOOKUPS} lookups in this build; handlers met after that are not bound`);
      return { kind: "gap", cause: "budget", note: `the lookup budget of ${MAX_LOOKUPS} ran out`, candidates: null };
    }
    used.lookups++;
    return index.lookup(file, path);
  };

  // ---------- files, packages and their facts ----------
  const files = index.factFiles();
  const goFiles = new Map<string, string[]>(); // folder to its Go files
  for (const p of index.paths()) {
    if (!p.endsWith(".go")) continue;
    const d = dirOf(p);
    const list = goFiles.get(d);
    if (list) list.push(p);
    else goFiles.set(d, [p]);
  }
  const pkgName = (file: string): string => index.languageFacts(file)?.goPackage ?? "";
  // The package a folder's non-test files declare, read once per folder.
  const dirPackages = new Map<string, string>();
  const pkgOfDir = (dir: string): string => {
    const kept = dirPackages.get(dir);
    if (kept !== undefined) return kept;
    let found = "";
    for (const f of goFiles.get(dir) ?? []) {
      const p = pkgName(f);
      if (p !== "" && !p.endsWith("_test")) {
        found = p;
        break;
      }
    }
    dirPackages.set(dir, found);
    return found;
  };
  const of = <K extends GoHttpFact["kind"]>(file: string, kind: K): Fact<K>[] => index.factsOf(file).filter((f): f is Fact<K> => f.kind === kind);

  const fileIndexes = new Map<string, FileIndex>();
  const fileIndex = (file: string): FileIndex => {
    let fi = fileIndexes.get(file);
    if (fi) return fi;
    fi = { byDecl: new Map(), paramByDecl: new Map(), paramsOf: new Map(), consts: new Map(), serveHttp: new Map() };
    for (const f of index.factsOf(file)) {
      if (f.kind === "value") {
        if (f.decl !== null) (fi.byDecl.get(f.decl) ?? fi.byDecl.set(f.decl, []).get(f.decl))?.push(f);
      } else if (f.kind === "param") {
        fi.paramByDecl.set(f.decl, f);
        (fi.paramsOf.get(f.scope) ?? fi.paramsOf.set(f.scope, []).get(f.scope))?.push(f);
      } else if (f.kind === "const") fi.consts.set(f.name, f.value);
      else if (f.kind === "serve-http") fi.serveHttp.set(`${f.recv}\0${f.line}`, f);
    }
    fileIndexes.set(file, fi);
    return fi;
  };
  // Package-level values by folder, package and name: declared at package
  // level, or assigned to a package variable inside a function.
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

  // ---------- which local names are net/http, httptest and testing ----------
  const identities = new Map<string, Identity>();
  const identity = (file: string): Identity => {
    let id = identities.get(file);
    if (id) return id;
    id = { http: new Set(), httptest: new Set(), testing: new Set() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf || lf.lang !== "go") return id;
    const stdlib = (spec: string) => index.module(file, spec).kind === "external";
    for (const imp of lf.imports) {
      if (imp.scoped || imp.star) continue;
      const local = imp.namespace ?? lastOf(imp.spec);
      if (local === "_" || local === "") continue;
      if (imp.spec === "net/http" && stdlib(imp.spec)) id.http.add(local);
      else if (imp.spec === "net/http/httptest" && stdlib(imp.spec)) id.httptest.add(local);
      else if (imp.spec === "testing" && stdlib(imp.spec)) id.testing.add(local);
    }
    // A package-level definition of the same name would not compile; it never passes for the package.
    for (const d of lf.defs) {
      if (!d.topLevel) continue;
      id.http.delete(d.name);
      id.httptest.delete(d.name);
      id.testing.delete(d.name);
    }
    return id;
  };
  const isPkg = (file: string, e: Expr, set: keyof Identity, member: string | null): boolean =>
    e.t === "ref" && !e.local && e.path.length === (member === null ? 1 : 2) && identity(file)[set].has(e.path[0] as string) && (member === null || e.path[1] === member);

  // ---------- names and values ----------
  // What a name holds at a line. A local name reads the one declaration the
  // walk saw it name (`decl`, from facts.ts): the latest value bound to that
  // declaration before the line, else the parameter it is. A name no
  // function declares reads a package-level value of the file's package.
  // `strict` skips a value bound on the line itself (`mux = wrap(mux)`
  // reads the mux before the assignment).
  const declOf = (file: string, name: string, decl: string | null, line: number, strict: boolean): Decl | null => {
    if (decl === null) return topValue(dirOf(file), pkgName(file), name);
    const fi = fileIndex(file);
    let best: Fact<"value"> | null = null;
    for (const v of fi.byDecl.get(decl) ?? []) if ((strict ? v.line < line : v.line <= line) && (!best || v.line > best.line)) best = v;
    if (best) return { kind: "value", file, fact: best };
    const p = fi.paramByDecl.get(decl);
    return p ? { kind: "param", file, fact: p } : null;
  };
  // The declaration a name chain's head names, and what is left of the chain:
  // a local or a package-level value of this package, or a value of another
  // package named `pkg.Name`.
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

  const muxes = new Map<string, Mux>();
  // Muxes past MAX_APPS are no application; the cap's unknown counts them.
  const leftApps = new Set<string>();
  const roomFor = (id: string, site: Site): boolean => {
    if (muxes.size < MAX_APPS) return true;
    leftApps.add(id);
    const cap = stop("apps", "fan-out-capped", site, ["handles", "mounts"], `the plugin stopped listing applications after ${MAX_APPS} muxes in this build; the routes of the muxes past that are not listed`);
    cap.count = leftApps.size;
    cap.exact = true;
    return false;
  };
  const muxAt = (file: string, f: Fact<"value">): Mux | null => {
    const id = appId(PLUGIN, file, f.line);
    let m = muxes.get(id);
    if (!m) {
      if (!roomFor(id, { file, line: f.line, column: f.column })) return null;
      m = { kind: "mux", id, file, name: f.name, line: f.line, column: f.column, project: index.projectOf(file), dflt: false, served: [], first: null };
      muxes.set(id, m);
    }
    return m;
  };
  const modPath = (project: string): string => (project === "" ? "go.mod" : `${project}/go.mod`);
  const defaultMux = (project: string, create: Site | null): Mux | null => {
    const id = appId(PLUGIN, modPath(project), 1);
    let m = muxes.get(id);
    if (!m && create && roomFor(id, create)) {
      m = { kind: "mux", id, file: modPath(project), name: "http.DefaultServeMux", line: 1, column: 1, project, dflt: true, served: [], first: create };
      muxes.set(id, m);
    }
    return m ?? null;
  };
  // Whether a value expression makes a mux: `http.NewServeMux()`, `http.ServeMux{}`.
  const makesMux = (file: string, e: Expr): boolean =>
    (e.t === "call" && e.args.length === 0 && isPkg(file, e.fn, "http", "NewServeMux")) || (e.t === "lit" && e.type !== null && e.type.length === 2 && identity(file).http.has(e.type[0] as string) && e.type[1] === "ServeMux");

  const muxOfDecl = (d: Decl | null, create: Site | null, steps: number): Mux | ParamMux | null => {
    if (!d || steps > MAX_VALUE_STEPS) return null;
    if (d.kind === "param") {
      const t = d.fact.type;
      return t.length === 2 && identity(d.file).http.has(t[0] as string) && t[1] === "ServeMux" ? { kind: "param", what: "parameter", file: d.file, name: d.fact.name, type: `${d.fact.pointer ? "*" : ""}${t.join(".")}`, line: d.fact.line } : null;
    }
    const v = d.fact;
    if (makesMux(d.file, v.value)) return muxAt(d.file, v);
    return v.value.t === "ref" ? muxOfRef(d.file, v.value, v.line, true, create, steps + 1) : null;
  };
  const muxOfRef = (file: string, e: Expr, line: number, strict: boolean, create: Site | null, steps: number): Mux | ParamMux | null => {
    if (e.t !== "ref" || steps > MAX_VALUE_STEPS) return null;
    if (isPkg(file, e, "http", "DefaultServeMux")) return defaultMux(index.projectOf(file), create);
    const found = declPath(file, e.path, e.decl, line, strict);
    return found && found.rest.length === 0 ? muxOfDecl(found.decl, create, steps) : null;
  };

  // Every mux made anywhere is an application, registered on or not.
  for (const file of files) for (const v of of(file, "value")) if (makesMux(file, v.value)) muxAt(file, v);

  // ---------- handlers ----------
  // Each package's methods by `Type.method`, built once per package from the
  // symbol ids (`file#Type.method@line:column`): a lookup per handler type
  // never scans the package again.
  const packageMethods = new Map<string, Map<string, string[]>>();
  const methodsOf = (dir: string, pkg: string): Map<string, string[]> => {
    const k = `${dir}\0${pkg}`;
    let m = packageMethods.get(k);
    if (m) return m;
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
    return m;
  };
  // The methods named `name` declared on a type in its package.
  const methodsOn = (type: GraphNode, name: string): string[] => methodsOf(dirOf(type.file), pkgName(type.file)).get(`${type.name}.${name}`) ?? [];
  // Each file's definitions (language facts) by name and line, built once per file.
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
  const embeds = (type: GraphNode): boolean => (defOf(type)?.bases.length ?? 0) > 0;
  // Whether a declared type is net/http's ServeMux, read in the file that declares it.
  const isServeMux = (file: string, t: TypeRef | null | undefined): boolean => !!t && t.qualifier !== null && identity(file).http.has(t.qualifier) && t.name === "ServeMux";
  // Each file's functions by name and line, built once per file.
  const functionsByPlace = new Map<string, Map<string, GraphNode>>();
  const functionAt = (file: string, name: string, line: number): GraphNode | null => {
    let m = functionsByPlace.get(file);
    if (!m) {
      m = new Map();
      for (const n of index.symbols(file)) if (n.kind === "function") m.set(`${n.name}\0${n.startLine}`, n);
      functionsByPlace.set(file, m);
    }
    return m.get(`${name}\0${line}`) ?? null;
  };

  type Res = Omit<Bound, "wrappers" | "wrapCut" | "mount">;
  // A handler no rule binds: its status and the unknown that says why, with
  // the relations it hides (the handles edge, and middleware for a call).
  const fail = (status: HandlerStatus, cause: Cause, note: string, name: string | null, at: Expr, affects: FrameworkEdgeKind[] = ["handles"]): Res => ({ status, targets: [], tier: "certain", via: null, note: null, why: { cause, note, name, at: { line: at.line, column: at.column }, affects } });
  const fromLookup = (found: Lookup, e: Expr, what: string): Res => {
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${what}'s binding is ${found.tier}`), why: null };
      case "external":
        return fail("external", "external", `${show(e)} comes from the standard library or a declared dependency`, show(e), e);
      case "gap":
        return fail(found.cause === "ambiguous" ? "ambiguous" : found.cause === "miss" ? "missing" : "unresolved", found.cause, found.note, show(e), e);
      case "miss":
        return fail("missing", "miss", `the ${what} ${show(e)} names ${found.name} in ${found.target.startsWith("go:") ? found.target.slice(3) : found.target}, where no such definition exists now`, show(e), e);
      default:
        return fail("missing", "miss", `no definition named ${show(e)} is in scope`, show(e), e);
    }
  };

  // The type a value has, read from its declaration: a parameter's declared
  // type or a composite literal's type.
  const typeOfDecl = (d: Decl): { file: string; path: string[] } | null => {
    if (d.kind === "param") return d.fact.func ? null : { file: d.file, path: d.fact.type };
    const v = d.fact.value;
    return v.t === "lit" && v.type ? { file: d.file, path: v.type } : null;
  };
  const typeNode = (file: string, path: string[]): { node: GraphNode; found: Lookup } | { found: Lookup } => {
    const found = lookup(file, path);
    if (found.kind !== "symbol") return { found };
    const node = found.ids.map((id) => index.node(id)).find((n): n is GraphNode => n !== null && n.kind === "type");
    return node ? { node, found } : { found };
  };
  // A method value `x.m` whose receiver's type is declared: the method m of that type.
  const methodValue = (d: Decl, method: string, e: Expr, what: string): Res => {
    const t = typeOfDecl(d);
    if (!t) return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a method of a value whose type no rule reads`, show(e), e);
    const tn = typeNode(t.file, t.path);
    if (!("node" in tn)) return tn.found.kind === "symbol" ? fail("unresolved", "unsupported-rule", `${t.path.join(".")} is not a type declared in the repository`, show(e), e) : fromLookup(tn.found, e, what);
    const ids = methodsOn(tn.node, method);
    if (ids.length === 0) return fail("unresolved", "unsupported-rule", `${t.path.join(".")} declares no method ${method} in its package; a promoted method or a field of function type is not followed`, show(e), e);
    const f = tn.found as Extract<Lookup, { kind: "symbol" }>;
    return { status: "bound", targets: ids, tier: f.tier, via: f.via, note: f.tier === "certain" ? `the ${what} is the method value ${show(e)} of ${t.path.join(".")}` : (f.note ?? `the type's binding is ${f.tier}`), why: null };
  };
  // A type used as a handler (`T{}`, `&pkg.T{}`): its ServeHTTP method.
  const servesType = (file: string, e: Extract<Expr, { t: "lit" }>): Res => {
    if (!e.type) return fail("dynamic", "dynamic", "the handler is a literal of an unnamed type", null, e);
    const tn = typeNode(file, e.type);
    if (!("node" in tn)) return tn.found.kind === "symbol" ? fail("unresolved", "unsupported-rule", `${e.type.join(".")} is not a type declared in the repository`, show(e), e) : fromLookup(tn.found, e, "handler");
    const ids = methodsOn(tn.node, "ServeHTTP");
    if (ids.length === 0) {
      return embeds(tn.node)
        ? fail("unresolved", "unsupported-rule", `${e.type.join(".")} declares no ServeHTTP method of its own; one promoted from an embedded field is not followed`, show(e), e)
        : fail("missing", "miss", `${e.type.join(".")} declares no ServeHTTP method in its package`, show(e), e);
    }
    const m = index.node(ids[0] as string);
    const fact = m ? fileIndex(m.file).serveHttp.get(`${tn.node.name}\0${m.startLine}`) : undefined;
    const recv = fact ? ` (${fact.pointer ? "pointer" : "value"} receiver)` : "";
    const f = tn.found as Extract<Lookup, { kind: "symbol" }>;
    return { status: "bound", targets: ids, tier: f.tier, via: f.via, note: f.tier === "certain" ? `served through ${tn.node.name}.ServeHTTP${recv}` : (f.note ?? `the type's binding is ${f.tier}`), why: null };
  };

  // A name used as a handler or a function value.
  const bindRef = (file: string, e: Extract<Expr, { t: "ref" }>, line: number, isFunc: boolean, steps: number): Res | { follow: Decl } => {
    const what = isFunc ? "handler function" : "handler";
    if (isPkg(file, { ...e, path: e.path.slice(0, 1) }, "http", null)) return fail("external", "external", `${show(e)} is a handler of the standard library`, show(e), e);
    const symbol = e.local ? null : lookup(file, e.path);
    if (symbol?.kind === "symbol") return fromLookup(symbol, e, what);
    const found = declPath(file, e.path, e.decl, line, false);
    if (found && found.rest.length === 0 && found.decl.kind === "value" && steps < MAX_VALUE_STEPS) return { follow: found.decl };
    if (found && found.rest.length === 1) return methodValue(found.decl, found.rest[0] as string, e, what);
    if (found || e.local) return fail("dynamic", "dynamic", `the ${what} ${show(e)} is a value the code computes, not a definition`, show(e), e);
    return fromLookup(symbol ?? { kind: "none" }, e, what);
  };

  // What a call used as a handler is: a wrapper of the repository (a
  // function that takes a handler and returns one), with the position of the
  // handler it takes, or null.
  const wrappers = new Map<string, { arg: number; func: boolean } | null>();
  const handlerParam = (id: string): { arg: number; func: boolean } | null => {
    if (wrappers.has(id)) return wrappers.get(id) ?? null;
    const node = index.node(id);
    let found: { arg: number; func: boolean } | null = null;
    if (node) {
      const http = identity(node.file).http;
      const param = (fileIndex(node.file).paramsOf.get(node.startLine) ?? []).find((p) => p.index >= 0 && (p.func || (p.type.length === 2 && http.has(p.type[0] as string) && (p.type[1] === "Handler" || p.type[1] === "HandlerFunc"))));
      if (param) found = { arg: param.index, func: param.func || param.type[1] === "HandlerFunc" };
    }
    wrappers.set(id, found);
    return found;
  };
  const callees = new Map<string, Res>();
  const wrapperOf = (file: string, call: Extract<Expr, { t: "call" }>, line: number): { res: Res; arg: number; func: boolean } | null => {
    const fn = call.fn;
    if (fn.t !== "ref") return null;
    let res: Res;
    if (fn.local) {
      const found = declPath(file, fn.path, fn.decl, line, false);
      if (!found || found.rest.length !== 1) return null;
      res = methodValue(found.decl, found.rest[0] as string, fn, "middleware");
    } else {
      // A wrapper named at the top of a file binds the same way at every call.
      const k = `${file}\0${fn.path.join(".")}`;
      res = callees.get(k) ?? fromLookup(lookup(file, fn.path), fn, "middleware");
      callees.set(k, res);
    }
    if (res.status !== "bound") return null;
    const p = handlerParam(res.targets[0] as string);
    return p ? { res, ...p } : null;
  };

  const bind = (file: string, e: Expr, line: number, isFunc: boolean, steps: number): Bound => {
    const wrappers: Wrapper[] = [];
    let left = 0; // wrappers past MAX_MIDDLEWARE_CHAIN
    let strip: string | null | undefined;
    let cur = e;
    let fnValue = isFunc;
    const wrapCut = (): Bound["wrapCut"] => (left > 0 ? { count: left, exact: !isCut(cur) } : null);
    const done = (r: Res, mount: Bound["mount"] = null): Bound => ({ ...r, wrappers, wrapCut: wrapCut(), mount });
    for (let guard = 0; cur.t === "call" && guard <= MAX_EXPR_DEPTH; guard++) {
      const call: Extract<Expr, { t: "call" }> = cur;
      const fn = call.fn;
      if (fn.t === "ref" && !fn.local && fn.path.length === 2 && identity(file).http.has(fn.path[0] as string)) {
        const name = fn.path[1] as string;
        if (name === "HandlerFunc" && !fnValue && call.args.length === 1) {
          cur = call.args[0] as Expr;
          fnValue = true;
          continue;
        }
        if (name === "StripPrefix" && !fnValue && call.args.length === 2) {
          const p = evaluate(call.args[0] as Expr, constantOf(file));
          strip = strip === null || p === null ? null : `${strip ?? ""}${p}`;
          cur = call.args[1] as Expr;
          continue;
        }
        if (STDLIB_WRAPPERS.has(name) && !fnValue && call.args.length >= 1) {
          cur = call.args[0] as Expr;
          continue;
        }
        return done(fail("external", "external", `the handler is ${show(call)}, which the standard library builds`, show(call), call));
      }
      const w = wrapperOf(file, call, line);
      if (!w) {
        // A call no rule binds as a wrapper may be middleware of its own: it
        // hides the middleware edge as well as the handler.
        return done(
          wrappers.length > 0
            ? fail("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether the wrappers call ${show(call)} is not proved, so the handler is not bound`, show(call), e, WRAPPED)
            : fail("unresolved", "unsupported-rule", `the handler is the value ${show(call)} returns; no rule reads what it returns, so neither the handler nor any middleware it applies is listed`, show(call), call, call.args.length > 0 ? WRAPPED : undefined),
        );
      }
      if (wrappers.length < MAX_MIDDLEWARE_CHAIN) wrappers.push({ targets: w.res.targets, tier: w.res.tier, via: w.res.via, note: w.res.note });
      else left++;
      // The handler argument past the arguments read is not known: a read limit.
      cur = call.args[w.arg] ?? { t: "other", cut: call.omitted !== undefined, line: call.line, column: call.column };
      fnValue = w.func;
    }
    if (wrappers.length > 0) {
      const outer = show(e.t === "call" ? e.fn : e);
      return done(fail("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether ${outer} calls ${show(cur)} is not proved, so the handler is not bound`, show(cur), e, WRAPPED));
    }
    switch (cur.t) {
      case "fn":
        return done(fail("unresolved", "unsupported-rule", "the handler is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it", null, cur));
      case "lit":
        return fnValue ? done(fail("dynamic", "dynamic", `the handler ${show(cur)} is not a function`, show(cur), cur)) : done(servesType(file, cur));
      case "ref": {
        if (!fnValue) {
          const m = muxOfRef(file, cur, line, false, null, 0);
          if (m?.kind === "mux") return done({ status: "bound", targets: [], tier: "certain", via: null, note: null, why: null }, { mux: m, strip });
          if (m?.kind === "param") return done(fail("dynamic", "dynamic", `the handler is the ${m.what} ${m.name} (${m.type}), a mux the plugin cannot name`, m.name, cur, ["handles", "mounts"]));
        }
        const r = bindRef(file, cur, line, fnValue, steps);
        if ("follow" in r) {
          const d = r.follow as Extract<Decl, { kind: "value" }>;
          const inner = bind(d.file, d.fact.value, d.fact.line, fnValue, steps + 1);
          const outer = wrapCut();
          const both = outer && inner.wrapCut ? { count: outer.count + inner.wrapCut.count, exact: outer.exact && inner.wrapCut.exact } : (outer ?? inner.wrapCut);
          return { ...inner, wrappers: [...wrappers, ...inner.wrappers], wrapCut: both };
        }
        return done(r);
      }
      default:
        if (isCut(cur)) return done(fail("unresolved", "fan-out-capped", "the handler expression is longer than the plugin reads, so the handler is not known", null, cur));
        return done(fail("dynamic", "dynamic", `the handler is computed (${show(cur)})`, null, cur));
    }
  };
  const bound = new Map<Event, Bound>();
  const boundOf = (e: Event): Bound => {
    let b = bound.get(e);
    if (!b) {
      b = bind(e.file, e.handler, e.site.line, e.prop === "HandleFunc", 0);
      bound.set(e, b);
    }
    return b;
  };

  // ---------- registrations and servers ----------
  // What a call returns, by the callee's declared result: a ServeMux, another
  // type, or not known.
  const resultOf = (file: string, call: Extract<Expr, { t: "call" }>): "mux" | "other" | null => {
    const fn = call.fn;
    if (fn.t !== "ref" || fn.local) return null;
    if (isPkg(file, fn, "http", "NewServeMux")) return "mux";
    if (fn.path.length === 2 && identity(file).http.has(fn.path[0] as string)) return "other";
    const found = lookup(file, fn.path);
    if (found.kind === "external") return "other";
    const node = found.kind === "symbol" ? index.node(found.ids[0] as string) : null;
    const def = node ? defOf(node) : null;
    if (!node || !def) return null;
    const r = def.results?.[0];
    return r && isServeMux(node.file, r) ? "mux" : "other";
  };
  const resultMux = (file: string, call: Expr, line: number): ParamMux => ({ kind: "param", what: "result", file, name: show(call), type: "*http.ServeMux", line });
  // What a registration call's receiver is: a mux; a mux the plugin cannot
  // name (a parameter, a field or a call's result typed as one); "other" for
  // a value known not to be a net/http mux; null when the plugin cannot tell.
  const receiverOf = (file: string, recv: Expr, line: number, create: Site | null): Mux | ParamMux | "other" | null => {
    if (isPkg(file, recv, "http", null)) return defaultMux(index.projectOf(file), create) ?? "other";
    if (recv.t === "call") {
      const r = resultOf(file, recv);
      return r === "mux" ? resultMux(file, recv, line) : r;
    }
    if (recv.t !== "ref") return null;
    const direct = muxOfRef(file, recv, line, false, create, 0);
    if (direct) return direct;
    if (isPkg(file, recv, "http", "DefaultServeMux")) return "other"; // past the application cap
    const found = declPath(file, recv.path, recv.decl, line, false);
    if (!found) {
      // `router.HandleFunc` of another package's function, or a dependency's value.
      if (recv.decl !== null) return null;
      const m = lookup(file, recv.path);
      return m.kind === "module" || m.kind === "external" ? "other" : null;
    }
    const d = found.decl;
    if (found.rest.length === 0) {
      if (d.kind === "param") return "other"; // typed, and not a ServeMux
      const v = d.fact.value;
      if (v.t === "call") {
        const r = resultOf(d.file, v);
        return r === "mux" ? resultMux(d.file, v, d.fact.line) : r;
      }
      return v.t === "ref" || v.t === "other" ? null : "other";
    }
    if (found.rest.length !== 1) return null;
    // A field: its declared type, read from the struct that declares it.
    const t = typeOfDecl(d);
    if (!t) return null;
    const tn = typeNode(t.file, t.path);
    if (!("node" in tn)) return tn.found.kind === "external" ? "other" : null;
    const field = defOf(tn.node)?.fields[found.rest[0] as string];
    if (!field) return null;
    return isServeMux(tn.node.file, field) ? { kind: "param", what: "field", file, name: show(recv), type: `${field.qualifier}.${field.name}`, line } : "other";
  };

  const events = new Map<string, Event[]>();
  const paramEvents: { param: ParamMux; event: Event }[] = [];
  for (const file of files) {
    for (const f of of(file, "call")) {
      if (f.prop !== "Handle" && f.prop !== "HandleFunc") continue;
      const pattern = f.args[0];
      const handler = f.args[1];
      const site: Site = { file, line: f.line, column: f.column };
      const whole = !f.omitted && pattern !== undefined && handler !== undefined && f.args.length === 2;
      if (!whole && !f.omitted) continue; // Handle and HandleFunc take two arguments
      const target = receiverOf(file, f.recv, f.line, whole ? site : null);
      if (target === "other") continue;
      if (target === null) {
        if (identity(file).http.size > 0) {
          gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "no-receiver-type", name: show(f.recv), note: `${f.prop} is called on ${show(f.recv)}, a value whose type the plugin does not read; if it is a net/http mux, this route is not listed`, count: null, exact: false });
        }
        continue;
      }
      if (!whole) {
        gap({ plugin: PLUGIN, site, scope: { file }, affects: ["handles"], cause: "fan-out-capped", name: null, note: `the call has more than ${MAX_ARGS} arguments; the ${f.omitted ?? 0} past that were not read, so it is not listed as a registration`, count: f.omitted ?? null, exact: f.omitted !== undefined });
        continue;
      }
      const event: Event = { file, site, prop: f.prop, pattern: pattern as Expr, handler: handler as Expr };
      if (target.kind === "param") {
        paramEvents.push({ param: target, event });
        continue;
      }
      (events.get(target.id) ?? events.set(target.id, []).get(target.id))?.push(event);
    }
  }
  for (const list of events.values()) list.sort((a, b) => (a.file === b.file ? a.site.line - b.site.line || a.site.column - b.site.column : a.file < b.file ? -1 : 1));

  // A server serves a mux, the default one when given nil.
  const serve = (file: string, e: Expr, site: Site) => {
    let cur = e;
    // `ListenAndServe(addr, logging(mux))` still serves mux.
    for (let i = 0; i < MAX_MOUNT_DEPTH && cur.t === "call"; i++) cur = cur.args.find((a) => a.t === "ref" || a.t === "call" || isCut(a)) ?? cur.args[0] ?? cur;
    if (isCut(cur)) {
      gap({ plugin: PLUGIN, site, scope: { file }, affects: [], cause: "fan-out-capped", name: null, note: "the handler this server is given lies past the plugin's read limit, so which mux it serves is not known", count: null, exact: false });
      return;
    }
    const m = cur.t === "nil" ? defaultMux(index.projectOf(file), null) : muxOfRef(file, cur, site.line, false, null, 0);
    if (m && m.kind === "mux" && !m.served.some((s) => siteKey(s) === siteKey(site))) m.served.push(site);
  };
  for (const file of files) {
    for (const f of of(file, "call")) {
      const at = SERVE_ARG[f.prop];
      if (at === undefined || !isPkg(file, f.recv, "http", null)) continue;
      const arg = f.args[at];
      if (arg) serve(file, arg, { file, line: f.line, column: f.column });
    }
    for (const f of of(file, "server")) {
      if (!identity(file).http.has(f.type[0] as string)) continue;
      serve(file, f.handler ?? { t: "nil", line: f.line, column: f.column }, { file, line: f.line, column: f.column });
    }
  }

  // ---------- patterns ----------
  const roleSeen = new Set<string>();
  const addRole = (target: string, role: "route_handler" | "middleware" | "test", detail: string, app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (roles.length >= MAX_ROLES) {
      const cap = stop("roles", "fan-out-capped", evidence.site, [], `the plugin stopped listing roles after ${MAX_ROLES} in this build; the count is of the roles left out`);
      cap.count = (cap.count ?? 0) + 1;
      cap.exact = true;
      return;
    }
    roles.push({ target, role, detail, app, evidence });
  };
  // Past MAX_EDGES no edge is kept, and none is counted: the work stops.
  const edgeSeen = new Set<string>();
  const addEdge = (e: FrameworkEdge): boolean => {
    if (edges.length >= MAX_EDGES) {
      stop("edges", "fan-out-capped", e.evidence.site, ["handles", "mounts", "applies_middleware", "tests"], `the plugin stopped listing edges after ${MAX_EDGES} in this build`);
      return false;
    }
    const k = `${e.kind}\0${e.app ?? ""}\0${e.from}\0${e.to}\0${siteKey(e.evidence.site)}\0${e.order ?? ""}`;
    if (edgeSeen.has(k)) return false;
    edgeSeen.add(k);
    edges.push(e);
    return true;
  };

  // A route that is not a registration: its own pattern is computed, or is
  // longer than the plugin reads (that is a read limit, never "computed").
  const computedPattern = (e: Event) =>
    gap(
      isCut(e.pattern)
        ? { plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles"], cause: "fan-out-capped", name: show(e.handler), note: `the route pattern is longer than the plugin reads, so this call is not listed as a registration; its handler is ${show(e.handler)}`, count: null, exact: false }
        : { plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles"], cause: "dynamic", name: show(e.handler), note: `the route pattern ${show(e.pattern)} is computed at run time, so this call is not listed as a registration; its handler is ${show(e.handler)}`, count: null, exact: false },
    );

  // The handles edge, the handler's unknown and the middleware chain of one registration.
  const attach = (reg: Registration, e: Event, b: Bound) => {
    const app = reg.app;
    if (b.why) gap({ plugin: PLUGIN, site: { file: e.file, line: b.why.at.line, column: b.why.at.column }, scope: { file: e.file }, affects: b.why.affects, cause: b.why.cause, name: b.why.name, note: b.why.note, count: null, exact: false });
    for (const t of b.targets) {
      const ev: FrameworkEvidence = { kind: "route-call", tier: b.tier, site: e.site, via: b.via, premises: [], rule: rule("go-http-route"), note: b.note };
      addEdge({ from: reg.id, to: t, kind: "handles", plugin: PLUGIN, app, evidence: ev });
      addRole(t, "route_handler", "net/http", app, ev);
    }
    b.wrappers.forEach((w, order) => {
      for (const t of w.targets) {
        if (used.middleware >= MAX_MIDDLEWARE_EDGES) {
          stop("middleware", "fan-out-capped", e.site, ["applies_middleware"], `the plugin stopped adding middleware edges after ${MAX_MIDDLEWARE_EDGES} in this build`);
          return;
        }
        const ev: FrameworkEvidence = { kind: "route-call", tier: w.tier, site: e.site, via: w.via, premises: [], rule: rule("go-http-middleware"), note: w.note };
        if (addEdge({ from: reg.id, to: t, kind: "applies_middleware", plugin: PLUGIN, app, evidence: ev, order })) used.middleware++;
        addRole(t, "middleware", "net/http", app, ev);
      }
    });
    if (b.wrapCut) {
      const { count, exact } = b.wrapCut;
      gap({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["applies_middleware"], cause: "fan-out-capped", name: show(e.handler), note: `the handler is wrapped in more than ${MAX_MIDDLEWARE_CHAIN} middleware calls; the ${exact ? "" : "at least "}${count} past the first ${MAX_MIDDLEWARE_CHAIN} are not listed`, count, exact });
    }
  };

  const takeRegistration = (site: Site): boolean => {
    if (used.registrations >= MAX_REGISTRATIONS) {
      stop("registrations", "fan-out-capped", site, ["handles"], `the plugin stopped listing registrations after ${MAX_REGISTRATIONS} in this build; the routes past that are not listed`);
      return false;
    }
    used.registrations++;
    return true;
  };

  // ---------- composition: every route each mux serves ----------
  type Ctx = { app: Mux; prefix: string | null; host: string; methods: string[] | null; within: string[]; via: Site[]; stack: string[]; depth: number };
  const compose = (mux: Mux, ctx: Ctx) => {
    for (const e of events.get(mux.id) ?? []) {
      if (used.steps >= MAX_COMPOSE_STEPS) {
        stop("steps", "budget", e.site, ["handles", "mounts"], `the plugin stopped composing muxes after ${MAX_COMPOSE_STEPS} steps in this build`);
        return;
      }
      used.steps++;
      if (stopped.has("registrations") && stopped.has("mounts")) return;
      // Once registrations stop, only a Handle call can still mount a mux.
      if (stopped.has("registrations") && e.prop === "HandleFunc") continue;
      const written = evaluate(e.pattern, constantOf(e.file));
      if (written === null) {
        computedPattern(e);
        continue;
      }
      const own = parsePattern(written);
      const methods = meet(ctx.methods, own.methods);
      if (methods.length === 0) continue;
      const path = ctx.prefix === null ? null : join(ctx.prefix, own.path);
      if (path !== null && !ctx.within.every((w) => under(w, path))) continue;
      const host = ctx.host !== "" ? ctx.host : own.host;
      const b = boundOf(e);
      if (b.mount) {
        const sub = b.mount.mux;
        if (ctx.stack.includes(sub.id)) continue; // a loop: stop there, never repeat it
        if (ctx.depth >= MAX_MOUNT_DEPTH) {
          stop("depth", "fan-out-capped", e.site, ["mounts", "handles"], `muxes mounted more than ${MAX_MOUNT_DEPTH} levels deep are not followed`);
          continue;
        }
        if (used.mounts >= MAX_MOUNTS) {
          stop("mounts", "fan-out-capped", e.site, ["mounts", "handles"], `the plugin stopped following mounted muxes after ${MAX_MOUNTS} in this build`);
          continue;
        }
        used.mounts++;
        addEdge({ from: mux.id, to: sub.id, kind: "mounts", plugin: PLUGIN, app: ctx.app.id, evidence: { kind: "mount", tier: "certain", site: e.site, via: null, premises: [], rule: rule("go-http-mount"), note: b.mount.strip ? `the prefix ${b.mount.strip} is stripped before ${sub.name} routes the request` : null } });
        const strip = b.mount.strip;
        if (strip === null) gap({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["mounts", "handles"], cause: "dynamic", name: show(e.handler), note: "the prefix http.StripPrefix removes is computed at run time, so the routes under it have no known pattern", count: null, exact: false });
        const prefix = ctx.prefix === null || strip === null ? null : strip === undefined ? ctx.prefix : join(ctx.prefix, strip);
        compose(sub, { app: ctx.app, prefix, host, methods, within: path === null ? ctx.within : [...ctx.within, path], via: [...ctx.via, e.site], stack: [...ctx.stack, sub.id], depth: ctx.depth + 1 });
        continue;
      }
      if (!takeRegistration(e.site)) continue;
      const key = `${siteKey(e.site)}${ctx.via.map((s) => `@${siteKey(s)}`).join("")}`;
      const reg: Registration = {
        kind: "registration",
        id: entityId(PLUGIN, ctx.app.id, "registration", key),
        plugin: PLUGIN,
        app: ctx.app.id,
        methods,
        pattern: path === null ? null : host + path,
        written: own.host + own.path,
        name: null,
        site: e.site,
        mountedVia: ctx.via,
        mounted: true,
        handler: { written: show(e.handler), status: b.status, targets: b.targets },
      };
      registrations.push(reg);
      attach(reg, e, b);
    }
  };

  const apps = [...muxes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of apps) compose(m, { app: m, prefix: "", host: "", methods: null, within: [], via: [], stack: [m.id], depth: 0 });

  // Routes on a parameter typed as a mux: kept, with no application.
  for (const { param, event: e } of paramEvents) {
    const written = evaluate(e.pattern, constantOf(e.file));
    if (written === null) {
      computedPattern(e);
      continue;
    }
    const b = boundOf(e);
    if (b.mount || !takeRegistration(e.site)) continue;
    const own = parsePattern(written);
    const reg: Registration = {
      kind: "registration",
      id: entityId(PLUGIN, null, "registration", siteKey(e.site)),
      plugin: PLUGIN,
      app: null,
      methods: own.methods,
      pattern: own.host + own.path,
      written: own.host + own.path,
      name: null,
      site: e.site,
      mountedVia: [],
      mounted: false,
      handler: { written: show(e.handler), status: b.status, targets: b.targets },
    };
    registrations.push(reg);
    gap({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles", "mounts"], cause: "dynamic", name: param.name, note: `the route is registered on the ${param.what} ${param.name} (${param.type}); which mux it lands on, and under which prefix, is decided ${param.what === "parameter" ? "by the caller" : "where that mux is made"}`, count: null, exact: false });
    attach(reg, e, b);
  }

  // ---------- applications ----------
  const detections: Detection[] = apps.map((m) => ({
    id: m.id,
    name: m.dflt ? `http.DefaultServeMux (${m.file})` : `${m.name} (${m.file})`,
    project: m.project,
    root: m.project,
    site: { file: m.file, line: m.line, column: m.column },
    evidence: [
      m.dflt
        ? { file: m.first?.file ?? m.file, line: m.first?.line ?? 1, note: "registers on the default mux through net/http" }
        : { file: m.file, line: m.line, note: "made by net/http's NewServeMux" },
      ...m.served.map((s) => ({ file: s.file, line: s.line, note: "served here" })),
    ],
    version: null,
    data: { served: m.served.length > 0 },
  }));
  const appById = new Map(detections.map((d) => [d.id, d]));
  const httpProjects = new Set<string>([...detections.map((d) => d.project), ...registrations.map((r) => index.projectOf(r.site.file))]);

  // ---------- tests ----------
  const testFile = (file: string) => file.endsWith("_test.go");
  const byProject = new Map<string, Registration[]>();
  for (const r of registrations) {
    if (r.app === null) continue;
    const p = appById.get(r.app)?.project ?? index.projectOf(r.site.file);
    (byProject.get(p) ?? byProject.set(p, []).get(p))?.push(r);
  }
  const meter = { steps: 0 };
  const split = new Map<Registration, ReturnType<typeof splitPattern>>();
  const splitOf = (reg: Registration) => {
    let s = split.get(reg);
    if (!s) {
      s = splitPattern(reg.pattern as string);
      split.set(reg, s);
    }
    return s;
  };
  requests: for (const file of files) {
    if (!testFile(file)) continue;
    for (const f of of(file, "call")) {
      if ((f.prop !== "NewRequest" && f.prop !== "NewRequestWithContext") || !isPkg(file, f.recv, "httptest", null)) continue;
      const site: Site = { file, line: f.line, column: f.column };
      if (used.requests >= MAX_TEST_REQUESTS) {
        stop("requests", "fan-out-capped", site, ["tests"], `the plugin stopped matching test requests after ${MAX_TEST_REQUESTS} in this build`);
        break requests;
      }
      used.requests++;
      const at = f.prop === "NewRequest" ? 0 : 1;
      const mArg = f.args[at];
      const tArg = f.args[at + 1];
      if (!mArg || !tArg) continue;
      const method = mArg.t === "ref" && !mArg.local && mArg.path.length === 2 && identity(file).http.has(mArg.path[0] as string) ? (METHOD_CONSTANTS[mArg.path[1] as string] ?? null) : evaluate(mArg, constantOf(file));
      const target = evaluate(tArg, constantOf(file));
      if (method === null || target === null) {
        const arg = method === null ? mArg : tArg;
        const what = method === null ? "method" : "path";
        gap(
          isCut(arg)
            ? { plugin: PLUGIN, site, scope: { file }, affects: ["tests"], cause: "fan-out-capped", name: null, note: `the request's ${what} is longer than the plugin reads, so the route it reaches is not known`, count: null, exact: false }
            : { plugin: PLUGIN, site, scope: { file }, affects: ["tests"], cause: "dynamic", name: show(arg), note: `the test builds a request with a computed ${what} (${show(arg)}), so the route it reaches is not known`, count: null, exact: false },
        );
        continue;
      }
      const req = requestTarget(target);
      const verb = method === "" ? "GET" : method.toUpperCase();
      const unread = (cause: Cause, note: string) => gap({ plugin: PLUGIN, site, scope: { file }, affects: ["tests"], cause, name: show(tArg), note, count: null, exact: false });
      const hits: Registration[] = [];
      if (!req.path.startsWith("/")) {
        unread("unsupported-rule", `the request target ${req.path.slice(0, 80)} is neither a path nor an absolute URL, so the route it reaches is not known`);
        continue;
      }
      const xs = segments(req.path);
      if (!xs) {
        unread("fan-out-capped", `the request path ${req.path.slice(0, 80)} has more than ${MAX_PATTERN_SEGMENTS} segments, so it is not matched against any route`);
        continue;
      }
      // What the matcher could not read, said once per request: a route
      // past the segment cap, a pattern with no path, a computed prefix.
      const missed = { cap: 0, unreadable: 0, computed: 0 };
      for (const reg of byProject.get(index.projectOf(file)) ?? []) {
        if (meter.steps >= MAX_MATCH_WORK) break;
        meter.steps++;
        if (!reg.methods.includes("*") && !reg.methods.includes(verb) && !(verb === "HEAD" && reg.methods.includes("GET"))) continue;
        if (reg.pattern === null) {
          missed.computed++;
          continue;
        }
        const p = splitOf(reg);
        if (!p.segs) {
          missed[p.why === "cap" ? "cap" : "unreadable"]++;
          continue;
        }
        if ((p.host === "" || p.host === req.host) && matchSegments(p.segs, xs, meter)) hits.push(reg);
      }
      if (meter.steps >= MAX_MATCH_WORK) {
        stop("match", "budget", site, ["tests"], `the plugin stopped matching test requests to routes after ${MAX_MATCH_WORK} pattern steps in this build`);
        break requests;
      }
      if (missed.cap > 0) unread("fan-out-capped", `${missed.cap} routes of this project have more than ${MAX_PATTERN_SEGMENTS} path segments; whether the request reaches them is not known`);
      if (missed.unreadable > 0) unread("unsupported-rule", `${missed.unreadable} routes of this project have a pattern with no path the matcher reads; whether the request reaches them is not known`);
      if (missed.computed > 0) unread("dynamic", `${missed.computed} routes of this project sit under a computed prefix; whether the request reaches them is not known`);
      const appsHit = new Set(hits.map((r) => r.app));
      const from = index.enclosing(file, f.line)?.id ?? file;
      for (const reg of hits) {
        const app = appById.get(reg.app as string);
        const several = appsHit.size > 1;
        if (used.testLinks >= MAX_TEST_LINKS) {
          stop("testLinks", "fan-out-capped", site, ["tests"], `the plugin stopped adding test links after ${MAX_TEST_LINKS} in this build`);
          break requests;
        }
        used.testLinks++;
        addEdge({
          from,
          to: reg.id,
          kind: "tests",
          plugin: PLUGIN,
          app: reg.app,
          category: "route-request",
          evidence: {
            kind: "test-route-request",
            tier: several ? "possible" : "likely",
            site,
            via: null,
            premises: [reg.id],
            rule: rule("go-http-test-request"),
            note: several
              ? `the test requests ${verb} ${req.path}, which routes on ${appsHit.size} muxes of this project match, and the test does not say which mux serves it`
              : `the test requests ${verb} ${req.path}, which this route's pattern ${reg.pattern} on ${app?.name ?? "its mux"} matches`,
          },
        });
      }
    }
  }
  // Test functions, in the projects that serve net/http.
  for (const file of files) {
    if (!testFile(file) || !httpProjects.has(index.projectOf(file))) continue;
    const testing = identity(file).testing;
    for (const f of of(file, "test-func")) {
      if (f.param.length !== 2 || !testing.has(f.param[0] as string) || f.param[1] !== "T" || !isTestName(f.name)) continue;
      const sym = functionAt(file, f.name, f.line);
      if (!sym) continue;
      addRole(sym.id, "test", "go test", null, { kind: "role-path", tier: "certain", site: { file, line: f.line, column: f.column }, via: null, premises: [], rule: rule("go-http-test-function"), note: null });
    }
  }

  // ---------- files not read ----------
  for (const file of files) {
    for (const f of index.factsOf(file)) {
      if (f.kind === "too-large") {
        addUnknown({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "file-not-parsed", name: null, note: `the file is ${f.bytes} bytes, over the ${MAX_SOURCE_BYTES} byte cap of the net/http plugin, so its routes were not read`, count: null, exact: false });
      } else if (f.kind === "parse-error") {
        addUnknown({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "file-not-parsed", name: null, note: "the file has a syntax error; calls inside the broken regions were not read", count: null, exact: false });
      }
    }
  }

  return { apps: detections, output: { roles, entities: registrations, edges, unknowns } };
}

// Go's rule for a test function's name: Test, then nothing or a character that is not a lower-case letter.
function isTestName(name: string): boolean {
  if (!name.startsWith("Test")) return false;
  const next = name[4];
  return next === undefined || !(next >= "a" && next <= "z");
}

// A Go 1.22 pattern: `[METHOD ][HOST]/[PATH]`. No method takes any.
export function parsePattern(written: string): { methods: string[]; host: string; path: string } {
  let rest = written;
  let method = "*";
  let sp = -1;
  for (let i = 0; i < written.length && sp < 0; i++) if (written[i] === " " || written[i] === "\t") sp = i;
  if (sp >= 0) {
    method = written.slice(0, sp);
    rest = written.slice(sp).trimStart();
  }
  const slash = rest.indexOf("/");
  return slash < 0 ? { methods: [method], host: "", path: rest } : { methods: [method], host: rest.slice(0, slash), path: rest.slice(slash) };
}

// The methods a route keeps under a mount that takes only some.
function meet(outer: string[] | null, own: string[]): string[] {
  if (outer === null || outer.includes("*")) return own;
  if (own.includes("*")) return outer;
  return own.filter((m) => outer.includes(m));
}

// A prefix and a path, with one slash between them.
function join(prefix: string, path: string): string {
  if (prefix === "") return path;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path.startsWith("/") ? `${p}${path}` : `${p}/${path}`;
}

// Whether a composed path lies under a mount's own path: its subtree when
// the mount path ends in a slash, else the path itself. A mount path with a
// wildcard is not compared.
function under(mount: string, path: string): boolean {
  if (mount.includes("{")) return true;
  return mount.endsWith("/") ? path.startsWith(mount) : path === mount;
}

// The host and path an httptest request is made for: a path, or an absolute
// URL; httptest uses example.com when the target names no host.
function requestTarget(target: string): { host: string; path: string } {
  let host = "example.com";
  let rest = target;
  for (const scheme of ["http://", "https://"]) {
    if (!target.startsWith(scheme)) continue;
    const after = target.slice(scheme.length);
    const slash = after.indexOf("/");
    host = slash < 0 ? after : after.slice(0, slash);
    rest = slash < 0 ? "/" : after.slice(slash);
  }
  for (const stop of ["?", "#"]) {
    const i = rest.indexOf(stop);
    if (i >= 0) rest = rest.slice(0, i);
  }
  return { host, path: rest === "" ? "/" : rest };
}

// The segments after a path's leading slash, or null past MAX_PATTERN_SEGMENTS.
function segments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const parts = path.slice(1).split("/", MAX_PATTERN_SEGMENTS + 1);
  return parts.length > MAX_PATTERN_SEGMENTS ? null : parts;
}

// A composed pattern's host and path segments. No segments when the matcher
// cannot read it: past the segment cap ("cap"), or with no path at all
// ("unreadable").
function splitPattern(pattern: string): { host: string; segs: string[] | null; why: "cap" | "unreadable" | null } {
  const slash = pattern.indexOf("/");
  if (slash < 0) return { host: "", segs: null, why: "unreadable" };
  const segs = segments(pattern.slice(slash));
  return { host: pattern.slice(0, slash), segs, why: segs ? null : "cap" };
}

// Whether a request matches a composed Go pattern (`[HOST]/[PATH]`), by Go's
// rules, one segment at a time with no regular expression: `{name}` takes one
// non-empty segment, a last `{name...}` takes the rest, a trailing slash
// takes the subtree below it, `{$}` only the path that ends there. A pattern
// or path of more than MAX_PATTERN_SEGMENTS segments matches nothing.
// `meter` counts the segments compared.
export function matches(pattern: string, path: string, host = "example.com", meter?: { steps: number }): boolean {
  const p = splitPattern(pattern);
  const xs = segments(path);
  if (!p.segs || !xs || (p.host !== "" && p.host !== host)) return false;
  return matchSegments(p.segs, xs, meter);
}

function matchSegments(ps: readonly string[], xs: readonly string[], meter?: { steps: number }): boolean {
  for (let i = 0; i < ps.length; i++) {
    if (meter) meter.steps++;
    const seg = ps[i] as string;
    const last = i === ps.length - 1;
    if (last && seg === "") return xs.length > i;
    if (seg === "{$}") return last && xs.length === i + 1 && xs[i] === "";
    const wild = seg.startsWith("{") && seg.endsWith("}");
    if (wild && seg.endsWith("...}")) return last && xs.length > i;
    if (i >= xs.length) return false;
    if (wild) {
      if (xs[i] === "") return false;
      continue;
    }
    if (seg !== xs[i]) return false;
  }
  return xs.length === ps.length;
}
