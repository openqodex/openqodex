// oxlint adapter (JS / TS lint). Runs `oxlint --format=json <files>`
// against the changed JavaScript / TypeScript files in the working tree
// and normalizes the vendor JSON `diagnostics[]` into StaticFinding[].
// oxlint is a single self-contained binary that needs no repo config
// and no installed node_modules: out of the box it runs its
// `correctness` rule set (ESLint-rule-compatible: no-cond-assign,
// no-unused-vars, no-debugger, no-constant-condition, the
// always-a-bug class). That makes it the right zero-setup linter for
// the ensemble where a repo's own ESLint may not be runnable. A repo's
// `.oxlintrc.json` is not loaded: it can load JavaScript plugins. For a
// file in a React, React Native or Next.js project (detect.ts reads the
// project's package.json) oxlint's own react, jsx-a11y and nextjs plugins
// are switched on: built into the binary, nothing more to download.
//
// We invoke it only on changed .js/.jsx/.ts/.tsx/.mjs/.cjs/.cts/.mts
// files so a change without them is a no-op. oxlint emits one JSON object
// with a diagnostics[] array; each diagnostic's location lives on the first
// label's span. Findings are anchored to changed lines downstream
// (filterToChangedLines). It writes nothing to disk.
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
import { withOwnedConfig } from "./owned-config.js";
import type { Scratch } from "../scratch.js";
import { groupBy } from "./group.js";
import { folderList, listAnd, suchAs } from "./words.js";

const OXLINT_TIMEOUT_MS = 60_000;
const OXLINT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

// Extensions oxlint lints: .js .jsx .ts .tsx .mjs .cjs .mts .cts.
function isJsTsPath(p: string): boolean {
  return /\.(jsx?|tsx?|[cm][jt]s)$/i.test(p);
}

const jsTsFiles = (changedPaths: string[]): string[] => safeFileArgs(changedPaths.filter(isJsTsPath));

// oxlint's built-in plugins switched on for a file, from its project's
// frameworks, on top of oxlint's default plugins.
export type OxlintPlugin = "react" | "jsx-a11y" | "nextjs";
const PLUGIN_NAMES: Record<OxlintPlugin, string> = { react: "React", "jsx-a11y": "accessibility", nextjs: "Next.js" };

export function oxlintPlugins(p: string, facts: RepoFacts): OxlintPlugin[] {
  const frameworks = facts.project(p)?.frameworks ?? [];
  const react = frameworks.includes("react") || frameworks.includes("react-native") || frameworks.includes("nextjs");
  return [...(react ? (["react", "jsx-a11y"] as const) : []), ...(frameworks.includes("nextjs") ? (["nextjs"] as const) : [])];
}

// The React rule a review pattern (lens) also looks for: with the react
// plugin on, oxlint checks it, so the lens stands down for those files.
export const OXLINT_EXHAUSTIVE_DEPS = "oxlint:react-hooks/exhaustive-deps";

// Files grouped by the plugins they get ("react,jsx-a11y"; "" for none): one
// oxlint run per group.
export function oxlintGroups(files: string[], facts: RepoFacts): Map<string, string[]> {
  return groupBy(files, (p) => oxlintPlugins(p, facts).join(","));
}

// The projects with plugins on, and the plugins, for the selection line.
function pluginProjects(files: string[], facts: RepoFacts): string[] {
  return [...new Set(files.filter((p) => oxlintPlugins(p, facts).length > 0).map((p) => facts.project(p)!.root))].sort();
}

function oxlintWhy(files: string[], facts: RepoFacts): string {
  const projects = pluginProjects(files, facts);
  const base = `JavaScript or TypeScript files, ${suchAs(files)}`;
  if (projects.length === 0) return base;
  const plugins = [...new Set(files.flatMap((p) => oxlintPlugins(p, facts)))];
  return `${base}; ${listAnd(plugins.map((x) => PLUGIN_NAMES[x]))} rules in ${folderList(projects)}`;
}

export async function runOxlint(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
  scratch: Scratch;
}): Promise<AdapterResult> {
  const jsFiles = jsTsFiles(args.changedPaths);
  if (jsFiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const tool = args.tool;
  try {
    // -c <owned> and --disable-nested-config: no repo config is loaded, at
    // the root or in any folder. A repo's .oxlintrc.json can name JavaScript
    // plugins (jsPlugins), which oxlint runs in Node: code from the change
    // running on the developer's machine. Reproduced with oxlint 1.71.0.
    // --format=json: the stable machine shape. Changed files are passed
    // positionally so it lints only those. --react-plugin and the others
    // add oxlint's own framework rules for the files of such a project.
    // One process per group of files with the same plugins, and per chunk
    // of a group, so a whole-repo file list stays under the argument limit;
    // the findings of every run are merged.
    return await withOwnedConfig(args.scratch.temp, "oxlintrc.json", "{}\n", async (configPath) => {
      const findings: StaticFinding[] = [];
      for (const [key, files] of oxlintGroups(jsFiles, args.facts)) {
        const flags = key === "" ? [] : key.split(",").map((plugin) => `--${plugin}-plugin`);
        findings.push(
          ...(await runInChunks("oxlint", files, OXLINT_TIMEOUT_MS, async (chunk, left) => {
            const cliArgs = ["-c", configPath, "--disable-nested-config", ...flags, "--format=json", "--", ...chunk];
            const stdout = await execOxlint(tool, cliArgs, args.repoDir, left);
            try {
              return parseOxlintJson(stdout);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(`parse: ${message.slice(0, 200)}`);
            }
          })),
        );
      }
      const react = jsFiles.filter((p) => oxlintPlugins(p, args.facts).includes("react"));
      return { findings, error: null, checked: react.length > 0 ? [{ token: OXLINT_EXHAUSTIVE_DEPS, files: react }] : [] };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

async function execOxlint(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: OXLINT_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // oxlint exit codes: 0 = no deny-level errors (warnings still
  // possible), 1 = lint errors / max-warnings exceeded, higher =
  // usage error. It writes the JSON object to stdout for both 0
  // and 1. Prefer stdout whenever present; only a missing binary
  // or an empty-output failure is fatal.
  const failed = describeFailure("oxlint", result, OXLINT_TIMEOUT_MS);
  if (result.failure === "not_found" && failed) throw new Error(failed);
  if (result.stdout.trim()) return result.stdout;
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`oxlint exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const oxlint: Adapter = {
  source: "oxlint",
  files: jsTsFiles,
  why: oxlintWhy,
  projects: pluginProjects,
  run: (args) => runOxlint(args),
};

type OxlintLabel = {
  span?: { line?: unknown };
};

type OxlintDiagnostic = {
  message?: unknown;
  code?: unknown;
  severity?: unknown;
  url?: unknown;
  filename?: unknown;
  labels?: unknown;
};

export function parseOxlintJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { diagnostics?: unknown };
  if (!parsed || !Array.isArray(parsed.diagnostics)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.diagnostics as OxlintDiagnostic[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.filename === "string" ? raw.filename : "";
    const line = firstLabelLine(raw.labels);
    if (!filePath || line <= 0) continue;
    // oxlint codes look like "eslint(no-debugger)"; normalize to
    // "eslint/no-debugger" so the citation token reads
    // "oxlint:eslint/no-debugger".
    const code = typeof raw.code === "string" && raw.code ? raw.code : "oxlint";
    const ruleId = normalizeCode(code);
    const message = typeof raw.message === "string" ? raw.message : "";
    out.push({
      source: "oxlint",
      ruleId,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: severityForRule(ruleId),
      message: buildMessage(ruleId, message),
      reference: typeof raw.url === "string" && raw.url ? raw.url : null,
    });
  }
  return out;
}

// oxlint puts the diagnostic location on the first label's span; take
// the first label that carries a usable line.
function firstLabelLine(labels: unknown): number {
  if (!Array.isArray(labels)) return 0;
  for (const l of labels as OxlintLabel[]) {
    if (l && typeof l === "object") {
      const line = numberOrZero(l.span?.line);
      if (line > 0) return line;
    }
  }
  return 0;
}

function normalizeCode(code: string): string {
  const m = /^([^()]+)\(([^()]+)\)$/.exec(code.trim());
  return m ? `${m[1]}/${m[2]}` : code;
}

// oxlint's JSON omits the rule's category, so derive it from the rule
// id. oxlint runs only its `correctness` (bug) category by default, so
// the common case is a real-bug finding; a repo that opts extra
// categories in via .oxlintrc.json can surface security or style rules,
// which we rank up / down accordingly.
function categoryForRule(ruleId: string): "security" | "style" | "bug" {
  const id = ruleId.toLowerCase();
  if (id.startsWith("security/") || /\b(eval|injection|xss|csrf|unsafe|dangerously|crypto)\b/.test(id)) {
    return "security";
  }
  if (/^(prettier|stylistic)\//.test(id) || /(indent|spacing|quotes|semicolon|padding|newline)/.test(id)) {
    return "style";
  }
  return "bug";
}

// security is the high-value class; correctness/bug rules are the
// medium bug class (rubocop's Lint cops sit here too); style /
// formatting is info noise the cap sheds first.
function severityForRule(ruleId: string): StaticFindingSeverity {
  switch (categoryForRule(ruleId)) {
    case "security":
      return "high";
    case "style":
      return "info";
    default:
      return "medium";
  }
}

function buildMessage(ruleId: string, message: string): string {
  const full = message ? `${ruleId}: ${message}` : ruleId;
  return trimMessage(full);
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
