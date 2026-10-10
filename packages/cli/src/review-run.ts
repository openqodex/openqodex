// `openqodex review`: the whole review in one run, owned by the tool.
//
// The review itself (prepare, scan, redact, review, check, report, clean)
// is @openqodex/review's runReviewCore. This file is the command around it:
//   before    the flags and the user config turned into the core's inputs,
//             the repository's config, the team files, the --report-dir
//             folder checked before anything runs
//   parts     the laptop's parts the core runs with: snapshots under
//             <openqodex home>/checkouts/, scanners from the pinned table
//             with the install wait, the graph's kept store, the owners'
//             instructions, the reviewer drivers
//   during    every line printed, the run folder written as the core goes,
//             and the signal handlers that stop the reviewer and remove the
//             snapshot
//   after     the report files, the receipts and the records in the home,
//             the receipt printed, the exit code
//
// The developer's files are never written. A tool failure, an incomplete
// review and a missing reviewer all exit 2.
import { join, relative, resolve } from "node:path";
import { OpenQodexError, STATE_DIR, gateReceipt, openReportDir, redactSecrets, renderUnavailableHtml, writeLatest, writeReportFiles } from "@openqodex/core";
import type { ChangeScope, Config, Latest, Severity } from "@openqodex/core";
import { DEPTH_ENV, claudeDriver, codexDriver, cursorDriver, redactStored, reviewerOrder, runReviewCore } from "@openqodex/review";
import type { ReviewCoreResult, ReviewDeps, ReviewerDriver } from "@openqodex/review";
import { createToolResolver } from "@openqodex/scanners";
import { announceRepoFiles } from "./agents/repo-folder.js";
import { checkoutOwner, laptopSnapshots } from "./checkout.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "./exit-codes.js";
import { scannerList } from "./flags.js";
import type { GlobalFlags } from "./flags.js";
import { INSTALL_BUDGET_MS, emitReview, exitFor, graphStore, loadRepo, ownersInstructions, progress, reportFolderWriter, reviewOutputs, warn, writeReportHtml } from "./pipeline.js";
import { keepRunStateOutOfRepo, noteScan } from "./feedback.js";
import { directRunner, launcherPath, launcherRunner, launcherStarted, openqodexHomeDir, shQuote } from "./launcher.js";
import { writeHomeLastReview, writeHomeReceipt } from "./receipts.js";
import { readReviewerSettings } from "./reviewers/settings.js";
import { dropTempRef, resolveTarget } from "./target.js";

export const DEFAULT_TIMEOUT_SECONDS = 600;

// The order `auto` tries them in, after the agent running the command.
const DRIVERS: ReviewerDriver[] = [claudeDriver, codexDriver, cursorDriver];

// Every file a review writes in its run folder may quote the code under review.
const PRIVATE = 0o600;

export type ReviewOptions = {
  flags: GlobalFlags;
  scope: ChangeScope;
  target?: string;
  base?: string;
  all?: boolean;
  only?: string;
  skip?: string;
  noGraph: boolean;
  // --reviewer; when left out, `reviewer:` in the user config, else auto.
  reviewer?: string;
  timeoutMs: number;
  // The drivers to choose from; tests pass a model provider stand-in.
  drivers?: ReviewerDriver[];
  // Files to review as they were before `init` wrote them (getChange overlay).
  overlay?: { path: string; content: string | null }[];
  // --block-on-severity: wins over review.block_on_severity in the config, as for scan.
  blockOn?: Severity;
  // --instructions: the owners' instructions from this file instead of the
  // repository's .openqodex/custom-instructions.md (the Action passes the
  // base branch's copy, so a pull request cannot supply its own).
  instructions?: string;
  // --report-dir: every file of this run goes to this folder alone, and
  // nothing under .openqodex/ in the checkout is created, read or written
  // (without --config and --instructions, the built-in defaults and no
  // instructions), so a caller takes this run's report and never one a
  // branch planted there, and a link a branch committed there cannot stop
  // the run.
  // reviewer.json there says whether a reviewer started (and which), and
  // why none could when none did.
  reportDir?: string;
  // --reviewer-web: the reviewer's web tools for this run, over the user
  // config's reviewer_web.
  web?: boolean;
  // Filled with how the review ended, beside the exit code, which cannot
  // tell an incomplete review from one that never had a reviewer.
  end?: ReviewEnd;
  // How long a scanner still downloading is waited for; the scan's default
  // (INSTALL_BUDGET_MS) when left out.
  installBudgetMs?: number;
};

// The agents' names as a developer knows them.
export const REVIEWER_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

export type Readiness = { ready: { name: string; version: string } | null; reasons: string[] };

// The reviewer a review started now would use, by the same choice and order
// as `review`, with every driver's detect() run at once; or, when none can
// start, each one's reason and fix. Nothing is started.
export async function reviewerReadiness(repoRoot: string, drivers: ReviewerDriver[] = DRIVERS): Promise<Readiness> {
  const choice = readReviewerSettings().reviewer;
  const order = reviewerOrder(choice, drivers);
  const found = await Promise.all(order.map((d) => d.detect(repoRoot)));
  const reasons: string[] = [];
  for (const [i, d] of found.entries()) {
    if (d.ok) return { ready: { name: order[i].name, version: d.version }, reasons: [] };
    reasons.push(`${order[i].name}: ${d.missing}; ${d.fix}`);
  }
  return { ready: null, reasons: reasons.length > 0 ? reasons : [`${choice}: no driver of that name`] };
}

// How a review ended, for the caller that must say so (init's first review),
// why when that is not plain from `ended`, and the scanners it left out
// because they were still downloading.
export type ReviewEnd = { ended: "finished" | "incomplete" | "unavailable" | "nothing"; why?: string; installing: string[] };

// The laptop's parts the review core runs with, for this command's options:
// the drivers, snapshots under <openqodex home>/checkouts/, scanners from
// the pinned table (installed on first use unless --no-install, waited for
// up to the install budget), a branch or pull request resolved as `review
// <target>` does, the graph's kept store unless --report-dir, and the
// owners' instructions (none with --report-dir and no --instructions, never
// the checkout's file). The lines and the signal stop are the caller's.
export function laptopParts(o: ReviewOptions, repoRoot: string, config: Config): Omit<ReviewDeps, "onEvent" | "onStop"> {
  return {
    drivers: o.drivers ?? DRIVERS,
    snapshots: laptopSnapshots,
    resolveTool: createToolResolver({ allowInstall: !o.flags.noInstall, installBudgetMs: o.installBudgetMs ?? INSTALL_BUDGET_MS, onProgress: progress(o.flags) }),
    resolveTarget: async (spec) => {
      const t = await resolveTarget({ repoRoot, spec, offline: o.flags.offline, base: o.base, defaultBase: config.defaultBase });
      return {
        ...t,
        release: async () => {
          if (t.tmpRef !== null) await dropTempRef(repoRoot, t.tmpRef);
        },
      };
    },
    graphStore: o.reportDir === undefined ? () => graphStore(repoRoot, config) : undefined,
    instructions: (secrets) => (o.reportDir !== undefined && o.instructions === undefined ? { text: "", hash: null } : ownersInstructions(repoRoot, secrets, o.instructions)),
    now: Date.now,
  };
}

// The two-step review through the agent the developer works in, for when no
// reviewer can start: the same scope, folder, config and network limits,
// through the launcher, the pinned npx form, or a local build's own node and
// entry file (directRunner).
function fallbackCommand(o: ReviewOptions): string {
  const runner = launcherStarted() ? launcherRunner(launcherPath(openqodexHomeDir())) : directRunner();
  const base = o.base ?? o.scope.base;
  const scope = o.all
    ? ["--all"]
    : [...(o.target !== undefined ? [shQuote(o.target)] : []), ...(base !== undefined ? ["--base", shQuote(base)] : []), ...(o.scope.uncommitted ? ["--uncommitted"] : [])];
  const f = o.flags;
  const kept = [
    ...(f.cwd !== process.cwd() ? ["--cwd", shQuote(f.cwd)] : []),
    ...(f.config !== undefined ? ["--config", shQuote(resolve(f.config))] : []),
    ...(f.offline ? ["--offline"] : []),
    ...(f.noInstall ? ["--no-install"] : []),
  ];
  return [runner, "review", "--agent", ...scope, ...kept].join(" ");
}

type RunFolder = { dir: string; shown: string; write: (files: Record<string, string>) => void };

// Where a run's files go: a new folder under .openqodex/reviews/ in the
// repository, or with --report-dir that folder alone, so nothing under
// .openqodex/ in the checkout is created, read or written (a branch can
// commit links there). `shown`: the folder as the receipts name it.
// `reportWriter`: the --report-dir writer, made when the run began, so its
// folder was checked before anything else ran.
function runFolder(o: ReviewOptions, repoRoot: string, shortId: string, reportWriter: ((files: Record<string, string>) => void) | null): RunFolder {
  if (o.reportDir !== undefined && reportWriter !== null) {
    const dir = resolve(o.reportDir);
    return { dir, shown: dir, write: reportWriter };
  }
  const dir = openReportDir(repoRoot, shortId);
  return { dir, shown: relative(repoRoot, dir), write: (files) => writeReportFiles(repoRoot, dir, files, PRIVATE) };
}

export async function runReview(o: ReviewOptions): Promise<number> {
  if (process.env[DEPTH_ENV]) throw new OpenQodexError("openqodex review cannot run inside an openqodex reviewer");
  const say = progress(o.flags);
  const loaded = await loadRepo(o.flags, o.reportDir === undefined);
  const repoRoot = loaded.repoRoot;
  const config: Config = o.blockOn === undefined ? loaded.config : { ...loaded.config, blockOnSeverity: o.blockOn };
  const owner = checkoutOwner(repoRoot);
  if (owner !== null) throw new OpenQodexError(`this folder is the temporary checkout of a review; run review from ${owner}`);
  // A --report-dir reached through a link stops the run here, before
  // anything is made, scanned or written.
  const reportWriter = o.reportDir === undefined ? null : reportFolderWriter(o.reportDir, repoRoot);
  if (o.reportDir === undefined) announceRepoFiles(repoRoot);
  else keepRunStateOutOfRepo();
  const settings = readReviewerSettings();
  for (const w of settings.warnings) warn(`openqodex: ${w}`);
  const web = o.web ?? settings.web;
  const parts = laptopParts(o, repoRoot, config);
  const choice = o.reviewer ?? settings.reviewer;
  // An unknown reviewer name stops the run before the scanner lists are read.
  reviewerOrder(choice, parts.drivers);
  const only = scannerList("--only", o.only);
  const skip = scannerList("--skip", o.skip);

  // Set as the core goes: the run folder once the change is known, and the
  // raw matched secrets, for every redaction done here.
  let folder: RunFolder | null = null;
  let secrets: string[] = [];
  const write = (files: Record<string, string>): void => (folder as RunFolder | null)!.write(files);
  // The one redaction every output of this run goes through (redact.ts:
  // each matched secret and each line of a multi-line one).
  const redact = (text: string): string => redactSecrets(text, secrets);
  // --report-dir: whether a reviewer started, and which, so a caller tells
  // a review that stopped from one that never began without reading stderr.
  const noteReviewer = (record: { started: boolean; reasons?: string[]; driver?: string; version?: string }): void => {
    if (o.reportDir !== undefined) write({ "reviewer.json": `${JSON.stringify(redactStored(record, secrets))}\n` });
  };
  // Ctrl-C or a kill: the core's stop ends the reviewer's process group and
  // removes the snapshot, synchronously, since the process exits right after.
  let onSignal: ((signal: NodeJS.Signals) => void) | null = null;
  const offSignals = (): void => {
    const handler = onSignal as ((signal: NodeJS.Signals) => void) | null;
    if (handler !== null) {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    }
  };
  // Everything the run writes and prints from its result, before the core
  // removes the snapshot: a cleanup that fails then fails the command after
  // the review is on disk, recorded and printed.
  const finish = (result: ReviewCoreResult): number => {
    if (result.ended === "nothing") {
      if (o.end) o.end.ended = "nothing";
      return EXIT_OK;
    }
    const dir = (folder as RunFolder | null)!.dir;

    // No reviewer can start: the scanner candidates are saved as unchecked,
    // never as a review, and the fallback through the agent the developer is in is named.
    // report.html then says the review is unavailable and why; it is not a review.
    // Paths and commands are printed and written through the same redaction
    // as the report: a secret can sit in a folder name.
    if (result.ended === "unavailable") {
      const reasons = redactStored(result.reasons, secrets);
      const path = redact(join(dir, "unchecked-candidates.json"));
      const fallback = redact(fallbackCommand(o));
      write({
        "unchecked-candidates.json": `${JSON.stringify({ label: "unchecked scanner candidates, not a review: no reviewer checked them", change_id: result.change.id, candidates: result.scan.candidates }, null, 2)}\n`,
        "report.html": renderUnavailableHtml({ changeId: result.change.id, reasons, candidatesPath: path, fallback, version: __OPENQODEX_VERSION__ }),
      });
      noteReviewer({ started: false, reasons });
      warn("Full review unavailable: openqodex could not start a reviewer.");
      for (const line of reasons) warn(`- ${line}`);
      warn(`Unchecked scanner candidates, not a review: ${path}`);
      warn(`To review with the agent you are in instead, run \`${fallback}\` and follow the brief it prints.`);
      warn(`Status page: ${redact(join(dir, "report.html"))}`);
      if (o.end) o.end.ended = "unavailable";
      return EXIT_TOOL_FAILED;
    }

    // The command passes no model reviewer, so the core never ends this way here.
    if (result.ended === "model-reviewed") throw new OpenQodexError("the review core ended with a model reviewer, which the command never gives it");
    const { report, completion, change } = result;
    const shown = (folder as RunFolder | null)!.shown;
    // Every file, record and line printed from here on is drawn from `out`.
    const out = reviewOutputs({ report, display: result.display, dir, redact, version: __OPENQODEX_VERSION__ });
    const { "report.html": html, ...files } = out.files;

    write({
      ...files,
      "submission.json": `${JSON.stringify(redactStored(result.submission, secrets), null, 2)}\n`,
      "trace.json": `${JSON.stringify(redactStored(result.trace, secrets), null, 2)}\n`,
    });
    if (!writeReportHtml(write, html!)) {
      if (o.end) {
        o.end.ended = "incomplete";
        o.end.why = "report.html could not be written";
      }
      return EXIT_TOOL_FAILED;
    }
    const receipt: Latest = {
      dir: shown,
      change_id: change.id,
      kind: "review",
      finalized: completion.status === "complete",
      verdict: completion.status === "complete" ? report.verdict : null,
      completion: completion.status,
    };
    // The push gate's receipt is the developer's own change only. With
    // --report-dir no receipt is written in the checkout; the one in the
    // developer's home still is.
    const inCheckout = o.reportDir === undefined;
    if (result.whole) {
      if (inCheckout) writeReportFiles(repoRoot, join(repoRoot, STATE_DIR), { "latest-all.json": `${JSON.stringify(receipt, null, 2)}\n` });
    } else if (result.target === null) {
      // A link a branch put at .openqodex/latest.json stops this record only,
      // never the review: the report is written, and the push hooks trust the
      // record in the developer's home below.
      if (inCheckout) {
        try {
          writeLatest(repoRoot, receipt);
        } catch (error) {
          warn(`openqodex: could not write the review record in .openqodex: ${(error as Error).message.split("\n")[0]}`);
        }
      }
      // The record the push hooks trust, in the developer's home: a branch
      // cannot plant it the way it can carry files under .openqodex/.
      try {
        writeHomeReceipt(openqodexHomeDir(), repoRoot, gateReceipt(out.report, completion.status, shown, out.paths.html));
      } catch (error) {
        warn(`openqodex: could not record this review for the push hooks: ${(error as Error).message.split("\n")[0]}`);
      }
    }
    // The review `openqodex findings` reads, whatever kind it was, with the
    // hash of the report.json it may print.
    try {
      writeHomeLastReview(openqodexHomeDir(), repoRoot, { dir, shown: redact(dir), changeId: change.id, reportSha256: out.reportSha256 });
    } catch (error) {
      warn(`openqodex: could not record this review for openqodex findings: ${(error as Error).message.split("\n")[0]}`);
    }
    emitReview(out.report, o.flags, repoRoot, out.paths);
    if (o.end) o.end.ended = completion.status === "complete" ? "finished" : "incomplete";
    return exitFor(report);
  };
  let code: number = EXIT_OK;
  try {
    await runReviewCore(
      { repoRoot, config, scope: o.scope, all: o.all, target: o.target, overlay: o.overlay, only, skip, noGraph: o.noGraph, reviewer: choice, web, timeoutMs: o.timeoutMs, runtimeVersion: __OPENQODEX_VERSION__ },
      {
        ...parts,
        onEvent: (e) => {
          if (e.type === "progress") say(e.line);
          else if (e.type === "warning") warn(e.line);
          else if (e.type === "scan") noteScan(repoRoot, e.scan);
          else if (e.type === "prepared") {
            secrets = e.secrets;
            if (o.end) o.end.installing = e.scan.scanners.filter((s) => s.status === "installing").map((s) => s.scanner);
            folder = runFolder(o, repoRoot, e.change.shortId, reportWriter);
          } else if (e.type === "brief") {
            write({
              "manifest.json": `${JSON.stringify(e.manifest, null, 2)}\n`,
              "scan.json": `${JSON.stringify(e.scan, null, 2)}\n`,
              "brief.md": e.brief,
              "impact.json": `${JSON.stringify(e.impact, null, 2)}\n`,
            });
          } else if (e.type === "started") noteReviewer({ started: true, driver: e.driver, version: e.version });
        },
        onStop: (stop) => {
          onSignal = (signal) => {
            stop();
            process.exit(signal === "SIGINT" ? 130 : 143);
          };
          process.once("SIGINT", onSignal);
          process.once("SIGTERM", onSignal);
        },
        onResult: (result) => {
          try {
            code = finish(result);
          } finally {
            offSignals();
          }
        },
      },
    );
    return code;
  } finally {
    offSignals();
  }
}
