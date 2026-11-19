// A function written in place where a route handler goes is read as a
// definition of its own (extract.ts, routeHandlerName), so a framework
// plugin can bind the route to it. The shape alone does not prove a route:
// `cache.get(key, () => load())` has it too. Once the plugins have run, each
// such definition no plugin bound is folded back into the definition it is
// written in (the file, at the top level): the node goes, and every edge,
// site and record it was the caller of moves to that definition, as if the
// definition had never been made.
import { TIER_RANK } from "./model/records.js";
import { symbolId } from "./resolve.js";
import type { Resolved } from "./resolve.js";
import type { FileFacts, GraphEdge } from "./types.js";

// Folds every definition written in place that `keep` does not name.
export function foldInline(r: Resolved, files: readonly { path: string; facts: FileFacts }[], keep: ReadonlySet<string>): void {
  const into = new Map<string, string>();
  for (const f of files) {
    const defs = f.facts.defs;
    if (!defs.some((d) => d.inlineIn !== undefined)) continue;
    const ids = defs.map((d) => symbolId(f.path, d));
    defs.forEach((d, i) => {
      const id = ids[i] as string;
      if (d.inlineIn === undefined || keep.has(id)) return;
      // The definition it is written in comes first in the file's list: one folded itself is already mapped.
      const around = d.inlineIn >= 0 ? (ids[d.inlineIn] as string) : f.path;
      into.set(id, into.get(around) ?? around);
    });
  }
  if (into.size === 0) return;

  const touched = new Set<string>();
  for (const id of into.keys()) {
    const n = r.nodes.get(id);
    if (n) touched.add(n.file);
    r.nodes.delete(id);
    r.summaries.delete(id);
  }
  for (const file of touched) r.defsByFile.set(file, (r.defsByFile.get(file) ?? []).filter((n) => !into.has(n.id)));
  r.edges = moved(r.edges, into);
  r.references = moved(r.references, into);
  for (const d of r.dispatch) d.caller = into.get(d.caller) ?? d.caller;
  for (const u of r.unknowns) u.caller = into.get(u.caller) ?? u.caller;
  for (const m of r.misses) m.from = into.get(m.from) ?? m.from;
}

// The edges with each folded caller replaced: an edge that lands on one
// already there takes its sites, in source order, and the stronger tier.
// An edge into a folded definition goes: nothing called it by name.
function moved(edges: GraphEdge[], into: ReadonlyMap<string, string>): GraphEdge[] {
  const key = (e: GraphEdge) => `${e.from}\0${e.to}\0${e.kind}`;
  const at = new Map<string, GraphEdge>();
  for (const e of edges) if (!into.has(e.from)) at.set(key(e), e);
  const out: GraphEdge[] = [];
  for (const e of edges) {
    if (into.has(e.to)) continue;
    const from = into.get(e.from);
    if (from === undefined) {
      out.push(e);
      continue;
    }
    const m: GraphEdge = { ...e, from };
    const held = at.get(key(m));
    if (!held) {
      at.set(key(m), m);
      out.push(m);
      continue;
    }
    held.sites.push(...e.sites);
    held.sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    if (TIER_RANK[e.tier] > TIER_RANK[held.tier]) held.tier = e.tier;
  }
  return out;
}
