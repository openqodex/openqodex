// golangci-lint adapter (Go lint + SAST). Runs
// `golangci-lint run --no-config ... --output.json.path=stdout --enable=gosec <pkgs>`
// from each changed module's root, scoped to the directories of changed
// .go files, and normalizes the vendor JSON `Issues[]` into
// StaticFinding[]. golangci-lint bundles a dozen Go analyzers behind
// one binary; we keep its default bug set (govet, staticcheck,
// errcheck, ineffassign, unused) and explicitly enable gosec so the Go
// security space (the G-rules: command injection, weak crypto,
// hardcoded creds, unsafe file perms, SQL string building) is covered
// too.
//
// golangci-lint type-checks whole packages, so we pass the changed
// files' directories as package args rather than the files themselves;
// a change without Go is a no-op. Findings are anchored to changed lines
// downstream (filterToChangedLines), so a package scan only ever
// surfaces hits on lines this change touched.
//
// Needs the developer's Go toolchain (the resolver reports "needs Go"
// when it is missing). GOTOOLCHAIN=local keeps a scanned go.mod from
// triggering a toolchain download. Go's build cache lives in the user cache
// folder and golangci-lint's own cache in the OpenQodex home, one folder per
// module checkout, both outside the repo; package loading runs in read-only
// module mode, so go.mod and go.sum are never rewritten.
//
// A package golangci-lint cannot type-check is not analyzed at all, and the
// only sign of it is a "typecheck" issue in the JSON report, often on a file
// outside the repo (a Go newer than the one golangci-lint was built with
// fails inside the standard library). Those issues become the module's
// error, so a broken Go setup reads as a failed scan, never a clean one.
//
// Two states of the developer's machine are not failures: a changed Go file
// with no go.mod above it, and a module whose dependencies are not in the Go
// module cache (scanner runs keep Go offline, GOPROXY=off, so Go cannot fetch
// them). Each is a skip with its reason and the command that fixes it. A run
// where only some packages are skipped still ran, and the skip is its note.
// The parts of a reason are joined with "; ", and tool text inside a part has
// its own "; " turned into ", ", so the problem report can split the parts.
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { ARG_BUDGET_BYTES, describeFailure, execTool, splitArgs, stderrTail } from "../exec.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { folderList, folderName, suchAs } from "./words.js";

// golangci-lint loads + type-checks each package, so give it more
// headroom than the file-scoped linters. Shared across every module
// run in one invocation, not granted per module: a monorepo with a
// dozen modules must not multiply the static-analysis wall clock.
const GOLANGCI_TIMEOUT_MS = 180_000;
const GOLANGCI_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
// Runaway guard on multi-module diffs. Modules are tried in order of
// how many changed files they hold, so the cap sheds the least of the
// diff; whatever it sheds is reported, never dropped silently.
const GOLANGCI_MAX_MODULES = 4;

export type GolangciRunArgs = {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  scratch: Scratch;
};

function isGoPath(p: string): boolean {
  return /\.go$/i.test(p);
}

// CLI args and module keys are posix-shaped whatever the host is: a "\"
// in a package arg is a path component to Go rather than a separator.
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Directory of the nearest `go.mod` at or above `relDir`, relative to
 * `runDir` ("." when the module is the run dir itself). Null when the
 * walk reaches the run dir without finding one.
 *
 * This exists because the run dir is NOT the module root in general: a
 * repository is free to put go.mod deeper, such as
 * `backend/src/factors/go.mod` in a monorepo. Run golangci-lint outside a module and it exits 5 in package
 * loading ("no go files to analyze") without analyzing anything, which
 * reads as a clean scan from the outside.
 */
export function nearestGoModuleRoot(runDir: string, relDir: string): string | null {
  let cur = relDir === "." || relDir === "" ? "" : relDir;
  for (;;) {
    const abs = cur ? path.join(runDir, cur) : runDir;
    if (fs.existsSync(path.join(abs, "go.mod"))) return cur ? toPosix(cur) : ".";
    if (!cur) return null;
    const parent = path.dirname(cur);
    cur = parent === "." || parent === cur ? "" : parent;
  }
}

export type GoModuleGroup = {
  // Module root relative to the run dir ("." = the run dir).
  moduleRoot: string;
  // `./pkg` args relative to THAT module root, which is the cwd the
  // module's run uses.
  packages: string[];
  fileCount: number;
};

/**
 * Group the changed .go files by the module that owns them, so each
 * module can be linted from its own root. Directories with no module
 * above them come back as `orphans` for reporting.
 */
export function groupGoPackagesByModule(
  runDir: string,
  goFiles: string[],
): { groups: GoModuleGroup[]; orphans: string[] } {
  // Changed-file count per directory first, so the module walk runs
  // once per unique directory rather than once per file.
  const filesPerDir = new Map<string, number>();
  for (const f of goFiles) {
    const dir = path.dirname(f);
    const relDir = dir === "." || dir === "" ? "." : dir;
    filesPerDir.set(relDir, (filesPerDir.get(relDir) ?? 0) + 1);
  }

  const byModule = new Map<string, GoModuleGroup>();
  const orphans: string[] = [];
  for (const [relDir, count] of filesPerDir) {
    const moduleRoot = nearestGoModuleRoot(runDir, relDir);
    if (!moduleRoot) {
      orphans.push(relDir);
      continue;
    }
    const group = byModule.get(moduleRoot) ?? {
      moduleRoot,
      packages: [],
      fileCount: 0,
    };
    const arg = packageArg(moduleRoot, relDir);
    if (!group.packages.includes(arg)) group.packages.push(arg);
    group.fileCount += count;
    byModule.set(moduleRoot, group);
  }
  // Heaviest module first, so the cap keeps the bulk of the diff.
  const groups = [...byModule.values()].sort((a, b) => b.fileCount - a.fileCount);
  return { groups, orphans };
}

// A changed directory expressed relative to its module root, in the
// `./pkg` form golangci-lint takes as a positional argument.
function packageArg(moduleRoot: string, relDir: string): string {
  if (moduleRoot === "." || moduleRoot === "") {
    return relDir === "." ? "." : `./${toPosix(relDir)}`;
  }
  const rel = toPosix(path.relative(moduleRoot, relDir));
  return rel === "" ? "." : `./${rel}`;
}

export async function runGolangci(args: GolangciRunArgs): Promise<AdapterResult> {
  const started = Date.now();
  const goFiles = args.changedPaths.filter(isGoPath);
  if (goFiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const { groups, orphans } = groupGoPackagesByModule(args.repoDir, goFiles);
  const notes: string[] = [];
  // States of the developer's machine, not failures: see the header.
  const skips: string[] = [];
  if (orphans.length > 0) {
    // Worth naming precisely: Go's own message for this ("no go files to
    // analyze: running `go mod tidy` may solve the problem") sends the
    // reader after a dependency problem that does not exist.
    skips.push(orphanSkip(orphans));
  }
  if (groups.length === 0) {
    return { findings: [], error: null, skipped: joinParts(skips) };
  }
  const running = groups.slice(0, GOLANGCI_MAX_MODULES);
  if (groups.length > running.length) {
    notes.push(`skipped ${groups.length - running.length} module(s) past the cap`);
  }

  // One deadline for the whole set, so N modules cost the same wall
  // clock ceiling as one.
  const deadline = started + GOLANGCI_TIMEOUT_MS;
  const findings: StaticFinding[] = [];
  // Runs whose packages all loaded and were linted.
  let loaded = 0;
  // Per module: the imports that are not downloaded.
  const notDownloaded = new Map<string, string[]>();
  // Modules with a run whose packages all loaded and were linted: a module
  // split into chunks can have one clean chunk and one blocked chunk.
  const linted = new Set<string>();
  // A module with more packages than one process may take as arguments runs
  // once per chunk of packages, under the same deadline.
  const runs = running.flatMap((group) => splitArgs(group.packages, ARG_BUDGET_BYTES).map((packages) => ({ group, packages })));
  for (const { group, packages } of runs) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      notes.push(`timed out before module ${toolText(group.moduleRoot)}`);
      break;
    }
    const cwd =
      group.moduleRoot === "."
        ? args.repoDir
        : path.join(args.repoDir, ...group.moduleRoot.split("/"));

    const lint = async (pkgs: string[]): Promise<GolangciReport | null> => {
      const left = deadline - Date.now();
      if (left <= 0) {
        notes.push(`timed out before module ${toolText(group.moduleRoot)}`);
        return null;
      }
      let stdout: string;
      try {
        stdout = await execGolangci(args.tool!, golangciArgs(pkgs), cwd, left, args.scratch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notes.push(`${toolText(group.moduleRoot)}: ${toolText(message).slice(0, 200)}`);
        return null;
      }
      try {
        const report = parseGolangciJson(stdout);
        findings.push(...reanchorToRunDir(report.findings, group.moduleRoot));
        const first = report.typecheckErrors[0];
        if (first) notes.push(`${toolText(group.moduleRoot)}: could not type-check: ${toolText(first).slice(0, 200)}`);
        return report;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notes.push(`${toolText(group.moduleRoot)}: parse: ${toolText(message).slice(0, 150)}`);
        return null;
      }
    };

    const report = await lint(packages);
    if (!report || report.typecheckErrors.length > 0) continue;
    if (report.notDownloaded.length === 0) {
      loaded++;
      linted.add(group.moduleRoot);
      continue;
    }
    const imports = notDownloaded.get(group.moduleRoot) ?? [];
    notDownloaded.set(group.moduleRoot, imports);
    addAll(imports, report.notDownloaded);
    // golangci-lint reports no linter's issue for any package of a run that
    // has a type-check error, so the packages that did load are linted again
    // on their own: one more run, never a loop.
    const blocked = new Set(report.blockedDirs.map(realDir));
    const rest = packages.filter((p) => !blocked.has(realDir(path.resolve(cwd, p))));
    if (rest.length === 0 || rest.length === packages.length) continue;
    const again = await lint(rest);
    if (!again || again.typecheckErrors.length > 0) continue;
    addAll(imports, again.notDownloaded);
    if (again.notDownloaded.length === 0) {
      loaded++;
      linted.add(group.moduleRoot);
    }
  }

  for (const [moduleRoot, imports] of notDownloaded) {
    skips.push(notDownloadedSkip(moduleRoot, imports, linted.has(moduleRoot)));
  }
  if (notes.length > 0) {
    return { findings, error: joinParts([...notes, ...skips]) };
  }
  if (skips.length === 0) return { findings, error: null };
  const reason = joinParts(skips);
  // Nothing was linted: a skip. Something was: a run with a note.
  return findings.length > 0 || loaded > 0
    ? { findings, error: null, note: reason }
    : { findings, error: null, skipped: reason };
}

// Folders are relative to the repository root; "." is the root itself.
function asFolder(dir: string): string {
  return dir === "." ? "" : dir;
}

// The fixed start of each skip part; the problem report's classifier
// (packages/cli/src/feedback.ts) matches these words.
function orphanSkip(orphans: string[]): string {
  const shown = orphans.slice(0, 3).map(asFolder);
  const more = orphans.length > shown.length ? ` and ${orphans.length - shown.length} more` : "";
  const where = orphans.length > 1 ? "each folder" : "that folder";
  return `not run on ${toolText(folderList(shown))}${more}. No go.mod is at or above these Go files, so they are not in a Go module. To fix, run go mod init <module path> in ${where}`;
}

function notDownloadedSkip(moduleRoot: string, imports: string[], partly: boolean): string {
  const root = asFolder(moduleRoot);
  const what = partly ? "some packages of the Go module" : "the Go module";
  // The folder stays in prose: a folder name pasted into a command can hold
  // a space or a semicolon.
  const folder = toolText(folderName(root));
  const where = root === "" ? "" : ` in ${folder}`;
  const shown = imports.map((i) => (i.length > 80 ? `${i.slice(0, 77)}...` : i));
  return `not run on ${what} at ${folder}. Its dependencies are not in the Go module cache, ${suchAs(shown)}. To fix, run go mod download${where}`;
}

// The reason's parts, joined with "; ", within the 300 characters the runner
// keeps. A part that does not fit is left out whole and counted, so no part
// is cut in the middle of its fix.
export function joinParts(parts: string[], max = 300): string {
  const kept: string[] = [];
  let length = 0;
  for (const [i, part] of parts.entries()) {
    const left = parts.length - i - 1;
    const tail = left > 0 ? `; and ${left} more` : "";
    const add = (kept.length > 0 ? 2 : 0) + part.length;
    if (length + add + tail.length > max && kept.length > 0) {
      kept.push(`and ${parts.length - i} more`);
      return kept.join("; ");
    }
    kept.push(kept.length === 0 ? part.slice(0, max) : part);
    length += add;
  }
  return kept.join("; ");
}

// Tool text inside a reason part: its own "; " would read as a part break.
function toolText(text: string): string {
  return text.replace(/;\s*/g, ", ");
}

function addAll(into: string[], items: string[]): void {
  for (const item of items) if (!into.includes(item)) into.push(item);
}

// A folder by its real path, so a path golangci-lint reports through a link
// (/private/var against /var on macOS) still matches.
function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

// --no-config: a repo's .golangci.yml is never loaded, since it can turn on
// fixes that rewrite source, module downloads, or extra report files inside
// the repo. --modules-download-mode=readonly: go.mod and go.sum are never
// updated. --path-mode=abs: absolute paths, which the runner rebases onto
// the repo root, so a nested module never gets its folder prefixed twice.
// --output.json.path=stdout and --show-stats=false: the JSON report is the
// only output, on stdout. --enable=gosec layers the security linter on top
// of the default bug set. Package dirs are positional so we analyze only
// changed packages. Every flag was checked against the help of golangci-lint
// 2.14.0.
function golangciArgs(packages: string[]): string[] {
  return [
    "run",
    "--no-config",
    "--modules-download-mode=readonly",
    "--path-mode=abs",
    "--output.json.path=stdout",
    "--show-stats=false",
    "--enable=gosec",
    ...packages,
  ];
}

export const golangci: Adapter = {
  source: "golangci",
  files: (changedPaths) => changedPaths.filter(isGoPath),
  why: (files) => `Go files, ${suchAs(files)}`,
  run: (args) => runGolangci(args),
};

/**
 * Module-root-relative -> run-dir-relative.
 *
 * golangci-lint reports paths relative to the directory it ran in, which
 * is now the module root rather than the run dir. Everything downstream
 * speaks the run-dir frame (filterToChangedLines matches a finding's
 * path against the coverage keys by exact string, so a path left in the
 * module frame is not "slightly off", it is silently dropped). Absolute
 * paths are left alone; toRunDirRelative in run.ts rebases those.
 */
function reanchorToRunDir(
  findings: StaticFinding[],
  moduleRoot: string,
): StaticFinding[] {
  if (moduleRoot === "." || moduleRoot === "") return findings;
  return findings.map((f) =>
    path.isAbsolute(f.filePath)
      ? f
      : { ...f, filePath: `${moduleRoot}/${toPosix(f.filePath)}` },
  );
}

async function execGolangci(
  tool: ResolvedTool,
  cliArgs: string[],
  cwd: string,
  timeoutMs: number,
  scratch: Scratch,
): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: GOLANGCI_OUTPUT_MAX_BYTES,
    env: { ...tool.env, GOTOOLCHAIN: "local", GOLANGCI_LINT_CACHE: golangciCacheDir(scratch, cwd) },
  });
  // golangci-lint exit codes: 0 = no issues, 1 = issues found,
  // higher = config / analysis error. It writes the JSON report
  // to stdout for 0 and 1 (and often still emits a JSON report on
  // a partial analysis error). Prefer stdout whenever it carries
  // a JSON object; only a missing binary or an empty-output
  // failure is fatal.
  const failed = describeFailure("golangci-lint", result, timeoutMs);
  if (result.failure === "not_found" && failed) throw new Error(failed);
  if (result.stdout.includes("{")) return result.stdout;
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`golangci-lint exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

// golangci-lint keys its issue cache on package content, not location, and
// stores absolute positions: two checkouts holding the same package (two
// worktrees of one repo) get the first checkout's paths back, which match no
// changed line and are dropped. One cache folder per module checkout keeps
// the speed of a warm cache without replaying another folder's paths. The
// folders live under the run's scratch root (scratch.ts): the OpenQodex
// home on the laptop; each is made or checked through the scratch's guarded
// writer, so a link on the way is refused.
function golangciCacheDir(scratch: Scratch, moduleDir: string): string {
  let real = moduleDir;
  try {
    real = fs.realpathSync(moduleDir);
  } catch {
    // The run itself reports a missing folder.
  }
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return scratch.cache("golangci", key);
}

type GolangciIssue = {
  FromLinter?: unknown;
  Text?: unknown;
  SourceLines?: unknown;
  Pos?: { Filename?: unknown; Line?: unknown };
};

export type GolangciReport = {
  findings: StaticFinding[];
  // "file:line: text" for each issue from the typecheck pseudo-linter: the
  // package it names was not analyzed by any linter.
  typecheckErrors: string[];
  // Import paths that could not load because their module is not in the Go
  // module cache and the offline scan may not download it. A state of the
  // machine, kept apart from the type-check errors the change can cause.
  notDownloaded: string[];
  // The folders (packages) of the files whose imports were not downloaded.
  blockedDirs: string[];
};

// Go's text when an import needs a module that is required but not in the
// module cache, and the scan may not download it. On the laptop GOPROXY=off
// says "module lookup disabled by GOPROXY=off". On a server the proxy is the
// preinstalled module cache read as files (scratch.ts), and a module missing
// there says "reading file:///.../@v/v1.2.3.zip: no such file or directory".
// An import that no required module provides says "import lookup disabled by
// -mod=readonly", and a module go.sum does not list says "missing go.sum
// entry": both are defects of the change and stay type-check errors.
const NOT_DOWNLOADED = /module lookup disabled by GOPROXY=off|reading file:\/\/\S+: no such file or directory/;
const COULD_NOT_IMPORT = /could not import (\S+) \(/g;

// The import that is not downloaded, and the import of this file that
// failed because of it. A package of the repo that imports the missing
// module nests the text: "could not import example.com/e/b (b/b.go:3:8:
// could not import github.com/x/y (...GOPROXY=off))".
function notDownloadedImport(text: string): { missing: string; outer: string } | null {
  const tail = NOT_DOWNLOADED.exec(text);
  if (!tail || !text.startsWith("could not import ")) return null;
  const names = [...text.slice(0, tail.index).matchAll(COULD_NOT_IMPORT)].map((m) => m[1]!);
  if (names.length === 0) return null;
  return { missing: names[names.length - 1]!, outer: names[0]! };
}

// The names code may use for an import whose package could not load. Go
// then reports "undefined: <name>" at each use. The name is the import's
// alias in the file, else the package's own name, which is not in the path:
// "github.com/go-chi/chi/v5" is chi, "github.com/mattn/go-sqlite3" is
// sqlite3, "github.com/x/not-downloaded" is commonly notdownloaded.
function importNames(importPath: string, sourceLine: string): string[] {
  const alias = /^\s*(?:import\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+"/.exec(sourceLine)?.[1];
  // "import" itself is the keyword of a one-line import, never an alias.
  if (alias && alias !== "_" && alias !== "import") return [alias];
  const parts = importPath.split("/");
  let last = parts[parts.length - 1] ?? "";
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2]!;
  const base = last.replace(/\.v\d+$/, "");
  // "github.com/satori/go.uuid" is uuid: the part after the last dot.
  const names = [base, base.replace(/-/g, ""), base.replace(/^go-/, "").replace(/-go$/, ""), base.split(".").pop() ?? ""];
  return [...new Set(names.map((n) => n.replace(/[^A-Za-z0-9_]/g, "")).filter((n) => /^[A-Za-z_]/.test(n)))];
}

export function parseGolangciJson(json: string): GolangciReport {
  const report: GolangciReport = { findings: [], typecheckErrors: [], notDownloaded: [], blockedDirs: [] };
  const body = extractJsonObject(json);
  if (!body) return report;
  const parsed = JSON.parse(body) as { Issues?: unknown };
  // golangci emits Issues: null (not []) when there are no findings.
  if (!parsed || !Array.isArray(parsed.Issues)) return report;
  const out = report.findings;
  const issues = (parsed.Issues as GolangciIssue[]).filter((raw) => raw && typeof raw === "object");
  // A file with an import that is not downloaded is type-checked without
  // it, and each use of the import's name is "undefined: <name>". Only that
  // error, in that file, follows from the missing module; every other
  // type-check error is the change's own.
  const unloadedNames = new Map<string, Set<string>>();
  for (const raw of issues) {
    if (raw.FromLinter !== "typecheck" || typeof raw.Text !== "string") continue;
    const hit = notDownloadedImport(raw.Text);
    if (!hit) continue;
    const file = typeof raw.Pos?.Filename === "string" ? raw.Pos.Filename : "";
    const line = Array.isArray(raw.SourceLines) && typeof raw.SourceLines[0] === "string" ? raw.SourceLines[0] : "";
    const names = unloadedNames.get(file) ?? new Set<string>();
    for (const n of importNames(hit.outer, line)) names.add(n);
    unloadedNames.set(file, names);
  }
  for (const raw of issues) {
    const filePath = typeof raw.Pos?.Filename === "string" ? raw.Pos.Filename : "";
    const line = numberOrZero(raw.Pos?.Line);
    // FromLinter is the analyzer that produced the issue (e.g. "gosec",
    // "staticcheck"); it becomes the citation token "golangci:gosec".
    const linter = typeof raw.FromLinter === "string" && raw.FromLinter ? raw.FromLinter : "golangci";
    const message = typeof raw.Text === "string" ? raw.Text : "";
    if (linter === "typecheck") {
      const hit = notDownloadedImport(message);
      if (hit) {
        if (!report.notDownloaded.includes(hit.missing)) report.notDownloaded.push(hit.missing);
        const dir = path.dirname(filePath);
        if (filePath && !report.blockedDirs.includes(dir)) report.blockedDirs.push(dir);
        continue;
      }
      const undefinedName = /^undefined: ([A-Za-z_][A-Za-z0-9_]*)$/.exec(message)?.[1];
      if (undefinedName && unloadedNames.get(filePath)?.has(undefinedName)) continue;
      report.typecheckErrors.push(trimMessage(`${filePath || "?"}:${line}: ${message}`));
      continue;
    }
    if (!filePath || line <= 0) continue;
    out.push({
      source: "golangci",
      ruleId: linter,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: severityForLinter(linter),
      message: buildMessage(linter, message),
      reference: null,
    });
  }
  return report;
}

// Trim any leading log noise before the JSON object. golangci writes
// warnings to stderr and the JSON report to stdout, so stdout is
// normally clean; this only guards against a stray prefix line.
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) return trimmed;
  const idx = trimmed.indexOf("{");
  return idx >= 0 ? trimmed.slice(idx) : "";
}

// Map the producing linter to our scale and (implicit) category: gosec
// is the security class (high); the type-aware bug finders (govet,
// staticcheck, errcheck) are real bugs (medium); every other golangci
// linter (ineffassign, unused, gosimple, ...) is lower-priority lint
// the cap sheds first.
const BUG_LINTERS = new Set(["govet", "staticcheck", "errcheck"]);

function severityForLinter(linter: string): StaticFindingSeverity {
  if (linter === "gosec") return "high";
  if (BUG_LINTERS.has(linter)) return "medium";
  return "low";
}

function buildMessage(linter: string, message: string): string {
  const full = message ? `${linter}: ${message}` : linter;
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
