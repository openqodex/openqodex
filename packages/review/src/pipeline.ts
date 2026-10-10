// The scan and the code graph of a change, for every caller: the one-run
// review (review-change.ts), and the CLI's `scan` and two-step review
// through their flag-shaped wrappers. What only a host can give (where the
// scanner binaries come from, the graph's kept store, where lines go) comes
// in as a host object; nothing here prints or keeps state of its own.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DIFF_CAP_BYTES, loadLensCatalog, safeGit, selectLensesForDiff } from "@openqodex/core";
import type { Change, Config, HotSpot, ImpactSummary, ResolveTool, RuleCoverage, ScanResult, ScannerSource, SelectedLens, WholeRepo } from "@openqodex/core";
import { buildGraph, detectImpact, emptyImpact, hotSymbols, isManifest, langOf } from "@openqodex/graph";
import type { Graph, GraphStore, Lease, ListedFile } from "@openqodex/graph";
import { customAdapters, runScanners } from "@openqodex/scanners";
import { redactStored } from "./redact.js";

export type PipelineResult = {
  // The developer's repository: its config, its run folders, its approvals.
  repoRoot: string;
  // Where the changed files are read and the scanners run: repoRoot, or the
  // temporary checkout of a branch or a pull request under review.
  workDir: string;
  config: Config;
  change: Change;
  // null when the change is empty and nothing was scanned.
  scan: ScanResult | null;
  // Raw matched secrets, in memory only. Never written or printed.
  secrets: string[];
  // The rules scanners that ran checked, token to files, for the lenses.
  checked: Map<string, Set<string>>;
};

// Whether a scanner rule ran on a file in this run: a lens that rule covers
// stands down for that file.
export function ruleCoverage(p: PipelineResult): RuleCoverage {
  return (token, file) => p.checked.get(token)?.has(file) ?? false;
}

// The line a run with nothing to review says.
export function nothingToReviewLine(change: Change): string {
  return `Nothing to review: no changes against ${change.baseRef}`;
}

// What the host gives the scan: where each scanner's binary comes from (and
// whether a missing one may install), where progress lines go, what it
// does with the scan as the scanners left it (the CLI queues its feedback
// offer for a scanner that failed), and where the scanners write: the
// laptop's places when `scratchRoot` is left out, else only under it
// (a server review's scratch, which the host removes).
export type ScanHost = { resolveTool: ResolveTool; onProgress: (line: string) => void; onScan?: (scan: ScanResult) => void; scratchRoot?: string };

// The most of a base version a scanner is given through a base reader.
const BASE_TEXT_BYTES = 64 * 1024 * 1024;

// The scanners on a change already worked out. For the whole repository no
// coverage is passed: every finding in a file of the inventory is kept.
export async function scanChange<C extends Change>(args: {
  repoRoot: string;
  workDir?: string;
  config: Config;
  change: C;
  wholeRepo?: boolean;
  only?: ScannerSource[];
  skip?: ScannerSource[];
  host: ScanHost;
  // How a base version is read, when not with git show in repoRoot (the
  // server review's scope-checking reader over its private clone).
  readBase?: (path: string, maxBytes: number) => Promise<Buffer | null>;
}): Promise<PipelineResult & { change: C }> {
  const { repoRoot, config, change, host } = args;
  const workDir = args.workDir ?? repoRoot;
  if (change.files.length === 0) return { repoRoot, workDir, config, change, scan: null, secrets: [], checked: new Map() };

  const { scan, secrets, checked } = await runScanners({
    repoDir: workDir,
    changedPaths: change.changedPaths,
    coverage: args.wholeRepo ? undefined : change.coverage,
    baseText: async (path) => {
      if (args.readBase) return (await args.readBase(path, BASE_TEXT_BYTES))?.toString("utf8") ?? null;
      const r = await safeGit(repoRoot, ["show", "--no-textconv", `${change.baseSha}:${path}`]);
      return r.code === 0 ? r.stdout.toString("utf8") : null;
    },
    config,
    resolveTool: host.resolveTool,
    // Approvals and the scanner list belong to the developer's repository and
    // its config; an approved scanner runs in workDir, where the files are.
    custom: config.custom.length > 0 ? customAdapters(repoRoot, config) : [],
    only: args.only,
    skip: args.skip,
    onProgress: host.onProgress,
    ...(host.scratchRoot !== undefined ? { scratchRoot: host.scratchRoot } : {}),
  });
  host.onScan?.(scan);
  return { repoRoot, workDir, config, change, scan: redactStored(scan, secrets), secrets, checked };
}

// What the host gives the graph: its kept store (left out, the graph is
// built in memory and nothing is kept, as with --report-dir), where progress
// lines go, and where a warning goes. `store` resolves to a null store with
// the reason when the folder cannot be used; the build then runs in memory.
export type GraphHost = {
  store?: () => Promise<{ store: GraphStore | null; refused?: string }>;
  onProgress: (line: string) => void;
  warn: (line: string) => void;
  // The server review's snapshot, a folder git does not know: the files the
  // graph builds from, and how it reads base versions (scoped.ts).
  inventory?: (dir: string) => ListedFile[];
  readBase?: (path: string, maxBytes: number) => Promise<Buffer | null>;
};

// The graph for this run, or the summary saying why there is none. For the
// whole repo (no base) it reads only the inventory. The graph runs when a
// changed file is code in a supported language or a manifest that decides
// how imports resolve (package.json, tsconfig.json, pyproject.toml, go.mod,
// ...). Never throws: a graph that cannot be built is reported as "failed"
// with one line and the review goes on.
export async function graphFor(p: PipelineResult, host: GraphHost, noGraph: boolean, withBase: boolean): Promise<Graph | ImpactSummary> {
  if (noGraph) return emptyImpact("off", "--no-graph was given");
  if (!p.config.graph.enabled) return emptyImpact("off", "graph.enabled is false in the config");
  const relevant = (path: string | null) => path !== null && (langOf(path) !== null || isManifest(path));
  if (!p.change.files.some((f) => relevant(f.path) || relevant(f.oldPath))) {
    return emptyImpact("skipped", `no ${withBase ? "changed " : ""}file is TypeScript, JavaScript, Python, Go or Ruby code or a manifest`);
  }
  try {
    const { store, refused } = host.store ? await host.store() : { store: null, refused: undefined };
    return await buildGraph({
      repoRoot: p.workDir,
      store,
      storeRefused: refused,
      capture: store === null ? null : p.workDir === p.repoRoot ? "working-tree" : "snapshot",
      files: withBase ? p.change.changedPaths : undefined,
      only: withBase ? undefined : p.change.changedPaths,
      budgetMs: p.config.graph.budgetMs,
      maxFiles: p.config.graph.maxFiles,
      maxFileBytes: p.config.graph.maxFileBytes,
      maxHeapMb: p.config.graph.maxHeapMb,
      onProgress: host.onProgress,
      base: withBase ? { sha: p.change.baseSha, files: p.change.files, ...(host.readBase ? { read: host.readBase } : {}) } : undefined,
      ...(host.inventory ? { inventory: host.inventory(p.workDir) } : {}),
    });
  } catch (error) {
    const reason = ((error as Error).message ?? String(error)).split("\n")[0] ?? "unknown error";
    host.warn(`openqodex: the code graph could not be built: ${reason}`);
    return emptyImpact("failed", reason);
  }
}

const isGraph = (g: Graph | ImpactSummary): g is Graph => "nodes" in g;

// The graph of a review and its view of the change. The build the review
// read is held with a lease until `lease.release()`, so a build that
// another review publishes meanwhile never collects it.
export type GraphRun = { impact: ImpactSummary; graph: Graph | null; lease: Lease | null };

export async function buildGraphRun(p: PipelineResult, host: GraphHost, noGraph: boolean): Promise<GraphRun> {
  const graph = await graphFor(p, host, noGraph, true);
  if (!isGraph(graph)) return { impact: graph, graph: null, lease: null };
  let lease: Lease | null = null;
  if (host.store && graph.status.generation) {
    const { store } = await host.store();
    try {
      lease = (await store?.lease({ id: graph.status.generation }, "review"))?.lease ?? null;
    } catch (error) {
      // The graph is in memory already; without the lease another process
      // may collect the kept build meanwhile, which this review never reads.
      host.warn(`openqodex: the code graph's build is not held for this review: ${((error as Error).message ?? String(error)).split("\n")[0]}`);
    }
  }
  return { impact: redactStored(detectImpact(graph, p.change), p.secrets), graph, lease };
}

const HOT_SYMBOLS = 20;
const SITES_PER_HOT_SYMBOL = 3;

// For the whole repository: every file is touched, so the impact of the
// change would list everything. The graph is built once (which also warms
// its cache for later change reviews), the impact is taken over an empty
// change for its build counts, and the most-called symbols say where to start.
export async function buildHotSpots(p: PipelineResult, host: GraphHost, noGraph: boolean): Promise<{ impact: ImpactSummary; hot: HotSpot[]; note: string | null }> {
  const graph = await graphFor(p, host, noGraph, false);
  if (!isGraph(graph)) {
    const lead = graph.status === "off" ? "The code graph is off" : graph.status === "skipped" ? "The code graph was skipped" : "The code graph could not be built";
    return { impact: graph, hot: [], note: `${lead}: ${graph.reasons.join("; ")}. Find the most-used code with your own tools.` };
  }
  const impact = redactStored(detectImpact(graph, { files: [], coverage: new Map() }), p.secrets);
  const hot = hotSymbols(graph, HOT_SYMBOLS).map((h) => ({
    name: h.symbol.name,
    kind: h.symbol.kind,
    file: h.symbol.file,
    line: h.symbol.startLine,
    callers: h.callers,
    sites: (graph.in.get(h.symbol.id) ?? [])
      .flatMap((e) => e.sites)
      .slice(0, SITES_PER_HOT_SYMBOL)
      .map((s) => `${s.file}:${s.line}`),
  }));
  const note =
    impact.status === "partial"
      ? `The graph is partial: ${impact.reasons.join("; ")}. Callers in the files left out are missing from the counts.`
      : null;
  return { impact, hot: redactStored(hot, p.secrets), note };
}

// The lens triggers over the whole repo: every line counts as changed. Each
// text file contributes its first bytes, an equal share of the 5 MB the
// brief's diff may carry, so a late file is sampled as fully as an early
// one; the matches are then ranked and capped as for a change.
const LENS_SAMPLE_MIN_BYTES = 1024;

export function wholeRepoLenses(change: WholeRepo, covered?: RuleCoverage): SelectedLens[] {
  const text = [...change.lines.keys()];
  const share = Math.max(LENS_SAMPLE_MIN_BYTES, Math.floor(DIFF_CAP_BYTES / Math.max(1, text.length)));
  const buf = Buffer.alloc(share);
  let diff = "";
  for (const path of text) {
    let fd: number;
    try {
      fd = openSync(join(change.repoRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    let read = 0;
    try {
      read = readSync(fd, buf, 0, share, 0);
    } catch {
      // unreadable now: it contributes nothing
    } finally {
      closeSync(fd);
    }
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) diff += `+${line}\n`;
  }
  return selectLensesForDiff({ diff, files: change.changedPaths, catalog: loadLensCatalog(), covered });
}
