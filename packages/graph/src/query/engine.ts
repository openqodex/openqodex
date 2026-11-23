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
import { langOf, unreadNote } from "../capture/inventory.js";
import { floorOf, isTestPath, joinGaps, partialGaps, sameNameGaps, toImpactUnknown } from "../impact.js";
import { API_VERSION, CERTAIN_KINDS, MODEL_VERSION } from "../model/records.js";
import type { Tier } from "../model/records.js";
import { CALLER_KINDS } from "../types.js";
import type { Graph, GraphNode, GraphSite, UnknownSite } from "../types.js";
import { BAD_CURSOR, candidate, counts, empty, fail, graphBlock, isAnswer, listing, OPERATIONS, Point, qualified, stoppedAt } from "./answer.js";
import type { Answer, Candidate, Extra, FloorGroup, Job, Listing, Request, Session } from "./answer.js";
import { frameworkCallerGaps, frameworkLayer, routes, routesUnsupported, tests, testsUnread } from "./frameworks.js";
import { gapPlace, namesReached, NEXT } from "../gap.js";
import type { GapPlace } from "../gap.js";
import { edgeId, isShortEdgeId, longEdgeId, readEdgeId } from "./ids.js";
import { cursorFor, keepJob, keepList, keptJob, keptList, limitOf, pageOf, pagingNote, readCursor } from "./page.js";
import { Overrides, dynamicBases, implementers, importCycles, impact, methodsNamed, outline, packages, path, references, relationsOf } from "./relations.js";
import { budgetOf, definesEdge, holderOf, prepareTraversal, sortWithin, spent, Walk } from "./traverse.js";
import type { Budget } from "./traverse.js";

export { OPERATIONS, parseTarget, resolveTarget } from "./answer.js";
export type { Answer, Candidate, ChangesExtra, ErrorCode, Extra, FloorGroup, Operation, Request, Session, Target } from "./answer.js";
export type { Budget, Item } from "./traverse.js";
export { budgetOf, checksBudget } from "./traverse.js";
export { edgeId } from "./ids.js";

const LANGUAGES = ["typescript", "tsx", "javascript", "python", "go", "ruby", "java"];

// What this build can answer, and what it cannot yet.
function capabilities(s: Session): Record<string, unknown> {
  const rel = relationsOf(s.graph);
  const unsupported: Record<string, string> = {};
  // Routes and tests each by the plugins that read them (query/frameworks.ts).
  const routesWhy = routesUnsupported(s.graph);
  const testsWhy = testsUnread(s.graph);
  if (![...rel].some((k) => ["uses_value", "uses_type", "reads", "writes", "may_invoke", "decorates"].includes(k))) unsupported.references = "uses of a symbol as a value or a type are not resolved";
  if (routesWhy !== null) unsupported.routes = `${routesWhy}: routes and handlers are not read`;
  if (!rel.has("dispatches_to")) unsupported["implementers of a method"] = "calls through interfaces and base types are not resolved; overrides are found by name from the inheritance";
  if (testsWhy !== null) unsupported.tests = `${testsWhy}: files named like tests are leads only`;
  return {
    apiVersion: API_VERSION,
    modelVersion: MODEL_VERSION,
    languages: LANGUAGES,
    ...(s.graph.status.unreadLanguages ? { unreadLanguages: s.graph.status.unreadLanguages } : {}),
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
      for (const name of namesReached(u)) (ix.byName.get(name) ?? ix.byName.set(name, []).get(name))?.push(u);
    }
    unknownIndex.set(g, ix);
  }
  return ix;
}
export const unknownsInside = (g: Graph, id: string): UnknownSite[] => unknownsBy(g).byCaller.get(id) ?? [];
const unknownsNamed = (g: Graph, name: string): UnknownSite[] => unknownsBy(g).byName.get(name) ?? [];

// Same-name gaps with first the ones whose receiver may be the target's
// class: a word of the receiver as written, or of its type, is the class
// name, or ends with it (`sessions`, `userSessions` for Sessions; an
// interface's name without its leading I). The rest keep their order.
function mayBe(named: UnknownSite[], n: GraphNode): UnknownSite[] {
  const owner = qualified(n).split(".").slice(-2, -1)[0];
  if (!owner) return named;
  const names = [owner, ...(/^I[A-Z]/.test(owner) ? [owner.slice(1)] : [])].map((o) => o.toLowerCase());
  const hit = (u: UnknownSite) => (u.receiver ?? "").toLowerCase().split(/[^a-z0-9_$]+/).some((w) => w !== "" && names.some((o) => w.endsWith(o)));
  return [...named.filter(hit), ...named.filter((u) => !hit(u))];
}

// The indexes questions read, built once per graph when a session opens it
// (open.ts), so no question's budget pays for them.
export function prepareIndexes(g: Graph): void {
  unknownsBy(g);
  relationsOf(g);
  dynamicBases(g, "js");
  methodsNamed(g, "", "");
  prepareTraversal(g);
}

// The score of a name that starts with the text searched; the exact name
// scores 1 and the same name in another case 0.9.
const PREFIX_SCORE = 0.7;

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
      const score = n.name === text || q === text ? 1 : n.name.toLowerCase() === lower ? 0.9 : n.name.toLowerCase().startsWith(lower) ? PREFIX_SCORE : n.name.toLowerCase().includes(lower) ? 0.5 : 0;
      if (score > 0) scored.push(candidate(g, n, score));
    }
    if (!sortWithin(scored, (a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id), budget)) return stoppedAt(base, [], [], null, "leads");
    // A definition named exactly as searched, or whose name starts with it,
    // is an item: likely for the exact name (a name match alone is never
    // certain), possible for the rest (another case, a prefix). A name that only holds the text and a file path hit
    // are leads. Neither is counted as callers or anything else. One
    // definition with exactly the name searched is also named as the
    // target; a prefix match, a file path hit or two exact names never is.
    const exact = scored.filter((c) => c.score === 1);
    const hits = scored.map((c) => (c.score >= PREFIX_SCORE ? { ...c, tier: c.score === 1 ? "likely" : "possible" } : c));
    return listing(exact.length === 1 ? { ...base, target: exact[0] as Candidate } : base, hits, { into: "items", lead: (c) => (c as Candidate).score < PREFIX_SCORE });
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
    // A call through a value in another file of the package could reach this
    // file, so those rows are listed (scope project); say how many.
    const reasons = [...base.unknown.reasons];
    const others = project === null ? 0 : hits.filter((u) => u.file !== t.file).length;
    if (others > 0) reasons.push(`${others} of these ${notRead.length + hits.length} rows come from other files of the same package: a call through a value there could reach this file, so they are listed (scope project)`);
    return listing({ ...base, unknown: { ...base.unknown, causes, reasons } }, [...notRead, ...hits.map(toImpactUnknown)]);
  };
}

function explainJob(s: Session, req: Request): Job | Answer {
  const g = s.graph;
  const asked = req.target?.id ?? "";
  const id = isShortEdgeId(asked) ? longEdgeId(g, asked) : asked;
  if (id === null) return fail(s, "explain", "not-found", `this build gave no edge ${asked}; ask the question again for its short id, or with full for the long one`);
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
  // A defines hop the query derived from the nesting: derived again.
  if (kind === "defines") {
    const holder = holderOf(g, to);
    const d = g.nodes.get(to);
    const hop = holder && d && holder.id === from ? definesEdge(holder, d) : null;
    const at = hop?.sites[0];
    if (!hop || !at || at.file !== file || at.line !== line || at.column !== column) return fail(s, "explain", "not-found", `no edge ${id} in this graph`);
    return { ...base, items: [{ edge: id, from, to, kind, site: at, why: `${d?.name} is defined inside ${holder?.name}; the parse proves the nesting, not that ${holder?.name} calls it` }] };
  }
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

// Callers and callees to a depth, with the floor of each. Callees walk
// the relations `edges` names when it is given, so `defines` (a function
// to a definition in its body) is walked only when asked.
const CALLEE_EDGES = new Set<string>([...CALLER_KINDS, "defines"]);
function walkJob(s: Session, req: Request, tiers: ReadonlySet<Tier>): Job | Answer {
  const g = s.graph;
  const kind = req.kind as "callers" | "callees";
  const depth = Math.min(Math.max(1, req.depth ?? 1), 3);
  const edges = kind === "callees" && req.edges && req.edges.length > 0 ? req.edges : null;
  const unknownEdge = edges?.find((k) => !CALLEE_EDGES.has(k));
  if (unknownEdge) return fail(s, kind, "bad-request", `callees walks ${[...CALLEE_EDGES].join(", ")}; not ${unknownEdge}`);
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
      w = new Walk(g, n.id, kind === "callers" ? "in" : "out", depth, tiers, edges ? new Set(edges) : null);
    }
    const walk = w as Walk;
    const target = candidate(g, n, 1);
    if (!walk.run(budget)) return stoppedAt({ ...base, target }, walk.items, walk.pending(), walk.pending().length);
    let reasons: string[];
    let causes: Record<string, number | null> = {};
    let examples: Answer["unknown"]["examples"];
    let gaps: GapPlace[] = [];
    // The places that could hide a caller, when each is known and each is a test.
    let inTests: { file: string; line: number | null }[] | null = null;
    if (kind === "callers") {
      const floor = floorOf(g, { id: n.id, name: n.name, file: n.file, kind: n.kind }, new Set());
      // The framework may run it too (a handler, a middleware): a cap of the framework layer may hide that.
      const fw = frameworkCallerGaps(g, n.file);
      reasons = [...floor.reasons, ...fw.reasons];
      gaps = joinGaps(floor.gaps, fw.gaps);
      if (fw.reasons.length === 0 && floor.places && floor.places.length > 0 && floor.places.every((p) => isTestPath(p.file))) inTests = floor.places;
      const named = n.kind === "function" || n.kind === "method" ? sameNameGaps(g, n) : unknownsNamed(g, n.name);
      for (const u of named) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
      examples = mayBe(named, n).slice(0, 5).map(toImpactUnknown);
    } else {
      // What it calls is a floor when a call inside any point the walk
      // expanded could not be bound: at every hop, not only the first.
      const inside: UnknownSite[] = [];
      for (const at of walk.expanded) for (const u of unknownsInside(g, at)) if (u.cause !== "external") inside.push(u);
      reasons = inside.length > 0 ? [`${inside.length} ${inside.length === 1 ? "call" : "calls"} inside the code it reaches within ${depth} ${depth === 1 ? "hop" : "hops"} could not be bound`] : [];
      causes = {};
      for (const u of inside) causes[u.cause] = (causes[u.cause] ?? 0) + 1;
      examples = inside.slice(0, 5).map(toImpactUnknown);
      gaps = joinGaps(inside.map(gapPlace));
    }
    const partial = g.status.status === "partial";
    // A partial build floors every answer: its files not read are gaps too.
    gaps = joinGaps(gaps, partialGaps(g));
    const answer: Answer = { ...base, target, counts: counts(walk.items), unknown: { floor: reasons.length > 0 || partial, reasons: [...reasons, ...(partial ? g.status.reasons : [])], causes, examples, ...(gaps.length > 0 ? { gaps } : {}) } };
    // Only the target's floor is read: past one hop a caller of a caller may hide anywhere.
    if (inTests && !partial && depth === 1) Object.assign(answer.unknown, { scope: "tests", note: testsNote(inTests) });
    // The same count the floor reason gives, said before the rows.
    const unbound = kind !== "callers" ? 0 : n.kind === "function" || n.kind === "method" ? sameNameGaps(g, n).length : (g.unknownNames.get(n.name) ?? 0);
    if (unbound > 0) answer.warning = `${unbound} ${unbound === 1 ? "call" : "calls"} named ${n.name} could not be bound; this list may be missing callers. See: openqodex graph unknowns --name ${n.name}`;
    return listing(answer, walk.items, { beyond: walk.beyond ? { frontier: walk.past } : null });
  };
}

// A floor whose every place is a test, said in one sentence.
const TESTS_SHOWN = 3;
function testsNote(places: { file: string; line: number | null }[]): string {
  const at = [...new Set(places.map((p) => (p.line === null ? p.file : `${p.file}:${p.line}`)))];
  const more = at.length > TESTS_SHOWN ? ` and ${at.length - TESTS_SHOWN} more` : "";
  return `Only test files could hide a caller: ${at.slice(0, TESTS_SHOWN).join(", ")}${more}.`;
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

// The answers that carry `gaps`, and a floor's gaps at the points it
// names (node ids), or at the target's definition when none is a node.
const GAP_KINDS: ReadonlySet<string> = new Set(["callers", "callees", "impact"]);
function gapsAt(g: Graph, points: readonly string[], target: Answer["target"], cause: string, next: string): GapPlace[] {
  const at = points.flatMap((id) => {
    const n = g.nodes.get(id);
    return n ? [{ cause, file: n.file, line: n.startLine, next }] : [];
  });
  if (at.length > 0) return joinGaps(at);
  const ends = target === null ? [] : Array.isArray(target) ? target : [target];
  return joinGaps(ends.map((c) => ({ cause, file: c.file, line: c.line, next })));
}

// What a question's work gave, as its answer. Stopped: its work is kept,
// the answer is a floor with what it found and where it stopped, and the
// cursor goes on from there. Whole: the list is kept for the next page.
function settle(s: Session, req: Request, job: Job, out: Listing | Answer, offset: number): Answer {
  if (isAnswer(out)) return out;
  if (out.stopped) {
    const id = keepJob(s.graph, job);
    const a = out.answer;
    const cursor = cursorFor(s.generation, req, offset, id);
    // Where it stopped is a gap: each point of the frontier, else the target.
    const stoppedGaps = GAP_KINDS.has(a.kind) ? joinGaps(a.unknown.gaps ?? [], gapsAt(s.graph, out.stopped.frontier, a.target, "budget", NEXT.questionStopped)) : [];
    return {
      ...a,
      [out.into]: out.all.slice(offset, offset + limitOf(req)),
      counts: { certain: null, likely: null, possible: null },
      unknown: { ...a.unknown, floor: true, reasons: [out.stopped.note, ...a.unknown.reasons], ...(stoppedGaps.length > 0 ? { gaps: stoppedGaps } : {}) },
      truncated: {
        by: "budget",
        omitted: null,
        omittedExact: false,
        cursor,
        note: pagingNote("budget", null, cursor),
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
  if (isAnswer(st)) return finish(s, st);
  return finish(s, settle(s, req, st.job, st.job(st.budget), st.offset));
}

// The answers whose list code in a language the build does not read can
// leave short: a call, a use, a test or a route may be in it.
const UNREAD_KINDS: ReadonlySet<string> = new Set(["callers", "callees", "search", "impact", "references", "implementers", "path", "routes", "tests"]);
// Languages whose code calls one another by name in one process: Kotlin
// and Scala call Java methods, and Java calls theirs. Any other unread
// language reaches a read one only through a binding layer (a native
// module, WebAssembly, a foreign function interface) that no build reads,
// the same as a call from another repository.
const RUNTIME: Record<string, string> = { java: "jvm", kotlin: "jvm", scala: "jvm" };
const runtimeOf = (language: string | null): string => (language === null ? "" : (RUNTIME[language] ?? language));

// The unread languages that can make this answer's list short. About one
// or two symbols: the languages that can call theirs. A name or a file
// the graph does not hold (any question but `explain`, whose edge ids
// are the graph's own), a search or a whole listing: every one, the code
// asked about may be there.
function unreadFor(s: Session, a: Answer): { language: string; files: number }[] {
  const unread = s.graph.status.unreadLanguages ?? [];
  if (unread.length === 0) return [];
  if (a.error?.code === "not-found") return a.kind === "explain" ? [] : unread;
  if (a.error !== null || !UNREAD_KINDS.has(a.kind)) return [];
  const ends = a.error === null && a.kind !== "search" && a.target !== null ? (Array.isArray(a.target) ? a.target : [a.target]) : [];
  if (ends.length === 0) return unread;
  const runtimes = new Set(ends.map((c) => runtimeOf(langOf(c.file))));
  return unread.filter((u) => runtimes.has(runtimeOf(u.language)));
}

const exampleLine = (e: Answer["unknown"]["examples"][number]): string => `${e.file}${e.line !== null ? `:${e.line}` : ""}: ${e.note ?? e.name ?? e.cause}`;

// Every answer as it leaves the engine: the unread languages that can make
// it short, its gaps grouped by cause (kept when a question grouped its
// own), whether its list is complete, and where a missing row could be.
// A floor is scoped to tests only when the callers walk said so and no
// unread language was added here; any other floor may hide a row anywhere.
function finish(s: Session, a: Answer): Answer {
  const langs = unreadFor(s, a);
  let unknown = a.unknown;
  const files = langs.reduce((k, u) => k + u.files, 0);
  if (langs.length > 0) {
    const notes = langs.map(unreadNote).filter((r) => !unknown.reasons.includes(r));
    // The build keeps no path of an unread file: the gap is said at the target.
    const gaps = GAP_KINDS.has(a.kind) && a.error === null ? joinGaps(unknown.gaps ?? [], gapsAt(s.graph, [], a.target, "language-not-read", NEXT.unreadLanguage)) : [];
    unknown = { ...unknown, floor: true, reasons: [...unknown.reasons, ...notes], causes: { ...unknown.causes, "language-not-read": files }, ...(gaps.length > 0 ? { gaps } : {}) };
  }
  const groups: FloorGroup[] = unknown.groups
    ? [...unknown.groups]
    : Object.entries(unknown.causes).map(([cause, count]) => ({ cause, count, examples: unknown.examples.filter((e) => e.cause === cause).slice(0, 2).map(exampleLine) }));
  const at = groups.findIndex((g) => g.cause === "language-not-read");
  if (langs.length > 0) groups.splice(at < 0 ? groups.length : at, at < 0 ? 0 : 1, { cause: "language-not-read", count: files, examples: langs.slice(0, 2).map(unreadNote) });
  const { scope, note, ...rest } = unknown;
  const tests = unknown.floor && scope === "tests" && note !== undefined && langs.length === 0;
  const where = !unknown.floor ? {} : tests ? { scope: "tests" as const, note } : { scope: "all" as const };
  return { ...a, unknown: { ...rest, groups, ...where }, listIncomplete: unknown.floor };
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
  if (isAnswer(st)) return finish(s, st);
  const { job, budget, offset } = st;
  for (;;) {
    const part: Budget = { deadline: budget.deadline, signal: budget.signal, stopped: false, checks: 0, limit: slice };
    const out = job(part);
    if (isAnswer(out) || !out.stopped || spent(budget)) return finish(s, settle(s, req, job, out, offset));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
