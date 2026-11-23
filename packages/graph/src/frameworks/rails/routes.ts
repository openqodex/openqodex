// Expands the route facts of every `routes.draw` block into registration
// drafts, before any handler is looked up (PLAN.md decision 55): `resources`
// and `resource` expand from the declaration and its `only:` and `except:`
// options to their seven (singular: six) registrations, so a registration
// whose action is later deleted is still listed. Prefixes, name prefixes
// and controller modules compose through `namespace`, `scope`,
// `controller`, nested resources, `member` and `collection` blocks, with
// Rails' own naming rules (ActionDispatch::Routing::Mapper).
//
// Literal only: a computed path, option or name becomes a gap with cause
// "dynamic", and the registration keeps `pattern: null`. Every cap stops
// with a gap: route blocks nested deeper than eight levels, more than
// MAX_REGISTRATIONS registrations in one application, and the work budget.
import type { Cause } from "../../model/records.js";
import type { FrameworkEdgeKind, Site } from "../plugin.js";
import type { Lit, RailsFact, RouteFact } from "./facts.js";
import { MAX_NODE_DEPTH } from "./facts.js";
import { MAX_NAME, pluralize, singularize, underscore } from "./inflect.js";
import type { App, RailsWorld } from "./world.js";
import { relTo, under } from "./world.js";

export const MAX_REGISTRATIONS = 10_000;
// How many route files deep `draw(:name)` is followed.
export const MAX_DRAW_DEPTH = 8;

// A count of work units; when it runs out the step that drew on it stops
// and says so once.
export class Budget {
  spent = false;
  constructor(public left: number) {}
  take(n = 1): boolean {
    if (this.left < n) {
      this.left = 0;
      this.spent = true;
      return false;
    }
    this.left -= n;
    return true;
  }
}

export type HandlerSpec =
  | { kind: "action"; controller: string; action: string } // controller path with its module: "admin/posts"
  | { kind: "mount"; target: string } // a constant: an engine or a Rack application
  | { kind: "rack"; target: string } // `to: SomeRackApp`
  | { kind: "redirect" }
  | { kind: "dynamic"; note: string }
  | { kind: "unresolved"; note: string };

export type Draft = {
  app: App | null;
  file: string; // the routes file
  site: Site;
  ordinal: number; // the position among the registrations of one route call
  methods: string[];
  pattern: string | null;
  written: string | null;
  name: string | null;
  handler: HandlerSpec;
  handlerWritten: string;
  action: string | null; // the resource action ("show") or null
  // When the pattern is computed: the pattern with each computed part
  // shown as "{computed}", for display only; null when nothing is known.
  partial: string | null;
};

const COMPUTED = "{computed}";
// A display pattern worth showing: one that knows more than a computed part.
const partialOf = (p: string | null) => (p === null || p === `/${COMPUTED}` ? null : p);

export type RouteGap = { site: Site; scope: { file: string } | { app: string }; cause: Cause; affects: FrameworkEdgeKind[]; name: string | null; note: string };

type Res = {
  controller: string;
  collectionName: string;
  memberName: string;
  collectionPath: string;
  memberPath: string;
  shownCollection: string; // the paths with computed parts shown as {computed}
  shownMember: string;
  outerAs: string | null;
  memberAs: string | null;
};

type Level = "default" | "nested" | "member" | "collection" | "new";

type Scope = {
  path: string;
  shown: string; // the path with each computed part shown as {computed}
  module: string | null;
  as: string | null;
  controller: string | null; // as written, before the module is applied
  action: string | null; // a scope's or defaults' action, for every route inside
  shallowPath: string;
  shallowPrefix: string | null;
  shallow: boolean;
  level: Level;
  res: Res | null;
  dynamic: string | null; // why the composed prefix is computed
  // Why the controller of the routes inside is not known: a computed
  // module, controller or action. A route there gets no handler by guess.
  handlerUnknown: string | null;
};

const VERBS = new Set(["get", "post", "put", "patch", "delete", "match", "root"]);
const TRANSPARENT = new Set(["constraints", "defaults"]);
const HELPER_ONLY = new Set(["direct", "resolve"]);
const PLURAL_ACTIONS = ["index", "create", "new", "edit", "show", "update", "destroy"];
const SINGULAR_ACTIONS = ["create", "new", "edit", "show", "update", "destroy"];

// "/a//b/" to "/a/b"; "" to "/".
export function normalizePath(p: string): string {
  const parts = p.split("/").filter((x) => x !== "");
  return `/${parts.join("/")}`;
}
const joinPath = (a: string, b: string) => normalizePath(`${a}/${b}`);
const joinModule = (a: string | null, b: string) => (a ? `${a}/${b}` : b);
const joinName = (...parts: (string | null | undefined)[]) => {
  const kept = parts.filter((x): x is string => typeof x === "string" && x !== "");
  return kept.length > 0 ? kept.join("_") : null;
};
// Rails' name normalisation: "-" to "_", no leading "/", "/" to "_".
const normName = (s: string) => {
  let out = "";
  for (const c of s) out += c === "-" || c === "/" ? "_" : c;
  return out.startsWith("_") && s.startsWith("/") ? out.slice(1) : out;
};
const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
// `[\w\-/]+`, by hand.
const isWordPath = (s: string) => {
  if (s.length === 0 || s.length > 256) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(isWordChar(c) || c === 45 || c === 47)) return false;
  }
  return true;
};
// Rails' match shorthand `get "photos/search"` (photos#search): a word path
// with a slash after its first segment.
const shorthand = (s: string): { controller: string; action: string } | null => {
  const t = s.startsWith("/") ? s.slice(1) : s;
  if (!isWordPath(t)) return null;
  const cut = t.lastIndexOf("/");
  if (cut <= 0 || cut === t.length - 1) return null;
  return { controller: t.slice(0, cut), action: t.slice(cut + 1).split("-").join("_") };
};
const text = (l: Lit | undefined): string | null => (l && (l.t === "str" || l.t === "sym") ? l.v : null);
// A value the plugin cannot read: computed, a constant or a call.
const isDyn = (l: Lit | undefined) => l !== undefined && (l.t === "dyn" || l.t === "const" || l.t === "call");
const listOf = (l: Lit | undefined): string[] | null => (l === undefined ? null : l.t === "list" ? l.v : l.t === "str" || l.t === "sym" ? [l.v] : null);
// A key of a `defaults:` hash: `defaults: { controller: "pages" }`.
const fromHash = (l: Lit | undefined, key: string): string | null => (l?.t === "hash" ? text(l.v[key]) : null);

// Whether a file is a route table of the application: its config/routes.rb
// or a file under its config/routes/. A draw block anywhere else (a test
// that redraws the routes in its setup) is not the application's routes.
function isRouteTable(app: App | null, file: string): boolean {
  if (app) {
    const rel = relTo(app.root, file);
    return rel !== null && (rel === "config/routes.rb" || rel.startsWith("config/routes/"));
  }
  return file === "config/routes.rb" || file.endsWith("/config/routes.rb") || file.startsWith("config/routes/") || file.includes("/config/routes/");
}

export type Expansion = { drafts: Draft[]; gaps: RouteGap[]; tables: { file: string; site: Site; app: App }[] };

// The application a draw block belongs to: `Rails.application` (or
// `<Name>::Application`) to the application whose root holds the file;
// `<Name>::Engine` to the engine of that name. Null when neither.
function drawApp(world: RailsWorld, receiver: string, file: string): App | null {
  const r = receiver.startsWith("::") ? receiver.slice(2) : receiver;
  if (r === "Rails.application" || r.endsWith("::Application")) {
    let best: App | null = null;
    for (const a of world.apps) {
      if (a.kind !== "application") continue;
      if (a.root !== "" && !file.startsWith(`${a.root}/`)) continue;
      if (!best || a.root.length > best.root.length) best = a;
    }
    return best;
  }
  return world.apps.find((a) => a.kind === "engine" && a.className === r) ?? null;
}

export function expandRoutes(world: RailsWorld, budget: Budget): Expansion {
  const out: Expansion = { drafts: [], gaps: [], tables: [] };
  const counts = new Map<string, number>();
  const capped = new Set<string>();
  const used = new Map<string, Set<string>>(); // app to the route names taken
  let budgetGap = false;

  // The route calls of a file by draw block and parent, built once per file
  // that is read as a route table; its depth caps are named as gaps then.
  type FileCtx = { file: string; childrenOf: Map<string, RouteFact[]>; indexOf: Map<RouteFact, number> };
  const contexts = new Map<string, FileCtx>();
  const fileCtx = (file: string): FileCtx => {
    const kept = contexts.get(file);
    if (kept) return kept;
    const facts = world.facts(file);
    const ctx: FileCtx = { file, childrenOf: new Map(), indexOf: new Map() };
    const routes = facts.filter((f): f is RouteFact => f.kind === "route");
    routes.forEach((r, i) => {
      ctx.indexOf.set(r, i);
      // A parent index that does not point back is a damaged cache: the fact is left out.
      if (r.parent >= i) return;
      const k = `${r.draw}:${r.parent}`;
      (ctx.childrenOf.get(k) ?? ctx.childrenOf.set(k, []).get(k))?.push(r);
    });
    for (const cap of facts) {
      if (cap.kind !== "route-cap") continue;
      const note = cap.by === "syntax" ? `route calls nested more than ${MAX_NODE_DEPTH} syntax levels deep are not read` : "route blocks nested deeper than eight levels are not read";
      out.gaps.push({ site: { file, line: cap.line, column: cap.column }, scope: { file }, cause: "fan-out-capped", affects: ["handles"], name: null, note });
    }
    contexts.set(file, ctx);
    return ctx;
  };

  for (const file of world.index.factFiles()) {
    const draws = world.facts(file).filter((f) => f.kind === "draw");
    if (draws.length === 0) continue;
    let refused = false;
    draws.forEach((d, drawIndex) => {
      if (d.kind !== "draw") return;
      const app = drawApp(world, d.receiver, file);
      if (!isRouteTable(app, file)) {
        if (!refused) out.gaps.push({ site: { file, line: d.line, column: d.column }, scope: { file }, cause: "unsupported-rule", affects: ["handles"], name: null, note: "a routes draw block outside config/routes.rb and config/routes/ is not read as the application's routes" });
        refused = true;
        return;
      }
      if (app) out.tables.push({ file, site: { file, line: d.line, column: d.column }, app });
      const key = app?.id ?? "-";
      if (!used.has(key)) used.set(key, new Set());
      const taken = used.get(key) as Set<string>;
      // The file being walked: the draw block's own, or a file it draws.
      let cur = { ctx: fileCtx(file), draw: drawIndex, depth: 0 };
      const children = { get: (parent: number) => cur.ctx.childrenOf.get(`${cur.draw}:${parent}`) };
      const site = (f: RailsFact): Site => ({ file: cur.ctx.file, line: f.line, column: f.column });
      const gap = (f: RailsFact, cause: Cause, note: string, name: string | null = null, affects: FrameworkEdgeKind[] = ["handles"]) => out.gaps.push({ site: site(f), scope: { file: cur.ctx.file }, cause, affects, name, note });

      let ordinal = 0;
      const emit = (f: RouteFact, d: Omit<Draft, "app" | "file" | "site" | "ordinal">): void => {
        if (!budget.take()) {
          if (!budgetGap) gap(f, "budget", "the route expansion ran out of its work budget; later routes are not listed");
          budgetGap = true;
          return;
        }
        const n = counts.get(key) ?? 0;
        if (n >= MAX_REGISTRATIONS) {
          if (!capped.has(key)) gap(f, "fan-out-capped", `the application has more than ${MAX_REGISTRATIONS.toLocaleString("en-US")} route registrations; later ones are not listed`);
          capped.add(key);
          return;
        }
        counts.set(key, n + 1);
        out.drafts.push({ app, file: cur.ctx.file, site: site(f), ordinal: ordinal++, ...d });
      };
      // A name Rails would give the route: an explicit `as:` always; a
      // derived one only when it is valid and not taken.
      const nameOf = (candidate: string | null, explicit: boolean): string | null => {
        if (candidate === null) return null;
        if (explicit) {
          taken.add(candidate);
          return candidate;
        }
        const first = candidate.charCodeAt(0);
        if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95) || taken.has(candidate)) return null;
        taken.add(candidate);
        return candidate;
      };

      const walk = (list: readonly RouteFact[] | undefined, S: Scope): void => {
        for (const f of list ?? []) {
          if (budget.spent) return;
          ordinal = 0;
          const kids = children.get(cur.ctx.indexOf.get(f) as number);
          call(f, S, kids);
        }
      };

      const call = (f: RouteFact, S: Scope, kids: RouteFact[] | undefined): void => {
        const o = f.opts;
        switch (f.call) {
          case "namespace": {
            const name = text(f.args[0]);
            const dyn = name === null ? "the namespace name is computed" : null;
            if (dyn) gap(f, "dynamic", "a computed namespace name: the routes in it have no known path");
            const nsPath = text(o.path) ?? name ?? "";
            const nsAs = o.as !== undefined ? text(o.as) : name;
            const nsModule = text(o.module) ?? name;
            walk(kids, {
              ...S,
              path: joinPath(S.path, nsPath),
              shown: joinPath(S.shown, text(o.path) ?? name ?? COMPUTED),
              module: nsModule ? joinModule(S.module, nsModule) : S.module,
              as: joinName(S.as, nsAs),
              shallowPath: joinPath(S.shallowPath, text(o.shallow_path) ?? nsPath),
              shallowPrefix: joinName(S.shallowPrefix, text(o.shallow_prefix) ?? nsAs),
              level: "default",
              res: null,
              dynamic: S.dynamic ?? dyn ?? (isDyn(o.path) ? "a namespace option is computed" : null),
              handlerUnknown: S.handlerUnknown ?? (name === null || isDyn(o.module) ? "the namespace's module is computed, so the controllers of its routes are not known" : null),
            });
            return;
          }
          case "scope": {
            let path = "";
            let shown = "";
            let dyn: string | null = null;
            for (const a of [...f.args, ...(o.path !== undefined ? [o.path] : [])]) {
              const t = text(a);
              if (t === null) dyn = "the scope path is computed";
              path = t === null ? path : `${path}/${t}`;
              shown = `${shown}/${t ?? COMPUTED}`;
            }
            const hidden = isDyn(o.module) || isDyn(o.controller) || isDyn(o.action) ? "a scope's module, controller or action is computed, so the controllers of its routes are not known" : null;
            if (dyn) gap(f, "dynamic", `a computed scope: ${dyn}`);
            if (hidden) gap(f, "dynamic", hidden);
            const mod = text(o.module);
            walk(kids, {
              ...S,
              path: joinPath(S.path, path),
              shown: joinPath(S.shown, shown),
              module: mod ? joinModule(S.module, mod) : S.module,
              as: joinName(S.as, text(o.as)),
              controller: text(o.controller) ?? fromHash(o.defaults, "controller") ?? S.controller,
              action: text(o.action) ?? fromHash(o.defaults, "action") ?? S.action,
              shallowPath: text(o.shallow_path) ? joinPath(S.shallowPath, text(o.shallow_path) as string) : S.shallowPath,
              shallowPrefix: joinName(S.shallowPrefix, text(o.shallow_prefix)),
              shallow: o.shallow?.t === "bool" ? o.shallow.v : S.shallow,
              dynamic: S.dynamic ?? dyn,
              handlerUnknown: S.handlerUnknown ?? hidden,
            });
            return;
          }
          case "controller": {
            const c = text(f.args[0]);
            if (c === null) gap(f, "dynamic", "a computed controller name: the routes in it have no known handler");
            walk(kids, { ...S, controller: c ?? S.controller, handlerUnknown: S.handlerUnknown ?? (c === null ? "the controller name is computed" : null) });
            return;
          }
          case "shallow":
            walk(kids, { ...S, shallow: true });
            return;
          case "member":
          case "collection": {
            if (!S.res) {
              gap(f, "unsupported-rule", `${f.call} outside a resources block is not read`);
              return;
            }
            walk(kids, { ...S, level: f.call, path: f.call === "member" ? S.res.memberPath : S.res.collectionPath, shown: f.call === "member" ? S.res.shownMember : S.res.shownCollection, as: S.res.outerAs });
            return;
          }
          case "resources":
          case "resource":
            resources(f, S, kids);
            return;
          case "mount":
            mount(f, S);
            return;
          default:
            if (VERBS.has(f.call)) {
              verb(f, S);
              return;
            }
            if (f.call === "defaults") {
              walk(kids, { ...S, controller: text(o.controller) ?? S.controller, action: text(o.action) ?? S.action });
              return;
            }
            if (TRANSPARENT.has(f.call)) {
              walk(kids, S);
              return;
            }
            if (f.call === "draw") {
              drawFile(f, S);
              return;
            }
            if (HELPER_ONLY.has(f.call)) return;
            gap(f, "unsupported-rule", `\`${f.call}\` in a routes block adds routes the plugin does not expand`, f.call);
        }
      };

      const verb = (f: RouteFact, S: Scope): void => {
        const o = f.opts;
        const root = f.call === "root";
        const paths: { lit: Lit; to: Lit | undefined }[] = [];
        if (root) paths.push({ lit: { t: "str", v: "/" }, to: f.args[0] ?? o.to });
        else {
          for (const a of f.args) {
            if (a.t === "list") for (const v of a.v) paths.push({ lit: { t: "str", v }, to: o.to });
            else paths.push({ lit: a, to: o.to });
          }
          if (f.pair) paths.push({ lit: f.pair[0], to: f.pair[1] });
        }
        if (paths.length === 0) {
          gap(f, "unsupported-rule", `\`${f.call}\` with no path is not read`, f.call);
          return;
        }
        for (const p of paths) {
          const on = text(o.on) as Level | null;
          const level: Level = on === "member" || on === "collection" || on === "new" ? on : S.level;
          if ((level === "member" || level === "collection" || level === "new") && !S.res) {
            gap(f, "unsupported-rule", `a route on ${level} outside a resources block is not read`);
            continue;
          }
          const res = S.res;
          let base = S.path;
          if (level !== S.level && res) base = level === "member" ? res.memberPath : level === "collection" ? res.collectionPath : joinPath(res.collectionPath, "new");
          let local: string | null = null;
          let defaultAction: string | null = null;
          let prefix: string | null = null;
          if (p.lit.t === "sym") {
            local = text(o.path) ?? p.lit.v;
            defaultAction = p.lit.v;
            prefix = normName(p.lit.v);
          } else if (p.lit.t === "str") {
            local = p.lit.v;
            if (isWordPath(p.lit.v)) {
              prefix = normName(p.lit.v);
              if (!p.lit.v.includes("/")) defaultAction = p.lit.v.split("-").join("_");
            }
          }
          if (root) {
            prefix = "root";
            defaultAction = null;
          }
          const dyn = S.dynamic ?? (local === null ? "the route path is computed" : null);
          if (local === null) gap(f, "dynamic", "a computed route path: the registration has no known pattern", null, ["tests"]);
          // The name: `as:` when given (nil or false: none), else derived.
          let explicit = false;
          if (o.as !== undefined) {
            if (o.as.t === "nil" || (o.as.t === "bool" && !o.as.v)) prefix = null;
            else if (text(o.as) !== null) {
              prefix = normName(text(o.as) as string);
              explicit = true;
            } else {
              prefix = null;
              gap(f, "dynamic", "a computed route name", null, ["tests"]);
            }
          }
          let parts: (string | null)[];
          if (level === "nested") parts = [S.as, prefix];
          else if (level === "collection" && res) parts = [prefix, res.outerAs, res.collectionName];
          else if (level === "member" && res) parts = [prefix, res.memberAs, res.memberName];
          else if (level === "new" && res) parts = [prefix, "new", res.outerAs, res.memberName];
          else parts = [S.as, prefix];
          // No derived name without a word to derive it from.
          const name = prefix === null ? null : nameOf(joinName(...parts), explicit);
          // The methods.
          let methods: string[];
          if (root) methods = ["GET"];
          else if (f.call !== "match") methods = [f.call.toUpperCase()];
          else {
            const via = listOf(o.via);
            methods = via === null || via.includes("all") ? ["*"] : via.map((v) => v.toUpperCase());
            if (isDyn(o.via)) gap(f, "dynamic", "computed route methods: the registration takes any method here", null, ["tests"]);
          }
          const handler = guarded(handlerOf(p.to, o, S, res, level, defaultAction, p.lit), S);
          emit(f, {
            methods,
            pattern: dyn !== null || local === null ? null : root ? normalizePath(S.path) : joinPath(base, local),
            partial: dyn === null && local !== null ? null : level !== S.level ? null : partialOf(root ? normalizePath(S.shown) : joinPath(S.shown, local ?? COMPUTED)),
            written: local === null ? null : root ? "/" : local,
            name,
            handler,
            handlerWritten: written(handler),
            action: null,
          });
        }
      };

      const handlerOf = (to: Lit | undefined, o: Record<string, Lit>, S: Scope, res: Res | null, level: Level, defaultAction: string | null, path: Lit): HandlerSpec => {
        const qualify = (c: string) => (c.startsWith("/") ? c.slice(1) : joinModule(S.module, c));
        if (to !== undefined && to.t !== "nil") {
          if (to.t === "str") {
            const hash = to.v.indexOf("#");
            if (hash <= 0 || hash === to.v.length - 1) return { kind: "unresolved", note: `the route target ${JSON.stringify(to.v.slice(0, 60))} is not of the form controller#action` };
            return { kind: "action", controller: qualify(to.v.slice(0, hash)), action: to.v.slice(hash + 1) };
          }
          if (to.t === "const") return { kind: "rack", target: to.v };
          if (to.t === "call" && to.v === "redirect") return { kind: "redirect" };
          return { kind: "dynamic", note: "the route target is computed, or a string that is not controller#action" };
        }
        if (isDyn(o.controller) || isDyn(o.action)) return { kind: "dynamic", note: "the route's controller or action is computed" };
        // The route's own options win, then its `defaults:`, then the
        // enclosing blocks, innermost first; the path names the action last.
        const c = text(o.controller) ?? fromHash(o.defaults, "controller");
        const a = text(o.action) ?? fromHash(o.defaults, "action") ?? S.action ?? defaultAction;
        let controller: string | null = null;
        if (c !== null) controller = qualify(c);
        else if (res && level !== "default") controller = res.controller;
        else if (S.controller) controller = qualify(S.controller);
        if (controller !== null && a !== null) return { kind: "action", controller, action: a };
        if (controller === null && a === null && path.t === "str") {
          const s = shorthand(path.v);
          if (s) return { kind: "action", controller: qualify(s.controller), action: s.action };
        }
        return { kind: "unresolved", note: controller === null ? "the route names no controller" : "the route names no action" };
      };

      const resources = (f: RouteFact, S: Scope, kids: RouteFact[] | undefined): void => {
        const o = f.opts;
        const singular = f.call === "resource";
        const names: string[] = [];
        for (const a of f.args) {
          const t = text(a);
          if (t !== null) names.push(t);
          else if (a.t === "list") for (const v of a.v) names.push(v);
          else gap(f, "dynamic", `a computed ${f.call} name: its routes are not listed`);
        }
        if (o.concerns !== undefined) gap(f, "unsupported-rule", "routes added through concerns are not expanded", null);
        const only = listOf(o.only);
        const except = listOf(o.except);
        const filterDyn = isDyn(o.only) || isDyn(o.except);
        if (filterDyn) gap(f, "dynamic", `computed only: or except: options: the ${f.call} routes are not listed`);
        // Only the path option makes the pattern computed; a computed
        // controller or module hides the handler, a computed `as` the names.
        const dyn = S.dynamic ?? (isDyn(o.path) ? `a computed ${f.call} path` : null);
        if (dyn && dyn !== S.dynamic) gap(f, "dynamic", `${dyn}: the routes have no known pattern`, null, ["tests"]);
        const hidden = isDyn(o.controller) || isDyn(o.module) ? `the ${f.call} controller is computed, so its routes' handlers are not known` : null;
        if (hidden) gap(f, "dynamic", hidden);
        const unnamed = isDyn(o.as);
        const shallow = S.shallow || (o.shallow?.t === "bool" && o.shallow.v);
        // Every name of the call; the block nests under the last one.
        names.forEach((name, i) => {
          const asName = text(o.as) ?? name;
          const ctrlName = text(o.controller) ?? (singular ? pluralize(name) : name);
          if (singular && text(o.controller) === null && name.length > MAX_NAME) gap(f, "fan-out-capped", `the ${f.call} name is longer than ${MAX_NAME} characters, so it is not made plural and its controller may not be found`);
          const mod = text(o.module);
          const controller = joinModule(mod ? joinModule(S.module, mod) : S.module, ctrlName);
          const seg = text(o.path) ?? name;
          const param = text(o.param) ?? "id";
          const one = singular ? asName : singularize(asName);
          const collectionPath = joinPath(S.path, seg);
          // A path as shown: the scope's shown prefix in place of its path.
          const shownOf = (p: string) => (S.dynamic === null ? p : p.startsWith(S.path) ? joinPath(S.shown, p.slice(S.path.length)) : `/${COMPUTED}`);
          const memberBase = shallow && !singular ? { path: S.shallowPath, as: S.shallowPrefix } : { path: S.path, as: S.as };
          const memberPath = singular ? collectionPath : joinPath(joinPath(memberBase.path, seg), `:${param}`);
          const collectionName = joinName(S.as, singular ? asName : asName);
          const memberName = singular ? joinName(S.as, asName) : joinName(memberBase.as, one);
          const all = singular ? SINGULAR_ACTIONS : PLURAL_ACTIONS;
          const actions = filterDyn ? [] : all.filter((a) => (only === null || only.includes(a)) && (except === null || !except.includes(a)));
          const routes: Record<string, { methods: string[]; path: string; name: string | null }> = {
            index: { methods: ["GET"], path: collectionPath, name: collectionName },
            create: { methods: ["POST"], path: collectionPath, name: singular ? memberName : collectionName },
            new: { methods: ["GET"], path: joinPath(collectionPath, "new"), name: joinName("new", S.as, one) },
            edit: { methods: ["GET"], path: joinPath(memberPath, "edit"), name: joinName("edit", singular ? S.as : memberBase.as, one) },
            show: { methods: ["GET"], path: memberPath, name: memberName },
            update: { methods: ["PATCH", "PUT"], path: memberPath, name: memberName },
            destroy: { methods: ["DELETE"], path: memberPath, name: memberName },
          };
          const local = (full: string) => (full.startsWith(S.path) && S.path !== "/" ? full.slice(S.path.length) || "/" : full);
          for (const action of actions) {
            const r = routes[action] as { methods: string[]; path: string; name: string | null };
            const handler: HandlerSpec = guarded(hidden !== null ? { kind: "dynamic", note: hidden } : { kind: "action", controller, action }, S);
            if (r.name !== null && !unnamed) taken.add(r.name);
            emit(f, { methods: r.methods, pattern: dyn === null ? r.path : null, written: dyn === null ? local(r.path) : null, name: unnamed ? null : r.name, handler, handlerWritten: written(handler), action, partial: dyn === null || isDyn(o.path) ? null : partialOf(shownOf(r.path)) });
          }
          if (i !== names.length - 1 || !kids) return;
          const res: Res = {
            controller,
            collectionName: asName,
            memberName: one,
            collectionPath,
            memberPath,
            shownCollection: shownOf(collectionPath),
            shownMember: shownOf(memberPath),
            outerAs: S.as,
            memberAs: singular ? S.as : memberBase.as,
          };
          const nestedPath = singular ? collectionPath : joinPath(collectionPath, `:${one}_${param}`);
          walk(kids, { ...S, path: nestedPath, shown: shownOf(nestedPath), as: joinName(S.as, one), controller: null, level: "nested", res, shallow, dynamic: dyn, handlerUnknown: S.handlerUnknown ?? hidden });
        });
      };

      // `draw(:admin)`: Rails reads config/routes/admin.rb in the scope of the
      // call; its route calls are at the top of that file.
      const drawFile = (f: RouteFact, S: Scope): void => {
        const name = text(f.args[0]);
        if (name === null || !isWordPath(name) || name.startsWith("/")) {
          gap(f, "dynamic", "a draw of a computed routes file");
          return;
        }
        if (!app) {
          gap(f, "unsupported-rule", `draw(:${name}) in routes no detected application owns is not followed`, name);
          return;
        }
        const target = under(app.root, `config/routes/${name}.rb`);
        if (!world.paths.has(target)) {
          gap(f, "miss", `draw(:${name}) names ${target}, which does not exist`, name);
          return;
        }
        if (cur.depth >= MAX_DRAW_DEPTH) {
          gap(f, "fan-out-capped", `route files drawn more than ${MAX_DRAW_DEPTH} deep are not read`, name);
          return;
        }
        const saved = cur;
        cur = { ctx: fileCtx(target), draw: -1, depth: saved.depth + 1 };
        out.tables.push({ file: target, site: { file: saved.ctx.file, line: f.line, column: f.column }, app });
        walk(children.get(-1), S);
        cur = saved;
      };

      const mount = (f: RouteFact, S: Scope): void => {
        const o = f.opts;
        let target: string | null = null;
        let at: Lit | undefined;
        if (f.pair && f.pair[0].t === "const") {
          target = f.pair[0].v;
          at = f.pair[1];
        } else if (f.args[0]?.t === "const") {
          target = f.args[0].v;
          at = o.at;
        }
        if (target === null) {
          gap(f, "dynamic", "a mount of a computed application", null, ["mounts"]);
          return;
        }
        const path = text(at);
        if (path === null) gap(f, "dynamic", "a mount at a computed path", null, ["tests"]);
        const engine = target.endsWith("::Engine") ? normName(underscore(target.slice(0, -"::Engine".length))) : null;
        const as = o.as !== undefined ? text(o.as) : engine;
        const handler: HandlerSpec = { kind: "mount", target };
        emit(f, {
          methods: ["*"],
          pattern: path === null || S.dynamic !== null ? null : joinPath(S.path, path),
          partial: path !== null && S.dynamic === null ? null : partialOf(joinPath(S.shown, path ?? COMPUTED)),
          written: path,
          name: as === null ? null : nameOf(joinName(S.as, normName(as)), true),
          handler,
          handlerWritten: target,
          action: null,
        });
      };

      const rootScope: Scope = {
        path: "/",
        shown: "/",
        module: app?.kind === "engine" && app.isolate ? underscore(app.isolate) : null,
        as: null,
        controller: null,
        action: null,
        shallowPath: "/",
        shallowPrefix: null,
        shallow: false,
        level: "default",
        res: null,
        dynamic: null,
        handlerUnknown: null,
      };
      walk(children.get(-1), rootScope);
    });
  }
  return out;
}

// A controller action under a scope that hides its controller is computed.
function guarded(h: HandlerSpec, S: Scope): HandlerSpec {
  return h.kind === "action" && S.handlerUnknown !== null ? { kind: "dynamic", note: S.handlerUnknown } : h;
}

// The handler as `rails routes` writes it: "admin/posts#index".
function written(h: HandlerSpec): string {
  switch (h.kind) {
    case "action":
      return `${h.controller}#${h.action}`;
    case "mount":
    case "rack":
      return h.target;
    case "redirect":
      return "redirect";
    default:
      return "(computed)";
  }
}
