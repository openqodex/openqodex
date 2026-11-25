// The Rails plugin's context-free facts, read from one Ruby file's parse
// tree. A fact never names the file it was read from and never refers to
// another file: the resolve step decides what a fact means from the file's
// place in an application (config/routes.rb, app/controllers/, db/migrate/).
//
// What is read:
// - route DSL calls inside a `<receiver>.routes.draw do ... end` block, as a
//   flat list with parent indexes for nesting. A route call outside a draw
//   block is never a route fact.
// - classes and modules with their qualified name, base and includes, and
//   inside a class body the controller callbacks, visibility changes, model
//   associations, `self.table_name =`, `self.abstract_class =` and
//   `isolate_namespace`.
// - `render` calls, migration operations, job enqueues, mail deliveries,
//   config reads and assignments, ENV reads, `describe` subjects, test
//   requests (`get "/posts"`, `visit "/x"`) and route helper names
//   (`posts_path`, `post_url`).
// Literal values only: a computed value is recorded as computed, never
// guessed. Values of config keys and ENV entries are never recorded. Every
// string kept is bounded, with key-shaped text redacted (shared/kept.ts). A
// route keeps only the options the resolve step reads, a path with no
// scheme, host, query string or fragment, and a target only when it is
// controller#action; a test request keeps its path alone.
import type { Node } from "web-tree-sitter";
import type { FrameworkFactBase } from "../plugin.js";
import { keptText, pathText } from "../shared/kept.js";

// A literal argument or option value as written.
export type Lit =
  | { t: "str"; v: string } // a string with no interpolation
  | { t: "sym"; v: string } // a symbol: `:posts`, `:"posts"`
  | { t: "const"; v: string } // a constant path: `Blog::Engine`
  | { t: "list"; v: string[] } // an array of string or symbol literals
  | { t: "bool"; v: boolean }
  | { t: "nil" }
  | { t: "call"; v: string } // a bare method call: `redirect("/x")`
  | { t: "hash"; v: Record<string, Lit> } // a hash literal with symbol keys, one level deep: `{ controller: "pages" }`
  | { t: "dyn" }; // anything else: computed

// A `<receiver>.routes.draw do ... end` block.
export type DrawFact = FrameworkFactBase & { kind: "draw"; receiver: string; endLine: number };

// One call in a draw block. `draw` is the ordinal of the draw block in the
// file, or -1 for a route call at the top of a file (what a file under
// config/routes/ holds, read only when a route file draws it with
// `draw(:name)`); `parent` the index of the enclosing route call among the
// file's route facts (-1 directly in the draw block or at the top). `opts` holds the symbol-keyed
// options (`to:`, `only:`, `as:`); `pair` the first pair whose key is not a
// symbol (`"status" => "health#show"`, `Blog::Engine => "/blog"`).
export type RouteFact = FrameworkFactBase & {
  kind: "route";
  draw: number;
  parent: number;
  call: string;
  args: Lit[];
  opts: Record<string, Lit>;
  pair: [Lit, Lit] | null;
  block: boolean;
};

// The route options the resolve step reads, and the keys of `defaults:` it
// reads. Any other option (`constraints:`, `format:`, a `defaults:` value
// of another key) is not kept.
const ROUTE_OPTIONS = new Set(["action", "as", "at", "concerns", "controller", "defaults", "except", "module", "on", "only", "param", "path", "shallow", "shallow_path", "shallow_prefix", "to", "via"]);
const DEFAULT_KEYS = new Set(["controller", "action"]);

// Route options and arguments the resolve step reads as a path.
const PATH_OPTIONS = new Set(["path", "at", "shallow_path"]);

// A route path as the resolve step reads it (shared/kept.ts `pathText`);
// computed when it hides an encoded key.
function pathLit(x: Lit): Lit {
  if (x.t !== "str") return x;
  const v = pathText(x.v);
  return v === null ? { t: "dyn" } : { t: "str", v };
}

// A route target the resolve step reads: a string only when it is
// controller#action (`admin/posts#index`), anything else as it is. A string
// of another shape is not kept: it reads as computed.
function targetLit(x: Lit): Lit {
  if (x.t !== "str") return x;
  const hash = x.v.indexOf("#");
  if (hash <= 0 || hash === x.v.length - 1 || hash !== x.v.lastIndexOf("#")) return { t: "dyn" };
  for (let i = 0; i < x.v.length; i++) {
    const c = x.v.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122) || c === 95 || c === 35 || (i < hash && (c === 47 || c === 58));
    if (!ok) return { t: "dyn" };
  }
  return x;
}

// An option as the resolve step reads it: a path, a target, a `defaults:`
// hash with only the keys it reads, or a name or list as litOf kept it.
function optionLit(key: string, x: Lit): Lit {
  if (PATH_OPTIONS.has(key)) return pathLit(x);
  if (key === "to") return targetLit(x);
  if (x.t === "hash") return { t: "hash", v: Object.fromEntries(Object.entries(x.v).filter(([k]) => DEFAULT_KEYS.has(k))) };
  return x;
}

// Route blocks nested deeper than MAX_ROUTE_DEPTH (`by` "blocks"), or a
// route call more than MAX_NODE_DEPTH syntax levels deep (`by` "syntax"), are not read.
export type RouteCapFact = FrameworkFactBase & { kind: "route-cap"; draw: number; parent: number; by: "blocks" | "syntax" };

// A class or module, with its name qualified by the lexical nesting.
// `base` is the superclass as written (`ActiveRecord::Migration` for
// `ActiveRecord::Migration[7.1]`), null when none or computed.
export type ClassFact = FrameworkFactBase & { kind: "class"; name: string; module: boolean; base: string | null; includes: string[]; endLine: number };

// Facts inside a class body name their class by the class fact's line (`cls`).
export type CallbackFact = FrameworkFactBase & { kind: "callback"; cls: number; call: string; targets: string[]; dynamic: boolean; only: string[] | null; except: string[] | null };
// `private` alone (names null) or `private :a` and `private def a` (names).
export type VisibilityFact = FrameworkFactBase & { kind: "visibility"; cls: number; value: "private" | "protected" | "public"; names: string[] | null };
// `through` and `source` name associations, not classes: the class of a
// through association is the class of its source association on the
// through model.
export type AssocFact = FrameworkFactBase & { kind: "assoc"; cls: number; macro: string; name: string | null; className: string | null; classNameDynamic: boolean; polymorphic: boolean; through: string | null; source: string | null; sourceType: string | null };
export type TableNameFact = FrameworkFactBase & { kind: "table-name"; cls: number; value: string | null };
export type AbstractFact = FrameworkFactBase & { kind: "abstract"; cls: number };
export type IsolateFact = FrameworkFactBase & { kind: "isolate"; cls: number; name: string | null };

// `render "x"` (name), `render template:`, `render :x` and `render action:`
// (action), `render partial:`; `render SomeView.new(...)` (component, the
// constant as written); "other" for a render of no template (`json:`,
// `plain:`); value null when the name is computed.
export type RenderFact = FrameworkFactBase & { kind: "render"; mode: "name" | "template" | "action" | "partial" | "component" | "other"; value: string | null };

// A schema operation in a migration (or anywhere: the resolve step reads
// them only in db/migrate/). `table` is null when computed.
// `field` is the column the operation names (`add_column :posts, :title`).
export type MigrationOpFact = FrameworkFactBase & { kind: "migration-op"; op: string; table: string | null; field: string | null; to: string | null; columns: string[] };

// `XJob.perform_later`, `XJob.set(...).perform_later`, `XWorker.perform_async`.
export type EnqueueFact = FrameworkFactBase & { kind: "enqueue"; target: string; via: string };
// `XMailer.welcome(...).deliver_later`, `XMailer.with(...).welcome.deliver_now`.
export type MailFact = FrameworkFactBase & { kind: "mail"; target: string; action: string; via: string };

// `Rails.application.config.x.y` and `Rails.configuration.x.y` (source
// "rails", key "x.y"), `ENV["X"]` and `ENV.fetch("X")` (source "env").
export type ConfigReadFact = FrameworkFactBase & { kind: "config-read"; source: "rails" | "env"; key: string | null };
// `config.x.y = ...` and `Rails.application.config.x.y = ...`.
export type ConfigDefineFact = FrameworkFactBase & { kind: "config-define"; key: string };

// `describe PostsController`, `RSpec.describe Post, type: :model`.
export type DescribeFact = FrameworkFactBase & { kind: "describe"; subject: string; type: string | null; endLine: number };
// A bare `get "/posts"`, `post :create`, `visit "/x"` outside any draw
// block. `path` is a string, a symbol, or computed.
export type RequestFact = FrameworkFactBase & { kind: "request"; verb: string; path: Lit };
// A bare `posts_path` or `post_url(...)`; `verb` when it is the first
// argument of a request (`delete post_path(p)`).
export type RouteNameFact = FrameworkFactBase & { kind: "route-name"; name: string; verb: string | null };

export type RailsFact =
  | DrawFact
  | RouteFact
  | RouteCapFact
  | ClassFact
  | CallbackFact
  | VisibilityFact
  | AssocFact
  | TableNameFact
  | AbstractFact
  | IsolateFact
  | RenderFact
  | MigrationOpFact
  | EnqueueFact
  | MailFact
  | ConfigReadFact
  | ConfigDefineFact
  | DescribeFact
  | RequestFact
  | RouteNameFact;

// The deepest nesting of route blocks read (PLAN.md 3.2.3, include depth 8).
export const MAX_ROUTE_DEPTH = 8;
// The deepest syntax nesting walked inside one draw block.
export const MAX_NODE_DEPTH = 200;

const CALLBACKS = new Set([
  "before_action",
  "after_action",
  "around_action",
  "prepend_before_action",
  "prepend_after_action",
  "prepend_around_action",
  "append_before_action",
  "append_after_action",
  "append_around_action",
  "skip_before_action",
  "skip_after_action",
  "skip_around_action",
]);
const ASSOCIATIONS = new Set(["has_many", "has_one", "belongs_to", "has_and_belongs_to_many"]);
export const MIGRATION_OPS = new Set([
  "create_table",
  "drop_table",
  "rename_table",
  "change_table",
  "add_column",
  "remove_column",
  "rename_column",
  "change_column",
  "change_column_default",
  "change_column_null",
  "add_reference",
  "remove_reference",
  "add_belongs_to",
  "remove_belongs_to",
  "add_index",
  "remove_index",
  "add_timestamps",
  "remove_timestamps",
  "add_foreign_key",
  "remove_foreign_key",
  "create_join_table",
  "drop_join_table",
]);
const ENQUEUES = new Set(["perform_later", "perform_now", "perform_async", "perform_in", "perform_at", "perform_bulk"]);
const DELIVERIES = new Set(["deliver_later", "deliver_now", "deliver_later!", "deliver_now!"]);
export const REQUEST_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "visit"]);
const VISIBILITY = new Set(["private", "protected", "public"]);
// The longest identifier read as a route helper name.
const MAX_HELPER = 128;

// The route name of a URL helper identifier (`posts_path`, `new_post_url`),
// or null. A character loop, never a pattern run on repository text.
export function helperName(id: string): string | null {
  if (id.length > MAX_HELPER) return null;
  const cut = id.endsWith("_path") ? 5 : id.endsWith("_url") ? 4 : 0;
  if (cut === 0 || id.length <= cut) return null;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    const lower = c >= 97 && c <= 122;
    const digit = c >= 48 && c <= 57;
    if (!(lower || c === 95 || (digit && i > 0))) return null;
  }
  return id.slice(0, -cut);
}
// Where a route call is a statement of its block (or of the file, for a
// file a route file draws).
const ROUTE_PARENTS = new Set(["program", "body_statement", "block_body", "then", "else", "if_modifier", "unless_modifier", "begin"]);
// The route calls read at the top of a file: Rails' mapper methods.
const ROUTE_DSL = new Set(["get", "post", "put", "patch", "delete", "match", "root", "resources", "resource", "namespace", "scope", "controller", "constraints", "defaults", "member", "collection", "shallow", "mount", "concern", "concerns", "draw", "direct", "resolve"]);

// The cheap text test: a Ruby file with none of these words has nothing a
// Rails rule reads and is skipped before its tree is walked. Plain
// substring searches, linear in the file.
const WANTS = ["class ", "module ", "draw", "describe", "ENV", "config", "perform_", "deliver_", "render", "get ", "get(", "post ", "post(", "put ", "patch ", "delete ", "visit", "_path", "_url", "_table", "add_", "remove_", "rename_", "change_"];
export function wantsRails(source: string): boolean {
  return WANTS.some((w) => source.includes(w));
}

const line = (n: Node) => n.startPosition.row + 1;
// 1-based, as the language facts give columns.
const col = (n: Node) => n.startPosition.column + 1;

// A string node's text when it holds no interpolation.
function stringValue(n: Node): string | null {
  if (n.type !== "string" && n.type !== "delimited_symbol" && n.type !== "bare_string" && n.type !== "bare_symbol") return null;
  let out = "";
  for (const c of n.namedChildren) {
    if (c.type === "string_content") out += c.text;
    else if (c.type === "escape_sequence") out += c.text;
    else return null;
  }
  return out;
}

// A string or symbol as a fact keeps it: bounded, key-shaped text redacted,
// null when it hides an encoded key (shared/kept.ts).
const kept = (v: string | null): string | null => (v === null ? null : keptText(v));

export function litOf(n: Node | null | undefined, depth = 0): Lit {
  if (!n) return { t: "dyn" };
  switch (n.type) {
    case "hash": {
      if (depth > 0) return { t: "dyn" };
      const v: Record<string, Lit> = {};
      for (const p of n.namedChildren) {
        if (p.type !== "pair") return { t: "dyn" };
        const k = p.childForFieldName("key");
        const key = k?.type === "hash_key_symbol" ? k.text : k?.type === "simple_symbol" ? k.text.slice(1) : null;
        if (key === null) return { t: "dyn" };
        v[key] = litOf(p.childForFieldName("value"), depth + 1);
      }
      return { t: "hash", v };
    }
    case "string": {
      const v = kept(stringValue(n));
      return v === null ? { t: "dyn" } : { t: "str", v };
    }
    case "simple_symbol": {
      const v = kept(n.text.slice(1));
      return v === null ? { t: "dyn" } : { t: "sym", v };
    }
    case "delimited_symbol": {
      const v = kept(stringValue(n));
      return v === null ? { t: "dyn" } : { t: "sym", v };
    }
    case "hash_key_symbol":
      return { t: "sym", v: n.text };
    case "constant":
    case "scope_resolution":
      return { t: "const", v: n.text };
    case "true":
      return { t: "bool", v: true };
    case "false":
      return { t: "bool", v: false };
    case "nil":
      return { t: "nil" };
    case "array":
    case "string_array":
    case "symbol_array": {
      const v: string[] = [];
      for (const c of n.namedChildren) {
        const x = litOf(c);
        if (x.t === "str" || x.t === "sym") v.push(x.v);
        else if (c.type === "bare_string" || c.type === "bare_symbol") {
          const s = kept(stringValue(c));
          if (s === null) return { t: "dyn" };
          v.push(s);
        } else return { t: "dyn" };
      }
      return { t: "list", v };
    }
    case "call": {
      if (n.childForFieldName("receiver")) return { t: "dyn" };
      const m = n.childForFieldName("method");
      return m ? { t: "call", v: m.text } : { t: "dyn" };
    }
    default:
      return { t: "dyn" };
  }
}

// The positional arguments, the symbol-keyed options and the first other
// pair of a call's argument list.
function argsOf(call: Node): { args: Node[]; opts: Map<string, Node>; pair: [Node, Node] | null } {
  const args: Node[] = [];
  const opts = new Map<string, Node>();
  let pair: [Node, Node] | null = null;
  const list = call.childForFieldName("arguments");
  const take = (p: Node) => {
    const k = p.childForFieldName("key");
    const v = p.childForFieldName("value");
    if (!k || !v) return;
    if (k.type === "hash_key_symbol") opts.set(k.text, v);
    else if (k.type === "simple_symbol") opts.set(k.text.slice(1), v);
    else if (pair === null) pair = [k, v];
  };
  for (const a of list?.namedChildren ?? []) {
    if (a.type === "pair") take(a);
    else if (a.type === "hash") {
      for (const p of a.namedChildren) if (p.type === "pair") take(p);
    }
    else if (a.type !== "comment" && a.type !== "block_argument") args.push(a);
  }
  return { args, opts, pair };
}

function symbolList(n: Node | undefined): string[] | null {
  if (!n) return null;
  const x = litOf(n);
  if (x.t === "sym" || x.t === "str") return [x.v];
  if (x.t === "list") return x.v;
  return null;
}

// The constant a call chain starts from, through `.set(...)` and
// `.with(...)`: `PublishJob` for `PublishJob.set(wait: 1)`.
function constantOf(n: Node | null): string | null {
  if (!n) return null;
  if (n.type === "constant" || n.type === "scope_resolution") return n.text;
  if (n.type === "call") {
    const m = n.childForFieldName("method")?.text;
    if (m === "set" || m === "with") return constantOf(n.childForFieldName("receiver"));
  }
  return null;
}

// The method names of a call chain after a root: for
// `Rails.application.config.x.y` from `config`, ["x", "y"]. A link that
// takes arguments ends the key below it (`config.x.fetch(:a)` reads "x").
// Null when the chain does not start at the root.
function chainFrom(n: Node, isRoot: (n: Node) => boolean): string[] | null {
  let names: string[] = [];
  let cur: Node | null = n;
  while (cur) {
    if (isRoot(cur)) return names.reverse();
    if (cur.type !== "call") return null;
    const m = cur.childForFieldName("method");
    if (!m || m.type !== "identifier") return null;
    if (cur.childForFieldName("arguments") || cur.childForFieldName("block")) names = [];
    else names.push(m.text);
    cur = cur.childForFieldName("receiver");
  }
  return null;
}

// `Rails.application.config` or `Rails.configuration`.
function isRailsConfig(n: Node): boolean {
  if (n.type !== "call") return false;
  const m = n.childForFieldName("method")?.text;
  const r = n.childForFieldName("receiver");
  if (!r) return false;
  if (m === "configuration") return r.text === "Rails" || r.text === "::Rails";
  if (m !== "config" || r.type !== "call") return false;
  return r.childForFieldName("method")?.text === "application" && (r.childForFieldName("receiver")?.text === "Rails" || r.childForFieldName("receiver")?.text === "::Rails");
}
// The bare `config` of an application class or a configure block.
const isBareConfig = (n: Node) => (n.type === "identifier" && n.text === "config") || (n.type === "call" && !n.childForFieldName("receiver") && !n.childForFieldName("arguments") && n.childForFieldName("method")?.text === "config");

const isEnv = (n: Node | null) => !!n && n.type === "constant" && n.text === "ENV";

type Scope = { locals: Set<string> };
// The most syntax nodes one create_table or change_table block is read for columns.
const MAX_COLUMN_NODES = 500;

export function railsFacts(root: Node): RailsFact[] {
  const out: RailsFact[] = [];
  const classes: { line: number; name: string; fact: ClassFact }[] = [];
  const scopes: Scope[] = [{ locals: new Set() }];
  // Every local name in any open scope, with how many scopes declare it:
  // one map lookup per identifier, however deep the nesting.
  const declared = new Map<string, number>();
  let methodDepth = 0;
  let draws = 0;
  const skip = new Set<number>();

  const cls = () => classes[classes.length - 1];
  const isLocal = (name: string) => (declared.get(name) ?? 0) > 0;
  const declare = (name: string) => {
    const top = scopes[scopes.length - 1] as Scope;
    if (top.locals.has(name)) return;
    top.locals.add(name);
    declared.set(name, (declared.get(name) ?? 0) + 1);
  };
  const popScope = () => {
    const top = scopes.pop();
    for (const name of top?.locals ?? []) declared.set(name, (declared.get(name) ?? 1) - 1);
  };
  const params = (n: Node) => {
    const p = n.childForFieldName("parameters") ?? n.namedChildren.find((c) => c.type === "block_parameters" || c.type === "lambda_parameters");
    for (const x of p?.namedChildren ?? []) {
      const id = x.type === "identifier" ? x : x.childForFieldName("name");
      if (id) declare(id.text);
    }
  };
  // Directly in a class body: not inside a method, a block or an argument.
  const inClassBody = (n: Node) => {
    const c = cls();
    if (!c || methodDepth > 0) return null;
    const p = n.parent;
    if (!p || p.type !== "body_statement") return null;
    const owner = p.parent;
    return owner && (owner.type === "class" || owner.type === "module") && line(owner) === c.line ? c : null;
  };

  // ---------- routes inside a draw block ----------
  const routeFacts: RouteFact[] = [];
  const walkRoutes = (n: Node, draw: number, parent: number, depth: number, nodeDepth: number) => {
    if (nodeDepth > MAX_NODE_DEPTH) {
      out.push({ kind: "route-cap", line: line(n), column: col(n), draw, parent, by: "syntax" });
      return;
    }
    if (n.type === "call" && !n.childForFieldName("receiver")) {
      const m = n.childForFieldName("method");
      const p = n.parent;
      // A route call: a bare call that is a statement of the block.
      if (m && m.type === "identifier" && p && ROUTE_PARENTS.has(p.type)) {
        const { args, opts, pair } = argsOf(n);
        const block = n.childForFieldName("block");
        const fact: RouteFact = {
          kind: "route",
          line: line(n),
          column: col(n),
          draw,
          parent,
          call: m.text,
          // `root "pages#home"` names a target; every other string argument is a path or a name.
          args: args.map((a) => (m.text === "root" ? targetLit(litOf(a)) : pathLit(litOf(a)))),
          opts: Object.fromEntries([...opts].filter(([k]) => ROUTE_OPTIONS.has(k)).map(([k, v]) => [k, optionLit(k, litOf(v))])),
          // `"/x" => "c#a"`, or `Engine => "/at"` for a mount.
          pair: pair ? [pathLit(litOf(pair[0])), m.text === "mount" ? pathLit(litOf(pair[1])) : targetLit(litOf(pair[1]))] : null,
          block: block !== null,
        };
        const index = routeFacts.length;
        routeFacts.push(fact);
        out.push(fact);
        if (block) {
          if (depth + 1 > MAX_ROUTE_DEPTH) out.push({ kind: "route-cap", line: line(block), column: col(block), draw, parent: index, by: "blocks" });
          else for (const c of block.namedChildren) walkRoutes(c, draw, index, depth + 1, nodeDepth + 1);
        }
        return;
      }
    }
    for (const c of n.namedChildren) walkRoutes(c, draw, parent, depth, nodeDepth + 1);
  };

  const onCall = (n: Node): false | void => {
    const m = n.childForFieldName("method");
    if (!m) return;
    const name = m.text;
    const recv = n.childForFieldName("receiver");
    // A draw block: its routes are read by walkRoutes, nothing else in it.
    if (name === "draw" && recv?.type === "call" && recv.childForFieldName("method")?.text === "routes") {
      const block = n.childForFieldName("block");
      const target = recv.childForFieldName("receiver");
      if (block && target) {
        const draw = draws++;
        out.push({ kind: "draw", line: line(n), column: col(n), receiver: target.text, endLine: n.endPosition.row + 1 });
        for (const c of block.namedChildren) walkRoutes(c, draw, -1, 0, 0);
        return false;
      }
    }
    if (!recv) {
      const here = inClassBody(n);
      if (here) {
        if (CALLBACKS.has(name)) {
          const { args, opts } = argsOf(n);
          const targets: string[] = [];
          let dynamic = false;
          for (const a of args) {
            const x = litOf(a);
            if (x.t === "sym" || x.t === "str") targets.push(x.v);
            else dynamic = true;
          }
          if (n.childForFieldName("block")) dynamic = true;
          out.push({ kind: "callback", line: line(n), column: col(n), cls: here.line, call: name, targets, dynamic, only: symbolList(opts.get("only")), except: symbolList(opts.get("except")) });
          return;
        }
        if (VISIBILITY.has(name)) {
          const { args } = argsOf(n);
          const names: string[] = [];
          for (const a of args) {
            if (a.type === "method") {
              const id = a.childForFieldName("name");
              if (id) names.push(id.text);
            } else {
              const x = litOf(a);
              if (x.t === "sym" || x.t === "str") names.push(x.v);
            }
          }
          out.push({ kind: "visibility", line: line(n), column: col(n), cls: here.line, value: name as "private", names: args.length === 0 ? null : names });
          return;
        }
        if (ASSOCIATIONS.has(name)) {
          const { args, opts } = argsOf(n);
          const first = litOf(args[0]);
          const cn = opts.get("class_name");
          const cnLit = cn ? litOf(cn) : null;
          const poly = opts.get("polymorphic");
          const word = (key: string) => {
            const x = litOf(opts.get(key));
            return x.t === "sym" || x.t === "str" ? x.v : null;
          };
          out.push({
            kind: "assoc",
            line: line(n),
            column: col(n),
            cls: here.line,
            macro: name,
            name: first.t === "sym" || first.t === "str" ? first.v : null,
            className: cnLit && (cnLit.t === "str" || cnLit.t === "sym" || cnLit.t === "const") ? cnLit.v : null,
            classNameDynamic: cnLit !== null && cnLit.t !== "str" && cnLit.t !== "sym" && cnLit.t !== "const",
            polymorphic: poly !== undefined && poly.type === "true",
            through: word("through"),
            source: word("source"),
            sourceType: word("source_type"),
          });
          return;
        }
        if (name === "include" || name === "extend" || name === "prepend") {
          for (const a of argsOf(n).args) if (a.type === "constant" || a.type === "scope_resolution") here.fact.includes.push(a.text);
          return;
        }
        if (name === "primary_abstract_class") {
          out.push({ kind: "abstract", line: line(n), column: col(n), cls: here.line });
          return;
        }
        if (name === "isolate_namespace") {
          const a = argsOf(n).args[0];
          out.push({ kind: "isolate", line: line(n), column: col(n), cls: here.line, name: a && (a.type === "constant" || a.type === "scope_resolution") ? a.text : null });
          return;
        }
      }
      if (name === "render") {
        const { args, opts } = argsOf(n);
        let fact: RenderFact | null = null;
        const value = (x: Lit) => (x.t === "str" || x.t === "sym" ? x.v : null);
        if (opts.has("partial")) fact = { kind: "render", line: line(n), column: col(n), mode: "partial", value: value(litOf(opts.get("partial"))) };
        else if (opts.has("template")) fact = { kind: "render", line: line(n), column: col(n), mode: "template", value: value(litOf(opts.get("template"))) };
        else if (opts.has("action")) fact = { kind: "render", line: line(n), column: col(n), mode: "action", value: value(litOf(opts.get("action"))) };
        else if (args[0]?.type === "call" && args[0].childForFieldName("method")?.text === "new" && (args[0].childForFieldName("receiver")?.type === "constant" || args[0].childForFieldName("receiver")?.type === "scope_resolution")) {
          fact = { kind: "render", line: line(n), column: col(n), mode: "component", value: args[0].childForFieldName("receiver")?.text ?? null };
        } else if (args[0]) {
          const x = litOf(args[0]);
          fact = { kind: "render", line: line(n), column: col(n), mode: x.t === "sym" ? "action" : "name", value: value(x) };
        } else if (opts.size > 0) fact = { kind: "render", line: line(n), column: col(n), mode: "other", value: null };
        if (fact) out.push(fact);
        return;
      }
      if (MIGRATION_OPS.has(name)) {
        const { args, opts } = argsOf(n);
        const lit = (a: Node | undefined) => {
          const x = litOf(a);
          return x.t === "str" || x.t === "sym" ? x.v : null;
        };
        let table = lit(args[0]);
        let to: string | null = null;
        let field: string | null = null;
        if (name === "create_join_table" || name === "drop_join_table") {
          const a = lit(args[0]);
          const b = lit(args[1]);
          const given = opts.get("table_name");
          table = given ? lit(given) : a !== null && b !== null ? [a, b].sort().join("_") : null;
        } else if (name === "rename_table") to = lit(args[1]);
        else if (name === "rename_column") {
          field = lit(args[1]);
          to = lit(args[2]);
        } else if (name === "add_foreign_key" || name === "remove_foreign_key") to = lit(args[1]);
        else if (args[1]) field = lit(args[1]);
        const columns: string[] = [];
        const block = n.childForFieldName("block");
        if (block && (name === "create_table" || name === "change_table")) {
          const stack: Node[] = [block];
          let seen = 0;
          while (stack.length > 0 && seen++ < MAX_COLUMN_NODES) {
            const x = stack.pop() as Node;
            if (x.type === "call" && x.childForFieldName("receiver")?.type === "identifier") {
              const first = argsOf(x).args[0];
              const c = lit(first);
              if (c !== null) columns.push(c);
            }
            for (const c of x.namedChildren) stack.push(c);
          }
          columns.reverse();
        }
        out.push({ kind: "migration-op", line: line(n), column: col(n), op: name, table, field, to, columns });
        return;
      }
      if (REQUEST_VERBS.has(name) && methodDepthOk(n)) {
        const first = argsOf(n).args[0];
        if (first) {
          const helper = (first.type === "identifier" || (first.type === "call" && !first.childForFieldName("receiver"))) && helperName(first.type === "identifier" ? first.text : (first.childForFieldName("method")?.text ?? "")) !== null;
          if (!helper) out.push({ kind: "request", line: line(n), column: col(n), verb: name === "visit" ? "GET" : name.toUpperCase(), path: pathLit(litOf(first)) });
        }
      }
      if (name === "describe" || name === "context") {
        describeFact(n);
      }
      if (helperName(name) !== null) routeName(n, name);
      return;
    }
    // Calls with a receiver.
    if (name === "describe" && (recv.text === "RSpec" || recv.text === "::RSpec")) {
      describeFact(n);
      return;
    }
    if (ENQUEUES.has(name)) {
      const target = constantOf(recv);
      if (target) out.push({ kind: "enqueue", line: line(n), column: col(n), target, via: name });
      return;
    }
    if (DELIVERIES.has(name) && recv.type === "call") {
      const action = recv.childForFieldName("method")?.text;
      const target = constantOf(recv.childForFieldName("receiver"));
      if (action && target) out.push({ kind: "mail", line: line(n), column: col(n), target, action, via: name });
      return;
    }
    if (name === "fetch" && isEnv(recv)) {
      const x = litOf(argsOf(n).args[0]);
      out.push({ kind: "config-read", line: line(n), column: col(n), source: "env", key: x.t === "str" || x.t === "sym" ? x.v : null });
      return;
    }
    // The outermost link of a `Rails.application.config...` chain.
    const parent = n.parent;
    if (parent?.type === "call" && parent.childForFieldName("receiver")?.id === n.id) return;
    const keys = chainFrom(n, isRailsConfig);
    if (keys && keys.length > 0) out.push({ kind: "config-read", line: line(n), column: col(n), source: "rails", key: keys.join(".") });
  };

  // A request verb outside a class body: inside a test block or method.
  function methodDepthOk(n: Node): boolean {
    return inClassBody(n) === null;
  }

  function describeFact(n: Node) {
    const { args, opts } = argsOf(n);
    const first = args[0];
    if (!first || (first.type !== "constant" && first.type !== "scope_resolution")) return;
    const type = opts.get("type");
    const t = type ? litOf(type) : null;
    out.push({ kind: "describe", line: line(n), column: col(n), subject: first.text, type: t && (t.t === "sym" || t.t === "str") ? t.v : null, endLine: n.endPosition.row + 1 });
  }

  function routeName(n: Node, name: string) {
    const route = helperName(name);
    if (route === null) return;
    let verb: string | null = null;
    const list = n.parent;
    const call = list?.parent;
    if (list?.type === "argument_list" && call?.type === "call" && !call.childForFieldName("receiver") && list.namedChildren[0]?.id === n.id) {
      const v = call.childForFieldName("method")?.text ?? "";
      if (REQUEST_VERBS.has(v)) verb = v === "visit" ? "GET" : v.toUpperCase();
    }
    out.push({ kind: "route-name", line: line(n), column: col(n), name: route, verb });
  }

  const enter = (n: Node): false | (() => void) | void => {
    if (skip.has(n.id)) return false;
    switch (n.type) {
      case "program": {
        // Route calls at the top of the file: a route file may draw it.
        for (const c of n.namedChildren) {
          if (c.type !== "call" || c.childForFieldName("receiver")) continue;
          const m = c.childForFieldName("method");
          if (m && ROUTE_DSL.has(m.text)) walkRoutes(c, -1, -1, 0, 0);
        }
        return;
      }
      case "class":
      case "module": {
        const nameNode = n.childForFieldName("name");
        if (!nameNode) return;
        const outer = cls()?.name ?? null;
        const raw = nameNode.text;
        const full = raw.startsWith("::") ? raw.slice(2) : outer ? `${outer}::${raw}` : raw;
        let base: string | null = null;
        const sup = n.childForFieldName("superclass")?.firstNamedChild;
        if (sup?.type === "constant" || sup?.type === "scope_resolution") base = sup.text;
        else if (sup?.type === "element_reference") {
          const obj = sup.childForFieldName("object");
          if (obj && (obj.type === "constant" || obj.type === "scope_resolution")) base = obj.text;
        }
        const fact: ClassFact = { kind: "class", line: line(n), column: col(n), name: full, module: n.type === "module", base, includes: [], endLine: n.endPosition.row + 1 };
        out.push(fact);
        classes.push({ line: fact.line, name: full, fact });
        const savedDepth = methodDepth;
        methodDepth = 0;
        return () => {
          classes.pop();
          methodDepth = savedDepth;
        };
      }
      case "method":
      case "singleton_method": {
        methodDepth++;
        scopes.push({ locals: new Set() });
        params(n);
        return () => {
          methodDepth--;
          popScope();
        };
      }
      case "block":
      case "do_block":
      case "lambda": {
        scopes.push({ locals: new Set() });
        params(n);
        return () => {
          popScope();
        };
      }
      case "assignment":
      case "operator_assignment": {
        const left = n.childForFieldName("left");
        if (!left) return;
        if (left.type === "identifier") {
          declare(left.text);
          return;
        }
        if (left.type === "call") {
          const m = left.childForFieldName("method")?.text;
          const r = left.childForFieldName("receiver");
          const here = inClassBody(n);
          if (here && r?.type === "self" && m === "table_name") {
            const x = litOf(n.childForFieldName("right"));
            out.push({ kind: "table-name", line: line(n), column: col(n), cls: here.line, value: x.t === "str" || x.t === "sym" ? x.v : null });
            skip.add(left.id);
            return;
          }
          if (here && r?.type === "self" && m === "abstract_class") {
            if (n.childForFieldName("right")?.type === "true") out.push({ kind: "abstract", line: line(n), column: col(n), cls: here.line });
            skip.add(left.id);
            return;
          }
          const keys = chainFrom(left, (x) => isBareConfig(x) || isRailsConfig(x));
          if (keys && keys.length > 0) {
            out.push({ kind: "config-define", line: line(n), column: col(n), key: keys.join(".") });
            skip.add(left.id);
          }
          return;
        }
        // `ENV["X"] = ...` writes an entry; it is not a read.
        if (left.type === "element_reference" && isEnv(left.childForFieldName("object"))) skip.add(left.id);
        return;
      }
      case "call":
        return onCall(n);
      case "element_reference": {
        if (!isEnv(n.childForFieldName("object"))) return;
        const key = n.namedChildren.find((c) => c.id !== n.childForFieldName("object")?.id);
        const x = litOf(key);
        out.push({ kind: "config-read", line: line(n), column: col(n), source: "env", key: x.t === "str" || x.t === "sym" ? x.v : null });
        return;
      }
      case "identifier": {
        const p = n.parent;
        if (!p) return;
        if (n.text === "primary_abstract_class") {
          const here = inClassBody(n);
          if (here) out.push({ kind: "abstract", line: line(n), column: col(n), cls: here.line });
          return;
        }
        // `private` alone in a class body.
        if (VISIBILITY.has(n.text)) {
          const here = inClassBody(n);
          if (here) out.push({ kind: "visibility", line: line(n), column: col(n), cls: here.line, value: n.text as "private", names: null });
          return;
        }
        if (helperName(n.text) === null || isLocal(n.text)) return;
        // A value position only: never a method name, a parameter or an assignment target.
        if (p.type === "call" || p.type === "method" || p.type === "singleton_method" || p.type.endsWith("parameters") || p.type === "assignment" && p.childForFieldName("left")?.id === n.id) return;
        routeName(n, n.text);
        return;
      }
    }
  };

  walkNode(root, enter);
  return out;
}

// Walks a tree depth first with a cursor (no recursion), calling `enter`
// on each named node; `false` skips the node's children and a returned
// function runs when the walk leaves the node.
function walkNode(root: Node, enter: (n: Node) => false | (() => void) | void): void {
  const cursor = root.walk();
  const leaves: { depth: number; fn: () => void }[] = [];
  let depth = 0;
  for (;;) {
    let descend = true;
    const node = cursor.currentNode;
    if (node.isNamed) {
      const r = enter(node);
      if (r === false) descend = false;
      else if (typeof r === "function") leaves.push({ depth, fn: r });
    }
    if (descend && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    for (;;) {
      while (leaves.length > 0 && (leaves[leaves.length - 1] as { depth: number }).depth === depth) (leaves.pop() as { fn: () => void }).fn();
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) {
        cursor.delete();
        return;
      }
      depth--;
    }
  }
}

// ---------- the shape check for cached facts ----------

const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isStrList = (v: unknown) => Array.isArray(v) && v.every(isStr);
const isStrListOrNull = (v: unknown) => v === null || isStrList(v);

function isLit(v: unknown): v is Lit {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  switch (r.t) {
    case "str":
    case "sym":
    case "const":
    case "call":
      return isStr(r.v);
    case "list":
      return isStrList(r.v);
    case "hash":
      return typeof r.v === "object" && r.v !== null && !Array.isArray(r.v) && Object.values(r.v).every((x) => isLit(x) && (x as Lit).t !== "hash");
    case "bool":
      return typeof r.v === "boolean";
    case "nil":
    case "dyn":
      return true;
    default:
      return false;
  }
}

export function isRailsFact(v: unknown): v is RailsFact {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (!isStr(r.kind) || !isInt(r.line) || (r.line as number) < 1 || !isInt(r.column)) return false;
  switch (r.kind) {
    case "draw":
      return isStr(r.receiver) && isInt(r.endLine);
    case "route":
      return (
        isInt(r.draw) &&
        isInt(r.parent) &&
        isStr(r.call) &&
        Array.isArray(r.args) &&
        r.args.every(isLit) &&
        typeof r.opts === "object" &&
        r.opts !== null &&
        !Array.isArray(r.opts) &&
        Object.values(r.opts).every(isLit) &&
        (r.pair === null || (Array.isArray(r.pair) && r.pair.length === 2 && r.pair.every(isLit))) &&
        typeof r.block === "boolean"
      );
    case "route-cap":
      return isInt(r.draw) && isInt(r.parent) && (r.by === "blocks" || r.by === "syntax");
    case "class":
      return isStr(r.name) && typeof r.module === "boolean" && isStrOrNull(r.base) && isStrList(r.includes) && isInt(r.endLine);
    case "callback":
      return isInt(r.cls) && isStr(r.call) && isStrList(r.targets) && typeof r.dynamic === "boolean" && isStrListOrNull(r.only) && isStrListOrNull(r.except);
    case "visibility":
      return isInt(r.cls) && (r.value === "private" || r.value === "protected" || r.value === "public") && isStrListOrNull(r.names);
    case "assoc":
      return isInt(r.cls) && isStr(r.macro) && isStrOrNull(r.name) && isStrOrNull(r.className) && typeof r.classNameDynamic === "boolean" && typeof r.polymorphic === "boolean" && isStrOrNull(r.through) && isStrOrNull(r.source) && isStrOrNull(r.sourceType);
    case "table-name":
      return isInt(r.cls) && isStrOrNull(r.value);
    case "abstract":
      return isInt(r.cls);
    case "isolate":
      return isInt(r.cls) && isStrOrNull(r.name);
    case "render":
      return (r.mode === "name" || r.mode === "template" || r.mode === "action" || r.mode === "partial" || r.mode === "component" || r.mode === "other") && isStrOrNull(r.value);
    case "migration-op":
      return isStr(r.op) && isStrOrNull(r.table) && isStrOrNull(r.field) && isStrOrNull(r.to) && isStrList(r.columns);
    case "enqueue":
      return isStr(r.target) && isStr(r.via);
    case "mail":
      return isStr(r.target) && isStr(r.action) && isStr(r.via);
    case "config-read":
      return (r.source === "rails" || r.source === "env") && isStrOrNull(r.key);
    case "config-define":
      return isStr(r.key);
    case "describe":
      return isStr(r.subject) && isStrOrNull(r.type) && isInt(r.endLine);
    case "request":
      return isStr(r.verb) && isLit(r.path);
    case "route-name":
      return isStr(r.name) && isStrOrNull(r.verb);
    default:
      return false;
  }
}
