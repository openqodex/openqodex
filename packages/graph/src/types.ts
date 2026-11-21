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
  // With `result`: the value is one element of what the call returns, which
  // must be declared as an array or a set (`for (const s of all())`).
  item?: boolean;
  values?: TypeRef; // Map<K, V> and ReadonlyMap: V, read only through `values()`
  // With `result`: not what the call returns but the declared type of
  // parameter `param` of the function the call takes as argument `arg`
  // (`span("x", (s) => ...)` with `span(name, fn: (s: Span) => T)`).
  callback?: { arg: number; param: number };
  declared?: boolean;
  // A TypeScript local given a member without an annotation: the member's
  // type, so the value may be of any class below it, as a field's is; unlike
  // `declared`, an assignment to the local ends it.
  member?: boolean;
  bound?: BoundImport;
  rel?: "implements" | "include" | "prepend" | "extend";
  args?: TypeRef[]; // Java and TypeScript type arguments, in declaration order.
  kind?: "param"; // A Java result, or a TypeScript member, naming a class or interface type parameter.
  param?: number; // The class type parameter's index.
  // TypeScript only. `fields`: an object type written in place (name "{}")
  // or an object literal a function returns, its members' types; a method
  // or a function-typed member is a "{}" with no fields. `path`: the type of
  // these members, read in turn, of the type this names (a name bound by
  // destructuring). `parts`: an intersection (name "&"), each side.
  fields?: Record<string, TypeRef>;
  path?: string[];
  parts?: TypeRef[];
  // On an intersection of one side: `Pick<T, K>` keeps only the members
  // `only` names, `Omit<T, K>` every member but those `omit` names. `open`:
  // K also names keys not written out (`keyof X | "a"`), which may be kept.
  only?: string[];
  omit?: string[];
  open?: boolean;
  // On a function's result: read from what its body returns, not declared.
  inferred?: boolean;
  // With `result`: the call names this file's definition at that index, a
  // function declared inside a function that no file-level name reaches.
  localDef?: number;
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
  // Each parameter declared as a function type: its position and the
  // declared type of each of that function's parameters (null: none, or a
  // type parameter, which the call may fill with any type).
  callbacks?: { arg: number; params: (TypeRef | null)[] }[];
  static?: boolean; // methods called on the class itself: JS `static`, Ruby `def self.x`
  // A hash of the definition without its name, comments and whitespace
  // (top-level definitions and members of top-level classes only).
  bodyHash?: string;
  // A function written in place where a route handler goes (extract.ts,
  // routeHandlerName): the index of the definition it is written in, -1 at
  // the top level. It stays a definition only when a framework plugin binds
  // it; otherwise its calls go back to that definition (inline-fold.ts).
  inlineIn?: number;
  // A TypeScript type alias: the type it stands for (`type Loose = any`).
  alias?: TypeRef;
  // A member declared without a body that runs: a TypeScript interface
  // member or `abstract` method, a Go interface method, a Python method
  // marked @abstractmethod. Calls bind to it as the declared member; it is
  // never a dispatch target.
  abstract?: boolean;
  iface?: boolean; // a TypeScript interface or a Go interface type
  // A TypeScript interface member marked `?` (`close?(): void`): a value of
  // the interface need not have it, so a class matched by shape need not either.
  optional?: boolean;
  // A TypeScript interface declared in `declare module "x"` or `declare
  // global`: it adds members to a type that may come from outside the repository.
  augments?: boolean;
  anonymous?: boolean; // a Java object or enum constant body, never a source-level type name
  pointer?: boolean; // a Go method with a pointer receiver
  // A Java method whose last parameter is varargs (`Object... rest`): it
  // takes any number of arguments from its fixed parameters up.
  varargs?: boolean;
  // A TypeScript interface property typed by a named type (`resolve:
  // ResolveFn`): a member a call may name, which returns what that type's
  // call signature returns. The type as written.
  signature?: TypeRef;
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
  // `other`: any read no other role took (a ternary's side, a spread, a
  // default value). `object`: the name before a dot (`f.bind`, `ns.x`), a
  // use of a function, never of a module. `index`: the name before a
  // computed member (`ns[k]`), a use of a function and of a module.
  role: "arg" | "assign" | "return" | "property" | "element" | "other" | "object" | "index";
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

export type LiteralFact = { line: number; keys: string[]; open?: boolean; unread?: number; by?: string };

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
  // TypeScript and JavaScript: the receiver as written (`deps.sessions`),
  // when it is a name or a member path; what ranks a gap the call leaves.
  hint?: string;
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

// TypeScript and JavaScript: a place where a function may be reached by a
// name the graph cannot follow. `module`: a module loaded in a way the
// reader does not read whole (a pattern with a default, a rest or a nested
// part, a load written in place), by its specifier. `own`: the file's own
// `exports` or `module.exports` read as a value or given a value the reader
// does not read whole. `eval`: a direct `eval(...)` or a `with` statement.
// `global`: code or a name built at run time on the global scope
// (`Function`, an indirect eval, `globalThis[k]`). `load`: a module loaded
// by a computed path, or `require` used other than as a direct call with a
// written path; `names` when only those names of it are read.
export type EscapeFact =
  | { kind: "module"; spec: string; line: number }
  | { kind: "own" | "eval" | "global"; line: number }
  | { kind: "load"; line: number; names?: string[] };

export type FileFacts = {
  lang: Lang;
  defs: DefFact[];
  calls: CallFact[];
  values: ValueRef[];
  types: TypeUse[];
  typeCuts?: number; // annotations too large to read whole: their types past the cut are not type uses
  tables: TableFact[];
  // TypeScript and JavaScript: each object literal that is no definition of
  // the graph (an argument, a returned object, a local) and names a member
  // that may hold code (a method, a function, a name), with those member
  // names, and `open` when it may have others (a spread or a source of
  // Object.assign that is no literal), `unread` the members whose names
  // are not read (computed keys, keys past the cap). `by` names a value
  // given its members in place (`f.get = g`, `Object.assign(f, { get })`).
  // A call through an interface may run such an object's code.
  // `literalsCut`: the file holds more literals than the cap, so any
  // interface call may reach one not listed.
  literals?: LiteralFact[];
  literalsCut?: boolean;
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
  escapes?: EscapeFact[];
  // TypeScript and JavaScript: the module-level variables that are no
  // definition (`const LIMIT = 10`), and those exported as declared
  // (`export const LIMIT`, CommonJS `exports.LIMIT = 10`). An import of one
  // binds a value the graph follows, not a name it could not find.
  variables?: string[];
  exportedVariables?: string[];
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
  rule: "dispatch-implements" | "dispatch-override" | "by-shape";
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
  // The receiver as written and the type it was read as, when known
  // (`sessions any`): which same-name gaps may be a class's callers.
  receiver?: string;
  // The call cannot run a plain function of that name: a bare call of a
  // local or a parameter, `this.x()` where `this` is proved an instance of
  // a class, or a call on a value whose class or interface the graph knows.
  notPlain?: boolean;
};

export type Place = { file: string; line: number };

// Why a function's caller list may miss a caller the graph cannot see, as
// the build found it (impact.ts, floorReasons reads it). `uses`: per
// symbol id, its uses as a value under any of its names, its own body
// included. `unbound`: value uses no rule could bind, by family and name
// (`js:save`). `reach`: per symbol id, each place its module escapes
// (`module`), or a name built at run time may reach it (`eval`, `global`,
// `load` with the name a load by a computed path may read). `modules`:
// every module found escaping, with its place, for the definitions a
// change removed. `loadAny`: the places that may load any module
// (a load by a computed path read for any name, code built at run time),
// and `offered`, then, every definition a module offers.
export type Reach = Place & { why: "module" | "eval" | "global" | "load"; name?: string };
export type Escapes = {
  uses: Map<string, Place & { count: number }>;
  unbound: Map<string, Place & { count: number }>;
  reach: Map<string, Reach[]>;
  modules: Map<string, Place>;
  loadAny: (Place & { why: "load" | "eval" | "global" })[];
  offered: Set<string>;
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
  // Source files of known languages the graph does not parse, by language.
  // Informational: never a reason, never a floor. Absent in a build kept by
  // an older version.
  unreadLanguages?: { language: string; files: number }[];
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
  escapes: Escapes;
  model: ProjectModel;
  // Go module paths by folder, as the build read them: with `model`, what
  // the index needs to give back `projectOf`.
  goModules: [string, string][];
  projectOf(file: string): string;
  exportChanges: ImpactExportChange[]; // set when the build compared a base; every consumer, never cut
  status: GraphStatus;
  // The graph input digest of what the build read (build.ts, captureDigest):
  // set by a build of a work tree, absent on a graph read back from a kept build.
  digest?: string;
  // What the framework plugins found (frameworks/stage.ts); absent when the
  // framework stage did not run. Read through frameworks/layer.ts.
  frameworks?: FrameworkData;
};

export type HotSymbol = { symbol: GraphNode; callers: number; sites: number; files: number };
