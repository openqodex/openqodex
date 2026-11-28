// The tools a host's package manager installs. On FreeBSD, pkg installs
// shellcheck, ruff, hadolint, gitleaks, osv-scanner and zizmor under
// LOCALBASE, and OpenQodex never downloads or copies them: the only place
// looked at is the path under LOCALBASE, so two machines report the same
// findings and a program of another user cannot run the review.
import { lstatSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run, smallEnv } from "./fetch.js";
import { currentPlatform, isSystemAsset, type Recipe, type SystemAsset } from "./table.js";

// The variable that names the localbase, for a host whose packages are not
// under /usr/local.
export const LOCALBASE_VARIABLE = "OPENQODEX_LOCALBASE";

// Where pkg installs on FreeBSD.
const DEFAULT_LOCALBASE = "/usr/local";

// How long the version probe may run.
const PROBE_TIMEOUT_MS = 15_000;

// The localbase: the variable when it is set and absolute, else the
// default.
export function localbase(): string {
  const named = process.env[LOCALBASE_VARIABLE];
  if (named !== undefined && named !== "" && isAbsolute(named)) return resolve(named);
  return DEFAULT_LOCALBASE;
}

// Whether a path is inside a root folder. The root itself is inside it.
// The two are compared by the path of the target relative to the root, so a
// root of "/" works and every path is inside it.
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

// Whether a program or a folder that belongs to an owner is one this build
// may use: the system's own, or this user's. A program of another user is
// that user's program, and it is not run.
export function ownerIsTrusted(uid: number, user: number): boolean {
  return uid === 0 || uid === user;
}

// The problem with the owner of a program or of a folder, or null when the
// owner is one this build may use. The words are the ones the reason adds
// after the name of the program or of the folder.
export function ownerProblem(uid: number, user: number): string | null {
  if (ownerIsTrusted(uid, user)) return null;
  return "is owned by another user";
}

// The problem with the mode of a program or of a folder, or null when
// nobody but the owner can write to it: another user who can write to it
// can put a program of their own there.
export function modeProblem(mode: number): string | null {
  if ((mode & 0o022) === 0) return null;
  return "is writable by group or others";
}

// The problem with a folder, or null when it has none. The folder must be a
// folder, must belong to the system's own or to this user, and must not be
// writable by group or others: another user who can write to it can put a
// program of their own there. The owner comes before the mode, and the
// words are the ones a program gets for the same owner and the same mode.
export function folderProblem(info: { uid: number; mode: number; isDirectory(): boolean }, user: number): string | null {
  if (!info.isDirectory()) return "is not a folder";
  return ownerProblem(info.uid, user) ?? modeProblem(info.mode);
}

// The error a failed call gave, in one line.
function readError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

// The code of a failed call, or null when it has none.
function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : null;
}

// Whether a failed call to read a link says that the target is not there.
// Only that failure means the target is missing: every other one, a loop of
// links or a path that goes through a file that is not a folder, is a file
// this build cannot read, and its error says why.
function targetIsMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT";
}

// The folders from a folder up to a root, the root last. The walk stops at
// the root, or at the top of the file system.
function directoriesUpTo(root: string, from: string): string[] {
  const dirs: string[] = [];
  let current = from;
  for (;;) {
    if (!isInside(root, current)) break;
    dirs.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

// The asset of the platform this machine is, when it is a system asset.
export function systemAssetFor(recipe: Recipe): SystemAsset | null {
  if (recipe.method !== "github-release") return null;
  const platform = currentPlatform();
  if (platform === null) return null;
  const asset = recipe.assets[platform];
  return asset !== undefined && asset !== null && isSystemAsset(asset) ? asset : null;
}

// A version as three numbers, or null when it is not x.y.z.
function versionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Which of two versions is the smaller.
function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
  }
  return 0;
}

// Whether the version a program reports fits the pin this build ships:
// "ok" when it does, "older" when it is below the pin, "other-series" when
// it is in another series, and "invalid" when either is not x.y.z.
export function versionFits(pin: string, found: string): "ok" | "older" | "other-series" | "invalid" {
  const wanted = versionParts(pin);
  const got = versionParts(found);
  if (wanted === null || got === null) return "invalid";
  const order = compare(got, wanted);
  if (order < 0) return "older";
  if (order === 0) return "ok";
  return wanted[0] === got[0] && wanted[1] === got[1] ? "ok" : "other-series";
}

// The number of capture groups a pattern has. The pattern is compiled with
// the "d" flag, which reports one entry per group, and an empty
// alternative is added so the pattern matches even when it would not.
function captureGroups(pattern: string): number {
  const probe = new RegExp(`${pattern}|`, "md");
  const found = probe.exec("");
  return found === null || found.indices === undefined ? 0 : found.indices.length - 1;
}

// How a program ended, in one line.
function endedWith(out: { code: number | null; missing: boolean; timedOut: boolean }): string {
  if (out.timedOut) return "it did not finish in time";
  if (out.missing) return "it could not be started";
  if (out.code === null) return "it was stopped";
  return `it exited with code ${out.code}`;
}

// The resolution of a system asset: the program and the version it reports,
// or the plain reason it cannot be used. A failure that says the package is
// not there is "missing"; every other failure is "refused", because the
// program is there and this build must not run it. A refusal that knows the
// version the program printed carries it.
export type SystemResolution =
  | { ok: true; path: string; version: string }
  | { ok: false; kind: "missing" | "refused"; reason: string; version?: string };

// The resolutions of this process: a program is checked once, and every
// later answer about it is the same one.
const resolutions = new Map<string, Promise<SystemResolution>>();

// The checks of this process are forgotten, so a caller that changed the
// machine sees the machine as it is now.
export function clearSystemResolutions(): void {
  resolutions.clear();
}

// The program of a system asset, or the reason the asset names no program.
function programOf(asset: SystemAsset): { file: string } | { reason: string } {
  const system = asset.system;
  if (isAbsolute(system.path) || system.path.split("/").includes("..")) {
    return { reason: `${system.package}: ${system.path} is not a path inside the localbase` };
  }
  return { file: join(localbase(), system.path) };
}

// The real path of a file, links followed, or null when it cannot be read.
function realOf(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

// Checks the program of a system asset and reads its version.
async function checkNow(tool: string, recipe: Recipe, asset: SystemAsset, timeoutMs: number): Promise<SystemResolution> {
  const system = asset.system;
  const where = programOf(asset);
  if ("reason" in where) return { ok: false, kind: "refused", reason: where.reason };
  const file = where.file;
  // The first lstat tells the two errors apart, and it does not follow a
  // link: an entry that is not there is a package that is not installed,
  // and every other failure is a file this build cannot read. A link whose
  // target is not there is not missing: the entry itself is there.
  let entry: Stats;
  try {
    entry = lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, kind: "missing", reason: `${system.package} is not installed: pkg install ${system.package}` };
    }
    return { ok: false, kind: "refused", reason: `${system.package}: ${file} could not be read: ${readError(error)}` };
  }
  // The program that runs is the file the link points at, and it must be
  // inside the localbase: a link out of it is a program of somewhere else,
  // and the path of a program is never looked for on PATH.
  const root = realOf(localbase());
  if (root === null) {
    return { ok: false, kind: "refused", reason: `${system.package}: ${system.path} is not a path inside the localbase` };
  }
  let real: string;
  try {
    real = realpathSync(file);
  } catch (error) {
    // A link whose target is not there is a program that is there and
    // cannot be used: the entry is present and the target is missing. Any
    // other failure is a file this build cannot read, and the error says
    // why.
    if (entry.isSymbolicLink() && targetIsMissing(error)) {
      return { ok: false, kind: "refused", reason: `${system.package}: ${file} is a link whose target is missing` };
    }
    return { ok: false, kind: "refused", reason: `${system.package}: ${file} could not be read: ${readError(error)}` };
  }
  if (!isInside(root, real)) {
    return { ok: false, kind: "refused", reason: `${system.package}: ${system.path} is not a path inside the localbase` };
  }
  // The owner and the mode are those of the program that will run: they are
  // read after the path is resolved, so they cannot be about another file.
  let target: Stats;
  try {
    target = statSync(real);
  } catch (error) {
    if (entry.isSymbolicLink() && targetIsMissing(error)) {
      return { ok: false, kind: "refused", reason: `${system.package}: ${file} is a link whose target is missing` };
    }
    return { ok: false, kind: "refused", reason: `${system.package}: ${real} could not be read: ${readError(error)}` };
  }
  if (!target.isFile()) return { ok: false, kind: "refused", reason: `${system.package}: ${real} did not run: it is not a file` };
  // The user this build runs as is the effective one: the real user may be
  // another one, and the program runs with the effective one. The owner
  // comes before the mode, and the words are the ones a folder gets for
  // the same owner and the same mode.
  const user = process.geteuid?.() ?? process.getuid?.() ?? 0;
  const owner = ownerProblem(target.uid, user);
  if (owner !== null) return { ok: false, kind: "refused", reason: `${system.package}: ${real} ${owner}` };
  const mode = modeProblem(target.mode);
  if (mode !== null) return { ok: false, kind: "refused", reason: `${system.package}: ${real} ${mode}` };
  // The folders above the program, up to the localbase, must be the system's
  // or this user's, and must not be writable by anyone else: another user who
  // can write to one of them can put a program there. Two chains are walked:
  // the folder that holds the program, and the folder that holds the file the
  // link points at, because the folder that holds the link can be swapped.
  // A folder that is in both chains is walked once.
  const folders = [...new Set([...directoriesUpTo(localbase(), dirname(file)), ...directoriesUpTo(root, dirname(real))])];
  for (const dir of folders) {
    // A folder is judged by the folder it really is, and it is named by that
    // path, so the reason says where the program is not trusted.
    let folder: string;
    try {
      folder = realpathSync(dir);
    } catch (error) {
      return { ok: false, kind: "refused", reason: `${system.package}: ${dir} could not be read: ${readError(error)}` };
    }
    let dirInfo: Stats;
    try {
      dirInfo = statSync(folder);
    } catch (error) {
      return { ok: false, kind: "refused", reason: `${system.package}: ${folder} could not be read: ${readError(error)}` };
    }
    const problem = folderProblem(dirInfo, user);
    if (problem !== null) return { ok: false, kind: "refused", reason: `${system.package}: ${folder} ${problem}` };
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(system.versionPattern, "m");
  } catch {
    return { ok: false, kind: "refused", reason: `${system.package}: this build cannot read a version from it` };
  }
  try {
    if (captureGroups(system.versionPattern) !== 1) return { ok: false, kind: "refused", reason: `${system.package}: this build cannot read a version from it` };
  } catch {
    return { ok: false, kind: "refused", reason: `${system.package}: this build cannot read a version from it` };
  }
  let out: Awaited<ReturnType<typeof run>>;
  try {
    out = await run(real, system.versionArgs, { env: smallEnv(), timeoutMs });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "refused", reason: `${system.package}: ${real} did not run: ${cause}` };
  }
  // The run is the authority on whether the program can run: a check of the
  // mode would read the real user, and the program runs with the effective
  // one. A program the run cannot start because it cannot be executed is
  // refused for that. Only a run that never started says so: a program that
  // ran and printed the words of a failed start is not one.
  if (out.missing && /EACCES|ENOEXEC/.test(out.stderr)) {
    return { ok: false, kind: "refused", reason: `${system.package}: ${real} did not run: it is not executable` };
  }
  // The version the program printed is read and validated before the run is
  // judged, so that every refusal that follows carries the same value: a
  // printed string this build cannot read is no version at all. A refusal
  // that knows the version the program printed carries it, so the report
  // names the version that is there and not the pin.
  const match = pattern.exec(out.stdout) ?? pattern.exec(out.stderr);
  const printed = match?.[1]?.trim();
  const candidate = printed === undefined ? "" : printed;
  const version = candidate !== "" && versionParts(candidate) !== null ? candidate : undefined;
  if (out.code !== 0 || out.timedOut) {
    return { ok: false, kind: "refused", reason: `${system.package}: ${real} did not run: ${endedWith(out)}`, ...(version === undefined ? {} : { version }) };
  }
  if (version === undefined) {
    return { ok: false, kind: "refused", reason: `${system.package}: ${real} printed no version this build understands` };
  }
  // The version the program printed travels with the refusal, so the report
  // can name the version that is there and not the pin.
  const fit = versionFits(asset.version, version);
  if (fit === "invalid") return { ok: false, kind: "refused", reason: `${system.package}: this build cannot read a version from it`, version };
  if (fit === "older") {
    return { ok: false, kind: "refused", reason: `${system.package} ${version} is older than the pinned ${asset.version}: pkg upgrade ${system.package}`, version };
  }
  if (fit === "other-series") {
    const pinned = versionParts(asset.version) as [number, number, number];
    return { ok: false, kind: "refused", reason: `${system.package} ${version} is outside the pinned ${pinned[0]}.${pinned[1]} series (this build pins ${asset.version})`, version };
  }
  return { ok: true, path: real, version };
}

// The program of a system asset, with the version it reports, or the plain
// reason it cannot be used. The program is checked once per process, and
// the answer is kept. `timeoutMs` shortens the version probe, for a test
// that must not wait for it.
export function resolveSystemAsset(tool: string, recipe: Recipe, asset: SystemAsset, opts: { timeoutMs?: number } = {}): Promise<SystemResolution> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const system = asset.system;
  const key = [tool, recipe.method, localbase(), system.path, system.package, system.versionPattern, system.versionArgs.join(" "), asset.version, String(timeoutMs)].join("\0");
  const kept = resolutions.get(key);
  if (kept !== undefined) return kept;
  const checked = checkNow(tool, recipe, asset, timeoutMs);
  resolutions.set(key, checked);
  return checked;
}
