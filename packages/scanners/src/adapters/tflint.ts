// TFLint adapter (Terraform language checks). Runs `tflint --recursive` on a
// staging copy of the folder of each changed Terraform file (iac.ts), with
// OpenQodex's own config: the terraform ruleset built into the binary, with
// its recommended preset (the rules about mistakes: unused declarations,
// deprecated syntax, unpinned modules, missing version constraints; not the
// naming and documentation rules of the "all" preset), and no other plugin.
//
// No plugin is downloaded or started: `tflint --init` never runs, the config
// names no plugin but the bundled one, and its plugin_dir is an empty folder
// of the run's own, so neither a `.tflint.d/plugins` folder in the repository
// nor one in the developer's home can stand in for the bundled ruleset
// (plugin/discovery.go at v0.64.0 looks there before falling back to it).
// The repository's `.tflint.hcl` is never read: --config names ours, and the
// staging copy holds no other. Module calls are off (call_module_type
// "none"): the terraform ruleset checks each module as written, and no
// module is read from anywhere. TFLint gets no PATH and a home of its own;
// it starts only itself.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterResult, ResolvedTool, ScannerSeverity, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool } from "../exec.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { folderOf, isTerraformPath, stagedPath, withStage } from "./iac.js";
import { suchAs } from "./words.js";

const TFLINT_TIMEOUT_MS = 120_000;
const TFLINT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

const tflintFiles = (changedPaths: string[]): string[] => changedPaths.filter(isTerraformPath);

// OpenQodex's TFLint config, with its empty plugin folder.
//
// TFLint evaluates the repository's expressions, and an expression can read
// any file the user can read: file(), fileexists(), templatefile() and
// fileset() take an absolute path. terraform_map_duplicate_keys is the one
// rule of the recommended preset whose message prints an evaluated value
// (the duplicate key), so a key written as file("<path>") would put that
// file into the report: it is off. Every other recommended rule of ruleset
// 0.15.0 prints names, literals of the configuration or fixed text (read in
// its rules/*.go); a ruleset bump re-reads them for a new rule that prints an
// evaluated value. An evaluation error is reported by TFLint's fixed summary
// only (parseTflintJson), since its detail can name a path and say whether a
// file exists there.
export function tflintConfig(pluginDir: string): string {
  return [
    "config {",
    '  call_module_type = "none"',
    `  plugin_dir       = ${JSON.stringify(pluginDir)}`,
    "}",
    "",
    'plugin "terraform" {',
    "  enabled = true",
    '  preset  = "recommended"',
    "}",
    "",
    'rule "terraform_map_duplicate_keys" {',
    "  enabled = false",
    "}",
    "",
  ].join("\n");
}

// TFLint talks to its bundled ruleset over a Unix socket in TMPDIR, and a
// socket path longer than about 100 bytes cannot be bound (macOS allows 104):
// the ruleset then fails to start. The folder must be absolute: TFLint runs
// each folder of a recursive run from inside it, so a relative one moves.
// The run's temporary folder when it is short. Else, on the laptop, /tmp;
// a server run writes nowhere outside its scratch root, so it gets null and
// TFLint is not started.
const SOCKET_DIR_MAX = 64;
function socketDir(scratch: Scratch): string | null {
  if (scratch.temp.length <= SOCKET_DIR_MAX) return scratch.temp;
  return scratch.laptop ? "/tmp" : null;
}

export async function runTflint(args: { repoDir: string; changedPaths: string[]; tool: ResolvedTool | null; scratch: Scratch }): Promise<AdapterResult> {
  const files = tflintFiles(args.changedPaths);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;
  const folders = [...new Set(files.map(folderOf))].sort();
  const socket = socketDir(args.scratch);
  if (socket === null) {
    return { findings: [], error: `the run's temporary folder is ${args.scratch.temp.length} characters long, and TFLint's plugin socket needs one of ${SOCKET_DIR_MAX} or fewer; give a shorter scratch root` };
  }

  try {
    return await withStage(args.scratch.temp, args.repoDir, folders, [], async (stage) => {
      const pluginDir = path.join(stage.root, "plugins");
      const configPath = path.join(stage.root, "tflint.hcl");
      await fs.mkdir(pluginDir);
      await fs.writeFile(configPath, tflintConfig(pluginDir));
      const cliArgs = ["--config", configPath, "--format", "json", "--no-color", "--call-module-type", "none", "--recursive", "--force"];
      const result = await execTool(tool.path, cliArgs, {
        cwd: stage.tree,
        timeoutMs: TFLINT_TIMEOUT_MS,
        maxBytes: TFLINT_OUTPUT_MAX_BYTES,
        env: { PATH: "", HOME: stage.home, TMPDIR: socket },
      });
      const failed = describeFailure("tflint", result, TFLINT_TIMEOUT_MS);
      if (failed) throw new Error(failed);
      // --force: issues found still exit 0; 1 is an error, with or without a
      // report on stdout. Its stderr is not quoted: like an error's detail,
      // it can hold a value TFLint evaluated.
      if (!result.stdout.trim()) {
        if (result.exitCode !== 0) throw new Error(`tflint exit ${result.exitCode}, with no report`);
        return { findings: [], error: null };
      }
      try {
        const report = parseTflintJson(result.stdout);
        return { findings: report.findings, error: report.errors.length > 0 ? report.errors.join("; ").slice(0, 300) : null };
      } catch (err) {
        throw new Error(`parse: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

export const tflint: Adapter = {
  source: "tflint",
  files: (changedPaths) => tflintFiles(changedPaths),
  why: (files) => `Terraform files, ${suchAs(files)}`,
  run: (args) => runTflint(args),
};

type TflintIssue = {
  rule?: { name?: unknown; severity?: unknown; link?: unknown };
  message?: unknown;
  range?: { filename?: unknown; start?: { line?: unknown }; end?: { line?: unknown } };
};

type TflintError = { summary?: unknown; range?: { filename?: unknown } };

// The issues of a `tflint --format json` report on their lines, and its
// errors (a file it could not parse or evaluate), each as one line naming the
// file and TFLint's fixed summary, never the error's detail: an evaluation
// error's detail can name a path outside the repository and say whether a
// file exists there.
export function parseTflintJson(json: string): { findings: StaticFinding[]; errors: string[] } {
  const parsed = JSON.parse(json) as { issues?: unknown; errors?: unknown };
  const findings: StaticFinding[] = [];
  for (const issue of Array.isArray(parsed?.issues) ? (parsed.issues as TflintIssue[]) : []) {
    const rule = typeof issue?.rule?.name === "string" ? issue.rule.name : "";
    const file = typeof issue?.range?.filename === "string" ? issue.range.filename : "";
    const start = numberOrZero(issue?.range?.start?.line);
    if (!rule || !file || start <= 0) continue;
    findings.push({
      source: "tflint",
      ruleId: rule,
      filePath: stagedPath(file),
      lineStart: start,
      lineEnd: Math.max(start, numberOrZero(issue.range?.end?.line)),
      severity: severityOf(issue.rule?.severity),
      message: trimMessage(typeof issue.message === "string" && issue.message ? issue.message : rule),
      reference: typeof issue.rule?.link === "string" && issue.rule.link.startsWith("https://") ? issue.rule.link : null,
    });
  }
  const errors: string[] = [];
  for (const e of Array.isArray(parsed?.errors) ? (parsed.errors as TflintError[]) : []) {
    const where = typeof e?.range?.filename === "string" ? `${stagedPath(e.range.filename)}: ` : "";
    const text = typeof e?.summary === "string" && e.summary ? e.summary : "TFLint error";
    errors.push(`${where}${text}`.replace(/\s+/g, " ").trim());
  }
  return { findings, errors };
}

// TFLint's own levels: error is a mistake Terraform itself rejects or a rule
// set to error; warning and notice are the ruleset's advice.
function severityOf(raw: unknown): ScannerSeverity {
  switch (raw) {
    case "error":
      return "high";
    case "warning":
      return "low";
    default:
      return "info";
  }
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
