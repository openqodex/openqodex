// The scan pipeline every command shares: find the repo, load the config,
// work out the change, run the scanners on it. Progress goes to stderr.
// The scan and the graph themselves are @openqodex/review's; the wrappers
// here give them the CLI's parts from the flags.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import {
  OpenQodexError,
  DEFAULT_CONFIG,
  closeWider,
  findRepoRoot,
  getChange,
  isRepoState,
  loadConfig,
  redactSecrets,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderReceipt,
  renderReview,
  renderSarif,
  renderTerminal,
  writeRepoFile,
} from "@openqodex/core";
import type { Change, ChangeScope, Config, Display, HotSpot, ImpactSummary, Report, ScannerSource } from "@openqodex/core";
import { openStore } from "@openqodex/graph";
import type { GraphStore } from "@openqodex/graph";
import { buildGraphRun as reviewGraphRun, buildHotSpots as reviewHotSpots, nothingToReviewLine, redactWith, scanChange as reviewScan } from "@openqodex/review";
import type { GraphHost, GraphRun, PipelineResult, ScanHost } from "@openqodex/review";
import { createToolResolver, openqodexHome } from "@openqodex/scanners";
import { Guard } from "./agents/guarded-fs.js";
import { instructionsTemplate } from "./agents/repo-folder.js";
import { EXIT_FINDINGS, EXIT_OK, EXIT_TOOL_FAILED } from "./exit-codes.js";
import { readInstructions, readInstructionsAt } from "./instructions.js";
import { noteScan } from "./feedback.js";
import type { GlobalFlags } from "./flags.js";

export const INSTALL_BUDGET_MS = 45_000;

export function progress(flags: GlobalFlags): (line: string) => void {
  return (line) => {
    if (!flags.quiet) process.stderr.write(`${line}\n`);
  };
}

export function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}

// `checkoutSettings` false (`--report-dir`): without `--config` the built-in
// defaults, never the repository's own file, so nothing under .openqodex/
// in the checkout is read.
export async function loadRepo(flags: GlobalFlags, checkoutSettings = true): Promise<{ repoRoot: string; config: Config }> {
  const repoRoot = await findRepoRoot(flags.cwd);
  if (!checkoutSettings && flags.config === undefined) return { repoRoot, config: structuredClone(DEFAULT_CONFIG) };
  const loaded = loadConfig(repoRoot, flags.config, { runtimeVersion: __OPENQODEX_VERSION__ });
  for (const w of loaded.warnings) warn(`openqodex: ${w}`);
  return { repoRoot, config: loaded.config };
}

export async function runPipeline(args: {
  scope: ChangeScope;
  flags: GlobalFlags;
  only?: ScannerSource[];
  skip?: ScannerSource[];
  checkoutSettings?: boolean;
}): Promise<PipelineResult> {
  const { repoRoot, config } = await loadRepo(args.flags, args.checkoutSettings);
  const change = await getChange({ repoRoot, scope: args.scope, exclude: config.exclude, defaultBase: config.defaultBase });
  return scanChange({ ...args, repoRoot, config, change });
}

// The scan's parts from the flags: scanners resolved from the pinned table,
// installed on first use unless --no-install and waited for up to
// `installBudgetMs` (INSTALL_BUDGET_MS when left out); progress on stderr;
// a scanner that failed queues the feedback offer.
export function scanHost(flags: GlobalFlags, repoRoot: string, installBudgetMs?: number): ScanHost {
  const onProgress = progress(flags);
  return {
    resolveTool: createToolResolver({
      allowInstall: !flags.noInstall,
      installBudgetMs: installBudgetMs ?? INSTALL_BUDGET_MS,
      onProgress,
    }),
    onProgress,
    onScan: (scan) => noteScan(repoRoot, scan),
  };
}

// The scanners on a change already worked out (@openqodex/review's
// scanChange), with the parts from the flags.
export async function scanChange<C extends Change>(args: {
  repoRoot: string;
  workDir?: string;
  config: Config;
  change: C;
  wholeRepo?: boolean;
  flags: GlobalFlags;
  only?: ScannerSource[];
  skip?: ScannerSource[];
  // How long a scanner still downloading is waited for; INSTALL_BUDGET_MS
  // unless the caller says otherwise (the review init ends with).
  installBudgetMs?: number;
}): Promise<PipelineResult & { change: C }> {
  return reviewScan({ repoRoot: args.repoRoot, workDir: args.workDir, config: args.config, change: args.change, wholeRepo: args.wholeRepo, only: args.only, skip: args.skip, host: scanHost(args.flags, args.repoRoot, args.installBudgetMs) });
}

export type ReviewOutputs = {
  // The report every output is drawn from, after the redaction.
  report: Report;
  // report.html and report.md as the receipt prints them, after the redaction.
  paths: { html: string; md: string };
  // report.md, report.json, report.sarif and report.html, to write as they are.
  files: Record<string, string>;
  // sha256 of report.json's text, for the home record `findings` checks.
  reportSha256: string;
};

// Every output of a finished review, from one redaction pass: every string
// of the report (the summary, each finding with its file name and suggested
// change, the dropped reasons and the scanners' messages) and the run
// folder's paths go through `redact` once, and every file and the receipt
// (renderReceipt over `report` and `paths`) are drawn from what came out.
// `redact`: by the matched secrets in a review run here (redactSecrets), by
// their saved fingerprints in a two-step finalize (redactByFingerprint);
// both remove every line of a multi-line secret too. `display` is redacted
// when it is built.
export function reviewOutputs(args: { report: Report; display: Display | null; dir: string; redact: (text: string) => string; version: string }): ReviewOutputs {
  const report = redactWith(args.report, args.redact);
  const paths = { html: args.redact(join(args.dir, "report.html")), md: args.redact(join(args.dir, "report.md")) };
  const files: Record<string, string> = { ...reportFiles(report), "report.html": renderHtml({ report, display: args.display, version: args.version, reportMd: paths.md }) };
  return { report, paths, files, reportSha256: createHash("sha256").update(files["report.json"] as string, "utf8").digest("hex") };
}

// The graph folder of the developer's repository for this run, or null when
// the folder cannot be used (a link, a tracked file, a folder other users
// can write): the graph is then built in memory, the run goes on, and
// `refused` says why, for the build's reasons. A run that keeps nothing
// (--report-dir writes nothing under .openqodex/) never asks for it.
export async function graphStore(repoRoot: string, config: Config): Promise<{ store: GraphStore | null; refused?: string }> {
  let refused: string;
  try {
    const opened = await openStore(repoRoot, { home: openqodexHome(), maxCacheMb: config.graph.maxCacheMb });
    if (opened.ok) return { store: opened.store };
    refused = opened.reason;
  } catch (error) {
    refused = ((error as Error).message ?? "").split("\n")[0] ?? "";
  }
  warn(`openqodex: the code graph's folder is not used: ${refused}`);
  return { store: null, refused };
}

// The graph's parts from the flags: the repository's kept store unless
// `persist` is false (--report-dir), progress on stderr, warnings on stderr.
function graphHost(p: PipelineResult, flags: GlobalFlags, persist: boolean): GraphHost {
  return { store: persist ? () => graphStore(p.repoRoot, p.config) : undefined, onProgress: progress(flags), warn };
}

// The graph of a review and its view of the change (@openqodex/review's
// buildGraphRun), with the parts from the flags.
export async function buildGraphRun(p: PipelineResult, flags: GlobalFlags, noGraph: boolean, persist = true): Promise<GraphRun> {
  return reviewGraphRun(p, graphHost(p, flags, persist), noGraph);
}

// The code graph's view of the change, for a run that holds no build open.
export async function buildImpact(p: PipelineResult, flags: GlobalFlags, noGraph: boolean, persist = true): Promise<ImpactSummary> {
  return (await buildGraphRun(p, flags, noGraph, persist)).impact;
}

// For the whole repository: the graph's most-called symbols (@openqodex/review's
// buildHotSpots), with the parts from the flags.
export async function buildHotSpots(
  p: PipelineResult,
  flags: GlobalFlags,
  noGraph: boolean,
  persist = true,
): Promise<{ impact: ImpactSummary; hot: HotSpot[]; note: string | null }> {
  return reviewHotSpots(p, graphHost(p, flags, persist), noGraph);
}

export function nothingToReview(change: Change): number {
  warn(nothingToReviewLine(change));
  return EXIT_OK;
}

// The four report files every finished run writes. A review `review` ran
// with its own reviewer has the standard report; a scan and a legacy review
// keep theirs.
export function reportFiles(report: Report): Record<string, string> {
  return {
    "report.md": report.completion ? renderReview(report, { format: "markdown" }) : renderMarkdown(report),
    "report.json": renderJson(report),
    "report.sarif": renderSarif(report),
  };
}

// The chosen format to stdout, or to --output.
export function emitReport(report: Report, flags: GlobalFlags, repoRoot: string): void {
  const color = flags.color && flags.output === undefined;
  const text =
    flags.format === "markdown"
      ? report.completion
        ? renderReview(report, { format: "markdown" })
        : renderMarkdown(report)
      : flags.format === "json"
        ? renderJson(report)
        : flags.format === "sarif"
          ? renderSarif(report)
          : report.completion
            ? renderReview(report, { format: "terminal", color })
            : renderTerminal(report, { color });
  if (flags.output !== undefined) writeOutFile(resolve(flags.output), repoRoot, text);
  else process.stdout.write(text);
}

// What a finished review prints. The default terminal format is the
// receipt: the verdict, one line per finding and the absolute paths of
// report.html and report.md, so the developer reads the review there and
// names what to fix. An explicit markdown, json or sarif format is the whole
// report in that format, as before (the Action and scripts read it), and the
// two paths go to stderr, where --quiet keeps them: they are results, not
// progress. --output writes the chosen text to a file instead of stdout.
export function emitReview(report: Report, flags: GlobalFlags, repoRoot: string, paths: { html: string; md: string }): void {
  if (flags.format !== "terminal") {
    emitReport(report, flags, repoRoot);
    warn(`Report: ${paths.html}`);
    warn(`Markdown: ${paths.md}`);
    return;
  }
  const text = renderReceipt(report, { ...paths, color: flags.color && flags.output === undefined });
  if (flags.output !== undefined) writeOutFile(resolve(flags.output), repoRoot, text);
  else process.stdout.write(text);
}

// report.html, written before anything announces the review. False, with
// one line on stderr, when it could not be written: the caller then records
// no review, prints no receipt and exits 2.
export function writeReportHtml(write: (files: Record<string, string>) => void, html: string): boolean {
  try {
    write({ "report.html": html });
    return true;
  } catch (error) {
    warn(`openqodex: could not write report.html (${(error as Error).message.split("\n")[0]}); report.md and report.json beside it hold the review, which is not recorded for the push hooks`);
    return false;
  }
}

// A temp file beside it, then a rename: an existing entry, a symbolic link
// included, is replaced and never written through. Into the repo state:
// through the repo state writer, never through a link. A report quotes the
// code, so the file is created readable by its owner only.
function writeOutFile(out: string, repoRoot: string, text: string, mode = 0o600): void {
  const state = isRepoState(repoRoot, out);
  if (state !== null) {
    writeRepoFile(repoRoot, state, text, { mode });
    return;
  }
  const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode });
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// `--report-dir <folder>` of scan and review: the run's files, written to a
// folder the caller names instead of .openqodex/reviews/, readable by their
// owner only. The GitHub Action names a new folder of its own, so it never
// takes a report that a branch committed under .openqodex/ for this run's.
//
// The folder must be reached through no symbolic link but the system's own
// aliases: each part of its path, from the root, is looked at without
// following it, and the only links allowed are /var, /tmp and /etc on macOS
// pointing at their folders under /private, where the walk goes on and
// allows no further link. Any other link, whoever owns it, stops the
// command before anything is made or written: a link a repository or
// anyone else put there would send the run's files where it points. In a
// folder that is there already, a file that is a link stops it too.
//
// The writer that comes back holds a guard (agents/guarded-fs.ts) whose one
// root is that folder, as it is now: every file is written through a
// checked handle into that very folder, so a link swapped in later, at the
// folder or at a file in it, that leads anywhere else is refused. The
// repository's link rule holds on every write too, as for its own
// .openqodex files: a link whose own place lies in the work tree is never
// followed, even one that leads back to this very folder.
//
// Each file is created 0600, and a folder made for it 0700. A folder that
// was there already (a run folder reused) and that other users could open
// is closed to 0700 at the first write, and named once on stderr.
const SYSTEM_ALIASES: Record<string, string> = { "/var": "/private/var", "/tmp": "/private/tmp", "/etc": "/private/etc" };

// Whether the link at `path` reading `target` is one of the system's own aliases.
export function systemAlias(path: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && Object.hasOwn(SYSTEM_ALIASES, path) && resolve(sep, target) === SYSTEM_ALIASES[path];
}

export function checkReportFolder(folder: string): string {
  const dir = resolve(folder);
  const refuse = (at: string) => new OpenQodexError(`--report-dir ${folder}: ${at} is a symbolic link; name a folder reached through no link`);
  const realFolder = (at: string): void => {
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw refuse(at);
    if (st !== undefined && !st.isDirectory()) throw new OpenQodexError(`--report-dir ${folder}: ${at} is not a folder`);
  };
  let at = parse(dir).root;
  for (const part of dir.slice(at.length).split(sep).filter((p) => p !== "")) {
    const next = join(at, part);
    const st = lstatSync(next, { throwIfNoEntry: false });
    if (st === undefined) break;
    if (st.isSymbolicLink()) {
      if (!systemAlias(next, readlinkSync(next))) throw refuse(next);
      // The alias's own target, each part of it a real folder.
      at = parse(next).root;
      for (const p of SYSTEM_ALIASES[next]!.split(sep).filter((x) => x !== "")) {
        at = join(at, p);
        realFolder(at);
      }
      continue;
    }
    realFolder(next);
    at = next;
  }
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isSymbolicLink()) throw refuse(join(dir, e.name));
  }
  return dir;
}

export function reportFolderWriter(folder: string, repoRoot: string | null): (files: Record<string, string>) => void {
  const dir = checkReportFolder(folder);
  const guard = new Guard({ repoRoot, gitFolders: [], roots: [dir], writeRepo: false });
  // Named by its real path: the write reports the folder as it really lies.
  let shownFrom = dir;
  try {
    shownFrom = realpathSync(dir);
  } catch {
    // not made yet: the write makes it 0700 and has nothing to report
  }
  const wider = closeWider(guard, shownFrom);
  return (files) => {
    for (const [name, text] of Object.entries(files)) {
      if (name !== basename(name) || name.startsWith(".")) throw new Error(`not a plain file name: ${name}`);
      if (lstatSync(join(dir, name), { throwIfNoEntry: false })?.isSymbolicLink()) throw new OpenQodexError(`--report-dir ${folder}: ${join(dir, name)} is a symbolic link; openqodex does not write through it`);
      guard.write(join(dir, name), text, { mode: 0o600, folderMode: 0o700, wider });
    }
  };
}

export function writeReportCopies(folder: string, repoRoot: string | null, files: Record<string, string>): void {
  reportFolderWriter(folder, repoRoot)(files);
}

export function exitFor(report: Report): number {
  if (report.verdict === "incomplete") return EXIT_TOOL_FAILED;
  return report.verdict === "blocked" ? EXIT_FINDINGS : EXIT_OK;
}

// sha256 of the instructions file, null when there is none. Finalize compares
// it with the brief's, so a review always follows the instructions as they are.
export function instructionsHash(text: string): string | null {
  return text === "" ? null : createHash("sha256").update(text).digest("hex");
}

// The owners' instructions as the brief takes them, and their hash: from the
// repository's file, or from the file `review --instructions` names. The
// untouched template says nothing about this repo: no block for it.
export function ownersInstructions(repoRoot: string, secrets: string[], path?: string): { text: string; hash: string | null } {
  const raw = path === undefined ? readInstructions(repoRoot) : readInstructionsAt(repoRoot, path);
  return { text: raw === "" || raw === instructionsTemplate() ? "" : redactSecrets(raw, secrets), hash: instructionsHash(raw) };
}
