// The Nest plugin's context-free facts of one JavaScript or TypeScript file:
// the classes that carry a decorator Nest reads (`@Controller`, `@Module`,
// a route decorator such as `@Get`, `@Version`, `@UseGuards`,
// `@UseInterceptors`) with those decorators' arguments, the calls that make
// or configure an application (`NestFactory.create`, `setGlobalPrefix`,
// `enableVersioning`), and the module constants a decorator or such a call
// reads as a path. Nothing here knows whether `Controller` is Nest's: that
// is decided in resolve, from the file's imports, so a fact never claims
// what only another file can prove. The core does not keep TypeScript
// decorators, so the plugin reads them from the tree itself.
import type { Node } from "web-tree-sitter";
import type { FrameworkFactBase } from "../plugin.js";
import { eitherSegmentText, keptText, routeSegmentText } from "../shared/kept.js";
import { decodeEscape } from "../express/js.js";

// The most bytes of one file the plugin reads; a larger file gets one
// "too-large" fact and nothing else, and resolve says so with an unknown.
export const MAX_SOURCE_BYTES = 256 * 1024;
// Items of one array, object or argument list read; the rest are counted.
export const MAX_ITEMS = 64;
// How deep one decorator argument is read.
export const MAX_DEPTH = 8;
// Decorated members of one class read; the rest are counted.
export const MAX_MEMBERS = 500;
// Names of one class's members kept (to tell an override from an inherited route).
export const MAX_NAMES = 1000;
// Steps spent telling whether a name inside a function is a local, per file.
export const MAX_SHADOW_STEPS = 50_000;
// The longest exported constant kept for a route path read in another file.
export const MAX_EXPORTED_CONSTANT = 100;
// Steps from a read to the constant it names through other constants
// (`const P = BASE`: P is 0 steps, BASE 1); resolve follows as many, so a
// constant further on is not kept and the path reads as computed.
export const MAX_CONSTANT_STEPS = 4;

// The decorators the plugin reads, by the name they are written with
// (the imported name, or the last part of `ns.Get`).
export const ROUTE_DECORATORS: Readonly<Record<string, string>> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "*",
  Search: "SEARCH",
  QueryMethod: "QUERY",
  Propfind: "PROPFIND",
  Proppatch: "PROPPATCH",
  Mkcol: "MKCOL",
  Copy: "COPY",
  Move: "MOVE",
  Lock: "LOCK",
  Unlock: "UNLOCK",
  Sse: "GET",
};
const OTHER_DECORATORS = new Set(["Controller", "Module", "Version", "UseGuards", "UseInterceptors", "RequestMapping"]);
const isWatched = (name: string) => name in ROUTE_DECORATORS || OTHER_DECORATORS.has(name);
// The calls on an application value that change the paths it serves.
export const APP_CALLS = new Set(["setGlobalPrefix", "enableVersioning"]);

// A decorator argument or a call argument as the plugin reads it. A string
// is kept (`v`) only where resolve reads one as a path or a version, by the
// rule of shared/kept.ts; elsewhere `v` is null.
export type Arg =
  | { t: "str"; v: string | null; line: number; column: number }
  | { t: "ref"; path: string[]; line: number; column: number }
  | { t: "bool"; v: boolean; line: number; column: number }
  | { t: "arr"; items: Arg[]; more: number; line: number; column: number }
  // `more`: entries the reader cut, spreads and computed keys.
  | { t: "obj"; props: { key: string; value: Arg }[]; more: number; line: number; column: number }
  | { t: "call"; fn: string[] | null; args: Arg[]; more: number; line: number; column: number }
  | { t: "new"; fn: string[] | null; line: number; column: number }
  | { t: "arrow"; body: Arg | null; line: number; column: number }
  | { t: "other"; line: number; column: number };

// A decorator as written: its callee (`["Get"]`, `["common", "Get"]`),
// whether it is called, and its arguments (empty for a decorator the
// plugin does not read). `shadowed`: a function around a class written
// inside it binds the callee's first name.
export type Deco = { fn: string[]; called: boolean; args: Arg[]; more: number; line: number; column: number; shadowed?: boolean };

// A member of a class that carries a decorator the plugin reads.
export type Member = { name: string | null; line: number; column: number; static: boolean; decorators: Deco[] };

export type NestFact =
  // A class with a decorator the plugin reads on it or on a member. `line`
  // and `column` are its name's (the symbol's line). `top`: declared at
  // module level. `base`: what it extends. `names`: every member's name
  // (`namesCut` past MAX_NAMES). `dynamic`: a static method builds an
  // object with `controllers`, `imports` or a spread, so a dynamic module
  // made by it may add controllers.
  | (FrameworkFactBase & { kind: "class"; name: string | null; top: boolean; decorators: Deco[]; members: Member[]; cut: number; base: Arg | null; names: string[]; namesCut: boolean; dynamic: boolean })
  // `NestFactory.create(module, ...)`, written through a name imported from
  // @nestjs/core. `name`: the variable it is bound to, else null. `scope`:
  // the line of the function around it (0 at module level). `block`: the
  // block it is a statement of.
  | (FrameworkFactBase & { kind: "factory"; fn: string[]; module: Arg | null; name: string | null; scope: number; block: number })
  // `recv.setGlobalPrefix(...)` or `recv.enableVersioning(...)`; `recv` is
  // null when the receiver is not a plain name.
  | (FrameworkFactBase & { kind: "app-call"; prop: string; recv: string[] | null; args: Arg[]; more: number; scope: number; block: number })
  // A module-level `const name = value` that a fact of this file reads as
  // a path or a route table, or an exported string constant with a path's
  // shape that another file may import as one.
  | (FrameworkFactBase & { kind: "value"; name: string; value: Arg; exported: boolean })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has a syntax error at the fact's position; nothing inside a
  // broken region was read.
  | (FrameworkFactBase & { kind: "syntax-error" });

// A file the plugin may read: a decorator, a factory call, a call on an
// application, or an exported constant another file may read as a path.
export function wants(source: string): boolean {
  return source.includes("@") || source.includes("NestFactory") || source.includes("setGlobalPrefix") || source.includes("enableVersioning") || source.includes("export");
}

const pos = (n: Node) => ({ line: n.startPosition.row + 1, column: n.startPosition.column + 1 });
const WRAPPERS = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "type_assertion"]);
const FUNCTIONS = new Set(["function_declaration", "function_expression", "function", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"]);
const CLASSES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
// The nodes whose parts may run once, many times or not at all.
const CONDITIONAL = new Set(["if_statement", "else_clause", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "switch_default", "ternary_expression"]);
const LOGICAL = new Set(["&&", "||", "??"]);

// A plain name path: `a`, `a.b.c`; null for anything else.
export function namePath(n: Node | null): string[] | null {
  const out: string[] = [];
  let at = n;
  for (let i = 0; at && i < 16; i++) {
    while (at && WRAPPERS.has(at.type)) at = at.namedChildren[0] ?? null;
    if (!at) return null;
    if (at.type === "identifier" || at.type === "this") {
      if (at.type === "this") return null;
      out.unshift(at.text);
      return out;
    }
    if (at.type !== "member_expression") return null;
    const prop = at.childForFieldName("property");
    if (!prop || (prop.type !== "property_identifier" && prop.type !== "private_property_identifier")) return null;
    out.unshift(prop.text);
    at = at.childForFieldName("object");
  }
  return null;
}

// The string a literal holds, its escapes decoded as JavaScript decodes
// them: a quoted string or a template with no substitution; null for
// anything else or an escape the language rejects.
function stringOf(n: Node): string | null {
  if (n.type === "string") {
    let s = "";
    for (const c of n.namedChildren) {
      if (c.type === "string_fragment") s += c.text;
      else if (c.type === "escape_sequence") {
        const d = decodeEscape(c.text);
        if (d === null) return null;
        s += d;
      } else return null;
    }
    return s;
  }
  if (n.type === "template_string") {
    let s = "";
    for (const c of n.namedChildren) {
      if (c.type === "string_fragment") s += c.text;
      else if (c.type === "escape_sequence") {
        const d = decodeEscape(c.text);
        if (d === null) return null;
        s += d;
      } else return null;
    }
    return s;
  }
  return null;
}

// A path piece as a fact keeps it, by the rule of shared/kept.ts. Nest
// serves a "?" or a "#" as part of the route, never as a query, so a text
// the rule would cut there (`/items?token=x`), or an absolute URL, is not
// kept at all: no query value or credential is copied, and no route is
// listed at a shortened path. A "?" the rule keeps (`:id?`) stays.
function segmentText(s: string): string | null {
  const t = routeSegmentText(s);
  return t !== null && eitherSegmentText(s) === t ? t : null;
}

// Where a string is read, and the contexts of what it holds. `str`: a
// string here is a path or a version (kept by segmentText); null: not
// read, so not kept. `refs`: a lone name here is read as a constant of that
// form ("path", or "routes" for a RouterModule table).
type Ctx = { str: boolean; refs: "path" | "routes" | null; item?: Ctx; key?: (k: string) => Ctx; arg?: (fn: string[] | null, i: number) => Ctx; body?: Ctx };
const NONE: Ctx = { str: false, refs: null };
const PATH: Ctx = { str: true, refs: "path" };
PATH.item = PATH;
const CONTROLLER_OPTS: Ctx = { str: true, refs: "path", item: PATH, key: (k) => (k === "path" || k === "version" ? PATH : NONE) };
const MAPPING_OPTS: Ctx = { str: false, refs: null, key: (k) => (k === "path" ? PATH : NONE) };
const ROUTES: Ctx = { str: false, refs: "routes" };
const ROUTE: Ctx = { str: false, refs: null, key: (k) => (k === "path" ? PATH : k === "children" ? ROUTES : NONE) };
ROUTES.item = ROUTE;
const IMPORT_ITEM: Ctx = { str: false, refs: null, arg: (fn) => (fn && fn[fn.length - 1] === "register" ? ROUTES : NONE), body: NONE };
const MODULE_OPTS: Ctx = { str: false, refs: null, key: (k) => (k === "imports" ? { str: false, refs: null, item: IMPORT_ITEM } : NONE) };
const EXCLUDE_ITEM: Ctx = { str: true, refs: "path", key: (k) => (k === "path" ? PATH : NONE) };
const PREFIX_OPTS: Ctx = { str: false, refs: null, key: (k) => (k === "exclude" ? { str: false, refs: null, item: EXCLUDE_ITEM } : NONE) };
const VERSIONING_OPTS: Ctx = { str: false, refs: null, key: (k) => (k === "prefix" || k === "defaultVersion" ? PATH : NONE) };

// The context of each argument of a decorator the plugin reads.
function decoratorCtx(name: string, i: number): Ctx {
  if (name === "Controller") return i === 0 ? CONTROLLER_OPTS : NONE;
  if (name === "Module") return i === 0 ? MODULE_OPTS : NONE;
  if (name === "RequestMapping") return i === 0 ? MAPPING_OPTS : NONE;
  if (name === "Version" || name in ROUTE_DECORATORS) return i === 0 ? PATH : NONE;
  return NONE; // UseGuards, UseInterceptors: names only
}

export function readFacts(root: Node): NestFact[] {
  if (root.endIndex > MAX_SOURCE_BYTES) return [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }];
  const out: NestFact[] = [];
  // Locals bound to @nestjs/core's NestFactory, or to the module as a namespace.
  const coreNames = new Set<string>();
  const coreSpaces = new Set<string>();
  // Local names of decorators imported from @nestjs/common under another name.
  const commonAlias = new Map<string, string>();
  // Module-level constants: name to declarator, and whether exported.
  const constants = new Map<string, { value: Node; exported: boolean }>();
  // Names read as constants, with the form they are read in, the steps
  // from the read that first named each, and the names left to read.
  const reads = new Map<string, "path" | "routes">();
  const steps = new Map<string, number>();
  const queue: string[] = [];
  let step = 0; // the steps of a name read now
  const noteRead = (name: string, form: "path" | "routes") => {
    const prev = reads.get(name);
    if (!prev || form === "routes") reads.set(name, form);
    if (prev) return;
    steps.set(name, step);
    queue.push(name);
  };
  // Names an export clause with no source exports under their own name.
  const clauseExports = new Set<string>();
  let shadowSteps = 0;

  for (const st of root.namedChildren) {
    if (st.type === "import_statement") {
      const src = st.childForFieldName("source");
      const spec = src ? stringOf(src) : null;
      const clause = st.namedChildren.find((c) => c.type === "import_clause");
      if (spec === "@nestjs/common") {
        // A decorator imported under another name is read by the name it is imported as.
        for (const c of clause?.namedChildren ?? []) {
          if (c.type !== "named_imports") continue;
          for (const s of c.namedChildren) {
            const name = s.type === "import_specifier" ? s.childForFieldName("name")?.text : undefined;
            const alias = s.type === "import_specifier" ? s.childForFieldName("alias")?.text : undefined;
            if (name && alias && isWatched(name)) commonAlias.set(alias, name);
          }
        }
        continue;
      }
      if (spec !== "@nestjs/core") continue;
      for (const c of clause?.namedChildren ?? []) {
        if (c.type === "namespace_import") {
          const id = c.namedChildren.find((x) => x.type === "identifier");
          if (id) coreSpaces.add(id.text);
        } else if (c.type === "named_imports") {
          for (const spec of c.namedChildren) {
            if (spec.type !== "import_specifier") continue;
            const name = spec.childForFieldName("name")?.text;
            const alias = spec.childForFieldName("alias")?.text;
            if (name === "NestFactory") coreNames.add(alias ?? name);
          }
        }
      }
      continue;
    }
    const exported = st.type === "export_statement";
    if (exported && !st.childForFieldName("source") && !st.children.some((c) => c.type === "type")) {
      // `export { A }`: A is exported under its own name. An aliased name
      // (`export { A as B }`) is not marked, so a lookup by the exported
      // name never reads another constant of the file that has that name.
      const clause = st.namedChildren.find((c) => c.type === "export_clause");
      for (const s of clause?.namedChildren ?? []) {
        if (s.type !== "export_specifier" || s.children.some((c) => c.type === "type")) continue;
        const name = s.childForFieldName("name");
        const alias = s.childForFieldName("alias");
        if (name?.type === "identifier" && (!alias || alias.text === name.text)) clauseExports.add(name.text);
      }
    }
    const decl = exported ? st.childForFieldName("declaration") : st;
    if (!decl || decl.type !== "lexical_declaration" || decl.child(0)?.type !== "const") continue;
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      const value = d.childForFieldName("value");
      if (name?.type === "identifier" && value && !constants.has(name.text)) constants.set(name.text, { value, exported });
    }
  }
  for (const name of clauseExports) {
    const c = constants.get(name);
    if (c) c.exported = true;
  }

  // What `name` reads at `n` when a function around it, or a block inside
  // one, binds it: the value of a `const` declared with one, else "other"
  // (a parameter, a `let`, a nested function or class); null when no
  // function binds it (a module-level name). Past MAX_SHADOW_STEPS every
  // name counts as bound to something not read.
  const binding = (n: Node, name: string): Node | "other" | null => {
    for (let at = n.parent; at && at.type !== "program"; at = at.parent) {
      if (++shadowSteps > MAX_SHADOW_STEPS) return "other";
      if (FUNCTIONS.has(at.type)) {
        const params = at.childForFieldName("parameters") ?? at.childForFieldName("parameter");
        if (params && declares(params, name)) return "other";
      }
      if (at.type === "statement_block" || at.type === "class_body") {
        for (const c of at.namedChildren) {
          if (++shadowSteps > MAX_SHADOW_STEPS) return "other";
          if (c.type === "lexical_declaration" || c.type === "variable_declaration") {
            for (const d of c.namedChildren) {
              if (d.type !== "variable_declarator" || !declares(d.childForFieldName("name"), name)) continue;
              const value = d.childForFieldName("value");
              return c.child(0)?.type === "const" && d.childForFieldName("name")?.type === "identifier" && value ? value : "other";
            }
          }
          if ((c.type === "function_declaration" || CLASSES.has(c.type)) && c.childForFieldName("name")?.text === name) return "other";
        }
      }
    }
    return null;
  };
  const shadowed = (n: Node, name: string): boolean => binding(n, name) !== null;
  // Whether a binding pattern binds `name` (bounded by MAX_SHADOW_STEPS).
  const declares = (p: Node | null, name: string): boolean => {
    if (!p) return false;
    if (p.type === "identifier") return p.text === name;
    const stack = [p];
    while (stack.length > 0) {
      const x = stack.pop() as Node;
      if (++shadowSteps > MAX_SHADOW_STEPS) return true;
      if ((x.type === "identifier" || x.type === "shorthand_property_identifier_pattern") && x.text === name) {
        const parent = x.parent;
        // A type or a default value is no binding.
        if (parent && (parent.type === "type_annotation" || (parent.type === "assignment_pattern" && parent.childForFieldName("right")?.id === x.id))) continue;
        return true;
      }
      if (x.type === "type_annotation" || x.type === "decorator") continue;
      for (const c of x.namedChildren) stack.push(c);
    }
    return false;
  };

  // A value as the plugin reads it, in a context.
  const readArg = (n: Node, ctx: Ctx, depth: number, local: Node | null): Arg => {
    let at = n;
    while (WRAPPERS.has(at.type) && at.namedChildren[0]) at = at.namedChildren[0];
    const p = pos(at);
    if (depth > MAX_DEPTH) return { t: "other", ...p };
    const s = stringOf(at);
    if (s !== null) return { t: "str", v: ctx.str ? segmentText(s) : null, ...p };
    if (at.type === "true" || at.type === "false") return { t: "bool", v: at.type === "true", ...p };
    const path = namePath(at);
    if (path) {
      // A lone name read as a constant: its module-level value is kept. A
      // name a function around the read binds is read only as a `const`
      // string of that function; anything else it binds is not read.
      if (ctx.refs && path.length === 1) {
        const name = path[0] as string;
        const b = local ? binding(local, name) : null;
        if (b === null) noteRead(name, ctx.refs);
        else {
          const text = b === "other" ? null : stringOf(b);
          return ctx.refs === "path" && text !== null ? { t: "str", v: segmentText(text), ...p } : { t: "other", ...p };
        }
      }
      return { t: "ref", path, ...p };
    }
    if (at.type === "array") {
      const items: Arg[] = [];
      let more = 0;
      for (const c of at.namedChildren) {
        if (c.type === "comment") continue;
        if (c.type === "spread_element" || items.length >= MAX_ITEMS) {
          more++;
          continue;
        }
        items.push(readArg(c, ctx.item ?? NONE, depth + 1, local));
      }
      return { t: "arr", items, more, ...p };
    }
    if (at.type === "object") {
      const props: { key: string; value: Arg }[] = [];
      let more = 0;
      for (const c of at.namedChildren) {
        if (c.type === "comment") continue;
        if (props.length >= MAX_ITEMS) {
          more++;
          continue;
        }
        if (c.type === "pair") {
          const k = c.childForFieldName("key");
          const v = c.childForFieldName("value");
          const key = k?.type === "property_identifier" ? k.text : k && stringOf(k) !== null ? stringOf(k) : null;
          if (key === null || !v) {
            more++;
            continue;
          }
          props.push({ key, value: readArg(v, ctx.key ? ctx.key(key) : NONE, depth + 1, local) });
        } else if (c.type === "shorthand_property_identifier") {
          const sub = ctx.key ? ctx.key(c.text) : NONE;
          if (sub.refs && local && shadowed(local, c.text)) props.push({ key: c.text, value: { t: "other", ...pos(c) } });
          else {
            if (sub.refs) noteRead(c.text, sub.refs);
            props.push({ key: c.text, value: { t: "ref", path: [c.text], ...pos(c) } });
          }
        } else more++;
      }
      return { t: "obj", props, more, ...p };
    }
    if (at.type === "call_expression") {
      let fnNode = at.childForFieldName("function");
      while (fnNode && WRAPPERS.has(fnNode.type)) fnNode = fnNode.namedChildren[0] ?? null;
      const fn = namePath(fnNode);
      const list = at.childForFieldName("arguments");
      const args: Arg[] = [];
      let more = 0;
      for (const c of list?.namedChildren ?? []) {
        if (c.type === "comment") continue;
        if (c.type === "spread_element" || args.length >= MAX_ITEMS) {
          more++;
          continue;
        }
        args.push(readArg(c, ctx.arg ? ctx.arg(fn, args.length) : NONE, depth + 1, local));
      }
      return { t: "call", fn, args, more, ...p };
    }
    if (at.type === "new_expression") return { t: "new", fn: namePath(at.childForFieldName("constructor")), ...p };
    if (at.type === "arrow_function") {
      const body = at.childForFieldName("body");
      return { t: "arrow", body: body && body.type !== "statement_block" ? readArg(body, ctx.body ?? NONE, depth + 1, local) : null, ...p };
    }
    return { t: "other", ...p };
  };

  // A decorator node read: its callee, and its arguments when the plugin reads it.
  const readDeco = (d: Node, local: Node | null): Deco | null => {
    let e = d.namedChildren[0] ?? null;
    while (e && WRAPPERS.has(e.type)) e = e.namedChildren[0] ?? null;
    if (!e) return null;
    const called = e.type === "call_expression";
    const fn = namePath(called ? e.childForFieldName("function") : e);
    if (!fn) return null;
    const name = fn.length === 1 ? (commonAlias.get(fn[0] as string) ?? (fn[0] as string)) : (fn[fn.length - 1] as string);
    if (!isWatched(name)) return null;
    const args: Arg[] = [];
    let more = 0;
    if (called) {
      for (const c of e.childForFieldName("arguments")?.namedChildren ?? []) {
        if (c.type === "comment") continue;
        if (c.type === "spread_element" || args.length >= MAX_ITEMS) {
          more++;
          continue;
        }
        args.push(readArg(c, decoratorCtx(name, args.length), 0, local));
      }
    }
    const deco: Deco = { fn, called, args, more, ...pos(d) };
    if (local && shadowed(local, fn[0] as string)) deco.shadowed = true;
    return deco;
  };

  // Whether a static method builds an object with controllers, imports or a spread.
  const buildsModule = (body: Node | null): boolean => {
    if (!body) return false;
    const stack = [body];
    let steps = 0;
    while (stack.length > 0) {
      const x = stack.pop() as Node;
      if (++steps > 20_000) return true;
      if (x.type === "object") {
        for (const c of x.namedChildren) {
          if (c.type === "spread_element") return true;
          const key = c.type === "pair" ? c.childForFieldName("key")?.text : c.type === "shorthand_property_identifier" ? c.text : null;
          if (key === "controllers" || key === "imports") return true;
        }
      }
      for (const c of x.namedChildren) stack.push(c);
    }
    return false;
  };

  const readClass = (c: Node) => {
    const nameNode = c.childForFieldName("name");
    const parent = c.parent;
    const top = parent?.type === "program" || (parent?.type === "export_statement" && parent.parent?.type === "program");
    const local = top ? null : c;
    const decorators: Deco[] = [];
    const decoNodes = [...(parent?.type === "export_statement" ? parent.childrenForFieldName("decorator") : []), ...c.namedChildren.filter((x) => x.type === "decorator")];
    for (const d of decoNodes) {
      const r = readDeco(d, local);
      if (r) decorators.push(r);
    }
    const members: Member[] = [];
    const names: string[] = [];
    let cut = 0;
    let namesCut = false;
    let dynamic = false;
    const body = c.childForFieldName("body");
    let pending: Node[] = [];
    for (const m of body?.namedChildren ?? []) {
      if (m.type === "decorator") {
        pending.push(m);
        continue;
      }
      const decos = m.type === "method_definition" ? [...pending, ...m.namedChildren.filter((x) => x.type === "decorator")] : [];
      pending = [];
      if (m.type !== "method_definition" && m.type !== "public_field_definition" && m.type !== "field_definition" && m.type !== "method_signature" && m.type !== "abstract_method_signature") continue;
      const key = m.childForFieldName("name") ?? m.childForFieldName("property");
      const name = key && (key.type === "property_identifier" || key.type === "private_property_identifier") ? key.text : key && stringOf(key) !== null ? stringOf(key) : null;
      if (name !== null) {
        if (names.length < MAX_NAMES) names.push(name);
        else namesCut = true;
      }
      const isStatic = m.children.some((x) => x.type === "static");
      if (isStatic && m.type === "method_definition" && !dynamic) dynamic = buildsModule(m.childForFieldName("body"));
      if (m.type !== "method_definition") continue;
      const read: Deco[] = [];
      for (const d of decos) {
        const r = readDeco(d, local);
        if (r) read.push(r);
      }
      if (read.length === 0) continue;
      if (members.length >= MAX_MEMBERS) {
        cut++;
        continue;
      }
      members.push({ name, ...pos(key ?? m), static: isStatic, decorators: read });
    }
    if (decorators.length === 0 && members.length === 0 && cut === 0) return;
    const heritage = c.namedChildren.find((x) => x.type === "class_heritage");
    const ext = heritage?.namedChildren.find((x) => x.type === "extends_clause") ?? (heritage && heritage.child(0)?.type === "extends" ? heritage : null);
    const baseNode = ext ? (ext.childForFieldName("value") ?? ext.namedChildren.find((x) => x.type !== "type_arguments") ?? null) : null;
    out.push({ kind: "class", name: nameNode?.text ?? null, ...pos(nameNode ?? c), top, decorators, members, cut, base: baseNode ? readArg(baseNode, NONE, 0, local) : null, names, namesCut, dynamic });
  };

  // The line of the function around a node (0 at module level), and the
  // start of the block it is a statement of. A node a condition or a loop
  // holds without a block of its own (`if (x) app.setGlobalPrefix("api");`,
  // `x && app.setGlobalPrefix("api")`) is in the block of that condition,
  // so it never reads as a statement of the block around it.
  const scopeOf = (n: Node): number => {
    for (let at = n.parent; at; at = at.parent) if (FUNCTIONS.has(at.type)) return at.startPosition.row + 1;
    return 0;
  };
  const blockOf = (n: Node): number => {
    for (let at = n.parent; at; at = at.parent) if (at.type === "statement_block" || at.type === "program" || CONDITIONAL.has(at.type) || (at.type === "binary_expression" && LOGICAL.has(at.childForFieldName("operator")?.type ?? ""))) return at.startIndex;
    return 0;
  };

  const readCall = (call: Node) => {
    let fnNode = call.childForFieldName("function");
    // `await NestFactory.create(M)` parses as a call whose callee is `await NestFactory.create`.
    const awaited = fnNode?.type === "await_expression";
    if (awaited) fnNode = fnNode?.namedChildren[0] ?? null;
    if (fnNode?.type !== "member_expression") return;
    const prop = fnNode.childForFieldName("property")?.text ?? "";
    const recvNode = fnNode.childForFieldName("object");
    const recv = namePath(recvNode);
    const args = call.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? [];
    // The import is read only where no function around the call binds its name.
    if (prop === "create" && recv && ((recv.length === 1 && coreNames.has(recv[0] as string)) || (recv.length === 2 && coreSpaces.has(recv[0] as string) && recv[1] === "NestFactory")) && !shadowed(call, recv[0] as string)) {
      // The name the application is bound to: `const app = await NestFactory.create(M)`, `app = ...`.
      let up: Node | null = call.parent;
      while (up && (up.type === "await_expression" || WRAPPERS.has(up.type))) up = up.parent;
      let name: string | null = null;
      if (up?.type === "variable_declarator" && up.childForFieldName("name")?.type === "identifier") name = up.childForFieldName("name")?.text ?? null;
      else if (up?.type === "assignment_expression" && up.childForFieldName("left")?.type === "identifier") name = up.childForFieldName("left")?.text ?? null;
      const first = args[0];
      out.push({ kind: "factory", ...pos(call), fn: recv, module: first ? readArg(first, NONE, 0, null) : null, name, scope: scopeOf(call), block: blockOf(call) });
      return;
    }
    if (!APP_CALLS.has(prop)) return;
    const ctxs = prop === "setGlobalPrefix" ? [PATH, PREFIX_OPTS] : [VERSIONING_OPTS];
    const read: Arg[] = [];
    let more = 0;
    for (const a of args) {
      if (a.type === "spread_element" || read.length >= ctxs.length) {
        more++;
        continue;
      }
      read.push(readArg(a, ctxs[read.length] as Ctx, 0, call));
    }
    out.push({ kind: "app-call", ...pos(call), prop, recv, args: read, more, scope: scopeOf(call), block: blockOf(call) });
  };

  // ---------- the walk ----------
  let broken: { line: number; column: number } | null = null;
  const cursor = root.walk();
  try {
    let descend = true;
    for (;;) {
      if (descend) {
        const type = cursor.nodeType;
        if (type === "ERROR" || cursor.currentNode.isMissing) {
          broken ??= { line: cursor.startPosition.row + 1, column: cursor.startPosition.column + 1 };
          descend = false;
          continue;
        }
        if (CLASSES.has(type)) readClass(cursor.currentNode);
        else if (type === "call_expression") readCall(cursor.currentNode);
        if (cursor.gotoFirstChild()) continue;
      }
      if (cursor.gotoNextSibling()) {
        descend = true;
        continue;
      }
      if (!cursor.gotoParent()) break;
      descend = false;
    }
  } finally {
    cursor.delete();
  }

  // ---------- the constants the facts read ----------
  // Each name read is read once, in the order it was first named. Reading
  // a constant may name another (`const P = BASE`), declared before or
  // after it, which joins the queue one step further on.
  const emitted = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i] as string;
    const c = constants.get(name);
    const at = steps.get(name) ?? 0;
    if (!c || at > MAX_CONSTANT_STEPS) continue;
    emitted.add(name);
    step = at + 1;
    out.push({ kind: "value", name, ...pos(c.value), value: readArg(c.value, reads.get(name) === "routes" ? ROUTES : PATH, 0, null), exported: c.exported });
  }
  for (const [name, c] of constants) {
    // An exported string constant another file may read as a path: kept
    // only when it is short and has a path's shape (letters, digits and
    // `/ : _ - . *`), as the kept-string rule keeps it.
    if (emitted.has(name) || !c.exported) continue;
    const s = stringOf(c.value);
    if (s !== null && s.length > 0 && s.length <= MAX_EXPORTED_CONSTANT && pathShaped(s) && keptText(s) === s) out.push({ kind: "value", name, ...pos(c.value), value: { t: "str", v: s, ...pos(c.value) }, exported: true });
  }
  if (broken) out.push({ kind: "syntax-error", ...broken });
  return out;
}

function pathShaped(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 58 || c === 95 || c === 45 || c === 46 || c === 42;
    if (!ok) return false;
  }
  return true;
}

// ---------- shape checks for facts read back from disk ----------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isPos = (v: Record<string, unknown>) => isNum(v.line) && isNum(v.column);

export function isArg(v: unknown, depth = 0): v is Arg {
  if (!isObj(v) || !isPos(v) || depth > MAX_DEPTH + 2) return false;
  switch (v.t) {
    case "str":
      return v.v === null || typeof v.v === "string";
    case "ref":
      return isStrs(v.path) && v.path.length > 0;
    case "bool":
      return typeof v.v === "boolean";
    case "arr":
      return Array.isArray(v.items) && v.items.every((x) => isArg(x, depth + 1)) && isNum(v.more);
    case "obj":
      return Array.isArray(v.props) && v.props.every((p) => isObj(p) && typeof p.key === "string" && isArg(p.value, depth + 1)) && isNum(v.more);
    case "call":
      return (v.fn === null || isStrs(v.fn)) && Array.isArray(v.args) && v.args.every((x) => isArg(x, depth + 1)) && isNum(v.more);
    case "new":
      return v.fn === null || isStrs(v.fn);
    case "arrow":
      return v.body === null || isArg(v.body, depth + 1);
    case "other":
      return true;
    default:
      return false;
  }
}
const isDeco = (v: unknown): v is Deco => isObj(v) && isPos(v) && isStrs(v.fn) && v.fn.length > 0 && typeof v.called === "boolean" && Array.isArray(v.args) && v.args.every((a) => isArg(a)) && isNum(v.more) && (v.shadowed === undefined || typeof v.shadowed === "boolean");
const isMember = (v: unknown): v is Member => isObj(v) && isPos(v) && (v.name === null || typeof v.name === "string") && typeof v.static === "boolean" && Array.isArray(v.decorators) && v.decorators.every(isDeco);

export function isNestFact(v: unknown): v is NestFact {
  if (!isObj(v) || !isPos(v)) return false;
  switch (v.kind) {
    case "class":
      return (v.name === null || typeof v.name === "string") && typeof v.top === "boolean" && Array.isArray(v.decorators) && v.decorators.every(isDeco) && Array.isArray(v.members) && v.members.every(isMember) && isNum(v.cut) && (v.base === null || isArg(v.base)) && isStrs(v.names) && typeof v.namesCut === "boolean" && typeof v.dynamic === "boolean";
    case "factory":
      return isStrs(v.fn) && (v.module === null || isArg(v.module)) && (v.name === null || typeof v.name === "string") && isNum(v.scope) && isNum(v.block);
    case "app-call":
      return typeof v.prop === "string" && (v.recv === null || isStrs(v.recv)) && Array.isArray(v.args) && v.args.every((a) => isArg(a)) && isNum(v.more) && isNum(v.scope) && isNum(v.block);
    case "value":
      return typeof v.name === "string" && isArg(v.value) && typeof v.exported === "boolean";
    case "too-large":
      return isNum(v.bytes);
    case "syntax-error":
      return true;
    default:
      return false;
  }
}
