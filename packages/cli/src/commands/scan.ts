// `openqodex scan`: the scanners only, on the current change. Used by the
// Action and pre-commit; not a review.
import { relative, resolve } from "node:path";
import { OpenQodexError, SEVERITIES, openReportDir, scanReport, writeLatestScan, writeReportFiles, writeScan } from "@openqodex/core";
import type { PipelineResult } from "@openqodex/review";
import { announceRepoFiles } from "../agents/repo-folder.js";
import { keepRunStateOutOfRepo } from "../feedback.js";
import type { ChangeScope, Report, Severity } from "@openqodex/core";
import { parseFlags, scannerList } from "../flags.js";
import type { GlobalFlags } from "../flags.js";
import { checkReportFolder, emitReport, exitFor, nothingToReview, reportFiles, runPipeline, writeReportCopies } from "../pipeline.js";

export const SCOPE_BOOLS = ["--uncommitted"];
export const SCOPE_VALUES = ["--base"];

export function scopeFrom(bools: Set<string>, values: Map<string, string>): ChangeScope {
  const scope: ChangeScope = {};
  const base = values.get("--base");
  if (base !== undefined) scope.base = base;
  if (bools.has("--uncommitted")) scope.uncommitted = true;
  return scope;
}

export type ScanOutcome = { exitCode: number; report: Report | null; dir: string | null };

export async function runScan(args: {
  flags: GlobalFlags;
  scope: ChangeScope;
  only?: string;
  skip?: string;
  // --block-on-severity: wins over the config's review.block_on_severity, so
  // a workflow can set a gate the change's own config cannot weaken.
  blockOn?: string;
  // --report-dir: this scan's files go to this folder alone, and nothing
  // under .openqodex/ in the checkout is created, read or written (without
  // --config, the built-in defaults), so a link a branch committed there
  // cannot stop the scan (the GitHub Action).
  reportDir?: string;
}): Promise<ScanOutcome> {
  const { flags } = args;
  if (args.blockOn !== undefined && !(SEVERITIES as readonly string[]).includes(args.blockOn)) {
    throw new OpenQodexError(`--block-on-severity must be one of ${SEVERITIES.join(", ")}, not ${args.blockOn}`);
  }
  if (args.reportDir !== undefined) {
    // A folder reached through a link stops the scan before it runs.
    checkReportFolder(args.reportDir);
    keepRunStateOutOfRepo();
  }
  const p = await runPipeline({
    scope: args.scope,
    flags,
    only: scannerList("--only", args.only),
    skip: scannerList("--skip", args.skip),
    checkoutSettings: args.reportDir === undefined,
  });
  if (args.blockOn !== undefined) p.config = { ...p.config, blockOnSeverity: args.blockOn as Severity };
  if (args.reportDir === undefined) announceRepoFiles(p.repoRoot);
  return reportScan(p, flags, args.reportDir);
}

// The scan report of a pipeline run, written to a run folder of the
// developer's repository, or with `reportDir` to that folder alone, and printed.
export function reportScan(p: PipelineResult, flags: GlobalFlags, reportDir?: string): ScanOutcome {
  if (p.scan === null) return { exitCode: nothingToReview(p.change), report: null, dir: null };

  const report = scanReport({ change: p.change, scan: p.scan, config: p.config });
  const files = reportFiles(report);
  if (reportDir !== undefined) {
    const dir = resolve(reportDir);
    writeReportCopies(dir, p.repoRoot, { "scan.json": `${JSON.stringify(p.scan, null, 2)}\n`, ...files });
    emitReport(report, flags, p.repoRoot);
    return { exitCode: exitFor(report), report, dir };
  }
  const dir = openReportDir(p.repoRoot, p.change.shortId);
  writeScan(p.repoRoot, dir, p.scan);
  writeReportFiles(p.repoRoot, dir, files);
  // The scan receipt: the push gate reads only the review receipt, so a scan
  // never makes it forget a finalized review of the same change.
  writeLatestScan(p.repoRoot, {
    dir: relative(p.repoRoot, dir),
    change_id: p.change.id,
    kind: "scan",
    finalized: false,
    verdict: report.verdict,
  });
  emitReport(report, flags, p.repoRoot);
  return { exitCode: exitFor(report), report, dir };
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values } = parseFlags(args, {
    bools: SCOPE_BOOLS,
    values: [...SCOPE_VALUES, "--only", "--skip", "--block-on-severity", "--report-dir"],
  });
  const outcome = await runScan({
    flags: global,
    scope: scopeFrom(bools, values),
    only: values.get("--only"),
    skip: values.get("--skip"),
    blockOn: values.get("--block-on-severity"),
    reportDir: values.get("--report-dir"),
  });
  return outcome.exitCode;
}
