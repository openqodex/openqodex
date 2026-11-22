// What a change reaches: the symbols it touches or removes, their callers
// two hops out over calls, inheritance and implementation, what they call
// one hop out, the files that import a changed file, and the public names
// the change removed or bound elsewhere. Every call site is kept with its
// evidence and tier. A path with a possible step (a call through an
// interface or a base type to an implementation, a function value a
// callee, an alias, a table or a returned value may call) is listed apart
// from the certain and likely ones, and the hub rule holds per group. The
// other uses of a touched symbol (as a value, as a type, implemented or
// overridden) are listed one hop out.
//
// Every cut the walk makes is recorded with what it left out (a hub keeps
// its 20 nearest callers, the second hop keeps 20 per caller, the walk stops
// at 200 symbols, a public name keeps its first 200 consumers), and every
// seed says whether its caller list is a floor: a call of the same name the
// graph could not bind, a call through a value in its project, a file of its
// project not read, or a cut at it. The review's packet reads the uncut
// lists from the graph, never from this summary.
import { dirname } from "node:path";
import type { Change, ImpactCut, ImpactEdge, ImpactKind, ImpactPath, ImpactSummary, ImpactSymbol, ImpactUnknown } from "@openqodex/core";
import { langOf } from "./capture/inventory.js";
import { frameworkImpact } from "./frameworks/impact.js";
import type { DispatchSite, Family, Graph, GraphEdge, GraphNode, HotSymbol, Miss, Place, UnknownSite } from "./types.js";
import { familyOf } from "./types.js";

export const HUB_CALLERS = 40; // a symbol with more direct callers is a hub
export const HUB_SHOWN = 20; // callers kept for a hub, and per caller on the second hop
export const WALK_LIMIT = 200; // symbols the whole walk may reach
export const INLINE_SITES = 60; // certain and likely call sites the brief shows
export const INLINE_POSSIBLE = 20; // possible call sites the brief shows
export const REFERENCES_KEPT = 200; // uses of one kind per symbol the summary keeps
const FAN_OUT_CUTS = 10; // capped dispatch sites named per symbol
export const SUMMARY_CONSUMERS = 200; // consumers of a public name the summary keeps
const NEAR_SHOWN = 40;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures?)\/|[._-](test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$|_spec\.rb$|(Test|Tests|TestCase|IT|ITCase)\.java$|(^|\/)(Test|IT)[A-Z][^/]*\.java$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

// Code that is not the product: a test or a fixture; a package's corpus
// (the cases its tests read); a benchmark, which measures the product; and
// the scripts of the repository or of a package (build, release, checks).
// None of them is shipped with the product or imported by it.
const OUTSIDE_PRODUCT = /(^|\/)benchmarks?\/|^packages\/[^/]+\/(corpus|scripts)\/|^scripts\//;
export function isOutsideProduct(path: string): boolean {
  return isTestPath(path) || OUTSIDE_PRODUCT.test(path);
}

// Folders between two files: 0 for the same folder.
function distance(a: string, b: string): number {
  const pa = dirname(a).split("/");
  const pb = dirname(b).split("/");
  let common = 0;
  while (common < pa.length && common < pb.length && pa[common] === pb[common]) common++;
  return pa.length - common + (pb.length - common);
}

function toImpactEdge(e: GraphEdge): ImpactEdge {
  return { from: e.from, to: e.to, kind: e.kind, sites: e.sites };
}

function toSymbol(n: GraphNode): ImpactSymbol {
  return { id: n.id, file: n.file, name: n.name, kind: n.kind, startLine: n.startLine, endLine: n.endLine, snapshot: n.snapshot, ...(n.movedTo ? { movedTo: { ...n.movedTo } } : {}) };
}

// Certain before likely, production files before tests, then the nearest
// folder, then by path and line.
function byCloseness(seedFile: string) {
  const rank = (e: GraphEdge) => (e.tier === "certain" ? 0 : e.tier === "likely" ? 1 : 2);
  return (a: GraphEdge, b: GraphEdge): number => {
    const fa = a.sites[0]?.file ?? a.from;
    const fb = b.sites[0]?.file ?? b.from;
    return (
      Number(isTestPath(fa)) - Number(isTestPath(fb)) ||
      rank(a) - rank(b) ||
      distance(seedFile, fa) - distance(seedFile, fb) ||
      fa.localeCompare(fb) ||
      (a.sites[0]?.line ?? 0) - (b.sites[0]?.line ?? 0)
    );
  };
}

export function emptyImpact(status: "off" | "skipped" | "failed", reason: string): ImpactSummary {
  return {
    version: 2,
    status,
    reasons: [reason],
    risk: null,
    build: { durationMs: 0, cacheHits: 0, parses: 0, eligibleFiles: 0, parsedFiles: 0, omittedFiles: 0, unresolvedSites: null, externalSites: null, mode: null, generation: null },
    symbols: [],
    touched: [],
    removed: [],
    callers: [],
    possible: [],
    references: [],
    callees: [],
    importers: [],
    hubs: [],
    exports: [],
    unknown: { floor: true, seeds: [], causes: {}, near: [], nearTotal: 0, notRead: [], notReadTotal: 0 },
    cuts: [],
    truncated: { walk: false, inline: false, omittedSites: null },
    packet: null,
  };
}

// Possible callers raise a change to medium at most: a widely implemented
// interface must not make every change to one implementation high.
function riskFor(touched: number, callers: number, possible: number, removedStillCalled: boolean, brokenConsumers: number): ImpactSummary["risk"] {
  if (touched === 0) return "none";
  if (removedStillCalled || brokenConsumers > 0 || callers > 8 || touched > 12) return "high";
  if (callers >= 1 || possible >= 1 || touched > 4) return "medium";
  return "low";
}

// Miss targets that point at a removed symbol: its file (old or new path),
// its Go package, or its class.
function missTargets(node: GraphNode, path: string): Set<string> {
  const owner = node.id.slice(node.id.indexOf("#") + 1, node.id.lastIndexOf("@")).split(".").slice(0, -1).join(".");
  const out = new Set<string>();
  for (const file of new Set([node.file, path])) {
    const dir = dirname(file) === "." ? "" : dirname(file);
    if (owner) {
      out.add(`${file}::${owner}`);
      out.add(`go:${dir}::${owner}`);
      out.add(`rb::${owner}`);
      out.add(`java:${file}::${owner}`);
    } else {
      out.add(file);
      out.add(`go:${dir}`);
    }
  }
  return out;
}

export function toImpactUnknown(u: UnknownSite): ImpactUnknown {
  return {
    file: u.file,
    line: u.line > 0 ? u.line : null,
    name: u.name === "" ? null : u.name,
    cause: u.cause,
    scope: u.scope,
    note: u.note ?? null,
    candidates: u.candidates ?? null,
  };
}

const missIndex = new WeakMap<Graph, Map<string, Miss[]>>();
function missesNamed(graph: Graph, name: string): Miss[] {
  let byName = missIndex.get(graph);
  if (!byName) {
    byName = new Map();
    for (const m of graph.misses) {
      const list = byName.get(m.name);
      if (list) list.push(m);
      else byName.set(m.name, [m]);
    }
    missIndex.set(graph, byName);
  }
  return byName.get(name) ?? [];
}

// Every call site that still reaches a removed symbol, one edge per caller:
// a current call whose evidence points at the place the base version
// defined it (its file under the old or new path, its Go package or its
// class). Nothing is cut here. `path` is the changed file it was removed from.
export function callersOfRemoved(graph: Graph, node: GraphNode, path: string): GraphEdge[] {
  const targets = missTargets(node, path);
  const byFrom = new Map<string, GraphEdge>();
  for (const m of missesNamed(graph, node.name)) {
    if (!targets.has(m.target)) continue;
    let e = byFrom.get(m.from);
    if (!e) {
      e = { from: m.from, to: node.id, kind: "calls", tier: m.site.tier, sites: [] };
      byFrom.set(m.from, e);
    }
    e.sites.push(m.site);
  }
  return [...byFrom.values()];
}

// Dispatch sites by the member name they call.
const dispatchIndex = new WeakMap<Graph, Map<string, DispatchSite[]>>();
function dispatchNamed(graph: Graph, name: string): DispatchSite[] {
  let byName = dispatchIndex.get(graph);
  if (!byName) {
    byName = new Map();
    for (const d of graph.dispatch) {
      const list = byName.get(d.name);
      if (list) list.push(d);
      else byName.set(d.name, [d]);
    }
    dispatchIndex.set(graph, byName);
  }
  return byName.get(name) ?? [];
}

const budgetSets = new WeakMap<Graph, Set<string>>();
function budgetFilesOf(graph: Graph): Set<string> {
  let set = budgetSets.get(graph);
  if (!set) {
    set = new Set(graph.unknowns.filter((u) => u.cause === "budget").map((u) => u.file));
    budgetSets.set(graph, set);
  }
  return set;
}

// The language family of a file: TypeScript and JavaScript are one.
function familyAt(graph: Graph, file: string): Family | null {
  const lang = graph.nodes.get(file)?.lang ?? langOf(file);
  return lang ? familyOf(lang) : null;
}

const unknownIndex = new WeakMap<Graph, Map<string, UnknownSite[]>>();
function unknownsNamed(graph: Graph, name: string): UnknownSite[] {
  let byName = unknownIndex.get(graph);
  if (!byName) {
    byName = new Map();
    for (const u of graph.unknowns) {
      if (u.name === "") continue;
      const list = byName.get(u.name);
      if (list) list.push(u);
      else byName.set(u.name, [u]);
    }
    unknownIndex.set(graph, byName);
  }
  return byName.get(name) ?? [];
}

// The calls of a seed's name no rule could bind that may be its callers
// (rule C): only in files of its family, since a Go call cannot reach a
// TypeScript function. A TypeScript or JavaScript plain function leaves
// out the calls that cannot run a plain function: a bare call of a local
// or a parameter, `this.x()` where `this` is proved a class's instance, a
// call on a value whose class or interface lacks the member. The warning,
// the causes and the examples of a callers answer read this list.
export function sameNameGaps(graph: Graph, seed: { name: string; file: string; kind?: ImpactKind | undefined }): UnknownSite[] {
  const family = familyAt(graph, seed.file);
  const named = unknownsNamed(graph, seed.name);
  // Only TypeScript and JavaScript are narrowed to their own family. The
  // others call by a name built at run time (Java reflection, Ruby `send`,
  // Python `getattr`, Go `reflect`) in ways their readers do not record, so
  // a call of the name in any language keeps the floor it kept before.
  if (family !== "js") return named;
  const plain = seed.kind === "function";
  return named.filter((u) => familyAt(graph, u.file) === family && !(plain && u.notPlain));
}

// The opaque files that can reach a file's definitions, by how: one that
// may load any module reaches every one; one reaches its own and those of
// the modules it imports; one that reads the global scope reaches a
// script's; one with an import the graph could not bind reaches every one
// of its project, since what it imports is not known.
type OpaqueFile = Graph["escapes"]["opaque"] extends Map<string, infer V> ? V : never;
type OpaqueReach = { any: OpaqueFile[]; byFile: Map<string, OpaqueFile[]>; global: OpaqueFile[]; unbound: Map<string, OpaqueFile[]> };
const opaqueReach = new WeakMap<Graph, OpaqueReach>();
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};
function opaqueFor(graph: Graph, file: string, project: string): { file: string; line: number; why: string; how: string; any: boolean }[] {
  let r = opaqueReach.get(graph);
  if (!r) {
    r = { any: [], byFile: new Map(), global: [], unbound: new Map() };
    const files = [...graph.escapes.opaque.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (const o of files) {
      if (o.any) r.any.push(o);
      if (o.global) r.global.push(o);
      if (o.unbound) push(r.unbound, graph.projectOf(o.file), o);
      for (const m of o.reach) push(r.byFile, m, o);
    }
    opaqueReach.set(graph, r);
  }
  // Nearest first: the file itself, the files that import it, then the wider ways.
  const out: { file: string; line: number; why: string; how: string; any: boolean }[] = [];
  const seen = new Set<string>();
  const add = (list: OpaqueFile[] | undefined, how: (o: OpaqueFile) => string) => {
    for (const o of list ?? []) {
      if (seen.has(o.file)) continue;
      seen.add(o.file);
      out.push({ file: o.file, line: o.line, why: o.why, how: how(o), any: o.any });
    }
  };
  const reaching = r.byFile.get(file);
  add(reaching?.filter((o) => o.file === file), () => "defines it");
  add(reaching, () => "imports its module");
  if (graph.escapes.scripts.has(file)) add(r.global, () => "reads the global scope, where a script's definitions live");
  add(r.unbound.get(project), () => "imports a module the graph could not find, so what it reaches is not known");
  add(r.any, () => "may load any module");
  return out;
}

// Calls through a value (a callback, a computed member), per family, with the first place.
const familyValueCalls = new WeakMap<Graph, Map<Family, Place & { count: number }>>();
function valueCallsOf(graph: Graph, family: Family): (Place & { count: number }) | undefined {
  let byFamily = familyValueCalls.get(graph);
  if (!byFamily) {
    byFamily = new Map();
    for (const u of graph.unknowns) {
      if (u.scope !== "project" || u.cause === "metadata-unreadable") continue;
      const f = familyAt(graph, u.file);
      if (!f) continue;
      const kept = byFamily.get(f);
      if (kept) kept.count++;
      else byFamily.set(f, { file: u.file, line: u.line, count: 1 });
    }
    familyValueCalls.set(graph, byFamily);
  }
  return byFamily.get(family);
}

const at = (p: Place) => `${p.file}:${p.line}`;
const calls = (n: number) => `${n} ${n === 1 ? "call" : "calls"}`;

// Why a seed's caller list may be short. Empty when the graph knows it is
// whole. A function or a method is whole only when every way it may be
// reached by a call the graph cannot bind is checked and closed: a call of
// its name no rule bound (C), a use of it as a value under any of its
// names (D), its module used as a value (E), a call through a value that
// may hold its object, for a member (F), a call through a value in its
// project, for a function or method of a family with no such checks (G),
// and a name built at run time (H). Other kinds keep the older rule: any call of
// the name, any call through a value in the project.
export function floorReasons(graph: Graph, seed: { id: string; name: string; file: string; kind?: ImpactKind | undefined }, cutAt: ReadonlySet<string>): string[] {
  return floorOf(graph, seed, cutAt).reasons;
}

// The reasons with every place they rest on: where a hidden call would
// run. `places` is null when a reason does not know each of them (a count,
// the first of many, a cut) or when the call runs where a value goes, not
// where it was taken (a use as a value, a getter read, a function passed
// to a callee that calls it): such a floor may hide a caller anywhere.
export type Floor = { reasons: string[]; places: { file: string; line: number | null }[] | null };
export function floorOf(graph: Graph, seed: { id: string; name: string; file: string; kind?: ImpactKind | undefined }, cutAt: ReadonlySet<string>): Floor {
  const reasons: string[] = [];
  let places: Floor["places"] = [];
  const why = (reason: string, at: readonly { file: string; line: number | null }[] | null) => {
    reasons.push(reason);
    places = places && at ? [...places, ...at.map((p) => ({ file: p.file, line: p.line }))] : null;
  };
  // A count of calls with its first place knows every place only when it is one.
  const only = (p: Place & { count: number }) => (p.count === 1 ? [p] : null);
  // A possible caller is never proof that the code runs, nor that nothing else reaches it.
  const possibleSites = (graph.in.get(seed.id) ?? []).filter((e) => e.tier === "possible" && e.from !== seed.id).flatMap((e) => e.sites);
  const possible = possibleSites.length;
  // A function passed to a callee that calls it runs in that callee, not at the site that passed it.
  if (possible > 0) why(`${possible} ${possible === 1 ? "call" : "calls"} may reach it through an interface, a base type or a function value, and none is proved to`, possibleSites.some((p) => p.evidence === "invocation-summary") ? null : possibleSites);
  const kind = seed.kind ?? graph.nodes.get(seed.id)?.kind;
  const family = familyAt(graph, seed.file);
  const project = graph.projectOf(seed.file);
  const projectValues = (): boolean => {
    const values = graph.valueCalls.get(project) ?? 0;
    if (values > 0) why(`${values} ${values === 1 ? "call goes" : "calls go"} through a value (a callback or a computed member) in ${project === "" ? "the repository root project" : project}, and could reach it`, null);
    return values > 0;
  };
  if (kind !== "function" && kind !== "method") {
    const named = graph.unknownNames.get(seed.name) ?? 0;
    if (named > 0) why(`${calls(named)} named \`${seed.name}\` in the repository could not be bound to one definition`, null);
    projectValues();
  } else {
    const gaps = sameNameGaps(graph, { ...seed, kind });
    if (gaps.length > 0) why(`${calls(gaps.length)} named \`${seed.name}\` in the repository could not be bound to one definition`, gaps);
    const x = graph.escapes;
    const used = x.uses.get(seed.id);
    if (used) why(`it is used as a value in ${used.count} ${used.count === 1 ? "place" : "places"}, first at ${at(used)}; a call through that value is not listed`, null);
    const loose = family ? x.unbound.get(`${family}:${seed.name}`) : undefined;
    if (loose) why(`${loose.count} ${loose.count === 1 ? "use" : "uses"} of the name \`${seed.name}\` as a value could not be bound to one definition, first at ${at(loose)}`, null);
    const reach = x.reach.get(seed.id) ?? [];
    const removed = !graph.nodes.has(seed.id);
    // A definition a change removed: the module that held it escapes, so a
    // computed name may still reach it, though the export table no longer lists it.
    const gone = removed && family === "js" ? x.modules.get(seed.file) : undefined;
    const escaped = reach.find((r) => r.why === "module") ?? gone;
    // The build keeps only the first place each module escapes at.
    if (escaped) why(`its module is used as a value at ${at(escaped)}, so a call by a computed name may reach anything it exports`, null);
    // Code built at run time may pass the function to any code (`eval("run(f)")`),
    // so the call may run anywhere, not only where that code is.
    const evaluated = reach.find((r) => r.why === "eval");
    if (evaluated) why(`${at(evaluated)} runs code by a name built at run time, and it can see this function`, null);
    const global = reach.find((r) => r.why === "global");
    if (global) why(`${at(global)} reaches the global scope by a name built at run time, and it can see this function`, null);
    const any = x.loadAny[0];
    if (any && family === "js" && (x.offered.has(seed.id) || removed)) {
      const more = x.loadAny.length > 1 ? ` (and ${x.loadAny.length - 1} more ${x.loadAny.length === 2 ? "place" : "places"})` : "";
      why(any.why === "load" ? `a module loaded by a computed path at ${at(any)}${more} may be any module of the repository` : `code built at run time at ${at(any)}${more} can load any module of the repository`, null);
    }
    // A family with no checklist of its own (all but TypeScript and
    // JavaScript) keeps the rule it had, for its methods too: its reader
    // does not record every way a name escapes (a Rails `before_action
    // :name`), so only a call through a value in the project clears it.
    // A file the reader cannot vouch for that can reach the function:
    // anything there may call it by a path the graph does not see.
    const dark = family === "js" ? opaqueFor(graph, seed.file, project) : [];
    if (dark.length > 0) {
      // Commas between the places: the renderers join whole reasons with semicolons.
      const shown = dark.slice(0, 3).map((d) => `${at(d)} ${d.why} (its file ${d.how})`).join(", ");
      const more = dark.length > 3 ? ` and ${dark.length - 3} more` : "";
      // A file that may run code built at run time may pass it to any code.
      why(`${dark.length} ${dark.length === 1 ? "file" : "files"} the graph cannot read whole could call it by a path it does not see: ${shown}${more}`, dark.some((d) => d.any) ? null : dark);
    }
    const kept = family !== "js" && projectValues();
    const read = kind === "method" && family === "js" ? x.members.get(`js:${seed.name}`) : undefined;
    if (read) why(`${read.count} ${read.count === 1 ? "read" : "reads"} of \`.${seed.name}\` on a value of unknown type, first at ${at(read)}, may run it (a getter) or take it as a value`, null);
    const anyRead = kind === "method" && family === "js" ? x.members.get("js:*") : undefined;
    // A getter runs where it is read; a method taken by a read that passes its value on may run anywhere.
    if (anyRead) why(`${anyRead.count} ${anyRead.count === 1 ? "read" : "reads"} by a computed key on a value that is no string, number or other primitive, first at ${at(anyRead)}, may run it (a getter) or take it as a value`, anyRead.passed ? null : (anyRead.places ?? null));
    if (kind === "method" && family && !kept) {
      const values = valueCallsOf(graph, family);
      if (values) why(`${values.count} ${values.count === 1 ? "call goes" : "calls go"} through a value (a callback or a computed member) in projects that can hold its objects, first at ${at(values)}`, only(values));
    }
  }
  const unread = graph.status.notRead.filter((n) => graph.projectOf(n.file) === project);
  const notRead = unread.length;
  // A file not read, or whose calls were not resolved, may pass the function to any code too.
  if (notRead > 0) why(`${notRead} ${notRead === 1 ? "file" : "files"} of its project ${notRead === 1 ? "was" : "were"} not read`, null);
  const budgetFiles = budgetFilesOf(graph);
  const unresolved = (graph.importers.get(seed.file) ?? []).filter((e) => budgetFiles.has(e.from));
  const importersUnresolved = unresolved.length;
  if (importersUnresolved > 0) why(`the calls of ${importersUnresolved} ${importersUnresolved === 1 ? "file" : "files"} that import it were not resolved: the budget ran out`, null);
  // A manifest or tsconfig governing its folder that could not be read, when its loss can hide a call.
  for (const g of graph.model.unreadable) if (g.affects.length > 0 && (g.dir === "" || seed.file.startsWith(`${g.dir}/`))) why(g.note, null);
  if (cutAt.has(seed.id)) why("the walk was cut at it", null);
  return { reasons, places };
}

export function detectImpact(graph: Graph, change: Pick<Change, "files" | "coverage">): ImpactSummary {
  const s = graph.status;
  const symbols = new Map<string, ImpactSymbol>();
  const note = (id: string) => {
    if (symbols.has(id)) return;
    const n = graph.nodes.get(id);
    if (n) symbols.set(id, toSymbol(n));
  };
  const cuts: ImpactCut[] = [];
  const cutAt = new Set<string>();

  // Touched: the innermost symbol around each changed line, and any symbol
  // whose first line changed.
  const touched: string[] = [];
  const touchedSet = new Set<string>();
  for (const f of change.files) {
    if (f.status === "deleted") continue;
    const lines = change.coverage.get(f.path);
    const defs = graph.defsByFile.get(f.path);
    if (!lines || !defs) continue;
    for (const line of lines) {
      let inner: GraphNode | null = null;
      for (const d of defs) {
        if (line < d.startLine || line > d.endLine) continue;
        if (line === d.startLine && !touchedSet.has(d.id)) {
          touchedSet.add(d.id);
          touched.push(d.id);
        }
        if (!inner || d.endLine - d.startLine < inner.endLine - inner.startLine) inner = d;
      }
      if (inner && !touchedSet.has(inner.id)) {
        touchedSet.add(inner.id);
        touched.push(inner.id);
      }
    }
  }
  touched.forEach(note);

  // Removed: in the base version of a changed file and gone now; callers are
  // the current call sites whose evidence still points at them. A move the
  // build found stands only when no such call site is left: one that still
  // reaches the old place is broken, so the symbol reads as removed.
  const removed: string[] = [];
  let moved = 0;
  const removedEdges = new Map<string, GraphEdge[]>();
  for (const f of change.files) {
    for (const node of graph.removed.get(f.path) ?? []) {
      removed.push(node.id);
      const edges = callersOfRemoved(graph, node, f.path);
      const symbol = toSymbol(node);
      if (edges.length > 0) {
        removedEdges.set(node.id, edges);
        delete symbol.movedTo;
      } else if (node.movedTo) moved++;
      symbols.set(node.id, symbol);
    }
  }

  // Callers: two hops back over calls, inheritance and implementation;
  // certain and likely first, then possible. Each cut says what it left out.
  const callers: ImpactPath[] = [];
  const possible: ImpactPath[] = [];
  const addPath = (seed: string, edges: GraphEdge[]) => {
    const path = { seed, edges: edges.map(toImpactEdge) as ImpactPath["edges"] };
    (edges.some((e) => e.tier === "possible") ? possible : callers).push(path);
  };
  const hubs: ImpactSummary["hubs"] = [];
  const reached = new Set<string>([...touched, ...removed]);
  let walkCut = false;
  let walkFrontier = 0;
  const incoming = (id: string): GraphEdge[] => removedEdges.get(id) ?? graph.in.get(id) ?? [];
  const seedFile = (id: string) => symbols.get(id)?.file ?? graph.nodes.get(id)?.file ?? "";

  // The hub rule holds per group: a widely implemented interface floods
  // the possible callers, never the certain ones.
  const firstLists = new Map<string, { sure: GraphEdge[]; possible: GraphEdge[] }>();
  for (const seed of [...touched, ...removed]) {
    const all = incoming(seed).filter((e) => e.from !== seed);
    const lists = { sure: all.filter((e) => e.tier !== "possible"), possible: all.filter((e) => e.tier === "possible") };
    for (const group of ["sure", "possible"] as const) {
      const edges = [...lists[group]].sort(byCloseness(seedFile(seed)));
      if (edges.length > HUB_CALLERS) {
        if (group === "sure") {
          const sites = edges.reduce((n, e) => n + e.sites.length, 0);
          const files = new Set(edges.flatMap((e) => e.sites.map((x) => x.file))).size;
          hubs.push({ symbol: seed, callers: edges.length, sites, files });
        }
        const what = group === "sure" ? `a hub with ${edges.length} callers` : `${edges.length} possible callers (through an interface, a base type or a function value)`;
        cuts.push({ by: "hub", at: seed, omitted: edges.length - HUB_SHOWN, exact: true, unit: "callers", note: `${what}; the ${HUB_SHOWN} nearest are listed` });
        cutAt.add(seed);
        lists[group] = edges.slice(0, HUB_SHOWN);
      } else lists[group] = edges;
    }
    firstLists.set(seed, lists);
  }
  const firstHop: { seed: string; edge: GraphEdge }[] = [];
  for (const group of ["sure", "possible"] as const) {
    for (const [seed, lists] of firstLists) {
      const edges = lists[group];
      for (const [i, edge] of edges.entries()) {
        if (reached.size >= WALK_LIMIT && !reached.has(edge.from)) {
          walkCut = true;
          walkFrontier += edges.length - i;
          cutAt.add(seed);
          break;
        }
        reached.add(edge.from);
        note(edge.from);
        firstHop.push({ seed, edge });
        addPath(seed, [edge]);
      }
    }
  }
  for (const { seed, edge } of firstHop) {
    if (walkCut) break;
    if (graph.nodes.get(edge.from)?.kind === "file") continue; // a file's top level has no callers
    const all = incoming(edge.from).filter((e) => !reached.has(e.from));
    const next = all.sort(byCloseness(seedFile(edge.from))).slice(0, HUB_SHOWN);
    if (all.length > next.length) {
      cuts.push({ by: "second-hop", at: edge.from, omitted: all.length - next.length, exact: true, unit: "callers", note: `the second hop keeps ${HUB_SHOWN} callers of each caller` });
      cutAt.add(seed);
    }
    for (const [i, e2] of next.entries()) {
      if (reached.size >= WALK_LIMIT) {
        walkCut = true;
        walkFrontier += next.length - i;
        cutAt.add(seed);
        break;
      }
      reached.add(e2.from);
      note(e2.from);
      addPath(seed, [edge, e2]);
    }
  }
  // Past the walk limit what lies beyond the frontier cannot be counted.
  if (walkCut) cuts.push({ by: "walk-limit", at: null, omitted: null, exact: false, unit: "callers", note: `the walk stopped at ${WALK_LIMIT} symbols with at least ${walkFrontier} more callers waiting; what lies past them is not counted` });

  // Callees: one hop out of the touched code.
  const callees: ImpactPath[] = [];
  for (const seed of touched) {
    for (const e of graph.out.get(seed) ?? []) {
      if (touchedSet.has(e.to)) continue;
      note(e.to);
      callees.push({ seed, edges: [toImpactEdge(e)] });
    }
  }

  // Importers of each changed file; for Go, of its package from other folders.
  const importers: ImpactEdge[] = [];
  const seenImporter = new Set<string>();
  for (const f of change.files) {
    const dir = dirname(f.path) === "." ? "" : dirname(f.path);
    for (const e of [...(graph.importers.get(f.path) ?? []), ...(f.path.endsWith(".go") ? (graph.importers.get(`go:${dir}`) ?? []) : [])]) {
      const key = `${e.from}\0${e.to}`;
      if (seenImporter.has(key)) continue;
      seenImporter.add(key);
      importers.push(toImpactEdge(e));
      note(e.from);
    }
  }

  // Nearest first across all seeds: one hop before two, production before tests.
  const rank = (p: ImpactPath) => {
    const last = p.edges[p.edges.length - 1] as ImpactEdge;
    return p.edges.length * 2 + Number(isTestPath(last.sites[0]?.file ?? last.from));
  };
  callers.sort((a, b) => rank(a) - rank(b));
  possible.sort((a, b) => rank(a) - rank(b));

  const callerIds = new Set(callers.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const possibleIds = new Set(possible.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const removedStillCalled = removed.some((id) => removedEdges.has(id));
  const sitesOf = (paths: ImpactPath[]) => paths.reduce((n, p) => n + (p.edges[p.edges.length - 1] as ImpactEdge).sites.length, 0);
  const totalSites = sitesOf(callers);
  const possibleSites = sitesOf(possible);
  if (totalSites > INLINE_SITES) cuts.push({ by: "inline", at: null, omitted: totalSites - INLINE_SITES, exact: true, unit: "sites", note: `the brief shows ${INLINE_SITES} certain and likely call sites; the packet holds every one` });
  if (possibleSites > INLINE_POSSIBLE) cuts.push({ by: "inline", at: null, omitted: possibleSites - INLINE_POSSIBLE, exact: true, unit: "sites", note: `the brief shows ${INLINE_POSSIBLE} possible call sites; the packet holds every one` });

  // Other uses of each seed, one hop: as a value, as a type, implemented
  // or overridden. The summary keeps the first ones of each kind.
  const references: NonNullable<ImpactSummary["references"]> = [];
  for (const seed of [...touched, ...removed]) {
    const kinds = new Map<string, GraphEdge[]>();
    for (const e of graph.refsIn.get(seed) ?? []) {
      if (e.from === seed) continue;
      const list = kinds.get(e.kind);
      if (list) list.push(e);
      else kinds.set(e.kind, [e]);
    }
    for (const [kind, edges] of kinds) {
      const sorted = [...edges].sort(byCloseness(seedFile(seed)));
      if (sorted.length > REFERENCES_KEPT) cuts.push({ by: "references", at: seed, omitted: sorted.length - REFERENCES_KEPT, exact: true, unit: "symbols", note: `the summary keeps the first ${REFERENCES_KEPT} symbols with a ${kind} edge into it; the packet holds every one` });
      for (const e of sorted.slice(0, REFERENCES_KEPT)) {
        note(e.from);
        references.push({ seed, edge: toImpactEdge(e) });
      }
    }
  }

  // A call that may run more implementations of a seed's name than the
  // graph lists: the seed may be among those left out.
  for (const seed of [...touched, ...removed]) {
    const sym = symbols.get(seed);
    if (!sym || sym.kind !== "method") continue;
    let named = 0;
    for (const d of dispatchNamed(graph, sym.name)) {
      if (d.total <= d.candidates.length || d.declared.includes(seed) || d.candidates.includes(seed)) continue;
      if (++named > FAN_OUT_CUTS) break;
      const omitted = d.total - d.candidates.length;
      cuts.push({ by: "fan-out", at: `${d.file}:${d.line}`, omitted, exact: true, unit: "symbols", note: `a call to ${d.name} at ${d.file}:${d.line} may run ${d.total} implementations or overrides; the ${omitted} past the first ${d.candidates.length} are not listed, and \`${sym.name}\` at ${sym.file}:${sym.startLine} may be one of them` });
      cutAt.add(seed);
    }
  }

  // What the graph could not see, per seed and near the change.
  const seeds = [...touched, ...removed].map((id) => {
    const sym = symbols.get(id);
    const reasons = sym ? floorReasons(graph, { id, name: sym.name, file: sym.file, kind: sym.kind }, cutAt) : ["the symbol is not in the graph"];
    return { seed: id, floor: reasons.length > 0, reasons };
  });
  const nearFiles = new Set<string>([...change.files.map((f) => f.path), ...[...callers, ...possible].flatMap((p) => p.edges.flatMap((e) => e.sites.map((x) => x.file)))]);
  const near = graph.unknowns.filter((u) => nearFiles.has(u.file));
  const causes: Record<string, number | null> = {};
  for (const u of near) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
  // The graph keeps every consumer of a changed public name; the summary
  // keeps the first SUMMARY_CONSUMERS of each and records the cut.
  const brokenConsumers = graph.exportChanges.reduce((n, e) => n + e.consumers.filter((c) => c.now === "broken" || c.now === "retargeted").length, 0);
  const exports = graph.exportChanges.map((e) => {
    if (e.consumers.length <= SUMMARY_CONSUMERS) return e;
    cuts.push({ by: "consumers", at: e.file, omitted: e.consumers.length - SUMMARY_CONSUMERS, exact: true, unit: "sites", note: `the summary keeps the first ${SUMMARY_CONSUMERS} consumers of \`${e.name}\`` });
    return { ...e, consumers: e.consumers.slice(0, SUMMARY_CONSUMERS) };
  });

  // What the framework plugins say about the touched code (frameworks/impact.ts).
  const frameworks = frameworkImpact(graph, change, touched, removed);

  return {
    version: 2,
    status: s.status,
    reasons: s.reasons,
    // A move is no change of its own: the lines added at the new place make its new definition a touched symbol.
    // A route the change left without its handler is broken like a removed symbol still called.
    risk: riskFor(touched.length + removed.length - moved + exports.length, callerIds.size, possibleIds.size, removedStillCalled || (frameworks?.routes.some((r) => r.status === "missing") ?? false), brokenConsumers),
    build: {
      durationMs: s.durationMs,
      cacheHits: s.cacheHits,
      parses: s.parses,
      eligibleFiles: s.eligibleFiles,
      parsedFiles: s.filesParsed,
      omittedFiles: s.filesSkipped,
      unresolvedSites: s.unresolvedSites,
      externalSites: s.externalSites,
      mode: s.mode,
      generation: s.generation,
    },
    symbols: [...symbols.values()],
    touched,
    removed,
    callers,
    possible,
    references,
    callees,
    importers,
    hubs,
    exports,
    unknown: {
      floor: seeds.some((x) => x.floor) || s.status === "partial",
      seeds,
      causes,
      near: near.slice(0, NEAR_SHOWN).map(toImpactUnknown),
      nearTotal: near.length,
      notRead: s.notRead.slice(0, NEAR_SHOWN),
      notReadTotal: s.notRead.length,
    },
    cuts: [...s.cuts, ...cuts],
    truncated: {
      walk: walkCut || cuts.some((c) => c.by === "hub"),
      inline: totalSites > INLINE_SITES || possibleSites > INLINE_POSSIBLE,
      omittedSites: totalSites > INLINE_SITES || possibleSites > INLINE_POSSIBLE ? Math.max(0, totalSites - INLINE_SITES) + Math.max(0, possibleSites - INLINE_POSSIBLE) : null,
    },
    packet: null,
    ...(frameworks ? { frameworks } : {}),
  };
}

// The most called symbols, for a review of the whole repo.
export function hotSymbols(graph: Graph, n: number): HotSymbol[] {
  const out: HotSymbol[] = [];
  for (const [id, edges] of graph.in) {
    const symbol = graph.nodes.get(id);
    if (!symbol || symbol.kind === "file") continue;
    const callers = new Set(edges.map((e) => e.from)).size;
    const sites = edges.reduce((k, e) => k + e.sites.length, 0);
    const files = new Set(edges.flatMap((e) => e.sites.map((x) => x.file))).size;
    out.push({ symbol, callers, sites, files });
  }
  return out.sort((a, b) => b.callers - a.callers || b.sites - a.sites || a.symbol.id.localeCompare(b.symbol.id)).slice(0, n);
}

export type { UnknownSite };
