// The questions of phase 3 that read relations beyond one symbol's direct
// edges: what implements or overrides it, who uses it as a value, how two
// points are connected, what a change reaches, what a file or folder
// holds, which packages depend on a package, and which import cycles exist.
//
// Each reads the graph through its public shape only (nodes, edges, the
// importers index, the unknown records, the project of a file); none
// binds anything the resolver did not bind. A relation this build does not
// produce is a capability boundary, never an empty success. Each is a job
// (answer.ts) that checks the question's budget at every element it
// touches and goes on where the budget stopped it.
import { LineSet } from "@openqodex/core";
import { detectImpact, toImpactUnknown } from "../impact.js";
import type { Tier } from "../model/records.js";
import { weakest } from "../model/records.js";
import { familyOf } from "../types.js";
import type { Family, Graph, GraphEdge, GraphNode, GraphSite, UnknownSite } from "../types.js";
import { candidate, counts, empty, fail, isAnswer, listing, Point, qualified, stoppedAt } from "./answer.js";
import type { Answer, Extra, Job, Request, Session } from "./answer.js";
import { edgeId } from "./ids.js";
import { byItem, Cycles, importCount, importEdges, importsFrom, Pass, PathSearch, RANK, sortWithin, spent, toItem, Walk } from "./traverse.js";
import type { Budget, Item } from "./traverse.js";

// The relations the resolver of this build produces. A later phase that
// adds a relation adds it here; a relation found on an edge of the graph
// counts as produced too. Phase 2 resolves calls through interfaces and
// base types (implements, dispatches_to, overrides) and uses of a symbol
// as a value or a type (may_invoke, uses_value, uses_type) on every build,
// so a repository with none of them answers an empty list, not a boundary.
export const RESOLVED_RELATIONS = ["calls", "inherits", "implements", "dispatches_to", "may_invoke", "overrides", "uses_value", "uses_type", "imports"] as const;
const REFERENCE_KINDS = ["uses_value", "uses_type", "reads", "writes", "may_invoke", "decorates"];
const KNOWN_KINDS = new Set<string>([...RESOLVED_RELATIONS, ...REFERENCE_KINDS]);

const produced = new WeakMap<Graph, Set<string>>();
export function relationsOf(g: Graph): Set<string> {
  let set = produced.get(g);
  if (!set) {
    set = new Set<string>(RESOLVED_RELATIONS);
    for (const e of g.edges) set.add(e.kind);
    for (const e of g.references) set.add(e.kind);
    produced.set(g, set);
  }
  return set;
}

const ALL_TIERS = new Set<Tier>(["certain", "likely", "possible"]);

// Files of a project the graph did not read.
function notReadIn(g: Graph, project: string): number {
  return g.status.notRead.filter((n) => g.projectOf(n.file) === project).length;
}

function withFloor(base: Answer, reasons: string[], causes: Record<string, number | null> = {}): Answer["unknown"] {
  const all = [...reasons, ...base.unknown.reasons];
  return { floor: all.length > 0 || base.unknown.floor, reasons: all, causes: { ...base.unknown.causes, ...causes }, examples: base.unknown.examples };
}

// ---------- implementers ----------

export type Override = Item & { premises: string[] };

// The class a method belongs to: the definition in the same file whose
// qualified name is the method's owner path.
function ownerClass(g: Graph, m: GraphNode): GraphNode | null {
  const q = qualified(m);
  const dot = q.lastIndexOf(".");
  if (dot === -1) return null;
  const owner = q.slice(0, dot);
  return (g.defsByFile.get(m.file) ?? []).find((d) => (d.kind === "class" || d.kind === "type" || d.kind === "module") && qualified(d) === owner) ?? null;
}

// The methods of the graph by file and qualified name, built once per graph
// when a session opens it (open.ts), so no question pays for it.
const methodIndex = new WeakMap<Graph, Map<string, GraphNode[]>>();
export function methodsNamed(g: Graph, file: string, qualifiedName: string): GraphNode[] {
  let ix = methodIndex.get(g);
  if (!ix) {
    ix = new Map();
    for (const list of g.defsByFile.values()) {
      for (const d of list) {
        if (d.kind !== "method") continue;
        const key = `${d.file}\0${qualified(d)}`;
        (ix.get(key) ?? ix.set(key, []).get(key))?.push(d);
      }
    }
    methodIndex.set(g, ix);
  }
  return ix.get(`${file}\0${qualifiedName}`) ?? [];
}

// Overrides of a method found from the inheritance the graph resolved: a
// method of the same name on a class that inherits the owner, directly or
// through others. The inheritance is proved; the override rests on the
// name and on a lookup order the graph does not resolve, so it is likely
// at most and names the inheritance it rests on. Each step (the walk, each
// inheritance edge read, each subclass looked at, the sort) checks the
// budget and goes on where it stopped. Run it until it returns true.
export class Overrides {
  items: Override[] = [];
  private readonly owner: GraphNode | null;
  private readonly walk: Walk | null;
  private phase: "walk" | "chains" | "derive" | "sort" | "done" = "walk";
  // The inheritance chain of each subclass back to the owner, strongest site per hop.
  private readonly up = new Map<string, Item>();
  private read = 0;
  private subclasses: Iterator<[string, Item]> | null = null;
  private readonly out: Override[] = [];
  constructor(
    private readonly g: Graph,
    private readonly m: GraphNode,
    depth: number,
    private readonly tiers: ReadonlySet<Tier>,
  ) {
    this.owner = ownerClass(g, m);
    this.walk = this.owner ? new Walk(g, this.owner.id, "in", depth, ALL_TIERS, new Set(["inherits"])) : null;
  }

  pending(): string[] {
    return this.walk?.pending() ?? [];
  }

  // Subclasses at the depth asked with more inheriting from them: an
  // override past them is not looked for.
  get past(): string[] {
    return this.walk?.past ?? [];
  }

  run(budget: Budget): boolean {
    if (!this.walk || !this.owner) {
      this.phase = "done";
      return true;
    }
    const g = this.g;
    const owner = this.owner;
    if (this.phase === "walk") {
      if (!this.walk.run(budget)) return false;
      this.phase = "chains";
    }
    if (this.phase === "chains") {
      const items = this.walk.items;
      while (this.read < items.length) {
        if (spent(budget)) return false;
        const i = items[this.read++] as Item;
        const have = this.up.get(i.from);
        if (!have || i.depth < have.depth || (i.depth === have.depth && RANK[i.site.tier] < RANK[have.site.tier])) this.up.set(i.from, i);
      }
      this.subclasses = this.up.entries();
      this.phase = "derive";
    }
    if (this.phase === "derive") {
      const subclasses = this.subclasses as Iterator<[string, Item]>;
      for (;;) {
        if (spent(budget)) return false;
        const r = subclasses.next();
        if (r.done) break;
        const [sub, link] = r.value;
        const cls = g.nodes.get(sub);
        if (!cls) continue;
        const own = methodsNamed(g, cls.file, `${qualified(cls)}.${this.m.name}`);
        if (own.length === 0) continue;
        const premises: string[] = [];
        let tier: Tier = "likely";
        let at: Item | undefined = link;
        for (let guard = 0; at && guard < 64; guard++) {
          premises.push(at.edge);
          tier = weakest(tier, at.site.tier);
          at = at.to === owner.id ? undefined : this.up.get(at.to);
        }
        if (!this.tiers.has(tier)) continue;
        for (const d of own) {
          const site: GraphSite = {
            file: d.file,
            line: d.startLine,
            column: 0,
            tier,
            evidence: "override-by-name",
            via: { file: link.site.file, line: link.site.line, spec: null },
            note: `a method of the same name on a class that inherits ${qualified(owner)} (${link.site.file}:${link.site.line}); method lookup order is not resolved`,
            rule: "query-override-by-name",
          };
          const e = { from: d.id, to: this.m.id, kind: "overrides" };
          this.out.push({ ...toItem(g, e, site, link.depth), edge: edgeId(e, site), premises });
        }
      }
      this.phase = "sort";
    }
    if (this.phase === "sort") {
      if (!sortWithin(this.out, byItem, budget)) return false;
      this.items = this.out;
      this.phase = "done";
    }
    return true;
  }
}

// The classes that name a base with an expression (a call such as a mixin,
// a conditional): the facts keep a base only when it is a name, so such a
// class is tied to no base, and the resolver records a dynamic-base gap on
// it. What it extends is not known, so it may be missing under any class
// of its language. By language family, built once per graph when a
// session opens it (open.ts), so no question pays for it.
const dynamicBaseIndex = new WeakMap<Graph, Map<Family, UnknownSite[]>>();
export function dynamicBases(g: Graph, family: Family): UnknownSite[] {
  let ix = dynamicBaseIndex.get(g);
  if (!ix) {
    ix = new Map();
    for (const u of g.unknowns) {
      if (u.cause !== "dynamic-base") continue;
      const lang = g.nodes.get(u.caller)?.lang ?? null;
      if (lang === null) continue;
      const f = familyOf(lang);
      (ix.get(f) ?? ix.set(f, []).get(f))?.push(u);
    }
    dynamicBaseIndex.set(g, ix);
  }
  return ix.get(family) ?? [];
}

export function implementers(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job {
  const g = s.graph;
  const point = new Point(g, req.target);
  const rel = relationsOf(g);
  const depth = Math.min(Math.max(1, req.depth ?? 3), 8);
  let n: GraphNode | null = null;
  let walk: Walk | null = null;
  let derive: Overrides | null = null;
  return (budget) => {
    const base = empty(s, "implementers");
    if (!n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, "implementers");
      if (isAnswer(o)) return o;
      if (o.kind !== "class" && o.kind !== "type" && o.kind !== "method" && o.kind !== "module") {
        return fail(s, "implementers", "bad-request", `implementers takes a class, an interface, a type or a method; ${o.name} is a ${o.kind}`);
      }
      n = o;
      if (n.kind === "method" && !rel.has("overrides")) derive = new Overrides(g, n, depth, tiers);
      else walk = new Walk(g, n.id, "in", depth, tiers, n.kind === "method" ? new Set(["overrides"]) : new Set(["inherits", ...(rel.has("implements") ? ["implements"] : [])]));
    }
    const target = candidate(g, n, 1);
    const reasons: string[] = [];
    const causes: Record<string, number | null> = {};
    let items: Item[];
    let beyond: string[] = [];
    if (derive) {
      if (!derive.run(budget)) return stoppedAt({ ...base, target }, [], derive.pending(), derive.pending().length);
      items = derive.items;
      beyond = derive.past;
    } else {
      const w = walk as Walk;
      if (!w.run(budget)) return stoppedAt({ ...base, target }, w.items, w.pending(), w.pending().length);
      items = w.items;
      beyond = w.past;
    }
    if (n.kind === "method" && !rel.has("dispatches_to")) {
      reasons.push("calls through an interface or a base type are not resolved in this build, so a method that implements an interface method is not listed here");
      causes["unsupported-rule"] = null;
    }
    const hidden = n.lang !== null ? dynamicBases(g, familyOf(n.lang)) : [];
    const first = hidden[0];
    if (first) {
      const cls = g.nodes.get(first.caller);
      const example = `${cls ? qualified(cls) : first.caller} at ${first.file}:${first.line}`;
      reasons.push(`${hidden.length} ${hidden.length === 1 ? "class names" : "classes name"} a base with an expression the graph does not read (a call such as a mixin, or a conditional), such as ${example}; a class declared that way is not listed, and may extend this one`);
      causes["dynamic-base"] = hidden.length;
    }
    if (n.kind === "type" && !rel.has("implements")) {
      reasons.push("this build does not read `implements` clauses or Go method sets, so the classes that implement it are not listed");
      causes["unsupported-rule"] = null;
    }
    // TypeScript matches an interface or an object type by its shape: a
    // class or an object that has its members implements it without saying
    // so, and the graph lists only the ones that declare it.
    const shape = n.kind === "type" ? n : n.kind === "method" ? ownerClass(g, n) : null;
    if (shape?.kind === "type" && shape.lang !== null && familyOf(shape.lang) === "js") {
      reasons.push(`TypeScript matches ${qualified(shape)} by its shape, so a class or an object that has its members without declaring it is not listed`);
      causes["unsupported-rule"] = null;
    }
    const skipped = notReadIn(g, g.projectOf(n.file));
    if (skipped > 0) reasons.push(`${skipped} ${skipped === 1 ? "file" : "files"} of its project ${skipped === 1 ? "was" : "were"} not read`);
    const unknown = withFloor(base, reasons, causes);
    if (hidden.length > 0) unknown.examples = hidden.slice(0, 5).map(toImpactUnknown);
    return listing({ ...base, target, counts: counts(items), unknown }, items, { beyond: beyond.length > 0 ? { frontier: beyond } : null });
  };
}

// ---------- references ----------

export function references(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job | Answer {
  const g = s.graph;
  const rel = relationsOf(g);
  const kinds = REFERENCE_KINDS.filter((k) => rel.has(k));
  if (kinds.length === 0) {
    return fail(s, "references", "unsupported", "this build does not resolve uses of a symbol as a value or a type; `callers` lists the calls, and `unknowns` the calls through values it could not bind");
  }
  const point = new Point(g, req.target);
  let n: GraphNode | null = null;
  let walk: Walk | null = null;
  return (budget) => {
    const base = empty(s, "references");
    if (!n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, "references");
      if (isAnswer(o)) return o;
      n = o;
      walk = new Walk(g, n.id, "in", 1, tiers, new Set(kinds));
    }
    const w = walk as Walk;
    const target = candidate(g, n, 1);
    if (!w.run(budget)) return stoppedAt({ ...base, target }, w.items, w.pending(), w.pending().length);
    const reasons: string[] = [];
    const skipped = notReadIn(g, g.projectOf(n.file));
    if (skipped > 0) reasons.push(`${skipped} ${skipped === 1 ? "file" : "files"} of its project ${skipped === 1 ? "was" : "were"} not read`);
    return listing({ ...base, target, counts: counts(w.items), unknown: withFloor(base, reasons) }, w.items);
  };
}

// ---------- path ----------

export const PATH_DEPTH = 8;

export function path(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job | Answer {
  const g = s.graph;
  if (!req.to) return fail(s, "path", "bad-request", "path needs a second point: `to`");
  const kinds = req.edges && req.edges.length > 0 ? req.edges : ["calls", "inherits"];
  const unknownKind = kinds.find((k) => !KNOWN_KINDS.has(k));
  if (unknownKind) return fail(s, "path", "bad-request", `no relation named ${unknownKind}`);
  const rel = relationsOf(g);
  const missing = kinds.find((k) => !rel.has(k));
  if (missing) return fail(s, "path", "unsupported", `this build does not resolve ${missing} edges`);
  const set = new Set(kinds);
  // Imports join files: a symbol stands for its file when only imports are walked.
  const onlyImports = kinds.every((k) => k === "imports");
  const depth = Math.min(Math.max(1, req.depth ?? PATH_DEPTH), PATH_DEPTH);
  const pa = new Point(g, req.target);
  const pb = new Point(g, req.to);
  let ends: [GraphNode, GraphNode] | null = null;
  let fwd: PathSearch | null = null;
  let rev: PathSearch | null = null;
  return (budget) => {
    const base = empty(s, "path");
    if (!ends) {
      if (!pa.run(budget) || !pb.run(budget)) return stoppedAt(base, [], [], null);
      const a = pa.outcome(s, "path");
      if (isAnswer(a)) return a;
      const b = pb.outcome(s, "path");
      if (isAnswer(b)) return b;
      ends = [a, b];
    }
    const [a, b] = ends;
    const from = onlyImports ? a.file : a.id;
    const to = onlyImports ? b.file : b.id;
    const target = [candidate(g, a, 1), candidate(g, b, 1)];
    if (from === to) return listing({ ...base, target, counts: { certain: 0, likely: 0, possible: 0 } }, []);
    fwd ??= new PathSearch(g, from, to, set, depth, tiers);
    if (!fwd.run(budget)) return stoppedAt({ ...base, target }, [], fwd.pending(), fwd.pending().length);
    let hops = fwd.hops;
    let direction: "forward" | "reverse" = "forward";
    if (!hops) {
      rev ??= new PathSearch(g, to, from, set, depth, tiers);
      if (!rev.run(budget)) return stoppedAt({ ...base, target }, [], rev.pending(), rev.pending().length);
      if (rev.hops) {
        hops = rev.hops;
        direction = "reverse";
      }
    }
    if (hops) {
      const items = hops.map((h) => ({ ...h, direction }));
      return listing({ ...base, target, counts: counts(items) }, items);
    }
    // No path among the known edges: a floor when an unbound call in the code
    // the search visited, a file not read, or the depth could hide one.
    const visited = new Set([...fwd.visited, ...(rev?.visited ?? [])]);
    const unbound = g.unknowns.filter((u) => u.cause !== "external" && visited.has(u.caller));
    const reasons: string[] = [];
    const causes: Record<string, number | null> = {};
    for (const u of unbound) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
    if (unbound.length > 0) reasons.push(`${unbound.length} ${unbound.length === 1 ? "call" : "calls"} in the code the search visited could not be bound, and could lead from one to the other`);
    if (g.status.notRead.length > 0) reasons.push(`${g.status.notRead.length} ${g.status.notRead.length === 1 ? "file was" : "files were"} not read`);
    const unknown = withFloor(base, reasons, causes);
    unknown.examples = unbound.slice(0, 5).map(toImpactUnknown);
    const beyond = fwd.beyond || rev?.beyond === true;
    return listing({ ...base, target, counts: { certain: 0, likely: 0, possible: 0 }, unknown }, [], { beyond: beyond ? { frontier: [...fwd.pending(), ...(rev?.pending() ?? [])] } : null });
  };
}

// ---------- impact ----------

// The review's own walk (impact.ts), seeded by the diff the caller passes
// or by one symbol as if its first line changed. Items: each caller path
// with its hops, each possible caller path (a step through an interface, a
// base type or a function value) apart, each use that is not a call (as a
// value, as a type, an implementation or an override), each callee, each
// importer of a changed file, each changed public name. The walk is bounded by its own limits (200 symbols, 20
// callers a hop), so it runs whole once its point is found. Each changed
// public name comes from the graph with every place that used it, never
// from the summary, which keeps the first 200 for the brief; the cuts the
// walk made in what it lists are said as the floor's reasons.
const LISTED_CUTS = new Set(["hub", "second-hop", "walk-limit", "export-walk"]);
export function impact(s: Session, req: Request, extra: Extra): Job | Answer {
  const g = s.graph;
  const bySymbol = req.target !== undefined && (req.target.id !== undefined || req.target.name !== undefined || req.target.file !== undefined);
  if (!bySymbol && !extra.change) return fail(s, "impact", "bad-request", "impact needs a symbol, or a change compared with its base (`openqodex graph impact` with no symbol)");
  const point = bySymbol ? new Point(g, req.target) : null;
  return (budget) => {
    const base = empty(s, "impact");
    let change = extra.change;
    let target: Answer["target"] = null;
    if (point) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const n = point.outcome(s, "impact");
      if (isAnswer(n)) return n;
      target = candidate(g, n, 1);
      change = { files: [{ path: n.file, status: "modified", oldPath: null, binary: false }], coverage: new Map([[n.file, new LineSet().add(n.startLine)]]) };
    }
    if (spent(budget)) return stoppedAt(base, [], [], null);
    const sum = detectImpact(g, change as NonNullable<typeof change>);
    const hop = (e: { from: string; to: string; kind: string; sites: GraphSite[] }, depth: number): Item => toItem(g, e, e.sites[0] as GraphSite, depth);
    const all: unknown[] = [
      ...sum.callers.map((p) => ({ type: "caller", seed: p.seed, hops: p.edges.map((e, i) => hop(e, i + 1)) })),
      ...(sum.possible ?? []).map((p) => ({ type: "possible-caller", seed: p.seed, hops: p.edges.map((e, i) => hop(e, i + 1)) })),
      // Every use of each touched and removed symbol, from the graph: the
      // summary keeps the first 200 of each kind for the brief.
      ...[...sum.touched, ...sum.removed].flatMap((seed) => (g.refsIn.get(seed) ?? []).filter((e) => e.from !== seed).map((e) => ({ type: "reference", seed, hops: [hop(e, 1)] }))),
      ...sum.callees.map((p) => ({ type: "callee", seed: p.seed, hops: p.edges.map((e, i) => hop(e, i + 1)) })),
      ...sum.importers.map((e) => ({ type: "importer", hops: [hop(e, 1)] })),
      ...g.exportChanges.map((e) => ({ type: "export", ...e })),
    ];
    const cutNotes = [...new Set(sum.cuts.filter((c) => LISTED_CUTS.has(c.by)).map((c) => c.note))];
    const lastSites = [...sum.callers, ...(sum.possible ?? [])].map((c) => c.edges[c.edges.length - 1]?.sites[0]).filter((x): x is GraphSite => x !== undefined);
    return listing(
      {
        ...base,
        target: target ?? sum.symbols.filter((x) => sum.touched.includes(x.id) || sum.removed.includes(x.id)).map((x) => ({ id: x.id, name: x.name, kind: x.kind, file: x.file, line: x.startLine, project: g.projectOf(x.file), score: 1 })),
        counts: counts(lastSites.map((site) => ({ site }))),
        unknown: {
          floor: sum.unknown.floor || cutNotes.length > 0,
          reasons: [...new Set([...sum.unknown.seeds.flatMap((x) => x.reasons), ...cutNotes, ...(sum.status === "partial" ? sum.reasons : [])])],
          causes: sum.unknown.causes,
          examples: sum.unknown.near.slice(0, 5),
        },
      },
      all,
    );
  };
}

// ---------- outline ----------

export function outline(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const at = (req.target?.file ?? "").replace(/\/+$/, "");
  if (at === "") return fail(s, "outline", "bad-request", "outline takes a file or a folder of the repository");
  const keys = g.defsByFile.keys();
  const files: string[] = [];
  let scanning = !g.defsByFile.has(at);
  if (!scanning) files.push(at);
  let left = g.defsByFile.size;
  const all: unknown[] = [];
  // Where the listing stands, kept across runs: the files sorted, the file
  // being read, its definitions sorted, the next one of them.
  let sorted = false;
  let file = 0;
  let defs: GraphNode[] | null = null;
  let defsSorted = false;
  let def = 0;
  const sites = (list: GraphEdge[] | undefined) => (list ?? []).reduce((k, e) => k + e.sites.length, 0);
  return (budget) => {
    const base = empty(s, "outline");
    while (scanning) {
      if (spent(budget)) return stoppedAt(base, [], [], left);
      const r = keys.next();
      if (r.done) {
        scanning = false;
        break;
      }
      left--;
      if (r.value.startsWith(`${at}/`)) files.push(r.value);
    }
    if (files.length === 0) return fail(s, "outline", "not-found", `no file of the graph is ${at} or under it`);
    if (!sorted) {
      if (!sortWithin(files, byText, budget)) return stoppedAt(base, all, [], files.length - file);
      sorted = true;
    }
    while (file < files.length) {
      if (defs === null) {
        if (spent(budget)) return stoppedAt(base, all, [], files.length - file);
        defs = (g.defsByFile.get(files[file] as string) ?? []).slice();
        defsSorted = false;
        def = 0;
      }
      if (!defsSorted) {
        if (!sortWithin(defs, (x, y) => x.startLine - y.startLine, budget)) return stoppedAt(base, all, [], files.length - file);
        defsSorted = true;
      }
      while (def < defs.length) {
        if (spent(budget)) return stoppedAt(base, all, [], files.length - file);
        const d = defs[def++] as GraphNode;
        all.push({ id: d.id, name: d.name, qualified: qualified(d), kind: d.kind, file: d.file, line: d.startLine, endLine: d.endLine, exported: d.exported, callerSites: sites(g.in.get(d.id)), calleeSites: sites(g.out.get(d.id)) });
      }
      defs = null;
      file++;
    }
    const notRead = g.status.notRead.filter((n) => n.file === at || n.file.startsWith(`${at}/`));
    const reasons = notRead.length > 0 ? [`${notRead.length} ${notRead.length === 1 ? "file" : "files"} here ${notRead.length === 1 ? "was" : "were"} not read: ${notRead.slice(0, 5).map((n) => `${n.file} (${n.reason})`).join(", ")}`] : [];
    return listing({ ...base, unknown: withFloor(base, reasons) }, all);
  };
}

// ---------- packages and cycles ----------

type Dependency = { from: string; to: string; edges: GraphEdge[] };

// Import edges between files of two different projects, by project pair,
// gathered edge by edge within the budget. A finished gathering is kept
// for the graph; an unfinished one is kept by its job.
const projectDeps = new WeakMap<Graph, Map<string, Dependency>>();
class Dependencies {
  deps = new Map<string, Dependency>();
  private readonly pass: Pass<GraphEdge> | null;
  constructor(private readonly g: Graph) {
    const kept = projectDeps.get(g);
    if (kept) {
      this.deps = kept;
      this.pass = null;
      return;
    }
    this.pass = new Pass(
      importEdges(g),
      (e) => {
        const from = g.projectOf(e.from);
        const to = e.to.startsWith("go:") ? g.projectOf(`${e.to.slice(3)}/x.go`) : g.projectOf(e.to);
        if (from === to) return;
        const key = `${from}\0${to}`;
        const d = this.deps.get(key) ?? { from, to, edges: [] };
        d.edges.push(e);
        this.deps.set(key, d);
      },
      importCount(g),
    );
  }
  get left(): number | null {
    return this.pass?.left ?? 0;
  }
  run(budget: Budget): boolean {
    if (!this.pass) return true;
    if (!this.pass.run(budget)) return false;
    projectDeps.set(this.g, this.deps);
    return true;
  }
}

// The files of each project the graph read, counted file by file, sorted
// by project. A finished count is kept for the graph.
const projectFiles = new WeakMap<Graph, { files: Map<string, number>; projects: string[] }>();
class Projects {
  files = new Map<string, number>();
  projects: string[] = [];
  private readonly pass: Pass<string> | null;
  private sorted = false;
  constructor(private readonly g: Graph) {
    const kept = projectFiles.get(g);
    if (kept) {
      ({ files: this.files, projects: this.projects } = kept);
      this.pass = null;
      return;
    }
    this.pass = new Pass(
      g.defsByFile.keys(),
      (f) => {
        const p = g.projectOf(f);
        this.files.set(p, (this.files.get(p) ?? 0) + 1);
      },
      g.defsByFile.size,
    );
  }
  get left(): number | null {
    return this.pass?.left ?? 0;
  }
  run(budget: Budget): boolean {
    if (!this.pass) return true;
    if (!this.pass.run(budget)) return false;
    if (!this.sorted) {
      if (this.projects.length === 0) this.projects = [...this.files.keys()];
      if (!sortWithin(this.projects, byText, budget)) return false;
      this.sorted = true;
      projectFiles.set(this.g, { files: this.files, projects: this.projects });
    }
    return true;
  }
}

const byText = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

const EDGES_SHOWN = 50;

function importItems(g: Graph, edges: GraphEdge[]): Item[] {
  return edges.flatMap((e) => e.sites.map((site) => toItem(g, e, site, 1))).sort(byItem);
}

function importReasons(g: Graph): string[] {
  const reasons: string[] = [];
  for (const x of g.model.unreadable) if (x.affects.includes("imports")) reasons.push(x.note);
  if (g.status.notRead.length > 0) reasons.push(`${g.status.notRead.length} ${g.status.notRead.length === 1 ? "file was" : "files were"} not read, and their imports are not here`);
  return reasons;
}

// Which projects depend on which, or the projects that depend on one. Each
// step reads one edge, file, dependency or project with the budget checked;
// the sites of one project pair are read as one step.
export function packages(s: Session, req: Request): Job {
  const g = s.graph;
  const gather = new Dependencies(g);
  const count = new Projects(g);
  const t = req.target ?? {};
  const asked = t.project ?? (t.file ? g.projectOf(t.file) : t.name);
  const dependsOn = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const mine: Dependency[] = [];
  let linking: Pass<Dependency> | null = null;
  let sorted = false;
  let building: Pass<string> | Pass<Dependency> | null = null;
  const all: unknown[] = [];
  return (budget) => {
    const base = empty(s, "packages");
    if (!gather.run(budget)) return stoppedAt(base, [], [], gather.left);
    if (!count.run(budget)) return stoppedAt(base, [], [], count.left);
    const unknown = withFloor(base, importReasons(g));
    if (asked === undefined) {
      linking ??= new Pass(
        gather.deps.values(),
        (d) => {
          (dependsOn.get(d.from) ?? dependsOn.set(d.from, []).get(d.from))?.push(d.to);
          (dependents.get(d.to) ?? dependents.set(d.to, []).get(d.to))?.push(d.from);
        },
        gather.deps.size,
      );
      if (!linking.run(budget)) return stoppedAt(base, [], [], linking.left);
      building ??= new Pass(count.projects, (p: string) => {
        all.push({ project: p, files: count.files.get(p) ?? 0, dependsOn: (dependsOn.get(p) ?? []).sort(byText), dependents: (dependents.get(p) ?? []).sort(byText) });
      });
      if (!building.run(budget)) return stoppedAt(base, all, [], building.left);
      return listing({ ...base, unknown }, all);
    }
    if (!count.files.has(asked)) return fail(s, "packages", "not-found", `no project ${asked === "" ? "at the repository root" : asked} in this graph; the projects are ${count.projects.map((p) => (p === "" ? "(root)" : p)).join(", ")}`);
    linking ??= new Pass(
      gather.deps.values(),
      (d) => {
        if (d.to === asked) mine.push(d);
      },
      gather.deps.size,
    );
    if (!linking.run(budget)) return stoppedAt(base, [], [], linking.left);
    if (!sorted) {
      if (!sortWithin(mine, (a, b) => byText(a.from, b.from), budget)) return stoppedAt(base, [], [], null);
      sorted = true;
    }
    building ??= new Pass(mine, (d: Dependency) => {
      const items = importItems(g, d.edges);
      all.push({ project: d.from, importSites: items.length, sites: items.slice(0, EDGES_SHOWN).map((i) => `${i.site.file}:${i.site.line}`), edges: items.slice(0, EDGES_SHOWN) });
    });
    if (!building.run(budget)) return stoppedAt(base, all, [], building.left);
    return listing({ ...base, unknown }, all);
  };
}

// Import cycles between files or between projects. The nodes are gathered
// edge by edge, the search reads one successor at a time, and the edges of
// each cycle found are read one cycle at a time.
export function importCycles(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const level = req.level ?? "files";
  if (level !== "files" && level !== "projects") return fail(s, "cycles", "bad-request", "cycles takes the level files or projects");
  const gather = level === "projects" ? new Dependencies(g) : null;
  const count = level === "projects" ? new Projects(g) : null;
  // files: the files that import; projects: each project's dependencies.
  const importing = new Set<string>();
  const next = new Map<string, string[]>();
  let nodes: Pass<GraphEdge> | Pass<Dependency> | null = null;
  let order: string[] | null = null;
  let search: Cycles | null = null;
  let groups: string[][] | null = null;
  const all: unknown[] = [];
  let reading: Pass<string[]> | null = null;
  return (budget) => {
    const base = empty(s, "cycles");
    if (!search) {
      if (level === "files") {
        nodes ??= new Pass(importEdges(g), (e: GraphEdge) => importing.add(e.from), importCount(g));
        if (!nodes.run(budget)) return stoppedAt(base, [], [], nodes.left);
        order ??= [...importing];
        if (!sortWithin(order, byText, budget)) return stoppedAt(base, [], [], null);
        search = new Cycles(order, (f) => [...new Set(importsFrom(g, f).flatMap((e) => (e.to.startsWith("go:") ? [] : [e.to])))]);
      } else {
        const dep = gather as Dependencies;
        const projects = count as Projects;
        if (!dep.run(budget)) return stoppedAt(base, [], [], dep.left);
        if (!projects.run(budget)) return stoppedAt(base, [], [], projects.left);
        nodes ??= new Pass(dep.deps.values(), (d: Dependency) => (next.get(d.from) ?? next.set(d.from, []).get(d.from))?.push(d.to), dep.deps.size);
        if (!nodes.run(budget)) return stoppedAt(base, [], [], nodes.left);
        search = new Cycles(projects.projects, (p) => next.get(p) ?? []);
      }
    }
    if (!search.run(budget)) return stoppedAt(base, [], [], search.remaining);
    if (!groups) {
      const found = search.groups.slice();
      if (!sortWithin(found, (a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""), budget)) return stoppedAt(base, [], [], null);
      groups = found;
    }
    reading ??= new Pass(groups, (members) => {
      const m = new Set(members);
      const edges =
        level === "files"
          ? importItems(g, members.flatMap((f) => importsFrom(g, f).filter((e) => m.has(e.to))))
          : importItems(g, members.flatMap((p) => (next.get(p) ?? []).filter((q) => m.has(q)).flatMap((q) => (gather as Dependencies).deps.get(`${p}\0${q}`)?.edges ?? [])));
      all.push({ level, members, size: members.length, edgeCount: edges.length, edges: edges.slice(0, EDGES_SHOWN) });
    });
    if (!reading.run(budget)) return stoppedAt(base, all, [], reading.left);
    const reasons = g.status.notRead.length > 0 ? [`${g.status.notRead.length} ${g.status.notRead.length === 1 ? "file was" : "files were"} not read, and their imports are not here`] : [];
    return listing({ ...base, unknown: withFloor(base, reasons) }, all);
  };
}
