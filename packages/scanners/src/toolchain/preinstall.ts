// Strict preinstall, for a server image: every scanner the server needs,
// installed into an install root the caller names, at its pinned version,
// with the runtime it needs, and each one proved to run by its check case
// (check-cases.ts) through the same adapter a review uses. The server then
// reads that root with installs off (createToolResolver with allowInstall:
// false) and never installs at review time.
//
// Nothing is installed anywhere but the install root: the installers'
// download caches live in a temporary folder removed at the end, and each
// check case runs in a temporary repository with its own scratch root
// (scratch.ts), also removed.
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseConfig } from "@openqodex/core";
import type { BuiltinScanner, ScannerSource } from "@openqodex/core";
import { ADAPTERS, IN_PROCESS } from "../adapters/index.js";
import { runScanners } from "../run.js";
import { checkCase, type CheckCase } from "./check-cases.js";
import { createToolResolver } from "./index.js";
import { installTool, isInstalled, missingRuntime, unsupportedReason } from "./install.js";
import { loadToolchain, markerPath, type InstallPlace, type Recipe } from "./table.js";

// `installRoot`: the folder the tools go into, one folder per tool.
// `require`: "all" for every built-in scanner, or the scanners the server
// will run. `onProgress`: one line per install and per check.
export type PreinstallOptions = {
  installRoot: string;
  require: "all" | ScannerSource[];
  onProgress?: (line: string) => void;
};

// One required scanner: its pinned version ("built in" for one that runs
// inside OpenQodex, null for a name that is no built-in scanner), whether it
// is ready, and one plain line: what its check case reported, or why it is
// missing.
export type PreinstallTool = { scanner: ScannerSource; version: string | null; ok: boolean; detail: string };

// `ok`: every required scanner is ready. `missing`: one line per scanner
// that is not, "<scanner>: <why>".
export type PreinstallResult = { ok: boolean; missing: string[]; tools: PreinstallTool[] };

const BUILTINS = ADAPTERS.map((a) => a.source);

function required(require: PreinstallOptions["require"]): ScannerSource[] {
  return require === "all" ? [...BUILTINS] : [...new Set(require)];
}

const isBuiltin = (s: ScannerSource): s is BuiltinScanner => (BUILTINS as ScannerSource[]).includes(s);

// Installs every required scanner into `installRoot`, then checks them all
// (checkScanners). A tool that fails to install is reported by the check
// with the install's reason; the others still install.
export async function preinstallScanners(opts: PreinstallOptions): Promise<PreinstallResult> {
  const root = resolve(opts.installRoot);
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
  } catch {
    throw new Error(`cannot write ${root}: a preinstall needs its install root writable`);
  }
  const table = loadToolchain();
  const cache = mkdtempSync(join(tmpdir(), "openqodex-preinstall-"));
  const place: InstallPlace = { root, cache, owner: root };
  const failures = new Map<ScannerSource, string>();
  try {
    await Promise.all(
      required(opts.require)
        .filter((s): s is BuiltinScanner => isBuiltin(s) && !IN_PROCESS.has(s) && table.tools[s] !== undefined)
        .map(async (scanner) => {
          if (isInstalled(root, scanner, table.tools[scanner]!)) return;
          opts.onProgress?.(`installing ${scanner} ${table.tools[scanner]!.version}`);
          try {
            await installTool(scanner, { table, place });
          } catch (error) {
            failures.set(scanner, error instanceof Error ? error.message : String(error));
          }
        }),
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  return checkScanners({ installRoot: root, require: opts.require, onProgress: opts.onProgress, installFailures: failures });
}

// Checks the required scanners in `installRoot` without installing any:
// each must be a built-in scanner, have its runtime, be installed at its
// pinned version, and report its check case's finding. `installFailures`:
// why an install just tried failed, named in place of "not installed".
export async function checkScanners(opts: {
  installRoot: string;
  require: PreinstallOptions["require"];
  onProgress?: (line: string) => void;
  installFailures?: Map<ScannerSource, string>;
}): Promise<PreinstallResult> {
  const root = resolve(opts.installRoot);
  const tools: PreinstallTool[] = [];
  // One at a time: a check case is a real scan, and several heavy scanners
  // at once could pass their timeouts on a small build machine.
  for (const scanner of required(opts.require)) tools.push(await checkOne(scanner, root, opts));
  const missing = tools.filter((t) => !t.ok).map((t) => `${t.scanner}: ${t.detail}`);
  return { ok: missing.length === 0, missing, tools };
}

async function checkOne(scanner: ScannerSource, root: string, opts: { onProgress?: (line: string) => void; installFailures?: Map<ScannerSource, string> }): Promise<PreinstallTool> {
  if (scanner.startsWith("custom:")) {
    return { scanner, version: null, ok: false, detail: "a custom scanner is never preinstalled: it runs only after `openqodex trust` approves it in its repository" };
  }
  if (!isBuiltin(scanner)) return { scanner, version: null, ok: false, detail: "not a built-in scanner" };
  if (IN_PROCESS.has(scanner)) return { scanner, version: "built in", ok: true, detail: "runs inside openqodex" };
  const table = loadToolchain();
  const recipe = table.tools[scanner];
  if (!recipe) return { scanner, version: null, ok: false, detail: "no install recipe; this build cannot run it" };
  const version = recipe.version;
  const runtime = await missingRuntime(recipe);
  if (runtime) return { scanner, version, ok: false, detail: runtime };
  if (!isInstalled(root, scanner, recipe)) {
    const why = opts.installFailures?.get(scanner) ?? unsupportedReason(table, recipe) ?? `not installed at ${version}`;
    return { scanner, version, ok: false, detail: why };
  }
  const marked = markedVersion(root, scanner, recipe);
  if (marked !== version) return { scanner, version, ok: false, detail: `installed as ${marked ?? "an unknown version"}, pinned ${version}` };
  opts.onProgress?.(`checking ${scanner} ${version} on its check case`);
  const outcome = await runCheckCase(checkCase(scanner)!, root);
  return { scanner, version, ...outcome };
}

// The version the install's marker names, or null when it names none.
function markedVersion(root: string, tool: string, recipe: Recipe): string | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath(root, tool, recipe), "utf8")) as { version?: unknown };
    return typeof marker.version === "string" ? marker.version : null;
  } catch {
    return null;
  }
}

// The case's files in a fresh repository, every line changed, scanned by its
// scanner alone with installs off and a scratch root of its own. The work
// folder sits under the install root with short names, not under the
// system's temporary folder: TFLint binds a Unix socket under the scratch
// root's TMPDIR, and that path has a bound of about 100 bytes (tflint.ts),
// which macOS's temporary folder alone takes half of.
async function runCheckCase(c: CheckCase, root: string): Promise<{ ok: boolean; detail: string }> {
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(join(root, ".c-"));
  try {
    const repo = join(work, "repo");
    const files = c.files();
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
    const paths = Object.keys(files);
    const coverage = new Map(paths.map((p) => [p, new Set(files[p]!.split("\n").map((_, i) => i + 1))]));
    const { scan } = await runScanners({
      repoDir: repo,
      changedPaths: paths,
      coverage,
      config: parseConfig("").config,
      resolveTool: createToolResolver({ allowInstall: false, installRoot: root }),
      only: [c.scanner],
      scratchRoot: join(work, "s"),
    });
    const summary = scan.scanners.find((s) => s.scanner === c.scanner);
    const ran = summary?.status === "ran";
    const found = c.rule === null || scan.candidates.some((x) => x.source === c.scanner && x.ruleId === c.rule && x.filePath === c.anchor);
    if (ran && found) return { ok: true, detail: c.rule === null ? "ran its check case" : `reported ${c.rule} on ${c.anchor}` };
    const state = summary === undefined ? "no result" : `${summary.status}${summary.reason ? `: ${summary.reason}` : ""}`;
    const others = ran ? `ran, ${scan.candidates.length} other finding${scan.candidates.length === 1 ? "" : "s"}` : state;
    return { ok: false, detail: c.rule === null ? `its check case did not run (${state})` : `its check case did not report ${c.rule} on ${c.anchor} (${others})` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
