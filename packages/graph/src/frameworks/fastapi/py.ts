// A small reader of Python expressions for the FastAPI plugin: it turns the
// parts of a parse tree the plugin watches into plain JSON (a string, a
// dotted name, a call with its keyword arguments, a list), so a fact can be
// cached and read back without the tree.
//
// Every read is bounded: an expression is read at most MAX_DEPTH levels
// deep and MAX_EXPR_NODES nodes wide, and a list keeps MAX_LIST_ITEMS items
// with the count of the ones it left out. A deep or wide expression in a
// file a stranger wrote costs the same as a small one.
import type { Node } from "web-tree-sitter";
import { assembledText } from "../shared/kept.js";

// Positions as the language facts give them: 1-based line and column.
export type Pos = { line: number; column: number };

export function pos(node: Node): Pos {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

// A piece of a computed string: a literal, or a dotted name.
export type Part = { s: string } | { ref: string[] };

// An expression as the plugin reads it. `str` is a string literal (or
// several written side by side), decoded by Python's rules. `dyn` is a
// string the code computes: an f-string with a replacement field (always
// `parts: null`, never evaluated), or a `+` concatenation whose `parts`
// hold its literal pieces and names when every piece is one of those, so
// resolve can evaluate a concatenation of module-level string constants.
// `ref` is a name or a dotted name. `call` a call with its positional and
// keyword arguments, `omitted` the arguments past MAX_ARGS (a keyword not
// found may be among them). `list` a list or tuple, with `omitted` the
// items past the read cap. `other` anything else. `cut` on `dyn` and
// `other`: the reader stopped at one of its caps, so the expression may be
// a plain name or literal the plugin would have read.
export type Expr =
  | ({ t: "str"; v: string } & Pos)
  | ({ t: "dyn"; parts: Part[] | null; cut?: true } & Pos)
  | ({ t: "ref"; path: string[] } & Pos)
  | ({ t: "call"; fn: Expr; args: Expr[]; kw: Kw[]; omitted: number } & Pos)
  | ({ t: "list"; items: Expr[]; omitted: number } & Pos)
  | ({ t: "other"; cut?: true } & Pos);

export type Kw = { key: string; value: Expr };

export const MAX_DEPTH = 6;
export const MAX_EXPR_NODES = 256; // expression nodes one read keeps
export const MAX_LIST_ITEMS = 64; // items of one list: as many as a dependency chain keeps
export const MAX_ARGS = 24; // positional and keyword arguments of one call
const MAX_NAME_PARTS = 16;
const MAX_STRING_PIECES = 64;

type Budget = { left: number };

// A dotted name `a.b.c`, or null when any part is not a plain name.
export function namePath(node: Node | null): string[] | null {
  const out: string[] = [];
  let n = node;
  while (n && n.type === "attribute") {
    const attr = n.childForFieldName("attribute");
    if (!attr || attr.type !== "identifier" || out.length >= MAX_NAME_PARTS) return null;
    out.push(attr.text);
    n = n.childForFieldName("object");
  }
  if (!n || n.type !== "identifier") return null;
  out.push(n.text);
  return out.reverse();
}

// The string prefix letters (`r`, `f`, `b`, `u`, `t`, in any case and
// combination), lower-cased, read from the tree's string_start node.
function prefixOf(node: Node): string {
  const start = node.firstChild;
  if (!start || start.type !== "string_start") return "";
  let p = "";
  for (const ch of start.text) {
    if (ch === '"' || ch === "'") break;
    p += ch.toLowerCase();
  }
  return p;
}

const SIMPLE_ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

const hexValue = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);

// Exactly `n` hex digits at `i`, or -1.
function hexAt(text: string, i: number, n: number): number {
  if (i + n > text.length) return -1;
  let v = 0;
  for (let k = 0; k < n; k++) {
    const d = hexValue(text.charCodeAt(i + k));
    if (d < 0) return -1;
    v = v * 16 + d;
  }
  return v;
}

// The text of one string_content node as Python reads it, in one pass:
// in a non-raw string the escapes `\\ \' \" \a \b \f \n \r \t \v`, octal
// `\ooo`, `\xHH`, `\uHHHH`, `\UHHHHHHHH` and a backslash before a line end
// (a line continuation); an unknown escape keeps its backslash, as Python
// does. In an f-string `{{` and `}}` are one brace. Null when the value
// cannot be known from the text alone: `\N{name}` (a Unicode name the
// plugin does not look up) or a malformed escape.
export function decodeContent(text: string, raw: boolean, fstring: boolean): string | null {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i] as string;
    if (fstring && (ch === "{" || ch === "}") && text[i + 1] === ch) {
      out += ch;
      i += 2;
      continue;
    }
    if (raw || ch !== "\\" || i + 1 >= text.length) {
      out += ch;
      i++;
      continue;
    }
    const n = text[i + 1] as string;
    const simple = SIMPLE_ESCAPES[n];
    if (simple !== undefined) {
      out += simple;
      i += 2;
    } else if (n === "\n") i += 2;
    else if (n === "\r") i += text[i + 2] === "\n" ? 3 : 2;
    else if (n >= "0" && n <= "7") {
      let v = 0;
      let k = i + 1;
      while (k < text.length && k < i + 4 && (text[k] as string) >= "0" && (text[k] as string) <= "7") v = v * 8 + (text.charCodeAt(k++) - 48);
      out += String.fromCharCode(v);
      i = k;
    } else if (n === "x" || n === "u" || n === "U") {
      const len = n === "x" ? 2 : n === "u" ? 4 : 8;
      const v = hexAt(text, i + 2, len);
      if (v < 0 || v > 0x10ffff) return null;
      out += String.fromCodePoint(v);
      i += 2 + len;
    } else if (n === "N") return null;
    else {
      out += `\\${n}`;
      i += 2;
    }
  }
  return out;
}

// The value of one string node: its decoded text; "computed" for an
// f-string with a replacement field or text the plugin cannot decode;
// "not-str" for a bytes or template literal.
function stringValue(node: Node): string | "computed" | "not-str" {
  const prefix = prefixOf(node);
  if (prefix.includes("b") || prefix.includes("t")) return "not-str";
  const raw = prefix.includes("r");
  const fstring = prefix.includes("f");
  let out = "";
  for (const c of node.namedChildren) {
    if (c.type === "interpolation") return "computed";
    if (c.type !== "string_content") continue;
    const s = decodeContent(c.text, raw, fstring);
    if (s === null) return "computed";
    out += s;
  }
  return out;
}

// A string node, or several written side by side (implicit
// concatenation), as an expression: a literal only when every piece is one.
function readString(node: Node, p: Pos): Expr {
  const strings = node.type === "concatenated_string" ? node.namedChildren.filter((c) => c.type === "string") : [node];
  if (strings.length > MAX_STRING_PIECES) return { t: "dyn", parts: null, cut: true, ...p };
  let v = "";
  for (const s of strings) {
    const piece = stringValue(s);
    if (piece === "not-str") return { t: "other", ...p };
    if (piece === "computed") return { t: "dyn", parts: null, ...p };
    v += piece;
  }
  return { t: "str", v, ...p };
}

// The pieces of a `+` concatenation when every leaf is a string literal or
// a name; null when some leaf is anything else (an f-string with a field, a
// call), which leaves the string computed.
function concatParts(node: Node, depth: number, cut: { at: boolean }): Part[] | null {
  if (depth > MAX_DEPTH) {
    cut.at = true;
    return null;
  }
  if (node.type === "string" || node.type === "concatenated_string") {
    const e = readString(node, pos(node));
    if (e.t === "dyn" && e.cut) cut.at = true;
    return e.t === "str" ? [{ s: e.v }] : null;
  }
  if (node.type === "parenthesized_expression" && node.firstNamedChild) return concatParts(node.firstNamedChild, depth + 1, cut);
  const path = namePath(node);
  if (path) return [{ ref: path }];
  if (node.type === "binary_operator" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) return null;
    const l = concatParts(left, depth + 1, cut);
    if (!l) return null;
    const r = concatParts(right, depth + 1, cut);
    if (!r) return null;
    if (l.length + r.length > MAX_STRING_PIECES) {
      cut.at = true;
      return null;
    }
    return [...l, ...r];
  }
  return null;
}

// Whether a `+` expression is a string by its leaves: some leaf is a string literal.
function stringish(node: Node, depth: number, cut: { at: boolean }): boolean {
  if (depth > MAX_DEPTH) {
    cut.at = true;
    return false;
  }
  if (node.type === "string" || node.type === "concatenated_string") return true;
  if (node.type === "parenthesized_expression" && node.firstNamedChild) return stringish(node.firstNamedChild, depth + 1, cut);
  if (node.type === "binary_operator" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    return (left !== null && stringish(left, depth + 1, cut)) || (right !== null && stringish(right, depth + 1, cut));
  }
  return false;
}

const named = (node: Node | null): Node[] => (node ? node.namedChildren.filter((c) => c.type !== "comment") : []);

export function readExpr(node: Node | null, budget: Budget = { left: MAX_EXPR_NODES }, depth = 0): Expr {
  if (!node) return { t: "other", line: 1, column: 1 };
  const p = pos(node);
  if (depth > MAX_DEPTH || budget.left <= 0) return { t: "other", cut: true, ...p };
  budget.left--;
  switch (node.type) {
    case "parenthesized_expression":
    case "await":
      return readExpr(node.firstNamedChild, budget, depth + 1);
    case "string":
    case "concatenated_string":
      return readString(node, p);
    case "binary_operator": {
      if (node.childForFieldName("operator")?.text !== "+") return { t: "other", ...p };
      const deep = { at: false };
      if (!stringish(node, 0, deep)) return deep.at ? { t: "other", cut: true, ...p } : { t: "other", ...p };
      const cut = { at: false };
      const parts = concatParts(node, 0, cut);
      return parts === null && cut.at ? { t: "dyn", parts, cut: true, ...p } : { t: "dyn", parts, ...p };
    }
    case "identifier":
      return { t: "ref", path: [node.text], ...p };
    case "attribute": {
      const path = namePath(node);
      if (path) return { t: "ref", path, ...p };
      // A plain dotted name past MAX_NAME_PARTS parts is cut, not computed.
      let at: Node | null = node;
      while (at?.type === "attribute" && at.childForFieldName("attribute")?.type === "identifier") at = at.childForFieldName("object");
      return at?.type === "identifier" ? { t: "other", cut: true, ...p } : { t: "other", ...p };
    }
    case "call": {
      const fn = readExpr(node.childForFieldName("function"), budget, depth + 1);
      const args: Expr[] = [];
      const kw: Kw[] = [];
      const list = node.childForFieldName("arguments");
      const all = list?.type === "argument_list" ? named(list) : [];
      for (const a of all) {
        if (args.length + kw.length >= MAX_ARGS) break;
        if (a.type === "keyword_argument") {
          const key = a.childForFieldName("name");
          if (key) kw.push({ key: key.text, value: readExpr(a.childForFieldName("value"), budget, depth + 1) });
        } else args.push(readExpr(a, budget, depth + 1));
      }
      return { t: "call", fn, args, kw, omitted: all.length - args.length - kw.length, ...p };
    }
    case "list":
    case "tuple": {
      const all = named(node);
      const items: Expr[] = [];
      for (const c of all) {
        if (items.length >= MAX_LIST_ITEMS || budget.left <= 0) break;
        items.push(readExpr(c, budget, depth + 1));
      }
      return { t: "list", items, omitted: all.length - items.length, ...p };
    }
    default:
      return { t: "other", ...p };
  }
}

// The names of the definitions that open a new scope of names.
const SCOPES = new Set(["function_definition", "class_definition"]);

// Where a node sits: the line of the innermost function or class around it
// (0 at module level), and whether that innermost scope is a class body.
export type Scope = { line: number; inClass: boolean };

// Depth-first walk over the named nodes with a cursor, so a deep tree never
// overflows the stack, and the enclosing scope of each node tracked on a
// stack keyed by the cursor's depth (no walk up the parent chain). `visit`
// also gets the type of the node's parent, kept on the same kind of stack:
// tree-sitter finds `node.parent` by descending from the root again, so a
// lookup per node would make a deeply nested file quadratic. `visit`
// returns false to skip the children of a node.
export function walkScoped(root: Node, visit: (node: Node, scope: Scope, parentType: string | null) => boolean | void): void {
  const cursor = root.walk();
  const types: string[] = []; // the node type at each depth of the current path
  const stack: { depth: number; line: number; inClass: boolean }[] = [];
  let depth = 0;
  const top: Scope = { line: 0, inClass: false };
  for (;;) {
    let descend = true;
    if (cursor.nodeIsNamed) {
      while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
      const s = stack[stack.length - 1];
      const node = cursor.currentNode;
      types[depth] = node.type;
      descend = visit(node, s ? { line: s.line, inClass: s.inClass } : top, depth > 0 ? (types[depth - 1] ?? null) : null) !== false;
      if (descend && SCOPES.has(node.type)) stack.push({ depth, line: node.startPosition.row + 1, inClass: node.type === "class_definition" });
    }
    if (descend && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) return;
      depth--;
    }
  }
}

// A literal string an expression stands for: a string, or a computed one
// whose names each resolve through `constant` to a literal. Null otherwise.
export function evaluate(e: Expr, constant: (path: string[]) => string | null): string | null {
  if (e.t === "str") return e.v;
  if (e.t === "ref") return constant(e.path);
  if (e.t === "dyn" && e.parts) {
    let out = "";
    for (const part of e.parts) {
      if ("s" in part) out += part.s;
      else {
        const v = constant(part.ref);
        if (v === null) return null;
        out += v;
      }
    }
    // The value the pieces make, kept by the same rule as one literal.
    return assembledText(out);
  }
  return null;
}

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

// Whether a cached expression has the shape readExpr gives.
export function isExpr(v: unknown, depth = 0): v is Expr {
  if (depth > MAX_DEPTH + 2 || typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isInteger(e.line) || !Number.isInteger(e.column)) return false;
  switch (e.t) {
    case "str":
      return typeof e.v === "string";
    case "dyn":
      if (e.cut !== undefined && e.cut !== true) return false;
      return e.parts === null || (Array.isArray(e.parts) && e.parts.every((p) => typeof p === "object" && p !== null && (typeof (p as { s?: unknown }).s === "string" || strings((p as { ref?: unknown }).ref))));
    case "ref":
      return strings(e.path) && e.path.length > 0;
    case "call":
      return isExpr(e.fn, depth + 1) && Array.isArray(e.args) && e.args.every((a) => isExpr(a, depth + 1)) && isKws(e.kw, depth + 1) && Number.isInteger(e.omitted);
    case "list":
      return Array.isArray(e.items) && e.items.every((a) => isExpr(a, depth + 1)) && Number.isInteger(e.omitted);
    case "other":
      return e.cut === undefined || e.cut === true;
    default:
      return false;
  }
}

export function isKws(v: unknown, depth = 0): v is Kw[] {
  return Array.isArray(v) && v.every((k) => typeof k === "object" && k !== null && typeof (k as { key?: unknown }).key === "string" && isExpr((k as { value?: unknown }).value, depth));
}

// The source text of an expression, short, for a note: `Depends(get_db)`.
export function show(e: Expr): string {
  switch (e.t) {
    case "str":
      return JSON.stringify(e.v);
    case "dyn":
      return e.parts ? e.parts.map((p) => ("s" in p ? JSON.stringify(p.s) : p.ref.join("."))).join(" + ") : "a computed string";
    case "ref":
      return e.path.join(".");
    case "call":
      return `${show(e.fn)}(${[...e.args.map(show), ...e.kw.map((k) => `${k.key}=${show(k.value)}`)].join(", ")})`;
    case "list":
      return `[${e.items.map(show).join(", ")}${e.omitted > 0 ? ", ..." : ""}]`;
    case "other":
      return "an expression";
  }
}
