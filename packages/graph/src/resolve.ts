// Turns every file's local facts into a graph. A call becomes an edge only
// with evidence: a definition in the same file or Go package, an import that
// names it, a receiver whose type a constructor or an annotation gives, or
// (Ruby) a constant found by the autoload convention. A method call is never
// matched by its name alone. Every call site is kept on its edge, with the
// evidence that bound it and its tier (model/records.ts): a binding is no
// stronger than its weakest step, so a call through a workspace package
// reached by the dist to src convention is likely, never certain.
//
// A call no rule binds is never dropped: it becomes an unknown site with a
// cause (a declared dependency is "external", a value of unknown type is
// "no-receiver-type", a call through a parameter or a computed member is
// "dynamic", ...). An unresolved name alone is never "external": that needs
// a declared dependency or a standard library module.
//
// Every cross-file read goes through the `index` object below (the exports
// of a module, the bindings of a file, the members of a class, the module a
// specifier names), so a later phase can record what each file's resolution
// read. Everything is maps keyed by name or path: no step scans every file
// for every call, so resolution stays linear in the number of call sites.
import { dirname, posix } from "node:path";
import type { ImpactKind } from "@openqodex/core";
import type { ProjectModel } from "./discovery/projects.js";
import { governingTsconfig, isGoStdlib, isNodeBuiltin, isPyStdlib, isRubyStdlib, linkageOf, metadataUnknown, nodeProjectOf, normalisePy, packageName, pathLinkOff } from "./discovery/projects.js";
import type { Cause, Cut, EvidenceKind, Shape, Tier, Via } from "./model/records.js";
import { weakest } from "./model/records.js";
import type { Lookup as PluginLookup } from "./frameworks/plugin.js";
import type { BoundImport, CallFact, DefFact, DispatchSite, EdgeKind, Family, FileFacts, GraphEdge, GraphNode, GraphSite, InvocationSummary, Miss, TypeRef, UnknownSite, ValueRef } from "./types.js";
import { CALLER_KINDS, MAX_TYPE_DEPTH, familyOf } from "./types.js";

const MAX_DEPTH = 8; // re-export and base-class chains
// Files the walk of `export *` may open in one world. Each file is walked
// once (its names are kept), so this bounds only a walk through cycles or a
// barrel chain longer than any real repository holds.
export const EXPORT_WALK_STEPS = 4096;
// Export lookups one name may make before it stops. A lookup is kept once
// it finished cleanly, so this bounds only a web of `export *` that loops
// back on itself, which no cache can shorten.
export const EXPORT_LOOKUP_STEPS = 10_000;
export const HUB_FILES = 8; // a name defined in more files never binds without evidence
// A call through an interface or a base type keeps at most this many
// implementations or overrides as possible targets; the rest is a gap.
export const DISPATCH_CAP = 32;
// 8: dispatch through interfaces and base types, language lookup orders
// (Python C3, Go embedding depth, Ruby mixins), value and type uses,
// may_invoke, overrides and implements. 9: a dynamic-base gap on each class
// that names a base with an expression. 10: such a base keeps its place in
// the lookup order, so a member found past it is likely at most. 11: Java
// (declared packages, imports, overloads by argument count, nested types).
// 12: a Java call on a typed value's method result (TypeRef.on). 13: Java
// constructor calls, source sets by folder, overloads across both sides.
// 14: abstract members kept below a body, static-import evidence per member.
// 15: qualified names before external star imports, star imports of a
// class, the java.lang classes. 16: source sets by source root first, no
// import from the default package.
export const RESOLVER_VERSION = 17;

// How a base written as an expression stands in a lookup order.
const DYNAMIC_BASE = "\u0000a base written as an expression";

// The java.lang names a Java file sees without an import.
const JAVA_LANG = (
  "Object String StringBuilder StringBuffer CharSequence Math StrictMath System Thread ThreadLocal Runnable Iterable Comparable Cloneable AutoCloseable Readable Appendable " +
  "Integer Long Short Byte Double Float Boolean Character Number Void Class Enum Record ClassLoader Process ProcessBuilder Runtime StackTraceElement " +
  "Override Deprecated SuppressWarnings FunctionalInterface SafeVarargs " +
  "Throwable Exception RuntimeException Error IllegalArgumentException IllegalStateException NullPointerException UnsupportedOperationException " +
  "IndexOutOfBoundsException ArrayIndexOutOfBoundsException StringIndexOutOfBoundsException ArithmeticException ClassCastException NumberFormatException " +
  "InterruptedException CloneNotSupportedException ReflectiveOperationException ClassNotFoundException NoSuchMethodException NoSuchFieldException " +
  "IllegalAccessException InstantiationException SecurityException NegativeArraySizeException ArrayStoreException " +
  "AssertionError OutOfMemoryError StackOverflowError LinkageError NoClassDefFoundError ExceptionInInitializerError VirtualMachineError"
).split(" ");

const BUILTINS: Record<Family, ReadonlySet<string>> = {
  js: new Set(
    "require console setTimeout setInterval clearTimeout clearInterval setImmediate parseInt parseFloat isNaN isFinite String Number Boolean Array Object Promise Symbol Error TypeError RangeError SyntaxError Map Set WeakMap WeakSet Date RegExp JSON Math Reflect Proxy BigInt encodeURIComponent decodeURIComponent encodeURI decodeURI structuredClone fetch queueMicrotask describe it test expect beforeEach afterEach beforeAll afterAll jest vi process Buffer URL URLSearchParams TextEncoder TextDecoder AbortController Uint8Array ArrayBuffer Intl globalThis window document Function Int8Array Int16Array Int32Array Uint16Array Uint32Array Uint8ClampedArray Float32Array Float64Array BigInt64Array BigUint64Array DataView SharedArrayBuffer Atomics WeakRef FinalizationRegistry AggregateError EvalError ReferenceError URIError eval escape unescape performance crypto atob btoa Blob File FormData Headers Request Response Event EventTarget CustomEvent MessageChannel clearImmediate setImmediate module exports __dirname __filename WebAssembly".split(
      " ",
    ),
  ),
  python: new Set(
    "print len range str int float bool list dict set tuple isinstance issubclass super getattr setattr hasattr delattr type open repr sorted enumerate zip map filter any all min max sum abs iter next id hash callable format vars round object Exception ValueError TypeError KeyError IndexError RuntimeError NotImplementedError AttributeError ImportError OSError StopIteration AssertionError staticmethod classmethod property divmod chr ord bytes bytearray frozenset globals locals dir input reversed slice memoryview complex pow hex oct bin compile eval exec breakpoint ascii".split(
      " ",
    ),
  ),
  go: new Set(
    "append cap clear close complex copy delete imag len make max min new panic print println real recover string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 byte rune bool error any complex64 complex128".split(
      " ",
    ),
  ),
  ruby: new Set(
    "puts print p pp require require_relative raise fail lambda proc loop attr_accessor attr_reader attr_writer private protected public module_function include extend prepend new freeze format sprintf block_given? yield define_method send public_send respond_to? is_a? kind_of? instance_of? nil? to_s to_i to_f to_a to_h to_sym each map select reject find each_with_object inject reduce tap then dup clone catch throw sleep rand srand gets binding caller exit abort at_exit Integer Float String Array Hash Rational Complex".split(
      " ",
    ),
  ),
  // java.lang: every file sees these names without an import.
  java: new Set(JAVA_LANG),
};

// Built-in types whose methods are the language's: a call on a value of
// one is external, never a gap of the repository.
const BUILTIN_TYPES: Record<Family, ReadonlySet<string>> = {
  js: new Set(
    "string number boolean bigint symbol never void undefined null String Number Boolean BigInt Symbol Object Array ReadonlyArray Map ReadonlyMap Set ReadonlySet WeakMap WeakSet Promise PromiseLike Date RegExp Error TypeError RangeError Function Record Partial Required Readonly Pick Omit Iterable IterableIterator AsyncIterable AsyncIterableIterator Iterator Generator AsyncGenerator ArrayBuffer SharedArrayBuffer DataView Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array BigInt64Array BigUint64Array Buffer URL URLSearchParams AbortController AbortSignal TextEncoder TextDecoder".split(" "),
  ),
  python: new Set("str int float bool bytes bytearray list dict set frozenset tuple complex List Dict Set FrozenSet Tuple Sequence Mapping MutableMapping MutableSequence Iterable Iterator".split(" ")),
  go: new Set("string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 byte rune bool error".split(" ")),
  ruby: new Set("String Integer Float Array Hash Symbol Range Proc".split(" ")),
  java: new Set(JAVA_LANG),
};

// TypeScript's types that say nothing about a value's methods: keywords no
// declaration can rebind, and "{}", which the extractor writes for an
// object type written in place. A call on a value of one may reach any
// method of that name, so it is an untyped receiver, never external and
// never bound. Python's and Go's are known by what binds them (untypedType).
const JS_UNTYPED: ReadonlySet<string> = new Set(["any", "unknown", "object", "{}"]);
// The modules whose `Any` is Python's untyped type.
const TYPING: ReadonlySet<string> = new Set(["typing", "typing_extensions"]);

export type FileInput = { path: string; facts: FileFacts };

// The evidence a value carries: how it was bound, how surely, through which line.
type Ev = { kind: EvidenceKind; tier: Tier; via: Via | null; note: string | null; rule: string };

const SAME_SCOPE: Ev = { kind: "same-scope", tier: "certain", via: null, note: null, rule: "same-scope" };

// A name followed through more re-exports or aliases than MAX_DEPTH: the
// graph stops there and says so, never a miss or an untyped value.
const TOO_DEEP = { v: "gap", cause: "export-chain-too-deep", note: `the name is re-exported or aliased through more than ${MAX_DEPTH} modules; the graph stops following it there`, candidates: null } as const;
const LOOKUP_CUT = {
  v: "gap",
  cause: "export-chain-too-deep",
  note: `the lookup passed ${EXPORT_LOOKUP_STEPS.toLocaleString("en-US")} steps through export * that loops back on itself; the graph stops there`,
  candidates: null,
} as const;

// A branch of an `export *` set the graph could not follow: what it was
// and why. It may bring the name too.
type Unfollowed = { spec: string; cause: Cause; note: string };

// A step through a module: the outer binding (the import the call read)
// keeps its kind and line; the tier is the weaker of the two and the notes
// add up.
function chain(outer: Ev | null, inner: Ev): Ev {
  if (outer === null) return inner;
  const notes = [outer.note, inner.note].filter((n): n is string => n !== null && n !== "");
  return { kind: outer.kind, tier: weakest(outer.tier, inner.tier), via: outer.via ?? inner.via, note: notes.length > 0 ? [...new Set(notes)].join(" ") : null, rule: outer.rule };
}

// What a module specifier names.
type Mod =
  | { file: string; ev: Ev } // a file in the repository (Go: a package folder)
  | { ext: string } // a declared dependency or a standard library module
  | { gap: Cause; note: string; candidates: string[] | null }
  | null; // a path specifier that names nothing here: a miss

// What a name or an expression stands for.
type Value =
  | { v: "sym"; ids: string[]; ev: Ev }
  | { v: "mod"; file: string; ev: Ev }
  | { v: "pkg"; dir: string; ev: Ev }
  | { v: "pyns"; dir: string; ev: Ev } // a Python namespace package: a folder without __init__.py
  | { v: "pymod"; from: string; dotted: string } // Python `import a.b`: a dotted module path
  | { v: "ext" }
  | { v: "gap"; cause: Cause; note: string; candidates: string[] | null }
  | { v: "miss"; target: string; name: string; ev: Ev };

type Def = DefFact & { id: string; file: string; family: Family };

// `dynamic`: the bases written as expressions the facts cannot name.
// `scope`: a Java type's own dotted path (`Outer.Inner`), the scope its members are read in.
type ClassInfo = { file: string; family: Family; ids: string[]; files: Set<string>; bases: TypeRef[]; dynamic: NonNullable<DefFact["dynamicBases"]>; fields: Map<string, TypeRef>; nesting: string | null; scope?: string };

export type ResolveInput = {
  files: FileInput[];
  known: ReadonlySet<string>; // every path import resolution may land on: eligible files and removed ones
  model: ProjectModel;
  goModules: [string, string][]; // module path, folder ("" for the root)
  // Checked between files while calls are resolved: true stops; the files
  // left are listed in `budgetFiles`.
  stop?: () => boolean;
};

export type Resolved = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[]; // the callers profile
  references: GraphEdge[]; // overrides, uses_value, uses_type
  dispatch: DispatchSite[];
  summaries: Map<string, InvocationSummary>;
  importers: Map<string, GraphEdge[]>;
  defsByFile: Map<string, GraphNode[]>;
  misses: Miss[];
  unknowns: UnknownSite[];
  unresolvedSites: number;
  externalSites: number;
  budgetFiles: string[]; // files whose calls were not resolved: the budget ran out
};

// One call site or import binding, resolved with a record of the exports it
// read on the way: what the export diff compares between two worlds.
export type SiteTrace = { file: string; line: number; column: number; from: string; reads: string[]; targets: string[] | null };

// An exported name's target: the stable keys of the definitions it names,
// or "ext" for a name a declared dependency supplies.
export type ExportTarget = { keys: string[]; ids: string[] } | "ext";

export type World = {
  resolveAll(): Resolved;
  // Call sites and import bindings of these files, resolved with the
  // exports each read.
  trace(files: Iterable<string>): SiteTrace[];
  // Every name the module exports and what it names; null for a name the
  // module lists but that resolves to nothing.
  surface(file: string): Map<string, { target: ExportTarget | null; line: number | null }>;
  // The modules a file's imports and re-exports name (in-repo only), and
  // whether each is a re-export.
  importsOf(file: string): { target: string; reexport: boolean }[];
  // The node of an id or a stable key (the first of its overloads).
  node(idOrKey: string): GraphNode | null;
  // The cuts the walk of `export *` made in this world (at most one).
  walkCuts(): Cut[];
  // For the framework layer (frameworks/plugin.ts, PluginIndex): what a
  // dotted name means at the top level of a file, and which file a module
  // specifier names from a file. Read-only; the same rules as call binding.
  lookup(file: string, path: readonly string[]): PluginLookup;
  moduleLookup(file: string, spec: string): PluginLookup;
};

export function symbolId(file: string, d: Pick<DefFact, "owner" | "name" | "line" | "column">): string {
  return `${file}#${d.owner ? `${d.owner}.` : ""}${d.name}@${d.line}:${d.column}`;
}

// A symbol id without its position: equal across two versions of a file
// whose lines moved. Overloads share it.
export function stableKey(id: string): string {
  const at = id.lastIndexOf("@");
  return id.includes("#") && at > id.indexOf("#") ? id.slice(0, at) : id;
}

function dirOf(path: string): string {
  const d = dirname(path);
  return d === "." ? "" : d;
}

function join(...parts: string[]): string {
  const j = posix.normalize(posix.join(...parts.filter((p) => p !== "")));
  return j === "." ? "" : j;
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function resolveGraph(input: ResolveInput): Resolved {
  return createWorld(input).resolveAll();
}

export function createWorld(input: ResolveInput): World {
  const facts = new Map<string, FileFacts>();
  for (const f of input.files) facts.set(f.path, f.facts);
  const model = input.model;

  const nodes = new Map<string, GraphNode>();
  const defsByFile = new Map<string, GraphNode[]>();
  const defById = new Map<string, Def>();
  const topByFile = new Map<string, Map<string, string[]>>();
  const pkgTop = new Map<string, Map<string, string[]>>(); // Go package (folder, or folder#test) to name to ids
  const pkgName = new Map<string, string>(); // Go folder to package name
  const classes = new Map<string, ClassInfo>();
  const classOfId = new Map<string, string>();
  // Methods per class key and name, one map per side: called on the class
  // itself ("s") and on an instance ("i").
  const methodsOn = { s: new Map<string, Map<string, string[]>>(), i: new Map<string, Map<string, string[]>>() };
  const rbTop = new Map<string, string[]>(); // Ruby methods outside any class
  // Java: the top-level types of each declared package by simple name (every
  // project and source set), and the nested types of each file by simple name.
  const javaTypes = new Map<string, Map<string, string[]>>();
  const javaNested = new Map<string, Map<string, string[]>>();
  const javaLocalClasses = new Set<string>();
  const filesByName = new Map<string, Set<string>>(); // family:name to defining files

  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const nameIndex = (m: Map<string, Map<string, string[]>>, k: string) => {
    let inner = m.get(k);
    if (!inner) {
      inner = new Map();
      m.set(k, inner);
    }
    return inner;
  };

  // A Go package is its folder; an external test package (`package x_test`)
  // in the same folder is a package of its own.
  const pkgOf = (file: string): string => {
    const pkg = facts.get(file)?.goPackage;
    return pkg?.endsWith("_test") ? `${dirOf(file)}#test` : dirOf(file);
  };

  // A Java type: its declaring file (which fixes its project, source set
  // and package) and its path through the enclosing types. Java has no
  // partial classes, so two declarations of one qualified name (two
  // projects, a main and a test copy) are two classes and never merge.
  const javaPkgOf = (file: string): string => facts.get(file)?.javaPackage ?? "";
  const classKey = (family: Family, file: string, qualified: string) => {
    if (family === "ruby") return `rb::${qualified}`;
    if (family === "go") return `go:${pkgOf(file)}::${qualified}`;
    if (family === "java") return `java:${file}::${qualified}`;
    return `${file}::${qualified}`;
  };
  // Methods called on the class itself ("s") and on an instance ("i") are
  // indexed apart; Python methods are reachable both ways.
  type Side = "s" | "i";


  // ---------- index the definitions ----------
  for (const { path, facts: f } of input.files) {
    const family = familyOf(f.lang);
    const lineCount = f.defs.reduce((m, d) => Math.max(m, d.endLine), 1);
    nodes.set(path, { id: path, file: path, name: posix.basename(path), kind: "file", startLine: 1, endLine: lineCount, snapshot: "current", exported: true, lang: f.lang });
    if (family === "go" && f.goPackage && !f.goPackage.endsWith("_test") && !pkgName.has(dirOf(path))) pkgName.set(dirOf(path), f.goPackage);
    const list: GraphNode[] = [];
    for (const d of f.defs) {
      const id = symbolId(path, d);
      const node: GraphNode = { id, file: path, name: d.name, kind: d.kind as ImpactKind, startLine: d.line, endLine: d.endLine, snapshot: "current", exported: d.exported, lang: f.lang };
      if (d.bodyHash) node.bodyHash = d.bodyHash;
      nodes.set(id, node);
      list.push(node);
      defById.set(id, { ...d, id, file: path, family });
      let names = filesByName.get(`${family}:${d.name}`);
      if (!names) filesByName.set(`${family}:${d.name}`, (names = new Set()));
      names.add(path);
      if (d.kind === "method") {
        const key = classKey(family, path, d.owner ?? "");
        // A method of an object literal made a module runs on the module
        // itself and on whatever value the literal is given to (an object
        // typed by an interface it implements).
        const both = family === "python" || (family === "js" && d.static === true && classes.get(key)?.ids.every((x) => defById.get(x)?.kind === "module") === true);
        // A Java constructor is called on the class (`new T()`), never on an instance.
        const onType = d.static === true || (family === "java" && d.ctor === true);
        if (both || onType) push(nameIndex(methodsOn.s, key), d.name, id);
        if (both || !onType) push(nameIndex(methodsOn.i, key), d.name, id);
      } else if (family === "go") {
        if (d.topLevel) push(nameIndex(pkgTop, pkgOf(path)), d.name, id);
      } else if (family === "ruby" && d.kind === "function") {
        push(rbTop, d.name, id);
      } else if (d.topLevel) {
        push(nameIndex(topByFile, path), d.name, id);
      }
      // A nested definition is reached only through the scopes that declare it (CallFact.local).
      if (d.kind === "class" || d.kind === "module" || d.kind === "type") {
        const qualified = family === "ruby" && d.owner ? `${d.owner}::${d.name}` : family === "java" && d.owner ? `${d.owner}.${d.name}` : d.name;
        const key = classKey(family, path, qualified);
        classOfId.set(id, key);
        let info = classes.get(key);
        if (!info) {
          info = { file: path, family, ids: [], files: new Set(), bases: [], dynamic: [], fields: new Map(), nesting: d.owner };
          if (family === "java") info.scope = qualified;
          classes.set(key, info);
        }
        if (family === "java") {
          const ownerKey = d.owner === null ? null : classKey("java", path, d.owner);
          if (ownerKey !== null && (!classes.has(ownerKey) || javaLocalClasses.has(ownerKey) || classes.get(ownerKey)?.ids.some((o) => defById.get(o)?.anonymous))) javaLocalClasses.add(key);
          if (d.owner === null) push(nameIndex(javaTypes, javaPkgOf(path)), d.name, id);
          else if (!javaLocalClasses.has(key) && !d.anonymous) push(nameIndex(javaNested, path), d.name, id);
        }
        info.ids.push(id);
        info.files.add(path);
        info.bases.push(...d.bases);
        if (d.dynamicBases) info.dynamic.push(...d.dynamicBases);
        for (const [k, t] of Object.entries(d.fields)) info.fields.set(k, t);
      }
    }
    defsByFile.set(path, list);
  }

  // ---------- module resolution ----------
  const known = input.known;
  const viaOf = (from: string, line: number, spec: string): Via => ({ file: from, line, spec });

  const jsCandidates = (base: string): string | null => {
    if (known.has(base)) return base;
    const swapped = base.replace(/\.(m|c)?jsx?$/, (_m, k: string | undefined) => `.${k ?? ""}ts`);
    if (swapped !== base) {
      if (known.has(swapped)) return swapped;
      if (known.has(`${swapped}x`)) return `${swapped}x`;
    }
    for (const ext of JS_EXTS) if (known.has(base + ext)) return base + ext;
    for (const ext of JS_EXTS) if (known.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  };

  // A `paths` pattern match: the longest prefix wins, as TypeScript picks.
  const matchPaths = (paths: [string, string[]][], spec: string): { targets: string[]; rest: string } | null => {
    let best: { targets: string[]; rest: string; len: number } | null = null;
    for (const [pattern, targets] of paths) {
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (pattern === spec && (!best || pattern.length > best.len)) best = { targets, rest: "", len: pattern.length };
      } else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length && (!best || pre.length > best.len)) {
          best = { targets, rest: spec.slice(pre.length, spec.length - post.length), len: pre.length };
        }
      }
    }
    return best;
  };

  // The entry an `exports` value selects for the active conditions, in the
  // object's own key order (Node's rule): a string, or the first key whose
  // condition is active. `types` is never active: a declaration file is
  // not an implementation.
  const pickExport = (value: unknown, active: ReadonlySet<string>, depth = 0): { target: string; condition: string | null } | null => {
    if (depth > 8) return null;
    if (typeof value === "string") return { target: value, condition: null };
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = pickExport(v, active, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "types" || !active.has(k)) continue;
      const hit = pickExport(v, active, depth + 1);
      if (hit) return { target: hit.target, condition: hit.condition ?? k };
    }
    return null;
  };

  // The `exports` entry for a subpath ("." or "./sub"), with `./*` patterns.
  const exportsEntry = (exportsField: unknown, sub: string): unknown => {
    if (typeof exportsField === "string" || Array.isArray(exportsField)) return sub === "." ? exportsField : undefined;
    if (typeof exportsField !== "object" || exportsField === null) return undefined;
    const map = exportsField as Record<string, unknown>;
    const keys = Object.keys(map);
    if (!keys.some((k) => k.startsWith("."))) return sub === "." ? exportsField : undefined; // conditions at the top: the "." entry
    if (sub in map) return map[sub];
    for (const k of keys) {
      const star = k.indexOf("*");
      if (star === -1) continue;
      const pre = k.slice(0, star);
      const post = k.slice(star + 1);
      if (sub.startsWith(pre) && sub.endsWith(post)) {
        const rest = sub.slice(pre.length, sub.length - post.length);
        const replace = (v: unknown): unknown =>
          typeof v === "string" ? v.replaceAll("*", rest) : Array.isArray(v) ? v.map(replace) : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, replace(b)])) : v;
        return replace(map[k]);
      }
    }
    return undefined;
  };

  // A built file of a member mapped back to its source: through the member
  // tsconfig's outDir and rootDir when both are set, else `dist/` (or
  // `build/`, `lib/`) to `src/`.
  const builtToSource = (memberDir: string, built: string): string | null => {
    const config = model.tsconfigs.get(memberDir);
    const strip = built.replace(/\.d\.[cm]?ts$/, ".js");
    if (config?.outDir && config.rootDir && strip.startsWith(`${config.outDir}/`)) {
      const hit = jsCandidates(join(config.rootDir, strip.slice(config.outDir.length + 1)).replace(/\.[cm]?js$/, ""));
      if (hit) return hit;
    }
    const rel = strip.slice(memberDir === "" ? 0 : memberDir.length + 1);
    const m = /^(dist|build|lib|out)\/(.*)$/.exec(rel);
    if (!m) return null;
    return jsCandidates(join(memberDir, "src", (m[2] as string).replace(/\.[cm]?jsx?$/, "")));
  };

  // A bare specifier that names a workspace package.
  const workspaceSpec = (from: string, line: number, spec: string, name: string): Mod => {
    const members = model.members.get(name) ?? [];
    const via = viaOf(from, line, spec);
    if (members.length > 1) return { gap: "ambiguous", note: `${members.length} workspace packages are named ${name}`, candidates: members.map((m) => m.dir) };
    const member = members[0];
    if (!member) return null;
    // A package importing itself by name (Node resolves a self-reference through its own exports).
    const self = nodeProjectOf(model, from)?.dir === member.dir;
    const link = self ? { linkage: "workspace" as const, declaredIn: member.file, spec: "itself" } : linkageOf(model, from, name);
    if (link === null) {
      return { gap: "ambiguous", note: `the package of this file does not declare ${name}, so the workspace package ${member.dir} is not assumed`, candidates: [member.dir] };
    }
    if (link.linkage === "published") return { ext: name };
    const off = pathLinkOff(link, name, member.dir);
    if (off === "outside") return { ext: name };
    if (off !== null) return { gap: "unsupported-rule", note: off.note, candidates: [member.dir] };
    const linkNote = link.linkage === "unknown" ? `${link.declaredIn} declares ${name} as ${link.spec} and no lockfile says it links the workspace package.` : null;
    const capped = (ev: Ev): Ev => (linkNote ? { ...ev, tier: weakest(ev.tier, "likely"), note: [ev.note, linkNote].filter(Boolean).join(" ") } : ev);
    const sub = spec.length > name.length ? `.${spec.slice(name.length)}` : ".";
    const gov = governingTsconfig(model, from);
    const referenced = gov?.config.references.some((r) => r === member.dir) ?? false;
    const active = new Set(["import", "node", "default", "module", ...(gov?.config.customConditions ?? [])]);
    const missing = `no tsconfig paths, project reference or active source condition maps ${name} to its source`;
    // The entry the package declares, through `exports`, then `module` and `main`.
    let entry: string | null = null;
    let condition: string | null = null;
    if (member.pkg.exports !== null) {
      // An exports map is the whole public surface: a path it does not
      // expose, under the conditions this import uses, is refused by Node.
      const listed = exportsEntry(member.pkg.exports, sub);
      const picked = listed === undefined ? null : pickExport(listed, active);
      if (!picked) {
        const what = sub === "." ? "its root" : sub;
        return {
          gap: "not-exported",
          note: `${member.file} has an exports map that does not expose ${what}${listed === undefined ? "" : " under the conditions this import uses"}`,
          candidates: [member.dir],
        };
      }
      entry = join(member.dir, picked.target);
      condition = picked.condition;
    } else if (sub === ".") {
      const field = member.pkg.module ?? member.pkg.main;
      if (field) entry = join(member.dir, field);
    }
    if (entry !== null) {
      const direct = jsCandidates(entry.replace(/\.[cm]?jsx?$/, "")) === entry || known.has(entry) ? entry : null;
      if (direct) {
        // The declared entry is a source file of the repository.
        const rule = condition === null ? "workspace-main" : `workspace-exports-${condition}`;
        return { file: direct, ev: capped({ kind: "workspace-package", tier: "certain", via, note: null, rule }) };
      }
      const source = builtToSource(member.dir, entry);
      if (source) {
        if (referenced) return { file: source, ev: capped({ kind: "workspace-package", tier: "certain", via, note: null, rule: "workspace-references" }) };
        return {
          file: source,
          ev: capped({ kind: "workspace-package", tier: "likely", via, note: `Bound through ${name}'s entry ${entry}, built from ${source}; ${missing}.`, rule: "workspace-dist-src" }),
        };
      }
    }
    if (sub === ".") {
      for (const fallback of ["src/index", "index"]) {
        const hit = jsCandidates(join(member.dir, fallback));
        if (hit) {
          return { file: hit, ev: capped({ kind: "workspace-package", tier: "likely", via, note: `Bound to ${hit} by the src/index convention; ${missing}.`, rule: "workspace-index" }) };
        }
      }
    } else if (member.pkg.exports === null) {
      // No exports map: Node finds a subpath by the package's folder layout.
      const hit = jsCandidates(join(member.dir, sub.slice(2)));
      if (hit) return { file: hit, ev: capped({ kind: "workspace-package", tier: "certain", via, note: null, rule: "workspace-subpath" }) };
    }
    return { gap: "unsupported-rule", note: `the entry of the workspace package ${name} could not be mapped to a source file`, candidates: [member.dir] };
  };

  const jsSpec = (from: string, line: number, spec: string): Mod => {
    const via = viaOf(from, line, spec);
    if (spec.startsWith(".")) {
      const hit = jsCandidates(join(dirOf(from), spec));
      return hit ? { file: hit, ev: { kind: "import", tier: "certain", via, note: null, rule: "js-relative" } } : null;
    }
    const gov = governingTsconfig(model, from);
    if (gov) {
      const { config, admits } = gov;
      const tier: Tier = admits ? "certain" : "likely";
      const note = admits ? null : `${config.file} governs this file by its folder, but its files, include and exclude do not list it.`;
      const best = config.paths.length > 0 ? matchPaths(config.paths, spec) : null;
      if (best) {
        for (const t of best.targets) {
          const hit = jsCandidates(join(config.pathsBase, t.replace("*", best.rest)));
          if (hit) return { file: hit, ev: { kind: "ts-paths", tier, via, note, rule: "ts-paths" } };
        }
      }
      if (config.baseUrl !== null) {
        const hit = jsCandidates(join(config.baseUrl, spec));
        if (hit) return { file: hit, ev: { kind: "ts-paths", tier, via, note, rule: "ts-baseurl" } };
      }
    }
    if (isNodeBuiltin(spec)) return { ext: spec };
    const name = packageName(spec);
    const ws = workspaceSpec(from, line, spec, name);
    if (ws !== null) return ws;
    // Not in the repository: external only when a package.json declares it,
    // and not by a path into a folder of the repository.
    const declared = linkageOf(model, from, name);
    if (declared !== null) {
      const off = pathLinkOff(declared, name, null);
      return off === null || off === "outside" ? { ext: name } : { gap: "unsupported-rule", note: off.note, candidates: null };
    }
    return { gap: "miss", note: `the module ${name} is not in the repository and no package.json declares it`, candidates: null };
  };

  const pyRoots = new Map<string, string[]>();
  const pyWalkRoots = (from: string): string[] => {
    const dir = dirOf(from);
    let roots = pyRoots.get(dir);
    if (roots) return roots;
    roots = [];
    let d = dir;
    for (;;) {
      if (!known.has(join(d, "__init__.py"))) roots.push(d);
      if (d === "") break;
      d = dirOf(d);
    }
    pyRoots.set(dir, roots);
    return roots;
  };
  const pyModule = (base: string): string | null => {
    if (known.has(`${base}.py`)) return `${base}.py`;
    if (known.has(join(base, "__init__.py"))) return join(base, "__init__.py");
    return null;
  };
  // Folders that hold Python files: a folder without __init__.py among
  // them is a namespace package.
  const pyDirs = new Set<string>();
  for (const k of known) {
    if (!k.endsWith(".py")) continue;
    for (let d = dirOf(k); d !== "" && !pyDirs.has(d); d = dirOf(d)) pyDirs.add(d);
  }
  type PyHit = { file: string } | { ns: string };
  const pyFind = (root: string, rest: string): PyHit | null => {
    const file = pyModule(join(root, rest));
    if (file) return { file };
    const dir = join(root, rest);
    return rest !== "" && pyDirs.has(dir) ? { ns: dir } : null;
  };
  const pySpec = (from: string, line: number, spec: string): Mod | { ns: string; ev: Ev } => {
    const via = viaOf(from, line, spec);
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
    if (dots > 0) {
      let d = dirOf(from);
      for (let i = 1; i < dots; i++) d = dirOf(d);
      const hit = pyModule(join(d, rest));
      return hit ? { file: hit, ev: { kind: "import", tier: "certain", via, note: null, rule: "py-relative" } } : null;
    }
    // Every module the name finds, from the importer's own folders and from
    // the source roots of the repository's projects: one binds, several are
    // ambiguous. A module or a regular package wins over a namespace
    // package wherever it is, as Python's path finder does.
    const files = new Map<string, string>(); // file to the rule that found it
    for (const root of pyWalkRoots(from)) {
      const hit = pyModule(join(root, rest));
      if (hit && !files.has(hit)) files.set(hit, "py-walk-root");
    }
    const spaces = new Set<string>();
    for (const root of model.pyRoots) {
      const hit = pyFind(root, rest);
      if (hit && "file" in hit && !files.has(hit.file)) files.set(hit.file, "py-src-root");
      else if (hit && "ns" in hit) spaces.add(hit.ns);
    }
    if (files.size === 1) {
      const [file, rule] = [...files.entries()][0] as [string, string];
      return { file, ev: { kind: "py-root", tier: "certain", via, note: null, rule } };
    }
    if (files.size > 1) return { gap: "ambiguous", note: `${rest.replaceAll("/", ".")} is found in ${files.size} places on the import path`, candidates: [...files.keys()].sort() };
    if (spaces.size === 1) return { ns: [...spaces][0] as string, ev: { kind: "py-root", tier: "certain", via, note: null, rule: "py-src-root" } };
    if (spaces.size > 1) return { gap: "ambiguous", note: `${rest.replaceAll("/", ".")} is found under ${spaces.size} source roots`, candidates: [...spaces].sort().map((d) => `ns:${d}`) };
    // A namespace package next to the importer.
    for (const root of pyWalkRoots(from)) {
      const hit = pyFind(root, rest);
      if (hit && "ns" in hit) return { ns: hit.ns, ev: { kind: "py-root", tier: "certain", via, note: null, rule: "py-namespace" } };
    }
    const top = spec.split(".")[0] as string;
    if (isPyStdlib(spec) || model.pyDeclared.has(normalisePy(top))) return { ext: top };
    return { gap: "miss", note: `the module ${spec} is not in the repository and no Python manifest declares ${top}`, candidates: null };
  };
  const goModules = [...input.goModules].sort((a, b) => b[0].length - a[0].length);
  const goSpec = (from: string, line: number, spec: string): Mod => {
    for (const [mod, dir] of goModules) {
      const via = viaOf(from, line, spec);
      if (spec === mod) return { file: dir, ev: { kind: "go-module", tier: "certain", via, note: null, rule: "go-module" } };
      if (spec.startsWith(`${mod}/`)) return { file: join(dir, spec.slice(mod.length + 1)), ev: { kind: "go-module", tier: "certain", via, note: null, rule: "go-module" } };
    }
    if (isGoStdlib(spec) || model.goRequires.some((r) => spec === r || spec.startsWith(`${r}/`))) return { ext: spec };
    return { gap: "miss", note: `the package ${spec} is not in the repository and no go.mod requires it`, candidates: null };
  };
  const rbSpec = (from: string, line: number, spec: string, relative: boolean): Mod => {
    const base = relative ? join(dirOf(from), spec) : spec;
    const file = base.endsWith(".rb") ? base : `${base}.rb`;
    const via = viaOf(from, line, spec);
    if (known.has(file)) return { file, ev: { kind: "import", tier: "certain", via, note: null, rule: "rb-require" } };
    if (!relative && known.has(join("lib", file))) return { file: join("lib", file), ev: { kind: "import", tier: "certain", via, note: null, rule: "rb-require-lib" } };
    if (relative) return null;
    if (isRubyStdlib(spec) || model.gems.has(spec) || model.gems.has(spec.split("/")[0] as string)) return { ext: spec };
    return { gap: "miss", note: `${spec} is not in the repository and the Gemfile does not name it`, candidates: null };
  };

  // Java: a package no file declares is the standard library (`java.*`,
  // `javax.*`) or a dependency when a build file declares a group it starts
  // with; any other is a miss the graph discloses.
  const javaGroups = [...model.javaDeps];
  const javaExternal = (pkg: string): boolean => {
    if (pkg === "java" || pkg === "javax" || pkg.startsWith("java.") || pkg.startsWith("javax.")) return true;
    return javaGroups.some((g) => pkg === g || pkg.startsWith(`${g}.`));
  };
  const javaMissNote = (pkg: string) => `the package ${pkg} is not in the repository and no build file declares a dependency for it`;
  // The folder of the nearest pom.xml, build.gradle or build.gradle.kts above a file.
  const javaProjectOf = (file: string): string => {
    let best = "";
    for (const dir of model.javaProjects) if ((dir === "" || file.startsWith(`${dir}/`)) && dir.length > best.length) best = dir;
    return best;
  };
  // Which of several declarations of one qualified name a file sees: a main
  // source never sees a test source; the file's own project and source set
  // come first, then its own project, then every project. One left binds;
  // several are ambiguous; none is null.
  // The source set by folder only, never by the file name (a main class
  // named `SmokeTest.java` is still main). The source roots decide first:
  // under `src/test/` or `src/it/` is test, under `src/main/` is main
  // whatever its package folders are called; without either root, a
  // `test` or `tests` folder decides.
  const javaTestSet = (path: string): boolean => {
    if (/(^|\/)src\/(test|it)\//.test(path)) return true;
    if (/(^|\/)src\/main\//.test(path)) return false;
    return /(^|\/)tests?\//.test(path);
  };
  const javaChoose = (from: string, ids: readonly string[]): { id: string } | { candidates: string[] } | null => {
    const fileOf = (id: string) => defById.get(id)?.file ?? id;
    const test = javaTestSet(from);
    const seen = test ? [...ids] : ids.filter((id) => !javaTestSet(fileOf(id)));
    if (seen.length === 0) return null;
    if (seen.length === 1) return { id: seen[0] as string };
    const project = javaProjectOf(from);
    const own = seen.filter((id) => javaProjectOf(fileOf(id)) === project);
    const tiers = [own.filter((id) => javaTestSet(fileOf(id)) === test), own, seen];
    const pick = tiers.find((t) => t.length > 0) as string[];
    return pick.length === 1 ? { id: pick[0] as string } : { candidates: pick.map(fileOf).sort() };
  };
  // The class `import <spec>.<name>` names, by the declared packages: the
  // longest prefix of the name that a file declares as its package, then the
  // type and the nested types below it. `path`: the type's dotted path in
  // its file (`Outer.Inner`).
  const javaClassMod = (from: string, line: number, spec: string, name: string): { mod: Mod; path: string } => {
    const via = viaOf(from, line, spec);
    const segs = [...(spec === "" ? [] : spec.split(".")), name];
    let declared = false;
    // Java never imports a type of the default package, so it is not tried.
    for (let i = segs.length - 1; i >= 1; i--) {
      const pkg = segs.slice(0, i).join(".");
      const rest = segs.slice(i);
      const ids = javaTypes.get(pkg)?.get(rest[0] as string);
      if (javaTypes.has(pkg)) declared = true;
      if (!ids) continue;
      const c = javaChoose(from, ids);
      if (c === null) continue;
      if ("candidates" in c) return { mod: { gap: "ambiguous", note: `${[...segs].join(".")} is declared in ${c.candidates.length} files this file may see`, candidates: c.candidates }, path: rest.join(".") };
      return { mod: { file: defById.get(c.id)?.file ?? from, ev: { kind: "import", tier: "certain", via, note: null, rule: "java-import" } }, path: rest.join(".") };
    }
    if (javaExternal(spec)) return { mod: { ext: spec }, path: name };
    // A package the repository declares without the class: nothing here.
    if (declared) return { mod: null, path: name };
    return { mod: { gap: "miss", note: javaMissNote(spec), candidates: null }, path: name };
  };
  // `import a.b.Outer.*`: the spec names a class of the repository, whose
  // member types the import brings. Null when no class has that name.
  const javaStarClass = (from: string, line: number, spec: string): { mod: Mod; path: string } | null => {
    const dot = spec.lastIndexOf(".");
    if (dot < 0) return null;
    const hit = javaClassMod(from, line, spec.slice(0, dot), spec.slice(dot + 1));
    return hit.mod !== null && "file" in hit.mod ? hit : null;
  };
  const javaSpec = (from: string, imp: { spec: string; line: number; names?: { imported: string }[]; star?: boolean; staticStar?: boolean }): Mod => {
    const name = imp.names?.[0]?.imported;
    if (name === undefined || (imp.star && !imp.staticStar)) {
      if (javaTypes.has(imp.spec)) return null;
      const cls = javaStarClass(from, imp.line, imp.spec);
      if (cls) return cls.mod;
      return javaExternal(imp.spec) ? { ext: imp.spec } : { gap: "miss", note: javaMissNote(imp.spec), candidates: null };
    }
    return javaClassMod(from, imp.line, imp.spec, name).mod;
  };

  // ---------- the index: every cross-file read goes through here ----------
  type Binding =
    | { kind: "named"; mod: Mod | { ns: string; ev: Ev }; imported: string }
    | { kind: "ns"; mod: Mod | { ns: string; ev: Ev } }
    | { kind: "pyns"; dotted: string };
  // Java: `jstars`, the packages of `import a.b.*` (`mod` null when the
  // repository declares the package); `jstatic`, the members of `import
  // static a.b.C.m` by name, each bound to its class; `jstaticStars`, the
  // classes of `import static a.b.C.*`.
  type FileBindings = {
    names: Map<string, Binding>;
    stars: (Mod | { ns: string; ev: Ev })[];
    starSpecs: string[];
    // `type`: the class an `import a.b.Outer.*` names, whose member types it brings.
    jstars?: { spec: string; mod: Mod; ev: Ev; type?: Binding }[];
    jstatic?: Map<string, Binding[]>;
    jstaticStars?: Binding[];
  };
  const bindingsCache = new Map<string, FileBindings>();
  const importTargets = new Map<string, { target: string; line: number; column: number; ev: Ev; reexport: boolean }[]>();
  // The export reads of the site being traced, when one is.
  let reading: Set<string> | null = null;

  const moduleOf = (file: string, family: Family, imp: { spec: string; line: number; relative?: boolean }): Mod | { ns: string; ev: Ev } => {
    if (family === "js") return jsSpec(file, imp.line, imp.spec);
    if (family === "python") return pySpec(file, imp.line, imp.spec);
    if (family === "go") return goSpec(file, imp.line, imp.spec);
    if (family === "java") return javaSpec(file, imp);
    return rbSpec(file, imp.line, imp.spec, imp.relative === true);
  };

  const index = {
    bindings(file: string): FileBindings {
      let b = bindingsCache.get(file);
      if (b) return b;
      b = { names: new Map(), stars: [], starSpecs: [] };
      bindingsCache.set(file, b);
      const f = facts.get(file);
      if (!f) return b;
      const family = familyOf(f.lang);
      const targets: { target: string; line: number; column: number; ev: Ev; reexport: boolean }[] = [];
      if (family === "java") {
        for (const imp of f.imports) {
          if (imp.star && !imp.staticStar) {
            const mod = javaSpec(file, imp);
            const star: { spec: string; mod: Mod; ev: Ev; type?: Binding } = { spec: imp.spec, mod, ev: { kind: "import", tier: "certain", via: viaOf(file, imp.line, imp.spec), note: null, rule: "java-star-import" } };
            const cls = mod !== null && "file" in mod ? javaStarClass(file, imp.line, imp.spec) : null;
            if (cls && mod !== null && "file" in mod) {
              star.type = { kind: "named", mod, imported: cls.path };
              targets.push({ target: mod.file, line: imp.line, column: imp.column, ev: mod.ev, reexport: false });
            }
            (b.jstars ??= []).push(star);
            continue;
          }
          const n = imp.names[0];
          if (!n) continue;
          const { mod, path } = javaClassMod(file, imp.line, imp.spec, n.imported);
          if (mod !== null && "file" in mod) targets.push({ target: mod.file, line: imp.line, column: imp.column, ev: mod.ev, reexport: false });
          const binding: Binding = { kind: "named", mod, imported: path };
          if (imp.staticMember !== undefined) {
            const all = (b.jstatic ??= new Map());
            all.set(imp.staticMember, [...(all.get(imp.staticMember) ?? []), binding]);
          }
          else if (imp.staticStar) (b.jstaticStars ??= []).push(binding);
          else b.names.set(n.local, binding);
        }
        importTargets.set(file, targets);
        return b;
      }
      for (const imp of f.imports) {
        const mod = moduleOf(file, family, imp);
        if (mod !== null && "file" in mod) targets.push({ target: mod.file, line: imp.line, column: imp.column, ev: mod.ev, reexport: imp.reexport });
        if (family === "ruby") continue;
        if (imp.reexport) continue; // re-exports bind nothing locally
        if (imp.scoped) continue; // binds only in its own scope, through CallFact.bound
        if (imp.star) {
          b.stars.push(mod);
          b.starSpecs.push(imp.spec);
          continue;
        }
        if (family === "go") {
          const local = imp.namespace ?? (mod !== null && "file" in mod ? pkgName.get(mod.file) : undefined) ?? goGuess(imp.spec);
          b.names.set(local, { kind: "ns", mod });
          continue;
        }
        if (imp.namespace && family === "python") {
          // `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
          b.names.set(imp.namespace, { kind: "pyns", dotted: imp.alias ? imp.spec : imp.namespace });
        } else if (imp.namespace) b.names.set(imp.namespace, { kind: "ns", mod });
        for (const n of imp.names) b.names.set(n.local, { kind: "named", mod, imported: n.imported });
      }
      importTargets.set(file, targets);
      return b;
    },

    // A name a module offers to importers.
    exports(file: string, name: string, depth: number): Value | null {
      return lookupExport(file, name, depth);
    },

    // The method and the evidence of the inheritance steps to the class
    // that defines it (null when the class itself does), by the language's
    // lookup order; a gap when that order cannot be established.
    members(key: string, name: string, side: Side): Lookup {
      return methodOn(key, name, side, 0);
    },

    // The classes that extend, include or implement a class key directly,
    // and for a Go interface or a Python Protocol, the types whose method
    // set covers it. An empty answer is a read too.
    implementers(key: string): string[] {
      return childrenOf(key);
    },
  };

  // ---------- export lookups ----------
  // A name's export value depends only on the file and the name, so it is
  // kept after its first lookup, with the export reads it made (the trace
  // replays them). A lookup that met a cycle, the depth limit or the step
  // budget is kept by no one: its value depends on where it started.
  const exportMemo = new Map<string, { v: Value | null; reads: string[] }>();
  type LookupFrame = { reads: Set<string>; tainted: boolean };
  const lookupStack: LookupFrame[] = [];
  const openLookups = new Set<string>();
  let lookupSteps = 0;
  let lookupCut: Cut | null = null;
  const taintAll = () => {
    for (const frame of lookupStack) frame.tainted = true;
  };
  const noteRead = (read: string) => {
    const top = lookupStack[lookupStack.length - 1];
    if (top) top.reads.add(read);
    else if (reading) reading.add(read);
  };

  function lookupExport(file: string, name: string, depth: number): Value | null {
    const key = `${file}\0${name}`;
    const kept = exportMemo.get(key);
    if (kept) {
      for (const read of kept.reads) noteRead(read);
      return kept.v;
    }
    if (depth > MAX_DEPTH) {
      taintAll();
      return TOO_DEEP;
    }
    if (openLookups.has(key)) {
      // A cycle: along this path the name is not found.
      taintAll();
      noteRead(key);
      return { v: "miss", target: file, name, ev: SAME_SCOPE };
    }
    if (lookupStack.length === 0) lookupSteps = 0;
    if (++lookupSteps > EXPORT_LOOKUP_STEPS) {
      taintAll();
      lookupCut ??= { by: "export-walk", at: file, omitted: null, exact: false, unit: "paths", note: LOOKUP_CUT.note };
      return LOOKUP_CUT;
    }
    const frame: LookupFrame = { reads: new Set([key]), tainted: false };
    lookupStack.push(frame);
    openLookups.add(key);
    let v: Value | null;
    try {
      v = exportsOf(file, name, depth);
    } finally {
      lookupStack.pop();
      openLookups.delete(key);
    }
    if (!frame.tainted) exportMemo.set(key, { v, reads: [...frame.reads] });
    for (const read of frame.reads) noteRead(read);
    return v;
  }

  // What `file` offers under `name`, read once per name (lookupExport).
  function exportsOf(file: string, name: string, depth: number): Value | null {
    {
      const f = facts.get(file);
      if (!f) return known.has(file) ? { v: "miss", target: file, name, ev: SAME_SCOPE } : null;
      const family = familyOf(f.lang);
      if (family === "go") return pkgValue(pkgOf(file), name);
      if (family === "java") return javaExport(file, name);
      if (family === "js") {
        // The export table: exported declarations, `export { a as b }`,
        // `export default`, CommonJS assignments, then re-exports. A private
        // top-level definition is never an export.
        if (name === "default" && f.defaultExport) return resolveLocal(file, f.defaultExport, depth + 1);
        const top = topByFile.get(file)?.get(name)?.filter((id) => defById.get(id)?.exported);
        if (top && top.length > 0) return { v: "sym", ids: top, ev: SAME_SCOPE };
        for (const e of f.exportsLocal) if (e.exported === name) return resolveLocal(file, e.local, depth + 1);
        // Every `export *` that offers the name: one definition binds; two
        // different ones are ambiguous (JavaScript exports neither). A star
        // the graph cannot follow (a module that is not there, a package
        // outside the repository, a gap) may bring the name too, so nothing
        // it competes with is certain.
        const starHits: { v: Value; spec: string }[] = [];
        const unfollowed: Unfollowed[] = [];
        for (const imp of f.imports) {
          if (!imp.reexport) continue;
          const named = imp.names.find((n) => n.local === name);
          if (!named && !imp.star) continue;
          const mod = jsSpec(file, imp.line, imp.spec);
          if (named) {
            if (mod === null) return { v: "miss", target: file, name, ev: SAME_SCOPE };
            if ("ext" in mod) return { v: "ext" };
            if ("gap" in mod) return { v: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
            return named.imported === "*" ? { v: "mod", file: mod.file, ev: mod.ev } : withEv(index.exports(mod.file, named.imported, depth + 1), mod.ev);
          }
          if (mod === null) unfollowed.push({ spec: imp.spec, cause: "miss", note: `export * from ${imp.spec} names no module here` });
          else if ("ext" in mod) unfollowed.push({ spec: imp.spec, cause: "external", note: `export * from ${imp.spec}, a package outside the repository, may bring it` });
          else if ("gap" in mod) unfollowed.push({ spec: imp.spec, cause: mod.gap, note: mod.note });
          else {
            const hit = withEv(index.exports(mod.file, name, depth + 1), mod.ev);
            if (hit === null) unfollowed.push({ spec: imp.spec, cause: "miss", note: `export * from ${imp.spec} could not be read` });
            else if (hit.v === "gap") unfollowed.push({ spec: imp.spec, cause: hit.cause, note: hit.note });
            else if (hit.v !== "miss") starHits.push({ v: hit, spec: imp.spec });
          }
        }
        return starValue(file, name, starHits, unfollowed) ?? noStarHit(unfollowed) ?? { v: "miss", target: file, name, ev: SAME_SCOPE };
      }
      // Python: definitions, then names the module imported, then submodules of a package.
      const top = topByFile.get(file)?.get(name);
      if (top) return { v: "sym", ids: top, ev: SAME_SCOPE };
      if (index.bindings(file).names.has(name)) return resolveLocal(file, name, depth + 1);
      if (file.endsWith("__init__.py")) {
        const sub = pyModule(join(dirOf(file), name));
        if (sub) return { v: "mod", file: sub, ev: { kind: "import", tier: "certain", via: null, note: null, rule: "py-submodule" } };
      }
      return pyStarValue(file, name, depth) ?? { v: "miss", target: file, name, ev: SAME_SCOPE };
    }
  }

  // A Python module's `from x import *` lines run in order, so the last
  // one that brings the name binds it. One after it that the graph cannot
  // follow may bind it again: the binding is then only possible.
  function pyStarValue(file: string, name: string, depth: number): Value | null {
    const b = index.bindings(file);
    const later: Unfollowed[] = [];
    for (let i = b.stars.length - 1; i >= 0; i--) {
      const star = b.stars[i] as Mod | { ns: string; ev: Ev };
      const spec = b.starSpecs[i] ?? "a module";
      if (star === null) later.push({ spec, cause: "miss", note: `from ${spec} import * names no module here` });
      else if ("ext" in star) later.push({ spec, cause: "external", note: `from ${spec} import *, a module outside the repository, may bring it` });
      else if ("gap" in star) later.push({ spec, cause: star.gap, note: star.note });
      else if ("file" in star) {
        const hit = index.exports(star.file, name, depth + 1);
        if (hit === null) later.push({ spec, cause: "miss", note: `from ${spec} import * could not be read` });
        else if (hit.v === "gap") later.push({ spec, cause: hit.cause, note: hit.note });
        else if (hit.v !== "miss") return onlyPossible(withEv(hit, star.ev) as Value, later);
      }
    }
    return noStarHit(later);
  }

  // A value another branch may also bring: at most possible, with why.
  function onlyPossible(v: Value, open: Unfollowed[]): Value {
    if (open.length === 0 || v.v !== "sym") return v;
    const why = `${open.map((u) => u.note).join("; ")}, so the name may come from there instead.`;
    return { ...v, ev: { ...v.ev, tier: weakest(v.ev.tier, "possible"), note: [v.ev.note, why].filter(Boolean).join(" ") } };
  }

  // No branch brought the name: the first branch that could not be
  // followed says why, and a package outside the repository is the name's
  // likely source; null when every branch was followed and none has it.
  function noStarHit(open: Unfollowed[]): Value | null {
    const gap = open.find((u) => u.cause !== "external");
    if (gap) return { v: "gap", cause: gap.cause, note: gap.note, candidates: null };
    return open.length > 0 ? { v: "ext" } : null;
  }

  // The value of a name several `export *` statements offer. The same
  // definition (or module) reached twice is one value; different ones are
  // ambiguous: every candidate at the possible tier, with a note.
  function starValue(file: string, name: string, hits: { v: Value; spec: string }[], open: Unfollowed[]): Value | null {
    if (hits.length === 0) return null;
    const keyOf = (v: Value): string | null => (v.v === "sym" ? [...new Set(v.ids.map(stableKey))].sort().join("\0") : v.v === "mod" ? `mod:${v.file}` : v.v === "ext" ? "ext" : null);
    const distinct = new Map<string, { v: Value; spec: string }>();
    for (const h of hits) {
      const k = keyOf(h.v);
      if (k === null) return (hits[0] as { v: Value }).v; // a gap or a namespace: the first decides, as before
      if (!distinct.has(k)) distinct.set(k, h);
    }
    const first = hits[0] as { v: Value };
    if (distinct.size === 1) return onlyPossible(first.v, open);
    const syms = [...distinct.values()].filter((h): h is { v: Extract<Value, { v: "sym" }>; spec: string } => h.v.v === "sym");
    const unopened = open.length > 0 ? ` ${open.map((u) => u.note).join("; ")}.` : "";
    const note = `${file} re-exports ${name} through export * from ${distinct.size} modules (${[...distinct.values()].map((h) => h.spec).join(", ")}); JavaScript exports neither, and a bundler may pick one.${unopened}`;
    if (syms.length < 2) return { v: "gap", cause: "ambiguous", note, candidates: [...distinct.keys()] };
    const base = syms[0]?.v.ev as Ev;
    return { v: "sym", ids: syms.flatMap((h) => h.v.ids), ev: { ...base, tier: "possible", note: [base.note, note].filter(Boolean).join(" "), rule: "js-star-ambiguous" } };
  }

  // A value reached through a module step keeps that step's evidence.
  function withEv(v: Value | null, ev: Ev): Value | null {
    if (!v) return v;
    if (v.v === "sym" || v.v === "mod" || v.v === "pkg" || v.v === "pyns" || v.v === "miss") return { ...v, ev: chain(ev, v.ev) };
    return v;
  }

  // What a Java file declares under a dotted name: a top-level type, the
  // types nested in it, and as the last part a member of the type (every
  // overload, static or not). Package-private types count: the package and
  // an importer of the file both read them through here.
  const javaNamedClass = (info: ClassInfo | undefined): ClassInfo | undefined =>
    info?.ids.some((id) => defById.get(id)?.anonymous) ? undefined : info;

  const javaExport = (file: string, dotted: string): Value => {
    const parts = dotted.split(".");
    const top = topByFile.get(file)?.get(parts[0] as string)?.filter((id) => defById.get(id)?.kind === "class");
    if (!top || top.length === 0) return { v: "miss", target: file, name: dotted, ev: SAME_SCOPE };
    let key = classOfId.get(top[0] as string) as string;
    let ids = top;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i] as string;
      const nested = javaNamedClass(classes.get(`${key}.${p}`));
      if (nested) {
        key = `${key}.${p}`;
        ids = nested.ids;
        continue;
      }
      if (i === parts.length - 1) {
        const members = [...(methodsOn.s.get(key)?.get(p) ?? []), ...(methodsOn.i.get(key)?.get(p) ?? [])];
        if (members.length > 0) return { v: "sym", ids: members, ev: SAME_SCOPE };
      }
      return { v: "miss", target: key, name: p, ev: SAME_SCOPE };
    }
    return { v: "sym", ids, ev: SAME_SCOPE };
  };

  // The one declaration of `<pkg>.<name>` a Java file sees (javaChoose),
  // read through that file's exports, so a trace records the read.
  const javaTypeIn = (from: string, pkg: string, name: string, ev: Ev): Value | null => {
    const ids = javaTypes.get(pkg)?.get(name);
    if (!ids) return null;
    const c = javaChoose(from, ids);
    if (c === null) return null;
    if ("candidates" in c) return { v: "gap", cause: "ambiguous", note: `${pkg === "" ? "" : `${pkg}.`}${name} is declared in ${c.candidates.length} files this file may see`, candidates: c.candidates };
    return withEv(index.exports(defById.get(c.id)?.file ?? from, name, 1), ev);
  };

  // The class a Java scope (`Outer.Inner`, a type's dotted path in `file`)
  // and each scope around it stand for, innermost first.
  const javaScopes = (file: string, nesting: string | null): string[] => {
    if (!nesting) return [];
    const parts = nesting.split(".");
    const out: string[] = [];
    for (let i = parts.length; i > 0; i--) {
      const key = classKey("java", file, parts.slice(0, i).join("."));
      if (classes.has(key)) out.push(key);
    }
    return out;
  };

  // A nested type a Java class inherits: declared in one of its superclasses
  // or interfaces, nearest first.
  const javaInheritedNested = (key: string, name: string): ClassInfo | undefined => {
    const seen = new Set([key]);
    const queue = [...basesOf(key).keys];
    for (let i = 0; i < queue.length && i < 1000; i++) {
      const k = queue[i] as string;
      if (seen.has(k)) continue;
      seen.add(k);
      const hit = javaNamedClass(classes.get(`${k}.${name}`));
      if (hit) return hit;
      queue.push(...basesOf(k).keys);
    }
    return undefined;
  };

  // A bare type name in a Java file, in the language's order: the enclosing
  // types and the types nested in them, the file's explicit imports, the
  // file's own package, its star imports, then java.lang. `nesting`: the
  // dotted path of the type the name is read in, when known; without it,
  // a nested type of the file binds only when it is the one of its name.
  const javaLocal = (file: string, name: string, depth: number, nesting: string | null): Value | null => {
    const asType = (ids: string[] | undefined): Value | null => {
      const named = ids?.filter((id) => !defById.get(id)?.anonymous);
      return named && named.length > 0 ? { v: "sym", ids: named, ev: SAME_SCOPE } : null;
    };
    for (const key of javaScopes(file, nesting)) {
      const inner = javaNamedClass(classes.get(`${key}.${name}`)) ?? javaInheritedNested(key, name);
      if (inner) return asType(inner.ids);
      if (key.endsWith(`::${name}`) || key.endsWith(`.${name}`)) {
        const own = asType(classes.get(key)?.ids);
        if (own) return own;
      }
    }
    const top = asType(topByFile.get(file)?.get(name)?.filter((id) => defById.get(id)?.kind === "class"));
    if (top) return top;
    if (!nesting) {
      const nested = javaNested.get(file)?.get(name);
      if (nested && nested.length === 1) return asType(nested);
    }
    const b = index.bindings(file);
    const bound = b.names.get(name);
    if (bound) return bindingValue(file, "java", name, bound, depth);
    const same = javaTypeIn(file, javaPkgOf(file), name, { kind: "same-scope", tier: "certain", via: null, note: null, rule: "java-same-package" });
    if (same) return same;
    let open: Value | null = null;
    for (const star of b.jstars ?? []) {
      if (star.type) {
        const cls = bindingValue(file, "java", name, star.type, depth);
        const key = cls?.v === "sym" && cls.ids.length === 1 ? classOfId.get(cls.ids[0] as string) : undefined;
        const inner = key ? javaNamedClass(classes.get(`${key}.${name}`)) : undefined;
        if (inner && cls?.v === "sym") return { v: "sym", ids: inner.ids, ev: cls.ev };
        continue;
      }
      if (star.mod === null) {
        const hit = javaTypeIn(file, star.spec, name, star.ev);
        if (hit) return hit;
      } else if ("ext" in star.mod) open ??= { v: "ext" };
      else if ("gap" in star.mod) open ??= { v: "gap", cause: star.mod.gap, note: star.mod.note, candidates: star.mod.candidates };
    }
    if (BUILTINS.java.has(name)) return { v: "ext" };
    return open;
  };

  const pkgValue = (dir: string, name: string): Value => {
    const ids = pkgTop.get(dir)?.get(name);
    return ids ? { v: "sym", ids, ev: SAME_SCOPE } : { v: "miss", target: `go:${dir}`, name, ev: SAME_SCOPE };
  };

  const modValue = (mod: Mod | { ns: string; ev: Ev }, family: Family, name: string, file: string): Value => {
    if (mod === null) return { v: "miss", target: file, name, ev: SAME_SCOPE };
    if ("ext" in mod) return { v: "ext" };
    if ("gap" in mod) return { v: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
    if ("ns" in mod) return { v: "pyns", dir: mod.ns, ev: mod.ev };
    return family === "go" ? { v: "pkg", dir: mod.file, ev: mod.ev } : { v: "mod", file: mod.file, ev: mod.ev };
  };

  const bindingValue = (file: string, family: Family, name: string, b: Binding, depth: number): Value | null => {
    if (b.kind === "pyns") return { v: "pymod", from: file, dotted: b.dotted };
    const mod = b.mod;
    if (b.kind === "ns" || mod === null || "ext" in mod || "gap" in mod) return modValue(mod, family, name, file);
    if ("ns" in mod) return withEv(attr({ v: "pyns", dir: mod.ns, ev: SAME_SCOPE }, b.imported), mod.ev);
    return withEv(index.exports(mod.file, b.imported, depth + 1), mod.ev);
  };

  // What a name a scoped import binds means: the same as a file-wide import
  // of it would, for the one scope the import was made in.
  const boundValue = (file: string, name: string, ref: BoundImport): Value | null => {
    const f = facts.get(file);
    const imp = f?.imports[ref.import];
    if (!f || !imp) return null;
    const family = familyOf(f.lang);
    if (family === "python" && ref.imported === "*") return { v: "pymod", from: file, dotted: imp.alias ? imp.spec : (imp.namespace ?? imp.spec) };
    if (family !== "python" && family !== "js") return null;
    const mod = moduleOf(file, family, imp);
    const b: Binding = ref.imported === "*" ? { kind: "ns", mod } : { kind: "named", mod, imported: ref.imported };
    return bindingValue(file, family, name, b, 0);
  };

  // What a bare name means in a file.
  const resolveLocal = (file: string, name: string, depth = 0, nesting: string | null = null): Value | null => {
    const f = facts.get(file);
    if (!f) return null;
    if (depth > MAX_DEPTH) return TOO_DEEP;
    const family = familyOf(f.lang);
    if (family === "java") return javaLocal(file, name, depth, nesting);
    if (family === "go") {
      const ids = pkgTop.get(pkgOf(file))?.get(name);
      if (ids) return { v: "sym", ids, ev: SAME_SCOPE };
    } else {
      const top = topByFile.get(file)?.get(name);
      if (top) return { v: "sym", ids: top, ev: SAME_SCOPE };
    }
    const b = index.bindings(file).names.get(name);
    if (b) return bindingValue(file, family, name, b, depth);
    if (family === "python") return pyStarValue(file, name, depth);
    for (const star of index.bindings(file).stars) {
      if (star === null || !("file" in star)) continue;
      const hit = index.exports(star.file, name, depth + 1);
      if (hit && hit.v !== "miss") return withEv(hit, star.ev);
    }
    if (family === "go") {
      // Dot imports bring a package's names into scope.
      for (const star of index.bindings(file).stars) if (star !== null && "ext" in star) return { v: "ext" };
    }
    return null;
  };

  const attr = (value: Value | null, name: string): Value | null => {
    if (!value) return null;
    if (value.v === "ext" || value.v === "gap") return value;
    if (value.v === "miss") return null;
    if (value.v === "mod") return withEv(index.exports(value.file, name, 0), value.ev);
    if (value.v === "pkg") return withEv(pkgValue(value.dir, name), value.ev);
    if (value.v === "pyns") {
      const sub = pyModule(join(value.dir, name));
      if (sub) return { v: "mod", file: sub, ev: value.ev };
      return pyDirs.has(join(value.dir, name)) ? { v: "pyns", dir: join(value.dir, name), ev: value.ev } : { v: "miss", target: value.dir, name, ev: value.ev };
    }
    if (value.v === "pymod") {
      const dotted = `${value.dotted}.${name}`;
      const sub = pySpec(value.from, 0, dotted);
      if (sub !== null && "file" in sub) return { v: "mod", file: sub.file, ev: sub.ev };
      if (sub !== null && "ns" in sub) return { v: "pyns", dir: sub.ns, ev: sub.ev };
      const mod = pySpec(value.from, 0, value.dotted);
      if (mod !== null && "ext" in mod) return { v: "ext" };
      // A module the name cannot settle (ambiguous, missing): the gap stands for every name read from it.
      if (mod !== null && "gap" in mod) return { v: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
      if (mod === null) return null;
      if ("ns" in mod) return attr({ v: "pyns", dir: mod.ns, ev: mod.ev }, name);
      return withEv(index.exports(mod.file, name, 0), mod.ev);
    }
    const key = value.ids.length === 1 ? classOfId.get(value.ids[0] as string) : undefined;
    if (!key) return null;
    // A Java class holds its nested types by name.
    const nested = classes.get(key)?.family === "java" ? classes.get(`${key}.${name}`) : undefined;
    if (nested) return { v: "sym", ids: nested.ids, ev: value.ev };
    const m = index.members(key, name, "s");
    if (m && "gap" in m) return { v: "gap", cause: m.gap, note: m.note, candidates: null };
    return m ? { v: "sym", ids: m.ids, ev: m.ev ? chain(value.ev, m.ev) : value.ev } : { v: "miss", target: key, name, ev: value.ev };
  };

  // Ruby: a constant by lexical lookup from the innermost nesting outwards.
  const rbConst = (name: string, nesting: string | null): string | null => {
    const n = name.replace(/^::/, "");
    const parts = nesting && !name.startsWith("::") ? nesting.split("::") : [];
    for (let i = parts.length; i >= 0; i--) {
      const key = `rb::${[...parts.slice(0, i), n].join("::")}`;
      if (classes.has(key)) return key;
    }
    return null;
  };
  // A Ruby constant's evidence: defined in the caller's own file, or found
  // in another file by the autoload convention.
  const rbConstEv = (key: string, file: string): Ev =>
    classes.get(key)?.files.has(file)
      ? SAME_SCOPE
      : { kind: "autoload", tier: "likely", via: null, note: "The Ruby constant was found by the autoload convention, not by a require.", rule: "rb-autoload-const" };

  // The class a type name in `file` stands for, with the evidence of that
  // name's binding. A function's name stands for its declared result type
  // at the position the call took. `ext`: the type comes from a dependency.
  type TypeArgs = { types: TypeRef[]; file: string; nesting: string | null };
  type TypeHit = { key: string; ev: Ev; args?: TypeArgs } | "ext" | null;
  const typeValue = (file: string, t: TypeRef): Value | null => {
    // The head name, through the scoped import that binds it where the type was read.
    const head = (name: string) => (t.bound ? boundValue(file, name, t.bound) : resolveLocal(file, name));
    let v: Value | null;
    if (t.qualifier) {
      const parts = t.qualifier.split(".");
      v = head(parts[0] as string);
      for (const p of parts.slice(1)) v = attr(v, p);
      v = v && v.v !== "sym" ? attr(v, t.name) : null;
    } else v = head(t.name);
    return v;
  };
  const typeKey = (file: string, family: Family, t: TypeRef, depth = 0, asType = false, nesting: string | null = null): TypeHit => {
    if (t.elem || t.param !== undefined || depth > MAX_TYPE_DEPTH) return null;
    if (t.promise) return "ext";
    if (t.result !== undefined) return asType ? null : resultType(file, family, t, depth, nesting);
    if (family === "java") return javaTypeKey(file, t, asType, nesting);
    if (family === "ruby") {
      const key = rbConst(t.name, t.qualifier);
      return key ? { key, ev: rbConstEv(key, file) } : null;
    }
    const v = typeValue(file, t);
    if (v?.v === "ext") return "ext";
    if (v?.v !== "sym" || v.ids.length !== 1) return null;
    const cls = classOfId.get(v.ids[0] as string);
    if (cls) return { key: cls, ev: v.ev };
    if (asType) return null;
    const def = defById.get(v.ids[0] as string);
    const result = def?.results?.[t.result ?? 0];
    if (!def || !result) return null;
    const inner = typeKey(def.file, def.family, { ...result, result: undefined }, depth + 1);
    return inner === null || inner === "ext" ? inner : { ...inner, ev: chain(v.ev, inner.ev) };
  };

  // A dotted Java type name (`Repo`, `Outer.Inner`, `a.b.Repo`): its head
  // by javaLocal, else the longest prefix a file declares as its package,
  // then the nested types below it. A name under `java.*`, `javax.*` or a
  // declared dependency group is external.
  const QUALIFIED: Ev = { kind: "same-scope", tier: "certain", via: null, note: null, rule: "java-qualified-name" };
  const javaTypeValue = (file: string, parts: readonly string[], nesting: string | null): Value | null => {
    // Scoped local names are qualified by the extractor, never by source text.
    const localKey = classKey("java", file, parts.join("."));
    if (javaLocalClasses.has(localKey)) {
      const local = javaNamedClass(classes.get(localKey));
      return local ? { v: "sym", ids: local.ids, ev: SAME_SCOPE } : null;
    }
    let v = javaLocal(file, parts[0] as string, 0, nesting);
    let i = 1;
    // A qualified name tries the declared packages first: an external or a
    // gap head (a star import outside the graph may bring a name `com`) is
    // no answer while a package of the repository spells the name.
    const head = v;
    if (v === null || v.v === "miss" || (parts.length > 1 && (v.v === "ext" || v.v === "gap"))) {
      v = null;
      for (let k = parts.length - 1; k >= 1; k--) {
        const pkg = parts.slice(0, k).join(".");
        if (!javaTypes.has(pkg)) continue;
        v = javaTypeIn(file, pkg, parts[k] as string, QUALIFIED);
        i = k + 1;
        break;
      }
      if (v === null && head !== null && (head.v === "ext" || head.v === "gap")) v = head;
      if (v === null) return parts.length > 1 && javaExternal(parts.slice(0, -1).join(".")) ? { v: "ext" } : null;
    }
    for (; i < parts.length; i++) {
      if (v.v !== "sym") return v;
      const key: string | undefined = v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
      const nested: ClassInfo | undefined = key ? javaNamedClass(classes.get(`${key}.${parts[i]}`)) : undefined;
      if (!nested) return null;
      v = { v: "sym", ids: nested.ids, ev: v.ev };
    }
    return v;
  };
  const javaTypeKey = (file: string, t: TypeRef, asType: boolean, nesting: string | null): TypeHit => {
    // Enum fields carry the exact body type, which source code cannot name.
    if (!asType && t.qualifier !== null) {
      const key = classKey("java", file, `${t.qualifier}.${t.name}`);
      if (classes.get(key)?.ids.some((id) => defById.get(id)?.anonymous)) return { key, ev: SAME_SCOPE };
    }
    const v = javaTypeValue(file, t.qualifier ? [...t.qualifier.split("."), t.name] : [t.name], nesting);
    if (v?.v === "ext") return "ext";
    if (v?.v !== "sym" || v.ids.length !== 1) return null;
    const cls = classOfId.get(v.ids[0] as string);
    return cls ? { key: cls, ev: v.ev, args: t.args ? { types: t.args, file, nesting } : undefined } : null;
  };
  type ResultTarget = { ids: string[]; ev: Ev } | "ext" | null;
  const javaResultTarget = (file: string, t: TypeRef, nesting: string | null): ResultTarget => {
    let found: { ids: string[]; ev: Ev } | null = null;
    if (t.qualifier === null) {
      for (const key of javaScopes(file, nesting)) {
        for (const side of ["i", "s"] as const) {
          const hit = methodOn(key, t.name, side, 0);
          if (hit && "ids" in hit) {
            found = { ids: hit.ids, ev: hit.ev ?? SAME_SCOPE };
            break;
          }
        }
        if (found) break;
      }
    } else {
      const v = javaTypeValue(file, t.qualifier.split("."), nesting);
      if (v?.v === "ext") return "ext";
      const key = v?.v === "sym" && v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
      const hit = key ? methodOn(key, t.name, "s", 0) : null;
      if (v?.v === "sym" && hit && "ids" in hit) found = { ids: hit.ids, ev: hit.ev ? chain(v.ev, hit.ev) : v.ev };
    }
    return found;
  };
  const namedResultTarget = (file: string, t: TypeRef): ResultTarget => {
    const v = typeValue(file, t);
    if (v?.v === "ext") return "ext";
    return v?.v === "sym" && v.ids.length === 1 ? { ids: v.ids, ev: v.ev } : null;
  };
  const resultTargets: Record<Family, (file: string, t: TypeRef, nesting: string | null) => ResultTarget> = {
    java: javaResultTarget,
    js: namedResultTarget,
    go: namedResultTarget,
    python: namedResultTarget,
    ruby: namedResultTarget,
  };

  // Each argument resolves in the context of its own declaration.
  const sameTypeArguments = (a: TypeArgs | undefined, b: TypeArgs | undefined, depth: number): boolean => {
    if (!a || !b) return a === b;
    if (depth > MAX_TYPE_DEPTH || a.types.length !== b.types.length) return false;
    return a.types.every((type, i) => {
      const left = typeKey(a.file, "java", type, depth + 1, false, a.nesting);
      const right = typeKey(b.file, "java", b.types[i] as TypeRef, depth + 1, false, b.nesting);
      if (left === "ext" || right === "ext") return left === right;
      if (left === null || right === null) return false;
      return left.key === right.key && sameTypeArguments(left.args, right.args, depth + 1);
    });
  };

  // Every candidate must declare the same result type. Receiver lookup follows the family's method rules.
  const resultType = (file: string, family: Family, t: TypeRef, depth: number, nesting: string | null): TypeHit => {
    let found: ResultTarget;
    let receiver: TypeHit = null;
    if (t.on) {
      const on = typeKey(file, family, t.on, depth + 1, false, nesting);
      // An external receiver has no readable method declaration.
      if (on === null || on === "ext") return null;
      receiver = on;
      const hit = methodOn(on.key, t.name, "i", 0);
      if (!hit || !("ids" in hit)) return null;
      const ids = hit.ids.filter((id) => defById.get(id)?.results?.[t.result ?? 0]);
      if (ids.length === 0) return null;
      found = { ids, ev: hit.ev ? chain(on.ev, hit.ev) : on.ev };
    } else {
      found = resultTargets[family](file, t, nesting);
      if (found === "ext") return "ext";
      // A constructor or a Go type conversion names its class directly.
      const key = found?.ids.length === 1 ? classOfId.get(found.ids[0] as string) : undefined;
      if (key && found) return { key, ev: found.ev };
    }
    if (!found) return null;
    let out: TypeHit = null;
    for (const id of found.ids) {
      const def = defById.get(id);
      const result = def?.results?.[t.result ?? 0];
      if (!def || !result) return null;
      let inner: TypeHit;
      if (def.family === "java" && result.param !== undefined) {
        // Arguments belong to the receiver's file, which may differ from the method's file.
        if (!receiver || receiver.key !== classKey("java", def.file, def.owner ?? "")) return null;
        const args = receiver.args;
        const arg = args?.types[result.param];
        if (!args || !arg || result.elem) return null;
        inner = typeKey(args.file, "java", arg, depth + 1, false, args.nesting);
      } else {
        // Only an awaited call exposes the value inside a declared Promise.
        inner = result.promise && !t.awaited
          ? "ext"
          : typeKey(def.file, def.family, { ...result, result: undefined, promise: undefined }, depth + 1, false, def.owner);
      }
      if (inner === null) return null;
      if (out !== null && (inner === "ext" ? out !== "ext" : out === "ext" || out.key !== inner.key)) return null;
      // Candidates that disagree on type arguments keep the class and lose the arguments.
      const agreed: boolean = out === null || out === "ext" || inner === "ext" || sameTypeArguments(out.args, inner.args, depth + 1);
      out = inner === "ext" ? inner : { key: inner.key, ev: chain(found.ev, inner.ev), ...(agreed && inner.args ? { args: inner.args } : {}) };
    }
    return out;
  };

  // Whether a type says nothing about a value's methods, by what binds its
  // name rather than how it is spelled: TypeScript's keywords and object
  // types written in place, and an alias of one, however it is imported;
  // Python's `object` (unless the file defines one) and `Any` from typing,
  // under any name or through a module alias (`t.Any`); Go's `any`.
  const untypedType = (file: string, family: Family, t: TypeRef, depth: number): boolean => {
    if (t.result !== undefined || t.elem || depth > MAX_DEPTH) return false;
    if (family === "js") {
      if (t.qualifier === null && JS_UNTYPED.has(t.name)) return true;
      let v: Value | null;
      if (t.qualifier) {
        const parts = t.qualifier.split(".");
        v = t.bound ? boundValue(file, parts[0] as string, t.bound) : resolveLocal(file, parts[0] as string);
        for (const part of [...parts.slice(1), t.name]) v = attr(v, part);
      } else v = t.bound ? boundValue(file, t.name, t.bound) : resolveLocal(file, t.name);
      if (v?.v !== "sym" || v.ids.length !== 1) return false;
      const def = defById.get(v.ids[0] as string);
      return def?.kind === "type" && def.alias !== undefined && untypedType(def.file, def.family, def.alias, depth + 1);
    }
    if (family === "python") {
      const own = (name: string) => topByFile.get(file)?.has(name) === true;
      if (t.qualifier === null) {
        if (own(t.name)) return false;
        if (t.name === "object") return !index.bindings(file).names.has("object");
        const b = index.bindings(file).names.get(t.name);
        return b?.kind === "named" && b.imported === "Any" && b.mod !== null && "ext" in b.mod && TYPING.has(b.mod.ext);
      }
      if (t.name !== "Any" || t.qualifier.includes(".") || own(t.qualifier)) return false;
      const b = index.bindings(file).names.get(t.qualifier);
      return b?.kind === "pyns" && TYPING.has(b.dotted);
    }
    if (family === "go") return t.qualifier === null && t.name === "any" && resolveLocal(file, "any") === null;
    return false;
  };

  // `order`: every base a member may come from, in the order written: one
  // in the graph by its index into `keys`, one outside it by its spelling.
  type Slot = { i: number } | { outside: string; rel: TypeRef["rel"] };
  type Bases = { keys: string[]; evs: Ev[]; rels: TypeRef["rel"][]; refs: TypeRef[]; outside: boolean; order: Slot[] };
  const baseKeys = new Map<string, Bases>();
  // The in-repo base classes of a class, each with the evidence of the name
  // that binds it, how the class takes it (extends, implements, a Ruby
  // mixin), and whether a base it inherits members from is outside the
  // graph (an implemented interface outside it brings no member).
  const basesOf = (key: string): Bases => {
    let out = baseKeys.get(key);
    if (out) return out;
    out = { keys: [], evs: [], rels: [], refs: [], outside: false, order: [] };
    baseKeys.set(key, out);
    const info = classes.get(key);
    if (!info) return out;
    // A base written as an expression keeps its place as a base outside
    // the graph: a member found past it is likely at most, never certain
    // (typing's own Generic[T] and Protocol[T] name no class). In Python and
    // TypeScript it stands where it is written; a Ruby class looks in it
    // first among those it takes the same way.
    const dynamic = info.dynamic.filter((d) => !(d.head && info.family === "python" && (isTyping(info.file, d.head, "Generic") || isTyping(info.file, d.head, "Protocol"))));
    const at = (p: { line: number; column: number }) => p.line * 100_000 + p.column;
    const written: ({ b: TypeRef } | { d: (typeof dynamic)[number] })[] = info.bases.map((b) => ({ b }));
    if (info.family === "ruby") written.unshift(...dynamic.map((d) => ({ d })));
    else {
      for (const d of dynamic) {
        const i = written.findIndex((w) => "b" in w && at(w.b) > at(d));
        written.splice(i < 0 ? written.length : i, 0, { d });
      }
    }
    for (const w of written) {
      if ("d" in w) {
        out.outside = true;
        // Named by its place, so two such bases of one class stay two.
        out.order.push({ outside: `${DYNAMIC_BASE}@${w.d.line}:${w.d.column}`, rel: w.d.rel });
        continue;
      }
      const b = w.b;
      const k = typeKey(info.file, info.family, b, 0, false, info.nesting);
      if (k !== null && k !== "ext" && k.key !== key) {
        out.order.push({ i: out.keys.length });
        out.keys.push(k.key);
        out.evs.push(k.ev);
        out.rels.push(b.rel);
        out.refs.push(b);
      } else if ((k === null || k === "ext") && b.rel !== "implements") {
        // An implemented interface outside the graph brings no member; any other base may.
        out.outside = true;
        out.order.push({ outside: info.family === "ruby" || b.qualifier === null ? b.name : `${b.qualifier}.${b.name}`, rel: b.rel });
      }
    }
    return out;
  };

  // A member found past a base outside the graph that the language looks
  // in first: that base may define it, so the binding is likely at most.
  const pastOutside = (outside: string, name: string, ev: Ev | null): Ev => {
    const caveat: Ev =
      outside.startsWith(DYNAMIC_BASE)
        ? { kind: "same-scope", tier: "likely", via: null, note: `The lookup passes a base written as an expression, which the graph does not read, before it finds ${name}; that base may define it.`, rule: "lookup-past-dynamic-base" }
        : { kind: "same-scope", tier: "likely", via: null, note: `The lookup passes ${outside}, a class outside the graph, before it finds ${name}; the graph assumes ${outside} does not define it.`, rule: "lookup-past-outside" };
    return ev ? chain(ev, caveat) : caveat;
  };

  // A step from a class to its base: the base binding's evidence, then
  // what was found past it. The weakest step decides the tier.
  const throughBase = (base: Ev, past: Ev | null): Ev => (past ? chain(base, past) : base);

  // A member found by a lookup: its definitions and the evidence of the
  // steps to the class that defines it; a gap when the language's order
  // cannot pick one; null when no class on the way defines it.
  type Lookup = { ids: string[]; ev: Ev | null; zero?: { id: string; ev: Ev | null }[] } | { gap: Cause; note: string } | null;
  const ownMethods = (key: string, name: string, side: Side): string[] | undefined => methodsOn[side].get(key)?.get(name);
  const shortKey = (key: string) => key.slice(key.lastIndexOf("::") + 2) || key;
  const stepped = (base: Ev, hit: Lookup): Lookup => (hit && "ids" in hit ? { ids: hit.ids, ev: throughBase(base, hit.ev) } : hit);

  // A lookup's answer depends only on the class, the member and the side,
  // so each is made once.
  const lookupMemo = { s: new Map<string, Map<string, Lookup>>(), i: new Map<string, Map<string, Lookup>>() };
  function methodOn(key: string, name: string, side: Side, _depth = 0): Lookup {
    let perKey = lookupMemo[side].get(key);
    if (!perKey) lookupMemo[side].set(key, (perKey = new Map()));
    const kept = perKey.get(name);
    if (kept !== undefined) return kept;
    const family = classes.get(key)?.family;
    const out =
      family === "python" ? pyLookup(key, name, side) : family === "go" ? goLookup(key, name, side) : family === "ruby" ? rbLookup(key, name, side, 0, new Set()) : family === "java" ? javaLookup(key, name, side) : firstWins(key, name, side);
    perKey.set(name, out);
    return out;
  }

  // TypeScript and JavaScript: the class, then its superclass chain, then
  // the interfaces it implements, in the order written, depth first. Each
  // class is visited once: one met again by another path holds nothing
  // new, so interfaces that each extend many others cost their number, not
  // the number of paths through them.
  function firstWins(key: string, name: string, side: Side): Lookup {
    const own = ownMethods(key, name, side);
    if (own) return { ids: own, ev: null };
    const seen = new Set([key]);
    const stack: ({ key: string; ev: Ev } | { outside: string })[] = [];
    const pushBases = (k: string, ev: Ev | null) => {
      const b = basesOf(k);
      for (let j = b.order.length - 1; j >= 0; j--) {
        const slot = b.order[j] as Slot;
        if ("outside" in slot) stack.push({ outside: slot.outside });
        else stack.push({ key: b.keys[slot.i] as string, ev: ev ? chain(ev, b.evs[slot.i] as Ev) : (b.evs[slot.i] as Ev) });
      }
    };
    pushBases(key, null);
    let outside: string | null = null;
    while (stack.length > 0) {
      const top = stack.pop() as { key: string; ev: Ev } | { outside: string };
      if ("outside" in top) {
        outside ??= top.outside;
        continue;
      }
      if (seen.has(top.key)) continue;
      seen.add(top.key);
      const found = ownMethods(top.key, name, side);
      if (found) return { ids: found, ev: outside ? pastOutside(outside, name, top.ev) : top.ev };
      pushBases(top.key, top.ev);
    }
    return null;
  }

  // Public instance methods on Java interfaces can hide inherited defaults.
  const javaInterfaceMethodOwner = (id: string): string | null => {
    const d = defById.get(id);
    if (!d || d.family !== "java" || d.kind !== "method" || !d.exported || d.static || d.ctor) return null;
    const key = classKey("java", d.file, d.owner ?? "");
    return isIface(key) ? key : null;
  };
  // A public instance method with a body on a Java interface is a default.
  const javaDefaultOwner = (id: string): string | null => defById.get(id)?.abstract ? null : javaInterfaceMethodOwner(id);
  const javaInterfaceAncestorsMemo = new Map<string, Set<string>>();
  const javaInterfaceAncestors = (key: string): Set<string> => {
    const kept = javaInterfaceAncestorsMemo.get(key);
    if (kept) return kept;
    const seen = new Set([key]);
    const stack = [key];
    while (stack.length > 0 && seen.size < 10_000) {
      if (seen.size % 1024 === 0) checkBudget();
      for (const base of basesOf(stack.pop() as string).keys) {
        if (seen.has(base) || !isIface(base)) continue;
        seen.add(base);
        stack.push(base);
      }
    }
    seen.delete(key);
    javaInterfaceAncestorsMemo.set(key, seen);
    return seen;
  };

  // Java: every member of the name along the superclass chain, then along
  // the interfaces (an interface's own bases are interfaces), each class
  // visited once. A Java class inherits every overload it does not hide, so
  // the lookup never stops at the first class that declares the name; the
  // argument count chooses among them later (javaOverloads). A superclass
  // outside the graph passed before a hit makes that hit likely at most.
  // Static members are not inherited from interfaces.
  function javaLookup(key: string, name: string, side: Side): Lookup {
    const hits: { ids: string[]; ev: Ev | null }[] = [];
    const seen = new Set<string>();
    let outside: string | null = null;
    const ifaces: { key: string; ev: Ev | null }[] = [];
    const take = (k: string, ev: Ev | null) => {
      const own = ownMethods(k, name, side);
      if (own) hits.push({ ids: own, ev: outside ? pastOutside(outside, name, ev) : ev });
    };
    const step = (ev: Ev | null, base: Ev): Ev => (ev ? chain(ev, base) : base);
    let cur: { key: string; ev: Ev | null } | null = { key, ev: null };
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      take(cur.key, cur.ev);
      const b = basesOf(cur.key);
      const isInterface = isIface(cur.key);
      let next: { key: string; ev: Ev | null } | null = null;
      for (const slot of b.order) {
        if ("outside" in slot) {
          if (slot.rel !== "implements" && !isInterface) outside ??= slot.outside;
          continue;
        }
        const at: { key: string; ev: Ev | null } = { key: b.keys[slot.i] as string, ev: step(cur.ev, b.evs[slot.i] as Ev) };
        if (isInterface || isIface(at.key) || b.rels[slot.i] === "implements") ifaces.push(at);
        else next ??= at;
      }
      cur = next;
    }
    if (side === "i") {
      for (let i = 0; i < ifaces.length && i < 10_000; i++) {
        const at = ifaces[i] as { key: string; ev: Ev | null };
        if (seen.has(at.key)) continue;
        seen.add(at.key);
        take(at.key, at.ev);
        const b = basesOf(at.key);
        b.keys.forEach((k, j) => ifaces.push({ key: k, ev: step(at.ev, b.evs[j] as Ev) }));
      }
    }
    if (hits.length === 0) return null;
    // Only zero-parameter signatures can be proved equal without parameter types.
    const declarations = hits.flatMap((h) => h.ids.flatMap((id) => {
      const owner = javaInterfaceMethodOwner(id);
      return owner === null ? [] : [{ id, owner, count: defById.get(id)?.params?.length ?? 0 }];
    }));
    const defaults = declarations.filter((d) => d.count === 0 && javaDefaultOwner(d.id) !== null);
    const hidden = new Set(defaults.filter((a) => declarations.some((b) =>
      a.owner !== b.owner && a.count === b.count && javaInterfaceAncestors(b.owner).has(a.owner) && !javaInterfaceAncestors(a.owner).has(b.owner),
    )).map((d) => d.id));
    const kept = hits.map((h) => ({ ...h, ids: h.ids.filter((id) => !hidden.has(id)) })).filter((h) => h.ids.length > 0);
    const ids = [...new Set(kept.flatMap((h) => h.ids))];
    const evs = kept.map((h) => h.ev).filter((e): e is Ev => e !== null);
    let ev: Ev | null = null;
    for (const e of evs) ev = ev === null ? e : chain(ev, e);
    // An outside superclass may declare a better overload for a call with arguments.
    if (outside !== null) ev = pastOutside(outside, name, ev);
    // Fixed zero-argument members keep only evidence from the path before their declaration.
    const zero = kept.flatMap((h) => h.ids.filter((id) => {
      const d = defById.get(id);
      return d?.params?.length === 0 && !d.varargs && !d.ctor;
    }).map((id) => ({ id, ev: h.ev })));
    return { ids, ev, zero };
  }

  // Python: the C3 linearisation of the class over its bases in the graph,
  // with the evidence of the steps to each class on it; null when it
  // cannot be established (an inconsistent or cyclic hierarchy, or one
  // deeper than the graph follows).
  const mroMemo = new Map<string, { keys: string[]; evs: (Ev | null)[] } | null>();
  const mroOpen = new Set<string>();
  function mro(key: string, depth = 0): { keys: string[]; evs: (Ev | null)[] } | null {
    const kept = mroMemo.get(key);
    if (kept !== undefined) return kept;
    if (depth > MAX_DEPTH || mroOpen.has(key)) return null;
    mroOpen.add(key);
    const b = basesOf(key);
    const lists: { keys: string[]; evs: (Ev | null)[] }[] = [];
    // A base outside the graph keeps its place, named by its spelling with a
    // leading "?", so a lookup that reaches it knows the member may be there.
    const heads: string[] = [];
    let failed = false;
    for (const slot of b.order) {
      if (failed) break;
      if ("outside" in slot) {
        lists.push({ keys: [`?${slot.outside}`], evs: [null] });
        heads.push(`?${slot.outside}`);
        continue;
      }
      const sub = mro(b.keys[slot.i] as string, depth + 1);
      if (!sub) failed = true;
      else {
        lists.push({ keys: sub.keys, evs: sub.evs.map((e) => throughBase(b.evs[slot.i] as Ev, e)) });
        heads.push(b.keys[slot.i] as string);
      }
    }
    mroOpen.delete(key);
    let out: { keys: string[]; evs: (Ev | null)[] } | null = null;
    if (!failed) {
      const evOf = new Map<string, Ev | null>();
      for (const l of lists) l.keys.forEach((k, j) => evOf.has(k) || evOf.set(k, l.evs[j] ?? null));
      const seqs = [...lists.map((l) => [...l.keys]), heads];
      const keys = [key];
      const evs: (Ev | null)[] = [null];
      for (;;) {
        const live = seqs.filter((s) => s.length > 0);
        if (live.length === 0) break;
        const head = live.map((s) => s[0] as string).find((h) => !live.some((s) => s.indexOf(h) > 0));
        if (head === undefined) {
          failed = true;
          break;
        }
        keys.push(head);
        evs.push(evOf.get(head) ?? null);
        for (const s of live) if (s[0] === head) s.shift();
      }
      if (!failed) out = { keys, evs };
    }
    if (depth === 0 || out !== null) mroMemo.set(key, out);
    return out;
  }
  function pyLookup(key: string, name: string, side: Side): Lookup {
    const order = mro(key);
    if (!order) {
      const own = ownMethods(key, name, side);
      if (own) return { ids: own, ev: null };
      return basesOf(key).keys.length > 0 ? { gap: "ambiguous", note: `the method resolution order of ${shortKey(key)} cannot be established (an inconsistent, cyclic or very deep hierarchy)` } : null;
    }
    let outside: string | null = null;
    for (let i = 0; i < order.keys.length; i++) {
      const k = order.keys[i] as string;
      if (k.startsWith("?")) {
        outside ??= k.slice(1);
        continue;
      }
      const own = ownMethods(k, name, side);
      if (own) return { ids: own, ev: outside ? pastOutside(outside, name, order.evs[i] ?? null) : (order.evs[i] ?? null) };
    }
    return null;
  }

  // Go: the shallowest embedding depth wins; two at the same depth is an
  // ambiguous selector Go itself refuses, and so is one type reached along
  // two paths at that depth (two embedded types that both embed it). Each
  // level counts the paths to each type, up to two, and expands each type
  // once; a type met at a shallower depth is not walked again.
  function goLookup(key: string, name: string, side: Side): Lookup {
    let level = new Map<string, { paths: number; ev: Ev | null }>([[key, { paths: 1, ev: null }]]);
    const done = new Set<string>();
    // An embedded type outside the graph at this depth or above may define it too.
    let outside: string | null = null;
    for (let depth = 0; depth <= MAX_DEPTH && level.size > 0; depth++) {
      const hits: { key: string; ids: string[]; paths: number; ev: Ev | null }[] = [];
      for (const [k, x] of level) {
        done.add(k);
        const own = ownMethods(k, name, side);
        if (own) hits.push({ key: k, ids: own, paths: x.paths, ev: x.ev });
      }
      const paths = hits.reduce((n, h) => n + h.paths, 0);
      if (paths === 1) {
        const hit = hits[0] as { ids: string[]; ev: Ev | null };
        return { ids: hit.ids, ev: outside ? pastOutside(outside, name, hit.ev) : hit.ev };
      }
      if (paths > 1) {
        const why = hits.length > 1 ? `from ${hits.length} embedded types at the same depth (${hits.map((h) => shortKey(h.key)).join(", ")})` : `from ${shortKey((hits[0] as { key: string }).key)} along two embedding paths at the same depth`;
        return { gap: "ambiguous", note: `${name} is promoted ${why}, a selector Go refuses` };
      }
      const next = new Map<string, { paths: number; ev: Ev | null }>();
      for (const [k, x] of level) {
        const b = basesOf(k);
        for (const slot of b.order) if ("outside" in slot) outside ??= slot.outside;
        b.keys.forEach((base, i) => {
          if (done.has(base)) return;
          const kept = next.get(base);
          if (kept) kept.paths = Math.min(2, kept.paths + x.paths);
          else next.set(base, { paths: x.paths, ev: x.ev ? chain(x.ev, b.evs[i] as Ev) : (b.evs[i] as Ev) });
        });
      }
      level = next;
    }
    return null;
  }

  // Ruby: on an instance, the prepended modules (the last prepended
  // first), the class, the included modules (the last included first),
  // then the superclass; on the class, its own class methods, the modules
  // it extends (the last first), then the superclass's class methods.
  // `seen`: the modules and classes this lookup has entered, each entered once.
  function rbLookup(key: string, name: string, side: Side, depth: number, seen: Set<string>): Lookup {
    const entry = `${side} ${key}`;
    if (depth > MAX_DEPTH || seen.has(entry)) return null;
    seen.add(entry);
    const b = basesOf(key);
    const by = (rel: TypeRef["rel"]) => b.order.filter((slot) => ("outside" in slot ? slot.rel : b.rels[slot.i]) === rel);
    let outside: string | null = null;
    const through = (slots: Slot[], at: Side): Lookup => {
      for (const slot of slots) {
        if ("outside" in slot) {
          outside ??= slot.outside;
          continue;
        }
        const hit = rbLookup(b.keys[slot.i] as string, name, at, depth + 1, seen);
        if (hit && "ids" in hit && outside) return { ids: hit.ids, ev: pastOutside(outside, name, throughBase(b.evs[slot.i] as Ev, hit.ev)) };
        if (hit) return stepped(b.evs[slot.i] as Ev, hit);
      }
      return null;
    };
    if (side === "i") {
      const pre = through(by("prepend").reverse(), "i");
      if (pre) return pre;
      const own = ownMethods(key, name, "i");
      if (own) return { ids: own, ev: null };
      return through(by("include").reverse(), "i") ?? through(by(undefined), "i");
    }
    const own = ownMethods(key, name, "s");
    if (own) return { ids: own, ev: null };
    // A Ruby module's instance methods are called on the module itself
    // through module_function or extend self.
    const info = classes.get(key);
    if (info?.ids.every((id) => defById.get(id)?.kind === "module")) {
      const viaModule = ownMethods(key, name, "i");
      if (viaModule) return { ids: viaModule, ev: null };
    }
    return through(by("extend").reverse(), "i") ?? through(by(undefined), "s");
  }

  // Whether any class in the base chain of `key` is outside the graph,
  // each class looked at once.
  const outsideMemo = new Map<string, boolean>();
  const outsideBase = (key: string): boolean => {
    const kept = outsideMemo.get(key);
    if (kept !== undefined) return kept;
    let out = false;
    const seen = new Set<string>();
    const stack = [key];
    while (stack.length > 0 && !out) {
      const k = stack.pop() as string;
      if (seen.has(k)) continue;
      seen.add(k);
      const b = basesOf(k);
      if (b.outside) out = true;
      b.keys.forEach((base, i) => {
        if (b.rels[i] !== "implements") stack.push(base);
      });
    }
    outsideMemo.set(key, out);
    return out;
  };

  // ---------- implementers: subclasses, implementers and method sets ----------
  // Which classes extend, include, prepend or implement each class key.
  // Go embedding is not inheritance: a Go type is reached only through
  // the method sets of interfaces.
  let subIndex: Map<string, { key: string; i: number }[]> | null = null;
  const subsOf = (key: string): { key: string; i: number }[] => {
    if (subIndex === null) {
      const built = new Map<string, { key: string; i: number }[]>();
      for (const [k, info] of classes) {
        if (info.family === "go") continue;
        const b = basesOf(k);
        b.keys.forEach((base, i) => {
          if (b.rels[i] !== "extend") push(built, base, { key: k, i });
        });
      }
      subIndex = built;
    }
    return subIndex.get(key) ?? [];
  };

  // A name from Python's typing module (`Protocol`, `typing.Protocol`).
  const isTyping = (file: string, t: TypeRef, name: string): boolean => {
    if (t.name !== name) return false;
    if (t.qualifier === null) {
      const b = index.bindings(file).names.get(name);
      return b?.kind === "named" && b.imported === name && b.mod !== null && "ext" in b.mod && TYPING.has(b.mod.ext);
    }
    if (t.qualifier.includes(".")) return false;
    const b = index.bindings(file).names.get(t.qualifier);
    return b?.kind === "pyns" && TYPING.has(b.dotted);
  };
  const protocolMemo = new Map<string, boolean>();
  const isProtocol = (key: string): boolean => {
    let v = protocolMemo.get(key);
    if (v !== undefined) return v;
    const info = classes.get(key);
    v = info?.family === "python" && info.bases.some((b) => isTyping(info.file, b, "Protocol"));
    protocolMemo.set(key, v);
    return v;
  };
  // A TypeScript interface, a Go interface type or a Python Protocol: a
  // contract whose members other types implement.
  const isIface = (key: string): boolean => classes.get(key)?.ids.some((id) => defById.get(id)?.iface === true) === true || isProtocol(key);

  // The member names a Go interface or a Python Protocol declares, its
  // bases' included; null when a base is outside the graph (the set is not
  // literal) or it declares none.
  const contractMemo = new Map<string, Set<string> | null>();
  const contractNames = (key: string, depth = 0): Set<string> | null => {
    const kept = contractMemo.get(key);
    if (kept !== undefined) return kept;
    if (depth > MAX_DEPTH) return null;
    const info = classes.get(key);
    let out: Set<string> | null = new Set(methodsOn.i.get(key)?.keys() ?? []);
    for (const b of info?.bases ?? []) {
      const k = typeKey(info?.file ?? "", info?.family ?? "go", b);
      if (k !== null && k !== "ext" && k.key !== key) {
        const sub = contractNames(k.key, depth + 1);
        if (sub === null) out = null;
        else for (const n of sub) out?.add(n);
      } else if (!(info?.family === "python" && (isTyping(info.file, b, "Protocol") || isTyping(info.file, b, "Generic")))) out = null;
      if (out === null) break;
    }
    if (out !== null && out.size === 0) out = null;
    contractMemo.set(key, out);
    return out;
  };
  // The member names a type has: its own and those it inherits or that
  // embedding promotes.
  const namesMemo = new Map<string, Set<string>>();
  const memberNames = (key: string, depth = 0): Set<string> => {
    const kept = namesMemo.get(key);
    if (kept) return kept;
    const out = new Set<string>(methodsOn.i.get(key)?.keys() ?? []);
    namesMemo.set(key, out);
    if (depth <= MAX_DEPTH) for (const k of basesOf(key).keys) for (const n of memberNames(k, depth + 1)) out.add(n);
    return out;
  };
  // Per family and member name, the types that have it: built once.
  const typesByName = new Map<Family, Map<string, string[]>>();
  const typesNamed = (family: Family, name: string): string[] => {
    let byName = typesByName.get(family);
    if (!byName) {
      byName = new Map();
      typesByName.set(family, byName);
      for (const [k, info] of classes) {
        if (info.family !== family || isIface(k)) continue;
        for (const n of memberNames(k)) push(byName, n, k);
      }
    }
    return byName.get(name) ?? [];
  };
  // The types whose members cover every member of a Go interface or a
  // Python Protocol, by name: Go's satisfaction, a Protocol's structural match.
  const methodSetMemo = new Map<string, string[]>();
  const methodSetImplementers = (key: string): string[] => {
    const kept = methodSetMemo.get(key);
    if (kept) return kept;
    let out: string[] = [];
    const info = classes.get(key);
    const names = info && (info.family === "go" || isProtocol(key)) && isIface(key) ? contractNames(key) : null;
    if (info && names) {
      const [first, ...rest] = [...names];
      out = typesNamed(info.family, first as string).filter((k) => k !== key && rest.every((n) => memberNames(k).has(n)));
    }
    methodSetMemo.set(key, out);
    return out;
  };

  // The classes directly below a class key: subclasses, includers,
  // declared implementers, and for a Go interface or a Python Protocol the
  // types matching its method set. A generic argument never drops one:
  // TypeScript compares `Repo<A>` and `Repo<B>` by the shapes of A and B,
  // which the graph does not hold whole, so a difference is never proved.
  function childrenOf(key: string): string[] {
    const out: string[] = [];
    for (const s of subsOf(key)) out.push(s.key);
    if (isIface(key)) for (const k of methodSetImplementers(key)) out.push(k);
    return out;
  }

  // The implementations or overrides a call bound to `declared` on `key`
  // may run: for each class below `key`, the method its own lookup finds,
  // never an abstract member nor the declared one, in path and line order.
  // Per class key, then per member name and side: the declared member
  // follows from those, so it is no part of the key.
  const dispatchMemo = new Map<string, Map<string, string[]>>();
  // Java: only members whose parameter count fits the call's arguments,
  // and never a member the static type itself has (its own overloads and
  // those it inherits are bound, not dispatched to).
  const javaCount = (id: string): number => defById.get(id)?.params?.length ?? 0;
  const dispatchTargets = (key: string, name: string, side: Side, declared: readonly string[]): string[] => {
    let perKey = dispatchMemo.get(key);
    if (!perKey) dispatchMemo.set(key, (perKey = new Map()));
    const java = classes.get(key)?.family === "java";
    // Java: an override has the bound member's parameter count (`T...` and `T[]` alike).
    const counts = java ? new Set(declared.map(javaCount)) : null;
    const memoKey = `${side === "i" ? name : `${name} s`}${counts ? ` ${[...counts].sort().join(",")}` : ""}`;
    const kept = perKey.get(memoKey);
    if (kept) return kept;
    const skip = new Set(declared);
    if (java) {
      const above = new Set<string>([key]);
      const stack = [key];
      while (stack.length > 0 && above.size < 10_000) {
        for (const k of basesOf(stack.pop() as string).keys) {
          if (above.has(k)) continue;
          above.add(k);
          stack.push(k);
        }
      }
      for (const k of above) for (const id of [...(methodsOn.i.get(k)?.get(name) ?? []), ...(methodsOn.s.get(k)?.get(name) ?? [])]) skip.add(id);
    }
    const found = new Set<string>();
    const seen = new Set<string>([key]);
    const queue = childrenOf(key);
    for (let i = 0; i < queue.length && seen.size < 100_000; i++) {
      if (i % 1024 === 1023) checkBudget();
      const k = queue[i] as string;
      if (seen.has(k)) continue;
      seen.add(k);
      const hit = methodOn(k, name, side, 0);
      if (hit && "ids" in hit) for (const id of hit.ids) if (!skip.has(id) && defById.get(id)?.abstract !== true) found.add(id);
      for (const c of childrenOf(k)) if (!seen.has(c)) queue.push(c);
    }
    const out = [...found].filter((id) => counts === null || counts.has(javaCount(id))).sort((a, b) => {
      const x = defById.get(a);
      const y = defById.get(b);
      return (x?.file ?? a).localeCompare(y?.file ?? b) || (x?.line ?? 0) - (y?.line ?? 0) || a.localeCompare(b);
    });
    perKey.set(memoKey, out);
    return out;
  };

  // `seen`: the classes this lookup has entered, each entered once.
  const fieldKey = (key: string, field: string, depth = 0, seen = new Set<string>()): TypeHit => {
    if (depth > MAX_DEPTH || seen.has(key)) return null;
    seen.add(key);
    const info = classes.get(key);
    const t = info?.fields.get(field);
    if (info && t) return typeKey(info.file, info.family, t, 0, false, info.scope ?? null);
    const b = basesOf(key);
    for (let i = 0; i < b.keys.length; i++) {
      const hit = fieldKey(b.keys[i] as string, field, depth + 1, seen);
      if (hit === "ext") return hit;
      if (hit) return { key: hit.key, ev: throughBase(b.evs[i] as Ev, hit.ev) };
    }
    return null;
  };

  // The class whose method the caller is: its owner in this file.
  const enclosingClass = (file: string, family: Family, caller: Def | undefined): string | null => {
    if (!caller) return null;
    if (caller.kind === "class" || caller.kind === "module") return classOfId.get(caller.id) ?? null;
    if (caller.kind !== "method" || !caller.owner) return null;
    return classKey(family, file, caller.owner);
  };

  // ---------- calls ----------
  // Where a call bound through a type that others extend or implement may
  // also go: the static type and the side.
  type Dispatch = { key: string; side: Side };
  type Outcome =
    | { ids: string[]; ev: Ev; dispatch?: Dispatch }
    | { miss: { target: string; name: string }; ev: Ev; cause: Cause }
    | { ext: true }
    | "ignore"
    | { unknown: Cause; shape: Shape; note?: string; candidates?: string[] | null; scope?: "file" | "project" };

  const receiverKind = (t: TypeRef, path: string[]): EvidenceKind => {
    if (path.length > 0) return "receiver-field";
    if (t.declared) return "receiver-annotation";
    if (t.result !== undefined) return "receiver-result";
    return "receiver-constructor";
  };

  const fromValue = (v: Value | null, shape: Shape): Outcome => {
    if (!v) return { unknown: "no-receiver-type", shape };
    if (v.v === "ext") return { ext: true };
    if (v.v === "gap") return { unknown: v.cause, shape, note: v.note, candidates: v.candidates };
    if (v.v === "miss") return { miss: { target: v.target, name: v.name }, ev: v.ev, cause: "miss" };
    if (v.v === "sym") return { ids: v.ids, ev: v.ev };
    // A CommonJS module called as a function calls what `module.exports` holds.
    if (v.v === "mod" && familyOf(facts.get(v.file)?.lang ?? "go") === "js" && facts.get(v.file)?.defaultExport) {
      return fromValue(withEv(index.exports(v.file, "default", 0), v.ev), shape);
    }
    return "ignore"; // a module, a package or an outside module called as a function
  };

  const onClass = (key: string, name: string, side: Side, ev: Ev): Outcome => {
    const info = classes.get(key);
    if (name === "new" && side === "s" && info?.family === "ruby") return { ids: info.ids, ev };
    const hit = index.members(key, name, side);
    if (hit && "gap" in hit) return { unknown: hit.gap, shape: "typed", note: hit.note };
    if (hit) return { ids: hit.ids, ev: hit.ev ? chain(ev, hit.ev) : ev };
    // Not on the class or its bases in the repository: inherited from a
    // base outside the graph, or gone.
    // An interface or a type alias: its members are not definitions the
    // graph follows yet (phase 2 binds calls through them).
    if (info && info.ids.every((id) => defById.get(id)?.kind === "type")) return { miss: { target: key, name }, ev, cause: "no-receiver-type" };
    return { miss: { target: key, name }, ev, cause: outsideBase(key) ? "no-receiver-type" : "miss" };
  };

  const followPath = (start: TypeHit, path: string[]): TypeHit => {
    let k = start;
    for (const p of path) {
      if (k === null || k === "ext") return k;
      const next = fieldKey(k.key, p);
      k = next === null || next === "ext" ? next : { key: next.key, ev: chain(k.ev, next.ev) };
    }
    return k;
  };

  const rbGlobal = (name: string): Outcome => {
    const ids = rbTop.get(name);
    const files = filesByName.get(`ruby:${name}`)?.size ?? 0;
    if (ids && ids.length === 1 && files <= HUB_FILES) {
      return { ids, ev: { kind: "autoload", tier: "likely", via: null, note: "The only Ruby definition of this name, in at most 8 files, bound by the autoload convention.", rule: "rb-autoload-global" } };
    }
    if (files > 0) return { unknown: "ambiguous", shape: "bare", note: `${files} files define ${name}`, candidates: [...(filesByName.get(`ruby:${name}`) ?? [])].slice(0, 8) };
    return { unknown: "miss", shape: "bare", note: `no definition of ${name} in the repository` };
  };

  // ---------- Java calls ----------
  // Whether a Java member takes `k` arguments: its parameter count, or for
  // varargs any count from its fixed parameters up.
  const javaFits = (id: string, k: number): boolean => {
    const d = defById.get(id);
    const n = d?.params?.length ?? 0;
    return d?.varargs === true ? k >= n - 1 : k === n;
  };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  // The arity rule: the members whose parameter count fits the call's
  // argument count stay. One left binds at the receiver's tier; several
  // bind as possible. A call whose argument list did not parse keeps every
  // member as possible. The count never picks a wrong member, it only fails
  // to narrow: the parameter types are not compared.
  // `value`: a method reference, which passes no arguments to count.
  const javaOverloads = (ids: string[], name: string, arity: number | undefined, ev: Ev, value = false): Outcome => {
    const possible = (keep: string[], why: string): Outcome => ({ ids: keep, ev: { ...ev, tier: "possible", note: [ev.note, why].filter(Boolean).join(" "), rule: "java-overloads" } });
    if (arity === undefined && value && ids.length === 1) return { ids, ev };
    if (arity === undefined) return possible(ids, `${plural(ids.length, "member")} named ${name} may take this call; its argument list was not read, so the count does not choose.`);
    const fit = ids.filter((id) => javaFits(id, arity));
    if (fit.length === 1) return { ids: fit, ev };
    if (fit.length > 1) return possible(fit, `${fit.length} members named ${name} take ${plural(arity, "argument")}; the graph does not compare parameter types.`);
    return { unknown: "no-receiver-type", shape: "typed", note: `no member named ${name} takes ${plural(arity, "argument")}; a member outside the graph may` };
  };
  const javaSimple = (key: string): string => {
    const q = key.slice(key.lastIndexOf("::") + 2);
    return q.slice(q.lastIndexOf(".") + 1);
  };
  // A member of a Java class by the lookup and the arity rule. `both`: the
  // static and the instance side together (a bare call, a method
  // reference); `value`: a method reference, which passes no arguments.
  const javaOn = (key: string, name: string, side: Side, ev: Ev, arity: number | undefined, both = false, value = both): Outcome => {
    const sides: Side[] = both ? ["i", "s"] : [side];
    const ids: string[] = [];
    const zeroEvidence = new Map<string, Ev | null>();
    let inner: Ev | null = null;
    for (const at of sides) {
      const hit = index.members(key, name, at);
      if (hit && "gap" in hit) return { unknown: hit.gap, shape: "typed", note: hit.note };
      if (!hit) continue;
      // A constructor is no member: only javaCtor reads it.
      for (const id of hit.ids) if (!ids.includes(id) && defById.get(id)?.ctor !== true) ids.push(id);
      for (const zero of hit.zero ?? []) if (!zeroEvidence.has(zero.id)) zeroEvidence.set(zero.id, zero.ev);
      if (hit.ev) inner = inner ? chain(inner, hit.ev) : hit.ev;
    }
    if (ids.length === 0) return { miss: { target: key, name }, ev, cause: outsideBase(key) ? "no-receiver-type" : "miss" };
    // A nearer class body suppresses an abstract member with the same parameter count.
    // Interface defaults prove this only for zero-parameter methods.
    // Two members on one class remain overloads.
    const classOf = (id: string) => {
      const d = defById.get(id);
      return d ? classKey("java", d.file, d.owner ?? "") : id;
    };
    // The lookup lists members nearest to the receiver first.
    const live = ids.filter((id, i) => {
      if (defById.get(id)?.abstract !== true) return true;
      return !ids.some((b, j) => j < i && defById.get(b)?.abstract !== true
        && (javaCount(id) === 0 || javaDefaultOwner(b) === null)
        && javaCount(b) === javaCount(id) && classOf(b) !== classOf(id));
    });
    // The nearest fixed zero-argument member wins over varargs, including inherited members.
    // Bases passed before that member still contribute their evidence.
    if (arity === 0) {
      const fixed = live.find((id) => javaCount(id) === 0 && !defById.get(id)?.varargs);
      if (fixed) {
        // Unrelated defaults remain possible. A class member still wins first.
        const candidates = javaDefaultOwner(fixed) === null ? [fixed] : live.filter((id) =>
          javaCount(id) === 0 && !defById.get(id)?.varargs && javaDefaultOwner(id) !== null,
        );
        let evidence = ev;
        for (const id of candidates) {
          const step = zeroEvidence.get(id);
          if (step) evidence = chain(evidence, step);
        }
        return javaOverloads(candidates, name, arity, evidence, value);
      }
    }
    return javaOverloads(live, name, arity, inner ? chain(ev, inner) : ev, value);
  };
  // `new T(...)`, `this(...)`, `super(...)`: the constructors T itself
  // declares (they are not inherited). None declared: the default
  // constructor runs no code of the repository, and the call is dropped
  // (the extractor records the type use).
  const classOfMember = (id: string): string => {
    const d = defById.get(id);
    return d ? classKey("java", d.file, d.owner ?? "") : id;
  };
  const javaCtor = (key: string, arity: number | undefined, ev: Ev): Outcome => {
    const name = javaSimple(key);
    const ids = (methodsOn.s.get(key)?.get(name) ?? []).filter((id) => defById.get(id)?.ctor === true);
    return ids.length === 0 ? "ignore" : javaOverloads(ids, name, arity, ev);
  };
  // The dotted path of the Java type a definition is read in.
  const javaNestingOf = (caller: Def | undefined): string | null => {
    if (!caller) return null;
    if (caller.kind === "class") return caller.owner ? `${caller.owner}.${caller.name}` : caller.name;
    return caller.owner;
  };
  // What a Java name receiver (`T.m()`, `Outer.Inner.m()`, `a.b.T.m()`,
  // `f.m()` with `f` a field the extractor did not see) stands for. Java
  // reads a simple name as a variable first, then a type, then a package.
  type JavaPath = { type: string; ev: Ev } | { inst: { key: string; ev: Ev } } | "ext" | { gap: Cause; note: string; candidates: string[] | null } | null;
  const javaPath = (file: string, parts: readonly string[], nesting: string | null): JavaPath => {
    const fieldEv: Ev = { kind: "receiver-field", tier: "certain", via: null, note: null, rule: "receiver-self" };
    for (const scope of javaScopes(file, nesting)) {
      const fk = fieldKey(scope, parts[0] as string);
      if (fk === "ext") return "ext";
      if (fk) {
        const k = followPath({ key: fk.key, ev: chain(fieldEv, fk.ev) }, parts.slice(1));
        return k === null ? null : k === "ext" ? "ext" : { inst: k };
      }
    }
    let v: Value | null = null;
    let i = parts.length;
    for (let n = parts.length; n >= 1 && v === null; n--) {
      // The longest prefix that names a type: `Outer.Inner.CONST` reads
      // `Outer.Inner`, then the field CONST of it.
      v = javaTypeValue(file, parts.slice(0, n), nesting);
      if (v !== null && v.v === "sym" && !classOfId.has(v.ids[0] as string)) v = null;
      i = n;
    }
    if (v === null) return javaExternal(parts.join(".")) ? "ext" : null;
    if (v.v === "ext") return "ext";
    if (v.v === "gap") return { gap: v.cause, note: v.note, candidates: v.candidates };
    if (v.v !== "sym" || v.ids.length !== 1) return null;
    const key = classOfId.get(v.ids[0] as string) as string;
    if (i === parts.length) return { type: key, ev: v.ev };
    // A static field of the type: an instance from here on.
    const fk = fieldKey(key, parts[i] as string);
    if (fk === "ext") return "ext";
    if (fk === null) return null;
    const k = followPath({ key: fk.key, ev: chain(v.ev, { ...fk.ev, kind: "receiver-field" }) }, parts.slice(i + 1));
    return k === null ? null : k === "ext" ? "ext" : { inst: k };
  };
  const javaCall = (file: string, call: CallFact, caller: Def | undefined, asValue: boolean): Outcome => {
    const r = call.recv;
    const nesting = javaNestingOf(caller);
    const arity = call.arity;
    const selfEv: Ev = { kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-self" };
    if (call.ctor) {
      if (r.kind === "self") {
        const own = enclosingClass(file, "java", caller);
        return own ? javaCtor(own, arity, selfEv) : "ignore";
      }
      if (r.kind === "super") {
        const key = enclosingClass(file, "java", caller);
        const bases = key ? basesOf(key) : null;
        const at = bases ? bases.rels.findIndex((rel, i) => rel !== "implements" && !isIface(bases.keys[i] as string)) : -1;
        const base = bases?.keys[at];
        // A superclass outside the graph: external when its name binds to a
        // declared dependency or the standard library, else unknown.
        if (!bases || !base) {
          const info = key ? classes.get(key) : undefined;
          const sup = info?.bases.find((t) => {
            if (t.rel !== undefined) return false;
            const base = typeKey(info.file, "java", t, 0, false, info.nesting);
            return base === null || base === "ext" || !isIface(base.key);
          });
          if (!info || !sup) return "ignore";
          return typeKey(info.file, "java", sup, 0, false, info.nesting) === "ext" ? { ext: true } : { unknown: "no-receiver-type", shape: "self", note: "the superclass is outside the graph" };
        }
        return javaCtor(base, arity, chain({ kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-super" }, bases.evs[at] as Ev));
      }
      if (r.kind === "name") {
        const p = javaPath(file, [r.name, ...r.path], nesting);
        if (p === "ext") return { ext: true };
        if (p === null) return { unknown: "no-receiver-type", shape: "name", note: `the type ${[r.name, ...r.path].join(".")} is not found in the graph` };
        if ("gap" in p) return { unknown: p.gap, shape: "name", note: p.note, candidates: p.candidates };
        if ("type" in p) return javaCtor(p.type, arity, p.ev);
        return { unknown: "no-receiver-type", shape: "name" };
      }
      if (r.kind === "type") {
        const key = typeKey(file, "java", r.type, 0, false, nesting);
        if (key === "ext") return { ext: true };
        return key ? javaCtor(key.key, arity, key.ev) : { unknown: "no-receiver-type", shape: "typed" };
      }
    }
    switch (r.kind) {
      case "none": {
        if (call.local !== undefined) return { ids: [symbolId(file, facts.get(file)?.defs[call.local] as DefFact)], ev: SAME_SCOPE };
        const v = javaLocal(file, call.name, 0, nesting);
        if (!v) return { miss: { target: file, name: call.name }, ev: SAME_SCOPE, cause: "miss" };
        const key = v.v === "sym" && v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
        if (key && v.v === "sym") return javaOn(key, call.name, "s", v.ev, arity);
        return fromValue(v, "bare");
      }
      case "self": {
        const own = enclosingClass(file, "java", caller);
        if (!own) return { unknown: "no-receiver-type", shape: "self", note: "this outside a method of a class" };
        if (r.path.length > 0) {
          const key = followPath({ key: own, ev: selfEv }, r.path);
          if (key === "ext") return { ext: true };
          if (key === null) return { unknown: "no-receiver-type", shape: "self", note: "a field whose type no rule knows" };
          return withDispatch(javaOn(key.key, call.name, "i", { ...key.ev, kind: "receiver-field" }, arity, asValue), { key: key.key, side: "i" });
        }
        // A bare m(): the class's members of both sides together (only the
        // static side in a static context), then each enclosing class's,
        // then the static imports.
        let first: Outcome | null = null;
        for (const key of [own, ...javaScopes(file, nesting).filter((k) => k !== own)]) {
          const out = javaOn(key, call.name, call.static ? "s" : "i", selfEv, arity, asValue || !call.static, asValue);
          if (out === "ignore") continue;
          if ("ids" in out) return out.ids.some((id) => methodsOn.i.get(classOfMember(id))?.get(call.name)?.includes(id) === true) ? withDispatch(out, { key, side: "i" }) : out;
          if ("unknown" in out) return out;
          if ("miss" in out && out.cause === "no-receiver-type") {
            return { unknown: "no-receiver-type", shape: "self", note: "An outside base may declare this method." };
          }
          first ??= out;
        }
        // Every static import of the name together (a single-member import
        // shadows the on-demand ones), then the arity rule once.
        const b = index.bindings(file);
        // Each candidate keeps the evidence of its own import; a source the
        // graph cannot read (outside it, or not found) may take the call.
        const viaImports = (bindings: readonly Binding[]): Outcome | null => {
          const evOf = new Map<string, Ev>();
          let open: Outcome | null = null;
          let outside = false;
          for (const binding of bindings) {
            const v = bindingValue(file, "java", call.name, binding, 0);
            if (!v || v.v === "miss") {
              outside = true;
              continue;
            }
            if (v.v === "ext") open ??= { ext: true };
            if (v.v === "gap") open ??= { unknown: v.cause, shape: "bare", note: v.note, candidates: v.candidates };
            const key = v.v === "sym" && v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
            if (!key || v.v !== "sym") {
              outside = true;
              continue;
            }
            const hit = index.members(key, call.name, "s");
            if (!hit || "gap" in hit) continue;
            const ev: Ev = { ...(hit.ev ? chain(v.ev, hit.ev) : v.ev), rule: "java-static-import" };
            for (const id of hit.ids) if (!evOf.has(id) && defById.get(id)?.ctor !== true) evOf.set(id, ev);
          }
          if (evOf.size === 0) return open;
          const base = [...evOf.values()][0] as Ev;
          const out = javaOverloads([...evOf.keys()], call.name, arity, base);
          if (out === "ignore" || !("ids" in out)) return out;
          // The weakest evidence among the candidates left decides.
          let ev = out.ev;
          for (const id of out.ids) {
            const own = evOf.get(id) as Ev;
            if (weakest(ev.tier, own.tier) !== ev.tier) ev = { ...ev, tier: own.tier, note: [ev.note, own.note].filter(Boolean).join(" ") || null };
          }
          if (open !== null || outside) ev = { ...ev, tier: "possible", note: [ev.note, "A static import outside the graph may take this call."].filter(Boolean).join(" "), rule: "java-static-import" };
          return { ids: out.ids, ev };
        };
        const viaNamed = viaImports(b.jstatic?.get(call.name) ?? []);
        if (viaNamed) return viaNamed;
        const viaStars = viaImports(b.jstaticStars ?? []);
        if (viaStars) return viaStars;
        return first ?? { unknown: "no-receiver-type", shape: "self" };
      }
      case "super": {
        const key = enclosingClass(file, "java", caller);
        const bases = key ? basesOf(key) : null;
        const at = bases ? bases.rels.findIndex((rel, i) => rel !== "implements" && !isIface(bases.keys[i] as string)) : -1;
        const base = bases?.keys[at];
        if (!bases || !base) return key && outsideBase(key) ? { unknown: "no-receiver-type", shape: "self", note: "the base class is outside the graph" } : { unknown: "no-receiver-type", shape: "self" };
        const superEv = chain({ kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-super" }, bases.evs[at] as Ev);
        return javaOn(base, call.name, call.static ? "s" : "i", superEv, arity, asValue);
      }
      case "type": {
        const t = typeKey(file, "java", r.type, 0, false, nesting);
        if (t === "ext") return { ext: true };
        if (t === null) {
          if (r.type.elem && r.path.length === 0) return { ext: true };
          const named = `${r.type.qualifier ? `${r.type.qualifier}.` : ""}${r.type.name}`;
          if (r.type.result === undefined) {
            const head = javaTypeValue(file, r.type.qualifier ? [...r.type.qualifier.split("."), r.type.name] : [r.type.name], nesting);
            if (head?.v === "gap") return { unknown: head.cause, shape: "typed", note: head.note, candidates: head.candidates };
          }
          const note = r.type.result !== undefined ? `what ${named} returns is not known to the graph` : `the type ${named} is not found in the graph`;
          return { unknown: "no-receiver-type", shape: "typed", note };
        }
        const key = followPath(t, r.path);
        if (key === "ext") return { ext: true };
        if (key === null) return { unknown: "no-receiver-type", shape: "typed", note: "a field whose type no rule knows" };
        const kind = receiverKind(r.type, r.path);
        const out = javaOn(key.key, call.name, "i", { ...key.ev, kind, rule: "receiver-type" }, arity, asValue);
        // A value a constructor made is of that class alone.
        return withDispatch(out, kind !== "receiver-constructor" ? { key: key.key, side: "i" } : null);
      }
      case "name": {
        const p = javaPath(file, [r.name, ...r.path], nesting);
        if (p === "ext") return { ext: true };
        if (p === null) return { unknown: "no-receiver-type", shape: "name" };
        if ("gap" in p) return { unknown: p.gap, shape: "name", note: p.note, candidates: p.candidates };
        if ("inst" in p) return withDispatch(javaOn(p.inst.key, call.name, "i", { ...p.inst.ev, kind: "receiver-field" }, arity, asValue), { key: p.inst.key, side: "i" });
        // `T.m()` and `new T()` (a call named like T on T): the static side.
        return javaOn(p.type, call.name, "s", p.ev, arity, asValue);
      }
      default:
        return { unknown: "no-receiver-type", shape: "other" };
    }
  };

  const resolveCall = (file: string, family: Family, call: CallFact, caller: Def | undefined, asValue = false): Outcome => {
    const r = call.recv;
    if (call.dynamic && call.result !== undefined) return { unknown: "dynamic", shape: "other", note: "a call of what another call returned: the graph cannot tell which function that is", scope: "project" };
    if (call.dynamic) return { unknown: "dynamic", shape: "other", note: "a computed callee: the graph cannot tell which function it calls", scope: "project" };
    if (family === "java") return javaCall(file, call, caller, asValue);
    const builtin = BUILTINS[family].has(call.name);
    switch (r.kind) {
      case "none": {
        if (family === "ruby") return builtin ? { ext: true } : rbGlobal(call.name);
        if (call.local !== undefined) return { ids: [symbolId(file, facts.get(file)?.defs[call.local] as DefFact)], ev: SAME_SCOPE };
        if (call.bound) return fromValue(boundValue(file, call.name, call.bound), "bare");
        if (call.shadowed) return { unknown: "dynamic", shape: "bare", note: "a call through a parameter or a local value", scope: "project" };
        const v = resolveLocal(file, call.name);
        if (!v) {
          if (builtin) return { ext: true };
          return { miss: { target: family === "go" ? `go:${pkgOf(file)}` : file, name: call.name }, ev: SAME_SCOPE, cause: "miss" };
        }
        return fromValue(v, "bare");
      }
      case "self": {
        // self in a static method or a class body is the class; a field of it is an instance.
        const side: Side = call.static && r.path.length === 0 ? "s" : "i";
        const own = enclosingClass(file, family, caller);
        if (!own) return { unknown: "no-receiver-type", shape: "self", note: "this or self outside a method of a class" };
        const key = followPath({ key: own, ev: { kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-self" } }, r.path);
        if (key === "ext") return { ext: true };
        if (key === null) return { unknown: "no-receiver-type", shape: "self", note: "a field whose type no rule knows" };
        const ev: Ev = { ...key.ev, kind: r.path.length > 0 ? "receiver-field" : "receiver-self" };
        const out = onClass(key.key, call.name, side, ev);
        if (family === "ruby" && r.path.length === 0 && typeof out === "object" && "miss" in out) {
          const global = rbGlobal(call.name);
          if (typeof global === "object" && "ids" in global) return global;
          if (builtin) return { ext: true };
        }
        // this or self may be an instance of a subclass that overrides the
        // method; a Go value is never anything but its own type.
        return withDispatch(out, family !== "go" || isIface(key.key) ? { key: key.key, side } : null);
      }
      case "super": {
        const key = enclosingClass(file, family, caller);
        const bases = key ? basesOf(key) : null;
        // The superclass, never an implemented interface.
        const at = bases ? bases.rels.findIndex((rel) => rel !== "implements") : -1;
        const base = bases?.keys[at];
        if (!bases || !base) return key && outsideBase(key) ? { unknown: "no-receiver-type", shape: "self", note: "the base class is outside the graph" } : { unknown: "no-receiver-type", shape: "self" };
        // super is the base class as the class's own declaration binds it.
        const superEv = chain({ kind: "receiver-self", tier: "certain", via: null, note: null, rule: "receiver-super" }, bases.evs[at] as Ev);
        return onClass(base, call.name, call.static ? "s" : "i", superEv);
      }
      case "type": {
        if (untypedType(file, family, r.type, 0)) {
          const spelled = r.type.name === "{}" ? "by an object type written in place" : `${r.type.qualifier ? `${r.type.qualifier}.` : ""}${r.type.name}`;
          return { unknown: "untyped-receiver", shape: "typed", note: `a value typed ${spelled} may be anything with a method of this name` };
        }
        const t = typeKey(file, family, r.type);
        if (t === "ext") return { ext: true };
        // A collection itself (an array, a list, a slice) or a value of a
        // built-in type the file does not redefine: the method is the
        // language's own.
        if (t === null && r.path.length === 0 && (r.type.elem || (!r.type.qualifier && BUILTIN_TYPES[family].has(r.type.name) && resolveLocal(file, r.type.name) === null))) return { ext: true };
        if (t === null) {
          const named = `${r.type.qualifier ? `${r.type.qualifier}.` : ""}${r.type.name}`;
          // `result`: the value is what calling `named` returns, not a type of that name.
          const note = r.type.result !== undefined ? `what ${named} returns is not known to the graph` : `the type ${named} is not found in the graph`;
          return { unknown: "no-receiver-type", shape: "typed", note };
        }
        const key = followPath(t, r.path);
        if (key === "ext") return { ext: true };
        if (key === null) return { unknown: "no-receiver-type", shape: "typed", note: "a field whose type no rule knows" };
        const kind = receiverKind(r.type, r.path);
        const out = onClass(key.key, call.name, "i", { ...key.ev, kind, rule: "receiver-type" });
        // A value a constructor made here is of that class alone; one typed
        // by an annotation, a declared result or a field may be any class
        // below it. In Go only an interface has implementations.
        const dispatches = family === "go" ? isIface(key.key) : kind !== "receiver-constructor";
        return withDispatch(out, dispatches ? { key: key.key, side: "i" } : null);
      }
      case "name": {
        if (family === "ruby") {
          const key = rbConst(r.name, r.nesting);
          if (!key) return { unknown: "no-receiver-type", shape: "name", note: `the constant ${r.name} is not defined in the repository` };
          return onClass(key, call.name, "s", rbConstEv(key, file));
        }
        let v = r.bound ? boundValue(file, r.name, r.bound) : resolveLocal(file, r.name);
        if (!v) return BUILTINS[family].has(r.name) ? { ext: true } : { unknown: "no-receiver-type", shape: "name" };
        // A path through a module or package; a field of a class value is not followed.
        for (const p of r.path) v = v?.v === "sym" ? null : attr(v, p);
        if (!v) return { unknown: "no-receiver-type", shape: "name" };
        if (v.v === "ext") return { ext: true };
        if (v.v === "gap") return { unknown: v.cause, shape: "name", note: v.note, candidates: v.candidates };
        if (v.v === "sym") {
          const key = v.ids.length === 1 ? classOfId.get(v.ids[0] as string) : undefined;
          return key ? onClass(key, call.name, "s", v.ev) : { unknown: "no-receiver-type", shape: "name", note: `${r.name} is not a class or a module` };
        }
        return fromValue(attr(v, call.name), "name");
      }
      default:
        return { unknown: "no-receiver-type", shape: "other" };
    }
  };

  // The outcomes onClass returns are made per call, so the dispatch is set on it in place.
  const withDispatch = (out: Outcome, d: Dispatch | null): Outcome => {
    if (d !== null && typeof out === "object" && "ids" in out) out.dispatch = d;
    return out;
  };

  // `rule`: the rule that made the edge, when it is not the one that bound
  // the name (a value use, a type use, an override rest on a binding).
  const siteOf = (file: string, line: number, column: number, ev: Ev, rule?: string): GraphSite => ({ file, line, column, tier: ev.tier, evidence: ev.kind, via: ev.via ? { file: ev.via.file, line: ev.via.line, spec: ev.via.spec } : null, note: ev.note, rule: rule ?? ev.rule });

  const stableTargets = (out: Outcome): string[] | null => (typeof out === "object" && "ids" in out ? [...new Set(out.ids.map(stableKey))].sort() : null);

  // ---------- values: what a name in value position stands for ----------
  const defOf = (file: string, index: number): Def | undefined => {
    const id = defIdsOf(file)[index];
    return id === undefined ? undefined : defById.get(id);
  };
  const defIdsMemo = new Map<string, string[]>();
  const defIdsOf = (file: string): string[] => {
    let ids = defIdsMemo.get(file);
    if (!ids) defIdsMemo.set(file, (ids = (facts.get(file)?.defs ?? []).map((d) => symbolId(file, d))));
    return ids;
  };
  const valueMemo = new Map<string, ({ ids: string[]; ev: Ev } | null | undefined)[]>();
  // The functions or methods a value reference names, with the evidence of
  // its binding; null for anything else (a class, a constant, a module,
  // a name the graph cannot bind).
  const valueOf = (file: string, i: number): { ids: string[]; ev: Ev } | null => {
    let perFile = valueMemo.get(file);
    if (!perFile) valueMemo.set(file, (perFile = []));
    const kept = perFile[i];
    if (kept !== undefined) return kept;
    let out: { ids: string[]; ev: Ev } | null = null;
    const f = facts.get(file);
    const ref = f?.values[i];
    if (f && ref) {
      const asCall: CallFact = { name: ref.name, line: ref.line, column: ref.column, caller: ref.caller, recv: ref.recv };
      if (ref.local !== undefined) asCall.local = ref.local;
      if (ref.bound) asCall.bound = ref.bound;
      const r = resolveCall(file, familyOf(f.lang), asCall, ref.caller >= 0 ? defOf(file, ref.caller) : undefined, true);
      if (typeof r === "object" && "ids" in r) {
        const ids = r.ids.filter((id) => {
          const d = defById.get(id);
          return d !== undefined && (d.kind === "function" || d.kind === "method");
        });
        if (ids.length > 0) out = { ids, ev: r.ev };
      }
    }
    perFile[i] = out;
    return out;
  };
  // The functions a function returns by name, made once per function.
  const returnsMemo = new Map<string, string[]>();
  const returnsOf = (id: string): string[] => {
    const kept = returnsMemo.get(id);
    if (kept) return kept;
    const d = defById.get(id);
    const out = new Set<string>();
    for (const r of d?.returns ?? []) for (const x of valueOf(d?.file ?? "", r)?.ids ?? []) out.add(x);
    const list = [...out];
    returnsMemo.set(id, list);
    return list;
  };

  // The build's time budget, checked inside a file as well as between
  // files: one file can hold enough work to run far past it. When it runs
  // out, the file being resolved stops where it is and is listed with the
  // files whose calls were not resolved.
  class BudgetStop extends Error {}
  const checkBudget = () => {
    if (input.stop?.()) throw new BudgetStop("budget");
  };

  // ---------- the world ----------
  const resolveAll = (): Resolved => {
    // One edge per (from, to, kind), found by the ids themselves: building
    // a key string per site was the resolver's largest cost on vscode.
    const callerEdges: GraphEdge[] = [];
    const refEdges: GraphEdge[] = [];
    const edgeAt = new Map<string, Map<string, Map<EdgeKind, GraphEdge>>>();
    const addEdge = (from: string, to: string, kind: EdgeKind, site: GraphSite) => {
      let byTo = edgeAt.get(from);
      if (!byTo) edgeAt.set(from, (byTo = new Map()));
      let byKind = byTo.get(to);
      if (!byKind) byTo.set(to, (byKind = new Map()));
      let e = byKind.get(kind);
      if (!e) {
        e = { from, to, kind, tier: site.tier, sites: [] };
        byKind.set(kind, e);
        (CALLER_KINDS.has(kind) ? callerEdges : refEdges).push(e);
      }
      if (weakest(e.tier, site.tier) === e.tier && e.tier !== site.tier) e.tier = site.tier;
      e.sites.push(site);
    };
    const misses: Miss[] = [];
    const unknowns: UnknownSite[] = [];
    const dispatch: DispatchSite[] = [];
    // Notes and proofs shared by the sites that say the same thing.
    const evMemo = new Map<string, Ev>();
    const dispatchEv = (declared: string, contract: boolean, count: number): Ev => {
      const k = `${declared} ${contract ? 1 : 0} ${count}`;
      let ev = evMemo.get(k);
      if (!ev) {
        const rule = contract ? "dispatch-implements" : "dispatch-override";
        ev = { kind: rule, tier: "possible", via: null, note: `A call to ${declared} may run this ${contract ? "implementation" : "override"}, one of ${count}; which one runs is not proved.`, rule };
        evMemo.set(k, ev);
      }
      return ev;
    };
    const tsIface = new Map<string, boolean>();
    const isTsInterface = (key: string): boolean => {
      let v = tsIface.get(key);
      if (v === undefined) tsIface.set(key, (v = classes.get(key)?.family === "js" && classes.get(key)?.ids.some((id) => defById.get(id)?.iface === true) === true));
      return v;
    };
    const openNotes = new Map<string, string>();
    const openShapeNote = (key: string): string => {
      let note = openNotes.get(key);
      if (note === undefined) openNotes.set(key, (note = `a value of the interface ${shortKey(key)} may be any object of that shape; only classes that declare implements ${shortKey(key)} are listed as possible targets`));
      return note;
    };
    let unresolvedSites = 0;
    let externalSites = 0;
    const budgetFiles: string[] = [];
    let stopped = false;

    for (const { path, facts: f } of input.files) {
      if (!stopped && input.stop?.()) stopped = true;
      if (stopped) {
        budgetFiles.push(path);
        continue;
      }
      try {
        resolveFile(path, f);
      } catch (error) {
        if (!(error instanceof BudgetStop)) throw error;
        stopped = true;
        budgetFiles.push(path);
      }
    }
    function resolveFile(path: string, f: FileFacts): void {
      const family = familyOf(f.lang);
      const defIds = f.defs.map((d) => symbolId(path, d));
      const callerOf = (i: number): string => (i >= 0 ? (defIds[i] as string) : path);
      // The functions each literal table holds, made once per table: a
      // table called from many places is read once, not once per call.
      const tableIdsMemo = new Map<number, string[]>();
      const tableIds = (index: number): string[] => {
        let ids = tableIdsMemo.get(index);
        if (!ids) tableIdsMemo.set(index, (ids = [...new Set((f.tables[index]?.values ?? []).flatMap((i) => valueOf(path, i)?.ids ?? []))]));
        return ids;
      };
      // The value references passed to each call, by the call's index.
      const argsOf = new Map<number, number[]>();
      f.values.forEach((v, i) => {
        if (v.call !== undefined) push(argsOf, v.call, i);
      });
      for (const [ci, call] of f.calls.entries()) {
        if (ci % 64 === 63) checkBudget();
        const callerId = callerOf(call.caller);
        const caller = call.caller >= 0 ? defById.get(callerId) : undefined;
        const shape: Shape = call.recv.kind === "none" ? "bare" : call.recv.kind === "self" || call.recv.kind === "super" ? "self" : call.recv.kind === "type" ? "typed" : call.recv.kind === "name" ? "name" : "other";
        // A local given one function once: calling it may run that function.
        if (call.alias !== undefined) {
          const v = valueOf(path, call.alias);
          const ref = f.values[call.alias];
          if (v && ref) {
            const ev: Ev = { kind: "value-alias", tier: "possible", via: null, note: `${call.aliasOf ?? call.name} is given ${ref.name} at line ${ref.line}, so calling it may run it.`, rule: "value-alias" };
            for (const t of v.ids) addEdge(callerId, t, "may_invoke", siteOf(path, call.line, call.column, ev));
            continue;
          }
        }
        // What a call returned, called: the functions that callee returns by name.
        if (call.result !== undefined) {
          const inner = f.calls[call.result];
          const got = inner ? resolveCall(path, family, inner, inner.caller >= 0 ? defById.get(callerOf(inner.caller)) : undefined) : "ignore";
          const callees = typeof got === "object" && "ids" in got ? got.ids : [];
          const targets = callees.length === 1 ? returnsOf(callees[0] as string) : [...new Set(callees.flatMap(returnsOf))];
          if (targets.length > 0) {
            const by = defById.get(callees[0] as string)?.name ?? "the callee";
            const ev: Ev = { kind: "returned-value", tier: "possible", via: null, note: `${by} returns it by name, and what ${by} returns is called here.`, rule: "returned-value" };
            const site = siteOf(path, call.line, call.column, ev);
            for (const t of targets.slice(0, DISPATCH_CAP)) addEdge(callerId, t, "may_invoke", site);
            if (targets.length > DISPATCH_CAP) {
              unknowns.push({ file: path, line: call.line, column: call.column, name: "", cause: "fan-out-capped", shape, caller: callerId, scope: "file", note: `${by} returns ${targets.length.toLocaleString("en-US")} functions by name; the ${(targets.length - DISPATCH_CAP).toLocaleString("en-US")} past the first ${DISPATCH_CAP} are not listed as possible targets of this call` });
            }
            // A callee that also returns something else (a parameter, a
            // call) may hand back any function: the call keeps its gap.
            if (!callees.some((id) => defById.get(id)?.returnsOther === true)) continue;
          }
        }
        // A computed call on a literal table may call any of its entries;
        // at most DISPATCH_CAP of them are listed, and the gap says how many are not.
        const table = call.table !== undefined ? f.tables[call.table] : undefined;
        const entries = table && call.table !== undefined ? tableIds(call.table) : [];
        const listed = entries.length > DISPATCH_CAP ? entries.slice(0, DISPATCH_CAP) : entries;
        if (table && listed.length > 0) {
          const ev: Ev = { kind: "value-table", tier: "possible", via: null, note: `${table.name}[...] may call it: it is an entry of the table at line ${table.line}.`, rule: "value-table" };
          const site = siteOf(path, call.line, call.column, ev);
          for (const t of listed) addEdge(callerId, t, "may_invoke", site);
        }
        const out = resolveCall(path, family, call, caller);
        if (out === "ignore") continue;
        if ("ext" in out) {
          externalSites++;
          continue;
        }
        if ("unknown" in out) {
          if (call.implicit) continue;
          unresolvedSites++;
          const u: UnknownSite = { file: path, line: call.line, column: call.column, name: call.name, cause: out.unknown, shape: out.shape, caller: callerId, scope: out.scope ?? "file" };
          if (out.note) u.note = out.note;
          if (out.candidates) u.candidates = out.candidates;
          // A table nothing else can change narrows the gap to its entries
          // (or a key it does not hold). One that may change elsewhere keeps
          // the gap's whole scope: a function put in it later may be called.
          if (table && listed.length > 0) {
            u.candidates = listed;
            const which =
              entries.length > listed.length
                ? `one of its ${entries.length.toLocaleString("en-US")} entries, of which the first ${listed.length} are listed as possible targets and ${(entries.length - listed.length).toLocaleString("en-US")} are not`
                : "one of its entries, listed as possible targets";
            if (table.open) u.note = `a computed member of the table ${table.name} (line ${table.line}), which may be changed elsewhere (it is exported, a module's or a package's, written through a member or an index, or passed on): ${which}, or any function put in it`;
            else {
              u.scope = "file";
              u.note = `a computed member of the table ${table.name} (line ${table.line}): ${which}, or a key the table does not hold`;
            }
          }
          unknowns.push(u);
          continue;
        }
        if ("miss" in out) {
          misses.push({ target: out.miss.target, name: out.miss.name, from: callerId, site: siteOf(path, call.line, call.column, out.ev) });
          if (call.implicit) continue;
          unresolvedSites++;
          unknowns.push({
            file: path,
            line: call.line,
            column: call.column,
            name: call.name,
            cause: out.cause,
            shape,
            caller: callerId,
            scope: "file",
            note:
              out.cause === "miss"
                ? `no definition of ${call.name} where the evidence points (${out.miss.target.split("\u0000").join(" ")})`
                : `${out.miss.target.split("::").pop()} is an interface or a type alias without that member, or inherits from a class outside the graph`,
          });
          continue;
        }
        // Several ids only when one name has several definitions in one place
        // (overloads, a reopened Ruby class): each gets the site.
        // A recursive call is kept as a self-edge; the impact walk stops cycles.
        for (const to of out.ids) addEdge(callerId, to, "calls", siteOf(path, call.line, call.column, out.ev));
        // Through a type others extend or implement: each implementation or
        // override that may run instead, possible, capped per site.
        if (out.dispatch) {
          const d = out.dispatch;
          const targets = dispatchTargets(d.key, call.name, d.side, out.ids);
          const contract = isIface(d.key) || out.ids.every((id) => defById.get(id)?.abstract === true);
          const rule = contract ? "dispatch-implements" : "dispatch-override";
          const declared = `${shortKey(d.key)}.${call.name}`;
          if (targets.length > 0) {
            const kept = targets.length > DISPATCH_CAP ? targets.slice(0, DISPATCH_CAP) : targets;
            dispatch.push({ file: path, line: call.line, column: call.column, caller: callerId, name: call.name, declared: out.ids, candidates: kept, total: targets.length, rule });
            // Every target of one call shares its site: the same place, proof and note.
            const site = siteOf(path, call.line, call.column, dispatchEv(declared, contract, targets.length));
            for (const t of kept) addEdge(callerId, t, "dispatches_to", site);
            if (targets.length > DISPATCH_CAP) {
              unknowns.push({ file: path, line: call.line, column: call.column, name: call.name, cause: "fan-out-capped", shape, caller: callerId, scope: "file", note: `the call may run ${targets.length} implementations or overrides of ${declared}; the ${targets.length - DISPATCH_CAP} past the first ${DISPATCH_CAP} in path order are not listed` });
            }
          }
          // A TypeScript interface admits any value of its shape, declared or not.
          if (family === "js" && isTsInterface(d.key)) {
            unknowns.push({ file: path, line: call.line, column: call.column, name: call.name, cause: "unsupported-rule", shape, caller: callerId, scope: "file", note: openShapeNote(d.key) });
          }
        }
        // A function passed to a callee whose body calls that parameter.
        if (out.ev.tier !== "possible") {
          for (const id of out.ids) {
            const callee = defById.get(id);
            if (!callee?.invokes || !callee.params) continue;
            for (const ri of argsOf.get(ci) ?? []) {
              const ref = f.values[ri] as ValueRef;
              const param = ref.key !== undefined ? callee.params.indexOf(ref.key) : (ref.arg ?? -1);
              if (param < 0 || !callee.invokes.includes(param)) continue;
              const v = valueOf(path, ri);
              if (!v) continue;
              const ev: Ev = { kind: "invocation-summary", tier: "possible", via: null, note: `Passed to ${callee.name} (${callee.file}:${callee.line}), whose body calls its parameter ${callee.params[param]}.`, rule: "invocation-summary" };
              for (const t of v.ids) if (t !== callerId) addEdge(callerId, t, "may_invoke", siteOf(path, ref.line, ref.column, ev));
            }
          }
        }
      }
      // Uses as a value: a function or method named where it is not called.
      f.values.forEach((ref, i) => {
        const v = valueOf(path, i);
        if (!v) return;
        const from = callerOf(ref.caller);
        for (const to of v.ids) if (to !== from) addEdge(from, to, "uses_value", siteOf(path, ref.line, ref.column, v.ev, "value-ref"));
      });
      // Uses as a type: a class, interface or type named in an annotation, a cast or a type test.
      if (f.typeCuts) {
        unknowns.push({ file: path, line: 0, column: 0, name: "", cause: "unsupported-rule", shape: "other", caller: path, scope: "file", note: `${f.typeCuts} type ${f.typeCuts === 1 ? "annotation is" : "annotations are"} too large to read whole (over 4,096 parts); the types past the cut are not recorded as type uses` });
      }
      for (const t of f.types) {
        const k = typeKey(path, family, t.ref, 0, true, family === "java" && t.caller >= 0 ? javaNestingOf(defById.get(callerOf(t.caller))) : null);
        if (k === null || k === "ext") continue;
        const from = callerOf(t.caller);
        for (const to of classes.get(k.key)?.ids ?? []) if (to !== from) addEdge(from, to, "uses_type", siteOf(path, t.ref.line, t.ref.column, k.ev, "type-use"));
      }
      // Inheritance: class to base class; an implemented interface apart.
      f.defs.forEach((d, i) => {
        if (d.bases.length === 0) return;
        for (const b of d.bases) {
          const key = typeKey(path, family, b, 0, false, d.owner);
          if (key === null || key === "ext") continue;
          const info = classes.get(key.key);
          if (!info) continue;
          for (const to of info.ids) {
            if (to === defIds[i]) continue;
            addEdge(defIds[i] as string, to, b.rel === "implements" || (family === "java" && !d.iface && isIface(key.key)) ? "implements" : "inherits", siteOf(path, b.line, b.column, key.ev));
          }
        }
      });
      // A base written as an expression: the class extends something the
      // graph cannot name, so it may be missing from what implements or
      // extends any class of its language. Typing's own `Generic[T]` and
      // `Protocol[T]` name no class and are no gap.
      f.defs.forEach((d, i) => {
        for (const b of d.dynamicBases ?? []) {
          if (b.head && family === "python" && (isTyping(path, b.head, "Generic") || isTyping(path, b.head, "Protocol"))) continue;
          unknowns.push({ file: path, line: b.line, column: b.column, name: "", cause: "dynamic-base", shape: "other", caller: defIds[i] as string, scope: "file", note: `${d.name} names a base with an expression the graph does not read, so the class it extends is not known` });
        }
      });
      // Overrides: a method to the member of a base it overrides or implements.
      if (family !== "go") {
        f.defs.forEach((d, i) => {
          if (d.kind !== "method") return;
          const key = classKey(family, path, d.owner ?? "");
          const b = basesOf(key);
          // Java: a static method hides, never overrides; a constructor is no member.
          if (family === "java" && (d.static || d.ctor)) return;
          const side: Side = methodsOn.i.get(key)?.has(d.name) ? "i" : "s";
          b.keys.forEach((base, j) => {
            if (b.rels[j] === "extend") return;
            const hit = methodOn(base, d.name, side, 0);
            if (!hit || !("ids" in hit)) return;
            let ev = throughBase(b.evs[j] as Ev, hit.ev);
            let ids = hit.ids;
            if (family === "java") {
              // The same name and the same number of parameters: the types are not compared.
              const n = d.params?.length ?? 0;
              ids = ids.filter((id) => (defById.get(id)?.params?.length ?? 0) === n);
              ev = { ...ev, tier: weakest(ev.tier, "likely"), note: [ev.note, `${d.name} has the name and the number of parameters of the base member; the parameter types are not compared.`].filter(Boolean).join(" ") };
            }
            for (const to of ids) if (to !== defIds[i]) addEdge(defIds[i] as string, to, "overrides", siteOf(path, d.line, d.column, ev, "override"));
          });
        });
      }
    }

    // Method sets: a Go type or a Python class that defines every member of
    // an interface or a Protocol without declaring it, likely by its names.
    const matched = new Set<string>();
    for (const [key, info] of classes) {
      if (stopped || !(info.family === "go" || info.family === "python") || !isIface(key)) continue;
      const names = contractNames(key);
      if (!names) continue;
      const declared = new Set(subsOf(key).map((s) => s.key));
      for (const t of methodSetImplementers(key)) {
        const tInfo = classes.get(t);
        if (!tInfo || declared.has(t)) continue;
        const pointer = [...names].some((n) => {
          const h = methodOn(t, n, "i", 0);
          return h !== null && "ids" in h && h.ids.some((id) => defById.get(id)?.pointer === true);
        });
        const what = info.family === "go" && pointer ? `*${shortKey(t)}` : shortKey(t);
        const how = info.family === "go" ? (pointer ? `; some have pointer receivers, so only ${what} implements it` : "; all have value receivers") : "";
        const ev: Ev = {
          kind: "method-set",
          tier: "likely",
          via: null,
          note: `${what} defines every member of ${shortKey(key)} by name${how}; the signatures are not compared.`,
          rule: info.family === "go" ? (pointer ? "go-method-set-pointer" : "go-method-set-value") : "py-protocol-match",
        };
        for (const from of tInfo.ids) {
          const at = defById.get(from);
          if (!at) continue;
          for (const to of info.ids) addEdge(from, to, "implements", siteOf(at.file, at.line, at.column, ev));
        }
        for (const n of names) {
          const mine = methodOn(t, n, "i", 0);
          const theirs = methodOn(key, n, "i", 0);
          if (!mine || !("ids" in mine) || !theirs || !("ids" in theirs)) continue;
          for (const from of mine.ids) {
            const at = defById.get(from);
            if (!at) continue;
            for (const to of theirs.ids) {
              const k = `${from}\u0000${to}`;
              if (from === to || matched.has(k)) continue;
              matched.add(k);
              addEdge(from, to, "overrides", siteOf(at.file, at.line, at.column, ev, "method-set-override"));
            }
          }
        }
      }
    }

    // ---------- importers ----------
    const importers = new Map<string, GraphEdge[]>();
    for (const { path, facts: f } of input.files) {
      index.bindings(path);
      const family = familyOf(f.lang);
      const seen = new Set<string>();
      for (const t of importTargets.get(path) ?? []) {
        // Go: the target is a package folder; files of one package do not import each other.
        const key = family === "go" ? `go:${t.target}` : t.target;
        if (seen.has(key) || (family === "go" && t.target === dirOf(path))) continue;
        seen.add(key);
        const site = siteOf(path, t.line, t.column, t.ev);
        push(importers, key, { from: path, to: key, kind: "imports", tier: site.tier, sites: [site] } as GraphEdge);
      }
    }

    // A manifest or tsconfig the model could not read, parse or follow: one unknown each.
    for (const g of model.unreadable) unknowns.push(metadataUnknown(g));

    // What each function does with its parameters and what it returns by name.
    const summaries = new Map<string, InvocationSummary>();
    for (const [id, d] of defById) if (d.invokes || d.returns) summaries.set(id, { params: d.params ?? [], invokes: d.invokes ?? [], returns: returnsOf(id), returnsOther: d.returnsOther === true });

    return { nodes, edges: callerEdges, references: refEdges, dispatch, summaries, importers, defsByFile, misses, unknowns, unresolvedSites, externalSites, budgetFiles };
  };

  const trace = (files: Iterable<string>): SiteTrace[] => {
    const out: SiteTrace[] = [];
    for (const path of files) {
      const f = facts.get(path);
      if (!f) continue;
      const family = familyOf(f.lang);
      const defIds = f.defs.map((d) => symbolId(path, d));
      for (const call of f.calls) {
        const callerId = call.caller >= 0 ? (defIds[call.caller] as string) : path;
        const caller = call.caller >= 0 ? defById.get(callerId) : undefined;
        const record = new Set<string>();
        reading = record;
        const result = resolveCall(path, family, call, caller);
        reading = null;
        const reads = [...record];
        if (reads.length > 0) out.push({ file: path, line: call.line, column: call.column, from: callerId, reads, targets: stableTargets(result) });
      }
      // Import bindings: a named import reads the export it names even when
      // no call uses it.
      if (family === "java") {
        for (const imp of f.imports) {
          const n = imp.names[0];
          if (!n || imp.star && !imp.staticStar) continue;
          const { mod, path: dotted } = javaClassMod(path, imp.line, imp.spec, n.imported);
          if (mod === null || !("file" in mod)) continue;
          const record = new Set<string>();
          reading = record;
          const v = index.exports(mod.file, dotted, 1);
          reading = null;
          out.push({ file: path, line: imp.line, column: imp.column, from: path, reads: [...record], targets: v?.v === "sym" ? [...new Set(v.ids.map(stableKey))].sort() : null });
        }
      }
      if (family === "js" || family === "python") {
        for (const imp of f.imports) {
          if (imp.reexport || imp.names.length === 0) continue;
          const mod = moduleOf(path, family, imp);
          if (mod === null || !("file" in mod)) continue;
          for (const n of imp.names) {
            if (n.imported === "*") continue;
            const record = new Set<string>();
            reading = record;
            const v = index.exports(mod.file, n.imported, 1);
            reading = null;
            const reads = [...record];
            out.push({ file: path, line: imp.line, column: imp.column, from: path, reads, targets: v?.v === "sym" ? [...new Set(v.ids.map(stableKey))].sort() : null });
          }
        }
      }
    }
    return out;
  };

  // The names a JS module exports and the line that exports each: its own
  // exports and named re-exports first, then every name an `export *`
  // brings that is not already there (never "default"). Walked without
  // recursion, each file once: a file's names are kept when its walk
  // finished without meeting a file still being walked (a cycle) or the
  // step budget, so a diamond of barrels costs one visit a file and a cycle
  // ends where it closes.
  const jsNames = new Map<string, Map<string, number | null>>();
  let walkSteps = 0;
  let walkCut: Cut | null = null;
  type Frame = { file: string; names: Map<string, number | null>; stars: { file: string; line: number }[]; next: number; partial: boolean };
  const ownJsNames = (file: string): Frame => {
    const names = new Map<string, number | null>();
    const stars: { file: string; line: number }[] = [];
    const f = facts.get(file);
    if (f) {
      for (const d of f.defs) if (d.topLevel && d.exported) names.set(d.name, d.line);
      for (const e of f.exportsLocal) names.set(e.exported, e.line ?? null);
      if (f.defaultExport) names.set("default", null);
      for (const imp of f.imports) {
        if (!imp.reexport) continue;
        for (const n of imp.names) names.set(n.local, imp.line);
        if (imp.star) {
          const mod = jsSpec(file, imp.line, imp.spec);
          if (mod !== null && "file" in mod) stars.push({ file: mod.file, line: imp.line });
        }
      }
    }
    return { file, names, stars, next: 0, partial: false };
  };
  const exportedJsNames = (root: string): Map<string, number | null> => {
    const kept = jsNames.get(root);
    if (kept) return kept;
    const merge = (into: Frame, from: Map<string, number | null>, line: number) => {
      for (const [k] of from) if (!into.names.has(k) && k !== "default") into.names.set(k, line);
    };
    const open = new Set<string>([root]);
    const stack: Frame[] = [ownJsNames(root)];
    for (;;) {
      const top = stack[stack.length - 1] as Frame;
      if (top.next < top.stars.length) {
        const star = top.stars[top.next++] as { file: string; line: number };
        const done = jsNames.get(star.file);
        if (done) merge(top, done, star.line);
        else if (open.has(star.file)) top.partial = true;
        else if (walkSteps >= EXPORT_WALK_STEPS) {
          top.partial = true;
          walkCut ??= {
            by: "export-walk",
            at: root,
            omitted: null,
            exact: false,
            unit: "files",
            note: `the walk of export * stopped after ${EXPORT_WALK_STEPS} files; names re-exported past it were not compared`,
          };
        } else {
          walkSteps++;
          open.add(star.file);
          stack.push(ownJsNames(star.file));
        }
        continue;
      }
      stack.pop();
      open.delete(top.file);
      if (!top.partial) jsNames.set(top.file, top.names);
      const parent = stack[stack.length - 1];
      if (!parent) return top.names;
      merge(parent, top.names, (parent.stars[parent.next - 1] as { line: number }).line);
      if (top.partial) parent.partial = true;
    }
  };

  const surface = (file: string): Map<string, { target: ExportTarget | null; line: number | null }> => {
    const out = new Map<string, { target: ExportTarget | null; line: number | null }>();
    const f = facts.get(file);
    if (!f) return out;
    const family = familyOf(f.lang);
    const targetOf = (v: Value | null): ExportTarget | null => {
      if (!v) return null;
      if (v.v === "ext") return "ext";
      if (v.v === "sym") return { keys: [...new Set(v.ids.map(stableKey))].sort(), ids: v.ids };
      if (v.v === "mod") return { keys: [v.file], ids: [v.file] };
      return null;
    };
    let names = new Map<string, number | null>();
    if (family === "js") {
      names = exportedJsNames(file);
    } else if (family === "python") {
      for (const d of f.defs) if (d.topLevel) names.set(d.name, d.line);
      for (const [k] of index.bindings(file).names) names.set(k, null);
    } else if (family === "go") {
      for (const d of f.defs) if (d.topLevel && d.exported) names.set(d.name, d.line);
    } else if (family === "java") {
      // The file's top-level types (package-visible ones too: the package
      // reads them), and the members of those types other files may call:
      // static ones and public ones.
      const tops = new Set(f.defs.filter((d) => d.kind === "class" && d.owner === null).map((d) => d.name));
      for (const d of f.defs) {
        if (d.kind === "class" && d.owner === null) names.set(d.name, d.line);
        else if (d.kind === "method" && d.owner !== null && tops.has(d.owner) && (d.static || d.exported) && !d.ctor) names.set(`${d.owner}.${d.name}`, d.line);
      }
    }
    for (const [name, line] of names) out.set(name, { target: targetOf(index.exports(file, name, 0)), line });
    return out;
  };

  const importsOf = (file: string): { target: string; reexport: boolean }[] => {
    index.bindings(file);
    return (importTargets.get(file) ?? []).map((t) => ({ target: t.target, reexport: t.reexport }));
  };

  let byKey: Map<string, GraphNode> | null = null;
  const node = (idOrKey: string): GraphNode | null => {
    const hit = nodes.get(idOrKey);
    if (hit) return hit;
    if (byKey === null) {
      byKey = new Map();
      for (const n of nodes.values()) if (!byKey.has(stableKey(n.id))) byKey.set(stableKey(n.id), n);
    }
    return byKey.get(idOrKey) ?? null;
  };

  // ---------- lookups for the framework layer ----------
  const viaOut = (ev: Ev) => (ev.via ? { file: ev.via.file, line: ev.via.line, spec: ev.via.spec } : null);
  const modLookup = (mod: Mod | { ns: string; ev: Ev }): PluginLookup => {
    if (mod === null) return { kind: "none" };
    if ("ext" in mod) return { kind: "external" };
    if ("gap" in mod) return { kind: "gap", cause: mod.gap, note: mod.note, candidates: mod.candidates };
    if ("ns" in mod) return { kind: "module", file: mod.ns, tier: mod.ev.tier, via: viaOut(mod.ev), note: mod.ev.note };
    return { kind: "module", file: mod.file, tier: mod.ev.tier, via: viaOut(mod.ev), note: mod.ev.note };
  };
  const valueLookup = (v: Value | null): PluginLookup => {
    if (v === null) return { kind: "none" };
    switch (v.v) {
      case "sym":
        return { kind: "symbol", ids: [...v.ids], tier: v.ev.tier, evidence: v.ev.kind, via: viaOut(v.ev), note: v.ev.note };
      case "mod":
        return { kind: "module", file: v.file, tier: v.ev.tier, via: viaOut(v.ev), note: v.ev.note };
      case "pkg":
      case "pyns":
        return { kind: "module", file: v.dir, tier: v.ev.tier, via: viaOut(v.ev), note: v.ev.note };
      case "pymod":
        return modLookup(pySpec(v.from, 0, v.dotted));
      case "ext":
        return { kind: "external" };
      case "gap":
        return { kind: "gap", cause: v.cause, note: v.note, candidates: v.candidates };
      case "miss":
        return { kind: "miss", target: v.target, name: v.name };
    }
  };
  const lookup = (file: string, path: readonly string[]): PluginLookup => {
    const [head, ...rest] = path;
    if (head === undefined) return { kind: "none" };
    let v = resolveLocal(file, head);
    for (const name of rest) {
      if (v === null || v.v === "ext" || v.v === "gap" || v.v === "miss") break;
      const before: Value = v;
      v = attr(v, name);
      // A name a module or a class does not hold: a miss where it was looked up.
      if (v === null && (before.v === "mod" || before.v === "sym")) return { kind: "miss", target: before.v === "mod" ? before.file : (classOfId.get(before.ids[0] as string) ?? (before.ids[0] as string)), name };
    }
    return valueLookup(v);
  };
  const moduleLookup = (file: string, spec: string): PluginLookup => {
    const f = facts.get(file);
    if (!f) return { kind: "none" };
    return modLookup(moduleOf(file, familyOf(f.lang), { spec, line: 0 }));
  };

  return { resolveAll, trace, surface, importsOf, node, walkCuts: () => [walkCut, lookupCut].filter((c): c is Cut => c !== null), lookup, moduleLookup };
}

// The name an unaliased Go import is used by when its package is not in the
// repo: the last path element without a major version suffix.
function goGuess(spec: string): string {
  const parts = spec.split("/");
  let last = parts[parts.length - 1] ?? spec;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] ?? last;
  return last.replace(/^go-/, "").replace(/[.-].*$/, "");
}

// The project folder of a file: its nearest package.json, go.mod,
// pyproject.toml, setup.cfg, Gemfile, pom.xml, build.gradle or
// build.gradle.kts folder, else the repository root.
export function projectFolder(model: ProjectModel, goModules: [string, string][], file: string): string {
  let best = nodeProjectOf(model, file)?.dir ?? "";
  for (const [, dir] of goModules) if ((dir === "" || file.startsWith(`${dir}/`)) && dir.length > best.length) best = dir;
  for (const dir of model.pyRoots) if ((dir === "" || file.startsWith(`${dir}/`)) && dir.length > best.length) best = dir;
  for (const dir of model.javaProjects) if ((dir === "" || file.startsWith(`${dir}/`)) && dir.length > best.length) best = dir;
  return best;
}
