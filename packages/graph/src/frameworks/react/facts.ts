// The React plugin's context-free facts of one JavaScript or TypeScript
// file: the functions and classes that return JSX, the JSX elements and
// which function each sits in, the calls of hooks, the contexts made with
// createContext, and the test blocks. Nothing here knows which import is
// React: that is decided in resolve, from the file's imports.
//
// One pass over the tree with a stack of frames (functions and classes),
// kept by depth as the walk enters and leaves them; whether an element is
// returned is read from the types of its ancestors, which the walk keeps.
// No step climbs the parents, and the one climb through the ancestors' types
// stops at the nearest element above, so a deeply nested file stays linear.
import type { Node } from "web-tree-sitter";
import type { FactReader, FrameworkFactBase } from "../plugin.js";
import { readAlone } from "../../walk.js";
import type { TreeVisitor, UpType } from "../../walk.js";
import { exported, identifierName, MAX_SOURCE_BYTES, namePath, pos } from "../express/js.js";

export type ReactFact =
  // A function or class that may be a component: its name, where it is
  // declared, whether its own body returns JSX, and for a class the base it
  // extends as written.
  | (FrameworkFactBase & { kind: "component"; name: string; form: "function" | "class"; returnsJsx: boolean; base: string[] | null; exported: boolean })
  // A JSX element whose name is not an intrinsic tag: `<Button />`,
  // `<Theme.Provider>`. `local`: the name is a parameter or a variable of a
  // function around it (a computed component). `render`: the element is the
  // first argument of this call (`render(<X />)` in a test).
  | (FrameworkFactBase & { kind: "element"; name: string[]; local: boolean; render: string[] | null })
  // A call of a hook: `useState(...)`, `React.useEffect(...)`, `useUser(id)`.
  // `scope` is the line of the function it is called in (0 at module level);
  // `local`: the callee's first name is a parameter or a local of a function
  // around the call, so it is not the import or the module's definition.
  | (FrameworkFactBase & { kind: "hook-call"; name: string[]; scope: number; local: boolean })
  // `const ThemeContext = createContext(...)`.
  | (FrameworkFactBase & { kind: "context"; name: string; callee: string[] })
  // A test block: `describe(...)`, `it(...)`, `test(...)`.
  | (FrameworkFactBase & { kind: "test-block"; fn: string; name: string | null })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has regions the parser could not read (the first at `line`):
  // nothing in them is a fact.
  | (FrameworkFactBase & { kind: "syntax-error"; regions: number });

// Every file is read: a component can render another without naming React,
// and a hook can be called in any file, so no test on the text can tell
// which files hold none. The facts come from the tree the core parsed.
export function wants(): boolean {
  return true;
}

const FN_TYPES = new Set(["arrow_function", "function_expression", "function", "generator_function", "function_declaration", "generator_function_declaration", "method_definition"]);
const CLASS_TYPES = new Set(["class_declaration", "class"]);
const JSX_TYPES = new Set(["jsx_element", "jsx_self_closing_element"]);
const TEST_FNS = new Set(["describe", "it", "test", "suite"]);
// What an element may sit in and still be what a return hands back:
// `return (<X />)`, `cond ? <A /> : <B />`, `ok && <X />`.
const PASS_THROUGH = new Set(["parenthesized_expression", "ternary_expression", "binary_expression"]);
// The node types the reader is entered for.
const TYPES: ReadonlySet<string> = new Set([...FN_TYPES, ...CLASS_TYPES, "variable_declarator", ...JSX_TYPES, "jsx_fragment", "jsx_opening_element", "call_expression"]);

const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;

// A hook's name: `use`, or `use` followed by an upper-case letter or a digit.
export function isHookName(name: string): boolean {
  if (!name.startsWith("use")) return false;
  if (name.length === 3) return true;
  const c = name.charCodeAt(3);
  return isUpper(c) || isDigit(c);
}

// A component's name starts with an upper-case letter.
export const isComponentName = (name: string): boolean => name.length > 0 && isUpper(name.charCodeAt(0));

type Frame = { t: "fn"; depth: number; line: number; fact: number | null; locals: string[]; render: boolean } | { t: "class"; depth: number; fact: number };

// The names a binding pattern declares: `x`, `{ a, b: c }`, `[d, ...e]`.
function patternNames(node: Node | null, out: string[], budget = { left: 64 }): void {
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

export function readFacts(root: Node): ReactFact[] {
  return readAlone(root, reader(root));
}

// The facts of one file as one reader of a shared walk (walk.ts).
export function reader(root: Node): FactReader<ReactFact> {
  if (root.endIndex > MAX_SOURCE_BYTES) return { visitor: null, finish: () => [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }] };
  const out: ReactFact[] = [];
  const frames: Frame[] = [];
  // The function frames alone, so the innermost one is found in one step.
  const fnFrames: (Frame & { t: "fn" })[] = [];
  // Names declared by the functions on the stack, with how many frames declare each.
  const locals = new Map<string, number>();
  const topFn = (): (Frame & { t: "fn" }) | null => fnFrames[fnFrames.length - 1] ?? null;
  // The answer of `returned` for each element on the path from the root to
  // the node entered, innermost last, popped as the walk leaves them (pop).
  const elements: { depth: number; returned: boolean }[] = [];
  // Whether the node entered is what the innermost function returns: an
  // arrow function's expression body, or, for an element, one under a
  // return statement or such a body through nothing but PASS_THROUGH nodes
  // and other elements. A function, a class, or any other node between
  // them ends the returned position (`return () => <X />` returns a
  // function; `return f(<X />)` the call's value).
  const returned = (type: string, field: () => string | null, upType: UpType, depth: number): boolean => {
    if (topFn() === null) return false;
    if (upType(1) === "arrow_function" && type !== "statement_block" && field() === "body") return true;
    if (!JSX_TYPES.has(type)) return false;
    for (let k = 1; ; k++) {
      const t = upType(k);
      if (t === null) return false;
      // An arrow function holds a node from these types only as its body.
      if (t === "return_statement" || (upType(k + 1) === "arrow_function" && t !== "statement_block")) return !FN_TYPES.has(t);
      if (JSX_TYPES.has(t)) {
        // The nearest element above has its answer, and the climb from it
        // would be this one's: n nested elements climb n steps in all, not
        // n squared (issue #101). An element the walk did not enter (none
        // is known) is climbed through as before.
        const above = elements[elements.length - 1];
        if (above !== undefined && above.depth === depth - k) return above.returned;
        continue;
      }
      if (!PASS_THROUGH.has(t)) return false;
    }
  };
  const pop = (depth: number) => {
    while (elements.length > 0 && (elements[elements.length - 1] as { depth: number }).depth >= depth) elements.pop();
    while (frames.length > 0 && (frames[frames.length - 1] as Frame).depth >= depth) {
      const f = frames.pop() as Frame;
      if (f.t === "fn") {
        fnFrames.pop();
        for (const n of f.locals) locals.set(n, (locals.get(n) ?? 1) - 1);
      }
    }
  };
  const declare = (name: string) => {
    const fn = topFn();
    if (!fn) return; // module level: a name the resolver can look up
    fn.locals.push(name);
    locals.set(name, (locals.get(name) ?? 0) + 1);
  };

  let broken = 0;
  let firstBroken = 0;
  // A region the parser could not read is never entered (walk.ts):
  // the language would not run such a file, so nothing in it is a fact.
  const visitor: TreeVisitor = {
    types: TYPES,
    enter(node, type, field, depth, up, upType) {
      const parentType = upType(1);
      if (FN_TYPES.has(type)) {
        let name: string | null = null;
        let line = node.startPosition.row + 1;
        let column = node.startPosition.column + 1;
        let isExported = false;
        if (type === "function_declaration" || type === "generator_function_declaration") {
          const n = node.childForFieldName("name");
          name = n ? identifierName(n.text) : null;
          isExported = exported(upType);
          // A nested function's name is a local of the function around it.
          if (name !== null) declare(name);
        } else if (type === "method_definition") {
          name = null;
        } else if (parentType === "variable_declarator" && field() === "value") {
          const parent = up(1) as Node;
          const n = parent.childForFieldName("name");
          if (n?.type === "identifier") {
            name = identifierName(n.text);
            line = parent.startPosition.row + 1;
            column = parent.startPosition.column + 1;
            isExported = exported((k) => upType(k + 1));
          }
        }
        // Only a top-level function (or one directly in an exported binding) is a component.
        let fact: number | null = null;
        if (name && isComponentName(name) && topFn() === null) {
          out.push({ kind: "component", line, column, name, form: "function", returnsJsx: false, base: null, exported: isExported });
          fact = out.length - 1;
        }
        // `render() { return <X /> }` of a class: the class returns JSX.
        if (type === "method_definition" && node.childForFieldName("name")?.text === "render") {
          const cls = frames[frames.length - 1];
          if (cls && cls.t === "class") fact = cls.fact;
        }
        const frame: Frame & { t: "fn" } = { t: "fn", depth, line: node.startPosition.row + 1, fact, locals: [], render: false };
        frames.push(frame);
        fnFrames.push(frame);
        const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
        if (params) {
          const names: string[] = [];
          if (params.type === "identifier") names.push(params.text);
          else for (const p of params.namedChildren) patternNames(p, names);
          for (const n of names) declare(n);
        }
      } else if (CLASS_TYPES.has(type)) {
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? identifierName(nameNode.text) : null;
        const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
        const ext = heritage?.namedChildren.find((c) => c.type === "extends_clause") ?? null;
        const baseNode = ext ? (ext.childForFieldName("value") ?? ext.firstNamedChild) : (heritage?.firstNamedChild ?? null);
        if (name && isComponentName(name) && topFn() === null) {
          out.push({ kind: "component", ...pos(node), name, form: "class", returnsJsx: false, base: namePath(baseNode), exported: exported(upType) });
          frames.push({ t: "class", depth, fact: out.length - 1 });
        }
      } else if (type === "variable_declarator") {
        const n = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        const names: string[] = [];
        patternNames(n, names);
        for (const x of names) declare(x);
        if (n?.type === "identifier" && value?.type === "call_expression") {
          const callee = namePath(value.childForFieldName("function"));
          const id = identifierName(n.text);
          if (id !== null && callee && callee[callee.length - 1] === "createContext" && topFn() === null && !node.hasError) out.push({ kind: "context", ...pos(node), name: id, callee });
        }
      } else if (JSX_TYPES.has(type)) {
        const nameNode = type === "jsx_element" ? (node.childForFieldName("open_tag")?.childForFieldName("name") ?? null) : node.childForFieldName("name");
        const name = namePath(nameNode);
        const fn = topFn();
        const ret = returned(type, field, upType, depth);
        elements.push({ depth, returned: ret });
        if (fn && ret && fn.fact !== null) {
          const f = out[fn.fact];
          if (f && f.kind === "component") f.returnsJsx = true;
        }
        if (name && !node.hasError && (name.length > 1 || isComponentName(name[0] as string))) {
          let render: string[] | null = null;
          if (parentType === "arguments" && upType(2) === "call_expression" && up(1)?.firstNamedChild?.id === node.id) render = namePath((up(2) as Node).childForFieldName("function"));
          out.push({ kind: "element", ...pos(node), name, local: (locals.get(name[0] as string) ?? 0) > 0, render });
        }
      } else if (type === "jsx_fragment" || (type === "jsx_opening_element" && node.childForFieldName("name") === null)) {
        const fn = topFn();
        if (fn && returned(type, field, upType, depth) && fn.fact !== null) {
          const f = out[fn.fact];
          if (f && f.kind === "component") f.returnsJsx = true;
        }
      } else if (type === "call_expression" && !node.hasError) {
        const fn = node.childForFieldName("function");
        // A member callee's name path ends in its property and holds two or
        // more names: it can only be a hook's (`React.useState`).
        if (fn?.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          const name = prop?.type === "property_identifier" ? identifierName(prop.text) : null;
          if (name === null || !isHookName(name)) return;
        }
        const callee = namePath(fn);
        const last = callee ? (callee[callee.length - 1] as string) : null;
        if (callee && last && isHookName(last) && callee.length <= 2) out.push({ kind: "hook-call", ...pos(node), name: callee, scope: topFn()?.line ?? 0, local: (locals.get(callee[0] as string) ?? 0) > 0 });
        // A test block is counted, never named: its title may hold any literal, and the cached facts keep none they do not read.
        if (callee && callee.length === 1 && TEST_FNS.has(last as string)) out.push({ kind: "test-block", ...pos(node), fn: last as string, name: null });
      }
    },
    leave: (depth) => pop(depth),
    broken(line) {
      if (broken++ === 0) firstBroken = line;
    },
  };
  const finish = (): ReactFact[] => {
    if (broken > 0) out.push({ kind: "syntax-error", line: firstBroken, column: 1, regions: broken });
    return out;
  };
  return { visitor, finish };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 16 && v.every((s) => typeof s === "string");

export function isReactFact(v: unknown): v is ReactFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "component":
      return typeof f.name === "string" && (f.form === "function" || f.form === "class") && typeof f.returnsJsx === "boolean" && (f.base === null || strings(f.base)) && typeof f.exported === "boolean";
    case "element":
      return strings(f.name) && typeof f.local === "boolean" && (f.render === null || strings(f.render));
    case "hook-call":
      return strings(f.name) && Number.isInteger(f.scope) && typeof f.local === "boolean";
    case "context":
      return typeof f.name === "string" && strings(f.callee);
    case "test-block":
      return typeof f.fn === "string" && (f.name === null || typeof f.name === "string");
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return Number.isInteger(f.regions);
    default:
      return false;
  }
}
