// One parse of one file yields its local facts: definitions with their spans,
// call sites with what stands before the dot, and imports as written. Nothing
// here looks at another file, so the facts are cached by the file's content
// and every cross-file question is answered later, in resolve.ts.
//
// The node types and fields below are the tree-sitter grammars' own; the
// patterns were written here against the pinned grammar files.
import { createHash } from "node:crypto";
import type { Node, Tree } from "web-tree-sitter";
import type { BoundImport, CallFact, DefFact, EscapeFact, FileFacts, OpaqueFact, ImportFact, Lang, LiteralFact, Receiver, TableFact, TypeRef, TypeUse, ValueRef } from "./types.js";
import { MAX_AMBIENT_NAMES, MAX_FACT_STRING, MAX_TYPE_DEPTH } from "./types.js";
import { keyShaped } from "./frameworks/shared/kept.js";
import { unreadRegions, walkTree } from "./walk.js";
import type { TreeVisitor } from "./walk.js";

// Bump when the facts change shape or meaning: every cached file is re-parsed.
// 9: body hashes on definitions, computed-member calls as dynamic call
// sites, and the line of each local export. 10: predefined TypeScript
// types (`string`, `number[]`) on receivers. 13: interface and abstract
// members as methods, `implements` and Ruby mixins as bases with their
// relation, Go interface types and pointer receivers, object literal
// modules, names in value position, type uses, literal tables, aliases,
// calls of returned values and the invocation summary of each function.
// 14: the review of phase 2: Ruby mixins of one statement in the order Ruby
// applies them, whether a function returns anything but named functions,
// parameters given another value, abstract Python methods by decorator
// only, and every type an annotation names. 15: the parameters and returns
// of a function written as a const arrow or function expression, and the
// call a local holds found by the call's end. 16: each base a class writes
// as an expression the facts cannot name (`extends mixin(Base)`, a Python
// base made by a call or a subscript, a Ruby superclass or mixin that is
// not a constant), as the class's dynamic bases. 17: the framework
// plugins' facts beside the language facts (FileFacts.frameworks). 18: how
// a Ruby class takes a mixin written as an expression. 19: Java (its
// package, static imports, constructors, varargs and each call's argument count).
// 26: TypeScript member types: interface properties, object types written in
// place and aliased, intersections, destructured names, type arguments, the
// result a function's body returns, and each member call's receiver as written.
// 27: calls in an instance field initializer run on the instance, a const
// function inside an anonymous callback or a module block is a definition,
// and callback parameters and loop variables take a declared element type.
// 28: `this` and `super` outside an arrow, a method or a class field's
// function give no receiver type, and each parameter declared as a function
// type keeps that function's parameter types (DefFact.callbacks), which an
// untyped parameter of a callback passed there takes (TypeRef.callback).
// 29: a class field typed by a function type is a member a call names, a
// generic alias's own members mark its type parameters, and a destructuring
// default under an annotation takes the member's type.
// 31: Pick and Omit keep only the members they keep (TypeRef.only, omit), a
// built-in generic the file declares or imports is the file's own type, and
// an annotation's types are read at most MAX_TYPE_DEPTH deep.
// 32: a Python field assigned a local takes the local's type (a
// parameter's annotation), and a field assigned two different types keeps
// none.
// 35: a local declared from a member (`const repo = this.deps.repo`) takes
// that member's type as one that may be any class below it (TypeRef.member);
// it and an unannotated destructured name are not declared, so assigned
// again they lose the type; a function type alias whose result cannot be
// read keeps a null result.
// 36: a type named in an interface property, a type alias, a type argument
// of a call, a `new`, an instantiation or a base, or the constraint or
// default of a type parameter is a type use; a mapped type's key and an
// `infer` name are not.
// 38: a route handler written in place (`app.get("/x", (c) => ...)`, a gin
// `r.GET("/x", func(c *gin.Context) {...})`) is a definition of its own,
// with the definition it is written in (DefFact.inlineIn).
// 39: an interface member marked `?` is optional (DefFact.optional); an
// interface in `declare module "x"` or `declare global` augments a type
// (DefFact.augments); the object literals that may hold code
// (FileFacts.literals); a literal counts its computed keys that hold code
// (LiteralFact.unread), and a value given members by assignment or
// Object.assign is recorded as one (LiteralFact.by).
// 40: TypeScript and JavaScript record every read of a name or a member path
// that is not a call (roles other, object, index); a named function
// expression's own name is bound to its definition inside it; and the
// places a function may be reached by a name the graph cannot follow
// (FileFacts.escapes). 41: what the reader cannot vouch for in a file
// (FileFacts.opaque). 42: how far each such place reaches
// (OpaqueFact.reach), and `this` in a script may be the global object.
// 43: a timer given a name proved a function, the global names a file
// declares as plain data (FileFacts.ambient), and each place said as what
// it does.
// 44: a TypeScript angle-bracket cast (`<Row>x`) is a type use; a type
// named through an import type (`import("./m").Row`) binds through a scoped
// import of the module it names; a Python `typing.cast` and a Go type
// assertion are type uses.
// 45: a read of a local named `require` (a parameter, a let or const, a
// destructured name) is no load, unless `createRequire(...)` made it.
// 46: `import.meta.url`, `dirname` and `filename`, `performance.now`,
// `Atomics.wait` and `process.cpuUsage` leave a file readable.
// 47: a read by a bracket key is a member read (`c["total"]` as
// `c.total`, `c[k]` as any member); `createRequire` is found through its
// import (an alias, a namespace, `require("module")`) and a local
// `require` made by any call is a loader; `new.target` is no
// `import.meta`; `queueMicrotask` is no timer; `typeof import("./m").a.b`
// records no type use.
// 48: imports of `module` are read before the names they bind (they are
// hoisted), the module object passed on or re-exported is a load, and a
// member `createRequire` counts only on it; a read by a computed key is
// judged plain once every scope is known and keeps its places; a key a
// pattern takes apart is a member read.
// 49: any use of Node's module library past `isBuiltin`, `builtinModules`,
// `findSourceMap` and `SourceMap` is a load by a computed path, its path
// read with string escapes decoded and its names bound by scope; a load by a
// computed path that is used is read for any name (a load fact holds no
// names); a member `createRequire` or `_load` on any value is a loader; a
// read by a computed key on a value of a plain type keeps the names a type
// of the repository would have to take to make it not plain (OpaqueFact.plain);
// and a read followed by a member or a call whose value is passed on is passed.
// 50: `createRequire` of Node's module library given the file's own place
// (`import.meta.url`, `import.meta.filename`, `__filename`, `pathToFileURL`
// of a file name or its `.href`) and bound to `require` or called at once
// makes the file's own require, which loads as `require` does.
// 51: `__filename` is that place only in a CommonJS file that never binds
// it (EscapeFact.cjs), `pathToFileURL` only when an import of `url` binds
// it; an export of a made `require` is a load; any read of
// `getBuiltinModule` but a call, an import of it, and a pattern that takes
// `createRequire`, `_load` or `getBuiltinModule` from a value are loads.
// 52: a literal bracket or pattern key is read with its escapes decoded,
// and one written with an escape reads any member; a name written with an
// escape makes the file opaque; only a primitive type is plain by name;
// `require("node:module").createRequire(base)("./x")` given the file's own
// place, or through `process.getBuiltinModule`, loads that path only.
// 53: a free name read is checked against the file's own top-level
// imports only; a `require` made by a call is a loader in its own scope
// only; `Function` named by a local makes no code; an `import()` in a type
// loads nothing; `c[0]` reads the member `0`; top-level `declare` names
// are kept apart (`ambientTop`), since a `.mts` or `.cts` file is a module.
// 54: a function declaration given another value is no proof for a
// timer; a type use keeps the module an import type names; an import
// type's path is read with its escapes decoded; `x.total += 1` and
// `const { 0: a } = x` read the member; a `require` given a value through
// `<T>` stays a loader.
// 55: a `type` specifier of an import or a re-export makes no loader; a
// Python `cast` is typing's only where its import is seen; a file with an
// `import` or `export` statement says so (`esm`); a file keeps at most
// MAX_AMBIENT_NAMES global names declared as plain data, none longer than
// MAX_FACT_STRING; a Python `cast` is typing's only when the last import at
// the top of the module that binds its name is typing's; a Python
// decorator without parentheses (`@wrap`, `@pkg.wrap`) is a call of the
// name it gives; a method called on a local that holds a function aliases
// it only when the method runs it (`fn.call`, not `fn.bind` or `r.equals`);
// the Express facts keep a computed string, and a string given to a name no
// path reads, as a string with no text, and read `process.env["X"]` as
// `process.env.X`.
// 56: a region the parser could not read is kept with the words in and
// around it (`unread`), none of them a string's text or a key; Java
// `getMethod` and its kin, Go `MethodByName`, Python `getattr` and Ruby
// `send` and its kin are calls of the name they are given, or computed
// callees when it is not a plain string or is shaped like a key, each
// marked `byName`.
export const EXTRACTOR_VERSION = 56;

type Frame = {
  def: number; // the definition this frame belongs to, -1 for none
  cls: string | null; // set on a class or module frame: its qualified name
  locals: Map<string, TypeRef | null> | null; // null: no scope of its own
  fns?: Map<string, number>; // definitions declared in this scope, by name
  imports?: Map<string, BoundImport>; // names an import made in this scope binds
  // A JavaScript block (`{ }`, a loop, a catch clause): `let`, `const` and
  // a nested function land here; `var` and parameters skip it.
  block?: boolean;
  // Locals given one value once (`const fn = helper`, `const h = pick(k)`):
  // the value reference, or the call node whose result it holds, by its
  // end (`pick(k)()` and `pick(k)` start at one place, never end at one).
  aliases?: Map<string, { ref?: number; callNode?: number }>;
  tables?: Map<string, number>; // names bound to a literal table, index into tables
  typeParams?: Map<string, TypeRef | null>; // Type parameters and their bounds.
  objectAt?: number; // a module made from an object literal: the literal's start
  fnAt?: number; // a const bound to a function: the function's start, whose frame is this definition's
  // `this` here is the enclosing class's instance or the class: false in a
  // function that is no arrow and no method, where `this` is whatever the
  // caller binds. Unset: as around it, and true in a class frame.
  thisKnown?: boolean;
  // `this` here is proved an instance of a class or the class itself: a
  // method or field of a class body (a class expression's too), and an
  // arrow inside one. Unset: as around it, and true in a class frame.
  thisClass?: boolean;
  // Parameters and locals given another value lose their original callable value.
  reassigned?: Set<string>;
  // A Java type's frame: the names of its fields, read before its methods,
  // and the declared type of each field that has one.
  members?: Set<string>;
  fieldTypes?: Record<string, TypeRef>;
  // Java local types bind only within their declaring block and below.
  javaTypes?: Map<string, TypeRef>;
};

// A frame once pushed: linked to the one around it, with what every lookup
// from inside it needs worked out once, so nothing copies or scans the chain.
type Scope = Frame & {
  parent: Scope | null;
  depth: number; // 0 for the module
  caller: number; // the nearest enclosing definition, -1 for the top level
  clsScope: Scope | null; // the nearest class or module frame
  inFunction: boolean; // a function frame stands between here and the module
  decl: Scope; // where a `let`, a `const` or a nested function lands: the nearest scope
  fnDecl: Scope; // where a `var`, a parameter or a Python name lands: the nearest that is not a block
};

// Scopes deeper than this are not read: a call there is left unresolved, and
// no lookup walks further out, so deeply nested input stays linear.
const MAX_SCOPE_DEPTH = 256;

// The scope a type name was read in, kept on its TypeRef under a symbol:
// copies made with `{ ...t }` keep it and JSON leaves it out. Ctx.facts()
// turns it into `bound` once every scope has been read. The reading scope is
// the extraction's own state; extraction is synchronous, one file at a time.
// The binding the head name had when the type was read is kept too: an
// object built from an imported class stays that class's object after the
// code assigns the name something else.
const READ_IN = Symbol("readIn");
// TypeScript type parameters of the function being entered, read before
// its frame is pushed (its parameters are read first).
let enteringTypeParams: Map<string, TypeRef | null> | null = null;
const READ_AS = Symbol("readAs");
type Stamped = TypeRef & { [READ_IN]?: Scope; [READ_AS]?: { at: Scope; bound: BoundImport } };
let readingScope: Scope | null = null;
// The file being read's import of a module an import type names (jsImportType).
let readingImportType: ((spec: string, at: Node) => number) | null = null;

function typeRef(t: TypeRef): TypeRef {
  if (!readingScope) return t;
  const s = t as Stamped;
  s[READ_IN] = readingScope;
  const head = t.qualifier ? (t.qualifier.split(".")[0] as string) : t.name;
  const at = lookupIn(readingScope, head);
  const bound = at && !at.fns?.has(head) ? at.imports?.get(head) : undefined;
  if (at && bound) s[READ_AS] = { at, bound };
  return t;
}

// Assignment preserves a result only when its receiver type also stays the same.
function sameType(a: TypeRef | undefined, b: TypeRef | undefined): boolean {
  if (!a || !b) return a === b;
  return a.name === b.name && a.qualifier === b.qualifier && !a.elem === !b.elem && !a.item === !b.item && a.result === b.result
    && a.callback?.arg === b.callback?.arg && a.callback?.param === b.callback?.param
    && !a.promise === !b.promise && !a.awaited === !b.awaited
    && a.kind === b.kind && a.param === b.param && (a.args?.length ?? 0) === (b.args?.length ?? 0)
    && (a.args ?? []).every((arg, i) => sameType(arg, b.args?.[i]))
    && a.bound?.import === b.bound?.import && a.bound?.imported === b.bound?.imported && sameType(a.on, b.on)
    && (a.path ?? []).join(".") === (b.path ?? []).join(".") && a.fields === b.fields && a.parts === b.parts && a.localDef === b.localDef;
}

// Two types read where their head names bind the same way.
function sameRead(a: TypeRef, b: TypeRef): boolean {
  const ra = (a as Stamped)[READ_IN];
  const rb = (b as Stamped)[READ_IN];
  if (!ra || !rb) return ra === rb;
  const head = a.qualifier ? (a.qualifier.split(".")[0] as string) : a.name;
  return lookupIn(ra, head) === lookupIn(rb, head) && (!a.on || !b.on || sameRead(a.on, b.on));
}

// The first scope from `from` outwards that knows `name` as a nested
// definition, a scoped import or a local; null when none does, or when the
// answer lies more than MAX_SCOPE_DEPTH scopes out.
function lookupIn(from: Scope, name: string): Scope | null {
  let s: Scope | null = from;
  for (let steps = 0; s && steps <= MAX_SCOPE_DEPTH; s = s.parent, steps++) {
    if (s.fns?.has(name) || s.imports?.has(name) || s.locals?.has(name) || s.tables?.has(name)) return s;
  }
  return null;
}

// An identifier before a dot, as the scope `at` (the nearest that knows the
// name) holds it: a local's type, a scoped import, or a name the resolver
// looks up in the file. `topNames` set: the walk is over, and a module-level
// variable hides only names it is not also defined as.
function receiverIn(at: Scope | null, name: string, path: string[], topNames: ReadonlySet<string> | null): Receiver {
  const named: Receiver = { kind: "name", name, path, nesting: null };
  if (!at || at.fns?.has(name)) return named;
  const bound = at.imports?.get(name);
  if (bound) return topNames ? { kind: "name", name, path, nesting: null, bound } : named;
  if (topNames && at.depth === 0 && topNames.has(name)) return named;
  // Known here only as a literal table: a module made from an object literal.
  if (!at.locals?.has(name)) return named;
  const t = at.locals.get(name) ?? null;
  // A collection (an array, a list) is kept as such: a method called on it
  // is the language's own, never a gap.
  return t ? { kind: "type", type: t, path } : { kind: "other" };
}

// An identifier receiver is tagged with what was read where, until Ctx.addCall takes it.
const IDENT = Symbol("ident");
type Ident = { name: string; at: Scope | null; path: string[] };
type Tagged = Receiver & { [IDENT]?: Ident };

type Leave = () => void;

function pos(node: Node): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

function stringContent(node: Node): string {
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

// The member calls whose last argument, a function written in place, is a
// route handler: `app.get("/x", (c) => ...)`, `router.openapi(route, c =>
// ...)`, `r.GET("/x", func(c *gin.Context) { ... })`. An `on` call is a
// route only with a method, a path and a handler (an event listener has two
// arguments).
const JS_ROUTE_CALLS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all", "on", "openapi"]);
const GO_ROUTE_CALLS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "Any", "Handle"]);
const LABEL_MAX = 64;
// A route label's characters: no space, dot, `#`, `@`, `<` or `>`, so the
// name never reads as a qualified name or a symbol id.
const labelChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || "/_:{}*-$~+!".includes(String.fromCharCode(c));

// The name of a function written in place as a route handler, or null when
// it is not one: `<get /login>` from the call's method and its first
// argument (a short plain string or a name), `<get>` when that argument is
// anything else. The brackets keep the name apart from every source name,
// so no call ever binds to it by name.
function routeHandlerName(fn: Node, calls: ReadonlySet<string>): string | null {
  let arg = fn;
  while (arg.parent && ["parenthesized_expression", "as_expression", "satisfies_expression"].includes(arg.parent.type)) arg = arg.parent;
  const list = arg.parent;
  if (!list || (list.type !== "arguments" && list.type !== "argument_list")) return null;
  const args = list.namedChildren.filter((c) => c.type !== "comment");
  if (args.length < 2 || args[args.length - 1]?.id !== arg.id) return null;
  const call = list.parent;
  const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
  const prop = callee?.type === "member_expression" ? callee.childForFieldName("property") : callee?.type === "selector_expression" ? callee.childForFieldName("field") : null;
  if (!prop || !calls.has(prop.text) || (prop.text === "on" && args.length < 3)) return null;
  const first = args[0] as Node;
  const text = first.type === "identifier" ? first.text : ["string", "interpreted_string_literal", "raw_string_literal"].includes(first.type) ? stringContent(first) : "";
  let clean = text.length > 0 && text.length <= LABEL_MAX;
  for (let i = 0; clean && i < text.length; i++) clean = labelChar(text.charCodeAt(i));
  return clean ? `<${prop.text} ${text}>` : `<${prop.text}>`;
}

// A short hash of a definition's text without its own name, its comments
// and its whitespace: the same body under another name or in another file
// hashes the same, so a removal and an addition can be paired as a move.
function bodyHash(lang: Lang, node: Node, nameNode: Node): string {
  const start = node.startIndex;
  const text = node.text;
  const inside = nameNode.startIndex >= start && nameNode.endIndex <= node.endIndex;
  const cut = inside ? text.slice(0, nameNode.startIndex - start) + text.slice(nameNode.endIndex - start) : text;
  return createHash("sha1").update(withoutComments(cut, lang === "python" || lang === "ruby")).digest("hex").slice(0, 16);
}

// The text without its comments and blanks, in one pass: a comment's end
// is found with indexOf from where it starts, so unclosed comments cost no
// more than the text. Strings are not told apart: the hash only has to be
// the same for the same text.
function withoutComments(text: string, hashComments: boolean): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (hashComments ? c === "#" : c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (!hashComments && c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") out += c;
      i += 1;
    }
  }
  return out;
}

// A name or a member path that can stand for a value of the repository:
// what a value reference is made from. Literals, calls and anything else
// are not.
type ValueNode = { name: Node; recv: Receiver } | null;

// An annotation is read with a stack, never by recursion (a union of many
// members nests as deep as it has members), and at most this many of its
// nodes are read; one larger is cut, and the cut is a gap of its file.
const MAX_TYPE_NODES = 4096;
let typeCuts = 0;

// The nodes of an annotation, depth first, no more than MAX_TYPE_NODES.
// `take` returns true for a node read whole (a type name): its children
// are not visited.
function typeNodes(node: Node | null, take: (n: Node) => boolean): void {
  if (!node) return;
  const stack: Node[] = [node];
  let read = 0;
  while (stack.length > 0) {
    if (++read > MAX_TYPE_NODES) {
      typeCuts++;
      return;
    }
    const n = stack.pop() as Node;
    if (take(n)) continue;
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

// The name a string literal gives, when it has no escape or interpolation
// and reads as a name, else null. A literal shaped like a key is no name:
// the facts are cached and feed the review packet, so a key there would be
// copied out (frameworks/shared/kept.ts).
const STRING_NODES = new Set(["string", "string_literal", "interpreted_string_literal", "raw_string_literal"]);
const STRING_TEXT = new Set(["string_content", "string_fragment", "interpreted_string_literal_content", "raw_string_literal_content"]);
const NAME = /^[\p{L}_$][\p{L}\p{N}_$]*[?!=]?$/u;
function stringName(node: Node): string | null {
  if (!STRING_NODES.has(node.type)) return null;
  const parts = node.namedChildren.filter((c) => c.type !== "string_start" && c.type !== "string_end");
  const text = parts.length === 1 && STRING_TEXT.has((parts[0] as Node).type) ? (parts[0] as Node).text : null;
  return text !== null && text.length <= MAX_FACT_STRING && NAME.test(text) && !keyShaped(text) ? text : null;
}

class Ctx {
  goFields = new Map<string, Record<string, TypeRef>>();
  defs: DefFact[] = [];
  calls: CallFact[] = [];
  values: ValueRef[] = [];
  types: TypeUse[] = [];
  tables: TableFact[] = [];
  literals: LiteralFact[] = [];
  literalsCut = false;
  assignedMembers = new Map<string, LiteralKeys & { line: number }>();
  imports: ImportFact[] = [];
  exportsLocal: { local: string; exported: string; line?: number }[] = [];
  defaultExport: string | null = null;
  goPackage: string | null = null;
  escapes: EscapeFact[] = [];
  opaque = new Map<string, OpaqueFact>();
  // An `import` or `export` statement at the top of the file: a module,
  // strict, so `this` in a plain function is never the global object.
  esm = false;
  looseMembers = new Map<string, OpaqueFact>();
  // Timers given a name: `setTimeout(code)` runs a string as code unless
  // the name is proved a function (`proof`, from the code around the call:
  // a function or a function-typed name, or a Promise executor's parameter).
  pendingTimers: { scope: Scope; timer: string; arg: string | null; proof: "fn" | "promise" | null; line: number }[] = [];
  // The global object read only to call a timer on it (`window.setTimeout(f)`).
  timerRefs = new Set<ValueRef>();
  // Global names declared as plain data: in `declare global`, and at the
  // top of a file (counted only when the file is a script).
  ambient = new Set<string>();
  ambientTop = new Set<string>();
  // The names of an import or re-export's `type` specifiers (`import { x,
  // type T }`): they bind nothing at run time, so no loader is made of them.
  typeSpecifiers = new Map<ImportFact, Set<string>>();
  // Python: where an import outside any function stands. `top`: a statement
  // of the module itself, which replaces an earlier binding of its names.
  // `maybe`: under an `if`, `try` or other block, which may not run.
  // `class`: in a class body, which binds class attributes, never the
  // module's names.
  pyImportPlace = new Map<ImportFact, "top" | "maybe" | "class">();
  variables = new Set<string>();
  exportedVariables = new Set<string>();
  // TypeScript and JavaScript: the name nodes already recorded as a value,
  // by their start, so the catch-all read of every name records each once.
  readAt = new Set<number>();
  // Loads already read as a binding (jsRequire), by the call's start.
  consumedLoads = new Set<number>();
  // Calls marked by the node above them when the walk visits it, by
  // callKey, so no call reads its own `parent`: tree-sitter finds a parent
  // by walking down from the root, and a read per call made a deeply nested
  // file quadratic. A call whose value is given to the name `require`
  // (jsMarkRequireBinders), and among them those given to a `const`, `let`
  // or `var` named `require` that is not exported (`own`); one whose value
  // is called at once (`f()(x)`), with the call that calls it; and one
  // whose value is thrown away (`f();`, `await f();`).
  bindsRequire = new Set<string>();
  ownBinders = new Set<string>();
  calledCalls = new Map<string, Node>();
  discardedCalls = new Set<string>();
  // Calls that may be `createRequire` given the file's own place
  // (`import.meta.url`) and whose value is the file's own require: bound
  // to `require`, or called at once (`outer`: the load that call makes).
  // `name` is the callee, or the object of `m.createRequire`; `key` the
  // place of that name's read. Whether it is the loader factory is
  // decided once every import is known, as is the base: `filename`, it
  // reads `__filename`, which must never be bound or assigned in the file;
  // `url`, it goes through `pathToFileURL` under that name (`member`: of
  // that object), which an import of `url` must bind.
  // `inline`: the object is Node's module library written in place
  // (`require("node:module")`), whose load is then no load of any module
  // (`ownLibCalls`, by the load call's callKey).
  ownRequires: { name: string; member: boolean; inline: boolean; key: string; scope: Scope; line: number; filename: boolean; url: { name: string; member: boolean } | null; outer: EscapeFact | null }[] = [];
  ownLibCalls = new Set<string>();
  // Names an import of `url` or `node:url` binds, as libBindings are kept.
  private urlBindings: { name: string; scope: Scope | null; imported: string }[] = [];
  // Reads of `__filename` as a value, and the file's text, whose every
  // `__filename` they must be for it to be the free one.
  filenameReads = 0;
  source: () => string = () => "";
  private filenameCount: number | null = null;
  // Object patterns that take apart Node's module library loaded by a
  // written path, read as an import is (Ctx.libImport), by their start.
  libPatterns = new Set<number>();
  private root: Scope;
  // The member read after a name with role `object` (`m.run`): what the
  // module library bound to a name is read for.
  propOf = new Map<ValueRef, string>();
  // An escape that holds only when its name is not a local, a nested
  // definition, an import or a top-level definition of the file
  // (`eval`, `window`, `exports`), decided once every scope is known.
  private pendingEscapes: { fact: EscapeFact; scope: Scope; name: string }[] = [];
  // Where a `require` was declared from a call (`createRequire(...)`): a
  // read of the `require` that binding makes is a loader read, though the
  // name is a local. Each is the scope at the call; the binding is the one
  // `require` names from there.
  madeRequire: Scope[] = [];
  // An opaque place that holds only when its name is not a local, a
  // nested definition, an import or a top-level definition (`Function`).
  private pendingOpaque: { why: string; line: number; reach: OpaqueFact["reach"]; scope: Scope; name: string }[] = [];
  // Whether a name is proved a function where it is declared, by the block
  // or function node that holds the declaration (jsFunctionProof).
  proofs = new Map<string, { is: "fn" | "promise" | null } | null>();
  // Reads by a computed key (`c[k]`): whether the value is of a plain type
  // is decided once every scope is known, as a member read's receiver is.
  // `stays`: the read's value is used where it is read (called, operated
  // on, read further), never passed on.
  keyReads: { recv: Receiver; scope: Scope; line: number; stays: boolean }[] = [];
  // Names bound to Node's module library (`member` false: the module
  // object, read only for the members LIB_SAFE names) or to one of its
  // other members (`member`: any read is a load), in the scope that binds
  // them (null: the module's own scope, where an import binds). Imports are
  // hoisted, so the reads are decided once every scope is known. And the
  // names called past the depth bound, where no scope is read.
  private libBindings: { name: string; scope: Scope | null; member: boolean; imported: string }[] = [];
  deepCalls: { name: string; line: number }[] = [];
  top: Scope;
  // Calls whose names are bound when the walk ends, each with a reference to
  // its scope: a scope's names are known only once all of it has been read
  // (hoisting in JavaScript, any assignment makes a Python name local).
  private pending: { call: CallFact; scope: Scope; ident: Ident | undefined; receiverName?: string }[] = [];
  // Value references the same way: a name of a local variable is dropped
  // once every scope is known.
  private pendingValues: { ref: ValueRef; scope: Scope; ident: Ident | undefined }[] = [];
  // Locals that hold a call's result, by the call node's start: the call
  // is pushed after the declaration that names it.
  private callAt = new Map<number, number>();
  private aliasCalls: { call: CallFact; callNode: number }[] = [];
  private typeSeen = new Set<string>();
  // The import each import type made, by the module and where it is written.
  private importTypes = new Map<string, number>();
  // Computed calls on a name: the table it is bound to, decided once every
  // scope is known (a module's table may be declared below the function).
  private tableCalls: { call: number; name: string; scope: Scope }[] = [];
  // Uses of a name that may change a table it is bound to (a write through
  // a member or an index), decided the same way; and the tables found open.
  private tableUses: { name: string; scope: Scope }[] = [];
  private openTables = new Set<number>();
  // Object literals waiting for their table: the declaration that binds
  // the literal is read before the literal's entries.
  pendingTables = new Map<number, { name: string; line: number; scope: Scope; open?: boolean }>();
  // The class whose instance field initializer the walk is in, -1 for none:
  // a call there runs on the instance, though its caller is the class.
  instanceInit = -1;
  // Python fields by class definition and name: those an annotation
  // declared, and those given two different types, which keep none.
  private declaredFields = new Set<string>();
  private mixedFields = new Set<string>();

  constructor(readonly lang: Lang) {
    const root = { def: -1, cls: null, locals: new Map(), parent: null, depth: 0, caller: -1, clsScope: null, inFunction: false } as unknown as Scope;
    root.decl = root;
    root.fnDecl = root;
    this.top = root;
    this.root = root;
    readingScope = root;
    readingImportType = (spec, at) => this.importType(spec, at);
    typeCuts = 0;
  }

  push(frame: Frame): Leave {
    const parent = this.top;
    const s = frame as Scope;
    s.parent = parent;
    s.depth = parent.depth + 1;
    s.caller = frame.def >= 0 ? frame.def : parent.caller;
    s.clsScope = frame.cls !== null ? s : parent.clsScope;
    s.thisKnown = frame.thisKnown ?? (frame.cls !== null || parent.thisKnown !== false);
    s.thisClass = frame.thisClass ?? (frame.cls !== null || parent.thisClass === true);
    s.inFunction = parent.inFunction || !(frame.block === true || (frame.cls !== null && frame.locals === null));
    s.decl = frame.locals ? s : parent.decl;
    s.fnDecl = frame.locals && !frame.block ? s : parent.fnDecl;
    this.top = s;
    readingScope = s;
    return () => {
      this.top = parent;
      readingScope = parent;
    };
  }

  caller(): number {
    return this.top.caller;
  }

  // The innermost class or module frame, with its definition.
  cls(): Scope | null {
    return this.top.clsScope;
  }

  // True when no function frame stands between here and the module. A block
  // at the top of the module (an `if`, a `try`) keeps its definitions top level.
  atModuleLevel(): boolean {
    return !this.top.inFunction;
  }

  lookup(from: Scope, name: string): Scope | null {
    return lookupIn(from, name);
  }

  // The type of a local, null for a local of unknown type, undefined when
  // the nearest scope that knows the name does not hold it as a local.
  local(name: string): TypeRef | null | undefined {
    const at = this.lookup(this.top, name);
    if (!at || at.fns?.has(name) || at.imports?.has(name)) return undefined;
    return at.locals?.get(name) ?? null;
  }

  // An identifier before a dot, read at this point of the walk: a local's
  // type here keeps the flow of assignments so far. Ctx.facts() reads the
  // name again once every scope is complete: a nearer scope that declares
  // it later wins, and an import is decided only then.
  identReceiver(name: string, path: string[]): Receiver {
    const at = this.lookup(this.top, name);
    const recv = receiverIn(at, name, path, null) as Tagged;
    recv[IDENT] = { name, at, path };
    return recv;
  }

  // A declaration: the name is new in its scope (`block`: a `let` or
  // `const`, else the function's scope), and no longer an import there.
  setLocal(name: string, type: TypeRef | null, block = false): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    at.imports?.delete(name);
    at.locals?.set(name, type);
  }

  // A Python field assigned a type. A declared type stands. Otherwise the
  // field keeps a type only while every assignment of a known type gives
  // the same one, since either value may reach a later call.
  setField(def: number, name: string, type: TypeRef | null, declared: boolean): void {
    const d = this.defs[def];
    const key = `${def}\0${name}`;
    if (!d || !type || this.declaredFields.has(key)) return;
    if (declared) {
      this.declaredFields.add(key);
      this.mixedFields.delete(key);
      d.fields[name] = type;
      return;
    }
    if (this.mixedFields.has(key)) return;
    const old = d.fields[name];
    if (old && !(sameType(old, type) && sameRead(old, type))) {
      delete d.fields[name];
      this.mixedFields.add(key);
    } else if (!old) d.fields[name] = type;
  }

  // An import. At the top of the module its names are the file's; made
  // inside a function or a block, they belong to that scope only, so a call
  // elsewhere in the file never resolves through them.
  addImport(fact: ImportFact, block = false): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    const index = this.imports.length;
    this.imports.push(fact);
    this.libImport(fact, at.depth === 0 ? null : at);
    if (at.depth === 0) return;
    fact.scoped = true;
    at.imports ??= new Map();
    for (const n of fact.names) at.imports.set(n.local, { import: index, imported: n.imported });
    if (fact.namespace) at.imports.set(fact.namespace, { import: index, imported: "*" });
  }

  // The module an import type names (`import("./m").Row`): an import of
  // the whole module, once per place it is written, that binds no name of
  // the file; the type binds through it.
  importType(spec: string, at: Node): number {
    const key = `${at.startIndex}\0${spec}`;
    let index = this.importTypes.get(key);
    if (index === undefined) {
      index = this.imports.length;
      this.imports.push({ spec, ...pos(at), names: [], namespace: null, star: false, reexport: false, typeOnly: true, scoped: true });
      this.importTypes.set(key, index);
    }
    return index;
  }

  // An assignment to a name that may exist already. A declared type stands;
  // otherwise the receiver evidence survives only when the new value has the
  // same type, since either value may reach a later call. A name an import
  // bound and the code then assigns is a local of unknown value: the import
  // is no longer evidence for any call to it.
  // `innermost`: Python, where assigning in a function makes a new local.
  assign(name: string, type: TypeRef | null, innermost = false): void {
    let s: Scope | null = this.top;
    for (let steps = 0; s && steps <= MAX_SCOPE_DEPTH; s = s.parent, steps++) {
      if (innermost && !s.locals) continue;
      if (s.imports?.has(name)) {
        s.imports.delete(name);
        s.locals?.set(name, null);
        return;
      }
      // A function declaration given another value (`f = "code"`) no longer holds that function.
      if (s.fns?.has(name)) {
        (s.reassigned ??= new Set()).add(name);
        return;
      }
      if (innermost && !s.locals?.has(name)) break;
      const locals = s.locals;
      if (locals?.has(name)) {
        (s.reassigned ??= new Set()).add(name);
        const old = locals.get(name) ?? null;
        if (old?.declared) return;
        const same = old !== null && type !== null && sameType(old, type);
        locals.set(name, same ? old : null);
        return;
      }
    }
    this.setLocal(name, type);
  }

  // A nested definition is visible by name in the scope that declares it:
  // its block for a function declaration or a `let` or `const`, the whole
  // function for a `var` (`block` false).
  declareFn(name: string, def: number, block = true): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    if (at.depth === 0) return;
    at.fns ??= new Map();
    at.fns.set(name, def);
  }

  // The enclosing definition, as an owner for a nested one.
  ownerName(): string | null {
    const def = this.caller();
    if (def < 0) return null;
    const d = this.defs[def] as DefFact;
    return d.owner ? `${d.owner}.${d.name}` : d.name;
  }

  addDef(node: Node, nameNode: Node, kind: DefFact["kind"], fields: Partial<DefFact> = {}, spanNode: Node = node): number {
    const { column } = pos(nameNode);
    // Only definitions at the top of the file or directly in a top-level
    // class get a body hash: hashing every nested one would read deep code
    // once per level.
    const hash = this.top.depth <= 2 ? bodyHash(this.lang, spanNode, nameNode) : undefined;
    this.defs.push({
      name: nameNode.text,
      kind,
      owner: null,
      line: spanNode.startPosition.row + 1,
      column,
      endLine: spanNode.endPosition.row + 1,
      exported: false,
      topLevel: false,
      bases: [],
      fields: {},
      ...fields,
      ...(hash ? { bodyHash: hash } : {}),
    });
    return this.defs.length - 1;
  }

  // A call whose callee is computed (`table[key]()`): no name to bind, so
  // the resolver records it as a dynamic call site the graph cannot follow.
  addDynamicCall(node: Node): void {
    const { line, column } = pos(node);
    this.calls.push({ name: "", line, column, caller: this.caller(), recv: { kind: "other" }, dynamic: true });
  }

  // A call by a name built at run time (Java `getMethod(n)`, Go
  // `MethodByName(n)`, Python `getattr(o, n)`): a name written as a plain
  // string is a call of that name on a value of unknown type; any other
  // (or `arg` undefined) makes a computed callee, which may run any function.
  // Either call is marked `byName`.
  addNameBuiltCall(node: Node, arg: Node | undefined): void {
    const name = arg ? stringName(arg) : null;
    if (!arg || name === null) {
      this.addDynamicCall(node);
      (this.calls[this.calls.length - 1] as CallFact).byName = true;
      return;
    }
    const i = this.addCall(arg, { kind: "other" });
    (this.calls[i] as CallFact).name = name;
    (this.calls[i] as CallFact).byName = true;
  }

  addCall(nameNode: Node, recv: Receiver, implicit = false, receiverName?: string): number {
    const { line, column } = pos(nameNode);
    const call: CallFact = { name: nameNode.text, line, column, caller: this.caller(), recv };
    const index = this.calls.length;
    if (implicit) call.implicit = true;
    const callerDef = call.caller >= 0 ? this.defs[call.caller] : undefined;
    // A Java constructor runs on the new instance: its calls are never static.
    if ((callerDef?.static && !callerDef.ctor) || (callerDef?.kind === "class" && this.instanceInit !== call.caller) || callerDef?.kind === "module") call.static = true;
    this.calls.push(call);
    const ident = (recv as Tagged)[IDENT];
    if (ident) delete (recv as Tagged)[IDENT];
    if (this.lang === "ruby" && receiverName === undefined) return index;
    // Past the depth bound the scopes around a call are not read: the safe
    // reading is a call nothing binds, never one bound past a scope that hides it.
    if (this.top.depth > MAX_SCOPE_DEPTH) {
      call.recv = { kind: "other" };
      if (recv.kind === "none") call.shadowed = true;
      if (recv.kind === "none" && JS_LANGS.has(this.lang)) this.deepCalls.push({ name: call.name, line });
      return index;
    }
    // A Go receiver name is decided where it is read (identReceiver is not
    // used for Go): no Go name is hoisted.
    if (recv.kind === "none" || ident || receiverName !== undefined) this.pending.push({ call, scope: this.top, ident, receiverName });
    return index;
  }

  // The call a call node made, when one was recorded since `before`.
  noteCall(node: Node, before: number): number | undefined {
    if (this.calls.length === before) return undefined;
    this.callAt.set(node.endIndex, before);
    return before;
  }

  // A call of what a call returned (`pick(k)()`): `inner` is the call node
  // that returned it.
  addResultCall(node: Node, inner: Node): void {
    const { line, column } = pos(node);
    const call: CallFact = { name: "", line, column, caller: this.caller(), recv: { kind: "other" }, dynamic: true };
    this.calls.push(call);
    this.aliasCalls.push({ call, callNode: inner.endIndex });
  }

  // A name in value position. Go names are decided where they are read (a
  // local is never recorded); the other languages decide once every scope
  // is known.
  addValue(v: { name: Node; recv: Receiver }, role: ValueRef["role"], extra: { call?: number; arg?: number; key?: string } = {}): number {
    const { line, column } = pos(v.name);
    const ref: ValueRef = { name: v.name.text, line, column, caller: this.caller(), recv: v.recv, role };
    this.readAt.add(v.name.startIndex);
    if (extra.call !== undefined) ref.call = extra.call;
    if (extra.arg !== undefined) ref.arg = extra.arg;
    if (extra.key !== undefined) ref.key = extra.key;
    const index = this.values.length;
    this.values.push(ref);
    const ident = (v.recv as Tagged)[IDENT];
    if (ident) delete (v.recv as Tagged)[IDENT];
    if (this.lang === "go" || this.lang === "ruby") return index;
    if (this.top.depth > MAX_SCOPE_DEPTH) {
      if (JS_LANGS.has(this.lang)) this.addOpaque("nests scopes too deep to read", line, "any");
      ref.recv = { kind: "other" };
      return index;
    }
    if (v.recv.kind === "none" || ident) this.pendingValues.push({ ref, scope: this.top, ident });
    return index;
  }

  // A local given a value: one value reference, or a call's result, may
  // stand for it when it is called. `once`: the language keeps the name to
  // this value (a JavaScript const); else a second assignment in the same
  // scope ends the alias.
  noteAssign(name: string, value: { ref?: number; callNode?: number } | null, once: boolean, block = false): void {
    const at = block ? this.top.decl : this.top.fnDecl;
    at.aliases ??= new Map();
    if (!once && (at.aliases.has(name) || at.locals?.has(name) || at.tables?.has(name))) {
      at.aliases.set(name, {});
      return;
    }
    at.aliases.set(name, value ?? {});
  }

  // A name bound to an object, dict or map literal whose entries are the
  // value references `values`, in the scope that declares it.
  bindTable(name: string, line: number, values: number[], scope: Scope, open = false): void {
    const index = this.tables.length;
    this.tables.push({ name, line, values });
    // A Python module's or a Go package's table may be written from other modules or files.
    if (open || (scope.depth === 0 && (this.lang === "python" || this.lang === "go"))) this.openTables.add(index);
    scope.tables ??= new Map();
    scope.tables.set(name, index);
  }

  // An assigned parameter or local no longer holds its original callable value.
  reassign(name: string): void {
    const at = this.lookup(this.top, name);
    if (at?.locals?.has(name)) (at.reassigned ??= new Set()).add(name);
  }

  // A computed call on `name` (`handlers[key]()`, call index `call`).
  tableCall(call: number, name: string): void {
    this.tableCalls.push({ call, name, scope: this.top });
  }

  // A use of `name` that may change what a table bound to it holds: a write
  // through a member or an index, a method called on it, the name passed on.
  tableUse(name: string): void {
    this.tableUses.push({ name, scope: this.top });
  }

  // A place a function may be reached by a name the graph cannot follow;
  // with `name`, only when that name is not one the file declares.
  addEscape(fact: EscapeFact, name?: string): void {
    if (name === undefined) this.escapes.push(fact);
    else this.pendingEscapes.push({ fact, scope: this.top, name });
  }

  // A place the reader cannot vouch for: the file is opaque, and what it
  // reaches (its own definitions, the modules it imports, and with `reach`
  // the global scope or every module) may be reached by a path the graph
  // does not see.
  addOpaque(why: string, line: number, reach?: OpaqueFact["reach"], name?: string): void {
    if (name === "Function") return void this.pendingOpaque.push({ why, line, reach, scope: this.top, name });
    const kept = this.opaque.get(why);
    if (kept) {
      kept.count++;
      if (reach === "any" || (reach === "global" && kept.reach === undefined)) kept.reach = reach;
    } else this.opaque.set(why, { why, line, count: 1, ...(reach ? { reach } : {}), ...(name !== undefined ? { name } : {}) });
  }

  // The names an import of Node's module library binds, in `scope` (null
  // for the module's own): the module object, or a member LIB_SAFE does not name.
  libImport(fact: ImportFact, scope: Scope | null): void {
    if (fact.typeOnly || fact.reexport) return;
    const spec = jsUnescape(fact.spec);
    if (spec === "url" || spec === "node:url") {
      if (fact.namespace !== null) this.urlBindings.push({ name: fact.namespace, scope, imported: "*" });
      for (const n of fact.names) this.urlBindings.push({ name: n.local, scope, imported: n.imported });
    }
    if (!LOADER_MODULES.has(spec)) {
      // `getBuiltinModule` taken by name (`import { getBuiltinModule } from
      // "node:process"`), or a loader member of another module: a loader.
      if (fact.names.some((n) => LOADER_READS.has(n.imported) || n.imported.includes("\\"))) this.escapes.push({ kind: "load", line: fact.line });
      return;
    }
    if (fact.namespace !== null) this.libBindings.push({ name: fact.namespace, scope, member: false, imported: "*" });
    for (const n of fact.names) {
      if (n.imported === "default") this.libBindings.push({ name: n.local, scope, member: false, imported: n.imported });
      else if (!LIB_SAFE.has(n.imported)) this.libBindings.push({ name: n.local, scope, member: true, imported: n.imported });
    }
  }

  // A table that something outside this file may change from the start.
  openTable(index: number): void {
    this.openTables.add(index);
  }

  // A named type read in an annotation, a cast or a type test, once per
  // enclosing definition and name.
  addTypeUse(ref: TypeRef | null, caller: number): void {
    if (!ref || ref.name === "{}") return;
    // An import type keeps its module: `import("./a").Row` and `import("./b").Row` are two types.
    const key = `${caller}|${ref.qualifier ?? ""}|${ref.name}|${ref.bound ? `${ref.bound.import}:${ref.bound.imported}` : ""}`;
    if (this.typeSeen.has(key)) return;
    this.typeSeen.add(key);
    this.types.push({ ref, caller });
  }

  facts(): FileFacts {
    readingScope = null;
    readingImportType = null;
    const topNames = new Set(this.defs.filter((d) => d.topLevel).map((d) => d.name));
    // `createRequire` of Node's module library given the file's own place
    // makes the file's own require: a call of what it makes loads as
    // `require` does. Any other callee of that name (a local function too),
    // or `m.createRequire` on a value that is not Node's module library, is
    // a loader.
    const own = new Set<string>();
    const libAt = (scope: Scope, name: string) => this.libBindings.find((b) => b.name === name && this.lookup(scope, name) === b.scope);
    for (const o of this.ownRequires) {
      const b = libAt(o.scope, o.name);
      const factory = o.inline || (b !== undefined && (o.member ? !b.member : b.imported === "createRequire"));
      const url = o.url;
      const viaUrl = url === null || this.urlBindings.some((u) => u.name === url.name && this.lookup(o.scope, url.name) === u.scope && (url.member ? u.imported === "*" || u.imported === "default" : u.imported === "pathToFileURL"));
      const filename = !o.filename || this.filenameReads === (this.filenameCount ??= (this.source().match(/__filename/g) ?? []).length);
      if (factory && viaUrl && filename) {
        own.add(o.key);
        if (o.outer) this.escapes.push(o.outer);
        // `__filename` is the file's own place only in a CommonJS file.
        if (o.filename) this.escapes.push({ kind: "load", line: o.line, cjs: true });
      } else if (o.member || o.name === "createRequire") this.escapes.push({ kind: "load", line: o.line });
    }
    this.ownRequires = [];
    // A read of a name bound to Node's module library where it is read:
    // anything but a member LIB_SAFE names (`m.isBuiltin`) is a load, but
    // for the factory read by an own `createRequire` call above.
    const libRead = (scope: Scope, name: string, prop: string | null, line: number, key: string) => {
      for (const b of this.libBindings) {
        if (b.name !== name || this.lookup(scope, name) !== b.scope) continue;
        if (own.has(key) && (b.member ? prop === null : prop === "createRequire")) continue;
        if (b.member || prop === null || !LIB_SAFE.has(prop)) this.escapes.push({ kind: "load", line });
      }
    };
    // A local alias's call node, made into the call it names.
    const aliasCalls: { call: CallFact; callNode: number }[] = [...this.aliasCalls];
    const bindAlias = (call: CallFact, at: Scope | null, name: string, refOnly = false) => {
      if (at?.reassigned?.has(name)) return;
      const alias = at?.aliases?.get(name);
      if (alias?.ref !== undefined) {
        call.alias = alias.ref;
        if (name !== call.name) call.aliasOf = name;
      }
      else if (!refOnly && alias?.callNode !== undefined) aliasCalls.push({ call, callNode: alias.callNode });
    };
    for (const { call, scope, ident, receiverName } of this.pending) {
      if (ident || receiverName !== undefined) {
        // The name read again with every scope complete. The same scope
        // answering keeps the type the walk had at the call; a nearer scope
        // that declared the name later decides instead.
        const name = ident?.name ?? receiverName as string;
        const at = this.lookup(scope, name);
        // A method called on a table (`handlers.set(...)`) may change what it holds.
        const table = at?.tables?.get(name);
        if (table !== undefined) this.openTables.add(table);
        if (ident && (at !== ident.at || call.recv.kind === "name")) call.recv = receiverIn(at, name, ident.path, topNames);
        if ((!ident || ident.path.length === 0) && runsHeldValue(this.lang, call.name)) bindAlias(call, at, name, true);
        continue;
      }
      if (this.libBindings.length > 0) libRead(scope, call.name, null, call.line, `${call.line}:${call.column}`);
      const at = this.lookup(scope, call.name);
      if (!at) continue;
      const fn = at.fns?.get(call.name);
      const bound = at.imports?.get(call.name);
      if (fn !== undefined) call.local = fn;
      else if (bound) call.bound = bound;
      // A module-level variable hides only names it is not also defined as.
      else if (at.depth > 0 || !topNames.has(call.name)) {
        call.shadowed = true;
        // A local given one value once: the call may run that value.
        bindAlias(call, at, call.name);
        // A parameter of the function whose frame holds it: the function
        // calls what it is given there.
        const owner = !at.block && at.def >= 0 && !at.reassigned?.has(call.name) ? this.defs[at.def] : undefined;
        const param = owner?.params?.indexOf(call.name) ?? -1;
        if (owner && param >= 0 && !owner.invokes?.includes(param)) (owner.invokes ??= []).push(param);
      }
    }
    this.pending = [];
    for (const t of this.tableCalls) {
      const table = this.lookup(t.scope, t.name)?.tables?.get(t.name);
      if (table !== undefined) (this.calls[t.call] as CallFact).table = table;
    }
    this.tableCalls = [];
    for (const u of this.tableUses) {
      const table = this.lookup(u.scope, u.name)?.tables?.get(u.name);
      if (table !== undefined) this.openTables.add(table);
    }
    this.tableUses = [];
    for (const { call, callNode } of aliasCalls) {
      const inner = this.callAt.get(callNode);
      if (inner !== undefined) call.result = inner;
    }
    // Value references: a name of a local variable is no use of a
    // definition and is dropped; the indices that name a reference are
    // renumbered over the ones kept.
    const drop = new Set<ValueRef>();
    // The names an import binds, a namespace among them, for the free-name check.
    // Only an import at the top of the module binds a name the whole file
    // sees; one inside a function binds it there (lookup finds it), and
    // `export ... from` binds none.
    const importLocals = new Set(this.imports.filter((i) => !i.scoped && !i.reexport).flatMap((i) => [...i.names.map((n) => n.local), ...(i.namespace ? [i.namespace] : [])]));
    for (const { ref, scope, ident } of this.pendingValues) {
      if (!ident && ref.recv.kind === "none" && this.libBindings.length > 0) libRead(scope, ref.name, ref.role === "object" ? (this.propOf.get(ref) ?? null) : null, ref.line, `${ref.line}:${ref.column}`);
      // The name of a table passed on, assigned or returned: what it holds
      // may change elsewhere. A read of its member or by a computed key does not.
      if (!ident && ref.recv.kind === "none" && ref.role !== "object" && ref.role !== "index") {
        const table = this.lookup(scope, ref.name)?.tables?.get(ref.name);
        if (table !== undefined) this.openTables.add(table);
      }
      if (ident) {
        const at = this.lookup(scope, ident.name);
        ref.recv = receiverIn(at, ident.name, ident.path, topNames);
        if (ref.recv.kind === "other") drop.add(ref);
        continue;
      }
      const at = this.lookup(scope, ref.name);
      if (!at) {
        if (JS_LANGS.has(this.lang) && ref.recv.kind === "none" && !topNames.has(ref.name) && !importLocals.has(ref.name) && !jsHarmlessGlobal(ref.name, ref.role, this.propOf.get(ref) ?? null)) this.addOpaque(`reads the free name \`${ref.name}\``, ref.line, this.timerRefs.has(ref) ? "global" : jsFreeReach(ref.name, ref.role, this.propOf.get(ref) ?? null), ref.name);
        continue;
      }
      const fn = at.fns?.get(ref.name);
      const bound = at.imports?.get(ref.name);
      if (fn !== undefined) ref.local = fn;
      else if (bound) ref.bound = bound;
      else if (at.depth > 0 || !topNames.has(ref.name)) drop.add(ref);
    }
    this.pendingValues = [];
    // A `require` exported (`export { require }`, `export default require`,
    // `module.exports = require`) goes wherever an importer takes it.
    for (const e of this.exportsLocal) if (e.local === "require") this.pendingEscapes.push({ fact: { kind: "load", line: e.line ?? 1 }, scope: this.root, name: "require" });
    if (this.defaultExport === "require") this.pendingEscapes.push({ fact: { kind: "load", line: 1 }, scope: this.root, name: "require" });
    const made = new Set(this.madeRequire.map((s) => this.lookup(s, "require")));
    for (const { fact, scope, name } of this.pendingEscapes) if ((name === "require" && made.has(this.lookup(scope, name))) || (!this.lookup(scope, name) && !topNames.has(name))) this.escapes.push(fact);
    this.pendingEscapes = [];
    for (const o of this.pendingOpaque) if (!this.lookup(o.scope, o.name) && !topNames.has(o.name)) this.addOpaque(o.why, o.line, o.reach);
    this.pendingOpaque = [];
    // Node's module library handed on: a re-export of anything LIB_SAFE
    // does not name, an export of a name bound to it, or a call of such a
    // name past the depth bound. What an importer makes of it is not
    // followed, so each is a load by a computed path.
    for (const i of this.imports) if (i.reexport && !i.typeOnly && jsLoaderSpec(i.spec) && (i.star || i.namespace !== null || i.names.some((n) => !LIB_SAFE.has(n.imported) && !this.typeSpecifiers.get(i)?.has(n.local)))) this.escapes.push({ kind: "load", line: i.line });
    const libTop = new Set(this.libBindings.filter((b) => b.scope === null || b.scope.depth === 0).map((b) => b.name));
    for (const e of this.exportsLocal) if (libTop.has(e.local)) this.escapes.push({ kind: "load", line: e.line ?? 1 });
    if (this.defaultExport !== null && libTop.has(this.defaultExport)) this.escapes.push({ kind: "load", line: 1 });
    for (const c of this.deepCalls) if (this.libBindings.some((b) => b.name === c.name)) this.escapes.push({ kind: "load", line: c.line });
    this.libBindings = [];
    this.deepCalls = [];
    // A read by a computed key on a value not proved plain (an array, a
    // string, a number, a record) may run any getter, or take any method.
    // A plain type named by a definition or an import of the file is the
    // file's own; one named only by its name holds while the repository
    // declares none of the names it lists (`plain`), decided in resolve.ts.
    const ownNames = new Set([...this.defs.map((d) => d.name), ...importLocals]);
    for (const k of this.keyReads) {
      const ident = (k.recv as Tagged)[IDENT];
      const recv = ident ? receiverIn(this.lookup(k.scope, ident.name), ident.name, ident.path, topNames) : k.recv;
      const plain = jsPlainNames(recv);
      const own = plain !== null && plain.some((n) => ownNames.has(n));
      const key = plain === null || own ? "*" : `*:${plain.join(",")}`;
      const kept = this.looseMembers.get(key);
      if (kept) {
        kept.count++;
        if (!k.stays) kept.passed = true;
      } else this.looseMembers.set(key, { why: "*", line: k.line, count: 1, ...(k.stays ? {} : { passed: true }), ...(key === "*" ? {} : { plain: plain as string[] }) });
    }
    this.keyReads = [];
    for (const t of this.pendingTimers) {
      if (this.lookup(t.scope, t.timer) || topNames.has(t.timer)) continue;
      const at = t.arg === null ? null : this.lookup(t.scope, t.arg);
      if (t.arg !== null && ((at?.fns?.has(t.arg) && !at.reassigned?.has(t.arg)) || (!at && topNames.has(t.arg)))) continue;
      // A name proved a function where it is declared, never given another value.
      const promise = () => !this.lookup(t.scope, "Promise") && !topNames.has("Promise") && !importLocals.has("Promise");
      if (t.arg !== null && at && !at.reassigned?.has(t.arg) && (t.proof === "fn" || (t.proof === "promise" && promise()))) continue;
      this.addOpaque("runs code given to a timer", t.line, "any");
      this.escapes.push({ kind: "global", line: t.line });
    }
    this.pendingTimers = [];
    for (const ref of this.values) {
      const untyped = ref.recv.kind === "type" && (ref.recv.type.name === "any" || ref.recv.type.name === "unknown") && !ref.recv.type.qualifier;
      if (ref.recv.kind !== "other" && !untyped) continue;
      if (!untyped) drop.add(ref);
      // A member read on a value of unknown type.
      if (JS_LANGS.has(this.lang)) {
        const kept = this.looseMembers.get(ref.name);
        if (kept) kept.count++;
        else this.looseMembers.set(ref.name, { why: ref.name, line: ref.line, count: 1 });
      }
    }
    const renumber = new Map<number, number>();
    const values: ValueRef[] = [];
    this.values.forEach((ref, i) => {
      if (drop.has(ref)) return;
      renumber.set(i, values.length);
      values.push(ref);
    });
    for (const c of this.calls) {
      if (c.alias === undefined) continue;
      const to = renumber.get(c.alias);
      if (to === undefined) {
        delete c.alias;
        delete c.aliasOf;
      } else c.alias = to;
    }
    for (const d of this.defs) {
      if (!d.returns) continue;
      const kept = d.returns.map((i) => renumber.get(i)).filter((i): i is number => i !== undefined);
      // A returned name that is a local or a parameter is a value the graph does not name.
      if (kept.length < d.returns.length) d.returnsOther = true;
      if (kept.length > 0) d.returns = kept;
      else delete d.returns;
    }
    const tables = this.tables.map((t, i) => ({ ...t, values: t.values.map((v) => renumber.get(v)).filter((v): v is number => v !== undefined), ...(this.openTables.has(i) ? { open: true } : {}) }));
    // Each type name binds through the scope it was read in: what that scope
    // holds now, or the import it held when the type was read if the code
    // assigned the name something else after.
    const bindType = (t: TypeRef | null | undefined): void => {
      if (t?.on) bindType(t.on);
      if (t?.values) bindType(t.values);
      t?.args?.forEach(bindType);
      t?.parts?.forEach(bindType);
      if (t?.fields) Object.values(t.fields).forEach(bindType);
      const s = t as Stamped | null | undefined;
      const at = s?.[READ_IN];
      if (!s || !at) return;
      const readAs = s[READ_AS];
      delete s[READ_IN];
      delete s[READ_AS];
      const head = s.qualifier ? (s.qualifier.split(".")[0] as string) : s.name;
      const found = this.lookup(at, head);
      let bound = found && !found.fns?.has(head) ? found.imports?.get(head) : undefined;
      if (!bound && readAs && found === readAs.at) bound = readAs.bound;
      if (bound) s.bound = bound;
    };
    for (const d of this.defs) {
      d.callbacks?.forEach((c) => c.params.forEach(bindType));
      d.bases.forEach(bindType);
      Object.values(d.fields).forEach(bindType);
      d.results?.forEach(bindType);
      bindType(d.alias);
      bindType(d.signature);
    }
    for (const c of this.calls) if (c.recv.kind === "type") bindType(c.recv.type);
    for (const v of values) if (v.recv.kind === "type") bindType(v.recv.type);
    for (const t of this.types) bindType(t.ref);
    for (const [by, found] of this.assignedMembers) jsAddLiteral(this, found.line, found, by.startsWith("Object.assign@") ? "Object.assign" : by);
    return {
      lang: this.lang,
      defs: this.defs,
      calls: this.calls,
      values,
      types: this.types,
      ...(typeCuts > 0 ? { typeCuts } : {}),
      tables,
      ...(this.literals.length > 0 ? { literals: this.literals } : {}),
      ...(this.literalsCut ? { literalsCut: true } : {}),
      imports: this.imports,
      exportsLocal: this.exportsLocal,
      defaultExport: this.defaultExport,
      goPackage: this.goPackage,
      ...(this.escapes.length > 0 ? { escapes: this.escapes } : {}),
      // In a script, `this` in a plain function is the global object.
      ...(this.opaque.size > 0 ? { opaque: [...this.opaque.values()].map((o) => (o.why === THIS_OUTSIDE && !this.esm ? { ...o, reach: "any" as const } : o)) } : {}),
      ...(this.ambient.size > 0 ? { ambient: [...this.ambient].sort().slice(0, MAX_AMBIENT_NAMES) } : {}),
      // Top-level `declare` names count only in a script; whether a file
      // with no import or export is one depends on its name (a `.mts` file
      // is a module), so the resolver decides.
      ...(!this.esm && this.ambientTop.size > 0 ? { ambientTop: [...this.ambientTop].sort().slice(0, MAX_AMBIENT_NAMES) } : {}),
      ...(this.looseMembers.size > 0 ? { looseMembers: [...this.looseMembers.values()] } : {}),
      ...(this.variables.size > 0 ? { variables: [...this.variables].filter((n) => !topNames.has(n)) } : {}),
      ...(this.exportedVariables.size > 0 ? { exportedVariables: [...this.exportedVariables].filter((n) => !topNames.has(n)) } : {}),
      ...(this.esm ? { esm: true as const } : {}),
    };
  }
}

// ---------- TypeScript, TSX, JavaScript ----------

const JS_TYPES = new Set([
  "this",
  "ambient_declaration",
  "pair_pattern",
  "shorthand_property_identifier_pattern",
  "internal_module",
  "module",
  "import_alias",
  "meta_property",
  "import_statement",
  "export_statement",
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "method_definition",
  "public_field_definition",
  "field_definition",
  "variable_declarator",
  "interface_declaration",
  "method_signature",
  "abstract_method_signature",
  "property_signature",
  "type_alias_declaration",
  "enum_declaration",
  "return_statement",
  "object",
  "array",
  "as_expression",
  "satisfies_expression",
  "type_assertion",
  "instantiation_expression",
  "binary_expression",
  "jsx_expression",
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "call_expression",
  "new_expression",
  "assignment_expression",
  "jsx_opening_element",
  "jsx_self_closing_element",
  "for_in_statement",
  "for_statement",
  "statement_block",
  "switch_body",
  "catch_clause",
  "identifier",
  "shorthand_property_identifier",
  "member_expression",
  "subscript_expression",
  "with_statement",
  "expression_statement",
]);

// The constraint a TypeScript type parameter in scope stands for (`T
// extends Repo` reads as Repo, an unconstrained one as nothing); undefined
// when the name is no type parameter.
function typeParam(name: string): TypeRef | null | undefined {
  if (enteringTypeParams?.has(name)) return enteringTypeParams.get(name) ?? null;
  let s = readingScope;
  for (let steps = 0; s && steps <= MAX_SCOPE_DEPTH; s = s.parent, steps++) {
    if (s.typeParams?.has(name)) return s.typeParams.get(name) ?? null;
  }
  return undefined;
}

// The type parameters a function, class or interface declares, with
// their constraints; null when it declares none.
function jsTypeParams(node: Node): Map<string, TypeRef | null> | null {
  const list = node.childForFieldName("type_parameters");
  if (!list) return null;
  const out = new Map<string, TypeRef | null>();
  for (const tp of list.namedChildren) {
    if (tp.type !== "type_parameter") continue;
    const name = tp.childForFieldName("name");
    const constraint = tp.childForFieldName("constraint");
    if (name) out.set(name.text, declared(jsTypeRef(constraint?.namedChildren[0] ?? null)));
  }
  return out.size > 0 ? out : null;
}

// Every named type in an annotation (`Map<string, Repo[]>` names Repo);
// type parameters and predefined types are not, nor a name the annotation
// binds itself: a mapped type's key (`[K in keyof T]`) or an `infer X`,
// local to the whole annotation.
function jsTypeNames(node: Node | null): TypeRef[] {
  const out: TypeRef[] = [];
  const bound = new Set<string>();
  typeNodes(node, (n) => {
    if (n.type === "mapped_type_clause" || n.type === "infer_type") {
      const name = n.type === "mapped_type_clause" ? n.childForFieldName("name") : n.firstNamedChild;
      if (name?.type === "type_identifier") bound.add(name.text);
      return false;
    }
    if (n.type === "type_identifier") {
      if (typeParam(n.text) === undefined) out.push(typeRef({ name: n.text, qualifier: null, ...pos(n) }));
      return true;
    }
    if (n.type === "nested_type_identifier") {
      const name = n.childForFieldName("name");
      const module = n.childForFieldName("module");
      if (name && module) out.push(typeRef({ name: name.text, qualifier: module.text, ...pos(n) }));
      return true;
    }
    // `typeof import("./m").x` names a value, not a type, and so does
    // every member between (`typeof import("./m").ns.x`).
    if (n.type === "member_expression" && importTypeCall(n)) {
      let top = n;
      while (top.parent?.type === "member_expression" && sameNode(top.parent.childForFieldName("object"), top)) top = top.parent;
      if (top.parent?.type === "type_query") return true;
      const t = jsImportType(n);
      if (t) out.push(t);
      return true;
    }
    return false;
  });
  return bound.size === 0 ? out : out.filter((t) => t.qualifier !== null || !bound.has(t.name));
}

// The `import("./m")` a type is named through (`import("./m").Row`,
// `import("./m").ns.Row`, which the grammar reads as member expressions),
// or null when the member expression is no import type.
function importTypeCall(n: Node): Node | null {
  let o = n.childForFieldName("object");
  while (o?.type === "member_expression") o = o.childForFieldName("object");
  return o?.type === "call_expression" && o.childForFieldName("function")?.type === "import" ? o : null;
}

// A type named through an import type: bound to a scoped import of the
// module it names, as `import * as m from "./m"` and `m.Row` would bind
// it. Its qualifier is `import` and the namespaces between, a head no
// name of the file can shadow.
function jsImportType(n: Node): TypeRef | null {
  const call = importTypeCall(n);
  const arg = call?.childForFieldName("arguments")?.firstNamedChild;
  const name = n.childForFieldName("property");
  if (!call || arg?.type !== "string" || !name || !readingImportType) return null;
  const path: string[] = [];
  for (let o = n.childForFieldName("object"); o?.type === "member_expression"; o = o.childForFieldName("object")) path.unshift(o.childForFieldName("property")?.text ?? "");
  const bound = { import: readingImportType(jsUnescape(stringContent(arg)), call), imported: "*" };
  return typeRef({ name: name.text, qualifier: ["import", ...path].join("."), ...pos(n), bound });
}

// The named types in the type arguments a base is written with
// (`extends Holder<Repo>`, `implements Store<Row>`, `extends Base<Repo>`):
// each a use of that type by the declaration.
function jsBaseArgNames(node: Node): TypeRef[] {
  if (node.type !== "generic_type" && node.type !== "extends_clause") return [];
  return jsTypeNames(node.childForFieldName("type_arguments"));
}

// The named types in the constraints and defaults of the type parameters a
// declaration lists (`<T extends Repo = Repo>`): each a use of that type.
// Read while the declaration's own type parameters are entering, so one
// parameter named in another's constraint is no type of the repository.
function jsTypeParamNames(node: Node): TypeRef[] {
  const out: TypeRef[] = [];
  for (const tp of node.childForFieldName("type_parameters")?.namedChildren ?? []) {
    if (tp.type !== "type_parameter") continue;
    out.push(...jsTypeNames(tp.childForFieldName("constraint")), ...jsTypeNames(tp.childForFieldName("value")));
  }
  return out;
}

// How deep one annotation's types nest as read: object types in object
// types, type arguments, unions. A type nested deeper is not read (null, so
// a member typed by it is "?"): a file of thousands of nested object types
// never exhausts the stack.
let typeNesting = 0;

function jsTypeRef(annotation: Node | null): TypeRef | null {
  if (!annotation || typeNesting >= MAX_TYPE_DEPTH) return null;
  typeNesting++;
  try {
    return readJsTypeRef(annotation);
  } finally {
    typeNesting--;
  }
}

function readJsTypeRef(annotation: Node): TypeRef | null {
  let t: Node | null = annotation.type === "type_annotation" ? annotation.firstNamedChild : annotation;
  if (t?.type === "union_type") {
    // `Repo | undefined` is a Repo wherever a method is called on it.
    const named = t.namedChildren.filter((m) => !/^(undefined|null)$/.test(m.text));
    return named.length === 1 ? jsTypeRef(named[0] as Node) : null;
  }
  if (t?.type === "array_type") {
    const inner = jsTypeRef(t.firstNamedChild);
    return inner ? { ...inner, elem: true } : null;
  }
  // `A & B`: each side, or nothing when a side cannot be read (a member is
  // then never proved to come from one side alone).
  if (t?.type === "intersection_type") {
    const parts = t.namedChildren.map((c) => jsTypeRef(c));
    if (parts.length < 2 || parts.some((p) => p === null)) return null;
    return typeRef({ name: "&", qualifier: null, ...pos(t), parts: parts as TypeRef[] });
  }
  let args: TypeRef[] | undefined;
  if (t?.type === "generic_type") {
    // The language's own generic type, read through below, only when the
    // file gives its name no other meaning; else the name is a type of the
    // repository, read as any other.
    const named = t.childForFieldName("name")?.text;
    const head = named !== undefined && BUILTIN_GENERICS.has(named) && !fileDeclares(t, named) ? named : undefined;
    const arg = t.childForFieldName("type_arguments")?.firstNamedChild ?? null;
    // Promise<T> is a T once awaited; Array<T> and its kin hold T.
    if (head === "Promise") {
      const inner = jsTypeRef(arg);
      return inner ? { ...inner, promise: true } : null;
    }
    if (head === "Array" || head === "ReadonlyArray" || head === "Set" || head === "ReadonlySet") {
      const inner = jsTypeRef(arg);
      return inner ? { ...inner, elem: true } : null;
    }
    // These keep each member of T they keep, with its type.
    if (head !== undefined && MEMBER_KEEPING.has(head)) return jsTypeRef(arg);
    // Pick<T, K> and Omit<T, K>: T's members, only those K names or those it
    // does not. An intersection of T alone carries the keys. A Pick whose
    // keys are not all written out (`keyof X | "a"`) keeps those that are
    // and may keep any other; such an Omit, or a Pick naming none, is not read.
    if (head === "Pick" || head === "Omit") {
      const inner = jsTypeRef(arg);
      const k = jsKeyNames(t.childForFieldName("type_arguments")?.namedChildren.filter((c) => c.type !== "comment")[1] ?? null);
      if (!inner || !k || (head === "Omit" && !k.all) || k.keys.length === 0) return null;
      return typeRef({ name: "&", qualifier: null, ...pos(t), parts: [inner], ...(head === "Pick" ? { only: k.keys, ...(k.all ? {} : { open: true }) } : { omit: k.keys }) });
    }
    // A Map keeps its value type for `values()`, unless that is a collection itself.
    const name = t.childForFieldName("name");
    if ((head === "Map" || head === "ReadonlyMap") && name) {
      const map = jsTypeRef(name);
      const values = jsTypeRef(t.childForFieldName("type_arguments")?.namedChildren.filter((c) => c.type !== "comment")[1] ?? null);
      return map && values && !values.elem ? { ...map, values } : map;
    }
    // The arguments, when each can be read: a member typed by the type's own
    // parameter takes its argument.
    const read = (t.childForFieldName("type_arguments")?.namedChildren ?? []).filter((c) => c.type !== "comment").map((c) => jsTypeRef(c));
    if (read.length > 0 && read.every((a) => a !== null)) args = read as TypeRef[];
    t = t.childForFieldName("name");
  }
  if (!t) return null;
  const { line, column } = pos(t);
  if (t.type === "type_identifier") {
    const constraint = typeParam(t.text);
    if (constraint !== undefined) return constraint ? { ...constraint } : null;
  }
  // An object type written in place (`{ save(): number }`) names no
  // definition: "{}" marks it, so a call on it is an untyped receiver. Its
  // members' types are kept: a path through a member is typed.
  if (t.type === "object_type") {
    const fields = jsObjectTypeFields(t);
    return typeRef({ name: "{}", qualifier: null, line, column, ...(fields ? { fields } : {}) });
  }
  if (args && (t.type === "type_identifier" || t.type === "nested_type_identifier")) {
    const named = jsTypeRef(t);
    return named ? { ...named, args } : null;
  }
  // A predefined type (`string`, `number`) is kept, so a call on it is known to be the language's own.
  if (t.type === "type_identifier" || t.type === "identifier" || t.type === "predefined_type") return typeRef({ name: t.text, qualifier: null, line, column });
  if (t.type === "member_expression" && importTypeCall(t)) return jsImportType(t);
  if (t.type === "nested_type_identifier" || t.type === "member_expression") {
    const name = t.childForFieldName("name") ?? t.childForFieldName("property");
    const module = t.childForFieldName("module") ?? t.childForFieldName("object");
    if (name && module) return typeRef({ name: name.text, qualifier: module.text, line, column });
  }
  return null;
}

// Generic types whose members are T's own members with T's types.
const MEMBER_KEEPING = new Set(["Readonly", "Partial", "Required", "NonNullable"]);
// Every generic type of the language jsTypeRef reads through.
const BUILTIN_GENERICS = new Set(["Promise", "Array", "ReadonlyArray", "Set", "ReadonlySet", "Map", "ReadonlyMap", "Pick", "Omit", ...MEMBER_KEEPING]);

// The nodes that give a name a meaning in a TypeScript or JavaScript file:
// declarations, and imports by any form.
const DECLARING = ["class_declaration", "abstract_class_declaration", "class", "interface_declaration", "type_alias_declaration", "enum_declaration", "function_declaration", "generator_function_declaration", "internal_module", "module", "variable_declarator", "type_parameter", "import_specifier", "namespace_import", "import_clause", "import_require_clause", "import_alias"];
const IMPORTING = new Set(["import_specifier", "namespace_import", "import_clause", "import_require_clause", "import_alias"]);
const declaredIn = new WeakMap<object, Set<string>>();

// Whether the file of `node` declares or imports `name` in any scope. A name
// reaches a TypeScript file only that way or as a global, and a global of a
// built-in's name is a duplicate the checker rejects.
function fileDeclares(node: Node, name: string): boolean {
  let names = declaredIn.get(node.tree);
  if (!names) {
    names = new Set();
    for (const d of node.tree.rootNode.descendantsOfType(DECLARING)) {
      for (const field of ["name", "alias"]) {
        const n = d.childForFieldName(field);
        if (n) names.add(n.text);
      }
      if (IMPORTING.has(d.type)) for (const c of d.namedChildren) if (c.type === "identifier") names.add(c.text);
    }
    declaredIn.set(node.tree, names);
  }
  return names.has(name);
}

// The member names a key type writes out (`"a"`, `"a" | "b"`), and whether
// it is only those: any other part (`keyof X`, `K`) may name any member.
function jsKeyNames(node: Node | null): { keys: string[]; all: boolean } | null {
  if (!node) return null;
  const keys: string[] = [];
  const cuts = typeCuts;
  let all = true;
  typeNodes(node, (n) => {
    if (n.type === "union_type" || n.type === "parenthesized_type") return false;
    const s = n.type === "literal_type" ? n.firstNamedChild : null;
    if (s?.type === "string" && !s.text.includes("\\")) keys.push(s.text.slice(1, -1));
    else all = false;
    return true;
  });
  return { keys, all: all && typeCuts === cuts };
}

// The members of an object type written in place, by name: a property its
// declared type ("?" when the type cannot be read), a method or a property
// typed by a function "{}". Null when a member cannot be named (an index
// signature, a call signature, a computed or quoted name) or there is none:
// which members it has is then not known.
function jsObjectTypeFields(node: Node, params?: Map<string, TypeRef | null>): Record<string, TypeRef> | null {
  const fields: Record<string, TypeRef> = {};
  let any = false;
  for (const m of node.namedChildren) {
    if (m.type === "comment") continue;
    const name = m.childForFieldName("name");
    if ((m.type !== "property_signature" && m.type !== "method_signature") || name?.type !== "property_identifier") return null;
    const annotation = m.type === "property_signature" ? m.childForFieldName("type") : null;
    const marker = (n: Node, as: string): TypeRef => typeRef({ name: as, qualifier: null, ...pos(n) });
    if (m.type === "method_signature" || annotation?.firstNamedChild?.type === "function_type") fields[name.text] = marker(m, "{}");
    else fields[name.text] = (params ? jsMemberType(annotation, params) : jsTypeRef(annotation)) ?? marker(m, "?");
    any = true;
  }
  return any ? fields : null;
}

// A member's declared type; one written as the declaring interface's or
// class's own unconstrained type parameter is marked with its index, to be
// read from the type arguments the value's type gives.
function jsMemberType(annotation: Node | null, params: Map<string, TypeRef | null> | undefined): TypeRef | null {
  const t = annotation?.type === "type_annotation" ? annotation.firstNamedChild : annotation;
  if (t?.type === "type_identifier" && params?.has(t.text) && params.get(t.text) === null) {
    return { name: t.text, qualifier: null, ...pos(t), kind: "param", param: [...params.keys()].indexOf(t.text) };
  }
  return jsTypeRef(annotation);
}

// The object literals a file records, and the member names one keeps.
const MAX_LITERALS = 4096;
const MAX_LITERAL_KEYS = 1024;
// A value that never holds code: a string, a number, a boolean, null, an array or an object.
const DATA_VALUES = new Set(["string", "template_string", "number", "true", "false", "null", "undefined", "array", "object", "regex"]);
// The members of an object literal that may hold code (a method, a
// function, a name or any other expression), into `into`: a spread may
// bring other members, and a computed key that holds code (`[k]: fn`) is
// a member whose name is not read.
type LiteralKeys = { keys: Set<string>; open: boolean; unread: number };
function jsLiteralKeys(node: Node, into: LiteralKeys): void {
  for (const c of node.namedChildren) {
    if (c.type === "spread_element") into.open = true;
    else if (c.type === "shorthand_property_identifier") into.keys.add(c.text);
    else if (c.type === "method_definition" || c.type === "pair") {
      const key = c.childForFieldName(c.type === "pair" ? "key" : "name");
      const value = c.type === "pair" ? jsUnwrap(c.childForFieldName("value")) : null;
      if (c.type === "pair" && (!value || DATA_VALUES.has(value.type))) continue;
      const name = key?.type === "property_identifier" ? key.text : key?.type === "string" ? key.namedChildren.find((x) => x.type === "string_fragment")?.text : undefined;
      if (name) into.keys.add(name);
      else if (key?.type === "computed_property_name") into.unread++;
    }
  }
}
// Records a value that may hold code under the names `found` gives it.
// The keys past the cap are members whose names are not kept.
function jsAddLiteral(ctx: Ctx, line: number, found: LiteralKeys, by?: string): void {
  if (found.keys.size === 0 && found.unread === 0) return;
  if (ctx.literals.length >= MAX_LITERALS) {
    ctx.literalsCut = true;
    return;
  }
  const keys = [...found.keys];
  const unread = found.unread + Math.max(0, keys.length - MAX_LITERAL_KEYS);
  ctx.literals.push({ line, keys: keys.slice(0, MAX_LITERAL_KEYS), ...(found.open ? { open: true } : {}), ...(unread > 0 ? { unread } : {}), ...(by !== undefined ? { by } : {}) });
}
function jsLiteral(ctx: Ctx, node: Node): void {
  const found: LiteralKeys = { keys: new Set(), open: false, unread: 0 };
  jsLiteralKeys(node, found);
  jsAddLiteral(ctx, node.startPosition.row + 1, found);
}
// A value given members in place: `f.get = fn` and `Object.assign(f, { get })`
// give `f` a member that may hold code, so `f` may fill an interface no
// definition of the graph declares. The members are kept by the text of
// the value (`f`, `deps.store`) for the whole file and recorded when the
// walk ends. Any other target of Object.assign (`Object.assign({}, a, b)`)
// is a value of its own; `this` is left out, as its members are the
// class's fields.
function jsAssignedMembers(ctx: Ctx, target: Node, line: number, objectAssign: boolean): LiteralKeys | null {
  const t = jsUnwrap(target);
  const by = t?.type === "identifier" || t?.type === "member_expression" ? t.text : t && t.type !== "this" && objectAssign ? `Object.assign@${t.startIndex}` : null;
  if (by === null) return null;
  let found = ctx.assignedMembers.get(by);
  if (!found) {
    found = { line, keys: new Set(), open: false, unread: 0 };
    ctx.assignedMembers.set(by, found);
  }
  return found;
}

// An expression read for its value: `(x)`, `x!` and `x satisfies T` are x.
function jsUnwrap(node: Node | null): Node | null {
  let n = node;
  while (n && (n.type === "parenthesized_expression" || n.type === "non_null_expression" || n.type === "satisfies_expression") && n.firstNamedChild) n = n.firstNamedChild;
  return n;
}

// The receiver of `a.b.c()`: the object `a.b` flattened to a base and a path.
function jsReceiver(ctx: Ctx, object: Node): Receiver {
  const path: string[] = [];
  let base: Node | null = jsUnwrap(object);
  while (base && base.type === "member_expression") {
    const prop = base.childForFieldName("property");
    if (!prop) return { kind: "other" };
    path.unshift(prop.text);
    base = jsUnwrap(base.childForFieldName("object"));
  }
  if (!base) return { kind: "other" };
  // `this` or `super` in a function that is no arrow and no method: not proved the class's.
  if ((base.type === "this" || base.type === "super") && ctx.top.thisKnown === false && ctx.cls()) return { kind: "other" };
  if (base.type === "this") return { kind: "self", path };
  if (base.type === "super") return path.length === 0 ? { kind: "super" } : { kind: "other" };
  // `(x as T).m()`: the cast declares the type, as an annotation would.
  if (base.type === "as_expression") {
    const type = declared(jsTypeRef(base.namedChildren[1] ?? null));
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type === "new_expression") {
    const type = newType(base);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type === "call_expression" || base.type === "await_expression") {
    const type = callType(ctx, base);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type === "identifier") {
    return ctx.identReceiver(base.text, path);
  }
  return { kind: "other" };
}

function jsCallee(ctx: Ctx, fn: Node | null): void {
  if (!fn) return;
  if (fn.type === "instantiation_expression") return jsCallee(ctx, fn.childForFieldName("function"));
  if (fn.type === "await_expression") return jsCallee(ctx, fn.firstNamedChild);
  if (fn.type === "parenthesized_expression") return;
  if (fn.type === "subscript_expression") {
    ctx.addDynamicCall(fn);
    return;
  }
  if (fn.type === "identifier") {
    if (fn.text !== "require") ctx.addCall(fn, { kind: "none" });
    return;
  }
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    const object = fn.childForFieldName("object");
    if (prop && object) {
      const call = ctx.calls[ctx.addCall(prop, jsReceiver(ctx, object))] as CallFact;
      const text = object.text.replace(/\s+/g, "");
      if (text.length <= 80 && /^[\w$#.!?()]+$/.test(text)) call.hint = text;
    }
  }
}

// A type from an annotation: a reassignment cannot change it.
function declared(t: TypeRef | null): TypeRef | null {
  return t ? { ...t, declared: true } : null;
}

function isStatic(node: Node): boolean {
  return node.children.some((c) => c.type === "static");
}

// The parameters of a function or a signature: each a local of `locals`
// (when given) with its declared type, each named type a type use of
// `def`, the return type too, and the names in order on `def` ("" for a
// destructured one) for its invocation summary.
function jsSignature(ctx: Ctx, fn: Node, def: number, locals: Map<string, TypeRef | null> | null): void {
  const user = def >= 0 ? def : ctx.caller();
  const names: string[] = [];
  const params = fn.childForFieldName("parameters");
  if (!params) {
    const single = fn.childForFieldName("parameter"); // x => ...
    if (single?.type === "identifier") {
      locals?.set(single.text, null);
      names.push(single.text);
    }
  }
  for (const p of params?.namedChildren ?? []) {
    if (p.type === "identifier") {
      locals?.set(p.text, null);
      names.push(p.text);
      continue;
    }
    if (p.type === "comment") continue;
    // TypeScript wraps each parameter and names its pattern; JavaScript does not.
    const pattern = p.childForFieldName("pattern");
    if (pattern?.type === "this") continue; // TypeScript's `this` parameter is no argument
    const typeNode = p.childForFieldName("type");
    if (pattern?.type === "identifier") {
      locals?.set(pattern.text, declared(jsTypeRef(typeNode)));
      const params = def >= 0 ? jsCallbackParams(typeNode, fn) : null;
      if (params) ((ctx.defs[def] as DefFact).callbacks ??= []).push({ arg: names.length, params });
      names.push(pattern.text);
    } else {
      const bound = patternNames(pattern ?? p);
      for (const name of bound) locals?.set(name, null);
      // `({ sessions }: Deps)`: each name has the type of its member.
      const from = pattern?.type === "object_pattern" ? declared(jsTypeRef(typeNode)) : null;
      if (from && pattern) for (const [name, type] of jsPatternTypes(pattern, from, true)) locals?.set(name, type);
      names.push(bound.length === 1 && (p.type === "assignment_pattern" || pattern?.type === "assignment_pattern") ? (bound[0] as string) : "");
    }
    for (const t of jsTypeNames(typeNode)) ctx.addTypeUse(t, user);
  }
  for (const t of jsTypeNames(fn.childForFieldName("return_type"))) ctx.addTypeUse(t, user);
  if (def >= 0 && names.some((n) => n !== "")) (ctx.defs[def] as DefFact).params = names;
}

// A parameter declared as a function type (`fn: (s: Span) => T`): the
// declared type of each parameter of that function, null where none is
// written or a type parameter is named; null when it declares none.
function jsCallbackParams(typeNode: Node | null, fn: Node): (TypeRef | null)[] | null {
  let t = typeNode?.type === "type_annotation" ? typeNode.firstNamedChild : typeNode;
  while (t?.type === "parenthesized_type") t = t.firstNamedChild;
  if (t?.type !== "function_type" || t.childForFieldName("type_parameters")) return null;
  const own = new Set(fn.childForFieldName("type_parameters")?.namedChildren.map((p) => p.childForFieldName("name")?.text) ?? []);
  const out: (TypeRef | null)[] = [];
  for (const p of t.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type === "comment") continue;
    const pattern = p.childForFieldName("pattern");
    if (pattern?.type === "this") continue;
    const type = p.childForFieldName("type");
    const generic = type?.descendantsOfType("type_identifier").some((n) => own.has(n.text) || typeParam(n.text) !== undefined);
    out.push(p.type === "required_parameter" && pattern?.type === "identifier" && !generic ? jsTypeRef(type) : null);
  }
  return out.some((x) => x !== null) ? out : null;
}

// The names of a function's parameters, by position: a plain name with no
// type or default written on it, else null.
function jsUntypedParams(fn: Node): (string | null)[] {
  const single = fn.childForFieldName("parameter"); // x => ...
  if (single) return [single.type === "identifier" ? single.text : null];
  const out: (string | null)[] = [];
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type === "comment") continue;
    const pattern = p.type === "required_parameter" ? p.childForFieldName("pattern") : null;
    if (pattern?.type === "this") continue;
    out.push(p.type === "identifier" ? p.text : pattern?.type === "identifier" && !p.childForFieldName("type") && !p.childForFieldName("value") ? pattern.text : null);
  }
  return out;
}

// A name or a member path that may stand for a function of the
// repository; null for anything else (a literal, a call, `this` alone).
function jsValueNode(ctx: Ctx, n: Node | null): ValueNode {
  if (!n) return null;
  if (n.type === "identifier") return n.text === "undefined" ? null : { name: n, recv: { kind: "none" } };
  if (n.type === "member_expression") {
    const prop = n.childForFieldName("property");
    const object = n.childForFieldName("object");
    if (!prop || !object || prop.type !== "property_identifier") return null;
    const recv = jsReceiver(ctx, object);
    return recv.kind === "other" ? null : { name: prop, recv };
  }
  return null;
}

// The arguments of a call: each name or member path a value reference
// with its position (none past a spread, where positions are unknown).
function jsArgs(ctx: Ctx, args: Node | null, call: number | undefined): void {
  let i = 0;
  let known = call !== undefined;
  for (const a of args?.namedChildren ?? []) {
    if (a.type === "comment") continue;
    if (a.type === "spread_element") known = false;
    const v = jsValueNode(ctx, a);
    if (v) ctx.addValue(v, "arg", known ? { call, arg: i } : {});
    i++;
  }
}

const FN_DECLS = new Set(["function_declaration", "generator_function_declaration", "method_definition"]);

function isFnNode(n: Node | null): boolean {
  return n !== null && ["arrow_function", "function_expression", "function", "generator_function"].includes(n.type);
}

// The names a destructuring pattern binds: `{ a, b: c, d = 1, ...e }`,
// `[f, [g] = h]`, Python `a, (b, *c)`. A target that is not a name (`x.y`,
// `x[0]`) binds nothing.
function patternNames(node: Node | null, out: string[] = []): string[] {
  if (!node) return out;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(node.text);
      break;
    case "pair_pattern":
      patternNames(node.childForFieldName("value"), out);
      break;
    case "assignment_pattern":
    case "object_assignment_pattern":
      patternNames(node.childForFieldName("left"), out);
      break;
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
    case "pattern_list":
    case "tuple_pattern":
    case "list_pattern":
    case "list_splat_pattern":
      for (const c of node.namedChildren) patternNames(c, out);
      break;
  }
  return out;
}

function isExportedDecl(node: Node): boolean {
  let p = node.parent;
  if (node.type === "variable_declarator") p = p?.parent ?? null;
  return p?.type === "export_statement";
}

function typeSpecifier(ctx: Ctx, fact: ImportFact, local: string): void {
  const set = ctx.typeSpecifiers.get(fact);
  if (set) set.add(local);
  else ctx.typeSpecifiers.set(fact, new Set([local]));
}

function jsImport(ctx: Ctx, node: Node): void {
  const source = node.childForFieldName("source") ?? node.namedChildren.find((c) => c.type === "import_require_clause")?.namedChildren.find((c) => c.type === "string");
  if (!source) return;
  const fact: ImportFact = {
    spec: stringContent(source),
    ...pos(node),
    names: [],
    namespace: null,
    star: false,
    reexport: false,
    typeOnly: node.children.some((c) => c.type === "type"),
  };
  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  // TypeScript `import m = require("./m")`: m is bound to the whole module.
  const required = node.namedChildren.find((c) => c.type === "import_require_clause");
  if (required) {
    ctx.addOpaque("uses `import x = require(...)` that the reader does not read whole", node.startPosition.row + 1);
    const name = required.namedChildren.find((c) => c.type === "identifier");
    const spec = required.namedChildren.find((c) => c.type === "string");
    if (name && spec) {
      const fact: ImportFact = { spec: stringContent(spec), ...pos(node), names: [], namespace: name.text, star: false, reexport: false, typeOnly: false };
      ctx.imports.push(fact);
      ctx.libImport(fact, null);
    }
    return;
  }
  for (const part of clause?.namedChildren ?? []) {
    if (part.type === "identifier") fact.names.push({ imported: "default", local: part.text });
    else if (part.type === "namespace_import") fact.namespace = part.firstNamedChild?.text ?? null;
    else if (part.type === "named_imports") {
      for (const s of part.namedChildren) {
        if (s.type !== "import_specifier") continue;
        const name = s.childForFieldName("name");
        const alias = s.childForFieldName("alias");
        if (name) fact.names.push({ imported: name.text, local: (alias ?? name).text });
        if (name && s.children.some((c) => c.type === "type")) typeSpecifier(ctx, fact, (alias ?? name).text);
      }
    }
  }
  ctx.imports.push(fact);
  const types = ctx.typeSpecifiers.get(fact);
  ctx.libImport(types ? { ...fact, names: fact.names.filter((n) => !types.has(n.local)) } : fact, null);
}

function jsExport(ctx: Ctx, node: Node): void {
  const source = node.childForFieldName("source");
  const clause = node.namedChildren.find((c) => c.type === "export_clause");
  const specs = (clause?.namedChildren ?? []).filter((s) => s.type === "export_specifier");
  if (source) {
    const fact: ImportFact = {
      spec: stringContent(source),
      ...pos(node),
      names: [],
      namespace: null,
      star: false,
      reexport: true,
      typeOnly: node.children.some((c) => c.type === "type"),
    };
    const ns = node.namedChildren.find((c) => c.type === "namespace_export");
    if (ns) fact.names.push({ imported: "*", local: ns.firstNamedChild?.text ?? "" });
    else if (!clause) fact.star = true;
    for (const s of specs) {
      const name = s.childForFieldName("name");
      const alias = s.childForFieldName("alias");
      if (name) fact.names.push({ imported: name.text, local: (alias ?? name).text });
      if (name && s.children.some((c) => c.type === "type")) typeSpecifier(ctx, fact, (alias ?? name).text);
    }
    ctx.imports.push(fact);
    return;
  }
  for (const s of specs) {
    const name = s.childForFieldName("name");
    const alias = s.childForFieldName("alias");
    if (name) ctx.exportsLocal.push({ local: name.text, exported: (alias ?? name).text, line: s.startPosition.row + 1 });
  }
  if (node.children.some((c) => c.type === "default")) {
    const decl = node.childForFieldName("declaration");
    const named = decl?.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (named) ctx.defaultExport = named.text;
    else if (value?.type === "identifier") ctx.defaultExport = value.text;
  }
}

function isDefaultExport(node: Node): boolean {
  return node.parent?.type === "export_statement" && node.parent.children.some((c) => c.type === "default");
}

// CommonJS exports: `module.exports = { a, b: c }`, `module.exports = a`,
// `module.exports.x = a`, `exports.x = a`, `exports.x = function () {}`.
function jsCommonExport(ctx: Ctx, node: Node, left: Node, right: Node | null): Leave | boolean {
  if (!right || !ctx.atModuleLevel() || ctx.caller() >= 0) return false;
  const target = left.text.replace(/\s+/g, "");
  // A value the export table cannot list whole: the module's exports may hold any function.
  const unread = () => ctx.addEscape({ kind: "own", line: node.startPosition.row + 1 });
  if (target === "module.exports") {
    if (right.type === "identifier") ctx.defaultExport = right.text;
    else if (right.type !== "object" && !isFnNode(right) && !DATA_VALUES.has(right.type)) unread();
    for (const p of right.type === "object" ? right.namedChildren : []) {
      if (p.type === "shorthand_property_identifier") ctx.exportsLocal.push({ local: p.text, exported: p.text, line: p.startPosition.row + 1 });
      else if (p.type === "pair") {
        const key = p.childForFieldName("key");
        const value = p.childForFieldName("value");
        if (key && key.type !== "computed_property_name" && value?.type === "identifier") ctx.exportsLocal.push({ local: value.text, exported: key.type === "string" ? stringContent(key) : key.text, line: p.startPosition.row + 1 });
        else if (!value || key?.type === "computed_property_name" || (!isFnNode(value) && !DATA_VALUES.has(value.type))) unread();
      } else if (p.type !== "comment" && p.type !== "method_definition") unread();
    }
    return true;
  }
  const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
  if (!m) return false;
  const name = m[1] as string;
  if (right.type === "identifier") {
    ctx.exportsLocal.push({ local: right.text, exported: name, line: node.startPosition.row + 1 });
    return true;
  }
  if (["arrow_function", "function_expression", "function"].includes(right.type)) {
    const prop = left.childForFieldName("property") as Node;
    const def = ctx.addDef(node, prop, "function", { topLevel: true, exported: true, results: jsResults(right) });
    return ctx.push({ def, cls: null, locals: null });
  }
  if (!DATA_VALUES.has(right.type)) unread();
  else ctx.exportedVariables.add(name);
  return false;
}

// `const x = require("./m")` and `const { a, b: c } = require("./m")`, and the
// same with `await import("./m")`. Inside a function or a block the names
// belong to that scope (`block`: a `let` or `const`). Without `await` the
// value is a promise, not the module, so it is not an import. A pattern the
// reader does not read whole (a default value, a rest, a nested part, an
// array, a computed key) keeps the names it does read and marks the module:
// any of its names may be reached. A computed path is a load of a module the
// graph cannot name, read for any name: it may be Node's module library,
// whose loader then loads anything. Node's module library itself binds as
// an import does (Ctx.libImport), unless it is exported or taken apart by a
// pattern the reader does not read whole.
function jsRequire(ctx: Ctx, node: Node, nameNode: Node, value: Node, block: boolean): boolean {
  const awaited = value.type === "await_expression";
  const call = awaited ? value.firstNamedChild : value;
  if (call?.type !== "call_expression") return false;
  const fn = call.childForFieldName("function");
  if (awaited ? fn?.type !== "import" : fn?.type !== "identifier" || fn.text !== "require") return false;
  const arg = call.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
  const line = node.startPosition.row + 1;
  ctx.consumedLoads.add(call.startIndex);
  // Exported as a variable, the module goes wherever an importer takes it.
  if (arg?.type === "string" && isExportedDecl(node)) ctx.addEscape({ kind: "module", spec: stringContent(arg), line });
  if (arg?.type !== "string") {
    ctx.addEscape({ kind: "load", line });
    for (const name of patternNames(nameNode)) ctx.setLocal(name, null, block);
    return true;
  }
  const fact: ImportFact = { spec: stringContent(arg), ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
  if (jsLoaderSpec(fact.spec) && isExportedDecl(node)) ctx.addEscape({ kind: "load", line });
  if (jsLoaderSpec(fact.spec) && nameNode.type === "object_pattern") ctx.libPatterns.add(nameNode.startIndex);
  if (nameNode.type === "identifier") fact.namespace = nameNode.text;
  else {
    const keys = jsPatternKeys(nameNode);
    if (keys) fact.names.push(...keys.names);
    if (!keys || !keys.full) {
      if (jsLoaderSpec(fact.spec)) ctx.addEscape({ kind: "load", line });
      ctx.addEscape({ kind: "module", spec: fact.spec, line });
      // A default value, a rest or a nested pattern: a local whose value is not known.
      const read = new Set(fact.names.map((n) => n.local));
      for (const name of patternNames(nameNode)) if (!read.has(name)) ctx.setLocal(name, null, block);
    }
  }
  ctx.addImport(fact, block);
  return true;
}

// The names an object pattern reads by a plain key (`{ a }`, `{ a: b }`,
// `{ "a": b }`), and whether it reads nothing else; null for any other pattern.
function jsPatternKeys(pattern: Node): { names: { imported: string; local: string }[]; full: boolean } | null {
  if (pattern.type !== "object_pattern") return null;
  const names: { imported: string; local: string }[] = [];
  let full = true;
  for (const p of pattern.namedChildren) {
    if (p.type === "comment") continue;
    const key = p.type === "pair_pattern" ? p.childForFieldName("key") : null;
    const val = p.type === "pair_pattern" ? p.childForFieldName("value") : null;
    if (p.type === "shorthand_property_identifier_pattern") names.push({ imported: p.text, local: p.text });
    else if ((key?.type === "property_identifier" || key?.type === "string") && val?.type === "identifier") names.push({ imported: key.type === "string" ? stringContent(key) : key.text, local: val.text });
    else full = false;
  }
  return { names, full };
}

// A read of `.constructor`: from a function it is `Function`, which makes
// code from a string, so the file is opaque and the code may load anything.
function jsConstructorRead(ctx: Ctx, line: number): void {
  ctx.addOpaque("reads `.constructor` and so can reach `Function`", line, "any");
  ctx.addEscape({ kind: "global", line });
}

// Node's module library under the paths that name it. The members LIB_SAFE
// names load nothing: `isBuiltin` and `builtinModules` name the built-in
// modules, `findSourceMap` and `SourceMap` read source maps, and
// `syncBuiltinESMExports` updates the built-in modules' ES bindings (Node's
// module docs). Any other use of it may make a loader (`createRequire`, `Module`,
// `_load`, its default export), so it is a load by a computed path.
const LOADER_MODULES = new Set(["module", "node:module"]);
const LIB_SAFE = new Set(["isBuiltin", "builtinModules", "findSourceMap", "SourceMap", "syncBuiltinESMExports"]);
// Members that make a loader or are one, on any value: a call or a read of
// one is a load by a computed path, a method of that name of the
// repository too.
const LOADER_MEMBERS = new Set(["createRequire", "_load"]);
// Read by name other than as a call (`const g = process.getBuiltinModule`,
// `const { createRequire } = x`), these are loaders too: `getBuiltinModule`
// gives Node's module library for a path the reader no longer sees.
const LOADER_READS = new Set([...LOADER_MEMBERS, "getBuiltinModule"]);
// Whether a path written as a string names Node's module library, its
// escapes decoded (`"node:\u006dodule"`).
function jsLoaderSpec(raw: string): boolean {
  return LOADER_MODULES.has(jsUnescape(raw));
}
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
// The value of the text between a JavaScript string's quotes, each escape
// decoded: `\u006d`, `\u{6d}`, `\x6d`, `\155`, a line continuation, `\n`.
function jsUnescape(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g, (_m, cp, u4, x2, oct, eol, ch) => {
    if (cp !== undefined) return parseInt(cp, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(cp, 16)) : "";
    if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
    if (x2 !== undefined) return String.fromCharCode(parseInt(x2, 16));
    if (oct !== undefined) return String.fromCharCode(parseInt(oct, 8));
    if (eol !== undefined) return "";
    return SIMPLE_ESCAPES[ch] ?? ch;
  });
}
// Whether a base given to `createRequire` is the file's own place:
// `import.meta.url`, `import.meta.filename`, `__filename` (`filename`: it
// must be the free one in a CommonJS file), or `pathToFileURL` of a file
// name, or its `.href` (`url`: the name it is called by, which an import of
// `url` must bind). Null for any other base: a computed one, or another
// folder. What must hold is decided once the file is read (Ctx.facts).
function jsOwnBase(arg: Node): { filename: boolean; url: { name: string; member: boolean } | null } | null {
  let n = jsHeld(arg);
  const href = n?.type === "member_expression" && n.childForFieldName("property")?.text === "href";
  if (href) n = jsHeld(n?.childForFieldName("object") ?? null);
  const fn = n?.type === "call_expression" ? jsHeld(n.childForFieldName("function")) : null;
  const object = fn?.type === "member_expression" ? jsHeld(fn.childForFieldName("object")) : null;
  const url = fn?.type === "identifier" && fn.text === "pathToFileURL" ? { name: fn.text, member: false }
    : object?.type === "identifier" && fn?.childForFieldName("property")?.text === "pathToFileURL" ? { name: object.text, member: true } : null;
  if ((href || fn) && !url) return null;
  if (url) n = jsHeld(n?.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment") ?? null);
  if (n?.type === "identifier" && n.text === "__filename") return { filename: true, url };
  const text = n?.type === "member_expression" ? n.text.replace(/\s+/g, "") : "";
  return text === "import.meta.filename" || (!url && text === "import.meta.url") ? { filename: false, url } : null;
}
// An `import("./m")` inside `typeof` in a type, through members.
function jsInTypeQuery(call: Node): boolean {
  let n = call;
  while (n.parent?.type === "member_expression" && sameNode(n.parent.childForFieldName("object"), n)) n = n.parent;
  return n.parent?.type === "type_query";
}
// Node's module library written in place: `require("node:module")` or
// `process.getBuiltinModule("node:module")`, with a written path.
function jsInlineLib(call: Node): boolean {
  const fn = jsHeld(call.childForFieldName("function"));
  const first = call.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
  if (first?.type !== "string" || !jsLoaderSpec(stringContent(first))) return false;
  if (fn?.type === "identifier") return fn.text === "require";
  return fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "getBuiltinModule" && jsHeld(fn.childForFieldName("object"))?.text === "process";
}
// A name written with an escape (`\u0065val`, `x.\u0063onstructor`): the
// reader compares names as written, so what it does is not known and the
// file may reach anything.
function jsEscapedName(ctx: Ctx, text: string, line: number): void {
  if (!text.includes("\\")) return;
  ctx.addOpaque("writes a name with an escape the reader does not read", line, "any");
  ctx.addEscape({ kind: "global", line });
}
// The text of a literal key (`c["total"]`, `` c[`total`] ``, `{ ["total"]:
// t }`), its escapes decoded; null for any other key (a name, a template
// with a substitution, an expression).
function jsKeyText(key: Node | null): string | null {
  const k = key?.type === "computed_property_name" ? jsHeld(key.firstNamedChild) : key;
  if (k?.type === "string") return jsUnescape(stringContent(k));
  if (k?.type === "template_string" && !k.namedChildren.some((c) => c.type === "template_substitution")) return jsUnescape(stringContent(k));
  return null;
}
// A load of Node's module library by a written path that the reader did
// not read as a binding (`require("module")`, `import("node:module")`,
// `process.getBuiltinModule("module")`): thrown away, or read for a member
// LIB_SAFE names (`require("module").isBuiltin`), it loads nothing; any
// other use (another member, an index, passed on, a promise not awaited) is
// a load by a computed path. Only such a load reads its parents.
function jsLibUse(ctx: Ctx, call: Node, line: number): void {
  if (ctx.discardedCalls.has(callKey(call)) || ctx.ownLibCalls.has(callKey(call))) return;
  let at = call;
  let up = call.parent;
  const climb = () => {
    while (up && JS_WRAPPERS.has(up.type)) {
      at = up;
      up = up.parent;
    }
  };
  if (call.childForFieldName("function")?.type === "import") {
    climb();
    if (up?.type !== "await_expression") return void ctx.addEscape({ kind: "load", line });
    at = up;
    up = up.parent;
  }
  climb();
  const prop = up?.type === "member_expression" && sameNode(up.childForFieldName("object"), at) ? up.childForFieldName("property") : null;
  if (prop?.type !== "property_identifier" || !LIB_SAFE.has(prop.text)) ctx.addEscape({ kind: "load", line });
}
// The value a node holds, through the wrappers that keep it (a cast too).
function jsHeld(node: Node | null): Node | null {
  let n = node;
  while (n && JS_WRAPPERS.has(n.type)) n = n.type === "type_assertion" ? n.lastNamedChild : n.firstNamedChild;
  return n;
}
// A call by its start and end, the two sameNode compares for nodes of one type.
const callKey = (call: Node): string => `${call.startIndex}:${call.endIndex}`;
const REQUIRE_WRAPPERS = new Set(["await_expression", "parenthesized_expression", "as_expression", "non_null_expression", "satisfies_expression", "type_assertion"]);
// The calls whose value is given to the name `require` (`const require =
// f()`, `let { require } = f()`, `require = f()`), marked from `value`, the
// declarator's or the assignment's value, down through the wrappers that
// keep it: what such a call returns may be a loader, so each read of that
// `require` stays one.
function jsMarkRequireBinders(ctx: Ctx, value: Node | null, own = false): void {
  const stack = value ? [value] : [];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (n.type === "call_expression") {
      ctx.bindsRequire.add(callKey(n));
      if (own) ctx.ownBinders.add(callKey(n));
    }
    else if (REQUIRE_WRAPPERS.has(n.type)) stack.push(...n.namedChildren);
  }
}

// A pattern that takes a loader by name from a value (`const {
// createRequire } = x`), as `x.createRequire` does, unless it takes apart
// Node's module library loaded by a written path, which binds as an import.
function jsPatternLoader(ctx: Ctx, pattern: Node | null, key: string | null, line: number): void {
  if (key !== null && LOADER_READS.has(key) && pattern?.type === "object_pattern" && !ctx.libPatterns.has(pattern.startIndex)) ctx.addEscape({ kind: "load", line });
}
// The escapes a call may open: a load the reader did not read as a binding,
// a direct eval, `Function`, a string run as code by a timer, a call that
// makes or uses a loader (`createRequire`, `module.require`, Node's module
// library), an eval through the global object.
function jsCallEscapes(ctx: Ctx, node: Node, fn: Node | null): void {
  if (!fn) return;
  const line = node.startPosition.row + 1;
  const key = callKey(node);
  if (ctx.bindsRequire.has(key)) ctx.madeRequire.push(ctx.top);
  const first = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment") ?? null;
  const literal = first?.type === "string";
  // A load whose value is thrown away runs the module and reads none of its names.
  const discarded = ctx.discardedCalls.has(key);
  const loaded: EscapeFact | null = !literal ? { kind: "load", line } : !discarded ? { kind: "module", spec: stringContent(first as Node), line } : null;
  const load = () => {
    if (loaded) ctx.addEscape(loaded);
  };
  const lib = literal && jsLoaderSpec(stringContent(first as Node));
  // A call that may be `createRequire` given the file's own place, whose
  // value is the file's own require: bound to `require` (its uses are read
  // as require's are), or called at once (that call loads as `require` does).
  const outer = ctx.calledCalls.get(key);
  const base = (outer !== undefined || ctx.ownBinders.has(key)) && first !== null ? jsOwnBase(first) : null;
  const ownRequire = (name: Node, member: boolean, inline = false) => {
    const arg = outer?.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
    const made: EscapeFact | null = !outer ? null : arg?.type !== "string" ? { kind: "load", line } : ctx.discardedCalls.has(callKey(outer)) ? null : { kind: "module", spec: stringContent(arg), line };
    const { line: at, column } = pos(name);
    ctx.ownRequires.push({ name: name.text, member, inline, key: `${at}:${column}`, scope: ctx.top, line, filename: base?.filename === true, url: base?.url ?? null, outer: made });
  };
  if (fn.type === "import" || (fn.type === "identifier" && fn.text === "require")) {
    if (ctx.consumedLoads.has(node.startIndex)) return;
    // `typeof import("./m").fn` names a type: nothing is loaded.
    if (fn.type === "import" && jsInTypeQuery(node)) return;
    load();
    if (lib) jsLibUse(ctx, node, line);
    return;
  }
  if (fn.type === "identifier") {
    jsEscapedName(ctx, fn.text, line);
    if (fn.text === "eval") ctx.addEscape({ kind: "eval", line }, "eval");
    else if (fn.text === "Function") {
      ctx.addEscape({ kind: "global", line }, "Function");
      ctx.addOpaque("makes code from a string with `Function`", line, "any", "Function");
    }
    else if (TIMERS.has(fn.text) && first && !JS_FN_LITERALS.has(first.type)) {
      // A browser runs a string given to a timer as code: only a function
      // written in place, or a name proved a function, is safe.
      ctx.pendingTimers.push({ scope: ctx.top, timer: fn.text, arg: first.type === "identifier" ? first.text : null, proof: first.type === "identifier" ? jsFunctionProof(first, first.text, ctx.proofs) : null, line });
    }
    else if (base !== null) ownRequire(fn, false);
    // What `createRequire(...)` makes loads any module.
    else if (fn.text === "createRequire") ctx.addEscape({ kind: "load", line });
    return;
  }
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property")?.text;
    const object = jsUnwrap(fn.childForFieldName("object"));
    // `f.constructor("code")`: the constructor of a function is `Function`.
    if (prop === "constructor") jsConstructorRead(ctx, line);
    if (prop !== undefined) jsEscapedName(ctx, prop, line);
    if (prop === "createRequire" && base !== null && object?.type === "identifier") ownRequire(object, true);
    // `require("node:module").createRequire(base)("./x")`, or through
    // `process.getBuiltinModule("node:module")`, called at once.
    else if (prop === "createRequire" && base !== null && outer !== undefined && object?.type === "call_expression" && jsInlineLib(object)) {
      ctx.ownLibCalls.add(callKey(object));
      ownRequire(object, true, true);
    }
    else if (prop !== undefined && LOADER_MEMBERS.has(prop)) ctx.addEscape({ kind: "load", line });
    if (prop === "require" && loaderOwner(object)) {
      load();
      if (lib) jsLibUse(ctx, node, line);
    }
    // `process.getBuiltinModule(...)`, on any value: a built-in module, so
    // Node's module library when the path is computed.
    else if (prop === "getBuiltinModule") {
      if (lib) jsLibUse(ctx, node, line);
      else if (!literal && !discarded) ctx.addEscape({ kind: "load", line });
    }
    else if (prop === "eval" && object?.type === "identifier" && GLOBAL_OBJECTS.has(object.text)) ctx.addEscape({ kind: "global", line }, object.text);
    // `window.setTimeout(x)`: a timer, read as one when the global object's name is free.
    else if (prop !== undefined && TIMERS.has(prop) && object?.type === "identifier" && GLOBAL_NAMES.has(object.text) && first && !JS_FN_LITERALS.has(first.type)) {
      ctx.pendingTimers.push({ scope: ctx.top, timer: object.text, arg: first.type === "identifier" ? first.text : null, proof: first.type === "identifier" ? jsFunctionProof(first, first.text, ctx.proofs) : null, line });
    }
  }
}

// Whether `name`, read at `from`, is proved to hold a function where it is
// declared: a function, an arrow or a function-typed name given in a
// `const` or a function declaration; a parameter whose type is a function
// type; or one of the first two parameters of a function written as the
// executor of `new Promise(...)` ("promise": only when `Promise` is the
// global one). Null for anything else, and whenever the code that holds
// that declaration binds or assigns the name anywhere else: a pattern, a
// loop, a `catch`, a `var` in a nested block, an assignment.
function jsFunctionProof(from: Node, name: string, proofs: Map<string, { is: "fn" | "promise" | null } | null>): "fn" | "promise" | null {
  for (let n = from.parent; n; n = n.parent) {
    // Each block or function is read once per name: many timers given one
    // callback cost one scan, not one each.
    const key = `${n.startIndex}:${n.endIndex}:${n.type}:${name}`;
    const known = proofs.get(key);
    if (known !== undefined) {
      if (known) return known.is;
      if (n.type === "program") return null;
      continue;
    }
    let proof: { decl: Node; is: "fn" | "promise" | null } | null = null;
    if (n.type === "statement_block" || n.type === "program") {
      for (const child of n.namedChildren) {
        const c = child.type === "export_statement" ? (child.childForFieldName("declaration") ?? child) : child;
        if (c.type === "lexical_declaration" || c.type === "variable_declaration") {
          for (const d of c.namedChildren) {
            const id = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
            if (id?.type !== "identifier" || id.text !== name) continue;
            const constant = c.type === "lexical_declaration" && c.child(0)?.type === "const";
            const value = jsUnwrap(d.childForFieldName("value"));
            proof = { decl: id, is: constant && (JS_FN_LITERALS.has(value?.type ?? "") || jsFunctionType(d.childForFieldName("type"))) ? "fn" : null };
          }
        } else if ((c.type === "function_declaration" || c.type === "generator_function_declaration") && c.childForFieldName("name")?.text === name) {
          proof = { decl: c.childForFieldName("name") as Node, is: "fn" };
        }
        if (proof) break;
      }
    } else if (JS_FN_NODES.has(n.type)) {
      const single = n.childForFieldName("parameter");
      const params = single ? [single] : (n.childForFieldName("parameters")?.namedChildren ?? []).filter((p) => p.type !== "comment");
      const at = params.findIndex((p) => (p.type === "identifier" ? p : p.childForFieldName("pattern"))?.text === name);
      const p = params[at];
      const id = p?.type === "identifier" ? p : p?.childForFieldName("pattern");
      if (p && id?.type === "identifier" && !p.childForFieldName("value")) {
        const args = n.parent;
        const ctor = args?.type === "arguments" && args.parent?.type === "new_expression" ? args.parent.childForFieldName("constructor") : null;
        const executor = ctor?.type === "identifier" && ctor.text === "Promise" && args?.namedChildren.find((c) => c.type !== "comment")?.startIndex === n.startIndex;
        proof = { decl: id, is: p.type !== "identifier" && jsFunctionType(p.childForFieldName("type")) ? "fn" : executor && at <= 1 ? "promise" : null };
      }
    }
    if (proof) {
      const is = proof.is !== null && !jsBindsElsewhere(n, name, proof.decl) ? proof.is : null;
      proofs.set(key, { is });
      return is;
    }
    proofs.set(key, null);
    if (n.type === "program") return null;
  }
  return null;
}

// Whether `root` binds or assigns `name` anywhere but at `keep`.
const JS_BINDS = new Set([
  "variable_declarator", "function_declaration", "generator_function_declaration", "class_declaration", "class", "function_expression", "function",
  "required_parameter", "optional_parameter", "formal_parameters", "arrow_function", "assignment_expression", "augmented_assignment_expression",
  "update_expression", "for_in_statement", "catch_clause", "import_specifier", "namespace_import", "import_clause", "array_pattern", "object_pattern",
  "pair_pattern", "rest_pattern", "assignment_pattern", "object_assignment_pattern", "import_require_clause", "import_alias",
]);
function jsBindsElsewhere(root: Node, name: string, keep: Node): boolean {
  for (const id of root.descendantsOfType(["identifier", "shorthand_property_identifier_pattern"])) {
    if (id.text !== name || id.startIndex === keep.startIndex) continue;
    if (id.type === "shorthand_property_identifier_pattern") return true;
    const up = id.parent;
    if (!up || !JS_BINDS.has(up.type)) continue;
    // A read inside one of these (`f = g`, `x += f`, `for (x of f)`) is no binding of f.
    const right = up.childForFieldName("right") ?? up.childForFieldName("value") ?? up.childForFieldName("body");
    if (right && right.startIndex === id.startIndex && right.endIndex === id.endIndex && up.type !== "pair_pattern") continue;
    return true;
  }
  return false;
}

// A type annotation that names a function type: `(x: T) => U`.
function jsFunctionType(t: Node | null): boolean {
  let x = t?.type === "type_annotation" ? t.firstNamedChild : t;
  while (x?.type === "parenthesized_type") x = x.firstNamedChild;
  return x?.type === "function_type";
}

function newType(value: Node | null): TypeRef | null {
  if (value?.type !== "new_expression") return null;
  const ctor = value.childForFieldName("constructor");
  return ctor ? jsTypeRef(ctor) : null;
}

// A method result keeps its receiver type. Deeper chains remain unknown.
function methodResultType(name: Node, on: TypeRef | null | undefined, result = 0): TypeRef | null {
  if (!on || on.elem) return null;
  let depth = 0;
  for (let t: TypeRef | undefined = on; t?.on; t = t.on) {
    if (++depth >= MAX_TYPE_DEPTH) return null;
  }
  return typeRef({ name: name.text, qualifier: null, ...pos(name), result, on });
}

// Calls carry the function name or the declared type of their receiver.
function callType(ctx: Ctx, value: Node | null, depth = 0): TypeRef | null {
  if (depth > MAX_TYPE_DEPTH) return null;
  let v = value;
  while (v?.type === "parenthesized_expression") v = v.firstNamedChild;
  if (v?.type === "await_expression") {
    const result = callType(ctx, v.firstNamedChild, depth);
    return result ? { ...result, awaited: true } : null;
  }
  if (v?.type !== "call_expression") return null;
  const fn = v.childForFieldName("function");
  if (fn?.type === "identifier") {
    // A function declared inside a function is its definition there; a
    // parameter or a local of that name calls a value, not a definition.
    const at = ctx.lookup(ctx.top, fn.text);
    const localDef = at && at.depth > 0 ? at.fns?.get(fn.text) : undefined;
    if (at && at.depth > 0 && localDef === undefined && !at.imports?.has(fn.text)) return null;
    return typeRef({ name: fn.text, qualifier: null, ...pos(fn), result: 0, ...(localDef !== undefined ? { localDef } : {}) });
  }
  if (fn?.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    const object = jsUnwrap(fn.childForFieldName("object"));
    if (!prop || !object) return null;
    if (object.type === "identifier") {
      const local = ctx.local(object.text);
      if (local !== undefined) return methodResultType(prop, local);
      return typeRef({ name: prop.text, qualifier: object.text, ...pos(fn), result: 0 });
    }
    if (object.type === "call_expression" || object.type === "await_expression") return methodResultType(prop, callType(ctx, object, depth + 1));
    if (object.type === "new_expression") return methodResultType(prop, newType(object));
    const cls = ctx.cls();
    if (!cls || ctx.defs[ctx.caller()]?.static || ctx.top.thisKnown === false) return null;
    if (object.type === "this" && cls.cls) {
      return ctx.defs[cls.def]?.topLevel ? methodResultType(prop, typeRef({ name: cls.cls, qualifier: null, ...pos(object) })) : null;
    }
    if (object.type === "member_expression" && object.childForFieldName("object")?.type === "this") {
      const field = object.childForFieldName("property");
      return field ? methodResultType(prop, ctx.defs[cls.def]?.fields[field.text]) : null;
    }
  }
  return null;
}

// One element of a value of type `t`: of a declared array or set, or of
// what a call returns (the resolver checks that result is declared as one).
function elementType(t: TypeRef | null | undefined): TypeRef | null {
  if (t?.elem) return { ...t, elem: false };
  return t && t.result !== undefined && !t.item ? { ...t, item: true } : null;
}

// The array's or set's own methods whose callback takes an element first.
const ELEMENT_CALLBACKS = new Set(["forEach", "map", "flatMap", "filter", "find", "findLast", "findIndex", "findLastIndex", "some", "every"]);

// A callback handed first to one of those methods (`items.map((s) => ...)`):
// the type of its first parameter, an element of the receiver.
function callbackElement(ctx: Ctx, fn: Node): TypeRef | null {
  const args = fn.parent;
  const call = args?.parent;
  if (args?.type !== "arguments" || call?.type !== "call_expression" || args.firstNamedChild?.startIndex !== fn.startIndex) return null;
  const callee = call.childForFieldName("function");
  const prop = callee?.type === "member_expression" ? callee.childForFieldName("property") : null;
  if (!prop || !ELEMENT_CALLBACKS.has(prop.text)) return null;
  const elem = elementType(collectionType(ctx, callee?.childForFieldName("object") ?? null));
  return elem ? { ...elem, declared: false } : null;
}

// A function passed as an argument of a call, with its position; null when
// a spread argument comes before it (its position is not known).
function callbackArg(fn: Node): { call: Node; arg: number } | null {
  const args = fn.parent;
  const call = args?.parent;
  if (args?.type !== "arguments" || call?.type !== "call_expression") return null;
  let arg = 0;
  for (const a of args.namedChildren) {
    if (a.startIndex === fn.startIndex) return { call, arg };
    if (a.type === "spread_element") return null;
    if (a.type !== "comment") arg++;
  }
  return null;
}

// The declared type of a collection a loop or a callback reads: a local, a
// field of `this`, the values of a Map (`m.values()`), or what a call returns.
function collectionType(ctx: Ctx, node: Node | null): TypeRef | null {
  let n = node;
  while (n?.type === "parenthesized_expression") n = n.firstNamedChild;
  if (!n) return null;
  if (n.type === "identifier") return ctx.local(n.text) ?? null;
  if (n.type === "member_expression" && n.childForFieldName("object")?.type === "this") {
    const cls = ctx.cls();
    const field = n.childForFieldName("property");
    if (!cls?.cls || !field || ctx.defs[ctx.caller()]?.static || ctx.top.thisKnown === false) return null;
    return ctx.defs[cls.def]?.fields[field.text] ?? null;
  }
  const fn = n.type === "call_expression" ? n.childForFieldName("function") : null;
  if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "values" && n.childForFieldName("arguments")?.namedChildCount === 0) {
    const map = collectionType(ctx, fn.childForFieldName("object"))?.values;
    if (map) return { ...map, elem: true };
  }
  return callType(ctx, n);
}

// Read fields before method bodies, including fields declared after their callers.
function jsFields(node: Node, params?: Map<string, TypeRef | null>): Record<string, TypeRef> {
  const fields: Record<string, TypeRef> = {};
  for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
    if (member.type === "public_field_definition" || member.type === "field_definition") {
      const name = member.childForFieldName("name") ?? member.childForFieldName("property");
      const type = jsMemberType(member.childForFieldName("type"), params) ?? newType(member.childForFieldName("value"));
      if (name && type) fields[name.text] = type;
    }
    if (member.type !== "method_definition" || member.childForFieldName("name")?.text !== "constructor") continue;
    for (const p of member.childForFieldName("parameters")?.namedChildren ?? []) {
      const isProperty = p.namedChildren.some((c) => c.type === "accessibility_modifier") || p.children.some((c) => c.type === "readonly");
      const pattern = p.childForFieldName("pattern");
      const type = jsTypeRef(p.childForFieldName("type"));
      if (isProperty && pattern?.type === "identifier" && type) fields[pattern.text] = type;
    }
  }
  return fields;
}

// The type of member `key` of a value of type `from`: read from an object
// type written in place, else `from` with the member added to its path. A
// collection or an unawaited promise has no such member of the repository.
function jsFieldOf(from: TypeRef, key: string): TypeRef | null {
  if (from.elem || from.promise) return null;
  if (from.name === "{}" && from.qualifier === null && from.result === undefined && !from.path) {
    const inner = from.fields?.[key];
    return inner ? { ...inner, ...(from.declared ? { declared: true } : {}) } : null;
  }
  if ((from.path?.length ?? 0) >= MAX_TYPE_DEPTH) return null;
  return { ...from, path: [...(from.path ?? []), key] };
}

// The names an object pattern binds with the type of their member of
// `from`: `{ a }`, `{ a: b }`, `{ a: { c } }`. A rest holds what is left and
// is not typed. A default (`{ a = x }`) is typed only when the pattern's
// declaration is annotated: the checker then types the name by the member
// (the default must fit it); unannotated, the default's own type joins in.
function jsPatternTypes(pattern: Node, from: TypeRef, annotated: boolean, out: [string, TypeRef][] = []): [string, TypeRef][] {
  for (const p of pattern.namedChildren) {
    const bare = p.type === "object_assignment_pattern" && annotated ? p.childForFieldName("left") : p;
    if (bare?.type === "shorthand_property_identifier_pattern") {
      const type = jsFieldOf(from, bare.text);
      if (type) out.push([bare.text, type]);
    } else if (p.type === "pair_pattern") {
      const key = p.childForFieldName("key");
      let value = p.childForFieldName("value");
      if (value?.type === "assignment_pattern" && annotated) value = value.childForFieldName("left");
      if (key?.type !== "property_identifier" || !value) continue;
      const type = jsFieldOf(from, key.text);
      if (!type) continue;
      if (value.type === "identifier") out.push([value.text, type]);
      else if (value.type === "object_pattern") jsPatternTypes(value, type, annotated, out);
    }
  }
  return out;
}

// The type of a value a pattern takes apart: a typed local, a member path
// of one, `this.field`, a constructor, a call's result or a cast.
function jsValueType(ctx: Ctx, value: Node | null): TypeRef | null {
  const v = jsUnwrap(value);
  if (!v) return null;
  if (v.type === "identifier") return ctx.local(v.text) ?? null;
  if (v.type === "new_expression") return newType(v);
  if (v.type === "call_expression" || v.type === "await_expression") return callType(ctx, v);
  if (v.type === "as_expression") return declared(jsTypeRef(v.namedChildren[1] ?? null));
  if (v.type !== "member_expression") return null;
  const recv = jsReceiver(ctx, v);
  delete (recv as Tagged)[IDENT];
  let type: TypeRef | null = null;
  let rest: string[] = [];
  if (recv.kind === "type") {
    type = recv.type;
    rest = recv.path;
  } else if (recv.kind === "self" && recv.path.length > 0) {
    // `this.field`, as a call on it reads it: in a method of a top-level class.
    const cls = ctx.cls();
    if (!cls || ctx.defs[ctx.caller()]?.static || !ctx.defs[cls.def]?.topLevel) return null;
    type = ctx.defs[cls.def]?.fields[recv.path[0] as string] ?? null;
    rest = recv.path.slice(1);
  }
  for (const key of rest) type = type ? jsFieldOf(type, key) : null;
  return type;
}

// ---------- escape paths (TypeScript, JavaScript) ----------

// A member read, not called, by name: on a value of a known kind, a value
// reference the resolver binds (a getter, a method taken); on any other,
// a read of the name on a value of unknown type. `*` is any member.
function jsMemberRead(ctx: Ctx, recv: Receiver | null, name: Node, text: string, role: ValueRef["role"], line: number): void {
  if (recv && recv.kind !== "other") {
    ctx.addValue({ name, recv }, role);
    return;
  }
  if (recv) delete (recv as Tagged)[IDENT];
  const kept = ctx.looseMembers.get(text);
  if (kept) kept.count++;
  else ctx.looseMembers.set(text, { why: text, line, count: 1 });
}
// A key a pattern takes apart reads that member of the value, as a dot
// does (`const { total } = c` as `c.total`): a getter runs there. A key
// that is not written out (`{ [k]: v }`, `key` null) reads any member.
function jsPatternRead(ctx: Ctx, pattern: Node, key: Node | null, line: number): void {
  const recv = jsPatternSource(ctx, pattern);
  if (recv === undefined) return;
  if (key) jsMemberRead(ctx, recv, key, key.text, "other", line);
  else ctx.keyReads.push({ recv: recv ?? { kind: "other" }, scope: ctx.top, line, stays: false });
}
// What an object pattern takes apart: the value it is given, the type a
// parameter or the declaration declares, or an element of what a
// `for...of` reads; null when that is not known (a nested pattern, a
// parameter with no type, a `catch`), undefined for a module a `require`
// or `import()` loads (read as an import) and the string keys of
// `for...in`.
function jsPatternSource(ctx: Ctx, pattern: Node): Receiver | null | undefined {
  const up = pattern.parent;
  const is = (field: string) => sameNode(up?.childForFieldName(field) ?? null, pattern);
  const typed = (t: TypeRef | null): Receiver | null => (t ? { kind: "type", type: t, path: [] } : null);
  if (up?.type === "variable_declarator" && is("name")) {
    const annotation = up.childForFieldName("type");
    if (annotation) return typed(declared(jsTypeRef(annotation)));
    const value = jsHeld(up.childForFieldName("value"));
    if (!value) return null;
    const call = value.type === "await_expression" ? jsHeld(value.firstNamedChild) : value;
    const fn = call?.type === "call_expression" ? call.childForFieldName("function") : null;
    if (fn?.type === "import" || (fn?.type === "identifier" && fn.text === "require")) return undefined;
    return jsReceiver(ctx, value);
  }
  if (up?.type === "assignment_expression" && is("left")) {
    const right = up.childForFieldName("right");
    return right ? jsReceiver(ctx, right) : null;
  }
  if ((up?.type === "required_parameter" || up?.type === "optional_parameter") && is("pattern")) return typed(declared(jsTypeRef(up.childForFieldName("type"))));
  if (up?.type === "for_in_statement" && is("left")) {
    if (!up.children.some((c) => c.type === "of")) return undefined;
    return typed(elementType(collectionType(ctx, up.childForFieldName("right"))));
  }
  return null;
}
// The key of `c["total"]` or `` c[`total`] ``: the node that holds its text.
function jsLiteralKey(index: Node | null): Node | null {
  if (index?.type !== "string" && index?.type !== "template_string") return null;
  const parts = index.namedChildren;
  if (parts.length === 1 && parts[0]?.type === "string_fragment") return parts[0];
  return null;
}
// A value indexed by a key that runs no getter of the repository: one
// declared as a primitive (`string`, `number`, `boolean`, `bigint`,
// `symbol`), by the names the types of the repository would have to take
// to change that (the global whose prototype it reads, and `Object`).
// Whether the repository declares one is known only once every file is
// read (resolve.ts). An object type is never plain: a class with an index
// signature and a getter fits `Record`, an `Array` or typed array subclass
// with a getter fits `T[]`.
const PLAIN_INDEXED = new Map<string, string[]>([
  ["string", ["String"]], ["number", ["Number"]], ["boolean", ["Boolean"]], ["bigint", ["BigInt"]], ["symbol", ["Symbol"]],
]);
// The names that would make a value's declared type not plain, or null for
// a type that is not plain whatever the repository declares.
function jsPlainNames(recv: Receiver): string[] | null {
  if (recv.kind !== "type" || recv.path.length > 0) return null;
  const names = recv.type.elem !== true && recv.type.qualifier === null ? PLAIN_INDEXED.get(recv.type.name) : undefined;
  return names ? [...names, "Object"] : null;
}
// Whether the value of a read is used where it is read and never passed
// on: called, operated on, tested, written or thrown away. A member read
// or a call through a member of it (`c[k].valueOf()`, `c[k]["bind"](c)`,
// `c[k][b](c)`) may give the same function back, so the value is followed
// through each and must stay at the end of them. A method taken by such a
// read can run only there.
function jsValueStays(node: Node): boolean {
  let at = node;
  let up = node.parent;
  let member = false;
  const is = (field: string) => sameNode(up?.childForFieldName(field) ?? null, at);
  for (;;) {
    while (up && JS_WRAPPERS.has(up.type)) {
      at = up;
      up = up.parent;
    }
    if (!up) return false;
    const read = (up.type === "member_expression" || up.type === "subscript_expression") && is("object");
    const called = up.type === "call_expression" && is("function");
    // `c[k]()` runs what it read there; `c[k].x`, `c[k].x()` hand on a value.
    if (called && !member) return true;
    if (!read && !called) break;
    member ||= read;
    at = up;
    up = up.parent;
  }
  switch (up.type) {
    case "expression_statement":
    case "unary_expression":
    case "update_expression":
    case "template_substitution":
      return true;
    // `a || c[k]` gives the value on.
    case "binary_expression":
      return !["&&", "||", "??"].includes(up.childForFieldName("operator")?.text ?? "");
    case "assignment_expression":
    case "augmented_assignment_expression":
      return is("left");
    case "ternary_expression":
      return is("condition");
    case "if_statement":
    case "while_statement":
    case "do_statement":
      return is("condition");
  }
  return false;
}

// Names of the global object: a computed member of one may be any global.
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const JS_LANGS: ReadonlySet<Lang> = new Set<Lang>(["typescript", "tsx", "javascript"]);

// Whether a method called on a local runs the value the local holds:
// JavaScript's `fn.call(x)` and `fn.apply(x)` (not `fn.bind(x)`, which
// only makes a function), Python's `fn.__call__()`. In Java any method but
// one every object has (`r.equals(o)`, `r.toString()`): a functional
// interface's own method runs it, and a default one (`f.andThen(g)`) makes
// a function that may.
const OBJECT_METHODS: ReadonlySet<string> = new Set(["equals", "hashCode", "toString", "getClass", "notify", "notifyAll", "wait"]);
function runsHeldValue(lang: Lang, method: string): boolean {
  if (JS_LANGS.has(lang)) return method === "call" || method === "apply";
  if (lang === "python") return method === "__call__";
  if (lang === "java") return !OBJECT_METHODS.has(method);
  return true;
}
// Free names (bound to nothing in the file) whose every use is known to
// reach no code by a name built at run time: no global object, no way to
// make code from a string, no loader. `require`, `module` and `exports`
// have rules of their own. Any other free name makes the file opaque.
const HARMLESS_GLOBALS = new Set([
  "console", "JSON", "Math", "Number", "String", "Boolean", "Array", "Object", "Promise", "Symbol", "BigInt", "Date", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError",
  "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "Intl",
  "NaN", "Infinity", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "structuredClone", "clearTimeout", "clearInterval", "clearImmediate", "__dirname", "__filename",
  "require", "module", "exports",
]);
// The members of `process` that read or set plain data, or take a listener
// (a function the file names as a value, so it is a use of its own).
const HARMLESS_PROCESS = new Set([
  "env", "argv", "argv0", "execArgv", "execPath", "exit", "exitCode", "cwd", "chdir", "platform", "arch", "pid", "ppid", "title", "version", "versions", "release",
  "stdout", "stderr", "stdin", "on", "once", "off", "removeListener", "hrtime", "nextTick", "memoryUsage", "uptime", "kill", "emitWarning", "umask", "getuid", "getgid", "config",
  "cpuUsage",
]);
// Members of other globals that read a clock or wait, and take no function:
// a read of one reaches no code. A file that sets one to a function of its
// own (`performance.now = tick`) uses that function as a value, which keeps
// its own floor. Any other member, a computed one, or the name passed on
// stays opaque (`performance.timerify(f)`, `Atomics.waitAsync`).
const HARMLESS_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["performance", new Set(["now"])],
  ["Atomics", new Set(["wait"])],
]);
function jsHarmlessGlobal(name: string, role: ValueRef["role"], prop: string | null): boolean {
  if (name === "process") return role === "object" && prop !== null && HARMLESS_PROCESS.has(prop);
  const members = HARMLESS_MEMBERS.get(name);
  if (members) return role === "object" && prop !== null && members.has(prop);
  return HARMLESS_GLOBALS.has(name);
}
const THIS_OUTSIDE = "uses `this` outside a class";
// The timers that run a string given to them as code in a browser.
// `queueMicrotask` takes only a function, so it is none of them.
const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const JS_FN_LITERALS = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const JS_FN_NODES = new Set([...JS_FN_LITERALS, "function_declaration", "generator_function_declaration", "method_definition"]);
// The plain-data types a global name declared ambient may have.
const PLAIN_TYPES = new Set(["string", "number", "boolean"]);
// The members of `import.meta` that hold plain data. The module's own
// place (`url`, `dirname`, `filename`) is a string the runtime sets: a read
// of it reaches no code, so it leaves the file readable.
const META_PLAIN = new Set(["url", "dirname", "filename", "resolve", "env", "main"]);
const META_PLACE = new Set(["url", "dirname", "filename"]);
// Names of the global object, and the members of one that lead to it again,
// to code made from a string, or to a loader.
const GLOBAL_NAMES = new Set([...GLOBAL_OBJECTS, "top", "parent", "frames"]);
const GLOBAL_CHAIN = new Set([
  ...GLOBAL_NAMES, "document", "opener", "frameElement", "eval", "Function", "constructor", "__proto__", "Reflect",
  "setTimeout", "setInterval", "setImmediate", "execScript", "importScripts", "process", "require", "module",
]);
// The members of `process` that load code or open native bindings.
const PROCESS_LOADERS = new Set(["mainModule", "binding", "_linkedBinding", "dlopen", "constructor"]);
// How far a free name the reader does not know may reach. A name of the
// global scope reaches the global scope: a script's definitions. The global
// object indexed, passed on or followed to a member that leads to code, and
// a name that makes code (`eval`, `Function`, `document`), may load any module.
function jsFreeReach(name: string, role: ValueRef["role"], prop: string | null): "any" | "global" {
  if (name === "eval" || name === "Function" || name === "document" || TIMERS.has(name)) return "any";
  if (name === "process") return role === "object" && prop !== null && !PROCESS_LOADERS.has(prop) ? "global" : "any";
  if (GLOBAL_NAMES.has(name)) return role === "object" && prop !== null && !GLOBAL_CHAIN.has(prop) ? "global" : "any";
  return "global";
}
// The objects whose `require` member is a loader: a module, and the ones
// `require.main` and `process.mainModule` give. Any other way to one reads
// `module`, `require` or `process.mainModule` first, which is a load itself.
const LOADER_OWNERS = new Set(["module", "require.main", "process.mainModule", "module.parent"]);
const loaderOwner = (object: Node | null): boolean => object !== null && LOADER_OWNERS.has(object.text.replace(/\s+/g, ""));
// Wrappers that keep the value of what they hold.
const JS_WRAPPERS = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "type_assertion"]);
// Nodes whose `name` field declares a name, never reads one.
const JS_NAMED = new Set([
  "variable_declarator", "function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function",
  "class_declaration", "abstract_class_declaration", "class", "method_definition", "enum_declaration", "internal_module", "module",
  "function_signature", "interface_declaration", "type_alias_declaration", "import_alias", "method_signature", "abstract_method_signature",
  "public_field_definition", "field_definition", "property_signature",
]);
// Nodes whose identifiers are never reads: patterns, clauses, type positions.
const JS_NOT_READ = new Set([
  "formal_parameters", "array_pattern", "rest_pattern", "object_pattern", "export_specifier", "namespace_export", "import_specifier",
  "import_clause", "namespace_import", "import_require_clause", "meta_property", "nested_identifier", "type_query", "type_predicate",
  "asserts", "jsx_namespace_name", "jsx_closing_element", "export_statement", "nested_type_identifier",
]);

const sameNode = (a: Node | null | undefined, b: Node): boolean => !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

// A name or member path in a place that writes, declares or calls it, not
// one that reads its value, from its parent's type and the field it holds
// it in. `export default name` is read by the export table.
function jsNotRead(parent: string | null, field: () => string | null): boolean {
  if (parent === null) return true;
  switch (parent) {
    case "call_expression":
      return field() === "function";
    case "new_expression":
      return field() === "constructor";
    // `x.total += 1` reads `total` before it writes it: no case here.
    case "assignment_expression":
    case "for_in_statement":
    case "assignment_pattern":
    case "object_assignment_pattern":
      return field() === "left";
    case "required_parameter":
    case "optional_parameter":
      return field() === "pattern";
    case "pair_pattern":
      return field() === "value";
    case "arrow_function":
    case "catch_clause":
      return field() === "parameter";
    case "jsx_opening_element":
    case "jsx_self_closing_element":
      return field() === "name";
  }
  if (JS_NOT_READ.has(parent)) return true;
  return JS_NAMED.has(parent) && field() === "name";
}

// What a read's value is used for, through the wrappers that keep it:
// the object before a dot, the object of a computed member, or anything else.
function jsReadRole(n: Node, parent: string | null, field: () => string | null): { role: "object" | "index" | "other"; prop: string | null } {
  // The common places, read without making the parent.
  if (parent === "subscript_expression") return field() === "object" ? { role: "index", prop: null } : { role: "other", prop: null };
  if (parent !== null && !JS_WRAPPERS.has(parent) && parent !== "member_expression") return { role: "other", prop: null };
  if (parent === "member_expression" && field() !== "object") return { role: "other", prop: null };
  let at = n;
  let p = n.parent;
  while (p && JS_WRAPPERS.has(p.type) && (p.type === "type_assertion" ? sameNode(p.lastNamedChild, at) : sameNode(p.firstNamedChild, at))) {
    at = p;
    p = p.parent;
  }
  if (p?.type === "member_expression" && sameNode(p.childForFieldName("object"), at)) {
    const prop = p.childForFieldName("property");
    return { role: "object", prop: prop?.type === "property_identifier" ? prop.text : null };
  }
  if (p?.type === "subscript_expression" && sameNode(p.childForFieldName("object"), at)) return { role: "index", prop: null };
  return { role: "other", prop: null };
}

// `this` where the graph has not proved it the instance of a class: a
// function that is no arrow and no method, or the top of a file.
function jsLooseThis(ctx: Ctx): boolean {
  return ctx.top.thisKnown === false || !ctx.cls();
}

// The escapes a read of a name may open: `require` or `createRequire` used
// other than as a direct call (`const load = require`), `eval` read and
// called elsewhere, the global object passed on or indexed, a CommonJS
// module's own `exports` or `module` read as a value.
function jsNameEscapes(ctx: Ctx, name: string, role: ValueRef["role"], prop: string | null, line: number): void {
  switch (name) {
    // A parameter, a local or a destructured name `require` holds what was
    // given to it: where the real one is passed, that read is the load.
    case "require":
      if (role !== "object" || prop !== "resolve") ctx.addEscape({ kind: "load", line }, name);
      return;
    case "createRequire":
      ctx.addEscape({ kind: "load", line });
      return;
    case "eval":
      ctx.addEscape({ kind: "eval", line }, name);
      ctx.addEscape({ kind: "global", line }, name);
      return;
    case "exports":
      if (role !== "object") ctx.addEscape({ kind: "own", line }, name);
      return;
    case "module":
      if (role !== "object") ctx.addEscape({ kind: "own", line }, name);
      if (role !== "object" || prop === "parent" || prop === "children" || prop === "constructor") ctx.addEscape({ kind: "load", line }, name);
      return;
  }
  if (GLOBAL_OBJECTS.has(name) && (role !== "object" || prop === "eval")) ctx.addEscape({ kind: "global", line }, name);
}

function jsResults(fn: Node): TypeRef[] | undefined {
  const r = jsTypeRef(fn.childForFieldName("return_type"));
  return r ? [r] : undefined;
}

function extractJs(tree: Tree, lang: Lang, readers: readonly TreeVisitor[]): FileFacts {
  const ctx = new Ctx(lang);
  ctx.source = () => tree.rootNode.text;
  const fnFrame = (node: Node, def: number): Leave => {
    const locals = new Map<string, TypeRef | null>();
    const typeParams = jsTypeParams(node);
    enteringTypeParams = typeParams;
    jsSignature(ctx, node, def, locals);
    for (const t of jsTypeParamNames(node)) ctx.addTypeUse(t, def >= 0 ? def : ctx.caller());
    enteringTypeParams = null;
    const untyped = jsUntypedParams(node);
    const first = untyped[0];
    if (first && locals.get(first) === null) {
      const elem = callbackElement(ctx, node);
      if (elem) locals.set(first, elem);
    }
    // A callback passed to a call: each untyped parameter as the called
    // function declares it, read once the call is bound.
    const at = callbackArg(node);
    const called = at ? callType(ctx, at.call) : null;
    if (at && called?.result !== undefined && !called.callback) {
      untyped.forEach((name, param) => {
        if (name && locals.get(name) === null) locals.set(name, { ...called, callback: { arg: at.arg, param } });
      });
    }
    // Only an arrow keeps the `this` around it; a method's own is its class's,
    // and so is that of a function a class field holds.
    const ownThis = (def >= 0 && ctx.defs[def]?.kind === "method") || node.parent?.type === "public_field_definition" || node.parent?.type === "field_definition";
    // A method of a class body, a class expression's too: `this` is the
    // instance (or the class, for a static one). In an object literal, or in
    // a function a field holds, it is whatever the caller binds.
    const inClassBody = node.type === "method_definition" && node.parent?.type === "class_body";
    const leave = ctx.push({ def, cls: null, locals, ...(typeParams ? { typeParams } : {}), ...(node.type === "arrow_function" ? {} : { thisKnown: ownThis, thisClass: inClassBody }) });
    // A named function expression (`const f = function inner() {}`): its own
    // name, inside its body, is the definition it makes.
    const own = def >= 0 && (node.type === "function_expression" || node.type === "function" || node.type === "generator_function") ? node.childForFieldName("name") : null;
    if (own?.type === "identifier") (ctx.top.fns ??= new Map()).set(own.text, def);
    if (def >= 0 && !(ctx.defs[def] as DefFact).results) {
      const generator = node.type.startsWith("generator") || node.children.some((c) => c.type === "*");
      returned.set(def, { types: [], bad: generator, async: node.children.some((c) => c.type === "async") });
    }
    // An arrow whose body is an expression returns it.
    const body = node.type === "arrow_function" ? node.childForFieldName("body") : null;
    if (body && body.type !== "statement_block") jsReturned(body);
    return leave;
  };
  // What each function without a declared result returns, read return by
  // return: the type of each, the locals it rests on, and whether one could
  // not be read (then the result is not known).
  type Returned = { t: TypeRef; literal: boolean; deps: { at: Scope; name: string }[] };
  const returned = new Map<number, { types: Returned[]; bad: boolean; async: boolean }>();
  // The local a value or a call chain starts from, when its type is not declared.
  const restsOn = (node: Node | null, deps: Returned["deps"]): void => {
    let n = jsUnwrap(node);
    while (n && (n.type === "call_expression" || n.type === "await_expression" || n.type === "member_expression")) {
      n = jsUnwrap(n.type === "call_expression" ? n.childForFieldName("function") : n.type === "await_expression" ? n.firstNamedChild : n.childForFieldName("object"));
    }
    if (n?.type !== "identifier") return;
    const at = ctx.lookup(ctx.top, n.text);
    if (at && ctx.local(n.text) !== undefined && !ctx.local(n.text)?.declared) deps.push({ at, name: n.text });
  };
  // The type of a returned value, or null when it cannot be proved.
  const returnType = (node: Node, owner: DefFact, deps: Returned["deps"]): TypeRef | null => {
    if (node.type === "new_expression") return newType(node);
    if (node.type === "as_expression") return declared(jsTypeRef(node.namedChildren[1] ?? null));
    if (node.type === "identifier") {
      const t = ctx.local(node.text);
      if (t) restsOn(node, deps);
      return t ?? null;
    }
    if (node.type === "call_expression" || node.type === "await_expression") {
      const t = callType(ctx, node);
      // A function that returns its own call: what it returns is never read.
      if (!t || (t.result !== undefined && !t.on && t.qualifier === null && t.name === owner.name)) return null;
      restsOn(node, deps);
      return t;
    }
    return null;
  };
  // An object literal returned: each member whose value's type is proved and
  // that no spread after it may replace.
  const literalType = (node: Node, owner: DefFact, deps: Returned["deps"]): TypeRef | null => {
    const fields: Record<string, TypeRef> = {};
    for (const c of node.namedChildren) {
      // A spread may bring any member, over the ones written before it.
      if (c.type === "spread_element") {
        for (const k of Object.keys(fields)) delete fields[k];
        continue;
      }
      const key = c.type === "shorthand_property_identifier" ? c : c.type === "pair" ? c.childForFieldName("key") : null;
      const value = c.type === "pair" ? jsUnwrap(c.childForFieldName("value")) : c.type === "shorthand_property_identifier" ? c : null;
      if (!key || !value || (key.type !== "property_identifier" && key.type !== "shorthand_property_identifier")) continue;
      const t = value.type === "shorthand_property_identifier" ? (ctx.local(value.text) ?? null) : returnType(value, owner, deps);
      if (value.type === "shorthand_property_identifier" && t) {
        const at = ctx.lookup(ctx.top, value.text);
        if (at && !t.declared) deps.push({ at, name: value.text });
      }
      if (t) fields[key.text] = t;
    }
    return Object.keys(fields).length > 0 ? typeRef({ name: "{}", qualifier: null, ...pos(node), fields }) : null;
  };
  const inferReturn = (value: Node | null, owner: number) => {
    const info = returned.get(owner);
    if (!info || info.bad) return;
    const def = ctx.defs[owner] as DefFact;
    // A return in a finally block replaces whatever the try returned.
    for (let n = value?.parent ?? null; n && !isFnNode(n) && !FN_DECLS.has(n.type); n = n.parent) {
      if (n.type === "finally_clause") info.bad = true;
    }
    const v = jsUnwrap(value);
    const sides = v?.type === "ternary_expression" ? [v.childForFieldName("consequence"), v.childForFieldName("alternative")].map(jsUnwrap) : [v];
    for (const side of sides) {
      // `return;`, `return null`: no value, as when the body runs out.
      if (!side || side.type === "null" || side.type === "undefined" || (side.type === "identifier" && side.text === "undefined")) continue;
      const deps: Returned["deps"] = [];
      const literal = side.type === "object";
      const t = literal ? literalType(side, def, deps) : returnType(side, def, deps);
      if (!t) info.bad = true;
      else info.types.push({ t, literal, deps });
    }
  };
  // Each function's result, once every scope is read: the one type every
  // return agrees on, none of the locals it rests on given another value.
  const settleReturns = () => {
    for (const [owner, info] of returned) {
      const def = ctx.defs[owner] as DefFact;
      const first = info.types[0];
      if (info.bad || !first || def.results) continue;
      if (info.types.some((r) => r.deps.some((d) => d.at.reassigned?.has(d.name)))) continue;
      if (info.types.length > 1 && (info.types.some((r) => r.literal) || !info.types.every((r) => sameType(r.t, first.t) && sameRead(r.t, first.t)))) continue;
      const t = info.async && !first.t.promise ? { ...first.t, promise: true } : first.t;
      def.results = [{ ...t, inferred: true }];
    }
  };
  // What a return hands back: a name or a member path, either side of a
  // ternary. Each is a value reference; on a named function, a returned one.
  const jsReturned = (value: Node | null) => {
    const owner = ctx.top.fnDecl.def;
    if (owner >= 0) inferReturn(value, owner);
    const sides = value?.type === "ternary_expression" ? [value.childForFieldName("consequence"), value.childForFieldName("alternative")] : [value];
    for (const side of sides) {
      const v = jsValueNode(ctx, side);
      if (!v) {
        if (side && owner >= 0) (ctx.defs[owner] as DefFact).returnsOther = true;
        continue;
      }
      const ref = ctx.addValue(v, "return");
      if (owner >= 0) ((ctx.defs[owner] as DefFact).returns ??= []).push(ref);
    }
  };
  // A computed call on a name may call any entry of the literal table the
  // name is bound to, decided once every scope is known.
  const subscriptCall = (fn: Node) => {
    ctx.addDynamicCall(fn);
    const object = fn.childForFieldName("object");
    if (object?.type === "identifier") ctx.tableCall(ctx.calls.length - 1, object.text);
  };
  // The reads a name or a member path may be: none where its place declares, writes or calls it.
  const reads = (type: string, field: () => string | null, upType: (k: number) => string | null): boolean =>
    (type !== "identifier" && type !== "shorthand_property_identifier" && type !== "member_expression") || !jsNotRead(upType(1), field);
  walkTree(tree.rootNode, readers, { interesting: JS_TYPES, wants: reads, visit: (node, field, upType) => {
    switch (node.type) {
      case "import_statement":
        ctx.esm = true;
        jsImport(ctx, node);
        return false;
      case "export_statement":
        // An `export` inside a `namespace` or `declare module` block leaves a
        // script a script: only one at the top of the file makes a module.
        if (upType(1) === "program") ctx.esm = true;
        if (node.children.some((c) => c.type === "=")) {
          ctx.addOpaque("uses `export =` that the reader does not read", node.startPosition.row + 1);
          // `export = require`: the file's require goes wherever an importer takes it.
          if (node.namedChildren.some((c) => c.type === "identifier" && c.text === "require")) ctx.addEscape({ kind: "load", line: node.startPosition.row + 1 }, "require");
        }
        jsExport(ctx, node);
        return;
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name");
        if (!name) return fnFrame(node, -1);
        const top = ctx.atModuleLevel();
        const owner = top ? null : ctx.ownerName();
        const def = ctx.addDef(node, name, "function", { owner, topLevel: top, exported: isExportedDecl(node) && !isDefaultExport(node), results: jsResults(node) });
        if (!top) ctx.declareFn(name.text, def);
        return fnFrame(node, def);
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name");
        if (!name) return;
        const bases: TypeRef[] = [];
        const implemented: TypeRef[] = [];
        const dynamicBases: { line: number; column: number }[] = [];
        const typeParams = jsTypeParams(node);
        enteringTypeParams = typeParams;
        const argUses: TypeRef[] = jsTypeParamNames(node);
        const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
        for (const h of heritage?.namedChildren ?? []) {
          if (h.type === "implements_clause") {
            for (const t of h.namedChildren) {
              const ref = jsTypeRef(t);
              if (ref) implemented.push({ ...ref, rel: "implements" });
              argUses.push(...jsBaseArgNames(t));
            }
            continue;
          }
          argUses.push(...jsBaseArgNames(h));
          // TypeScript wraps the base in extends_clause; JavaScript does not.
          const value = h.type === "extends_clause" ? h.childForFieldName("value") : h;
          const ref = value ? jsTypeRef(value) : null;
          if (ref) bases.push(ref);
          // A base written as an expression (`extends mixin(Base)`): what it extends is not known.
          else if (value && value.type !== "comment") dynamicBases.push(pos(value));
        }
        enteringTypeParams = null;
        // The superclass first: a member is looked up there before an interface.
        bases.push(...implemented);
        const topLevel = ctx.atModuleLevel();
        // A class declared inside a function is a name of that scope, as a
        // `const` would be: a read of it is no free name.
        if (!topLevel && name.type !== "computed_property_name") ctx.setLocal(name.text, null, true);
        const def = ctx.addDef(node, name, "class", { topLevel, exported: isExportedDecl(node) && !isDefaultExport(node), bases, ...(dynamicBases.length > 0 ? { dynamicBases } : {}) });
        for (const t of argUses) ctx.addTypeUse(t, def);
        const leave = ctx.push({ def, cls: name.text, locals: null, ...(typeParams ? { typeParams } : {}) });
        (ctx.defs[def] as DefFact).fields = jsFields(node, typeParams ?? undefined);
        return leave;
      }
      case "method_definition": {
        const name = node.childForFieldName("name");
        const cls = ctx.cls();
        // A method of an object literal made a module: called on the module itself.
        if (name && name.type === "property_identifier" && node.parent?.type === "object" && ctx.top.objectAt === node.parent.startIndex && cls) {
          const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, results: jsResults(node), static: true });
          return fnFrame(node, def);
        }
        if (!name || name.type === "computed_property_name" || node.parent?.type !== "class_body" || !cls) {
          return fnFrame(node, -1);
        }
        const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, results: jsResults(node), static: isStatic(node) });
        if (name.text === "constructor") {
          // Parameter properties: constructor(private repo: Repo) declares a field.
          const fields = (ctx.defs[cls.def] as DefFact).fields;
          for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
            const isProperty = p.namedChildren.some((c) => c.type === "accessibility_modifier") || p.children.some((c) => c.type === "readonly");
            const pattern = p.childForFieldName("pattern");
            const type = jsTypeRef(p.childForFieldName("type"));
            if (isProperty && pattern?.type === "identifier" && type) fields[pattern.text] = type;
          }
        }
        return fnFrame(node, def);
      }
      case "public_field_definition":
      case "field_definition": {
        const name = node.childForFieldName("name") ?? node.childForFieldName("property");
        const cls = ctx.cls();
        if (!name || !cls) return;
        const value = node.childForFieldName("value");
        const annotation = node.childForFieldName("type");
        const type = jsMemberType(annotation, cls.typeParams) ?? newType(value);
        if (type) (ctx.defs[cls.def] as DefFact).fields[name.text] = type;
        for (const t of jsTypeNames(annotation)) ctx.addTypeUse(t, cls.def);
        const v = jsValueNode(ctx, value);
        if (v) ctx.addValue(v, "assign");
        if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
          const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, static: isStatic(node) });
          return ctx.push({ def, cls: null, locals: null });
        }
        // A field typed by a function type, written in place or named
        // (`#resolve: ResolveToken`), as an interface property is: a member a
        // call names, returning what that type returns.
        const fnType = annotation?.type === "type_annotation" ? annotation.firstNamedChild : annotation;
        if (fnType?.type === "function_type") {
          const result = jsTypeRef(fnType.childForFieldName("return_type"));
          const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, static: isStatic(node), ...(result ? { results: [result] } : {}) });
          jsSignature(ctx, fnType, def, null);
        } else if (type && type.kind !== "param" && !type.elem && !type.promise && !type.parts && type.name !== "{}" && type.name !== "?" && (fnType?.type === "type_identifier" || fnType?.type === "nested_type_identifier" || fnType?.type === "generic_type")) {
          ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, static: isStatic(node), signature: type });
        }
        // Any other initializer runs on the instance, unless the field is static.
        const outer = ctx.instanceInit;
        ctx.instanceInit = isStatic(node) ? -1 : cls.def;
        return () => {
          ctx.instanceInit = outer;
        };
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (!name) return;
        if (name.type === "identifier" ? name.text === "require" : patternNames(name).includes("require")) jsMarkRequireBinders(ctx, value, name.type === "identifier" && !isExportedDecl(node));
        // `let` and `const` belong to their block, `var` to its function.
        const block = node.parent?.type !== "variable_declaration";
        // A module-level variable: a value an import of it binds.
        if (ctx.caller() < 0 && (node.parent?.parent?.type === "program" || node.parent?.parent?.type === "export_statement")) {
          const exported = isExportedDecl(node);
          for (const n of name.type === "identifier" ? [name.text] : patternNames(name)) {
            ctx.variables.add(n);
            if (exported) ctx.exportedVariables.add(n);
          }
        }
        // The walk goes on into the declarator either way: a default value
        // such as `{ a = fallback() }` holds calls of its own.
        if (value && jsRequire(ctx, node, name, value, block)) return;
        if (name.type !== "identifier") {
          // `const { a } = x`, `const [b] = y`: each name is a local of its
          // scope and hides a definition of the same name outside it.
          for (const n of patternNames(name)) ctx.setLocal(n, null, block);
          // `const { session } = params`: each name has the type of its member.
          const annotation = name.type === "object_pattern" ? declared(jsTypeRef(node.childForFieldName("type"))) : null;
          const from = name.type === "object_pattern" ? (annotation ?? jsValueType(ctx, value)) : null;
          // Unannotated, the names hold a member's type but are not declared: one assigned again loses its type.
          if (from) for (const [n, type] of jsPatternTypes(name, from, annotation !== null)) ctx.setLocal(n, annotation ? type : { ...type, declared: false, member: true }, block);
          return;
        }
        const isFn = value && ["arrow_function", "function_expression", "function", "generator_function"].includes(value.type);
        const parent = node.parent;
        const moduleLevel = (parent?.parent?.type === "program" || parent?.parent?.type === "export_statement") && ctx.atModuleLevel();
        const isConst = parent?.type === "lexical_declaration" && parent.childForFieldName("kind")?.type === "const";
        const annotation = node.childForFieldName("type");
        for (const t of jsTypeNames(annotation)) ctx.addTypeUse(t, ctx.caller());
        if (value?.type === "object") {
          // A table: the names of its entries, read when the literal is.
          if (isConst) ctx.pendingTables.set(value.startIndex, { name: name.text, line: node.startPosition.row + 1, scope: block ? ctx.top.decl : ctx.top.fnDecl, open: isExportedDecl(node) });
          // A module-level literal with a function in it is a module whose
          // functions are its methods (`api.run()`).
          const hasFn = value.namedChildren.some((c) => c.type === "method_definition" || (c.type === "pair" && isFnNode(c.childForFieldName("value"))));
          if (moduleLevel && isConst && hasFn) {
            const typed = jsTypeRef(annotation);
            const def = ctx.addDef(node, name, "module", { topLevel: true, exported: isExportedDecl(node), bases: typed ? [{ ...typed, rel: "implements" }] : [] });
            return ctx.push({ def, cls: name.text, locals: null, objectAt: value.startIndex });
          }
        }
        if (isConst && !isFn) {
          const v = jsValueNode(ctx, value);
          const awaited = value?.type === "await_expression" ? value.firstNamedChild : value;
          if (v) ctx.noteAssign(name.text, { ref: ctx.addValue(v, "assign") }, true, block);
          else if (awaited?.type === "call_expression") ctx.noteAssign(name.text, { callNode: awaited.endIndex }, true, block);
        } else if (!isFn) {
          const v = jsValueNode(ctx, value);
          if (v) ctx.addValue(v, "assign");
        }
        // The function's own frame takes the definition (fnAt), so its
        // parameters and what it returns by name are the definition's.
        if (isFn && moduleLevel) {
          const def = ctx.addDef(node, name, "function", { topLevel: true, exported: isExportedDecl(node), results: jsResults(value as Node) });
          return ctx.push({ def, cls: null, locals: null, fnAt: (value as Node).startIndex });
        }
        if (isFn && (ctx.caller() >= 0 || isConst)) {
          // const inner = () => ... inside a function: a definition of that
          // scope; a const one also inside an anonymous callback (a test
          // body) or a block at the top of the module.
          const def = ctx.addDef(node, name, "function", { owner: ctx.ownerName(), results: jsResults(value as Node) });
          ctx.declareFn(name.text, def, block);
          return ctx.push({ def, cls: null, locals: null, fnAt: (value as Node).startIndex });
        }
        // `const repo = this.deps.repo`: the local has the member's type, as
        // `const { repo } = this.deps` gives it: a member's type (any class
        // below it), never declared, so a local assigned again loses it.
        const member = jsUnwrap(value)?.type === "member_expression" ? jsValueType(ctx, value) : null;
        ctx.setLocal(name.text, declared(jsTypeRef(node.childForFieldName("type"))) ?? newType(value) ?? callType(ctx, value) ?? (member ? { ...member, declared: false, member: true } : null), block);
        return;
      }
      case "statement_block":
      case "switch_body":
      case "for_statement":
        return ctx.push({ def: -1, cls: null, locals: new Map(), block: true });
      case "catch_clause": {
        const leave = ctx.push({ def: -1, cls: null, locals: new Map(), block: true });
        for (const n of patternNames(node.childForFieldName("parameter"))) ctx.setLocal(n, null, true);
        return leave;
      }
      case "interface_declaration": {
        const name = node.childForFieldName("name");
        if (!name) return false;
        const typeParams = jsTypeParams(node);
        enteringTypeParams = typeParams;
        const bases: TypeRef[] = [];
        const argUses: TypeRef[] = jsTypeParamNames(node);
        const ext = node.namedChildren.find((c) => c.type === "extends_type_clause");
        for (const t of ext?.namedChildren ?? []) {
          const ref = jsTypeRef(t);
          if (ref) bases.push(ref);
          argUses.push(...jsBaseArgNames(t));
        }
        enteringTypeParams = null;
        // `declare module "x" { interface T { ... } }` and `declare global`: members added to a type of a package or of the runtime.
        const block = (node.parent?.type === "export_statement" ? node.parent : node).parent;
        const holder = block?.type === "statement_block" ? block.parent : null;
        const augments = holder?.type === "ambient_declaration" || (holder?.type === "module" && holder.childForFieldName("name")?.type === "string" && holder.parent?.type === "ambient_declaration");
        const def = ctx.addDef(node, name, "type", { topLevel: ctx.atModuleLevel(), exported: isExportedDecl(node), bases, iface: true, ...(augments ? { augments: true } : {}) });
        for (const t of argUses) ctx.addTypeUse(t, def);
        return ctx.push({ def, cls: name.text, locals: null, ...(typeParams ? { typeParams } : {}) });
      }
      case "method_signature":
      case "abstract_method_signature":
      case "property_signature": {
        // A member declared without a body: of an interface, or `abstract`
        // in a class. A property is one when its type is a function.
        const cls = ctx.cls();
        const where = node.parent?.type;
        if (!cls || !(where === "interface_body" || (where === "class_body" && node.type === "abstract_method_signature"))) return false;
        const name = node.childForFieldName("name");
        if (!name || name.type !== "property_identifier") return false;
        const fnType = node.type === "property_signature" ? node.childForFieldName("type")?.firstNamedChild : node;
        const optional = where === "interface_body" && node.children.some((c) => c.type === "?") ? { optional: true } : {};
        // An interface property whose type is not a function is a field, as a class's is.
        if (node.type === "property_signature" && where === "interface_body" && fnType?.type !== "function_type") {
          for (const t of jsTypeNames(node.childForFieldName("type"))) ctx.addTypeUse(t, cls.def);
          const type = jsMemberType(node.childForFieldName("type"), cls.typeParams);
          if (type) (ctx.defs[cls.def] as DefFact).fields[name.text] = type;
          // Typed by a name, it may be a function type declared elsewhere
          // (`resolve: ResolveFn`): a member a call can name, as a property
          // spelled with a function type is. A call can name it only then.
          if (type && type.kind !== "param" && !type.elem && !type.promise && !type.parts && type.name !== "{}" && type.name !== "?" && (fnType?.type === "type_identifier" || fnType?.type === "nested_type_identifier" || fnType?.type === "generic_type")) {
            ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, abstract: true, signature: type, ...optional });
          }
          return false;
        }
        if (!fnType || (node.type === "property_signature" && fnType.type !== "function_type")) return false;
        const ret = fnType.childForFieldName("return_type");
        const result = node.type === "property_signature" ? jsTypeRef(ret) : jsTypeRef(ret);
        const def = ctx.addDef(node, name, "method", { owner: cls.cls, exported: true, abstract: true, ...(result ? { results: [result] } : {}), ...optional });
        jsSignature(ctx, fnType, def, null);
        return false;
      }
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name");
        // A type alias keeps what it stands for, so `type Loose = any` is known as any.
        // An alias of an object type also holds its members as fields, as an
        // interface does; a call on the alias itself stays untyped.
        const typeParams = node.type === "type_alias_declaration" ? jsTypeParams(node) : null;
        enteringTypeParams = typeParams;
        const value = node.type === "type_alias_declaration" ? node.childForFieldName("value") : null;
        let alias = value ? jsTypeRef(value) : null;
        // `type Box<T> = { value: T }`: a member typed by the alias's own
        // parameter is marked, to take the argument a use of the alias gives.
        const own = value?.type === "object_type" && typeParams && alias?.fields ? jsObjectTypeFields(value, typeParams) : null;
        if (alias && own) alias = { ...alias, fields: own };
        // A function type (`type ResolveFn = (t: string) => Store`): what a call of a value of it returns,
        // null when the result cannot be read; a function type either way.
        const result = value?.type === "function_type" ? declared(jsTypeRef(value.childForFieldName("return_type"))) : undefined;
        // Every type the alias names, in a union, an intersection or an
        // object type of members, is a use of that type by the alias.
        const uses = [...jsTypeParamNames(node), ...jsTypeNames(value)];
        enteringTypeParams = null;
        if (name) {
          const def = ctx.addDef(node, name, "type", { topLevel: ctx.atModuleLevel(), exported: isExportedDecl(node), ...(alias ? { alias } : {}), ...(alias?.fields ? { fields: { ...alias.fields } } : {}), ...(result !== undefined ? { results: [result] } : {}) });
          for (const t of uses) ctx.addTypeUse(t, def);
        }
        return false;
      }
      case "arrow_function":
      case "function_expression":
      case "function":
      case "generator_function": {
        // The value of `const apply = (cb) => ...`: the frame of apply itself.
        if (ctx.top.fnAt === node.startIndex) return fnFrame(node, ctx.top.def);
        // `stop: () => 1` in an object literal made a module: its method.
        const pair = node.parent?.type === "pair" ? node.parent : null;
        const key = pair?.childForFieldName("key");
        const cls = ctx.cls();
        if (pair && key?.type === "property_identifier" && pair.parent && ctx.top.objectAt === pair.parent.startIndex && cls) {
          const def = ctx.addDef(pair, key, "method", { owner: cls.cls, exported: true, results: jsResults(node), static: true });
          return fnFrame(node, def);
        }
        // A route handler written in place is a definition of its own, so
        // the calls in it have it as their caller; one no framework plugin
        // binds is folded back into the code around it (inline-fold.ts). An
        // arrow inside a class stays the class's: `this` in it is the class's
        // instance.
        const route = node.type === "arrow_function" && cls ? null : routeHandlerName(node, JS_ROUTE_CALLS);
        if (route) return fnFrame(node, ctx.addDef(node, node.firstChild ?? node, "function", { name: route, owner: ctx.ownerName(), inlineIn: ctx.caller() }, node));
        return fnFrame(node, -1);
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "call_expression") ctx.calledCalls.set(callKey(fn), node);
        jsCallEscapes(ctx, node, jsUnwrap(fn));
        if (fn?.type === "import") return;
        const before = ctx.calls.length;
        const inner = fn?.type === "await_expression" ? fn.firstNamedChild : fn;
        if (inner?.type === "call_expression") ctx.addResultCall(fn as Node, inner);
        else if (fn?.type === "subscript_expression") subscriptCall(fn);
        else jsCallee(ctx, fn);
        jsArgs(ctx, node.childForFieldName("arguments"), ctx.noteCall(node, before));
        // `pick<Repo>(xs)`: each type argument is a use of that type.
        for (const t of jsTypeNames(node.childForFieldName("type_arguments"))) ctx.addTypeUse(t, ctx.caller());
        // `Object.assign(f, { get }, other)`: `f` takes the members of each
        // source, and a source that is no object literal may bring others.
        if (fn?.type === "member_expression" && fn.text === "Object.assign") {
          const [target, ...sources] = node.childForFieldName("arguments")?.namedChildren ?? [];
          const found = target ? jsAssignedMembers(ctx, target, node.startPosition.row + 1, true) : null;
          if (found) for (const src of sources) {
            const o = jsUnwrap(src);
            if (o?.type === "object") jsLiteralKeys(o, found);
            else found.open = true;
          }
        }
        return;
      }
      case "new_expression": {
        const ctor = node.childForFieldName("constructor");
        if (ctor?.type === "identifier" && ctor.text === "Function") {
          ctx.addEscape({ kind: "global", line: node.startPosition.row + 1 }, "Function");
          ctx.addOpaque("makes code from a string with `Function`", node.startPosition.row + 1, "any", "Function");
        }
        if (ctor?.type === "member_expression" && ctor.childForFieldName("property")?.text === "constructor") jsConstructorRead(ctx, node.startPosition.row + 1);
        jsCallee(ctx, ctor);
        jsArgs(ctx, node.childForFieldName("arguments"), undefined);
        for (const t of jsTypeNames(node.childForFieldName("type_arguments"))) ctx.addTypeUse(t, ctx.caller());
        return;
      }
      case "return_statement":
        jsReturned(node.firstNamedChild);
        return;
      case "object": {
        const refs: number[] = [];
        for (const c of node.namedChildren) {
          if (c.type === "shorthand_property_identifier") refs.push(ctx.addValue({ name: c, recv: { kind: "none" } }, "property"));
          else if (c.type === "pair") {
            const v = jsValueNode(ctx, c.childForFieldName("value"));
            if (v) refs.push(ctx.addValue(v, "property"));
          }
        }
        const pending = ctx.pendingTables.get(node.startIndex);
        if (pending) {
          ctx.pendingTables.delete(node.startIndex);
          ctx.bindTable(pending.name, pending.line, refs, pending.scope, pending.open === true);
        }
        // An object that is no module of the graph: the members that may hold code.
        if (ctx.top.objectAt !== node.startIndex) jsLiteral(ctx, node);
        return;
      }
      case "array":
        for (const c of node.namedChildren) {
          const v = jsValueNode(ctx, c);
          if (v) ctx.addValue(v, "element");
        }
        return;
      case "as_expression":
      case "satisfies_expression":
        for (const t of jsTypeNames(node.namedChildren[1] ?? null)) ctx.addTypeUse(t, ctx.caller());
        return;
      case "type_assertion":
        // `<Row>x`, TypeScript only (in TSX it is a JSX element).
        for (const t of jsTypeNames(node.namedChildren[0] ?? null)) ctx.addTypeUse(t, ctx.caller());
        return;
      case "instantiation_expression":
        // `make<Repo>` used as a value, or `sql<Row>` before a template the
        // grammar reads this way: each type argument is a use of that type.
        for (const t of jsTypeNames(node.childForFieldName("type_arguments"))) ctx.addTypeUse(t, ctx.caller());
        return;
      case "binary_expression": {
        if (node.childForFieldName("operator")?.type !== "instanceof") return;
        const right = node.childForFieldName("right");
        if (right?.type === "identifier") ctx.addTypeUse(typeRef({ name: right.text, qualifier: null, ...pos(right) }), ctx.caller());
        else if (right?.type === "member_expression") {
          const prop = right.childForFieldName("property");
          const object = right.childForFieldName("object");
          if (prop && object?.type === "identifier") ctx.addTypeUse(typeRef({ name: prop.text, qualifier: object.text, ...pos(right) }), ctx.caller());
        }
        return;
      }
      case "jsx_expression": {
        // `onClick={handler}`: the handler is a value the element may call.
        if (node.parent?.type !== "jsx_attribute") return;
        const v = jsValueNode(ctx, node.firstNamedChild);
        if (v) ctx.addValue(v, "property");
        return;
      }
      case "assignment_expression": {
        // this.repo = new Repo() in a method declares the field's type.
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "identifier" && left.text === "require") jsMarkRequireBinders(ctx, right);
        const assigned = jsValueNode(ctx, right);
        if (assigned) ctx.addValue(assigned, "assign");
        const type = newType(right);
        if (left?.type === "identifier") {
          ctx.assign(left.text, type ?? callType(ctx, right));
          return;
        }
        // `({ f } = deps)`, `[a, b] = list`: each name gets a value whose type is not known.
        if (left?.type === "object_pattern" || left?.type === "array_pattern") {
          for (const n of patternNames(left)) ctx.assign(n, null);
          return;
        }
        if (left?.type === "member_expression") {
          const exported = jsCommonExport(ctx, node, left, right);
          if (exported) return typeof exported === "function" ? exported : undefined;
        }
        // `handlers.b = g`, `handlers[k] = g`: what a table bound to the name holds changes.
        const target = left?.type === "member_expression" || left?.type === "subscript_expression" ? left.childForFieldName("object") : null;
        if (target?.type === "identifier") ctx.tableUse(target.text);
        // `f.get = g`: `f` takes a member that may hold code.
        const value = jsUnwrap(right);
        const prop = left?.type === "member_expression" ? left.childForFieldName("property") : null;
        if (target && prop?.type === "property_identifier" && value && !DATA_VALUES.has(value.type) && target.type !== "this") {
          jsAssignedMembers(ctx, target, node.startPosition.row + 1, false)?.keys.add(prop.text);
        }
        const cls = ctx.cls();
        if (type && cls && ctx.top.thisKnown !== false && left?.type === "member_expression" && left.childForFieldName("object")?.type === "this") {
          const prop = left.childForFieldName("property");
          if (prop) (ctx.defs[cls.def] as DefFact).fields[prop.text] = type;
        }
        return;
      }
      case "for_in_statement": {
        // for (const op of ops): op is an element of ops. A `let` or
        // `const` loop variable belongs to the loop, a `var` to its function;
        // with neither, the loop assigns a name declared elsewhere.
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        // The same over a field of `this`, a Map's values() or a call
        // (`for (const s of all())`): an element of what the call returns.
        const of = node.children.some((c) => c.type === "of");
        const type = of && left?.type === "identifier" ? elementType(collectionType(ctx, right)) : null;
        const kind = node.children.find((c) => c.type === "var" || c.type === "let" || c.type === "const")?.type;
        const leave = ctx.push({ def: -1, cls: null, locals: new Map(), block: true });
        for (const n of patternNames(left)) {
          if (kind === undefined) ctx.assign(n, type);
          else ctx.setLocal(n, type, kind !== "var");
        }
        return leave;
      }
      case "identifier":
      case "shorthand_property_identifier": {
        // Every other read of a name: a value use, unless a rule above
        // recorded it or the place writes, declares or calls it.
        const text = node.text;
        if (text === "undefined" || text === "arguments") return;
        if (text === "__filename") ctx.filenameReads++;
        jsEscapedName(ctx, text, node.startPosition.row + 1);
        const { role, prop } = jsReadRole(node, upType(1), field);
        jsNameEscapes(ctx, text, role, prop, node.startPosition.row + 1);
        if (ctx.readAt.has(node.startIndex)) return;
        const ref = ctx.values[ctx.addValue({ name: node, recv: { kind: "none" } }, role)] as ValueRef;
        if (prop !== null) ctx.propOf.set(ref, prop);
        // `window.setTimeout(x)`: the timer call itself is checked for what it
        // runs. The node above is read only then: tree-sitter finds it by a
        // walk down from the root, a cost per read that grows with the depth.
        if (prop === null || !TIMERS.has(prop)) return;
        const member = node.parent;
        if (member?.type === "member_expression" && member.parent?.type === "call_expression" && sameNode(member.parent.childForFieldName("function"), member)) ctx.timerRefs.add(ref);
        return;
      }
      case "member_expression": {
        const prop = node.childForFieldName("property");
        if (!prop) return;
        const line = node.startPosition.row + 1;
        const { role } = jsReadRole(node, upType(1), field);
        const object = jsUnwrap(node.childForFieldName("object"));
        if ((prop.text === "require" && loaderOwner(object)) || (prop.text === "mainModule" && object?.type === "identifier" && object.text === "process")) ctx.addEscape({ kind: "load", line });
        if (prop.text === "eval" && object?.type === "identifier" && GLOBAL_OBJECTS.has(object.text)) ctx.addEscape({ kind: "global", line }, object.text);
        if (role !== "object" && object?.type === "identifier" && object.text === "module" && prop.text === "exports") ctx.addEscape({ kind: "own", line }, "module");
        if (prop.text === "constructor") jsConstructorRead(ctx, line);
        jsEscapedName(ctx, prop.text, line);
        // `m.createRequire`, `m._load` or `process.getBuiltinModule` taken as
        // a value, on any value: a loader.
        if (LOADER_READS.has(prop.text)) ctx.addEscape({ kind: "load", line });
        if (ctx.readAt.has(prop.startIndex) || (prop.type !== "property_identifier" && prop.type !== "private_property_identifier")) return;
        jsMemberRead(ctx, object ? jsReceiver(ctx, object) : null, prop, prop.text, role, line);
        return;
      }
      case "subscript_expression": {
        const index = node.childForFieldName("index");
        const text = jsKeyText(index);
        if (text === "constructor") jsConstructorRead(ctx, node.startPosition.row + 1);
        // A read by a bracket key runs a getter as a read by name does: a
        // literal key (`c["total"]`) as that name, any other key (`c[k]`)
        // as any member, unless the value is an array, a string or a record.
        {
          const line = node.startPosition.row + 1;
          const { role } = jsReadRole(node, upType(1), field);
          const target = jsUnwrap(node.childForFieldName("object"));
          // A key written with an escape reads any member, as a computed one does.
          const key = jsLiteralKey(index);
          if (text !== null && LOADER_READS.has(text)) ctx.addEscape({ kind: "load", line });
          // A number key reads the member its digits name (`c[0]` reads
          // `0`, a getter of that name too); one written otherwise
          // (`c[0x0]`, `c[1e3]`) reads any member.
          const digits = index?.type === "number" && /^(0|[1-9][0-9]*)$/.test(index.text) ? index : null;
          if (key) jsMemberRead(ctx, target ? jsReceiver(ctx, target) : null, key, key.text, role, line);
          else if (digits) jsMemberRead(ctx, target ? jsReceiver(ctx, target) : null, digits, digits.text, role, line);
          else if (index && target) {
            const recv: Receiver = ctx.top.depth > MAX_SCOPE_DEPTH ? { kind: "other" } : jsReceiver(ctx, target);
            ctx.keyReads.push({ recv, scope: ctx.top, line, stays: jsValueStays(node) });
          }
        }
        // `this[k]` where `this` may be the global object or a CommonJS module's exports.
        const object = jsUnwrap(node.childForFieldName("object"));
        if (object?.type === "this" && jsLooseThis(ctx)) {
          const line = node.startPosition.row + 1;
          ctx.addEscape({ kind: "global", line });
          ctx.addEscape({ kind: "own", line });
        }
        return;
      }
      case "with_statement":
        ctx.addEscape({ kind: "eval", line: node.startPosition.row + 1 });
        return;
      case "expression_statement":
        // `f();`, `await f();`: the calls whose value is thrown away (jsCallEscapes).
        for (const c of node.namedChildren) {
          if (c.type === "call_expression") ctx.discardedCalls.add(callKey(c));
          else if (c.type === "await_expression") for (const d of c.namedChildren) if (d.type === "call_expression") ctx.discardedCalls.add(callKey(d));
        }
        return;
      case "this":
        // Outside a class, `this` may be the global object, a CommonJS
        // module's exports or any object a call hands it.
        if (ctx.top.thisClass !== true) ctx.addOpaque(THIS_OUTSIDE, node.startPosition.row + 1);
        return;
      case "pair_pattern": {
        const key = node.childForFieldName("key");
        const text = key === null ? null : key.type === "string" || key.type === "computed_property_name" ? jsKeyText(key) : key.text;
        if (text === "constructor") jsConstructorRead(ctx, node.startPosition.row + 1);
        if (key?.type === "property_identifier") jsEscapedName(ctx, key.text, node.startPosition.row + 1);
        jsPatternLoader(ctx, node.parent, text, node.startPosition.row + 1);
        // A number key reads the member its digits name, as `c[0]` does; one written otherwise reads any member.
        const digits = key?.type === "number" && /^(0|[1-9][0-9]*)$/.test(key.text);
        if (key && node.parent?.type === "object_pattern") jsPatternRead(ctx, node.parent, key.type === "property_identifier" || digits ? key : jsLiteralKey(key), node.startPosition.row + 1);
        return;
      }
      case "shorthand_property_identifier_pattern": {
        if (node.text === "constructor") jsConstructorRead(ctx, node.startPosition.row + 1);
        jsEscapedName(ctx, node.text, node.startPosition.row + 1);
        const up = node.parent?.type === "object_assignment_pattern" ? node.parent.parent : node.parent;
        jsPatternLoader(ctx, up, node.text, node.startPosition.row + 1);
        if (up?.type === "object_pattern") jsPatternRead(ctx, up, node, node.startPosition.row + 1);
        return;
      }
      case "ambient_declaration": {
        // `declare const V: string`: a global name of plain data, when the
        // file is a script; inside `declare global`, in any file.
        const block = node.namedChildren.find((c) => c.type === "statement_block");
        const global = node.children.some((c) => c.type === "global") && block !== undefined;
        if (!global && node.parent?.type !== "program") return;
        for (const decl of global ? (block?.namedChildren ?? []) : [node]) {
          for (const c of global ? [decl] : decl.namedChildren) {
            if (c.type !== "lexical_declaration" && c.type !== "variable_declaration") continue;
            for (const d of c.namedChildren) {
              const name = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
              const type = d.childForFieldName("type")?.firstNamedChild;
              if (name?.type === "identifier" && name.text.length <= MAX_FACT_STRING && type?.type === "predefined_type" && PLAIN_TYPES.has(type.text)) (global ? ctx.ambient : ctx.ambientTop).add(name.text);
            }
          }
        }
        return;
      }
      case "internal_module":
      case "module":
        // `declare namespace` and `declare module "x"` hold types alone.
        if (node.parent?.type === "ambient_declaration") return;
        ctx.addOpaque("holds a TypeScript namespace the reader does not read", node.startPosition.row + 1);
        return;
      case "import_alias":
        ctx.addOpaque("uses `import x = a.b` that the reader does not read", node.startPosition.row + 1);
        return;
      case "meta_property": {
        // `import.meta.url` and its like are strings; any other use
        // (Vite's `import.meta.glob`, the object passed on) may load modules.
        // `new.target` is the class a constructor runs for.
        if (node.firstChild?.type !== "import") return;
        const up = node.parent;
        const member = up?.type === "member_expression" && up.childForFieldName("object")?.startIndex === node.startIndex ? (up.childForFieldName("property")?.text ?? "") : "";
        if (META_PLACE.has(member)) return;
        const safe = META_PLAIN.has(member);
        ctx.addOpaque(safe ? "uses `import.meta` that the reader does not read" : "uses `import.meta` for more than its url or path and so may load modules", node.startPosition.row + 1, safe ? undefined : "any");
        return;
      }
      case "jsx_opening_element":
      case "jsx_self_closing_element": {
        const name = node.childForFieldName("name");
        if (name?.type === "identifier" && /^[A-Z]/.test(name.text)) ctx.addCall(name, { kind: "none" });
        else if (name?.type === "member_expression") jsCallee(ctx, name);
        return;
      }
    }
  } });
  // A definition is exported under its own name only through `export` on it
  // or `export { x }`; `export default` and `export { x as y }` export it
  // under another name, which the resolver reads from the export table.
  const exported = new Set(ctx.exportsLocal.filter((e) => e.local === e.exported).map((e) => e.local));
  for (const d of ctx.defs) if (d.topLevel && exported.has(d.name)) d.exported = true;
  settleReturns();
  return ctx.facts();
}

// ---------- Python ----------

const PY_TYPES = new Set([
  "for_statement",
  "import_statement",
  "import_from_statement",
  "class_definition",
  "function_definition",
  "lambda",
  "assignment",
  "decorator",
  "call",
  "return_statement",
  "dictionary",
  "list",
  "tuple",
  "set",
]);

// Every named type in a Python annotation (`Optional[Repo]` names Optional
// and Repo).
function pyTypeNames(node: Node | null): TypeRef[] {
  const out: TypeRef[] = [];
  typeNodes(node, (n) => {
    if (n.type !== "identifier" && n.type !== "attribute" && n.type !== "string") return false;
    const r = pyTypeRef(n);
    if (r) out.push(r);
    return true;
  });
  return out;
}

// Whether a call is written with the typing module's `cast`: a name
// imported from typing (`from typing import cast as c`) or an attribute of
// a name bound to the module (`typing.cast`, `t.cast`), when no parameter
// or local of that name hides the import where the call is.
const PY_TYPING = new Set(["typing", "typing_extensions"]);
function pyTypingCast(ctx: Ctx, fn: Node | null): boolean {
  if (fn?.type === "identifier") return pyTypingName(ctx, fn.text, "cast", (i) => i.names.some((n) => n.imported === "cast" && n.local === fn.text));
  if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "cast") return false;
  const object = fn.childForFieldName("object");
  return object?.type === "identifier" && pyTypingName(ctx, object.text, "*", (i) => i.namespace === object.text);
}

// `name` is bound by an import of the typing module where it is read: an
// import of the function or block around it, else one of the module's. Of
// those, the last statement of the module itself that binds the name
// decides, or a typing import after it under a block that may run. An
// import inside another function or in a class body binds nothing here.
function pyTypingName(ctx: Ctx, name: string, imported: string, binds: (i: ImportFact) => boolean): boolean {
  const bound = ctx.lookup(ctx.top, name)?.imports?.get(name);
  if (bound) return bound.imported === imported && PY_TYPING.has(ctx.imports[bound.import]?.spec ?? "");
  if (ctx.local(name) !== undefined) return false;
  for (let k = ctx.imports.length - 1; k >= 0; k--) {
    const i = ctx.imports[k] as ImportFact;
    const place = ctx.pyImportPlace.get(i);
    if (i.scoped === true || place === "class" || !(i.namespace === name || i.names.some((n) => n.local === name))) continue;
    if (PY_TYPING.has(i.spec) && binds(i)) return true;
    if (place === "top") return false;
  }
  return false;
}

// Where a Python import that is in no function stands (Ctx.pyImportPlace).
function pyImportPlace(node: Node): "top" | "maybe" | "class" {
  if (node.parent?.type === "module") return "top";
  for (let p = node.parent; p && p.type !== "module"; p = p.parent) if (p.type === "class_definition") return "class";
  return "maybe";
}

// A method Python never runs on an instance of a concrete class: one
// marked @abstractmethod (a class with one cannot be instantiated). A body
// that only raises NotImplementedError, or is `...`, still runs when it is
// called, so it is no proof of anything.
function pyAbstract(fn: Node): boolean {
  const decorators = fn.parent?.type === "decorated_definition" ? fn.parent.namedChildren.filter((c) => c.type === "decorator") : [];
  return decorators.some((d) => /(^|\.)abstractmethod$/.test(d.namedChildren[0]?.text ?? ""));
}

function pyStatic(fn: Node): boolean {
  return fn.parent?.type === "decorated_definition" && fn.parent.namedChildren.some((c) => c.type === "decorator" && c.namedChildren[0]?.text === "staticmethod");
}

// A name or an attribute path that may stand for a function.
function pyValueNode(ctx: Ctx, n: Node | null): ValueNode {
  // `(f)` and `((f))` are the value `f`.
  while (n?.type === "parenthesized_expression") n = n.firstNamedChild;
  if (!n) return null;
  if (n.type === "identifier") return { name: n, recv: { kind: "none" } };
  if (n.type === "attribute") {
    const attr = n.childForFieldName("attribute");
    const object = n.childForFieldName("object");
    if (!attr || !object) return null;
    const recv = pyReceiver(ctx, object);
    return recv.kind === "other" ? null : { name: attr, recv };
  }
  return null;
}

function pyTypeRef(node: Node | null): TypeRef | null {
  let t = node;
  if (t?.type === "type") t = t.firstNamedChild;
  if (!t) return null;
  // `Repo | None` and `Optional[Repo]` are a Repo wherever a method is called on it.
  if (t.type === "binary_operator" && t.childForFieldName("operator")?.text === "|") {
    const sides = [t.childForFieldName("left"), t.childForFieldName("right")].filter((x): x is Node => x !== null && x.type !== "none");
    return sides.length === 1 ? pyTypeRef(sides[0] as Node) : null;
  }
  if (t.type === "generic_type" || t.type === "subscript") {
    const head = t.type === "subscript" ? t.childForFieldName("value") : t.firstNamedChild;
    const args = t.type === "subscript" ? t.childrenForFieldName("subscript") : (t.namedChildren[1]?.namedChildren ?? []);
    if (head?.text === "Optional" && args.length === 1) return pyTypeRef(args[0] as Node);
    if (args.length === 1 && /^(list|List|set|Set|Sequence|Iterable|Iterator|frozenset|FrozenSet)$/.test(head?.text ?? "")) {
      const inner = pyTypeRef(args[0] as Node);
      return inner ? { ...inner, elem: true } : null;
    }
    return null;
  }
  const { line, column } = pos(t);
  if (t.type === "identifier") return typeRef({ name: t.text, qualifier: null, line, column });
  if (t.type === "attribute") {
    const attr = t.childForFieldName("attribute");
    const object = t.childForFieldName("object");
    if (attr && object) return typeRef({ name: attr.text, qualifier: object.text, line, column });
  }
  if (t.type === "string") {
    const text = stringContent(t);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return typeRef({ name: text, qualifier: null, line, column });
  }
  return null;
}

function pyReceiver(ctx: Ctx, object: Node): Receiver {
  const path: string[] = [];
  let base: Node | null = object;
  while (base && base.type === "attribute") {
    const attr = base.childForFieldName("attribute");
    if (!attr) return { kind: "other" };
    path.unshift(attr.text);
    base = base.childForFieldName("object");
  }
  if (!base) return { kind: "other" };
  if (base.type === "call" && base.childForFieldName("function")?.text === "super") {
    return path.length === 0 ? { kind: "super" } : { kind: "other" };
  }
  if (base.type === "call") {
    // Repo().find(): the receiver is what the call constructs, when it names a class.
    const type = pyCallType(base);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base.type !== "identifier") return { kind: "other" };
  if ((base.text === "self" || base.text === "cls") && ctx.cls()) return { kind: "self", path };
  return ctx.identReceiver(base.text, path);
}

function pyCallType(value: Node | null): TypeRef | null {
  if (value?.type !== "call") return null;
  return pyTypeRef(value.childForFieldName("function"));
}

function extractPython(tree: Tree, readers: readonly TreeVisitor[]): FileFacts {
  const ctx = new Ctx("python");
  const returned = (value: Node | null) => {
    const owner = ctx.top.fnDecl.def;
    const sides = value?.type === "conditional_expression" ? [value.namedChildren[0] ?? null, value.namedChildren[2] ?? null] : [value];
    for (const side of sides) {
      const v = pyValueNode(ctx, side);
      if (!v) {
        if (side && owner >= 0) (ctx.defs[owner] as DefFact).returnsOther = true;
        continue;
      }
      const ref = ctx.addValue(v, "return");
      if (owner >= 0) ((ctx.defs[owner] as DefFact).returns ??= []).push(ref);
    }
  };
  walkTree(tree.rootNode, readers, { interesting: PY_TYPES, visit: (node) => {
    switch (node.type) {
      case "import_statement": {
        for (const n of node.namedChildren) {
          const fact: ImportFact = { spec: "", ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
          if (n.type === "dotted_name") {
            // `import a.b` binds `a`; the rest is reached as attributes.
            fact.spec = n.text;
            fact.namespace = n.text.split(".")[0] ?? null;
          } else if (n.type === "aliased_import") {
            fact.spec = n.childForFieldName("name")?.text ?? "";
            fact.namespace = n.childForFieldName("alias")?.text ?? null;
            fact.alias = true;
          } else continue;
          ctx.pyImportPlace.set(fact, pyImportPlace(node));
          ctx.addImport(fact);
        }
        return false;
      }
      case "import_from_statement": {
        const module = node.childForFieldName("module_name");
        if (!module) return false;
        const fact: ImportFact = { spec: module.text, ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
        for (const n of node.childrenForFieldName("name")) {
          if (n.type === "dotted_name") fact.names.push({ imported: n.text, local: n.text });
          else if (n.type === "aliased_import") {
            const name = n.childForFieldName("name");
            const alias = n.childForFieldName("alias");
            if (name && alias) fact.names.push({ imported: name.text, local: alias.text });
          }
        }
        if (node.namedChildren.some((c) => c.type === "wildcard_import")) fact.star = true;
        ctx.pyImportPlace.set(fact, pyImportPlace(node));
        ctx.addImport(fact);
        return false;
      }
      case "class_definition": {
        const name = node.childForFieldName("name");
        if (!name) return;
        const bases: TypeRef[] = [];
        const dynamicBases: { line: number; column: number; head?: TypeRef }[] = [];
        for (const b of node.childForFieldName("superclasses")?.namedChildren ?? []) {
          // `metaclass=M` and `**options` are keywords of the class statement, never a base.
          if (b.type === "keyword_argument" || b.type === "dictionary_splat" || b.type === "comment") continue;
          const ref = pyTypeRef(b);
          if (ref) bases.push(ref);
          else {
            // A base made by a call, a subscript (`Base[int]`, `Generic[T]`) or a `*bases` list.
            const head = b.type === "subscript" ? pyTypeRef(b.childForFieldName("value")) : null;
            dynamicBases.push({ ...pos(b), ...(head ? { head } : {}) });
          }
        }
        const span = node.parent?.type === "decorated_definition" ? node.parent : node;
        const top = ctx.atModuleLevel();
        const cls = ctx.cls();
        const def = ctx.addDef(node, name, "class", { topLevel: top, exported: !name.text.startsWith("_"), bases, owner: cls?.cls ?? null, ...(dynamicBases.length > 0 ? { dynamicBases } : {}) }, span);
        return ctx.push({ def, cls: name.text, locals: null });
      }
      case "function_definition": {
        const name = node.childForFieldName("name");
        const span = node.parent?.type === "decorated_definition" ? node.parent : node;
        const inner = ctx.top;
        const isMethod = inner.cls !== null && inner.locals === null;
        const locals = new Map<string, TypeRef | null>();
        const params: string[] = [];
        const typeNodes: (Node | null)[] = [node.childForFieldName("return_type")];
        let positional = true;
        for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
          let id: Node | null | undefined = null;
          if (p.type === "identifier") {
            id = p;
            locals.set(p.text, null);
          } else if (p.type === "typed_parameter") {
            id = p.namedChildren.find((c) => c.type === "identifier");
            if (id) locals.set(id.text, declared(pyTypeRef(p.childForFieldName("type"))));
          } else {
            id = p.childForFieldName("name");
            if (id) locals.set(id.text, declared(pyTypeRef(p.childForFieldName("type"))));
          }
          typeNodes.push(p.childForFieldName("type"));
          // After *args or a bare *, the rest are keyword only: named, never by position.
          if (p.type === "list_splat_pattern" || p.type === "dictionary_splat_pattern" || p.type === "keyword_separator") positional = false;
          if (id && (positional || p.type !== "list_splat_pattern")) params.push(id.type === "identifier" ? id.text : "");
        }
        // A method's first parameter is the instance or the class: no argument of a call.
        if (isMethod && !pyStatic(node)) params.shift();
        if (!name) return ctx.push({ def: -1, cls: null, locals });
        const top = ctx.atModuleLevel() && !isMethod;
        const nested = !top && !isMethod;
        const def = ctx.addDef(
          node,
          name,
          isMethod ? "method" : "function",
          {
            owner: isMethod ? inner.cls : nested ? ctx.ownerName() : null,
            topLevel: top,
            exported: !name.text.startsWith("_") || /^__\w+__$/.test(name.text),
            results: (() => {
              const r = pyTypeRef(node.childForFieldName("return_type"));
              return r ? [r] : undefined;
            })(),
            ...(isMethod && pyAbstract(node) ? { abstract: true } : {}),
            ...(params.some((x) => x !== "") ? { params } : {}),
          },
          span,
        );
        for (const t of typeNodes) for (const r of pyTypeNames(t)) ctx.addTypeUse(r, def);
        if (nested) ctx.declareFn(name.text, def);
        return ctx.push({ def, cls: null, locals });
      }
      case "lambda":
        return ctx.push({ def: -1, cls: null, locals: new Map() });
      case "for_statement": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type !== "identifier") {
          // `for a, b in pairs`: each name is a local whose type is not known.
          for (const n of patternNames(left)) ctx.setLocal(n, null);
          return;
        }
        const t = right?.type === "identifier" ? ctx.local(right.text) : null;
        ctx.setLocal(left.text, t?.elem ? { ...t, elem: false } : null);
        return;
      }
      case "assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const annotation = declared(pyTypeRef(node.childForFieldName("type")));
        for (const r of pyTypeNames(node.childForFieldName("type"))) ctx.addTypeUse(r, ctx.caller());
        const type = annotation ?? pyCallType(right);
        const inner = ctx.top;
        const v = pyValueNode(ctx, right);
        const ref = v ? ctx.addValue(v, "assign") : undefined;
        const inClassBody = inner.cls !== null && inner.locals === null;
        if (left?.type === "identifier" && !inClassBody) {
          // A name given one value once may stand for it when called; a
          // literal table is read for its entries.
          ctx.noteAssign(left.text, ref !== undefined ? { ref } : right?.type === "call" ? { callNode: right.endIndex } : null, false);
          if (right?.type === "dictionary") ctx.pendingTables.set(right.startIndex, { name: left.text, line: node.startPosition.row + 1, scope: ctx.top.fnDecl });
        }
        if (left?.type === "identifier") {
          if (inClassBody) ctx.setField(inner.def, left.text, type, annotation !== null);
          else if (annotation) ctx.setLocal(left.text, annotation);
          else ctx.assign(left.text, type, true);
        } else if (left?.type === "pattern_list" || left?.type === "tuple_pattern" || left?.type === "list_pattern") {
          // `a, b = pair`: each name is assigned a value whose type is not known.
          if (!(inner.cls !== null && inner.locals === null)) for (const n of patternNames(left)) ctx.assign(n, null, true);
        } else if ((left?.type === "subscript" || left?.type === "attribute") && left.childForFieldName(left.type === "subscript" ? "value" : "object")?.type === "identifier") {
          // `HANDLERS["k"] = g`: what a table bound to the name holds changes.
          ctx.tableUse(left.childForFieldName(left.type === "subscript" ? "value" : "object")?.text ?? "");
        }
        if (left?.type === "attribute" && left.childForFieldName("object")?.text === "self") {
          const attr = left.childForFieldName("attribute");
          const cls = ctx.cls();
          // `self.store = store`: the field takes the local's type, a
          // parameter's annotation among them.
          const value = type ?? (right?.type === "identifier" ? (ctx.local(right.text) ?? null) : null);
          if (attr && cls) ctx.setField(cls.def, attr.text, value, annotation !== null);
        }
        return;
      }
      case "decorator": {
        // `@wrap` and `@pkg.wrap` call the name with the decorated function,
        // from the scope around the definition, as `@wrap()` calls it;
        // `@(wrap)` is the same name.
        const inner = (n: Node | null | undefined) => n?.namedChildren.find((c) => c.type !== "comment");
        let expr = inner(node);
        while (expr?.type === "parenthesized_expression") expr = inner(expr);
        if (expr?.type === "identifier") ctx.addCall(expr, { kind: "none" });
        else if (expr?.type === "attribute") {
          const attr = expr.childForFieldName("attribute");
          const object = expr.childForFieldName("object");
          if (attr && object) ctx.addCall(attr, pyReceiver(ctx, object));
        }
        return;
      }
      case "call": {
        const fn = node.childForFieldName("function");
        const before = ctx.calls.length;
        if (fn?.type === "identifier") ctx.addCall(fn, { kind: "none" });
        else if (fn?.type === "subscript") {
          ctx.addDynamicCall(fn);
          const table = fn.childForFieldName("value");
          if (table?.type === "identifier") ctx.tableCall(ctx.calls.length - 1, table.text);
        } else if (fn?.type === "call") ctx.addResultCall(fn, fn);
        else if (fn?.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          const object = fn.childForFieldName("object");
          if (attr && object) ctx.addCall(attr, pyReceiver(ctx, object));
        }
        const call = ctx.noteCall(node, before);
        const args = node.childForFieldName("arguments");
        let i = 0;
        let known = call !== undefined;
        for (const a of args?.type === "argument_list" ? args.namedChildren : []) {
          if (a.type === "comment") continue;
          if (a.type === "list_splat" || a.type === "dictionary_splat") known = false;
          if (a.type === "keyword_argument") {
            const key = a.childForFieldName("name");
            const v = pyValueNode(ctx, a.childForFieldName("value"));
            if (v && key) ctx.addValue(v, "arg", call !== undefined ? { call, key: key.text } : {});
            continue;
          }
          const v = pyValueNode(ctx, a);
          if (v) ctx.addValue(v, "arg", known ? { call, arg: i } : {});
          i++;
        }
        // getattr(o, name): a call of the method it may take, by that name.
        // A splat in the first two places may give the name: then it is not known.
        if (fn?.type === "identifier" && fn.text === "getattr") {
          const all = args?.namedChildren.filter((a) => a.type !== "comment" && a.type !== "keyword_argument") ?? [];
          const splat = all.findIndex((a) => a.type === "list_splat" || a.type === "dictionary_splat");
          if (splat >= 0 && splat <= 1) ctx.addNameBuiltCall(node, undefined);
          else if (all.length >= 2) ctx.addNameBuiltCall(node, all[1]);
        }
        // isinstance(x, Repo) and issubclass: the classes are type uses.
        if (fn?.type === "identifier" && (fn.text === "isinstance" || fn.text === "issubclass")) {
          for (const r of pyTypeNames(args?.namedChildren[1] ?? null)) ctx.addTypeUse(r, ctx.caller());
        }
        // `cast(Foo, x)`, `typing.cast("Foo", x)`, `cast(typ=Foo, val=x)`: the type is a type use.
        if (pyTypingCast(ctx, fn)) {
          const all = args?.namedChildren.filter((a) => a.type !== "comment") ?? [];
          const first = all[0]?.type !== "keyword_argument" ? all[0] : all.find((a) => a.childForFieldName("name")?.text === "typ")?.childForFieldName("value");
          if (first) for (const r of pyTypeNames(first)) ctx.addTypeUse(r, ctx.caller());
        }
        return;
      }
      case "return_statement":
        returned(node.firstNamedChild);
        return;
      case "dictionary":
      case "list":
      case "tuple":
      case "set": {
        const refs: number[] = [];
        for (const c of node.namedChildren) {
          const v = pyValueNode(ctx, c.type === "pair" ? c.childForFieldName("value") : c);
          if (v) refs.push(ctx.addValue(v, node.type === "dictionary" ? "property" : "element"));
        }
        const pending = ctx.pendingTables.get(node.startIndex);
        if (pending) {
          ctx.pendingTables.delete(node.startIndex);
          ctx.bindTable(pending.name, pending.line, refs, pending.scope);
        }
        return;
      }
    }
  } });
  return ctx.facts();
}

// ---------- Go ----------

const GO_TYPES = new Set([
  "package_clause",
  "import_spec",
  "function_declaration",
  "method_declaration",
  "type_spec",
  "func_literal",
  "short_var_declaration",
  "var_spec",
  "range_clause",
  "call_expression",
  "assignment_statement",
  "return_statement",
  "literal_value",
  "type_conversion_expression",
  "type_assertion_expression",
]);

// Every named type in a Go type (`map[string]*Repo` names Repo).
function goTypeNames(node: Node | null): TypeRef[] {
  const out: TypeRef[] = [];
  typeNodes(node, (n) => {
    if (n.type !== "type_identifier" && n.type !== "qualified_type") return false;
    const r = goTypeRef(n);
    if (r) out.push(r);
    return true;
  });
  return out;
}

// The names of a parameter list in order ("" for a blank or unnamed one).
function goParamNames(list: Node | null): string[] {
  const out: string[] = [];
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue;
    const names = p.childrenForFieldName("name");
    if (names.length === 0) out.push("");
    for (const n of names) out.push(n.text === "_" ? "" : n.text);
  }
  return out;
}

// A name or a selector that may stand for a function: never a local.
function goValueNode(ctx: Ctx, n: Node | null): ValueNode {
  if (!n) return null;
  if (n.type === "identifier") return ctx.local(n.text) === undefined && n.text !== "nil" ? { name: n, recv: { kind: "none" } } : null;
  if (n.type === "selector_expression") {
    const field = n.childForFieldName("field");
    const operand = n.childForFieldName("operand");
    if (!field || !operand) return null;
    const recv = goReceiver(ctx, operand);
    return recv.kind === "other" ? null : { name: field, recv };
  }
  return null;
}

function goTypeRef(node: Node | null): TypeRef | null {
  if (!node) return null;
  const { line, column } = pos(node);
  switch (node.type) {
    case "type_identifier":
      return { name: node.text, qualifier: null, line, column };
    case "pointer_type":
      return goTypeRef(node.firstNamedChild);
    case "generic_type":
      return goTypeRef(node.childForFieldName("type"));
    case "slice_type":
    case "array_type":
    case "map_type": {
      const inner = goTypeRef(node.childForFieldName(node.type === "map_type" ? "value" : "element"));
      return inner ? { ...inner, elem: true } : null;
    }
    case "qualified_type": {
      const pkg = node.childForFieldName("package");
      const name = node.childForFieldName("name");
      return pkg && name ? { name: name.text, qualifier: pkg.text, line, column } : null;
    }
    default:
      return null;
  }
}

function goParams(list: Node | null, locals: Map<string, TypeRef | null>): void {
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue;
    const type = p.type === "parameter_declaration" ? goTypeRef(p.childForFieldName("type")) : null;
    for (const n of p.childrenForFieldName("name")) locals.set(n.text, type);
  }
}

// The declared result types, one per result (a named group repeats its type).
function goResults(node: Node): (TypeRef | null)[] | undefined {
  const r = node.childForFieldName("result");
  if (!r) return undefined;
  if (r.type !== "parameter_list") return [goTypeRef(r)];
  const out: (TypeRef | null)[] = [];
  for (const p of r.namedChildren) {
    if (p.type !== "parameter_declaration") continue;
    const type = goTypeRef(p.childForFieldName("type"));
    const names = p.childrenForFieldName("name");
    for (let i = 0; i < Math.max(1, names.length); i++) out.push(type);
  }
  return out;
}

// Calls keep their result position and the type of a known receiver.
function goCallType(ctx: Ctx, call: Node, index: number, depth = 0): TypeRef | null {
  if (depth > MAX_TYPE_DEPTH) return null;
  const fn = call.childForFieldName("function");
  if (fn?.type === "identifier") return { name: fn.text, qualifier: null, ...pos(fn), result: index };
  if (fn?.type === "selector_expression") {
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    if (operand?.type === "identifier" && field && ctx.local(operand.text) === undefined) {
      return { name: field.text, qualifier: operand.text, ...pos(fn), result: index };
    }
    if (!operand || !field) return null;
    const recv = goReceiver(ctx, operand, depth + 1);
    if (recv.kind !== "type") return null;
    let on: TypeRef | undefined = recv.type;
    for (const name of recv.path) {
      if (!on || on.qualifier || on.elem || on.result !== undefined) return null;
      on = ctx.goFields.get(on.name)?.[name];
    }
    return methodResultType(field, on, index);
  }
  return null;
}

function goValueType(ctx: Ctx, value: Node | undefined, index = 0): TypeRef | null {
  let v = value;
  if (v?.type === "unary_expression") v = v.childForFieldName("operand") ?? undefined;
  if (v?.type === "composite_literal") return goTypeRef(v.childForFieldName("type"));
  if (v?.type === "call_expression") return goCallType(ctx, v, index);
  return null;
}

function goReceiver(ctx: Ctx, operand: Node, depth = 0): Receiver {
  const path: string[] = [];
  let base: Node | null = operand;
  while (base && base.type === "selector_expression") {
    const field = base.childForFieldName("field");
    if (!field) return { kind: "other" };
    path.unshift(field.text);
    base = base.childForFieldName("operand");
  }
  if (base?.type === "index_expression") {
    // clients[0].Get(): an element of a typed slice or map.
    const operand = base.childForFieldName("operand");
    const t = operand?.type === "identifier" ? ctx.local(operand.text) : null;
    return t?.elem ? { kind: "type", type: { ...t, elem: false }, path } : { kind: "other" };
  }
  if (base?.type === "call_expression") {
    const type = goCallType(ctx, base, 0, depth);
    return type ? { kind: "type", type, path } : { kind: "other" };
  }
  if (base?.type !== "identifier") return { kind: "other" };
  const type = ctx.local(base.text);
  if (type?.elem) return { kind: "other" };
  if (type) return { kind: "type", type, path };
  if (type === null) return { kind: "other" };
  return { kind: "name", name: base.text, path, nesting: null };
}

function extractGo(tree: Tree, readers: readonly TreeVisitor[]): FileFacts {
  const ctx = new Ctx("go");
  // Package types are visible before their declarations. Keep their direct field annotations for receiver calls.
  for (const decl of tree.rootNode.namedChildren) {
    if (decl.type !== "type_declaration") continue;
    for (const spec of decl.namedChildren) {
      const name = spec.childForFieldName("name");
      const body = spec.childForFieldName("type");
      if (!name || body?.type !== "struct_type") continue;
      const fields: Record<string, TypeRef> = {};
      const list = body.namedChildren.find((c) => c.type === "field_declaration_list");
      for (const field of list?.namedChildren ?? []) {
        const type = goTypeRef(field.childForFieldName("type"));
        if (type) for (const n of field.childrenForFieldName("name")) fields[n.text] = type;
      }
      ctx.goFields.set(name.text, fields);
    }
  }
  const exported = (name: string) => /^[A-Z]/.test(name);
  const signatureUses = (node: Node, def: number) => {
    for (const field of ["parameters", "result"]) for (const r of goTypeNames(node.childForFieldName(field))) ctx.addTypeUse(r, def);
  };
  // A local given a value: a name or a selector, a call's result, or a
  // literal table; a later assignment of the same name ends the alias.
  const assignLocal = (name: Node, value: Node | undefined) => {
    if (name.type !== "identifier" || name.text === "_") return;
    const v = goValueNode(ctx, value ?? null);
    const ref = v ? ctx.addValue(v, "assign") : undefined;
    let inner: Node | undefined = value;
    if (inner?.type === "unary_expression") inner = inner.childForFieldName("operand") ?? undefined;
    ctx.noteAssign(name.text, ref !== undefined ? { ref } : value?.type === "call_expression" ? { callNode: value.endIndex } : null, false);
    const body = inner?.type === "composite_literal" ? inner.childForFieldName("body") : null;
    if (body) ctx.pendingTables.set(body.startIndex, { name: name.text, line: name.startPosition.row + 1, scope: ctx.top.fnDecl });
  };
  walkTree(tree.rootNode, readers, { interesting: GO_TYPES, visit: (node) => {
    switch (node.type) {
      case "package_clause":
        ctx.goPackage = node.firstNamedChild?.text ?? null;
        return false;
      case "import_spec": {
        const path = node.childForFieldName("path");
        if (!path) return false;
        const alias = node.childForFieldName("name");
        if (alias?.type === "blank_identifier") return false;
        ctx.imports.push({
          spec: stringContent(path),
          ...pos(node),
          names: [],
          namespace: alias?.type === "package_identifier" ? alias.text : null,
          star: alias?.type === "dot",
          reexport: false,
          typeOnly: false,
        });
        return false;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name");
        const locals = new Map<string, TypeRef | null>();
        goParams(node.childForFieldName("parameters"), locals);
        goParams(node.childForFieldName("result"), locals);
        if (!name) return ctx.push({ def: -1, cls: null, locals });
        const params = goParamNames(node.childForFieldName("parameters"));
        const def = ctx.addDef(node, name, "function", { topLevel: true, exported: exported(name.text), results: goResults(node), ...(params.some((x) => x !== "") ? { params } : {}) });
        signatureUses(node, def);
        return ctx.push({ def, cls: null, locals });
      }
      case "method_declaration": {
        const name = node.childForFieldName("name");
        const locals = new Map<string, TypeRef | null>();
        const receiver = node.childForFieldName("receiver");
        goParams(receiver, locals);
        goParams(node.childForFieldName("parameters"), locals);
        goParams(node.childForFieldName("result"), locals);
        const recvNode = receiver?.namedChildren[0]?.childForFieldName("type") ?? null;
        const recvType = goTypeRef(recvNode);
        if (!name || !recvType) return ctx.push({ def: -1, cls: null, locals });
        const params = goParamNames(node.childForFieldName("parameters"));
        const def = ctx.addDef(node, name, "method", {
          owner: recvType.name,
          exported: exported(name.text),
          results: goResults(node),
          ...(recvNode?.type === "pointer_type" ? { pointer: true } : {}),
          ...(params.some((x) => x !== "") ? { params } : {}),
        });
        signatureUses(node, def);
        return ctx.push({ def, cls: null, locals });
      }
      case "type_spec": {
        const name = node.childForFieldName("name");
        if (!name) return false;
        const body = node.childForFieldName("type");
        const fields: Record<string, TypeRef> = {};
        const bases: TypeRef[] = [];
        const typeNodes: Node[] = [];
        if (body?.type === "struct_type") {
          const list = body.namedChildren.find((c) => c.type === "field_declaration_list");
          for (const f of list?.namedChildren ?? []) {
            if (f.type !== "field_declaration") continue;
            const typeNode = f.childForFieldName("type");
            if (typeNode) typeNodes.push(typeNode);
            const type = goTypeRef(typeNode);
            const names = f.childrenForFieldName("name");
            if (!type) continue;
            if (names.length === 0) bases.push(type);
            for (const n of names) fields[n.text] = type;
          }
        }
        // An interface: its methods are declared members; an embedded
        // interface is a base.
        const iface = body?.type === "interface_type";
        if (iface) {
          for (const e of body.namedChildren) {
            if (e.type !== "type_elem") continue;
            const ref = goTypeRef(e.namedChildren[0] ?? null);
            if (ref && e.namedChildCount === 1) bases.push(ref);
          }
        }
        const top = node.parent?.parent?.type === "source_file";
        const span = node.parent?.type === "type_declaration" && node.parent.namedChildren.length === 1 ? node.parent : node;
        const def = ctx.addDef(node, name, "type", { topLevel: top, exported: exported(name.text), fields, bases, ...(iface ? { iface: true } : {}) }, span);
        for (const t of typeNodes) for (const r of goTypeNames(t)) ctx.addTypeUse(r, def);
        if (iface) {
          for (const m of body.namedChildren) {
            const mName = m.type === "method_elem" ? m.childForFieldName("name") : null;
            if (!mName) continue;
            const params = goParamNames(m.childForFieldName("parameters"));
            const member = ctx.addDef(m, mName, "method", {
              owner: name.text,
              exported: exported(mName.text),
              results: goResults(m),
              abstract: true,
              ...(params.some((x) => x !== "") ? { params } : {}),
            });
            signatureUses(m, member);
          }
        }
        return false;
      }
      case "func_literal": {
        const locals = new Map<string, TypeRef | null>();
        goParams(node.childForFieldName("parameters"), locals);
        // A route handler written in place is a definition of its own,
        // folded back when no framework plugin binds it (inline-fold.ts).
        const route = routeHandlerName(node, GO_ROUTE_CALLS);
        if (route) return ctx.push({ def: ctx.addDef(node, node.firstChild ?? node, "function", { name: route, owner: ctx.ownerName(), inlineIn: ctx.caller() }, node), cls: null, locals });
        return ctx.push({ def: -1, cls: null, locals });
      }
      case "short_var_declaration": {
        const left = node.childForFieldName("left")?.namedChildren ?? [];
        const right = node.childForFieldName("right")?.namedChildren ?? [];
        left.forEach((l, i) => {
          if (l.type !== "identifier" || l.text === "_") return;
          if (left.length === right.length) assignLocal(l, right[i]);
          else ctx.noteAssign(l.text, null, false);
          // a, err := F() takes F's results in order; a, b := x, y pairs up.
          const type = right.length === 1 && left.length > 1 ? goValueType(ctx, right[0], i) : left.length === right.length ? goValueType(ctx, right[i]) : null;
          ctx.setLocal(l.text, type);
        });
        return;
      }
      case "var_spec": {
        const typeNode = node.childForFieldName("type");
        const type = goTypeRef(typeNode);
        for (const r of goTypeNames(typeNode)) ctx.addTypeUse(r, ctx.caller());
        const values = node.childForFieldName("value")?.namedChildren ?? [];
        node.childrenForFieldName("name").forEach((n, i) => {
          if (values.length === node.childrenForFieldName("name").length) assignLocal(n, values[i]);
          ctx.setLocal(n.text, type ?? goValueType(ctx, values[i]));
        });
        return;
      }
      case "assignment_statement": {
        // x = y: a name assigned again is no alias; a function on the right is a value.
        const left = node.childForFieldName("left")?.namedChildren ?? [];
        const right = node.childForFieldName("right")?.namedChildren ?? [];
        for (const l of left) {
          if (l.type === "identifier") {
            ctx.noteAssign(l.text, null, false);
            ctx.reassign(l.text);
          }
          // `handlers["k"] = g`: what a table bound to the name holds changes.
          const operand = l.type === "index_expression" ? l.childForFieldName("operand") : null;
          if (operand?.type === "identifier") ctx.tableUse(operand.text);
        }
        for (const r of right) {
          const v = goValueNode(ctx, r);
          if (v) ctx.addValue(v, "assign");
        }
        return;
      }
      case "type_assertion_expression":
        // `v.(Bar)`, `v.(*store.Bar)`: the type is a type use.
        for (const r of goTypeNames(node.childForFieldName("type"))) ctx.addTypeUse(r, ctx.caller());
        return;
      case "type_conversion_expression": {
        // `handlers[k](x)` reads like a generic conversion `T[k](x)`; when
        // the name is a variable it is a call of an indexed value.
        const type = node.childForFieldName("type");
        const head = type?.type === "generic_type" ? type.childForFieldName("type") : null;
        if (!head || head.type !== "type_identifier" || ctx.local(head.text) === undefined) return;
        ctx.addDynamicCall(node);
        ctx.tableCall(ctx.calls.length - 1, head.text);
        const v = goValueNode(ctx, node.childForFieldName("operand"));
        if (v) ctx.addValue(v, "arg");
        return;
      }
      case "return_statement": {
        const owner = ctx.top.fnDecl.def;
        const list = node.firstNamedChild;
        for (const r of list?.type === "expression_list" ? list.namedChildren : list ? [list] : []) {
          const v = goValueNode(ctx, r);
          if (!v) {
            if (owner >= 0) (ctx.defs[owner] as DefFact).returnsOther = true;
            continue;
          }
          const ref = ctx.addValue(v, "return");
          if (owner >= 0) ((ctx.defs[owner] as DefFact).returns ??= []).push(ref);
        }
        return;
      }
      case "literal_value": {
        // A composite literal's entries; one bound to a name is a table.
        const refs: number[] = [];
        for (const e of node.namedChildren) {
          const value = e.type === "keyed_element" ? e.childForFieldName("value") : e.type === "literal_element" ? e : null;
          const v = goValueNode(ctx, value?.type === "literal_element" ? value.firstNamedChild : value);
          if (v) refs.push(ctx.addValue(v, e.type === "keyed_element" ? "property" : "element"));
        }
        const pending = ctx.pendingTables.get(node.startIndex);
        if (pending) {
          ctx.pendingTables.delete(node.startIndex);
          ctx.bindTable(pending.name, pending.line, refs, pending.scope);
        }
        return;
      }
      case "range_clause": {
        // for _, op := range ops: op is an element of ops.
        const left = node.childForFieldName("left")?.namedChildren ?? [];
        const right = node.childForFieldName("right");
        const t = right?.type === "identifier" ? ctx.local(right.text) : null;
        left.forEach((l, i) => {
          if (l.type === "identifier" && l.text !== "_") ctx.setLocal(l.text, i === 1 && t?.elem ? { ...t, elem: false } : null);
        });
        return;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const before = ctx.calls.length;
        if (fn?.type === "identifier") ctx.addCall(fn, { kind: "none" });
        else if (fn?.type === "selector_expression") {
          const field = fn.childForFieldName("field");
          const operand = fn.childForFieldName("operand");
          if (field && operand) ctx.addCall(field, goReceiver(ctx, operand), false, operand.type === "identifier" ? operand.text : undefined);
          // reflect's v.MethodByName(name): a call of the method of that name.
          if (field?.text === "MethodByName") ctx.addNameBuiltCall(node, node.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment"));
        } else if (fn?.type === "index_expression") {
          // handlers[key](x): a computed callee, maybe on a literal table.
          ctx.addDynamicCall(fn);
          const table = fn.childForFieldName("operand");
          if (table?.type === "identifier") ctx.tableCall(ctx.calls.length - 1, table.text);
        } else if (fn?.type === "call_expression") ctx.addResultCall(fn, fn);
        const call = ctx.noteCall(node, before);
        let i = 0;
        for (const a of node.childForFieldName("arguments")?.namedChildren ?? []) {
          if (a.type === "comment") continue;
          // A table passed to a function may be changed there.
          if (a.type === "identifier") ctx.tableUse(a.text);
          const v = goValueNode(ctx, a);
          if (v) ctx.addValue(v, "arg", call !== undefined ? { call, arg: i } : {});
          i++;
        }
        return;
      }
    }
  } });
  return ctx.facts();
}

// ---------- Java ----------

const JAVA_TYPES = new Set([
  "package_declaration",
  "import_declaration",
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
  "method_declaration",
  "constructor_declaration",
  "annotation_type_element_declaration",
  "field_declaration",
  "static_initializer",
  "class_body",
  "block",
  "constructor_body",
  "for_statement",
  "enhanced_for_statement",
  "catch_clause",
  "try_with_resources_statement",
  "switch_block",
  "switch_rule",
  "switch_block_statement_group",
  "type_pattern",
  "record_pattern_component",
  "constant_declaration",
  "enum_constant",
  "compact_constructor_declaration",
  "if_statement",
  "while_statement",
  "explicit_constructor_invocation",
  "local_variable_declaration",
  "instanceof_expression",
  "cast_expression",
  "lambda_expression",
  "method_invocation",
  "object_creation_expression",
  "method_reference",
  "assignment_expression",
]);

// Java reflection that finds a method by a name given at run time: the
// argument that names it and the type that finds it (`c.getMethod(name,
// ...)` on a Class, `lookup.findVirtual(c, name, type)` on a Lookup). -1:
// no name, every method (`c.getMethods()`). `getMethod` with no argument is
// another method (a servlet request's).
const JAVA_REFLECT = new Map<string, [number, string]>([["getMethod", [0, "Class"]], ["getDeclaredMethod", [0, "Class"]], ["getMethods", [-1, "Class"]], ["getDeclaredMethods", [-1, "Class"]], ["findVirtual", [1, "Lookup"]], ["findStatic", [1, "Lookup"]], ["findSpecial", [1, "Lookup"]]]);

// Whether a receiver may be of the type `want`: not when it is the class's
// own method (`getMethods()`, `this.getMethods()`: Class and Lookup are
// final, so no class of the repository is one), nor a field, a local or a
// parameter declared of another type. A receiver whose type is not known
// (a call's result, a class literal) may be.
function javaMayBe(ctx: Ctx, recv: Receiver, want: string): boolean {
  if (recv.kind === "self" && recv.path.length === 0) return false;
  const declared = recv.kind === "type" && recv.path.length === 0 ? recv.type : recv.kind === "self" && recv.path.length === 1 ? (ctx.cls()?.fieldTypes?.[recv.path[0] as string] ?? null) : null;
  return !declared || declared.result !== undefined || declared.name === want || declared.name.endsWith(`.${want}`);
}

// The keywords of a declaration's modifiers (`public`, `static`, `abstract`, `default`).
function javaModifiers(node: Node): Set<string> {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  return new Set(mods ? mods.children.filter((c) => !c.isNamed).map((c) => c.type) : []);
}

// Class and method parameters use their first bound. All names shadow outer parameters.
function javaTypeParams(node: Node): Map<string, TypeRef | null> | null {
  const list = node.childForFieldName("type_parameters");
  if (!list) return null;
  const out = new Map<string, TypeRef | null>();
  for (const tp of list.namedChildren) {
    const name = tp.type === "type_parameter" ? tp.namedChildren.find((c) => c.type === "type_identifier") : undefined;
    if (name) out.set(name.text, null);
  }
  const previous = enteringTypeParams;
  enteringTypeParams = out;
  for (const tp of list.namedChildren) {
    const name = tp.type === "type_parameter" ? tp.namedChildren.find((c) => c.type === "type_identifier") : undefined;
    const bound = tp.namedChildren.find((c) => c.type === "type_bound")?.firstNamedChild;
    if (name && bound) out.set(name.text, declared(javaTypeRef(bound)));
  }
  enteringTypeParams = previous;
  return out.size > 0 ? out : null;
}

// The names of a type written `a.b.C` in order, with the node of the last;
// null for anything that is not a plain or a scoped type name.
function javaTypeChain(node: Node | null): { names: string[]; last: Node; args?: Node } | null {
  if (!node) return null;
  if (node.type === "generic_type") {
    const head = javaTypeChain(node.namedChildren.find((c) => c.type === "type_identifier" || c.type === "scoped_type_identifier") ?? null);
    const args = node.namedChildren.find((c) => c.type === "type_arguments");
    return head ? { ...head, ...(args ? { args } : {}) } : null;
  }
  if (node.type === "type_identifier") return { names: [node.text], last: node };
  if (node.type !== "scoped_type_identifier") return null;
  const parts = node.namedChildren.filter((c) => c.type === "type_identifier" || c.type === "scoped_type_identifier");
  const head = javaTypeChain(parts[0] ?? null);
  const last = parts[parts.length - 1];
  if (!head || !last || parts.length !== 2 || last.type !== "type_identifier") return null;
  return { names: [...head.names, last.text], last };
}

// A declarator's own dimensions (`Foo xs[]`): the type is an array of what is written.
function javaDims(t: TypeRef | null, declarator: Node | null | undefined): TypeRef | null {
  return t && declarator?.childForFieldName("dimensions") ? { ...t, elem: true } : t;
}

// A field whose type names no class (a type parameter, a primitive): an
// entry that names nothing, so the field hides one of a base class.
function opaqueType(at: Node): TypeRef {
  return { name: "", qualifier: null, ...pos(at) };
}

// Local type names use the same scoped path in annotations, receivers and result qualifiers.
function javaScopedTypeNames(names: readonly string[]): string[] {
  const head = names[0] as string;
  for (let s = readingScope, steps = 0; s && steps <= MAX_SCOPE_DEPTH; s = s.parent, steps++) {
    const local = s.javaTypes?.get(head);
    if (local) return [...(local.qualifier ? local.qualifier.split(".") : []), local.name, ...names.slice(1)];
  }
  return [...names];
}

// A bound can be used inside arguments that already consumed part of the depth limit.
function javaBoundType(t: TypeRef, depth: number): TypeRef {
  return { ...t, args: depth < MAX_TYPE_DEPTH ? t.args?.map((a) => javaBoundType(a, depth + 1)) : undefined };
}

// Written types keep arguments. Parameters use their bound, or remain unknown without one.
function javaTypeRef(node: Node | null, depth = 0): TypeRef | null {
  if (!node || depth > MAX_TYPE_DEPTH) return null;
  if (node.type === "array_type") {
    const inner = javaTypeRef(node.childForFieldName("element"), depth + 1);
    return inner ? { ...inner, elem: true } : null;
  }
  if (node.type === "annotated_type") return javaTypeRef(node.namedChildren.find((c) => c.type !== "marker_annotation" && c.type !== "annotation") ?? null, depth + 1);
  const chain = javaTypeChain(node);
  if (!chain) return null;
  const name = chain.names[chain.names.length - 1] as string;
  if (chain.names.length === 1) {
    if (name === "var") return null;
    const bound = typeParam(name);
    // Nested bounds keep their head type to prevent exponential expansion.
    if (bound !== undefined) return bound ? (depth > 0 ? { ...bound, args: undefined } : javaBoundType(bound, depth)) : null;
  }
  const names = javaScopedTypeNames(chain.names);
  // Unknown arguments keep their slot, so later parameter indices never shift.
  const args = depth < MAX_TYPE_DEPTH ? chain.args?.namedChildren
    .filter((c) => c.type !== "line_comment" && c.type !== "block_comment")
    .map((c) => javaTypeRef(c, depth + 1) ?? opaqueType(c)) : undefined;
  return { name, qualifier: names.length > 1 ? names.slice(0, -1).join(".") : null, ...pos(node), ...(args ? { args } : {}) };
}

// Every named type in a written type, generic arguments included (`Map<K,
// List<V>>` names Map, K, List and V); type parameters are not.
function javaTypeNames(node: Node | null): TypeRef[] {
  const out: TypeRef[] = [];
  typeNodes(node, (n) => {
    if (n.type !== "type_identifier" && n.type !== "scoped_type_identifier") return false;
    const r = javaTypeRef(n);
    if (r) out.push(r);
    return true;
  });
  return out;
}

// A field belongs to the nearest class or to an enclosing instance.
function javaField(ctx: Ctx, name: string): "self" | "outer" | null {
  let first = true;
  for (let s: Scope | null = ctx.top; s; s = s.parent) {
    if (s.cls === null) continue;
    if (s.members?.has(name)) return first ? "self" : "outer";
    first = false;
  }
  return null;
}

// An identifier before a dot: a local's declared or constructed type, a
// field of this class, else a name the resolver looks up (a type, a package).
function javaLocalValue(ctx: Ctx, name: string): TypeRef | null | undefined {
  const at = ctx.lookup(ctx.top, name);
  // A nearer class's field hides a captured local, but not a local declared inside that class's method.
  for (let s: Scope | null = ctx.top; s && s !== at; s = s.parent) {
    if (s.members?.has(name)) return undefined;
  }
  return ctx.local(name);
}

function javaIdent(ctx: Ctx, name: string, path: string[]): Receiver {
  const t = javaLocalValue(ctx, name);
  if (t !== undefined) return t && !t.elem ? { kind: "type", type: t, path } : { kind: "other" };
  const field = javaField(ctx, name);
  if (field === "self") return { kind: "self", path: [name, ...path] };
  if (field === "outer") return { kind: "other" };
  const names = javaScopedTypeNames([name]);
  return { kind: "name", name: names[0] as string, path: [...names.slice(1), ...path], nesting: null };
}

// The declared type of a field of the nearest class.
function javaSelfFieldType(ctx: Ctx, name: string): TypeRef | null {
  if (javaField(ctx, name) !== "self") return null;
  for (let s: Scope | null = ctx.top; s; s = s.parent) if (s.cls !== null) return s.fieldTypes?.[name] ?? null;
  return null;
}

// `make()`, `this.make()` or `Type.make()`: typed by make's declared result,
// looked up when the graph is resolved. A method called on a value of a
// known type (a typed local or parameter, a field, a constructed value,
// another call whose type is known) carries that type in `on`.
function javaCallType(ctx: Ctx, call: Node, depth = 0): TypeRef | null {
  const name = call.childForFieldName("name");
  let object = call.childForFieldName("object");
  if (!name || depth > MAX_TYPE_DEPTH) return null;
  while (object?.type === "parenthesized_expression") object = object.firstNamedChild;
  if (!object || object.type === "this") return ctx.cls() ? { name: name.text, qualifier: null, ...pos(call), result: 0 } : null;
  const depthOf = (t: TypeRef): number => {
    const children = [...(t.args ?? []), ...(t.on ? [t.on] : [])];
    return children.reduce((max, child) => Math.max(max, 1 + depthOf(child)), 0);
  };
  // Past MAX_TYPE_DEPTH the type is not followed: the validator keeps the facts.
  const onValue = (on: TypeRef | null | undefined): TypeRef | null => (on && !on.elem && depthOf(on) < MAX_TYPE_DEPTH ? { name: name.text, qualifier: null, ...pos(call), result: 0, on } : null);
  if (object.type === "identifier") {
    const local = javaLocalValue(ctx, object.text);
    if (local !== undefined) return onValue(local);
    const field = javaField(ctx, object.text);
    if (field === "self") return onValue(javaSelfFieldType(ctx, object.text));
    if (field === "outer") return null;
    return { name: name.text, qualifier: javaScopedTypeNames([object.text]).join("."), ...pos(call), result: 0 };
  }
  if (object.type === "field_access" && object.childForFieldName("object")?.type === "this" && ctx.cls()) {
    const field = object.childForFieldName("field");
    return field?.type === "identifier" ? onValue(javaSelfFieldType(ctx, field.text)) : null;
  }
  if (object.type === "method_invocation") return onValue(javaCallType(ctx, object, depth + 1));
  if (object.type === "object_creation_expression") return onValue(javaValueType(ctx, object));
  return null;
}

// What a value's type is known to be: a constructed class, a cast, a call's declared result.
function javaValueType(ctx: Ctx, value: Node | null): TypeRef | null {
  let v = value;
  while (v?.type === "parenthesized_expression") v = v.firstNamedChild;
  if (v?.type === "object_creation_expression") return v.namedChildren.some((c) => c.type === "class_body") ? null : javaTypeRef(v.childForFieldName("type"));
  if (v?.type === "cast_expression") return declared(javaTypeRef(v.childForFieldName("type")));
  if (v?.type === "method_invocation") return javaCallType(ctx, v);
  return null;
}

// The receiver of `a.b.m()`: the object flattened to a base and a path.
function javaReceiver(ctx: Ctx, object: Node): Receiver {
  const path: string[] = [];
  let base: Node | null = object;
  while (base?.type === "field_access") {
    const field = base.childForFieldName("field");
    if (field?.type === "this") {
      const type = javaTypeRef(base.childForFieldName("object"));
      // The qualifier of `Outer.this` is an expression name in the grammar.
      const qualifier = base.childForFieldName("object");
      const names = qualifier?.text.replace(/\s+/g, "").split(".");
      for (let s = ctx.cls(); s; s = s.parent?.clsScope ?? null) {
        const d = ctx.defs[s.def];
        if (!d || !names || (d.name !== names.join(".") && s.cls !== names.join("."))) continue;
        return { kind: "type", type: type ?? { name: d.name, qualifier: d.owner, ...pos(base) }, path };
      }
      return { kind: "other" };
    }
    // A qualified super receiver is not read.
    if (field?.type !== "identifier") return { kind: "other" };
    path.unshift(field.text);
    base = base.childForFieldName("object");
  }
  while (base?.type === "parenthesized_expression") base = base.firstNamedChild;
  switch (base?.type) {
    case "this":
      return ctx.cls() ? { kind: "self", path } : { kind: "other" };
    case "super":
      return path.length === 0 && ctx.cls() ? { kind: "super" } : { kind: "other" };
    case "identifier":
      return javaIdent(ctx, base.text, path);
    case "method_invocation":
    case "object_creation_expression":
    case "cast_expression": {
      const type = javaValueType(ctx, base);
      return type ? { kind: "type", type, path } : { kind: "other" };
    }
    default:
      return { kind: "other" };
  }
}

// The receiver that names a type written in place (`new a.b.T()`, `T::m`).
function javaTypeReceiver(chain: { names: string[] }): Receiver {
  const names = javaScopedTypeNames(chain.names);
  return { kind: "name", name: names[0] as string, path: names.slice(1), nesting: null };
}

function extractJava(tree: Tree, readers: readonly TreeVisitor[]): FileFacts {
  const ctx = new Ctx("java");
  let javaPackage: string | null = null;
  // Inside a static field's initializer or a static initializer block: a
  // call there runs on the class, one in an instance initializer on an instance.
  let staticInit = 0;
  // Each call node's call, by the node's end (a call and its receiver call start at one place).
  const callAt = new Map<number, number>();
  // A method called on an identifier: when the name is a parameter of its
  // method, decided once the body is read (it may be assigned below).
  const paramCalls: { name: string; scope: Scope }[] = [];
  const blockFrame = (locals = new Map<string, TypeRef | null>()): Leave => ctx.push({ def: -1, cls: null, locals, block: true });
  // Pattern names stay local when their typed scope ends.
  const patternNames = new Map<Scope, Set<string>>();
  type PatternBinding = { type: TypeRef | null; negated: boolean; supported: boolean };
  type PatternFlow = {
    frame: Scope;
    condition: Node;
    consequence: Node | null;
    alternative: Node | null;
    patterns: Map<string, PatternBinding>;
    phase: "condition" | "consequence" | "alternative";
  };
  const patternFlows: PatternFlow[] = [];
  const notePattern = (frame: Scope, name: string) => {
    let names = patternNames.get(frame);
    if (!names) patternNames.set(frame, (names = new Set()));
    names.add(name);
  };
  const endPatterns = (leave: Leave, frame: Scope, surviving?: ReadonlyMap<string, TypeRef | null>) => {
    leave();
    for (const name of patternNames.get(frame) ?? []) {
      ctx.setLocal(name, surviving?.get(name) ?? null, true);
      notePattern(ctx.top.decl, name);
    }
    patternNames.delete(frame);
  };
  const bindPattern = (node: Node, name: string, type: TypeRef | null) => {
    const frame = ctx.top.decl;
    const flow = patternFlows[patternFlows.length - 1];
    let binding: PatternBinding | null = null;
    if (flow?.frame === frame && node.startIndex >= flow.condition.startIndex && node.endIndex <= flow.condition.endIndex) {
      binding = { type, negated: false, supported: true };
      // Record components start inside the pattern expression.
      let expression: Node | null = node;
      while (expression && expression.id !== flow.condition.id && expression.type !== "instanceof_expression") expression = expression.parent;
      binding.supported = expression?.type === "instanceof_expression";
      for (let at = expression?.parent; binding.supported && at && at.id !== flow.condition.id; at = at.parent) {
        const operator = at.childForFieldName("operator")?.text;
        if (at.type === "parenthesized_expression") continue;
        if (at.type === "unary_expression" && operator === "!") {
          binding.negated = !binding.negated;
          continue;
        }
        if (at.type === "binary_expression" && operator === "&&" && !binding.negated) continue;
        binding.supported = false;
      }
      if (!binding.supported) binding.type = null;
      flow.patterns.set(name, binding);
    }
    ctx.setLocal(name, binding?.negated || binding?.supported === false ? null : type, true);
    notePattern(frame, name);
  };
  // Read the branch boundary before extracting its first relevant node.
  const enterPatternBranch = (node: Node) => {
    const flow = patternFlows[patternFlows.length - 1];
    if (!flow || node.startIndex < flow.condition.endIndex) return;
    const phase = flow.alternative && node.startIndex >= flow.alternative.startIndex ? "alternative" : "consequence";
    if (phase === flow.phase) return;
    flow.phase = phase;
    const branch = phase === "alternative" ? flow.alternative : flow.consequence;
    // Block branches keep separate maps for value references resolved after the walk.
    const branchLocals = branch?.type === "block" && branch.id === node.id ? new Map<string, TypeRef | null>() : undefined;
    const locals = branchLocals ?? flow.frame.locals;
    for (const [name, binding] of flow.patterns) {
      const visible = binding.supported && binding.negated === (phase === "alternative");
      locals?.set(name, visible ? binding.type : null);
    }
    return branchLocals;
  };
  const completesAbruptly = (branch: Node | null): boolean => {
    let last = branch;
    let read = 0;
    while (last?.type === "block") {
      if (++read > MAX_TYPE_NODES) return false;
      let statement: Node | null = null;
      for (let i = last.namedChildCount - 1; i >= 0; i--) {
        if (++read > MAX_TYPE_NODES) return false;
        const child = last.namedChild(i);
        if (child && child.type !== "line_comment" && child.type !== "block_comment") {
          statement = child;
          break;
        }
      }
      last = statement;
    }
    return last !== null && ["return_statement", "throw_statement", "break_statement", "continue_statement"].includes(last.type);
  };
  const breakBoundaries = new Set([
    "for_statement", "enhanced_for_statement", "while_statement", "do_statement",
    "switch_expression", "switch_statement", "lambda_expression", "class_body", "enum_body",
  ]);
  const loopCanBreak = (body: Node | null): boolean => {
    const stack = body ? [{ node: body, nested: false }] : [];
    let read = 0;
    while (stack.length > 0) {
      if (++read > MAX_TYPE_NODES) return true;
      const { node, nested } = stack.pop()!;
      if (node.type === "break_statement") {
        // A labeled break may target this loop from a nested statement.
        if (!nested || node.namedChildren.some((c) => c.type === "identifier")) return true;
        continue;
      }
      const inside = nested || breakBoundaries.has(node.type);
      for (let i = 0; i < node.namedChildCount; i++) {
        if (read + stack.length >= MAX_TYPE_NODES) return true;
        const child = node.namedChild(i);
        if (child) stack.push({ node: child, nested: inside });
      }
    }
    return false;
  };
  const breaksAnyLabel = (body: Node | null, labels: ReadonlySet<string>): boolean => {
    if (labels.size === 0) return false;
    const stack = body ? [body] : [];
    let read = 0;
    while (stack.length > 0) {
      if (++read > MAX_TYPE_NODES) return true;
      const node = stack.pop()!;
      // Breaks cannot cross a class or lambda boundary.
      if (["lambda_expression", "class_body", "enum_body", "interface_body", "annotation_type_body"].includes(node.type)) continue;
      if (node.type === "break_statement") {
        const label = node.namedChildren.find((c) => c.type === "identifier");
        if (label && labels.has(label.text)) return true;
        continue;
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        if (read + stack.length >= MAX_TYPE_NODES) return true;
        const child = node.namedChild(i);
        if (child) stack.push(child);
      }
    }
    return false;
  };
  let anonymous = 0;
  const localTypes = new Map<string, Map<string, number>>();
  const typeUses = (node: Node | null, caller: number) => {
    for (const r of javaTypeNames(node)) ctx.addTypeUse(r, caller);
  };
  // The parameters of a method, a constructor or a lambda: each a local
  // with its declared type, the names in order, and whether the last is varargs.
  const params = (list: Node | null, locals: Map<string, TypeRef | null>, user: number): { names: string[]; varargs: boolean } => {
    const names: string[] = [];
    let varargs = false;
    for (const p of list?.namedChildren ?? []) {
      if (p.type === "formal_parameter") {
        const name = p.childForFieldName("name");
        const typeNode = p.childForFieldName("type");
        typeUses(typeNode, user);
        if (!name) continue;
        locals.set(name.text, declared(javaDims(javaTypeRef(typeNode), p)));
        names.push(name.text);
      } else if (p.type === "spread_parameter") {
        const typeNode = p.namedChildren.find((c) => c.type !== "modifiers" && c.type !== "variable_declarator") ?? null;
        const name = p.namedChildren.find((c) => c.type === "variable_declarator")?.childForFieldName("name");
        typeUses(typeNode, user);
        varargs = true;
        if (!name) continue;
        const t = javaTypeRef(typeNode);
        locals.set(name.text, t ? { ...t, elem: true, declared: true } : null);
        names.push(name.text);
      }
    }
    return { names, varargs };
  };
  // A call: its argument count when the list parsed, and whether it runs on the class.
  const addCall = (nameNode: Node, recv: Receiver, args: Node | null, callNode: Node): number => {
    const object = callNode.childForFieldName("object");
    const receiverName = object?.type === "identifier" && javaLocalValue(ctx, object.text) !== undefined ? object.text : undefined;
    const index = ctx.addCall(nameNode, recv, false, receiverName);
    const call = ctx.calls[index] as CallFact;
    if (args && !args.hasError) call.arity = args.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment").length;
    const callerDef = call.caller >= 0 ? ctx.defs[call.caller] : undefined;
    if (callerDef?.kind === "class") {
      if (staticInit > 0) call.static = true;
      else delete call.static;
    }
    callAt.set(callNode.endIndex, index);
    return index;
  };
  // Named and anonymous types share field collection and member ownership.
  const typeBody = (node: Node, body: Node | null, def: number, qualified: string, typeParams?: Map<string, TypeRef | null> | null): Leave => {
    const fields = (ctx.defs[def] as DefFact).fields;
    const members = new Set<string>();
    const leave = ctx.push({ def, cls: qualified, locals: null, members, fieldTypes: fields, ...(typeParams ? { typeParams } : {}) });
    // Fields are read first so methods can use fields declared below them.
    const decls = (body?.namedChildren ?? []).flatMap((c) => (c.type === "enum_body_declarations" ? c.namedChildren : [c]));
    for (const f of decls) {
      if (f.type === "enum_constant") {
        const n = f.childForFieldName("name");
        if (!n) continue;
        const owner = ctx.defs[def] as DefFact;
        const hasBody = f.namedChildren.some((c) => c.type === "class_body");
        members.add(n.text);
        fields[n.text] = { name: hasBody ? n.text : owner.name, qualifier: hasBody ? qualified : owner.owner, ...pos(n) };
        continue;
      }
      if (f.type !== "field_declaration" && f.type !== "constant_declaration") continue;
      const typeNode = f.childForFieldName("type");
      const type = javaTypeRef(typeNode);
      typeUses(typeNode, def);
      for (const d of f.childrenForFieldName("declarator")) {
        const n = d.childForFieldName("name");
        if (!n) continue;
        members.add(n.text);
        fields[n.text] = javaDims(type, d) ?? opaqueType(n);
      }
    }
    for (const p of node.type === "record_declaration" ? (node.childForFieldName("parameters")?.namedChildren ?? []) : []) {
      if (p.type !== "formal_parameter") continue;
      const n = p.childForFieldName("name");
      const typeNode = p.childForFieldName("type");
      const type = javaTypeRef(typeNode);
      typeUses(typeNode, def);
      if (!n) continue;
      members.add(n.text);
      fields[n.text] = type ?? opaqueType(n);
    }
    return leave;
  };
  // Same-named local types use source-order ordinals within their enclosing scope.
  const typeDecl = (node: Node): Leave => {
    const name = node.childForFieldName("name");
    if (!name) return blockFrame();
    const local = ctx.top.depth > 0 && ctx.top.cls === null;
    let outer = ctx.cls()?.cls ?? null;
    if (local) {
      const owner = ctx.ownerName() ?? outer ?? "";
      const scope = ctx.defs[ctx.caller()]?.kind === "class" ? `${owner}.<init>` : owner;
      let names = localTypes.get(scope);
      if (!names) localTypes.set(scope, (names = new Map()));
      const ordinal = (names.get(name.text) ?? 0) + 1;
      names.set(name.text, ordinal);
      outer = ordinal === 1 ? scope : `${scope}$${ordinal}`;
      (ctx.top.decl.javaTypes ??= new Map()).set(name.text, { name: name.text, qualifier: outer, ...pos(name) });
    }
    const typeParams = javaTypeParams(node);
    enteringTypeParams = typeParams;
    const bases: TypeRef[] = [];
    const baseNodes: Node[] = [];
    const take = (list: Node | null | undefined, rel?: "implements") => {
      const types = list?.type === "type_list" ? list.namedChildren : list ? [list] : [];
      for (const t of types) {
        baseNodes.push(t);
        const ref = javaTypeRef(t);
        if (ref) bases.push(rel ? { ...ref, rel } : ref);
      }
    };
    take(node.childForFieldName("superclass")?.namedChildren[0]);
    take(node.childForFieldName("interfaces")?.namedChildren[0], "implements");
    // An interface's `extends` are all its bases.
    take(node.namedChildren.find((c) => c.type === "extends_interfaces")?.namedChildren[0]);
    enteringTypeParams = null;
    const iface = node.type === "interface_declaration" || node.type === "annotation_type_declaration";
    const fields: Record<string, TypeRef> = {};
    const def = ctx.addDef(node, name, "class", { owner: outer, topLevel: ctx.top.depth === 0, exported: javaModifiers(node).has("public"), bases, fields, ...(iface ? { iface: true } : {}) });
    const leave = typeBody(node, node.childForFieldName("body"), def, outer ? `${outer}.${name.text}` : name.text, typeParams);
    for (const b of baseNodes) typeUses(b, def);
    return leave;
  };
  // A method, a constructor or an annotation element: a definition when
  // it stands directly in a named type, else its body is the enclosing method's.
  const method = (node: Node): Leave => {
    const cls = ctx.top.cls !== null ? ctx.top : null;
    const name = node.childForFieldName("name");
    const typeParams = javaTypeParams(node);
    const locals = new Map<string, TypeRef | null>();
    const frame = (def: number): Leave => ctx.push({ def, cls: null, locals, ...(typeParams ? { typeParams } : {}) });
    enteringTypeParams = typeParams;
    if (!cls || !name) {
      params(node.childForFieldName("parameters"), locals, ctx.caller());
      typeUses(node.childForFieldName("type"), ctx.caller());
      enteringTypeParams = null;
      return frame(-1);
    }
    const owner = ctx.defs[cls.def] as DefFact;
    const mods = javaModifiers(node);
    const inIface = owner.iface === true;
    const compact = node.type === "compact_constructor_declaration";
    const isCtor = node.type === "constructor_declaration" || compact;
    const body = node.childForFieldName("body");
    const typeNode = node.childForFieldName("type");
    const resultName = typeNode?.type === "type_identifier" ? typeNode.text : null;
    const param = resultName && !typeParams?.has(resultName) ? [...(cls.typeParams?.keys() ?? [])].indexOf(resultName) : -1;
    const result: TypeRef | null = param >= 0 && typeNode
      ? { kind: "param", name: resultName as string, qualifier: null, ...pos(typeNode), param }
      : javaTypeRef(typeNode);
    const results = isCtor ? [{ name: owner.name, qualifier: owner.owner, ...pos(name) }] : [result];
    const def = ctx.addDef(node, name, "method", {
      owner: cls.cls,
      exported: mods.has("public") || (inIface && !mods.has("private")),
      results,
      ...(mods.has("static") && !isCtor ? { static: true } : {}),
      ...(mods.has("abstract") || (inIface && !body) ? { abstract: true } : {}),
      ...(isCtor ? { ctor: true } : {}),
    });
    // A record's compact constructor takes the record's components.
    const sig = params(compact ? (node.parent?.parent?.childForFieldName("parameters") ?? null) : node.childForFieldName("parameters"), locals, def);
    typeUses(typeNode, def);
    enteringTypeParams = null;
    const d = ctx.defs[def] as DefFact;
    d.params = sig.names;
    if (sig.varargs) d.varargs = true;
    return frame(def);
  };
  // A method reference (`T::m`, `this::m`, `x::m`): a value reference with its receiver.
  const methodRef = (node: Node) => {
    const kids = node.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment");
    const name = kids[kids.length - 1];
    const target = kids[0];
    // `T::new` names a constructor, not a method: not read in this version.
    if (!name || !target || kids.length !== 2 || name.type !== "identifier") return;
    const chain = target.type === "identifier" ? null : javaTypeChain(target);
    const recv = chain ? javaTypeReceiver(chain) : javaReceiver(ctx, target);
    if (recv.kind === "other") return;
    const parent = node.parent;
    if (parent?.type === "argument_list") {
      const call = parent.parent ? callAt.get(parent.parent.endIndex) : undefined;
      const arg = parent.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment").findIndex((c) => c.startIndex === node.startIndex);
      ctx.addValue({ name, recv }, "arg", call !== undefined ? { call, arg } : {});
    } else if (parent?.type === "return_statement") {
      const ref = ctx.addValue({ name, recv }, "return");
      const owner = ctx.top.fnDecl.def;
      if (owner >= 0) ((ctx.defs[owner] as DefFact).returns ??= []).push(ref);
    } else {
      const ref = ctx.addValue({ name, recv }, "assign");
      const local = parent?.type === "variable_declarator" && parent.parent?.type === "local_variable_declaration"
        ? parent.childForFieldName("name") : null;
      if (local) ctx.noteAssign(local.text, { ref }, true, true);
    }
  };
  walkTree(tree.rootNode, readers, { interesting: JAVA_TYPES, visit: (node) => {
    const branchLocals = enterPatternBranch(node);
    switch (node.type) {
      case "package_declaration": {
        const id = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
        javaPackage = id ? id.text.replace(/\s+/g, "") : null;
        return false;
      }
      case "import_declaration": {
        const id = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
        if (!id) return false;
        const parts = id.text.replace(/\s+/g, "").split(".");
        const isStatic = node.children.some((c) => c.type === "static");
        const star = node.namedChildren.some((c) => c.type === "asterisk");
        // The class an import names: the last part, or the one before a static member.
        const clsAt = parts.length - (isStatic && !star ? 2 : 1);
        if (clsAt < 0) return false;
        const fact: ImportFact = { spec: "", ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false };
        if (star && !isStatic) {
          fact.spec = parts.join(".");
          fact.star = true;
        } else {
          const cls = parts[clsAt] as string;
          fact.spec = parts.slice(0, clsAt).join(".");
          fact.names.push({ imported: cls, local: cls });
          if (isStatic && star) fact.staticStar = true;
          else if (isStatic) fact.staticMember = parts[parts.length - 1] as string;
        }
        ctx.imports.push(fact);
        return false;
      }
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "record_declaration":
      case "annotation_type_declaration":
        return typeDecl(node);
      case "method_declaration":
      case "constructor_declaration":
      case "compact_constructor_declaration":
      case "annotation_type_element_declaration":
        return method(node);
      // An interface constant and an enum constant's arguments run on the
      // type itself, as a static initializer does.
      case "constant_declaration":
      case "enum_constant": {
        const leave = blockFrame();
        staticInit++;
        return () => {
          staticInit--;
          leave();
        };
      }
      // A case's pattern variables (`case Circle c ->`) end with the case.
      case "switch_rule":
      case "switch_block_statement_group": {
        const leave = blockFrame();
        const frame = ctx.top.decl;
        return () => endPatterns(leave, frame);
      }
      // `case Circle c`, and each component of a record pattern
      // (`o instanceof Point(int x, Svc y)`): a local of that type.
      case "type_pattern":
      case "record_pattern_component": {
        const typeNode = node.namedChildren[0] ?? null;
        const name = node.namedChildren[node.namedChildren.length - 1];
        typeUses(typeNode, ctx.caller());
        if (!name || name.type !== "identifier" || name === typeNode) return;
        bindPattern(node, name.text, declared(javaTypeRef(typeNode)));
        return;
      }
      case "field_declaration":
      case "static_initializer": {
        // A field's initializers have a scope of their own: a pattern
        // variable there never reaches the rest of the class.
        const leave = node.type === "field_declaration" ? blockFrame() : null;
        const isStatic = node.type === "static_initializer" || javaModifiers(node).has("static");
        if (isStatic) staticInit++;
        return () => {
          if (isStatic) staticInit--;
          leave?.();
        };
      }
      case "class_body": {
        const parent = node.parent;
        if (parent?.type !== "enum_constant" && parent?.type !== "object_creation_expression") return;
        const outer = ctx.cls()?.cls ?? null;
        const constant = parent.type === "enum_constant";
        const name = constant ? parent.childForFieldName("name")?.text : `$${++anonymous}`;
        if (!name) return blockFrame();
        const base = constant && outer
          ? { name: (ctx.defs[ctx.cls()?.def ?? -1] as DefFact).name, qualifier: (ctx.defs[ctx.cls()?.def ?? -1] as DefFact).owner, ...pos(parent) }
          : javaTypeRef(parent.childForFieldName("type"));
        const def = ctx.addDef(node, node, "class", { name, owner: outer, bases: base ? [base] : [], anonymous: true });
        delete (ctx.defs[def] as DefFact).bodyHash;
        const saved = staticInit;
        staticInit = 0;
        const leave = typeBody(node, node, def, outer ? `${outer}.${name}` : name);
        return () => {
          leave();
          staticInit = saved;
        };
      }
      case "block":
      case "constructor_body":
      case "for_statement":
      case "switch_block": {
        const leave = blockFrame(branchLocals);
        const frame = ctx.top.decl;
        return () => endPatterns(leave, frame);
      }
      // Negated patterns bind in the alternative or after a guard that exits.
      case "if_statement":
      case "while_statement": {
        const leave = blockFrame();
        const frame = ctx.top.decl;
        const condition = node.childForFieldName("condition");
        if (!condition) return () => endPatterns(leave, frame);
        const flow: PatternFlow = {
          frame, condition, consequence: node.childForFieldName("consequence") ?? node.childForFieldName("body"),
          alternative: node.childForFieldName("alternative"), patterns: new Map(), phase: "condition",
        };
        patternFlows.push(flow);
        return () => {
          patternFlows.pop();
          const surviving = new Map<string, TypeRef | null>();
          for (const [name, binding] of flow.patterns) {
            if (binding.negated && binding.supported) surviving.set(name, binding.type);
          }
          if (surviving.size > 0) {
            let container = node.parent;
            const labels = new Set<string>();
            while (container?.type === "labeled_statement") {
              const label = container.namedChildren.find((c) => c.type === "identifier");
              if (label) labels.add(label.text);
              container = container.parent;
            }
            const inBlock = container !== null && ["block", "constructor_body", "switch_block_statement_group"].includes(container.type);
            const survives = inBlock && !breaksAnyLabel(flow.consequence, labels)
              && (node.type === "while_statement" ? !loopCanBreak(flow.consequence) : completesAbruptly(flow.consequence));
            if (!survives) surviving.clear();
          }
          endPatterns(leave, frame, surviving);
        };
      }
      case "explicit_constructor_invocation": {
        // `this(...)` and `super(...)`: a constructor call on the own class or the superclass.
        const kw = node.childForFieldName("constructor");
        const cls = ctx.cls();
        const owner = cls ? ctx.defs[cls.def] : undefined;
        if (!kw || !owner) return;
        const isSuper = kw.type === "super";
        const name = isSuper ? owner.bases.find((b) => b.rel === undefined)?.name : owner.name;
        if (name === undefined || (kw.type !== "this" && !isSuper)) return;
        const index = addCall(kw, isSuper ? { kind: "super" } : { kind: "self", path: [] }, node.childForFieldName("arguments"), node);
        const call = ctx.calls[index] as CallFact;
        call.name = name;
        call.ctor = true;
        return;
      }
      case "enhanced_for_statement": {
        const leave = blockFrame();
        const name = node.childForFieldName("name");
        const typeNode = node.childForFieldName("type");
        typeUses(typeNode, ctx.caller());
        if (name) ctx.setLocal(name.text, declared(javaTypeRef(typeNode)), true);
        return leave;
      }
      case "catch_clause": {
        const leave = blockFrame();
        const param = node.namedChildren.find((c) => c.type === "catch_formal_parameter");
        const types = param?.namedChildren.find((c) => c.type === "catch_type")?.namedChildren ?? [];
        for (const t of types) typeUses(t, ctx.caller());
        const name = param?.childForFieldName("name");
        // A multi-catch parameter has no one type.
        if (name) ctx.setLocal(name.text, types.length === 1 ? declared(javaTypeRef(types[0] as Node)) : null, true);
        return leave;
      }
      case "try_with_resources_statement": {
        const leave = blockFrame();
        for (const r of node.childForFieldName("resources")?.namedChildren ?? []) {
          const name = r.type === "resource" ? r.childForFieldName("name") : null;
          if (!name) continue;
          const typeNode = r.childForFieldName("type");
          typeUses(typeNode, ctx.caller());
          ctx.setLocal(name.text, typeNode?.text === "var" ? javaValueType(ctx, r.childForFieldName("value")) : declared(javaTypeRef(typeNode)), true);
        }
        return leave;
      }
      case "local_variable_declaration": {
        const typeNode = node.childForFieldName("type");
        typeUses(typeNode, ctx.caller());
        const isVar = typeNode?.text === "var";
        const type = isVar ? null : declared(javaTypeRef(typeNode));
        for (const d of node.childrenForFieldName("declarator")) {
          const name = d.childForFieldName("name");
          if (name) ctx.setLocal(name.text, isVar ? javaValueType(ctx, d.childForFieldName("value")) : javaDims(type, d), true);
        }
        return;
      }
      case "assignment_expression": {
        // A local given another value; a parameter no longer holds what the caller passed.
        const left = node.childForFieldName("left");
        if (left?.type !== "identifier" || javaLocalValue(ctx, left.text) === undefined) return;
        // A Java local's type is fixed where it is declared (a `var` by its
        // first value). Reassignment ends the original callable alias.
        ctx.reassign(left.text);
        return;
      }
      case "instanceof_expression": {
        const typeNode = node.childForFieldName("right");
        typeUses(typeNode, ctx.caller());
        // `o instanceof Svc s`: s is a Svc where the test holds.
        const name = node.childForFieldName("name");
        if (name) {
          bindPattern(node, name.text, declared(javaTypeRef(typeNode)));
        }
        return;
      }
      case "cast_expression":
        typeUses(node.childForFieldName("type"), ctx.caller());
        return;
      case "lambda_expression": {
        // A lambda's calls belong to the enclosing method; its `this` is that method's.
        const locals = new Map<string, TypeRef | null>();
        const list = node.childForFieldName("parameters");
        if (list?.type === "identifier") locals.set(list.text, null);
        else if (list?.type === "inferred_parameters") for (const p of list.namedChildren) locals.set(p.text, null);
        else params(list, locals, ctx.caller());
        return ctx.push({ def: -1, cls: null, locals });
      }
      case "method_invocation": {
        const name = node.childForFieldName("name");
        const object = node.childForFieldName("object");
        if (!name) return;
        const recv: Receiver = object ? javaReceiver(ctx, object) : ctx.cls() ? { kind: "self", path: [] } : { kind: "other" };
        addCall(name, recv, node.childForFieldName("arguments"), node);
        if (object?.type === "identifier" && javaLocalValue(ctx, object.text) !== undefined) paramCalls.push({ name: object.text, scope: ctx.top });
        // Reflection: a method found by a name given at run time.
        const reflect = JAVA_REFLECT.get(name.text);
        const args = node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment") ?? [];
        if (reflect && (reflect[0] < 0 ? args.length === 0 : args.length > reflect[0]) && javaMayBe(ctx, recv, reflect[1])) ctx.addNameBuiltCall(node, args[reflect[0]]);
        return;
      }
      case "object_creation_expression": {
        // `new T(args)`: a call named T on the receiver that names T.
        const typeNode = node.childForFieldName("type");
        typeUses(typeNode, ctx.caller());
        const chain = javaTypeChain(typeNode);
        const type = javaTypeRef(typeNode);
        const scoped = type && chain && type.qualifier !== (chain.names.slice(0, -1).join(".") || null);
        const recv = scoped ? { kind: "type" as const, type, path: [] } : chain ? javaTypeReceiver(chain) : null;
        if (chain && recv) (ctx.calls[addCall(chain.last, recv, node.childForFieldName("arguments"), node)] as CallFact).ctor = true;
        return;
      }
      case "method_reference":
        methodRef(node);
        return;
    }
  } });
  // A method called on a parameter of its method: the method calls what it is given there.
  for (const { name, scope } of paramCalls) {
    const at = ctx.lookup(scope, name);
    if (!at || at.block || at.def < 0 || at.reassigned?.has(name) || !at.locals?.has(name)) continue;
    const owner = ctx.defs[at.def] as DefFact;
    const param = owner.params?.indexOf(name) ?? -1;
    if (param >= 0 && !owner.invokes?.includes(param)) (owner.invokes ??= []).push(param);
  }
  return { ...ctx.facts(), javaPackage };
}

// ---------- Ruby ----------

const RB_TYPES = new Set(["class", "module", "method", "singleton_method", "call", "assignment", "identifier", "block", "do_block", "lambda"]);

// Where a bare identifier can only be a value: a local or a method call.
const RB_VALUE_PARENTS = new Set([
  "body_statement",
  "then",
  "else",
  "argument_list",
  "binary",
  "parenthesized_statements",
  "return",
  "array",
  "interpolation",
  "conditional",
  "if",
  "unless",
  "while",
  "until",
  "if_modifier",
  "unless_modifier",
]);

function rbQualify(nesting: string | null, name: string): string {
  const n = name.replace(/^::/, "");
  return nesting && !name.startsWith("::") ? `${nesting}::${n}` : n;
}

// Calls Ruby makes by a name in a symbol or a string: `items.each(&:save)`
// calls `save` on each item, `send(:save)` and `method(:save)` name it. A
// literal name is an unbound call of that name; `send(name)` with a name
// built at run time is a call through a value. `respond_to?(:save)` only
// asks whether the method is there: no call.
const RB_SENDS = new Set(["send", "public_send", "__send__", "method", "public_method", "instance_method", "try"]);
function rbNamedCalls(ctx: Ctx, node: Node, method: Node): void {
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const named = (at: Node, name: string) => {
    const i = ctx.addCall(at, { kind: "other" });
    (ctx.calls[i] as CallFact).name = name;
  };
  for (const a of args) {
    const sym = a.type === "block_argument" ? a.firstNamedChild : null;
    if (sym?.type === "simple_symbol") named(sym, sym.text.slice(1));
  }
  if (!RB_SENDS.has(method.text)) return;
  const first = args.find((a) => a.type !== "comment");
  if (!first) return;
  if (first.type === "simple_symbol") {
    named(first, first.text.slice(1));
    (ctx.calls[ctx.calls.length - 1] as CallFact).byName = true;
  }
  // A string names the method only when it reads as a name, never a key.
  else ctx.addNameBuiltCall(node, first);
}

function extractRuby(tree: Tree, readers: readonly TreeVisitor[]): FileFacts {
  const ctx = new Ctx("ruby");
  const nesting = () => ctx.cls()?.cls ?? null;
  const methodLocals = (node: Node): Map<string, TypeRef | null> => {
    const locals = new Map<string, TypeRef | null>();
    for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
      const id = p.type === "identifier" ? p : p.childForFieldName("name");
      if (id) locals.set(id.text, null);
    }
    return locals;
  };
  const classLike = (node: Node, kind: "class" | "module"): Leave | false => {
    const name = node.childForFieldName("name");
    if (!name) return false;
    const outer = nesting();
    const full = rbQualify(outer, name.text);
    const cut = full.lastIndexOf("::");
    const owner = cut === -1 ? null : full.slice(0, cut);
    const nameNode = name.type === "scope_resolution" ? (name.childForFieldName("name") ?? name) : name;
    const bases: TypeRef[] = [];
    const sup = node.childForFieldName("superclass")?.firstNamedChild;
    if (sup && (sup.type === "constant" || sup.type === "scope_resolution")) bases.push({ name: sup.text, qualifier: outer, ...pos(sup) });
    // A superclass made by an expression (`< Struct.new(:a)`): what it extends is not known.
    const dynamicBases = sup && !(sup.type === "constant" || sup.type === "scope_resolution") ? [pos(sup)] : [];
    const def = ctx.addDef(node, nameNode, kind, { owner, topLevel: true, exported: true, bases, ...(dynamicBases.length > 0 ? { dynamicBases } : {}) });
    return ctx.push({ def, cls: full, locals: null });
  };
  walkTree(tree.rootNode, readers, { interesting: RB_TYPES, visit: (node) => {
    switch (node.type) {
      case "class":
        return classLike(node, "class");
      case "module":
        return classLike(node, "module");
      case "method":
      case "singleton_method": {
        const name = node.childForFieldName("name");
        const locals = methodLocals(node);
        if (!name) return ctx.push({ def: -1, cls: null, locals });
        const owner = nesting();
        const def = ctx.addDef(node, name, owner ? "method" : "function", { owner, topLevel: owner === null, exported: true, static: node.type === "singleton_method" });
        return ctx.push({ def, cls: null, locals });
      }
      case "block":
      case "do_block":
      case "lambda": {
        const locals = new Map<string, TypeRef | null>();
        const params = node.childForFieldName("parameters") ?? node.namedChildren.find((c) => c.type === "block_parameters");
        for (const p of params?.namedChildren ?? []) {
          const id = p.type === "identifier" ? p : p.childForFieldName("name");
          if (id) locals.set(id.text, null);
        }
        return ctx.push({ def: -1, cls: null, locals });
      }
      case "assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        let type: TypeRef | null = null;
        if (right?.type === "call" && right.childForFieldName("method")?.text === "new") {
          const recv = right.childForFieldName("receiver");
          if (recv && (recv.type === "constant" || recv.type === "scope_resolution")) type = { name: recv.text, qualifier: nesting(), ...pos(recv) };
        }
        if (left?.type === "identifier") ctx.assign(left.text, type);
        else if (left?.type === "instance_variable" && type) {
          const cls = ctx.cls();
          if (cls && cls.def >= 0) (ctx.defs[cls.def] as DefFact).fields[left.text] = type;
        }
        return;
      }
      case "call": {
        const method = node.childForFieldName("method");
        if (!method) return;
        rbNamedCalls(ctx, node, method);
        const recv = node.childForFieldName("receiver");
        if (!recv) {
          const args = node.childForFieldName("arguments")?.namedChildren ?? [];
          if ((method.text === "require" || method.text === "require_relative") && args[0]?.type === "string") {
            const content = args[0].namedChildren.find((c) => c.type === "string_content");
            if (content) {
              ctx.imports.push({ spec: content.text, ...pos(node), names: [], namespace: null, star: false, reexport: false, typeOnly: false, relative: method.text === "require_relative" });
            }
            return false;
          }
          if (method.text === "include" || method.text === "extend" || method.text === "prepend") {
            const cls = ctx.cls();
            if (cls && cls.def >= 0) {
              // Ruby applies the modules of one statement last first, so
              // `include A, B` puts A before B: they are recorded in the
              // order Ruby applies them, as if written one statement each.
              const def = ctx.defs[cls.def] as DefFact;
              for (const a of [...args].reverse()) {
                if (a.type === "constant" || a.type === "scope_resolution") def.bases.push({ name: a.text, qualifier: cls.cls, ...pos(a), rel: method.text as "include" | "extend" | "prepend" });
                // `extend self` adds the module's own methods; any other expression is a mixin not known.
                else if (a.type !== "self" && a.type !== "comment") (def.dynamicBases ??= []).push({ ...pos(a), rel: method.text as "include" | "extend" | "prepend" });
              }
            }
            return;
          }
          ctx.addCall(method, ctx.cls() ? { kind: "self", path: [] } : { kind: "none" });
          return;
        }
        let r: Receiver = { kind: "other" };
        if (recv.type === "self") r = { kind: "self", path: [] };
        else if (recv.type === "constant" || recv.type === "scope_resolution") r = { kind: "name", name: recv.text, path: [], nesting: nesting() };
        else if (recv.type === "instance_variable") r = { kind: "self", path: [recv.text] };
        else if (recv.type === "call" && recv.childForFieldName("method")?.text === "new") {
          const cls = recv.childForFieldName("receiver");
          if (cls && (cls.type === "constant" || cls.type === "scope_resolution")) r = { kind: "type", type: { name: cls.text, qualifier: nesting(), ...pos(cls) }, path: [] };
        }
        else if (recv.type === "identifier") {
          const type = ctx.local(recv.text);
          if (type) r = { kind: "type", type, path: [] };
        }
        ctx.addCall(method, r, false, recv.type === "identifier" ? recv.text : undefined);
        // The receiver identifier is a value, never a call of its own.
        return;
      }
      case "identifier": {
        const parent = node.parent;
        if (!parent || !RB_VALUE_PARENTS.has(parent.type)) return false;
        if (ctx.local(node.text) !== undefined || !ctx.cls()) return false;
        ctx.addCall(node, { kind: "self", path: [] }, true);
        return false;
      }
    }
  } });
  return ctx.facts();
}

// `readers`: the framework plugins' fact readers of the same file
// (frameworks/facts.ts), shown the tree on the extractor's own walk, so a
// file is walked once for everything read from it.
// A region the parser could not read is kept (`unread`): a call in it may
// be missing from the calls.
export function extract(tree: Tree, lang: Lang, readers: readonly TreeVisitor[] = []): FileFacts {
  const facts = lang === "python" ? extractPython(tree, readers) : lang === "go" ? extractGo(tree, readers) : lang === "ruby" ? extractRuby(tree, readers) : lang === "java" ? extractJava(tree, readers) : extractJs(tree, lang, readers);
  const unread = unreadRegions(tree);
  if (unread.length > 0) facts.unread = unread;
  return facts;
}
