// Installs one pinned tool into an install root: the OpenQodex home's tools
// folder inside the detached install process (`openqodex __install <tool>`),
// so a slow install finishes even when the run that started it has exited,
// or the root a preinstall names (preinstall.ts).
import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { ResolvedTool } from "@openqodex/core";
import { InstallError, downloadVerified, extractArchive, isRegularFileInside, run, smallEnv, which } from "./fetch.js";
import {
  binaryPath,
  currentPlatform,
  homePlace,
  loadToolchain,
  lockFile,
  markerPath,
  toolDir,
  versionDir,
  type InstallPlace,
  type Recipe,
  type Toolchain,
} from "./table.js";

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
// How long an install waits for another process's install of the same tool.
const LOCK_WAIT_MS = 40 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isInstalled(root: string, tool: string, recipe: Recipe): boolean {
  return existsSync(markerPath(root, tool, recipe)) && existsSync(binaryPath(root, tool, recipe));
}

// ---------- the developer's runtimes (never installed by OpenQodex) ----------

type Runtime = { reason: string | null; env: Record<string, string> };

// Go never downloads a toolchain or a module and never sends a module path
// anywhere: not while probing, not while scanning.
const GO_OFFLINE = { GOTOOLCHAIN: "local", GOPROXY: "off" };

const runtimeNames: Record<string, string> = { ruby: "Ruby", go: "Go", cargo: "Cargo (Rust)" };

// Where the developer keeps Rust: the toolchains (rustup) and the crate
// cache (Cargo). Paths, not secrets; a probe and a scan need them when they
// are not the defaults under the home folder.
function rustHomes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["CARGO_HOME", "RUSTUP_HOME"]) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  return out;
}

function parseNeeds(needs: string | undefined): { runtime: string; minimum: string | null } | null {
  if (!needs) return null;
  const match = /^([a-z]+)(?:>=([0-9.]+))?$/.exec(needs);
  if (!match) throw new Error(`toolchain.json: cannot read needs "${needs}"`);
  return { runtime: match[1]!, minimum: match[2] ?? null };
}

function atLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < b.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// The full PATH a tool needs: its own folders first, then the current PATH.
// Scanners start from a small allowlisted environment and `env` is applied on
// top, so a PATH here replaces the whole value and must carry everything.
function pathWith(first: string[]): string {
  return [...first, process.env.PATH ?? ""].filter((p) => p !== "").join(delimiter);
}

// One probe per runtime: its version, plus what a scanner run needs from it.
// Probes run in the user's home folder, never the repo, so a repo's go.mod or
// .ruby-version cannot change what they do.
async function probe(runtime: string, file: string): Promise<{ version: string; env: Record<string, string> } | null> {
  const opts = { cwd: homedir(), timeoutMs: PROBE_TIMEOUT_MS };
  if (runtime === "go") {
    const out = await run(file, ["env", "GOVERSION", "GOPATH", "GOMODCACHE", "GOCACHE"], { ...opts, env: smallEnv(GO_OFFLINE) });
    if (out.code !== 0) return null;
    const [goversion = "", gopath = "", modcache = "", cache = ""] = out.stdout.split("\n");
    const env: Record<string, string> = { ...GO_OFFLINE, PATH: pathWith([dirname(file)]) };
    if (gopath) env.GOPATH = gopath;
    if (modcache) env.GOMODCACHE = modcache;
    if (cache) env.GOCACHE = cache;
    return { version: goversion.replace(/^go/, ""), env };
  }
  if (runtime === "cargo") {
    // The toolchain `cargo` resolves to from the home folder, named by its
    // real files. A rustup proxy started inside a project would follow the
    // project's rust-toolchain.toml and could install the toolchain it
    // names; the real cargo and rustc read no such file. RUSTUP_AUTO_INSTALL
    // keeps the probe itself from installing one.
    const rustup = smallEnv({ ...rustHomes(), RUSTUP_AUTO_INSTALL: "0" });
    const version = await run(file, ["--version"], { ...opts, env: rustup });
    if (version.code !== 0) return null;
    const rustc = join(dirname(file), "rustc");
    const rustcFile = existsSync(rustc) ? rustc : which("rustc");
    if (rustcFile === null) return null;
    const sysroot = await run(rustcFile, ["--print", "sysroot"], { ...opts, env: rustup });
    const bin = join(sysroot.stdout.trim(), "bin");
    if (sysroot.code !== 0 || !existsSync(join(bin, "cargo")) || !existsSync(join(bin, "rustc"))) return null;
    // CARGO and RUSTC by path; no rustc wrapper, whatever a config names;
    // Cargo never goes to the network.
    const env: Record<string, string> = {
      ...rustHomes(),
      PATH: pathWith([bin]),
      CARGO: join(bin, "cargo"),
      RUSTC: join(bin, "rustc"),
      RUSTC_WRAPPER: "",
      RUSTC_WORKSPACE_WRAPPER: "",
      CARGO_NET_OFFLINE: "true",
      RUSTUP_AUTO_INSTALL: "0",
    };
    return { version: /(\d+\.\d+(?:\.\d+)?)/.exec(version.stdout)?.[1] ?? "", env };
  }
  const args = runtime === "ruby" ? ["-e", "print RUBY_VERSION"] : ["--version"];
  const out = await run(file, args, { ...opts, env: smallEnv() });
  if (out.code !== 0) return null;
  return { version: /(\d+\.\d+(?:\.\d+)?)/.exec(out.stdout)?.[1] ?? "", env: { PATH: pathWith([dirname(file)]) } };
}

const runtimeChecks = new Map<string, Promise<Runtime>>();

// Whether the developer's runtime for this tool is here, and the environment
// the tool needs from it. Checked once per process.
export function checkRuntime(recipe: Recipe): Promise<Runtime> {
  const needs = parseNeeds(recipe.needs);
  if (!needs) return Promise.resolve({ reason: null, env: {} });
  const key = `${needs.runtime}>=${needs.minimum ?? ""}|${process.env.PATH ?? ""}`;
  let check = runtimeChecks.get(key);
  if (!check) {
    check = (async () => {
      const name = runtimeNames[needs.runtime] ?? needs.runtime;
      const reason = needs.minimum ? `needs ${name} ${needs.minimum} or newer` : `needs ${name}`;
      const file = which(needs.runtime);
      const found = file ? await probe(needs.runtime, file) : null;
      if (!found) return { reason, env: {} };
      if (needs.minimum && !(found.version && atLeast(found.version, needs.minimum))) return { reason, env: {} };
      return { reason: null, env: found.env };
    })();
    runtimeChecks.set(key, check);
  }
  return check;
}

export async function missingRuntime(recipe: Recipe): Promise<string | null> {
  return (await checkRuntime(recipe)).reason;
}

// The resolved tool, with the environment it needs to start from the small
// scanner environment.
export async function resolvedTool(root: string, tool: string, recipe: Recipe): Promise<ResolvedTool> {
  const dir = versionDir(root, tool, recipe);
  const runtime = await checkRuntime(recipe);
  let env: Record<string, string> = {};
  if (recipe.method === "uv") {
    // semgrep's launcher starts pysemgrep from PATH; the tool's bin folder holds it.
    env.PATH = pathWith([join(dir, "bin")]);
  } else if (recipe.method === "gem") {
    const ruby = runtime.env.PATH ? [runtime.env.PATH.split(delimiter)[0]!] : [];
    env = { GEM_HOME: dir, GEM_PATH: dir, PATH: pathWith([join(dir, "bin"), ...ruby]) };
  } else {
    env = { ...runtime.env };
  }
  return { path: binaryPath(root, tool, recipe), version: recipe.version, env };
}

// The plain reason this machine has no way to get the tool, or null.
export function unsupportedReason(table: Toolchain, recipe: Recipe): string | null {
  const platform = currentPlatform();
  if (recipe.method === "github-release") {
    return platform && recipe.assets[platform] ? null : "no download for this platform";
  }
  if (recipe.method === "uv") {
    if (which("uv")) return null;
    const uv = table.tools.uv;
    return platform && uv?.method === "github-release" && uv.assets[platform] ? null : "no download for this platform";
  }
  return null;
}

export function cannotWriteReason(owner: string): string {
  return `cannot write ${owner} here: run \`npx openqodex doctor --install\` in this repository from your own terminal`;
}

// Creates the tool folder, or throws the plain reason it cannot be written.
export function ensureWritable(place: InstallPlace, tool: string): string {
  const dir = toolDir(place.root, tool);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    throw new InstallError("not_installed", cannotWriteReason(place.owner));
  }
  return dir;
}

// ---------- the per-tool lock ----------
// The lock file holds "<pid> <token>". It is created atomically with its
// content (a hard link of a finished temp file), counts as stale only when its
// pid is no longer alive, and is released only by the holder of its token.
//
// Node has no kernel file lock, so one window remains: two takers that both
// re-checked the same dead holder can both rename over the lock, and the first
// may read back its own token before the second renames. Both then install.
// That cannot leave a half install that looks installed: every worker builds
// in a folder only it created and deletes only that folder, the version
// becomes visible through one atomic rename of a finished folder (with its
// marker already inside), and a worker that finds the version already in
// place, or no longer reads its own token before publishing, discards its own
// work. The cost of the window is a duplicated download, nothing more.

function lockPath(root: string, tool: string): string {
  return join(toolDir(root, tool), ".lock");
}

export function readLock(path: string): { pid: number; token: string } | null {
  try {
    const [pid = "", token = ""] = readFileSync(path, "utf8").trim().split(/\s+/);
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), token } : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// True while a live process holds the lock on this tool.
export function isLocked(root: string, tool: string): boolean {
  const holder = readLock(lockPath(root, tool));
  return holder !== null && isAlive(holder.pid);
}

export function holdsLock(root: string, tool: string, token: string): boolean {
  return readLock(lockPath(root, tool))?.token === token;
}

// Replaces a stale lock with the taker's own finished lock file. `observed` is
// the holder seen dead earlier; the lock is re-read right before the rename and
// the takeover goes ahead only if it is still that same dead holder. Returns
// true when the lock read back afterwards carries the taker's token.
export function takeOverStaleLock(lock: string, observed: { pid: number; token: string } | null, mine: string, token: string): boolean {
  const now = readLock(lock);
  const same = now === null ? observed === null : observed !== null && now.token === observed.token && now.pid === observed.pid;
  if (!same || (now !== null && isAlive(now.pid))) return false;
  try {
    renameSync(mine, lock);
  } catch {
    return false;
  }
  return readLock(lock)?.token === token;
}

export async function acquireLock(place: InstallPlace, tool: string): Promise<string> {
  const dir = toolDir(place.root, tool);
  const lock = lockPath(place.root, tool);
  const token = randomBytes(8).toString("hex");
  const mine = join(dir, `.lock-${token}`);
  const giveUp = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      writeFileSync(mine, `${process.pid} ${token}\n`);
      try {
        linkSync(mine, lock);
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new InstallError("not_installed", cannotWriteReason(place.owner));
      }
      const holder = readLock(lock);
      if (holder === null || !isAlive(holder.pid)) {
        if (takeOverStaleLock(lock, holder, mine, token)) return token;
        continue;
      }
      if (Date.now() > giveUp) throw new InstallError("failed", `another install of ${tool} did not finish`);
      await sleep(250);
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

export function releaseLock(root: string, tool: string, token: string): void {
  if (holdsLock(root, tool, token)) rmSync(lockPath(root, tool), { force: true });
}

async function withLock<T>(place: InstallPlace, tool: string, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await acquireLock(place, tool);
  try {
    return await fn(token);
  } finally {
    releaseLock(place.root, tool, token);
  }
}

// ---------- install methods ----------

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim().slice(0, 200);
}

function writeMarker(dir: string, version: string): void {
  writeFileSync(join(dir, ".installed"), `${JSON.stringify({ version, installedAt: new Date().toISOString() })}\n`);
}

type Published = "published" | "already_installed" | "lost_lock";

// Makes `built` (a finished folder with its marker inside, created by this
// worker) the installed version with one atomic rename: the folder itself
// (`move`) or a link to it (`link`, for installs that cannot move). Before
// that, the worker must still read its own token in the lock; when it does
// not, or the version is already installed, it deletes its own folder and
// publishes nothing.
export function publishVersion(
  root: string,
  tool: string,
  recipe: Recipe,
  built: string,
  token: string,
  how: "move" | "link",
): Published {
  const final = versionDir(root, tool, recipe);
  const discard = (result: Published): Published => {
    rmSync(built, { recursive: true, force: true });
    return result;
  };
  if (isInstalled(root, tool, recipe)) return discard("already_installed");
  if (!holdsLock(root, tool, token)) return discard("lost_lock");
  // A version folder without its marker is debris from an install that died
  // under the earlier in-place layout; no live worker writes there any more.
  if (existsSync(final) || isSymlink(final)) rmSync(final, { recursive: true, force: true });
  try {
    if (how === "move") {
      renameSync(built, final);
    } else {
      const link = `${built}.link`;
      symlinkSync(basename(built), link);
      renameSync(link, final);
    }
  } catch (error) {
    if (isInstalled(root, tool, recipe)) return discard("already_installed");
    throw error;
  }
  return "published";
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Download, verify, unpack into this worker's own staging folder, then publish
// the finished version folder, so a half install never looks installed.
async function installRelease(
  root: string,
  tool: string,
  recipe: Extract<Recipe, { method: "github-release" }>,
  token: string,
): Promise<Published> {
  const platform = currentPlatform();
  const asset = platform ? recipe.assets[platform] : null;
  if (!asset) throw new InstallError("not_installed", "no download for this platform");
  const dir = toolDir(root, tool);
  const staging = mkdtempSync(join(dir, ".staging-"));
  try {
    const download = join(staging, "download");
    await downloadVerified(asset.url, asset.sha256, download);
    let source = download;
    if (asset.archive !== "none") {
      const unpacked = join(staging, "unpacked");
      mkdirSync(unpacked);
      await extractArchive(download, asset.archive, unpacked);
      source = join(unpacked, asset.binaryPath);
      // Only bytes the checksum covered: a regular file inside the unpacked folder.
      if (!isRegularFileInside(source, unpacked)) {
        throw new InstallError("failed", `install failed: ${asset.binaryPath} is not a file in ${asset.name}`);
      }
    }
    const ready = join(staging, "version");
    mkdirSync(join(ready, "bin"), { recursive: true });
    const target = join(ready, "bin", recipe.binary);
    renameSync(source, target);
    chmodSync(target, 0o755);
    writeMarker(ready, recipe.version);
    return publishVersion(root, tool, recipe, ready, token, "move");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// npm next to the running node, so no PATH lookup decides which npm runs.
export function npmCommand(): { file: string; args: string[] } | null {
  const beside = join(dirname(process.execPath), "npm");
  if (!existsSync(beside)) return null;
  const real = realpathSync(beside);
  return /\.c?js$/.test(real) ? { file: process.execPath, args: [real] } : { file: real, args: [] };
}

// Installers run with the small environment plus what OpenQodex sets, in the
// folder that holds the install place (the OpenQodex home on the laptop) or
// a folder of the install's own, never the repo: a variable or a project
// config file cannot change where they read from or write to.
async function runInstaller(cwd: string, file: string, args: string[], extra: Record<string, string>): Promise<void> {
  const out = await run(file, args, { cwd, env: smallEnv(extra), timeoutMs: INSTALL_TIMEOUT_MS });
  if (out.timedOut) throw new InstallError("failed", "install failed: not finished after 20 minutes");
  if (out.code !== 0) throw new InstallError("failed", `install failed: ${lastLine(out.stderr) || `exit ${out.code}`}`);
}

// Tools installed by a package manager cannot be moved after install (absolute
// paths in scripts), so each worker installs into a folder of its own that
// stays where it is, writes the marker there, and publishes the version as a
// link to it.
async function installInPlace(place: InstallPlace, tool: string, recipe: Recipe, table: Toolchain, token: string): Promise<Published> {
  const dir = mkdtempSync(join(toolDir(place.root, tool), `.build-${recipe.version}-`));
  chmodSync(dir, 0o755);
  try {
    if (recipe.method === "uv") {
      const lock = lockFile(tool);
      if (lock === null) throw new InstallError("not_installed", "no lock file for this platform");
      const uv = which("uv") ?? (await installTool("uv", { table, place })).path;
      const python = join(place.root, "uv-python");
      const env = {
        UV_PYTHON_INSTALL_DIR: python,
        UV_PYTHON_BIN_DIR: join(python, "bin"),
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_CACHE_DIR: join(place.cache, "uv"),
        UV_NO_PROGRESS: "1",
      };
      // A Python environment of the tool's own, then exactly the packages of
      // the lock: --require-hashes refuses any file whose sha256 the lock
      // does not name, --no-deps adds nothing the lock leaves out, and
      // --only-binary installs wheels only, so no package's build script runs.
      await runInstaller(place.owner, uv, ["venv", "--quiet", "--allow-existing", "--python", recipe.python, dir], env);
      await runInstaller(
        place.owner,
        uv,
        ["pip", "install", "--quiet", "--python", join(dir, "bin", "python"), "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", lock],
        env,
      );
    } else if (recipe.method === "gem") {
      const lock = lockFile(tool);
      if (lock === null) throw new InstallError("not_installed", "no lock file for this platform");
      const ruby = which("ruby");
      const gem = ruby && existsSync(join(dirname(ruby), "gem")) ? join(dirname(ruby), "gem") : which("gem");
      if (!gem) throw new InstallError("not_installed", "needs RubyGems");
      // Every gem of the lock, downloaded into a folder of this install's own
      // and checked against its sha256; then `gem install --local` from that
      // folder installs the recipe's gems, their dependencies taken from
      // those files or from the gems Ruby ships, never from the network.
      const files = join(dir, ".gems");
      mkdirSync(files);
      for (const entry of readGemLock(lock)) {
        await downloadVerified(`https://rubygems.org/downloads/${entry.name}-${entry.version}.gem`, entry.sha256, join(files, `${entry.name}-${entry.version}.gem`));
      }
      const tops = recipe.gems.map((spec) => `${spec.replace(":", "-")}.gem`);
      const args = ["install", "--local", "--no-document", "--install-dir", dir, "--bindir", join(dir, "bin"), ...tops];
      await runInstaller(files, gem, args, { GEM_HOME: dir, GEM_PATH: dir, GEM_SPEC_CACHE: join(place.cache, "gem-specs") });
      rmSync(files, { recursive: true, force: true });
    }
    const bin = join(dir, "bin", recipe.binary);
    if (!existsSync(bin)) throw new InstallError("failed", `install failed: ${recipe.binary} missing after install`);
    writeMarker(dir, recipe.version);
    return publishVersion(place.root, tool, recipe, dir, token, "link");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// The gems of a gem lock: `<name> <version> sha256:<hex>` per line, `#`
// lines are notes. A line in any other shape stops the install.
export function readGemLock(file: string): { name: string; version: string; sha256: string }[] {
  const out: { name: string; version: string; sha256: string }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [name = "", version = "", hash = ""] = line.trim().split(" ");
    const sha256 = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : "";
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !/^[0-9][0-9.]*$/.test(version) || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new InstallError("failed", `install failed: cannot read the lock line "${line.slice(0, 80)}"`);
    }
    out.push({ name, version, sha256 });
  }
  return out;
}

// Installs one tool from the table and returns it. Throws InstallError with the
// plain reason. Safe to call from several processes at once: one installs, the
// others wait on the lock and then find it installed. `place`: where it
// goes, by default the OpenQodex home's tools folder.
export async function installTool(
  tool: string,
  opts: { table?: Toolchain; onProgress?: (line: string) => void; place?: InstallPlace } = {},
): Promise<ResolvedTool> {
  const table = opts.table ?? loadToolchain();
  const recipe = table.tools[tool];
  if (!recipe) throw new InstallError("failed", `${tool} is not in the toolchain table`);
  const place = opts.place ?? homePlace();
  const root = place.root;
  const runtime = await missingRuntime(recipe);
  if (runtime) throw new InstallError("not_installed", runtime);
  if (isInstalled(root, tool, recipe)) return resolvedTool(root, tool, recipe);
  const unsupported = unsupportedReason(table, recipe);
  if (unsupported) throw new InstallError("not_installed", unsupported);
  const dir = ensureWritable(place, tool);
  // A worker that lost the lock to another installer goes back to waiting on
  // the lock, then finds the other's install in place.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await withLock(place, tool, async (token) => {
      if (isInstalled(root, tool, recipe)) return "already_installed" as const;
      opts.onProgress?.(`installing ${tool} ${recipe.version} (first run only)`);
      const published =
        recipe.method === "github-release"
          ? await installRelease(root, tool, recipe, token)
          : await installInPlace(place, tool, recipe, table, token);
      if (published === "published") {
        appendFileSync(join(dir, "install.log"), `${new Date().toISOString()} installed ${tool} ${recipe.version}\n`);
      }
      return published;
    });
    if (result !== "lost_lock" && isInstalled(root, tool, recipe)) return resolvedTool(root, tool, recipe);
  }
  throw new InstallError("failed", "install failed: another install kept taking the lock");
}

// ---------- the detached install process ----------

function errorPath(root: string, tool: string): string {
  return join(toolDir(root, tool), ".error");
}

// The reason the last install of this tool failed, if it did.
export function lastInstallError(root: string, tool: string): { status: "not_installed" | "failed"; reason: string } | null {
  try {
    return JSON.parse(readFileSync(errorPath(root, tool), "utf8")) as { status: "not_installed" | "failed"; reason: string };
  } catch {
    return null;
  }
}

// One install in this process, for `openqodex __install <tool>` (index.ts
// checks the entry first). Returns the exit code: 0 installed, 1 failed with
// the reason saved for the run that started it.
export async function runInstall(tool: string): Promise<number> {
  const root = homePlace().root;
  rmSync(errorPath(root, tool), { force: true });
  try {
    await installTool(tool);
    return 0;
  } catch (error) {
    const failure =
      error instanceof InstallError
        ? error
        : new InstallError("failed", `install failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      mkdirSync(toolDir(root, tool), { recursive: true });
      writeFileSync(errorPath(root, tool), JSON.stringify({ status: failure.status, reason: failure.message }));
    } catch {
      // the home folder cannot be written; the caller already reports that
    }
    process.stderr.write(`${tool}: ${failure.message}\n`);
    return 1;
  }
}
