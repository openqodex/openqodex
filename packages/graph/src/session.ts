// Reopening a kept build: from its index when it has one, else from the
// facts its inventory names, resolved again with the project model it kept.
// Either way the answer is the one the build gave (retained equals fresh;
// test/session.test.ts checks), and it needs no source byte: the bytes of a
// capture stay readable through `git show <tree>:<path>` while the build is
// kept (refs/openqodex/graph/<tree>).
import { foldInline } from "./inline-fold.js";
import { EXTRACTOR_VERSION } from "./extract.js";
import { RESOLVER_VERSION, createWorld } from "./resolve.js";
import { assemble, deserializeModel, readIndex } from "./store/graph-files.js";
import type { GenerationManifest, GraphStore, OpenGeneration } from "./store/types.js";
import type { FileFacts, Graph, GraphStatus, NotRead } from "./types.js";

export type Opened = { graph: Graph; manifest: GenerationManifest };

export function graphOf(store: GraphStore, gen: OpenGeneration): Graph | null {
  const indexed = readIndex(gen);
  // The index was written before its build had an id: the manifest names it.
  if (indexed) return { ...indexed, repoRoot: store.repoRoot, status: { ...indexed.status, generation: gen.manifest.id } };
  // Facts another reader wrote lack what this resolver needs (the value
  // uses and escapes a list floor rests on), so a caller list built from
  // them would read as whole where callers hide: such a build is not read.
  const v = gen.manifest.versions;
  if (v.extractor !== EXTRACTOR_VERSION || v.resolver !== RESOLVER_VERSION) return null;
  let inventory: { files: Record<string, { key: string; lang: string }> };
  let projects: { model: Record<string, unknown>; goModules: [string, string][] };
  let coverage: { notRead: NotRead[]; budgetFiles: string[]; unreadLanguages?: { language: string; files: number }[] };
  try {
    inventory = JSON.parse(gen.read("inventory.json") ?? "null") as typeof inventory;
    projects = JSON.parse(gen.read("projects.json") ?? "null") as typeof projects;
    coverage = JSON.parse(gen.read("coverage.json") ?? "null") as typeof coverage;
  } catch {
    return null;
  }
  if (!inventory?.files || !projects?.model || !coverage) return null;
  const files: { path: string; facts: FileFacts }[] = [];
  const missing: NotRead[] = [];
  for (const [path, entry] of Object.entries(inventory.files)) {
    const facts = store.readFacts(entry.key);
    if (facts) files.push({ path, facts });
    else missing.push({ file: path, reason: "unreadable" });
  }
  const model = deserializeModel(projects.model);
  const known = new Set(Object.keys(inventory.files));
  const resolved = createWorld({ files, known, model, goModules: projects.goModules }).resolveAll();
  // No framework data is kept without the index: no function written in place stays bound.
  foldInline(resolved, files, new Set());
  const m = gen.manifest;
  const notRead = [...coverage.notRead, ...missing];
  const reasons = [...m.reasons, ...(missing.length > 0 ? [`the facts of ${missing.length} files of this build are no longer kept`] : [])];
  const status: GraphStatus = {
    status: m.status === "partial" || missing.length > 0 ? "partial" : "ok",
    reason: reasons[0] ?? null,
    reasons,
    filesParsed: files.length,
    filesSkipped: notRead.length,
    durationMs: m.wallMs,
    eligibleFiles: m.counts.eligible,
    cacheHits: m.counts.fromCache,
    parses: m.counts.parsed,
    unresolvedSites: resolved.unresolvedSites,
    externalSites: resolved.externalSites,
    mode: m.mode,
    generation: m.id,
    predictedMs: null,
    stages: m.stages,
    cuts: [],
    notRead,
    ...(coverage.unreadLanguages ? { unreadLanguages: coverage.unreadLanguages } : {}),
  };
  const graph = assemble([...resolved.nodes.values()], resolved.edges, [...resolved.importers.values()].flat(), resolved.misses, resolved.unknowns, status, model, projects.goModules, {
    references: resolved.references,
    dispatch: resolved.dispatch,
    summaries: resolved.summaries,
    escapes: resolved.escapes,
  });
  return { ...graph, repoRoot: store.repoRoot };
}
