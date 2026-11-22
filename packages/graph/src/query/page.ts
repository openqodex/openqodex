// Pages and cuts of an answer's list, and the state a cursor goes on from.
// A cursor names the build it was made on, the request it belongs to, the
// position after the last item and, for work the budget stopped, the saved
// work to go on with. A cursor from another request or another build is
// refused, never answered from a newer graph.
//
// The work behind a cursor is kept in memory, per graph, for the 32 most
// recent questions: the whole list a question produced, so the next page
// is read from it and nothing is walked again, and the job a budget
// stopped, so the next call goes on from where it stopped. A cursor whose
// work is no longer kept (another process, or an older question) runs the
// question again from the start; the answer is the same, because the graph
// does not change.
//
// A token budget cuts items, never counts: the counts stay the true totals,
// and the cut says how many items it left out. Pagination is apart from
// analysis: `truncated` says what the page left out of a list the graph
// knows; `unknown` says what the graph could not see.
import { createHash, randomBytes } from "node:crypto";
import type { Graph } from "../types.js";
import type { Answer, Job, Listing } from "./answer.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const KEPT_PER_GRAPH = 32;
// A rough count of tokens in an item: JSON characters over four.
const CHARS_PER_TOKEN = 4;

export type Truncated = {
  by: "limit" | "depth" | "budget" | null;
  omitted: number | null; // exact when omittedExact; null when it cannot be counted
  omittedExact: boolean;
  cursor: string | null;
  // The points the work had not expanded when the budget stopped it, or the
  // points past the depth asked, up to 50; their count is `frontierTotal`.
  frontier?: string[];
  frontierTotal?: number;
  // How to go on, as the command line says it; set with a cursor.
  note?: string;
};

// What of a request a cursor is bound to: everything but the position and
// the page size and budget, which a client may change between pages.
type Bindable = { cursor?: string; limit?: number; budget?: unknown };

export function fingerprint(req: Bindable): string {
  const { cursor: _c, limit: _l, budget: _b, ...rest } = req as Record<string, unknown>;
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

export function cursorFor(generation: string | null, req: Bindable, offset: number, state: string | null = null): string {
  return Buffer.from(JSON.stringify({ g: generation, f: fingerprint(req), o: offset, ...(state ? { s: state } : {}) })).toString("base64url");
}

const MAX_CURSOR = 4096;

// The position and the saved work a cursor names; "bad" when it belongs to
// another request or build.
export function readCursor(generation: string | null, req: Bindable): { offset: number; state: string | null } | "bad" {
  if (!req.cursor) return { offset: 0, state: null };
  if (req.cursor.length > MAX_CURSOR) return "bad";
  try {
    const c = JSON.parse(Buffer.from(req.cursor, "base64url").toString("utf8")) as { g: unknown; f: unknown; o: unknown; s?: unknown };
    if (c.g !== generation || c.f !== fingerprint(req) || !Number.isInteger(c.o) || (c.o as number) < 0) return "bad";
    if (c.s !== undefined && (typeof c.s !== "string" || !/^[0-9a-f]{16}$/.test(c.s))) return "bad";
    return { offset: c.o as number, state: (c.s as string | undefined) ?? null };
  } catch {
    return "bad";
  }
}

export function limitOf(req: { limit?: number; budget?: { items?: number } }): number {
  const asked = Number.isFinite(req.limit) ? (req.limit as number) : DEFAULT_LIMIT;
  const items = req.budget?.items !== undefined && Number.isFinite(req.budget.items) ? req.budget.items : MAX_LIMIT;
  return Math.max(1, Math.min(Math.floor(asked), Math.floor(items), MAX_LIMIT));
}

// ---------- the saved work ----------

type Kept = { lists: Map<string, Listing>; jobs: Map<string, Job> };
const kept = new WeakMap<Graph, Kept>();

function keptOf(g: Graph): Kept {
  let k = kept.get(g);
  if (!k) {
    k = { lists: new Map(), jobs: new Map() };
    kept.set(g, k);
  }
  return k;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > KEPT_PER_GRAPH) map.delete(map.keys().next().value as string);
}

const listKey = (generation: string | null, req: Bindable) => `${generation ?? ""}\0${fingerprint(req)}`;

export function keepList(g: Graph, generation: string | null, req: Bindable, l: Listing): void {
  remember(keptOf(g).lists, listKey(generation, req), l);
}

export function keptList(g: Graph, generation: string | null, req: Bindable): Listing | null {
  return keptOf(g).lists.get(listKey(generation, req)) ?? null;
}

export function keepJob(g: Graph, job: Job): string {
  const id = randomBytes(8).toString("hex");
  remember(keptOf(g).jobs, id, job);
  return id;
}

export function keptJob(g: Graph, id: string): Job | null {
  const jobs = keptOf(g).jobs;
  const job = jobs.get(id) ?? null;
  if (job) jobs.delete(id);
  return job;
}

// ---------- a page ----------

// The page of a whole list at `offset`, cut further by the token budget. At
// least one item is returned when any is left, so a client paging with a
// tiny budget still moves forward. Past the last page, the depth asked.
export function pagingNote(by: "limit" | "budget", omitted: number | null, cursor: string | null): string {
  return `truncated by ${by}: ${omitted ?? "an unknown number of"} more; --cursor ${cursor}`;
}

export function pageOf(generation: string | null, req: Bindable & { limit?: number; budget?: { items?: number; tokens?: number } }, l: Listing, offset: number): Answer {
  let items = l.all.slice(offset, offset + limitOf(req));
  let byTokens = false;
  const tokens = req.budget?.tokens;
  if (tokens !== undefined && Number.isFinite(tokens)) {
    let used = 0;
    let n = 0;
    for (const item of items) {
      used += Math.ceil(JSON.stringify(item).length / CHARS_PER_TOKEN);
      if (used > tokens && n > 0) break;
      n++;
    }
    if (n < items.length) {
      items = items.slice(0, n);
      byTokens = true;
    }
  }
  const rest = l.all.length - offset - items.length;
  let truncated: Truncated = { by: null, omitted: 0, omittedExact: true, cursor: null };
  if (rest > 0) {
    const by = byTokens ? "budget" : "limit";
    const cursor = cursorFor(generation, req, offset + items.length);
    truncated = { by, omitted: rest, omittedExact: true, cursor, note: pagingNote(by, rest, cursor) };
  }
  else if (l.beyond) truncated = { by: "depth", omitted: null, omittedExact: false, cursor: null, frontier: l.beyond.frontier.slice(0, 50), frontierTotal: l.beyond.frontier.length };
  const lead = l.lead;
  if (lead) return { ...l.answer, items: items.filter((x) => !lead(x)), leads: items.filter(lead) as Answer["leads"], truncated };
  return { ...l.answer, [l.into]: items, truncated };
}
