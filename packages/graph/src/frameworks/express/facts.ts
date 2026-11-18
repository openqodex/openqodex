// The Express plugin's context-free facts of one JavaScript or TypeScript
// file: the calls it watches (`x.get(...)`, `x.use(...)`, `x.route(...)`,
// `x.listen(...)`, `createServer(...)`), the values names are bound to, the
// module-level string constants, the CommonJS exports, the parameter types
// of functions, the parameter counts of top-level functions, and the names
// each function declares (its parameters and locals), so resolve can tell
// when a local name shadows an import or a module constant. Nothing here
// knows which name is Express: that is decided in resolve, from the file's
// imports, so a fact never claims what only another file can prove.
//
// A value is kept only where resolve can read it (`namesRead`), and the
// scopes only for a file that holds a watched call or keeps a value: most
// files hold neither an application nor a route, and their values were
// most of every kept facts file.
import type { Node } from "web-tree-sitter";
import type { FactReader, FrameworkFactBase } from "../plugin.js";
import { eitherPathText, eitherSegmentText, keepParts, ledForm } from "../shared/kept.js";
import type { Expr } from "./js.js";
import type { ScopedVisit } from "./js.js";
import { exported, FN_TYPES, identifierName, isExpr, MAX_ITEMS, MAX_SOURCE_BYTES, namePath, paramCount, patternNames, pos, readExpr, scopedVisitor, stringValue } from "./js.js";
import { readAlone } from "../../walk.js";

// The member calls watched: the routing methods of an application and a
// router, `use`, `route`, `listen`, and the requests of a test agent.
export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "all"] as const;
const WATCHED = new Set<string>([...HTTP_METHODS, "del", "use", "route", "listen"]);

export type ExpressFact =
  // A watched member call: `recv.prop(args)`. `scope` is the line of the
  // innermost function around it (0 at module level).
  // `more`: arguments past MAX_ITEMS the reader left out.
  | (FrameworkFactBase & { kind: "call"; recv: Expr; prop: string; args: Expr[]; scope: number; more?: number })
  // A call of a function named createServer: `http.createServer(app)`.
  | (FrameworkFactBase & { kind: "server"; fn: string[]; args: Expr[]; scope: number })
  // A name bound to a value: `const app = express()`, `app = express()`.
  // `top`: declared at module level; `exported`: under an export statement;
  // `decl`: how the name got the value (a declaration, or an assignment).
  | (FrameworkFactBase & { kind: "value"; name: string; value: Expr; scope: number; top: boolean; exported: boolean; decl: "const" | "let" | "var" | "assign" })
  // `module.exports = x` (name "default") or `module.exports.n = x`, `exports.n = x`.
  | (FrameworkFactBase & { kind: "cjs-export"; name: string; value: Expr; bare?: true })
  // A parameter of a function with a type written as a name: `(app: Express)`.
  | (FrameworkFactBase & { kind: "param"; name: string; type: string[]; scope: number })
  // A top-level function and how many parameters it takes.
  | (FrameworkFactBase & { kind: "function"; name: string; params: number })
  // A test block: `describe(...)`, `it(...)`, `test(...)` with a literal name.
  | (FrameworkFactBase & { kind: "test-block"; fn: string; name: string | null })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has regions the parser could not read (the first at `line`):
  // nothing in them is a fact.
  | (FrameworkFactBase & { kind: "syntax-error"; regions: number })
  // A function's scope: the line it starts on (the scope key the other facts
  // carry), the scope around it (0 for the module), and every name it
  // declares, wherever in its body: parameters, variables, nested functions
  // and classes, catch parameters. `all`: more names than MAX_SCOPE_NAMES,
  // so every name counts as declared there.
  | (FrameworkFactBase & { kind: "scope"; parent: number; names: string[]; all: boolean });

// The most names kept for one function's scope.
export const MAX_SCOPE_NAMES = 256;

// Every file is read: a route can be registered on an imported application
// in a file that never names express, and a name can be spelled with an
// escape, so no test on the text can tell which files hold none. The facts
// come from the tree the core already parsed.
export function wants(): boolean {
  return true;
}

const TEST_FNS = new Set(["describe", "it", "test", "suite"]);

// The node types the reader is entered for (the function types besides,
// scopedVisitor; an import or a re-export for the module it names), and
// those of the ancestors it reads as nodes: what holds a variable
// declarator, and what holds a parameter list.
const TYPES: ReadonlySet<string> = new Set(["class_declaration", "catch_clause", "call_expression", "variable_declarator", "assignment_expression", "required_parameter", "optional_parameter", "import_statement", "export_statement"]);
const KEEP: ReadonlySet<string> = new Set(["lexical_declaration", "variable_declaration", "function_signature", "method_signature", "abstract_method_signature", "call_signature", "construct_signature", "function_type", "constructor_type"]);

// The modules whose values make an application, a router or a test agent.
const MODULES = new Set(["express", "supertest"]);
// The module a string names as the language facts read an import's
// specifier: the string's text without its quotes (extract.ts).
const specifier = (n: Node | null | undefined): string | null => (n?.type === "string" ? n.text.slice(1, -1) : null);

// How many functions out resolve follows a name's binding (resolve.ts).
export const MAX_SCOPE_CHAIN = 64;

// The names whose values resolve can read in a file that does not name
// express or supertest (resolve.ts): such a file makes no application,
// router or agent, so resolve reads its values only to follow a name
// through them. It follows the names its own watched and createServer
// calls read (a receiver, a handler, a path's constants), and, from
// another file that imports one, a module-level name given another name's
// value (`export const server = app`: a declaration at module level, or an
// assignment that writes the module's name). A name's value that is
// another name leads on to that name. Every write of a name read is kept,
// because two writes prove no value.
function namesRead(facts: readonly ExpressFact[], scopes: ReadonlyMap<number, { parent: number; names: ReadonlySet<string>; all: boolean }>): Set<string> {
  const read = new Set<string>();
  const heads = (e: Expr): void => {
    switch (e.t) {
      case "ref":
        read.add(e.path[0] as string);
        return;
      case "dyn":
        for (const p of e.parts ?? []) if ("ref" in p) read.add(p.ref[0] as string);
        return;
      case "call":
        heads(e.fn);
        for (const a of e.args) heads(a);
        return;
      case "member":
        heads(e.obj);
        return;
      case "array":
        for (const a of e.items) heads(a);
        return;
      case "object":
        for (const p of e.props) heads(p.value);
        return;
    }
  };
  // Whether a name written at a scope is the module's own: no function out
  // to the module declares it (resolve's bindingScope, to the same depth).
  const module = (name: string, scope: number): boolean => {
    let s = scope;
    for (let steps = 0; s !== 0; steps++) {
      const info = scopes.get(s);
      if (steps >= MAX_SCOPE_CHAIN || !info || info.all || info.names.has(name)) return false;
      s = info.parent;
    }
    return true;
  };
  const values: Extract<ExpressFact, { kind: "value" }>[] = [];
  for (const f of facts) {
    if (f.kind === "call") {
      heads(f.recv);
      for (const a of f.args) heads(a);
    } else if (f.kind === "server") for (const a of f.args) heads(a);
    else if (f.kind === "value") {
      values.push(f);
      if (f.value.t === "ref" && (f.decl === "assign" ? module(f.name, f.scope) : f.scope === 0)) read.add(f.name);
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of values) {
      if (v.value.t !== "ref" || !read.has(v.name)) continue;
      const next = v.value.path[0] as string;
      if (!read.has(next)) {
        read.add(next);
        grew = true;
      }
    }
  }
  return read;
}

export function readFacts(root: Node): ExpressFact[] {
  return readAlone(root, reader(root));
}

// The facts of one file as one reader of a shared walk (walk.ts).
export function reader(root: Node): FactReader<ExpressFact> {
  if (root.endIndex > MAX_SOURCE_BYTES) return { visitor: null, finish: () => [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }] };
  const out: ExpressFact[] = [];
  let firstBroken = 0;
  let broken = 0;
  let namesModule = false;
  // Each function scope's parent and declared names, by the line it starts on.
  const scopes = new Map<number, { parent: number; names: Set<string>; all: boolean }>();
  const declare = (at: number, names: readonly string[]) => {
    if (at === 0) return; // the module: its own names are read from its declarations
    const s = scopes.get(at);
    if (!s) return;
    for (const n of names) {
      if (s.names.size >= MAX_SCOPE_NAMES) s.all = true;
      else s.names.add(n);
    }
  };
  const visit: ScopedVisit = (node, scope, up, type, upType): void => {
    if (FN_TYPES.has(type) || type === "function_declaration" || type === "generator_function_declaration" || type === "method_definition") {
      const own = node.startPosition.row + 1;
      if (!scopes.has(own)) scopes.set(own, { parent: scope, names: new Set(), all: false });
      // The function's own name lives in the scope around it; its parameters in its own.
      const name = type === "function_declaration" || type === "generator_function_declaration" ? node.childForFieldName("name") : null;
      if (name) {
        const id = identifierName(name.text);
        if (id !== null) declare(scope, [id]);
      }
      const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
      const names: string[] = [];
      if (params?.type === "identifier") patternNames(params, names);
      else for (const p of params?.namedChildren ?? []) patternNames(p, names);
      declare(own, names);
    } else if (type === "class_declaration") {
      const name = node.childForFieldName("name");
      const id = name ? identifierName(name.text) : null;
      if (id !== null) declare(scope, [id]);
    } else if (type === "catch_clause") {
      const names: string[] = [];
      patternNames(node.childForFieldName("parameter"), names);
      declare(scope, names);
    }
    switch (type) {
      case "import_statement":
      case "export_statement":
        if (!namesModule && MODULES.has(specifier(node.childForFieldName("source")) ?? "")) namesModule = true;
        return;
      case "call_expression": {
        // A call the parser had to repair (a missing parenthesis) is no fact.
        if (node.hasError) return;
        const fn = node.childForFieldName("function");
        // The arguments, read only for a call the reader keeps a fact of.
        let list: Node[] | null = null;
        const args = (): Node[] => (list ??= (node.childForFieldName("arguments")?.namedChildren ?? []).filter((c) => c.type !== "comment"));
        // `require("express")`, `await import("supertest")`.
        if (!namesModule && (fn?.type === "import" || (fn?.type === "identifier" && fn.text === "require")) && MODULES.has(specifier(args()[0]) ?? "")) namesModule = true;
        if (fn?.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          const name = prop?.type === "property_identifier" ? identifierName(prop.text) : null;
          if (name !== null && WATCHED.has(name)) {
            const fact: ExpressFact = { kind: "call", ...pos(node), recv: readExpr(fn.childForFieldName("object")), prop: name, args: args().slice(0, MAX_ITEMS).map((a) => readExpr(a)), scope };
            if (args().length > MAX_ITEMS) fact.more = args().length - MAX_ITEMS;
            out.push(fact);
          }
          // A member callee's name path ends in this name and holds two or
          // more: it can only make a createServer fact.
          if (name !== "createServer") return;
        }
        const path = namePath(fn);
        if (path && path[path.length - 1] === "createServer") out.push({ kind: "server", ...pos(node), fn: path, args: args().slice(0, MAX_ITEMS).map((a) => readExpr(a)), scope });
        if (path && path.length === 1 && TEST_FNS.has(path[0] as string)) out.push({ kind: "test-block", ...pos(node), fn: path[0] as string, name: stringValue(args()[0] ?? null) });
        return;
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        const declared: string[] = [];
        patternNames(name, declared);
        declare(scope, declared);
        const id = name?.type === "identifier" ? identifierName(name.text) : null;
        const required = name?.type === "object_pattern" && value?.type === "call_expression" && value.childForFieldName("function")?.text === "require";
        if ((id === null && !required) || !value || node.hasError) return;
        const holder = up(1);
        const decl = holder?.type === "variable_declaration" ? "var" : holder?.childForFieldName("kind")?.text === "let" ? "let" : "const";
        const top = scope === 0 && upType(2) !== "for_statement";
        if (id === null) {
          // `const { a, b: c } = require("./m")`: each name holds a member of what the call returns (which one is read from the import).
          const call = readExpr(value);
          for (const p of name?.namedChildren ?? []) {
            const key = p.type === "pair_pattern" ? p.childForFieldName("key") : p; // only to tell a plain pattern from a computed one
            const local = p.type === "pair_pattern" ? p.childForFieldName("value") : p;
            if (!key || !local || (p.type !== "pair_pattern" && p.type !== "shorthand_property_identifier_pattern") || local.type !== (p.type === "pair_pattern" ? "identifier" : "shorthand_property_identifier_pattern")) continue;
            const localName = identifierName(local.text);
            if (localName !== null) out.push({ kind: "value", ...pos(node), name: localName, value: { t: "member", obj: call, prop: "", ...pos(node) }, scope, top, exported: exported(upType), decl });
          }
          return;
        }
        out.push({ kind: "value", ...pos(node), name: id, value: readExpr(value), scope, top, exported: exported(upType), decl });
        return;
      }
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (!left || !right || node.hasError) return;
        const path = namePath(left);
        if (!path) return;
        if (path[0] === "module" && path[1] === "exports") {
          out.push({ kind: "cjs-export", ...pos(node), name: path.length === 2 ? "default" : (path[2] as string), value: exportsValue(right) });
          return;
        }
        if (path[0] === "exports" && path.length === 2) {
          out.push({ kind: "cjs-export", ...pos(node), name: path[1] as string, value: readExpr(right), bare: true });
          return;
        }
        if (path.length === 1) {
          out.push({ kind: "value", ...pos(node), name: path[0] as string, value: readExpr(right), scope, top: scope === 0, exported: false, decl: "assign" });
        }
        return;
      }
      case "required_parameter":
      case "optional_parameter": {
        const pattern = node.childForFieldName("pattern");
        const ann = node.childForFieldName("type")?.firstNamedChild ?? null;
        const id = pattern?.type === "identifier" ? identifierName(pattern.text) : null;
        if (id === null || !ann) return;
        const named = typeName(ann);
        // The parameter list's owner, two steps up: the function the scope is named by.
        const owner = up(2);
        if (named) out.push({ kind: "param", ...pos(node), name: id, type: named, scope: owner ? owner.startPosition.row + 1 : 0 });
        return;
      }
      case "function_declaration": {
        const name = node.childForFieldName("name");
        const id = name ? identifierName(name.text) : null;
        if (id !== null && scope === 0) out.push({ kind: "function", ...pos(node), name: id, params: paramCount(node) });
        return;
      }
    }
  };
  const visitor = scopedVisitor(
    visit,
    (line) => {
      if (broken++ === 0) firstBroken = line;
    },
    TYPES,
    KEEP,
  );
  const finish = (): ExpressFact[] => {
    if (broken > 0) out.push({ kind: "syntax-error", line: firstBroken, column: 1, regions: broken });
    // First, so the core's per-file fact cap drops calls and values before
    // it drops a scope: a name read in a function whose scope is missing would
    // otherwise bind to the module.
    const scopeFacts: ExpressFact[] = [...scopes].map(([line, s]) => ({ kind: "scope", line, column: 1, parent: s.parent, names: [...s.names], all: s.all }));
    const facts = keepRead([...scopeFacts, ...out]);
    if (namesModule) return facts;
    // A file that holds a watched call keeps its scopes, which every name
    // its calls read is bound through; one that keeps a value, too.
    const read = namesRead(facts, scopes);
    const calls = facts.some((f) => f.kind === "call" || f.kind === "server");
    const kept = facts.filter((f) => f.kind !== "value" || read.has(f.name));
    return calls || kept.some((f) => f.kind === "value") ? kept : kept.filter((f) => f.kind !== "scope");
  };
  return { visitor, finish };
}

// ---------- the literals the facts keep ----------
// A string is kept only where resolve reads one, by the one rule of
// shared/kept.ts: the path or prefix a watched call or a `route(...)` call
// is given first, read in the "either" form (the call may be a route or a
// test agent's request), and a constant such a path names, the very
// binding the path reads. Every other literal, in a handler, an option, a
// header, a value, an object's key or an export, is kept as `other`, and a
// test block keeps no title.
const unread = (e: Expr): Expr => ({ t: "other", line: e.line, column: e.column });

// The value given to `module.exports`. An object's spreads, computed keys
// and methods are counted in its `more`: each may write a member the
// object also names, so no member it names is taken as the last write.
function exportsValue(right: Node): Expr {
  const v = readExpr(right);
  if (v.t !== "object" || right.type !== "object") return v;
  const hidden = right.namedChildren.filter((c) => c.type === "spread_element" || c.type === "method_definition" || (c.type === "pair" && c.childForFieldName("key")?.type === "computed_property_name")).length;
  return hidden > 0 ? { ...v, more: (v.more ?? 0) + hidden } : v;
}
// The calls whose first argument is a path or a prefix.
const PATH_FIRST = new Set<string>([...HTTP_METHODS, "del", "use", "route"]);

function keepRead(facts: ExpressFact[]): ExpressFact[] {
  // The scope a name read at a scope binds to, as resolve binds it: the
  // innermost function around the read that declares the name, else the
  // module (0).
  const scopes = new Map<number, { parent: number; names: Set<string>; all: boolean }>();
  for (const f of facts) if (f.kind === "scope") scopes.set(f.line, { parent: f.parent, names: new Set(f.names), all: f.all });
  const binding = (name: string, scope: number): number => {
    let at = scope;
    for (let guard = 0; at !== 0 && guard <= scopes.size; guard++) {
      const s = scopes.get(at);
      if (!s || s.all || s.names.has(name)) return at;
      at = s.parent;
    }
    return 0;
  };
  // The writes of each binding, and its constant: the one write, a string.
  const writes = new Map<string, Extract<ExpressFact, { kind: "value" }>[]>();
  const key = (name: string, at: number) => `${at}\0${name}`;
  for (const f of facts) {
    if (f.kind !== "value") continue;
    const k = key(f.name, binding(f.name, f.scope));
    (writes.get(k) ?? writes.set(k, []).get(k))?.push(f);
  }
  const constantIn = (scope: number) => (name: string): string | null => {
    const w = writes.get(key(name, binding(name, scope)));
    return w && w.length === 1 && w[0]?.value.t === "str" ? w[0].value.v : null;
  };
  // Each binding a path reads, and the forms it is read in: a whole path or
  // its first piece, or a later piece of one (shared/kept.ts, `ledForm`).
  const used = new Map<string, Set<"path" | "segment">>();
  const led: { name: string; at: number; lead: { s: string } | { ref: string[] } }[] = [];
  let at = 0; // the scope of the fact being read
  const use = (ref: string[], lead: { s: string } | { ref: string[] } | null = null) => {
    if (ref.length !== 1) return;
    const name = ref[0] as string;
    if (lead === null) {
      const k = key(name, binding(name, at));
      (used.get(k) ?? used.set(k, new Set()).get(k))?.add("path");
    } else led.push({ name, at, lead });
  };
  // An expression read as a path: a literal in the form resolve reads it, a
  // name whose constant it may need, or a list of those.
  const path = (e: Expr): Expr => {
    switch (e.t) {
      case "str": {
        const v = eitherPathText(e.v);
        return v === null ? unread(e) : { ...e, v };
      }
      case "dyn": {
        const parts = e.parts ? keepParts(e.parts, "either", use, constantIn(at)) : null;
        return parts === null ? unread(e) : { ...e, parts };
      }
      case "ref":
        use(e.path);
        return e;
      case "array":
        return { ...e, items: e.items.map(path) };
      default:
        return names(e);
    }
  };
  // An expression read only for its names and calls: no literal in it,
  // except the path a `route(...)` call in a chain is given; an object
  // keeps no key.
  const names = (e: Expr): Expr => {
    switch (e.t) {
      case "str":
      case "dyn":
        return unread(e);
      case "call": {
        const fn = names(e.fn);
        const route = (e.fn.t === "member" && e.fn.prop === "route") || (e.fn.t === "ref" && e.fn.path[e.fn.path.length - 1] === "route");
        // The module a `require` names is kept, by the rule that keeps a path piece, unless the rule would change it.
        const required = e.fn.t === "ref" && e.fn.path.length === 1 && e.fn.path[0] === "require";
        const spec = (a: Expr): Expr => (a.t === "str" && eitherSegmentText(a.v) === a.v ? a : unread(a));
        return { ...e, fn, args: e.args.map((a, i) => (route && i === 0 ? path(a) : required && i === 0 ? spec(a) : names(a))) };
      }
      case "member":
        return { ...e, obj: names(e.obj) };
      case "array":
        return { ...e, items: e.items.map(names) };
      case "object":
        return { ...e, props: e.props.map((p) => ({ key: "", value: names(p.value) })) };
      default:
        return e;
    }
  };
  const out: ExpressFact[] = facts.map((f) => {
    at = "scope" in f ? f.scope : 0;
    switch (f.kind) {
      case "call":
        return { ...f, recv: names(f.recv), args: f.args.map((a, i) => (i === 0 && PATH_FIRST.has(f.prop) ? path(a) : names(a))) };
      case "server":
        return { ...f, args: f.args.map(names) };
      case "value":
        return f.value.t === "str" ? f : { ...f, value: names(f.value) };
      case "cjs-export":
        // An object keeps the names it exports (`module.exports = { users }`), by the rule that keeps a path piece.
        return { ...f, value: f.value.t === "object" ? { ...f.value, props: f.value.props.map((p) => ({ key: eitherSegmentText(p.key) === p.key ? p.key : "", value: names(p.value) })) } : names(f.value) };
      case "test-block":
        return { ...f, name: null };
      default:
        return f;
    }
  });
  for (const l of led) {
    const k = key(l.name, binding(l.name, l.at));
    (used.get(k) ?? used.set(k, new Set()).get(k))?.add(ledForm(l.lead, constantIn(l.at)));
  }
  // A string is kept only for a binding a path reads, in the form that path reads it in.
  return out.map((f) => {
    if (f.kind !== "value" || f.value.t !== "str") return f;
    const str = f.value;
    const forms = used.get(key(f.name, binding(f.name, f.scope)));
    const v = forms ? ([...forms].map((form) => (form === "path" ? eitherPathText : eitherSegmentText)(str.v)).find((x) => x !== null) ?? null) : null;
    return { ...f, value: v === null ? unread(str) : { ...str, v } };
  });
}

// A type written as a name or a qualified name: `Express`, `express.Router`,
// read from the tree's own parts.
function typeName(node: Node): string[] | null {
  const parts: string[] = [];
  let n: Node | null = node;
  for (let steps = 0; n && steps < 8; steps++) {
    if (n.type === "generic_type") {
      n = n.firstNamedChild;
      continue;
    }
    if (n.type === "type_identifier" || n.type === "identifier") {
      const id = identifierName(n.text);
      if (id === null) return null;
      parts.unshift(id);
      return parts;
    }
    if (n.type !== "nested_type_identifier" && n.type !== "nested_identifier" && n.type !== "member_expression") return null;
    const last = n.lastNamedChild;
    const id = last && (last.type === "type_identifier" || last.type === "property_identifier" || last.type === "identifier") ? identifierName(last.text) : null;
    if (id === null) return null;
    parts.unshift(id);
    n = n.firstNamedChild;
  }
  return null;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function isExpressFact(v: unknown): v is ExpressFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "call":
      return isExpr(f.recv) && typeof f.prop === "string" && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && Number.isInteger(f.scope) && (f.more === undefined || Number.isInteger(f.more));
    case "server":
      return strings(f.fn) && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && Number.isInteger(f.scope);
    case "value":
      return typeof f.name === "string" && isExpr(f.value) && Number.isInteger(f.scope) && typeof f.top === "boolean" && typeof f.exported === "boolean" && (f.decl === "const" || f.decl === "let" || f.decl === "var" || f.decl === "assign");
    case "cjs-export":
      return typeof f.name === "string" && isExpr(f.value);
    case "param":
      return typeof f.name === "string" && strings(f.type) && Number.isInteger(f.scope);
    case "function":
      return typeof f.name === "string" && Number.isInteger(f.params);
    case "test-block":
      return typeof f.fn === "string" && (f.name === null || typeof f.name === "string");
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return Number.isInteger(f.regions);
    case "scope":
      return Number.isInteger(f.parent) && strings(f.names) && (f.names as string[]).length <= MAX_SCOPE_NAMES && typeof f.all === "boolean";
    default:
      return false;
  }
}
