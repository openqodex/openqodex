// The one-run review, without the command around it:
//
//   prepare   the change, and a frozen snapshot of it made by the host's
//             snapshot maker: committed, uncommitted and untracked work
//             (or a target's head), links as plain files
//   scan      the scanners and the code graph, on the snapshot
//   redact    secrets the scanners found, in the snapshot copy only
//   review    a reviewer process a driver starts (agents/), given the brief,
//             reading the snapshot alone
//   check     the answer, by script, with at most two correction rounds;
//             coverage from the brief, the correction rounds and, for a
//             reviewer whose trace is complete, its reads
//   report    one standard report and the completion record
//   clean     the snapshot is removed, whatever happened
//
// runReviewCore takes plain values and the host's parts, and hands back the
// result. By itself it writes nothing under .openqodex/ or in the openqodex
// home, registers no signal handler, writes no process.env and prints
// nothing: every line goes to `onEvent`, and the host writes the run folder,
// the receipts and the records from the events and the result (the CLI's
// review-run.ts). What it makes on disk it makes through the host's parts:
// the snapshot through the snapshot maker, scanner installs through the tool
// resolver, the graph's kept build through the graph store.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_CONFIG,
  MANIFEST_VERSION,
  OpenQodexError,
  display,
  buildDisplay,
  buildExcerptDisplay,
  buildInventory,
  buildReviewerBrief,
  checkSubmission,
  REVIEWER_TOOLS,
  REVIEWER_WEB_TOOLS,
  completionRecord,
  configHash,
  getChange,
  getTreeChange,
  getWholeRepo,
  modelCoverage,
  readCoverage,
  redactSecrets,
  safeGit,
  selectLenses,
  verdictFor,
} from "@openqodex/core";
import type {
  BaseSource,
  Change,
  ChangeScope,
  CompletionRecord,
  Config,
  Display,
  ImpactSummary,
  Report,
  ResolveTool,
  ReviewerRecord,
  RunManifest,
  RunTarget,
  ScanResult,
  ScannerSource,
  SelectedLens,
  SubmissionV2,
  TraceEntry,
  WholeRepo,
} from "@openqodex/core";
import { PacketCollision, PacketLeak, renderImpactBlock, writePacket } from "@openqodex/graph";
import type { Graph, GraphStore, Lease } from "@openqodex/graph";
import { createToolResolver } from "@openqodex/scanners";
import { meterSession } from "./agent-usage.js";
import { REVIEWER_NAMES, hostAgent } from "./agents/driver.js";
import type { ReviewerDriver, ReviewerSession } from "./agents/driver.js";
import { checkContext, useContext } from "./context.js";
import type { ContextItem } from "./context.js";
import { converse, deliverRanges, redactSnapshot } from "./conversation.js";
import type { Conversation, Speaker } from "./conversation.js";
import { modelSession, modelToolEntry } from "./model-loop.js";
import type { ModelSession } from "./model-loop.js";
import { modelEvidence } from "./evidence.js";
import { modelRecord, modelReport, reviewRender } from "./model-record.js";
import { agentReviewer } from "./reviewer.js";
import type { Budget, Disposition, ModelReviewer, ResultFinding, ReviewChangeInput, ReviewChangeOptions, Reviewer, ReviewResult } from "./reviewer.js";
import { disagreementsOf, mergeFindings, runSecondReviewer, withSecondReviewer } from "./second.js";
import type { SecondRun } from "./second.js";
import { buildGraphRun, buildHotSpots, nothingToReviewLine, ruleCoverage, scanChange, wholeRepoLenses } from "./pipeline.js";
import type { GraphHost, PipelineResult, ScanHost } from "./pipeline.js";
import { decideIncremental } from "./incremental.js";
import type { IncrementalDecision, ReviewScope } from "./incremental.js";
import { MissingObjects } from "./materialize.js";
import { redactStored } from "./redact.js";
import { serverScope } from "./scoped.js";
import type { ScopedParts } from "./scoped.js";
import { admitted } from "./scopes.js";
import { hashSnapshot, lineCounter, snapshotText } from "./snapshot.js";
import type { ToolBox } from "./tools/index.js";
import { usageTotals } from "./usage.js";
import type { CallRecord, ModelReviewEvidence, ToolLogEntry, UsageTotals } from "./usage.js";

// A frozen copy of the state under review: `tree` is the folder the
// scanners and the reviewer read; `folder` holds it and whatever the maker
// keeps beside it.
export type Snapshot = { folder: string; tree: string };

// How the host makes and removes snapshots (on the laptop: git work trees
// under <openqodex home>/checkouts, the CLI's checkout.ts).
export type SnapshotMaker = {
  // A snapshot of commit `sha`; with `tree`, filled from that git tree, its
  // new objects read from `tree.objects` (the working state the change
  // source staged). `prefix` starts the folder's name.
  make(repoRoot: string, sha: string, prefix: string, tree?: { sha: string; objects: string; alternates: string }): Promise<Snapshot>;
  // For a target's snapshot: the developer's settings files in place of the
  // commit's own .openqodex folder.
  placeSettings(repoRoot: string, tree: string): void;
  // How many of `paths` the snapshot holds as Git LFS pointer files.
  lfsPaths(tree: string, paths: string[]): Promise<number>;
  remove(repoRoot: string, snapshot: Snapshot): Promise<void>;
  // The same at once and synchronously, for a signal handler that exits
  // right after it.
  removeNow(repoRoot: string, snapshot: Snapshot): void;
};

// A branch or a pull request the host resolved for `ReviewInputs.target`:
// its head, its base and their merge base, the lines it has to say, and
// `release`, which removes anything the host made to resolve it (the CLI's
// temporary ref of a fetched pull request head) once the scan is done.
export type ResolvedTarget = { headSha: string; baseRef: string; baseSource: BaseSource; baseSha: string; mergeBase: string; notes: string[]; release(): Promise<void> };

export type ReviewInputs = {
  // The developer's repository: its git, its approvals.
  repoRoot: string;
  // The config in force, every override of the host already applied.
  config: Config;
  // Own work against a base, as the change source reads `scope`; with `all`
  // the whole repository; with `target` a branch or a pull request, which
  // `ReviewDeps.resolveTarget` resolves.
  scope: ChangeScope;
  all?: boolean;
  target?: string;
  // Files to review as they were before `init` wrote them (getChange overlay).
  overlay?: { path: string; content: string | null }[];
  only?: ScannerSource[];
  skip?: ScannerSource[];
  noGraph: boolean;
  // `auto` or one of REVIEWER_NAMES.
  reviewer: string;
  // The reviewer gets its agent's web tools.
  web: boolean;
  // The deadline for the scan, the graph and every reviewer turn, fixed
  // this long after the reviewer is chosen and before anything is scanned.
  timeoutMs: number;
  // The deadline itself, on the run's clock, when the host fixed it before
  // any work (reviewChange, at its entry); it then replaces timeoutMs.
  deadlineAt?: number;
  // The version the run's manifest names.
  runtimeVersion: string;
  // The lowest confidence a finding may have, in the brief and in the
  // check; left out, the global floor (the laptop passes none).
  confidenceFloor?: number;
  // A host's context items (context.ts), quoted in the brief as data and
  // hashed into the manifest; the laptop passes none.
  context?: ContextItem[];
};

// Every line and stage of a run, in the order they happen. The host acts on
// each at once (`onEvent` is called synchronously); one that throws stops
// the run there, the snapshot still removed.
export type ReviewEvent =
  // A stage line (the CLI prints it unless --quiet).
  | { type: "progress"; line: string }
  // A line shown whatever the verbosity (the CLI prints it always).
  | { type: "warning"; line: string }
  // The scan as the scanners left it, before its redaction (the CLI queues
  // its feedback offer for a scanner that failed).
  | { type: "scan"; scan: ScanResult }
  // The change and its redacted scan, as soon as both are known (the CLI
  // opens its run folder here). `secrets`: the raw matched secrets, in memory
  // only, for every redaction the host does itself.
  | { type: "prepared"; change: Change; scan: ScanResult; secrets: string[] }
  // The brief and what goes with it, before the reviewer starts.
  | { type: "brief"; manifest: RunManifest; scan: ScanResult; brief: string; impact: ImpactSummary }
  // The reviewer started.
  | { type: "started"; driver: string; version: string; pid: number | null };

export type ReviewDeps = {
  // The drivers `auto` tries, in order, after the agent running the host.
  drivers: readonly ReviewerDriver[];
  snapshots: SnapshotMaker;
  // Where each scanner's binary comes from, and whether a missing one may
  // install and how long it is waited for.
  resolveTool: ResolveTool;
  // Resolves `ReviewInputs.target`, when there is one.
  resolveTarget: (spec: string) => Promise<ResolvedTarget>;
  // The code graph's kept store; left out, the graph is built in memory.
  graphStore?: () => Promise<{ store: GraphStore | null; refused?: string }>;
  // The owners' instructions for the brief, redacted with the scan's
  // secrets, and the hash of the file they came from (null for none).
  instructions: (secrets: string[]) => { text: string; hash: string | null; from?: "host" };
  onEvent: (event: ReviewEvent) => void;
  // Receives the run's result before the run cleans up (the graph's lease,
  // the snapshot), so the host writes and prints everything from it first:
  // a cleanup that fails afterwards (a folder in the snapshot that cannot be
  // written) then throws out of runReviewCore without losing the review.
  // What it throws stops the run there, the cleanup still done.
  onResult?: (result: ReviewCoreResult) => void | Promise<void>;
  // Called once, as soon as the deadline is fixed, with a synchronous stop:
  // it ends a running boundary check and the reviewer's process group and
  // removes the snapshot. A host's signal handler calls it before it exits.
  // After the run it does nothing.
  onStop?: (stop: () => void) => void;
  // The clock, epoch milliseconds; the deadline is on it. The drivers in
  // agents/ time their own stop on the system clock, so a host that uses
  // them passes Date.now.
  now: () => number;
  // A model reviewer the host supplies in place of the drivers
  // (reviewChange's server profile): the brain runs the conversation with
  // its own five tools and asks `budget` before every model call.
  // `second`: a model that reviews the change again after it (second.ts).
  model?: { reviewer: ModelReviewer; budget?: Budget; second?: ModelReviewer };
  // The server review's scoped parts (scoped.ts): a target's change over the
  // admitted paths and the review's obligation (the delta of an incremental
  // review), base versions read through the scope check, and the graph's
  // inventory of the snapshot. Left out (the laptop), all is as before.
  scoped?: ScopedParts;
  // Where the scanners write (pipeline.ts ScanHost): left out, the laptop's
  // places; given, only under it.
  scratchRoot?: string;
};

export type ReviewCoreResult =
  // Nothing to review: the change is empty, or the repository has no files.
  | { ended: "nothing" }
  // No reviewer could start, or its boundary could not be shown for this
  // run: the scan's candidates stay unchecked.
  | { ended: "unavailable"; reasons: string[]; change: Change; scan: ScanResult; secrets: string[] }
  // The reviewer ran. `report` carries the completion record and says
  // incomplete when the record does; `display` is the code report.html shows.
  // `usage`: one record per round, from the driver's running totals.
  | {
      ended: "reviewed";
      report: Report;
      completion: CompletionRecord;
      display: Display;
      submission: unknown;
      trace: TraceEntry[];
      change: Change;
      secrets: string[];
      whole: boolean;
      target: RunTarget | null;
      usage: { calls: CallRecord[]; totals: UsageTotals };
      context?: NonNullable<RunManifest["context"]>;
    }
  // A model reviewer ran (`ReviewDeps.model`). No agent completion record is
  // made for it: `report` is the checked report without one, and `evidence`
  // is what the model completion record is built from (model-record.ts).
  // `usage`: one record per model attempt, the second reviewer's included.
  // `second`: the second reviewer's run, when one ran. `context`: the context
  // items as the manifest lists them, when any were given.
  | {
      ended: "model-reviewed";
      report: Report;
      evidence: ModelReviewEvidence;
      submission: unknown;
      change: Change;
      scan: ScanResult;
      secrets: string[];
      usage: { calls: CallRecord[]; totals: UsageTotals };
      second?: SecondRun;
      context?: NonNullable<RunManifest["context"]>;
    };

type Chosen = { driver: ReviewerDriver; version: string; bin: string } | { unavailable: string[] } | { model: { reviewer: ModelReviewer; budget?: Budget } };

// `choice` (auto or a driver's name), else the agent running this command
// when its driver is enabled, else the first enabled driver. A driver is
// enabled when detect() says its agent is installed, logged in and
// isolated; one that is not (Cursor, or Codex inside its own sandbox) says
// why and is passed by. An unknown name throws.
export function reviewerOrder(choice: string, drivers: readonly ReviewerDriver[]): ReviewerDriver[] {
  if (choice !== "auto" && !(REVIEWER_NAMES as readonly string[]).includes(choice)) {
    throw new OpenQodexError(`--reviewer must be auto or one of ${REVIEWER_NAMES.join(", ")}, not ${choice}`);
  }
  const host = hostAgent();
  return choice !== "auto"
    ? drivers.filter((d) => d.name === choice)
    : [...drivers.filter((d) => d.name === host), ...drivers.filter((d) => d.name !== host)];
}

async function chooseReviewer(choice: string, drivers: readonly ReviewerDriver[], repoRoot: string): Promise<Chosen> {
  const order = reviewerOrder(choice, drivers);
  const unavailable: string[] = [];
  for (const driver of order) {
    const d = await driver.detect(repoRoot);
    if (d.ok) return { driver, version: d.version, bin: d.bin };
    unavailable.push(`${driver.name}: ${d.missing}; ${d.fix}`);
  }
  return { unavailable: unavailable.length > 0 ? unavailable : [`${choice}: no driver of that name`] };
}

type Prepared = {
  p: PipelineResult;
  snapshot: Snapshot;
  tree: string | null;
  target?: RunTarget;
  whole?: WholeRepo;
  // The whole change findings anchor on, when the scan and the brief took
  // less of it (an incremental review); else the scan's change is the whole.
  full?: Change;
};

// A report that carries no finding: an incomplete review.
function incompleteReport(change: Change, scan: ScanResult, config: Config, now: number): Report {
  return {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date(now).toISOString(),
    verdict: "incomplete",
    block_on_severity: config.blockOnSeverity,
    summary: null,
    findings: [],
    below_threshold: 0,
    outside_change: [],
    low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: scan.scanners,
    impact: null,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
}

async function headOf(repoRoot: string): Promise<string> {
  const r = await safeGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const sha = r.stdout.toString("utf8").trim();
  if (r.code !== 0 || sha === "") throw new OpenQodexError("the repository has no commit yet; commit once, then review");
  return sha;
}

// The change and its snapshot. `keep` receives the snapshot as soon as it
// exists, so the caller removes it whatever fails later.
async function prepare(inputs: ReviewInputs, deps: ReviewDeps, scanHost: ScanHost, keep: (s: Snapshot) => void): Promise<Prepared | null> {
  const { repoRoot, config, only, skip } = inputs;
  const say = (line: string) => deps.onEvent({ type: "progress", line });
  const warn = (line: string) => deps.onEvent({ type: "warning", line });
  if (inputs.target !== undefined) {
    const t = await deps.resolveTarget(inputs.target);
    try {
      for (const note of t.notes) warn(note);
      say(`Reviewing ${inputs.target} at ${t.headSha.slice(0, 12)}: base ${t.baseRef} (from ${t.baseSource}), merge base ${t.mergeBase.slice(0, 12)}`);
      const target = { repoRoot, baseRef: t.baseRef, baseSha: t.mergeBase, headSha: t.headSha, exclude: config.exclude };
      const scoped = deps.scoped ? await deps.scoped.change(target) : null;
      const change = scoped?.obligation ?? (await getTreeChange(target));
      if (change.files.length === 0) {
        warn(nothingToReviewLine(change));
        return null;
      }
      const snapshot = await deps.snapshots.make(repoRoot, t.headSha, `${change.shortId}-`);
      keep(snapshot);
      deps.snapshots.placeSettings(repoRoot, snapshot.tree);
      const lfs = await deps.snapshots.lfsPaths(snapshot.tree, change.changedPaths);
      if (lfs > 0) warn(`${lfs} changed ${lfs === 1 ? "file is" : "files are"} stored in Git LFS and not fetched: the review sees the pointer files`);
      const runTarget: RunTarget = { spec: inputs.target, base_ref: t.baseRef, base_source: t.baseSource, base_sha: t.baseSha, merge_base: t.mergeBase, head_sha: t.headSha, repo_root: repoRoot, checkout: snapshot.tree };
      const readBase = deps.scoped ? { readBase: deps.scoped.readBase } : {};
      const scanned = await scanChange({ repoRoot, workDir: snapshot.tree, config, change, only, skip, host: scanHost, ...readBase });
      // A delta review scans only the delta, but the snapshot, the tools and
      // the outputs hold the whole change: its secrets are collected over the
      // whole change too (the secret scanner alone, quietly), so each one is
      // redacted wherever the reviewer reads.
      const secretScan = scoped !== null && scoped.full !== scoped.obligation && !(skip ?? []).includes("gitleaks") && (only === undefined || only.includes("gitleaks"));
      const wholeSecrets = secretScan
        ? (await scanChange({ repoRoot, workDir: snapshot.tree, config, change: scoped.full, only: ["gitleaks"], host: { resolveTool: scanHost.resolveTool, onProgress: () => {}, ...(scanHost.scratchRoot !== undefined ? { scratchRoot: scanHost.scratchRoot } : {}) }, ...readBase })).secrets
        : [];
      const p = wholeSecrets.length === 0 ? scanned : { ...scanned, secrets: [...new Set([...scanned.secrets, ...wholeSecrets])] };
      return { p, snapshot, tree: null, target: runTarget, ...(scoped ? { full: scoped.full } : {}) };
    } finally {
      await t.release();
    }
  }

  const head = await headOf(repoRoot);
  let snapshot: Snapshot | null = null;
  let treeSha: string | null = null;
  const change = await getChange({
    repoRoot,
    scope: inputs.all ? { uncommitted: true } : inputs.scope,
    exclude: config.exclude,
    defaultBase: config.defaultBase,
    overlay: inputs.overlay,
    onTree: async (tree) => {
      treeSha = tree.sha;
      snapshot = await deps.snapshots.make(repoRoot, head, "work-", tree);
      keep(snapshot);
    },
  });
  if (snapshot === null) throw new OpenQodexError("the snapshot of the change was not made");
  const snap: Snapshot = snapshot;
  if (inputs.all) {
    // The whole repository as the snapshot holds it, so nothing written in
    // the developer's folder from here on is part of the review.
    const whole = await getWholeRepo({ repoRoot: snap.tree, exclude: config.exclude });
    const p = await scanChange<WholeRepo>({ repoRoot, workDir: snap.tree, config, change: whole, wholeRepo: true, only, skip, host: scanHost });
    return p.scan === null ? null : { p, snapshot: snap, tree: treeSha, whole: p.change };
  }
  if (change.files.length === 0) {
    warn(nothingToReviewLine(change));
    return null;
  }
  say(`Reviewing the change against ${change.baseRef}: ${change.stats.files} ${change.stats.files === 1 ? "file" : "files"}, +${change.stats.additions} -${change.stats.deletions}`);
  const p = await scanChange({ repoRoot, workDir: snap.tree, config, change, only, skip, host: scanHost });
  return { p, snapshot: snap, tree: treeSha };
}

export async function runReviewCore(inputs: ReviewInputs, deps: ReviewDeps): Promise<ReviewCoreResult> {
  const { repoRoot, config } = inputs;
  const say = (line: string) => deps.onEvent({ type: "progress", line });
  const warn = (line: string) => deps.onEvent({ type: "warning", line });
  // Refused whole, never cut, before anything runs.
  const contextItems = inputs.context ? checkContext(inputs.context) : null;
  const chosen: Chosen = deps.model ? { model: deps.model } : await chooseReviewer(inputs.reviewer, deps.drivers, repoRoot);
  const deadline = inputs.deadlineAt ?? deps.now() + inputs.timeoutMs;

  let snapshot: Snapshot | null = null;
  let session: (Speaker & { close(): Promise<void>; kill?(): void }) | null = null;
  // The graph build this review read, held until the review ends.
  let graphLease: Lease | null = null;
  // A driver's boundary check that is running (Codex's sandbox probe): its
  // process group and files, ended synchronously.
  let checking: (() => void) | null = null;
  let over = false;
  // Ctrl-C or a kill in the host: the reviewer's process group and the
  // snapshot go too, synchronously, since the host exits right after. The
  // reviewer runs in a group of its own, so nothing else would stop it.
  deps.onStop?.(() => {
    if (over) return;
    checking?.();
    session?.kill?.();
    if (snapshot !== null) deps.snapshots.removeNow(repoRoot, snapshot as Snapshot);
  });
  const scanHost: ScanHost = { resolveTool: deps.resolveTool, onProgress: say, onScan: (scan) => deps.onEvent({ type: "scan", scan }), ...(deps.scratchRoot !== undefined ? { scratchRoot: deps.scratchRoot } : {}) };
  // The result goes to the host before the cleanup below.
  const finish = async (result: ReviewCoreResult): Promise<ReviewCoreResult> => {
    await deps.onResult?.(result);
    return result;
  };
  const graphHost: GraphHost = { store: deps.graphStore, onProgress: say, warn, ...(deps.scoped ? { inventory: deps.scoped.inventory, readBase: deps.scoped.readBase } : {}) };
  try {
    const prep = await prepare(inputs, deps, scanHost, (s) => (snapshot = s));
    if (prep === null) {
      if (inputs.all) warn("Nothing to review: the repository has no files");
      return await finish({ ended: "nothing" });
    }
    const { p } = prep;
    const scan = p.scan as ScanResult;
    const change = p.change;
    // What findings anchor on and are checked against.
    const full = prep.full ?? change;
    deps.onEvent({ type: "prepared", change, scan, secrets: p.secrets });
    // No reviewer can start: the scanner candidates stay unchecked, never a review.
    if ("unavailable" in chosen) return await finish({ ended: "unavailable", reasons: chosen.unavailable, change, scan, secrets: p.secrets });

    // The one redaction every output of this run goes through (redact.ts:
    // each matched secret and each line of a multi-line one).
    const redact = (text: string): string => redactSecrets(text, p.secrets);
    const redaction = redactSnapshot(prep.snapshot.tree, p.secrets);
    if (redaction.redacted > 0) say(`Redacted secrets in ${redaction.redacted} ${redaction.redacted === 1 ? "file" : "files"} of the snapshot`);
    if (redaction.removed.length > 0) warn(redact(`Left out of the review, too large to check for secrets: ${redaction.removed.join(", ")}`));
    const instructions = deps.instructions(p.secrets);
    const context = contextItems ? useContext(contextItems, change, p.secrets, deps.scoped?.admit) : null;
    let lenses: SelectedLens[];
    let impact: ImpactSummary;
    let brief: { text: string; diffFiles: Set<string> };
    // The graph a model reviewer's find_callers asks, and why there is none.
    let graph: Graph | null = null;
    if (prep.whole) {
      const hot = await buildHotSpots(p, graphHost, inputs.noGraph);
      impact = hot.impact;
      lenses = wholeRepoLenses(prep.whole, ruleCoverage(p));
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, instructions: instructions.text, ...(instructions.from ? { instructionsFrom: instructions.from } : {}), whole: { hot: hot.hot, graphNote: hot.note, inventory: buildInventory(prep.whole, scan) }, confidenceFloor: inputs.confidenceFloor, context: context?.shown });
    } else {
      const run = await buildGraphRun(p, graphHost, inputs.noGraph);
      graphLease = run.lease;
      impact = run.impact;
      graph = run.graph;
      // The graph files the brief names, written into the snapshot before it
      // is hashed, so the reviewer reads them inside the folder it may read.
      if (run.graph) {
        try {
          const packet = await writePacket({ root: prep.snapshot.tree, repoRoot, graph: run.graph, impact, baseSha: change.baseSha, secrets: p.secrets, ...(deps.scoped ? { readBase: deps.scoped.readBase } : {}) });
          impact = { ...impact, packet: packet.dir };
        } catch (error) {
          if (error instanceof PacketCollision || error instanceof PacketLeak) throw new OpenQodexError(error.message);
          throw error;
        }
      }
      lenses = selectLenses(change, undefined, ruleCoverage(p));
      brief = buildReviewerBrief({ change, scan, lenses, config, secrets: p.secrets, impactBlock: renderImpactBlock(impact), instructions: instructions.text, ...(instructions.from ? { instructionsFrom: instructions.from } : {}), target: prep.target, confidenceFloor: inputs.confidenceFloor, context: context?.shown });
    }
    const manifest: RunManifest = {
      version: MANIFEST_VERSION,
      change_id: change.id,
      config_hash: configHash(config),
      created_at: new Date(deps.now()).toISOString(),
      lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
      instructions_hash: instructions.hash,
      runtime_version: inputs.runtimeVersion,
      ...(prep.target ? { target: prep.target } : {}),
      ...(context ? { context: context.manifest } : {}),
    };
    deps.onEvent({ type: "brief", manifest, scan, brief: brief.text, impact });

    // A model reviewer runs in the brain's own loop, with the brain's tools.
    const model = "model" in chosen ? chosen.model : null;
    const agent = "driver" in chosen ? chosen : null;
    // A reviewer whose trace is not complete (Codex) has no read counted:
    // coverage is the brief and the correction rounds only. The brain's own
    // log of a model reviewer's tools is complete.
    const traced = agent ? agent.driver.traced : true;
    // The driver's per-run proof of its boundary (Codex's sandbox probe),
    // on the redacted snapshot, before its hash is taken.
    const unsafe = agent ? ((await agent.driver.check?.({ snapshotDir: prep.snapshot.tree, bin: agent.bin, register: (cleanup) => (checking = cleanup) })) ?? null) : null;
    if (agent && unsafe !== null) return await finish({ ended: "unavailable", reasons: [`${agent.driver.name}: ${unsafe}`], change, scan, secrets: p.secrets });
    const before = hashSnapshot(prep.snapshot.tree);
    const lineCount = lineCounter(prep.snapshot.tree);
    // A secret in a path would reach the reviewer through any listing: the
    // reviewer is not started and the review is incomplete.
    const refused = redaction.named > 0 ? "a file name in the change holds a secret the scanners found, so the reviewer was not started; rename the file" : null;
    // What a model reviewer's tools read: the snapshot, the change, the
    // graph, and the folder scopes when the review has any.
    const box: ToolBox = {
      snapshotDir: prep.snapshot.tree,
      change,
      secrets: p.secrets,
      graph,
      graphNote: graph === null ? `the graph is ${impact.status}${impact.reasons.length > 0 ? `: ${impact.reasons.join("; ")}` : ""}` : null,
      ...(deps.scoped?.folderScopes ? { admit: deps.scoped.admit } : {}),
    };
    let modelTalk: ModelSession | null = null;
    // An agent's usage is recorded round by round as its turns come back;
    // the turns reach the conversation unchanged.
    let metered: { session: ReviewerSession; calls(): CallRecord[] } | null = null;
    let pid: number | null = null;
    if (refused === null && model) {
      modelTalk = modelSession({
        reviewer: model.reviewer,
        role: "primary",
        budget: model.budget,
        box,
        now: deps.now,
        deadline,
      });
      session = modelTalk;
      deps.onEvent({ type: "started", driver: "model", version: model.reviewer.model, pid: null });
      say(`Reviewer: model ${model.reviewer.model} started; this takes one to three minutes`);
    } else if (refused === null && agent) {
      metered = meterSession(agentReviewer(agent.driver, { snapshotDir: prep.snapshot.tree, deadline, bin: agent.bin, web: inputs.web }), { driver: agent.driver.name, now: deps.now });
      session = metered.session;
      pid = metered.session.pid;
      deps.onEvent({ type: "started", driver: agent.driver.name, version: agent.version, pid });
      say(`Reviewer: ${agent.driver.name} ${agent.version} started${pid !== null ? ` (process ${pid})` : ""}; this takes one to three minutes`);
    }
    const startedIso = new Date(deps.now()).toISOString();
    const now = deps.now();
    // The checks every answer passes, and the changed ranges a correction
    // round carries: the same for the primary and the second reviewer.
    const check: Parameters<typeof converse>[0]["check"] = (submission, trace, delivered) => {
      const r = checkSubmission({ change: full, scan, manifest, config, submission, lineCount, wholeRepo: prep.whole ? { lines: prep.whole.lines } : undefined, confidenceFloor: inputs.confidenceFloor });
      // A model reviewer's reads count once a request carrying them was sent.
      const unread = prep.whole
        ? []
        : model
          ? modelCoverage({ change, briefSent: true, briefFiles: brief.diffFiles, toolLog: (trace as ToolLogEntry[]).map(modelToolEntry), delivered, lineCount }).unread
          : readCoverage({ change, briefFiles: brief.diffFiles, trace: traced ? trace : [], lineCount, delivered }).unread;
      return { report: r.ok ? r.report : null, errors: r.ok ? [] : r.errors, unread, required: r.required, disposed: r.disposed };
    };
    const deliver: Parameters<typeof converse>[0]["deliver"] = (unread, earlier) => deliverRanges({ snapshotDir: prep.snapshot.tree, unread, earlier, secrets: p.secrets, change });
    // The second reviewer, once the primary is done: on the same brief,
    // snapshot, tools, checks, deadline and budget. Not after a budget
    // refusal, which has ended the review, and not when the primary was not
    // started.
    const secondReview = async (m: NonNullable<ReviewDeps["model"]>, primary: ModelSession | null, first: ModelReviewEvidence): Promise<SecondRun | null> => {
      if (!m.second || primary === null || first.attempts.some((a) => a.outcome === "refused")) return null;
      const reviewer = m.second;
      return runSecondReviewer({
        reviewer,
        budget: m.budget,
        box,
        earlier: first.attempts,
        now: deps.now,
        deadline,
        started: (s) => {
          session = s;
          say(`Second reviewer: model ${reviewer.model} started`);
        },
        converse: (s) => converse({ session: s, snapshotDir: prep.snapshot.tree, brief: brief.text, deadline, traced: true, say, now: deps.now, check, deliver }),
        evidence: (s, t, startedAt) => modelEvidence({ role: "second", model: reviewer.model, session: s, talk: t, change, snapshot: { tree: prep.tree, before: first.snapshot.after ?? first.snapshot.before, after: hashSnapshot(prep.snapshot.tree) }, briefFiles: brief.diffFiles, lineCount, secrets: p.secrets, startedAt }),
      });
    };
    const talk: Conversation = session === null ? { rounds: 0, trace: [], usage: { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null }, report: null, checked: null, errors: [], required: 0, disposed: 0, failure: refused, submission: null, delivered: [], carried: [], startedAt: now, endedAt: now } : await converse({
      session,
      snapshotDir: prep.snapshot.tree,
      brief: brief.text,
      deadline,
      traced,
      say,
      now: deps.now,
      check,
      deliver,
    }).finally(async () => {
      await session?.close();
    });
    if (talk.failure !== null) warn(`openqodex: ${talk.failure}`);
    const after = hashSnapshot(prep.snapshot.tree);

    if ("model" in chosen) {
      const evidence = modelEvidence({ role: "primary", model: chosen.model.reviewer.model, session: modelTalk, talk, change, snapshot: { tree: prep.tree, before, after }, briefFiles: brief.diffFiles, lineCount, secrets: p.secrets, startedAt: startedIso });
      const second = await secondReview(chosen.model, modelTalk, evidence);
      // The checked report, or an empty one; the model record goes in it
      // where the record is built (modelReport).
      const report: Report = { ...(talk.report ?? talk.checked?.report ?? incompleteReport(full, scan, config, deps.now())), impact };
      const calls = [...evidence.attempts, ...(second?.evidence.attempts ?? [])];
      return await finish({ ended: "model-reviewed", report, evidence, submission: talk.report ? talk.submission : (talk.checked?.submission ?? talk.submission), change: full, scan, secrets: p.secrets, usage: { calls, totals: usageTotals(calls) }, ...(second ? { second } : {}), ...(context ? { context: context.manifest } : {}) });
    }

    const reviewer: ReviewerRecord | null = session === null ? null : {
      driver: chosen.driver.name,
      version: chosen.version,
      pid,
      started_at: startedIso,
      ended_at: new Date(talk.endedAt).toISOString(),
      duration_ms: talk.endedAt - talk.startedAt,
      rounds: talk.rounds,
      usage: talk.usage,
    };
    const coverage = readCoverage({ change, briefFiles: brief.diffFiles, trace: traced ? talk.trace : [], lineCount, delivered: talk.delivered });
    // Redacted like the report: a path or a tool input may hold a secret.
    const completion = redactStored(completionRecord({
      change,
      reviewer,
      snapshot: { tree: prep.tree, before, after },
      candidates: { total: talk.required, disposed: talk.disposed },
      coverage,
      trace: talk.trace,
      submissionErrors: talk.errors,
      wholeRepo: prep.whole !== undefined,
      failure: talk.failure,
      tools: inputs.web ? [...REVIEWER_TOOLS, ...REVIEWER_WEB_TOOLS] : REVIEWER_TOOLS,
      traced,
    }), p.secrets);
    // An incomplete review keeps the findings of an answer that passed every
    // check: the report prints them as the findings so far.
    const report: Report = {
      ...(talk.report ?? talk.checked?.report ?? incompleteReport(full, scan, config, deps.now())),
      impact: prep.whole ? null : impact,
      completion,
    };
    if (completion.status !== "complete") report.verdict = "incomplete";

    // report.html's code, while the diff and the matched secrets are still
    // in memory: the change as a diff, or for the whole repository a few
    // lines of the redacted snapshot around each cited line.
    const display = prep.whole
      ? buildExcerptDisplay({
          changeId: change.id,
          cited: [
            ...report.findings,
            ...report.dropped.map((d) => (d.cited ? { ...d.cited, line_end: d.cited.line_number } : { file_path: d.candidate.filePath, line_number: d.candidate.lineStart, line_end: d.candidate.lineEnd })),
          ],
          read: snapshotText(prep.snapshot.tree),
          secrets: p.secrets,
        })
      : buildDisplay({ change: full, secrets: p.secrets });
    const calls = metered?.calls() ?? [];
    return await finish({ ended: "reviewed", report, completion, display, submission: talk.submission, trace: talk.trace, change: full, secrets: p.secrets, whole: prep.whole !== undefined, target: prep.target ?? null, usage: { calls, totals: usageTotals(calls) }, ...(context ? { context: context.manifest } : {}) });
  } finally {
    over = true;
    graphLease?.release();
    if (snapshot !== null) await deps.snapshots.remove(repoRoot, snapshot as Snapshot);
  }
}

// ---------- reviewChange: one change in a host's clone, server profile ----------

// How long a review may run when the host gives no budget.

// Inputs and options this version does not take, or cannot use as given,
// refused with what to do instead: nothing given is ever ignored.
function refuseUnsupported(input: ReviewChangeInput, reviewer: Reviewer, options: ReviewChangeOptions): void {
  if (input.previousReviewedSha !== undefined && typeof input.previousReviewedSha !== "string") throw new OpenQodexError("reviewChange: previousReviewedSha must be a commit id");
  if (input.fullReviewRequested !== undefined && typeof input.fullReviewRequested !== "boolean") throw new OpenQodexError("reviewChange: fullReviewRequested must be true or false");
  // The scopes are checked the way the review will use them.
  if (input.scopes !== undefined) admitted(input.scopes, []);
  if ((options.profile as string) !== "server") throw new OpenQodexError('reviewChange runs the "server" profile only; the laptop review is the openqodex review command');
  if (options.tools?.web !== false || options.tools?.shell !== false) throw new OpenQodexError("the server profile gives the reviewer no web and no shell tool: pass tools: { web: false, shell: false }");
  if ((options.scanners as string) !== "preinstalled") throw new OpenQodexError('the server profile installs no scanner: pass scanners: "preinstalled"');
  for (const key of ["workDir", "installRoot"] as const) {
    if (typeof options[key] !== "string" || !isAbsolute(options[key])) throw new OpenQodexError(`reviewChange: ${key} must be an absolute path`);
  }
  const floor = options.confidenceFloor;
  if (floor !== undefined && !(typeof floor === "number" && Number.isFinite(floor) && floor >= 0 && floor <= 1)) throw new OpenQodexError("reviewChange: confidenceFloor must be a number from 0 to 1");
  // No model call is made that no budget authorized.
  const budget = options.budget as Partial<Budget> | undefined;
  if (budget === undefined || budget === null || typeof budget.authorize !== "function" || !(typeof budget.deadlineMs === "number" && budget.deadlineMs > 0)) {
    throw new OpenQodexError("reviewChange: the server profile needs a budget: { authorize, deadlineMs } with an authorize function and a deadlineMs above 0");
  }
  if (reviewer?.kind !== "model") throw new OpenQodexError("the server profile takes a model reviewer (kind: \"model\"); agent reviewers run on the laptop");
  if (typeof reviewer.model !== "string" || reviewer.model === "" || !Number.isInteger(reviewer.maxOutputTokens) || reviewer.maxOutputTokens < 1 || typeof reviewer.complete !== "function") {
    throw new OpenQodexError("reviewChange: a model reviewer needs a model name, a whole maxOutputTokens of 1 or more and a complete function");
  }
  refuseSecond(options.secondReviewer);
  if (input.context !== undefined) checkContext(input.context);
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== "string") throw new OpenQodexError("reviewChange: instructions must be text");
    const bytes = Buffer.byteLength(input.instructions, "utf8");
    if (bytes > INSTRUCTIONS_MAX_BYTES) throw new OpenQodexError(`reviewChange: the instructions are ${bytes} bytes, over the ${INSTRUCTIONS_MAX_BYTES / 1024} KB limit; they are refused, never cut: shorten them so every instruction reaches the review`);
  }
}

// The most the owners' instructions may hold, as on the laptop.
const INSTRUCTIONS_MAX_BYTES = 32 * 1024;

// The second reviewer obeys the primary's rules: a model, in this profile.
function refuseSecond(second: Reviewer | undefined): void {
  if (second === undefined) return;
  if (second?.kind !== "model") throw new OpenQodexError("the server profile takes a model second reviewer (kind: \"model\"); agent reviewers run on the laptop");
  if (typeof second.model !== "string" || second.model === "" || !Number.isInteger(second.maxOutputTokens) || second.maxOutputTokens < 1 || typeof second.complete !== "function") {
    throw new OpenQodexError("reviewChange: the second reviewer needs a model name, a whole maxOutputTokens of 1 or more and a complete function");
  }
}

// A review that stopped before a reviewer could be given the change: no
// finding, no usage, and outputs that say why. `scope`: the decision, when
// the proofs got that far.
function stoppedResult(status: "complete" | "incomplete", reason: string, scope: ReviewScope | null = null, notes: string[] = []): ReviewResult {
  const lead = status === "complete" ? "Review complete" : "Review incomplete";
  return {
    status,
    reason,
    scope,
    findings: [],
    dispositions: [],
    summary: null,
    coverage: null,
    scannerVersions: {},
    trace: [],
    usage: { calls: [], totals: usageTotals([]) },
    evidence: null,
    completion: null,
    notes,
    disagreements: [],
    context: [],
    render: {
      markdown: () => `# ${lead}\n\n${display(reason)}\n`,
      sarif: () => `${JSON.stringify({ $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0", runs: [{ tool: { driver: { name: "openqodex", rules: [] } }, results: [], properties: { status, reason } }] }, null, 2)}\n`,
      json: () => `${JSON.stringify({ status, reason }, null, 2)}\n`,
    },
  };
}

// The findings that passed every check, in the result's shape; `foundBy[i]`
// names the reviewers that raised the i-th.
function resultFindings(report: Report, foundBy: string[][]): ResultFinding[] {
  return report.findings.map((f, i) => ({
    file: f.file_path,
    lineStart: f.line_number,
    lineEnd: f.line_end ?? f.line_number,
    title: f.title,
    problem: f.problem ?? f.description,
    consequence: f.consequence ?? "",
    fix: f.fix ?? "",
    suggestedChange: f.suggested_change,
    severity: f.severity,
    category: f.category,
    confidence: f.confidence ?? 0,
    foundBy: foundBy[i] ?? [],
    source: f.source,
    candidate: f.candidate,
  }));
}

// What the reviewer did with each scanner candidate, from an answer that
// passed every check: raised (the finding's file and line) or dropped (the
// reason and the line that shows why).
function dispositionsOf(report: Report, submission: unknown, scan: ScanResult, by: Disposition["by"] = "primary"): Disposition[] {
  const byId = new Map(scan.candidates.map((c) => [c.id, c]));
  const out: Disposition[] = [];
  for (const f of (submission as SubmissionV2).findings ?? []) {
    const c = f.candidate ? byId.get(f.candidate) : undefined;
    if (c) out.push({ candidate: c.id, token: c.token, file: c.filePath, line: c.lineStart, outcome: "raised", reason: null, cited: { file: f.file_path, line: f.line_number }, by });
  }
  for (const d of report.dropped) {
    out.push({ candidate: d.candidate.id, token: d.candidate.token, file: d.candidate.filePath, line: d.candidate.lineStart, outcome: "dropped", reason: d.reason, cited: d.cited ? { file: d.cited.file_path, line: d.cited.line_number } : null, by });
  }
  return out;
}

// Reviews the change from `input.mergeBaseSha` to `input.headSha` in the
// host's clone with a model reviewer, in the server profile: the merge base
// proved first, and the previous review's commit, which decides between a
// delta and a full review (incremental.ts); the change, the snapshot, the
// scanners, the graph, the tools and the context kept inside
// `input.scopes` (scoped.ts); the snapshot, the head's admitted files
// written under `options.workDir`, nothing written in the clone; scanners
// only as preinstalled under
// `options.installRoot`; no instructions file read from the clone (the host
// gives the config); the brain's five tools and no others; the budget asked
// before every model call. Nothing is printed, no signal handler is added
// and no environment variable is written; progress lines go to
// `options.onProgress`. A proof that fails, or a clone that lacks what the
// review needs, ends as incomplete with the reason, never as a throw; a
// call this version cannot serve throws at once. `runtimeVersion`: the
// version the manifest names (the library entry passes the package's).
export async function reviewChange(input: ReviewChangeInput, reviewer: Reviewer, options: ReviewChangeOptions, runtimeVersion = "unknown"): Promise<ReviewResult> {
  refuseUnsupported(input, reviewer, options);
  // One deadline for the whole review, fixed before any work.
  const deadlineAt = Date.now() + options.budget.deadlineMs;
  const model = reviewer as ModelReviewer;
  const say = options.onProgress ?? (() => {});
  const decision = await decideIncremental({
    clonePath: input.clonePath,
    mergeBaseSha: input.mergeBaseSha,
    headSha: input.headSha,
    ...(input.previousReviewedSha !== undefined ? { previousReviewedSha: input.previousReviewedSha } : {}),
    ...(input.fullReviewRequested !== undefined ? { fullReviewRequested: input.fullReviewRequested } : {}),
  });
  if (!decision.ok) return stoppedResult("incomplete", decision.reason);
  const config = structuredClone(input.config ?? DEFAULT_CONFIG);
  // Everything the review writes besides its snapshot: the change source's
  // temporary folders and the scanners' caches, temporary folders, HOME and
  // TMPDIR (scanners/src/scratch.ts). Removed when the review ends.
  const scratch = join(options.workDir, "scratch");
  mkdirSync(join(scratch, "tmp"), { recursive: true, mode: 0o700 });
  try {
    return await reviewInScope(input, model, options, runtimeVersion, decision, config, scratch, say, deadlineAt);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The review once the merge base is proved, its decision made and its
// scratch folder there.
async function reviewInScope(
  input: ReviewChangeInput,
  model: ModelReviewer,
  options: ReviewChangeOptions,
  runtimeVersion: string,
  decision: Extract<IncrementalDecision, { ok: true }>,
  config: Config,
  scratch: string,
  say: (line: string) => void,
  deadlineAt: number,
): Promise<ReviewResult> {
  const scope = serverScope({
    clonePath: input.clonePath,
    workDir: options.workDir,
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    exclude: config.exclude,
    decision,
    tempRoot: join(scratch, "tmp"),
  });
  let r: ReviewCoreResult;
  try {
    r = await runReviewCore(
      {
        repoRoot: input.clonePath,
        config,
        scope: {},
        target: input.headSha,
        noGraph: false,
        reviewer: "auto",
        web: false,
        timeoutMs: options.budget.deadlineMs,
        deadlineAt,
        runtimeVersion,
        ...(options.confidenceFloor !== undefined ? { confidenceFloor: options.confidenceFloor } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      },
      {
        drivers: [],
        snapshots: scope.snapshots,
        scoped: scope.scoped,
        scratchRoot: scratch,
        resolveTool: createToolResolver({ allowInstall: false, installBudgetMs: null, installRoot: options.installRoot }),
        resolveTarget: async () => ({ headSha: input.headSha, baseRef: "the merge base", baseSource: "the host", baseSha: input.mergeBaseSha, mergeBase: input.mergeBaseSha, notes: [], release: async () => {} }),
        // The owners' instructions the host gave, quoted as the laptop quotes
        // its file; none read from the clone.
        instructions: (secrets) => (input.instructions ? { text: redactSecrets(input.instructions, secrets), hash: createHash("sha256").update(input.instructions).digest("hex"), from: "host" as const } : { text: "", hash: null }),
        onEvent: (e) => {
          if (e.type === "progress" || e.type === "warning") say(e.line);
        },
        now: Date.now,
        model: { reviewer: model, budget: options.budget, ...(options.secondReviewer ? { second: options.secondReviewer as ModelReviewer } : {}) },
      },
    );
  } catch (error) {
    // What the clone could not give (a partial clone's missing tree or
    // file), or a step that could not run, ends the review with its reason.
    if (error instanceof MissingObjects) return stoppedResult("incomplete", error.message, decision.scope, scope.notes());
    if (error instanceof OpenQodexError) return stoppedResult("incomplete", /partial clone/.test(error.message) ? `missing objects: ${error.message}` : error.message, decision.scope, scope.notes());
    throw error;
  }
  if (r.ended === "nothing") {
    const since = decision.scope.kind === "delta" ? "since the previously reviewed commit" : "since the merge base";
    return stoppedResult("complete", `nothing to review: the head adds no change ${since}${input.scopes !== undefined ? " inside the review's scopes" : ""}`, decision.scope, scope.notes());
  }
  if (r.ended !== "model-reviewed") return stoppedResult("incomplete", r.ended === "unavailable" ? r.reasons.join("; ") : "an agent reviewer ran where a model reviewer was given", decision.scope, scope.notes());
  // Only an answer that passed every check has dispositions; the empty
  // report of one that did not has no summary.
  const answered = r.report.summary !== null;
  const dispositions = answered ? dispositionsOf(r.report, r.submission, r.scan) : [];
  const second = r.second ?? null;
  let completion = modelRecord(r.evidence, { second: second?.evidence ?? null, secrets: r.secrets });
  let checked = r.report;
  let foundBy = r.report.findings.map(() => [model.model]);
  let disagreements: ReviewResult["disagreements"] = [];
  let secondDropped: Report["dropped"] | null = null;
  if (second) {
    // The second reviewer's work joins only when its own review completed.
    // One that failed is advisory: its record and a note stay, and nothing
    // it answered changes the primary's findings, dispositions or verdict.
    const joined = second.report !== null && completion.second?.status === "complete" ? second.report : null;
    if (joined) {
      const theirs = dispositionsOf(joined, second.submission, r.scan, "second");
      const merged = mergeFindings({ name: model.model, findings: r.report.findings }, { name: second.name, findings: joined.findings });
      checked = { ...r.report, findings: merged.findings, ...(answered ? { verdict: verdictFor(config.blockOnSeverity, merged.findings.map((f) => f.severity)) } : {}) };
      foundBy = merged.foundBy;
      if (answered) disagreements = disagreementsOf({ name: model.model, dispositions }, { name: second.name, dispositions: theirs });
      dispositions.push(...theirs);
      secondDropped = joined.dropped;
    }
    completion = withSecondReviewer(completion, disagreements, r.secrets);
  }
  const notes = [...(completion.notes ?? []), ...scope.notes()];
  // Every renderer gets who found each finding, the second reviewer's
  // dropped candidates and the notes, as the result holds them.
  const report = modelReport(
    redactStored(
      {
        ...checked,
        findings: checked.findings.map((f, i) => ({ ...f, found_by: foundBy[i] ?? [] })),
        ...(secondDropped ? { second_dropped: secondDropped } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      },
      r.secrets,
    ),
    completion,
  );
  const complete = completion.status === "complete";
  return {
    status: complete ? (report.verdict === "blocked" ? "complete_blocking" : "complete") : "incomplete",
    ...(complete ? {} : { reason: completion.missing.join("; ") }),
    scope: decision.scope,
    findings: resultFindings(report, foundBy),
    dispositions: redactStored(dispositions, r.secrets),
    summary: report.summary,
    coverage: r.evidence.coverage,
    scannerVersions: Object.fromEntries(r.scan.scanners.map((s) => [s.scanner, s.version])),
    trace: [...r.evidence.toolLog, ...(second?.evidence.toolLog ?? [])],
    usage: r.usage,
    evidence: r.evidence,
    completion,
    notes: report.notes ?? [],
    disagreements: completion.disagreements ?? [],
    context: r.context ?? [],
    render: reviewRender(report),
  };
}
