// Bounded, resumable work for the query layer: a name looked up, callers
// and callees walked to a depth, the shortest path between two points, the
// cycles of a graph, a list sorted. Each piece keeps its state in an object
// and checks the question's budget (wall time, and the caller's
// cancellation) at every element it touches: every node a name is looked
// up in, every site of every edge a walk or a path search reads, every
// edge of a point past the depth it checks, every thousand comparisons of
// a sort. When the budget is spent the piece
// stops where it is and can be run again with a new budget to go on from
// there: a question stopped by its budget says where it stopped, never a
// count of what lies past it, and its cursor resumes it.
import { edgeId } from "./ids.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphEdge, GraphNode, GraphSite } from "../types.js";

export type Budget = {
  deadline: number; // performance.now() time
  signal: AbortSignal | null;
  stopped: boolean;
  checks: number; // how many times the budget was checked
  limit: number | null; // a budget counted in checks instead of time (the MCP server's slices, tests)
};

export const DEFAULT_QUERY_MS = 1000;
export const MAX_QUERY_MS = 60_000;

export function budgetOf(ms: number | undefined, signal: AbortSignal | null = null): Budget {
  const span = ms !== undefined && Number.isFinite(ms) ? Math.max(1, Math.min(ms, MAX_QUERY_MS)) : DEFAULT_QUERY_MS;
  return { deadline: performance.now() + span, signal, stopped: false, checks: 0, limit: null };
}

// A budget of `n` checks, with no clock: the same stop points on every run.
export function checksBudget(n: number, signal: AbortSignal | null = null): Budget {
  return { deadline: Number.POSITIVE_INFINITY, signal, stopped: false, checks: 0, limit: n };
}

// True once the budget is spent or the question was cancelled; it stays true.
export function spent(b: Budget): boolean {
  b.checks++;
  if (b.stopped) return true;
  if ((b.limit !== null && b.checks > b.limit) || performance.now() > b.deadline || b.signal?.aborted === true) b.stopped = true;
  return b.stopped;
}

export type Item = {
  from: string;
  to: string;
  kind: string; // calls, inherits, imports, or a relation a later phase adds
  depth: number;
  site: GraphSite;
  edge: string; // the edge id `explain` takes
  fromName: string | null;
  toName: string | null;
};

export const RANK: Record<Tier, number> = { certain: 0, likely: 1, possible: 2 };

export function toItem(g: Graph, e: { from: string; to: string; kind: string }, site: GraphSite, depth: number): Item {
  return { from: e.from, to: e.to, kind: e.kind, depth, site, edge: edgeId(e, site), fromName: g.nodes.get(e.from)?.name ?? null, toName: g.nodes.get(e.to)?.name ?? null };
}

export const byItem = (a: Item, b: Item): number =>
  a.depth - b.depth || RANK[a.site.tier] - RANK[b.site.tier] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.site.column - b.site.column || a.from.localeCompare(b.from);

const STOP = Symbol("budget spent");
const COMPARISONS_PER_CHECK = 1024;

// Sorts `list` in place, checking the budget every 1,024 comparisons. False
// when the budget stopped it: the list holds the same elements, in no
// promised order, and a later call sorts it again.
export function sortWithin<T>(list: T[], cmp: (a: T, b: T) => number, budget: Budget): boolean {
  if (spent(budget)) return false;
  let n = 0;
  try {
    list.sort((a, b) => {
      if (++n % COMPARISONS_PER_CHECK === 0 && spent(budget)) throw STOP;
      return cmp(a, b);
    });
    return true;
  } catch (error) {
    if (error === STOP) return false;
    throw error;
  }
}

// One pass over a list or an iterator, an element at a time, with the
// budget checked at each. Run it until it returns true; `left` is what it
// has not read, null when the size of an iterator is not given.
export class Pass<T> {
  private readonly it: Iterator<T>;
  private readonly size: number | null;
  private read = 0;
  private done = false;
  constructor(
    list: readonly T[] | Iterable<T>,
    private readonly each: (x: T) => void,
    size?: number,
  ) {
    this.it = list[Symbol.iterator]();
    this.size = Array.isArray(list) ? list.length : (size ?? null);
  }
  get left(): number | null {
    return this.size === null ? null : this.size - this.read;
  }
  run(budget: Budget): boolean {
    while (!this.done) {
      if (spent(budget)) return false;
      const r = this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      this.read++;
      this.each(r.value);
    }
    return true;
  }
}

// Import edges by the file that imports: the graph keeps them by target.
const importsOut = new WeakMap<Graph, Map<string, GraphEdge[]>>();
export function importsFrom(g: Graph, file: string): GraphEdge[] {
  let byFrom = importsOut.get(g);
  if (!byFrom) {
    byFrom = new Map();
    for (const list of g.importers.values()) for (const e of list) (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from))?.push(e);
    importsOut.set(g, byFrom);
  }
  return byFrom.get(file) ?? [];
}

// Every import edge of the graph, one at a time, and how many there are.
export function* importEdges(g: Graph): Generator<GraphEdge> {
  for (const list of g.importers.values()) yield* list;
}
const importTotals = new WeakMap<Graph, number>();
export function importCount(g: Graph): number {
  let n = importTotals.get(g);
  if (n === undefined) {
    n = 0;
    for (const list of g.importers.values()) n += list.length;
    importTotals.set(g, n);
  }
  return n;
}

// An edge a walk reads: one of the graph's, or a hop the query derives.
export type HopEdge = { from: string; to: string; kind: string; sites: GraphSite[] };

// The definitions a function or a method holds in its body (closures,
// nested function declarations, handlers written inline) and, for each,
// the function that holds it. The parse proves the nesting: a nested
// definition's id names its enclosing definition's qualified name, and
// that definition's lines hold it. A `defines` hop says the definition is
// there, never that the function calls it or when it runs.
type Nesting = { held: Map<string, GraphNode[]>; holder: Map<string, GraphNode> };
const nestings = new WeakMap<Graph, Nesting>();
function nesting(g: Graph): Nesting {
  let n = nestings.get(g);
  if (!n) {
    n = { held: new Map(), holder: new Map() };
    for (const defs of g.defsByFile.values()) {
      const byName = new Map<string, GraphNode[]>();
      for (const d of defs) if (d.kind === "function" || d.kind === "method") (byName.get(qualified(d)) ?? byName.set(qualified(d), []).get(qualified(d)))?.push(d);
      for (const d of defs) {
        const q = qualified(d);
        const dot = q.lastIndexOf(".");
        if (dot === -1) continue;
        let best: GraphNode | null = null;
        for (const p of byName.get(q.slice(0, dot)) ?? []) {
          if (p.id === d.id || p.startLine > d.startLine || p.endLine < d.endLine) continue;
          if (!best || p.endLine - p.startLine < best.endLine - best.startLine) best = p;
        }
        if (!best) continue;
        n.holder.set(d.id, best);
        (n.held.get(best.id) ?? n.held.set(best.id, []).get(best.id))?.push(d);
      }
    }
    nestings.set(g, n);
  }
  return n;
}

// The function that holds a nested definition, or null.
export function holderOf(g: Graph, id: string): GraphNode | null {
  return nesting(g).holder.get(id) ?? null;
}

// A defines hop as an edge with one site: where the nested definition is.
// The parse names exactly one enclosing definition, so it is certain.
export function definesEdge(holder: GraphNode, d: GraphNode): HopEdge {
  const column = Number(d.id.slice(d.id.lastIndexOf(":") + 1)) || 0;
  const site: GraphSite = { file: d.file, line: d.startLine, column, tier: "certain", evidence: "same-scope", via: null, note: null, rule: "query-defines" };
  return { from: holder.id, to: d.id, kind: "defines", sites: [site] };
}

// The indexes of this file, built once per graph before any question.
export function prepareTraversal(g: Graph): void {
  importsFrom(g, "");
  importCount(g);
  goFilesOf(g, "go:");
  nesting(g);
}

// Go imports name a package folder (`go:<dir>`): the files of that folder.
const goFolders = new WeakMap<Graph, Map<string, string[]>>();
function goFilesOf(g: Graph, target: string): string[] {
  let byDir = goFolders.get(g);
  if (!byDir) {
    byDir = new Map();
    for (const file of g.defsByFile.keys()) {
      if (!file.endsWith(".go")) continue;
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir))?.push(file);
    }
    goFolders.set(g, byDir);
  }
  return byDir.get(target.slice(3)) ?? [];
}

// The edges leaving (or entering) a point, of the asked kinds, one at a
// time. A file's imports are edges out of the file; a Go package import
// reaches every file of the folder. The default (null) is what `in` and
// `out` hold: the calls profile (calls, inheritance, implements, dispatch
// and possible invocations). The uses that are not calls (overrides, uses
// as a value or a type) are read only when a kind asks for them.
function* neighbours(g: Graph, at: string, dir: "in" | "out", kinds: ReadonlySet<string> | null): Generator<{ edge: HopEdge; other: string }> {
  const want = (k: string) => kinds === null || kinds.has(k);
  for (const e of (dir === "in" ? g.in.get(at) : g.out.get(at)) ?? []) if (want(e.kind)) yield { edge: e, other: dir === "in" ? e.from : e.to };
  if (kinds !== null) for (const e of (dir === "in" ? g.refsIn.get(at) : g.refsOut.get(at)) ?? []) if (kinds.has(e.kind)) yield { edge: e, other: dir === "in" ? e.from : e.to };
  if (kinds !== null && kinds.has("defines")) {
    if (dir === "out") {
      const holder = g.nodes.get(at);
      if (holder) for (const d of nesting(g).held.get(at) ?? []) yield { edge: definesEdge(holder, d), other: d.id };
    } else {
      const holder = holderOf(g, at);
      const d = g.nodes.get(at);
      if (holder && d) yield { edge: definesEdge(holder, d), other: holder.id };
    }
  }
  if (kinds !== null && kinds.has("imports")) {
    if (dir === "out") {
      for (const e of importsFrom(g, at)) {
        if (e.to.startsWith("go:")) for (const f of goFilesOf(g, e.to)) yield { edge: e, other: f };
        else yield { edge: e, other: e.to };
      }
    } else {
      for (const e of g.importers.get(at) ?? []) yield { edge: e, other: e.from };
      if (at.endsWith(".go")) {
        const dir2 = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
        for (const e of g.importers.get(`go:${dir2}`) ?? []) yield { edge: e, other: e.from };
      }
    }
  }
}

// Every site of every edge of a point, one at a time, `last` on the last
// site of each edge (an edge with no site gives one step with none). A
// point with thousands of edges, or an edge with thousands of sites, is
// read with the budget checked at each step, and goes on where it stopped.
export type PointStep = { edge: HopEdge; other: string; site: GraphSite | null; last: boolean };
export function* pointSites(g: Graph, at: string, dir: "in" | "out", kinds: ReadonlySet<string> | null): Generator<PointStep> {
  for (const { edge, other } of neighbours(g, at, dir, kinds)) {
    const n = edge.sites.length;
    if (n === 0) yield { edge, other, site: null, last: true };
    for (let i = 0; i < n; i++) yield { edge, other, site: edge.sites[i] as GraphSite, last: i === n - 1 };
  }
}

// ---------- a name looked up ----------

// "Owner.name" when the symbol has an owner, else the name.
export function qualified(n: GraphNode): string {
  const inner = n.id.slice(n.id.indexOf("#") + 1, n.id.lastIndexOf("@"));
  return inner || n.name;
}

// The definitions a name (or `Owner.name`) names, narrowed by file, found
// node by node with the budget checked at each.
export class NameLookup {
  readonly found: GraphNode[] = [];
  private readonly it: Iterator<GraphNode>;
  done = false;
  constructor(
    g: Graph,
    private readonly name: string,
    private readonly file: string | undefined,
  ) {
    this.it = g.nodes.values();
  }
  run(budget: Budget): boolean {
    while (!this.done) {
      if (spent(budget)) return false;
      const r = this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      const n = r.value;
      if (n.kind === "file") continue;
      if (n.name !== this.name && qualified(n) !== this.name) continue;
      if (this.file && n.file !== this.file) continue;
      this.found.push(n);
    }
    return true;
  }
}

// ---------- a walk to a depth ----------

// Edges into or out of `start` to `depth` hops; each item keeps its hop.
// `expanded` names every point whose edges the walk read, for the floor of
// what they could not bind. Run it until it returns true.
export class Walk {
  readonly items: Item[] = [];
  readonly expanded = new Set<string>();
  readonly seen: Set<string>;
  private frontier: string[];
  private next: string[] = [];
  private d = 1;
  private i = 0; // the next point of the frontier to expand
  private steps: Iterator<PointStep> | null = null; // the point being expanded, where it stopped
  private pastChecked = 0;
  private pastSteps: Iterator<PointStep> | null = null;
  readonly past: string[] = []; // points at the last depth with edges past it
  private phase: "walk" | "past" | "sort" | "done" = "walk";

  constructor(
    private readonly g: Graph,
    start: string,
    private readonly dir: "in" | "out",
    private readonly depth: number,
    private readonly tiers: ReadonlySet<Tier>,
    private readonly kinds: ReadonlySet<string> | null = null,
  ) {
    this.seen = new Set([start]);
    this.frontier = [start];
  }

  get finished(): boolean {
    return this.phase === "done";
  }

  // The points not yet expanded, or past the depth once the walk is whole.
  pending(): string[] {
    if (this.phase === "walk") return [...this.frontier.slice(this.i), ...this.next];
    if (this.phase === "past") return this.frontier;
    return this.past;
  }

  get beyond(): boolean {
    return this.past.length > 0;
  }

  run(budget: Budget): boolean {
    const g = this.g;
    while (this.phase === "walk") {
      if (this.d > this.depth || this.frontier.length === 0) {
        this.phase = "past";
        break;
      }
      if (this.i >= this.frontier.length) {
        this.frontier = this.next;
        this.next = [];
        this.i = 0;
        this.d++;
        continue;
      }
      const at = this.frontier[this.i] as string;
      if (this.steps === null) {
        if (spent(budget)) return false;
        this.steps = pointSites(g, at, this.dir, this.kinds);
        this.expanded.add(at);
      }
      for (;;) {
        if (spent(budget)) return false;
        const r = this.steps.next();
        if (r.done) break;
        const { edge: e, other, site, last } = r.value;
        if (site && this.tiers.has(site.tier)) this.items.push(toItem(g, e, site, this.d));
        if (last && !this.seen.has(other)) {
          this.seen.add(other);
          this.next.push(other);
        }
      }
      this.steps = null;
      this.i++;
    }
    // Points one hop past the last depth: the answer stops at the depth asked.
    while (this.phase === "past") {
      if (this.pastChecked >= this.frontier.length) {
        this.phase = "sort";
        break;
      }
      const at = this.frontier[this.pastChecked] as string;
      if (this.pastSteps === null) {
        if (spent(budget)) return false;
        this.pastSteps = pointSites(g, at, this.dir, this.kinds);
      }
      let more = false;
      for (;;) {
        if (spent(budget)) return false;
        const r = this.pastSteps.next();
        if (r.done) break;
        if (!this.seen.has(r.value.other)) {
          more = true;
          break;
        }
      }
      if (more) this.past.push(at);
      this.pastSteps = null;
      this.pastChecked++;
    }
    if (this.phase === "sort") {
      if (!sortWithin(this.items, byItem, budget)) return false;
      this.phase = "done";
    }
    return true;
  }
}

// ---------- the shortest path ----------

// The shortest directed path from `a` to `b` over the asked kinds, at most
// `depth` hops; each hop is one edge with its strongest site. Run it until
// it returns true; `hops` is null when there is none within the depth, and
// `beyond` says the search had points left at its last hop.
export class PathSearch {
  hops: Item[] | null = null;
  beyond = false;
  readonly visited: Set<string>;
  private readonly parent = new Map<string, { from: string; edge: HopEdge; site: GraphSite }>();
  private frontier: string[];
  private next: string[] = [];
  private d = 1;
  private i = 0;
  private done = false;
  private steps: Iterator<PointStep> | null = null; // the point being expanded, where it stopped
  private best: GraphSite | null = null; // the strongest site so far of the edge being read

  constructor(
    private readonly g: Graph,
    private readonly a: string,
    private readonly b: string,
    private readonly kinds: ReadonlySet<string>,
    private readonly depth: number,
    private readonly tiers: ReadonlySet<Tier>,
  ) {
    this.visited = new Set([a]);
    this.frontier = [a];
  }

  get finished(): boolean {
    return this.done;
  }

  pending(): string[] {
    return [...this.frontier.slice(this.i), ...this.next];
  }

  // True when `s` is a site of an asked tier stronger than `best`.
  private stronger(s: GraphSite, best: GraphSite | null): boolean {
    if (!this.tiers.has(s.tier)) return false;
    return !best || RANK[s.tier] < RANK[best.tier] || (RANK[s.tier] === RANK[best.tier] && (s.file < best.file || (s.file === best.file && s.line < best.line)));
  }

  run(budget: Budget): boolean {
    while (!this.done) {
      if (this.d > this.depth || this.frontier.length === 0) {
        this.beyond = this.frontier.length > 0;
        this.done = true;
        break;
      }
      if (this.i >= this.frontier.length) {
        this.frontier = this.next;
        this.next = [];
        this.i = 0;
        this.d++;
        continue;
      }
      const at = this.frontier[this.i] as string;
      if (this.steps === null) {
        if (spent(budget)) return false;
        this.steps = pointSites(this.g, at, "out", this.kinds);
        this.best = null;
      }
      // One site at a time, the budget checked at each: a stop keeps the
      // place, and the next run goes on with the same edge.
      for (;;) {
        if (spent(budget)) return false;
        const r = this.steps.next();
        if (r.done) break;
        const { edge: e, other, site, last } = r.value;
        if (site && !this.visited.has(other) && this.stronger(site, this.best)) this.best = site;
        if (!last) continue;
        const best = this.best;
        this.best = null;
        if (!best || this.visited.has(other)) continue;
        this.visited.add(other);
        this.parent.set(other, { from: at, edge: e, site: best });
        if (other === this.b) {
          const hops: Item[] = [];
          let cur = this.b;
          while (cur !== this.a) {
            const p = this.parent.get(cur) as { from: string; edge: HopEdge; site: GraphSite };
            hops.unshift({ ...toItem(this.g, { from: p.from, to: cur, kind: p.edge.kind }, p.site, 0), edge: edgeId(p.edge, p.site) });
            cur = p.from;
          }
          this.hops = hops.map((h, n) => ({ ...h, depth: n + 1 }));
          this.done = true;
          return true;
        }
        this.next.push(other);
      }
      this.steps = null;
      this.i++;
    }
    return true;
  }
}

// ---------- cycles ----------

// Strongly connected components with more than one member (or a member
// that reaches itself), by Tarjan's method without recursion. Run it until
// it returns true.
export class Cycles {
  readonly groups: string[][] = [];
  private readonly index = new Map<string, number>();
  private readonly low = new Map<string, number>();
  private readonly onStack = new Set<string>();
  private readonly stack: string[] = [];
  private readonly work: { n: string; i: number; succ: readonly string[] }[] = [];
  private counter = 0;
  private root = 0;
  done = false;

  constructor(
    private readonly nodes: readonly string[],
    private readonly next: (n: string) => readonly string[],
  ) {}

  get remaining(): number {
    return this.nodes.length - this.root;
  }

  private open(n: string): void {
    this.index.set(n, this.counter);
    this.low.set(n, this.counter);
    this.counter++;
    this.stack.push(n);
    this.onStack.add(n);
    this.work.push({ n, i: 0, succ: this.next(n) });
  }

  run(budget: Budget): boolean {
    while (!this.done) {
      if (this.work.length === 0) {
        while (this.root < this.nodes.length && this.index.has(this.nodes[this.root] as string)) this.root++;
        if (this.root >= this.nodes.length) {
          this.done = true;
          break;
        }
        if (spent(budget)) return false;
        this.open(this.nodes[this.root] as string);
        continue;
      }
      if (spent(budget)) return false;
      const top = this.work[this.work.length - 1] as { n: string; i: number; succ: readonly string[] };
      if (top.i < top.succ.length) {
        const s = top.succ[top.i++] as string;
        if (!this.index.has(s)) this.open(s);
        else if (this.onStack.has(s)) this.low.set(top.n, Math.min(this.low.get(top.n) as number, this.index.get(s) as number));
        continue;
      }
      this.work.pop();
      const parent = this.work[this.work.length - 1];
      if (parent) this.low.set(parent.n, Math.min(this.low.get(parent.n) as number, this.low.get(top.n) as number));
      if (this.low.get(top.n) === this.index.get(top.n)) {
        const group: string[] = [];
        let m: string;
        do {
          m = this.stack.pop() as string;
          this.onStack.delete(m);
          group.push(m);
        } while (m !== top.n);
        if (group.length > 1 || this.next(top.n).includes(top.n)) this.groups.push(group.sort());
      }
    }
    return true;
  }
}
