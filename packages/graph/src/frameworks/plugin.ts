// The framework plugin interface (PLAN.md 3.2.3). A framework plugin turns a
// framework's own conventions into graph facts with proof: route
// registrations and their handlers, models and fields, migrations,
// templates, components, hooks, jobs, commands, signals, config keys and the
// links from tests to code. The core never names a framework; every
// framework rule lives in one plugin folder (`frameworks/<id>/`), and a
// plugin runs only from the shipped registry (`frameworks/registry.ts`):
// repository code is never loaded as a plugin, and nothing from the
// repository is executed.
//
// A plugin works in two steps, kept apart like the rest of the graph:
//
// 1. `facts`: context-free facts from one file's parse tree, cached with the
//    file's language facts under the file's content and the plugin's
//    version. A fact never refers to another file, never names the file's
//    own path, and is plain JSON.
// 2. `detect` and `resolve`: after symbol resolution, with every file's
//    facts and the resolved graph, read through `PluginIndex` only. This is
//    where a registration is bound to its handler, a template name to a
//    file and a test request to a route. It runs on every build, so a file
//    whose content did not change is re-read when a framework is newly
//    detected around it (no stale plugin output).
//
// Rules every plugin obeys (PLAN.md 3.2.3, the protected choice on
// registrations):
// - API identity: a registration counts only when its receiver or callee
//   binds to the framework's own import (`from django.urls import path`),
//   or the file has the framework's role (`config/routes.rb` inside a
//   `routes.draw` block). A dependency in a manifest enables a rule; it
//   never proves a receiver.
// - Application scope: every entity carries the application it belongs to.
//   Two applications in one repository never merge their routes.
// - Literal evidence only: a route path, template name, config key or job
//   name that is computed becomes an unknown with cause "dynamic", never an
//   edge.
// - Registrations are kept apart from handlers: a registration whose
//   handler is missing, computed or outside the repository is still listed,
//   with the handler's status and an unknown that says why.
// - A static test association is a reference, a call or a possible request;
//   it is never called coverage.
// - Overflow is a gap: every cap emits a scoped unknown when it stops.
// - Failure removes output: a plugin that throws contributes nothing to the
//   build, and the build says so.
//
// This file is the contract other plugins build against. It only grows:
// a field or a union member is appended, never removed or narrowed, and a
// change bumps PLUGIN_API_VERSION.
import type { Node } from "web-tree-sitter";
import type { ProjectModel } from "../discovery/projects.js";
import type { Cause, Tier } from "../model/records.js";
import type { FileFacts, GraphEdge, GraphNode, Lang } from "../types.js";
import type { TreeVisitor } from "../walk.js";

// 2: Registration.partial (appended).
// 3: FrameworkPlugin.reader (appended).
// 4: TreeVisitor.types and TreeVisitor.keep (appended): a reader names the
// node types it is entered for and the ancestors it reads as nodes.
export const PLUGIN_API_VERSION = 4;

// The most entities and edges one plugin keeps per application (null: the
// registrations no application reaches). Past either cap the rest are left
// out and one unknown with cause "fan-out-capped" says how many.
export const MAX_ENTITIES_PER_APP = 20_000;
export const MAX_EDGES_PER_APP = 100_000;

// ---------- the facts a plugin reads from one file ----------

// Every fact a plugin emits has a kind of its own choosing and the position
// it was read at (1-based line and 1-based column, as the language facts).
// Everything else on a fact is the plugin's own plain JSON.
export type FrameworkFactBase = { kind: string; line: number; column: number };

// The most facts one plugin keeps from one file. Past it the core keeps
// the first ones and adds one fact of kind "overflow" with `omitted` set;
// a plugin whose `facts` throws on a file gets one fact of kind "error".
// Both kinds are reserved: the core turns them into unknowns (cause
// "fan-out-capped" and "file-not-parsed") and never hands them to the
// plugin's `isFact` or `resolve`.
export const MAX_FACTS_PER_FILE = 2000;
export const RESERVED_FACT_KINDS: ReadonlySet<string> = new Set(["overflow", "error"]);

// The facts of every plugin for one file, as cached beside the language
// facts (FileFacts.frameworks): plugin id to its facts. A plugin that found
// nothing in the file has no entry.
export type FrameworkFileFacts = Record<string, FrameworkFactBase[]>;

// A plugin's fact reader for one file, as one reader of a shared walk:
// `visitor` is shown the tree's nodes (null when the reader needs no walk,
// such as a file over its size cap), and `finish`, called once the walk is
// done, returns exactly the facts `facts` returns for the same tree.
export type FactReader<F extends FrameworkFactBase = FrameworkFactBase> = { visitor: TreeVisitor | null; finish(): F[] };

// ---------- what a plugin's output depends on ----------

// Everything beyond the source files' facts that a plugin's output depends
// on. The build folds the matching paths and the declared dependencies into
// the context fingerprint, so a retained graph is not reused once a
// template appears, a view file is deleted or a manifest gains the
// framework.
export type PluginInputs = {
  // Repository paths whose presence or absence the output depends on:
  // template folders, view files, migration folders, marker files such as
  // `manage.py` or `config/routes.rb`. Matched against every path in the
  // capture, eligible source or not. Only presence is read, never content.
  paths: readonly RegExp[];
  // Dependency names that enable the plugin's rules, per ecosystem, as
  // declared in a manifest the project model reads. Enabling is all a
  // dependency does: it never proves a receiver or an application.
  dependencies: { npm?: readonly string[]; python?: readonly string[]; gems?: readonly string[]; go?: readonly string[] };
};

// ---------- applications ----------

// One instance of the framework: a Django settings module, a Rails
// application or engine, an Express `app`, a FastAPI value, a Go mux.
// Routes, jobs and config keys are scoped to one application.
export type Detection = {
  // Stable within a build and across builds of the same tree: built from
  // the plugin id and the declaration site (`appId`).
  id: string;
  name: string; // what the brief calls it: "mysite.settings", "Blog::Engine"
  project: string; // the project folder ("" for the repository root)
  root: string; // the folder the application's conventions are relative to
  // Where the application is declared, and what proved it.
  site: Site;
  evidence: { file: string; line: number; note: string }[];
  // The framework version the manifest declares, as written; null when
  // none is declared. A version outside `supportedVersions` keeps the
  // conservative rules and adds an unknown with cause "unsupported-rule".
  version: string | null;
  // Plugin-specific data the resolve step needs (a root URL module, an
  // engine's mount name). Plain JSON.
  data?: Record<string, unknown>;
};

export function appId(plugin: string, file: string, line: number): string {
  return `fw:${plugin}:app:${file}:${line}`;
}

// ---------- where a thing was read, and what proved it ----------

export type Site = { file: string; line: number; column: number };

// The evidence kinds a framework edge or role may rest on. A kind is
// listed in FRAMEWORK_CERTAIN_KINDS only when it reads one literal
// declaration the framework itself defines; a kind that rests on a naming
// convention (a controller found by its file path, an implicit view, a
// table name by pluralisation) is likely at most.
export type FrameworkEvidenceKind =
  | "route-table" // an entry of a route table: Django `urlpatterns`, a Rails `routes.draw` block
  | "route-decorator" // a decorator that registers the function below it
  | "route-call" // a registration call on a router value: `app.get("/x", h)`
  | "route-path" // a file whose path is the route by the framework's rule (Next.js `app/**/route.ts`)
  | "route-convention" // a handler found by a naming convention (Rails `posts#index` to `PostsController#index`)
  | "mount" // an include or mount that composes one route table under a prefix
  | "role-base" // a class whose base binds to the framework's class (`models.Model`, `ApplicationRecord`)
  | "role-path" // a file whose role comes from its path by the framework's rule (`management/commands/x.py`)
  | "role-decorator" // a function whose decorator binds to the framework's (`@receiver`, `@register.filter`)
  | "declaration" // a literal declaration inside a role-bearing class or file (a model field, a migration operation)
  | "association" // a model association naming another model by convention (`has_many :comments`)
  | "template-literal" // a literal template name matched to one file under a templates folder
  | "template-implicit" // a view file found by the implicit rendering convention
  | "component-element" // a JSX element bound to a component
  | "signal" // a signal connection: a receiver decorator or a `connect` call
  | "config-read" // a literal key read through the framework's settings accessor
  | "config-define" // a literal key assigned in a settings or config file
  | "enqueue" // a call that enqueues a job class
  | "test-direct-call" // a test symbol that calls the symbol: the call edge's own evidence
  | "test-route-request" // a test request whose literal path matches a route pattern
  | "test-route-name" // a test that names a route by its name (`reverse("x")`, `posts_path`)
  | "test-subject"; // a test that names the class it is about (`describe PostsController`)

export const FRAMEWORK_CERTAIN_KINDS: ReadonlySet<FrameworkEvidenceKind> = new Set<FrameworkEvidenceKind>([
  "route-table",
  "route-decorator",
  "route-call",
  "route-path",
  "mount",
  "role-base",
  "role-path",
  "role-decorator",
  "declaration",
  "component-element",
  "signal",
  "config-read",
  "config-define",
  "test-direct-call",
]);

// What proved a framework edge, entity or role. `premises` names what it
// rests on: the registration a handles edge belongs to, the symbol binding
// it read; the tier is no stronger than the weakest premise.
export type FrameworkEvidence = {
  kind: FrameworkEvidenceKind;
  tier: Tier;
  site: Site; // the declaration, call or decorator the plugin read
  via: { file: string; line: number; spec: string | null } | null; // the import, the route table entry or the include that proved it
  premises: string[];
  rule: { id: string; version: number };
  note: string | null; // one short sentence; required when the tier is below certain
};

// Returns why a framework evidence record is invalid, or null.
export function validateFrameworkEvidence(e: FrameworkEvidence): string | null {
  if (e.tier === "certain" && !FRAMEWORK_CERTAIN_KINDS.has(e.kind)) return `a certain framework edge cannot rest on ${e.kind}`;
  if (e.tier !== "certain" && (e.note === null || e.note.trim() === "")) return `a ${e.tier} framework edge needs a note that says why it is not certain`;
  if (e.rule.id === "" || !Number.isInteger(e.rule.version) || e.rule.version < 1) return "a framework edge needs the rule id and version that made it";
  if (!Number.isInteger(e.site.line) || e.site.line < 1 || e.site.file === "") return "a framework edge needs the site it was read at";
  return null;
}

// ---------- roles ----------

// A role attaches to a declaration (a symbol id) or a file (its path). One
// declaration has one kind and any number of roles. `detail` narrows the
// role in the framework's own words: "view", "viewset", "layout", "page",
// "partial", "mailer", "management", "signal".
export type Role =
  | "route_handler"
  | "model"
  | "migration"
  | "template"
  | "template_tag"
  | "component"
  | "hook"
  | "job"
  | "mailer"
  | "command"
  | "middleware"
  | "signal_receiver"
  | "serializer"
  | "form"
  | "test"
  | "fixture"
  | "config"
  | "route_table";

export type RoleAssignment = {
  target: string; // a symbol id or a file path
  role: Role;
  detail: string | null;
  app: string | null;
  evidence: FrameworkEvidence;
};

// ---------- semantic entities ----------

// Things a framework declares that have no declaration of their own. Each
// id starts with "fw:" and is built by `entityId`, so it never collides
// with a symbol id (which has "#") or a file path.
export type EntityKind =
  | "registration" // one route registration site
  | "template" // a template or view file, present or named and missing
  | "command" // a management command, a rake task, a CLI subcommand
  | "job" // a job class or a registered task
  | "signal" // a signal a receiver is connected to
  | "config_key" // a key read or defined, never its value
  | "model_field" // a field a model declares
  | "migration_operation" // one operation of one migration
  | "table"; // a table a migration or a model names

export function entityId(plugin: string, app: string | null, kind: EntityKind, key: string): string {
  return `fw:${plugin}:${kind}:${app ?? "-"}:${key}`;
}

// What a registration's handler turned out to be. A registration is never
// dropped because its handler is: "missing" names a place where no such
// definition exists now, "dynamic" a computed handler, "external" one a
// dependency supplies, "ambiguous" several candidates, "unresolved" no rule
// could tell.
export type HandlerStatus = "bound" | "missing" | "dynamic" | "external" | "ambiguous" | "unresolved";

export type Registration = {
  kind: "registration";
  id: string;
  plugin: string;
  app: string | null; // null when no application's root reaches the table that holds it
  // Upper-case HTTP methods; ["*"] when the registration takes any method.
  methods: string[];
  // The full pattern with every mount prefix composed, as the framework
  // writes it ("blog/<int:pk>/", "/posts/:id"); null when any part is computed.
  pattern: string | null;
  written: string | null; // the pattern as written at the site, before prefixes
  name: string | null; // the route's name: Django `name=`, Rails `as:`
  site: Site;
  // The includes or mounts that composed the prefix, outermost first.
  mountedVia: Site[];
  // False when no application root reaches the table: the pattern is
  // relative and the route may not be served at all.
  mounted: boolean;
  handler: { written: string; status: HandlerStatus; targets: string[] };
  // When `pattern` is null: the pattern with each computed part shown as
  // "{computed}" ("{computed}accounts/login/"), for display only; never
  // matched against a request. Absent or null when nothing is known.
  partial?: string | null;
};

export type Entity =
  | Registration
  | {
      kind: Exclude<EntityKind, "registration">;
      id: string;
      plugin: string;
      app: string | null;
      name: string; // the template path, the command name, the key, "Post.title"
      site: Site | null; // where it is declared; null for a template named but missing
      file: string | null; // the file that is the entity, when there is one (a template, a migration)
      detail: string | null;
    };

// ---------- edges ----------

export type FrameworkEdgeKind =
  | "handles" // registration to handler symbol
  | "mounts" // route table or application to route table
  | "renders" // symbol to template entity or component
  | "tests" // test symbol or file to symbol, registration or component
  | "declares_field" // model to model_field
  | "changes_schema" // migration file to table, or migration operation to model
  | "maps_to" // model to table
  | "uses_type" // model to model through an association
  | "applies_middleware" // registration, controller or application to middleware symbol, in order
  | "schedules" // signal or schedule entity to receiver symbol
  | "enqueues" // call site's symbol to job
  | "reads_config" // symbol to config_key
  | "defines_config" // settings file to config_key
  | "runs"; // command entity to the symbol that runs it

// Every framework relation, for a gap that may hide any of them.
export const FRAMEWORK_EDGE_KINDS: readonly FrameworkEdgeKind[] = ["handles", "mounts", "renders", "tests", "declares_field", "changes_schema", "maps_to", "uses_type", "applies_middleware", "schedules", "enqueues", "reads_config", "defines_config", "runs"];

// The test link categories. Never "coverage": each says what the test
// does with the target, statically.
export type TestCategory = "direct-call" | "route-request" | "route-name" | "subject" | "component-render" | "type-or-value-reference";

export type FrameworkEdge = {
  from: string;
  to: string;
  kind: FrameworkEdgeKind;
  plugin: string;
  app: string | null;
  evidence: FrameworkEvidence;
  category?: TestCategory; // on "tests" edges
  order?: number; // on "applies_middleware": the position in the chain
};

// ---------- gaps ----------

// What a plugin could not see. `scope` is the smallest scope the gap is
// proved to affect: a file, an application, a project, or the whole build
// (`{ build: true }`: a budget or a cap a plugin counts across every
// application, which may hide anything past the point it stopped).
// `affects` the framework relations it can hide; empty means every one. A
// count that cannot be known is null, never zero.
export type FrameworkUnknown = {
  plugin: string;
  site: Site | null;
  scope: { file: string } | { app: string } | { project: string } | { build: true };
  affects: FrameworkEdgeKind[];
  cause: Cause;
  name: string | null; // the handler, template, key or name the plugin could not settle
  note: string;
  count: number | null;
  exact: boolean;
};

// ---------- the read API a plugin resolves through ----------

// What a dotted name means at the top level of a file, as the symbol
// resolver binds it: `views.index` in a urls module, `PostList.as_view`.
// "miss" carries where the last name was looked up: a file path, or a
// class key. A module-level value that is not a definition (a router
// built by `APIRouter()`, `express.Router()`) shows as a miss whose target
// is the module's file, so a plugin reads its own facts in that file to
// tell a value from a real miss.
export type Lookup =
  | { kind: "symbol"; ids: string[]; tier: Tier; evidence: string; via: { file: string; line: number; spec: string | null } | null; note: string | null }
  | { kind: "module"; file: string; tier: Tier; via: { file: string; line: number; spec: string | null } | null; note: string | null }
  | { kind: "external" }
  | { kind: "gap"; cause: Cause; note: string; candidates: string[] | null }
  | { kind: "miss"; target: string; name: string }
  | { kind: "none" }; // the name is not bound at the top level of the file

// Every cross-file read a plugin makes goes through this object, so a later
// phase can record what each plugin read (PLAN.md 3.2.6).
export interface PluginIndex<F extends FrameworkFactBase = FrameworkFactBase> {
  // Every path in the capture, sorted: eligible source files, templates,
  // view files, migrations, marker files.
  paths(): readonly string[];
  // The files that hold facts of this plugin, sorted.
  factFiles(): readonly string[];
  // This plugin's facts for a file; empty when it has none.
  factsOf(file: string): readonly F[];
  // The language facts of a file the graph read; null when it did not.
  languageFacts(file: string): FileFacts | null;
  // The definitions of a file, in source order.
  symbols(file: string): readonly GraphNode[];
  // The innermost definition whose span holds the line, else null (top-level code).
  enclosing(file: string, line: number): GraphNode | null;
  node(id: string): GraphNode | null;
  // What a dotted name means at the top level of a file.
  lookup(file: string, path: readonly string[]): Lookup;
  // The repository file a module specifier names from a file (a Python
  // dotted path, a relative import); external, a gap, or none.
  module(file: string, spec: string): Lookup;
  // The call edges out of a symbol (or a file's top level), as resolved.
  callsFrom(id: string): readonly GraphEdge[];
  projectOf(file: string): string;
  model(): ProjectModel;
  // Whether a project declares the dependency (a manifest the project
  // model read). Enables rules; never proves a receiver.
  declares(project: string, ecosystem: "npm" | "python" | "gems" | "go", name: string): boolean;
}

// ---------- what resolve returns ----------

export type PluginOutput = {
  roles: RoleAssignment[];
  entities: Entity[];
  edges: FrameworkEdge[];
  unknowns: FrameworkUnknown[];
};

// ---------- what a plugin proves, and with which fixtures ----------

// Each rule a plugin applies, with the corpus cases that prove it. Cases
// are folders under packages/graph/corpus/frameworks/<plugin id>/, named
// relative to that folder ("blog-app"). Every
// rule names a positive case, an aliased-import case, an unrelated
// same-name case, a dynamic case and a metadata-edit case (PLAN.md 3.2.3,
// "Fixtures per rule"); a shape the rule does not have (a path convention
// has no import to alias) names the reason instead of a case.
export type RuleFixtures = {
  positive: string[];
  aliased: string[] | { none: string };
  unrelatedSameName: string[] | { none: string };
  dynamic: string[] | { none: string };
  metadataEdit: string[] | { none: string };
};

export type CapabilityRule = {
  id: string; // "django-urlpatterns"
  version: number;
  description: string; // one plain sentence
  emits: (FrameworkEdgeKind | EntityKind | Role)[];
  fixtures: RuleFixtures;
};

export type CapabilityReport = {
  plugin: string;
  version: number;
  supportedVersions: string;
  rules: CapabilityRule[];
  // Corpus cases where the plugin must emit no registration and no edge
  // (a file that looks like a route table and is not one, a same-named
  // function from another library, the framework's name in a manifest with
  // no application).
  negativeControls: string[];
  // A sample application per plugin, built in a test, with every column of
  // the plugin's table exercised.
  sampleApps: string[];
};

// ---------- the plugin ----------

export interface FrameworkPlugin<F extends FrameworkFactBase = FrameworkFactBase> {
  readonly id: string; // "django", "rails", "nextjs", "react", "express", "fastapi", "go-http"
  // Bumped whenever the facts or the resolve rules change shape or
  // meaning: it is part of every cached facts key and of the context
  // fingerprint.
  readonly version: number;
  // The framework versions the fixtures cover, as plain text ("Django 3.2 to 5.1").
  readonly supportedVersions: string;
  // The languages whose files the plugin reads facts from.
  readonly languages: readonly Lang[];
  readonly inputs: PluginInputs;

  // A cheap test on the file's text before its tree is walked: false skips
  // the file. Context-free, like the facts.
  wants(source: string, lang: Lang): boolean;

  // The context-free facts of one file, from its parse tree's root node.
  // Never reads another file, the file's path or the environment.
  facts(root: Node, lang: Lang): F[];

  // The same facts, read as one reader of the language extractor's own
  // walk of the tree (walk.ts), so a file is walked once for the extractor
  // and every such plugin. A reader that names its node types (`types`,
  // `keep`) has node objects made only for those. Optional: a plugin
  // without it is called through `facts`.
  reader?(root: Node, lang: Lang): FactReader<F>;

  // A shape check for one cached fact: facts are read back from disk and
  // checked before they are used. A fact that fails it is dropped and the
  // file gets an unknown.
  isFact(v: unknown): v is F;

  // The applications in the capture, with the evidence that proved each.
  // A dependency alone never makes an application.
  detect(index: PluginIndex<F>): Detection[];

  // Registrations, roles, entities, edges and gaps, for every application
  // `detect` returned (and for registrations no application reaches).
  resolve(index: PluginIndex<F>, apps: readonly Detection[]): PluginOutput;

  capabilities(): CapabilityReport;
}
