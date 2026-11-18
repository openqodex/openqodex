// The records every graph answer is made of: the evidence on an edge, its
// tier, and the unknown records that say what the graph could not see. One
// shape from the resolver to the brief, the packet and the CLI.
//
// Three tiers. "certain": the evidence names exactly one definition, its
// kind is in the certain set and every premise it rests on is certain.
// "likely": a stated convention picked the one target (Ruby autoload, a
// workspace package reached through its dist entry). "possible": the
// evidence names a set: a call through an interface or a base type to
// each implementation, a function value a callee, an alias, a table or a
// returned value may call. A name match alone is never
// certain: no name-convention kind is in CERTAIN_KINDS, and validateSite
// refuses a certain site whose kind is not.

// 3: dispatch, value and type uses (phase 2): the edge kinds implements,
// dispatches_to, may_invoke, overrides, uses_value and uses_type.
export const MODEL_VERSION = 3;
export const API_VERSION = 1;

export type Tier = "certain" | "likely" | "possible";

export const TIER_RANK: Record<Tier, number> = { certain: 2, likely: 1, possible: 0 };

// The weaker of two tiers: a binding is no stronger than its weakest premise.
export function weakest(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

export type EvidenceKind =
  | "same-scope" // a definition in the same file, scope or Go package
  | "import" // an import that names the symbol, relative or through a declared path
  | "ts-paths" // a tsconfig `paths` or `baseUrl` entry
  | "workspace-package" // a bare specifier naming a package of the workspace
  | "py-root" // a Python absolute import through a source root
  | "go-module" // a Go import through a go.mod module path
  | "receiver-constructor" // a receiver a constructor call typed
  | "receiver-annotation" // a receiver a type annotation typed
  | "receiver-result" // a receiver a declared result type typed
  | "receiver-inferred" // a receiver typed by what the called function's body provably returns
  | "receiver-field" // a receiver reached through a typed field
  | "receiver-self" // this, self or cls in a method of the class
  | "autoload" // a Ruby constant found by the autoload convention
  // Possible only: the evidence names a set, never one definition.
  | "dispatch-implements" // a call through an interface to one of its implementations
  | "dispatch-override" // a call through a base type, or this or self, to an override in a subclass
  | "invocation-summary" // a function passed to a callee whose body calls that parameter
  | "value-alias" // a local given one function, then called
  | "value-table" // a function in a literal table that a computed call on it may call
  | "returned-value" // a function a callee returns by name, called where it is returned
  // Likely at most: a match of member names, the signatures not compared.
  | "method-set"; // a Go type or Python class that defines every member of an interface or Protocol

// The kinds that may prove a certain edge. A kind outside this set yields
// likely at most. The set never grows without a corpus case for the kind
// (packages/graph/test/records.test.ts checks its exact contents).
export const CERTAIN_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  "same-scope",
  "import",
  "ts-paths",
  "workspace-package",
  "py-root",
  "go-module",
  "receiver-constructor",
  "receiver-annotation",
  "receiver-result",
  "receiver-inferred",
  "receiver-field",
  "receiver-self",
]);

// What proved a binding through a module: the import line and how its
// specifier was resolved. `note` is one short sentence for the brief, set
// when the tier is below certain (the missing mapping, the convention).
export type Via = { file: string; line: number; spec: string | null };

export type Evidence = {
  kind: EvidenceKind;
  tier: Tier;
  via: Via | null;
  note: string | null;
  rule: string; // the rule id that bound it: "js-import", "workspace-dist-src", ...
};

export type Cause =
  | "external" // the name comes from a declared dependency or the standard library
  | "no-receiver-type" // a method called on a value whose type no rule knows
  | "untyped-receiver" // a method called on a value typed any, unknown, object or a structural type
  | "not-exported" // a package path its exports map does not expose
  | "metadata-unreadable" // a manifest or tsconfig that could not be read, parsed or followed
  | "ambiguous" // several definitions could be meant and no evidence picks one
  | "miss" // the evidence names a place where no such symbol exists now
  | "dynamic" // a call through a value: a parameter, a computed member
  | "dynamic-base" // a class names a base with an expression (a call, a conditional), so what it extends is not known
  | "fan-out-capped"
  | "file-not-parsed" // the file was not read: size, budget, cap, memory, a parse error
  | "unsupported-language"
  | "unsupported-rule"
  | "budget"
  | "export-chain-too-deep" // re-exported or aliased through more modules than the graph follows
  | "memory"
  | "variant-excluded"
  | "redacted";

export const CAUSES: readonly Cause[] = [
  "external",
  "no-receiver-type",
  "untyped-receiver",
  "not-exported",
  "metadata-unreadable",
  "ambiguous",
  "miss",
  "dynamic",
  "dynamic-base",
  "fan-out-capped",
  "file-not-parsed",
  "unsupported-language",
  "unsupported-rule",
  "budget",
  "export-chain-too-deep",
  "memory",
  "variant-excluded",
  "redacted",
];

export type Stage = "capture" | "inventory" | "extract" | "bind" | "derive" | "query";
export type Shape = "bare" | "self" | "typed" | "name" | "other";
export type Relation = "calls" | "inherits" | "imports";

// One thing the graph could not see. `scope` is the smallest scope the gap
// is proved to affect; `affects` the relations it can hide. A count that
// cannot be known is null, never zero.
export type Unknown = {
  site: { file: string; line: number; column: number } | null;
  stage: Stage;
  scope: { file: string } | { project: string } | { workspace: true };
  affects: Relation[];
  name: string | null;
  shape: Shape | null;
  cause: Cause;
  candidates: string[] | null;
  count: number | null;
  unit: "sites" | "files" | "targets" | "paths" | null;
  exact: boolean;
  caller: string | null;
  recoverable: "more-budget" | "more-source" | "metadata" | "rule" | null;
  note: string | null;
};

// A cut a walk or a build made. `omitted` is exact when `exact`, else null
// (a stop at a budget cannot count what lies past the frontier).
export type Cut = {
  by: "hub" | "second-hop" | "walk-limit" | "inline" | "budget" | "parse-cap" | "memory" | "size" | "storage" | "export-walk" | "fan-out";
  at: string | null; // the symbol or file where the cut was made
  omitted: number | null;
  exact: boolean;
  unit: "callers" | "paths" | "sites" | "files" | "symbols";
  note: string;
};

// Checks a bound site before it is published: a certain tier needs a kind
// in the certain set and, for a binding through a module, the import line
// that proved it. Returns the reason it is invalid, or null.
export const POSSIBLE_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(["dispatch-implements", "dispatch-override", "invocation-summary", "value-alias", "value-table", "returned-value"]);

export function validateEvidence(e: Evidence): string | null {
  if (e.tier === "certain" && !CERTAIN_KINDS.has(e.kind)) return `a certain site cannot rest on ${e.kind}`;
  if (e.tier !== "possible" && POSSIBLE_KINDS.has(e.kind)) return `a ${e.kind} site names a set, so it is possible at most`;
  if (e.tier === "certain" && e.note !== null && /convention|guess/i.test(e.note)) return "a certain site cannot carry a convention note";
  const throughModule = e.kind === "import" || e.kind === "ts-paths" || e.kind === "workspace-package" || e.kind === "py-root" || e.kind === "go-module";
  if (throughModule && e.via === null) return `a ${e.kind} site needs the import line that proved it`;
  if (e.tier !== "certain" && (e.note === null || e.note.trim() === "")) return `a ${e.tier} site needs a note that says why it is not certain`;
  return null;
}
