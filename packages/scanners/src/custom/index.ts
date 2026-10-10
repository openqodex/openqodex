// Custom scanners from .openqodex.yaml: resolving what an entry would run,
// the developer's approval, and the adapters the runner calls. An entry runs
// only while the approval recorded for this repo matches its exact contents;
// before that nothing from it is executed or installed onto a tool path.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { OpenQodexError, customEntryHash, matchesGlob } from "@openqodex/core";
import type { Config, CustomScanner, ScannerSource, StaticFinding } from "@openqodex/core";
import { ARG_BUDGET_BYTES, describeFailure, execTool, splitArgs, stderrTail } from "../exec.js";
import { parseJsonMap } from "../formats/json-map.js";
import { parseSarif } from "../formats/sarif.js";
import type { CustomAdapter } from "../run.js";
import { extractArchive, isRegularFileInside, run, smallEnv, which } from "../toolchain/fetch.js";
import { installTool, isLocked, npmCommand, readLock, releaseLock } from "../toolchain/install.js";
import { openqodexHome, toolDir, toolsDir, type ArchiveKind } from "../toolchain/table.js";
import { expandArgs, splitCommand } from "./command.js";
import { resolveRelease } from "./release.js";

// What `openqodex trust` shows before the yes: the exact thing that will run.
export type ResolvedArtifact = {
  version: string;
  // The release asset; for npm and uv the exact pinned spec; null for PATH.
  assetName: string | null;
  url: string | null;
  // The download's hash, or for PATH the binary's own hash.
  sha256: string | null;
  checksumSource: "upstream" | "first-download" | null;
  binary: string;
  quarantinePath: string | null; // the downloaded file, not yet installed or executed
};

export type TrustRecord = {
  repoRoot: string;
  name: string;
  entryHash: string;
  artifact: ResolvedArtifact;
  approvedAt: string;
};

export type TrustRow = {
  entry: CustomScanner;
  state: "trusted" | "untrusted" | "changed";
  record: TrustRecord | null;
};

const REPORT_MAX_BYTES = 8 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const LOCK_WAIT_MS = 10_000;

const NOT_APPROVED = "not approved yet: run `openqodex trust`";
const ENTRY_CHANGED = "changed since it was approved: run `openqodex trust`";
const BINARY_CHANGED = "the approved binary changed: run `openqodex trust`";

// The program named by the run line, before it is replaced by the installed path.
function commandName(entry: CustomScanner): string {
  const first = splitCommand(entry.run)[0];
  if (!first) throw new OpenQodexError(`${entry.name}: run is empty`);
  return first;
}

const sha256Of = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The exact version an npm or uv spec pins, or null when it pins none.
const NPM_PIN = /^((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const UV_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?)==([0-9][0-9A-Za-z.+!-]*)$/;
function pinnedVersion(spec: string, kind: "npm" | "uv"): string | null {
  return (kind === "npm" ? NPM_PIN : UV_PIN).exec(spec.trim())?.[2] ?? null;
}

// A binary on PATH, looked up through absolute PATH entries only, as its real path.
function fromPath(name: string): string | null {
  if (name.includes("/")) return isAbsolute(name) && existsSync(name) ? realpathSync(name) : null;
  const absolute = (process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir)).join(delimiter);
  const found = which(name, absolute);
  return found ? realpathSync(found) : null;
}

// Reads the release, picks the asset for this OS and CPU, downloads it to
// quarantine without executing it. Throws OpenQodexError listing the candidate
// assets when none or several match.
export async function resolveCustomArtifact(entry: CustomScanner): Promise<ResolvedArtifact> {
  const name = commandName(entry);
  const install = entry.install;
  switch (install.kind) {
    case "github-release":
      return resolveRelease({ ...entry, install }, install.binary ?? name);
    case "path": {
      const found = fromPath(name);
      if (!found) throw new OpenQodexError(`${entry.name}: ${name} is not on PATH (only absolute PATH entries are searched)`);
      const version = entry.version ?? "path";
      return { version, assetName: null, url: null, sha256: sha256Of(found), checksumSource: null, binary: found, quarantinePath: null };
    }
    case "npm":
    case "uv": {
      const pin = pinnedVersion(install.spec, install.kind);
      const form = install.kind === "npm" ? "name@1.2.3" : "name==1.2.3";
      if (!pin) throw new OpenQodexError(`${entry.name}: ${install.kind} "${install.spec}" must name an exact version (${form})`);
      if (entry.version !== null && entry.version.replace(/^v/, "") !== pin) {
        throw new OpenQodexError(`${entry.name}: version ${entry.version} differs from the exact version ${pin} in "${install.spec}"`);
      }
      return { version: pin, assetName: install.spec.trim(), url: null, sha256: null, checksumSource: null, binary: name, quarantinePath: null };
    }
  }
}

// ---------- the trust file ----------

type TrustFile = { version: 1; records: TrustRecord[] };

const trustPath = () => join(openqodexHome(), "trust.json");

function repoKey(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return resolve(repoRoot);
  }
}

function readTrust(): TrustFile {
  const path = trustPath();
  if (!existsSync(path)) return { version: 1, records: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as TrustFile;
    if (!Array.isArray(data.records)) throw new Error("no records");
    return data;
  } catch {
    throw new OpenQodexError(`${path} is not readable: fix or delete it, then run \`openqodex trust\` again`);
  }
}

const LOCK_NAME = "custom";
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One cross-process lock (the toolchain's lock file for the custom tool
// folder) around every change to approvals. Trust changes are rare and started
// by a person, so it fails closed: a lock left by a dead process is never
// taken over automatically; the developer is told to delete it.
type TrustLock = { home: string; token: string };

// One attempt: the lock when it was free, null while a live process holds it.
function tryLock(): TrustLock | null {
  const home = openqodexHome();
  const dir = toolDir(toolsDir(home), LOCK_NAME);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const token = randomBytes(8).toString("hex");
  const mine = join(dir, `.lock-${token}`);
  try {
    writeFileSync(mine, `${process.pid} ${token}\n`);
    try {
      linkSync(mine, lock);
      return { home, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new OpenQodexError(`cannot write ${home}`);
    }
  } finally {
    rmSync(mine, { force: true });
  }
  // The holder is stale only when the same holder is seen before and after a
  // liveness check that failed; a lock released or passed on meanwhile is retried.
  const holder = readLock(lock);
  if (holder === null || isLocked(toolsDir(home), LOCK_NAME)) return null;
  if (readLock(lock)?.token === holder.token) {
    throw new OpenQodexError(`${lock} was left by an openqodex process that is no longer running: delete it and run the command again`);
  }
  return null;
}

const busy = () =>
  new OpenQodexError(`${join(toolDir(toolsDir(openqodexHome()), LOCK_NAME), ".lock")}: another openqodex process kept approvals locked for ${LOCK_WAIT_MS / 1000} seconds; run the command again when it has finished`);

function lockSync(): TrustLock {
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const held = tryLock();
    if (held) return held;
    if (Date.now() > giveUp) throw busy();
    sleepSync(50);
  }
}

async function lockAsync(): Promise<TrustLock> {
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const held = tryLock();
    if (held) return held;
    if (Date.now() > giveUp) throw busy();
    await sleep(50);
  }
}

const unlock = ({ home, token }: TrustLock) => releaseLock(toolsDir(home), LOCK_NAME, token);

// Read, edit and write trust.json. The caller holds the lock.
function editTrust(edit: (records: TrustRecord[]) => TrustRecord[]): void {
  const file = readTrust();
  const path = trustPath();
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...file, records: edit(file.records) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function sameBytes(record: TrustRecord): boolean {
  try {
    return sha256Of(record.artifact.binary) === record.artifact.sha256;
  } catch {
    return false; // gone or unreadable
  }
}

type Assessed = TrustRow & { reason: string | null };

function assess(repoRoot: string, config: Config): Assessed[] {
  const key = repoKey(repoRoot);
  const records = readTrust().records.filter((r) => r.repoRoot === key);
  return config.custom.map((entry) => {
    const record = records.find((r) => r.name === entry.name) ?? null;
    if (record === null) return { entry, record, state: "untrusted", reason: NOT_APPROVED };
    if (record.entryHash !== customEntryHash(entry)) return { entry, record, state: "changed", reason: ENTRY_CHANGED };
    // A binary from PATH is not ours to keep: check it is the same bytes every time.
    if (entry.install.kind === "path" && !sameBytes(record)) return { entry, record, state: "changed", reason: BINARY_CHANGED };
    return { entry, record, state: "trusted", reason: null };
  });
}

export function trustState(repoRoot: string, config: Config): TrustRow[] {
  return assess(repoRoot, config).map(({ entry, state, record }) => ({ entry, state, record }));
}

export function revoke(repoRoot: string, name: string): void {
  const key = repoKey(repoRoot);
  const lock = lockSync();
  try {
    editTrust((records) => records.filter((r) => !(r.repoRoot === key && r.name === name)));
  } finally {
    unlock(lock);
  }
}

// True when `path` is `dir` or below it. "..tools" is a folder inside; only
// ".." itself or ".." followed by a separator leaves.
function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// ---------- install on approval ----------

function archiveKind(name: string): ArchiveKind | null {
  if (/\.(tar\.gz|tgz)$/i.test(name)) return "tar.gz";
  if (/\.tar\.xz$/i.test(name)) return "tar.xz";
  if (/\.zip$/i.test(name)) return "zip";
  return null;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

// Every regular file under `dir` whose name is `name`.
function findFiles(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, name));
    else if (entry.isFile() && entry.name === name) found.push(path);
  }
  return found;
}

// Written last into an install folder: the binary's path inside it.
const MARKER = ".approved";
function installedBinary(folder: string): string | null {
  try {
    const rel = (JSON.parse(readFileSync(join(folder, MARKER), "utf8")) as { binary: string }).binary;
    const binary = join(folder, rel);
    return inside(folder, binary) ? binary : null;
  } catch {
    return null;
  }
}

// Unpacks the quarantined download into a staging folder, then moves it into
// place. Returns the absolute path of the binary. Only a regular file the
// checksum covered can become the binary: never a link, never outside.
async function installRelease(entry: CustomScanner, artifact: ResolvedArtifact, folder: string): Promise<string> {
  const quarantined = artifact.quarantinePath;
  if (!quarantined || !existsSync(quarantined)) {
    throw new OpenQodexError(`${entry.name}: the download is no longer in quarantine; run \`openqodex trust\` again`);
  }
  if ((await fileSha256(quarantined)) !== artifact.sha256) {
    throw new OpenQodexError(`${entry.name}: the quarantined download changed after it was checked; run \`openqodex trust\` again`);
  }
  const staging = mkdtempSync(join(dirname(folder), ".staging-"));
  try {
    const tree = join(staging, "tree");
    mkdirSync(tree);
    const kind = artifact.assetName ? archiveKind(artifact.assetName) : null;
    let binary: string;
    if (kind) {
      await extractArchive(quarantined, kind, tree);
      const wanted = artifact.binary;
      const hits = wanted.includes("/") ? [join(tree, wanted)] : findFiles(tree, wanted);
      if (hits.length !== 1) {
        throw new OpenQodexError(
          `${entry.name}: ${hits.length === 0 ? "no" : "more than one"} file named ${wanted} in ${artifact.assetName}; set install: { binary: "<path inside the archive>" }`,
        );
      }
      binary = hits[0]!;
    } else {
      mkdirSync(join(tree, "bin"));
      binary = join(tree, "bin", "tool");
      renameSync(quarantined, binary);
    }
    if (!isRegularFileInside(binary, tree)) {
      throw new OpenQodexError(`${entry.name}: ${artifact.binary} is not a regular file inside ${artifact.assetName}`);
    }
    chmodSync(binary, 0o755);
    const rel = relative(tree, binary);
    writeFileSync(join(tree, MARKER), `${JSON.stringify({ binary: rel })}\n`);
    renameSync(tree, folder);
    return join(folder, rel);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// npm and uv tools keep absolute paths in their scripts, so they install in
// place, the same way the pinned toolchain installs them.
async function installPackage(entry: CustomScanner, spec: string, kind: "npm" | "uv", folder: string): Promise<string> {
  const home = openqodexHome();
  const name = commandName(entry);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  try {
    let file: string;
    let args: string[];
    let extra: Record<string, string> = {};
    let binary: string;
    if (kind === "npm") {
      const npm = npmCommand();
      if (!npm) throw new OpenQodexError(`${entry.name}: needs npm`);
      file = npm.file;
      args = [...npm.args, "install", "--prefix", folder, "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--cache", join(home, "cache", "npm"), spec];
      binary = join(folder, "node_modules", ".bin", name);
    } else {
      file = which("uv") ?? (await installTool("uv")).path;
      args = ["tool", "install", spec];
      const python = join(toolsDir(home), "uv-python");
      extra = {
        UV_PYTHON_INSTALL_DIR: python,
        UV_PYTHON_BIN_DIR: join(python, "bin"),
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_TOOL_DIR: join(folder, "uv-tools"),
        UV_TOOL_BIN_DIR: join(folder, "bin"),
        UV_CACHE_DIR: join(home, "cache", "uv"),
        UV_NO_PROGRESS: "1",
      };
      binary = join(folder, "bin", name);
    }
    const out = await run(file, args, { cwd: home, env: smallEnv(extra), timeoutMs: INSTALL_TIMEOUT_MS });
    if (out.timedOut) throw new OpenQodexError(`${entry.name}: install not finished after 20 minutes`);
    if (out.code !== 0) throw new OpenQodexError(`${entry.name}: install failed: ${out.stderr.trim().split("\n").pop() ?? `exit ${out.code}`}`);
    // The package manager links the binary; what it points at must be inside the install.
    let real: string;
    try {
      real = realpathSync(binary);
    } catch {
      throw new OpenQodexError(`${entry.name}: ${name} is missing after installing ${spec}`);
    }
    if (!real.startsWith(realpathSync(folder) + sep) || !statSync(real).isFile()) {
      throw new OpenQodexError(`${entry.name}: ${name} does not point at a file inside the install`);
    }
    writeFileSync(join(folder, MARKER), `${JSON.stringify({ binary: relative(folder, binary) })}\n`);
    return binary;
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

// Records the approval and installs the quarantined artifact. Each approval
// installs into its own folder, named by a hash of the entry and the exact
// artifact, never by text from the entry or the release; an existing
// approved folder is reused, never replaced.
export async function approve(repoRoot: string, entry: CustomScanner, artifact: ResolvedArtifact): Promise<void> {
  // Held across the marker check, the install and the record write, so two
  // approvals of the same artifact never touch one folder at the same time.
  const lock = await lockAsync();
  try {
    await approveLocked(repoRoot, entry, artifact);
  } finally {
    unlock(lock);
  }
}

async function approveLocked(repoRoot: string, entry: CustomScanner, artifact: ResolvedArtifact): Promise<void> {
  const home = openqodexHome();
  const key = repoKey(repoRoot);
  const entryHash = customEntryHash(entry);
  let binary = artifact.binary;
  const install = entry.install;
  if (install.kind === "path") {
    if (!isAbsolute(binary) || sha256Of(binary) !== artifact.sha256) {
      throw new OpenQodexError(`${entry.name}: ${binary} changed after it was checked; run \`openqodex trust\` again`);
    }
    if (inside(key, realpathSync(binary))) {
      throw new OpenQodexError(`${entry.name}: ${binary} is inside the repo; a checkout could replace it, so it cannot be approved`);
    }
  } else {
    const identity = install.kind === "github-release" ? artifact.sha256 : `${install.kind}:${artifact.assetName}`;
    const id = createHash("sha256").update(`${entryHash}\n${identity}`).digest("hex").slice(0, 32);
    const folder = join(home, "tools", "custom", id);
    mkdirSync(dirname(folder), { recursive: true });
    const existing = installedBinary(folder);
    if (existing) binary = existing;
    else {
      // A folder without its marker is an install that died part way.
      rmSync(folder, { recursive: true, force: true });
      binary =
        install.kind === "github-release"
          ? await installRelease(entry, artifact, folder)
          : await installPackage(entry, install.spec, install.kind, folder);
    }
    if (install.kind === "github-release" && artifact.quarantinePath) {
      const rel = relative(join(home, "quarantine"), artifact.quarantinePath).split(sep);
      if (rel.length === 2 && rel[0] !== "..") rmSync(dirname(artifact.quarantinePath), { recursive: true, force: true });
    }
  }
  const record: TrustRecord = {
    repoRoot: key,
    name: entry.name,
    entryHash,
    artifact: { ...artifact, binary, quarantinePath: null },
    approvedAt: new Date().toISOString(),
  };
  editTrust((records) => [...records.filter((r) => !(r.repoRoot === key && r.name === entry.name)), record]);
}

// ---------- the adapters ----------

// Reads the report a scanner left, refusing a link, a FIFO, a device or
// anything past the cap. Null when there is no file.
function readReport(path: string): { text: string } | { error: string } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return { error: code === "ELOOP" ? "the report is a link" : `the report cannot be read (${code})` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { error: "the report is not a regular file" };
    const buffer = Buffer.alloc(REPORT_MAX_BYTES + 1);
    let size = 0;
    for (let n = 1; n > 0 && size < buffer.length; size += n) n = readSync(fd, buffer, size, buffer.length - size, size);
    if (size > REPORT_MAX_BYTES) return { error: "the report is larger than 8 MB" };
    return { text: buffer.subarray(0, size).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

function skippedAdapter(source: ScannerSource, reason: string): CustomAdapter {
  return {
    source,
    skipped: { scanner: source, status: "untrusted", version: null, rawCount: 0, keptCount: 0, durationMs: 0, reason },
    wants: () => false,
    run: async () => ({ findings: [], error: null, version: null }),
  };
}

function trustedAdapter(entry: CustomScanner, record: TrustRecord): CustomAdapter {
  const source: ScannerSource = `custom:${entry.name}`;
  const version = record.artifact.version;
  const matching = (paths: string[]) =>
    entry.paths === null ? paths : paths.filter((p) => entry.paths!.some((glob) => matchesGlob(p, glob)));
  return {
    source,
    skipped: null,
    wants: (changedPaths) => matching(changedPaths).length > 0,
    async run({ repoDir, changedPaths, scratch }) {
      const tokens = splitCommand(entry.run);
      const usesReport = tokens.some((t) => t.includes("{report}"));
      // The run's temporary folder and variables (scratch.ts); the system's
      // temp folder and none when left out, as on the laptop.
      const tmp = mkdtempSync(join(scratch?.temp ?? tmpdir(), "openqodex-custom-"));
      try {
        const report = join(tmp, "report");
        const timeoutMs = entry.timeoutSeconds * 1000;
        // One process per chunk of targets, so a whole-repo file list stays
        // under the argument limit, all under the entry's one timeout.
        const chunks = entry.target === "repo" ? [[repoDir]] : splitArgs(matching(changedPaths), ARG_BUDGET_BYTES);
        const deadline = Date.now() + timeoutMs;
        const findings: StaticFinding[] = [];
        for (const targets of chunks) {
          const left = deadline - Date.now();
          if (left <= 0) return { findings: [], error: `${entry.name} timed out after ${Math.round(timeoutMs / 1000)}s`, version };
          rmSync(report, { force: true });
          const args = expandArgs(tokens.slice(1), { report, repo: repoDir, targets });
          // A binary from PATH is checked right before it runs, not only when the adapter was built.
          if (entry.install.kind === "path" && !sameBytes(record)) return { findings: [], error: BINARY_CHANGED, version };
          const result = await execTool(record.artifact.binary, args, { cwd: repoDir, timeoutMs: left, maxBytes: REPORT_MAX_BYTES, env: scratch?.env });
          const failed = describeFailure(entry.name, result, timeoutMs);
          if (failed) return { findings: [], error: failed, version };
          const exit = `exit ${result.exitCode}${stderrTail(result) ? `: ${stderrTail(result)}` : ""}`;
          let text: string;
          if (usesReport) {
            const read = readReport(report);
            if (read === null) return { findings: [], error: `${entry.name} wrote no report (${exit})`, version };
            if ("error" in read) return { findings: [], error: `${entry.name}: ${read.error}`, version };
            text = read.text;
          } else {
            text = result.stdout;
          }
          try {
            const found =
              entry.format === "sarif"
                ? parseSarif(text, { repoDir, source })
                : parseJsonMap(text, entry.map!, { repoDir, source });
            for (const f of found) findings.push(f);
          } catch (error) {
            const why = (error as Error).message;
            return { findings: [], error: result.exitCode === 0 ? `${entry.name}: ${why}` : `${entry.name}: ${why} (${exit})`, version };
          }
        }
        // Many tools exit non-zero when they find something; a report that parses is a run.
        return { findings, error: null, version };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

// One adapter per custom entry; an entry that is not approved comes back with `skipped` set.
// `approvalRoot` is the repository the approvals were given for. The adapter
// runs in the folder the runner passes as `repoDir`, which for a review of a
// branch or a pull request is a temporary checkout, not that repository.
export function customAdapters(approvalRoot: string, config: Config): CustomAdapter[] {
  return assess(approvalRoot, config).map(({ entry, state, record, reason }) =>
    state === "trusted" && record ? trustedAdapter(entry, record) : skippedAdapter(`custom:${entry.name}`, reason ?? NOT_APPROVED),
  );
}
