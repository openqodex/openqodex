// `openqodex review`:
//   neither            the whole review in one run, with a reviewer process
//                      the tool starts (review-run.ts)
//   --all              the whole repository instead of the change
//   <target>           a branch or a pull request instead of the current work
//   --agent            hidden, the two-step protocol of older skills: scan,
//                      then write the brief for the host agent and print it
//   --finalize [path]  hidden, its second step: check the agent's findings
//                      without a model and write the report (a legacy review)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DISPLAY_MAX_BYTES,
  MANIFEST_VERSION,
  OpenQodexError,
  INVENTORY_FILE,
  buildBrief,
  buildDisplay,
  buildInventory,
  buildWholeRepoBrief,
  checkDisplay,
  configHash,
  displayJson,
  finalizeReview,
  gateReceipt,
  findRepoRoot,
  getChange,
  getTreeChange,
  getWholeRepo,
  safeGit,
  openReportDir,
  readLatest,
  readRepoFile,
  redactByFingerprint,
  repoStat,
  SEVERITIES,
  STATE_DIR,
  selectLenses,
  writeLatest,
  writeReportFiles,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, Display, ImpactSummary, Latest, RunManifest, RunTarget, ScanResult, Severity, WholeRepo } from "@openqodex/core";
import { renderImpactBlock } from "@openqodex/graph";
import { checkoutsDir, redactStored, ruleCoverage, wholeRepoLenses } from "@openqodex/review";
import type { PipelineResult } from "@openqodex/review";
import { announceRepoFiles } from "../agents/repo-folder.js";
import { addTargetCheckout, checkoutOwner, inCheckouts, lfsPaths, placeSettings, removeTargetCheckout, sweepCheckouts } from "../checkout.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { directRunner, launcherPath, launcherRunner, launcherStarted, openqodexHomeDir, runtimeBin } from "../launcher.js";
import { HANDED_OFF } from "../update/trigger.js";
import { readInstructions } from "../instructions.js";
import { readHomeRun, writeHomeLastReview, writeHomeReceipt, writeHomeRun } from "../receipts.js";
import type { RunRecord } from "../receipts.js";
import { ALL, NO_GRAPH, parseFlags, scannerList } from "../flags.js";
import { DEFAULT_TIMEOUT_SECONDS, runReview } from "../review-run.js";
import type { GlobalFlags } from "../flags.js";
import {
  buildHotSpots,
  buildImpact,
  emitReview,
  exitFor,
  instructionsHash,
  loadRepo,
  nothingToReview,
  ownersInstructions,
  reviewOutputs,
  progress,
  runPipeline,
  scanChange,
  warn,
  writeReportHtml,
} from "../pipeline.js";
import { dropTempRef, resolveTarget, sweepTempRefs } from "../target.js";
import type { Resolved } from "../target.js";
import { SCOPE_BOOLS, SCOPE_VALUES, scopeFrom } from "./scan.js";

const FINDINGS_FILE = "agent-findings.json";
const IMPACT_FILE = "impact.json";
const RUN_FILE = "run.json";
// The code report.html shows, captured with the brief while the matched
// secrets are in memory, since finalize has only their fingerprints.
const DISPLAY_FILE = "display.json";
// Files that quote the code under review.
const PRIVATE = 0o600;
const RUN_AGAIN = "run openqodex review --agent first";

// run.json beside the manifest: the scope the brief was made with, so
// finalize recomputes the same change ("all" for the whole repository,
// "target" for a branch or a pull request, whose commits are in the manifest).
type RunFile = { version: 1; scope: ChangeScope | "all" | "target" };

// Flags of the review openqodex runs itself only. The GitHub Action passes
// the last four: a gate the change's own config cannot weaken, the base
// branch's instructions, a folder of its own for this run's report, and the
// reviewer's web tools off whatever the runner's user config says.
const OWN_REVIEW_FLAGS = ["--reviewer", "--timeout", "--block-on-severity", "--instructions", "--report-dir", "--reviewer-web"];

export async function run(args: string[]): Promise<number> {
  const { global, bools, values, positionals } = parseFlags(args, {
    bools: [...SCOPE_BOOLS, "--agent", "--finalize", ALL, NO_GRAPH, HANDED_OFF],
    values: [...SCOPE_VALUES, "--only", "--skip", "--run", ...OWN_REVIEW_FLAGS],
    positionals: 1,
  });
  const agent = bools.has("--agent");
  const finalize = bools.has("--finalize");
  const noGraph = bools.has(NO_GRAPH);
  if (agent && finalize) throw new OpenQodexError("--agent and --finalize cannot be used together");
  if (values.has("--run") && !finalize) throw new OpenQodexError("--run names the run to finalize and needs --finalize");
  const own = OWN_REVIEW_FLAGS.filter((f) => values.has(f));
  if (own.length > 0 && (agent || finalize)) {
    throw new OpenQodexError(`${own.join(" and ")} ${own.length === 1 ? "is" : "are"} for the review openqodex runs itself, not --agent or --finalize`);
  }
  const blockOn = values.get("--block-on-severity");
  if (blockOn !== undefined && !(SEVERITIES as readonly string[]).includes(blockOn)) {
    throw new OpenQodexError(`--block-on-severity must be one of ${SEVERITIES.join(", ")}, not ${blockOn}`);
  }
  const web = values.get("--reviewer-web");
  if (web !== undefined && web !== "on" && web !== "off") throw new OpenQodexError(`--reviewer-web must be on or off, not ${web}`);
  const target = finalize ? undefined : positionals[0];
  if (target !== undefined && bools.has(ALL)) {
    throw new OpenQodexError("--all reviews the whole repository and takes no branch or pull request");
  }
  if (target !== undefined && bools.has("--uncommitted")) {
    throw new OpenQodexError("--uncommitted is about your own work and cannot be used with a branch or pull request");
  }
  if (bools.has(ALL) && (values.has("--base") || bools.has("--uncommitted"))) {
    throw new OpenQodexError("--all reviews the whole repository and cannot be used with --base or --uncommitted");
  }

  // Finalize reads the scope from the run; --all only picks the newest
  // whole-repo run when no findings path is given.
  if (finalize) return runFinalize(global, positionals[0], bools.has(ALL), args, bools.has(HANDED_OFF), values.get("--run"));
  // Checkouts that a review of a branch or a pull request left behind.
  const root = await findRepoRoot(global.cwd).catch(() => null);
  if (root !== null) await Promise.all([sweepCheckouts(root), sweepTempRefs(root)]);
  const scope = scopeFrom(bools, values);
  if (!agent) {
    return runReview({
      flags: global,
      scope,
      target,
      base: values.get("--base"),
      all: bools.has(ALL),
      only: values.get("--only"),
      skip: values.get("--skip"),
      noGraph,
      reviewer: values.get("--reviewer"),
      timeoutMs: timeoutSeconds(values.get("--timeout")) * 1000,
      blockOn: blockOn as Severity | undefined,
      instructions: values.get("--instructions"),
      reportDir: values.get("--report-dir"),
      web: web === undefined ? undefined : web === "on",
    });
  }
  if (target !== undefined) {
    return runTarget(global, target, { base: values.get("--base"), only: values.get("--only"), skip: values.get("--skip"), noGraph });
  }
  if (bools.has(ALL)) return runAll(global, values.get("--only"), values.get("--skip"), noGraph);
  return runAgent(global, scope, values.get("--only"), values.get("--skip"), noGraph);
}

function timeoutSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1) throw new OpenQodexError(`--timeout takes a whole number of seconds, not ${value}`);
  return n;
}

// Quoted for a POSIX shell: the agent pastes this line as it is.
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// The command that finalizes this run. Started through the launcher, it is
// the plain line the Claude Code permission rules cover, run from the
// repository root: `<launcher> review --finalize`, with --all and --offline
// as the brief was made, and finalize finds the run through latest.json or
// latest-all.json. When an update moved the launcher on in between, finalize
// hands the run to the version that wrote the brief by its findings file.
// An explicit --config, or a run not started through the launcher, gets the
// full line that works from any folder: the repo, the config and the
// findings file named, with the pinned npx version (or, for a local build,
// its own node and entry file: see directRunner).
// A review of a branch or a pull request writes no receipt, so its line names
// the run (`--run <id>`) in place of the findings file.
function finalizeCommand(repoRoot: string, flags: GlobalFlags, findingsPath: string, all: boolean, runId?: string): string {
  const run = runId === undefined ? [] : ["--run", runId];
  if (launcherStarted() && flags.config === undefined) {
    return [launcherRunner(launcherPath(openqodexHomeDir())), "review", "--finalize", ...(all ? ["--all"] : []), ...run, ...(flags.offline ? ["--offline"] : [])].join(" ");
  }
  const runner = launcherStarted() ? launcherRunner(launcherPath(openqodexHomeDir())) : directRunner();
  const args = ["review", "--finalize", "--cwd", repoRoot];
  if (flags.config !== undefined) args.push("--config", isAbsolute(flags.config) ? flags.config : resolve(repoRoot, flags.config));
  args.push(...(runId === undefined ? [findingsPath] : run));
  return [runner, ...args.map(shellQuote)].join(" ");
}

async function runAgent(flags: GlobalFlags, scope: ChangeScope, only: string | undefined, skip: string | undefined, noGraph: boolean): Promise<number> {
  const p = await runPipeline({
    scope,
    flags,
    only: scannerList("--only", only),
    skip: scannerList("--skip", skip),
  });
  announceRepoFiles(p.repoRoot);
  if (p.scan === null) return nothingToReview(p.change);
  await writeBrief(p, flags, noGraph, scope);
  return EXIT_OK;
}

// The run folder, the manifest and the brief of a change review, printed.
// A target review records the target and writes no receipt: latest.json is
// the push gate's view of the developer's own change.
async function writeBrief(p: PipelineResult, flags: GlobalFlags, noGraph: boolean, scope: ChangeScope | null, target?: RunTarget): Promise<void> {
  if (p.scan === null) return;
  // Read after the template may have been created, so finalize hashes the
  // same file. Over the size limit it is refused, never cut.
  const instructions = ownersInstructions(p.repoRoot, p.secrets);

  const lenses = selectLenses(p.change, undefined, ruleCoverage(p));
  const dir = openReportDir(p.repoRoot, p.change.shortId);
  const runId = target ? basename(dir) : undefined;
  const manifest: RunManifest = {
    version: MANIFEST_VERSION,
    change_id: p.change.id,
    config_hash: configHash(p.config),
    created_at: new Date().toISOString(),
    lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
    instructions_hash: instructions.hash,
    runtime_version: __OPENQODEX_VERSION__,
    ...(target ? { target, run_id: runId } : {}),
  };
  const impact = await buildImpact(p, flags, noGraph);
  const brief = buildBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config: p.config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: finalizeCommand(p.repoRoot, flags, join(dir, FINDINGS_FILE), false, runId),
    impactBlock: renderImpactBlock(impact, { overflow: "impact.json beside this brief" }),
    instructions: instructions.text,
    target,
  });
  const runFile: RunFile = { version: 1, scope: scope ?? "target" };
  // Every file finalize reads, as text, so the run record hashes exactly what
  // was written and never what the folder holds a moment later.
  const bound = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "scan.json": `${JSON.stringify(p.scan, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
  };
  writeReportFiles(p.repoRoot, dir, {
    ...bound,
    [IMPACT_FILE]: `${JSON.stringify(impact, null, 2)}\n`,
    "brief.md": brief,
  });
  // The run record in the developer's home, for every run kind: finalize
  // trusts this run's files (the scan and its fingerprints, display.json)
  // and issues a push receipt only while they are the texts recorded here.
  const display = displayJson(buildDisplay({ change: p.change, secrets: p.secrets }));
  // It quotes the code under review: readable by the developer only.
  writeReportFiles(p.repoRoot, dir, { [DISPLAY_FILE]: display }, PRIVATE);
  recordRun(p.repoRoot, dir, manifest, bound, display);
  if (!target) {
    writeLatest(p.repoRoot, {
      dir: relative(p.repoRoot, dir),
      change_id: p.change.id,
      kind: "review",
      finalized: false,
      verdict: null,
    });
  }
  process.stdout.write(brief);
}

// The worktree is clean apart from our own state folder.
function cleanWorkTree(repoRoot: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain", "--", ".", ":(exclude).openqodex"], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 && r.stdout === "";
}

// `review [--agent] <target>`: a branch or a pull request. The change is the
// target's head against its merge base with the base, from the two commits'
// trees. Its files are read in place when the head is HEAD and the work tree
// is clean, else in a temporary checkout made without running anything from
// the repo's config, with the developer's own settings, never the target's.
// The checkout outlives an agent review until finalize; a scan removes it.
async function runTarget(
  flags: GlobalFlags,
  spec: string,
  opts: { base: string | undefined; only: string | undefined; skip: string | undefined; noGraph: boolean },
): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  announceRepoFiles(repoRoot);
  const t = await resolveTarget({ repoRoot, spec, offline: flags.offline, base: opts.base, defaultBase: config.defaultBase });
  try {
    return await reviewResolved(flags, spec, opts, repoRoot, config, t);
  } finally {
    // The run's own ref for a fetched pull request head; the checkout or HEAD now holds the commit.
    if (t.tmpRef !== null) await dropTempRef(repoRoot, t.tmpRef);
  }
}

async function reviewResolved(
  flags: GlobalFlags,
  spec: string,
  opts: { base: string | undefined; only: string | undefined; skip: string | undefined; noGraph: boolean },
  repoRoot: string,
  config: Config,
  t: Resolved,
): Promise<number> {
  for (const note of t.notes) warn(note);
  progress(flags)(
    `Reviewing ${spec} at ${t.headSha.slice(0, 12)}: base ${t.baseRef} (from ${t.baseSource}), merge base ${t.mergeBase.slice(0, 12)}`,
  );
  const change = await getTreeChange({ repoRoot, baseRef: t.baseRef, baseSha: t.mergeBase, headSha: t.headSha, exclude: config.exclude });
  if (change.files.length === 0) return nothingToReview(change);

  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  let tree: string | null = null;
  if (t.headSha !== head || !cleanWorkTree(repoRoot)) {
    if (t.headSha === head) warn(`Uncommitted work is not part of a target review: reviewing the committed ${spec} at ${t.headSha.slice(0, 12)}`);
    tree = (await addTargetCheckout(repoRoot, t.headSha, `${change.shortId}-`)).tree;
  }
  const target: RunTarget = {
    spec,
    base_ref: t.baseRef,
    base_source: t.baseSource,
    base_sha: t.baseSha,
    merge_base: t.mergeBase,
    head_sha: t.headSha,
    repo_root: repoRoot,
    checkout: tree,
  };
  let keep = false;
  try {
    if (tree !== null) {
      placeSettings(repoRoot, tree, false);
      const lfs = await lfsPaths(tree, change.changedPaths);
      if (lfs > 0) warn(`${lfs} changed ${lfs === 1 ? "file is" : "files are"} stored in Git LFS and not fetched: the review sees the pointer files`);
    }
    const p = await scanChange({
      repoRoot,
      workDir: tree ?? repoRoot,
      config,
      change,
      flags,
      only: scannerList("--only", opts.only),
      skip: scannerList("--skip", opts.skip),
    });
    await writeBrief(p, flags, opts.noGraph, null, target);
    keep = true;
    return EXIT_OK;
  } finally {
    if (tree !== null && !keep) await removeTargetCheckout(repoRoot, tree);
  }
}

// The receipt of the newest whole-repo run, beside latest.json, which only
// change reviews and scans write: the push gate reads latest.json, and a
// whole-repo run must never replace the receipt of the change being pushed.
const LATEST_ALL_FILE = "latest-all.json";

function writeLatestAll(repoRoot: string, latest: Latest): void {
  writeReportFiles(repoRoot, join(repoRoot, STATE_DIR), { [LATEST_ALL_FILE]: `${JSON.stringify(latest, null, 2)}\n` });
}

async function runAll(flags: GlobalFlags, only: string | undefined, skip: string | undefined, noGraph: boolean): Promise<number> {
  const { repoRoot, config } = await loadRepo(flags);
  announceRepoFiles(repoRoot);
  const whole = await getWholeRepo({ repoRoot, exclude: config.exclude });
  const p = await scanChange<WholeRepo>({
    repoRoot,
    config,
    change: whole,
    wholeRepo: true,
    flags,
    only: scannerList("--only", only),
    skip: scannerList("--skip", skip),
  });
  if (p.scan === null) {
    warn("Nothing to review: the repository has no files");
    return EXIT_OK;
  }

  const instructions = ownersInstructions(repoRoot, p.secrets);
  const lenses = wholeRepoLenses(p.change, ruleCoverage(p));
  const dir = openReportDir(repoRoot, p.change.shortId);
  const manifest: RunManifest = {
    version: MANIFEST_VERSION,
    change_id: p.change.id,
    config_hash: configHash(config),
    created_at: new Date().toISOString(),
    lenses: lenses.map((l) => ({ name: l.name, confidenceFloor: l.confidenceFloor })),
    instructions_hash: instructions.hash,
    runtime_version: __OPENQODEX_VERSION__,
  };
  const runFile: RunFile = { version: 1, scope: "all" };
  // Every file finalize reads, as text, so the run record hashes exactly what was written.
  const bound = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "scan.json": `${JSON.stringify(p.scan, null, 2)}\n`,
    "candidates.json": `${JSON.stringify(p.scan.candidates, null, 2)}\n`,
    [RUN_FILE]: `${JSON.stringify(runFile, null, 2)}\n`,
  };
  writeReportFiles(repoRoot, dir, bound);
  recordRun(repoRoot, dir, manifest, bound);
  const { impact, hot, note } = await buildHotSpots(p, flags, noGraph);
  const inventory = buildInventory(p.change, p.scan);
  const brief = buildWholeRepoBrief({
    change: p.change,
    scan: p.scan,
    lenses,
    config,
    secrets: p.secrets,
    findingsPath: join(dir, FINDINGS_FILE),
    finalizeCommand: finalizeCommand(repoRoot, flags, join(dir, FINDINGS_FILE), true),
    inventory,
    inventoryPath: join(dir, INVENTORY_FILE),
    hot,
    graphNote: note,
    instructions: instructions.text,
  });
  writeReportFiles(repoRoot, dir, {
    [INVENTORY_FILE]: `${JSON.stringify(redactStored(inventory, p.secrets), null, 2)}\n`,
    [IMPACT_FILE]: `${JSON.stringify(impact, null, 2)}\n`,
    "brief.md": brief,
  });
  writeLatestAll(repoRoot, {
    dir: relative(repoRoot, dir),
    change_id: p.change.id,
    kind: "review",
    finalized: false,
    verdict: null,
  });
  process.stdout.write(brief);
  return EXIT_OK;
}

// The graph's summary the brief was made with; null for a run from before the graph.
function readImpact(repoRoot: string, dir: string): ImpactSummary | null {
  const value = readJsonFile(repoRoot, join(dir, IMPACT_FILE), "graph impact") as ImpactSummary | null;
  // Version 1 (before 0.9) lacks the export and unknown blocks; the renderers read them as absent.
  const version = (value as { version?: unknown } | null)?.version;
  return value !== null && typeof value === "object" && (version === 1 || version === 2) ? value : null;
}

// A JSON file in the run folder, or null when it is missing. Read through
// the repo state reader: a link or anything but a regular file stops finalize.
function readJsonFile(repoRoot: string, path: string, what: string): unknown {
  const text = readRepoFile(repoRoot, path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpenQodexError(`${what} at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

// <yyyymmdd-hhmmss>-<shortid>, with "-2", "-3", ... for a second run in the same second.
const RUN_DIR_NAME = /^\d{8}-\d{6}-[0-9a-f]{12}(?:-\d+)?$/;

// The run folder must be a real folder directly under this repo's
// .openqodex/reviews/, reached through no symbolic link, and the findings
// file must not be a link either: finalize reads and writes only there. The
// shape is checked from the path text first, so nothing is looked up through
// a folder the path names before it is known to be the run folder. Returns
// the folder and the findings file spelled from the repo root.
function checkRunDir(repoRoot: string, dir: string, findingsPath: string): { dir: string; findingsPath: string } {
  const reviews = join(repoRoot, STATE_DIR, "reviews");
  const outside = new OpenQodexError(
    `${findingsPath} is not in a report folder under ${reviews}; write the findings where the brief says`,
  );
  const parent = dirname(dir);
  const state = dirname(parent);
  const root = dirname(state);
  // The repo root may be spelled another way (/var and /private/var on macOS); only it is resolved.
  const sameRoot = (): boolean => {
    try {
      return realpathSync(root) === realpathSync(repoRoot);
    } catch {
      return false;
    }
  };
  if (!RUN_DIR_NAME.test(basename(dir)) || basename(parent) !== "reviews" || basename(state) !== STATE_DIR || (root !== repoRoot && !sameRoot())) {
    throw outside;
  }
  const canonical = join(reviews, basename(dir));
  const findings = join(canonical, basename(findingsPath));
  // A link at .openqodex, reviews, the run folder or the findings file throws here.
  if (!repoStat(repoRoot, canonical)?.isDirectory()) throw outside;
  repoStat(repoRoot, findings);
  return { dir: canonical, findingsPath: findings };
}

// The report folder this submission belongs to: the newest run when no path
// is given (the newest whole-repo run with --all), else the folder that
// holds the findings file.
function findRun(repoRoot: string, path: string | undefined, all: boolean): { dir: string; findingsPath: string; submission: unknown } {
  let dir: string;
  let findingsPath: string;
  if (path === undefined) {
    const latest = readLatest(repoRoot, all);
    if (latest === null || typeof latest.dir !== "string") {
      throw new OpenQodexError(`no review brief found in this repository; ${RUN_AGAIN}`);
    }
    ({ dir, findingsPath } = checkRunDir(repoRoot, resolve(repoRoot, latest.dir), join(resolve(repoRoot, latest.dir), FINDINGS_FILE)));
    if (repoStat(repoRoot, join(dir, "manifest.json")) === null) throw new OpenQodexError(`the newest run has no review brief; ${RUN_AGAIN}`);
    if (repoStat(repoRoot, findingsPath) === null) {
      throw new OpenQodexError(`no agent findings at ${findingsPath}; write them there as the brief says, then run this again`);
    }
  } else {
    ({ dir, findingsPath } = checkRunDir(repoRoot, dirname(resolve(path)), resolve(path)));
  }
  const submission = readJsonFile(repoRoot, findingsPath, "agent findings");
  if (submission === null) throw new OpenQodexError(`agent findings not found at ${findingsPath}`);
  return { dir, findingsPath, submission };
}

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// A brief written by another version is finalized by that version: the brief's
// rules and the finalize checks belong together. It runs only
// <home>/runtime/<x.y.z>/dist/bin.js, built from the developer's home folder
// and a plain version, never a path read from the manifest; a repository
// cannot write into the home folder.
// The child gets the findings file this process selected, by path, so it
// finalizes the same run even when latest.json moves on in between, and the
// hidden --handed-off argument, so it never hands off again. An environment
// variable would be inherited from whatever started this process.
function finalizeOnVersion(version: unknown, args: string[], path: string | undefined, findingsPath: string, handedOff: boolean): number {
  if (handedOff) {
    throw new OpenQodexError(`this finalize was handed here by another openqodex version, and the brief names ${String(version)}; run openqodex review --agent again`);
  }
  if (typeof version !== "string" || !PLAIN_VERSION.test(version)) {
    throw new OpenQodexError("the brief names no valid openqodex version; run openqodex review --agent again");
  }
  const bin = runtimeBin(openqodexHomeDir(), version);
  if (!existsSync(bin)) {
    throw new OpenQodexError(`this brief was written by openqodex ${version}, which is not installed here; run openqodex review --agent again`);
  }
  // The flags as given, without the path, then -- and the selected path, so a
  // path after -- or one that starts with a dash reaches the child as a path.
  const dash = args.indexOf("--");
  const given = dash !== -1 ? args.slice(0, dash) : path === undefined ? args : args.filter((a, i) => i !== args.indexOf(path));
  // --run chose the run here; the child gets that run's findings path instead,
  // and a version from before --run would not know the flag.
  const flags = given.filter((a, i) => a !== "--run" && given[i - 1] !== "--run" && !a.startsWith("--run="));
  const child = spawnSync(process.execPath, [bin, "review", HANDED_OFF, ...flags, "--", findingsPath], { stdio: "inherit" });
  return child.status ?? EXIT_TOOL_FAILED;
}

// The run a `--run <id>` names, in this repository's report folders.
function findRunById(repoRoot: string, id: string): { dir: string; findingsPath: string; submission: unknown } {
  if (!RUN_DIR_NAME.test(id)) throw new OpenQodexError(`--run ${id} is not a run name; copy it from the brief's finalize line`);
  const { dir, findingsPath } = checkRunDir(repoRoot, join(repoRoot, STATE_DIR, "reviews", id), join(repoRoot, STATE_DIR, "reviews", id, FINDINGS_FILE));
  if (repoStat(repoRoot, join(dir, "manifest.json")) === null) throw new OpenQodexError(`the run ${id} has no review brief; ${RUN_AGAIN}`);
  const submission = readJsonFile(repoRoot, findingsPath, "agent findings");
  if (submission === null) throw new OpenQodexError(`no agent findings at ${findingsPath}; write them there as the brief says, then run this again`);
  return { dir, findingsPath, submission };
}

// The checkout a target review was briefed on, still at the head it recorded.
async function checkTargetCheckout(target: RunTarget): Promise<void> {
  if (target.checkout === null) return;
  // Only a checkout this tool made is read, or later removed.
  if (!inCheckouts(target.checkout)) {
    throw new OpenQodexError(`the run names a checkout outside ${checkoutsDir()}, which openqodex never makes; run the review again`);
  }
  if (!existsSync(target.checkout)) throw new OpenQodexError(`the temporary checkout of ${target.spec} is gone; run the review again`);
  const head = (await safeGit(target.checkout, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.toString("utf8").trim();
  if (head !== target.head_sha) {
    throw new OpenQodexError(
      `the temporary checkout of ${target.spec} moved from ${target.head_sha.slice(0, 12)} to ${head.slice(0, 12) || "nothing"} since the brief; run the review again`,
    );
  }
}

async function runFinalize(flags: GlobalFlags, path: string | undefined, all: boolean, args: string[], handedOff: boolean, runId: string | undefined): Promise<number> {
  // Refused before any config is read: a checkout's root config is the target's.
  const owner = checkoutOwner(await findRepoRoot(flags.cwd));
  if (owner !== null) throw new OpenQodexError(`this folder is the temporary checkout of a review; run finalize from ${owner}`);
  const { repoRoot, config } = await loadRepo(flags);
  if (runId !== undefined && (path !== undefined || all)) throw new OpenQodexError("--run names the run; give no findings path and no --all with it");
  const { dir, findingsPath, submission } = runId !== undefined ? findRunById(repoRoot, runId) : findRun(repoRoot, path, all);
  // Each run file is read once, here; everything below, the run record check
  // included, uses these texts and what was parsed from them, never the files
  // again, so a file swapped after this read changes nothing.
  const texts = readRunTexts(repoRoot, dir);
  const manifest = parseRunFile<RunManifest>(texts["manifest.json"]);
  const target = manifest?.target;
  // A review of a branch or a pull request is bound to its run by name.
  if (target !== undefined && runId === undefined) {
    throw new OpenQodexError(`this run reviewed ${target.spec}; finalize it with review --finalize --run ${basename(dir)}`);
  }
  if (manifest !== null && manifest.runtime_version !== undefined && manifest.runtime_version !== __OPENQODEX_VERSION__) {
    if (target !== undefined) {
      throw new OpenQodexError(`this brief was written by openqodex ${manifest.runtime_version}; run the review of ${target.spec} again`);
    }
    return finalizeOnVersion(manifest.runtime_version, args, path, findingsPath, handedOff);
  }
  const scan = parseRunFile<ScanResult>(texts["scan.json"]);
  const runFile = parseRunFile<RunFile>(texts[RUN_FILE]);
  if (manifest === null || scan === null || runFile === null) {
    throw new OpenQodexError(`the run in ${relative(repoRoot, dir)} has no review brief; ${RUN_AGAIN}`);
  }
  // A failure here cannot be fixed in the findings file: a target review's
  // checkout goes with it. A wrong field found later keeps it for the retry.
  const discard = async (): Promise<void> => {
    if (target?.checkout) await removeTargetCheckout(repoRoot, target.checkout);
  };
  try {
    checkBinding(repoRoot, config, manifest);
    if (target !== undefined) await checkTargetCheckout(target);
  } catch (error) {
    await discard();
    throw error;
  }
  const whole = runFile.scope === "all" ? await getWholeRepo({ repoRoot, exclude: config.exclude }) : null;
  const change = target
    ? await getTreeChange({ repoRoot, baseRef: target.base_ref, baseSha: target.merge_base, headSha: target.head_sha, exclude: config.exclude })
    : (whole ?? (await getChange({ repoRoot, scope: runFile.scope as ChangeScope, exclude: config.exclude, defaultBase: config.defaultBase })));
  // A whole-repo run has no change to trace, so its report carries no blast radius.
  const report = {
    ...finalizeReview({ change, scan, manifest, config, submission, wholeRepo: whole ?? undefined }),
    impact: whole ? null : readImpact(repoRoot, dir),
  };

  // The run as this machine recorded it when the brief was written, checked
  // before anything is rendered: the change, the config, the instructions
  // and the exact texts of the run files, scan.json and its fingerprints
  // included. A run with no record or another text (a scan.json copied from
  // another run, its fingerprints emptied) is not trusted: the page shows
  // no code, `findings` gets no record of it, the push hooks no receipt.
  const record = readHomeRun(openqodexHomeDir(), repoRoot, basename(dir));
  const verified = runMatches(record, { changeId: change.id, configHash: configHash(config), instructionsHash: currentInstructionsHash(repoRoot), texts });
  if (!verified) warn("openqodex: this run's files are not the ones review --agent recorded on this machine, so report.html shows the findings without the code and openqodex findings will not print this review");
  // Every output from one redaction pass. The secrets are gone from memory
  // by now; their saved fingerprints (scan.json, every line of a multi-line
  // secret included) redact the report, the paths and anything else printed.
  const out = reviewOutputs({ report, display: verified ? savedDisplay(repoRoot, dir, change, record) : null, dir, redact: (text) => redactByFingerprint(text, scan.secretFingerprints), version: __OPENQODEX_VERSION__ });
  const { "report.html": html, ...files } = out.files;
  writeReportFiles(repoRoot, dir, files);
  if (!writeReportHtml((f) => writeReportFiles(repoRoot, dir, f, PRIVATE), html!)) {
    await discard();
    return EXIT_TOOL_FAILED;
  }
  const paths = out.paths;
  const receipt: Latest = {
    dir: relative(repoRoot, dir),
    change_id: change.id,
    kind: "review",
    finalized: true,
    verdict: report.verdict,
  };
  // A target review is not the developer's change: no receipt.
  if (whole) writeLatestAll(repoRoot, receipt);
  else if (!target) {
    writeLatest(repoRoot, receipt);
    // A legacy record in the developer's home, so the push hooks accept this
    // review as before; only for a run this machine scanned (recordRun).
    try {
      if (verified) writeHomeReceipt(openqodexHomeDir(), repoRoot, gateReceipt(out.report, "legacy", relative(repoRoot, dir), paths.html));
      else warn("openqodex: this review is not recorded for the push hooks: its scan was not run by review --agent on this machine, or its files changed since; run openqodex review");
    } catch (error) {
      warn(`openqodex: could not record this review for the push hooks: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  if (verified) {
    try {
      writeHomeLastReview(openqodexHomeDir(), repoRoot, { dir, shown: out.paths.md.slice(0, -"/report.md".length), changeId: change.id, reportSha256: out.reportSha256 });
    } catch (error) {
      warn(`openqodex: could not record this review for openqodex findings: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  await discard();
  emitReview(out.report, flags, repoRoot, paths);
  return exitFor(report);
}

// The code report.html shows for a two-step review whose run files the
// record already vouched for: display.json as review --agent wrote it, used
// only when `record` holds its hash, the text still has it, and it is in the
// saved shape for this very change. A record without the hash, a changed
// file or another change: the page shows the findings without code, and one
// line says why. A whole-repository run saved none, and nothing is said.
function savedDisplay(repoRoot: string, dir: string, change: Change, record: RunRecord | null): Display | null {
  let text: string | null;
  try {
    text = readRepoFile(repoRoot, join(dir, DISPLAY_FILE), DISPLAY_MAX_BYTES + 1);
  } catch {
    text = "";
  }
  if (text === null) return null;
  let display: Display | null = null;
  if (record?.display_sha256 !== undefined && record.display_sha256 === sha256Of(text)) {
    try {
      display = checkDisplay(JSON.parse(text) as unknown, change.id);
    } catch {
      display = null;
    }
  }
  if (display === null) warn("openqodex: report.html shows the findings without the code: the saved code of this run is not the one this machine's record of the run vouches for, or not for this change");
  return display;
}

const sha256Of = (text: string | null): string | null => (text === null ? null : createHash("sha256").update(text, "utf8").digest("hex"));

// Writes the home run record of a change run: its change id, the config and
// instructions hashes it was made with, and the sha256 of each file finalize
// reads, from the text this process wrote (never read back from the folder,
// which the repository and the agent can write too). A failure is one
// warning line: the run then finalizes with no push receipt.
function recordRun(repoRoot: string, dir: string, manifest: RunManifest, files: Record<"manifest.json" | "scan.json" | "candidates.json" | "run.json", string>, display?: string): void {
  try {
    writeHomeRun(openqodexHomeDir(), repoRoot, basename(dir), {
      version: 1,
      change_id: manifest.change_id,
      config_hash: manifest.config_hash,
      instructions_hash: manifest.instructions_hash ?? null,
      manifest_sha256: sha256Of(files["manifest.json"])!,
      scan_sha256: sha256Of(files["scan.json"])!,
      candidates_sha256: sha256Of(files["candidates.json"])!,
      run_sha256: sha256Of(files["run.json"])!,
      ...(display !== undefined ? { display_sha256: sha256Of(display)! } : {}),
      written_at: new Date().toISOString(),
    });
  } catch (error) {
    warn(`openqodex: could not record this run for the push hooks: ${(error as Error).message.split("\n")[0]}`);
  }
}

type RunFileName = "manifest.json" | "scan.json" | "candidates.json" | "run.json";
const RUN_FILES: RunFileName[] = ["manifest.json", "scan.json", "candidates.json", "run.json"];

// The run files as text, each read once through the repo state reader (no
// link, nothing but a regular file); null for a file that is not there.
function readRunTexts(repoRoot: string, dir: string): Record<RunFileName, string | null> {
  return Object.fromEntries(RUN_FILES.map((name) => [name, readRepoFile(repoRoot, join(dir, name))])) as Record<RunFileName, string | null>;
}

function parseRunFile<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function currentInstructionsHash(repoRoot: string): string | null {
  try {
    return instructionsHash(readInstructions(repoRoot));
  } catch {
    return "unreadable";
  }
}

// Whether a home run record (looked up by the run folder's name, whose shape
// checkRunDir and readHomeRun both check) matches this run now: the change
// computed now from the working state, the config and instructions now, and
// the exact run file texts finalize goes on to use. It takes text, never a
// path, so what it checks is what finalize uses.
export function runMatches(
  run: RunRecord | null,
  now: { changeId: string; configHash: string; instructionsHash: string | null; texts: Record<RunFileName, string | null> },
): boolean {
  if (run === null) return false;
  const t = now.texts;
  return (
    run.change_id === now.changeId &&
    run.config_hash === now.configHash &&
    run.instructions_hash === now.instructionsHash &&
    run.manifest_sha256 === sha256Of(t["manifest.json"]) &&
    run.scan_sha256 === sha256Of(t["scan.json"]) &&
    run.candidates_sha256 === sha256Of(t["candidates.json"]) &&
    run.run_sha256 === sha256Of(t["run.json"])
  );
}

// The config and the instructions are the ones the brief was made with.
function checkBinding(repoRoot: string, config: Config, manifest: RunManifest): void {
  if (manifest.config_hash !== configHash(config)) {
    throw new OpenQodexError("the config changed since the brief (.openqodex/config.yaml or --config); run openqodex review --agent again");
  }
  // A run from before the field existed has no hash to compare.
  if (manifest.instructions_hash !== undefined) {
    let current: string | null;
    try {
      current = instructionsHash(readInstructions(repoRoot));
    } catch {
      current = "unreadable";
    }
    if (current !== manifest.instructions_hash) {
      throw new OpenQodexError("the instructions changed since the brief (.openqodex/custom-instructions.md); run review again (openqodex review --agent)");
    }
  }
}
