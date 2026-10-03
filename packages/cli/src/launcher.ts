// The stable command every hook and the user-scope skill call. `init` and
// `hook install` copy the installed package to <home>/runtime/<version>/,
// write <home>/runtime/current (the active record: line 1 the active
// version, line 2 the previous one or empty) and write <home>/bin/openqodex,
// a POSIX sh script that runs the runtime line 1 names with the node binary
// they ran under, or the version baked into it when line 1 is missing,
// malformed or names a runtime that is gone. Hooks then never depend on npx,
// the npm cache or PATH. A runtime folder is created once, by a rename, and
// never replaced; switching versions is one rename of the record.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { openqodexHome } from "@openqodex/scanners";
import { assetPath } from "./assets.js";
import { readText, sha256, writeAtomic } from "./agents/files.js";
import { ownedFile, type Action } from "./agents/plan.js";
import type { InstallRecord } from "./agents/record.js";
import { readState, statePath, userConfigPath } from "./update/state.js";

const execFileAsync = promisify(execFile);

export const LAUNCHER_MARKER = "# openqodex launcher, written by openqodex init";

// $OPENQODEX_HOME or ~/.openqodex.
export function openqodexHomeDir(): string {
  return openqodexHome();
}

export function launcherPath(home: string): string {
  return join(home, "bin", "openqodex");
}

export function runtimeDir(version: string, home: string): string {
  return join(home, "runtime", version);
}

export function runtimeBin(home: string, version: string): string {
  return join(runtimeDir(version, home), "dist", "bin.js");
}

export function currentPath(home: string): string {
  return join(home, "runtime", "current");
}

// What the launcher accepts in `current`: a digit first (so never "." or
// ".."), then only [0-9A-Za-z.+-]. launcherScript applies the same rule in sh.
const VERSION_TEXT = /^[0-9][0-9A-Za-z.+-]*$/;

export type Active = { current: string | null; previous: string | null };

// The active record, each line null when missing or not a version.
export function readActive(home: string): Active {
  let text: string;
  try {
    text = readFileSync(currentPath(home), "utf8");
  } catch {
    return { current: null, previous: null };
  }
  const [first = "", second = ""] = text.split("\n");
  return { current: VERSION_TEXT.test(first) ? first : null, previous: VERSION_TEXT.test(second) ? second : null };
}

// Writes both lines by a temp file and a rename, so the launcher never reads
// half a line and current and previous always change together.
export function writeActive(home: string, active: { current: string; previous: string | null }): void {
  for (const v of [active.current, active.previous]) if (v !== null && !VERSION_TEXT.test(v)) throw new Error(`not a version: ${v}`);
  const path = currentPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${active.current}\n${active.previous ?? ""}\n`, { flag: "wx", mode: 0o644 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// The version the launcher runs now: line 1 when its runtime is there, else
// the version baked into the launcher, as the launcher itself decides.
export function activeVersion(home: string): string | null {
  const { current } = readActive(home);
  if (current !== null && existsSync(runtimeBin(home, current))) return current;
  return bakedVersion(home);
}

// Single quotes for a POSIX shell; an inner single quote becomes '\''.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, () => `'\\''`)}'`;
}

// The launcher as the skill, the agent hooks and the Claude Code permission
// rules write it: bare when the path needs no shell quoting, so a rule such
// as `Bash(/home/me/.openqodex/bin/openqodex review *)` matches the command
// text the agent runs character for character; quoted otherwise.
export function launcherRunner(path: string): string {
  return /^[A-Za-z0-9_./@+-]+$/.test(path) ? path : shQuote(path);
}

// `hook check` must never fail a push by accident, so for that command the
// script exits 0 whatever happens (no node, a broken runtime, an old node),
// with one line on stderr saying how to repair it. Every other command gets
// exit 2 when it cannot start, which the git hook does not treat as a finding.
//
// Line 1 of the record is read with the shell's own `read`, never run or
// expanded; line 2 is never read here. A line that breaks the version rule,
// or names a runtime with no dist/bin.js, leaves the baked-in runtime in place.
export function launcherScript(nodePath: string, home: string, version: string): string {
  const repair = "run npx openqodex init again to repair it";
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    `node=${shQuote(nodePath)}`,
    `runtimes=${shQuote(join(home, "runtime"))}`,
    `bin=${shQuote(runtimeBin(home, version))}`,
    'current=""',
    '[ -f "$runtimes/current" ] && IFS= read -r current < "$runtimes/current"',
    'case "$current" in',
    '  [0-9]*) case "$current" in *[!0-9A-Za-z.+-]*) ;; *) [ -f "$runtimes/$current/dist/bin.js" ] && bin="$runtimes/$current/dist/bin.js" ;; esac ;;',
    "esac",
    '[ -x "$node" ] || node=$(command -v node 2>/dev/null) || node=""',
    // The runtime knows it was started here, and from which file: only
    // then does it check for updates (see launcherStarted).
    'OPENQODEX_LAUNCHER="$bin"',
    "export OPENQODEX_LAUNCHER",
    'if [ "$1" = hook ] && [ "$2" = check ]; then',
    `  if [ -z "$node" ] || [ ! -f "$bin" ]; then echo "openqodex: the push check could not start (no node or no runtime); ${repair}" >&2; exit 0; fi`,
    `  "$node" "$bin" "$@" || echo "openqodex: the push check failed to run; ${repair}" >&2`,
    "  exit 0",
    "fi",
    `if [ -z "$node" ] || [ ! -f "$bin" ]; then echo "openqodex: cannot start (no node or no runtime); ${repair}" >&2; exit 2; fi`,
    'exec "$node" "$bin" "$@"',
    "",
  ].join("\n");
}

// True when this process was started by the launcher: the launcher exports
// the runtime file it ran, and that is this process's own entry file. A child
// that inherits the variable but runs another file (npx, a project-scope
// pin) does not count.
export function launcherStarted(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): boolean {
  const named = env.OPENQODEX_LAUNCHER;
  return named !== undefined && named !== "" && entry !== undefined && resolve(named) === resolve(entry);
}

// The version baked into the launcher script, from its bin= line; null when
// the launcher is missing or not ours.
export function bakedVersion(home: string): string | null {
  const text = readText(launcherPath(home));
  if (text === null || !text.includes(LAUNCHER_MARKER)) return null;
  const m = /^bin='(.*)'$/m.exec(text);
  const parts = m ? m[1]!.split("/") : [];
  // .../runtime/<version>/dist/bin.js
  const v = parts[parts.length - 3];
  return v !== undefined && VERSION_TEXT.test(v) ? v : null;
}

// What a folder holds, as relative path to "dir" or "file <sha256>"; null
// when it holds anything else (a symbolic link, a device). `skipTop` names
// entries left out at the top: the installed package may sit beside its
// node_modules, which init never copies.
function treeEntries(root: string, skipTop: string[] = []): Map<string, string> | null {
  const out = new Map<string, string>();
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && skipTop.includes(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        out.set(rel, "dir");
        if (!walk(full)) return false;
      } else if (entry.isFile()) out.set(rel, `file ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      else return false;
    }
    return true;
  };
  return walk(root) ? out : null;
}

// True when `runtime` holds exactly what `source` holds: the same entries,
// the same types, the same bytes, and no link anywhere in either.
export function identicalTree(source: string, runtime: string, skipInSource: string[] = []): boolean {
  // A root that is a link would let bytes outside the runtime folder run.
  for (const root of [source, runtime]) {
    try {
      if (!lstatSync(root).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  const a = treeEntries(source, skipInSource);
  const b = treeEntries(runtime);
  if (a === null || b === null || a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// The installed package folder: the one that holds dist/.
function packageDir(): string {
  return assetPath();
}

const PACKAGE_SKIP = ["node_modules"];

export async function checkRuns(binJs: string, version: string): Promise<void> {
  const { stdout } = await execFileAsync(process.execPath, [binJs, "--version"], { timeout: 30_000 });
  if (stdout.trim() !== version) throw new Error(`the runtime copy printed "${stdout.trim()}" for --version, expected ${version}`);
}

// Copies the package to a temp folder beside the target, checks it runs,
// then renames it into place. The target is never replaced: when a folder
// appeared there in between, the rename fails and nothing changes.
async function installRuntime(version: string, home: string): Promise<void> {
  const target = runtimeDir(version, home);
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(packageDir(), tmp, { recursive: true, filter: (src) => !(dirname(src) === packageDir() && PACKAGE_SKIP.includes(src.split(/[\\/]/).pop() ?? "")) });
    await checkRuns(join(tmp, "dist", "bin.js"), version);
    if (existsSync(target)) throw new Error(`${target} appeared while init was running; nothing was replaced`);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The runtime copy, the active record and the launcher, as plan actions. An
// existing runtime folder of this version is used only when it is identical
// to this package; one that differs is refused, never replaced. The caller
// holds the commit boundary.
export function planRuntime(record: InstallRecord, version: string, home: string): Action[] {
  const rt = runtimeDir(version, home);
  const launcher = launcherPath(home);
  const actions: Action[] = [];
  if (!existsSync(rt)) {
    actions.push({ verb: "create", path: rt, note: "a copy of this openqodex that the hooks and the skill run", apply: () => installRuntime(version, home) });
  } else if (identicalTree(packageDir(), rt, PACKAGE_SKIP)) {
    actions.push({ verb: "skip", path: rt, note: "runtime already present" });
  } else {
    actions.push({ verb: "refuse", failed: true, path: rt, note: `${rt} holds a different copy of openqodex ${version}; move it aside and run init again` });
  }

  const pointer = currentPath(home);
  const was = readActive(home);
  if (was.current === version) {
    actions.push({ verb: "skip", path: pointer, note: `the launcher already runs ${version}` });
  } else {
    // The version active before stays as the one to roll back to.
    const before = activeVersion(home);
    const previous = before !== null && before !== version ? before : was.previous;
    actions.push({
      verb: existsSync(pointer) ? "update" : "create",
      path: pointer,
      note: `points the launcher at ${version}`,
      apply: () => writeActive(home, { current: version, previous }),
    });
  }

  const script = launcherScript(process.execPath, home, version);
  const before = readText(launcher);
  const remember = (): void => {
    record.files = record.files.filter((f) => f.path !== launcher);
    record.files.push({ path: launcher, sha256: createHash("sha256").update(script).digest("hex"), usesLauncher: false });
  };
  const write = (): void => {
    writeAtomic(launcher, script, 0o755);
    remember();
  };
  if (before === script) {
    // Exactly what we would write, down to the paths: ours.
    if (!ownedFile(record, launcher, before)) remember();
    actions.push({ verb: "skip", path: launcher, note: "launcher already present" });
  } else if (before === null || ownedFile(record, launcher, before)) {
    actions.push({ verb: before === null ? "create" : "update", path: launcher, note: "launcher the hooks and the skill call", guard: { path: launcher, before }, apply: write });
  } else {
    actions.push({ verb: "refuse", failed: true, path: launcher, note: "a launcher openqodex init did not write is in the way; move it aside" });
  }
  return actions;
}

// The runtime folders OpenQodex can name as its own: <home>/runtime/<x.y.z>/
// with a package.json whose name is openqodex.
export function ourRuntimes(home: string): string[] {
  const dir = join(home, "runtime");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!/^\d+\.\d+\.\d+$/.test(name)) return false;
    try {
      return (JSON.parse(readFileSync(join(dir, name, "package.json"), "utf8")) as { name?: unknown }).name === "openqodex";
    } catch {
      return false;
    }
  });
}

// The temp folders a worker or init unpacks into: <home>/runtime/<x>.tmp-<pid>.
// With `all`, every one (uninstall); otherwise only those whose process is
// gone and that are older than an hour, left by a crash or a kill.
export function tempRuntimes(home: string, all: boolean, now = Date.now()): string[] {
  const dir = join(home, "runtime");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      const m = /\.tmp-(\d+)$/.exec(name);
      if (m === null) return false;
      if (all) return true;
      const pid = Number(m[1]);
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
      try {
        return !alive && now - statSync(join(dir, name)).mtimeMs > 60 * 60 * 1000;
      } catch {
        return false;
      }
    })
    .map((name) => join(dir, name));
}

// Runtimes younger than this are kept even when no rule below names them.
export const KEEP_YOUNG_MS = 7 * 24 * 60 * 60 * 1000;

// Removes openqodex runtime folders older than 7 days, except the baked-in,
// current and previous ones. Run by init and the foreground update, inside
// the commit boundary; never by the worker. Never fails its caller.
export function pruneRuntimes(home: string, now = Date.now()): void {
  const active = readActive(home);
  const keep = new Set([bakedVersion(home), active.current, active.previous].filter((v): v is string => v !== null));
  for (const name of ourRuntimes(home)) {
    if (keep.has(name)) continue;
    const dir = runtimeDir(name, home);
    try {
      if (now - statSync(dir).mtimeMs < KEEP_YOUNG_MS) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // tried again next time
    }
  }
}

// What still calls the launcher once this run is done: recorded agent hooks
// (including one in a file that could not be parsed) and recorded git hooks
// that are still on disk as we wrote them.
export function launcherUsers(record: InstallRecord): string[] {
  const hooks = record.hooks.filter((h) => h.usesLauncher).map((h) => h.path);
  const gitHooks = record.files.filter((f) => f.usesLauncher && ownedFile(record, f.path, readText(f.path))).map((f) => f.path);
  return [...new Set([...hooks, ...gitHooks])];
}

// Removes every openqodex runtime, the active record, the launcher and the
// update files once nothing recorded calls the launcher. The caller holds
// the commit boundary, so no worker switches versions meanwhile; a worker
// that reaches the boundary afterwards finds no launcher and writes nothing.
export function planRuntimeRemoval(record: InstallRecord, home: string, willStay: string[]): Action[] {
  const launcher = launcherPath(home);
  if (willStay.length > 0) {
    return [{ verb: "keep", path: launcher, note: `launcher and runtime kept: still called by ${willStay.join(", ")}` }];
  }
  const stillCalled = (): void => {
    if (launcherUsers(record).length > 0) throw new Error(`kept: still called by ${launcherUsers(record).join(", ")}`);
  };
  const actions: Action[] = [];
  // Written by earlier versions; nothing reads them now.
  record.runtimes = [];
  record.pointers = [];
  for (const name of ourRuntimes(home)) {
    const rt = runtimeDir(name, home);
    actions.push({
      verb: "remove",
      path: rt,
      note: "runtime copy of openqodex",
      apply: () => {
        stillCalled();
        rmSync(rt, { recursive: true, force: true });
      },
    });
  }
  for (const tmp of tempRuntimes(home, true)) {
    actions.push({ verb: "remove", path: tmp, note: "an unfinished runtime copy", apply: () => rmSync(tmp, { recursive: true, force: true }) });
  }
  const pointer = currentPath(home);
  if (existsSync(pointer)) {
    actions.push({
      verb: "remove",
      path: pointer,
      note: "the launcher's record of the active runtime",
      apply: () => {
        stillCalled();
        rmSync(pointer, { force: true });
        try {
          rmdirSync(dirname(pointer));
        } catch {
          // other files are there; they are not ours
        }
      },
    });
  }
  const text = readText(launcher);
  if (ownedFile(record, launcher, text)) {
    actions.push({
      verb: "remove",
      path: launcher,
      note: "launcher",
      guard: { path: launcher, before: text },
      apply: () => {
        stillCalled();
        rmSync(launcher, { force: true });
        try {
          rmdirSync(dirname(launcher));
        } catch {
          // not empty
        }
        record.files = record.files.filter((f) => f.path !== launcher);
      },
    });
  } else if (record.files.some((f) => f.path === launcher)) {
    record.files = record.files.filter((f) => f.path !== launcher);
  }
  actions.push(...planUpdateFilesRemoval(home));
  return actions;
}

// The update check's files go with the launcher: its state, and the user
// config.yaml only when `update` created it and it is unchanged.
function planUpdateFilesRemoval(home: string): Action[] {
  const actions: Action[] = [];
  const config = userConfigPath(home);
  const configText = readText(config);
  const state = readState(home);
  if (configText !== null && state.userConfig !== null && state.userConfig === sha256(configText)) {
    actions.push({ verb: "remove", path: config, note: "the update switch openqodex update wrote", guard: { path: config, before: configText }, apply: () => rmSync(config, { force: true }) });
  }
  const path = statePath(home);
  if (existsSync(path)) actions.push({ verb: "remove", path, note: "the update check's state", apply: () => rmSync(path, { force: true }) });
  return actions;
}

// Lock files of versions before the commit boundary: never read now, and
// removed by init and uninstall.
export function removeOldLocks(home: string): void {
  for (const name of ["install.lock", "update.lock", "update.json.lock"]) {
    for (const path of [join(home, name), join(home, `${name}.takeover`)]) rmSync(path, { force: true });
  }
}
