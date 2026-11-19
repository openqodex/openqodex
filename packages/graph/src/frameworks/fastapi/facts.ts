// The FastAPI plugin's context-free facts of one Python file: the names
// bound to values (`app = FastAPI()`, `router = APIRouter(prefix="/v1")`,
// `client = TestClient(app)`, `LEGACY = "/legacy"`), the decorators that
// register the function below them (`@router.get("/{item_id}")`), the
// dependencies a decorated function declares in its parameters, and the
// calls watched on any value (`include_router`, `add_api_route`, and the
// requests a test client makes), and the names each scope binds, so resolve
// can tell an imported FastAPI from a parameter or a local of that name.
// Nothing here knows which name is FastAPI: that is decided in resolve,
// from the file's imports, so a fact never claims what only another file
// can prove.
import type { Node } from "web-tree-sitter";
import type { FrameworkFactBase } from "../plugin.js";
import { keepParts, keptShape, ledForm, methodText, nameText, requestSegmentText, routePathText, routeSegmentText, urlParts } from "../shared/kept.js";
import type { Expr, Kw, Part, Scope } from "./py.js";
import { isExpr, isKws, MAX_ARGS, namePath, pos, readExpr, walkScoped } from "./py.js";

// The most bytes of one file the plugin reads; a larger file gets one
// "too-large" fact and nothing else, and resolve says so with an unknown.
export const MAX_SOURCE_BYTES = 256 * 1024;
// Parameters of one decorated function read for dependencies.
export const MAX_PARAMS = 64;

// The decorators that register the function below them, on an application
// or a router.
export const ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"] as const;
const ROUTE_DECORATORS = new Set<string>([...ROUTE_METHODS, "api_route", "websocket"]);
// The calls watched on any value: route assembly, and a test client's requests.
const WATCHED = new Set<string>(["include_router", "add_api_route", "add_api_websocket_route", "get", "post", "put", "patch", "delete", "options", "head", "request"]);

// A dependency a parameter declares: the call in its default or in its
// `Annotated[...]` metadata, and the parameter's annotation (what a bare
// `Depends()` depends on).
export type ParamDep = { call: Expr; type: Expr | null };

// A decorator of a function: its line, its source as the plugin reads it,
// and whether it is written like a route decorator (`@x.get(...)`).
export type Decorator = { line: number; text: string; route: boolean };

export type FastApiFact =
  // A name bound to a value: `app = FastAPI()`, `with TestClient(app) as c:`.
  // `scope` is the line of the innermost function around it (0 at module level).
  | (FrameworkFactBase & { kind: "value"; name: string; value: Expr; scope: number })
  // A decorator `@recv.method(args)` on a function. `def` is the line the
  // decorated definition starts at (the function's symbol line), `params`
  // the dependencies its parameters declare, in order, and `omitted` the
  // parameters past MAX_PARAMS. `below` lists the decorators between this
  // one and the def, top to bottom (at most MAX_ARGS, `belowOmitted` the
  // rest): what this decorator registers is the function they return.
  | (FrameworkFactBase & { kind: "route"; recv: string[]; method: string; args: Expr[]; kw: Kw[]; fn: string; def: number; scope: number; params: ParamDep[]; omitted: number; below: Decorator[]; belowOmitted: number; cut: number })
  // A watched call `recv.prop(args)` that is not a decorator. On both this
  // and "route", `cut` counts the arguments past MAX_ARGS: a keyword not
  // found may be among them.
  | (FrameworkFactBase & { kind: "call"; recv: Expr; prop: string; args: Expr[]; kw: Kw[]; scope: number; cut: number })
  // A function whose parameters declare calls (`db=Depends(get_db)`), read
  // so a dependency's own dependencies chain: `def` is the function's symbol
  // line, `scope` the scope its parameters are evaluated in.
  | (FrameworkFactBase & { kind: "deps"; fn: string; def: number; scope: number; params: ParamDep[]; omitted: number })
  // The file is larger than MAX_SOURCE_BYTES and was not read.
  | (FrameworkFactBase & { kind: "too-large"; bytes: number })
  // The file has a syntax error (the first one is at the fact's position);
  // nothing inside a broken region was read.
  | (FrameworkFactBase & { kind: "syntax-error" })
  // The names every scope of the file binds: one fact per file, first.
  | (FrameworkFactBase & { kind: "scopes"; frames: ScopeFrame[] });

// One scope of a file and the names it binds, as Python binds them: a name
// a function assigns anywhere in its body (a parameter, an assignment, a
// loop or with target, a nested def or class, an import) is local to the
// whole function. `line` is the line of the def or class (0 for the
// module), `parent` the line of the scope around it (-1 for the module),
// `at` the line its definition starts at, decorators included (the
// symbol's line). `names` leaves out names bound only by an import, which
// are in `imports` with the qualified name they stand for (null when two
// imports bind the name to different things); the module's own imports are
// read from the language facts. `more`: the scope binds names the plugin
// cannot list (a star import inside it), so it is taken to shadow every name.
export type ScopeFrame = { line: number; parent: number; cls: boolean; at: number; names: string[]; imports: { local: string; q: string | null; spec: string }[]; more: boolean };

// Every Python file is read. No text test is a superset of the facts: a
// module that imports its router from another file registers routes with
// no FastAPI name in its text (and Python allows `@ router . get (...)`),
// and a route path can be a constant of a file that names nothing at all.
export function wants(): boolean {
  return true;
}

// The dependencies a function's parameters declare, in order: each
// parameter's `Annotated[...]` metadata calls, then its default when that
// is a call.
function paramDeps(fn: Node): { params: ParamDep[]; omitted: number } {
  const params: ParamDep[] = [];
  const list = fn.childForFieldName("parameters")?.namedChildren ?? [];
  let read = 0;
  let omitted = 0;
  for (const p of list) {
    if (p.type !== "typed_parameter" && p.type !== "default_parameter" && p.type !== "typed_default_parameter") continue;
    if (read >= MAX_PARAMS) {
      omitted++;
      continue;
    }
    read++;
    const typeNode = p.childForFieldName("type");
    const inner = typeNode?.type === "type" ? typeNode.firstNamedChild : typeNode;
    let annotation: Expr | null = null;
    if (inner && (inner.type === "generic_type" || inner.type === "subscript")) {
      const head = inner.type === "subscript" ? inner.childForFieldName("value") : inner.firstNamedChild;
      const headPath = namePath(head);
      if (headPath && headPath[headPath.length - 1] === "Annotated") {
        const args = inner.type === "subscript" ? inner.childrenForFieldName("subscript") : (inner.namedChildren.find((c) => c.type === "type_parameter")?.namedChildren ?? []);
        const types = args.map((a) => (a.type === "type" ? a.firstNamedChild : a)).filter((a): a is Node => a !== null);
        annotation = types[0] ? readExpr(types[0]) : null;
        for (const meta of types.slice(1, MAX_ARGS)) if (meta.type === "call") params.push({ call: readExpr(meta), type: annotation });
        if (types.length > MAX_ARGS) omitted += types.length - MAX_ARGS;
      } else annotation = readExpr(inner);
    } else if (inner) annotation = readExpr(inner);
    const value = p.childForFieldName("value");
    if (value?.type === "call") params.push({ call: readExpr(value), type: annotation });
  }
  return { params, omitted };
}

// The node types a binding target is grouped in: `a, (b, *c) = ...`.
const TARGET_GROUPS = new Set(["pattern_list", "tuple_pattern", "list_pattern", "tuple", "list", "parenthesized_expression", "list_splat_pattern", "as_pattern_target", "expression_list"]);
const FACT_NODES = new Set(["decorated_definition", "call", "assignment", "augmented_assignment", "with_item"]);

// One scope's names while the tree is walked.
type FrameAcc = { line: number; parent: number; cls: boolean; at: number; names: Set<string>; imports: Map<string, { q: string | null; spec: string }>; globals: Set<string>; nonlocals: Set<string>; more: boolean };

export function readFacts(root: Node): FastApiFact[] {
  if (root.endIndex > MAX_SOURCE_BYTES) return [{ kind: "too-large", line: 1, column: 1, bytes: root.endIndex }];
  const out: FastApiFact[] = [];
  let broken: { line: number; column: number } | null = null;

  // ---------- the names each scope binds ----------
  const frame = (line: number, parent: number, cls: boolean, at: number): FrameAcc => ({ line, parent, cls, at, names: new Set(), imports: new Map(), globals: new Set(), nonlocals: new Set(), more: false });
  const moduleFrame = frame(0, -1, false, 0);
  const frames = new Map<number, FrameAcc>([[0, moduleFrame]]);
  const frameAt = (scope: Scope): FrameAcc => frames.get(scope.line) ?? moduleFrame;
  // Every binding site is a name in the source, so the names a file's
  // scopes hold are bounded by its size (MAX_SOURCE_BYTES).
  const bind = (f: FrameAcc, name: string) => {
    f.names.add(name);
  };
  const bindTargets = (f: FrameAcc, node: Node | null, depth = 0) => {
    if (!node || depth > 8) return;
    if (node.type === "identifier") bind(f, node.text);
    else if (TARGET_GROUPS.has(node.type)) for (const c of node.namedChildren) bindTargets(f, c, depth + 1);
  };
  const bindImport = (f: FrameAcc, local: string, q: string, spec: string) => {
    const prev = f.imports.get(local);
    f.imports.set(local, prev && prev.q !== q ? { q: null, spec } : { q, spec });
  };
  let decoratedAt = 0;

  walkScoped(root, (node, scope: Scope, parentType) => {
    // A broken region is not read at all; the file's "syntax-error" fact
    // says so.
    if (node.type === "ERROR" || node.isMissing) {
      broken ??= pos(node);
      return false;
    }
    const f = frameAt(scope);
    switch (node.type) {
      case "function_definition":
      case "class_definition": {
        const line = node.startPosition.row + 1;
        const own = frame(line, scope.line, node.type === "class_definition", parentType === "decorated_definition" ? decoratedAt : line);
        frames.set(line, own);
        bindTargets(f, node.childForFieldName("name"));
        if (node.type === "function_definition" && !node.childForFieldName("parameters")?.hasError) {
          const name = node.childForFieldName("name")?.text;
          const deps = paramDeps(node);
          if (name && deps.params.length > 0) out.push({ kind: "deps", ...pos(node), fn: name, def: own.at, scope: scope.line, params: deps.params, omitted: deps.omitted });
        }
        if (node.type === "function_definition") {
          for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
            if (p.type === "identifier") bind(own, p.text);
            else if (p.type === "default_parameter" || p.type === "typed_default_parameter") bindTargets(own, p.childForFieldName("name"));
            else if (p.type === "typed_parameter" || p.type === "list_splat_pattern" || p.type === "dictionary_splat_pattern") {
              const id = p.namedChildren.find((c) => c.type === "identifier" || c.type === "list_splat_pattern" || c.type === "dictionary_splat_pattern");
              const name = id?.type === "identifier" ? id : (id?.namedChildren.find((c) => c.type === "identifier") ?? null);
              bindTargets(own, name ?? null);
            }
          }
        }
        break;
      }
      case "assignment":
      case "augmented_assignment":
      case "for_statement":
        bindTargets(f, node.childForFieldName("left"));
        break;
      case "with_item":
      case "except_clause": {
        const v = node.childForFieldName("value");
        if (v?.type === "as_pattern") bindTargets(f, v.childForFieldName("alias"));
        break;
      }
      case "named_expression":
        bindTargets(f, node.childForFieldName("name"));
        break;
      case "delete_statement":
        for (const c of node.namedChildren) bindTargets(f, c);
        break;
      case "global_statement":
      case "nonlocal_statement":
        for (const c of node.namedChildren) if (c.type === "identifier") (node.type === "global_statement" ? f.globals : f.nonlocals).add(c.text);
        return false;
      case "import_statement":
      case "import_from_statement": {
        // A module's own imports are read from the language facts; an
        // import inside a function or a class binds a name of that scope.
        if (f === moduleFrame) return false;
        if (node.type === "import_statement") {
          for (const n of node.namedChildren) {
            if (n.type === "dotted_name") bindImport(f, n.text.split(".")[0] as string, n.text.split(".")[0] as string, n.text);
            else if (n.type === "aliased_import") {
              const name = n.childForFieldName("name")?.text;
              const alias = n.childForFieldName("alias")?.text;
              if (name && alias) bindImport(f, alias, name, name);
            }
          }
          return false;
        }
        const spec = node.childForFieldName("module_name")?.text ?? "";
        if (node.namedChildren.some((c) => c.type === "wildcard_import")) f.more = true;
        for (const n of node.childrenForFieldName("name")) {
          if (n.type === "dotted_name") bindImport(f, n.text, `${spec}.${n.text}`, spec);
          else if (n.type === "aliased_import") {
            const name = n.childForFieldName("name")?.text;
            const alias = n.childForFieldName("alias")?.text;
            if (name && alias) bindImport(f, alias, `${spec}.${name}`, spec);
          }
        }
        return false;
      }
    }
    if (node.type === "decorated_definition") decoratedAt = node.startPosition.row + 1;
    // No fact comes from a node whose subtree holds a syntax error.
    if (node.hasError && FACT_NODES.has(node.type)) {
      if (node.type === "decorated_definition") broken ??= pos(node);
      return;
    }
    switch (node.type) {
      case "decorated_definition": {
        const def = node.childForFieldName("definition");
        if (def?.type !== "function_definition") return;
        const name = def.childForFieldName("name")?.text;
        if (!name) return;
        // Every decorator, top to bottom, and whether it is written like a
        // route decorator. Python applies them bottom up, so what a route
        // decorator registers is the function after every decorator below it.
        const decorators: (Decorator & { column: number; recv: string[] | null; method: string; call: Node | null })[] = [];
        for (const d of node.namedChildren) {
          if (d.type !== "decorator") continue;
          const expr = d.firstNamedChild;
          const fn = expr?.type === "call" ? expr.childForFieldName("function") : null;
          const method = fn?.type === "attribute" ? (fn.childForFieldName("attribute")?.text ?? "") : "";
          const recv = fn?.type === "attribute" ? namePath(fn.childForFieldName("object")) : null;
          const route = recv !== null && ROUTE_DECORATORS.has(method);
          // The decorator is named by what it calls, never by its arguments at any depth, which may hold any literal.
          decorators.push({ ...pos(d), text: bare(readExpr(fn ?? expr)), route, recv, method, call: route ? expr : null });
        }
        let deps: { params: ParamDep[]; omitted: number } | null = null;
        decorators.forEach((d, i) => {
          if (!d.route || !d.recv || !d.call) return;
          const e = readExpr(d.call);
          if (e.t !== "call") return;
          deps ??= paramDeps(def);
          const below = decorators.slice(i + 1, i + 1 + MAX_ARGS).map((x) => ({ line: x.line, text: x.text, route: x.route }));
          out.push({ kind: "route", line: d.line, column: d.column, recv: d.recv, method: d.method, args: e.args, kw: e.kw, fn: name, def: node.startPosition.row + 1, scope: scope.line, params: deps.params, omitted: deps.omitted, below, belowOmitted: Math.max(0, decorators.length - i - 1 - below.length), cut: e.omitted });
        });
        return;
      }
      case "call": {
        // A decorator's call is read with its decorated definition.
        if (parentType === "decorator") return;
        const fn = node.childForFieldName("function");
        if (fn?.type !== "attribute") return;
        const prop = fn.childForFieldName("attribute")?.text ?? "";
        if (!WATCHED.has(prop)) return;
        const e = readExpr(node);
        if (e.t !== "call" || e.fn.t !== "ref") {
          // `TestClient(app).get("/x")`: the receiver is a call.
          if (e.t !== "call") return;
          const recv = readExpr(fn.childForFieldName("object"));
          if (recv.t !== "call") return;
          out.push({ kind: "call", ...pos(node), recv, prop, args: e.args, kw: e.kw, scope: scope.line, cut: e.omitted });
          return;
        }
        out.push({ kind: "call", ...pos(node), recv: { t: "ref", path: e.fn.path.slice(0, -1), line: e.fn.line, column: e.fn.column }, prop, args: e.args, kw: e.kw, scope: scope.line, cut: e.omitted });
        return;
      }
      case "assignment":
      case "augmented_assignment": {
        if (scope.inClass) return;
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type !== "identifier" || !right) return;
        // At module level every assignment is kept (as "other" when the
        // plugin does not read its value), so a constant assigned twice is
        // seen as no constant.
        const value = node.type === "assignment" ? valueExpr(right) : null;
        if (value || scope.line === 0) out.push({ kind: "value", ...pos(node), name: left.text, value: value ?? { t: "other", ...pos(right) }, scope: scope.line });
        return;
      }
      case "with_item": {
        // `with TestClient(app) as client:` binds the client.
        const v = node.childForFieldName("value");
        if (v?.type !== "as_pattern") return;
        const target = v.childForFieldName("alias")?.firstNamedChild;
        const value = v.firstNamedChild;
        if (target?.type !== "identifier" || value?.type !== "call") return;
        out.push({ kind: "value", ...pos(node), name: target.text, value: readExpr(value), scope: scope.line });
        return;
      }
    }
  });
  if (root.hasError) {
    const at: { line: number; column: number } = broken ?? { line: 1, column: 1 };
    out.push({ kind: "syntax-error", line: at.line, column: at.column });
  }
  // `global x` makes a function's assignments to x rebind the module's x;
  // `nonlocal x` rebinds the enclosing function's.
  for (const f of frames.values()) {
    for (const g of f.globals) {
      f.names.delete(g);
      f.imports.delete(g);
      if (f !== moduleFrame) bind(moduleFrame, g);
    }
    for (const n of f.nonlocals) {
      f.names.delete(n);
      f.imports.delete(n);
      const parent = frames.get(f.parent);
      if (parent && parent !== moduleFrame) bind(parent, n);
    }
  }
  const scopes: ScopeFrame[] = [...frames.values()].map((f) => ({ line: f.line, parent: f.parent, cls: f.cls, at: f.at, names: [...f.names], imports: [...f.imports].map(([local, x]) => ({ local, q: x.q, spec: x.spec })), more: f.more }));
  // First, so the core's per-file fact cap drops route facts before it drops these.
  out.unshift({ kind: "scopes", line: 1, column: 1, frames: scopes });
  return keepRead(out);
}

// ---------- the literals the facts keep ----------
// A string is kept only where resolve reads one, by the one rule of
// shared/kept.ts: a route's path, methods and name, an include's prefix
// and a router's prefix, as FastAPI reads them (a route: kept whole), a
// request's method and target (a request: nothing from a "?" or a "#" on),
// and a module constant one of those names where no function around the
// use binds the name. Every other literal, in any argument, keyword,
// decorator (at any depth) or value, is kept as `other`.
// "segment" and "tsegment": a later piece of a route's and of a request's
// path; "tpath": a constant a request's target names, kept as a path.
type Form = "path" | "target" | "tpath" | "method" | "name" | "segment" | "tsegment";

const unread = (e: Expr): Expr => ({ t: "other", line: e.line, column: e.column });

// A decorator as the facts name it: what it calls, with every argument
// left out at every depth (`factory(...)()` for `@factory("x")()`).
function bare(e: Expr): string {
  switch (e.t) {
    case "ref":
      return e.path.join(".");
    case "call":
      return `${bare(e.fn)}(...)`;
    default:
      return "an expression";
  }
}

// A request target written as a literal, or a test client's base URL: an
// absolute URL's scheme, host and path (no user, password, query or
// fragment), or the text before a query or a fragment, which may be
// relative to the test client's base URL (resolve joins it to that URL's
// path, as httpx does).
function targetText(s: string): string | null {
  const u = urlParts(s);
  if (u) return u.origin + u.path;
  const at = [s.indexOf("?"), s.indexOf("#")].filter((i) => i >= 0);
  return at.length > 0 ? s.slice(0, Math.min(...at)) : s;
}
// A constant a request's target names: a path or an absolute URL, never a relative text.
const targetPathText = (s: string): string | null => {
  const t = targetText(s);
  return t !== null && (t.startsWith("/") || urlParts(t) !== null) ? t : null;
};
const FORMS: Record<Form, (s: string) => string | null> = { path: routePathText, target: keptShape(targetText), tpath: keptShape(targetPathText), method: methodText, name: nameText, segment: routeSegmentText, tsegment: requestSegmentText };
// The path form of each place a text is read in.
const PATH_FORM: Partial<Record<Form, "route" | "request">> = { path: "route", target: "request" };

function keepRead(facts: FastApiFact[]): FastApiFact[] {
  // The scopes of the file. A name read at a scope reads a module constant
  // only when no function around the read binds it (a class body's names
  // are seen only inside that body, as Python reads them).
  const frames = new Map<number, ScopeFrame>();
  for (const f of facts) if (f.kind === "scopes") for (const fr of f.frames) frames.set(fr.line, fr);
  const readsModule = (name: string, scope: number): boolean => {
    let at = frames.get(scope);
    let first = true;
    for (let guard = 0; at && at.line !== 0 && guard <= frames.size; guard++) {
      if ((!at.cls || first) && (at.more || at.names.includes(name) || at.imports.some((i) => i.local === name))) return false;
      first = false;
      at = frames.get(at.parent);
    }
    return at !== undefined || scope === 0;
  };
  // A module constant as resolve reads one: every module-level assignment
  // gives the same string. One index of the file, made once, so a lookup
  // per concatenation never scans the facts again.
  const constants = new Map<string, string | null>();
  for (const f of facts) {
    if (f.kind !== "value" || f.scope !== 0) continue;
    const had = constants.get(f.name);
    constants.set(f.name, f.value.t !== "str" || had === null || (had !== undefined && had !== f.value.v) ? null : f.value.v);
  }
  const constant = (name: string): string | null => constants.get(name) ?? null;
  // The names a test client is bound to in this file (`client = TestClient(app)`,
  // `with TestClient(app) as client:`): only a request on one of them, or on
  // a client made in place, keeps a target that is relative to its base URL.
  const isClientCall = (e: Expr): boolean => e.t === "call" && e.fn.t === "ref" && e.fn.path[e.fn.path.length - 1] === "TestClient";
  const clients = new Set<string>();
  for (const f of facts) if (f.kind === "value" && isClientCall(f.value)) clients.add(f.name);
  const used = new Map<string, Set<Form>>();
  let at = 0; // the scope of the fact being read
  const use = (name: string, form: Form) => {
    if (readsModule(name, at)) (used.get(name) ?? used.set(name, new Set()).get(name))?.add(form);
  };
  // Names read as a later piece of a concatenation, with the piece that
  // leads them and the form of the text they are a piece of.
  const led: { name: string; lead: Part; form: Form }[] = [];
  // An expression read only for its names and calls: no literal in it.
  const names = (e: Expr): Expr => {
    switch (e.t) {
      case "str":
      case "dyn":
        return unread(e);
      case "call":
        return { ...e, fn: names(e.fn), args: e.args.map(names), kw: e.kw.map((k) => ({ key: k.key, value: names(k.value) })) };
      case "list":
        return { ...e, items: e.items.map(names) };
      default:
        return e;
    }
  };
  // An expression read as a path, a target, a method or a name. A target a
  // non-client may be asked for (`lookup.get("key")`) keeps only a path.
  const text = (e: Expr | undefined, form: Form, client = true): Expr | undefined => {
    if (e === undefined) return e;
    const own = form === "target" && !client ? (s: string) => (targetText(s)?.startsWith("/") ? FORMS.target(s) : null) : FORMS[form];
    switch (e.t) {
      case "str": {
        const v = own(e.v);
        return v === null ? unread(e) : { ...e, v };
      }
      case "dyn": {
        const pathForm = PATH_FORM[form];
        if (!e.parts || !pathForm) return unread(e);
        const parts = keepParts(
          e.parts,
          pathForm,
          (ref, lead) => {
            if (ref.length !== 1) return;
            if (lead === null) use(ref[0] as string, form === "target" ? "tpath" : form);
            else if (readsModule(ref[0] as string, at)) led.push({ name: ref[0] as string, lead, form });
          },
          (name) => (readsModule(name, at) ? constant(name) : null),
          form === "target" ? own : null,
        );
        return parts === null ? unread(e) : { ...e, parts };
      }
      case "ref":
        if (e.path.length === 1) use(e.path[0] as string, form === "target" ? "tpath" : form);
        return e;
      case "list":
        return { ...e, items: e.items.map((x) => text(x, form, client) as Expr) };
      default:
        return names(e);
    }
  };
  // Arguments and keywords: those `read` names in the form it gives, the rest by names only.
  const args = (list: Expr[], read: (Form | null)[], client = true): Expr[] => list.map((a, i) => (read[i] ? (text(a, read[i] as Form, client) as Expr) : names(a)));
  const kws = (list: Kw[], read: Record<string, Form>, client = true): Kw[] => list.map((k) => ({ key: k.key, value: read[k.key] ? (text(k.value, read[k.key] as Form, client) as Expr) : names(k.value) }));
  const ROUTE_KW: Record<string, Form> = { path: "path", methods: "method", name: "name" };
  // A test client made in place or bound: its app and the other names as
  // names, and its base URL (the second argument, or `base_url`) as a target.
  const client = (e: Expr): Expr => (e.t === "call" ? { ...(names(e) as Extract<Expr, { t: "call" }>), args: e.args.map((a, i) => (i === 1 ? (text(a, "target") as Expr) : names(a))), kw: kws(e.kw, { base_url: "target" }) } : names(e));
  const out: FastApiFact[] = facts.map((f) => {
    at = "scope" in f ? f.scope : 0;
    switch (f.kind) {
      case "route":
        return { ...f, args: args(f.args, ["path"]), kw: kws(f.kw, ROUTE_KW), params: f.params.map((p) => ({ call: names(p.call), type: p.type && names(p.type) })) };
      case "deps":
        return { ...f, params: f.params.map((p) => ({ call: names(p.call), type: p.type && names(p.type) })) };
      case "call": {
        const recv = isClientCall(f.recv) ? client(f.recv) : names(f.recv);
        const isClient = isClientCall(f.recv) || (f.recv.t === "ref" && f.recv.path.length === 1 && clients.has(f.recv.path[0] as string));
        if (f.prop === "request") return { ...f, recv, args: args(f.args, ["method", "target"], isClient), kw: kws(f.kw, { method: "method", url: "target" }, isClient) };
        if (f.prop === "include_router") return { ...f, recv, args: args(f.args, []), kw: kws(f.kw, { prefix: "path" }) };
        if (f.prop === "add_api_route" || f.prop === "add_api_websocket_route") return { ...f, recv, args: args(f.args, ["path"]), kw: kws(f.kw, ROUTE_KW) };
        return { ...f, recv, args: args(f.args, ["target"], isClient), kw: kws(f.kw, { url: "target" }, isClient) };
      }
      case "value":
        // A router's prefix and a test client's base URL are read; a string is decided below, once every use is known.
        if (isClientCall(f.value)) return { ...f, value: client(f.value) };
        if (f.value.t === "call") return { ...f, value: { ...names(f.value), kw: kws(f.value.kw, { prefix: "path" }) } as Expr };
        return f.value.t === "str" ? f : { ...f, value: names(f.value) };
      default:
        return f;
    }
  });
  for (const l of led) {
    const lf = ledForm(l.lead, constant);
    use(l.name, l.form === "target" ? (lf === "segment" ? "tsegment" : "tpath") : lf === "segment" ? "segment" : "path");
  }
  // A module constant is kept, in the form a use reads it in, only when some
  // use reads it; a function's own value is never a constant resolve reads.
  return out.map((f) => {
    if (f.kind !== "value" || f.value.t !== "str") return f;
    const forms = f.scope === 0 ? used.get(f.name) : undefined;
    const str = f.value;
    const v = forms ? ([...forms].map((form) => FORMS[form](str.v)).find((x) => x !== null) ?? null) : null;
    return { ...f, value: v === null ? unread(str) : { ...str, v } };
  });
}

// The value of an assignment the plugin may need: a call (an application,
// a router, a test client), a name (an alias of one), or a string (a
// constant a route path is built from). Anything else is not read, so a
// module of plain data costs one small fact per module-level name.
function valueExpr(right: Node): Expr | null {
  if (right.type !== "call" && right.type !== "identifier" && right.type !== "attribute" && right.type !== "string" && right.type !== "concatenated_string") return null;
  const e = readExpr(right);
  return e.t === "other" ? null : e;
}

function isFrame(v: unknown): v is ScopeFrame {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    Number.isInteger(f.line) &&
    Number.isInteger(f.parent) &&
    typeof f.cls === "boolean" &&
    Number.isInteger(f.at) &&
    Array.isArray(f.names) &&
    f.names.every((n) => typeof n === "string") &&
    Array.isArray(f.imports) &&
    f.imports.every((i) => typeof i === "object" && i !== null && typeof (i as { local?: unknown }).local === "string" && typeof (i as { spec?: unknown }).spec === "string" && ((i as { q?: unknown }).q === null || typeof (i as { q?: unknown }).q === "string")) &&
    typeof f.more === "boolean"
  );
}

const isParamDep = (p: unknown): boolean => typeof p === "object" && p !== null && isExpr((p as { call?: unknown }).call) && ((p as { type?: unknown }).type === null || isExpr((p as { type?: unknown }).type));

export function isFastApiFact(v: unknown): v is FastApiFact {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (!Number.isInteger(f.line) || !Number.isInteger(f.column)) return false;
  switch (f.kind) {
    case "value":
      return typeof f.name === "string" && isExpr(f.value) && Number.isInteger(f.scope);
    case "route":
      return (
        Array.isArray(f.recv) &&
        f.recv.length > 0 &&
        f.recv.every((s) => typeof s === "string") &&
        typeof f.method === "string" &&
        Array.isArray(f.args) &&
        f.args.every((a) => isExpr(a)) &&
        isKws(f.kw) &&
        typeof f.fn === "string" &&
        Number.isInteger(f.def) &&
        Number.isInteger(f.scope) &&
        Array.isArray(f.params) &&
        f.params.every(isParamDep) &&
        Number.isInteger(f.omitted) &&
        Array.isArray(f.below) &&
        f.below.every((d) => typeof d === "object" && d !== null && Number.isInteger((d as { line?: unknown }).line) && typeof (d as { text?: unknown }).text === "string" && typeof (d as { route?: unknown }).route === "boolean") &&
        Number.isInteger(f.belowOmitted) &&
        Number.isInteger(f.cut)
      );
    case "call":
      return isExpr(f.recv) && typeof f.prop === "string" && Array.isArray(f.args) && f.args.every((a) => isExpr(a)) && isKws(f.kw) && Number.isInteger(f.scope) && Number.isInteger(f.cut);
    case "deps":
      return typeof f.fn === "string" && Number.isInteger(f.def) && Number.isInteger(f.scope) && Array.isArray(f.params) && f.params.every(isParamDep) && Number.isInteger(f.omitted);
    case "too-large":
      return Number.isInteger(f.bytes);
    case "syntax-error":
      return true;
    case "scopes":
      return Array.isArray(f.frames) && f.frames.every(isFrame);
    default:
      return false;
  }
}
