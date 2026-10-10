// Builds the graph of a folder: list what git knows (the inventory, with
// content ids), read each file's facts from the store or a parse, model the
// projects from their manifests, then resolve. The five-second rule
// (runtime/predict.ts) decides the mode: under the line the graph is built
// fresh from facts; over it the retained index of the same capture is
// loaded when one exists, else the build runs under the budget and keeps an
// index for next time.
//
// Every stage checks the budget between files, so a 1 ms budget stops a
// cached vscode build within moments, partial and saying so. Facts come in
// changed files first, so a cut never loses them. The parse cap counts
// parses, never cached facts. The heap bound stops admitting files when the
// heap passes it. Nothing here sets a timer.
//
// A generation is published to the store (store/types.ts) with its
// inventory, its project model and what it could not read; the capture's
// tree is written into the repository's objects so its bytes stay readable.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ImpactExportChange } from "@openqodex/core";
import type { Parser } from "web-tree-sitter";
import { captureSnapshot, captureWorkingTree } from "./capture/capture.js";
import { showBlob } from "./capture/git.js";
import { blobId, inventoryDigest, langOf, listInventory, takeInventory } from "./capture/inventory.js";
import type { Inventory, InventoryEntry, ListedFile } from "./capture/inventory.js";
import { exportChanges } from "./changes/exports.js";
import type { ChangedFile } from "./changes/exports.js";
import { goModule, LOCKFILE_BYTES, MANIFEST_BYTES } from "./discovery/manifests.js";
import { discoverProjects } from "./discovery/projects.js";
import { traceReads } from "./discovery/trace.js";
import type { ProjectModel } from "./discovery/projects.js";
import { EXTRACTOR_VERSION, extract } from "./extract.js";
import { frameworkReaders } from "./frameworks/facts.js";
import { contextFingerprint, runFrameworks } from "./frameworks/stage.js";
import { pluginsKey } from "./frameworks/registry.js";
import { MODEL_VERSION } from "./model/records.js";
import type { Cut } from "./model/records.js";
import { grammarVersion, parserFor } from "./parser.js";
import { RESOLVER_VERSION, createWorld, projectFolder, stableKey, symbolId } from "./resolve.js";
import type { FileInput, Resolved, World } from "./resolve.js";
import { asPredictMeta, decideMode, predictMs, recordBuild } from "./runtime/predict.js";
import type { Mode } from "./runtime/predict.js";
import { RepoReader } from "./safe-fs.js";
import { INDEX_FORMAT, readIndex, serializeModel, writeIndex } from "./store/graph-files.js";
import type { GraphStore } from "./store/types.js";
import type { DefFact, FileFacts, Graph, GraphEdge, GraphNode, Lang, NotRead, UnknownSite } from "./types.js";

export { langOf };

export const DEFAULT_BUDGET_MS = 10_000;
export const DEFAULT_MAX_FILES = 4000; // a cap on parses per build; cached facts are not counted
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
// Measured: a whole vscode build (14,300 files) from cached facts needs about
// 1 GB of heap (it fails under 900 MB) and 1.7 GB resident. The bound is
// checked as files are admitted.
export const DEFAULT_MAX_HEAP_MB = 1536;
export const POLICY_VERSION = 1;


export type BuildArgs = {
  // The folder the files are read from: the repository, or the review's snapshot.
  repoRoot: string;
  // Paths to read first (the change), so a cut never loses them.
  files?: string[];
  // When set, the only paths the graph may read: anything else is left out
  // as if it were not in the repo (a whole-repo review passes its inventory,
  // so an excluded file never reaches the brief).
  only?: string[];
  budgetMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxHeapMb?: number;
  // Where facts and generations are kept: the owning repository's
  // .openqodex/graph/. Null keeps nothing (the GitHub Action's
  // --report-dir runs write nothing under .openqodex/).
  store?: GraphStore | null;
  // Why the graph folder was refused when it was opened (openStore's
  // reason); the build, kept in memory, says so first among its reasons.
  storeRefused?: string;
  // What tree the generation's capture is written as: the review snapshot,
  // or the work tree for the graph commands. Null writes no tree.
  capture?: "snapshot" | "working-tree" | null;
  onProgress?: (line: string) => void;
  // The change's base: each changed file's base version is parsed too, so a
  // symbol the change removed is known with its surviving callers, and the
  // export surface is compared in two worlds. `read`: how a base version is
  // read, when not from git in repoRoot (the server review's scope-checking
  // reader over its private clone): the bytes of `path` at the base, or null
  // when it is refused, missing or larger than `maxBytes`.
  base?: { sha: string; files: ChangedFile[]; read?: (path: string, maxBytes: number) => Promise<Buffer | null> };
  // In place of git's listing of repoRoot: the files to build from, each
  // with git's id of the bytes it holds now (the server review's
  // materialised snapshot, a folder with no .git). Only these paths exist
  // for the graph and nothing runs git. Such a build keeps nothing: `store`
  // and `capture` must be left out.
  inventory?: ListedFile[];
  // Forces the mode (tests and `graph build --full`); otherwise the
  // five-second rule decides.
  mode?: Mode;
};

// The key of a file's facts: the extractor, the grammar and the content.
// The framework plugins are part of it: a plugin added or bumped re-reads
// every file (frameworks/registry.ts).
export function factsKey(lang: Lang, blob: string): string {
  return createHash("sha1").update(`${EXTRACTOR_VERSION}\0${lang}\0${grammarVersion(lang)}\0${pluginsKey()}\0${blob}`).digest("hex");
}

// The graph input digest of a capture (PLAN.md 3.2.0): the eligible files
// and their content ids, the graph's versions and index format, every file
// the project model read or looked for (tsconfig chains, manifests,
// workspace files, lockfiles, go.mod files) with its content or its
// absence, what the model made of the work tree, the files left out and
// why, the size cap that decides which are left out, and the framework
// plugins with the paths their output depends on (templates, view files,
// marker files), which no source entry names. The same digest means the
// same graph. The build keys its kept index by it, and the query layer
// compares it to say whether files changed since a build.
export function captureDigest(args: { inv: Inventory; only: string[] | null; maxFileBytes: number; reads: [string, string][]; model: ProjectModel }): string {
  const { inv } = args;
  return inventoryDigest(inv.entries, {
    versions: { model: MODEL_VERSION, extractor: EXTRACTOR_VERSION, resolver: RESOLVER_VERSION, policy: POLICY_VERSION },
    index: INDEX_FORMAT,
    only: args.only,
    maxFileBytes: args.maxFileBytes,
    projects: args.reads,
    // And what the model made of the work tree beyond the files it read:
    // where each file: dependency leads (a folder walked by identity, which
    // may become a link while no listed file changes) and why a file could
    // not be read.
    model: createHash("sha256").update(JSON.stringify(serializeModel(args.model))).digest("hex"),
    tooBig: [...inv.tooBig].sort(),
    unreadable: [...inv.unreadable].sort(),
    frameworks: contextFingerprint(inv.all),
  });
}

// The digest of the work tree of `root` as a build of it now would compute
// it, with no file read but the ones the build's capture and project model
// read.
export async function workTreeDigest(root: string, maxFileBytes: number): Promise<string> {
  const reader = new RepoReader(root);
  const inv = await takeInventory(root, reader, { maxFileBytes });
  const traced = traceReads(reader);
  const model = discoverProjects(inv.all, traced.reader, traced.look);
  readGoModules(traced.reader, inv.all);
  return captureDigest({ inv, only: null, maxFileBytes, reads: traced.entries(), model });
}

function readGoModules(reader: RepoReader, all: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const f of all) {
    if (f !== "go.mod" && !f.endsWith("/go.mod")) continue;
    if (f.split("/").some((part) => part === "node_modules" || part === "vendor")) continue;
    try {
      const mod = goModule(reader.read(f, MANIFEST_BYTES) ?? "");
      if (mod) out.push([mod, posix.dirname(f) === "." ? "" : posix.dirname(f)]);
    } catch {
      // unreadable go.mod: its imports stay outside the repo
    }
  }
  return out;
}


function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// Parsers, one per language, closed after the build.
// The longest one file's parse may take: tree-sitter's error recovery is
// slow on some broken input (an unclosed comment of half a megabyte takes
// minutes), so a parse past this, or past the build's budget, is stopped
// and the file is listed as not read.
export const MAX_PARSE_MS = 2000;

class Parsers {
  private map = new Map<Lang, Parser>();
  count = 0; // parses started: what the parse cap counts
  // "slow" when the last parse was stopped at MAX_PARSE_MS, "budget" when at the build's deadline.
  stopped: "slow" | "budget" | null = null;
  async facts(lang: Lang, content: string, deadline: number): Promise<FileFacts | null> {
    let parser = this.map.get(lang);
    if (!parser) {
      parser = await parserFor(lang);
      this.map.set(lang, parser);
    }
    this.count++;
    this.stopped = null;
    const started = performance.now();
    const limit = Math.min(started + MAX_PARSE_MS, deadline);
    // Returning true from the progress callback cancels the parse.
    const progressCallback = (() => performance.now() > limit) as unknown as (state: unknown) => void;
    const tree = parser.parse(content, null, { progressCallback });
    if (!tree) {
      this.stopped = limit === deadline && deadline < started + MAX_PARSE_MS ? "budget" : "slow";
      return null;
    }
    try {
      // The plugins' readers ride on the extractor's walk: one walk of the tree for everything.
      const reading = frameworkReaders(tree.rootNode, lang, content);
      const facts = extract(tree, lang, reading.visitors);
      const frameworks = reading.finish();
      if (frameworks) facts.frameworks = frameworks;
      return facts;
    } finally {
      tree.delete();
    }
  }
  close(): void {
    for (const p of this.map.values()) p.delete();
  }
}

// One file's local facts from its text, parsed and extracted exactly as a
// build does it, with the same limit on one parse. Null when the parse was
// stopped at MAX_PARSE_MS. The parser and the tree are freed before it returns.
export async function extractFacts(lang: Lang, content: string): Promise<FileFacts | null> {
  const parsers = new Parsers();
  try {
    return await parsers.facts(lang, content, Number.POSITIVE_INFINITY);
  } finally {
    parsers.close();
  }
}

const MANIFESTS = /(^|\/)(package\.json|tsconfig\.json|jsconfig\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg|go\.mod|go\.work|Gemfile)$/;
export function isManifest(path: string): boolean {
  return MANIFESTS.test(path);
}

export async function buildGraph(args: BuildArgs): Promise<Graph> {
  const started = performance.now();
  const budgetMs = args.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = started + budgetMs;
  const maxFiles = args.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = args.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxHeap = (args.maxHeapMb ?? DEFAULT_MAX_HEAP_MB) * 1024 * 1024;
  const store = args.store ?? null;
  const stages: Record<string, number> = {};
  let mark = performance.now();
  const stage = (name: string) => {
    const now = performance.now();
    stages[name] = Math.round((stages[name] ?? 0) + (now - mark));
    mark = now;
  };
  const overBudget = () => performance.now() > deadline;
  const reasons: string[] = [];
  if (!store && args.storeRefused) reasons.push(`the graph folder is not used: ${args.storeRefused}`);
  const refusedBefore = store?.refusedFacts ?? 0;
  const changedBefore = store?.changedFacts ?? 0;
  const cuts: Cut[] = [];
  const notRead: NotRead[] = [];

  // ---------- inventory ----------
  if (args.inventory && (store !== null || args.capture)) throw new Error("a build from an inventory keeps nothing: pass no store and no capture");
  const reader = new RepoReader(args.repoRoot);
  const only = args.only === undefined ? undefined : new Set(args.only);
  const inv = args.inventory ? listInventory(args.repoRoot, reader, { files: args.inventory, maxFileBytes, only }) : await takeInventory(args.repoRoot, reader, { maxFileBytes, only });
  const known = new Set(inv.entries.map((e) => e.path));
  for (const f of inv.all) if (f.endsWith("__init__.py") && langOf(f) !== null) known.add(f);
  for (const f of inv.tooBig) notRead.push({ file: f, reason: "size" });
  for (const f of inv.unreadable) notRead.push({ file: f, reason: "unreadable" });
  const eligible = inv.entries.length + inv.tooBig.length + inv.unreadable.length;
  // The change first, then everything else in git's order.
  const firstSet = new Set((args.files ?? []).filter((f) => known.has(f)));
  const order = [...inv.entries.filter((e) => firstSet.has(e.path)), ...inv.entries.filter((e) => !firstSet.has(e.path))];
  stage("inventory");

  // ---------- projects ----------
  // Read first, and traced: what the model read and looked for is part of
  // what a kept index is matched by.
  const traced = traceReads(reader);
  const model = discoverProjects(inv.all, traced.reader, traced.look);
  const goModules = readGoModules(traced.reader, inv.all);
  stage("projects");

  // ---------- the mode ----------
  const meta = store ? asPredictMeta(store.readMeta()?.predict ?? null) : null;
  const cached = store ? order.reduce((n, e) => n + Number(store.hasFacts(factsKey(e.lang, e.blob))), 0) : 0;
  const predicted = predictMs(meta, { eligible, cached });
  const decided = args.mode ? { mode: args.mode, streak: 0 } : decideMode(meta, predicted);
  const config = { budgetMs, maxFiles, maxFileBytes, maxHeapMb: Math.round(maxHeap / 1024 / 1024) };
  const versions = { model: MODEL_VERSION, extractor: EXTRACTOR_VERSION, resolver: RESOLVER_VERSION, policy: POLICY_VERSION };
  // What a kept index was resolved from (captureDigest above).
  const digest = captureDigest({ inv, only: args.only ?? null, maxFileBytes, reads: traced.entries(), model });
  stage("predict");

  // Retained: the same capture's index, when a complete one is kept.
  if (decided.mode === "retained" && store && !args.base) {
    const reused = store.list().find((m) => m.capture.digest === digest && m.complete && m.hasIndex);
    const opened = reused ? store.open({ id: reused.id }) : null;
    const loaded = opened ? readIndex(opened) : null;
    if (reused && loaded) {
      stage("load-index");
      const durationMs = Math.round(performance.now() - started);
      // Recorded for the mode and its streak; nothing was parsed or resolved, so no rate is measured.
      const next = recordBuild(meta, { eligible, parsed: 0, cached: 0, stages: { parse: 0, facts: 0, other: durationMs }, predictedMs: predicted, actualMs: durationMs, mode: decided.mode, streak: decided.streak }, { rates: false });
      try {
        await store.updateMeta((m) => ({ ...m, predict: next }));
      } catch {
        // the record is lost; the next build decides again
      }
      args.onProgress?.(`Code graph: ${plural(loaded.status.filesParsed, "file")} from the retained index in ${(durationMs / 1000).toFixed(1)} s`);
      return { ...loaded, repoRoot: args.repoRoot, status: { ...loaded.status, durationMs, parses: 0, cacheHits: 0, mode: "retained", generation: reused.id, predictedMs: predicted, stages } };
    }
  }

  // ---------- facts ----------
  const parsers = new Parsers();
  const inputs: FileInput[] = [];
  const keys = new Map<string, { key: string; blob: string; lang: Lang }>();
  let hits = 0;
  let parseCapped = 0;
  let stoppedBy: "budget" | "memory" | null = null;
  let changedDuringBuild = 0;
  let factsMs = 0;
  let parseMs = 0;
  const memo = new Map<string, FileFacts>(); // facts of this build, for the base side of unchanged content
  let storageRefused = 0;
  const factsFor = async (lang: Lang, blob: string, read: () => Buffer | null, canParse: boolean): Promise<{ facts: FileFacts | null; key: string; blob: string; parsed: boolean; stopped?: "slow" | "budget" | null }> => {
    let key = factsKey(lang, blob);
    const t0 = performance.now();
    const hit = memo.get(key) ?? store?.readFacts(key) ?? null;
    if (hit) {
      factsMs += performance.now() - t0;
      memo.set(key, hit);
      return { facts: hit, key, blob, parsed: false };
    }
    if (!canParse) return { facts: null, key, blob, parsed: false };
    const t1 = performance.now();
    const bytes = read();
    if (bytes === null) return { facts: null, key, blob, parsed: false };
    // A file that changed since the inventory is keyed by what was read.
    const actual = blobId(bytes);
    if (actual !== blob && blobId(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))) !== blob) {
      changedDuringBuild++;
      blob = actual;
      key = factsKey(lang, blob);
    }
    const facts = await parsers.facts(lang, bytes.toString("utf8"), deadline);
    parseMs += performance.now() - t1;
    if (!facts) return { facts: null, key, blob, parsed: true, stopped: parsers.stopped };
    memo.set(key, facts);
    // The graph folder's bound holds while the build writes, not only when it publishes.
    if (store && store.writeFacts(key, facts) === "over-budget") storageRefused++;
    return { facts, key, blob, parsed: true };
  };
  try {
    for (const [i, e] of order.entries()) {
      // Every cap holds for every file, the changed ones too: they come
      // first, so a cap reached late never loses them, and one reached early
      // says so. Past the budget or the memory bound nothing more is
      // admitted, cached facts included.
      if (overBudget()) {
        stoppedBy = "budget";
        for (const rest of order.slice(i)) notRead.push({ file: rest.path, reason: "budget" });
        break;
      }
      if (process.memoryUsage().heapUsed > maxHeap) {
        stoppedBy = "memory";
        for (const rest of order.slice(i)) notRead.push({ file: rest.path, reason: "memory" });
        break;
      }
      const canParse = parsers.count < maxFiles;
      const got = await factsFor(e.lang, e.blob, () => reader.readBytes(e.path, maxFileBytes), canParse);
      if (!got.facts) {
        if (!canParse) {
          parseCapped++;
          notRead.push({ file: e.path, reason: "parse-cap" });
        } else if (got.stopped) {
          if (got.stopped === "budget") stoppedBy = "budget";
          notRead.push({ file: e.path, reason: got.stopped === "slow" ? "slow-parse" : "budget" });
        } else notRead.push({ file: e.path, reason: got.parsed ? "parse-error" : "unreadable" });
        continue;
      }
      if (!got.parsed) hits++;
      keys.set(e.path, { key: got.key, blob: got.blob, lang: e.lang });
      inputs.push({ path: e.path, facts: got.facts });
    }
    stage("facts");

    // ---------- base versions of the changed files ----------
    const baseFacts = new Map<string, { file: string; facts: FileFacts }>();
    const current = new Set(inputs.map((i) => i.path));
    let removalUnchecked = 0;
    const baseManifests = new Map<string, string | null>();
    const base = args.base;
    const readBase = base?.read ?? ((path: string, maxBytes: number) => showBlob(args.repoRoot, base?.sha ?? "", path, maxBytes));
    for (const f of args.base?.files ?? []) {
      if (f.status === "added" || !args.base) continue;
      const basePath = f.oldPath ?? f.path;
      if (isManifest(basePath)) {
        const bytes = await readBase(basePath, LOCKFILE_BYTES);
        baseManifests.set(basePath, bytes === null ? null : bytes.toString("utf8"));
      }
      const lang = langOf(basePath);
      if (!lang) continue;
      known.add(basePath);
      if (f.status !== "deleted" && !current.has(f.path)) continue;
      // Base versions count against the same caps: the size is asked
      // before the bytes are read, and the budget, the memory bound and the
      // parse cap hold.
      const admitted = !overBudget() && process.memoryUsage().heapUsed <= maxHeap;
      const bytes = admitted ? await readBase(basePath, maxFileBytes) : null;
      const got = bytes === null ? null : await factsFor(lang, blobId(bytes), () => bytes, !overBudget() && parsers.count < maxFiles);
      if (!got?.facts) {
        removalUnchecked++;
        continue;
      }
      baseFacts.set(f.path, { file: basePath, facts: got.facts });
    }
    stage("base");

    // ---------- projects and resolution ----------
    // Asked once per file by the resolver and by every framework plugin: kept per file.
    const projects = new Map<string, string>();
    const projectOf = (file: string): string => {
      let p = projects.get(file);
      if (p === undefined) projects.set(file, (p = projectFolder(model, goModules, file)));
      return p;
    };
    const world = createWorld({ files: inputs, known, model, goModules, stop: overBudget });
    const resolved = world.resolveAll();
    if (resolved.budgetFiles.length > 0) stoppedBy ??= "budget";
    stage("resolve");

    // ---------- frameworks ----------
    // After symbol resolution, on every build: a file whose content did not
    // change is re-read when a framework is newly detected around it.
    const frameworks = runFrameworks({ files: inputs, paths: inv.all, nodes: resolved.nodes, defsByFile: resolved.defsByFile, edges: resolved.edges, world, model, projectOf, stop: overBudget });
    for (const p of frameworks.plugins) if (p.status === "failed" || (p.status === "stopped" && inputs.some((i) => i.facts.frameworks?.[p.id]))) reasons.push(p.reason ?? `the ${p.id} plugin did not run`);
    stage("frameworks");

    // ---------- removed, moved and the export surface ----------
    const removed = removedSymbols(args.base?.files ?? [], baseFacts, resolved);
    let exportsDiff: ImpactExportChange[] = [];
    if (args.base && args.base.files.length > 0 && !overBudget()) {
      exportsDiff = await compareWorlds({
        args,
        inputs,
        baseFacts,
        baseManifests,
        known,
        reader,
        all: inv.all,
        model,
        goModules,
        world,
        // Removed and moved definitions are reported with the removed symbols, never again as public names.
        removedKeys: new Set([...removed.values()].flat().map((n) => stableKey(n.id.replace(/^base:/, "")))),
        cuts,
      });
    } else if (args.base && args.base.files.length > 0) {
      reasons.push("the export surface was not compared: the budget ran out");
    }
    // The walks of export * and the export lookups stop with a cut, in either version.
    addWalkCuts(cuts, world);
    stage("compare");

    // ---------- the graph ----------
    const graphIn = new Map<string, GraphEdge[]>();
    const graphOut = new Map<string, GraphEdge[]>();
    for (const e of resolved.edges) {
      (graphIn.get(e.to) ?? graphIn.set(e.to, []).get(e.to))?.push(e);
      (graphOut.get(e.from) ?? graphOut.set(e.from, []).get(e.from))?.push(e);
    }
    const refsIn = new Map<string, GraphEdge[]>();
    const refsOut = new Map<string, GraphEdge[]>();
    for (const e of resolved.references) {
      (refsIn.get(e.to) ?? refsIn.set(e.to, []).get(e.to))?.push(e);
      (refsOut.get(e.from) ?? refsOut.set(e.from, []).get(e.from))?.push(e);
    }
    const unknowns: UnknownSite[] = [...resolved.unknowns];
    for (const file of resolved.budgetFiles) {
      unknowns.push({ file, line: 0, column: 0, name: "", cause: "budget", shape: "other", caller: file, scope: "file", note: "the budget ran out before every call of this file was resolved" });
    }
    const unknownNames = new Map<string, number>();
    const valueCalls = new Map<string, number>();
    for (const u of unknowns) {
      if (u.name !== "") unknownNames.set(u.name, (unknownNames.get(u.name) ?? 0) + 1);
      if (u.scope === "project" && u.cause !== "metadata-unreadable") {
        const p = projectOf(u.file);
        valueCalls.set(p, (valueCalls.get(p) ?? 0) + 1);
      }
    }

    const tooBig = inv.tooBig.length;
    const skipped = notRead.length;
    if (removalUnchecked > 0) reasons.push(`removed symbols were not checked in ${plural(removalUnchecked, "changed file")}`);
    if (stoppedBy === "budget") {
      const left = notRead.filter((n) => n.reason === "budget").length;
      reasons.push(`the ${(budgetMs / 1000).toFixed(budgetMs < 1000 ? 3 : 0)} s budget ran out${left > 0 ? ` with ${plural(left, "file")} not read` : ""}${resolved.budgetFiles.length > 0 ? ` and the calls of ${plural(resolved.budgetFiles.length, "file")} not resolved` : ""}`);
      cuts.push({ by: "budget", at: null, omitted: left + resolved.budgetFiles.length, exact: true, unit: "files", note: `stopped ${Math.max(0, Math.round(performance.now() - deadline))} ms after the ${budgetMs} ms budget` });
    }
    if (stoppedBy === "memory") {
      const left = notRead.filter((n) => n.reason === "memory").length;
      reasons.push(`the ${config.maxHeapMb} MB memory bound left out ${plural(left, "file")}`);
      cuts.push({ by: "memory", at: null, omitted: left, exact: true, unit: "files", note: `the heap passed ${config.maxHeapMb} MB` });
    }
    if (parseCapped > 0) {
      reasons.push(`the ${plural(maxFiles, "parse")} cap left out ${plural(parseCapped, "file")}; run \`openqodex graph build\` once to complete it`);
      cuts.push({ by: "parse-cap", at: null, omitted: parseCapped, exact: true, unit: "files", note: `${maxFiles} parses per build` });
    }
    if (tooBig > 0) {
      reasons.push(`${plural(tooBig, "file")} over ${Math.round(maxFileBytes / 1024)} KB not read`);
      cuts.push({ by: "size", at: null, omitted: tooBig, exact: true, unit: "files", note: `files over ${maxFileBytes} bytes` });
    }
    const parseErrors = notRead.filter((n) => n.reason === "parse-error" || n.reason === "unreadable").length;
    if (parseErrors > 0) reasons.push(`${plural(parseErrors, "file")} could not be read or parsed`);
    const gaps = model.unreadable;
    // Only a gap that can hide a relation makes the build partial
    // (discovery/projects.ts GAP_RULES); every gap is said.
    const hidingGaps = gaps.filter((g) => g.affects.length > 0);
    const firstGap = gaps[0];
    if (firstGap) reasons.push(gaps.length === 1 ? firstGap.note : `${plural(gaps.length, "manifest or tsconfig file")} could not be read, parsed or followed, the first: ${firstGap.note}`);
    if (changedDuringBuild > 0) reasons.push(`${plural(changedDuringBuild, "file")} changed while the graph was built; their facts are from what was read`);
    if (storageRefused > 0) {
      reasons.push(`the graph folder reached its ${Math.round((store?.boundBytes ?? 0) / 1024 / 1024)} MB bound: the facts of ${plural(storageRefused, "file")} were not saved and will be parsed again`);
      cuts.push({ by: "storage", at: null, omitted: storageRefused, exact: true, unit: "files", note: "facts not saved: the graph folder is at its size bound" });
    }
    if (store?.diskFull) reasons.push("the disk is full: the graph was not saved");
    const untrusted = (store?.refusedFacts ?? 0) - refusedBefore;
    if (untrusted > 0) reasons.push(`${plural(untrusted, "facts file")} in the graph folder could be changed by other users and ${untrusted === 1 ? "was" : "were"} parsed again`);
    const changed = (store?.changedFacts ?? 0) - changedBefore;
    if (changed > 0) reasons.push(`${plural(changed, "facts file")} in the graph folder differed from what openqodex recorded and ${changed === 1 ? "was" : "were"} parsed again`);
    stage("assemble");

    const durationMs = Math.round(performance.now() - started);
    const graph: Graph = {
      repoRoot: args.repoRoot,
      nodes: resolved.nodes,
      edges: resolved.edges,
      in: graphIn,
      out: graphOut,
      references: resolved.references,
      refsIn,
      refsOut,
      dispatch: resolved.dispatch,
      summaries: resolved.summaries,
      importers: resolved.importers,
      defsByFile: resolved.defsByFile,
      removed,
      misses: resolved.misses,
      unknowns,
      unknownNames,
      valueCalls,
      model,
      projectOf,
      exportChanges: exportsDiff,
      frameworks,
      status: {
        status: skipped > 0 || removalUnchecked > 0 || resolved.budgetFiles.length > 0 || hidingGaps.length > 0 ? "partial" : "ok",
        reason: reasons[0] ?? null,
        reasons,
        filesParsed: inputs.length,
        filesSkipped: skipped,
        durationMs,
        eligibleFiles: eligible,
        cacheHits: hits,
        parses: parsers.count,
        unresolvedSites: resolved.unresolvedSites,
        externalSites: resolved.externalSites,
        mode: decided.mode,
        generation: null,
        predictedMs: predicted,
        stages,
        cuts,
        notRead,
      },
    };

    // ---------- publish ----------
    // Complete: nothing a later build of the same files could add. A file
    // over the size cap, or one the parser rejects, is left out the same way
    // every time; one cut by the budget, the parse cap, the memory bound or
    // a slow parse, or one that vanished while it was read, is not. Nor is
    // a build whose project model lacks a manifest or tsconfig that can hide
    // a relation: its index is never loaded as if nothing were missing.
    const later = new Set<NotRead["reason"]>(["budget", "parse-cap", "memory", "slow-parse", "unreadable"]);
    const complete = !notRead.some((n) => later.has(n.reason)) && resolved.budgetFiles.length === 0 && hidingGaps.length === 0;
    const withIndex = decided.mode === "retained" && complete;
    // A kept build of the same capture and configuration is the same graph:
    // it is named, and nothing new is written.
    const same = store && complete ? store.list().find((m) => m.capture.digest === digest && m.complete && (m.hasIndex || !withIndex)) : undefined;
    if (store && same) {
      graph.status.generation = same.id;
      stage("publish");
    } else if (store && !store.diskFull) {
      let treeSha: string | null = null;
      try {
        if (args.capture === "snapshot") treeSha = await captureSnapshot(args.repoRoot);
        else if (args.capture === "working-tree") treeSha = await captureWorkingTree(args.repoRoot);
      } catch (error) {
        reasons.push(`the capture's files were not kept: ${((error as Error).message ?? "").split("\n")[0]}`);
      }
      stage("capture");
      const files: Record<string, string> = {
        "inventory.json": JSON.stringify({ files: Object.fromEntries([...keys].map(([p, k]) => [p, k])) }),
        "projects.json": JSON.stringify({ model: serializeModel(model), goModules }),
        "coverage.json": JSON.stringify({ notRead, cuts, budgetFiles: resolved.budgetFiles }),
      };
      if (withIndex) Object.assign(files, writeIndex(graph));
      const published = await store.publish({
        manifest: {
          capture: { kind: args.capture === "working-tree" ? "working-tree" : args.capture === "snapshot" ? "snapshot" : "revision", treeSha, digest, dirtyPaths: null },
          versions,
          config,
          status: graph.status.status,
          complete,
          counts: { eligible, inGraph: inputs.length, parsed: parsers.count, fromCache: hits, skipped },
          mode: decided.mode,
          reasons,
          stages,
          wallMs: durationMs,
          hasIndex: withIndex,
        },
        files,
      });
      if (published.ok) {
        graph.status.generation = published.id;
        if (published.overBudget) reasons.push(`the graph folder is over its ${Math.round(published.overBudget.boundBytes / 1024 / 1024)} MB bound: ${plural(published.overBudget.protected.length, "build")} in use are kept`);
      } else if (published.error === "disk-full") reasons.push("the disk is full: the graph was not saved");
      else reasons.push(`the graph was not saved: ${published.reason}`);
      stage("publish");
      graph.status.reason = reasons[0] ?? null;
    }
    // The whole build, capture and publication included, measured for the five-second rule.
    const actualMs = Math.round(performance.now() - started);
    graph.status.durationMs = actualMs;
    if (store && !store.diskFull) {
      const other = Math.max(0, actualMs - Math.round(parseMs) - Math.round(factsMs));
      const next = recordBuild(meta, {
        eligible,
        parsed: parsers.count,
        cached: hits,
        stages: { parse: Math.round(parseMs), facts: Math.round(factsMs), other },
        predictedMs: predicted,
        actualMs,
        mode: decided.mode,
        streak: decided.streak,
      });
      try {
        await store.updateMeta((m) => ({ ...m, predict: next }));
      } catch {
        // the measurement is lost; the next build measures again
      }
    }
    args.onProgress?.(`Code graph: ${plural(inputs.length, "file")} in ${(actualMs / 1000).toFixed(1)} s (${parsers.count} parsed, ${hits} from cache, ${decided.mode})`);
    return graph;
  } finally {
    parsers.close();
  }
}

// Symbols in the base version of a changed file and gone from it now. A
// file git renamed is gone from its old path as a whole: a symbol still
// defined at the new path moved with it. Any other gone symbol moved when
// exactly one file of the change gained a definition of the same kind,
// owner and name, or else exactly one definition with the same body under
// another name (moved and renamed). impact.ts drops the move while a call
// site still reaches the old place.
function removedSymbols(files: ChangedFile[], baseDefs: Map<string, { file: string; facts: FileFacts }>, resolved: Resolved): Map<string, GraphNode[]> {
  const keyOf = (n: GraphNode) => `${n.kind}\0${ownerOf(n.id)}\0${n.name}`;
  const baseKey = (d: DefFact) => `${d.kind}\0${d.owner ?? ""}\0${d.name}`;
  // Definitions the change added: in an added file, and in any other changed
  // file those its base version did not have. A file whose base version was
  // not read gained nothing that can be known.
  const gained = new Map<string, GraphNode[]>();
  const gainedBody = new Map<string, GraphNode[]>();
  for (const f of files) {
    const defs = f.status === "deleted" ? undefined : resolved.defsByFile.get(f.path);
    const base = baseDefs.get(f.path);
    if (!defs || (f.status !== "added" && !base)) continue;
    const had = new Set(base?.facts.defs.map(baseKey));
    const hadBody = new Set(base?.facts.defs.map((d) => d.bodyHash).filter(Boolean));
    for (const n of defs) {
      if (had.has(keyOf(n))) continue;
      (gained.get(keyOf(n)) ?? gained.set(keyOf(n), []).get(keyOf(n)))?.push(n);
      if (n.bodyHash && !hadBody.has(n.bodyHash)) (gainedBody.get(n.bodyHash) ?? gainedBody.set(n.bodyHash, []).get(n.bodyHash))?.push(n);
    }
  }
  const removed = new Map<string, GraphNode[]>();
  for (const [path, base] of baseDefs) {
    const renamed = base.file !== path;
    const now = new Map<string, GraphNode>();
    for (const n of resolved.defsByFile.get(path) ?? []) if (!now.has(keyOf(n))) now.set(keyOf(n), n);
    const gone: GraphNode[] = [];
    for (const d of base.facts.defs) {
      let to = now.get(baseKey(d));
      if (to && !renamed) continue;
      let byBody = false;
      if (!to) {
        const elsewhere = (gained.get(baseKey(d)) ?? []).filter((n) => n.file !== path);
        if (new Set(elsewhere.map((n) => n.file)).size === 1) to = elsewhere[0];
      }
      if (!to && d.bodyHash) {
        // The same body under another name: one definition in one file only.
        const same = (gainedBody.get(d.bodyHash) ?? []).filter((n) => n.kind === d.kind && n.name !== d.name);
        if (same.length === 1) {
          to = same[0];
          byBody = true;
        }
      }
      const node: GraphNode = {
        id: `base:${symbolId(base.file, d)}`,
        file: base.file,
        name: d.name,
        kind: d.kind,
        startLine: d.line,
        endLine: d.endLine,
        snapshot: "base",
        exported: d.exported,
        lang: base.facts.lang,
      };
      if (to) node.movedTo = { id: to.id, file: to.file, line: to.startLine, ...(byBody ? { renamed: true } : {}) };
      gone.push(node);
    }
    if (gone.length > 0) removed.set(path, gone);
  }
  return removed;
}

// A world's walk cuts, each kind once whichever version of the code made it.
function addWalkCuts(cuts: Cut[], world: World): void {
  for (const cut of world.walkCuts()) if (!cuts.some((x) => x.by === cut.by && x.note === cut.note)) cuts.push(cut);
}

// "a.ts#Cls.m@3:5" to "Cls"; "" for a symbol with no owner.
function ownerOf(id: string): string {
  const name = id.slice(id.indexOf("#") + 1, id.lastIndexOf("@"));
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(0, dot);
}

// The base world: the base version of every changed file (deleted and
// renamed files at their old path), the current facts of every other file,
// and, when a manifest changed, the project model as the base had it.
async function compareWorlds(c: {
  args: BuildArgs;
  inputs: FileInput[];
  baseFacts: Map<string, { file: string; facts: FileFacts }>;
  baseManifests: Map<string, string | null>;
  known: Set<string>;
  reader: RepoReader;
  all: string[];
  model: ProjectModel;
  goModules: [string, string][];
  world: World;
  removedKeys: Set<string>;
  cuts: Cut[]; // the walk of export * adds its cut here
}): Promise<ImpactExportChange[]> {
  const changed = c.args.base?.files ?? [];
  const drop = new Set(changed.map((f) => f.path));
  const baseInputs: FileInput[] = c.inputs.filter((i) => !drop.has(i.path));
  for (const [, b] of c.baseFacts) baseInputs.push({ path: b.file, facts: b.facts });
  const baseKnown = new Set([...c.known].filter((p) => !changed.some((f) => f.status === "added" && f.path === p)));
  for (const [, b] of c.baseFacts) baseKnown.add(b.file);
  // The base model: the manifests as the base had them.
  let baseModel = c.model;
  const seeds: { manifest: string; files: string[] }[] = [];
  if (c.baseManifests.size > 0) {
    // A base manifest is held to the same cap as the changed one, so a file
    // over it is unreadable in both versions, never a change between them.
    const baseText = (path: string, max: number): string | null => {
      const t = c.baseManifests.get(path) ?? null;
      return t !== null && Buffer.byteLength(t, "utf8") <= max ? t : null;
    };
    const overlay = {
      root: c.reader.root,
      read: (path: string, max: number): string | null => (c.baseManifests.has(path) ? baseText(path, max) : c.reader.read(path, max)),
      readBytes: (path: string, max: number): Buffer | null => {
        const t = c.baseManifests.has(path) ? baseText(path, max) : c.reader.read(path, max);
        return t === null ? null : Buffer.from(t);
      },
    } as unknown as RepoReader;
    const baseAll = [...new Set([...c.all, ...[...c.baseManifests.keys()].filter((p) => c.baseManifests.get(p) !== null)])];
    baseModel = discoverProjects(baseAll, overlay);
    for (const manifest of c.baseManifests.keys()) {
      const dir = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
      const base = posix.basename(manifest);
      let files: string[];
      if (base === "package.json") {
        // Every file that imports the package by name, in either world.
        const names = new Set([c.model.node.find((p) => p.file === manifest)?.pkg.name, baseModel.node.find((p) => p.file === manifest)?.pkg.name].filter((n): n is string => !!n));
        files = c.inputs.filter((i) => i.facts.imports.some((imp) => [...names].some((n) => imp.spec === n || imp.spec.startsWith(`${n}/`)))).map((i) => i.path);
      } else files = c.inputs.filter((i) => dir === "" || i.path.startsWith(`${dir}/`)).map((i) => i.path);
      seeds.push({ manifest, files });
    }
  }
  const baseWorld = createWorld({ files: baseInputs, known: baseKnown, model: baseModel, goModules: c.goModules });
  const changes = exportChanges({
    current: c.world,
    base: baseWorld,
    changed,
    files: c.inputs.map((i) => i.path),
    baseFiles: baseInputs.map((i) => i.path),
    removedKeys: c.removedKeys,
    seeds,
    nodeOf: (world, id) => {
      const n = (world === "base" ? baseWorld : c.world).node(id);
      return n ? { id: n.id, file: n.file, line: n.startLine } : null;
    },
  });
  addWalkCuts(c.cuts, baseWorld);
  return changes;
}

export type { InventoryEntry };
