// The one way the graph records that it gave up: what stopped, where, what
// a call it hides may run, and what to check there. A caller floor
// (impact.ts, floorOf) finds a gap only through `reaches`, so a gap made
// here can never be silent: one with no narrower target reaches "scope",
// every definition of its project.
import type { Cause, Shape } from "./model/records.js";
import type { Reaches, UnknownSite } from "./types.js";

export type GapInput = {
  cause: Cause;
  place: { file: string; line: number; column?: number };
  reaches: Reaches;
  next: string;
  // The call's name as written; by default the one name `reaches` names, else "".
  name?: string;
  shape?: Shape;
  // The symbol the gap sits inside; by default its file (top-level code).
  caller?: string;
  // "project" when a call through a value could reach any function of the
  // project; "values" makes it so.
  scope?: "file" | "project";
  note?: string;
  candidates?: string[];
};

export function gap(g: GapInput): UnknownSite {
  const names = typeof g.reaches === "object" && "names" in g.reaches ? g.reaches.names : [];
  const u: UnknownSite = {
    file: g.place.file,
    line: g.place.line,
    column: g.place.column ?? 0,
    name: g.name ?? (names.length === 1 ? (names[0] as string) : ""),
    cause: g.cause,
    shape: g.shape ?? "other",
    caller: g.caller ?? g.place.file,
    scope: g.reaches === "values" ? "project" : (g.scope ?? "file"),
    reaches: g.reaches,
    next: g.next,
  };
  if (g.note !== undefined) u.note = g.note;
  if (g.candidates !== undefined) u.candidates = g.candidates;
  return u;
}

// The names a gap reaches: a call of one of them may be hidden there.
export const namesReached = (u: UnknownSite): readonly string[] => (typeof u.reaches === "object" && "names" in u.reaches ? u.reaches.names : []);

// One gap as an answer gives it beside its reasons: what gave up, where
// (line null for a whole file), and what to check next.
export type GapPlace = { cause: string; file: string; line: number | null; next: string };
export const gapPlace = (u: Pick<UnknownSite, "cause" | "file" | "line" | "next">): GapPlace => ({ cause: u.cause, file: u.file, line: u.line > 0 ? u.line : null, next: u.next });

// What to check next, one sentence per kind of gap. Kept as constants so
// the index stores each once.
export const NEXT = {
  unbound: "Open this call and check whether it can run the target; if it can, count it as a caller.",
  values: "Open this call through a value and check what the value can hold; if it can hold the target, count it as a caller.",
  miss: "Open this call: its evidence points where no such definition exists now; check what it runs instead.",
  returnedCap: "Open this call: it calls what another call returns, and the functions past the listed ones may run here.",
  dispatchCap: "Open this call: implementations or overrides past the listed ones may run here.",
  tableCap: "Open this call on a table: entries past the listed ones may run here.",
  openShape: "Check which objects reach this call through the interface; any object of that shape may run here.",
  typeCut: "Read the long type annotations in this file: the types past the cut are not recorded as used, so a type's references may miss this file.",
  unreadImport: "Search this file for uses of the imported type that the graph did not read.",
  dynamicBase: "Read the base expression to learn which class this one extends; a call through that base may run this class's methods.",
  budget: "Build again with a larger budget (`openqodex graph build`) so the calls of this file are resolved.",
  metadata: "Fix or restore this manifest so the graph can read it, then build again.",
  framework: "Read the framework registrations near this place: a handler, middleware or job past the plugin's limit may be the target.",
  noCall: "Nothing to check for callers: this gap cannot hide a call.",
} as const;
