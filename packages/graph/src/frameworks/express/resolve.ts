// The Express plugin's resolve step: which values are Express applications
// and routers, which calls on them register routes, mount routers and add
// middleware, what each registration's handler is, and which test requests
// may reach which route.
//
// API identity: a value is an application only when it is made by calling
// the default (or namespace) import of the "express" module, a router only
// when it is made by `express.Router()` or the module's named `Router`, and
// the module must resolve outside the repository. A dependency on express
// enables the rules; it never proves that `app.get` is a route. A call on
// any other value, such as an object of the repository's own with a get
// method, is no registration.
//
// Every registration is kept with its site, apart from its handler: a
// handler that is missing, computed, wrapped, inline or external leaves the
// registration in place with the handler's status and an unknown that says
// why. A route whose own path is computed at run time is no registration:
// it is an unknown of cause "dynamic" naming its handler, and no edge. A
// route under a mount path computed at run time keeps its registration with
// the pattern null. Two applications never share a registration: a router
// mounted on both yields one registration per application.
//
// The route files are the repository's, so a stranger controls them. Every
// cap below counts the work actually done across the whole build (facts
// read, lookups made, mounts followed, registrations made, middleware edges,
// test requests and pattern steps), is checked where that work is done, and
// once reached stops that work for the rest of the build with one unknown.
// No counter restarts per application, file or router. Two caps bound one
// item instead: a mount branch stops MAX_MOUNT_DEPTH routers deep, and one
// route keeps MAX_MIDDLEWARE_CHAIN middleware. Patterns are matched segment
// by segment, never by a regular expression built from the repository's
// text.
import type { Detection, Entity, FrameworkEdge, FrameworkEvidence, FrameworkEvidenceKind, FrameworkUnknown, HandlerStatus, Lookup, PluginIndex, PluginOutput, Registration, RoleAssignment, Site } from "../plugin.js";
import { appId, entityId } from "../plugin.js";
import { inlineHandler } from "../shared/inline.js";
import type { Tier } from "../../model/records.js";
import type { ExpressFact } from "./facts.js";
import { HTTP_METHODS, MAX_SCOPE_CHAIN } from "./facts.js";
import type { Expr } from "./js.js";
import { evaluate, isTestFile, JS_RUNNERS, MAX_ITEMS, MAX_SOURCE_BYTES, show } from "./js.js";

export const PLUGIN = "express";
export const RULE_VERSION = 1;
const rule = (id: string) => ({ id, version: RULE_VERSION });

// Caps on one item.
export const MAX_MOUNT_DEPTH = 8; // routers deep under an application: past it that branch stops
export const MAX_MIDDLEWARE_CHAIN = 64; // middleware kept for one route
export const MAX_PATTERN_SEGMENTS = 64; // segments of one pattern or request path matched
export const MAX_STRING_WRITES = 32; // writes of one name read to tell whether it holds a string; past it, it does not

// Budgets for the whole build.
export const MAX_FACTS_READ = 400_000; // facts of every file together
export const MAX_LOOKUPS = 200_000; // names looked up through the index
export const MAX_MOUNTS = 2000; // router mounts followed, every application together
export const MAX_REGISTRATIONS = 10000; // registrations made, every application together
export const MAX_MIDDLEWARE_EDGES = 30_000; // middleware edges made
export const MAX_TEST_REQUESTS = 2000; // supertest requests matched
export const MAX_TEST_LINKS = 10_000; // tests edges made from requests
export const MAX_MATCH_WORK = 4_000_000; // pattern-by-path steps
export const MAX_UNKNOWNS = 5000; // unknowns kept; past it one more says how many were left out
export const MAX_APPS = 2000; // applications detected
export const MAX_ROLES = 20_000; // roles given

type Spend = "facts" | "lookups" | "mounts" | "registrations" | "middlewareEdges" | "requests" | "testLinks" | "matchWork" | "apps" | "roles" | "unknowns";
const LIMIT: Record<Spend, number> = {
  facts: MAX_FACTS_READ,
  lookups: MAX_LOOKUPS,
  mounts: MAX_MOUNTS,
  registrations: MAX_REGISTRATIONS,
  middlewareEdges: MAX_MIDDLEWARE_EDGES,
  requests: MAX_TEST_REQUESTS,
  testLinks: MAX_TEST_LINKS,
  apps: MAX_APPS,
  roles: MAX_ROLES,
  matchWork: MAX_MATCH_WORK,
  unknowns: MAX_UNKNOWNS,
};

type Fact<K extends ExpressFact["kind"]> = Extract<ExpressFact, { kind: K }>;

// A value the plugin knows: an application, a router, or a test agent
// (`request(app)` of supertest).
type Val =
  | { kind: "app" | "router"; id: string; file: string; name: string; line: number; column: number; scope: number }
  | { kind: "agent"; file: string; target: Expr; scope: number; line: number };

// A name that is a parameter typed as an Express application or router: a
// registration on it lands on whatever application the caller passes.
type Param = { kind: "param"; file: string; name: string; type: string; line: number };

type Identity = {
  factory: Set<string>; // locals that call into express(): the default or namespace import
  router: Set<string>; // locals bound to the named Router export
  types: Set<string>; // locals bound to the named type exports Express, Router, Application, IRouter
  supertest: Set<string>;
  http: Set<string>; // locals of node's http or https module
  createServer: Set<string>; // locals bound to their named createServer export
};

// One file's facts, sorted by kind and name once.
type FileIndex = {
  values: Map<string, Fact<"value">[]>;
  params: Map<string, Fact<"param">[]>;
  cjs: Map<string, Fact<"cjs-export">>;
  cjsTwice: Set<string>; // export names written more than once
  functions: Map<string, Fact<"function">[]>;
  calls: Fact<"call">[];
  servers: Fact<"server">[];
  testBlocks: number;
  tooLarge: Fact<"too-large"> | null;
  syntaxError: Fact<"syntax-error"> | null;
  scopes: Map<number, Fact<"scope">>; // function scopes by the line they start on
  unread: boolean; // the build's fact budget ran out before this file
};

const METHOD_SET = new Set<string>([...HTTP_METHODS, "del"]);
const TYPE_NAMES = new Set(["Express", "Router", "Application", "IRouter"]);
const HTTP_MODULES = new Set(["http", "https", "node:http", "node:https", "http2", "node:http2"]);

export type Analysis = {
  apps: Detection[];
  output: PluginOutput;
};

const memo = new WeakMap<object, Analysis>();

export function analyse(index: PluginIndex<ExpressFact>): Analysis {
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

function run(index: PluginIndex<ExpressFact>): Analysis {
  const roles: RoleAssignment[] = [];
  const edges: FrameworkEdge[] = [];
  const unknowns: FrameworkUnknown[] = [];
  const registrations: Registration[] = [];
  const apps: Detection[] = [];

  // ---------- the build's budgets ----------
  const spent: Record<Spend, number> = { facts: 0, lookups: 0, mounts: 0, registrations: 0, middlewareEdges: 0, requests: 0, testLinks: 0, matchWork: 0, apps: 0, roles: 0, unknowns: 0 };
  const refused: Record<Spend, number> = { facts: 0, lookups: 0, mounts: 0, registrations: 0, middlewareEdges: 0, requests: 0, testLinks: 0, matchWork: 0, apps: 0, roles: 0, unknowns: 0 };
  const take = (k: Spend, n = 1): boolean => {
    if (spent[k] + n > LIMIT[k]) {
      refused[k] += n;
      return false;
    }
    spent[k] += n;
    return true;
  };
  // A budget is gone once it has refused some work: what it allowed was all done.
  const exhausted = (k: Spend): boolean => refused[k] > 0;
  const seenUnknown = new Set<string>();
  const addUnknown = (u: FrameworkUnknown) => {
    const key = `${u.cause}\0${u.site ? `${u.site.file}:${u.site.line}:${u.site.column}` : JSON.stringify(u.scope)}\0${u.note}`;
    if (seenUnknown.has(key)) return;
    seenUnknown.add(key);
    if (take("unknowns")) unknowns.push(u);
  };
  const lookup = (file: string, path: readonly string[]): Lookup => {
    if (!take("lookups")) return { kind: "gap", cause: "budget", note: `the Express plugin makes at most ${MAX_LOOKUPS} lookups in one build`, candidates: null };
    return index.lookup(file, path);
  };

  const enabled = new Map<string, boolean>();
  const isEnabled = (file: string): boolean => {
    const project = index.projectOf(file);
    let on = enabled.get(project);
    if (on === undefined) {
      on = index.declares(project, "npm", "express");
      enabled.set(project, on);
    }
    return on;
  };

  const fileIndexes = new Map<string, FileIndex>();
  const fx = (file: string): FileIndex => {
    let f = fileIndexes.get(file);
    if (f) return f;
    f = { values: new Map(), params: new Map(), cjs: new Map(), cjsTwice: new Set(), functions: new Map(), calls: [], servers: [], testBlocks: 0, tooLarge: null, syntaxError: null, scopes: new Map(), unread: false };
    fileIndexes.set(file, f);
    const list = index.factsOf(file);
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
        case "cjs-export":
          if (f.cjs.has(fact.name)) f.cjsTwice.add(fact.name);
          else f.cjs.set(fact.name, fact);
          break;
        case "function":
          push(f.functions, fact.name, fact);
          break;
        case "call":
          f.calls.push(fact);
          break;
        case "server":
          f.servers.push(fact);
          break;
        case "test-block":
          f.testBlocks++;
          break;
        case "too-large":
          f.tooLarge = fact;
          break;
        case "syntax-error":
          f.syntaxError = fact;
          break;
        case "scope":
          if (!f.scopes.has(fact.line)) f.scopes.set(fact.line, fact);
          break;
      }
    }
    return f;
  };

  // ---------- bindings: which declaration a name at a place reads ----------
  // The function scope, from `scope` outwards, that declares `name`, or 0
  // when no function around the place does (the module's own name, or an
  // import). The chain is followed at most MAX_SCOPE_CHAIN functions out;
  // past that, or at a function whose scope record is missing (the fact cap
  // dropped it), the name counts as declared there, which proves nothing.
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
  // Every value written to the binding a name at a place reads: its
  // declaration with a value, and every assignment to it, in any function
  // that does not declare the name itself. A binding proves a value only
  // when exactly one is written; two writes leave it to the run.
  const writesCache = new Map<string, Fact<"value">[]>();
  const writesOf = (file: string, name: string, at: number): Fact<"value">[] => {
    const key = `${file}\0${name}\0${at}`;
    const kept = writesCache.get(key);
    if (kept) return kept;
    const out = (fx(file).values.get(name) ?? []).filter((v) => (v.decl === "assign" ? bindingScope(file, v.scope, name) : v.scope) === at);
    writesCache.set(key, out);
    return out;
  };

  // ---------- which local names are Express, supertest, node's http ----------
  const identities = new Map<string, Identity>();
  const identity = (file: string): Identity => {
    let id = identities.get(file);
    if (id) return id;
    id = { factory: new Set(), router: new Set(), types: new Set(), supertest: new Set(), http: new Set(), createServer: new Set() };
    identities.set(file, id);
    const lf = index.languageFacts(file);
    if (!lf) return id;
    const outside = (spec: string) => take("lookups") && index.module(file, spec).kind === "external";
    for (const imp of lf.imports) {
      if (imp.scoped) continue;
      const local = [...imp.names.filter((n) => n.imported === "default").map((n) => n.local), ...(imp.namespace ? [imp.namespace] : [])];
      if (imp.spec === "express" && outside("express")) {
        for (const l of local) id.factory.add(l);
        for (const n of imp.names) {
          if (n.imported === "Router") id.router.add(n.local);
          if (TYPE_NAMES.has(n.imported)) id.types.add(n.local);
        }
      } else if (imp.spec === "supertest" && outside("supertest")) {
        for (const l of local) id.supertest.add(l);
      } else if (HTTP_MODULES.has(imp.spec)) {
        for (const l of local) id.http.add(l);
        for (const n of imp.names) if (n.imported === "createServer") id.createServer.add(n.local);
      }
    }
    return id;
  };

  // ---------- values ----------
  const routerKey = (file: string, line: number) => `fw:express:router:${file}:${line}`;
  const classify = (file: string, v: { name: string; value: Expr; scope: number; line: number; column: number }): Val | null => {
    const e = v.value;
    if (e.t !== "call" || e.fn.t !== "ref") return null;
    const id = identity(file);
    const p = e.fn.path;
    // A parameter or local of that name shadows the import: its call is not the module's.
    if (bindingScope(file, v.scope, p[0] as string) !== 0) return null;
    if (p.length === 1 && id.factory.has(p[0] as string)) return { kind: "app", id: appId(PLUGIN, file, v.line), file, name: v.name, line: v.line, column: v.column, scope: v.scope };
    if ((p.length === 2 && id.factory.has(p[0] as string) && p[1] === "Router") || (p.length === 1 && id.router.has(p[0] as string))) {
      return { kind: "router", id: routerKey(file, v.line), file, name: v.name, line: v.line, column: v.column, scope: v.scope };
    }
    if (p.length >= 1 && p.length <= 2 && id.supertest.has(p[0] as string) && (p.length === 1 || p[1] === "agent") && e.args[0]) {
      return { kind: "agent", file, target: e.args[0], scope: v.scope, line: v.line };
    }
    return null;
  };

  // The value a name holds at a line of a file: a declaration in the same
  // function first, then one at module level, then what an import brings
  // (a module-level value of another file shows as a miss there, read
  // through that file's own facts). Each step is at most MAX_MOUNT_DEPTH
  // deep, so `const a = b; const b = a` ends.
  const valueCache = new Map<string, Val | Param | null>();
  const valueIn = (file: string, path: readonly string[], scope: number, line: number, depth = 0): Val | Param | null => {
    if (depth > MAX_MOUNT_DEPTH || path.length === 0) return null;
    const key = depth === 0 ? `${file}\0${scope}\0${line}\0${path.join(".")}` : null;
    if (key !== null && valueCache.has(key)) return valueCache.get(key) ?? null;
    const out = valueOf(file, path, scope, line, depth);
    if (key !== null) valueCache.set(key, out);
    return out;
  };
  const valueOf = (file: string, path: readonly string[], scope: number, line: number, depth: number): Val | Param | null => {
    const name = path[0] as string;
    const at = bindingScope(file, scope, name);
    const writes = writesOf(file, name, at);
    if (path.length === 1 && writes.length > 0) {
      // Two writes leave the value to the run: nothing is proved.
      if (writes.length > 1) return null;
      const decl = writes[0] as Fact<"value">;
      const direct = classify(file, decl);
      if (direct) return direct;
      // `const app = other` passes a known value on.
      if (decl.value.t === "ref" && !(decl.value.path.length === 1 && decl.value.path[0] === name)) return valueIn(file, decl.value.path, decl.scope, decl.line, depth + 1);
      return fromRequire(file, decl, undefined, depth)?.val ?? null;
    }
    // `m.users` where `m` holds `require("./m")`.
    if (path.length === 2 && writes.length === 1) {
      const got = fromRequire(file, writes[0] as Fact<"value">, path[1] as string, depth);
      if (got) return got.val;
    }
    if (at !== 0) {
      // A parameter or a local with no value the facts hold: only a parameter typed as Express says what it is.
      const param = path.length === 1 ? (fx(file).params.get(name) ?? []).find((p) => p.scope === at) : undefined;
      if (param) {
        const id = identity(file);
        const head = param.type[0] as string;
        const typed = (param.type.length === 1 && id.types.has(head)) || (param.type.length === 2 && id.factory.has(head) && TYPE_NAMES.has(param.type[1] as string));
        return typed ? { kind: "param", file, name, type: param.type.join("."), line: param.line } : null;
      }
      return null;
    }
    if (writes.length > 0) return null; // `app.x` on a module value of this file: not an import
    return fromImport(file, path, depth);
  };

  const fromImport = (file: string, path: readonly string[], depth: number): Val | Param | null => {
    let found: Lookup = lookup(file, path);
    let target: { file: string; name: string } | null = null;
    if (found.kind === "miss") target = found.past ? null : { file: found.target, name: found.name };
    else if (found.kind === "none" && path.length === 2) {
      found = lookup(file, [path[0] as string]);
      if (found.kind === "module") target = { file: found.file, name: path[1] as string };
    }
    if (!target || !index.languageFacts(target.file)) return null;
    return exportedValue(target.file, target.name, depth + 1);
  };

  const topValue = (file: string, name: string): Fact<"value"> | null => (fx(file).values.get(name) ?? []).find((v) => v.top) ?? null;

  // ---------- CommonJS ----------
  // `const m = require("./m")` and `const { a } = require("./m")` bind a name
  // to what a module assigns to `module.exports` or `exports`. `settled`: the
  // plugin knows what the name holds, a router, an application or a value
  // that is none (a function, a package). A name it cannot settle may be a
  // router, so a mount of it is an unknown, never a silent loss.
  type Got = { val: Val | Param | null; settled: boolean; note: string };
  const unsettled = (note: string): Got => ({ val: null, settled: false, note });
  const isRequire = (e: Expr, file: string, scope: number): boolean => e.t === "call" && e.fn.t === "ref" && e.fn.path.length === 1 && e.fn.path[0] === "require" && bindingScope(file, scope, "require") === 0;
  const requireBound = (file: string, decl: Fact<"value">): boolean => isRequire(decl.value.t === "member" ? decl.value.obj : decl.value, file, decl.scope);

  // What a file assigns to an export name: `exports.n = x`, `module.exports.n = x`,
  // or a member of `module.exports = { n }`; "default" is `module.exports` itself.
  // "competing" when more than one write may give the name its value and
  // the facts do not prove which runs last: the name written twice, an
  // object that names it twice or holds a spread, a member written beside
  // an object that names it, or written before `module.exports` is replaced.
  // "replaced" when `exports.n` is written after `module.exports` is replaced:
  // that write changes the old object, which nothing requires.
  const cjsEntry = (file: string, name: string): { value: Expr; line: number; column: number } | "competing" | "replaced" | null => {
    const f = fx(file);
    if (f.cjsTwice.has(name)) return "competing";
    const own = f.cjs.get(name);
    const whole = name === "default" ? undefined : f.cjs.get("default");
    if (!whole) return own ?? null;
    if (f.cjsTwice.has("default")) return "competing";
    const members = whole.value.t === "object" ? whole.value.props.filter((p) => p.key === name) : [];
    const hidden = whole.value.t === "object" && (whole.value.more ?? 0) > 0;
    // `exports.n = x` written after `module.exports` is replaced changes the old object only, unless the new value is `exports` itself.
    const aliased = whole.value.t === "ref" && whole.value.path.length === 1 && whole.value.path[0] === "exports";
    const stale = own?.bare === true && !aliased && !(own.line < whole.line || (own.line === whole.line && own.column < whole.column));
    if (stale) return "replaced";
    if (own) return members.length > 0 || hidden || own.line < whole.line || (own.line === whole.line && own.column < whole.column) ? "competing" : own;
    if (members.length > 1 || (members.length === 1 && hidden)) return "competing";
    const member = members[0];
    return member ? { value: member.value, line: whole.line, column: whole.column } : null;
  };
  // An export that is a function: middleware or a handler, never a router.
  const notRouter = (file: string, e: Expr): boolean => {
    if (e.t === "fn") return true;
    if (e.t !== "ref" || e.path.length !== 1) return false;
    const name = e.path[0] as string;
    return fx(file).functions.has(name) || (topValue(file, name)?.value.t === "fn");
  };
  const exportOf = (file: string, name: string, depth: number): Got => {
    if (!index.languageFacts(file)) return unsettled(`${file} was not read`);
    const val = exportedValue(file, name, depth + 1);
    if (val) return { val, settled: true, note: "" };
    const entry = cjsEntry(file, name);
    if (entry === "competing") return unsettled(`${file} writes its export ${name === "default" ? "module.exports" : name} more than once, so which value it holds is not known`);
    if (entry === "replaced") return unsettled(`${file} writes exports.${name} after it replaces module.exports, so the module does not export ${name}`);
    if (entry && notRouter(file, entry.value)) return { val: null, settled: true, note: "" };
    return unsettled(entry ? `${file} exports ${show(entry.value)}, which the plugin cannot read as a router` : `${file} has no export the plugin can read under that name`);
  };
  // `member`: the name read off the whole module (`m.users`).
  const fromRequire = (file: string, decl: Fact<"value">, member: string | undefined, depth: number): Got | null => {
    if (!requireBound(file, decl)) return null;
    const imp = index.languageFacts(file)?.imports.find((i) => i.line === decl.line && i.column === decl.column && (i.namespace === decl.name || i.names.some((n) => n.local === decl.name)));
    if (!imp) {
      // `const r = require("./x").router`: a member of the call, as inlineRequire reads it in place.
      if (decl.value.t === "member" && member === undefined) return inlineRequire(file, decl.value, decl.scope, depth) ?? unsettled("the module the require names is computed or not a plain string");
      return unsettled("the module the require names is computed or not a plain string");
    }
    const named = imp.names.find((n) => n.local === decl.name);
    if (named && member !== undefined) return unsettled(`${decl.name}.${member} reads a member of a destructured name`);
    return requiredExport(file, imp.spec, named ? named.imported : (member ?? "default"), depth);
  };
  const requiredExport = (file: string, spec: string, name: string, depth: number): Got => {
    if (!take("lookups")) return unsettled(`the Express plugin makes at most ${MAX_LOOKUPS} lookups in one build`);
    const mod = index.module(file, spec);
    if (mod.kind === "external") return { val: null, settled: true, note: "" };
    if (mod.kind !== "module") return unsettled(`no file in the repository is named by require(${JSON.stringify(spec)})`);
    return exportOf(mod.file, name, depth + 1);
  };
  // A require written where its value is used: `app.use("/x", require("./x"))`, or `require("./x").router`.
  const inlineRequire = (file: string, a: Expr, scope: number, depth: number): Got | null => {
    const member = a.t === "member" ? a.prop : undefined;
    const call = a.t === "member" ? a.obj : a;
    if (call.t !== "call" || !isRequire(call, file, scope)) return null;
    const spec = call.args[0];
    if (call.args.length !== 1 || spec?.t !== "str") return unsettled("the module name is computed or not a plain string");
    return requiredExport(file, spec.v, member ?? "default", depth);
  };
  // What an argument of `use` holds: a name, or a require written in place.
  const argValue = (file: string, a: Expr, scope: number, line: number): Val | Param | null =>
    a.t === "ref" ? valueIn(file, a.path, scope, line) : (inlineRequire(file, a, scope, 0)?.val ?? null);
  // Why a name a mount reads is not followed through a require; null when it is no require or is no router.
  const requireGap = (file: string, path: readonly string[], scope: number): string | null => {
    const name = path[0] as string;
    const writes = writesOf(file, name, bindingScope(file, scope, name));
    if (!writes.some((w) => requireBound(file, w))) return null;
    if (writes.length > 1) return `${name} is assigned more than once`;
    if (path.length > 2) return `${path.join(".")} reads deeper than one member of the module`;
    const got = fromRequire(file, writes[0] as Fact<"value">, path[1], 0);
    return got === null || got.settled ? null : got.note;
  };

  const exportedValue = (file: string, name: string, depth: number): Val | Param | null => {
    if (depth > MAX_MOUNT_DEPTH) return null;
    const cjs = cjsEntry(file, name);
    if (cjs === "competing" || cjs === "replaced") return null;
    const lf = index.languageFacts(file);
    let local: string | null = null;
    if (name === "default") local = lf?.defaultExport ?? null;
    const direct = (fx(file).values.get(name) ?? []).find((v) => v.top && v.exported);
    if (direct) return valueIn(file, [direct.name], 0, direct.line, depth);
    local ??= lf?.exportsLocal.find((x) => x.exported === name)?.local ?? null;
    if (!local && cjs) {
      if (cjs.value.t === "ref" && cjs.value.path.length === 1) local = cjs.value.path[0] as string;
      else return classify(file, { name, value: cjs.value, scope: 0, line: cjs.line, column: cjs.column });
    }
    if (!local) return null;
    const decl = topValue(file, local);
    return decl ? valueIn(file, [local], 0, decl.line, depth) : null;
  };

  // A name's literal string at a place: the binding it reads holds exactly
  // one write, and that write is a string. A name a local or a parameter
  // shadows, or one assigned twice, is no constant.
  const constant = (file: string, scope: number) => (path: string[]): string | null => {
    if (path.length !== 1) return null;
    const name = path[0] as string;
    const writes = writesOf(file, name, bindingScope(file, scope, name));
    const only = writes.length === 1 ? (writes[0] as Fact<"value">) : null;
    return only && only.value.t === "str" ? only.value.v : null;
  };

  // ---------- events on each application and router ----------
  // `more`: arguments the reader cut, in the call or in an array among them.
  type RouteEvent = { type: "route"; file: string; site: Site; methods: string[]; path: Expr; handlers: Expr[]; scope: number; more: number };
  type UseEvent = { type: "use"; file: string; site: Site; prefix: Expr | null; args: Expr[]; scope: number; more: number };
  const cutIn = (args: readonly Expr[], more: number | undefined): number => (more ?? 0) + args.reduce((n, a) => n + (a.t === "array" ? (a.more ?? 0) : 0), 0);
  type Event = RouteEvent | UseEvent;
  const events = new Map<string, Event[]>();
  const vals = new Map<string, Val & { kind: "app" | "router" }>();
  const served = new Map<string, Site[]>();
  const requests: { file: string; site: Site; method: string; path: Expr; agent: Val & { kind: "agent" }; scope: number }[] = [];
  const paramRoutes: { param: Param; event: RouteEvent }[] = [];
  const addEvent = (v: Val & { kind: "app" | "router" }, e: Event) => {
    vals.set(v.id, v);
    push(events, v.id, e);
  };

  const files = index.factFiles().filter(isEnabled);
  for (const file of files) {
    const fi = fx(file);
    if (fi.unread) continue;
    const big = fi.tooLarge;
    if (big) {
      addUnknown({ plugin: PLUGIN, site: { file, line: 1, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware", "tests"], cause: "file-not-parsed", name: null, note: `the file is ${big.bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte cap of the Express plugin, so its routes were not read`, count: null, exact: false });
      continue;
    }
    if (fi.syntaxError) addUnknown({ plugin: PLUGIN, site: { file, line: fi.syntaxError.line, column: 1 }, scope: { file }, affects: ["handles", "mounts", "applies_middleware", "tests"], cause: "file-not-parsed", name: null, note: `the file has ${fi.syntaxError.regions} region(s) the parser could not read, the first at line ${fi.syntaxError.line}; no route was read from them`, count: fi.syntaxError.regions, exact: true });
    for (const list of fx(file).values.values()) {
      for (const v of list) {
        const c = classify(file, v);
        if (c && c.kind !== "agent") {
          vals.set(c.id, c);
          if (!events.has(c.id)) events.set(c.id, []);
        }
      }
    }
  }

  // The receiver of a watched call: a value, a route chain on a value, or a
  // supertest agent.
  type Base = { val: Val | Param; route: Expr | null } | null;
  const baseOf = (file: string, recv: Expr, scope: number, line: number): Base => {
    let r = recv;
    // `x.route("/p").get(h).post(h2)`: walk down the chain of method calls
    // (readExpr kept it at most a few levels deep).
    while (r.t === "call" && r.fn.t === "member" && METHOD_SET.has(r.fn.prop)) r = r.fn.obj;
    if (r.t === "call" && r.fn.t === "ref" && r.fn.path.length >= 2 && r.fn.path[r.fn.path.length - 1] === "route") {
      const v = valueIn(file, r.fn.path.slice(0, -1), scope, line);
      return v && v.kind !== "agent" ? { val: v, route: r.args[0] ?? null } : null;
    }
    if (r.t === "call" && r.fn.t === "member" && r.fn.prop === "route") return null;
    if (r.t === "ref") {
      const v = valueIn(file, r.path, scope, line);
      return v ? { val: v, route: null } : null;
    }
    if (r.t === "call") {
      const c = classify(file, { name: "", value: r, scope, line, column: r.column });
      return c ? { val: c, route: null } : null;
    }
    return null;
  };

  // ---------- the strings a mount path may be ----------
  // Whether an expression is a string the graph can show: a literal, a
  // template or a concatenation, `process.env.X`, `String(x)`, or a name
  // whose every write, here or in the module it is imported from, is one of
  // those. Anything else, a parameter, a member of an object or of a
  // required module, a value of a type the facts do not hold, is not.
  type Binding = { file: string; at: number; name: string };
  const NOT = -1;
  // A name no binding of the file holds: the global of that name. A
  // module-level destructuring (`const { String } = helpers`) writes no
  // value fact, so the file's module-level variables are checked too.
  const isGlobal = (file: string, scope: number, name: string): boolean => bindingScope(file, scope, name) === 0 && writesOf(file, name, 0).length === 0 && !index.languageFacts(file)?.variables?.includes(name) && lookup(file, [name]).kind === "none";
  // The module and the name a module-level name is imported as: the index's
  // own answer, or, for a name the module exports with an export clause
  // (which the index binds to no definition), the import that names it.
  const importTarget = (file: string, name: string): { file: string; name: string } | null => {
    const found = lookup(file, [name]);
    if (found.kind === "miss") return { file: found.target, name: found.name };
    if (found.kind !== "none") return null;
    const imp = index.languageFacts(file)?.imports.find((i) => i.names.some((n) => n.local === name));
    const imported = imp?.names.find((n) => n.local === name)?.imported;
    if (!imp || imported === undefined || !take("lookups")) return null;
    const mod = index.module(file, imp.spec);
    return mod.kind === "module" ? { file: mod.file, name: imported } : null;
  };
  // One expression for the string check: a string (0), no string (NOT), or the binding of a name, to read.
  const stringStep = (file: string, e: Expr, scope: number): number | Binding => {
    if (e.t === "str" || e.t === "dyn") return 0;
    if (e.t === "call") return e.fn.t === "ref" && e.fn.path.length === 1 && e.fn.path[0] === "String" && isGlobal(file, scope, "String") ? 0 : NOT;
    if (e.t !== "ref") return NOT;
    const name = e.path[0] as string;
    if (e.path.length === 3 && name === "process" && e.path[1] === "env") return isGlobal(file, scope, "process") ? 0 : NOT;
    if (e.path.length !== 1) return NOT;
    const at = bindingScope(file, scope, name);
    if (writesOf(file, name, at).length > 0) return { file, at, name };
    if (at !== 0) return NOT;
    const target = importTarget(file, name);
    const lf = target ? index.languageFacts(target.file) : null;
    if (!target || !lf) return NOT;
    // `export default Y` and `module.exports = Y` export Y's value when they
    // run: Y must be a const, and no other `module.exports` may replace it.
    if (target.name === "default" && lf.defaultExport !== null) {
      const cjs = cjsEntry(target.file, "default");
      const writes = writesOf(target.file, lf.defaultExport, 0);
      return cjs !== "competing" && cjs !== "replaced" && writes.length > 0 && writes.every((w) => w.decl === "const") ? { file: target.file, at: 0, name: lf.defaultExport } : NOT;
    }
    // `export const X = ...`, or `const Y = ...; export { Y as X }`.
    const local = writesOf(target.file, target.name, 0).some((v) => v.exported) ? target.name : (lf.exportsLocal.find((x) => x.exported === target.name)?.local ?? null);
    return local !== null && writesOf(target.file, local, 0).length > 0 ? { file: target.file, at: 0, name: local } : NOT;
  };
  // How many names a binding is from a string (1 when every write is
  // one), or NOT: a write that is no string, more than MAX_STRING_WRITES
  // writes, more than MAX_MOUNT_DEPTH names to a string, or a name that
  // reaches itself. Each is a property of the binding alone, so the answer
  // is the same whichever mount asks first; each binding is read once per
  // build, without recursion, and each write read is charged to the lookup
  // budget.
  const stringHeight = new Map<string, number>();
  const keyOf = (b: Binding): string => `${b.file}\0${b.at}\0${b.name}`;
  const heightOf = (root: Binding): number => {
    const known = stringHeight.get(keyOf(root));
    if (known !== undefined) return known;
    type Frame = { key: string; steps: (number | Binding)[]; next: number; height: number };
    const frames: Frame[] = [];
    const reading = new Set<string>();
    const open = (b: Binding): void => {
      const key = keyOf(b);
      const writes = writesOf(b.file, b.name, b.at);
      const read = writes.length > 0 && writes.length <= MAX_STRING_WRITES && take("lookups", writes.length);
      frames.push({ key, steps: read ? writes.map((w) => stringStep(b.file, w.value, w.scope)) : [NOT], next: 0, height: 0 });
      reading.add(key);
    };
    open(root);
    let out = NOT;
    while (frames.length > 0) {
      const f = frames[frames.length - 1] as Frame;
      let opened = false;
      while (f.height !== NOT && f.next < f.steps.length) {
        const step = f.steps[f.next] as number | Binding;
        const h = typeof step === "number" ? step : (stringHeight.get(keyOf(step)) ?? (reading.has(keyOf(step)) ? NOT : null));
        if (h === null) {
          open(step as Binding);
          opened = true;
          break;
        }
        f.height = h === NOT ? NOT : Math.max(f.height, h + 1);
        f.next++;
      }
      if (opened) continue;
      out = f.height !== NOT && f.height <= MAX_MOUNT_DEPTH ? f.height : NOT;
      stringHeight.set(f.key, out);
      reading.delete(f.key);
      frames.pop();
    }
    return out;
  };
  const stringLike = (file: string, e: Expr, scope: number): boolean => {
    const step = stringStep(file, e, scope);
    return typeof step === "number" ? step !== NOT : heightOf(step) !== NOT;
  };
  // Whether the first argument of a use call is a mount path the code
  // computes: `app.use(PREFIX, router)`, `app.use(process.env.PREFIX, auth)`.
  // Express takes a first argument that is not a function for the path; it
  // is read as one only when the graph shows it is a string. Any other
  // first argument is middleware.
  const computedPrefix = (file: string, first: Expr, rest: readonly Expr[], scope: number): boolean => rest.length > 0 && stringLike(file, first, scope);

  for (const file of files) {
    if (fx(file).tooLarge || fx(file).unread) continue;
    for (const f of fx(file).calls) {
      const site: Site = { file, line: f.line, column: f.column };
      const base = baseOf(file, f.recv, f.scope, f.line);
      if (!base) continue;
      const v = base.val;
      if (v.kind === "agent") {
        if (METHOD_SET.has(f.prop) && f.args[0] && f.prop !== "all") requests.push({ file, site, method: f.prop === "del" ? "DELETE" : f.prop.toUpperCase(), path: f.args[0], agent: v, scope: f.scope });
        continue;
      }
      if (f.prop === "listen") {
        if (v.kind !== "param") push(served, v.id, site);
        continue;
      }
      if (f.prop === "use") {
        if (base.route || v.kind === "param") continue;
        const first = f.args[0];
        const isPath = first !== undefined && (first.t === "str" || first.t === "dyn" || (first.t === "ref" && evaluate(first, constant(file, f.scope)) !== null));
        const isPrefix = isPath || (first !== undefined && computedPrefix(file, first, f.args.slice(1), f.scope));
        addEvent(v, { type: "use", file, site, prefix: isPrefix ? (first as Expr) : null, args: isPrefix ? f.args.slice(1) : f.args, scope: f.scope, more: cutIn(f.args, f.more) });
        continue;
      }
      if (!METHOD_SET.has(f.prop)) continue;
      // `app.get("name")` with one argument reads a setting; a route needs a handler.
      const path = base.route ?? f.args[0];
      const handlers = base.route ? f.args : f.args.slice(1);
      if (!path || handlers.length === 0) continue;
      const method = f.prop === "all" ? "*" : f.prop === "del" ? "DELETE" : f.prop.toUpperCase();
      const e: RouteEvent = { type: "route", file, site, methods: [method], path, handlers, scope: f.scope, more: cutIn(f.args, f.more) };
      if (v.kind === "param") paramRoutes.push({ param: v, event: e });
      else addEvent(v, e);
    }
    for (const f of fx(file).servers) {
      const id = identity(file);
      const p = f.fn;
      const isNode = (p.length === 2 && id.http.has(p[0] as string)) || (p.length === 1 && id.createServer.has(p[0] as string));
      if (!isNode) continue;
      for (const a of f.args) {
        if (a.t !== "ref") continue;
        const v = valueIn(file, a.path, f.scope, f.line);
        if (v && v.kind === "app") push(served, v.id, { file, line: f.line, column: f.column });
      }
    }
  }
  for (const list of events.values()) list.sort((a, b) => (a.file === b.file ? a.site.line - b.site.line || a.site.column - b.site.column : a.file < b.file ? -1 : 1));

  // ---------- handlers and middleware ----------
  type Bound = { status: HandlerStatus; targets: string[]; tier: Tier; kind: FrameworkEvidenceKind; via: FrameworkEvidence["via"]; note: string | null; why: { cause: FrameworkUnknown["cause"]; note: string; name: string | null } | null };
  const bindCache = new Map<string, Bound>();
  const bindFn = (file: string, e: Expr, scope: number, line: number, role: "handler" | "middleware"): Bound => {
    const key = `${file}:${e.line}:${e.column}:${role}`;
    const kept = bindCache.get(key);
    if (kept) return kept;
    const out = bindOnce(file, e, scope, line, role);
    bindCache.set(key, out);
    return out;
  };
  const bindOnce = (file: string, e: Expr, scope: number, line: number, role: "handler" | "middleware"): Bound => {
    const none = (status: HandlerStatus, cause: FrameworkUnknown["cause"], note: string, name: string | null): Bound => ({ status, targets: [], tier: "certain", kind: "route-call", via: null, note: null, why: { cause, note, name } });
    if (e.t === "fn") {
      const inline = role === "handler" ? inlineHandler(index, file, e) : null;
      if (inline) return { status: "bound", targets: [inline], tier: "certain", kind: "route-call", via: null, note: null, why: null };
      return none("unresolved", "unsupported-rule", `the ${role} is an inline function, which has no symbol of its own; the calls it makes are counted under the code around it`, null);
    }
    if (e.t === "call") {
      const inner = e.args.find((a) => a.t === "ref");
      const wrapper = show(e.fn);
      if (role === "middleware") {
        const fn = e.fn.t === "ref" ? lookup(file, e.fn.path) : null;
        if (fn?.kind === "symbol") return { status: "bound", targets: fn.ids, tier: "possible", kind: "route-call", via: fn.via, note: `the middleware is the value ${show(e)} returns`, why: null };
        return none(fn?.kind === "external" ? "external" : "unresolved", fn?.kind === "external" ? "external" : "unsupported-rule", `the middleware is the value ${show(e)} returns`, null);
      }
      return none("unresolved", "unsupported-rule", `the handler is the value ${show(e)} returns; whether ${wrapper} calls ${inner ? show(inner) : "what it is given"} is not proved, so the handler is not bound`, inner ? show(inner) : wrapper);
    }
    if (e.t !== "ref") return none("dynamic", "dynamic", `the ${role} is computed (${show(e)})`, null);
    const found = lookup(file, e.path);
    switch (found.kind) {
      case "symbol":
        return { status: "bound", targets: found.ids, tier: found.tier, kind: "route-call", via: found.via, note: found.tier === "certain" ? null : (found.note ?? `the ${role}'s binding is ${found.tier}`), why: null };
      case "miss":
        return none("missing", "miss", `the ${role} ${show(e)} names ${found.name} in ${found.target}, where no such definition exists now`, show(e));
      case "external":
        return none("external", "external", `${show(e)} comes from a declared dependency`, show(e));
      case "gap":
        return none(found.cause === "ambiguous" ? "ambiguous" : "unresolved", found.cause, found.note, show(e));
      default: {
        const head = e.path[0] as string;
        const isLocal = fx(file).values.has(head) || fx(file).params.has(head) || (e.path.length === 1 && valueIn(file, e.path, scope, line) !== null);
        if (isLocal) return none("dynamic", "dynamic", `the ${role} ${show(e)} is a value the code computes, not a definition`, show(e));
        return none("missing", "miss", `no definition named ${show(e)} is in scope`, show(e));
      }
    }
  };

  const errorHandler = (id: string): boolean => {
    const n = index.node(id);
    if (!n) return false;
    return (fx(n.file).functions.get(n.name) ?? []).some((f) => f.line === n.startLine && f.params === 4);
  };

  // A middleware that cannot be bound is a gap in the chain, said once per
  // site: a dependency's middleware (`express.json()`) is known, not a gap.
  const middlewareGap = (file: string, site: Site, b: Bound) => {
    if (!b.why || b.status === "external") return;
    addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["applies_middleware"], cause: b.why.cause, name: b.why.name, note: `a middleware of this chain is not bound: ${b.why.note}`, count: null, exact: false });
  };
  // A call whose argument list the reader cut: its handler and the
  // middleware past the cut were not read.
  const cutGap = (file: string, site: Site, more: number, what: string) => {
    addUnknown({ plugin: PLUGIN, site, scope: { file }, affects: ["handles", "mounts", "applies_middleware"], cause: "fan-out-capped", name: null, note: `the call has ${more} more arguments than the ${MAX_ITEMS} the plugin reads, so ${what} past them were not read`, count: more, exact: true });
  };

  const roleSeen = new Set<string>();
  const addRole = (target: string, role: "route_handler" | "middleware" | "test", detail: string | null, app: string | null, evidence: FrameworkEvidence) => {
    const k = `${target}\0${role}`;
    if (roleSeen.has(k)) return;
    roleSeen.add(k);
    if (!take("roles")) return;
    roles.push({ target, role, detail, app, evidence });
  };

  // ---------- composition: every route each application serves ----------
  type Mw = { prefix: string | null; site: Site; file: string; expr: Expr; scope: number };
  const segs = (p: string): string[] => p.split("/").filter((s) => s !== "");
  const joinPath = (a: string, b: string): string => `/${[...segs(a), ...segs(b)].join("/")}`;
  const under = (pattern: string | null, prefix: string | null): boolean => {
    if (prefix === null || prefix === "/" || prefix === "") return true;
    if (pattern === null) return false;
    const p = segs(prefix);
    const q = segs(pattern);
    return p.length <= q.length && p.every((s, i) => s === q[i]);
  };
  const scopeOf = (app: string | null, file: string): FrameworkUnknown["scope"] => (app ? { app } : { file });
  // The walk stops everywhere once a build budget it spends is gone.
  const halted = (): boolean => exhausted("mounts") || exhausted("registrations");

  const reached = new Set<string>(); // routers some application reaches
  const mountedBy = new Map<string, number>(); // routers mounted anywhere, application or not
  for (const [id, list] of events) {
    for (const e of list) {
      if (e.type !== "use") continue;
      for (const a of e.args) {
        const v = argValue(e.file, a, e.scope, e.site.line);
        if (v && v.kind === "router" && v.id !== id) mountedBy.set(v.id, (mountedBy.get(v.id) ?? 0) + 1);
      }
    }
  }

  let middlewareOmitted = 0; // middleware past MAX_MIDDLEWARE_CHAIN in one chain
  const depthCut = new Map<string, number>(); // per application root: mounts past MAX_MOUNT_DEPTH

  // A route whose own path is computed: an unknown naming its handler, no registration.
  const computedRoute = (e: RouteEvent, h: Expr) => {
    addUnknown({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles"], cause: "dynamic", name: show(h), note: `the route path ${show(e.path)} is computed at run time, so the route that ${show(h)} handles is not known; it is not listed as a route`, count: null, exact: false });
  };

  const compose = (app: string | null, val: Val & { kind: "app" | "router" }, prefix: string | null, inherited: Mw[], via: Site[], stack: readonly string[], depth: number) => {
    if (app) reached.add(val.id);
    const mw: Mw[] = [...inherited];
    for (const e of events.get(val.id) ?? []) {
      if (halted()) return;
      if (e.type === "use") {
        const own = e.prefix === null ? null : evaluate(e.prefix, constant(e.file, e.scope));
        if (e.prefix !== null && own === null) {
          addUnknown({ plugin: PLUGIN, site: e.site, scope: scopeOf(app, e.file), affects: ["mounts", "handles", "applies_middleware"], cause: "dynamic", name: show(e.prefix), note: `the mount path ${show(e.prefix)} is computed at run time, so the routes under it have no known pattern`, count: null, exact: false });
        }
        // A computed prefix anywhere above leaves every pattern below it unknown.
        const at = e.prefix === null ? prefix : own === null || prefix === null ? null : joinPath(prefix, own);
        const known = e.prefix === null || own !== null;
        if (e.more > 0) cutGap(e.file, e.site, e.more, "the routers and middleware");
        for (const a of e.args) {
          if (halted()) return;
          const target = argValue(e.file, a, e.scope, e.site.line);
          if (target && target.kind === "router") {
            // A mount that loops back to a router on the way here ends the loop.
            if (stack.includes(target.id)) continue;
            if (depth >= MAX_MOUNT_DEPTH) {
              const root = stack[0] as string;
              depthCut.set(root, (depthCut.get(root) ?? 0) + 1);
              continue;
            }
            if (!take("mounts")) return;
            edges.push({ from: val.id, to: target.id, kind: "mounts", plugin: PLUGIN, app, evidence: { kind: "mount", tier: "certain", site: e.site, via: null, premises: [], rule: rule("express-mount"), note: null } });
            compose(app, target, at, mw.filter((m) => under(at, m.prefix)), [...via, e.site], [...stack, target.id], depth + 1);
            continue;
          }
          if (target && target.kind === "app") {
            // A sub-application keeps its own routes and identity; the routes it serves under this mount are not composed.
            addUnknown({ plugin: PLUGIN, site: e.site, scope: scopeOf(app, e.file), affects: ["mounts", "handles"], cause: "unsupported-rule", name: show(a), note: `${show(a)} is an application mounted here as a sub-application; the plugin lists its routes on it alone, not under this mount path`, count: null, exact: false });
            continue;
          }
          // A router brought in by a require the plugin cannot follow is not listed under this mount.
          const inline = target || a.t === "ref" ? null : inlineRequire(e.file, a, e.scope, 0);
          const lost = target ? null : a.t === "ref" ? requireGap(e.file, a.path, e.scope) : inline && !inline.settled ? inline.note : null;
          if (lost !== null) addUnknown({ plugin: PLUGIN, site: e.site, scope: scopeOf(app, e.file), affects: ["mounts", "handles"], cause: "dynamic", name: show(a), note: `${show(a)} comes from a CommonJS require the plugin cannot follow (${lost}), so it may be a router whose routes are not listed under this mount`, count: null, exact: false });
          if (mw.length >= MAX_MIDDLEWARE_CHAIN) {
            middlewareOmitted++;
            continue;
          }
          // Middleware under a computed mount path is not known to apply to any route.
          if (known) mw.push({ prefix: at, site: e.site, file: e.file, expr: a, scope: e.scope });
          // Every function given to use is middleware, whether or not a route follows it.
          const b = bindFn(e.file, a, e.scope, e.site.line, "middleware");
          middlewareGap(e.file, { file: e.file, line: a.line, column: a.column }, b);
          for (const t of b.targets) addRole(t, "middleware", errorHandler(t) ? "error-handler" : "express", app, { kind: "route-call", tier: b.tier, site: e.site, via: b.via, premises: [], rule: rule("express-middleware"), note: b.note });
        }
        continue;
      }
      // A route.
      const h = e.handlers[e.handlers.length - 1] as Expr;
      const written = evaluate(e.path, constant(e.file, e.scope));
      if (written === null) {
        computedRoute(e, h);
        continue;
      }
      if (!take("registrations")) return;
      // A router no application reaches is composed from "" and keeps its
      // pattern relative; one under a computed mount path has none.
      const pattern = prefix === null ? null : joinPath(prefix, written);
      const key = `${e.file}:${e.site.line}:${e.site.column}${via.map((s) => `@${s.file}:${s.line}:${s.column}`).join("")}`;
      const id = entityId(PLUGIN, app, "registration", key);
      // When the reader cut the arguments, the last one read is not the handler.
      const bound: Bound = e.more > 0 ? { status: "unresolved", targets: [], tier: "certain", kind: "route-call", via: null, note: null, why: null } : bindFn(e.file, h, e.scope, e.site.line, "handler");
      if (e.more > 0) cutGap(e.file, e.site, e.more, "the handler and the middleware");
      registrations.push({
        kind: "registration",
        id,
        plugin: PLUGIN,
        app,
        methods: e.methods,
        pattern,
        written,
        name: null,
        site: e.site,
        mountedVia: via,
        mounted: app !== null,
        handler: { written: e.more > 0 ? "past the arguments read" : show(h), status: bound.status, targets: bound.targets },
      });
      if (bound.why) addUnknown({ plugin: PLUGIN, site: { file: e.file, line: h.line, column: h.column }, scope: { file: e.file }, affects: ["handles"], cause: bound.why.cause, name: bound.why.name, note: bound.why.note, count: null, exact: false });
      for (const t of bound.targets) {
        const ev: FrameworkEvidence = { kind: bound.kind, tier: bound.tier, site: e.site, via: bound.via, premises: [], rule: rule("express-route"), note: bound.note };
        edges.push({ from: id, to: t, kind: "handles", plugin: PLUGIN, app, evidence: ev });
        addRole(t, "route_handler", "express", app, ev);
      }
      // Middleware: the application's and routers' own in effect here, then
      // the route's (every argument read, when the list was cut).
      const own: Mw[] = [];
      for (const x of e.more > 0 ? e.handlers : e.handlers.slice(0, -1)) {
        for (const item of x.t === "array" ? x.items : [x]) own.push({ prefix: null, site: e.site, file: e.file, expr: item, scope: e.scope });
      }
      const chain = [...mw.filter((m) => under(pattern, m.prefix)), ...own];
      if (chain.length > MAX_MIDDLEWARE_CHAIN) middlewareOmitted += chain.length - MAX_MIDDLEWARE_CHAIN;
      let order = 0;
      for (const m of chain.slice(0, MAX_MIDDLEWARE_CHAIN)) {
        const b = bindFn(m.file, m.expr, m.scope, m.site.line, "middleware");
        middlewareGap(m.file, { file: m.file, line: m.expr.line, column: m.expr.column }, b);
        for (const t of b.targets) {
          const ev: FrameworkEvidence = { kind: "route-call", tier: b.tier, site: m.site, via: b.via, premises: [], rule: rule("express-middleware"), note: b.note };
          addRole(t, "middleware", errorHandler(t) ? "error-handler" : "express", app, ev);
          if (take("middlewareEdges")) edges.push({ from: id, to: t, kind: "applies_middleware", plugin: PLUGIN, app, evidence: ev, order });
        }
        order++;
      }
    }
  };

  for (const v of vals.values()) {
    if (v.kind !== "app") continue;
    // Past the build's applications, an application and its routes are left out, and counted.
    if (!take("apps")) continue;
    const id = v.id;
    compose(id, v, "", [], [], [id], 0);
    const version = index.model().node.find((p) => p.dir === index.projectOf(v.file))?.pkg.deps.get("express") ?? null;
    const servedAt = served.get(id) ?? [];
    apps.push({
      id,
      name: `${v.name} (${v.file})`,
      project: index.projectOf(v.file),
      root: index.projectOf(v.file),
      site: { file: v.file, line: v.line, column: v.column },
      evidence: [{ file: v.file, line: v.line, note: "made by calling the express module's default export" }, ...servedAt.slice(0, 8).map((s) => ({ file: s.file, line: s.line, note: "served here" }))],
      version,
      data: { served: servedAt.length > 0 },
    });
  }
  // Routers no application reaches: their routes are kept, relative and not served.
  for (const v of vals.values()) {
    if (v.kind !== "router" || reached.has(v.id) || (mountedBy.get(v.id) ?? 0) > 0) continue;
    compose(null, v, "", [], [], [v.id], 0);
  }
  // Routes on a parameter typed as an application or a router.
  for (const { param, event: e } of paramRoutes) {
    const h = e.handlers[e.handlers.length - 1] as Expr;
    const written = evaluate(e.path, constant(e.file, e.scope));
    if (written === null) {
      computedRoute(e, h);
      continue;
    }
    if (!take("registrations")) break;
    const bound: Bound = e.more > 0 ? { status: "unresolved", targets: [], tier: "certain", kind: "route-call", via: null, note: null, why: null } : bindFn(e.file, h, e.scope, e.site.line, "handler");
    if (e.more > 0) cutGap(e.file, e.site, e.more, "the handler and the middleware");
    const id = entityId(PLUGIN, null, "registration", `${e.file}:${e.site.line}:${e.site.column}`);
    registrations.push({ kind: "registration", id, plugin: PLUGIN, app: null, methods: e.methods, pattern: written, written, name: null, site: e.site, mountedVia: [], mounted: false, handler: { written: show(h), status: bound.status, targets: bound.targets } });
    addUnknown({ plugin: PLUGIN, site: e.site, scope: { file: e.file }, affects: ["handles", "mounts"], cause: "dynamic", name: param.name, note: `the route is registered on the parameter ${param.name} (${param.type}); which application it lands on, and under which prefix, is decided by the caller`, count: null, exact: false });
    if (bound.why) addUnknown({ plugin: PLUGIN, site: { file: e.file, line: h.line, column: h.column }, scope: { file: e.file }, affects: ["handles"], cause: bound.why.cause, name: bound.why.name, note: bound.why.note, count: null, exact: false });
    for (const t of bound.targets) {
      const ev: FrameworkEvidence = { kind: "route-call", tier: bound.tier, site: e.site, via: bound.via, premises: [], rule: rule("express-route"), note: bound.note };
      edges.push({ from: id, to: t, kind: "handles", plugin: PLUGIN, app: null, evidence: ev });
      addRole(t, "route_handler", "express", null, ev);
    }
  }

  // ---------- test requests ----------
  // Patterns parsed once per registration, grouped by application. A
  // pattern the matcher does not read is kept apart, so a request it might
  // serve is disclosed rather than taken as no match.
  const byApp = new Map<string, { reg: Registration; pattern: Pattern }[]>();
  const unreadByApp = new Map<string, { reg: Registration; why: "too-long" | "syntax" }[]>();
  for (const r of registrations) {
    if (r.app === null || r.pattern === null) continue;
    if (segs(r.pattern).length > MAX_PATTERN_SEGMENTS) push(unreadByApp, r.app, { reg: r, why: "too-long" });
    else {
      const p = parsePattern(r.pattern);
      if (p) push(byApp, r.app, { reg: r, pattern: p });
      else push(unreadByApp, r.app, { reg: r, why: "syntax" });
    }
  }
  const testFiles = new Set<string>();
  let requestsCut = 0; // requests past the build's request cap
  let stepsCut = 0; // requests the pattern-step budget left unmatched
  for (const r of requests) {
    if (exhausted("matchWork")) {
      stepsCut++;
      continue;
    }
    if (!take("requests")) {
      requestsCut++;
      continue;
    }
    const target = r.agent.target;
    const app = target.t === "ref" ? valueIn(r.agent.file, target.path, r.agent.scope, r.agent.line) : null;
    if (!app || app.kind !== "app") continue;
    testFiles.add(r.file);
    const path = evaluate(r.path, constant(r.file, r.scope));
    if (path === null) {
      addUnknown({ plugin: PLUGIN, site: r.site, scope: { file: r.file }, affects: ["tests"], cause: "dynamic", name: show(r.path), note: `the test requests a computed path (${show(r.path)}), so the route it reaches is not known`, count: null, exact: false });
      continue;
    }
    const clean = (path.split("?")[0] as string).split("#")[0] as string;
    const asked = segs(clean);
    if (asked.length > MAX_PATTERN_SEGMENTS) {
      addUnknown({ plugin: PLUGIN, site: r.site, scope: { file: r.file }, affects: ["tests"], cause: "fan-out-capped", name: null, note: `the test requests a path of ${asked.length} segments, more than the ${MAX_PATTERN_SEGMENTS} the matcher reads, so the route it reaches is not known`, count: null, exact: false });
      continue;
    }
    const methodFits = (reg: Registration) => reg.methods.includes("*") || reg.methods.includes(r.method) || (r.method === "HEAD" && reg.methods.includes("GET"));
    const unread = (unreadByApp.get(app.id) ?? []).filter((u) => methodFits(u.reg));
    if (unread.length > 0) {
      const long = unread.some((u) => u.why === "too-long");
      addUnknown({ plugin: PLUGIN, site: r.site, scope: { file: r.file }, affects: ["tests"], cause: long ? "fan-out-capped" : "unsupported-rule", name: null, note: `${unread.length} routes of ${app.name} have patterns the matcher does not read (${long ? `more than ${MAX_PATTERN_SEGMENTS} segments` : "a regular expression or a wildcard inside a segment"}), so whether this request reaches one of them is not known`, count: unread.length, exact: true });
    }
    const from = index.enclosing(r.file, r.site.line)?.id ?? r.file;
    for (const { reg, pattern } of byApp.get(app.id) ?? []) {
      if (!methodFits(reg)) continue;
      if (!take("matchWork", (pattern.length + 1) * (asked.length + 1))) {
        stepsCut++;
        break;
      }
      if (!matchSegments(pattern, asked) || !take("testLinks")) continue;
      edges.push({ from, to: reg.id, kind: "tests", plugin: PLUGIN, app: app.id, category: "route-request", evidence: { kind: "test-route-request", tier: "likely", site: r.site, via: null, premises: [reg.id], rule: rule("express-test-request"), note: `the test requests ${r.method} ${clean} from ${app.name}, which this route's pattern ${reg.pattern} matches` } });
    }
  }
  for (const file of files) {
    if (!isTestFile(file) || fx(file).testBlocks === 0) continue;
    const project = index.projectOf(file);
    const runner = JS_RUNNERS.some((n) => index.declares(project, "npm", n)) || (index.languageFacts(file)?.imports.some((i) => i.spec === "node:test") ?? false);
    if (!runner || (!testFiles.has(file) && identity(file).supertest.size === 0)) continue;
    addRole(file, "test", "supertest", null, { kind: "role-path", tier: "certain", site: { file, line: 1, column: 1 }, via: null, premises: [], rule: rule("express-test-file"), note: null });
  }

  // ---------- what the caps and budgets left out ----------
  // A budget or a cap counted across the whole build.
  const whole = { build: true } as const;
  for (const [root, n] of depthCut) addUnknown({ plugin: PLUGIN, site: null, scope: root.startsWith("fw:express:app:") ? { app: root } : whole, affects: ["mounts", "handles"], cause: "fan-out-capped", name: null, note: `routers mounted more than ${MAX_MOUNT_DEPTH} levels deep were not followed (${n} mounts); their routes are not listed`, count: n, exact: true });
  // These always fit: they are the record of what the caps and budgets cut.
  const cut = (affects: FrameworkUnknown["affects"], cause: FrameworkUnknown["cause"], count: number | null, note: string) => unknowns.push({ plugin: PLUGIN, site: null, scope: whole, affects, cause, name: null, note, count, exact: count !== null });
  if (middlewareOmitted > 0) cut(["applies_middleware"], "fan-out-capped", middlewareOmitted, `${middlewareOmitted} middleware entries past ${MAX_MIDDLEWARE_CHAIN} in one chain were left out`);
  // Each build budget's record of what it cut, the only place a refused
  // take is said: a record over every budget, so a budget added without
  // one does not typecheck. Each floors every caller of the build
  // (escape-corpus/cap-fw-express-build-budgets.json trips one).
  const unreadFiles = [...fileIndexes.values()].filter((f) => f.unread).length;
  const spentOut: Record<Spend, () => void> = {
    facts: () => cut(["handles", "mounts", "applies_middleware", "tests"], "budget", unreadFiles, `${unreadFiles} files were not read: the Express plugin reads at most ${MAX_FACTS_READ} facts in one build`),
    lookups: () => cut(["handles", "mounts", "applies_middleware"], "budget", refused.lookups, `${refused.lookups} names were not looked up: the Express plugin makes at most ${MAX_LOOKUPS} lookups in one build`),
    mounts: () => cut(["mounts", "handles", "applies_middleware"], "fan-out-capped", null, `the walk stopped after ${MAX_MOUNTS} router mounts in this build; the routes past it are not listed`),
    registrations: () => cut(["handles", "applies_middleware"], "fan-out-capped", null, `the walk stopped after ${MAX_REGISTRATIONS} registrations in this build; the routes past it are not listed`),
    middlewareEdges: () => cut(["applies_middleware"], "fan-out-capped", refused.middlewareEdges, `${refused.middlewareEdges} middleware edges were left out: the Express plugin keeps at most ${MAX_MIDDLEWARE_EDGES} in one build`),
    testLinks: () => cut(["tests"], "fan-out-capped", refused.testLinks, `${refused.testLinks} test links were left out: the Express plugin keeps at most ${MAX_TEST_LINKS} in one build`),
    apps: () => cut(["handles", "mounts", "applies_middleware", "tests"], "fan-out-capped", refused.apps, `${refused.apps} applications and their routes were left out: the Express plugin keeps at most ${MAX_APPS} applications in one build`),
    roles: () => cut(["handles", "applies_middleware", "tests"], "fan-out-capped", refused.roles, `${refused.roles} roles were left out: the Express plugin gives at most ${MAX_ROLES} roles in one build`),
    requests: () => cut(["tests"], "fan-out-capped", requestsCut, `${requestsCut} test requests were not matched to routes: the Express plugin matches at most ${MAX_TEST_REQUESTS} requests in one build`),
    matchWork: () => cut(["tests"], "budget", stepsCut, `${stepsCut} test requests were not matched to routes: matching stopped after ${MAX_MATCH_WORK} pattern steps in this build`),
    unknowns: () => cut(["handles", "mounts", "applies_middleware", "tests"], "fan-out-capped", refused.unknowns, `${refused.unknowns} more unknowns past the first ${MAX_UNKNOWNS} were left out`),
  };
  for (const k of Object.keys(spentOut) as Spend[]) if (refused[k] > 0) spentOut[k]();
  const entities: Entity[] = registrations;
  return { apps, output: { roles, entities, edges, unknowns } };
}

// ---------- matching a request path against an Express pattern ----------

// A pattern segment: a literal, a `:name` parameter (one segment), a
// `:name?` optional parameter, or `*` (any number of segments).
type Seg = { t: "lit"; v: string } | { t: "param" } | { t: "optional" } | { t: "star" };
type Pattern = Seg[];

const isWordChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

// A pattern parsed into segments, or null when it holds a form this matcher
// does not read (a regular expression group, a wildcard inside a segment,
// more than MAX_PATTERN_SEGMENTS segments): such a route is never matched.
export function parsePattern(pattern: string): Pattern | null {
  const parts = pattern.split("/").filter((s) => s !== "");
  if (parts.length > MAX_PATTERN_SEGMENTS) return null;
  const out: Pattern = [];
  for (const s of parts) {
    if (s === "*") {
      out.push({ t: "star" });
      continue;
    }
    if (s.charCodeAt(0) === 58) {
      const optional = s.endsWith("?");
      const name = optional ? s.slice(1, -1) : s.slice(1);
      if (name.length === 0) return null;
      for (let i = 0; i < name.length; i++) if (!isWordChar(name.charCodeAt(i))) return null;
      out.push(optional ? { t: "optional" } : { t: "param" });
      continue;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "*" || c === "(" || c === ")" || c === "?" || c === "+" || c === ":" || c === "[") return null;
    }
    out.push({ t: "lit", v: s });
  }
  return out;
}

// Whether request segments match a parsed pattern: one pass over the
// pattern keeping the set of request positions reached, so the work is at
// most (pattern segments + 1) times (request segments + 1) steps, with no
// backtracking.
export function matchSegments(pattern: Pattern, asked: readonly string[]): boolean {
  const n = asked.length;
  let at = new Uint8Array(n + 1);
  at[0] = 1;
  for (const seg of pattern) {
    const next = new Uint8Array(n + 1);
    let any = false;
    if (seg.t === "star") {
      let seen = 0;
      for (let j = 0; j <= n; j++) {
        seen |= at[j] as number;
        next[j] = seen;
        any ||= seen === 1;
      }
    } else {
      for (let j = 0; j <= n; j++) {
        if (!at[j]) continue;
        if (seg.t === "optional") {
          next[j] = 1;
          any = true;
        }
        if (j < n && (seg.t !== "lit" || seg.v === asked[j])) {
          next[j + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    at = next;
  }
  return at[n] === 1;
}

// Whether a request path matches an Express pattern.
export function matches(pattern: string, path: string): boolean {
  const p = parsePattern(pattern);
  const asked = path.split("/").filter((s) => s !== "");
  if (!p || asked.length > MAX_PATTERN_SEGMENTS) return false;
  return matchSegments(p, asked);
}
