// Ruff adapter (Python lint). Runs
// `ruff check --output-format json --no-fix --no-fix-only --no-cache <files>` against
// the changed Python files in the working tree and normalizes the vendor
// JSON into StaticFinding[]. Fast, near-zero config, and covers the Python
// rule space the rest of the ensemble misses: bugbear gotchas (mutable
// default args, broad except), unused imports / names, comprehension
// and f-string mistakes, and the security-flavoured S-rules
// (flake8-bandit) for shell=True, hardcoded passwords, and unsafe
// deserialization.
//
// For a file in a Django, FastAPI or Airflow project (detect.ts reads the
// project's pyproject.toml, requirements files or Pipfile), ruff's own DJ,
// FAST or AIR rules are added with --extend-select, on top of the repo's
// own selection. Measured with ruff 0.17.3: a selection on the command line
// comes after the repo's config, so its `ignore` does not take these
// families off again; `# noqa`, per-file-ignores and review.disabled_rules
// do.
//
// We invoke it only on changed .py / .pyi files so a change without
// Python is a no-op. Ruff emits a JSON array (one object per diagnostic)
// with a location row we anchor on; it has no severity field of its own,
// so we map by rule-code prefix (security rules high, the rest low/info).
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { RepoFacts } from "../detect.js";
import type { Adapter } from "./index.js";
import { groupBy } from "./group.js";
import { folderList, listAnd, suchAs } from "./words.js";

const RUFF_TIMEOUT_MS = 60_000;
const RUFF_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

function isPythonPath(p: string): boolean {
  return /\.pyi?$/i.test(p);
}

const pythonFiles = (changedPaths: string[]): string[] => safeFileArgs(changedPaths.filter(isPythonPath));

const FAMILIES = [
  ["django", "DJ", "Django"],
  ["fastapi", "FAST", "FastAPI"],
  ["airflow", "AIR", "Airflow"],
] as const;

// The rule families ruff adds for a file, from its project's frameworks.
export function ruffFamilies(p: string, facts: RepoFacts): string[] {
  const frameworks = facts.project(p)?.frameworks ?? [];
  return FAMILIES.filter(([framework]) => frameworks.includes(framework)).map(([, family]) => family);
}

// Files grouped by the families they get ("DJ,FAST"; "" for none): one ruff
// run per group.
export function ruffGroups(files: string[], facts: RepoFacts): Map<string, string[]> {
  return groupBy(files, (p) => ruffFamilies(p, facts).join(","));
}

function familyProjects(files: string[], facts: RepoFacts): string[] {
  return [...new Set(files.filter((p) => ruffFamilies(p, facts).length > 0).map((p) => facts.project(p)!.root))].sort();
}

function ruffWhy(files: string[], facts: RepoFacts): string {
  const projects = familyProjects(files, facts);
  const base = `Python files, ${suchAs(files)}`;
  if (projects.length === 0) return base;
  const families = new Set(files.flatMap((p) => ruffFamilies(p, facts)));
  const names = FAMILIES.filter(([, family]) => families.has(family)).map(([, , name]) => name);
  return `${base}; ${listAnd(names)} rules in ${folderList(projects)}`;
}

export async function runRuff(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
}): Promise<AdapterResult> {
  const pyFiles = pythonFiles(args.changedPaths);
  if (pyFiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  // --no-fix and --no-fix-only: report only, never rewrite the working
  // tree (a repo config with `fix-only = true` applies fixes even under
  // --no-fix; checked against ruff 0.17.3). --no-cache:
  // ruff otherwise writes .ruff_cache into the project. --output-format
  // json: the stable machine shape. We let Ruff honor the repo's own
  // pyproject/ruff.toml when present (near-zero config), but pass the
  // changed files positionally so it lints only those.
  const cliArgs = (files: string[], families: string): string[] => [
    "check",
    "--output-format",
    "json",
    "--no-fix",
    "--no-fix-only",
    "--no-cache",
    "--quiet",
    ...(families === "" ? [] : ["--extend-select", families]),
    "--",
    ...files,
  ];

  // Files grouped by the families they get: one process per group, and per
  // chunk of a group, so a whole-repo file list stays under the argument
  // limit; the findings of every run are merged.
  const groups = ruffGroups(pyFiles, args.facts);
  const tool = args.tool;
  try {
    const findings: StaticFinding[] = [];
    for (const [families, files] of groups) {
      findings.push(
        ...(await runInChunks("ruff", files, RUFF_TIMEOUT_MS, async (chunk, left) => {
          const stdout = await execRuff(tool, cliArgs(chunk, families), args.repoDir, left);
          try {
            return parseRuffJson(stdout);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`parse: ${message.slice(0, 200)}`);
          }
        })),
      );
    }
    return { findings, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

async function execRuff(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: RUFF_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // Ruff exit codes: 0 = no violations, 1 = violations found, 2 =
  // error (bad config / args). We want stdout for both 0 and 1.
  const failed = describeFailure("ruff", result, RUFF_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new Error(`ruff exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const ruff: Adapter = {
  source: "ruff",
  files: pythonFiles,
  why: ruffWhy,
  projects: familyProjects,
  run: (args) => runRuff(args),
};

type RuffEntry = {
  code?: unknown;
  message?: unknown;
  filename?: unknown;
  location?: { row?: unknown; column?: unknown };
  end_location?: { row?: unknown; column?: unknown };
  url?: unknown;
};

export function parseRuffJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed as RuffEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.filename === "string" ? raw.filename : "";
    const lineStart = numberOrZero(raw.location?.row);
    const lineEnd = Math.max(lineStart, numberOrZero(raw.end_location?.row) || lineStart);
    // Some diagnostics (e.g. a syntax error) report a null code (ruff 0.8) or
    // the code "invalid-syntax" (ruff 0.17). Both get the rule id "ruff".
    const code = typeof raw.code === "string" && raw.code && raw.code !== "invalid-syntax" ? raw.code : "ruff";
    const message = typeof raw.message === "string" ? raw.message : "";
    if (!filePath || lineStart <= 0) continue;
    out.push({
      source: "ruff",
      ruleId: code,
      filePath,
      lineStart,
      lineEnd,
      severity: severityForCode(code),
      message: trimMessage(message),
      reference: typeof raw.url === "string" ? raw.url : null,
    });
  }
  return out;
}

// Ruff has no severity field. Map by rule-code family: the flake8-bandit
// security rules (S-prefix) are the high-value ones for a security
// review; common-bug rules (bugbear B, pyflakes F) are low; pure style
// (E/W pycodestyle, naming, import order) is info noise we keep
// low-priority so the cap sheds it first.
function severityForCode(code: string): StaticFindingSeverity {
  if (/^S\d/.test(code)) return "high";
  if (/^(B\d|F\d|PL[EW])/.test(code)) return "low";
  return "info";
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
