// SQLFluff adapter (SQL lint). Runs
// `sqlfluff lint --format json --templater raw --library-path none
// --rules <list> -- <files>` on a copy of the changed .sql files and of the
// settings files SQLFluff reads for them, and turns each violation of the
// listed rules into a StaticFinding.
//
// The rules: only those that name a query that is wrong or dead, never a
// style rule. A comparison with NULL by `=` (CV05), a set query whose sides
// return different numbers of columns (AM07), a join with no condition
// (AM08), a reference to a table that is not in FROM (RF01), a table alias
// used twice (AL04), a column alias used twice (AL08), a CTE never used
// (ST03), an outer-joined table never used (ST11). SQLFluff's default runs
// every rule; on hand-written SQL its layout, capitalisation and quoting
// rules fire on almost every line. AM09 (LIMIT without ORDER BY) is left
// out: it fires on every `LIMIT 1` lookup by a unique key. The Postgres
// lock rules (PG01, PG02) are left to squawk.
//
// What it may read and do, checked against the source and the binary:
// - Never the repo's code. A repo's settings can name the jinja, python or
//   dbt templater and a jinja `library_path`, whose Python files SQLFluff
//   imports (a planted library ran and wrote its marker with SQLFluff's
//   defaults). `--templater raw` and `--library-path none` override every
//   settings file, so nothing is imported.
// - The settings: SQLFluff's own search, from each file's folder and the
//   folders above it: `.sqlfluff` and the [sqlfluff] sections of
//   `setup.cfg`, `tox.ini`, `pep8.ini` and `pyproject.toml`, and
//   `.sqlfluffignore`. They choose the dialect, the rules left out, and
//   which rules only warn. The rules that run are this list whatever they
//   say. SQLFluff searches from the common ancestor of the file and its
//   HOME down to the file (core/config/loader.py, load_config_up_to_path),
//   which is above the repository, so a settings file there would count.
//   So it runs on a staging copy (iac.ts, withStage) of the changed .sql
//   files and of those settings files in each folder from the repository
//   root down to each one, regular files reached through no link only, with
//   HOME beside the copy: the search never leaves it.
// - The dialect: the one the settings name, else postgres. HOME is a folder
//   of OpenQodex's own whose `.sqlfluff` names postgres, the lowest layer,
//   so any dialect a settings file names wins; your user settings folder is
//   not read.
// - A statement it cannot parse in that dialect gives PRS, and an unknown
//   character LXR; neither names a problem in the code, so they are
//   dropped, as is any rule not in the list.
// - It writes nothing: `lint` never fixes, and no code is imported, so no
//   bytecode lands in the repo.
// - Exit codes: 0 no violation, 1 violations (JSON on stdout) or a crash
//   (nothing on stdout), 2 a usage or settings error.
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
import { withStage } from "./iac.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { suchAs } from "./words.js";

const SQLFLUFF_TIMEOUT_MS = 120_000;
const SQLFLUFF_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

export const SQLFLUFF_RULES = ["AL04", "AL08", "AM07", "AM08", "CV05", "RF01", "ST03", "ST11"] as const;
const LISTED = new Set<string>(SQLFLUFF_RULES);
// The rules whose finding means the query returns a wrong result or fails.
const WRONG_RESULT = new Set(["AL04", "AM07", "AM08", "CV05", "RF01"]);

// The dialect when no settings file names one, as the lowest settings layer.
const DEFAULT_SETTINGS = "[sqlfluff]\ndialect = postgres\n";

// The files SQLFluff reads its settings and ignore list from, in each folder
// (core/config/loader.py, load_config_at_path; core/linter/discovery.py).
const SETTINGS_NAMES = [".sqlfluff", ".sqlfluffignore", "setup.cfg", "tox.ini", "pep8.ini", "pyproject.toml"];

// The changed .sql files and the settings files of every folder from the
// repository root down to each one's own: what the staging copy holds.
export function sqlfluffStageFiles(files: readonly string[]): string[] {
  const out = new Set<string>(files);
  for (const file of files) {
    const parts = path.posix.dirname(file) === "." ? [] : path.posix.dirname(file).split("/");
    for (let depth = 0; depth <= parts.length; depth++) {
      const folder = parts.slice(0, depth).join("/");
      for (const name of SETTINGS_NAMES) out.add(folder === "" ? name : `${folder}/${name}`);
    }
  }
  return [...out].sort();
}

function isSqlPath(p: string): boolean {
  return p.toLowerCase().endsWith(".sql");
}

const sqlFiles = (changedPaths: string[]): string[] => safeFileArgs(changedPaths.filter(isSqlPath));

export async function runSqlfluff(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const files = sqlFiles(args.changedPaths);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const tool = args.tool;
  const cliArgs = (chunk: string[]): string[] => [
    "lint",
    "--format",
    "json",
    "--nocolor",
    "--disable-progress-bar",
    "--templater",
    "raw",
    "--library-path",
    "none",
    "--rules",
    SQLFLUFF_RULES.join(","),
    "--",
    ...chunk,
  ];
  return withStage(args.scratch.temp, args.repoDir, [], sqlfluffStageFiles(files), async (stage) => {
    await fs.writeFile(path.join(stage.home, ".sqlfluff"), DEFAULT_SETTINGS);
    const staged = new Set(stage.files);
    const present = files.filter((f) => staged.has(f));
    // One process per chunk of files, so a whole-repo file list stays under
    // the argument limit; the findings of every chunk are merged.
    try {
      const findings = await runInChunks("sqlfluff", present, SQLFLUFF_TIMEOUT_MS, async (chunk, left) => {
        const stdout = await execSqlfluff(tool, cliArgs(chunk), stage.tree, left, stage.home);
        try {
          return parseSqlfluffJson(stdout);
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
  });
}

async function execSqlfluff(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number, home: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: SQLFLUFF_OUTPUT_MAX_BYTES,
    env: { ...tool.env, HOME: home },
  });
  const failed = describeFailure("sqlfluff", result, SQLFLUFF_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  const printed = result.stdout.trim().startsWith("[");
  if ((result.exitCode === 0 || result.exitCode === 1) && printed) return result.stdout;
  // Every file was left out by a .sqlfluffignore: nothing to check.
  if (result.exitCode === 0 && result.stdout.trim() === "") return "";
  throw new Error(`sqlfluff exit ${result.exitCode}: ${stderrTail(result)}`);
}

export const sqlfluff: Adapter = {
  source: "sqlfluff",
  files: sqlFiles,
  why: (files) => `SQL files, ${suchAs(files)}`,
  run: (args) => runSqlfluff(args),
};

type SqlfluffViolation = {
  start_line_no?: unknown;
  end_line_no?: unknown;
  code?: unknown;
  description?: unknown;
  name?: unknown;
  warning?: unknown;
};
type SqlfluffFile = { filepath?: unknown; violations?: unknown };

export function parseSqlfluffJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const file of parsed as SqlfluffFile[]) {
    if (!file || typeof file !== "object" || typeof file.filepath !== "string" || !file.filepath) continue;
    if (!Array.isArray(file.violations)) continue;
    for (const raw of file.violations as SqlfluffViolation[]) {
      if (!raw || typeof raw !== "object") continue;
      const code = typeof raw.code === "string" ? raw.code : "";
      if (!LISTED.has(code) || !isLine(raw.start_line_no)) continue;
      const lineStart = raw.start_line_no;
      const lineEnd = isLine(raw.end_line_no) ? Math.max(lineStart, raw.end_line_no) : lineStart;
      const name = typeof raw.name === "string" ? raw.name : "";
      const description = typeof raw.description === "string" ? raw.description : code;
      const category = /^[a-z]+(?=\.)/.exec(name)?.[0];
      out.push({
        source: "sqlfluff",
        ruleId: code,
        filePath: file.filepath,
        lineStart,
        lineEnd,
        severity: severityOf(code, raw.warning === true),
        message: trimMessage(name ? `${description} (${name})` : description),
        reference: category ? `https://docs.sqlfluff.com/en/stable/reference/rules/${category}.html#${code.toLowerCase()}` : null,
      });
    }
  }
  return out;
}

// SQLFluff's lines count from 1.
function isLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

// SQLFluff has no severity. A rule the repo's settings list under `warnings`
// is info; a wrong result is medium; dead code is low.
function severityOf(code: string, warning: boolean): StaticFindingSeverity {
  if (warning) return "info";
  return WRONG_RESULT.has(code) ? "medium" : "low";
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
