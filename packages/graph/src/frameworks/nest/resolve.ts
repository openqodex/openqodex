// The Nest plugin's resolve step: which calls make Nest applications, which
// modules each application's root module reaches through `imports`, which
// controllers those modules declare, and the full path of every route those
// controllers serve, composed the way Nest's own route path factory does it
// (packages/core/router/route-path-factory.ts): the URI version, the
// RouterModule path of the module, the controller's path, the method's
// path, then the global prefix unless an exclusion matches.
//
// API identity: a decorator counts only when its name is imported from
// "@nestjs/common" (by name, under another name, or through a namespace),
// an application only when `NestFactory` is imported from "@nestjs/core",
// and the module must resolve outside the repository. A dependency on Nest
// enables the rules; it never proves that a decorator named `Get` is Nest's.
//
// A wrong path is worse than no path. A route whose own path is computed
// is no registration: it is an unknown of cause "dynamic" naming its
// handler. A route under a part the plugin cannot read (a computed
// controller path, global prefix, version or RouterModule table, a prefix
// set inside a condition or on a value the plugin cannot tie to the
// application, an exclusion it cannot match) keeps its registration with
// the pattern null, the known part in `partial`, and an unknown of cause
// "dynamic". A controller no application's modules reach keeps its routes,
// relative and not mounted. Two applications never share a registration.
import type { Detection, Entity, FrameworkEdge, FrameworkEvidence, FrameworkUnknown, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import type { Arg, Deco, Member, NestFact } from "./facts.js";
import { ROUTE_DECORATORS } from "./facts.js";
import { isTestFile } from "../express/js.js";

export const PLUGIN = "nest";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// Caps on one item.
export const MAX_BASE_DEPTH = 4; // base classes followed for inherited routes
export const MAX_PATHS_PER_ROUTE = 64; // paths one route makes (versions times controller paths times method paths)
export const MAX_ROUTE_TABLE = 256; // RouterModule entries read for one application

// Budgets for the whole build.
export const MAX_APPS = 2000;
export const MAX_REGISTRATIONS = 10_000;
export const MAX_MODULE_VISITS = 20_000; // modules visited, every application together
export const MAX_LOOKUPS = 200_000;
export const MAX_MIDDLEWARE_EDGES = 30_000;
export const MAX_UNKNOWNS = 5000;

type ClassFact = Extract<NestFact, { kind: "class" }>;
type FactoryFact = Extract<NestFact, { kind: "factory" }>;
type CallFact = Extract<NestFact, { kind: "app-call" }>;
type ValueFact = Extract<NestFact, { kind: "value" }>;
type Cls = { file: string; fact: ClassFact; key: string };

// What one piece of a path is: a text, absent, or computed.
const COMPUTED = null;
type Piece = string | undefined | typeof COMPUTED;
// A version: a text, or Nest's VERSION_NEUTRAL (no version in the path).
type Ver = { neutral: true } | { v: string };
type Versions = Ver[] | undefined | typeof COMPUTED;
// An exclusion from the global prefix: its path as written, and the method
// it applies to ("*" for every method).
type Excl = { path: string; method: string };
// An application's configuration as its bootstrap writes it; null where
// the plugin cannot read it.
type Versioning = { uri: boolean; prefix: string | null; def: Versions } | undefined | typeof COMPUTED;
type AppConfig = { prefix: Piece; exclude: Excl[] | null; versioning: Versioning; notes: string[] };

// Nest's own end-to-end test files: `app.e2e-spec.ts`.
const isE2eSpec = (file: string): boolean => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return [".e2e-spec.ts", ".e2e-spec.js", ".e2e-spec.mts", ".e2e-spec.cts"].some((x) => name.endsWith(x));
};

export type Analysis = { apps: Detection[]; output: PluginOutput };
const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<NestFact>): Analysis {
  const kept = memo.get(index);
  if (kept) return kept;
  const result = run(index);
  memo.set(index, result);
  return result;
}

// ---------- paths, as Nest writes them ----------
const addLeadingSlash = (p: string): string => (p && p[0] !== "/" && p.slice(0, 2) !== "{/" ? `/${p}` : p);
const stripEndSlash = (p: string): string => (p.endsWith("/") ? p.slice(0, -1) : p);
const concat = (a: string, b: string): string => stripEndSlash(a) + addLeadingSlash(b);
// Nest's normalizePath: one leading slash, no trailing slash, no doubled slash.
export function normalizePath(p: string): string {
  if (!p) return "/";
  let s = p;
  while (s.endsWith("/")) s = s.slice(0, -1);
  s = `/${s}`;
  let out = "";
  for (const c of s) if (!(c === "/" && out.endsWith("/"))) out += c;
  return out;
}

// Whether an exclusion of the global prefix matches a route's path (Nest
// runs path-to-regexp on the route's path as written, ignoring case, with
// an optional trailing slash): "yes", "no", or "maybe" when the exclusion
// has a shape the plugin does not match (a wildcard, an optional part, a
// regular expression).
export function excludes(exclusion: string, path: string): "yes" | "no" | "maybe" {
  const ex = addLeadingSlash(exclusion).split("/").slice(1);
  const at = addLeadingSlash(path).split("/").slice(1);
  if (ex.length > 0 && ex[ex.length - 1] === "") ex.pop();
  if (at.length > 0 && at[at.length - 1] === "") at.pop();
  for (const seg of ex) for (const c of seg) if ("*{}()?+[]".includes(c)) return "maybe";
  if (ex.length !== at.length) return "no";
  for (let i = 0; i < ex.length; i++) {
    const e = ex[i] as string;
    const p = at[i] as string;
    if (e.startsWith(":")) {
      if (e.length === 1 || e.slice(1).includes(":")) return "maybe";
      if (p === "") return "no";
      continue;
    }
    if (e.includes(":")) return "maybe";
    if (e.toLowerCase() !== p.toLowerCase()) return "no";
  }
  return "yes";
}

// The paths one route is served at, as Nest's RoutePathFactory.create
// makes them; a pattern is null when a piece it needs is computed, and
// `partial` then shows the known part.
export function composePaths(o: { versioning: Versioning; version: Versions; module: Piece; ctrl: Piece; method: string; prefix: Piece; exclude: Excl[] | null; requestMethod: string }): { pattern: string | null; partial: string | null }[] {
  type Acc = { text: string; known: boolean; truncate: string[] };
  let paths: Acc[] = [{ text: "", known: true, truncate: [] }];
  const versioning = o.versioning;
  if (versioning === COMPUTED) paths = [{ text: "/{computed}", known: false, truncate: [] }];
  else if (versioning?.uri) {
    const version = o.version === undefined ? versioning.def : o.version;
    if (version === COMPUTED || versioning.prefix === null) paths = [{ text: "/{computed}", known: false, truncate: [] }];
    else if (version !== undefined) {
      const strings = version.filter((v): v is { v: string } => "v" in v).map((v) => `/${versioning.prefix}${v.v}`);
      paths = version.map((v) => ("neutral" in v ? { text: "", known: true, truncate: strings } : { text: `/${versioning.prefix}${v.v}`, known: true, truncate: strings }));
    }
  }
  const append = (piece: Piece) => {
    if (piece === undefined || piece === "") return;
    for (const p of paths) {
      if (piece === COMPUTED) {
        p.text = concat(p.text, "{computed}");
        p.known = false;
      } else p.text = concat(p.text, piece);
    }
  };
  append(o.module);
  append(o.ctrl);
  append(o.method);
  const out: { pattern: string | null; partial: string | null }[] = [];
  for (const p of paths) {
    let text = p.text;
    let known = p.known;
    if (o.prefix === COMPUTED) {
      text = `{computed}${text}`;
      known = false;
    } else if (o.prefix) {
      // The path the exclusions are matched against: the version prefix taken off.
      let bare = text;
      for (const t of p.truncate) if (bare === t || bare.startsWith(`${t}/`)) bare = bare.slice(t.length);
      let excluded: "yes" | "no" | "maybe" = "no";
      if (o.exclude === null) excluded = "maybe";
      else if (p.known) {
        for (const e of o.exclude) {
          if (e.method !== "*" && e.method !== o.requestMethod) continue;
          const m = excludes(e.path, bare);
          if (m === "yes") {
            excluded = "yes";
            break;
          }
          if (m === "maybe") excluded = "maybe";
        }
      } else if (o.exclude.length > 0) excluded = "maybe";
      if (excluded === "maybe") {
        text = `{computed}${text}`;
        known = false;
      } else if (excluded === "no") text = stripEndSlash(addLeadingSlash(o.prefix)) + text;
    }
    text = addLeadingSlash(text || "/");
    if (text !== "/") text = stripEndSlash(text);
    out.push(known ? { pattern: text, partial: null } : { pattern: null, partial: text });
  }
  return out;
}

const show = (a: Arg | null | undefined): string => {
  if (!a) return "nothing";
  if (a.t === "ref") return a.path.join(".");
  if (a.t === "str") return a.v === null ? "a string" : JSON.stringify(a.v);
  if (a.t === "call" || a.t === "new") return `${a.t === "new" ? "new " : ""}${a.fn ? a.fn.join(".") : "(computed)"}(...)`;
  return "a computed value";
};

function run(index: PluginIndex<NestFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const entities: Entity[] = [];
  const apps: Detection[] = [];

  // ---------- budgets and gaps ----------
  const spent = { lookups: 0, modules: 0, registrations: 0, middleware: 0, apps: 0 };
  const left = { registrations: 0, middleware: 0, apps: 0, modules: 0, lookups: 0 };
  let unknownsLeftOut = 0;
  const seen = new Set<string>();
  const addUnknown = (u: FrameworkUnknown) => {
    const key = `${u.cause}\0${u.site ? `${u.site.file}:${u.site.line}:${u.site.column}` : JSON.stringify(u.scope)}\0${u.note}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (unknowns.length >= MAX_UNKNOWNS) unknownsLeftOut++;
    else unknowns.push(u);
  };
  const gap = (site: Site, cause: FrameworkUnknown["cause"], affects: FrameworkUnknown["affects"], name: string | null, note: string) => addUnknown({ plugin: PLUGIN, site, scope: { file: site.file }, affects, cause, name, note, count: null, exact: false });
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (spent.lookups >= MAX_LOOKUPS) {
      left.lookups++;
      return { kind: "gap", cause: "budget", note: `the Nest plugin makes at most ${MAX_LOOKUPS} lookups in one build`, candidates: null };
    }
    spent.lookups++;
    return index.lookup(file, path);
  };

  // ---------- which projects declare Nest ----------
  const enabled = new Map<string, boolean>();
  const isEnabled = (file: string): boolean => {
    const project = index.projectOf(file);
    let on = enabled.get(project);
    if (on === undefined) {
      on = index.declares(project, "npm", "@nestjs/common") || index.declares(project, "npm", "@nestjs/core");
      enabled.set(project, on);
    }
    return on;
  };
  const files = index.factFiles().filter(isEnabled);

  // ---------- each file's facts ----------
  type FileIndex = { classes: Map<string, ClassFact[]>; all: ClassFact[]; values: Map<string, ValueFact>; factories: FactoryFact[]; calls: CallFact[] };
  const fileIndexes = new Map<string, FileIndex>();
  const fx = (file: string): FileIndex => {
    let f = fileIndexes.get(file);
    if (f) return f;
    f = { classes: new Map(), all: [], values: new Map(), factories: [], calls: [] };
    fileIndexes.set(file, f);
    for (const fact of index.factsOf(file)) {
      if (fact.kind === "class") {
        f.all.push(fact);
        if (fact.top && fact.name !== null) f.classes.set(fact.name, [...(f.classes.get(fact.name) ?? []), fact]);
      } else if (fact.kind === "value") {
        if (!f.values.has(fact.name)) f.values.set(fact.name, fact);
      } else if (fact.kind === "factory") f.factories.push(fact);
      else if (fact.kind === "app-call") f.calls.push(fact);
    }
    return f;
  };

  // ---------- which local names are Nest's ----------
  type Ident = { common: Map<string, string>; commonNs: Set<string>; core: Map<string, string>; coreNs: Set<string>; via: Map<string, { file: string; line: number; spec: string }> };
  const identities = new Map<string, Ident>();
  const identity = (file: string): Ident => {
    let id = identities.get(file);
    if (id) return id;
    id = { common: new Map(), commonNs: new Set(), core: new Map(), coreNs: new Set(), via: new Map() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    for (const imp of lf?.imports ?? []) {
      if (imp.scoped || imp.typeOnly || (imp.spec !== "@nestjs/common" && imp.spec !== "@nestjs/core")) continue;
      if (index.module(file, imp.spec).kind !== "external") continue;
      const common = imp.spec === "@nestjs/common";
      for (const n of imp.names) {
        (common ? id.common : id.core).set(n.local, n.imported);
        id.via.set(n.local, { file, line: imp.line, spec: imp.spec });
      }
      if (imp.namespace) {
        (common ? id.commonNs : id.coreNs).add(imp.namespace);
        id.via.set(imp.namespace, { file, line: imp.line, spec: imp.spec });
      }
    }
    return id;
  };
  // The name a callee is imported as from the package, or null.
  const nestName = (file: string, fn: readonly string[] | null, pkg: "common" | "core"): string | null => {
    if (!fn) return null;
    const id = identity(file);
    if (fn.length === 1) return (pkg === "common" ? id.common : id.core).get(fn[0] as string) ?? null;
    if (fn.length === 2 && (pkg === "common" ? id.commonNs : id.coreNs).has(fn[0] as string)) return fn[1] as string;
    return null;
  };
  const decoName = (file: string, d: Deco): string | null => (d.shadowed ? null : nestName(file, d.fn, "common"));
  const viaOf = (file: string, d: Deco) => identity(file).via.get(d.fn[0] as string) ?? null;

  // ---------- classes across files ----------
  type ClassRef = { kind: "cls"; cls: Cls } | { kind: "plain"; id: string } | { kind: "external" } | { kind: "none"; cause: FrameworkUnknown["cause"]; note: string };
  const clsOf = (file: string, fact: ClassFact): Cls => ({ file, fact, key: `${file}:${fact.line}` });
  const classRef = (file: string, path: readonly string[]): ClassRef => {
    if (path.length === 1) {
      const local = fx(file).classes.get(path[0] as string) ?? [];
      if (local.length === 1) return { kind: "cls", cls: clsOf(file, local[0] as ClassFact) };
      if (local.length > 1) return { kind: "none", cause: "ambiguous", note: `${path[0]} names more than one class of ${file}` };
    }
    const found = lookup(file, path);
    if (found.kind === "external") return { kind: "external" };
    if (found.kind === "symbol") {
      const nodes = found.ids.map((id) => index.node(id)).filter((n) => n !== null && n.kind === "class");
      if (nodes.length !== 1) return { kind: "none", cause: nodes.length > 1 ? "ambiguous" : "unsupported-rule", note: `${path.join(".")} is not one class the plugin can read` };
      const node = nodes[0] as NonNullable<(typeof nodes)[number]>;
      const facts = (fx(node.file).classes.get(node.name) ?? []).filter((c) => c.line === node.startLine);
      const only = facts.length === 1 ? facts[0] : (fx(node.file).classes.get(node.name) ?? []).length === 1 ? fx(node.file).classes.get(node.name)?.[0] : undefined;
      return only ? { kind: "cls", cls: clsOf(node.file, only) } : { kind: "plain", id: node.id };
    }
    if (found.kind === "gap") return { kind: "none", cause: found.cause, note: found.note };
    return { kind: "none", cause: "miss", note: `${path.join(".")} is not a class the graph can find` };
  };
  const classSymbol = (c: Cls): string | null => {
    const nodes = index.symbols(c.file).filter((n) => n.kind === "class" && n.name === c.fact.name);
    return (nodes.find((n) => n.startLine === c.fact.line) ?? (nodes.length === 1 ? nodes[0] : undefined))?.id ?? null;
  };
  const methodSymbol = (c: Cls, m: Member): string | null => {
    if (m.name === null) return null;
    const nodes = index.symbols(c.file).filter((n) => n.kind === "method" && n.name === m.name && n.startLine === m.line);
    if (nodes.length === 1) return (nodes[0] as { id: string }).id;
    const owned = index.symbols(c.file).filter((n) => n.kind === "method" && n.id.includes(`#${c.fact.name}.${m.name}@`));
    return owned.length === 1 ? (owned[0] as { id: string }).id : null;
  };
  const decoOf = (c: Cls, name: string): Deco | null => c.fact.decorators.find((d) => decoName(c.file, d) === name) ?? null;

  // ---------- constants ----------
  // A string a value holds: the literal, a constant of the file, or an
  // exported constant of the file an import names. `undefined` for the
  // name `undefined`; null when it is computed or not read.
  const UNDEF = Symbol("undefined");
  const constantIn = (file: string, name: string, depth = 0): string | null => {
    const v = fx(file).values.get(name);
    if (v) return v.value.t === "str" ? v.value.v : v.value.t === "ref" && v.value.path.length === 1 && depth < 4 ? constantIn(file, v.value.path[0] as string, depth + 1) : null;
    if (depth > 3) return null;
    const found = lookup(file, [name]);
    let target: { file: string; name: string } | null = null;
    if (found.kind === "miss") target = { file: found.target, name: found.name };
    else if (found.kind === "symbol" && found.ids.length === 1) {
      const node = index.node(found.ids[0] as string);
      if (node) target = { file: node.file, name: node.name };
    }
    if (!target || target.file === file) return null;
    const there = fx(target.file).values.get(target.name);
    return there?.exported && there.value.t === "str" ? there.value.v : null;
  };
  const strOf = (file: string, a: Arg | undefined): string | null | typeof UNDEF => {
    if (!a) return UNDEF;
    if (a.t === "str") return a.v;
    if (a.t === "ref" && a.path.length === 1) return a.path[0] === "undefined" ? UNDEF : constantIn(file, a.path[0] as string);
    return null;
  };
  // A list of path strings (`"x"` or `["x", "y"]`); null when any is computed.
  const stringsOf = (file: string, a: Arg | undefined): string[] | null | typeof UNDEF => {
    if (a?.t === "arr") {
      if (a.more > 0) return null;
      const out: string[] = [];
      for (const item of a.items) {
        const s = strOf(file, item);
        if (typeof s !== "string") return null;
        out.push(s);
      }
      return out;
    }
    const s = strOf(file, a);
    return s === UNDEF ? UNDEF : s === null ? null : [s];
  };
  const versionsOf = (file: string, a: Arg | undefined): Versions => {
    if (!a) return undefined;
    const one = (x: Arg): Ver | null => {
      if (x.t === "ref" && nestName(file, x.path, "common") === "VERSION_NEUTRAL") return { neutral: true };
      const s = strOf(file, x);
      return typeof s === "string" ? { v: s } : null;
    };
    if (a.t === "ref" && a.path.length === 1 && a.path[0] === "undefined") return undefined;
    if (a.t === "arr") {
      if (a.more > 0) return COMPUTED;
      const out: Ver[] = [];
      for (const x of a.items) {
        const v = one(x);
        if (!v) return COMPUTED;
        out.push(v);
      }
      return out.length > 0 ? out : undefined;
    }
    const v = one(a);
    if (v && "v" in v && v.v === "") return undefined;
    return v ? [v] : COMPUTED;
  };
  const prop = (a: Arg | undefined, key: string): Arg | undefined => (a?.t === "obj" ? a.props.find((p) => p.key === key)?.value : undefined);

  // ---------- controllers ----------
  type Route = { owner: Cls; member: Member; deco: Deco; methods: string[]; paths: string[]; version: Versions };
  type Controller = { cls: Cls; site: Site; paths: string[] | null; version: Versions; routes: Route[]; guards: Mw[]; interceptors: Mw[] };
  type Mw = { file: string; arg: Arg; site: Site; kind: "guard" | "interceptor" };
  // The middleware a class's or method's decorators declare, in the order
  // Nest runs them: decorators apply from the bottom up and each adds its
  // own after the ones before.
  const middlewareOf = (file: string, decos: readonly Deco[], name: "UseGuards" | "UseInterceptors"): Mw[] => {
    const out: Mw[] = [];
    for (const d of [...decos].reverse()) {
      if (decoName(file, d) !== name) continue;
      const site = { file, line: d.line, column: d.column };
      if (d.more > 0) gap(site, "dynamic", ["applies_middleware"], null, `${name} is given a spread list, so some of what it applies is not listed`);
      for (const arg of d.args) out.push({ file, arg, site, kind: name === "UseGuards" ? "guard" : "interceptor" });
    }
    return out;
  };
  // A method's route: its methods and paths, or null when the member
  // carries no route decorator of Nest. The topmost route decorator wins,
  // as in Nest (each one overwrites the last).
  const routeOf = (owner: Cls, member: Member): Route | null => {
    if (member.static) return null;
    let deco: Deco | null = null;
    let name: string | null = null;
    for (const d of member.decorators) {
      const n = decoName(owner.file, d);
      if (n && (n in ROUTE_DECORATORS || n === "RequestMapping")) {
        deco = d;
        name = n;
        break;
      }
    }
    if (!deco || !name) return null;
    const site: Site = { file: owner.file, line: deco.line, column: deco.column };
    const handler = `${owner.fact.name ?? "(class)"}.${member.name ?? "(computed)"}`;
    let methods: string[] | null = name === "RequestMapping" ? null : [ROUTE_DECORATORS[name] as string];
    let pathArg: Arg | undefined = deco.args[0];
    if (name === "RequestMapping") {
      const opts = deco.args[0];
      pathArg = prop(opts, "path");
      const m = prop(opts, "method");
      if (opts !== undefined && opts.t !== "obj") methods = null;
      else if (m === undefined) methods = ["GET"];
      else if (m.t === "ref" && m.path.length === 2 && nestName(owner.file, [m.path[0] as string], "common") === "RequestMethod") methods = [m.path[1] === "ALL" ? "*" : (m.path[1] as string)];
      else if (m.t === "ref" && m.path.length === 3 && identity(owner.file).commonNs.has(m.path[0] as string) && m.path[1] === "RequestMethod") methods = [m.path[2] === "ALL" ? "*" : (m.path[2] as string)];
    }
    if (methods === null) {
      gap(site, "dynamic", ["handles"], handler, `the route's method is computed at run time, so ${handler} is not listed as a route`);
      return null;
    }
    const written = deco.more > 0 ? null : stringsOf(owner.file, pathArg);
    if (written === null) {
      gap(site, "dynamic", ["handles"], handler, `the route path ${show(pathArg)} of ${handler} is computed at run time, so it is not listed as a route`);
      return null;
    }
    // Nest's RequestMapping: an empty or missing path is "/".
    const paths = written === UNDEF || written.length === 0 ? ["/"] : written.map((p) => (p === "" ? "/" : p));
    const versionDeco = member.decorators.find((d) => decoName(owner.file, d) === "Version");
    const version = versionDeco ? versionsOf(owner.file, versionDeco.args[0]) : undefined;
    if (versionDeco && version === COMPUTED) gap({ file: owner.file, line: versionDeco.line, column: versionDeco.column }, "dynamic", ["handles"], handler, `the version of ${handler} is computed at run time, so its path is not known when versioning is on`);
    return { owner, member, deco, methods, paths, version };
  };
  const controllers = new Map<string, Controller | null>();
  const controllerOf = (cls: Cls, depth = 0): Controller | null => {
    if (controllers.has(cls.key)) return controllers.get(cls.key) ?? null;
    controllers.set(cls.key, null);
    const deco = decoOf(cls, "Controller");
    if (!deco) return null;
    const site: Site = { file: cls.file, line: deco.line, column: deco.column };
    const arg = deco.args[0];
    let paths: string[] | null;
    let version: Versions;
    if (deco.more > 0) {
      paths = null;
      version = COMPUTED;
    } else if (arg?.t === "obj") {
      const p = prop(arg, "path");
      const s = p === undefined ? ["/"] : stringsOf(cls.file, p);
      paths = s === UNDEF ? ["/"] : s === null ? null : s.map((x) => x || "/");
      version = arg.more > 0 ? COMPUTED : versionsOf(cls.file, prop(arg, "version"));
      if (arg.more > 0) paths = null;
    } else {
      const s = stringsOf(cls.file, arg);
      paths = s === UNDEF ? ["/"] : s;
      version = undefined;
    }
    const name = cls.fact.name ?? "a class";
    if (paths === null) gap(site, "dynamic", ["handles"], name, `the path of ${name} is computed at run time, so its routes have no known pattern`);
    if (version === COMPUTED) gap(site, "dynamic", ["handles"], name, `the version of ${name} is computed at run time, so its routes have no known pattern when versioning is on`);
    const routes: Route[] = [];
    const own = new Set<string>();
    // Its own routes, then the routes it inherits from base classes of the
    // repository a member of its own does not override.
    let at: Cls | null = cls;
    const names = new Set<string>();
    let namesKnown = true;
    for (let d = 0; at && d <= MAX_BASE_DEPTH; d++) {
      for (const m of at.fact.members) {
        if (m.name !== null && names.has(m.name)) continue;
        const r = routeOf(at, m);
        if (r) {
          if (at !== cls && !namesKnown) {
            gap({ file: at.file, line: r.deco.line, column: r.deco.column }, "unsupported-rule", ["handles"], m.name, `${name} has more members than the plugin lists, so whether it overrides ${m.name ?? "this method"} is not known`);
            continue;
          }
          routes.push(r);
        }
      }
      for (const n of at.fact.names) {
        names.add(n);
        if (at === cls) own.add(n);
      }
      if (at.fact.namesCut) namesKnown = false;
      if (at.fact.cut > 0) gap({ file: at.file, line: at.fact.line, column: at.fact.column }, "fan-out-capped", ["handles"], at.fact.name, `${at.fact.name ?? "a class"} has more decorated members than the plugin reads; ${at.fact.cut} were left out`);
      const base: Arg | null = at.fact.base;
      if (!base) break;
      const baseSite = { file: at.file, line: base.line, column: base.column };
      if (base.t !== "ref") {
        gap(baseSite, "dynamic", ["handles"], name, `${at.fact.name ?? "a class"} extends a computed class, so the routes it may inherit are not listed`);
        break;
      }
      const ref = classRef(at.file, base.path);
      if (ref.kind === "cls") at = ref.cls;
      else {
        if (ref.kind === "external") gap(baseSite, "external", ["handles"], base.path.join("."), `${at.fact.name ?? "a class"} extends ${base.path.join(".")} from outside the repository, so the routes it may inherit are not listed`);
        else if (ref.kind === "none") gap(baseSite, ref.cause, ["handles"], base.path.join("."), `${at.fact.name ?? "a class"} extends ${base.path.join(".")}, which the plugin cannot read, so the routes it may inherit are not listed`);
        break;
      }
      if (d === MAX_BASE_DEPTH) gap(baseSite, "fan-out-capped", ["handles"], name, `the plugin follows at most ${MAX_BASE_DEPTH} base classes; routes further up are not listed`);
    }
    void depth;
    // Guards and interceptors: the class's own, else those it inherits (Reflect metadata reads up the prototype chain).
    const classMw = (kind: "UseGuards" | "UseInterceptors"): Mw[] => {
      let c: Cls | null = cls;
      for (let d = 0; c && d <= MAX_BASE_DEPTH; d++) {
        const mine = middlewareOf(c.file, c.fact.decorators, kind);
        if (mine.length > 0) return mine;
        const base: Arg | null = c.fact.base;
        if (!base || base.t !== "ref") return [];
        const ref = classRef(c.file, base.path);
        c = ref.kind === "cls" ? ref.cls : null;
      }
      return [];
    };
    const out: Controller = { cls, site, paths, version, routes, guards: classMw("UseGuards"), interceptors: classMw("UseInterceptors") };
    controllers.set(cls.key, out);
    return out;
  };

  // ---------- applications ----------
  const bySite = (a: { line: number; column: number }, b: { line: number; column: number }) => a.line - b.line || a.column - b.column;
  type App = { id: string; file: string; fact: FactoryFact; config: AppConfig };
  const appsFound: App[] = [];
  const attributed = new Set<CallFact>();
  for (const file of files) {
    for (const f of fx(file).factories) {
      if (nestName(file, f.fn, "core") !== "NestFactory") continue;
      if (spent.apps >= MAX_APPS) {
        left.apps++;
        continue;
      }
      spent.apps++;
      appsFound.push({ id: appId(PLUGIN, file, f.line), file, fact: f, config: { prefix: undefined, exclude: [], versioning: undefined, notes: [] } });
    }
  }
  // The calls that set each application's prefix and versioning: on the
  // name the application is bound to, in the same function, after it is
  // made. One inside a condition or a loop may or may not run.
  for (const app of appsFound) {
    const f = app.fact;
    if (f.name === null) continue;
    const calls = fx(app.file)
      .calls.filter((c) => c.scope === f.scope && c.recv !== null && c.recv.length === 1 && c.recv[0] === f.name && bySite(c, f) > 0)
      .sort(bySite);
    for (const c of calls) {
      attributed.add(c);
      const site = { file: app.file, line: c.line, column: c.column };
      const cfg = app.config;
      if (c.block !== f.block) {
        if (c.prop === "setGlobalPrefix") cfg.prefix = COMPUTED;
        else cfg.versioning = COMPUTED;
        gap(site, "dynamic", ["handles"], c.prop, `${c.prop} is called inside a block that may not run, so the paths of this application are not known`);
        continue;
      }
      if (c.more > 0) {
        if (c.prop === "setGlobalPrefix") cfg.prefix = COMPUTED;
        else cfg.versioning = COMPUTED;
        gap(site, "dynamic", ["handles"], c.prop, `${c.prop} is given a spread argument, so the paths of this application are not known`);
        continue;
      }
      if (c.prop === "setGlobalPrefix") {
        const s = strOf(app.file, c.args[0]);
        cfg.prefix = s === UNDEF ? undefined : s;
        if (s === null) gap(site, "dynamic", ["handles"], show(c.args[0]), `the global prefix ${show(c.args[0])} is computed at run time, so the routes of this application have no known pattern`);
        const opts = c.args[1];
        if (opts !== undefined) {
          const ex = prop(opts, "exclude");
          if (opts.t !== "obj" || opts.more > 0) cfg.exclude = null;
          else if (ex === undefined) cfg.exclude = [];
          else if (ex.t !== "arr" || ex.more > 0) cfg.exclude = null;
          else {
            const list: Excl[] = [];
            for (const item of ex.items) {
              if (item.t === "obj") {
                const p = strOf(app.file, prop(item, "path"));
                const m = prop(item, "method");
                const method = m?.t === "ref" && m.path.length === 2 && nestName(app.file, [m.path[0] as string], "common") === "RequestMethod" ? (m.path[1] === "ALL" ? "*" : (m.path[1] as string)) : null;
                if (typeof p !== "string" || method === null || item.more > 0) {
                  list.length = 0;
                  cfg.exclude = null;
                  break;
                }
                list.push({ path: p, method });
                continue;
              }
              const p = strOf(app.file, item);
              if (typeof p !== "string") {
                cfg.exclude = null;
                break;
              }
              list.push({ path: p, method: "*" });
            }
            if (cfg.exclude !== null) cfg.exclude = list;
          }
          if (cfg.exclude === null) gap(site, "dynamic", ["handles"], "exclude", "the routes excluded from the global prefix are computed or written in a form the plugin does not read, so which routes carry the prefix is not known");
        }
      } else {
        const opts = c.args[0];
        if (opts === undefined) cfg.versioning = { uri: true, prefix: "v", def: undefined };
        else if (opts.t !== "obj" || opts.more > 0) cfg.versioning = COMPUTED;
        else {
          const type = prop(opts, "type");
          let uri: boolean | null = false;
          if (type === undefined) uri = false;
          else if (type.t === "ref" && type.path.length === 2 && nestName(app.file, [type.path[0] as string], "common") === "VersioningType") uri = type.path[1] === "URI";
          else uri = null;
          const pre = prop(opts, "prefix");
          const prefix = pre === undefined ? "v" : pre.t === "bool" && !pre.v ? "" : strOf(app.file, pre);
          const def = versionsOf(app.file, prop(opts, "defaultVersion"));
          cfg.versioning = uri === null ? COMPUTED : { uri, prefix: typeof prefix === "string" ? prefix : null, def };
        }
        if (cfg.versioning === COMPUTED || (cfg.versioning?.uri && (cfg.versioning.prefix === null || cfg.versioning.def === COMPUTED))) gap(site, "dynamic", ["handles"], "enableVersioning", "the versioning of this application is computed or written in a form the plugin does not read, so the paths of its routes are not known");
      }
    }
  }
  // A call that sets a prefix or versioning on a value the plugin cannot
  // tie to one application may change every application of its project. A
  // test file's call configures the application its test makes.
  for (const file of files) {
    if (isTestFile(file) || isE2eSpec(file)) continue;
    for (const c of fx(file).calls) {
      if (attributed.has(c)) continue;
      const project = index.projectOf(file);
      const site = { file, line: c.line, column: c.column };
      let hit = false;
      for (const app of appsFound) {
        if (index.projectOf(app.file) !== project) continue;
        hit = true;
        if (c.prop === "setGlobalPrefix") app.config.prefix = COMPUTED;
        else app.config.versioning = COMPUTED;
      }
      if (hit) gap(site, "dynamic", ["handles"], c.prop, `${c.prop} is called on ${c.recv ? c.recv.join(".") : "a value"} the plugin cannot tie to one application, so the paths of this project's applications are not known`);
    }
  }

  // ---------- modules each application reaches ----------
  type Reached = { ctl: Cls; module: Cls; via: Site[]; entry: Site };
  const isModule = (c: Cls) => decoOf(c, "Module") !== null;
  // The RouterModule table of one register call: each module's path, or null
  // when a part is computed; `whole` false when some entry is not read.
  type Table = { paths: { key: string; path: string | null }[]; whole: boolean };
  const readTable = (file: string, a: Arg | undefined, budget: { n: number }): Table => {
    const out: Table = { paths: [], whole: true };
    let routes = a;
    if (routes?.t === "ref" && routes.path.length === 1) {
      const v = fx(file).values.get(routes.path[0] as string);
      routes = v?.value;
    }
    if (routes?.t !== "arr") return { paths: [], whole: false };
    type Node = { path: string | null | undefined; module: Cls | "unread" | undefined; children: Node[] | "unread" | undefined } | { cls: Cls | "unread" };
    const read = (x: Arg, depth: number): Node => {
      if (--budget.n < 0 || depth > 8) return { cls: "unread" };
      if (x.t === "ref") {
        const r = classRef(file, x.path);
        return { cls: r.kind === "cls" ? r.cls : "unread" };
      }
      if (x.t !== "obj" || x.more > 0) return { cls: "unread" };
      const p = prop(x, "path");
      const m = prop(x, "module");
      const ch = prop(x, "children");
      const s = p === undefined ? undefined : strOf(file, p);
      const module = m === undefined ? undefined : m.t === "ref" ? ((r) => (r.kind === "cls" ? r.cls : "unread"))(classRef(file, m.path)) : "unread";
      const children = ch === undefined ? undefined : ch.t === "arr" && ch.more === 0 ? ch.items.map((c) => read(c, depth + 1)) : "unread";
      return { path: s === UNDEF ? undefined : s, module, children };
    };
    // Nest's flattenRoutePaths, which writes each child's joined path into it.
    const flatten = (items: Node[]) => {
      for (const item of items) {
        if ("cls" in item) continue;
        if (item.module === "unread") out.whole = false;
        else if (item.module && item.path !== undefined && item.path !== "") out.paths.push({ key: item.module.key, path: item.path });
        if (item.children === "unread") out.whole = false;
        else if (item.children) {
          for (const child of item.children) {
            if ("cls" in child) {
              if (child.cls === "unread") out.whole = false;
              else if (item.path !== undefined && item.path !== "") out.paths.push({ key: child.cls.key, path: item.path });
            } else if (child.path !== undefined) child.path = child.path === null || item.path === null ? null : normalizePath(normalizePath(item.path ?? "") + normalizePath(child.path));
          }
          flatten(item.children);
        }
      }
    };
    if (routes.more > 0) out.whole = false;
    flatten(routes.items.map((x) => read(x, 0)));
    return out;
  };

  const reachedBy = (app: App): { reached: Reached[]; paths: Map<string, string | null>; tableWhole: boolean } => {
    const reached: Reached[] = [];
    const paths = new Map<string, string | null>();
    let tableWhole = true;
    const visited = new Set<string>();
    const site = { file: app.file, line: app.fact.line, column: app.fact.column };
    const root = app.fact.module;
    if (!root || root.t !== "ref") {
      gap(site, root && root.t === "other" ? "unsupported-rule" : "dynamic", ["handles", "mounts"], show(root), "the root module is not a class the plugin can read (a computed value or a class written in place), so the controllers this application serves are not known");
      return { reached, paths, tableWhole };
    }
    const first = classRef(app.file, root.path);
    if (first.kind !== "cls" || !isModule(first.cls)) {
      gap(site, first.kind === "none" ? first.cause : "unsupported-rule", ["handles", "mounts"], root.path.join("."), `the root module ${root.path.join(".")} is not a module the plugin can read, so the controllers this application serves are not known`);
      return { reached, paths, tableWhole };
    }
    const queue: { cls: Cls; via: Site[] }[] = [{ cls: first.cls, via: [] }];
    visited.add(first.cls.key);
    const tableBudget = { n: MAX_ROUTE_TABLE };
    while (queue.length > 0) {
      const { cls, via } = queue.shift() as { cls: Cls; via: Site[] };
      if (spent.modules >= MAX_MODULE_VISITS) {
        left.modules++;
        gap(site, "budget", ["handles", "mounts"], null, `the plugin visits at most ${MAX_MODULE_VISITS} modules in one build; the controllers of the rest are not listed`);
        break;
      }
      spent.modules++;
      const deco = decoOf(cls, "Module") as Deco;
      const dsite = { file: cls.file, line: deco.line, column: deco.column };
      const meta = deco.args[0];
      if (meta === undefined) continue;
      const mname = cls.fact.name ?? "a module";
      if (meta.t !== "obj" || meta.more > 0 || deco.more > 0) gap(dsite, "dynamic", ["handles", "mounts"], mname, `the metadata of ${mname} is computed in part, so some of its controllers and imports may not be listed`);
      const ctl = prop(meta, "controllers");
      if (ctl !== undefined) {
        if (ctl.t !== "arr" || ctl.more > 0) gap({ file: cls.file, line: ctl.line, column: ctl.column }, "dynamic", ["handles", "mounts"], mname, `the controllers of ${mname} are computed in part, so some may not be listed`);
        for (const item of ctl.t === "arr" ? ctl.items : []) {
          const isite = { file: cls.file, line: item.line, column: item.column };
          if (item.t !== "ref") {
            gap(isite, "dynamic", ["handles", "mounts"], show(item), `a controller of ${mname} is computed, so its routes are not listed`);
            continue;
          }
          const r = classRef(cls.file, item.path);
          if (r.kind === "cls" && decoOf(r.cls, "Controller")) reached.push({ ctl: r.cls, module: cls, via: [...via], entry: isite });
          else if (r.kind === "external") gap(isite, "external", ["handles", "mounts"], item.path.join("."), `the controller ${item.path.join(".")} comes from outside the repository, so its routes are not listed`);
          else gap(isite, r.kind === "none" ? r.cause : "unsupported-rule", ["handles", "mounts"], item.path.join("."), `${item.path.join(".")} is not a controller the plugin can read, so its routes are not listed`);
        }
      }
      const imports = prop(meta, "imports");
      if (imports === undefined) continue;
      if (imports.t !== "arr" || imports.more > 0) gap({ file: cls.file, line: imports.line, column: imports.column }, "dynamic", ["handles", "mounts"], mname, `the imports of ${mname} are computed in part, so the controllers of some modules may not be listed`);
      const enqueue = (c: Cls, at: Site) => {
        if (visited.has(c.key)) return;
        visited.add(c.key);
        queue.push({ cls: c, via: [...via, at] });
      };
      for (const item of imports.t === "arr" ? imports.items : []) {
        const isite = { file: cls.file, line: item.line, column: item.column };
        let target: Arg | null = item;
        // forwardRef(() => X) imports X.
        if (item.t === "call" && nestName(cls.file, item.fn, "common") === "forwardRef") target = item.args[0]?.t === "arrow" ? item.args[0].body : null;
        if (target?.t === "ref") {
          const r = classRef(cls.file, target.path);
          if (r.kind === "cls" && isModule(r.cls)) enqueue(r.cls, isite);
          else if (r.kind === "none" || (r.kind === "cls" && !isModule(r.cls)) || r.kind === "plain") gap(isite, r.kind === "none" ? r.cause : "unsupported-rule", ["handles", "mounts"], target.path.join("."), `${target.path.join(".")} is not a module the plugin can read, so its controllers are not listed`);
          continue;
        }
        if (target?.t === "call" && target.fn) {
          const fn = target.fn;
          // RouterModule.register([...]): the paths of the modules it names.
          const isRegister = fn[fn.length - 1] === "register" && ((fn.length === 2 && nestName(cls.file, [fn[0] as string], "core") === "RouterModule") || (fn.length === 3 && identity(cls.file).coreNs.has(fn[0] as string) && fn[1] === "RouterModule"));
          if (isRegister) {
            const table = target.more > 0 ? { paths: [], whole: false } : readTable(cls.file, target.args[0], tableBudget);
            for (const p of table.paths) paths.set(p.key, p.path === null ? null : normalizePath(p.path));
            if (!table.whole) {
              tableWhole = false;
              gap(isite, "dynamic", ["handles"], "RouterModule.register", "the RouterModule table is computed or written in a form the plugin does not read, so the paths of this application's routes are not known");
            }
            continue;
          }
          // A dynamic module of the repository: `UsersModule.forRoot(...)`.
          if (fn.length === 2) {
            const r = classRef(cls.file, [fn[0] as string]);
            if (r.kind === "external") continue;
            if (r.kind === "cls" && isModule(r.cls)) {
              enqueue(r.cls, isite);
              if (r.cls.fact.dynamic) gap(isite, "unsupported-rule", ["handles", "mounts"], fn.join("."), `the dynamic module ${fn.join(".")}(...) returns may add controllers or imports the plugin does not read`);
              continue;
            }
          }
          const head = classRef(cls.file, [fn[0] as string]);
          if (head.kind === "external") continue;
          gap(isite, "dynamic", ["handles", "mounts"], fn.join("."), `the module ${fn.join(".")}(...) returns is computed, so its controllers are not listed`);
          continue;
        }
        gap(isite, "dynamic", ["handles", "mounts"], show(item), `an import of ${mname} is computed, so the controllers of the module it names are not listed`);
      }
    }
    return { reached, paths, tableWhole };
  };

  // ---------- registrations ----------
  const regKeys = new Set<string>();
  const roleKeys = new Set<string>();
  const edgeKeys = new Set<string>();
  const addRole = (target: string, role: RoleAssignment["role"], detail: string, app: string | null, evidence: FrameworkEvidence) => {
    const key = `${target}\0${role}\0${detail}\0${app}`;
    if (roleKeys.has(key)) return;
    roleKeys.add(key);
    roles.push({ target, role, detail, app, evidence });
  };
  const addEdge = (e: FrameworkEdge) => {
    const key = `${e.from}\0${e.to}\0${e.kind}\0${e.order ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(e);
  };
  const mwGapsSaid = new Set<string>();
  const bindMw = (m: Mw): string | null => {
    const at = m.arg.t === "new" ? (m.arg.fn ? { path: m.arg.fn } : null) : m.arg.t === "ref" ? { path: m.arg.path } : null;
    const say = (cause: FrameworkUnknown["cause"], note: string) => {
      const key = `${m.site.file}:${m.arg.line}:${m.arg.column}`;
      if (mwGapsSaid.has(key)) return;
      mwGapsSaid.add(key);
      gap({ file: m.file, line: m.arg.line, column: m.arg.column }, cause, ["applies_middleware"], show(m.arg), note);
    };
    if (!at) {
      const fn = m.arg.t === "call" ? m.arg.fn : null;
      const ext = fn ? classRef(m.file, [fn[0] as string]).kind === "external" : false;
      say(ext ? "external" : "dynamic", `the ${m.kind} ${show(m.arg)} is made at run time${ext ? " by a function from outside the repository" : ""}, so what it runs is not listed`);
      return null;
    }
    const r = classRef(m.file, at.path);
    if (r.kind === "cls") return classSymbol(r.cls);
    if (r.kind === "plain") return r.id;
    if (r.kind === "external") return null;
    say(r.cause, `the ${m.kind} ${at.path.join(".")} is not a class the plugin can find, so what it runs is not listed`);
    return null;
  };

  const register = (app: App | null, ctl: Controller, reach: Reached | null, modulePath: Piece) => {
    const appKey = app?.id ?? null;
    for (const r of ctl.routes) {
      const handler = `${r.owner.fact.name ?? "(class)"}.${r.member.name ?? "(computed)"}`;
      const site: Site = { file: r.owner.file, line: r.deco.line, column: r.deco.column };
      const cfg = app?.config;
      const results: { pattern: string | null; partial: string | null }[] = [];
      // Each composition makes at most one path per version; past the cap the rest are not made.
      outer: for (const ctrl of ctl.paths ?? [COMPUTED]) {
        for (const method of r.paths) {
          for (const m of r.methods) {
            if (results.length > MAX_PATHS_PER_ROUTE) break outer;
            const list = composePaths({
              versioning: cfg ? cfg.versioning : undefined,
              version: r.version !== undefined ? r.version : ctl.version,
              module: modulePath,
              ctrl,
              method,
              prefix: cfg ? cfg.prefix : undefined,
              exclude: cfg ? cfg.exclude : [],
              requestMethod: m,
            });
            for (const x of list) results.push(x);
          }
        }
      }
      // One registration per distinct path; methods of one decorator are one registration.
      const unique = new Map<string, { pattern: string | null; partial: string | null }>();
      for (const x of results) unique.set(x.pattern ?? `\0${x.partial}`, x);
      let i = 0;
      for (const x of unique.values()) {
        if (i >= MAX_PATHS_PER_ROUTE) {
          gap(site, "fan-out-capped", ["handles"], handler, `the route makes more than ${MAX_PATHS_PER_ROUTE} paths; the rest are not listed`);
          break;
        }
        if (spent.registrations >= MAX_REGISTRATIONS) {
          left.registrations++;
          continue;
        }
        spent.registrations++;
        // A controller two modules of one application declare serves each path once in the listing.
        const served = `${appKey}\0${site.file}:${site.line}:${site.column}\0${ctl.cls.key}\0${x.pattern ?? x.partial}`;
        if (regKeys.has(served)) continue;
        regKeys.add(served);
        const key = `${site.file}:${site.line}:${site.column}@${ctl.cls.key}@${reach?.module.key ?? "-"}#${i++}`;
        const id = entityId(PLUGIN, appKey, "registration", key);
        const target = methodSymbol(r.owner, r.member);
        const reg: Registration = {
          kind: "registration",
          id,
          plugin: PLUGIN,
          app: appKey,
          methods: r.methods,
          pattern: x.pattern,
          written: r.paths.join(", "),
          name: null,
          site,
          mountedVia: reach ? [...reach.via, reach.entry] : [],
          mounted: app !== null,
          handler: { written: handler, status: target ? "bound" : "unresolved", targets: target ? [target] : [] },
          partial: x.partial,
        };
        entities.push(reg);
        if (!target) {
          gap(site, "unsupported-rule", ["handles"], handler, `the method ${handler} has no definition of its own in the graph`);
          continue;
        }
        const ev: FrameworkEvidence = { kind: "route-decorator", tier: "certain", site, via: viaOf(r.owner.file, r.deco), premises: [], rule: rule("nest-route"), note: null };
        addEdge({ from: id, to: target, kind: "handles", plugin: PLUGIN, app: appKey, evidence: ev });
        addRole(target, "route_handler", "nest", appKey, ev);
        // Guards run before interceptors; the controller's before the method's.
        const methodGuards = middlewareOf(r.owner.file, r.member.decorators, "UseGuards");
        const methodInterceptors = middlewareOf(r.owner.file, r.member.decorators, "UseInterceptors");
        let order = 0;
        for (const m of [...ctl.guards, ...methodGuards, ...ctl.interceptors, ...methodInterceptors]) {
          const to = bindMw(m);
          if (to === null) {
            order++;
            continue;
          }
          if (spent.middleware >= MAX_MIDDLEWARE_EDGES) {
            left.middleware++;
            break;
          }
          spent.middleware++;
          const mev: FrameworkEvidence = { kind: "route-decorator", tier: "certain", site: m.site, via: null, premises: [id], rule: rule("nest-middleware"), note: null };
          addEdge({ from: id, to, kind: "applies_middleware", plugin: PLUGIN, app: appKey, evidence: mev, order: order++ });
          addRole(to, "middleware", m.kind === "guard" ? "nest-guard" : "nest-interceptor", appKey, mev);
        }
      }
    }
  };

  const served = new Set<string>();
  for (const app of appsFound) {
    const { reached, paths, tableWhole } = reachedBy(app);
    const rootName = app.fact.module?.t === "ref" ? app.fact.module.path.join(".") : "a root module";
    for (const x of reached) {
      const ctl = controllerOf(x.ctl);
      if (!ctl) continue;
      served.add(x.ctl.key);
      const sym = classSymbol(x.ctl);
      if (sym) addEdge({ from: app.id, to: sym, kind: "mounts", plugin: PLUGIN, app: app.id, evidence: { kind: "mount", tier: "certain", site: x.entry, via: null, premises: [], rule: rule("nest-module"), note: null } });
      const modulePath: Piece = !tableWhole ? COMPUTED : paths.has(x.module.key) ? paths.get(x.module.key) : undefined;
      register(app, ctl, x, modulePath);
    }
    apps.push({
      id: app.id,
      name: `${rootName} (${app.file})`,
      project: index.projectOf(app.file),
      root: index.projectOf(app.file),
      site: { file: app.file, line: app.fact.line, column: app.fact.column },
      evidence: [{ file: app.file, line: app.fact.line, note: "made by NestFactory.create of @nestjs/core" }],
      version: index.model().node.find((p) => p.dir === index.projectOf(app.file))?.pkg.deps.get("@nestjs/core") ?? null,
      data: { controllers: reached.length },
    });
  }
  // Controllers no application's modules reach: their routes are kept, relative and not served.
  for (const file of files) {
    for (const fact of fx(file).all) {
      const cls = clsOf(file, fact);
      if (served.has(cls.key)) continue;
      const ctl = controllerOf(cls);
      if (ctl) register(null, ctl, null, undefined);
    }
  }
  // A decorated class inside a function that binds the decorator's name, and files the plugin did not read.
  for (const file of files) {
    for (const fact of index.factsOf(file)) {
      if (fact.kind === "too-large" || fact.kind === "syntax-error") {
        const why = fact.kind === "too-large" ? `the file is larger than the plugin reads (${fact.bytes} bytes)` : "the file has a syntax error, and nothing inside the broken part was read";
        addUnknown({ plugin: PLUGIN, site: { file, line: fact.line, column: fact.column }, scope: { file }, affects: [], cause: "file-not-parsed", name: null, note: `${why}, so its Nest routes and modules are not listed`, count: null, exact: false });
      }
    }
  }
  const capped = (n: number, what: string) => {
    if (n > 0) addUnknown({ plugin: PLUGIN, site: null, scope: { build: true }, affects: ["handles", "mounts"], cause: "fan-out-capped", name: null, note: `the Nest plugin keeps at most ${what} in one build; ${n} were left out`, count: n, exact: true });
  };
  capped(left.registrations, `${MAX_REGISTRATIONS} registrations`);
  capped(left.apps, `${MAX_APPS} applications`);
  capped(left.middleware, `${MAX_MIDDLEWARE_EDGES} guard and interceptor edges`);
  if (left.lookups > 0) addUnknown({ plugin: PLUGIN, site: null, scope: { build: true }, affects: [], cause: "budget", name: null, note: `the Nest plugin makes at most ${MAX_LOOKUPS} lookups in one build; ${left.lookups} were refused`, count: left.lookups, exact: true });
  if (unknownsLeftOut > 0) unknowns.push({ plugin: PLUGIN, site: null, scope: { build: true }, affects: [], cause: "fan-out-capped", name: null, note: `the Nest plugin keeps at most ${MAX_UNKNOWNS} gaps; ${unknownsLeftOut} more were left out`, count: unknownsLeftOut, exact: true });
  return { apps, output: { roles, entities, edges, unknowns } };
}
