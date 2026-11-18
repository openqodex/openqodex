// The Hono plugin's context-free facts of one JavaScript or TypeScript file:
// the calls it watches (`x.get(...)`, `x.openapi(...)`, `x.route(...)`,
// `x.use(...)`), the values names are bound to, the values functions return,
// each named function's parameters, the parameters typed with a name, and
// the names each function declares, so resolve can tell when a local name
// shadows an import or a module constant. Nothing here knows which name is
// Hono: that is decided in resolve, from the file's imports.
//
// Hono values are made with `new` (`new Hono()`, `new OpenAPIHono()`) and
// their methods return the value itself, so a value is read through a chain
// of watched calls to the `new` or the name it starts from
// (`new Hono().basePath("/v1")`, `app.get("/a", h).post("/b", h)`). The
// shared JavaScript reader (express/js.ts) reads every other expression;
// this file does not change it.
//
// A string is kept only where resolve reads one, by the one rule of
// shared/kept.ts: a route path or prefix, a basePath, the methods of `on`,
// the `method` and `path` of a `createRoute` object, and a constant a path
// names. Every other literal is kept as an unread placeholder.
import type { Node } from "web-tree-sitter";
import type { FactReader, FrameworkFactBase } from "../plugin.js";
import { eitherPathText, eitherSegmentText, keepParts, ledForm, methodText } from "../shared/kept.js";
import type { Expr, Pos, ScopedVisit } from "../express/js.js";
import { exported, FN_TYPES, identifierName, isExpr, MAX_ITEMS, MAX_SOURCE_BYTES, namePath, patternNames, pos, readExpr, scopedVisitor } from "../express/js.js";
import { readAlone } from "../../walk.js";
import type { TreeVisitor } from "../../walk.js";

// The routing methods of a Hono value. Hono has no `head` method.
export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "all"] as const;
// Every method watched, and every method a chain of calls on a value is
// read through: each returns the value it is called on (basePath a new
// value that shares its routes).
export const WATCHED: ReadonlySet<string> = new Set<string>([...HTTP_METHODS, "on", "use", "route", "openapi", "basePath", "mount"]);
// The calls whose first argument is a path or a prefix.
const PATH_FIRST: ReadonlySet<string> = new Set<string>([...HTTP_METHODS, "use", "route", "basePath", "mount"]);
// How many calls of one chain are read.
const MAX_CHAIN = 32;

// The types of node that open a function scope (as the shared visitor's).
const SCOPE_TYPES: ReadonlySet<string> = new Set([...FN_TYPES, "function_declaration", "generator_function_declaration", "method_definition"]);

// A value as this plugin reads it: an expression of the shared reader, or
// `new X(...)` (`ctor` the constructor's name chain; `bases` the paths of
// the basePath calls chained on it, innermost first), or a chain of watched
// calls on another expression (`base`), with the basePath paths in it.
export type HExpr = Expr | ({ t: "new"; ctor: string[] | null; bases: Expr[] } & Pos) | ({ t: "via"; base: Expr; bases: Expr[] } & Pos);

// A function's scope key: the line it starts on, or, for a function that
// starts on a line another function already starts on (an inline handler on
// a one-line factory's line), a negative number unique in the file. Every
// `scope` below is such a key, 0 for the module.
export type HonoFact =
  // A watched member call: `recv.prop(args)`. `scope` is the key of the
  // innermost function around it (0 at module level). `more`: arguments
  // past MAX_ITEMS the reader left out.
  | (FrameworkFactBase & { kind: "call"; recv: HExpr; prop: string; args: HExpr[]; scope: number; more?: number })
  // A name bound to a value: `const app = new Hono()`.
  | (FrameworkFactBase & { kind: "value"; name: string; value: HExpr; scope: number; top: boolean; exported: boolean; decl: "const" | "let" | "var" | "assign" })
  // A value a function returns: a `return` statement or an arrow
  // function's expression body. `scope`: the key of the function it
  // returns from. Every return of a function that returns a value the
  // plugin may read is kept, the others as an unread placeholder, so
  // resolve knows how many there are.
  | (FrameworkFactBase & { kind: "return"; value: HExpr; scope: number })
  // A named function (a declaration, or a function a declarator binds), at
  // the line it starts on: its scope key, its name, its parameters in
  // order (null for a pattern), and the scope around it.
  | (FrameworkFactBase & { kind: "fn"; key: number; name: string; params: (string | null)[]; scope: number })
  // A parameter of a function with a type written as a name: `(app: Hono)`.
  | (FrameworkFactBase & { kind: "param"; name: string; type: string[]; scope: number })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has regions the parser could not read (the first at `line`).
  | (FrameworkFactBase & { kind: "syntax-error"; regions: number })
  // A function's scope, at the line it starts on: its key, the scope around
  // it (0 for the module) and every name it declares. `all`: more names
  // than MAX_SCOPE_NAMES, so every name counts as declared there.
  | (FrameworkFactBase & { kind: "scope"; key: number; parent: number; names: string[]; all: boolean });

export const MAX_SCOPE_NAMES = 256;
// How many functions out resolve follows a name's binding.
export const MAX_SCOPE_CHAIN = 64;

// Every file is read: a route can be registered on an imported value in a
// file that never names hono.
export function wants(): boolean {
  return true;
}

// Whether a module specifier is Hono's or one of its packages: `hono`,
// `hono/...`, `@hono/...`. Resolve decides which export of which makes a value.
export function honoModule(spec: string): boolean {
  return spec === "hono" || spec.startsWith("hono/") || spec.startsWith("@hono/");
}

const TYPES: ReadonlySet<string> = new Set(["class_declaration", "catch_clause", "call_expression", "variable_declarator", "assignment_expression", "required_parameter", "optional_parameter", "import_statement", "export_statement", "return_statement"]);
const KEEP: ReadonlySet<string> = new Set(["lexical_declaration", "variable_declaration", "variable_declarator", "function_signature", "method_signature", "abstract_method_signature", "call_signature", "construct_signature", "function_type", "constructor_type"]);

const specifier = (n: Node | null | undefined): string | null => (n?.type === "string" ? n.text.slice(1, -1) : null);

const UNWRAP: ReadonlySet<string> = new Set(["parenthesized_expression", "await_expression", "as_expression", "satisfies_expression", "non_null_expression"]);
function unwrap(node: Node | null): Node | null {
  let n = node;
  for (let i = 0; n && UNWRAP.has(n.type) && i < 16; i++) n = n.firstNamedChild;
  return n;
}

const argsOf = (call: Node): Node[] => (call.childForFieldName("arguments")?.namedChildren ?? []).filter((c) => c.type !== "comment");

// A value read through a chain of watched calls down to what starts it.
export function readH(node: Node | null): HExpr {
  const start = unwrap(node);
  if (!start) return readExpr(null);
  const bases: Node[] = [];
  let cur: Node = start;
  let chained = false;
  for (let steps = 0; steps < MAX_CHAIN && cur.type === "call_expression" && !cur.hasError; steps++) {
    const fn = cur.childForFieldName("function");
    if (fn?.type !== "member_expression") break;
    const prop = fn.childForFieldName("property");
    const name = prop?.type === "property_identifier" ? identifierName(prop.text) : null;
    if (name === null || !WATCHED.has(name)) break;
    if (name === "basePath") bases.unshift(argsOf(cur)[0] as Node);
    const obj = unwrap(fn.childForFieldName("object"));
    if (!obj) break;
    chained = true;
    cur = obj;
  }
  const read = bases.map((b) => readExpr(b ?? null));
  if (cur.type === "new_expression" && !cur.hasError) return { t: "new", ctor: namePath(cur.childForFieldName("constructor")), bases: read, ...pos(cur) };
  if (!chained) return readExpr(start);
  return { t: "via", base: readExpr(cur), bases: read, ...pos(start) };
}

export function readFacts(root: Node): HonoFact[] {
  return readAlone(root, reader(root));
}

// The ordered parameter names of a function node.
function paramNames(fn: Node): (string | null)[] {
  const params = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!params) return [];
  if (params.type === "identifier") return [identifierName(params.text)];
  const out: (string | null)[] = [];
  for (const p of params.namedChildren) {
    if (p.type === "comment") continue;
    const pat = p.type === "required_parameter" || p.type === "optional_parameter" ? p.childForFieldName("pattern") : p;
    out.push(pat?.type === "identifier" ? identifierName(pat.text) : null);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// The facts of one file as one reader of a shared walk (walk.ts).
export function reader(root: Node): FactReader<HonoFact> {
  if (root.endIndex > MAX_SOURCE_BYTES) return { visitor: null, finish: () => [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }] };
  const out: HonoFact[] = [];
  let firstBroken = 0;
  let broken = 0;
  let namesModule = false;
  // The local names this file binds to zod-openapi's createRoute: a named
  // import (aliased or not), or `ns.createRoute` of a namespace import.
  const createRouteNames = new Set<string>();
  const createRouteSpaces = new Set<string>();
  const scopes = new Map<number, { line: number; column: number; parent: number; names: Set<string>; all: boolean }>();
  // The shared visitor gives a function by its line alone, so this reader
  // keeps its own stack of scope keys: `entering` is the key of the
  // function being entered, `open` the keys of the functions around a node.
  const lines = new Set<number>();
  let extraKeys = 0;
  let entering = 0;
  const open: { depth: number; key: number }[] = [];
  const current = (): number => (open.length > 0 ? (open[open.length - 1] as { key: number }).key : 0);
  const declare = (at: number, names: readonly string[]) => {
    if (at === 0) return;
    const s = scopes.get(at);
    if (!s) return;
    for (const n of names) {
      if (s.names.size >= MAX_SCOPE_NAMES) s.all = true;
      else s.names.add(n);
    }
  };
  const visit: ScopedVisit = (node, _line, up, type, upType): void => {
    const scope = current();
    if (SCOPE_TYPES.has(type)) {
      const own = entering;
      scopes.set(own, { ...pos(node), parent: scope, names: new Set(), all: false });
      const nameNode = type === "function_declaration" || type === "generator_function_declaration" ? node.childForFieldName("name") : null;
      const declName = nameNode ? identifierName(nameNode.text) : null;
      if (declName !== null) declare(scope, [declName]);
      const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
      const names: string[] = [];
      if (params?.type === "identifier") patternNames(params, names);
      else for (const p of params?.namedChildren ?? []) patternNames(p, names);
      declare(own, names);
      // The function's name: its own, or the declarator that binds it.
      let name = declName;
      if (name === null && FN_TYPES.has(type) && upType(1) === "variable_declarator") {
        const id = up(1)?.childForFieldName("name");
        name = id?.type === "identifier" ? identifierName(id.text) : null;
      }
      if (name !== null && !node.hasError) out.push({ kind: "fn", ...pos(node), key: own, name, params: paramNames(node), scope });
      // An arrow function's expression body is the value it returns.
      if (type === "arrow_function") {
        const body = node.childForFieldName("body");
        if (body && body.type !== "statement_block") out.push({ kind: "return", ...pos(body), value: readH(body), scope: own });
      }
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
      case "export_statement": {
        const spec = specifier(node.childForFieldName("source"));
        if (spec === null || !honoModule(spec)) return;
        namesModule = true;
        if (type !== "import_statement" || spec !== "@hono/zod-openapi") return;
        const clause = node.namedChildren.find((c) => c.type === "import_clause");
        for (const part of clause?.namedChildren ?? []) {
          if (part.type === "namespace_import") {
            const id = part.namedChildren.find((c) => c.type === "identifier");
            if (id) createRouteSpaces.add(id.text);
          } else if (part.type === "named_imports") {
            for (const s of part.namedChildren) {
              if (s.type !== "import_specifier") continue;
              const name = s.childForFieldName("name");
              const alias = s.childForFieldName("alias");
              if (name?.text === "createRoute") createRouteNames.add((alias ?? name).text);
            }
          }
        }
        return;
      }
      case "return_statement": {
        const value = node.namedChildren.find((c) => c.type !== "comment") ?? null;
        out.push({ kind: "return", ...pos(node), value: value ? readH(value) : { t: "other", ...pos(node) }, scope });
        return;
      }
      case "call_expression": {
        if (node.hasError) return;
        const fn = node.childForFieldName("function");
        if (fn?.type !== "member_expression") return;
        const prop = fn.childForFieldName("property");
        const name = prop?.type === "property_identifier" ? identifierName(prop.text) : null;
        if (name === null || !WATCHED.has(name)) return;
        const args = argsOf(node);
        const fact: HonoFact = { kind: "call", ...pos(node), recv: readH(fn.childForFieldName("object")), prop: name, args: args.slice(0, MAX_ITEMS).map((a) => readH(a)), scope };
        if (args.length > MAX_ITEMS) fact.more = args.length - MAX_ITEMS;
        out.push(fact);
        return;
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        const declared: string[] = [];
        patternNames(name, declared);
        declare(scope, declared);
        const id = name?.type === "identifier" ? identifierName(name.text) : null;
        if (id === null || !value || node.hasError) return;
        const holder = up(1);
        const decl = holder?.type === "variable_declaration" ? "var" : holder?.childForFieldName("kind")?.text === "let" ? "let" : "const";
        out.push({ kind: "value", ...pos(node), name: id, value: readH(value), scope, top: scope === 0 && upType(2) !== "for_statement", exported: exported(upType), decl });
        return;
      }
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (!left || !right || node.hasError) return;
        const path = namePath(left);
        if (path && path.length === 1) out.push({ kind: "value", ...pos(node), name: path[0] as string, value: readH(right), scope, top: scope === 0, exported: false, decl: "assign" });
        return;
      }
      case "required_parameter":
      case "optional_parameter": {
        const pattern = node.childForFieldName("pattern");
        const ann = node.childForFieldName("type")?.firstNamedChild ?? null;
        const id = pattern?.type === "identifier" ? identifierName(pattern.text) : null;
        if (id === null || !ann) return;
        const named = typeName(ann);
        const owner = up(2);
        // A function's parameter is in the function's own scope, the one just entered.
        if (named) out.push({ kind: "param", ...pos(node), name: id, type: named, scope: owner && SCOPE_TYPES.has(owner.type) ? scope : owner ? owner.startPosition.row + 1 : 0 });
        return;
      }
    }
  };
  const shared = scopedVisitor(
    visit,
    (line) => {
      if (broken++ === 0) firstBroken = line;
    },
    TYPES,
    KEEP,
  );
  const visitor: TreeVisitor = {
    ...shared,
    enter(node, type, field, depth, up, upType) {
      const fn = SCOPE_TYPES.has(type);
      if (fn) {
        const line = node.startPosition.row + 1;
        entering = lines.has(line) ? -++extraKeys : line;
        lines.add(line);
      }
      const descend = shared.enter(node, type, field, depth, up, upType);
      if (descend !== false && fn) open.push({ depth, key: entering });
      return descend;
    },
    leave(depth) {
      while (open.length > 0 && (open[open.length - 1] as { depth: number }).depth >= depth) open.pop();
      shared.leave?.(depth);
    },
  };
  const finish = (): HonoFact[] => {
    if (broken > 0) out.push({ kind: "syntax-error", line: firstBroken, column: 1, regions: broken });
    const scopeFacts: HonoFact[] = [...scopes].map(([key, s]) => ({ kind: "scope", line: s.line, column: s.column, key, parent: s.parent, names: [...s.names], all: s.all }));
    const kept = keepRead([...scopeFacts, ...trimReturns(out)], createRouteNames, createRouteSpaces);
    if (namesModule) return kept;
    // A file that names no Hono module makes no Hono value and defines no
    // createRoute, but its functions may hand a router on: a factory that
    // calls another, a wrapper that passes one through, a handler declared
    // in a function. A file with watched calls keeps them, its functions,
    // their scopes and returns. A file with none keeps only the module
    // functions that return a value resolve may read, with their scopes
    // and returns: no other file can reach anything else in it. Both keep
    // the values that what they keep reads.
    let keep: (f: HonoFact) => boolean;
    if (kept.some((f) => f.kind === "call")) keep = (f) => f.kind === "call" || f.kind === "scope" || f.kind === "fn" || f.kind === "return" || f.kind === "syntax-error";
    else {
      const top = new Set(kept.flatMap((f) => (f.kind === "fn" && f.scope === 0 ? [f.key] : [])));
      const own = new Set(kept.flatMap((f) => (f.kind === "return" && top.has(f.scope) ? [f.scope] : [])));
      if (own.size === 0) return kept.filter((f) => f.kind === "too-large" || f.kind === "syntax-error");
      keep = (f) => f.kind === "syntax-error" || ((f.kind === "fn" || f.kind === "scope") && own.has(f.key)) || (f.kind === "return" && own.has(f.scope));
    }
    const read = namesRead(kept.filter((f) => keep(f) || f.kind === "value"));
    return kept.filter((f) => keep(f) || (f.kind === "value" && read.has(f.name)));
  };
  return { visitor, finish };
}

// Whether resolve may read a returned value: a Hono value, a chain on a
// name, a name, or a call of a function by its name (a factory).
function readable(v: HExpr): boolean {
  if (v.t === "new" || v.t === "via") return true;
  if (v.t === "ref") return v.path.length === 1;
  if (v.t === "call") return (v.fn.t === "ref" && (v.fn.path.length === 1 || (v.fn.path.length === 2 && v.fn.path[1] === "createApp"))) || (v.fn.t === "member" && v.fn.prop === "createApp");
  return false;
}

// The return facts of the functions that return a value resolve may read,
// and of no other function: a handler's `return c.json(...)` is no fact.
function trimReturns(facts: HonoFact[]): HonoFact[] {
  const factories = new Set<number>();
  for (const f of facts) if (f.kind === "return" && readable(f.value)) factories.add(f.scope);
  return facts.map((f): HonoFact => (f.kind === "return" && !readable(f.value) ? { ...f, value: { t: "other", line: f.value.line, column: f.value.column } } : f)).filter((f) => f.kind !== "return" || factories.has(f.scope));
}

// The names a file's watched calls and kept returns read, and the names the
// values of those names read in turn.
function namesRead(facts: readonly HonoFact[]): Set<string> {
  const read = new Set<string>();
  const heads = (e: HExpr): void => {
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
      case "via":
        heads(e.base);
        for (const b of e.bases) heads(b);
        return;
      case "new":
        for (const b of e.bases) heads(b);
        return;
    }
  };
  for (const f of facts) {
    if (f.kind === "return") heads(f.value);
    if (f.kind !== "call") continue;
    heads(f.recv);
    for (const a of f.args) heads(a);
  }
  const values = facts.filter((f): f is Extract<HonoFact, { kind: "value" }> => f.kind === "value");
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of values) {
      if (!read.has(v.name)) continue;
      const before = read.size;
      heads(v.value);
      if (read.size > before) grew = true;
    }
  }
  return read;
}

// ---------- the literals the facts keep ----------
const unread = (e: { line: number; column: number }): Expr => ({ t: "other", line: e.line, column: e.column });

function keepRead(facts: HonoFact[], createRouteNames: ReadonlySet<string>, createRouteSpaces: ReadonlySet<string>): HonoFact[] {
  const scopes = new Map<number, { parent: number; names: Set<string>; all: boolean }>();
  for (const f of facts) if (f.kind === "scope") scopes.set(f.key, { parent: f.parent, names: new Set(f.names), all: f.all });
  const binding = (name: string, scope: number): number => {
    let at = scope;
    for (let guard = 0; at !== 0 && guard <= scopes.size; guard++) {
      const s = scopes.get(at);
      if (!s || s.all || s.names.has(name)) return at;
      at = s.parent;
    }
    return 0;
  };
  const writes = new Map<string, Extract<HonoFact, { kind: "value" }>[]>();
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
  const used = new Map<string, Set<"path" | "segment">>();
  const led: { name: string; at: number; lead: { s: string } | { ref: string[] } }[] = [];
  let at = 0;
  const use = (ref: string[], lead: { s: string } | { ref: string[] } | null = null) => {
    if (ref.length !== 1) return;
    const name = ref[0] as string;
    if (lead === null) {
      const k = key(name, binding(name, at));
      (used.get(k) ?? used.set(k, new Set()).get(k))?.add("path");
    } else led.push({ name, at, lead });
  };
  // An expression read as a route path, in the "either" form of the shared
  // rule: a `get` or `post` call may as well be a request a test or a
  // client makes ("/x?secret"), so a "?" that could start a query is never kept.
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
      default:
        return names(e);
    }
  };
  const method = (e: Expr): Expr => {
    if (e.t === "str") {
      const v = methodText(e.v);
      return v === null ? unread(e) : { ...e, v };
    }
    if (e.t === "array") return { ...e, items: e.items.map(method) };
    return names(e);
  };
  const isCreateRoute = (fn: Expr): boolean => fn.t === "ref" && ((fn.path.length === 1 && createRouteNames.has(fn.path[0] as string)) || (fn.path.length === 2 && createRouteSpaces.has(fn.path[0] as string) && fn.path[1] === "createRoute"));
  // An expression read only for its names and calls: no literal in it,
  // except the method and path of a createRoute object; an object keeps a
  // key only there.
  const names = (e: Expr): Expr => {
    switch (e.t) {
      case "str":
      case "dyn":
        return unread(e);
      case "call": {
        const fn = names(e.fn);
        if (isCreateRoute(e.fn)) {
          const [first, ...rest] = e.args;
          const obj = first && first.t === "object" ? { ...first, props: first.props.filter((p) => p.key === "method" || p.key === "path").map((p) => ({ key: p.key, value: p.key === "path" ? path(p.value) : method(p.value) })) } : first ? names(first) : undefined;
          return { ...e, fn, args: [...(obj ? [obj] : []), ...rest.map(names)] };
        }
        return { ...e, fn, args: e.args.map(names) };
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
  const h = (e: HExpr): HExpr => {
    if (e.t === "new") return { ...e, bases: e.bases.map(path) };
    if (e.t === "via") return { ...e, base: names(e.base), bases: e.bases.map(path) };
    return names(e);
  };
  const out: HonoFact[] = facts.map((f) => {
    at = "scope" in f ? f.scope : 0;
    switch (f.kind) {
      case "call":
        return {
          ...f,
          recv: h(f.recv),
          args: f.args.map((a, i) => {
            if (a.t === "new" || a.t === "via") return h(a);
            if (f.prop === "on") return i === 0 ? method(a) : i === 1 ? path(a) : names(a);
            return i === 0 && PATH_FIRST.has(f.prop) ? path(a) : names(a);
          }),
        };
      case "value":
        return f.value.t === "str" ? f : { ...f, value: h(f.value) };
      case "return":
        return { ...f, value: h(f.value) };
      default:
        return f;
    }
  });
  for (const l of led) {
    const k = key(l.name, binding(l.name, l.at));
    (used.get(k) ?? used.set(k, new Set()).get(k))?.add(ledForm(l.lead, constantIn(l.at)));
  }
  return out.map((f) => {
    if (f.kind !== "value" || f.value.t !== "str") return f;
    const str = f.value;
    const forms = used.get(key(f.name, binding(f.name, f.scope)));
    const v = forms ? ([...forms].map((form) => (form === "path" ? eitherPathText : eitherSegmentText)(str.v)).find((x) => x !== null) ?? null) : null;
    return { ...f, value: v === null ? unread(str) : { ...str, v } };
  });
}

// A type written as a name or a qualified name: `Hono`, `hono.Hono`.
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

export function isHExpr(v: unknown): v is HExpr {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (e.t === "new") return Number.isInteger(e.line) && Number.isInteger(e.column) && (e.ctor === null || strings(e.ctor)) && Array.isArray(e.bases) && e.bases.length <= MAX_CHAIN && e.bases.every((b) => isExpr(b));
  if (e.t === "via") return Number.isInteger(e.line) && Number.isInteger(e.column) && isExpr(e.base) && Array.isArray(e.bases) && e.bases.length <= MAX_CHAIN && e.bases.every((b) => isExpr(b));
  return isExpr(v);
}

export function isHonoFact(v: unknown): v is HonoFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "call":
      return isHExpr(f.recv) && typeof f.prop === "string" && Array.isArray(f.args) && f.args.every((a) => isHExpr(a)) && Number.isInteger(f.scope) && (f.more === undefined || Number.isInteger(f.more));
    case "value":
      return typeof f.name === "string" && isHExpr(f.value) && Number.isInteger(f.scope) && typeof f.top === "boolean" && typeof f.exported === "boolean" && (f.decl === "const" || f.decl === "let" || f.decl === "var" || f.decl === "assign");
    case "return":
      return isHExpr(f.value) && Number.isInteger(f.scope);
    case "fn":
      return Number.isInteger(f.key) && typeof f.name === "string" && Array.isArray(f.params) && f.params.length <= MAX_ITEMS && f.params.every((p) => p === null || typeof p === "string") && Number.isInteger(f.scope);
    case "param":
      return typeof f.name === "string" && strings(f.type) && Number.isInteger(f.scope);
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return Number.isInteger(f.regions);
    case "scope":
      return Number.isInteger(f.key) && Number.isInteger(f.parent) && strings(f.names) && (f.names as string[]).length <= MAX_SCOPE_NAMES && typeof f.all === "boolean";
    default:
      return false;
  }
}
