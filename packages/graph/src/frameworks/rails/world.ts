// What the Rails resolve step reads about a capture, built once per build
// through the PluginIndex: the applications and engines, the classes and
// modules with their bases and includes, method lookup through includes and
// superclasses, action visibility, and the view files of each application.
import { symbolId } from "../../resolve.js";
import type { DefFact } from "../../types.js";
import type { Detection, PluginIndex, Site } from "../plugin.js";
import { appId } from "../plugin.js";
import { keptName } from "../shared/kept.js";
import type { ClassFact, RailsFact, VisibilityFact } from "./facts.js";
import { underscore } from "./inflect.js";

export const PLUGIN = "rails";
// 2: 1-based columns, as the language facts.
// 3: a route keeps only the options it reads, and no query string or URL user.
// 4: a kept literal is bounded, with key-shaped text redacted; a target only as controller#action.
// 5: a literal over the bound is not kept, and a redacted run is named by its hash.
// 6: a route cap says which limit stopped it: the nesting of route blocks or the syntax depth.
export const VERSION = 6;

export type App = {
  id: string;
  kind: "application" | "engine";
  root: string; // "" for the repository root, else a folder without a trailing slash
  className: string | null; // "Blog::Application", "Blog::Engine"
  isolate: string | null; // the engine's isolate_namespace module
  site: Site;
};

export type ClassInfo = {
  file: string;
  name: string; // qualified: "Admin::PostsController"
  id: string; // the symbol id
  def: DefFact;
  module: boolean;
  base: string | null; // as written
  includes: string[];
  line: number;
};

export type MethodHit = { id: string; def: DefFact; owner: ClassInfo; via: "own" | "base" | "include" };
// Why a method was not found: the class chain ends at a framework class
// (missing), leaves the repository at a class it cannot read (external),
// or could not be followed (unresolved).
export type MethodMiss = { status: "missing" | "external" | "unresolved"; note: string };

// Framework classes whose ancestors define no application method.
export const FRAMEWORK_BASES = new Set([
  "ActionController::Base",
  "ActionController::API",
  "ActionController::Metal",
  "ActionMailer::Base",
  "ActiveRecord::Base",
  "ActiveJob::Base",
  "ActiveSupport::TestCase",
  "ActionDispatch::IntegrationTest",
  "Object",
  "BasicObject",
]);

export const MAX_CHAIN = 8;

const strip = (name: string) => name.replace(/^::/, "");

export function under(root: string, rel: string): string {
  return root === "" ? rel : `${root}/${rel}`;
}

// The path of a file relative to an application root, or null when the
// file is not under it.
export function relTo(root: string, file: string): string | null {
  if (root === "") return file;
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
}


export class RailsWorld {
  readonly paths: ReadonlySet<string>;
  // The Ruby files of the capture, sorted.
  readonly rubyPaths: readonly string[];
  private readonly appCache = new Map<string, App | null>();
  readonly classesByName = new Map<string, ClassInfo[]>();
  private readonly classesByFile = new Map<string, ClassInfo[]>();
  private readonly viewsCache = new Map<string, Map<string, string[]>>();
  private readonly methodsCache = new Map<string, { id: string; def: DefFact; file: string }[]>();
  private readonly byClassCache = new Map<string, Map<number, RailsFact[]>>();
  private subclassMap: Map<string, ClassInfo[]> | null = null;
  private readonly spanCache = new Map<string, { symbols: Int32Array; classes: Int32Array; ids: string[] }>();

  constructor(
    readonly index: PluginIndex,
    readonly apps: readonly App[],
  ) {
    this.paths = new Set(index.paths());
    this.rubyPaths = [...this.paths].filter((p) => p.endsWith(".rb")).sort();
    for (const file of index.paths()) {
      if (!file.endsWith(".rb")) continue;
      const facts = index.languageFacts(file);
      if (!facts || facts.lang !== "ruby") continue;
      const mine = new Map<string, ClassFact>();
      for (const f of this.facts(file)) if (f.kind === "class") mine.set(`${f.line}\0${f.name}`, f);
      for (const def of facts.defs) {
        if (def.kind !== "class" && def.kind !== "module") continue;
        const name = def.owner ? `${def.owner}::${def.name}` : def.name;
        const fact = mine.get(`${def.line}\0${name}`);
        const info: ClassInfo = {
          file,
          name,
          id: symbolId(file, def),
          def,
          module: def.kind === "module",
          base: fact ? fact.base : (def.bases[0]?.name ?? null),
          includes: fact ? fact.includes : [],
          line: def.line,
        };
        (this.classesByName.get(name) ?? this.classesByName.set(name, []).get(name))?.push(info);
        (this.classesByFile.get(file) ?? this.classesByFile.set(file, []).get(file))?.push(info);
      }
    }
  }

  facts(file: string): readonly RailsFact[] {
    return this.index.factsOf(file) as readonly RailsFact[];
  }

  // The application whose root holds the file: the deepest one. Asked
  // for every file by several rules, so kept per file.
  appOf(file: string): App | null {
    const kept = this.appCache.get(file);
    if (kept !== undefined) return kept;
    let best: App | null = null;
    for (const a of this.apps) {
      if (relTo(a.root, file) === null) continue;
      if (!best || a.root.length > best.root.length || (a.root.length === best.root.length && a.kind === "application" && best.kind === "engine")) best = a;
    }
    this.appCache.set(file, best);
    return best;
  }

  classesIn(file: string): readonly ClassInfo[] {
    return this.classesByFile.get(file) ?? [];
  }

  // The class a constant names from a lexical nesting, innermost first;
  // among several definitions, the one in the same application at the
  // autoload path wins.
  resolveConst(name: string, nesting: string | null, app: App | null): ClassInfo | null {
    const n = strip(name);
    const parts = name.startsWith("::") || !nesting ? [] : nesting.split("::");
    for (let i = parts.length; i >= 0; i--) {
      const full = [...parts.slice(0, i), n].join("::");
      const list = this.classesByName.get(full);
      if (list && list.length > 0) return this.pick(list, app);
    }
    return null;
  }

  pick(list: readonly ClassInfo[], app: App | null): ClassInfo {
    const inApp = list.filter((c) => this.appOf(c.file) === app);
    const pool = inApp.length > 0 ? inApp : list;
    const path = `/${underscore(pool[0]?.name ?? "")}.rb`;
    return pool.find((c) => `/${c.file}`.endsWith(path)) ?? (pool[0] as ClassInfo);
  }

  // The facts of a kind in a file, by the line of the class they belong to
  // (the `cls` of a class-body fact), built once per file and kind.
  byClass(file: string, kind: string): Map<number, RailsFact[]> {
    const key = `${file}\0${kind}`;
    let m = this.byClassCache.get(key);
    if (m) return m;
    m = new Map();
    for (const f of this.facts(file)) {
      if (f.kind !== kind || !("cls" in f)) continue;
      (m.get(f.cls) ?? m.set(f.cls, []).get(f.cls))?.push(f);
    }
    this.byClassCache.set(key, m);
    return m;
  }

  // For each line of a file, the innermost definition (and the innermost
  // class or module) whose span holds it: one sweep over the spans sorted by
  // start, with a stack of the open ones. Linear in lines and definitions,
  // however many facts ask.
  private spans(file: string): { symbols: Int32Array; classes: Int32Array; ids: string[] } {
    const kept = this.spanCache.get(file);
    if (kept) return kept;
    const sweep = (spans: { start: number; end: number }[]): Int32Array => {
      const last = spans.reduce((m, s) => Math.max(m, s.end), 0);
      const out = new Int32Array(last + 2).fill(-1);
      const order = spans.map((_, i) => i).sort((a, b) => (spans[a] as { start: number }).start - (spans[b] as { start: number }).start || (spans[b] as { end: number }).end - (spans[a] as { end: number }).end);
      const stack: number[] = [];
      let next = 0;
      for (let line = 1; line <= last; line++) {
        while (next < order.length && (spans[order[next] as number] as { start: number }).start === line) stack.push(order[next++] as number);
        while (stack.length > 0 && (spans[stack[stack.length - 1] as number] as { end: number }).end < line) stack.pop();
        // A span that ended under a still-open later one leaves the stack when it is on top.
        out[line] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
      }
      return out;
    };
    const symbols = this.index.symbols(file).filter((n) => n.kind !== "file");
    const result = {
      ids: symbols.map((n) => n.id),
      symbols: sweep(symbols.map((n) => ({ start: n.startLine, end: n.endLine }))),
      classes: sweep(this.classesIn(file).map((c) => ({ start: c.def.line, end: c.def.endLine }))),
    };
    this.spanCache.set(file, result);
    return result;
  }

  // The qualified class or module whose body holds the line.
  nestingAt(file: string, line: number): string | null {
    const i = this.spans(file).classes[line] ?? -1;
    return i < 0 ? null : (this.classesIn(file)[i]?.name ?? null);
  }

  // The innermost definition holding the line, else the file itself.
  symbolAt(file: string, line: number): string {
    const s = this.spans(file);
    const i = s.symbols[line] ?? -1;
    return i < 0 ? file : (s.ids[i] ?? file);
  }

  // The instance methods a class or module defines in its own body, in
  // every file of its application that opens it.
  ownMethods(cls: ClassInfo): { id: string; def: DefFact; file: string }[] {
    const kept = this.methodsCache.get(cls.id);
    if (kept) return kept;
    const app = this.appOf(cls.file);
    const files = new Set((this.classesByName.get(cls.name) ?? []).filter((c) => this.appOf(c.file) === app).map((c) => c.file));
    files.add(cls.file);
    const out: { id: string; def: DefFact; file: string }[] = [];
    for (const file of [...files].sort()) {
      for (const def of this.index.languageFacts(file)?.defs ?? []) {
        if (def.kind === "method" && def.owner === cls.name && !def.static) out.push({ id: symbolId(file, def), def, file });
      }
    }
    this.methodsCache.set(cls.id, out);
    return out;
  }

  // An instance method by name: the class's own body, its includes, then
  // its superclasses, at most MAX_CHAIN classes deep.
  findMethod(cls: ClassInfo, name: string): MethodHit | MethodMiss {
    const app = this.appOf(cls.file);
    let cur: ClassInfo | null = cls;
    const outside: string[] = [];
    for (let depth = 0; cur && depth < MAX_CHAIN; depth++) {
      const own = this.ownMethods(cur).find((m) => m.def.name === name);
      if (own) return { id: own.id, def: own.def, owner: cur, via: depth === 0 ? "own" : "base" };
      for (const inc of [...cur.includes].reverse()) {
        const mod = this.resolveConst(inc, cur.name, app);
        if (!mod) {
          outside.push(strip(inc));
          continue;
        }
        const hit = this.ownMethods(mod).find((m) => m.def.name === name);
        if (hit) return { id: hit.id, def: hit.def, owner: mod, via: "include" };
      }
      const base = cur.base;
      if (base === null || FRAMEWORK_BASES.has(strip(base))) {
        const also = outside.length > 0 ? `; it also includes ${outside.join(", ")}, which is outside the repository` : "";
        return { status: "missing", note: `${name} is not defined in ${cls.name} or the classes it inherits from in the repository${also}` };
      }
      const next = this.resolveConst(base, cur.def.owner ?? null, app);
      if (!next) return { status: "external", note: `${name} is not defined in ${cls.name}; its base ${strip(base)} is outside the repository and may define it.` };
      if (next.id === cur.id) break;
      cur = next;
    }
    return { status: "unresolved", note: `the class chain of ${cls.name} is deeper than ${MAX_CHAIN} classes; the plugin stops there` };
  }

  // Whether the class chain reaches one of `roots` (qualified names), at most
  // MAX_CHAIN deep. "bound": through repository classes; "named": the class
  // itself names a framework root. "cut" when the chain goes on past MAX_CHAIN.
  reaches(cls: ClassInfo, roots: ReadonlySet<string>): { via: string[] } | "cut" | null {
    const app = this.appOf(cls.file);
    let cur: ClassInfo | null = cls;
    const via: string[] = [];
    for (let depth = 0; cur && depth < MAX_CHAIN; depth++) {
      const base = cur.base;
      if (base === null) return null;
      via.push(strip(base));
      if (roots.has(strip(base))) return { via };
      const next = this.resolveConst(base, cur.def.owner ?? null, app);
      if (!next || next.id === cur.id) return null;
      cur = next;
    }
    return "cut";
  }

  // The classes of the repository that inherit from a class, nearest first,
  // at most MAX_CHAIN levels down and `cap` classes in all; `cut` is set when
  // either limit stopped the walk.
  descendants(cls: ClassInfo, cap: number): { list: ClassInfo[]; cut: boolean } {
    if (!this.subclassMap) {
      const m = new Map<string, ClassInfo[]>();
      for (const list of this.classesByName.values()) {
        for (const c of list) {
          if (c.base === null || c.module) continue;
          const parent = this.resolveConst(c.base, c.def.owner ?? null, this.appOf(c.file));
          if (!parent || parent.id === c.id) continue;
          (m.get(parent.id) ?? m.set(parent.id, []).get(parent.id))?.push(c);
        }
      }
      this.subclassMap = m;
    }
    const out: ClassInfo[] = [];
    const seen = new Set<string>([cls.id]);
    let level = [cls];
    for (let depth = 0; depth < MAX_CHAIN && level.length > 0; depth++) {
      const next: ClassInfo[] = [];
      for (const c of level) {
        for (const sub of this.subclassMap.get(c.id) ?? []) {
          if (seen.has(sub.id)) continue;
          if (out.length >= cap) return { list: out, cut: true };
          seen.add(sub.id);
          out.push(sub);
          next.push(sub);
        }
      }
      level = next;
    }
    const subs = this.subclassMap;
    return { list: out, cut: level.some((c) => (subs.get(c.id) ?? []).some((sub) => !seen.has(sub.id))) };
  }

  includesAny(cls: ClassInfo, names: ReadonlySet<string>): string | null {
    for (const inc of cls.includes) if (names.has(strip(inc))) return strip(inc);
    return null;
  }

  // Whether a method is public in its class: no `private` or `protected`
  // above it in the class body (until a `public`), and not named by one.
  isPublic(cls: ClassInfo, def: DefFact, file: string): boolean {
    const marks = (this.byClass(file, "visibility").get(cls.def.line) ?? []) as VisibilityFact[];
    let visible = true;
    for (const m of marks) {
      if (m.names !== null) {
        if (m.names.includes(def.name)) visible = m.value === "public";
        continue;
      }
      if (m.line < def.line) visible = m.value === "public";
    }
    // A named mark after the definition (`private :x`) still applies.
    return visible;
  }

  // The view files of an application by logical name: "posts/show" for
  // app/views/posts/show.html.erb, "posts/_form" for a partial. Several
  // files share a name when they differ by format or handler. Each name is
  // in the form the facts keep a name in (shared/kept.ts `keptName`), so a
  // name the facts redacted still finds its view: a lookup puts its name in
  // that form too.
  views(app: App): Map<string, string[]> {
    const kept = this.viewsCache.get(app.id);
    if (kept) return kept;
    const prefix = under(app.root, "app/views/");
    const map = new Map<string, string[]>();
    for (const p of this.paths) {
      if (!p.startsWith(prefix)) continue;
      // A file of a nested application belongs to that one.
      if (this.appOf(p) !== app) continue;
      const rel = p.slice(prefix.length);
      const slash = rel.lastIndexOf("/");
      const base = rel.slice(slash + 1);
      const dot = base.indexOf(".");
      if (dot <= 0) continue;
      const logical = keptName(`${rel.slice(0, slash + 1)}${base.slice(0, dot)}`);
      (map.get(logical) ?? map.set(logical, []).get(logical))?.push(p);
    }
    for (const list of map.values()) list.sort();
    this.viewsCache.set(app.id, map);
    return map;
  }
}

// ---------- detection ----------

const isAppBase = (base: string) => strip(base) === "Rails::Application";
const isEngineBase = (base: string) => strip(base) === "Rails::Engine";
// `Rails.application` or `<Name>::Application` (the receiver of a routes draw).
function isAppReceiver(receiver: string): boolean {
  const r = strip(receiver);
  if (r === "Rails.application") return true;
  const parts = r.split("::");
  return parts.length >= 2 && parts[parts.length - 1] === "Application" && parts.every(isConstantName);
}
function isConstantName(part: string): boolean {
  if (part.length === 0 || part.length > 128) return false;
  const first = part.charCodeAt(0);
  if (first < 65 || first > 90) return false;
  for (let i = 1; i < part.length; i++) {
    const c = part.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}
// The root of an engine whose class is in `<root>/lib/...`: the folder above
// the last lib/ folder of the path.
function engineRoot(file: string): string | null {
  const parts = file.split("/");
  for (let i = parts.length - 2; i >= 0; i--) if (parts[i] === "lib") return parts.slice(0, i).join("/");
  return null;
}

function rootOf(file: string, marker: string): string | null {
  if (file === marker) return "";
  return file.endsWith(`/${marker}`) ? file.slice(0, -marker.length - 1) : null;
}

// The applications and engines in the capture. `rails` declared in a
// Gemfile only enables the rule; an application needs a marker: a
// config/application.rb class based on Rails::Application, a
// config/routes.rb drawing Rails.application's routes, or bin/rails. An
// engine is a class based on Rails::Engine in a lib/ folder; its root is
// the folder above lib/.
export function detectApps(index: PluginIndex): { apps: App[]; detections: Detection[] } {
  if (!index.declares("", "gems", "rails")) return { apps: [], detections: [] };
  type Found = { root: string; kind: App["kind"]; className: string | null; isolate: string | null; site: Site | null; evidence: { file: string; line: number; note: string }[] };
  const roots = new Map<string, Found>();
  const engines: Found[] = [];
  const at = (root: string): Found => {
    let f = roots.get(root);
    if (!f) roots.set(root, (f = { root, kind: "application", className: null, isolate: null, site: null, evidence: [] }));
    return f;
  };
  for (const file of index.factFiles()) {
    const facts = index.factsOf(file) as readonly RailsFact[];
    let isolated: Map<number, RailsFact & { kind: "isolate" }> | null = null;
    for (const f of facts) {
      if (f.kind === "class" && f.base !== null && isAppBase(f.base)) {
        const root = rootOf(file, "config/application.rb");
        if (root === null) continue;
        const found = at(root);
        found.className = f.name;
        found.site = { file, line: f.line, column: f.column };
        found.evidence.unshift({ file, line: f.line, note: `${f.name} is based on Rails::Application` });
      } else if (f.kind === "class" && f.base !== null && isEngineBase(f.base)) {
        const root = engineRoot(file);
        if (root === null) continue;
        isolated ??= isolates(facts);
        const isolate = isolated.get(f.line);
        engines.push({
          root,
          kind: "engine",
          className: f.name,
          isolate: isolate && isolate.kind === "isolate" ? isolate.name : null,
          site: { file, line: f.line, column: f.column },
          evidence: [{ file, line: f.line, note: `${f.name} is based on Rails::Engine` }],
        });
      } else if (f.kind === "draw" && isAppReceiver(f.receiver)) {
        const root = rootOf(file, "config/routes.rb");
        if (root === null) continue;
        const found = at(root);
        found.site ??= { file, line: f.line, column: f.column };
        found.evidence.push({ file, line: f.line, note: `config/routes.rb draws ${f.receiver}'s routes` });
      }
    }
  }
  for (const p of index.paths()) {
    const root = rootOf(p, "bin/rails");
    if (root === null) continue;
    const found = at(root);
    found.site ??= { file: p, line: 1, column: 0 };
    found.evidence.push({ file: p, line: 1, note: "bin/rails is present" });
  }
  // One application per root: an application marker wins over an engine,
  // and the first engine class of a root over later ones.
  const byRoot = new Map<string, Found>(roots);
  for (const e of engines) if (!byRoot.has(e.root)) byRoot.set(e.root, e);
  const all: Found[] = [...byRoot.values()];
  all.sort((a, b) => a.root.localeCompare(b.root) || a.kind.localeCompare(b.kind));
  const apps: App[] = [];
  const detections: Detection[] = [];
  for (const f of all) {
    const site = f.site as Site;
    const id = appId(PLUGIN, site.file, site.line);
    apps.push({ id, kind: f.kind, root: f.root, className: f.className, isolate: f.isolate, site });
    detections.push({
      id,
      name: f.className ?? (f.root === "" ? "the Rails application" : `the Rails application in ${f.root}`),
      project: index.projectOf(site.file),
      root: f.root,
      site,
      evidence: f.evidence,
      version: null,
      data: { kind: f.kind, className: f.className, isolate: f.isolate },
    });
  }
  return { apps, detections };
}

function isolates(facts: readonly RailsFact[]): Map<number, RailsFact & { kind: "isolate" }> {
  const m = new Map<number, RailsFact & { kind: "isolate" }>();
  for (const f of facts) if (f.kind === "isolate" && !m.has(f.cls)) m.set(f.cls, f);
  return m;
}

// The applications back from their detections (resolve receives the
// detections `detect` returned).
export function appsFrom(detections: readonly Detection[]): App[] {
  return detections.map((d) => {
    const data = (d.data ?? {}) as { kind?: unknown; className?: unknown; isolate?: unknown };
    return {
      id: d.id,
      kind: data.kind === "engine" ? "engine" : "application",
      root: d.root,
      className: typeof data.className === "string" ? data.className : null,
      isolate: typeof data.isolate === "string" ? data.isolate : null,
      site: d.site,
    };
  });
}
