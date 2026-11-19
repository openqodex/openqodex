// The Next.js plugin's context-free facts of one JavaScript or TypeScript
// file: the directives at its top ("use client", "use server"), the
// functions whose own body starts with "use server" (inline server
// actions), and the matcher of an exported `config` (the paths middleware
// runs for). A file's routes come from its path, which facts never read;
// its exports come from the language facts.
import type { Node } from "web-tree-sitter";
import type { FactReader, FrameworkFactBase } from "../plugin.js";
import { keptText } from "../shared/kept.js";
import { identifierName, MAX_SOURCE_BYTES, pos, readExpr, scopedVisitor, stringValue } from "../express/js.js";
import { hasError, readAlone } from "../../walk.js";

export type NextFact =
  // A directive of the file's prologue.
  | (FrameworkFactBase & { kind: "directive"; value: string })
  // A function whose own body starts with "use server".
  | (FrameworkFactBase & { kind: "action"; name: string })
  // `export const config = { matcher: ... }`: the literal matchers, or null
  // when the matcher is computed; `more`: entries past what the reader keeps.
  | (FrameworkFactBase & { kind: "matcher"; values: string[] | null; more?: number })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has regions the parser could not read.
  | (FrameworkFactBase & { kind: "syntax-error"; regions: number });

// Every file is read: a route file's conventions come from its path, and a
// directive can sit in any file, so no test on the text can skip one.
export function wants(): boolean {
  return true;
}

const MAX_MATCHERS = 64;
// The node types the reader is entered for (the function types besides, scopedVisitor).
const TYPES: ReadonlySet<string> = new Set(["function_declaration", "arrow_function", "function_expression", "function", "variable_declarator"]);
const DIRECTIVES = new Set(["use client", "use server"]);

// The directives of a statement list's prologue: the string statements
// before anything else.
function prologue(list: Node | null): { value: string; node: Node }[] {
  const out: { value: string; node: Node }[] = [];
  if (!list) return out;
  // Sibling by sibling, so a long body is not listed to find its first statement.
  for (let s = list.firstNamedChild; s; s = s.nextNamedSibling) {
    if (s.type === "comment") continue;
    if (s.type !== "expression_statement" || hasError(s)) break;
    const v = stringValue(s.firstNamedChild);
    if (v === null || s.firstNamedChild?.type !== "string") break;
    out.push({ value: v, node: s });
    if (out.length >= 8) break;
  }
  return out;
}

export function readFacts(root: Node): NextFact[] {
  return readAlone(root, reader(root));
}

// The facts of one file as one reader of a shared walk (walk.ts).
export function reader(root: Node): FactReader<NextFact> {
  if (root.endIndex > MAX_SOURCE_BYTES) return { visitor: null, finish: () => [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }] };
  const out: NextFact[] = [];
  // Only the directives the plugin reads are kept: a prologue string is any literal (shared/kept.ts).
  for (const d of prologue(root)) if (DIRECTIVES.has(d.value)) out.push({ kind: "directive", ...pos(d.node), value: d.value });
  let broken = 0;
  let firstBroken = 0;
  const visitor = scopedVisitor(
    (node, _scope, up, type, upType) => {
      switch (type) {
        case "function_declaration":
        case "arrow_function":
        case "function_expression":
        case "function": {
          const body = node.childForFieldName("body");
          if (body?.type !== "statement_block" || hasError(node)) return;
          if (!prologue(body).some((d) => d.value === "use server")) return;
          let name: string | null = null;
          const own = node.childForFieldName("name");
          if (type === "function_declaration" && own) name = identifierName(own.text);
          else if (upType(1) === "variable_declarator" && up(1)?.childForFieldName("value")?.id === node.id) {
            const n = up(1)?.childForFieldName("name");
            if (n?.type === "identifier") name = identifierName(n.text);
          }
          if (name !== null) out.push({ kind: "action", ...pos(type === "function_declaration" ? node : (up(1) as Node)), name });
          return;
        }
        case "variable_declarator": {
          const n = node.childForFieldName("name");
          if (n?.type !== "identifier" || identifierName(n.text) !== "config" || hasError(node)) return;
          if (upType(2) !== "export_statement") return;
          const value = readExpr(node.childForFieldName("value"));
          if (value.t !== "object") return;
          const m = value.props.find((p) => p.key === "matcher");
          if (!m) return;
          const v = m.value;
          let values: string[] | null = null;
          if (v.t === "str") values = [v.v];
          else if (v.t === "array" && v.items.length <= MAX_MATCHERS && v.items.every((x) => x.t === "str")) values = v.items.map((x) => (x.t === "str" ? x.v : ""));
          // A matcher is a path that starts with "/": any other (Next.js refuses it) makes the list unread, so no other literal is kept.
          if (values?.some((x) => !x.startsWith("/"))) values = null;
          // Each matcher is kept by the one rule (shared/kept.ts); one it drops makes the list unread.
          const kept = values?.map(keptText) ?? null;
          values = kept === null || kept.some((x) => x === null) ? null : (kept as string[]);
          const fact: NextFact = { kind: "matcher", ...pos(node), values };
          if (values !== null && v.t === "array" && v.more) fact.more = v.more;
          out.push(fact);
          return;
        }
      }
    },
    (line) => {
      if (broken++ === 0) firstBroken = line;
    },
    TYPES,
  );
  const finish = (): NextFact[] => {
    if (broken > 0) out.push({ kind: "syntax-error", line: firstBroken, column: 1, regions: broken });
    return out;
  };
  return { visitor, finish };
}

export function isNextFact(v: unknown): v is NextFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "directive":
      return typeof f.value === "string";
    case "action":
      return typeof f.name === "string";
    case "matcher":
      return (f.values === null || (Array.isArray(f.values) && f.values.length <= MAX_MATCHERS && f.values.every((s) => typeof s === "string"))) && (f.more === undefined || Number.isInteger(f.more));
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return Number.isInteger(f.regions);
    default:
      return false;
  }
}
