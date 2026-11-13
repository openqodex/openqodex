// The framework resolve stage: after symbol resolution, every registered
// plugin detects its applications and resolves its facts through a
// PluginIndex. The result is plain data (FrameworkData), kept on the graph
// and in a retained index; layer.ts answers questions from it.
//
// A plugin that throws contributes nothing, and the build says so. Every
// evidence record is checked; a plugin that emits an invalid one has that
// record dropped and the count reported, never published.
import { createHash } from "node:crypto";
import type { ProjectModel } from "../discovery/projects.js";
import { normalisePy } from "../discovery/projects.js";
import type { World } from "../resolve.js";
import type { FileFacts, GraphEdge, GraphNode } from "../types.js";
import { FRAMEWORK_EDGE_KINDS, MAX_ENTITIES_PER_APP, MAX_EDGES_PER_APP, RESERVED_FACT_KINDS, validateFrameworkEvidence } from "./plugin.js";
import type { Detection, Entity, FrameworkEdge, FrameworkFactBase, FrameworkPlugin, FrameworkUnknown, PluginIndex, RoleAssignment } from "./plugin.js";
import { PLUGINS, pluginsKey } from "./registry.js";
import { deriveTestCalls } from "./shared/tests.js";

// 2: a gap may name the whole build as its scope, and the stage's own gaps
// name every relation they can hide.
export const FRAMEWORK_DATA_VERSION = 2;

export { MAX_ENTITIES_PER_APP, MAX_EDGES_PER_APP } from "./plugin.js";

// Applies the caps to one plugin's output, in the order the plugin emitted it.
function capPerApp(plugin: string, entities: Entity[], edges: FrameworkEdge[], unknowns: FrameworkUnknown[]): { entities: Entity[]; edges: FrameworkEdge[] } {
  const count = new Map<string, number>();
  const droppedIds = new Set<string>();
  const droppedPerApp = new Map<string, number>();
  const keptEntities = entities.filter((e) => {
    const k = e.app ?? "-";
    const n = (count.get(k) ?? 0) + 1;
    count.set(k, n);
    if (n <= MAX_ENTITIES_PER_APP) return true;
    droppedIds.add(e.id);
    droppedPerApp.set(k, (droppedPerApp.get(k) ?? 0) + 1);
    return false;
  });
  const edgeCount = new Map<string, number>();
  const droppedEdges = new Map<string, number>();
  const keptEdges = edges.filter((e) => {
    if (droppedIds.has(e.from) || droppedIds.has(e.to)) return false;
    const k = e.app ?? "-";
    const n = (edgeCount.get(k) ?? 0) + 1;
    edgeCount.set(k, n);
    if (n <= MAX_EDGES_PER_APP) return true;
    droppedEdges.set(k, (droppedEdges.get(k) ?? 0) + 1);
    return false;
  });
  for (const [k, n] of droppedPerApp) unknowns.push({ plugin, site: null, scope: k === "-" ? { project: "" } : { app: k }, affects: ["handles", "renders", "tests"], cause: "fan-out-capped", name: null, note: `${n} entities past the ${MAX_ENTITIES_PER_APP} kept for one application were left out`, count: n, exact: true });
  for (const [k, n] of droppedEdges) unknowns.push({ plugin, site: null, scope: k === "-" ? { project: "" } : { app: k }, affects: ["handles", "renders", "tests"], cause: "fan-out-capped", name: null, note: `${n} edges past the ${MAX_EDGES_PER_APP} kept for one application were left out`, count: n, exact: true });
  return { entities: keptEntities, edges: keptEdges };
}

export type PluginRun = {
  id: string;
  version: number;
  status: "ok" | "failed" | "not-detected" | "stopped";
  reason: string | null;
  apps: number;
  ms: number;
  invalid: number; // evidence records dropped by the check
};

export type FrameworkData = {
  version: number;
  plugins: PluginRun[];
  apps: (Detection & { plugin: string })[];
  roles: (RoleAssignment & { plugin: string })[];
  entities: Entity[];
  edges: FrameworkEdge[];
  unknowns: FrameworkUnknown[];
  // What the output depends on beyond the source files: the plugins and
  // their versions and the paths their inputs match.
  fingerprint: string;
};

export type StageInput = {
  files: { path: string; facts: FileFacts }[];
  paths: readonly string[]; // every path in the capture
  nodes: Map<string, GraphNode>;
  defsByFile: Map<string, GraphNode[]>;
  edges: readonly GraphEdge[];
  world: World;
  model: ProjectModel;
  projectOf: (file: string) => string;
  plugins?: readonly FrameworkPlugin[];
  stop?: () => boolean;
};

// What the plugins' output depends on besides the source files. Folded into
// the retained index's digest, so a template added or a view file deleted
// is never answered from an older graph.
export function contextFingerprint(paths: readonly string[], plugins: readonly FrameworkPlugin[] = PLUGINS): string {
  const h = createHash("sha256").update(pluginsKey(plugins));
  for (const p of plugins) {
    h.update(`\0${p.id}`);
    for (const path of paths) if (p.inputs.paths.some((re) => re.test(path))) h.update(`\0${path}`);
  }
  return h.digest("hex");
}

export function emptyFrameworkData(fingerprint = ""): FrameworkData {
  return { version: FRAMEWORK_DATA_VERSION, plugins: [], apps: [], roles: [], entities: [], edges: [], unknowns: [], fingerprint };
}

// What every plugin's index reads alike, made once per build: each file's
// language facts, and every path sorted.
type Shared = { facts: Map<string, FileFacts>; sortedPaths: string[] };

function makeIndex(input: StageInput, shared: Shared, out: Map<string, GraphEdge[]>, plugin: FrameworkPlugin, dropped: FrameworkUnknown[]): PluginIndex {
  const { facts, sortedPaths } = shared;
  const valid = new Map<string, FrameworkFactBase[]>();
  for (const f of input.files) {
    const list = f.facts.frameworks?.[plugin.id];
    if (!list || list.length === 0) continue;
    const kept: FrameworkFactBase[] = [];
    let invalid = 0;
    for (const fact of list) {
      if (fact.kind === "error") {
        const why = (fact as FrameworkFactBase & { note?: unknown }).note;
        dropped.push({ plugin: plugin.id, site: { file: f.path, line: 1, column: 0 }, scope: { file: f.path }, affects: [...FRAMEWORK_EDGE_KINDS], cause: "file-not-parsed", name: null, note: `the ${plugin.id} plugin could not read this file${typeof why === "string" ? `: ${why.slice(0, 200)}` : ""}`, count: null, exact: false });
        continue;
      }
      if (fact.kind === "overflow") {
        const omitted = (fact as FrameworkFactBase & { omitted?: unknown }).omitted;
        dropped.push({ plugin: plugin.id, site: { file: f.path, line: 1, column: 0 }, scope: { file: f.path }, affects: [...FRAMEWORK_EDGE_KINDS], cause: "fan-out-capped", name: null, note: `the ${plugin.id} plugin kept the first facts of this file and left the rest out`, count: typeof omitted === "number" ? omitted : null, exact: typeof omitted === "number" });
        continue;
      }
      if (RESERVED_FACT_KINDS.has(fact.kind) || !plugin.isFact(fact)) {
        invalid++;
        continue;
      }
      kept.push(fact);
    }
    if (invalid > 0) dropped.push({ plugin: plugin.id, site: null, scope: { file: f.path }, affects: [...FRAMEWORK_EDGE_KINDS], cause: "file-not-parsed", name: null, note: `${invalid} cached ${plugin.id} facts of this file had the wrong shape and were left out`, count: invalid, exact: true });
    if (kept.length > 0) valid.set(f.path, kept);
  }
  const factFiles = [...valid.keys()].sort();
  const spans = new Map<string, GraphNode[]>();
  const symbolsOf = (file: string): GraphNode[] => input.defsByFile.get(file) ?? [];
  return {
    paths: () => sortedPaths,
    factFiles: () => factFiles,
    factsOf: (file) => valid.get(file) ?? [],
    languageFacts: (file) => facts.get(file) ?? null,
    symbols: symbolsOf,
    enclosing: (file, line) => {
      let list = spans.get(file);
      if (!list) {
        list = symbolsOf(file).filter((n) => n.kind !== "file");
        spans.set(file, list);
      }
      let best: GraphNode | null = null;
      for (const n of list) {
        if (n.startLine > line || n.endLine < line) continue;
        if (!best || n.endLine - n.startLine < best.endLine - best.startLine || (n.endLine - n.startLine === best.endLine - best.startLine && n.startLine > best.startLine)) best = n;
      }
      return best;
    },
    node: (id) => input.nodes.get(id) ?? input.world.node(id),
    lookup: (file, path) => input.world.lookup(file, path),
    module: (file, spec) => input.world.moduleLookup(file, spec),
    callsFrom: (id) => out.get(id) ?? [],
    projectOf: input.projectOf,
    model: () => input.model,
    declares: (project, ecosystem, name) => {
      if (ecosystem === "python") return input.model.pyDeclared.has(normalisePy(name));
      if (ecosystem === "gems") return input.model.gems.has(name);
      if (ecosystem === "go") return input.model.goRequires.some((r) => r === name || r.startsWith(`${name}/`));
      return input.model.node.some((p) => (project === "" || p.dir === project) && p.pkg.deps.has(name));
    },
  };
}

export function runFrameworks(input: StageInput): FrameworkData {
  const plugins = input.plugins ?? PLUGINS;
  const data = emptyFrameworkData(contextFingerprint(input.paths, plugins));
  const out = new Map<string, GraphEdge[]>();
  for (const e of input.edges) if (e.kind === "calls") (out.get(e.from) ?? out.set(e.from, []).get(e.from))?.push(e);
  const shared: Shared = { facts: new Map(), sortedPaths: [...input.paths].sort() };
  for (const f of input.files) shared.facts.set(f.path, f.facts);
  for (const plugin of plugins) {
    const started = performance.now();
    const run: PluginRun = { id: plugin.id, version: plugin.version, status: "ok", reason: null, apps: 0, ms: 0, invalid: 0 };
    data.plugins.push(run);
    if (input.stop?.()) {
      run.status = "stopped";
      run.reason = "the budget ran out before this plugin ran";
      continue;
    }
    const dropped: FrameworkUnknown[] = [];
    try {
      const index = makeIndex(input, shared, out, plugin, dropped);
      const apps = plugin.detect(index);
      run.apps = apps.length;
      const result = plugin.resolve(index, apps);
      const keep = <T extends { evidence: Parameters<typeof validateFrameworkEvidence>[0] }>(list: T[]): T[] =>
        list.filter((x) => {
          if (validateFrameworkEvidence(x.evidence) === null) return true;
          run.invalid++;
          return false;
        });
      const roles = keep(result.roles);
      const unknowns = [...dropped, ...result.unknowns];
      const capped = capPerApp(plugin.id, result.entities, [...keep(result.edges), ...deriveTestCalls(plugin.id, roles, index)], unknowns);
      const edges = capped.edges;
      if (apps.length === 0 && roles.length === 0 && capped.entities.length === 0 && edges.length === 0) run.status = "not-detected";
      // One push per item: a spread of a large list as arguments overflows the stack.
      for (const a of apps) data.apps.push({ ...a, plugin: plugin.id });
      for (const r of roles) data.roles.push({ ...r, plugin: plugin.id });
      for (const e of capped.entities) data.entities.push(e);
      for (const e of edges) data.edges.push(e);
      for (const u of unknowns) data.unknowns.push(u);
      if (run.invalid > 0) run.reason = `${run.invalid} evidence records failed the check and were left out`;
    } catch (error) {
      // A plugin that fails contributes nothing to this build.
      run.status = "failed";
      run.reason = `the ${plugin.id} plugin failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
    }
    run.ms = Math.round(performance.now() - started);
  }
  return data;
}
