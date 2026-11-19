// A small reader of JavaScript and TypeScript expressions, shared by the
// Express, React and Next.js plugins: it turns the parts of a parse tree a
// plugin watches into plain JSON (a string, a dotted name, a call, an inline
// function), so a fact can be cached and read back without the tree.
//
// The facts of all three plugins depend on this file: a change to what it
// returns bumps the version of each of them.
//
// The files read are the repository's, so a stranger controls them. Every
// read here is bounded: a file over MAX_SOURCE_BYTES is not read at all, an
// expression is read to at most MAX_DEPTH levels and MAX_NODES nodes, a name
// chain to MAX_NAME_PARTS parts, a string to MAX_STRING characters, and the
// walk over a tree is one pass with no step back up the parents.
import type { Node } from "web-tree-sitter";
import { assembledText } from "../shared/kept.js";
import { hasError } from "../../walk.js";
import type { TreeVisitor, Up, UpType } from "../../walk.js";

// The largest file a JavaScript plugin reads, in bytes. A larger file gets
// one fact of kind "too-large" and nothing else; resolve turns it into an
// unknown. Route tables, components and tests are far smaller.
export const MAX_SOURCE_BYTES = 256 * 1024;

// Positions as the language facts give them: 1-based line and column.
export type Pos = { line: number; column: number };

export function pos(node: Node): Pos {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

// An expression as a plugin reads it. `str` is a string literal, or a
// template with no substitution. `dyn` is a string the code computes (a
// template with a substitution, a concatenation with a name in it); `parts`
// holds the literal pieces and the names when every piece is one of those,
// so a plugin can evaluate a concatenation of module-level constants.
// `ref` is a name or a chain of names (`a`, `a.b.c`); `call` a call; `member`
// a property of something that is not a name (`f().x`); `fn` an inline
// function with its parameter count; `array` an array literal; `object` an
// object literal with its literal-keyed properties; `other` anything else.
// A list the reader cut at MAX_ITEMS (arguments, items, properties) carries
// `more`, how many it left out, so no reader of the fact takes a cut list
// for the whole one.
export type Expr =
  | ({ t: "str"; v: string } & Pos)
  | ({ t: "dyn"; parts: ({ s: string } | { ref: string[] })[] | null } & Pos)
  | ({ t: "ref"; path: string[] } & Pos)
  | ({ t: "call"; fn: Expr; args: Expr[]; more?: number } & Pos)
  | ({ t: "member"; obj: Expr; prop: string } & Pos)
  | ({ t: "fn"; params: number } & Pos)
  | ({ t: "array"; items: Expr[]; more?: number } & Pos)
  | ({ t: "object"; props: { key: string; value: Expr }[]; more?: number } & Pos)
  | ({ t: "other" } & Pos);

// How much of one expression is read before the rest becomes `other`: a
// fact stays small whatever the source holds.
export const MAX_DEPTH = 6;
export const MAX_ITEMS = 24; // arguments, array items or object properties kept
export const MAX_NODES = 256; // nodes read for one expression
export const MAX_NAME_PARTS = 16; // parts of a name chain `a.b.c`
export const MAX_STRING = 2048; // characters of a string literal kept
const MAX_PARTS = 32; // pieces of a computed string

// ---------- reading names and strings as the language does ----------
//
// Everything below reads the tree-sitter nodes the core already parsed,
// never the file's text a second way. Where the language gives a token a
// meaning its text does not show (an escape in a string or in a name), the
// token is decoded by the language's own rules; a token those rules reject
// is not read as a literal at all.

const HEX = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);

// The code point of `\uHHHH` or `\u{H...}` at `at` (the backslash), and
// where it ends; null when it is not a valid unicode escape.
function unicodeEscape(s: string, at: number): { cp: number; end: number } | null {
  if (s[at] !== "\\" || s[at + 1] !== "u") return null;
  if (s[at + 2] === "{") {
    let cp = 0;
    let i = at + 3;
    for (; i < s.length && s[i] !== "}"; i++) {
      const d = HEX(s.charCodeAt(i));
      if (d < 0 || i - at > 10) return null;
      cp = cp * 16 + d;
    }
    if (s[i] !== "}" || i === at + 3 || cp > 0x10ffff) return null;
    return { cp, end: i + 1 };
  }
  let cp = 0;
  for (let i = at + 2; i < at + 6; i++) {
    const d = HEX(s.charCodeAt(i));
    if (d < 0) return null;
    cp = cp * 16 + d;
  }
  return { cp, end: at + 6 };
}

// One escape sequence of a string or template, as JavaScript decodes it; null
// for one a module would reject (a legacy octal escape) or that is malformed.
export function decodeEscape(seq: string): string | null {
  if (seq.length < 2 || seq[0] !== "\\") return null;
  const c = seq[1] as string;
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "\n":
    case "\r":
    case " ":
    case " ":
      return ""; // a backslash before a line break joins the lines
    case "x": {
      if (seq.length !== 4) return null;
      const hi = HEX(seq.charCodeAt(2));
      const lo = HEX(seq.charCodeAt(3));
      return hi < 0 || lo < 0 ? null : String.fromCharCode(hi * 16 + lo);
    }
    case "u": {
      const u = unicodeEscape(seq, 0);
      return u && u.end === seq.length ? String.fromCodePoint(u.cp) : null;
    }
    case "0":
      return seq.length === 2 ? "\0" : null;
    default:
      if (c >= "1" && c <= "9") return null;
      return seq.length === 2 ? c : null;
  }
}

// An identifier's name as the language reads it: `get` is `get`. Null
// for a malformed escape.
export function identifierName(text: string): string | null {
  if (!text.includes("\\")) return text;
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      const u = unicodeEscape(text, i);
      if (!u) return null;
      out += String.fromCodePoint(u.cp);
      i = u.end;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

// A name chain `a.b.c`, or null when any part is not a plain name or the
// chain is longer than MAX_NAME_PARTS. Walks down the object side in a loop.
export function namePath(start: Node | null): string[] | null {
  const parts: string[] = [];
  let node = start;
  while (node) {
    if (parts.length >= MAX_NAME_PARTS || hasError(node)) return null;
    if (node.type === "parenthesized_expression") {
      node = node.firstNamedChild;
      continue;
    }
    if (node.type === "identifier" || node.type === "property_identifier" || node.type === "this") {
      const name = identifierName(node.text);
      if (name === null) return null;
      parts.push(name);
      return parts.reverse();
    }
    if (node.type !== "member_expression") return null;
    const prop = node.childForFieldName("property");
    if (!prop || prop.type !== "property_identifier") return null;
    const name = identifierName(prop.text);
    if (name === null) return null;
    parts.push(name);
    node = node.childForFieldName("object");
  }
  return null;
}

// The value of a string literal, or of a template with no substitution, as
// JavaScript decodes it; null when the node is not one, holds a syntax error
// or an escape the language rejects, or is longer than MAX_STRING.
export function stringValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type !== "string" && node.type !== "template_string") return null;
  if (hasError(node) || node.endIndex - node.startIndex > MAX_STRING + 2) return null;
  let out = "";
  for (const c of node.namedChildren) {
    if (c.type === "template_substitution") return null;
    if (c.type === "escape_sequence") {
      const d = decodeEscape(c.text);
      if (d === null) return null;
      out += d;
    } else if (c.type === "string_fragment") out += c.text;
    else if (c.type !== "comment") return null;
  }
  return out;
}

type Part = { s: string } | { ref: string[] };

// The literal pieces and names a computed string is made of, when every
// piece is a literal or a name; else null. A concatenation is flattened
// with an explicit stack, never by recursion, and stops at MAX_PARTS.
function stringParts(start: Node): Part[] | null {
  const out: Part[] = [];
  const stack: Node[] = [start];
  while (stack.length > 0) {
    if (out.length > MAX_PARTS) return null;
    const node = stack.pop() as Node;
    const lit = stringValue(node);
    if (lit !== null) {
      out.push({ s: lit });
      continue;
    }
    const path = namePath(node);
    if (path) {
      out.push({ ref: path });
      continue;
    }
    if (node.type === "parenthesized_expression" && node.firstNamedChild) {
      stack.push(node.firstNamedChild);
      continue;
    }
    if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (!left || !right) return null;
      stack.push(right, left);
      continue;
    }
    if (node.type === "template_string") {
      if (hasError(node) || node.endIndex - node.startIndex > MAX_STRING) return null;
      for (const c of node.namedChildren) {
        if (c.type === "template_substitution") {
          const inner = c.firstNamedChild;
          const p = inner ? namePath(inner) : null;
          if (!p) return null;
          out.push({ ref: p });
        } else if (c.type === "escape_sequence") {
          const d = decodeEscape(c.text);
          if (d === null) return null;
          out.push({ s: d });
        } else if (c.type === "string_fragment") out.push({ s: c.text });
        else return null;
      }
      continue;
    }
    return null;
  }
  return out;
}

// Whether a `+` expression builds a string: some leaf of it is a string or a
// template. Walks the leaves with a stack and a bound.
function isStringish(start: Node): boolean {
  const stack: Node[] = [start];
  for (let seen = 0; stack.length > 0 && seen < MAX_NODES; seen++) {
    const node = stack.pop() as Node;
    if (node.type === "template_string" || node.type === "string") return true;
    if (node.type === "parenthesized_expression" && node.firstNamedChild) stack.push(node.firstNamedChild);
    else if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left) stack.push(left);
      if (right) stack.push(right);
    }
  }
  return false;
}

export const FN_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const SCOPE_TYPES: ReadonlySet<string> = new Set([...FN_TYPES, "function_declaration", "generator_function_declaration", "method_definition"]);

// The names a binding pattern declares: `x`, `{ a, b: c }`, `[d, ...e]`,
// `x = 1`, a typed parameter. At most 64 nodes are read.
export function patternNames(node: Node | null, out: string[], budget = { left: 64 }): void {
  if (!node || budget.left-- <= 0) return;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern": {
      const name = identifierName(node.text);
      if (name !== null) out.push(name);
      return;
    }
    case "object_pattern":
    case "array_pattern":
      for (const c of node.namedChildren) patternNames(c, out, budget);
      return;
    case "pair_pattern":
      patternNames(node.childForFieldName("value"), out, budget);
      return;
    case "assignment_pattern":
    case "object_assignment_pattern":
      patternNames(node.childForFieldName("left"), out, budget);
      return;
    case "rest_pattern":
      patternNames(node.firstNamedChild, out, budget);
      return;
    case "required_parameter":
    case "optional_parameter":
      patternNames(node.childForFieldName("pattern"), out, budget);
      return;
  }
}

export function paramCount(fn: Node): number {
  const params = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!params) return 0;
  if (params.type === "identifier") return 1;
  return params.namedChildren.filter((c) => c.type !== "comment").length;
}

// Reads one expression, within MAX_DEPTH levels and MAX_NODES nodes.
export function readExpr(node: Node | null): Expr {
  return read(node, 0, { left: MAX_NODES });
}

function read(node: Node | null, depth: number, budget: { left: number }): Expr {
  if (!node) return { t: "other", line: 0, column: 0 };
  const p = pos(node);
  budget.left--;
  if (depth > MAX_DEPTH || budget.left < 0) return { t: "other", ...p };
  switch (node.type) {
    case "parenthesized_expression":
    case "await_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
      return read(node.firstNamedChild, depth + 1, budget);
    case "string": {
      const v = stringValue(node);
      return v === null ? { t: "other", ...p } : { t: "str", v, ...p };
    }
    case "template_string": {
      const v = stringValue(node);
      return v !== null ? { t: "str", v, ...p } : { t: "dyn", parts: stringParts(node), ...p };
    }
    case "binary_expression":
      if (isStringish(node)) return { t: "dyn", parts: stringParts(node), ...p };
      return { t: "other", ...p };
    case "identifier":
    case "this":
      return { t: "ref", path: [node.text], ...p };
    case "member_expression": {
      const path = namePath(node);
      if (path) return { t: "ref", path, ...p };
      const prop = node.childForFieldName("property");
      return { t: "member", obj: read(node.childForFieldName("object"), depth + 1, budget), prop: prop?.text ?? "", ...p };
    }
    case "call_expression": {
      const fn = read(node.childForFieldName("function"), depth + 1, budget);
      const args: Expr[] = [];
      let more = 0;
      for (const a of node.childForFieldName("arguments")?.namedChildren ?? []) {
        if (a.type === "comment") continue;
        if (args.length >= MAX_ITEMS) more++;
        else args.push(read(a, depth + 1, budget));
      }
      return more > 0 ? { t: "call", fn, args, more, ...p } : { t: "call", fn, args, ...p };
    }
    case "array": {
      const items: Expr[] = [];
      let more = 0;
      for (const c of node.namedChildren) {
        if (c.type === "comment") continue;
        if (items.length >= MAX_ITEMS) more++;
        else items.push(read(c, depth + 1, budget));
      }
      return more > 0 ? { t: "array", items, more, ...p } : { t: "array", items, ...p };
    }
    case "object": {
      const props: { key: string; value: Expr }[] = [];
      let more = 0;
      for (const c of node.namedChildren) {
        if (props.length >= MAX_ITEMS) {
          if (c.type === "pair" || c.type === "shorthand_property_identifier" || c.type === "spread_element") more++;
          continue;
        }
        if (c.type === "pair") {
          const key = c.childForFieldName("key");
          const k = key?.type === "property_identifier" ? key.text : stringValue(key);
          if (k !== null) props.push({ key: k, value: read(c.childForFieldName("value"), depth + 1, budget) });
        } else if (c.type === "shorthand_property_identifier") props.push({ key: c.text, value: { t: "ref", path: [c.text], ...pos(c) } });
      }
      return more > 0 ? { t: "object", props, more, ...p } : { t: "object", props, ...p };
    }
    default:
      if (FN_TYPES.has(node.type)) return { t: "fn", params: paramCount(node), ...p };
      return { t: "other", ...p };
  }
}

// A reader of the one depth-first pass over a tree that the core extractor
// and the plugins share (walk.ts). `visit` gets each node of `types` and of
// the function types, the line of the innermost function around it (0 at
// module level), `up`, which gives the node's ancestors (`up(1)` its
// parent, `up(2)` the one above), the node's type, read once, and
// `upType`, the ancestors' types. The function lines come from a stack kept
// as the walk enters and leaves nodes, never from a node's `parent`.
// `visit` returns false to skip the children of a node. `keep` names the
// types of the ancestors `visit` reads as nodes (walk.ts).
//
// A region the parser could not read (an ERROR node) is never visited: the
// language would not run such a file, so nothing in it is a fact. `broken`
// is told the line of each such region.
export type { Up, UpType } from "../../walk.js";

export type ScopedVisit = (node: Node, scope: number, up: Up, type: string, upType: UpType) => boolean | void;

// `visit` as one reader of a shared walk (walk.ts).
export function scopedVisitor(visit: ScopedVisit, broken: ((line: number) => void) | undefined, types: ReadonlySet<string>, keep?: ReadonlySet<string>): TreeVisitor {
  const scopes: { depth: number; line: number }[] = [];
  return {
    types: new Set([...types, ...SCOPE_TYPES]),
    ...(keep ? { keep } : {}),
    enter(node, type, _field, depth, up, upType) {
      const descend = visit(node, scopes.length > 0 ? (scopes[scopes.length - 1] as { line: number }).line : 0, up, type, upType) !== false;
      if (descend && SCOPE_TYPES.has(type)) scopes.push({ depth, line: node.startPosition.row + 1 });
      return descend;
    },
    leave(depth) {
      // Leaving this node: a function it opened is closed.
      while (scopes.length > 0 && (scopes[scopes.length - 1] as { depth: number }).depth >= depth) scopes.pop();
    },
    broken,
  };
}

const JS_EXTS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);

// A test file by the JavaScript runners' own default rule: under
// `__tests__`, or named `<name>.test.<ext>` or `<name>.spec.<ext>`. Plain
// string checks, no pattern.
export function isTestFile(file: string): boolean {
  const parts = file.split("/");
  if (parts.slice(0, -1).includes("__tests__")) return true;
  const bits = (parts[parts.length - 1] ?? "").split(".");
  if (bits.length < 3) return false;
  const kind = bits[bits.length - 2];
  return (kind === "test" || kind === "spec") && JS_EXTS.has(bits[bits.length - 1] as string);
}

// The test runners whose declared dependency lets a test file be a test.
export const JS_RUNNERS: readonly string[] = ["vitest", "jest", "mocha", "ava", "@jest/globals", "uvu", "tap"];

// Whether a declaration sits under an `export` statement: its declaration
// statement's parent, three steps up at most, read from the walk's stack.
export function exported(upType: UpType): boolean {
  for (let k = 1; k <= 3; k++) {
    const p = upType(k);
    if (p === null || p === "program" || p === "statement_block") return false;
    if (p === "export_statement") return true;
  }
  return false;
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
      if (out.length > MAX_STRING) return null;
    }
    // The value the pieces make, kept by the same rule as one literal.
    return assembledText(out);
  }
  return null;
}

// Whether a cached expression has the shape readExpr gives.
export function isExpr(v: unknown, depth = 0): v is Expr {
  if (depth > MAX_DEPTH + 2 || typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isInteger(e.line) || !Number.isInteger(e.column)) return false;
  const strings = (x: unknown) => Array.isArray(x) && x.length <= MAX_NAME_PARTS && x.every((s) => typeof s === "string");
  const list = (x: unknown): x is unknown[] => Array.isArray(x) && x.length <= MAX_PARTS + 1;
  const more = (x: unknown): boolean => x === undefined || (Number.isInteger(x) && (x as number) > 0);
  switch (e.t) {
    case "str":
      return typeof e.v === "string";
    case "dyn":
      return e.parts === null || (list(e.parts) && e.parts.every((p) => typeof p === "object" && p !== null && (typeof (p as { s?: unknown }).s === "string" || strings((p as { ref?: unknown }).ref))));
    case "ref":
      return strings(e.path);
    case "call":
      return isExpr(e.fn, depth + 1) && list(e.args) && e.args.every((a) => isExpr(a, depth + 1)) && more(e.more);
    case "member":
      return isExpr(e.obj, depth + 1) && typeof e.prop === "string";
    case "fn":
      return Number.isInteger(e.params);
    case "array":
      return list(e.items) && e.items.every((a) => isExpr(a, depth + 1)) && more(e.more);
    case "object":
      return list(e.props) && e.props.every((p) => typeof p === "object" && p !== null && typeof (p as { key?: unknown }).key === "string" && isExpr((p as { value?: unknown }).value, depth + 1)) && more(e.more);
    case "other":
      return true;
    default:
      return false;
  }
}

// The source text of an expression, short, for a note: `asyncHandler(getItem)`.
export function show(e: Expr): string {
  const text = render(e, 0);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function render(e: Expr, depth: number): string {
  if (depth > 4) return "...";
  switch (e.t) {
    case "str":
      return JSON.stringify(e.v.length > 120 ? `${e.v.slice(0, 117)}...` : e.v);
    case "dyn":
      return e.parts ? `\`${e.parts.map((p) => ("s" in p ? p.s : `\${${p.ref.join(".")}}`)).join("")}\`` : "a computed string";
    case "ref":
      return e.path.join(".");
    case "call":
      return `${render(e.fn, depth + 1)}(${e.args
        .slice(0, 4)
        .map((a) => render(a, depth + 1))
        .join(", ")}${e.args.length > 4 ? ", ..." : ""})`;
    case "member":
      return `${render(e.obj, depth + 1)}.${e.prop}`;
    case "fn":
      return "an inline function";
    case "array":
      return `[${e.items
        .slice(0, 4)
        .map((a) => render(a, depth + 1))
        .join(", ")}${e.items.length > 4 ? ", ..." : ""}]`;
    case "object":
      return "an object";
    case "other":
      return "an expression";
  }
}
