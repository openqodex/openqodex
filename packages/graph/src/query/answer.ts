// The shape of a question and of its answer, one for the review packet, the
// command line and the MCP tools (PLAN.md 3.3). Every answer carries what
// the graph does not know (`unknown`, with `floor` and the causes) and which
// build answered (`graph`). A count that cannot be known is null, never
// zero; search hits are leads and are never counted.
import type { Change, ImpactExportChange, ImpactSymbol } from "@openqodex/core";
import { toImpactUnknown } from "../impact.js";
import { API_VERSION } from "../model/records.js";
import type { Tier } from "../model/records.js";
import type { Graph, GraphNode } from "../types.js";
import type { Truncated } from "./page.js";
import { NameLookup, qualified } from "./traverse.js";
import type { Budget } from "./traverse.js";

export const OPERATIONS = [
  "search",
  "symbol",
  "callers",
  "callees",
  "importers",
  "implementers",
  "references",
  "routes",
  "tests",
  "path",
  "impact",
  "outline",
  "packages",
  "cycles",
  "changes",
  "unknowns",
  "explain",
  "status",
  "capabilities",
] as const;
export type Operation = (typeof OPERATIONS)[number];

// A symbol by its id, a file and line (the innermost definition around
// it), a name (`name` or `Owner.name`, narrowed by `file`), a file or
// folder by its path, or a project by its folder.
export type Target = { id?: string; name?: string; file?: string; line?: number; project?: string };

export type Request = {
  apiVersion: number;
  kind: Operation;
  target?: Target;
  to?: Target; // path: the other end
  text?: string; // search
  excludeTests?: boolean; // routes: leave out the routes of applications built in test files
  tiers?: Tier[];
  edges?: string[]; // path and callees: the relations to walk; path default calls, inherits and defines, callees default the calls profile
  depth?: number;
  level?: "files" | "projects"; // cycles
  limit?: number;
  cursor?: string;
  // items: a page size; tokens: a cut of the items by their size, never of
  // the counts; ms: the time the question may take (default 1 s).
  budget?: { items?: number; tokens?: number; ms?: number };
  generation?: string; // omitted: the build the session holds
};

export type Candidate = { id: string; name: string; kind: string; file: string; line: number; project: string; score: number };

// The gaps of one cause. `count`: the answer's `causes` value for it, null
// when it cannot be counted. `places`: how many places (a file, a call)
// hold gaps of the cause, where the question knows them one by one; a
// place may stand for several (a file with three regions it could not read).
export type FloorGroup = { cause: string; count: number | null; places?: number; examples: string[] };

export type ErrorCode = "ambiguous" | "not-found" | "bad-request" | "generation-unavailable" | "unsupported" | "refused";

export type Answer = {
  apiVersion: number;
  kind: Operation;
  error: null | { code: ErrorCode; message: string };
  target: Candidate | Candidate[] | null;
  items: unknown[];
  counts: { certain: number | null; likely: number | null; possible: number | null };
  leads: Candidate[];
  // `groups`: the gaps by cause, each with how many there are and at most
  // two examples, beside the reasons and causes it sums up.
  unknown: { floor: boolean; reasons: string[]; causes: Record<string, number | null>; examples: ReturnType<typeof toImpactUnknown>[]; groups?: FloorGroup[] };
  truncated: Truncated;
  // True on a floor: each row holds its tier, but rows may be missing, so
  // the counts are at least, never exactly. Set on every answer `query` gives.
  listIncomplete?: boolean;
  // Set when the rows alone could mislead: said first by every reader of the answer.
  warning?: string;
  graph: { generation: string | null; treeSha: string | null; builtAt: string | null; status: "ok" | "partial"; reasons: string[]; mode: "fresh" | "retained"; freshness: { laterEditsKnown: boolean } };
};

export type Session = {
  graph: Graph;
  generation: string | null;
  treeSha: string | null;
  builtAt: string | null;
  laterEditsKnown: boolean;
};

// What some questions need beyond the graph: the change compared with its
// base (`changes`), the diff the review walks (`impact`), the caller's
// cancellation, and a budget made by the caller (the MCP server's slices)
// in place of the request's `budget.ms`. `scope`: what the answer rests on
// besides the build, a comparison's resolved base and the capture it was
// built from; a cursor is bound to it, so a cursor made against one base
// is refused against another.
export type ChangesExtra = { exports: ImpactExportChange[]; removed: ImpactSymbol[]; moved: ImpactSymbol[] };
export type Extra = { changes?: ChangesExtra; change?: Pick<Change, "files" | "coverage">; signal?: AbortSignal; budget?: Budget; scope?: string };

export function graphBlock(s: Session): Answer["graph"] {
  const st = s.graph.status;
  return { generation: s.generation, treeSha: s.treeSha, builtAt: s.builtAt, status: st.status, reasons: st.reasons, mode: st.mode, freshness: { laterEditsKnown: s.laterEditsKnown } };
}

export function empty(s: Session, kind: Operation): Answer {
  const partial = s.graph.status.status === "partial";
  return {
    apiVersion: API_VERSION,
    kind,
    error: null,
    target: null,
    items: [],
    counts: { certain: null, likely: null, possible: null },
    leads: [],
    unknown: { floor: partial, reasons: partial ? s.graph.status.reasons : [], causes: {}, examples: [] },
    truncated: { by: null, omitted: 0, omittedExact: true, cursor: null },
    graph: graphBlock(s),
  };
}

export function fail(s: Session, kind: Operation, code: ErrorCode, message: string): Answer {
  return { ...empty(s, kind), error: { code, message } };
}

export const BAD_CURSOR = "the cursor belongs to another request or build";

export function candidate(g: Graph, n: GraphNode, score: number): Candidate {
  return { id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.startLine, project: g.projectOf(n.file), score };
}

export { qualified };

// A target that names its point without a search: an id, a file and line
// (the innermost definition around it), or a file. Undefined for a name.
function direct(g: Graph, t: Target): GraphNode[] | undefined {
  if (t.id) {
    const n = g.nodes.get(t.id);
    return n ? [n] : [];
  }
  if (t.file && t.line !== undefined) {
    let inner: GraphNode | null = null;
    for (const d of g.defsByFile.get(t.file) ?? []) {
      if (t.line < d.startLine || t.line > d.endLine) continue;
      if (!inner || d.endLine - d.startLine < inner.endLine - inner.startLine) inner = d;
    }
    return inner ? [inner] : [];
  }
  if (t.file && !t.name) {
    const n = g.nodes.get(t.file);
    return n ? [n] : [];
  }
  if (!t.name) return [];
  return undefined;
}

// The symbols a target names: an id, a file and line, a file, or a name
// (`name` or `Owner.name`), narrowed by file. No budget: for callers that
// are not answering a question.
export function resolveTarget(g: Graph, t: Target): GraphNode[] {
  const d = direct(g, t);
  if (d) return d;
  const l = new NameLookup(g, t.name as string, t.file);
  l.run({ deadline: Number.POSITIVE_INFINITY, signal: null, stopped: false, checks: 0, limit: null });
  return l.found;
}

// A target as a person or an agent writes it: `file:line`, or a name
// (`name` or `Owner.name`) narrowed to `file` when one is given. The
// command line and the MCP tools read targets with this one function.
export function parseTarget(value: string | undefined, file?: string): Target {
  if (value === undefined || value === "") return file ? { file } : {};
  const m = /^(.+):(\d+)$/.exec(value);
  if (m) return { file: m[1] as string, line: Number(m[2]) };
  return { name: value, ...(file ? { file } : {}) };
}

// The one symbol or file a question is about, found within the budget: a
// name is looked up node by node, and the lookup goes on where it stopped.
export class Point {
  private readonly lookup: NameLookup | null;
  private found: GraphNode[] | null;
  constructor(
    private readonly g: Graph,
    t: Target | undefined,
  ) {
    const d = direct(g, t ?? {});
    this.found = d ?? null;
    this.lookup = d ? null : new NameLookup(g, (t as Target).name as string, (t as Target).file);
  }
  run(budget: Budget): boolean {
    if (this.found) return true;
    if (!(this.lookup as NameLookup).run(budget)) return false;
    this.found = (this.lookup as NameLookup).found;
    return true;
  }
  // After run returned true: the point, or the answer that says why there
  // is none: not found, or several candidates and no silent pick.
  outcome(s: Session, kind: Operation): GraphNode | Answer {
    const found = this.found ?? [];
    if (found.length === 0) return fail(s, kind, "not-found", "no symbol or file of that name in this graph; try `search`");
    if (found.length > 1) return { ...fail(s, kind, "ambiguous", `${found.length} definitions match; name one by its id or file and line`), target: found.map((n) => candidate(s.graph, n, 1)) };
    return found[0] as GraphNode;
  }
}

export function counts(items: readonly { site: { tier: Tier } }[]): Answer["counts"] {
  const c = { certain: 0, likely: 0, possible: 0 };
  for (const i of items) c[i.site.tier]++;
  return c;
}

// What a question's work produced, before it is paged: the answer without
// its page (`items` or `leads` and `truncated`), the whole ordered list,
// and how the work ended. `stopped`: the budget stopped it, `all` holds
// what it had found, and running the same job again goes on from there.
// `beyond`: the work is whole, and the depth asked left points with more
// past them. `lead`: with `into` items, the entries of each page it is
// true for go to `leads` instead (search: a hit that is not an exact or
// prefix match).
export type Listing = {
  answer: Answer;
  all: unknown[];
  into: "items" | "leads";
  lead?: (entry: unknown) => boolean;
  beyond: { frontier: string[] } | null;
  stopped: { frontier: string[]; frontierTotal: number | null; note: string } | null;
};

// A question's work, run with a budget; run again, it goes on where the
// last budget stopped it. It returns an Answer when the question has no
// list to give (an error, a status).
export type Job = (budget: Budget) => Listing | Answer;

// True for an answer, as against the work or the point a step gives.
export function isAnswer<T>(v: T | Answer): v is Answer {
  return typeof v === "object" && v !== null && "apiVersion" in v;
}

export function listing(answer: Answer, all: unknown[], more: Partial<Pick<Listing, "into" | "lead" | "beyond" | "stopped">> = {}): Listing {
  return { answer, all, into: more.into ?? "items", ...(more.lead ? { lead: more.lead } : {}), beyond: more.beyond ?? null, stopped: more.stopped ?? null };
}

export const STOPPED_NOTE = "the question stopped at its time budget; what lies past where it stopped is not counted, and its cursor goes on from there";

export function stoppedAt(answer: Answer, all: unknown[], frontier: string[], frontierTotal: number | null, into: "items" | "leads" = "items"): Listing {
  return listing(answer, all, { into, stopped: { frontier, frontierTotal, note: STOPPED_NOTE } });
}
