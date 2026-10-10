// Semgrep adapter. Runs `semgrep scan` against the developer's working tree
// with three rule packs (default, security-audit, secrets) and normalizes the
// vendor JSON into StaticFinding[]. Every error is captured into the result;
// the runner never throws on a scanner failure: static analysis is additive
// context, not a gate.
//
// The rule packs are fetched from the Semgrep registry at run time onto the
// developer's machine and never bundled. Semgrep keeps its settings and logs
// under ~/.semgrep, outside the repo, and writes nothing into the working tree.
// Its temp files go to a folder of its own, removed after the scan.

import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterResult, ResolvedTool, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, runInChunks, isOffline, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";

const SEMGREP_TIMEOUT_MS = 60_000;
// Per-rule timeout. Semgrep's --timeout flag caps a single rule's
// run against a single file. With many files and many rules, the
// per-file budget is still bounded by SEMGREP_TIMEOUT_MS above.
const SEMGREP_PER_RULE_TIMEOUT_SEC = 30;
// semgrep skips a larger file, so a suppression comment in one hides nothing.
export const SEMGREP_MAX_TARGET_BYTES = 1_000_000;
const SEMGREP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

const RULE_PACKS = ["p/default", "p/security-audit", "p/secrets"];

// Semgrep asks semgrep.dev for the latest version on every run unless told
// not to; the rule packs are the only network use allowed. Both the variable
// and --disable-version-check are checked against semgrep 1.94.0.
const SEMGREP_ENV = { SEMGREP_ENABLE_VERSION_CHECK: "0" };

export const SEMGREP_OFFLINE_REASON = "offline, the rule packs need the network";

// Known before any tool is resolved, so an offline run never installs or
// starts semgrep (it would fetch the registry rule packs).
function offlineReason(): string | null {
  return isOffline() ? SEMGREP_OFFLINE_REASON : null;
}

export type SemgrepRunArgs = {
  repoDir: string;
  // Paths (relative to repoDir) to lint. We pass them as positional
  // args so semgrep only scans changed files, not the whole repo.
  changedPaths: string[];
  tool: ResolvedTool | null;
  scratch: Scratch;
};

export async function runSemgrep(args: SemgrepRunArgs): Promise<AdapterResult> {
  // Drop flag-shaped paths (argv smuggling via a file named, say,
  // "--config=https://attacker/rules.yaml", which would make semgrep load
  // remote rules); the "--" terminator below is defense in depth.
  const targets = safeFileArgs(args.changedPaths);
  if (targets.length === 0) return { findings: [], error: null };
  const skipped = offlineReason();
  if (skipped) return { findings: [], error: null, skipped };
  if (!args.tool) return { findings: [], error: "not installed" };

  const cliArgs = (files: string[]): string[] => [
    "scan",
    ...RULE_PACKS.flatMap((p) => ["--config", p]),
    "--json",
    "--quiet",
    "--metrics",
    "off",
    "--disable-version-check",
    "--no-git-ignore",
    "--timeout",
    String(SEMGREP_PER_RULE_TIMEOUT_SEC),
    "--max-target-bytes",
    String(SEMGREP_MAX_TARGET_BYTES),
    "--",
    ...files,
  ];

  // Semgrep writes each rule pack to its temp folder as semgrep-*.rules and
  // never removes them, about 2.7 MB a scan. It gets a folder of its own,
  // which mkdtemp makes readable by this user only, removed after the scan
  // whatever the exit.
  let tmp: string;
  try {
    tmp = await fs.mkdtemp(path.join(args.scratch.temp, "openqodex-semgrep-"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `mkdtemp: ${message.slice(0, 200)}` };
  }

  // One process per chunk of files, so a whole-repo file list stays under
  // the argument limit; the findings of every chunk are merged.
  const tool = args.tool;
  try {
    const findings = await runInChunks("semgrep", targets, SEMGREP_TIMEOUT_MS, async (chunk, left) => {
      const stdout = await execSemgrep(tool, cliArgs(chunk), args.repoDir, left, tmp);
      try {
        return parseSemgrepJson(stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`parse: ${message.slice(0, 200)}`);
      }
    });
    return { findings, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function execSemgrep(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number, tmp: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    // Semgrep prints findings as a single JSON blob on stdout; on
    // a large change with many matches the buffer must accommodate it.
    maxBytes: SEMGREP_OUTPUT_MAX_BYTES,
    env: { ...tool.env, ...SEMGREP_ENV, TMPDIR: tmp },
  });
  const failed = describeFailure("semgrep", result, SEMGREP_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  // Semgrep exit codes: 0 = clean, 1 = findings present, 2 =
  // error. We want stdout for both 0 and 1; only treat 2+ as a
  // real failure.
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new Error(`semgrep exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const semgrep: Adapter = {
  source: "semgrep",
  files: (changedPaths) => safeFileArgs(changedPaths),
  why: () => "any file",
  skip: offlineReason,
  run: (args) => runSemgrep(args),
};

type SemgrepResult = {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown };
  end?: { line?: unknown };
  extra?: {
    severity?: unknown;
    message?: unknown;
    metadata?: { references?: unknown };
  };
};

export function parseSemgrepJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.results as SemgrepResult[]) {
    if (!raw || typeof raw !== "object") continue;
    const ruleId = typeof raw.check_id === "string" ? raw.check_id : "";
    const filePath = typeof raw.path === "string" ? raw.path : "";
    const lineStart = numberOrZero(raw.start?.line);
    const lineEnd = Math.max(lineStart, numberOrZero(raw.end?.line) || lineStart);
    const message = typeof raw.extra?.message === "string" ? raw.extra.message : "";
    if (!ruleId || !filePath || lineStart <= 0) continue;
    out.push({
      source: "semgrep",
      ruleId,
      filePath,
      lineStart,
      lineEnd,
      severity: normalizeSemgrepSeverity(raw.extra?.severity),
      message: trimMessage(message),
      reference: firstReference(raw.extra?.metadata?.references),
    });
  }
  return out;
}

function normalizeSemgrepSeverity(raw: unknown) {
  if (typeof raw !== "string") return "medium" as const;
  const v = raw.toUpperCase();
  if (v === "ERROR") return "high" as const;
  if (v === "WARNING") return "medium" as const;
  if (v === "INFO") return "info" as const;
  return "medium" as const;
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  // One paragraph, single line. Strip newlines and cap.
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}

function firstReference(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const first = v[0];
  return typeof first === "string" ? first : null;
}
