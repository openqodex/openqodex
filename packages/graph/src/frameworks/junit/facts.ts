import type { Node } from "web-tree-sitter";
import { readAlone } from "../../walk.js";
import type { FactReader, FrameworkFactBase } from "../plugin.js";
import { SIMPLE_NAMES } from "./annotations.js";

export const MAX_ANNOTATIONS = 1999;
const MAX_NAME = 512;
const MAX_NESTING = 32;
const TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const VISITED = new Set([...TYPES, "method_declaration"]);

export type JunitFact =
  | (FrameworkFactBase & { kind: "annotation"; name: string; method: { name: string; line: number; column: number }; owner: string; nested: boolean })
  | (FrameworkFactBase & { kind: "cap" })
  | (FrameworkFactBase & { kind: "parse-error" });

const pos = (n: Node) => ({ line: n.startPosition.row + 1, column: n.startPosition.column + 1 });

// Facts record written names. Resolution decides which annotation they name.
export function reader(_root: Node): FactReader<JunitFact> {
  const facts: JunitFact[] = [];
  const owners: { name: string; depth: number }[] = [];
  let stopped = false;
  let broken = false;
  const cap = (node: Node): false => {
    if (!stopped) facts.push({ kind: "cap", ...pos(node) });
    stopped = true;
    return false;
  };
  return {
    visitor: {
      types: VISITED,
      enter(node, type, _field, depth) {
        if (stopped) return false;
        if (TYPES.has(type)) {
          const name = node.childForFieldName("name");
          if (!name) return false;
          if (owners.length >= MAX_NESTING || name.endIndex - name.startIndex > MAX_NAME) return cap(name);
          owners.push({ name: name.text, depth });
          return;
        }
        const name = node.childForFieldName("name");
        if (!name || owners.length === 0) return;
        const owner = owners.map((o) => o.name).join(".");
        if (owner.length > MAX_NAME || name.endIndex - name.startIndex > MAX_NAME) return cap(name);
        const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
        for (let i = 0; modifiers && i < modifiers.namedChildCount; i++) {
          const annotation = modifiers.namedChild(i);
          if (!annotation || (annotation.type !== "marker_annotation" && annotation.type !== "annotation")) continue;
          const written = annotation.childForFieldName("name");
          if (!written) continue;
          const last = written.childForFieldName("name") ?? written;
          if (last.endIndex - last.startIndex > MAX_NAME || !SIMPLE_NAMES.has(last.text)) continue;
          if (facts.length >= MAX_ANNOTATIONS) return cap(annotation);
          if (written.endIndex - written.startIndex > MAX_NAME) return cap(written);
          facts.push({ kind: "annotation", ...pos(annotation), name: written.text.replace(/\s+/g, ""), method: { name: name.text, line: pos(node).line, column: pos(name).column }, owner, nested: owners.length > 1 });
        }
      },
      leave(depth) {
        if (owners[owners.length - 1]?.depth === depth) owners.pop();
      },
      broken(line) {
        if (!broken && !stopped && facts.length < MAX_ANNOTATIONS) facts.push({ kind: "parse-error", line, column: 1 });
        broken = true;
      },
    },
    finish: () => facts,
  };
}

export const readFacts = (root: Node): JunitFact[] => readAlone(root, reader(root));

export function isJunitFact(value: unknown): value is JunitFact {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  const position = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;
  const name = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME;
  if (!position(f.line) || !position(f.column)) return false;
  if (f.kind === "cap" || f.kind === "parse-error") return true;
  if (f.kind !== "annotation" || !name(f.name) || !name(f.owner) || typeof f.nested !== "boolean" || !f.method || typeof f.method !== "object") return false;
  const method = f.method as Record<string, unknown>;
  return name(method.name) && position(method.line) && position(method.column);
}
