// The toolchain: finds each pinned scanner in an install root, by default
// ~/.openqodex/tools/<tool>/<version>/, installing it there on first use when
// installs are on. A builtin scanner is never taken from PATH, so two
// machines report the same findings.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuiltinScanner, ResolveTool, ToolResolution, ToolStatus } from "@openqodex/core";
import { IN_PROCESS } from "../adapters/index.js";
import { InstallError } from "./fetch.js";
import {
  ensureWritable,
  isInstalled,
  isLocked,
  lastInstallError,
  missingRuntime,
  resolvedTool,
  runInstall,
  unsupportedReason,
} from "./install.js";
import { homePlace, loadToolchain, openqodexHome, toolsDir, type Recipe } from "./table.js";

export { downloadVerified, extractArchive, InstallError } from "./fetch.js";
export { installTool } from "./install.js";
export { loadToolchain, openqodexHome, toolchainHash, toolsDir } from "./table.js";
export type { Recipe, ReleaseAsset, Toolchain } from "./table.js";

// Every builtin scanner, checked against the type so a new one is not missed.
const builtins: Record<BuiltinScanner, true> = {
  semgrep: true,
  gitleaks: true,
  sqllint: true,
  "osv-scanner": true,
  actionlint: true,
  hadolint: true,
  shellcheck: true,
  ruff: true,
  brakeman: true,
  rubocop: true,
  bandit: true,
  oxlint: true,
  golangci: true,
  zizmor: true,
  trivy: true,
  squawk: true,
  "kube-linter": true,
  tflint: true,
  kubeconform: true,
  "cargo-deny": true,
  checkov: true,
  sqlfluff: true,
};
const ALL_SCANNERS = Object.keys(builtins) as BuiltinScanner[];

// ---------- the detached install process ----------

// The hidden CLI command that runs one install: `openqodex __install <tool>`.
export const INSTALL_WORKER_COMMAND = "__install";

// Set in the environment of every install process. A process that has it
// never starts another install process.
const WORKER_MARKER = "OPENQODEX_INSTALL_WORKER";

// The package.json in `dir`, or null when there is none.
function manifest(dir: string): { name?: unknown; bin?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; bin?: unknown };
  } catch {
    return null;
  }
}

// The bin of the openqodex package rooted at `dir`, or null.
function openqodexBin(dir: string): string | null {
  const pkg = manifest(dir);
  if (pkg?.name !== "openqodex") return null;
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.openqodex;
  return typeof bin === "string" ? join(dir, bin) : null;
}

// The program that answers `__install <tool>`: the openqodex CLI bin, found
// from where this code lies and never from the running script
// (process.argv[1]), which a caller could name. In the published package
// this code is bundled into that bin; in the workspace it is the scanners
// package, beside packages/cli. Null when neither holds.
function findWorkerEntry(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = manifest(dir);
    if (pkg !== null) return pkg.name === "@openqodex/scanners" ? openqodexBin(join(dir, "..", "cli")) : openqodexBin(dir);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

let workerEntryFound: string | null | undefined;
function workerEntry(): string | null {
  if (workerEntryFound === undefined) workerEntryFound = findWorkerEntry();
  return workerEntryFound;
}

// A path as the file system names it, so a link to the bin counts as the bin.
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The body of `openqodex __install <tool>`. It installs only when this
// process runs the openqodex bin: any other entry, such as a script that
// imports this package and calls it, gets one line and exit code 1, and
// nothing is installed. Returns 0 installed, 1 failed.
export async function runInstallWorker(tool: string): Promise<number> {
  const entry = process.argv[1];
  const bin = workerEntry();
  if (bin === null || entry === undefined || realPath(entry) !== realPath(bin)) {
    process.stderr.write(`openqodex: a scanner install runs only as \`openqodex ${INSTALL_WORKER_COMMAND} <tool>\`\n`);
    return 1;
  }
  // Whatever runs in this process from here on starts no install process.
  process.env[WORKER_MARKER] = "1";
  return runInstall(tool);
}

// The program this process starts as an install process, or why it starts none.
function workerProgram(): { entry: string } | { refusal: string } {
  if (process.env[WORKER_MARKER]) return { refusal: "an install process does not start another install" };
  const entry = workerEntry();
  if (entry === null) return { refusal: "the openqodex program that runs installs was not found: run `npx openqodex doctor --install`" };
  return { entry };
}

// The worker runs in another folder, so it gets the absolute home: a
// relative OPENQODEX_HOME would otherwise name a different place there. It
// installs into that home's tools folder.
function startWorker(entry: string, tool: string, home: string) {
  return spawn(process.execPath, [entry, INSTALL_WORKER_COMMAND, tool], {
    cwd: homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENQODEX_HOME: home, [WORKER_MARKER]: "1" },
  });
}

const STILL_INSTALLING: ToolResolution = {
  ok: false,
  status: "installing",
  reason: "first run only, still installing; it will be included next run",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const remaining = (deadline: number) => Math.max(0, deadline - Date.now());
const TIMED_OUT = Symbol("timed out");

// Waits for the promise for at most `ms`. The timer is cleared as soon as the
// race settles, so it never keeps the process alive after the work is done.
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function installedResolution(root: string, tool: string, recipe: Recipe): Promise<ToolResolution> {
  return { ok: true, tool: await resolvedTool(root, tool, recipe) };
}

function failedResolution(root: string, tool: string): ToolResolution {
  const failure = lastInstallError(root, tool);
  return failure ? { ok: false, ...failure } : { ok: false, status: "failed", reason: "install failed" };
}

// Starts the install in a detached process, so it keeps going if this process
// exits, and waits for it until `deadline` (null: no limit). The process
// installs into the tools folder of `home`.
function installDetached(entry: string, tool: string, recipe: Recipe, home: string, deadline: number | null): Promise<ToolResolution> {
  const root = toolsDir(home);
  return new Promise((done) => {
    let timer: NodeJS.Timeout | undefined;
    const child = startWorker(entry, tool, home);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, status: "failed", reason: `could not start the install: ${error.message}` });
    });
    child.once("exit", () => {
      clearTimeout(timer);
      done(isInstalled(root, tool, recipe) ? installedResolution(root, tool, recipe) : failedResolution(root, tool));
    });
    if (deadline !== null) {
      timer = setTimeout(() => {
        child.unref();
        done(STILL_INSTALLING);
      }, Math.max(0, deadline - Date.now()));
    }
  });
}

const NO_RECIPE = "no install recipe; this build cannot run it";

// `installRoot`: the folder the pinned tools are read from, one folder per
// tool; by default the OpenQodex home's tools folder. With `allowInstall`,
// a missing tool is installed there by the openqodex program in a detached
// process, which installs only into an OpenQodex home: the install root must
// then be that home's tools folder. A server fills its own install root with
// preinstallScanners and reads it with installs off. `installBudgetMs`: how
// long to wait for the runtime probes and an install; null or left out waits
// until they finish.
export type ResolverOptions = { allowInstall: boolean; installRoot?: string; installBudgetMs?: number | null; onProgress?: (line: string) => void };

type Resolver = { allowInstall: boolean; root: string; home: string; installBudgetMs: number | null; onProgress?: (line: string) => void };

async function resolveOne(scanner: BuiltinScanner, opts: Resolver): Promise<ToolResolution> {
  // The budget covers everything below, the runtime probes included.
  const deadline = opts.installBudgetMs === null ? null : Date.now() + opts.installBudgetMs;
  const table = loadToolchain();
  const recipe = table.tools[scanner];
  if (!recipe) return IN_PROCESS.has(scanner) ? { ok: false, status: "failed", reason: "runs inside openqodex, no tool to resolve" } : { ok: false, status: "not_installed", reason: NO_RECIPE };
  const root = opts.root;
  // The probe is shared and may finish in the background; this caller waits
  // for it only as long as its budget allows.
  const probe = missingRuntime(recipe);
  const runtime = deadline === null ? await probe : await withDeadline(probe, remaining(deadline));
  if (runtime === TIMED_OUT) return { ok: false, status: "not_installed", reason: "still checking for the runtime; it will be included next run" };
  if (runtime) return { ok: false, status: "not_installed", reason: runtime };
  if (isInstalled(root, scanner, recipe)) return installedResolution(root, scanner, recipe);
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) return { ok: false, status: "not_installed", reason: unsupported };
  if (!opts.allowInstall) return { ok: false, status: "not_installed", reason: "not installed (installs are off)" };
  try {
    ensureWritable(homePlace(opts.home), scanner);
  } catch (error) {
    if (error instanceof InstallError) return { ok: false, status: error.status, reason: error.message };
    throw error;
  }
  // Another process is installing it: wait on that one instead of starting another.
  if (isLocked(root, scanner)) {
    while (isLocked(root, scanner)) {
      if (deadline !== null && Date.now() >= deadline) return STILL_INSTALLING;
      await sleep(deadline === null ? 250 : Math.min(250, remaining(deadline)));
    }
    if (isInstalled(root, scanner, recipe)) return installedResolution(root, scanner, recipe);
    if (lastInstallError(root, scanner)) return failedResolution(root, scanner);
  }
  // Only starting an install needs a program to start; waiting on another
  // process's install above does not.
  const worker = workerProgram();
  if ("refusal" in worker) return { ok: false, status: "not_installed", reason: worker.refusal };
  opts.onProgress?.(`installing ${scanner} ${recipe.version} (first run only)`);
  return installDetached(worker.entry, scanner, recipe, opts.home, deadline);
}

// The same folder, however it is spelled (a link on the way, /var and
// /private/var on macOS).
function sameFolder(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function createToolResolver(opts: ResolverOptions): ResolveTool {
  const home = openqodexHome();
  const root = opts.installRoot === undefined ? toolsDir(home) : resolve(opts.installRoot);
  if (opts.allowInstall && !sameFolder(root, toolsDir(home))) {
    throw new Error(
      `installs on demand go only into the OpenQodex home's tools folder (${toolsDir(home)}), not ${root}: fill ${root} with preinstallScanners and read it with allowInstall: false`,
    );
  }
  const resolver: Resolver = { allowInstall: opts.allowInstall, root, home, installBudgetMs: opts.installBudgetMs ?? null, onProgress: opts.onProgress };
  const seen = new Map<BuiltinScanner, Promise<ToolResolution>>();
  return (scanner) => {
    let resolution = seen.get(scanner);
    if (!resolution) {
      resolution = resolveOne(scanner, resolver);
      seen.set(scanner, resolution);
    }
    return resolution;
  };
}

async function statusOf(scanner: BuiltinScanner): Promise<ToolStatus> {
  const table = loadToolchain();
  const recipe = table.tools[scanner];
  // "built in" only for a scanner that runs inside OpenQodex; any other
  // scanner without a recipe is one this build cannot run.
  if (!recipe) {
    return IN_PROCESS.has(scanner) ? { scanner, state: "ready", version: "built in", detail: "runs inside openqodex" } : { scanner, state: "unsupported", version: "none", detail: NO_RECIPE };
  }
  const root = toolsDir(openqodexHome());
  const version = recipe.version;
  const runtime = await missingRuntime(recipe);
  if (runtime) return { scanner, state: "needs_runtime", version, detail: runtime };
  if (isInstalled(root, scanner, recipe)) {
    return { scanner, state: "ready", version, detail: (await resolvedTool(root, scanner, recipe)).path };
  }
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) return { scanner, state: "unsupported", version, detail: unsupported };
  if (isLocked(root, scanner)) return { scanner, state: "installing", version, detail: null };
  const failure = lastInstallError(root, scanner);
  return { scanner, state: "will_install", version, detail: failure ? `last attempt: ${failure.reason}` : null };
}

export function toolStatuses(): Promise<ToolStatus[]> {
  return Promise.all(ALL_SCANNERS.map(statusOf));
}

// Installs the named scanners (default: every one this machine supports) and waits.
export async function installTools(
  scanners: BuiltinScanner[] | null,
  onProgress?: (line: string) => void,
): Promise<ToolStatus[]> {
  const list = scanners ?? ALL_SCANNERS;
  const resolveTool = createToolResolver({ allowInstall: true, installBudgetMs: null, onProgress });
  await Promise.all(list.map((scanner) => resolveTool(scanner)));
  return Promise.all(list.map(statusOf));
}

// Starts the same install in a detached process and returns at once.
export function installToolsDetached(scanners: BuiltinScanner[] | null): void {
  const worker = workerProgram();
  if ("refusal" in worker) return;
  const table = loadToolchain();
  const home = openqodexHome();
  const root = toolsDir(home);
  for (const scanner of scanners ?? ALL_SCANNERS) {
    const recipe = table.tools[scanner];
    if (!recipe || isInstalled(root, scanner, recipe) || isLocked(root, scanner) || unsupportedReason(table, recipe)) continue;
    // The install process checks the runtime itself and records why it stopped.
    const child = startWorker(worker.entry, scanner, home);
    child.once("error", () => undefined);
    child.unref();
  }
}
