// Opening a graph for questions: one way for the command line and the MCP
// server, so the two never answer from different builds of one tree.
//
// A pin captures the work tree, builds or reuses the graph in the owning
// repository's `.openqodex/graph/`, and holds the build it got with a lease,
// so no collection removes it while questions are answered from it (PLAN.md
// 3.2.7). A pin of a kept build (`--generation`) never builds. Each pin
// keeps the graph input digest of what it read (build.ts, captureDigest):
// every eligible file's content, and every manifest, lockfile, workspace
// file and followed config with its content or its absence. A later
// question computes the digest of the work tree again, with no parse, and
// says that files changed since (`laterEditsKnown`) when the two differ.
import { cleanupDiffs, getChange } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph, workTreeDigest } from "../build.js";
import { detectImpact } from "../impact.js";
import { graphOf } from "../session.js";
import { BUILD_ID_PATTERN } from "../store/types.js";
import type { GraphStore, Lease, Purpose } from "../store/types.js";
import type { Graph } from "../types.js";
import type { ChangesExtra, Session } from "./answer.js";
import { prepareIndexes } from "./engine.js";

export type GraphSettings = { budgetMs: number; maxFiles: number; maxFileBytes: number; maxHeapMb: number };

// The ten-minute budget and no parse cap of `graph build`, the memory bound kept.
export const BUILD_ALL_MS = 600_000;

// What a pin read: the graph input digest of the work tree it captured.
export type Reference = { digest: string };

export type Pinned = {
  session: Session;
  lease: Lease | null;
  // Set when the pin compared the work tree with a base: the comparison,
  // and its scope (the resolved base and the capture digest) for cursors.
  changes?: ChangesExtra;
  change?: Change;
  scope?: string;
  reference: Reference | null;
  release(): void;
};

// True when a file the graph reads was added, removed or changed since the
// pin read the work tree: a source file, or a manifest, lockfile or config
// that decides how its imports bind.
export async function laterEdits(repoRoot: string, ref: Reference, maxFileBytes: number): Promise<boolean> {
  return (await workTreeDigest(repoRoot, maxFileBytes)) !== ref.digest;
}

function sessionOf(store: GraphStore | null, graph: Graph): Session {
  const id = graph.status.generation;
  const m = store && id ? store.open({ id })?.manifest : undefined;
  prepareIndexes(graph);
  return { graph, generation: id, treeSha: m?.capture.treeSha ?? null, builtAt: m?.createdAt ?? null, laterEditsKnown: false };
}

async function leaseOf(store: GraphStore | null, graph: Graph, purpose: Purpose): Promise<Lease | null> {
  if (!store || !graph.status.generation) return null;
  try {
    return (await store.lease({ id: graph.status.generation }, purpose))?.lease ?? null;
  } catch {
    // The folder's lock stayed busy or the lease file could not be written:
    // the answers still come from the graph in memory.
    return null;
  }
}

export type PinArgs = {
  repoRoot: string;
  store: GraphStore | null;
  storeRefused?: string;
  settings: GraphSettings;
  purpose: Purpose;
  // `graph build`: every file, no parse cap, the long budget.
  whole?: boolean;
  // Build fresh from facts even over the five-second line.
  full?: boolean;
  // Compare the work tree with its base: `changes`, and `impact` of the diff.
  compare?: { base?: string; exclude: string[]; defaultBase?: string | null };
  onProgress?: (line: string) => void;
};

// A capture of the work tree, built or reused, held by a lease.
export async function pinWorkTree(args: PinArgs): Promise<Pinned> {
  const { repoRoot, store, settings } = args;
  // Read before the build: an edit made while it runs shows as a later edit.
  const reference: Reference = { digest: await workTreeDigest(repoRoot, settings.maxFileBytes) };
  let change: Change | undefined;
  if (args.compare) change = await getChange({ repoRoot, scope: args.compare.base !== undefined ? { base: args.compare.base } : {}, exclude: args.compare.exclude, defaultBase: args.compare.defaultBase });
  try {
    const graph = await buildGraph({
      repoRoot,
      store,
      storeRefused: args.storeRefused,
      capture: "working-tree",
      files: change?.changedPaths,
      base: change ? { sha: change.baseSha, files: change.files } : undefined,
      budgetMs: args.whole ? BUILD_ALL_MS : settings.budgetMs,
      maxFiles: args.whole ? Number.MAX_SAFE_INTEGER : settings.maxFiles,
      maxFileBytes: settings.maxFileBytes,
      maxHeapMb: settings.maxHeapMb,
      mode: args.full ? "fresh" : undefined,
      onProgress: args.onProgress,
    });
    let changes: ChangesExtra | undefined;
    if (change) {
      const impact = detectImpact(graph, change);
      const removed = impact.symbols.filter((s) => impact.removed.includes(s.id));
      // Every consumer of each changed public name: the summary's cap is for the brief only.
      changes = { exports: graph.exportChanges, removed: removed.filter((s) => !s.movedTo), moved: removed.filter((s) => s.movedTo) };
    }
    const lease = await leaseOf(store, graph, args.purpose);
    const scope = change ? `${change.baseSha}:${reference.digest}` : undefined;
    return { session: sessionOf(store, graph), lease, changes, change, scope, reference, release: () => lease?.release() };
  } finally { if (change) cleanupDiffs(change); }
}

export type PinnedOrError = Pinned | { error: "generation-unavailable" | "unreadable"; message: string };

// A kept build by its id, held by a lease; it never builds.
export async function pinGeneration(store: GraphStore, id: string, purpose: Purpose): Promise<PinnedOrError> {
  if (!BUILD_ID_PATTERN.test(id)) return { error: "generation-unavailable", message: `${id} is not a build id` };
  const held = await store.lease({ id }, purpose);
  if (!held) return { error: "generation-unavailable", message: `no kept build ${id}` };
  const graph = graphOf(store, held.generation);
  if (!graph) {
    held.lease.release();
    return { error: "unreadable", message: `build ${id} could not be read back` };
  }
  const m = held.generation.manifest;
  // The digest the build kept of what it captured. A build of part of the
  // tree (a review's changed files) never matches the whole tree.
  const reference: Reference = { digest: m.capture.digest };
  prepareIndexes(graph);
  const session: Session = { graph, generation: m.id, treeSha: m.capture.treeSha, builtAt: m.createdAt, laterEditsKnown: false };
  return { session, lease: held.lease, reference, release: () => held.lease.release() };
}
