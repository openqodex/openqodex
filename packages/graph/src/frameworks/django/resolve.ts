// The Django plugin's detection and resolution: applications from settings
// modules, URL tables walked from each application's ROOT_URLCONF through
// `include()` with the prefix carried, views bound through the symbol
// resolver, templates by literal name, models, fields and migrations,
// management commands, template tags, signals, settings keys, and tests.
//
// API identity: a URL entry, a render call, a model base or a signal
// receiver counts only when its name binds, through the file's own imports,
// to Django's module (`django.urls.path`, `django.db.models.Model`). The
// `django` dependency in a manifest enables the rules; it never proves a
// name. Nothing is imported or executed: settings are read as literals.
import { posix } from "node:path";
import type { Tier } from "../../model/records.js";
import type { CallFact, DefFact, GraphNode } from "../../types.js";
import { appId, entityId } from "../plugin.js";
import type { Detection, Entity, FrameworkEdge, FrameworkEdgeKind, FrameworkEvidence, FrameworkEvidenceKind, FrameworkUnknown, Lookup, PluginIndex, PluginOutput, Registration, Role, RoleAssignment, Site } from "../plugin.js";
import { keptName } from "../shared/kept.js";
import { isDynamic } from "../shared/literals.js";
import type { Lit } from "../shared/literals.js";
import { HTTP_METHODS } from "./facts.js";
import type { DjangoFact, Ref } from "./facts.js";
import { COMPUTED_PART, MAX_REQUEST, joinTokens, matchTokens, requestPath, routePart } from "./routes.js";
import type { Budget, Part, Tok } from "./routes.js";

export const PLUGIN = "django";
export const MAX_INCLUDE_DEPTH = 8;
export const MAX_FAN_OUT = 32;
// Registrations one application may hold: includes multiply (a module
// included 400 times that includes another 400 times), so the walk stops
// here and says so.
export const MAX_REGISTRATIONS_PER_APP = 10_000;
// URL entries the walk may visit for one application. Past it, the walk of
// that application stops with a gap of cause "budget".
export const MAX_WALK_STEPS = 200_000;
// The work one whole resolve may do: every URL entry the walk visits, every
// fact and class the later steps read, and every step of the matcher draws
// on it. Past it, each step stops and one gap per project says so.
export const MAX_RESOLVE_STEPS = 2_000_000;

type Index = PluginIndex<DjangoFact>;
type Of<K extends DjangoFact["kind"]> = Extract<DjangoFact, { kind: K }>;

const URL_FUNCTIONS = new Set(["django.urls.path", "django.urls.re_path", "django.conf.urls.url", "django.urls.conf.path", "django.urls.conf.re_path"]);
const INCLUDE_FUNCTIONS = new Set(["django.urls.include", "django.conf.urls.include", "django.urls.conf.include"]);
const RENDER_FUNCTIONS = new Set([
  "django.shortcuts.render",
  "django.shortcuts.render_to_response",
  "django.template.loader.render_to_string",
  "django.template.loader.get_template",
  "django.template.loader.select_template",
  "django.template.response.TemplateResponse",
  "django.template.response.SimpleTemplateResponse",
]);
const DJANGO_SIGNAL_MODULES = ["django.db.models.signals.", "django.core.signals.", "django.test.signals.", "django.contrib.auth.signals.", "django.db.backends.signals.", "django.contrib.sessions.signals."];
const DJANGO_SIGNAL_CLASSES = new Set(["django.dispatch.Signal", "django.dispatch.dispatcher.Signal"]);
const MODEL_BASES = new Set(["django.db.models.Model", "django.db.models.base.Model"]);
const RELATED_FIELDS = new Set(["ForeignKey", "OneToOneField", "ManyToManyField"]);
// Django's field classes whose names do not end in Field.
const FIELD_CLASSES = new Set(["ForeignKey", "ForeignObject", "GenericForeignKey", "GenericRelation"]);
// How many classes deep a repository field class is followed to Django's.
const MAX_FIELD_CHAIN = 8;

// Whether a dotted name of Django's own is one of its field classes: a
// class of django.db.models or of a contrib app named like Django names
// its fields.
function djangoField(name: string): boolean {
  if (!name.startsWith("django.db.models.") && !name.startsWith("django.contrib.")) return false;
  const tail = name.slice(name.lastIndexOf(".") + 1);
  return tail.endsWith("Field") || FIELD_CLASSES.has(tail);
}
const TEST_BASES = new Set(["django.test.TestCase", "django.test.SimpleTestCase", "django.test.TransactionTestCase", "django.test.LiveServerTestCase", "rest_framework.test.APITestCase", "rest_framework.test.APISimpleTestCase", "rest_framework.test.APITransactionTestCase", "unittest.TestCase"]);
const COMMAND_BASES = new Set(["django.core.management.base.BaseCommand", "django.core.management.BaseCommand", "django.core.management.base.AppCommand", "django.core.management.base.LabelCommand"]);
const REVERSE_FUNCTIONS = new Set(["django.urls.reverse", "django.urls.reverse_lazy", "django.shortcuts.resolve_url", "django.core.urlresolvers.reverse"]);
const DRF_ROUTERS = new Set(["rest_framework.routers.DefaultRouter", "rest_framework.routers.SimpleRouter"]);
// The actions Django REST framework's own viewset and mixin classes give.
const DRF_ACTIONS: Record<string, string[]> = {
  "rest_framework.viewsets.ModelViewSet": ["list", "create", "retrieve", "update", "partial_update", "destroy"],
  "rest_framework.viewsets.ReadOnlyModelViewSet": ["list", "retrieve"],
  "rest_framework.viewsets.ViewSet": [],
  "rest_framework.viewsets.GenericViewSet": [],
  "rest_framework.viewsets.ViewSetMixin": [],
  "rest_framework.mixins.ListModelMixin": ["list"],
  "rest_framework.mixins.CreateModelMixin": ["create"],
  "rest_framework.mixins.RetrieveModelMixin": ["retrieve"],
  "rest_framework.mixins.UpdateModelMixin": ["update", "partial_update"],
  "rest_framework.mixins.DestroyModelMixin": ["destroy"],
};
const VIEWSET_ACTIONS: [string, string, string][] = [
  ["list", "GET", "list"],
  ["create", "POST", "list"],
  ["retrieve", "GET", "detail"],
  ["update", "PUT", "detail"],
  ["partial_update", "PATCH", "detail"],
  ["destroy", "DELETE", "detail"],
];

// Path conventions, read with string operations on the path's parts.
const parts = (file: string) => file.split("/");

export function isTestPath(file: string): boolean {
  const p = parts(file);
  const base = p[p.length - 1] as string;
  const dir = p[p.length - 2];
  if (!base.endsWith(".py")) return false;
  return base === "tests.py" || base === "test.py" || base === "conftest.py" || base.startsWith("test_") || base.endsWith("_test.py") || base.endsWith("_tests.py") || dir === "tests" || dir === "test";
}

function isMigrationPath(file: string): boolean {
  const p = parts(file);
  return p.length >= 2 && p[p.length - 2] === "migrations" && (p[p.length - 1] as string).endsWith(".py");
}

// The command name of a file under management/commands/, or null.
function commandName(file: string): string | null {
  const p = parts(file);
  const base = p[p.length - 1] as string;
  if (p.length < 3 || p[p.length - 2] !== "commands" || p[p.length - 3] !== "management" || !base.endsWith(".py") || base.startsWith("_")) return null;
  return base.slice(0, -3);
}

// The names a template file answers to: the path after each `templates/` folder in it.
function templateNames(file: string): string[] {
  const out: string[] = [];
  const p = parts(file);
  for (let i = 0; i < p.length - 1; i++) if (p[i] === "templates") out.push(p.slice(i + 1).join("/"));
  return out;
}

export const RULES = {
  urls: { id: "django-urlpatterns", version: 1 },
  include: { id: "django-include", version: 1 },
  drf: { id: "django-drf-router", version: 1 },
  templates: { id: "django-templates", version: 1 },
  models: { id: "django-models", version: 1 },
  migrations: { id: "django-migrations", version: 1 },
  commands: { id: "django-commands", version: 1 },
  tags: { id: "django-template-tags", version: 1 },
  signals: { id: "django-signals", version: 1 },
  settings: { id: "django-settings", version: 1 },
  tests: { id: "django-tests", version: 1 },
} as const;

type Rule = (typeof RULES)[keyof typeof RULES];

// ---------- names through a file's own imports ----------

// The dotted name a reference stands for when its head is bound by an
// import of the file (`path` from `from django.urls import path` is
// "django.urls.path"); null when the head is defined in the file, bound by
// nothing, or by a relative import.
// Per file: the top-level names it defines, and what each imported head stands for.
type Heads = { defined: Set<string>; assigned: Set<string>; imported: Map<string, string> };
const headCache = new WeakMap<Index, Map<string, Heads | null>>();

function headsOf(index: Index, file: string): Heads | null {
  let byFile = headCache.get(index);
  if (!byFile) headCache.set(index, (byFile = new Map()));
  if (byFile.has(file)) return byFile.get(file) ?? null;
  const facts = index.languageFacts(file);
  let heads: Heads | null = null;
  if (facts) {
    // A name assigned at module level no longer proves its import; past the
    // cap on names read, no import of the module proves anything.
    const assignedFacts = index.factsOf(file).filter((f): f is Of<"assigned"> => f.kind === "assigned");
    if (assignedFacts.some((f) => !f.complete)) {
      byFile.set(file, null);
      return null;
    }
    const assigned = new Set(assignedFacts.flatMap((f) => f.names));
    heads = { defined: new Set(facts.defs.filter((d) => d.topLevel).map((d) => d.name)), assigned, imported: new Map() };
    for (const imp of facts.imports) {
      if (imp.scoped || imp.reexport || imp.spec.startsWith(".")) continue;
      for (const n of imp.names) heads.imported.set(n.local, `${imp.spec}.${n.imported}`);
      if (imp.namespace !== null) heads.imported.set(imp.namespace, imp.alias ? imp.spec : imp.namespace);
    }
  }
  byFile.set(file, heads);
  return heads;
}

// `at`: the line of a call written with `callee` (the dotted callee, the
// ref itself when absent). The import binds there only when the name is
// not reassigned at module level and nothing in the calling function (a
// parameter, a local, a nested definition, an import in the function)
// hides it at that call, as the language facts record the call.
export function canonical(index: Index, file: string, ref: Ref, at?: { line: number; callee?: Ref }): string | null {
  const heads = headsOf(index, file);
  const [head, ...rest] = ref;
  if (!heads || head === undefined || heads.defined.has(head) || heads.assigned.has(head)) return null;
  const base = heads.imported.get(head);
  if (base === undefined) return null;
  if (at && !boundAtUse(index, file, at.line, at.callee ?? ref)) return null;
  return [base, ...rest].join(".");
}

const callCache = new WeakMap<Index, Map<string, Map<number, CallFact[]>>>();

// Whether every call on the line written with this callee reads the
// module's binding of its head: a bare call no scope shadows, binds locally
// or by a function's own import; a call on a name receiver.
function boundAtUse(index: Index, file: string, line: number, callee: Ref): boolean {
  let byFile = callCache.get(index);
  if (!byFile) callCache.set(index, (byFile = new Map()));
  let byLine = byFile.get(file);
  if (!byLine) {
    byLine = new Map();
    for (const c of index.languageFacts(file)?.calls ?? []) (byLine.get(c.line) ?? byLine.set(c.line, []).get(c.line))?.push(c);
    byFile.set(file, byLine);
  }
  const name = callee[callee.length - 1] as string;
  const calls = (byLine.get(line) ?? []).filter((c) => c.name === name);
  if (calls.length === 0) return true; // no call recorded there (a multi-line call): the module-level check stands
  return calls.every((c) => (callee.length === 1 ? c.recv.kind === "none" && !c.shadowed && c.local === undefined && c.bound === undefined : c.recv.kind === "name" && c.recv.name === callee[0] && c.recv.bound === undefined));
}

// ---------- the plugin's resolve state ----------

class Out {
  roles: RoleAssignment[] = [];
  entities: Entity[] = [];
  edges: FrameworkEdge[] = [];
  unknowns: FrameworkUnknown[] = [];
  private entityIds = new Set<string>();
  private roleKeys = new Set<string>();
  private edgeKeys = new Set<string>();
  private gapKeys = new Set<string>();

  entity(e: Entity): string {
    if (!this.entityIds.has(e.id)) {
      this.entityIds.add(e.id);
      this.entities.push(e);
    }
    return e.id;
  }
  role(target: string, role: Role, detail: string | null, app: string | null, evidence: FrameworkEvidence): void {
    const k = `${target}\0${role}\0${detail}\0${app}`;
    if (this.roleKeys.has(k)) return;
    this.roleKeys.add(k);
    this.roles.push({ target, role, detail, app, evidence });
  }
  edge(e: FrameworkEdge): void {
    const k = `${e.kind}\0${e.from}\0${e.to}\0${e.evidence.site.file}:${e.evidence.site.line}:${e.evidence.site.column}\0${e.category ?? ""}`;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.edges.push(e);
  }
  gap(u: Omit<FrameworkUnknown, "plugin" | "count" | "exact"> & { count?: number | null; exact?: boolean }): void {
    // A module included many times reports each of its gaps once per scope.
    const k = `${u.site ? `${u.site.file}:${u.site.line}:${u.site.column}` : ""}\0${JSON.stringify(u.scope)}\0${u.cause}\0${u.note}`;
    if (this.gapKeys.has(k)) return;
    this.gapKeys.add(k);
    this.unknowns.push({ plugin: PLUGIN, count: null, exact: false, ...u });
  }
}

function ev(kind: FrameworkEvidenceKind, tier: Tier, site: Site, rule: Rule, note: string | null, via: FrameworkEvidence["via"] = null, premises: string[] = []): FrameworkEvidence {
  return { kind, tier, site, via, premises, rule: { id: rule.id, version: rule.version }, note: tier === "certain" ? null : (note ?? "found by a Django naming convention") };
}

const siteOf = (file: string, f: { line: number; column: number }): Site => ({ file, line: f.line, column: f.column });
const joinNote = (a: string | null, b: string) => (a ? `${a} ${b}` : b);
const show = (ref: Ref) => ref.join(".");

// Symbols of a file by what they are, built once per file.
type FileSymbols = { classes: Map<string, GraphNode>; functions: Map<string, GraphNode[]>; methods: Map<string, GraphNode[]> };
const symbolCache = new WeakMap<Index, Map<string, FileSymbols>>();

function symbolsOf(index: Index, file: string): FileSymbols {
  let byFile = symbolCache.get(index);
  if (!byFile) symbolCache.set(index, (byFile = new Map()));
  let fs = byFile.get(file);
  if (fs) return fs;
  fs = { classes: new Map(), functions: new Map(), methods: new Map() };
  for (const s of index.symbols(file)) {
    const local = s.id.slice(s.id.indexOf("#") + 1, s.id.lastIndexOf("@"));
    if (s.kind === "class" && local === s.name && !fs.classes.has(s.name)) fs.classes.set(s.name, s);
    else if (s.kind === "function" && local === s.name) (fs.functions.get(s.name) ?? fs.functions.set(s.name, []).get(s.name))?.push(s);
    else if (s.kind === "method") {
      const owner = local.slice(0, local.length - s.name.length - 1);
      if (owner !== "" && !owner.includes(".")) (fs.methods.get(owner) ?? fs.methods.set(owner, []).get(owner))?.push(s);
    }
  }
  byFile.set(file, fs);
  return fs;
}

// The symbol a definition of the language facts names: by its name and line, from a map built once per file.
const atCache = new WeakMap<Index, Map<string, Map<string, GraphNode>>>();
function symbolAt(index: Index, file: string, name: string, line: number): GraphNode | null {
  let byFile = atCache.get(index);
  if (!byFile) atCache.set(index, (byFile = new Map()));
  let m = byFile.get(file);
  if (!m) {
    m = new Map();
    for (const s of index.symbols(file)) if (!m.has(`${s.name}\0${s.startLine}`)) m.set(`${s.name}\0${s.startLine}`, s);
    byFile.set(file, m);
  }
  return m.get(`${name}\0${line}`) ?? null;
}

// The class definition of the language facts a class symbol stands for: by
// its name and line, from a map built once per file.
const defCache = new WeakMap<Index, Map<string, Map<string, DefFact>>>();
function classDef(index: Index, cls: GraphNode): DefFact | null {
  let byFile = defCache.get(index);
  if (!byFile) defCache.set(index, (byFile = new Map()));
  let m = byFile.get(cls.file);
  if (!m) {
    m = new Map();
    for (const d of index.languageFacts(cls.file)?.defs ?? []) if (d.kind === "class" && !m.has(`${d.name}\0${d.line}`)) m.set(`${d.name}\0${d.line}`, d);
    byFile.set(cls.file, m);
  }
  return m.get(`${cls.name}\0${cls.startLine}`) ?? null;
}

function methodsOf(index: Index, cls: GraphNode): GraphNode[] {
  return symbolsOf(index, cls.file).methods.get(cls.name) ?? [];
}

function classIn(index: Index, file: string, name: string): GraphNode | null {
  return symbolsOf(index, file).classes.get(name) ?? null;
}

function functionIn(index: Index, file: string, name: string, near: number): GraphNode | null {
  const hits = symbolsOf(index, file).functions.get(name) ?? [];
  let best: GraphNode | null = null;
  for (const h of hits) if (!best || Math.abs(h.startLine - near) < Math.abs(best.startLine - near)) best = h;
  return best;
}

// The dotted name of a module file relative to its project ("mysite/settings.py" is "mysite.settings").
function moduleName(index: Index, file: string): string {
  const project = index.projectOf(file);
  const rel = project === "" ? file : file.slice(project.length + 1);
  return rel.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
}

// ---------- detection ----------

export function detectDjango(index: Index): Detection[] {
  const apps: Detection[] = [];
  const paths = index.paths();
  for (const file of index.factFiles()) {
    const project = index.projectOf(file);
    if (!index.declares(project, "python", "django")) continue;
    const settings = index.factsOf(file).filter((f): f is Of<"setting"> => f.kind === "setting");
    const installed = settings.find((s) => s.name === "INSTALLED_APPS");
    const urlconf = settings.find((s) => s.name === "ROOT_URLCONF");
    const marker = installed ?? urlconf;
    if (!marker) continue;
    const manage = paths.filter((p) => (p === "manage.py" || p.endsWith("/manage.py")) && index.projectOf(p) === project).sort((a, b) => a.length - b.length)[0];
    const root = manage ? posix.dirname(manage) : posix.dirname(posix.dirname(file));
    const evidence = [{ file, line: marker.line, note: `${marker.name} is assigned in this settings module` }];
    if (manage) evidence.push({ file: manage, line: 1, note: "manage.py marks the Django project" });
    apps.push({
      id: appId(PLUGIN, file, marker.line),
      name: moduleName(index, file),
      project,
      root: root === "." ? "" : root,
      site: siteOf(file, marker),
      evidence,
      version: null,
      data: { settings: file, rootUrlconf: urlconf ? urlconf.value : null, rootUrlconfLine: urlconf?.line ?? null },
    });
  }
  return apps.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- resolution ----------

export function resolveDjango(index: Index, apps: readonly Detection[]): PluginOutput {
  const out = new Out();
  const appsByProject = new Map<string, Detection[]>();
  for (const a of apps) (appsByProject.get(a.project) ?? appsByProject.set(a.project, []).get(a.project))?.push(a);
  // The one application a file belongs to, when its project has exactly one.
  const appOf = (file: string): string | null => {
    const list = appsByProject.get(index.projectOf(file)) ?? [];
    return list.length === 1 ? (list[0] as Detection).id : null;
  };
  const enabled = (file: string) => index.declares(index.projectOf(file), "python", "django");
  // Facts of a file by kind, sorted once per file.
  const byKind = new Map<string, Map<string, DjangoFact[]>>();
  const factsOf = <K extends DjangoFact["kind"]>(file: string, kind: K): Of<K>[] => {
    let kinds = byKind.get(file);
    if (!kinds) {
      kinds = new Map();
      for (const f of index.factsOf(file)) (kinds.get(f.kind) ?? kinds.set(f.kind, []).get(f.kind))?.push(f);
      byKind.set(file, kinds);
    }
    return (kinds.get(kind) ?? []) as Of<K>[];
  };

  // Facts of a kind grouped by the class that owns them, once per file.
  const ownerCache = new Map<string, Map<string, (Of<"field"> | Of<"db_table">)[]>>();
  function byOwner(file: string, kind: "field"): Map<string, Of<"field">[]>;
  function byOwner(file: string, kind: "db_table"): Map<string, Of<"db_table">[]>;
  function byOwner(file: string, kind: "field" | "db_table"): Map<string, (Of<"field"> | Of<"db_table">)[]> {
    const k = `${kind}\0${file}`;
    let m = ownerCache.get(k);
    if (!m) {
      m = new Map();
      for (const f of factsOf(file, kind)) (m.get(f.owner) ?? m.set(f.owner, []).get(f.owner))?.push(f);
      ownerCache.set(k, m);
    }
    return m;
  }
  // URL entries of a file by the list and the entry they sit in, once per file.
  const entryCache = new Map<string, Map<string, { f: Of<"url">; i: number }[]>>();
  const entriesOf = (file: string, list: string, parent: number): { f: Of<"url">; i: number }[] => {
    let m = entryCache.get(file);
    if (!m) {
      m = new Map();
      index.factsOf(file).forEach((f, i) => {
        if (f.kind !== "url") return;
        const k = `${f.list}\0${f.parent}`;
        (m?.get(k) ?? m?.set(k, []).get(k))?.push({ f, i });
      });
      entryCache.set(file, m);
    }
    return m.get(`${list}\0${parent}`) ?? [];
  };
  // Whether the file has URL entries in a list of this name.
  const listCache = new Map<string, Set<string>>();
  const hasList = (file: string, list: string): boolean => {
    let names = listCache.get(file);
    if (!names) {
      names = new Set();
      for (const f of factsOf(file, "url")) names.add(f.list);
      listCache.set(file, names);
    }
    return names.has(list);
  };

  // Facts of a kind grouped by one of their fields, once per file. Each kind
  // is grouped by one field only.
  const groupCache = new Map<string, Map<string, DjangoFact[]>>();
  const grouped = <K extends DjangoFact["kind"]>(file: string, kind: K, key: (f: Of<K>) => string): Map<string, Of<K>[]> => {
    const k = `${kind}\0${file}`;
    let m = groupCache.get(k);
    if (!m) {
      m = new Map();
      for (const f of factsOf(file, kind)) {
        const g = key(f);
        (m.get(g) ?? m.set(g, []).get(g))?.push(f);
      }
      groupCache.set(k, m);
    }
    return m as Map<string, Of<K>[]>;
  };
  const routersOf = (file: string, name: string) => grouped(file, "router", (r) => r.name).get(name) ?? [];
  const registersOf = (file: string, router: string) => grouped(file, "register", (r) => r.router).get(router) ?? [];
  // The statements that build a URL list, in order.
  const listSteps = (file: string, name: string) => grouped(file, "urllist", (l) => l.name).get(name) ?? [];
  const unreadOf = (file: string, list: string | null) => grouped(file, "unread", (u) => (u.list === null ? "" : `=${u.list}`)).get(list === null ? "" : `=${list}`) ?? [];
  const signalDefsOf = (file: string, name: string) => grouped(file, "signal_def", (d) => d.name).get(name) ?? [];

  // The one work budget of the resolve. `take` spends a step for work in a
  // file; once none is left it records the file's project and says no.
  const work: Budget = { steps: MAX_RESOLVE_STEPS };
  const spent = new Set<string>();
  const take = (file: string): boolean => {
    if (work.steps > 0) {
      work.steps--;
      return true;
    }
    spent.add(index.projectOf(file));
    return false;
  };

  // Registrations with the tokens of their composed path, for test requests.
  const patterns = new Map<string, Tok[] | null>();
  const visited = new Set<string>(); // urls modules some application reached
  const perApp = new Map<string, number>(); // registrations per application
  const walkSteps = new Map<string, number>(); // URL entries visited per application
  const capped = (app: string | null) => (perApp.get(app ?? "-") ?? 0) >= MAX_REGISTRATIONS_PER_APP || (walkSteps.get(app ?? "-") ?? 0) >= MAX_WALK_STEPS;
  // Said once per application, wherever the walk meets the cap.
  const capGap = (app: string | null, file: string) =>
    out.gap({ site: null, scope: app ? { app } : { project: index.projectOf(file) }, affects: ["handles", "mounts"], cause: "fan-out-capped", name: null, note: `the application has more than ${MAX_REGISTRATIONS_PER_APP} route registrations; the rest are not listed`, count: null, exact: false });
  const stepGap = (app: string | null, file: string) =>
    out.gap({ site: null, scope: app ? { app } : { project: index.projectOf(file) }, affects: ["handles", "mounts"], cause: "budget", name: null, note: `the URL walk visited ${MAX_WALK_STEPS} entries for this application and stopped`, count: null, exact: false });

  let paths: Set<string> | null = null;
  const pathSet = (): Set<string> => (paths ??= new Set(index.paths()));

  // ---------- views ----------
  // How a view is written: a name, `Class.as_view()`, or `Class()` (an instance).
  type ViewShape = "ref" | "as_view" | "instance";
  const bindHandler = (reg: Registration, file: string, entry: Of<"url"> | Of<"register">, ref: Ref, shape: ViewShape, rule: Rule): void => {
    const site = siteOf(file, entry);
    const lk: Lookup = index.lookup(file, ref);
    reg.handler.written = shape === "as_view" ? `${show(ref)}.as_view()` : shape === "instance" ? `${show(ref)}()` : show(ref);
    const scope = reg.app ? { app: reg.app } : { file };
    if (lk.kind === "symbol" && shape === "instance") {
      const classes = lk.ids.map((id) => index.node(id)).filter((n): n is GraphNode => n !== null && n.kind === "class");
      if (classes.length === 0) {
        reg.handler.status = "dynamic";
        out.gap({ site, scope, affects: ["handles"], cause: "dynamic", name: show(ref), note: `the view is what calling ${show(ref)} returns, which the graph does not follow` });
        return;
      }
      reg.handler.status = "bound";
      for (const cls of classes.slice(0, MAX_FAN_OUT)) {
        reg.handler.targets.push(cls.id);
        const tier: Tier = lk.tier === "certain" ? "likely" : lk.tier;
        const e = ev("route-table", tier, site, rule, joinNote(lk.note, "an instance of this class is the view; its __call__ method, here or in a base class, answers requests"), lk.via, [reg.id]);
        out.edge({ from: reg.id, to: cls.id, kind: "handles", plugin: PLUGIN, app: reg.app, evidence: e });
        out.role(cls.id, "route_handler", "instance-view", reg.app, e);
        for (const m of methodsOf(index, cls)) {
          if (m.name !== "__call__") continue;
          out.edge({ from: reg.id, to: m.id, kind: "handles", plugin: PLUGIN, app: reg.app, evidence: ev("route-table", "possible", site, rule, "the instance's __call__ method answers requests", lk.via, [reg.id, cls.id]) });
        }
      }
      if (classes.length > MAX_FAN_OUT) out.gap({ site, scope, affects: ["handles"], cause: "fan-out-capped", name: show(ref), note: `${show(ref)} names ${classes.length} classes; the first ${MAX_FAN_OUT} are kept`, count: classes.length - MAX_FAN_OUT, exact: true });
      return;
    }
    if (lk.kind === "symbol") {
      reg.handler.status = "bound";
      for (const id of lk.ids.slice(0, MAX_FAN_OUT)) {
        reg.handler.targets.push(id);
        const node = index.node(id);
        const e = ev("route-table", lk.tier, site, rule, lk.note, lk.via, [reg.id]);
        out.edge({ from: reg.id, to: id, kind: "handles", plugin: PLUGIN, app: reg.app, evidence: e });
        out.role(id, "route_handler", node?.kind === "class" ? (rule === RULES.drf ? "viewset" : "class-view") : "view", reg.app, e);
        if (node?.kind === "class") {
          const actions = rule === RULES.drf ? VIEWSET_ACTIONS.map(([name]) => name) : HTTP_METHODS;
          for (const m of methodsOf(index, node)) {
            if (!actions.includes(m.name)) continue;
            const note = rule === RULES.drf ? `the viewset's ${m.name} action answers this route when the router dispatches to it` : `the class's ${m.name} method answers ${m.name.toUpperCase()} requests when as_view() dispatches to it`;
            out.edge({ from: reg.id, to: m.id, kind: "handles", plugin: PLUGIN, app: reg.app, evidence: ev("route-table", "possible", site, rule, note, lk.via, [reg.id, id]) });
          }
        }
      }
      if (lk.ids.length > MAX_FAN_OUT) out.gap({ site, scope, affects: ["handles"], cause: "fan-out-capped", name: show(ref), note: `${show(ref)} names ${lk.ids.length} definitions; the first ${MAX_FAN_OUT} are kept`, count: lk.ids.length - MAX_FAN_OUT, exact: true });
      return;
    }
    if (lk.kind === "external") {
      reg.handler.status = "external";
      return;
    }
    if (lk.kind === "miss") {
      // A module-level value (a router, an instance) is no definition the
      // graph knows: only a module the plugin read, with no top-level
      // binding of the name, proves the view is missing.
      const read = index.factsOf(lk.target).length > 0;
      const value = factsOf(lk.target, "assigned").some((a) => a.names.includes(lk.name));
      // A module the graph did not read at all (over the size cap, a parse
      // error) says nothing about what it defines: the target itself, or the
      // submodule of a package the name stands for.
      const sub = lk.target.endsWith("__init__.py") ? `${posix.dirname(lk.target) === "." ? "" : `${posix.dirname(lk.target)}/`}${lk.name}.py` : null;
      const unread = index.languageFacts(lk.target) === null ? lk.target : sub !== null && pathSet().has(sub) && index.languageFacts(sub) === null ? sub : null;
      if (unread !== null) {
        reg.handler.status = "unresolved";
        out.gap({ site, scope, affects: ["handles"], cause: "file-not-parsed", name: show(ref), note: `the view ${show(ref)} is in ${unread}, which the graph did not read` });
        return;
      }
      if (!read || value) {
        reg.handler.status = "unresolved";
        out.gap({ site, scope, affects: ["handles"], cause: "dynamic", name: show(ref), note: `the view ${show(ref)} is a value of ${lk.target}, not a definition the graph follows` });
        return;
      }
      reg.handler.status = "missing";
      out.gap({ site, scope, affects: ["handles"], cause: "miss", name: show(ref), note: `the view ${show(ref)} is not defined in ${lk.target}; the route stays registered` });
      return;
    }
    if (lk.kind === "gap") {
      reg.handler.status = lk.cause === "ambiguous" ? "ambiguous" : "unresolved";
      out.gap({ site, scope, affects: ["handles"], cause: lk.cause, name: show(ref), note: `the view ${show(ref)} could not be bound: ${lk.note}` });
      return;
    }
    reg.handler.status = "unresolved";
    out.gap({ site, scope, affects: ["handles"], cause: "miss", name: show(ref), note: `the view ${show(ref)} is not bound by a definition or an import of this file` });
  };

  const newRegistration = (app: string | null, file: string, f: { line: number; column: number }, parts: Part[] | null, written: string | null, name: string | null, via: Site[], key: string, methods: string[] = ["*"]): Registration | null => {
    const site = siteOf(file, f);
    const count = perApp.get(app ?? "-") ?? 0;
    if (count >= MAX_REGISTRATIONS_PER_APP) {
      capGap(app, file);
      return null;
    }
    perApp.set(app ?? "-", count + 1);
    const reg: Registration = {
      kind: "registration",
      id: entityId(PLUGIN, app, "registration", `${file}:${f.line}:${f.column}${key}${via.map((v) => `<${v.file}:${v.line}`).join("")}`),
      plugin: PLUGIN,
      app,
      methods,
      pattern: parts && !parts.some((p) => p.computed) ? parts.map((p) => p.text).join("") : null,
      partial: parts && parts.some((p) => p.computed) ? parts.map((p) => p.text).join("") : null,
      written,
      name,
      site,
      mountedVia: via,
      mounted: app !== null,
      handler: { written: "", status: "unresolved", targets: [] },
    };
    out.entity(reg);
    patterns.set(reg.id, parts ? joinTokens(parts) : null);
    return reg;
  };

  // ---------- DRF routers ----------
  // The actions a viewset has: those it or an in-repo base defines, and
  // those Django REST framework's own classes give; null when a base comes
  // from elsewhere, so the actions are not known.
  const viewsetActions = (file: string, ref: Ref, depth = 0): Set<string> | null => {
    if (depth > 8) return null;
    const lk = index.lookup(file, ref);
    if (lk.kind !== "symbol") return null;
    const cls = lk.ids.map((id) => index.node(id)).find((n): n is GraphNode => n !== null && n.kind === "class");
    if (!cls) return null;
    const actions = new Set(methodsOf(index, cls).map((m) => m.name).filter((n) => VIEWSET_ACTIONS.some(([a]) => a === n)));
    const def = classDef(index, cls);
    for (const b of def?.bases ?? []) {
      const bref = [...(b.qualifier ? b.qualifier.split(".") : []), b.name];
      const known = DRF_ACTIONS[canonical(index, cls.file, bref) ?? ""];
      if (known) {
        for (const a of known) actions.add(a);
        continue;
      }
      const inner = viewsetActions(cls.file, bref, depth + 1);
      if (inner === null) return null;
      for (const a of inner) actions.add(a);
    }
    return actions;
  };

  const routerRegistrations = (app: string | null, file: string, routerName: string, prefix: Part[] | null, via: Site[], namespaces: string[]) => {
    const router = routersOf(file, routerName)[0];
    if (!router || !DRF_ROUTERS.has(canonical(index, file, router.ctor) ?? "")) return false;
    const slash = router.slash === "no" ? "" : "/";
    if (router.slash === "dynamic") out.gap({ site: siteOf(file, router), scope: app ? { app } : { file }, affects: ["handles", "tests"], cause: "dynamic", name: routerName, note: "the router's trailing_slash option is computed, so whether its paths end with a slash is not known" });
    for (const reg of registersOf(file, routerName)) {
      const site = siteOf(file, reg);
      if (typeof reg.prefix !== "string") {
        out.gap({ site, scope: app ? { app } : { file }, affects: ["handles"], cause: "dynamic", name: null, note: "the router prefix is computed, so its routes are not known" });
        continue;
      }
      const base = typeof reg.basename === "string" ? reg.basename : reg.prefix.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
      const actions = reg.view ? viewsetActions(file, reg.view) : null;
      if (actions === null) out.gap({ site, scope: app ? { app } : { file }, affects: ["handles", "tests"], cause: "unsupported-rule", name: reg.view ? show(reg.view) : null, note: "the viewset's actions come from a class outside the repository and Django REST framework's own, so the routes' methods are not known" });
      for (const [shape, suffix] of [
        ["list", `${reg.prefix}${slash}`],
        ["detail", `${reg.prefix}/<pk>${slash}`],
      ] as const) {
        const own = VIEWSET_ACTIONS.filter(([a, , s]) => s === shape && (actions === null || actions.has(a)));
        if (own.length === 0) continue; // no action answers this shape
        const parts = [...(prefix ?? [COMPUTED_PART]), routePart(suffix, false), ...(router.slash === "dynamic" ? [COMPUTED_PART] : [])];
        const methods = actions === null ? ["*"] : [...new Set(own.map(([, m]) => m))];
        const r = newRegistration(app, file, reg, parts, suffix, [...namespaces, `${base}-${shape}`].join(":"), via, `:${shape}`, methods);
        if (!r) return true;
        if (reg.view) bindHandler(r, file, reg, reg.view, "ref", RULES.drf);
        else {
          r.handler.status = "dynamic";
          out.gap({ site, scope: app ? { app } : { file }, affects: ["handles"], cause: "dynamic", name: null, note: "the viewset is not a name the graph can bind" });
        }
      }
    }
    return true;
  };

  // ---------- the URL walk ----------
  // `until`: a list joined into another by `+` is a copy made at the joining
  // statement, so only what the list held before it counts.
  const walk = (app: string | null, file: string, list: string, parent: number, prefix: Part[] | null, via: Site[], namespaces: string[], depth: number, stack: string[], until = Number.POSITIVE_INFINITY) => {
    const scope = app ? { app } : { file };
    if (capped(app)) {
      if ((perApp.get(app ?? "-") ?? 0) >= MAX_REGISTRATIONS_PER_APP) capGap(app, file);
      else stepGap(app, file);
      return;
    }
    // The statements Django's list is left with: from the last replacement
    // that always runs, every later one; replacements in branches keep
    // every branch's entries, with a gap.
    let live: Set<number> | null = null;
    if (parent === -1) {
      const steps = listSteps(file, list)
        .filter((l) => l.seq < until)
        .sort((a, b) => a.seq - b.seq);
      let from = -1;
      for (const l of steps) if (l.op === "replace" && !l.cond) from = l.seq;
      live = new Set(steps.filter((l) => l.seq >= from).map((l) => l.seq));
      const branchy = steps.find((l) => l.seq >= from && l.op === "replace" && l.cond);
      if (branchy) out.gap({ site: siteOf(file, branchy), scope, affects: ["handles", "mounts"], cause: "dynamic", name: list, note: `${list} is assigned in a branch, so which routes Django serves depends on how the code runs; the routes of every branch are listed` });
      // What the facts could not read in this list: a gap each, and a list
      // of the module joined in is walked as part of it.
      for (const u of unreadOf(file, list)) {
        // Before the last replacement that always runs, and after the copy, nothing is served.
        if (u.seq < from || u.seq >= until) continue;
        if (u.join !== undefined && entriesOf(file, u.join, -1).length > 0 && depth < MAX_INCLUDE_DEPTH && !stack.includes(`${file}#${u.join}`)) {
          walk(app, file, u.join, -1, prefix, via, namespaces, depth + 1, [...stack, `${file}#${u.join}`], u.seq);
          continue;
        }
        out.gap({ site: siteOf(file, u), scope, affects: ["handles", "mounts"], cause: u.cause, name: list, note: `${u.what}; its routes may be missing` });
      }
      // The routers whose urls are joined into this list by a statement Django keeps.
      for (const r of grouped(file, "urlrouter", (x) => x.name).get(list) ?? []) if (r.seq >= from && r.seq < until) routerRegistrations(app, file, r.router[0] as string, prefix, via, namespaces);
    }
    if (parent === -1 && list === "urlpatterns") {
      visited.add(file);
      const decl = listSteps(file, "urlpatterns").find((l) => !l.literal);
      if (decl) out.gap({ site: siteOf(file, decl), scope, affects: ["handles", "mounts"], cause: "dynamic", name: "urlpatterns", note: "urlpatterns is built by code the graph does not run; its routes may be missing" });
    }
    entriesOf(file, list, parent).forEach(({ f, i }) => {
      // An entry of a list a later assignment replaced is not served, and
      // neither is one added to a joined list after the copy.
      if (live !== null && live.size > 0 && !live.has(f.seq)) return;
      if (f.seq >= until) return;
      if (!take(file)) return;
      const site = siteOf(file, f);
      const steps = (walkSteps.get(app ?? "-") ?? 0) + 1;
      walkSteps.set(app ?? "-", steps);
      if (steps > MAX_WALK_STEPS) {
        stepGap(app, file);
        return;
      }
      if ((perApp.get(app ?? "-") ?? 0) >= MAX_REGISTRATIONS_PER_APP) {
        capGap(app, file);
        return;
      }
      const fn = canonical(index, file, f.fn, { line: f.line });
      if (!fn || !URL_FUNCTIONS.has(fn)) {
        if (app !== null) out.gap({ site, scope, affects: ["handles", "mounts"], cause: "unsupported-rule", name: show(f.fn), note: `${show(f.fn)} is not Django's path, re_path or url, so the graph does not read this entry` });
        return;
      }
      const regex = !fn.endsWith(".path");
      // A computed part stays in the parts as a marker: the pattern is then
      // unknown, and the known rest is kept for display.
      let parts: Part[] = prefix ?? [COMPUTED_PART];
      if (typeof f.route === "string") parts = [...parts, routePart(f.route, regex)];
      else {
        parts = [...parts, COMPUTED_PART];
        out.gap({ site, scope, affects: ["handles", "mounts"], cause: "dynamic", name: null, note: "the route is computed, so its path is not known" });
      }
      const written = typeof f.route === "string" ? f.route : null;
      const v = f.view;
      if (v.t === "include") {
        const inc = canonical(index, file, v.fn, { line: f.line });
        if (!inc || !INCLUDE_FUNCTIONS.has(inc)) {
          out.gap({ site, scope, affects: ["mounts"], cause: "unsupported-rule", name: show(v.fn), note: `${show(v.fn)} is not Django's include` });
          return;
        }
        const ns = [...namespaces, ...(typeof f.ns === "string" ? [f.ns] : [])];
        const nextVia = [...via, site];
        if (depth >= MAX_INCLUDE_DEPTH) {
          out.gap({ site, scope, affects: ["mounts", "handles"], cause: "fan-out-capped", name: null, note: `includes nested deeper than ${MAX_INCLUDE_DEPTH} are not followed` });
          return;
        }
        if (v.inline) {
          walk(app, file, list, i, parts, nextVia, ns, depth + 1, stack, until);
          return;
        }
        if (v.ref) {
          // include(router.urls) or include(other_list) in the same module.
          if (v.ref.length === 2 && v.ref[1] === "urls" && routerRegistrations(app, file, v.ref[0] as string, parts, nextVia, ns)) return;
          // include(api.router.urls): a router of an imported module.
          if (v.ref.length >= 3 && v.ref[v.ref.length - 1] === "urls") {
            const holder = index.lookup(file, v.ref.slice(0, -2));
            if (holder.kind === "module" && holder.file.endsWith(".py") && routerRegistrations(app, holder.file, v.ref[v.ref.length - 2] as string, parts, nextVia, ns)) return;
          }
          if (v.ref.length === 1 && hasList(file, v.ref[0] as string)) {
            walk(app, file, v.ref[0] as string, -1, parts, nextVia, ns, depth + 1, stack);
            return;
          }
          // include(module) of an imported URL module.
          const mod = index.lookup(file, v.ref);
          if (mod.kind === "external") return;
          if (mod.kind === "module" && mod.file.endsWith(".py")) {
            if (stack.includes(mod.file)) {
              out.gap({ site, scope, affects: ["mounts"], cause: "unsupported-rule", name: show(v.ref), note: `${show(v.ref)} includes itself through a cycle` });
              return;
            }
            out.edge({ from: file, to: mod.file, kind: "mounts", plugin: PLUGIN, app, evidence: ev("mount", mod.tier, site, RULES.include, mod.note, mod.via, []) });
            out.role(mod.file, "route_table", null, app, ev("mount", mod.tier, site, RULES.include, mod.note, mod.via));
            walk(app, mod.file, "urlpatterns", -1, parts, nextVia, ns, depth + 1, [...stack, mod.file]);
            return;
          }
          out.gap({ site, scope, affects: ["mounts", "handles"], cause: "unsupported-rule", name: show(v.ref), note: `include(${show(v.ref)}) is not a module path, an imported URL module or a list of this module` });
          return;
        }
        if (isDynamic(v.module) || v.module === null) {
          out.gap({ site, scope, affects: ["mounts", "handles"], cause: "dynamic", name: null, note: "the included module is computed, so its routes are not known" });
          return;
        }
        const target = index.module(file, v.module);
        if (target.kind !== "module") {
          if (target.kind === "external") return; // a dependency's URLs (django.contrib.admin.site.urls and the like)
          out.gap({ site, scope, affects: ["mounts", "handles"], cause: target.kind === "gap" ? target.cause : "miss", name: v.module, note: `the URL module ${v.module} is not in the repository` });
          return;
        }
        if (stack.includes(target.file)) {
          out.gap({ site, scope, affects: ["mounts"], cause: "unsupported-rule", name: v.module, note: `${v.module} includes itself through a cycle` });
          return;
        }
        out.edge({ from: file, to: target.file, kind: "mounts", plugin: PLUGIN, app, evidence: ev("mount", target.tier, site, RULES.include, target.note, target.via, []) });
        out.role(target.file, "route_table", null, app, ev("mount", target.tier, site, RULES.include, target.note, target.via));
        const targetNs = factsOf(target.file, "app_name").find((a) => typeof a.value === "string")?.value as string | undefined;
        walk(app, target.file, "urlpatterns", -1, parts, nextVia, typeof f.ns === "string" ? ns : targetNs ? [...namespaces, targetNs] : ns, depth + 1, [...stack, target.file]);
        return;
      }
      const name = typeof f.name === "string" ? [...namespaces, f.name].join(":") : null;
      const reg = newRegistration(app, file, f, parts, written, name, via, "");
      if (!reg) return;
      if (v.t === "ref" || v.t === "as_view" || v.t === "instance") bindHandler(reg, file, f, v.ref, v.t, RULES.urls);
      else {
        reg.handler.status = "dynamic";
        reg.handler.written = "(computed)";
        out.gap({ site, scope, affects: ["handles"], cause: "dynamic", name: null, note: "the view is computed, so its handler is not known; the route stays registered" });
      }
    });
  };

  for (const app of apps) {
    const data = app.data as { settings: string; rootUrlconf: Lit; rootUrlconfLine: number | null };
    if (data.rootUrlconf === null) continue;
    const site: Site = { file: data.settings, line: data.rootUrlconfLine ?? app.site.line, column: 0 };
    if (isDynamic(data.rootUrlconf)) {
      out.gap({ site, scope: { app: app.id }, affects: ["handles", "mounts"], cause: "dynamic", name: "ROOT_URLCONF", note: "ROOT_URLCONF is computed, so the application's routes are not known" });
      continue;
    }
    const root = index.module(data.settings, data.rootUrlconf);
    if (root.kind !== "module") {
      out.gap({ site, scope: { app: app.id }, affects: ["handles", "mounts"], cause: root.kind === "gap" ? root.cause : "miss", name: data.rootUrlconf, note: `ROOT_URLCONF names ${data.rootUrlconf}, which is not a module in the repository` });
      continue;
    }
    out.edge({ from: app.id, to: root.file, kind: "mounts", plugin: PLUGIN, app: app.id, evidence: ev("mount", root.tier, site, RULES.include, root.note, root.via) });
    out.role(root.file, "route_table", "root", app.id, ev("mount", root.tier, site, RULES.include, root.note, root.via));
    walk(app.id, root.file, "urlpatterns", -1, [], [], [], 0, [root.file]);
  }
  // URL modules no application reaches: their registrations stay, unmounted.
  for (const file of index.factFiles()) {
    if (visited.has(file) || !enabled(file)) continue;
    const entries = factsOf(file, "url").filter((f) => f.list === "urlpatterns" && f.parent === -1);
    if (!entries.some((f) => URL_FUNCTIONS.has(canonical(index, file, f.fn, { line: f.line }) ?? ""))) continue;
    out.role(file, "route_table", null, null, ev("route-table", "certain", siteOf(file, entries[0] as Of<"url">), RULES.urls, null));
    walk(null, file, "urlpatterns", -1, [], [], [], 0, [file]);
  }

  // What the facts could not read outside URL lists: a statement nested too
  // deep, a cap, migration operations built by code.
  for (const file of index.factFiles()) {
    if (!enabled(file)) continue;
    for (const u of unreadOf(file, null)) out.gap({ site: siteOf(file, u), scope: { file }, affects: u.affects ?? ["handles", "mounts", "changes_schema", "reads_config"], cause: u.cause, name: null, note: u.what });
  }

  // ---------- templates ----------
  // A template name to the files that hold it, and a project and a template
  // name to the files of the project that hold it, each name in the form
  // the facts keep a template name in (shared/kept.ts `keptName`), so a
  // name the facts redacted still finds its file.
  const templates = new Map<string, string[]>();
  const templatesNear = new Map<string, string[]>();
  for (const p of index.paths()) {
    for (const plain of templateNames(p)) {
      const name = keptName(plain);
      (templates.get(name) ?? templates.set(name, []).get(name))?.push(p);
      const k = `${index.projectOf(p)}\0${name}`;
      (templatesNear.get(k) ?? templatesNear.set(k, []).get(k))?.push(p);
    }
  }
  const renders = (file: string, from: string, at: { line: number; column: number }, template: Lit, rule: Rule) => {
    const site = siteOf(file, at);
    const app = appOf(file);
    if (template === null) return;
    if (isDynamic(template)) {
      out.gap({ site, scope: { file }, affects: ["renders"], cause: "dynamic", name: null, note: "the template name is computed, so the template is not known" });
      return;
    }
    const near = templatesNear.get(`${index.projectOf(file)}\0${template}`) ?? [];
    const hits = near.length > 0 ? near : (templates.get(template) ?? []);
    if (hits.length === 0) {
      const id = out.entity({ kind: "template", id: entityId(PLUGIN, app, "template", template), plugin: PLUGIN, app, name: template, site: null, file: null, detail: "missing" });
      out.edge({ from, to: id, kind: "renders", plugin: PLUGIN, app, evidence: ev("template-literal", "likely", site, rule, `no file under a templates folder is named ${template}`) });
      out.gap({ site, scope: { file }, affects: ["renders"], cause: "miss", name: template, note: `the template ${template} is not in the repository` });
      return;
    }
    const tier: Tier = hits.length === 1 ? "likely" : "possible";
    const note = hits.length === 1 ? "found by name under a templates folder; Django's loader settings are not read" : `${hits.length} templates folders hold ${template}; Django's loader order picks one`;
    for (const path of hits.slice(0, MAX_FAN_OUT)) {
      const id = out.entity({ kind: "template", id: entityId(PLUGIN, app, "template", path), plugin: PLUGIN, app, name: template, site: null, file: path, detail: null });
      out.edge({ from, to: id, kind: "renders", plugin: PLUGIN, app, evidence: ev("template-literal", tier, site, rule, note) });
      out.role(path, "template", null, app, ev("template-literal", tier, site, rule, note));
    }
    if (hits.length > 1) out.gap({ site, scope: { file }, affects: ["renders"], cause: "ambiguous", name: template, note, count: hits.length, exact: true });
  };

  for (const file of index.factFiles()) {
    if (!enabled(file)) continue;
    for (const r of factsOf(file, "render")) {
      if (!take(file)) break;
      if (!RENDER_FUNCTIONS.has(canonical(index, file, r.fn, { line: r.line }) ?? "")) continue;
      renders(file, index.enclosing(file, r.line)?.id ?? file, r, r.template, RULES.templates);
    }
    for (const t of factsOf(file, "template_attr")) {
      if (!take(file)) break;
      const cls = classIn(index, file, t.owner);
      if (cls) renders(file, cls.id, t, t.template, RULES.templates);
    }
  }

  // ---------- models, fields and tables ----------
  const models = new Map<string, { node: GraphNode; tier: Tier; note: string | null; file: string }>();
  const candidates: { node: GraphNode; file: string; bases: Ref[] }[] = [];
  for (const file of index.factFiles()) {
    if (!enabled(file)) continue;
    const facts = index.languageFacts(file);
    if (!facts) continue;
    for (const d of facts.defs) {
      if (d.kind !== "class" || d.bases.length === 0) continue;
      if (!take(file)) break;
      const node = symbolAt(index, file, d.name, d.line);
      if (!node || node.kind !== "class") continue;
      candidates.push({ node, file, bases: d.bases.map((b) => [...(b.qualifier ? b.qualifier.split(".") : []), b.name]) });
    }
  }
  for (const c of candidates) {
    if (c.bases.some((b) => MODEL_BASES.has(canonical(index, c.file, b) ?? ""))) models.set(c.node.id, { node: c.node, tier: "certain", note: null, file: c.file });
  }
  // Subclasses of a model, through bases the resolver binds, to a fixed point.
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const c of candidates) {
      if (models.has(c.node.id)) continue;
      if (!take(c.file)) break;
      for (const b of c.bases) {
        const lk = index.lookup(c.file, b);
        if (lk.kind !== "symbol") continue;
        const base = lk.ids.map((id) => models.get(id)).find((m) => m !== undefined);
        if (!base) continue;
        const tier = lk.tier === "certain" && base.tier === "certain" ? "certain" : lk.tier === "possible" || base.tier === "possible" ? "possible" : "likely";
        models.set(c.node.id, { node: c.node, tier, note: lk.note ?? base.note, file: c.file });
        grew = true;
        break;
      }
    }
    if (!grew) break;
  }
  const appLabelOf = (file: string): string => {
    const dir = posix.dirname(file);
    const appDir = posix.basename(dir) === "models" ? posix.dirname(dir) : dir;
    return posix.basename(appDir === "." ? "" : appDir);
  };
  const appDirOf = (file: string): string => {
    const dir = posix.dirname(file);
    return posix.basename(dir) === "models" || posix.basename(dir) === "migrations" ? posix.dirname(dir) : dir;
  };
  // The Django field class a repository class derives from through its
  // bases, at most MAX_FIELD_CHAIN classes deep; null when none. Every
  // class a walk visits spends a step of the work budget, and each answer
  // is kept by class and depth (a whole answer by class alone), so a
  // lattice of classes that inherit from many others costs its classes
  // times the depth, never the number of paths. `cut`: the depth or the
  // budget stopped the walk before it found one.
  const fieldBases = new Map<string, string | null>();
  const fieldMemo = new Map<string, { name: string | null; cut: boolean }>();
  const fieldBase = (cls: GraphNode, depth: number, visiting: Set<string>): { name: string | null; cut: boolean; cycle?: boolean } => {
    const kept = fieldBases.get(cls.id);
    if (kept !== undefined) return { name: kept, cut: false };
    const mk = `${cls.id}\0${depth}`;
    const memo = fieldMemo.get(mk);
    if (memo) return memo;
    if (visiting.has(cls.id)) return { name: null, cut: false, cycle: true };
    if (depth >= MAX_FIELD_CHAIN || !take(cls.file)) return { name: null, cut: true };
    visiting.add(cls.id);
    let cut = false;
    let cycle = false;
    let found: string | null = null;
    for (const b of classDef(index, cls)?.bases ?? []) {
      const ref = [...(b.qualifier ? b.qualifier.split(".") : []), b.name];
      const name = canonical(index, cls.file, ref);
      if (name !== null && djangoField(name)) {
        found = name;
        break;
      }
      const lk = index.lookup(cls.file, ref);
      if (lk.kind !== "symbol") continue;
      for (const id of lk.ids) {
        const base = index.node(id);
        if (base?.kind !== "class") continue;
        const r = fieldBase(base, depth + 1, visiting);
        cut ||= r.cut;
        cycle ||= r.cycle === true;
        found = r.name;
        if (found) break;
      }
      if (found) break;
    }
    visiting.delete(cls.id);
    const out = { name: found, cut: found === null && cut };
    if (found !== null || (!cut && !cycle)) fieldBases.set(cls.id, found);
    // An answer a cycle through the classes being visited shaped is not kept.
    else if (!cycle) fieldMemo.set(mk, out);
    return cycle ? { ...out, cycle } : out;
  };
  // The field class a model attribute's constructor names: Django's own
  // field class (certain), or a repository class that derives from one,
  // however it is named or imported (likely). Anything else is no field;
  // `cut` when a base chain was deeper than MAX_FIELD_CHAIN, so whether it
  // is one is not known.
  const fieldClass = (file: string, ctor: Ref, line: number): { name: string; tier: Tier; note: string | null } | { cut: true } | null => {
    const name = canonical(index, file, ctor, { line });
    if (name !== null && djangoField(name)) return { name, tier: "certain", note: null };
    const lk = index.lookup(file, ctor);
    if (lk.kind !== "symbol") return null;
    let cut = false;
    for (const id of lk.ids) {
      const cls = index.node(id);
      if (!cls || cls.kind !== "class") continue;
      const found = fieldBase(cls, 0, new Set());
      cut ||= found.cut;
      const base = found.name;
      if (base !== null) return { name: base, tier: lk.tier === "possible" ? "possible" : "likely", note: joinNote(lk.note, `a field class of the repository that derives from ${base}`) };
    }
    return cut ? { cut: true } : null;
  };

  // App folders by label: every folder that holds a models module, and the
  // models modules of each folder.
  const appDirs = new Map<string, Set<string>>();
  const modelModules = new Map<string, string[]>();
  for (const p of index.paths()) {
    const segs = p.split("/");
    // <app>/models.py, or <app>/models/<module>.py
    const dir = segs[segs.length - 1] === "models.py" ? segs.slice(0, -1) : segs.length >= 3 && segs[segs.length - 2] === "models" && p.endsWith(".py") ? segs.slice(0, -2) : null;
    if (!dir || dir.length === 0) continue;
    const label = dir[dir.length - 1] as string;
    (appDirs.get(label) ?? appDirs.set(label, new Set()).get(label))?.add(dir.join("/"));
    (modelModules.get(dir.join("/")) ?? modelModules.set(dir.join("/"), []).get(dir.join("/")))?.push(p);
  }
  // Every model by app folder first: a field may name by string a model defined later.
  const modelsByApp = new Map<string, Map<string, GraphNode>>(); // app folder to lower-case model name to its class
  for (const m of models.values()) {
    const dir = appDirOf(m.file);
    (modelsByApp.get(dir) ?? modelsByApp.set(dir, new Map()).get(dir))?.set(m.node.name.toLowerCase(), m.node);
  }
  for (const m of models.values()) {
    if (!take(m.file)) break;
    const site: Site = { file: m.file, line: m.node.startLine, column: 0 };
    const app = appOf(m.file);
    out.role(m.node.id, "model", null, app, ev("role-base", m.tier, site, RULES.models, m.note ?? "the base class is a model by the resolver's convention"));
    const table = byOwner(m.file, "db_table").get(m.node.name)?.[0];
    if (table && typeof table.table === "string") {
      const id = out.entity({ kind: "table", id: entityId(PLUGIN, app, "table", table.table), plugin: PLUGIN, app, name: table.table, site: siteOf(m.file, table), file: null, detail: null });
      out.edge({ from: m.node.id, to: id, kind: "maps_to", plugin: PLUGIN, app, evidence: ev("declaration", "certain", siteOf(m.file, table), RULES.models, null) });
    } else if (!table) {
      const name = `${appLabelOf(m.file)}_${m.node.name.toLowerCase()}`;
      const id = out.entity({ kind: "table", id: entityId(PLUGIN, app, "table", name), plugin: PLUGIN, app, name, site: null, file: null, detail: "default" });
      out.edge({ from: m.node.id, to: id, kind: "maps_to", plugin: PLUGIN, app, evidence: ev("declaration", "likely", site, RULES.models, "the default table name: the app label taken from the folder name, then the model name in lower case") });
    } else out.gap({ site: siteOf(m.file, table), scope: { file: m.file }, affects: ["maps_to"], cause: "dynamic", name: "db_table", note: "the table name is computed" });
    for (const f of byOwner(m.file, "field").get(m.node.name) ?? []) {
      if (!take(m.file)) break;
      const fsite = siteOf(m.file, f);
      // A field is proved by its constructor: Django's own field class, or
      // a class of the repository whose base is one (likely).
      const field = fieldClass(m.file, f.ctor, f.line);
      if (field === null) continue;
      if ("cut" in field) {
        out.gap({ site: fsite, scope: { file: m.file }, affects: ["declares_field"], cause: "fan-out-capped", name: `${m.node.name}.${f.name}`, note: `the base classes of ${show(f.ctor)} were not all followed (they go deeper than ${MAX_FIELD_CHAIN} levels, or past the work budget), so whether ${m.node.name}.${f.name} is a field is not known`, count: null, exact: false });
        continue;
      }
      const id = out.entity({ kind: "model_field", id: entityId(PLUGIN, app, "model_field", `${m.node.id}.${f.name}`), plugin: PLUGIN, app, name: `${m.node.name}.${f.name}`, site: fsite, file: null, detail: show(f.ctor) });
      out.edge({ from: m.node.id, to: id, kind: "declares_field", plugin: PLUGIN, app, evidence: ev("declaration", field.tier, fsite, RULES.models, field.note) });
      const tail = field.name.slice(field.name.lastIndexOf(".") + 1);
      if (!RELATED_FIELDS.has(tail) || f.related === null) continue;
      if (typeof f.related === "string") {
        if (f.related === "self") {
          out.edge({ from: m.node.id, to: m.node.id, kind: "uses_type", plugin: PLUGIN, app, evidence: ev("declaration", "certain", fsite, RULES.models, null) });
          continue;
        }
        const [label, modelName] = f.related.includes(".") ? (f.related.split(".") as [string, string]) : [null, f.related];
        const dirs = label === null ? [appDirOf(m.file)] : [...(appDirs.get(label) ?? [])];
        const target = dirs.map((d) => modelsByApp.get(d)?.get(modelName.toLowerCase())).find((x) => x !== undefined);
        // "auth.User": a label no app folder of the repository has names an installed app outside it.
        if (!target && label !== null && dirs.length === 0) continue;
        // A class of that name in the app's models whose model base comes from a dependency.
        const named = target ? null : dirs.flatMap((d) => modelModules.get(d) ?? []).map((f2) => classIn(index, f2, modelName)).find((c) => c !== null);
        if (named) out.edge({ from: m.node.id, to: named.id, kind: "uses_type", plugin: PLUGIN, app, evidence: ev("association", "likely", fsite, RULES.models, `the class is named by the string "${f.related}" in its app's models; its model base is outside the repository`) });
        else if (target) out.edge({ from: m.node.id, to: target.id, kind: "uses_type", plugin: PLUGIN, app, evidence: ev("association", "likely", fsite, RULES.models, `the model is named by the string "${f.related}", matched by its app folder and name`) });
        else out.gap({ site: fsite, scope: { file: m.file }, affects: ["uses_type"], cause: "miss", name: f.related, note: `no model named ${f.related} was found` });
        continue;
      }
      const lk = index.lookup(m.file, f.related);
      if (lk.kind === "symbol") for (const id2 of lk.ids) out.edge({ from: m.node.id, to: id2, kind: "uses_type", plugin: PLUGIN, app, evidence: ev("declaration", lk.tier, fsite, RULES.models, lk.note, lk.via) });
    }
  }

  // ---------- migrations ----------
  for (const file of index.factFiles()) {
    if (!isMigrationPath(file) || !enabled(file)) continue;
    const facts = index.languageFacts(file);
    const ops = factsOf(file, "mig_op");
    const cls = facts?.defs.find((d) => d.kind === "class" && d.bases.some((b) => canonical(index, file, [...(b.qualifier ? b.qualifier.split(".") : []), b.name]) === "django.db.migrations.Migration"));
    if (!cls) continue;
    const app = appOf(file);
    out.role(file, "migration", null, app, ev("role-base", "certain", { file, line: cls.line, column: cls.column }, RULES.migrations, null));
    const byName = modelsByApp.get(appDirOf(file)) ?? new Map<string, GraphNode>();
    for (const op of ops.filter((o) => o.owner === cls.name)) {
      if (!take(file)) break;
      const site = siteOf(file, op);
      const model = typeof op.model === "string" ? op.model : null;
      const label = `${op.op}${model ? ` ${model.toLowerCase()}` : ""}${typeof op.field === "string" ? `.${op.field}` : ""}${typeof op.to === "string" ? ` to ${op.to}` : ""}`;
      const opId = out.entity({ kind: "migration_operation", id: entityId(PLUGIN, app, "migration_operation", `${file}:${op.line}`), plugin: PLUGIN, app, name: label, site, file, detail: op.op });
      if (isDynamic(op.model) || isDynamic(op.field)) out.gap({ site, scope: { file }, affects: ["changes_schema"], cause: "dynamic", name: op.op, note: "the operation names its model or field with a computed value" });
      const names = [model, typeof op.to === "string" && op.op === "RenameModel" ? op.to : null].filter((x): x is string => x !== null);
      for (const n of names) {
        const target = byName.get(n.toLowerCase());
        if (target) out.edge({ from: file, to: target.id, kind: "changes_schema", plugin: PLUGIN, app, evidence: ev("declaration", "likely", site, RULES.migrations, "the operation names the model by its lower-case name in the same app folder", null, [opId]) });
      }
      if (op.fn) {
        const lk = index.lookup(file, op.fn);
        if (lk.kind === "symbol") for (const id of lk.ids) out.edge({ from: opId, to: id, kind: "runs", plugin: PLUGIN, app, evidence: ev("declaration", lk.tier, site, RULES.migrations, lk.note, lk.via) });
      }
    }
  }

  // ---------- management commands ----------
  for (const file of index.paths()) {
    const command = commandName(file);
    if (!command || !enabled(file)) continue;
    if (!take(file)) break;
    const cls = classIn(index, file, "Command");
    if (!cls) continue;
    const def = classDef(index, cls);
    const bound = def?.bases.some((b) => COMMAND_BASES.has(canonical(index, file, [...(b.qualifier ? b.qualifier.split(".") : []), b.name]) ?? "")) ?? false;
    const app = appOf(file);
    const site: Site = { file, line: cls.startLine, column: 0 };
    const e = ev("role-path", bound ? "certain" : "likely", site, RULES.commands, bound ? null : "a class named Command under management/commands, whose base is not Django's BaseCommand by import");
    const id = out.entity({ kind: "command", id: entityId(PLUGIN, app, "command", command), plugin: PLUGIN, app, name: command, site, file, detail: "management" });
    out.role(cls.id, "command", "management", app, e);
    const handle = methodsOf(index, cls).find((x) => x.name === "handle");
    if (handle) out.edge({ from: id, to: handle.id, kind: "runs", plugin: PLUGIN, app, evidence: e });
  }

  // ---------- template tags ----------
  for (const file of index.factFiles()) {
    if (!enabled(file)) continue;
    const libs = new Set(factsOf(file, "tag_library").filter((l) => canonical(index, file, l.ctor) === "django.template.Library" || canonical(index, file, l.ctor) === "django.template.library.Library").map((l) => l.name));
    if (libs.size === 0) continue;
    for (const t of factsOf(file, "tag")) {
      if (!take(file)) break;
      if (!libs.has(t.lib)) continue;
      const fn = functionIn(index, file, t.fn, t.line + 1);
      if (!fn) continue;
      const site = siteOf(file, t);
      out.role(fn.id, "template_tag", t.decorator, appOf(file), ev("role-decorator", "certain", site, RULES.tags, null));
      if (t.template !== null) renders(file, fn.id, t, t.template, RULES.tags);
    }
  }

  // ---------- signals ----------
  // A signal Django sends: a name of one of its signal modules, or a value
  // the repository builds with Django's Signal class.
  const djangoSignalDef = (file: string, def: Of<"signal_def">) => DJANGO_SIGNAL_CLASSES.has(canonical(index, file, def.ctor, { line: def.line }) ?? "");
  const signalEntity = (file: string, ref: Ref, app: string | null, site: Site): { id: string; tier: Tier; note: string | null } | null => {
    const name = canonical(index, file, ref);
    if (name !== null && DJANGO_SIGNAL_MODULES.some((m) => name.startsWith(m))) return { id: out.entity({ kind: "signal", id: entityId(PLUGIN, app, "signal", name), plugin: PLUGIN, app, name, site: null, file: null, detail: "django" }), tier: "certain", note: null };
    const lk = index.lookup(file, ref);
    // An in-repo signal is a module-level `Signal()` value: the lookup lands on its module.
    if (lk.kind === "miss" && !lk.target.includes("::")) {
      const def = signalDefsOf(lk.target, lk.name).find((s) => djangoSignalDef(lk.target, s));
      if (def) return { id: out.entity({ kind: "signal", id: entityId(PLUGIN, app, "signal", `${lk.target}:${def.name}`), plugin: PLUGIN, app, name: def.name, site: siteOf(lk.target, def), file: lk.target, detail: null }), tier: "certain", note: null };
    }
    if (ref.length === 1) {
      const def = signalDefsOf(file, ref[0] as string).find((s) => djangoSignalDef(file, s));
      if (def) return { id: out.entity({ kind: "signal", id: entityId(PLUGIN, app, "signal", `${file}:${def.name}`), plugin: PLUGIN, app, name: def.name, site: siteOf(file, def), file, detail: null }), tier: "certain", note: null };
    }
    out.gap({ site, scope: { file }, affects: ["schedules"], cause: "unsupported-rule", name: show(ref), note: `the signal ${show(ref)} is neither one Django sends nor built by Django's Signal class` });
    return null;
  };
  for (const file of index.factFiles()) {
    if (!enabled(file)) continue;
    const app = appOf(file);
    for (const r of factsOf(file, "receiver")) {
      if (!take(file)) break;
      const dec = canonical(index, file, r.dec, { line: r.line });
      if (dec !== "django.dispatch.receiver" && dec !== "django.dispatch.dispatcher.receiver") continue;
      const fn = functionIn(index, file, r.fn, r.line + 1);
      if (!fn) continue;
      const site = siteOf(file, r);
      for (const s of r.signals.slice(0, MAX_FAN_OUT)) {
        const sig = signalEntity(file, s, app, site);
        if (!sig) continue;
        const e = ev("signal", sig.tier, site, RULES.signals, sig.note);
        out.edge({ from: sig.id, to: fn.id, kind: "schedules", plugin: PLUGIN, app, evidence: e });
        out.role(fn.id, "signal_receiver", r.sender ? `sender ${show(r.sender)}` : null, app, e);
      }
      if (r.signals.length > MAX_FAN_OUT) out.gap({ site, scope: { file }, affects: ["schedules"], cause: "fan-out-capped", name: fn.name, note: `the receiver ${fn.name} names ${r.signals.length} signals; the first ${MAX_FAN_OUT} are linked`, count: r.signals.length - MAX_FAN_OUT, exact: true });
    }
    for (const c of factsOf(file, "connect")) {
      if (!take(file)) break;
      const site = siteOf(file, c);
      if (!c.handler) {
        if (canonical(index, file, c.signal) !== null || signalDefsOf(file, c.signal[0] as string).length > 0) out.gap({ site, scope: { file }, affects: ["schedules"], cause: "dynamic", name: show(c.signal), note: `${show(c.signal)}.connect() of a receiver that is not a name the graph binds` });
        continue;
      }
      const name = canonical(index, file, c.signal, { line: c.line, callee: [...c.signal, "connect"] });
      const inRepo = !name && ((c.signal.length === 1 && signalDefsOf(file, c.signal[0] as string).length > 0) || index.lookup(file, c.signal).kind === "miss");
      if (!(name !== null && DJANGO_SIGNAL_MODULES.some((m) => name.startsWith(m))) && !inRepo) continue;
      const sig = signalEntity(file, c.signal, app, site);
      if (!sig) continue;
      const lk = index.lookup(file, c.handler);
      if (lk.kind !== "symbol") {
        out.gap({ site, scope: { file }, affects: ["schedules"], cause: lk.kind === "gap" ? lk.cause : lk.kind === "external" ? "external" : "miss", name: show(c.handler), note: `the receiver ${show(c.handler)} could not be bound` });
        continue;
      }
      for (const id of lk.ids) {
        const e = ev("signal", lk.tier, site, RULES.signals, lk.note, lk.via);
        out.edge({ from: sig.id, to: id, kind: "schedules", plugin: PLUGIN, app, evidence: e });
        out.role(id, "signal_receiver", c.sender ? `sender ${show(c.sender)}` : null, app, e);
      }
    }
  }

  // ---------- settings keys ----------
  const keyIds = new Map<string, string>(); // app and key to the entity
  for (const app of apps) {
    const file = (app.data as { settings: string }).settings;
    out.role(file, "config", "settings", app.id, ev("config-define", "certain", app.site, RULES.settings, null));
    for (const s of factsOf(file, "setting")) {
      if (!take(file)) break;
      const site = siteOf(file, s);
      const id = out.entity({ kind: "config_key", id: entityId(PLUGIN, app.id, "config_key", s.name), plugin: PLUGIN, app: app.id, name: s.name, site, file: null, detail: "settings" });
      keyIds.set(`${app.id}\0${s.name}`, id);
      out.edge({ from: file, to: id, kind: "defines_config", plugin: PLUGIN, app: app.id, evidence: ev("config-define", "certain", site, RULES.settings, null) });
    }
  }
  for (const file of index.factFiles()) {
    if (!enabled(file)) continue;
    const reads = factsOf(file, "setting_read");
    if (reads.length === 0) continue;
    const projectApps = appsByProject.get(index.projectOf(file)) ?? [];
    for (const r of reads) {
      if (!take(file)) break;
      const base = canonical(index, file, r.base);
      if (base !== "django.conf.settings") continue;
      const from = index.enclosing(file, r.line)?.id ?? file;
      const site = siteOf(file, r);
      for (const app of projectApps) {
        let id = keyIds.get(`${app.id}\0${r.key}`);
        if (!id) {
          id = out.entity({ kind: "config_key", id: entityId(PLUGIN, app.id, "config_key", r.key), plugin: PLUGIN, app: app.id, name: r.key, site: null, file: null, detail: "not assigned in the settings module" });
          keyIds.set(`${app.id}\0${r.key}`, id);
        }
        out.edge({ from, to: id, kind: "reads_config", plugin: PLUGIN, app: app.id, evidence: ev("config-read", "certain", site, RULES.settings, null) });
      }
    }
  }

  // ---------- tests ----------
  const registrations = out.entities.filter((e): e is Registration => e.kind === "registration");
  // Mounted registrations by project, and by route name, for test links.
  const appProject = new Map(apps.map((a) => [a.id, a.project]));
  const byProject = new Map<string, Registration[]>();
  const byName = new Map<string, Registration[]>();
  for (const r of registrations) {
    if (r.app === null) continue;
    const p = appProject.get(r.app) ?? "";
    (byProject.get(p) ?? byProject.set(p, []).get(p))?.push(r);
    if (r.name !== null) (byName.get(`${p}\0${r.name}`) ?? byName.set(`${p}\0${r.name}`, []).get(`${p}\0${r.name}`))?.push(r);
  }
  for (const file of index.factFiles()) {
    if (!isTestPath(file) || !enabled(file)) continue;
    const app = appOf(file);
    const site: Site = { file, line: 1, column: 0 };
    out.role(file, "test", "file", app, ev("role-path", "certain", site, RULES.tests, null));
    const facts = index.languageFacts(file);
    for (const d of facts?.defs ?? []) {
      if (!take(file)) break;
      const node = symbolAt(index, file, d.name, d.line);
      if (!node) continue;
      if (d.kind === "class" && (d.bases.some((b) => TEST_BASES.has(canonical(index, file, [...(b.qualifier ? b.qualifier.split(".") : []), b.name]) ?? "")) || d.name.startsWith("Test"))) out.role(node.id, "test", "class", app, ev("role-path", "certain", { file, line: d.line, column: d.column }, RULES.tests, null));
      else if ((d.kind === "function" || d.kind === "method") && d.name.startsWith("test")) out.role(node.id, "test", d.kind, app, ev("role-path", "certain", { file, line: d.line, column: d.column }, RULES.tests, null));
    }
    const project = index.projectOf(file);
    const reachable = byProject.get(project) ?? [];
    for (const c of factsOf(file, "client")) {
      const csite = siteOf(file, c);
      const from = index.enclosing(file, c.line)?.id ?? file;
      if (isDynamic(c.path)) {
        out.gap({ site: csite, scope: { file }, affects: ["tests"], cause: "dynamic", name: null, note: "the request path is computed, so the route it requests is not known" });
        continue;
      }
      if (c.path === null) continue; // a path from reverse() is linked by its name below
      const method = c.method.toUpperCase();
      const path = requestPath(c.path);
      if (path === null) {
        out.gap({ site: csite, scope: { file }, affects: ["tests"], cause: "budget", name: null, note: `the request path is longer than ${MAX_REQUEST} characters and is not matched against routes` });
        continue;
      }
      if (!take(file)) {
        out.gap({ site: null, scope: { file }, affects: ["tests"], cause: "budget", name: null, note: "the work budget ran out; later test requests of this file are not linked to routes" });
        break;
      }
      const hits: Registration[] = [];
      let unmatchable = 0;
      let ranOut = false;
      for (const r of reachable) {
        if (--work.steps < 0) {
          ranOut = true;
          break;
        }
        if (!r.methods.includes("*") && !r.methods.includes(method)) continue;
        const toks = patterns.get(r.id);
        if (!toks) {
          unmatchable++;
          continue;
        }
        const m = matchTokens(toks, path, work);
        if (m === "budget") {
          ranOut = true;
          break;
        }
        if (m) hits.push(r);
      }
      // The budget ran out inside this request: said here, whatever follows.
      if (ranOut) {
        spent.add(index.projectOf(file));
        out.gap({ site: csite, scope: { file }, affects: ["tests"], cause: "budget", name: null, note: "the work budget ran out while this request was matched against the routes; the routes it reaches are not all linked" });
      }
      if (hits.length > MAX_FAN_OUT) out.gap({ site: csite, scope: { file }, affects: ["tests"], cause: "fan-out-capped", name: null, note: `the request matches ${hits.length} routes; the first ${MAX_FAN_OUT} are linked`, count: hits.length - MAX_FAN_OUT, exact: !ranOut });
      // Said once per test file: the routes the requests could reach are not matchable.
      if (hits.length === 0 && unmatchable > 0) out.gap({ site: null, scope: { file }, affects: ["tests"], cause: "unsupported-rule", name: null, note: "some routes of this project have a computed path or a regex the graph does not match requests against, so requests in this file may reach routes it does not link" });
      for (const r of hits.slice(0, MAX_FAN_OUT)) {
        const tier: Tier = hits.length === 1 ? "likely" : "possible";
        out.edge({ from, to: r.id, kind: "tests", plugin: PLUGIN, app: r.app, category: "route-request", evidence: ev("test-route-request", tier, csite, RULES.tests, hits.length === 1 ? `the test requests ${c.path}, which matches this route's pattern` : `the test requests ${c.path}, which ${hits.length} route patterns match`, null, [r.id]) });
      }
    }
    for (const rv of factsOf(file, "reverse")) {
      if (!take(file)) break;
      if (!REVERSE_FUNCTIONS.has(canonical(index, file, rv.fn, { line: rv.line }) ?? "")) continue;
      const rsite = siteOf(file, rv);
      if (isDynamic(rv.name)) {
        out.gap({ site: rsite, scope: { file }, affects: ["tests"], cause: "dynamic", name: null, note: "the route name is computed" });
        continue;
      }
      if (rv.name === null) continue;
      const from = index.enclosing(file, rv.line)?.id ?? file;
      const hits = byName.get(`${project}\0${rv.name}`) ?? [];
      if (hits.length > MAX_FAN_OUT) out.gap({ site: rsite, scope: { file }, affects: ["tests"], cause: "fan-out-capped", name: null, note: `${hits.length} routes are named ${rv.name}; the first ${MAX_FAN_OUT} are linked`, count: hits.length - MAX_FAN_OUT, exact: true });
      for (const r of hits.slice(0, MAX_FAN_OUT)) out.edge({ from, to: r.id, kind: "tests", plugin: PLUGIN, app: r.app, category: "route-name", evidence: ev("test-route-name", hits.length === 1 ? "likely" : "possible", rsite, RULES.tests, `the test names the route ${rv.name}`, null, [r.id]) });
    }
  }
  // Said once per project whose work the budget cut.
  for (const project of spent) out.gap({ site: null, scope: { project }, affects: EDGE_KINDS, cause: "budget", name: null, note: `the Django plugin used its work budget of ${MAX_RESOLVE_STEPS} steps; later routes, models, templates, signals, settings reads and test links of this project are not listed` });
  return { roles: out.roles, entities: out.entities, edges: out.edges, unknowns: out.unknowns };
}

export const EDGE_KINDS: FrameworkEdgeKind[] = ["handles", "mounts", "renders", "tests", "declares_field", "changes_schema", "maps_to", "uses_type", "schedules", "reads_config", "defines_config", "runs"];
