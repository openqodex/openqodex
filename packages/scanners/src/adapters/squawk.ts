// squawk adapter (Postgres migration safety). Runs
// `squawk --reporter json -c <settings> -- <files>` from the repository root
// on the changed .sql files, and turns each violation into a StaticFinding.
// It finds what makes a migration lock or rewrite a busy table: an index
// built without CONCURRENTLY, a constraint or foreign key added without NOT
// VALID, a NOT NULL column with no default, a column type change, a dropped
// or renamed column, and missing lock and statement timeouts.
//
// What it may read and do, checked against the source and the binary:
// - Its settings: the repo's `.squawk.toml` at the repository root, passed
//   with -c, or an empty one of OpenQodex's own. Left to itself, squawk looks
//   for `.squawk.toml` from its working folder up to the filesystem root,
//   above the repository too (crates/squawk/src/config.rs). The file holds
//   rule settings only: rules left out or added, paths left out, the
//   Postgres version and whether a transaction wraps each file. Unknown
//   keys are ignored. It cannot make squawk run code or write a file.
// - Each path is a glob pattern to squawk (crates/squawk/src/
//   file_finding.rs): `[1]x.sql` would match `1x.sql`. Every glob character
//   is escaped, so each name matches only itself.
// - It reads SQL from stdin only when no path is given or matched; a path
//   that matches nothing (a deleted file, or one the settings leave out)
//   stops it first with "Failed to find files", which here means nothing to
//   check.
// - It writes nothing. `upload-to-github`, its only command that sends
//   anything, is never run.
// - Exit codes: 0 no violation, 1 violations (JSON on stdout) or an error.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import fs from "node:fs/promises";
import path from "node:path";
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";
import { withOwnedConfig } from "./owned-config.js";
import type { Scratch } from "../scratch.js";
import { repoFileOrReason } from "./read.js";
import { suchAs } from "./words.js";

const SQUAWK_TIMEOUT_MS = 60_000;
const SQUAWK_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const SQUAWK_CONFIG_MAX_BYTES = 1024 * 1024;

// The settings file squawk reads, at the repository root.
export const SQUAWK_CONFIG = ".squawk.toml";

function isSqlPath(p: string): boolean {
  return p.toLowerCase().endsWith(".sql");
}

const sqlFiles = (changedPaths: string[]): string[] => safeFileArgs(changedPaths.filter(isSqlPath));

// A path as a glob pattern that matches only itself: each `[`, `]`, `*` and
// `?` inside brackets, as the glob crate squawk uses escapes them.
export function globLiteral(p: string): string {
  return p.replace(/[[\]*?]/g, (c) => `[${c}]`);
}

// The repo's .squawk.toml when it is a regular file inside the repository,
// or null: then squawk gets an empty settings file of OpenQodex's own.
async function repoConfig(repoDir: string): Promise<string | null> {
  try {
    await fs.lstat(path.join(repoDir, SQUAWK_CONFIG));
  } catch {
    return null;
  }
  try {
    const checked = await repoFileOrReason(repoDir, SQUAWK_CONFIG, SQUAWK_CONFIG_MAX_BYTES);
    return "reason" in checked ? null : checked.path;
  } catch {
    return null;
  }
}

export async function runSquawk(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const files = sqlFiles(args.changedPaths);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const tool = args.tool;
  const run = async (config: string): Promise<AdapterResult> => {
    // One process per chunk of files, so a whole-repo file list stays under
    // the argument limit; the findings of every chunk are merged.
    const cliArgs = (chunk: string[]): string[] => ["--reporter", "json", "-c", config, "--", ...chunk.map(globLiteral)];
    try {
      const findings = await runInChunks("squawk", files, SQUAWK_TIMEOUT_MS, async (chunk, left) => {
        const stdout = await execSquawk(tool, cliArgs(chunk), args.repoDir, left);
        try {
          return parseSquawkJson(stdout);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`parse: ${message.slice(0, 200)}`);
        }
      });
      return { findings, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { findings: [], error: message.slice(0, 300) };
    }
  };
  const own = await repoConfig(args.repoDir);
  return own !== null ? run(own) : withOwnedConfig(args.scratch.temp, SQUAWK_CONFIG, "", (config) => run(config));
}

async function execSquawk(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: SQUAWK_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  const failed = describeFailure("squawk", result, SQUAWK_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode === 0) return result.stdout;
  if (result.exitCode === 1 && result.stdout.trim().startsWith("[")) return result.stdout;
  // No changed file is left to check: each is gone, or the settings leave it out.
  if (result.exitCode === 1 && result.stderr.startsWith("Failed to find files for provided patterns")) return "";
  throw new Error(`squawk exit ${result.exitCode}: ${stderrTail(result)}`);
}

export const squawk: Adapter = {
  source: "squawk",
  files: sqlFiles,
  why: (files) => `SQL files, ${suchAs(files)}`,
  run: (args) => runSquawk(args),
};

type SquawkViolation = {
  file?: unknown;
  line?: unknown;
  line_end?: unknown;
  message?: unknown;
  help?: unknown;
  rule_name?: unknown;
};

export function parseSquawkJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed as SquawkViolation[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.file === "string" ? raw.file : "";
    if (!filePath || !isLine(raw.line)) continue;
    const ruleId = typeof raw.rule_name === "string" && raw.rule_name ? raw.rule_name : "squawk";
    const lineStart = raw.line + 1;
    const lineEnd = isLine(raw.line_end) ? Math.max(lineStart, raw.line_end + 1) : lineStart;
    const message = typeof raw.message === "string" ? raw.message : "";
    const help = typeof raw.help === "string" ? raw.help : "";
    out.push({
      source: "squawk",
      ruleId,
      filePath,
      lineStart,
      lineEnd,
      severity: severityOf(ruleId),
      message: trimMessage(help ? `${message} ${help}` : message || ruleId),
      reference: /^[a-z-]+$/.test(ruleId) ? `https://squawkhq.com/docs/${ruleId}` : null,
    });
  }
  return out;
}

// squawk's lines count from 0.
function isLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// Rules that ask for a habit rather than name a lock, a rewrite or lost
// data. The two timeout rules fire once on almost every migration file, and
// the IF NOT EXISTS rule on most statements, so they rank low.
const PREFERENCES = new Set([
  "prefer-robust-stmts",
  "prefer-bigint-over-int",
  "prefer-bigint-over-smallint",
  "prefer-identity",
  "prefer-repack",
  "prefer-text-field",
  "prefer-timestamp-tz",
  "ban-char-field",
  "require-lock-timeout",
  "require-statement-timeout",
  "require-timeout-settings",
  "require-table-schema",
  "require-enum-value-ordering",
  // A parse error of squawk's own grammar, not always a mistake in the file.
  "syntax-error",
]);

function severityOf(ruleId: string): StaticFindingSeverity {
  if (ruleId === "unused-ignore") return "info";
  return PREFERENCES.has(ruleId) ? "low" : "medium";
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
