// The code graph's own types. What the brief and the report see is
// ImpactSummary in @openqodex/core; these are the pieces it is built from.
import type { ImpactEdgeKind, ImpactExportChange, ImpactKind, ImpactSite, ImpactSymbol } from "@openqodex/core";
import type { ProjectModel } from "./discovery/projects.js";
import type { FrameworkFileFacts } from "./frameworks/plugin.js";
import type { FrameworkData } from "./frameworks/stage.js";
import type { Cause, Cut, Shape, Tier } from "./model/records.js";

export type Lang = "typescript" | "tsx" | "javascript" | "python" | "go" | "ruby" | "java";
// Calls bind only inside one family: a TypeScript file never calls Python.
export type Family = "js" | "python" | "go" | "ruby" | "java";

export function familyOf(lang: Lang): Family {
  if (lang === "python" || lang === "go" || lang === "ruby" || lang === "java") return lang;
  return "js";
}

// ---------- facts one parse of one file yields (cached by content) ----------

// Type nesting through `on` and `args` shares one depth limit.
export const MAX_TYPE_DEPTH = 16;

// A type named in source: `Repo`, `pkg.Repo` (qualifier "pkg"), Ruby `A::B`
// (whole path in `name`, the lexical nesting in `qualifier`).
// `result`: the type is what calling the function `name` returns, at that
// position of its results (Go has several). `elem`: a slice, array, map or
// list of the type; a loop over it or an index into it yields the type.
// `declared`: from a type annotation, so a reassignment cannot change it.
// `bound`: the head name (`name`, or the first part of `qualifier`) is
// bound by a scoped import where the type was read.
// On a base: `rel` is how the class takes it (absent: extends, a
// superclass, a Go embedded field or interface).
export type TypeRef = {
  name: string;
  qualifier: string | null;
  line: number;
  column: number;
  result?: number;
  promise?: boolean; // The declared type wraps this type in Promise.
  awaited?: boolean; // The call result is read through await.
  // With `result`: the method `name` is called on a value of type `on`
  // (`repo.find(id)` with `repo` a typed local or field); this type is that
  // method's declared result at position `result`. Chains nest through `on`.
  on?: TypeRef; // nested at most MAX_TYPE_DEPTH deep
  elem?: boolean;
  declared?: boolean;
  bound?: BoundImport;
  rel?: "implements" | "include" | "prepend" | "extend";
  args?: TypeRef[]; // Java arguments, in declaration order.
  kind?: "param"; // A Java result naming a class type parameter.
  param?: number; // The class type parameter's index.
};

export type DefFact = {
  name: string;
  kind: Exclude<ImpactKind, "file">;
  owner: string | null; // enclosing class or module; Go: the receiver type
  line: number;
  column: number;
  endLine: number;
  exported: boolean;
  topLevel: boolean; // bindable by name from the rest of the file
  bases: TypeRef[]; // classes: extends, superclasses, include; Go: embedded fields
  // Classes: each base written as an expression the facts cannot name (a
  // call such as a mixin, a conditional, a subscript), where it stands.
  // `head`: a Python subscript's head when it is a name (`Generic` of
  // `Generic[T]`), so the resolver can tell typing's own apart; `rel`: how a
  // Ruby class takes it (absent: its superclass).
  dynamicBases?: { line: number; column: number; head?: TypeRef; rel?: "include" | "extend" | "prepend" }[];
  fields: Record<string, TypeRef>; // classes and structs: field name to its declared or constructed type
  results?: (TypeRef | null)[]; // functions and methods: the declared result types
  static?: boolean; // methods called on the class itself: JS `static`, Ruby `def self.x`
  // A hash of the definition without its name, comments and whitespace
  // (top-level definitions and members of top-level classes only).
  bodyHash?: string;
  // A TypeScript type alias: the type it stands for (`type Loose = any`).
  alias?: TypeRef;
  // A member declared without a body that runs: a TypeScript interface
  // member or `abstract` method, a Go interface method, a Python method
  // marked @abstractmethod. Calls bind to it as the declared member; it is
  // never a dispatch target.
  abstract?: boolean;
  iface?: boolean; // a TypeScript interface or a Go interface type
  anonymous?: boolean; // a Java object or enum constant body, never a source-level type name
  pointer?: boolean; // a Go method with a pointer receiver
  // A Java method whose last parameter is varargs (`Object... rest`): it
  // takes any number of arguments from its fixed parameters up.
  varargs?: boolean;
  // A Java constructor: a method named like its class, called by `new`.
  // It is not static: its body runs on the new instance.
  ctor?: boolean;
  // Functions and methods: the parameter names in order (a Python method
  // without its self or cls), the ones the body calls (at any depth of
  // nested functions), and the value references it returns (indices into
  // FileFacts.values). The invocation summary of phase 2.
  params?: string[];
  invokes?: number[];
  returns?: number[];
  // A return hands back something other than a function named by the
  // graph (a parameter, a call, an expression): a call of the result may
  // run that too.
  returnsOther?: boolean;
};

// A name in value position: an argument, the right side of an assignment,
// a returned value, a property value, an element of a list. Bound like a
// call (`recv` is what stands before the dot, `local`, `shadowed` and
// `bound` as on CallFact); one that resolves to a function or a method is
// a use of it as a value. A name of a local variable is never recorded.
export type ValueRef = {
  name: string;
  line: number;
  column: number;
  caller: number; // index into defs, -1 for the file's top level
  recv: Receiver;
  local?: number;
  bound?: BoundImport;
  role: "arg" | "assign" | "return" | "property" | "element";
  call?: number; // an argument: the call (index into calls) it is passed to
  arg?: number; // its position among the arguments
  key?: string; // a Python keyword argument's name
};

// A type named in an annotation, a cast, `satisfies`, `instanceof` or
// `isinstance`, once per enclosing definition and name.
export type TypeUse = { ref: TypeRef; caller: number };

// An object, dict or map literal bound to a name: the value references of
// its entries. A computed call on the name (`handlers[key]()`) may call
// any of them. `open`: something else may change what it holds: it is
// exported, a Python module's or a Go package's (other modules and files
// can write it), written through a member or an index, passed on, or has
// a method called on it.
export type TableFact = { name: string; line: number; values: number[]; open?: boolean };

// A name bound by an import made inside a function or a block, in that
// scope only: the import (an index into FileFacts.imports) and the name it
// imports, "*" for the whole module.
export type BoundImport = { import: number; imported: string };

// What stands before the dot of a call.
export type Receiver =
  | { kind: "none" } // a bare call: f()
  | { kind: "self"; path: string[] } // this, self, cls (path: this.a.b)
  | { kind: "super" }
  | { kind: "type"; type: TypeRef; path: string[] } // a local whose type a constructor or an annotation gives
  // An identifier: maybe a module, a package or a class; `bound` when a scoped import gives it.
  | { kind: "name"; name: string; path: string[]; nesting: string | null; bound?: BoundImport }
  | { kind: "other" };

export type CallFact = {
  name: string;
  line: number;
  column: number;
  caller: number; // index into defs, -1 for the file's top level
  recv: Receiver;
  // Ruby: a bare identifier that may be a method call. Bound only when the
  // enclosing class defines it, never counted as unresolved.
  implicit?: boolean;
  // A bare call bound by the enclosing scopes: `local` is a nested
  // definition (index into defs); `shadowed` means a parameter or local
  // variable of that name hides every outer definition.
  local?: number;
  shadowed?: boolean;
  bound?: BoundImport; // a bare call to a name a scoped import binds

  static?: boolean; // the caller runs on the class itself (static method, Ruby class body)
  // Java: `new T(...)`, `this(...)` or `super(...)`: a constructor call,
  // bound only to the constructors the class itself declares.
  ctor?: boolean;
  // Java: the number of arguments, when the argument list parsed.
  arity?: number;
  // A computed callee (`table[key]()`): no name to bind. `name` is empty.
  dynamic?: boolean;
  // A call of a local or its member uses the local's single callable value.
  // The alias indexes FileFacts.values.
  alias?: number;
  // The local given the value, when it is not the callee name.
  aliasOf?: string;
  // A call of what a call returned: `pick(k)()`, or a local given that
  // value once (`const h = pick(k); h()`): the inner call (index into calls).
  result?: number;
  // A computed call on a name bound to a literal table (index into FileFacts.tables).
  table?: number;
};

export type ImportFact = {
  spec: string; // the specifier as written: "./x.js", ".models", "example.com/m/pkg", "lib/x"
  line: number;
  column: number;
  names: { imported: string; local: string }[]; // "default" for a default import
  namespace: string | null; // a local bound to the whole module
  star: boolean; // `export * from`, Python `from x import *`
  reexport: boolean; // `export ... from`
  typeOnly: boolean;
  relative?: boolean; // Ruby require_relative
  alias?: boolean; // Python `import a.b as c`
  // Made inside a function or a block (`await import()`, a require, a Python
  // import in a function): it binds no name for the whole file, only through `bound`.
  scoped?: boolean;
  // Java `import static a.b.C.m`: the member `m` of the named class C.
  staticMember?: string;
  // Java `import static a.b.C.*`: every static member of the named class C.
  staticStar?: boolean;
};

export type FileFacts = {
  lang: Lang;
  defs: DefFact[];
  calls: CallFact[];
  values: ValueRef[];
  types: TypeUse[];
  typeCuts?: number; // annotations too large to read whole: their types past the cut are not type uses
  tables: TableFact[];
  imports: ImportFact[];
  exportsLocal: { local: string; exported: string; line?: number }[]; // `export { a as b }` without a source
  defaultExport: string | null; // the local name `export default` names
  goPackage: string | null;
  // Java: the declared package (`a.b`), null for the default package.
  // Absent for the other languages.
  javaPackage?: string | null;
  // Each framework plugin's context-free facts of the file, by plugin id
  // (frameworks/plugin.ts); absent when no plugin found anything.
  frameworks?: FrameworkFileFacts;
};

// ---------- the graph ----------

export type GraphNode = ImpactSymbol & { exported: boolean; lang: Lang | null; bodyHash?: string };

export type GraphSite = ImpactSite;

export type EdgeKind = ImpactEdgeKind;

// The edges a caller list walks (Graph.in and Graph.out); the other kinds
// are uses that are not calls (Graph.refsIn and Graph.refsOut).
export const CALLER_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["calls", "inherits", "implements", "dispatches_to", "may_invoke"]);

export type GraphEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  tier: Tier; // the strongest tier among its sites
  sites: GraphSite[];
};

// A call through an interface or a base type: the member it binds to and
// the implementations or overrides it may reach, each a possible
// dispatches_to edge. At most DISPATCH_CAP candidates are kept, in path
// order; `total` counts every one, and the rest is an unknown
// fan-out-capped at the site.
export type DispatchSite = {
  file: string;
  line: number;
  column: number;
  caller: string; // symbol id, or the file for top-level code
  name: string; // the member called
  declared: string[]; // the definition the call binds to
  candidates: string[]; // ids of the implementations or overrides kept
  total: number;
  rule: "dispatch-implements" | "dispatch-override";
};

// What a function does with its parameters and what it returns, read from
// its body: the parameters it calls, the functions it returns by name, and
// whether it also returns something else (then what it returns is not
// known whole). Kept for functions that do any of it; a framework rule
// reads it to decide whether a wrapped handler may run (never that it does).
export type InvocationSummary = { params: string[]; invokes: number[]; returns: string[]; returnsOther: boolean };

// A call site whose evidence named a place (a file, a class, a Go package)
// where no symbol of that name exists now. A removed symbol's surviving
// callers are found here.
export type Miss = { target: string; name: string; from: string; site: GraphSite };

// A call site no rule could bind, kept small: the full Unknown record of
// model/records.ts is made from it when an answer shows it. `scope`
// "project": the call goes through a value (a parameter, a computed
// member), so it could reach any function of its project.
export type UnknownSite = {
  file: string;
  line: number;
  column: number;
  name: string; // "" for a computed callee
  cause: Cause;
  shape: Shape;
  caller: string; // symbol id, or the file for top-level code
  scope: "file" | "project";
  note?: string;
  candidates?: string[];
};

// An eligible file the graph did not read, and why.
export type NotRead = { file: string; reason: "size" | "budget" | "parse-cap" | "memory" | "parse-error" | "slow-parse" | "unreadable" };

export type GraphStatus = {
  status: "ok" | "partial";
  reason: string | null;
  reasons: string[];
  filesParsed: number; // files in the graph: facts from a parse or the cache
  filesSkipped: number; // eligible but left out (size, budget, parse cap, memory)
  durationMs: number;
  eligibleFiles: number;
  cacheHits: number;
  parses: number; // files actually parsed this build (cache misses)
  unresolvedSites: number; // call sites in the repository no rule bound
  externalSites: number; // calls into declared dependencies and standard libraries
  mode: "fresh" | "retained";
  generation: string | null; // the build id the store published, null when not saved
  predictedMs: number | null;
  stages: Record<string, number>;
  cuts: Cut[];
  notRead: NotRead[];
};

export type Graph = {
  repoRoot: string; // the folder the files were read from
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[]; // the callers profile: calls, inherits, implements, dispatches_to, may_invoke
  in: Map<string, GraphEdge[]>;
  out: Map<string, GraphEdge[]>;
  // Uses that are not calls: overrides, uses_value, uses_type.
  references: GraphEdge[];
  refsIn: Map<string, GraphEdge[]>;
  refsOut: Map<string, GraphEdge[]>;
  dispatch: DispatchSite[]; // every call that fanned out, with its candidates
  summaries: Map<string, InvocationSummary>; // per function id

  importers: Map<string, GraphEdge[]>; // target file or Go package folder to its import edges
  defsByFile: Map<string, GraphNode[]>; // current symbols per file
  removed: Map<string, GraphNode[]>; // per changed file: symbols in the base version and gone now; `movedTo` on a move the build found
  misses: Miss[];
  unknowns: UnknownSite[];
  // In-repo unbound call sites per called name, and value calls per project
  // folder: what makes a caller count a floor.
  unknownNames: Map<string, number>;
  valueCalls: Map<string, number>;
  model: ProjectModel;
  // Go module paths by folder, as the build read them: with `model`, what
  // the index needs to give back `projectOf`.
  goModules: [string, string][];
  projectOf(file: string): string;
  exportChanges: ImpactExportChange[]; // set when the build compared a base; every consumer, never cut
  status: GraphStatus;
  // What the framework plugins found (frameworks/stage.ts); absent when the
  // framework stage did not run. Read through frameworks/layer.ts.
  frameworks?: FrameworkData;
};

export type HotSymbol = { symbol: GraphNode; callers: number; sites: number; files: number };
