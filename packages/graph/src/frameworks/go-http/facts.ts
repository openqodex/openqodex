// The Go net/http plugin's context-free facts of one Go file: the calls it
// watches (`x.Handle(...)`, `x.HandleFunc(...)`, `x.ListenAndServe(...)`,
// `x.NewRequest(...)`), the values names are bound to, the parameters and
// receivers with a named type, the package-level string constants, the
// `Server{...}` literals, the ServeHTTP methods and the functions shaped like
// a go test. Nothing here knows which name is net/http: that is decided in
// resolve, from the file's imports. What the walk does record is whether a
// name is declared inside a function at the point it is used, so a local
// value named `http` can never pass for the package.
//
// Everything read here is bounded: a file over MAX_SOURCE_BYTES is not read
// at all, an expression is read to at most MAX_EXPR_DEPTH levels and
// MAX_EXPR_NODES nodes, a call keeps MAX_ARGS arguments, a name chain
// MAX_NAME_PARTS parts and a string MAX_STRING characters. The enclosing
// function of a node comes from a stack kept during the one walk over the
// tree, never from a walk up its parents.
import type { Node } from "web-tree-sitter";
import { assembledText, keepParts, keptShape, ledForm, methodText, requestPathText, requestSegmentText, routePathText, routeSegmentText, urlParts } from "../shared/kept.js";
import type { FrameworkFactBase } from "../plugin.js";

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_EXPR_NODES = 256; // nodes read for one fact's expressions
export const MAX_EXPR_DEPTH = 96; // nested levels read in one expression: a wrapper chain longer than the middleware cap stays readable
export const MAX_ARGS = 24; // arguments of a call, fields of a literal
export const MAX_NAME_PARTS = 16; // parts of a name chain `a.b.c`
export const MAX_STRING = 2048; // characters of a string literal kept
export const MAX_SCOPES = 16; // enclosing functions recorded per fact
const MAX_PARTS = 32; // pieces of a computed string

// The selector calls watched: registrations, the servers that serve a
// handler, and the test requests of httptest.
const WATCHED = new Set(["Handle", "HandleFunc", "ListenAndServe", "ListenAndServeTLS", "Serve", "ServeTLS", "NewRequest", "NewRequestWithContext"]);

export type Pos = { line: number; column: number };

function pos(node: Node): Pos {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

// An expression as the plugin reads it. `str` is a string literal; `dyn` a
// concatenation, with its pieces when each is a literal or a name; `ref` a
// name or a chain of names (`h`, `handlers.GetItem`), with `local` set when
// its first name is declared inside a function where it is used, and `decl`
// naming that declaration (see `Decl` below); `call` a
// call or a conversion; `lit` a composite literal (`T{}`, `&pkg.T{X: y}`)
// with its keyed fields; `fn` a function literal; `nil`; `other` anything
// else. A read limit never passes for a complete read: what lay past it is
// `other` with `cut` set, and a call or a literal whose list was cut short
// says how many arguments or fields it left out (`omitted`).
export type Part = { s: string } | { ref: string[]; local: boolean };
// A local declaration's key: the line and column of the name it declares
// ("12:2"). A use carries the key of the one declaration it names at that
// point, so a declaration in a block that has closed is never the one a
// later use reads.
export type Decl = string;
export type Expr =
  | ({ t: "str"; v: string } & Pos)
  | ({ t: "dyn"; parts: Part[] | null } & Pos)
  | ({ t: "ref"; path: string[]; local: boolean; decl: Decl | null } & Pos)
  | ({ t: "call"; fn: Expr; args: Expr[]; omitted?: number } & Pos)
  | ({ t: "lit"; type: string[] | null; addr: boolean; fields: { key: string; value: Expr }[]; omitted?: number } & Pos)
  | ({ t: "fn" } & Pos)
  | ({ t: "nil" } & Pos)
  | ({ t: "other"; cut?: boolean } & Pos);

// Whether an expression is what lay past a read limit.
export function isCut(e: Expr): boolean {
  return e.t === "other" && e.cut === true;
}

export type GoHttpFact =
  // A watched selector call: `recv.prop(args)`. `scopes` holds the lines of
  // the enclosing functions, innermost first; empty at package level.
  // `omitted`: the arguments past MAX_ARGS, not read.
  | (FrameworkFactBase & { kind: "call"; recv: Expr; prop: string; args: Expr[]; scopes: number[]; omitted?: number })
  // A name bound to a value: `mux := http.NewServeMux()`, `var h = T{}`,
  // `mux = other`. Empty `scopes`: declared at package level. `decl` is the
  // local declaration the name is (its own key for `:=` and `var`, the one
  // an assignment names), null at package level or for a package variable.
  | (FrameworkFactBase & { kind: "value"; name: string; value: Expr; scopes: number[]; decl: Decl | null })
  // A parameter or receiver with a named type: `m *http.ServeMux`,
  // `s *server`, `next http.Handler`; `func` when the type is a function
  // type. `index` is the position among the parameters, -1 for a receiver.
  // `scope` is the line of the function that declares it; `decl` its key.
  | (FrameworkFactBase & { kind: "param"; name: string; type: string[]; pointer: boolean; func: boolean; index: number; scope: number; decl: Decl })
  // A package-level string constant: `const prefix = "/api"`.
  | (FrameworkFactBase & { kind: "const"; name: string; value: string })
  // A composite literal of a type named Server: `http.Server{Handler: h}`.
  // `handler` is null when the literal sets no Handler field.
  | (FrameworkFactBase & { kind: "server"; type: string[]; handler: Expr | null; scopes: number[] })
  // A method named ServeHTTP: its receiver type, and whether the receiver is a pointer.
  | (FrameworkFactBase & { kind: "serve-http"; recv: string; pointer: boolean })
  // A function `func TestX(t *pkg.T)`: its name and its one parameter's type.
  | (FrameworkFactBase & { kind: "test-func"; name: string; param: string[] })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has a syntax error: calls inside a broken region were not read.
  | (FrameworkFactBase & { kind: "parse-error" });

// Whether to read a file's facts. Every Go file is read. A text test would
// have to be a superset of every fact read, and one fact kind has none: a
// package-level value (`var admin = AdminHandler{}`, `var Mux = other.Mux`)
// is read from any file of a package, and nothing in its text has to name
// net/http. The other kinds do have one (Go has no identifier escapes): a
// watched call needs "Handle", "Serve" or "NewRequest" (ListenAndServe holds
// "Serve"), a server literal "Server", a ServeHTTP method "ServeHTTP", a
// test function "Test". So a file with none of those keeps only the facts
// another file can use (see `keepOutside`), and the cost of reading it is
// one walk over its tree.
export function wants(_source: string): boolean {
  return true;
}

// ---------- reading expressions ----------

type Budget = { left: number };
// The local declaration a name has where it is read, or null when none
// inside a function declares it (a package-level name or an import).
type DeclHere = (name: string) => Decl | null;

// Go's one-character escapes and the byte each stands for.
const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "'": 39, '"': 34 };
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8");

// The bytes one escape sequence of an interpreted string stands for, by
// Go's rules: `\xHH` and octal `\NNN` are one byte each, `\uHHHH` and
// `\UHHHHHHHH` a code point written as UTF-8. Null for a sequence Go refuses.
function escapeBytes(seq: string): number[] | null {
  const k = seq.slice(1);
  const simple = ESCAPES[k];
  if (simple !== undefined) return [simple];
  const head = k[0];
  const hex = (s: string, n: number) => (s.length === n && [...s].every((c) => "0123456789abcdefABCDEF".includes(c)) ? Number.parseInt(s, 16) : -1);
  if (head === "x") {
    const b = hex(k.slice(1), 2);
    return b < 0 ? null : [b];
  }
  if (head === "u" || head === "U") {
    const cp = hex(k.slice(1), head === "u" ? 4 : 8);
    if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    return [...utf8.encode(String.fromCodePoint(cp))];
  }
  if (k.length === 3 && [...k].every((c) => c >= "0" && c <= "7")) {
    const b = Number.parseInt(k, 8);
    return b > 255 ? null : [b];
  }
  return null;
}

// The value of a Go string literal, decoded from the tree's own nodes: a raw
// string's content as written (Go drops its carriage returns), an
// interpreted string's content with each escape sequence decoded. Null when
// the node is not a string literal, holds a syntax error, or is longer than
// MAX_STRING.
export function stringValue(node: Node | null): string | null {
  if (!node || node.hasError || node.endIndex - node.startIndex > MAX_STRING + 2) return null;
  if (node.type === "raw_string_literal") {
    let out = "";
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === "raw_string_literal_content") out += c.text;
    }
    return out.replaceAll("\r", "");
  }
  if (node.type !== "interpreted_string_literal") return null;
  const bytes: number[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "escape_sequence") {
      const b = escapeBytes(c.text);
      if (b === null) return null;
      bytes.push(...b);
    } else if (c.type === "interpreted_string_literal_content") bytes.push(...utf8.encode(c.text));
    else return null;
  }
  return fromUtf8.decode(new Uint8Array(bytes));
}

// Whether a node is a string literal longer than MAX_STRING: its value is not read.
const tooLong = (n: Node): boolean => (n.type === "interpreted_string_literal" || n.type === "raw_string_literal") && n.endIndex - n.startIndex > MAX_STRING + 2;

// A name chain `a.b.c`; null when a part is not a plain name, "cut" when
// the chain is longer than MAX_NAME_PARTS. Walks down the operand side in a loop.
function namePath(node: Node): string[] | null | "cut" {
  const parts: string[] = [];
  let cur: Node | null = node;
  while (cur && cur.type === "selector_expression") {
    if (parts.length >= MAX_NAME_PARTS) return "cut";
    const field = cur.childForFieldName("field");
    if (!field) return null;
    parts.push(field.text);
    cur = cur.childForFieldName("operand");
  }
  if (!cur || cur.type !== "identifier") return null;
  parts.push(cur.text);
  return parts.reverse();
}

// A type written as a name: `T`, `pkg.T`, `T[X]`.
function typePath(node: Node | null): string[] | null {
  if (!node) return null;
  if (node.type === "type_identifier") return [node.text];
  if (node.type === "qualified_type") {
    const pkg = node.childForFieldName("package");
    const name = node.childForFieldName("name");
    return pkg && name ? [pkg.text, name.text] : null;
  }
  if (node.type === "generic_type") return typePath(node.childForFieldName("type"));
  return null;
}

// A parameter's type: a named type, a pointer to one, or a function type.
function paramType(node: Node | null): { path: string[]; pointer: boolean; func: boolean } | null {
  if (!node) return null;
  if (node.type === "function_type") return { path: [], pointer: false, func: true };
  if (node.type === "pointer_type") {
    const inner = typePath(node.firstNamedChild);
    return inner ? { path: inner, pointer: true, func: false } : null;
  }
  const path = typePath(node);
  return path ? { path, pointer: false, func: false } : null;
}

// The pieces of a `+` chain, left to right, with an explicit stack; null
// when a piece is neither a string literal nor a name, "cut" past a read
// limit (the budget, MAX_PARTS, a string or a name chain too long).
function stringParts(node: Node, b: Budget, declHere: DeclHere): Part[] | null | "cut" {
  const out: Part[] = [];
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (b.left-- <= 0 || out.length >= MAX_PARTS || tooLong(n)) return "cut";
    if (n.type === "parenthesized_expression" && n.firstNamedChild) {
      stack.push(n.firstNamedChild);
      continue;
    }
    if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (!left || !right) return null;
      stack.push(right, left);
      continue;
    }
    const s = stringValue(n);
    if (s !== null) {
      out.push({ s });
      continue;
    }
    const path = n.type === "identifier" ? [n.text] : n.type === "selector_expression" ? namePath(n) : null;
    if (path === "cut") return "cut";
    if (!path) return null;
    out.push({ ref: path, local: declHere(path[0] as string) !== null });
  }
  return out;
}

const ref = (path: string[], decl: Decl | null, p: Pos): Expr => ({ t: "ref", path, local: decl !== null, decl, ...p });
const cut = (p: Pos): Expr => ({ t: "other", cut: true, ...p });

// The arguments of a call, at most MAX_ARGS, and how many past it were left out.
function readArgs(list: Node | null, b: Budget, depth: number, declHere: DeclHere): { args: Expr[]; omitted: number } {
  const args: Expr[] = [];
  let omitted = 0;
  for (let i = 0; list && i < list.namedChildCount; i++) {
    const a = list.namedChild(i);
    if (!a || a.type === "comment") continue;
    if (args.length < MAX_ARGS) args.push(read(a, b, depth, declHere));
    else omitted++;
  }
  return { args, omitted };
}

function read(node: Node | null, b: Budget, depth: number, declHere: DeclHere): Expr {
  if (!node) return { t: "other", line: 0, column: 0 };
  const p = pos(node);
  if (b.left <= 0 || depth > MAX_EXPR_DEPTH) return cut(p);
  b.left--;
  switch (node.type) {
    case "parenthesized_expression":
      return read(node.firstNamedChild, b, depth + 1, declHere);
    case "interpreted_string_literal":
    case "raw_string_literal": {
      if (tooLong(node)) return cut(p);
      const v = stringValue(node);
      return v === null ? { t: "other", ...p } : { t: "str", v, ...p };
    }
    case "binary_expression": {
      if (node.childForFieldName("operator")?.text !== "+") return { t: "other", ...p };
      const parts = stringParts(node, b, declHere);
      return parts === "cut" ? cut(p) : { t: "dyn", parts, ...p };
    }
    case "identifier":
      return ref([node.text], declHere(node.text), p);
    case "nil":
      return { t: "nil", ...p };
    case "selector_expression": {
      const path = namePath(node);
      if (path === "cut") return cut(p);
      return path ? ref(path, declHere(path[0] as string), p) : { t: "other", ...p };
    }
    case "call_expression": {
      const fn = read(node.childForFieldName("function"), b, depth + 1, declHere);
      const { args, omitted } = readArgs(node.childForFieldName("arguments"), b, depth + 1, declHere);
      return omitted > 0 ? { t: "call", fn, args, omitted, ...p } : { t: "call", fn, args, ...p };
    }
    case "unary_expression": {
      const operand = node.childForFieldName("operand");
      if (node.childForFieldName("operator")?.text !== "&" || operand?.type !== "composite_literal") return { t: "other", ...p };
      const lit = read(operand, b, depth + 1, declHere);
      return lit.t === "lit" ? { ...lit, addr: true, ...p } : lit;
    }
    case "composite_literal": {
      const fields: { key: string; value: Expr }[] = [];
      let omitted = 0;
      const body = node.childForFieldName("body");
      for (let i = 0; body && i < body.namedChildCount; i++) {
        const el = body.namedChild(i);
        if (el?.type !== "keyed_element") continue;
        if (fields.length >= MAX_ARGS) {
          omitted++;
          continue;
        }
        const keyNode = el.childForFieldName("key") ?? el.namedChild(0);
        const valueNode = el.childForFieldName("value") ?? el.namedChild(1);
        const key = keyNode?.type === "literal_element" ? keyNode.firstNamedChild : keyNode;
        const value = valueNode?.type === "literal_element" ? valueNode.firstNamedChild : valueNode;
        if (key?.type === "identifier" || key?.type === "field_identifier") fields.push({ key: key.text, value: read(value, b, depth + 1, declHere) });
      }
      const type = typePath(node.childForFieldName("type"));
      return omitted > 0 ? { t: "lit", type, addr: false, fields, omitted, ...p } : { t: "lit", type, addr: false, fields, ...p };
    }
    case "func_literal":
      return { t: "fn", ...p };
    default:
      return { t: "other", ...p };
  }
}

// ---------- the walk ----------

// The node types that open a scope for names declared inside them.
const FUNCTION_TYPES = new Set(["function_declaration", "method_declaration", "func_literal"]);
const BLOCK_TYPES = new Set([
  "block",
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "expression_case",
  "default_case",
  "type_case",
  "communication_case",
]);

type Scope = { depth: number; names: string[]; fns: number[]; closed: boolean };
const NO_SCOPES: number[] = [];

const identifiers = (list: Node | null): Node[] => {
  const out: Node[] = [];
  for (let i = 0; list && i < list.namedChildCount; i++) {
    const c = list.namedChild(i);
    if (c?.type === "identifier") out.push(c);
  }
  return out;
};

const namedChildren = (list: Node | null): Node[] => {
  const out: Node[] = [];
  for (let i = 0; list && i < list.namedChildCount; i++) {
    const c = list.namedChild(i);
    if (c && c.type !== "comment") out.push(c);
  }
  return out;
};

// ---------- the literals the facts keep ----------
// A string is kept only where resolve reads one, by the one rule of
// shared/kept.ts: the pattern Handle and HandleFunc are given and the
// prefix http.StripPrefix is given, as the mux reads them (a route), the
// method and target of a request (a request: nothing from a "?" or a "#"
// on), and a package constant one of those names. Every other literal, in
// a handler, a value, a server or an address, is kept as `other`, and an
// unused constant is not kept.
// "segment" and "tsegment": a later piece of a route's and of a request's
// path; "tpath": a constant after an address, kept only as a request path.
export type Form = "pattern" | "path" | "method" | "target" | "tpath" | "segment" | "tsegment";
const unread = (e: Expr): Expr => ({ t: "other", line: e.line, column: e.column });
const isHostChar = (c: number) => (c >= 48 && c <= 58) || ((c | 32) >= 97 && (c | 32) <= 122) || c === 45 || c === 46 || c === 91 || c === 93;

// The start of a pattern, `[METHOD ][HOST]/[PATH]`: a path, or a method
// and its spaces, then a host up to the first "/". Null when the text
// cannot begin one.
function patternText(s: string): string | null {
  if (s.startsWith("/")) return s;
  let rest = s;
  let sp = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === " " || s[i] === "\t") {
      sp = i;
      break;
    }
  }
  if (sp >= 0) {
    if (methodText(s.slice(0, sp)) === null) return null;
    rest = s.slice(sp).trimStart();
  }
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  for (let i = 0; i < host.length; i++) if (!isHostChar(host.charCodeAt(i))) return null;
  return s;
}

// A request target: an absolute URL with its scheme, host and path, or
// the text before a query or a fragment (resolve says when that is no path).
function targetText(s: string): string {
  const u = urlParts(s);
  if (u) return u.origin + u.path;
  return (s.split("#")[0] as string).split("?")[0] as string;
}
const FORMS: Record<Form, (s: string) => string | null> = { pattern: keptShape(patternText), path: routePathText, method: methodText, target: keptShape(targetText), tpath: requestPathText, segment: routeSegmentText, tsegment: requestSegmentText };
// The path form of each place a text is read in.
const PATH_FORM: Partial<Record<Form, "route" | "request">> = { pattern: "route", path: "route", target: "request" };

function keepRead(facts: GoHttpFact[], READ: Record<string, (Form | null)[]>): GoHttpFact[] {
  // A package constant of this file, as resolve reads one (the first
  // declaration of the name), from one index made once, so a lookup per
  // concatenation never scans the facts again.
  const constants = new Map<string, string>();
  for (const f of facts) if (f.kind === "const" && !constants.has(f.name)) constants.set(f.name, f.value);
  const constant = (name: string): string | null => constants.get(name) ?? null;
  const used = new Map<string, Set<Form>>();
  const use = (ref: string[], form: Form) => {
    if (ref.length === 1) (used.get(ref[0] as string) ?? used.set(ref[0] as string, new Set()).get(ref[0] as string))?.add(form);
  };
  // Names read as a later piece of a concatenation, with the piece that
  // leads them and the form of the text they are a piece of.
  const led: { ref: string[]; lead: Part; form: Form }[] = [];
  const text = (e: Expr | undefined, form: Form): Expr | undefined => {
    if (e === undefined) return e;
    switch (e.t) {
      case "str": {
        const v = FORMS[form](e.v);
        return v === null ? unread(e) : { ...e, v };
      }
      case "dyn": {
        const pathForm = PATH_FORM[form];
        if (!e.parts || !pathForm) return unread(e);
        const own = form === "pattern" || form === "target" ? FORMS[form] : null;
        const parts = keepParts(
          e.parts,
          pathForm,
          (ref, lead) => {
            if (e.parts?.some((p) => "ref" in p && p.ref === ref && p.local)) return;
            if (lead === null) use(ref, form);
            else led.push({ ref, lead, form });
          },
          (name) => constant(name),
          own,
        );
        return parts === null ? unread(e) : { ...e, parts };
      }
      case "ref":
        if (!e.local) use(e.path, form);
        return e;
      default:
        return names(e);
    }
  };
  // An expression read only for its names, calls and literals' types: no
  // string in it, except the prefix http.StripPrefix is given.
  const names = (e: Expr): Expr => {
    switch (e.t) {
      case "str":
      case "dyn":
        return unread(e);
      case "call": {
        const strip = e.fn.t === "ref" && e.fn.path[e.fn.path.length - 1] === "StripPrefix";
        return { ...e, fn: names(e.fn), args: e.args.map((a, i) => (strip && i === 0 ? (text(a, "path") as Expr) : names(a))) };
      }
      case "lit":
        return { ...e, fields: e.fields.map((f) => ({ key: f.key, value: names(f.value) })) };
      default:
        return e;
    }
  };
  const out: GoHttpFact[] = facts.map((f) => {
    switch (f.kind) {
      case "call": {
        const read = READ[f.prop] ?? [];
        return { ...f, recv: names(f.recv), args: f.args.map((a, i) => (read[i] ? (text(a, read[i] as Form) as Expr) : names(a))) };
      }
      case "value":
        return { ...f, value: names(f.value) };
      case "server":
        return { ...f, handler: f.handler && names(f.handler) };
      default:
        return f;
    }
  });
  // A later piece is kept as a piece of the path it is in; after an
  // address of another host, only as a path of its own.
  for (const l of led) {
    const lf = ledForm(l.lead, constant);
    use(l.ref, l.form === "target" ? (lf === "segment" ? "tsegment" : "tpath") : lf === "segment" ? "segment" : "path");
  }
  // A constant is kept, in the form a use reads it in, only when some use reads it.
  const kept: GoHttpFact[] = [];
  for (const f of out) {
    if (f.kind !== "const") {
      kept.push(f);
      continue;
    }
    const forms = used.get(f.name);
    const v = forms ? ([...forms].map((form) => FORMS[form](f.value)).find((x) => x !== null) ?? null) : null;
    if (v !== null) kept.push({ ...f, value: v });
  }
  return kept;
}

// The facts another file can use, kept from a file that holds no watched
// call and no server literal: package-level values (a mux or a handler
// named from another file), parameters typed as a handler (a wrapper's
// signature), ServeHTTP methods, test functions and the parse error.
function keepOutside(f: GoHttpFact): boolean {
  switch (f.kind) {
    case "value":
      return f.decl === null;
    case "param": {
      const last = f.type[f.type.length - 1];
      return f.func || last === "Handler" || last === "HandlerFunc";
    }
    case "serve-http":
    case "test-func":
    case "parse-error":
      return true;
    default:
      return false;
  }
}

// What one plugin reads with this walk: the selector calls it watches, and
// for each, the form each argument's text is kept in (null: names only).
export type ReadSpec = { watched: ReadonlySet<string>; read: Record<string, (Form | null)[]> };
const NET_HTTP: ReadSpec = { watched: WATCHED, read: { Handle: ["pattern"], HandleFunc: ["pattern"], NewRequest: ["method", "target"], NewRequestWithContext: [null, "method", "target"] } };

export function readFacts(root: Node): GoHttpFact[] {
  return readFactsWith(root, NET_HTTP);
}

// The same walk for another Go router (gin): its own watched calls and the
// forms their arguments are kept in.
export function readFactsWith(root: Node, spec: ReadSpec): GoHttpFact[] {
  if (root.endIndex > MAX_SOURCE_BYTES) return [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }];
  const out: GoHttpFact[] = root.hasError ? [{ kind: "parse-error", line: 1, column: 1 }] : [];
  // The depths of the ERROR nodes the walk is inside: nothing is read there.
  const broken: number[] = [];
  const scopes: Scope[] = [];
  // The declarations of each name in the open scopes, innermost last: the
  // last one is the declaration a use of the name reads.
  const visible = new Map<string, Decl[]>();
  // Names a declaration binds once the walk leaves it: `http := http.X()` reads the outer http on its right side.
  const pending: { depth: number; target: Scope; names: { name: string; decl: Decl }[] }[] = [];
  const declHere: DeclHere = (name) => {
    const list = visible.get(name);
    return list && list.length > 0 ? (list[list.length - 1] as Decl) : null;
  };
  const top = (): Scope | undefined => scopes[scopes.length - 1];
  const fns = (): number[] => top()?.fns ?? NO_SCOPES;
  const keyOf = (n: Node): Decl => `${n.startPosition.row + 1}:${n.startPosition.column + 1}`;
  const declare = (s: Scope, name: string, decl: Decl) => {
    if (name === "_") return;
    s.names.push(name);
    const list = visible.get(name);
    if (list) list.push(decl);
    else visible.set(name, [decl]);
  };
  const declareLater = (depth: number, names: Node[]) => {
    const s = top();
    if (s && names.length > 0) pending.push({ depth, target: s, names: names.map((n) => ({ name: n.text, decl: keyOf(n) })) });
  };
  const close = (depth: number) => {
    while (broken.length > 0 && (broken[broken.length - 1] as number) >= depth) broken.pop();
    for (let s = top(); s && s.depth >= depth; s = top()) {
      scopes.pop();
      s.closed = true;
      for (const n of s.names) {
        const list = visible.get(n);
        list?.pop();
        if (list && list.length === 0) visible.delete(n);
      }
    }
    for (let p = pending[pending.length - 1]; p && p.depth >= depth; p = pending[pending.length - 1]) {
      pending.pop();
      if (!p.target.closed) for (const n of p.names) declare(p.target, n.name, n.decl);
    }
  };
  const expr = (node: Node | null): Expr => read(node, { left: MAX_EXPR_NODES }, 0, declHere);

  const fn = (node: Node, depth: number) => {
    const line = node.startPosition.row + 1;
    const s: Scope = { depth, names: [], fns: [line, ...fns()].slice(0, MAX_SCOPES), closed: false };
    scopes.push(s);
    // A function inside a broken region still declares its names, and records no fact.
    const record = broken.length === 0;
    // The receiver, the parameters and the named results are visible in the body.
    const lists: [Node | null, "receiver" | "params" | "results"][] = [
      [node.childForFieldName("receiver"), "receiver"],
      [node.childForFieldName("parameters"), "params"],
      [node.childForFieldName("result"), "results"],
    ];
    let index = 0;
    let params = 0;
    let only: { path: string[]; pointer: boolean } | null = null;
    for (const [list, role] of lists) {
      if (list?.type !== "parameter_list") continue;
      for (const p of namedChildren(list)) {
        if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue;
        const type = paramType(p.childForFieldName("type"));
        const names = p.childrenForFieldName("name");
        for (const n of names) {
          declare(s, n.text, keyOf(n));
          if (record && type && role !== "results") out.push({ kind: "param", ...pos(n), name: n.text, type: type.path, pointer: type.pointer, func: type.func, index: role === "params" ? index : -1, scope: line, decl: keyOf(n) });
          if (role === "params") index++;
        }
        if (role === "params") {
          if (names.length === 0) index++;
          params += Math.max(1, names.length);
          only = type && !type.func ? { path: type.path, pointer: type.pointer } : null;
        }
      }
    }
    const name = record ? node.childForFieldName("name") : null;
    if (node.type === "function_declaration" && name && name.text.startsWith("Test") && params === 1 && only?.pointer && only.path.length === 2) {
      out.push({ kind: "test-func", ...pos(node), name: name.text, param: only.path });
    }
    if (node.type === "method_declaration" && name?.text === "ServeHTTP") {
      const receiver = namedChildren(node.childForFieldName("receiver")).find((c) => c.type === "parameter_declaration");
      const type = paramType(receiver?.childForFieldName("type") ?? null);
      const recv = type?.path[type.path.length - 1];
      if (type && recv && !type.func) out.push({ kind: "serve-http", ...pos(node), recv, pointer: type.pointer });
    }
  };

  const visit = (node: Node, depth: number) => {
    if (node.type === "ERROR") {
      broken.push(depth);
      return;
    }
    if (FUNCTION_TYPES.has(node.type)) return fn(node, depth);
    if (BLOCK_TYPES.has(node.type)) {
      scopes.push({ depth, names: [], fns: fns(), closed: false });
      return;
    }
    // Inside a broken region no value, call or literal is read; a watched
    // call or a server literal that holds a syntax error is not read either.
    if (broken.length > 0) return;
    switch (node.type) {
      case "short_var_declaration": {
        const left = namedChildren(node.childForFieldName("left"));
        const right = namedChildren(node.childForFieldName("right"));
        if (left.length === right.length) {
          left.forEach((l, i) => {
            if (l.type === "identifier" && l.text !== "_") out.push({ kind: "value", ...pos(node), name: l.text, value: expr(right[i] ?? null), scopes: fns(), decl: keyOf(l) });
          });
        }
        declareLater(
          depth,
          left.filter((l) => l.type === "identifier"),
        );
        return;
      }
      case "var_spec":
      case "const_spec": {
        const names = node.childrenForFieldName("name");
        const values = namedChildren(node.childForFieldName("value"));
        const inside = scopes.length > 0;
        names.forEach((n, i) => {
          const v = values[i];
          if (!v || n.text === "_") return;
          if (node.type === "const_spec") {
            const s = inside ? null : stringValue(v);
            if (s !== null) out.push({ kind: "const", ...pos(node), name: n.text, value: s });
          } else out.push({ kind: "value", ...pos(node), name: n.text, value: expr(v), scopes: fns(), decl: inside ? keyOf(n) : null });
        });
        if (inside) declareLater(depth, names);
        return;
      }
      case "type_spec": {
        const name = node.childForFieldName("name");
        if (name && scopes.length > 0) declareLater(depth, [name]);
        return;
      }
      case "assignment_statement": {
        if (node.childForFieldName("operator")?.text !== "=") return;
        const left = namedChildren(node.childForFieldName("left"));
        const right = namedChildren(node.childForFieldName("right"));
        if (left.length !== right.length) return;
        left.forEach((l, i) => {
          if (l.type === "identifier" && l.text !== "_") out.push({ kind: "value", ...pos(node), name: l.text, value: expr(right[i] ?? null), scopes: fns(), decl: declHere(l.text) });
        });
        return;
      }
      case "range_clause": {
        let declares = false;
        for (let i = 0; i < node.childCount && !declares; i++) declares = node.child(i)?.type === ":=";
        if (declares) declareLater(depth, identifiers(node.childForFieldName("left")));
        return;
      }
      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (callee?.type !== "selector_expression") return;
        const prop = callee.childForFieldName("field")?.text;
        if (!prop || !spec.watched.has(prop) || node.hasError) return;
        const b: Budget = { left: MAX_EXPR_NODES };
        const recv = read(callee.childForFieldName("operand"), b, 0, declHere);
        const { args, omitted } = readArgs(node.childForFieldName("arguments"), b, 0, declHere);
        out.push(omitted > 0 ? { kind: "call", ...pos(node), recv, prop, args, scopes: fns(), omitted } : { kind: "call", ...pos(node), recv, prop, args, scopes: fns() });
        return;
      }
      case "composite_literal": {
        const type = typePath(node.childForFieldName("type"));
        if (!type || type.length !== 2 || type[1] !== "Server" || node.hasError) return;
        const lit = expr(node);
        // No Handler among the fields read means the default mux, but only
        // when no field was left out: else the handler is not known.
        const set = lit.t === "lit" ? lit.fields.find((f) => f.key === "Handler")?.value : undefined;
        const handler = set ?? (lit.t === "lit" && !lit.omitted ? null : cut(pos(node)));
        out.push({ kind: "server", ...pos(node), type, handler, scopes: fns() });
        return;
      }
    }
  };

  const cursor = root.walk();
  let depth = 0;
  for (;;) {
    if (cursor.nodeIsNamed) visit(cursor.currentNode, depth);
    if (cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      // Leaving the node at this depth: the scopes it opened close, and the names it declares bind.
      close(depth);
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) return keepRead(out.some((f) => f.kind === "call" || f.kind === "server") ? out : out.filter(keepOutside), spec.read);
      depth--;
    }
  }
}

// ---------- reading facts back ----------

// A literal string an expression stands for: a string, or a concatenation
// whose names each resolve through `constant` to a literal. Null otherwise.
// A name declared inside a function is never a package constant.
export function evaluate(e: Expr, constant: (name: string) => string | null): string | null {
  if (e.t === "str") return e.v;
  if (e.t === "ref") return !e.local && e.path.length === 1 ? constant(e.path[0] as string) : null;
  if (e.t === "dyn" && e.parts) {
    let out = "";
    for (const part of e.parts) {
      if ("s" in part) out += part.s;
      else {
        const v = !part.local && part.ref.length === 1 ? constant(part.ref[0] as string) : null;
        if (v === null) return null;
        out += v;
      }
    }
    // The value the pieces make, kept by the same rule as one literal.
    return assembledText(out);
  }
  return null;
}

// The source text of an expression, short, for a note: `logging(handlers.AdminHandler{})`.
export function show(e: Expr): string {
  switch (e.t) {
    case "str":
      return JSON.stringify(e.v);
    case "dyn":
      return e.parts ? e.parts.map((p) => ("s" in p ? JSON.stringify(p.s) : p.ref.join("."))).join(" + ") : "a computed string";
    case "ref":
      return e.path.join(".");
    case "call":
      return `${show(e.fn)}(${e.args.map(show).join(", ")})`;
    case "lit":
      return `${e.addr ? "&" : ""}${e.type ? e.type.join(".") : ""}{}`;
    case "fn":
      return "an inline function";
    case "nil":
      return "nil";
    case "other":
      return e.cut ? "an expression past the plugin's read limit" : "an expression";
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n));

// Whether a cached expression has the shape `read` gives.
export function isExpr(v: unknown, depth = 0): v is Expr {
  if (depth > MAX_EXPR_DEPTH + 2 || typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isInteger(e.line) || !Number.isInteger(e.column)) return false;
  switch (e.t) {
    case "str":
      return typeof e.v === "string";
    case "dyn":
      return e.parts === null || (Array.isArray(e.parts) && e.parts.every((p) => typeof p === "object" && p !== null && (typeof (p as { s?: unknown }).s === "string" || (strings((p as { ref?: unknown }).ref) && typeof (p as { local?: unknown }).local === "boolean"))));
    case "ref":
      return strings(e.path) && e.path.length > 0 && typeof e.local === "boolean" && (e.decl === null || typeof e.decl === "string") && e.local === (e.decl !== null);
    case "call":
      return isExpr(e.fn, depth + 1) && Array.isArray(e.args) && e.args.every((a) => isExpr(a, depth + 1)) && (e.omitted === undefined || Number.isInteger(e.omitted));
    case "lit":
      return (e.type === null || strings(e.type)) && typeof e.addr === "boolean" && Array.isArray(e.fields) && e.fields.every((f) => typeof f === "object" && f !== null && typeof (f as { key?: unknown }).key === "string" && isExpr((f as { value?: unknown }).value, depth + 1)) && (e.omitted === undefined || Number.isInteger(e.omitted));
    case "fn":
    case "nil":
      return true;
    case "other":
      return e.cut === undefined || typeof e.cut === "boolean";
    default:
      return false;
  }
}

export function isGoHttpFact(v: unknown): v is GoHttpFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "call":
      return isExpr(f.recv) && typeof f.prop === "string" && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && ints(f.scopes) && (f.omitted === undefined || Number.isInteger(f.omitted));
    case "value":
      return typeof f.name === "string" && isExpr(f.value) && ints(f.scopes) && (f.decl === null || typeof f.decl === "string");
    case "param":
      return typeof f.name === "string" && strings(f.type) && typeof f.pointer === "boolean" && typeof f.func === "boolean" && Number.isInteger(f.index) && Number.isInteger(f.scope) && typeof f.decl === "string";
    case "const":
      return typeof f.name === "string" && typeof f.value === "string";
    case "server":
      return strings(f.type) && (f.handler === null || isExpr(f.handler)) && ints(f.scopes);
    case "serve-http":
      return typeof f.recv === "string" && typeof f.pointer === "boolean";
    case "test-func":
      return typeof f.name === "string" && strings(f.param);
    case "too-large":
      return Number.isInteger(f.bytes);
    case "parse-error":
      return true;
    default:
      return false;
  }
}
