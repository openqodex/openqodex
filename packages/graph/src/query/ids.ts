// Edge ids: opaque, so no part of a path or a name can be read as a
// separator, and read back with one JSON.parse, never a pattern.
import { createHash } from "node:crypto";
import type { Graph, GraphSite } from "../types.js";

export function edgeId(e: { from: string; to: string; kind: string }, site: Pick<GraphSite, "file" | "line" | "column">): string {
  return `e.${Buffer.from(JSON.stringify([e.kind, e.from, e.to, site.file, site.line, site.column])).toString("base64url")}`;
}

const MAX_EDGE_ID = 64 * 1024;

export function readEdgeId(id: string): { kind: string; from: string; to: string; file: string; line: number; column: number } | null {
  if (!id.startsWith("e.") || id.length > MAX_EDGE_ID) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(2), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 6) return null;
    const [kind, from, to, file, line, column] = v as unknown[];
    if (typeof kind !== "string" || typeof from !== "string" || typeof to !== "string" || typeof file !== "string" || !Number.isInteger(line) || !Number.isInteger(column)) return null;
    return { kind, from, to, file, line: line as number, column: column as number };
  } catch {
    return null;
  }
}

// A short edge id, for the short form of an answer (the MCP default): a hash
// of the long id, so one edge has one short id in every answer. It names no
// edge by itself: `explain` reads it back through the short ids this build
// has given, kept per graph, so a short id given by another build or
// another process is not found, never guessed. A long id always explains.
const SHORT_EDGE_ID = /^e:[A-Za-z0-9_-]{12}$/;
const given = new WeakMap<Graph, Map<string, string>>();

export function shortEdgeId(g: Graph, id: string): string {
  const short = `e:${createHash("sha256").update(id).digest("base64url").slice(0, 12)}`;
  let ids = given.get(g);
  if (!ids) {
    ids = new Map();
    given.set(g, ids);
  }
  ids.set(short, id);
  return short;
}

export const isShortEdgeId = (id: string): boolean => SHORT_EDGE_ID.test(id);

// The long id a short id stands for in this build; null when this build
// never gave it.
export function longEdgeId(g: Graph, short: string): string | null {
  return given.get(g)?.get(short) ?? null;
}
