// One query function for every reader of the graph: the review's impact
// walk, the `openqodex graph` commands and the MCP tools (PLAN.md 3.3).
// Typed operations only; no model reads the question. Every answer carries
// what the graph does not know (`unknown`, with `floor` and the causes) and
// which graph answered (`graph`), in one shape (answer.ts).
//
// An ambiguous name returns its candidates and no items: the graph never
// picks one silently. A count that cannot be known is null, never zero.
// Search leads are never counted as callers. A question this build cannot
// answer is a capability boundary (`unsupported`), never an empty success.
//
// Each question has one budget (default 1 s, `budget.ms`), made before
// anything else and checked at every element its work touches, the name
// lookup and the sort included; the caller's cancellation stops it the same
// way. Work the budget stopped is a floor that names where it stopped, and
// its cursor goes on from there (page.ts). `querySliced` gives the same
// answer in slices with a turn of the event loop between them, so a
// cancellation that arrives while the work runs is seen (the MCP server).
import { floorReasons, toImpactUnknown } from "../impact.js";
import { API_VERSION, CERTAIN_KINDS, MODEL_VERSION } from "../model/records.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphNode, GraphSite, UnknownSite } from "../types.js";
import { BAD_CURSOR, candidate, counts, empty, fail, graphBlock, isAnswer, listing, OPERATIONS, Point, qualified, stoppedAt } from "./answer.js";
import type { Answer, Candidate, Extra, Job, Listing, Request, Session } from "./answer.js";
import { frameworkLayer, noLayerReason, routes, tests } from "./frameworks.js";
import { edgeId, readEdgeId } from "./ids.js";
import { cursorFor, keepJob, keepList, keptJob, keptList, limitOf, pageOf, readCursor } from "./page.js";
import { Overrides, dynamicBases, implementers, importCycles, impact, methodsNamed, outline, packages, path, references, relationsOf } from "./relations.js";
import { budgetOf, prepareTraversal, sortWithin, spent, Walk } from "./traverse.js";
import type { Budget } from "./traverse.js";

export { OPERATIONS, parseTarget, resolveTarget } from "./answer.js";
export type { Answer, Candidate, ChangesExtra, ErrorCode, Extra, Operation, Request, Session, Target } from "./answer.js";
export type { Budget, Item } from "./traverse.js";
export { budgetOf, checksBudget } from "./traverse.js";
export { edgeId } from "./ids.js";

const LANGUAGES = ["typescript", "tsx", "javascript", "python", "go", "ruby", "java"];

// What this build can answer, and what it cannot yet.
function capabilities(s: Session): Record<string, unknown> {
  const rel = relationsOf(s.graph);
  const layer = frameworkLayer(s.graph);
  const unsupported: Record<string, string> = {};
  if (![...rel].some((k) => ["uses_value", "uses_type", "reads", "writes", "may_invoke", "decorates"].includes(k))) unsupported.references = "uses of a symbol as a value or a type are not resolved";
  if (!layer) unsupported.routes = `${noLayerReason(s.graph)}: routes and handlers are not read`;
  if (!rel.has("dispatches_to")) unsupported["implementers of a method"] = "calls through interfaces and base types are not resolved; overrides are found by name from the inheritance";
  if (!layer) unsupported.tests = `${noLayerReason(s.graph)}: files named like tests are leads only`;
  return {
    apiVersion: API_VERSION,
    modelVersion: MODEL_VERSION,
    languages: LANGUAGES,
    operations: OPERATIONS,
    relations: [...rel].sort(),
    certainEvidence: [...CERTAIN_KINDS],
    unsupported,
  };
}

// The unknown records of the graph by the point they sit inside and by the
// name they call, built once per graph.
type UnknownIndex = { byCaller: Map<string, UnknownSite[]>; byName: Map<string, UnknownSite[]> };
const unknownIndex = new WeakMap<Graph, UnknownIndex>();
function unknownsBy(g: Graph): UnknownIndex {
  let ix = unknownIndex.get(g);
  if (!ix) {
    ix = { byCaller: new Map(), byName: new Map() };
    for (const u of g.unknowns) {
      (ix.byCaller.get(u.caller) ?? ix.byCaller.set(u.caller, []).get(u.caller))?.push(u);
      (ix.byName.get(u.name) ?? ix.byName.set(u.name, []).get(u.name))?.push(u);
    }
    unknownIndex.set(g, ix);
  }
  return ix;
}
export const unknownsInside = (g: Graph, id: string): UnknownSite[] => unknownsBy(g).byCaller.get(id) ?? [];
const unknownsNamed = (g: Graph, name: string): UnknownSite[] => unknownsBy(g).byName.get(name) ?? [];

// The indexes questions read, built once per graph when a session opens it
// (open.ts), so no question's budget pays for them.
export function prepareIndexes(g: Graph): void {
  unknownsBy(g);
  relationsOf(g);
  dynamicBases(g, "js");
  methodsNamed(g, "", "");
  prepareTraversal(g);
}

function searchJob(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const text = (req.text ?? req.target?.name ?? "").trim();
  if (text === "") return fail(s, "search", "bad-request", "search needs a text");
  const lower = text.toLowerCase();
  const scored: Candidate[] = [];
  const it = g.nodes.values();
  let scanned = 0;
  let scanning = true;
  return (budget) => {
    const base = empty(s, "search");
    while (scanning) {
      if (spent(budget)) return stoppedAt(base, [], [], g.nodes.size - scanned, "leads");
      const r = it.next();
      if (r.done) {
        scanning = false;
        break;
      }
      scanned++;
      const n = r.value;
      if (n.kind === "file") {
        if (n.file.toLowerCase().includes(lower)) scored.push(candidate(g, n, 0.5));
        continue;
      }
      const q = qualified(n);
      const score = n.name === text || q === text ? 1 : n.name.toLowerCase() === lower ? 0.9 : n.name.toLowerCase().startsWith(lower) ? 0.7 : n.name.toLowerCase().includes(lower) ? 0.5 : 0;
      if (score > 0) scored.push(candidate(g, n, score));
    }
    if (!sortWithin(scored, (a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id), budget)) return stoppedAt(base, [], [], null, "leads");
    // Search results are leads: never counted as callers or anything else.
    return listing(base, scored, { into: "leads" });
  };
}

function unknownsJob(s: Session, req: Request): Job {
  const g = s.graph;
  const t = req.target ?? {};
  const project = t.file && !t.name ? g.projectOf(t.file) : null;
  const notRead = t.file ? g.status.notRead.filter((n) => n.file === t.file).map((n) => ({ file: n.file, line: null, name: null, cause: "file-not-parsed", scope: "file", note: n.reason, candidates: null })) : [];
  const hits: UnknownSite[] = [];
  let i = 0;
  return (budget) => {
    const base = empty(s, "unknowns");
    while (i < g.unknowns.length) {
      if (spent(budget)) return stoppedAt(base, [...notRead, ...hits.map(toImpactUnknown)], [], g.unknowns.length - i);
      const u = g.unknowns[i++] as UnknownSite;
      if ((t.name ? u.name === t.name : true) && (t.file ? u.file === t.file || (u.scope === "project" && project !== null && g.projectOf(u.file) === project) : true)) hits.push(u);
    }
    const causes: Record<string, number | null> = {};
    for (const u of hits) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
    if (notRead.length > 0) causes["file-not-parsed"] = notRead.length;
    return listing({ ...base, unknown: { ...base.unknown, causes } }, [...notRead, ...hits.map(toImpactUnknown)]);
  };
}

function explainJob(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const id = req.target?.id ?? "";
  const parsed = readEdgeId(id);
  if (!parsed) return fail(s, "explain", "bad-request", "explain takes an edge id as the items of an answer print it");
  const { kind, from, to, file, line, column } = parsed;
  const base = empty(s, "explain");
  const why = (site: GraphSite) => (site.tier === "certain" ? `${site.evidence} proves it${site.via ? `: ${site.via.spec !== null ? "the import" : "the line"} at ${site.via.file}:${site.via.line}` : ""}` : site.note);
  const edges = kind === "imports" ? (g.importers.get(to) ?? []) : [...(g.out.get(from) ?? []), ...(g.refsOut.get(from) ?? [])];
  const e = edges.find((x) => x.kind === kind && x.from === from && x.to === to);
  const site = e?.sites.find((x) => x.file === file && x.line === line && x.column === column);
  if (e && site) return { ...base, items: [{ edge: id, from: e.from, to: e.to, kind: e.kind, site, why: why(site) }] };
  // A framework edge: its evidence record as the plugin wrote it.
  const layer = frameworkLayer(g);
  const fw = layer?.edges.find((x) => x.kind === kind && x.from === from && x.to === to && x.evidence.site.file === file && x.evidence.site.line === line && x.evidence.site.column === column);
  if (fw) return { ...base, items: [{ edge: id, from: fw.from, to: fw.to, kind: fw.kind, plugin: fw.plugin, app: fw.app, evidence: fw.evidence, why: fw.evidence.note ?? `${fw.evidence.kind} proves it` }] };
  // An override the query derived from the inheritance: derived again.
  const m = kind === "overrides" ? g.nodes.get(to) : undefined;
  if (!m) return fail(s, "explain", "not-found", `no edge ${id} in this graph`);
  const derive = new Overrides(g, m, 8, new Set<Tier>(["certain", "likely", "possible"]));
  return (budget) => {
    if (!derive.run(budget)) return stoppedAt(base, [], derive.pending(), derive.pending().length);
    const hit = derive.items.find((i) => i.edge === id);
    if (!hit) return fail(s, "explain", "not-found", `no edge ${id} in this graph`);
    return listing(base, [{ edge: id, from: hit.from, to: hit.to, kind: hit.kind, site: hit.site, premises: hit.premises, why: hit.site.note }]);
  };
}

// Callers and callees to a depth, with the floor of each.
function walkJob(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job {
  const g = s.graph;
  const kind = req.kind as "callers" | "callees";
  const depth = Math.min(Math.max(1, req.depth ?? 1), 3);
  const point = new Point(g, req.target);
  let n: GraphNode | null = null;
  let w: Walk | null = null;
  return (budget) => {
    const base = empty(s, kind);
    if (!n) {
      if (!point.run(budget)) return stoppedAt(base, [], [], null);
      const o = point.outcome(s, kind);
      if (isAnswer(o)) return o;
      n = o;
      w = new Walk(g, n.id, kind === "callers" ? "in" : "out", depth, tiers);
    }
    const walk = w as Walk;
    const target = candidate(g, n, 1);
    if (!walk.run(budget)) return stoppedAt({ ...base, target }, walk.items, walk.pending(), walk.pending().length);
    let reasons: string[];
    let causes: Record<string, number | null> = {};
    let examples: Answer["unknown"]["examples"];
    if (kind === "callers") {
      reasons = floorReasons(g, { id: n.id, name: n.name, file: n.file }, new Set());
      const named = unknownsNamed(g, n.name);
      for (const u of named) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
      examples = named.slice(0, 5).map(toImpactUnknown);
    } else {
      // What it calls is a floor when a call inside any point the walk
      // expanded could not be bound: at every hop, not only the first.
      const inside: UnknownSite[] = [];
      for (const at of walk.expanded) for (const u of unknownsInside(g, at)) if (u.cause !== "external") inside.push(u);
      reasons = inside.length > 0 ? [`${inside.length} ${inside.length === 1 ? "call" : "calls"} inside the code it reaches within ${depth} ${depth === 1 ? "hop" : "hops"} could not be bound`] : [];
      causes = {};
      for (const u of inside) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
      examples = inside.slice(0, 5).map(toImpactUnknown);
    }
    const partial = g.status.status === "partial";
    const answer: Answer = { ...base, target, counts: counts(walk.items), unknown: { floor: reasons.length > 0 || partial, reasons: [...reasons, ...(partial ? g.status.reasons : [])], causes, examples } };
    return listing(answer, walk.items, { beyond: walk.beyond ? { frontier: walk.past } : null });
  };
}

function changesJob(s: Session, extra: Extra): Job | Answer {
  const c = extra.changes;
  if (!c) return fail(s, "changes", "bad-request", "no base was compared for this graph; ask `changes` with a change against its base");
  const all = [...c.exports.map((e) => ({ type: "export", ...e })), ...c.removed.map((r) => ({ type: "removed", ...r })), ...c.moved.map((m) => ({ type: "moved", ...m }))];
  return () => listing(empty(s, "changes"), all);
}

function importersJob(s: Session, req: Request): Job {
  const g = s.graph;
  const point = new Point(g, req.target);
  return (budget) => {
    const base = empty(s, "importers");
    if (!point.run(budget)) return stoppedAt(base, [], [], null);
    const n = point.outcome(s, "importers");
    if (isAnswer(n)) return n;
    const file = n.file;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const edges = [...(g.importers.get(file) ?? []), ...(file.endsWith(".go") ? (g.importers.get(`go:${dir}`) ?? []) : [])];
    const items = edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, depth: 1, site: e.sites[0] as GraphSite, edge: edgeId(e, e.sites[0] as GraphSite), fromName: null, toName: null }));
    return listing({ ...base, target: candidate(g, n, 1), counts: counts(items) }, items);
  };
}

function symbolJob(s: Session, req: Request): Job {
  const g = s.graph;
  const point = new Point(g, req.target);
  return (budget) => {
    const base = empty(s, "symbol");
    if (!point.run(budget)) return stoppedAt(base, [], [], null);
    const n = point.outcome(s, "symbol");
    if (isAnswer(n)) return n;
    const callers = (g.in.get(n.id) ?? []).reduce((k, e) => k + e.sites.length, 0);
    const callees = (g.out.get(n.id) ?? []).reduce((k, e) => k + e.sites.length, 0);
    return { ...base, target: candidate(g, n, 1), items: [{ ...n, project: g.projectOf(n.file), callerSites: callers, calleeSites: callees }] };
  };
}

// The work of a question, ready to run with a budget, or the answer it
// gives without any.
function jobFor(s: Session, req: Request, extra: Extra, tiers: ReadonlySet<Tier>): Job | Answer {
  const g = s.graph;
  switch (req.kind) {
    case "status":
      return { ...empty(s, "status"), items: [{ ...g.status, eligible: g.status.eligibleFiles, inGraph: g.status.filesParsed }] };
    case "capabilities":
      return { ...empty(s, "capabilities"), items: [capabilities(s)] };
    case "search":
      return searchJob(s, req);
    case "unknowns":
      return unknownsJob(s, req);
    case "changes":
      return changesJob(s, extra);
    case "explain":
      return explainJob(s, req);
    case "implementers":
      return implementers(s, req, tiers);
    case "references":
      return references(s, req, tiers);
    case "routes":
      return routes(s, req);
    case "tests":
      return tests(s, req, tiers);
    case "path":
      return path(s, req, tiers);
    case "impact":
      return impact(s, req, extra);
    case "outline":
      return outline(s, req);
    case "packages":
      return packages(s, req);
    case "cycles":
      return importCycles(s, req);
    case "symbol":
      return symbolJob(s, req);
    case "importers":
      return importersJob(s, req);
    case "callers":
    case "callees":
      return walkJob(s, req, tiers);
  }
}

// What a question's work gave, as its answer. Stopped: its work is kept,
// the answer is a floor with what it found and where it stopped, and the
// cursor goes on from there. Whole: the list is kept for the next page.
function settle(s: Session, req: Request, job: Job, out: Listing | Answer, offset: number): Answer {
  if (isAnswer(out)) return out;
  if (out.stopped) {
    const id = keepJob(s.graph, job);
    const a = out.answer;
    return {
      ...a,
      [out.into]: out.all.slice(offset, offset + limitOf(req)),
      counts: { certain: null, likely: null, possible: null },
      unknown: { ...a.unknown, floor: true, reasons: [out.stopped.note, ...a.unknown.reasons] },
      truncated: {
        by: "budget",
        omitted: null,
        omittedExact: false,
        cursor: cursorFor(s.generation, req, offset, id),
        frontier: out.stopped.frontier.slice(0, 50),
        ...(out.stopped.frontierTotal !== null ? { frontierTotal: out.stopped.frontierTotal } : {}),
      },
    };
  }
  keepList(s.graph, s.generation, req, out);
  return pageOf(s.generation, req, out, offset);
}

// A question made ready to work: its job, its one budget and the position
// its cursor names, or the answer it gives with no work (an error, a page
// of a kept list, a status).
function start(s: Session, req: Request, extra: Extra): { job: Job; budget: Budget; offset: number } | Answer {
  const kind = req.kind;
  if (!(OPERATIONS as readonly string[]).includes(kind)) return fail(s, kind, "bad-request", `unknown operation ${String(kind)}`);
  // The one budget of this question, before any of its work.
  const budget = extra.budget ?? budgetOf(req.budget?.ms, extra.signal ?? null);
  if (req.apiVersion !== API_VERSION) return fail(s, kind, "bad-request", `this graph answers apiVersion ${API_VERSION}, not ${req.apiVersion}`);
  if (req.generation && s.generation && req.generation !== s.generation) return fail(s, kind, "generation-unavailable", `this session holds build ${s.generation}, not ${req.generation}`);
  const tiers = new Set<Tier>(req.tiers ?? ["certain", "likely", "possible"]);
  // A cursor first: a kept list gives its next page with no work, and kept
  // work goes on where its budget stopped it.
  const c = readCursor(s.generation, req);
  if (c === "bad") return fail(s, kind, "generation-unavailable", BAD_CURSOR);
  if (c.state) {
    const job = keptJob(s.graph, c.state);
    if (job) return { job, budget, offset: c.offset };
  } else if (req.cursor) {
    const kept: Listing | null = keptList(s.graph, s.generation, req);
    // The list was made earlier; what the session knows of later edits is now.
    if (kept) return { ...pageOf(s.generation, req, kept, c.offset), graph: graphBlock(s) };
  }
  const job = jobFor(s, req, extra, tiers);
  if (isAnswer(job)) return job;
  return { job, budget, offset: c.offset };
}

// The request as a cursor and a kept list are bound to it: with the
// scope of a comparison, when there is one.
function bound(req: Request, extra: { scope?: string }): Request {
  return extra.scope === undefined ? req : ({ ...req, scope: extra.scope } as Request);
}

export function query(s: Session, asked: Request, extra: Extra = {}): Answer {
  const req = bound(asked, extra);
  const st = start(s, req, extra);
  if (isAnswer(st)) return st;
  return settle(s, req, st.job, st.job(st.budget), st.offset);
}

// Budget checks in one slice of a question's work.
export const SLICE_CHECKS = 2048;

// The answer `query` gives, worked in slices of `slice` budget checks with
// a turn of the event loop between them, so a cancellation that arrives
// while the work runs is seen and stops it (the MCP server). The question's
// own budget is its time and its cancellation; a budget counted in checks
// is for `query`.
export async function querySliced(s: Session, asked: Request, extra: Omit<Extra, "budget"> = {}, slice = SLICE_CHECKS): Promise<Answer> {
  const req = bound(asked, extra);
  const st = start(s, req, extra);
  if (isAnswer(st)) return st;
  const { job, budget, offset } = st;
  for (;;) {
    const part: Budget = { deadline: budget.deadline, signal: budget.signal, stopped: false, checks: 0, limit: slice };
    const out = job(part);
    if (isAnswer(out) || !out.stopped || spent(budget)) return settle(s, req, job, out, offset);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
