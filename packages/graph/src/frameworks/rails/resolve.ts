// The Rails resolve step: registrations and their handlers, controller
// actions and callbacks, views, models, associations and tables,
// migrations, jobs and mailers, config keys and the links from tests to
// code. Every read goes through the PluginIndex (RailsWorld); every rule
// keeps to one application, and a registration is kept apart from its
// handler: a missing action leaves the registration with status "missing"
// and a gap that names it.
import type { Cause, Tier } from "../../model/records.js";
import { weakest } from "../../model/records.js";
import { entityId } from "../plugin.js";
import type { Detection, Entity, FrameworkEdgeKind, FrameworkEvidence, FrameworkEvidenceKind, FrameworkUnknown, PluginIndex, PluginOutput, Registration, Role, Site, TestCategory } from "../plugin.js";
import type { AssocFact, CallbackFact, ConfigDefineFact, ConfigReadFact, DescribeFact, EnqueueFact, MailFact, MigrationOpFact, RenderFact, RequestFact, RouteNameFact, TableNameFact } from "./facts.js";
import { camelize, classify, demodulize, singularize, tableize, underscore } from "./inflect.js";
import type { Compiled } from "./match.js";
import { compilePattern, firstLiterals, matches, requestSegments, stripPrefix } from "./match.js";
import type { Draft } from "./routes.js";
import { Budget, expandRoutes } from "./routes.js";
import type { App, ClassInfo, MethodMiss } from "./world.js";
import { FRAMEWORK_BASES, MAX_CHAIN, PLUGIN, RailsWorld, appsFrom, relTo, under } from "./world.js";
import { keptName } from "../shared/kept.js";

// The view folder of a controller ("admin/posts" for Admin::PostsController)
// and of a mailer ("user_mailer"); null for another class.
const controllerFolder = (c: ClassInfo) => (c.name.endsWith("Controller") && c.name.length > "Controller".length ? underscore(c.name.slice(0, -"Controller".length)) : null);
const mailerFolder = (c: ClassInfo) => (c.name.endsWith("Mailer") ? underscore(c.name) : null);

// Work units one resolve may spend on route expansion and request matching.
export const WORK_BUDGET = 2_000_000;
// The most subclasses searched for a callback a base class names.
export const MAX_SUBCLASSES = 32;
// How many through associations deep a through chain is followed.
const MAX_THROUGH = 4;

export const RULES = {
  application: "rails-application",
  routes: "rails-routes",
  resources: "rails-resources",
  handler: "rails-route-handler",
  mount: "rails-mount",
  actions: "rails-controller-actions",
  callbacks: "rails-callbacks",
  views: "rails-views",
  models: "rails-models",
  associations: "rails-associations",
  migrations: "rails-migrations",
  jobs: "rails-jobs",
  mailers: "rails-mailers",
  config: "rails-config",
  tests: "rails-tests",
} as const;
type RuleId = (typeof RULES)[keyof typeof RULES];

const MODEL_ROOTS = new Set(["ApplicationRecord", "ActiveRecord::Base"]);
const JOB_ROOTS = new Set(["ApplicationJob", "ActiveJob::Base"]);
const MAILER_ROOTS = new Set(["ApplicationMailer", "ActionMailer::Base"]);
const SIDEKIQ = new Set(["Sidekiq::Job", "Sidekiq::Worker"]);
const CONTROLLER_TEST = new Set(["ActionController::TestCase"]);

const strip = (n: string) => (n.startsWith("::") ? n.slice(2) : n);
// A note is one plain sentence that starts with a lower-case word (unless
// it starts with a name) and has no closing period, like the rest of the graph.
const sentence = (note: string) => {
  const t = note.trim();
  return t.endsWith(".") ? t.slice(0, -1) : t;
};
const isTestBase = (base: string | null) => base !== null && (base.endsWith("TestCase") || base.endsWith("IntegrationTest") || strip(base) === "Minitest::Test");

export function resolveRails(index: PluginIndex, detections: readonly Detection[]): PluginOutput {
  const out: PluginOutput = { roles: [], entities: [], edges: [], unknowns: [] };
  const apps = appsFrom(detections);
  // A dependency alone never makes an application: without one, nothing
  // is read.
  if (apps.length === 0) return out;
  new Resolver(new RailsWorld(index, apps), out).run();
  return out;
}

// The cause of a method not found: a chain cut past MAX_CHAIN is a cap.
const missCause = (m: MethodMiss): Cause => (m.status === "external" ? "external" : m.status === "unresolved" ? "fan-out-capped" : "miss");

class Resolver {
  private readonly budget = new Budget(WORK_BUDGET);
  private readonly roleKeys = new Set<string>();
  private readonly viewCapped = new Set<string>();
  private readonly edgeKeys = new Set<string>();
  private readonly entityById = new Map<string, Entity>();
  private readonly registrations: Registration[] = [];
  private readonly regsByApp = new Map<string, Registration[]>();
  private readonly regsByName = new Map<string, Registration[]>();
  private readonly regsByHandler = new Map<string, Registration[]>();
  private readonly engineMounts = new Map<string, Registration[]>(); // engine app id to the mounts naming it
  private readonly mountTarget = new Map<string, App>(); // mount registration id to its engine
  private readonly models = new Map<string, { cls: ClassInfo; app: App }>();
  private readonly tableOf = new Map<string, { table: string; tier: Tier; note: string | null; site: Site } | null>();

  constructor(
    private readonly w: RailsWorld,
    private readonly out: PluginOutput,
  ) {}

  run(): void {
    this.routes();
    this.controllers();
    this.mailers();
    this.models_();
    this.migrations();
    this.jobs();
    this.config();
    this.tests();
    // The budget is the whole build's, so what it left out may be in any project.
    if (this.budget.spent) this.unknown(null, { build: true }, "budget", [], null, "the Rails plugin ran out of its work budget; some routes or test links are not listed");
  }

  // ---------- small builders ----------

  private ev(kind: FrameworkEvidenceKind, tier: Tier, site: Site, rule: RuleId, note: string | null, via: FrameworkEvidence["via"] = null, premises: string[] = []): FrameworkEvidence {
    const text = tier === "certain" ? note : (note ?? "found by a Rails convention");
    return { kind, tier, site, via, premises, rule: { id: rule, version: 1 }, note: text === null ? null : sentence(text) };
  }

  private role(target: string, role: Role, detail: string | null, app: App | null, evidence: FrameworkEvidence): void {
    const k = `${target}\0${role}`;
    if (this.roleKeys.has(k)) return;
    this.roleKeys.add(k);
    this.out.roles.push({ target, role, detail, app: app?.id ?? null, evidence });
  }

  private edge(from: string, to: string, kind: FrameworkEdgeKind, app: App | null, evidence: FrameworkEvidence, extra: { category?: TestCategory; order?: number } = {}): void {
    const k = `${from}\0${to}\0${kind}\0${extra.category ?? ""}`;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.out.edges.push({ from, to, kind, plugin: PLUGIN, app: app?.id ?? null, evidence, ...extra });
  }

  private entity(e: Entity): Entity {
    const kept = this.entityById.get(e.id);
    if (kept) return kept;
    this.entityById.set(e.id, e);
    this.out.entities.push(e);
    return e;
  }

  private unknown(site: Site | null, scope: FrameworkUnknown["scope"], cause: Cause, affects: FrameworkEdgeKind[], name: string | null, note: string): void {
    this.out.unknowns.push({ plugin: PLUGIN, site, scope, affects, cause, name, note: sentence(note), count: null, exact: false });
  }

  // A class whose chain of bases goes on past MAX_CHAIN: whether it is `what` is not known.
  private chainCut(cls: ClassInfo, affects: FrameworkEdgeKind[], what: string): void {
    this.unknown({ file: cls.file, line: cls.line, column: 0 }, { file: cls.file }, "fan-out-capped", affects, cls.name, `the class chain of ${cls.name} is deeper than ${MAX_CHAIN} classes, so whether it is ${what} is not known`);
  }

  private template(app: App, file: string): string {
    const base = file.slice(file.lastIndexOf("/") + 1);
    return this.entity({ kind: "template", id: entityId(PLUGIN, app.id, "template", file), plugin: PLUGIN, app: app.id, name: file, site: { file, line: 1, column: 0 }, file, detail: base.startsWith("_") ? "partial" : "view" }).id;
  }

  private missingTemplate(app: App, logical: string): string {
    return this.entity({ kind: "template", id: entityId(PLUGIN, app.id, "template", `missing:${logical}`), plugin: PLUGIN, app: app.id, name: logical, site: null, file: null, detail: logical.slice(logical.lastIndexOf("/") + 1).startsWith("_") ? "partial" : "view" }).id;
  }

  private table(app: App, name: string, site: Site | null): string {
    const id = entityId(PLUGIN, app.id, "table", name);
    const kept = this.entityById.get(id);
    if (kept && kept.kind === "table" && kept.site === null && site !== null) kept.site = site;
    return this.entity({ kind: "table", id, plugin: PLUGIN, app: app.id, name, site, file: null, detail: null }).id;
  }

  private filesOf(app: App, folder: string): string[] {
    const prefix = under(app.root, folder);
    return this.w.rubyPaths.filter((p) => p.startsWith(prefix) && this.w.appOf(p) === app);
  }

  private classesUnder(app: App, folder: string): ClassInfo[] {
    return this.filesOf(app, folder).flatMap((f) => this.w.classesIn(f).filter((c) => !c.module));
  }

  private factsOfKind<K extends string>(file: string, kind: K) {
    return this.w.facts(file).filter((f) => f.kind === kind);
  }

  // Why a class has a framework role, as a note: by a base found through
  // the autoload convention, or by naming the framework class (Ruby has no
  // import that proves a constant).
  private baseNote(cls: ClassInfo, via: string[]): string {
    const last = via[via.length - 1] as string;
    return via.length === 1 ? `${cls.name} is based on ${last}, named in the source; Ruby has no import that proves the constant` : `${cls.name} reaches ${last} through ${via.slice(0, -1).join(", ")}, found by the autoload convention`;
  }

  // ---------- routes ----------

  private routes(): void {
    const exp = expandRoutes(this.w, this.budget);
    for (const t of exp.tables) this.role(t.file, "route_table", null, t.app, this.ev("route-table", "certain", t.site, RULES.routes, null));
    for (const g of exp.gaps) this.unknown(g.site, g.scope, g.cause, g.affects, g.name, g.note);
    // Mounts first: an engine's registrations name the mounts that serve them.
    const drafts = [...exp.drafts].sort((a, b) => Number(b.handler.kind === "mount") - Number(a.handler.kind === "mount"));
    for (const d of drafts) this.registration(d);
    this.registrations.sort((a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.site.column - b.site.column || a.id.localeCompare(b.id));
    for (const r of this.registrations) {
      const key = r.app ?? "-";
      (this.regsByApp.get(key) ?? this.regsByApp.set(key, []).get(key))?.push(r);
      if (r.name !== null) {
        const nk = `${key}\0${r.name}`;
        (this.regsByName.get(nk) ?? this.regsByName.set(nk, []).get(nk))?.push(r);
      }
    }
  }

  private registration(d: Draft): void {
    const reg: Registration = {
      kind: "registration",
      id: entityId(PLUGIN, d.app?.id ?? null, "registration", `${d.site.file}:${d.site.line}:${d.site.column}:${d.ordinal}`),
      plugin: PLUGIN,
      app: d.app?.id ?? null,
      methods: d.methods,
      pattern: d.pattern,
      written: d.written,
      name: d.name,
      site: d.site,
      mountedVia: d.app ? (this.engineMounts.get(d.app.id) ?? []).map((m) => m.site) : [],
      mounted: d.app !== null,
      handler: { written: d.handlerWritten, status: "unresolved", targets: [] },
      partial: d.pattern === null ? d.partial : null,
    };
    this.entity(reg);
    this.registrations.push(reg);
    const rule = d.action !== null ? RULES.resources : RULES.routes;
    const via = { file: d.site.file, line: d.site.line, spec: d.handlerWritten };
    const gap = (cause: Cause, note: string, scope: { file: string } = { file: d.site.file }) => this.unknown(d.site, scope, cause, ["handles"], d.handlerWritten, note);
    const app = d.app;
    if (!app) {
      gap("unsupported-rule", "the routes are drawn for an application the plugin did not detect; the handler is not looked up");
      return;
    }
    const h = d.handler;
    switch (h.kind) {
      case "action":
        this.bindAction(reg, app, h.controller, h.action, via, rule);
        return;
      case "mount": {
        const engine = this.w.apps.find((a) => a.kind === "engine" && a.className === strip(h.target));
        if (engine) {
          const routesFile = under(engine.root, "config/routes.rb");
          const target = this.w.paths.has(routesFile) ? routesFile : (this.w.resolveConst(engine.className as string, null, engine)?.id ?? routesFile);
          reg.handler.status = "bound";
          reg.handler.targets = [target];
          this.edge(reg.id, target, "mounts", app, this.ev("mount", "certain", d.site, RULES.mount, null, via));
          (this.engineMounts.get(engine.id) ?? this.engineMounts.set(engine.id, []).get(engine.id))?.push(reg);
          this.mountTarget.set(reg.id, engine);
          return;
        }
        const cls = this.w.resolveConst(h.target, null, app);
        if (cls) {
          reg.handler.status = "bound";
          reg.handler.targets = [cls.id];
          this.edge(reg.id, cls.id, "mounts", app, this.ev("mount", "likely", d.site, RULES.mount, `${strip(h.target)} is found by the autoload convention and is not a detected engine`, via));
          return;
        }
        reg.handler.status = "external";
        gap("external", `the mounted application ${strip(h.target)} is outside the repository`);
        return;
      }
      case "rack": {
        const cls = this.w.resolveConst(h.target, null, app);
        const call = cls ? this.w.findMethod(cls, "call") : null;
        if (cls && call && "id" in call) {
          reg.handler.status = "bound";
          reg.handler.targets = [call.id];
          this.edge(reg.id, call.id, "handles", app, this.ev("route-convention", "likely", d.site, RULES.handler, `a Rack application class found by the autoload convention; its call method answers the request`, via, [reg.id]));
          this.role(call.id, "route_handler", "rack", app, this.ev("route-convention", "likely", d.site, RULES.handler, "a Rack application class found by the autoload convention", via, [reg.id]));
          return;
        }
        reg.handler.status = cls ? "unresolved" : "external";
        if (call && !("id" in call) && call.status === "unresolved") gap("fan-out-capped", call.note);
        else gap(cls ? "miss" : "external", cls ? `${strip(h.target)} has no call method in the repository` : `the Rack application ${strip(h.target)} is outside the repository`);
        return;
      }
      case "redirect":
        // Rails answers a redirect route itself; nothing in the repository handles it.
        reg.handler.status = "external";
        return;
      case "dynamic":
        reg.handler.status = "dynamic";
        gap("dynamic", h.note);
        return;
      case "unresolved":
        reg.handler.status = "unresolved";
        gap("unsupported-rule", h.note);
        return;
    }
  }

  // The handler by the Zeitwerk convention: `admin/posts#show` to
  // app/controllers/admin/posts_controller.rb, class Admin::PostsController,
  // method show (or one it inherits or includes). A missing action keeps
  // the registration with status "missing" and a gap.
  private bindAction(reg: Registration, app: App, controller: string, action: string, via: FrameworkEvidence["via"], rule: RuleId): void {
    const file = under(app.root, `app/controllers/${controller}_controller.rb`);
    const expected = `${camelize(controller)}Controller`;
    const site = reg.site;
    const gap = (cause: Cause, note: string) => this.unknown(site, { file }, cause, ["handles"], reg.handler.written, note);
    if (!this.w.paths.has(file)) {
      reg.handler.status = "missing";
      reg.handler.targets = [file];
      gap("miss", `there is no controller file ${file} for ${reg.handler.written}`);
      return;
    }
    // A controller the graph did not read (over the size cap, a parse
    // error) says nothing about the actions it defines.
    if (this.w.index.languageFacts(file) === null) {
      reg.handler.status = "unresolved";
      reg.handler.targets = [file];
      gap("file-not-parsed", `${file} was not read, so whether it defines ${reg.handler.written} is not known`);
      return;
    }
    const classes = this.w.classesIn(file).filter((c) => !c.module);
    let cls = classes.find((c) => c.name === expected) ?? null;
    let acronym = false;
    if (!cls) {
      cls = classes.find((c) => c.name.toLowerCase() === expected.toLowerCase()) ?? null;
      acronym = cls !== null;
    }
    if (!cls) {
      reg.handler.status = "missing";
      reg.handler.targets = [file];
      gap("miss", `${file} does not define ${expected}`);
      return;
    }
    const hit = this.w.findMethod(cls, action);
    if ("id" in hit && this.w.isPublic(hit.owner, hit.def, hit.id.slice(0, hit.id.indexOf("#")))) {
      const how = hit.via === "own" ? `${file} defines ${cls.name}#${action}` : hit.via === "base" ? `${action} is defined in ${hit.owner.name}, which ${cls.name} inherits from` : `${action} is defined in ${hit.owner.name}, which ${cls.name} includes`;
      const note = `found by the controller path convention: ${how}${acronym ? "; the class name differs from the default inflection in case only" : ""}`;
      reg.handler.status = "bound";
      reg.handler.targets = [hit.id];
      this.edge(reg.id, hit.id, "handles", app, this.ev("route-convention", "likely", site, RULES.handler, note, via, [reg.id]));
      this.role(hit.id, "route_handler", "action", app, this.ev("route-convention", "likely", site, rule === RULES.resources ? RULES.resources : RULES.handler, note, via, [reg.id]));
      this.regsByHandlerAdd(hit.id, reg);
      return;
    }
    // Rails renders the action's view when no method of that name exists.
    const views = this.w.views(app).get(keptName(`${controller}/${action}`)) ?? [];
    if (!("id" in hit) && views.length > 0) {
      reg.handler.status = "bound";
      reg.handler.targets = views.map((v) => this.template(app, v));
      for (const t of reg.handler.targets) this.edge(reg.id, t, "renders", app, this.ev("template-implicit", "likely", site, RULES.views, `${cls.name} defines no ${action} method; Rails renders the view of that name`, via, [reg.id]));
      return;
    }
    if ("id" in hit) {
      reg.handler.status = "missing";
      reg.handler.targets = [cls.id];
      gap("miss", `${cls.name}#${action} is not public, so Rails does not route to it`);
      return;
    }
    reg.handler.status = hit.status;
    reg.handler.targets = [cls.id];
    gap(missCause(hit), hit.note);
  }

  private regsByHandlerAdd(id: string, reg: Registration): void {
    (this.regsByHandler.get(id) ?? this.regsByHandler.set(id, []).get(id))?.push(reg);
  }

  // ---------- controllers: actions, callbacks, views ----------

  private controllers(): void {
    for (const app of this.w.apps) {
      for (const cls of this.classesUnder(app, "app/controllers/")) {
        if (!cls.name.endsWith("Controller") || !cls.file.endsWith("_controller.rb")) continue;
        const methods = this.w.ownMethods(cls).filter((m) => m.file === cls.file);
        const actions = methods.filter((m) => this.w.isPublic(cls, m.def, m.file));
        for (const m of actions) {
          this.role(m.id, "route_handler", "action", app, this.ev("role-path", "likely", { file: m.file, line: m.def.line, column: 0 }, RULES.actions, `a public method of ${cls.name} under app/controllers; Rails treats it as an action`));
        }
        this.callbacks(app, cls);
        this.renders(app, cls, controllerFolder, actions);
      }
    }
  }

  private callbacks(app: App, cls: ClassInfo): void {
    let order = 0;
    for (const f of (this.w.byClass(cls.file, "callback").get(cls.line) ?? []) as CallbackFact[]) {
      const site = { file: cls.file, line: f.line, column: f.column };
      if (f.call.startsWith("skip_")) continue;
      if (f.dynamic) this.unknown(site, { file: cls.file }, "dynamic", ["applies_middleware"], f.call, `a ${f.call} with a block or a computed target`);
      const scope = f.only ? ` before ${f.only.join(", ")} only` : f.except ? ` except before ${f.except.join(", ")}` : "";
      for (const t of f.targets) {
        order++;
        const hit = this.w.findMethod(cls, t);
        if (!("id" in hit)) {
          // Rails calls the callback on the instance: a subclass that defines it runs its own.
          const subs = this.w.descendants(cls, MAX_SUBCLASSES);
          let found = 0;
          for (const sub of subs.list) {
            const own = this.w.ownMethods(sub).find((m) => m.def.name === t);
            if (!own) continue;
            found++;
            this.edge(cls.id, own.id, "applies_middleware", app, this.ev("declaration", "possible", site, RULES.callbacks, `${t} is not defined in ${cls.name}; ${sub.name}, which inherits from it, defines it, and Rails calls it on the instance${scope ? `; runs${scope}` : ""}`), { order });
          }
          if (subs.cut) this.unknown(site, { file: cls.file }, "fan-out-capped", ["applies_middleware"], t, `${cls.name} has more than ${MAX_SUBCLASSES} subclasses, or subclasses more than ${MAX_CHAIN} levels down; the rest are not searched for ${t}`);
          if (found === 0) this.unknown(site, { file: cls.file }, missCause(hit), ["applies_middleware"], t, `the ${f.call} callback ${t} is not defined: ${hit.note}`);
          continue;
        }
        const own = hit.via === "own";
        const note = own ? (scope ? `runs${scope}` : null) : `${t} is defined in ${hit.owner.name}, found by the autoload convention${scope ? `; runs${scope}` : ""}`;
        this.edge(cls.id, hit.id, "applies_middleware", app, this.ev("declaration", own ? "certain" : "likely", site, RULES.callbacks, note), { order });
      }
    }
  }

  // Explicit renders in each method, then the implicit view of every
  // action that names no template.
  // The render facts of a file by the definition that holds them, built
  // once per file.
  private readonly rendersCache = new Map<string, Map<string, RenderFact[]>>();
  private rendersIn(file: string): Map<string, RenderFact[]> {
    let m = this.rendersCache.get(file);
    if (m) return m;
    m = new Map();
    for (const f of this.factsOfKind(file, "render") as RenderFact[]) {
      const id = this.w.symbolAt(file, f.line);
      (m.get(id) ?? m.set(id, []).get(id))?.push(f);
    }
    this.rendersCache.set(file, m);
    return m;
  }

  // The view folders a class's renders are looked up in, as Rails does for
  // an instance: its own folder, then the folders of the classes it
  // inherits from, in order; and, for the code it hands down, each
  // subclass's own folder, where Rails looks first on an instance of it.
  private viewFolders(app: App, cls: ClassInfo, folderOf: (c: ClassInfo) => string | null): { own: { folder: string; owner: ClassInfo }[]; down: { folder: string; owner: ClassInfo }[]; cut: boolean } {
    const own: { folder: string; owner: ClassInfo }[] = [];
    let cur: ClassInfo | null = cls;
    for (let depth = 0; cur && depth < MAX_CHAIN; depth++) {
      const folder = folderOf(cur);
      if (folder !== null) own.push({ folder, owner: cur });
      if (cur.base === null || FRAMEWORK_BASES.has(strip(cur.base))) break;
      const next = this.w.resolveConst(cur.base, cur.def.owner ?? null, app);
      if (!next || next.id === cur.id) break;
      cur = next;
    }
    const subs = this.w.descendants(cls, MAX_SUBCLASSES);
    const down: { folder: string; owner: ClassInfo }[] = [];
    for (const c of subs.list) {
      const folder = folderOf(c);
      if (folder !== null) down.push({ folder, owner: c });
    }
    return { own, down, cut: subs.cut };
  }

  // Explicit renders in each method, then the implicit view of every
  // action that names no template.
  private renders(app: App, cls: ClassInfo, folderOf: (c: ClassInfo) => string | null, actions: { id: string; def: { name: string; line: number }; file: string }[]): void {
    const explicit = new Set<string>();
    const views = this.w.views(app);
    const byMethod = this.rendersIn(cls.file);
    let folders: ReturnType<Resolver["viewFolders"]> | null = null;
    const lookup = () => (folders ??= this.viewFolders(app, cls, folderOf));
    const own = folderOf(cls) ?? underscore(cls.name);
    for (const m of this.w.ownMethods(cls)) {
      if (m.file !== cls.file) continue;
      for (const f of byMethod.get(m.id) ?? []) {
        if (f.mode === "other") continue;
        const site = { file: cls.file, line: f.line, column: f.column };
        if (f.value === null) {
          this.unknown(site, { file: cls.file }, "dynamic", ["renders"], null, "a render of a computed template name");
          explicit.add(m.id);
          continue;
        }
        const v = f.value;
        if (f.mode !== "partial") explicit.add(m.id);
        if (f.mode === "component") {
          const hit = this.w.resolveConst(v, cls.name, app);
          if (hit) this.edge(m.id, hit.id, "renders", app, this.ev("template-literal", "likely", site, RULES.views, `renders the component ${hit.name}, found by the autoload convention`));
          else {
            const nf = this.notFound(v, `render ${strip(v)}.new names ${strip(v)}`);
            this.unknown(site, { file: cls.file }, nf.gap, ["renders"], nf.name, nf.note);
          }
          continue;
        }
        const quoted = JSON.stringify(v.slice(0, 80));
        // A name with a folder is relative to app/views (an action name never is).
        if (f.mode !== "action" && v.includes("/")) {
          const cut = v.lastIndexOf("/");
          const logical = f.mode === "partial" ? `${v.slice(0, cut)}/_${v.slice(cut + 1)}` : v;
          if (!this.viewEdges(app, m.id, views.get(keptName(logical)) ?? [], site, "template-literal", "likely", `the view is found by the app/views folder convention for ${quoted}`)) this.missingView(app, m.id, logical, site, "template-literal");
          continue;
        }
        const leaf = f.mode === "partial" ? `_${v}` : v;
        if (!this.folderEdges(app, cls, m.id, leaf, lookup(), views, site, "template-literal", quoted)) this.missingView(app, m.id, `${own}/${leaf}`, site, "template-literal");
      }
    }
    for (const m of actions) {
      if (explicit.has(m.id)) continue;
      this.folderEdges(app, cls, m.id, m.def.name, lookup(), views, { file: m.file, line: m.def.line, column: 0 }, "template-implicit", null);
    }
  }

  // Links a method to the view named `leaf` in the first of its own
  // folders that has it (likely) and in each subclass folder that has it
  // (possible). Returns whether any view was found.
  private folderEdges(app: App, cls: ClassInfo, from: string, leaf: string, folders: ReturnType<Resolver["viewFolders"]>, views: Map<string, string[]>, site: Site, kind: "template-literal" | "template-implicit", quoted: string | null): boolean {
    let found = false;
    for (const { folder, owner } of folders.own) {
      const files = views.get(keptName(`${folder}/${leaf}`)) ?? [];
      if (files.length === 0) continue;
      const where = owner.id === cls.id ? "" : ` in the folder of ${owner.name}, which ${cls.name} inherits from`;
      const note = quoted !== null ? `the view is found by the app/views folder convention for ${quoted}${where}` : `Rails renders app/views/${folder}/${leaf} when the action does not render another template${where}`;
      found = this.viewEdges(app, from, files, site, kind, "likely", note) || found;
      break;
    }
    for (const { folder, owner } of folders.down) {
      const files = views.get(keptName(`${folder}/${leaf}`)) ?? [];
      if (files.length === 0) continue;
      found = this.viewEdges(app, from, files, site, kind, "possible", `rendered on an instance of ${owner.name}, which inherits from ${cls.name}; Rails looks the view up in that folder first`) || found;
    }
    // Once per class: past the cap, views in the other subclasses' folders are not searched.
    if (folders.cut && !this.viewCapped.has(cls.id)) {
      this.viewCapped.add(cls.id);
      this.unknown({ file: cls.file, line: cls.line, column: 0 }, { file: cls.file }, "fan-out-capped", ["renders"], cls.name, `${cls.name} has more than ${MAX_SUBCLASSES} subclasses, or subclasses more than ${MAX_CHAIN} levels down; the views of the rest are not searched for what its methods render`);
    }
    return found;
  }

  private viewEdges(app: App, from: string, files: readonly string[], site: Site, kind: "template-literal" | "template-implicit", tier: Tier, note: string): boolean {
    const several = files.length > 1 ? `; one of ${files.length} views of this name, picked by the request format` : "";
    for (const f of files) this.edge(from, this.template(app, f), "renders", app, this.ev(kind, tier, site, RULES.views, `${note}${several}`));
    return files.length > 0;
  }

  private missingView(app: App, from: string, logical: string, site: Site, kind: "template-literal" | "template-implicit"): void {
    this.edge(from, this.missingTemplate(app, logical), "renders", app, this.ev(kind, "likely", site, RULES.views, `the template is named in the source and no such view file exists`));
    this.unknown(site, { file: site.file }, "miss", ["renders"], logical, `no view file under app/views matches ${logical}`);
  }

  // ---------- mailers ----------

  private mailerClasses = new Map<string, { cls: ClassInfo; app: App }>();

  private mailers(): void {
    for (const app of this.w.apps) {
      for (const cls of this.classesUnder(app, "app/mailers/")) {
        const reach = this.w.reaches(cls, MAILER_ROOTS);
        if (reach === "cut") this.chainCut(cls, ["enqueues"], "a mailer");
        if (!reach || reach === "cut" || cls.name === "ApplicationMailer") continue;
        this.mailerClasses.set(cls.id, { cls, app });
        const site = { file: cls.file, line: cls.line, column: 0 };
        this.role(cls.id, "mailer", null, app, this.ev("role-base", "likely", site, RULES.mailers, this.baseNote(cls, reach.via)));
        const methods = this.w.ownMethods(cls).filter((m) => m.file === cls.file && this.w.isPublic(cls, m.def, m.file));
        this.renders(app, cls, mailerFolder, methods);
      }
    }
  }

  // ---------- models and associations ----------

  private models_(): void {
    for (const app of this.w.apps) {
      for (const cls of this.classesUnder(app, "app/models/")) {
        if (cls.file.includes("/concerns/")) continue;
        const reach = this.w.reaches(cls, MODEL_ROOTS);
        if (!reach || reach === "cut" || this.isAbstract(cls)) continue;
        this.models.set(cls.id, { cls, app });
        this.role(cls.id, "model", null, app, this.ev("role-base", "likely", { file: cls.file, line: cls.line, column: 0 }, RULES.models, this.baseNote(cls, reach.via)));
      }
    }
    for (const { cls, app } of this.models.values()) {
      const t = this.tableFor(cls, app, 0);
      if (t) this.edge(cls.id, this.table(app, t.table, null), "maps_to", app, this.ev("declaration", t.tier, t.site, RULES.models, t.note));
      this.associations(cls, app);
    }
  }

  private isAbstract(cls: ClassInfo): boolean {
    return this.w.byClass(cls.file, "abstract").has(cls.line);
  }

  // The table a model maps to: `self.table_name =` (certain), the table of
  // its base model (single table inheritance), or the pluralised class name.
  private tableFor(cls: ClassInfo, app: App, depth: number): { table: string; tier: Tier; note: string | null; site: Site } | null {
    if (this.tableOf.has(cls.id)) return this.tableOf.get(cls.id) ?? null;
    const site = { file: cls.file, line: cls.line, column: 0 };
    let result: { table: string; tier: Tier; note: string | null; site: Site } | null = null;
    const named = (this.w.byClass(cls.file, "table-name").get(cls.line) ?? [])[0] as TableNameFact | undefined;
    if (named) {
      const s = { file: cls.file, line: named.line, column: named.column };
      if (named.value === null) this.unknown(s, { file: cls.file }, "dynamic", ["maps_to"], cls.name, `${cls.name} sets a computed table name`);
      else result = { table: named.value, tier: "certain", note: null, site: s };
    } else {
      const base = cls.base ? this.w.resolveConst(cls.base, cls.def.owner ?? null, app) : null;
      if (base && this.models.has(base.id) && depth < 8) {
        const t = this.tableFor(base, app, depth + 1);
        if (t) result = { table: t.table, tier: weakest(t.tier, "likely"), note: `single table inheritance: ${cls.name} uses the table of ${base.name}`, site };
      } else {
        const ns = cls.name.includes("::") ? "; a table_name_prefix on its module is not read" : "";
        result = { table: tableize(cls.name), tier: "likely", note: `the table name comes from pluralising ${demodulize(cls.name)}; custom inflections are not read${ns}`, site };
      }
    }
    this.tableOf.set(cls.id, result);
    return result;
  }

  private associations(cls: ClassInfo, app: App): void {
    for (const f of (this.w.byClass(cls.file, "assoc").get(cls.line) ?? []) as AssocFact[]) {
      const site = { file: cls.file, line: f.line, column: f.column };
      if (f.name === null || f.classNameDynamic) {
        this.unknown(site, { file: cls.file }, "dynamic", ["uses_type"], null, `a ${f.macro} with a computed name or class`);
        continue;
      }
      if (f.polymorphic) {
        this.unknown(site, { file: cls.file }, "dynamic", ["uses_type"], f.name, `${f.macro} :${f.name} is polymorphic: the class comes from the data`);
        continue;
      }
      const r = this.assocTarget(cls, app, f, 0);
      if ("gap" in r) {
        this.unknown(site, { file: cls.file }, r.gap, ["uses_type"], r.name, r.note);
        continue;
      }
      this.edge(cls.id, r.hit.id, "uses_type", app, this.ev("association", "likely", site, RULES.associations, `${r.how}; the class is found by the autoload convention`));
    }
  }

  // The class an association names: its `class_name:`; for a `through:`
  // association, the class of the source association (`source:`, else the
  // association's own name, singular then plural) on the through model;
  // else the class named after the association by Rails' convention.
  private assocTarget(cls: ClassInfo, app: App, f: AssocFact, depth: number): { hit: ClassInfo; how: string } | { gap: Cause; name: string | null; note: string } {
    const name = f.name ?? "";
    if (f.className !== null) {
      const hit = this.w.resolveConst(f.className, cls.name, app);
      return hit ? { hit, how: `class_name names ${f.className}` } : this.notFound(f.className, `${f.macro} :${name} names ${f.className}`);
    }
    if (f.through !== null) {
      const chain = { gap: "unsupported-rule" as Cause, name: `${name} through ${f.through}`, note: `${f.macro} :${name} goes through :${f.through}, and the plugin could not follow that chain to a class` };
      if (depth >= MAX_THROUGH) return chain;
      const via = this.assocsOf(cls).find((a) => a.name === f.through);
      const mid = via ? this.assocTarget(cls, app, via, depth + 1) : null;
      if (!mid || !("hit" in mid)) return chain;
      const names = f.source !== null ? [f.source] : [singularize(name), name];
      const source = this.assocsOf(mid.hit).find((a) => a.name !== null && names.includes(a.name));
      if (!source || source.name === null) return chain;
      if (source.polymorphic) {
        // A polymorphic source names its class with `source_type:`.
        const typed = f.sourceType !== null ? this.w.resolveConst(f.sourceType, cls.name, app) : null;
        return typed ? { hit: typed, how: `${f.macro} :${name} goes through :${f.through} to the polymorphic ${source.name} association of ${mid.hit.name}, typed ${f.sourceType}` } : chain;
      }
      const end = this.assocTarget(mid.hit, app, source, depth + 1);
      if (!("hit" in end)) return chain;
      return { hit: end.hit, how: `${f.macro} :${name} goes through :${f.through} to the ${source.name} association of ${mid.hit.name}` };
    }
    const plural = f.macro === "has_many" || f.macro === "has_and_belongs_to_many";
    const target = plural ? classify(name) : camelize(name);
    const hit = this.w.resolveConst(target, cls.name, app);
    return hit ? { hit, how: `${f.macro} :${name} names ${target} by the Rails naming convention` } : this.notFound(target, `${f.macro} :${name} names ${target}`);
  }

  // A class name no class of the repository defines: outside the
  // repository when its namespace is defined nowhere in it (a gem's
  // `Noticed::Notification`), else a miss.
  private notFound(name: string, what: string): { gap: Cause; name: string; note: string } {
    const head = strip(name).split("::")[0] ?? "";
    if (strip(name).includes("::") && !this.w.classesByName.has(head)) return { gap: "external", name, note: `${what}, from the namespace ${head}, which the repository does not define` };
    return { gap: "miss", name, note: `${what}, which no class in the repository defines` };
  }

  private assocsOf(cls: ClassInfo): AssocFact[] {
    return (this.w.byClass(cls.file, "assoc").get(cls.line) ?? []) as AssocFact[];
  }

  // ---------- migrations ----------

  private migrations(): void {
    const byTable = new Map<string, { cls: ClassInfo; app: App }[]>();
    for (const m of this.models.values()) {
      const t = this.tableOf.get(m.cls.id);
      if (!t) continue;
      const k = `${m.app.id}\0${t.table}`;
      (byTable.get(k) ?? byTable.set(k, []).get(k))?.push(m);
    }
    for (const app of this.w.apps) {
      for (const file of this.filesOf(app, "db/migrate/")) {
        if (file.slice(under(app.root, "db/migrate/").length).includes("/")) continue;
        this.role(file, "migration", null, app, this.ev("role-path", "certain", { file, line: 1, column: 0 }, RULES.migrations, null));
        for (const f of this.factsOfKind(file, "migration-op") as MigrationOpFact[]) {
          const site = { file, line: f.line, column: f.column };
          const name = opName(f);
          const op = this.entity({ kind: "migration_operation", id: entityId(PLUGIN, app.id, "migration_operation", `${file}:${f.line}:${f.column}`), plugin: PLUGIN, app: app.id, name, site, file, detail: f.op });
          if (f.table === null) {
            this.unknown(site, { file }, "dynamic", ["changes_schema"], f.op, `a ${f.op} with a computed table name`);
            continue;
          }
          for (const table of f.op === "rename_table" && f.to ? [f.table, f.to] : [f.table]) {
            const tid = this.table(app, table, f.op === "create_table" || f.op === "create_join_table" ? site : null);
            this.edge(file, tid, "changes_schema", app, this.ev("declaration", "certain", site, RULES.migrations, null, null, [op.id]));
            for (const m of byTable.get(`${app.id}\0${table}`) ?? []) {
              const t = this.tableOf.get(m.cls.id);
              const tier = t?.tier ?? "likely";
              this.edge(file, m.cls.id, "changes_schema", app, this.ev("declaration", tier, site, RULES.migrations, tier === "certain" ? null : `${m.cls.name} maps to ${table} by a Rails convention: ${t?.note ?? ""}`, null, [op.id, tid]));
            }
          }
        }
      }
    }
  }

  // ---------- jobs ----------

  private jobs(): void {
    const jobs = new Map<string, { cls: ClassInfo; app: App }>();
    for (const app of this.w.apps) {
      const candidates = [...this.classesUnder(app, "app/jobs/"), ...this.classesUnder(app, "app/workers/")];
      const bases = new Set(candidates.map((c) => (c.base ? this.w.resolveConst(c.base, c.def.owner ?? null, app)?.id : undefined)).filter((x): x is string => x !== undefined));
      for (const cls of candidates) {
        const found = this.w.reaches(cls, JOB_ROOTS);
        const reach = found === "cut" ? null : found;
        const sidekiq = this.w.includesAny(cls, SIDEKIQ);
        if (found === "cut" && !sidekiq) this.chainCut(cls, ["enqueues"], "a job");
        if (!reach && !sidekiq) continue;
        // An abstract base job (ApplicationJob): the base of other jobs with no perform of its own.
        if (bases.has(cls.id) && !this.w.ownMethods(cls).some((m) => m.def.name === "perform")) continue;
        jobs.set(cls.id, { cls, app });
        const site = { file: cls.file, line: cls.line, column: 0 };
        const note = sidekiq ? `${cls.name} includes ${sidekiq}, named in the source; Ruby has no import that proves the constant` : this.baseNote(cls, reach?.via ?? []);
        this.role(cls.id, "job", sidekiq ? "sidekiq" : "active_job", app, this.ev("role-base", "likely", site, RULES.jobs, note));
        this.entity({ kind: "job", id: entityId(PLUGIN, app.id, "job", cls.name), plugin: PLUGIN, app: app.id, name: cls.name, site, file: cls.file, detail: sidekiq ? "sidekiq" : "active_job" });
      }
    }
    for (const file of this.w.index.factFiles()) {
      const app = this.w.appOf(file);
      if (!app) continue;
      for (const f of this.factsOfKind(file, "enqueue") as EnqueueFact[]) {
        const site = { file, line: f.line, column: f.column };
        const cls = this.w.resolveConst(f.target, this.w.nestingAt(file, f.line), app);
        if (!cls) {
          this.unknown(site, { file }, "miss", ["enqueues"], strip(f.target), `${strip(f.target)}.${f.via} names a class no file in the repository defines`);
          continue;
        }
        const job = jobs.get(cls.id);
        if (!job) continue;
        const from = this.w.symbolAt(file, f.line);
        const perform = this.w.findMethod(cls, "perform");
        if ("id" in perform) this.edge(from, perform.id, "enqueues", app, this.ev("enqueue", "likely", site, RULES.jobs, `${cls.name} is found by the autoload convention; ${f.via} runs its perform method`));
        else {
          this.edge(from, entityId(PLUGIN, job.app.id, "job", cls.name), "enqueues", app, this.ev("enqueue", "likely", site, RULES.jobs, `${cls.name} is found by the autoload convention`));
          this.unknown(site, { file: cls.file }, missCause(perform), ["enqueues"], `${cls.name}#perform`, perform.status === "unresolved" ? perform.note : `${cls.name} has no perform method`);
        }
      }
      for (const f of this.factsOfKind(file, "mail") as MailFact[]) {
        const site = { file, line: f.line, column: f.column };
        const cls = this.w.resolveConst(f.target, this.w.nestingAt(file, f.line), app);
        if (!cls || !this.mailerClasses.has(cls.id)) {
          if (!cls) this.unknown(site, { file }, "miss", ["enqueues"], strip(f.target), `${strip(f.target)}.${f.action} names a mailer no file in the repository defines`);
          continue;
        }
        const hit = this.w.findMethod(cls, f.action);
        if (!("id" in hit)) {
          this.unknown(site, { file: cls.file }, missCause(hit), ["enqueues"], `${cls.name}#${f.action}`, hit.status === "unresolved" ? hit.note : `${cls.name} has no ${f.action} method`);
          continue;
        }
        this.edge(this.w.symbolAt(file, f.line), hit.id, "enqueues", app, this.ev("enqueue", "likely", site, RULES.mailers, `${cls.name} is found by the autoload convention; ${f.via} sends the mail it builds`));
      }
    }
  }

  // ---------- config ----------

  private config(): void {
    const key = (app: App, name: string, detail: string, site: Site | null) => {
      const id = entityId(PLUGIN, app.id, "config_key", name);
      const kept = this.entityById.get(id);
      if (kept && kept.kind === "config_key" && kept.site === null && site !== null) kept.site = site;
      return this.entity({ kind: "config_key", id, plugin: PLUGIN, app: app.id, name, site, file: null, detail }).id;
    };
    const files = this.w.index.factFiles();
    for (const file of files) {
      const app = this.w.appOf(file);
      if (!app) continue;
      const rel = relTo(app.root, file) as string;
      const configFile = rel === "config/application.rb" || rel.startsWith("config/environments/") || rel.startsWith("config/initializers/");
      if (!configFile) continue;
      for (const f of this.factsOfKind(file, "config-define") as ConfigDefineFact[]) {
        const site = { file, line: f.line, column: f.column };
        this.edge(file, key(app, `config.${f.key}`, "rails", site), "defines_config", app, this.ev("config-define", "certain", site, RULES.config, null));
      }
    }
    for (const file of files) {
      const app = this.w.appOf(file);
      if (!app) continue;
      for (const f of this.factsOfKind(file, "config-read") as ConfigReadFact[]) {
        const site = { file, line: f.line, column: f.column };
        if (f.key === null) {
          this.unknown(site, { file }, "dynamic", ["reads_config"], null, f.source === "env" ? "an ENV read with a computed key" : "a config read with a computed key");
          continue;
        }
        const name = f.source === "env" ? `ENV["${f.key}"]` : `config.${f.key}`;
        this.edge(this.w.symbolAt(file, f.line), key(app, name, f.source, null), "reads_config", app, this.ev("config-read", "certain", site, RULES.config, null));
      }
    }
  }

  // ---------- tests ----------

  private tests(): void {
    const rspec = ["rspec-rails", "rspec", "rspec-core"].some((g) => this.w.index.declares("", "gems", g));
    const compiled = new Map<string, Compiled | null>();
    const compile = (r: Registration) => {
      if (!compiled.has(r.id)) compiled.set(r.id, r.pattern === null ? null : compilePattern(r.pattern));
      return compiled.get(r.id) ?? null;
    };
    // Registrations per application by their first literal segment, in
    // declaration order, with the ones that start with a slot apart.
    const indexes = new Map<string, { byFirst: Map<string, Registration[]>; open: Registration[]; order: Map<string, number> }>();
    const indexOf = (appId: string) => {
      let ix = indexes.get(appId);
      if (ix) return ix;
      ix = { byFirst: new Map(), open: [], order: new Map() };
      (this.regsByApp.get(appId) ?? []).forEach((r, i) => {
        (ix as { order: Map<string, number> }).order.set(r.id, i);
        const c = compile(r);
        if (!c) return;
        const firsts = firstLiterals(c);
        if (firsts === null) (ix as { open: Registration[] }).open.push(r);
        else for (const f of new Set(firsts)) ((ix as { byFirst: Map<string, Registration[]> }).byFirst.get(f) ?? (ix as { byFirst: Map<string, Registration[]> }).byFirst.set(f, []).get(f))?.push(r);
      });
      indexes.set(appId, ix);
      return ix;
    };
    // The first registration of an application, in declaration order, that
    // takes the method and whose pattern matches the request, following
    // mounts into engines.
    const route = (app: App, method: string, req: string[], depth = 0): Registration | null => {
      const ix = indexOf(app.id);
      // The candidates with the request's first segment and the ones that
      // start with a slot, merged in declaration order (both lists are in
      // it already); every candidate draws on the budget.
      const a = ix.byFirst.get(req[0] ?? "") ?? [];
      const b = ix.open;
      const order = (r: Registration) => ix.order.get(r.id) ?? 0;
      for (let i = 0, j = 0; i < a.length || j < b.length; ) {
        if (!this.budget.take()) return null;
        const r = j >= b.length || (i < a.length && order(a[i] as Registration) < order(b[j] as Registration)) ? (a[i++] as Registration) : (b[j++] as Registration);
        const c = compile(r);
        if (!c) continue;
        const engine = this.mountTarget.get(r.id);
        if (engine && depth < 2) {
          const rest = stripPrefix(c, req, this.budget);
          if (rest === null) continue;
          const hit = route(engine, method, rest, depth + 1);
          if (hit) return hit;
          continue;
        }
        if (!r.methods.includes("*") && !r.methods.includes(method)) continue;
        if (matches(c, req, this.budget)) return r;
      }
      return null;
    };

    for (const app of this.w.apps) {
      for (const file of this.w.rubyPaths) {
        if (this.w.appOf(file) !== app) continue;
        const rel = relTo(app.root, file) as string;
        const spec = rspec && rel.startsWith("spec/") && rel.endsWith("_spec.rb");
        const minitest = rel.startsWith("test/") && rel.endsWith("_test.rb");
        if (!spec && !minitest) continue;
        const fileSite = { file, line: 1, column: 0 };
        this.role(file, "test", spec ? "rspec" : "minitest", app, this.ev("role-path", "certain", fileSite, RULES.tests, null));
        for (const c of this.w.classesIn(file)) {
          if (c.module || !isTestBase(c.base)) continue;
          this.role(c.id, "test", "minitest", app, this.ev("role-base", "likely", { file, line: c.line, column: 0 }, RULES.tests, `${c.name} is based on ${strip(c.base as string)}, a test case class named in the source`));
        }
        this.testLinks(app, file, route);
      }
    }
  }

  private testLinks(app: App, file: string, route: (app: App, method: string, req: string[]) => Registration | null): void {
    const facts = this.w.facts(file);
    const describes = facts.filter((f): f is DescribeFact => f.kind === "describe");
    for (const d of describes) {
      const cls = this.w.resolveConst(d.subject, null, app);
      if (!cls) continue;
      this.edge(file, cls.id, "tests", app, this.ev("test-subject", "possible", { file, line: d.line, column: d.column }, RULES.tests, "the test names the class it describes; it does not prove which of its code runs"), { category: "subject" });
    }
    // The controller a test of one names: the innermost `describe
    // XController`, or a minitest controller test class `XControllerTest`.
    const controllerAt = (line: number): ClassInfo | null => {
      let best: DescribeFact | null = null;
      for (const d of describes) if (d.line <= line && d.endLine >= line && d.subject.endsWith("Controller") && (!best || d.line >= best.line)) best = d;
      if (best) return this.w.resolveConst(best.subject, null, app);
      const nest = this.w.nestingAt(file, line);
      const holder = nest ? this.w.classesIn(file).find((c) => c.name === nest) : undefined;
      if (holder && holder.name.endsWith("ControllerTest") && holder.base !== null && CONTROLLER_TEST.has(strip(holder.base))) return this.w.resolveConst(holder.name.slice(0, -"Test".length), null, app);
      return null;
    };
    for (const f of facts) {
      if (this.budget.spent) return;
      if (f.kind === "request") this.requestLink(app, file, f, route, controllerAt);
      else if (f.kind === "route-name") this.routeNameLink(app, file, f);
    }
  }

  private requestLink(app: App, file: string, f: RequestFact, route: (app: App, method: string, req: string[]) => Registration | null, controllerAt: (line: number) => ClassInfo | null): void {
    const site = { file, line: f.line, column: f.column };
    const from = this.w.symbolAt(file, f.line);
    if (f.path.t === "str") {
      const req = requestSegments(f.path.v);
      if (req === null) {
        this.unknown(site, { file }, "budget", ["tests"], null, "a request path longer than the matcher reads");
        return;
      }
      const r = route(app, f.verb, req);
      if (!r) return;
      this.edge(from, r.id, "tests", app, this.ev("test-route-request", "likely", site, RULES.tests, "the test requests a literal path that matches this route; it does not prove the route ran", null, [r.id]), { category: "route-request" });
      return;
    }
    if (f.path.t === "sym") {
      const cls = controllerAt(f.line);
      if (!cls) return;
      const hit = this.w.findMethod(cls, f.path.v);
      if (!("id" in hit)) return;
      for (const r of this.regsByHandler.get(hit.id) ?? []) {
        if (!r.methods.includes("*") && !r.methods.includes(f.verb)) continue;
        this.edge(from, r.id, "tests", app, this.ev("test-route-request", "likely", site, RULES.tests, `a controller test calls ${f.path.v} of ${cls.name} by name; it does not prove the route ran`, null, [r.id]), { category: "route-request" });
      }
      return;
    }
    this.unknown(site, { file }, "dynamic", ["tests"], null, "a test request to a computed path");
  }

  private routeNameLink(app: App, file: string, f: RouteNameFact): void {
    const all = this.regsByName.get(`${app.id}\0${f.name}`) ?? [];
    if (all.length === 0) return;
    const pick = f.verb !== null ? all.filter((r) => r.methods.includes(f.verb as string) || r.methods.includes("*")) : all.filter((r) => r.methods.includes("GET"));
    const site = { file, line: f.line, column: f.column };
    const from = this.w.symbolAt(file, f.line);
    for (const r of pick.length > 0 ? pick : all) {
      this.edge(from, r.id, "tests", app, this.ev("test-route-name", "likely", site, RULES.tests, `the test names this route by its URL helper ${f.name}; it does not prove the route ran`, null, [r.id]), { category: "route-name" });
    }
  }
}

// A migration operation as the brief names it: "create_table posts",
// "add_column posts.title", "rename_table posts to articles".
function opName(f: MigrationOpFact): string {
  const t = f.table ?? "(computed)";
  if (f.op === "rename_table") return `rename_table ${t} to ${f.to ?? "(computed)"}`;
  if (f.op === "rename_column") return `rename_column ${t}.${f.field ?? "(computed)"} to ${f.to ?? "(computed)"}`;
  if (f.field !== null && f.op !== "add_foreign_key" && f.op !== "remove_foreign_key") return `${f.op} ${t}.${f.field}`;
  return `${f.op} ${t}`;
}
