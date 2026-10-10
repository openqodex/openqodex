// cargo-deny adapter (Rust dependency policy): RustSec advisories
// (vulnerabilities, unsound and unmaintained crates) and crate sources other
// than crates.io, for each changed Cargo.lock. Three steps, each from a
// temporary folder outside the repository:
//
// 1. `cargo-deny --manifest-path <project>/Cargo.toml --config <owned> fetch db`
//    clones or updates the RustSec advisory database
//    (github.com/rustsec/advisory-db) with the developer's git, into the
//    OpenQodex home. The only network use.
// Before any step, every path the project's manifests name, and the search
// for its workspace, must stay inside the repository (cargoPathProblem);
// a project that fails is held back with the reason.
// 2. `cargo metadata --format-version 1 --frozen --manifest-path <...>`
//    with the developer's toolchain named by its real files (the Cargo probe
//    in toolchain/install.ts). Cargo reads its settings from the folder it
//    starts in, so the repository's .cargo/config.toml (a rustc or a rustc
//    wrapper, a source replacement) is never read, and a project's
//    rust-toolchain.toml is never read either: no rustup proxy is started.
//    --frozen and CARGO_NET_OFFLINE: nothing is downloaded and Cargo.lock is
//    never rewritten. The crates must already be in the Cargo cache.
//    cargo-deny would run this itself from the project's folder, where Cargo
//    does read the project's settings, so OpenQodex runs it and hands over
//    the result.
// 3. `cargo-deny --frozen --manifest-path <...> --metadata-path <step 2>
//    --workspace --config <owned> check --hide-inclusion-graph advisories
//    sources`, offline, on the database from step 1.
//
// The config is OpenQodex's own: a repository's deny.toml can name advisory
// database URLs and a database folder anywhere, so it is never loaded. Its
// checks: advisories with yank checking off (the result would depend on each
// machine's index cache, and cargo-deny would read the repository's
// .cargo/config.toml to find it) and sources with cargo-deny's defaults (a
// git dependency or a registry other than crates.io). Not licenses (with no
// allow list every crate fails) and not bans (with no deny list it reports
// only duplicate versions). cargo-deny still reads a deny.exceptions.toml
// beside the project, which holds licence exceptions only; a broken one
// stops it, so it is a settings file.
//
// cargo-deny names each crate by name, version and source, not by a line of
// Cargo.lock; each finding is anchored to the crate's entry there, from its
// name line to its version line, as osv-scanner anchors the same advisory.
// All errors are captured into the result; the runner never throws on a
// scanner failure.

import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AdapterResult, ResolvedTool, ScannerSeverity, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, isOffline, type ExecResult } from "../exec.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";
import { withOwnedConfig } from "./owned-config.js";
import { parse as parseToml } from "smol-toml";
import { readRepoFile, repoFileOrReason, scannerInput } from "./read.js";
import { suchAs } from "./words.js";

// One deadline for every step of one run: the first clone of the database
// takes the longest.
const CARGO_DENY_TIMEOUT_MS = 180_000;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const LOCK_MAX_BYTES = 16 * 1024 * 1024;
const ADVISORY_DB = "https://github.com/rustsec/advisory-db";

export const CARGO_DENY_OFFLINE_REASON = "offline, advisory database downloads are off";

function offlineReason(): string | null {
  return isOffline() ? CARGO_DENY_OFFLINE_REASON : null;
}

function isCargoLock(p: string): boolean {
  return path.posix.basename(p) === "Cargo.lock";
}

// A TOML basic string.
const tomlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function cargoDenyConfig(dbRoot: string): string {
  return [
    "[advisories]",
    `db-path = ${tomlString(dbRoot)}`,
    `db-urls = [${tomlString(ADVISORY_DB)}]`,
    "disable-yank-checking = true",
    "",
    "[sources]",
    'unknown-registry = "warn"',
    'unknown-git = "warn"',
    "",
  ].join("\n");
}

// The plain reason a cargo metadata run failed. `folder` is the project's,
// repo-relative ("" for the root).
export function metadataFailure(stderr: string, folder: string): string {
  const lock = folder === "" ? "Cargo.lock" : `${folder}/Cargo.lock`;
  const where = folder === "" ? "the repository root" : `${folder}/`;
  if (/--frozen was specified|--offline was specified|offline mode/.test(stderr)) {
    // A crate the cache holds in its index but not its files fails to
    // download; a crate the index cache has never seen is not found.
    const what = /failed to download [^\n]*|no matching package named `[^`\n]*` found/.exec(stderr)?.[0];
    return `the crates of ${lock} are not all in your Cargo cache${what ? ` (${what.trim()})` : ""}; run \`cargo fetch\` in ${where} once`;
  }
  const lines = stderr.trim().split("\n").filter((l) => l.trim() !== "");
  return `cargo metadata failed: ${(lines[0] ?? "no output").trim().slice(0, 240)}`;
}

// The folder that holds the advisory database, under the run's scratch root
// (the OpenQodex home on the laptop), made or checked through the scratch's
// guarded writer (a link on the way is refused, even when the folder is
// already there); its real path, since git compares
// GIT_CEILING_DIRECTORIES with real paths.
function databaseRoot(scratch: Scratch): string {
  return realpathSync(scratch.cache("cargo-deny", "advisory-dbs"));
}

type Project = { lock: string; folder: string; manifest: string };

// A server run's Cargo home is its own (scratch.ts). Cargo reads and writes
// a home through the same folders (a lock file, a last-use record, the index
// cache, unpacked crates), so it cannot be pointed at the preinstalled one
// without writing there. Before `cargo metadata`, the run's home gets copies
// of what a Cargo.lock's registry crates need from the preinstalled home
// (`from`): each registry's settings files, and each crate's index entry and
// archive. Cargo unpacks the archives into the run's home. Only regular
// files are copied, never through a link, and a lock name that is not a
// crate name, or a version with a character no version holds, is skipped.
// The number of files copied.
const CRATE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CRATE_VERSION = /^[0-9A-Za-z.+-]{1,100}$/;

export function seedCargoHome(args: { from: string; to: string; lockText: string }): number {
  let parsed: { package?: unknown };
  try {
    parsed = parseToml(args.lockText) as { package?: unknown };
  } catch {
    return 0;
  }
  const crates: { name: string; version: string }[] = [];
  for (const p of Array.isArray(parsed.package) ? (parsed.package as Record<string, unknown>[]) : []) {
    const { name, version, source } = p ?? {};
    if (typeof name !== "string" || typeof version !== "string" || typeof source !== "string") continue;
    if (!/^(registry|sparse)\+/.test(source) || !CRATE_NAME.test(name) || !CRATE_VERSION.test(version)) continue;
    crates.push({ name, version });
  }
  let copied = 0;
  const copy = (from: string, to: string): void => {
    if (!lstatSync(from, { throwIfNoEntry: false })?.isFile()) return;
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    copied++;
  };
  const folders = (dir: string): string[] =>
    lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const filesIn = (dir: string): string[] =>
    lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  const indexes = path.join(args.from, "registry", "index");
  for (const registry of folders(indexes)) {
    const from = path.join(indexes, registry);
    const to = path.join(args.to, "registry", "index", registry);
    for (const name of filesIn(from)) copy(path.join(from, name), path.join(to, name));
    for (const name of filesIn(path.join(from, ".cache"))) copy(path.join(from, ".cache", name), path.join(to, ".cache", name));
    for (const crate of crates) {
      const entry = indexEntryPath(crate.name);
      copy(path.join(from, ".cache", entry), path.join(to, ".cache", entry));
    }
  }
  const archives = path.join(args.from, "registry", "cache");
  for (const registry of folders(archives)) {
    for (const crate of crates) {
      const file = `${crate.name}-${crate.version}.crate`;
      copy(path.join(archives, registry, file), path.join(args.to, "registry", "cache", registry, file));
    }
  }
  return copied;
}

// Where a registry index keeps a crate's entry: by the lowercased name's
// length and first letters, as Cargo lays out its index cache.
function indexEntryPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return path.join("1", n);
  if (n.length === 2) return path.join("2", n);
  if (n.length === 3) return path.join("3", n.slice(0, 1), n);
  return path.join(n.slice(0, 2), n.slice(2, 4), n);
}

// The Cargo home the developer's Cargo uses: CARGO_HOME, else .cargo in the
// home folder.
function preinstalledCargoHome(): string {
  return process.env.CARGO_HOME || path.join(homedir(), ".cargo");
}

export async function runCargoDeny(args: { repoDir: string; changedPaths: string[]; tool: ResolvedTool | null; scratch: Scratch }): Promise<AdapterResult> {
  const locks = args.changedPaths.filter(isCargoLock);
  if (locks.length === 0) return { findings: [], error: null };
  const skipped = offlineReason();
  if (skipped) return { findings: [], error: null, skipped };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;
  const cargo = tool.env.CARGO;
  if (!cargo) return { findings: [], error: "needs Cargo (Rust)" };

  const notes: string[] = [];
  // Projects held back because a manifest names a path outside the
  // repository: a note, not a failure, as trivy's held folders are.
  const held: string[] = [];
  const projects: Project[] = [];
  for (const lock of locks) {
    const folder = path.posix.dirname(lock) === "." ? "" : path.posix.dirname(lock);
    const rel = folder === "" ? "Cargo.toml" : `${folder}/Cargo.toml`;
    const checked = await repoFileOrReason(args.repoDir, rel, LOCK_MAX_BYTES).catch(() => ({ reason: "missing" }));
    if ("reason" in checked) {
      notes.push(`no Cargo.toml beside ${lock}`);
      continue;
    }
    const problem = await cargoPathProblem(args.repoDir, folder);
    if (problem !== null) {
      held.push(`not run on ${lock}: ${problem}`);
      continue;
    }
    projects.push({ lock, folder, manifest: checked.path });
  }
  if (projects.length === 0) return notes.length > 0 ? { findings: [], error: [...notes, ...held].join("; ").slice(0, 300) } : { findings: [], error: null, skipped: held.join("; ").slice(0, 300) };

  let dbRoot: string;
  try {
    dbRoot = databaseRoot(args.scratch);
  } catch (err) {
    return { findings: [], error: `cannot make the advisory database folder: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
  // git never looks above the database folder for a repository, so a
  // database folder left broken can never make it act on another one.
  const env = { ...tool.env, GIT_CEILING_DIRECTORIES: dbRoot };
  const deadline = Date.now() + CARGO_DENY_TIMEOUT_MS;
  const left = () => Math.max(1, deadline - Date.now());
  const step = (file: string, argv: string[], cwd: string): Promise<ExecResult> =>
    execTool(file, argv, { cwd, timeoutMs: left(), maxBytes: OUTPUT_MAX_BYTES, env });

  try {
    const findings = await withOwnedConfig(args.scratch.temp, "deny.toml", cargoDenyConfig(dbRoot), async (configPath, work) => {
      const common = ["--format", "json", "--color", "never"];
      const fetched = await step(tool.path, [...common, "--manifest-path", projects[0]!.manifest, "--config", configPath, "fetch", "db"], work);
      const fetchFailed = describeFailure("cargo-deny", fetched, CARGO_DENY_TIMEOUT_MS) ?? logError(fetched.stderr) ?? (fetched.exitCode === 0 ? null : `exit ${fetched.exitCode}`);
      if (fetchFailed) throw new Error(`could not fetch the RustSec advisory database: ${fetchFailed}`);

      const out: StaticFinding[] = [];
      for (const [n, project] of projects.entries()) {
        // A server run's own Cargo home gets the crates this lock needs.
        const runHome = tool.env.CARGO_HOME;
        if (!args.scratch.laptop && runHome) {
          try {
            const lockText = await readRepoFile(args.repoDir, project.lock, LOCK_MAX_BYTES);
            seedCargoHome({ from: preinstalledCargoHome(), to: runHome, lockText });
          } catch {
            // Nothing copied: cargo metadata names the crates it misses.
          }
        }
        const metadata = await step(cargo, ["metadata", "--format-version", "1", "--frozen", "--manifest-path", project.manifest], work);
        const metaFailed = describeFailure("cargo metadata", metadata, CARGO_DENY_TIMEOUT_MS);
        if (metaFailed || metadata.exitCode !== 0) {
          notes.push(metaFailed ?? metadataFailure(metadata.stderr, project.folder));
          continue;
        }
        const metadataPath = path.join(work, `metadata-${n}.json`);
        await fs.writeFile(metadataPath, metadata.stdout);
        const checked = await step(
          tool.path,
          [...common, "--frozen", "--manifest-path", project.manifest, "--metadata-path", metadataPath, "--workspace", "--config", configPath, "check", "--hide-inclusion-graph", "advisories", "sources"],
          work,
        );
        const checkFailed = describeFailure("cargo-deny", checked, CARGO_DENY_TIMEOUT_MS);
        if (checkFailed) {
          notes.push(checkFailed);
          continue;
        }
        let lockText: string | null = null;
        try {
          lockText = await readRepoFile(args.repoDir, project.lock, LOCK_MAX_BYTES);
        } catch {
          // Unreadable: its findings land on line 1.
        }
        const parsed = parseCargoDenyOutput(checked.stderr, { lockPath: project.lock, lockText });
        if (parsed.failure !== null) notes.push(`${project.lock}: ${parsed.failure}`);
        out.push(...parsed.findings);
      }
      return out;
    });
    return notes.length > 0 ? { findings, error: [...notes, ...held].join("; ").slice(0, 300) } : { findings, error: null, note: held.length > 0 ? held.join("; ").slice(0, 300) : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

export const cargoDeny: Adapter = {
  source: "cargo-deny",
  files: (changedPaths) => changedPaths.filter(isCargoLock),
  why: (files) => `Rust lockfiles, ${suchAs(files)}`,
  skip: offlineReason,
  run: (args) => runCargoDeny(args),
};

type Line = { type?: unknown; fields?: Record<string, unknown> };

// cargo-deny's JSON output, one object per line on stderr.
function jsonLines(stderr: string): Line[] {
  const out: Line[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Line);
    } catch {
      // Not one of its lines.
    }
  }
  return out;
}

// The first error cargo-deny logged, or null.
function logError(stderr: string): string | null {
  for (const line of jsonLines(stderr)) {
    if (line.type === "log" && line.fields?.level === "ERROR") return String(line.fields.message ?? "").trim().slice(0, 240);
  }
  return null;
}

// The diagnostics kept, by code, with their severity. The rest (an index
// failure, an ignore that matched nothing) are about the setup, not the
// change.
const KEPT: Record<string, ScannerSeverity> = {
  vulnerability: "high",
  unsound: "medium",
  unmaintained: "low",
  notice: "low",
  yanked: "low",
  "source-not-allowed": "medium",
  "git-source-underspecified": "low",
};

// The crate's entry in Cargo.lock: from its name line to its version line.
function entryRange(lockText: string | null, name: string, version: string, source: string): { start: number; end: number } {
  if (lockText === null) return { start: 1, end: 1 };
  const lines = lockText.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let found: { start: number; end: number } | null = null;
  let block: { name?: number; version?: number; nameValue?: string; versionValue?: string; sourceValue?: string } = {};
  const close = () => {
    if (found !== null || block.name === undefined || block.version === undefined) return;
    if (block.nameValue !== name || block.versionValue !== version) return;
    if (source !== "" && block.sourceValue !== undefined && block.sourceValue !== source) return;
    found = { start: Math.min(block.name, block.version) + 1, end: Math.max(block.name, block.version) + 1 };
  };
  const value = (line: string, key: string): string | null => {
    const prefix = `${key} = "`;
    return line.startsWith(prefix) && line.endsWith('"') ? line.slice(prefix.length, -1) : null;
  };
  for (const [i, line] of lines.entries()) {
    if (line === "[[package]]") {
      close();
      block = {};
      continue;
    }
    const n = value(line, "name");
    if (n !== null) {
      block.name = i;
      block.nameValue = n;
    }
    const v = value(line, "version");
    if (v !== null) {
      block.version = i;
      block.versionValue = v;
    }
    const s = value(line, "source");
    if (s !== null) block.sourceValue = s;
  }
  close();
  return found ?? { start: 1, end: 1 };
}

export function parseCargoDenyOutput(
  stderr: string,
  opts: { lockPath: string; lockText: string | null },
): { findings: StaticFinding[]; failure: string | null } {
  const lines = jsonLines(stderr);
  const findings: StaticFinding[] = [];
  let summary = false;
  for (const line of lines) {
    if (line.type === "summary") summary = true;
    if (line.type !== "diagnostic" || !line.fields) continue;
    const f = line.fields;
    const code = typeof f.code === "string" ? f.code : "";
    const severity = KEPT[code];
    if (severity === undefined) continue;
    const labels = Array.isArray(f.labels) ? (f.labels as { span?: unknown }[]) : [];
    const span = typeof labels[0]?.span === "string" ? labels[0].span : "";
    const [name = "", version = "", ...rest] = span.split(" ");
    const source = rest.join(" ");
    const range = entryRange(opts.lockText, name, version, source);
    const advisory = f.advisory && typeof f.advisory === "object" ? (f.advisory as { id?: unknown; aliases?: unknown }) : null;
    const id = typeof advisory?.id === "string" ? advisory.id : "";
    const aliases = Array.isArray(advisory?.aliases) ? (advisory.aliases as unknown[]).filter((a): a is string => typeof a === "string") : [];
    const notes = Array.isArray(f.notes) ? (f.notes as unknown[]).filter((n): n is string => typeof n === "string") : [];
    const solution = notes.find((n) => n.startsWith("Solution: "));
    const title = typeof f.message === "string" ? f.message.trim() : code;
    const crate = name ? `${name} ${version}` : "a crate";
    const message = id
      ? `${crate}: ${id}${aliases.length > 0 ? ` (${aliases.slice(0, 3).join(", ")})` : ""}. ${title.replace(/\.?$/, ".")}${solution ? ` ${solution}` : ""}`
      : `${crate}: ${title}${source ? ` (${source})` : ""}`;
    findings.push({
      source: "cargo-deny",
      ruleId: id || code,
      filePath: opts.lockPath,
      lineStart: range.start,
      lineEnd: range.end,
      severity,
      message: trimMessage(message),
      reference: id ? `https://rustsec.org/advisories/${encodeURIComponent(id)}` : `https://embarkstudios.github.io/cargo-deny/checks/sources/diags.html#${code}`,
    });
  }
  const failure = logError(stderr) ?? (summary ? null : "cargo-deny printed no result");
  return { findings, failure };
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}


// ---------- the paths a project's manifests name ----------

// Cargo reads every manifest the project's manifests name, and lists the
// folders their targets live in: path dependencies (in every dependency
// table, a target's, the workspace's), workspace members and the workspace
// root (`package.workspace`), patches and replaces, target, build script and
// readme paths, and the Cargo.toml of each folder above the project until one
// holds a [workspace]. Starting Cargo outside the repository and with
// --frozen constrains none of that, so before Cargo starts every such path
// must stay inside the repository, through no link, and the search for a
// workspace must end inside it. The gate fails closed: every manifest a path
// names must be a regular file the TOML parser (smol-toml) reads whole; a
// member pattern is not expanded, since Cargo expands it over the file system
// and follows links there; a walk past its limit stops. Null when the project
// passes, else the first problem.
const CARGO_MANIFEST_MAX_BYTES = 1024 * 1024;
const MAX_CARGO_MANIFESTS = 1000;
const DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "dev_dependencies", "build-dependencies", "build_dependencies"];
const TARGET_TABLES = ["lib", "bin", "example", "test", "bench"];
// The folders and files Cargo looks in for targets it finds on its own.
const DISCOVERED = ["src", "src/bin", "src/main.rs", "src/lib.rs", "examples", "tests", "benches", "build.rs"];

const isTable = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

// `value`, a path a manifest in `folder` names, repo-relative and normalised,
// or null when it leaves the repository.
function insidePath(folder: string, value: string): string | null {
  if (value === "" || value.startsWith("/") || value.startsWith("~") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return null;
  const resolved = path.posix.normalize(path.posix.join(folder === "" ? "." : folder, value.replace(/\\/g, "/")));
  if (resolved === ".." || resolved.startsWith("../")) return null;
  return resolved === "." ? "" : resolved.replace(/\/$/, "");
}

// Null when no part of `rel` that is there is a link; else the reason.
function linkOnTheWay(repoDir: string, rel: string): string | null {
  let at = repoDir;
  for (const part of rel === "" ? [] : rel.split("/")) {
    at = path.join(at, part);
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (stat.isSymbolicLink()) return "reached through a link";
  }
  return null;
}

export async function cargoPathProblem(repoDir: string, folder: string): Promise<string | null> {
  let realRepo: string;
  try {
    realRepo = realpathSync(repoDir);
  } catch {
    return "the repository cannot be read";
  }
  // Each manifest to read, and whether it must be there: one a path names
  // must; one in a folder above the project is read only when present.
  const queue: { rel: string; required: boolean }[] = [];
  const seen = new Set<string>();
  const manifestOf = (dir: string): string => (dir === "" ? "Cargo.toml" : `${dir}/Cargo.toml`);
  const visit = (dir: string, required = true): void => {
    const rel = manifestOf(dir);
    if (!seen.has(rel)) {
      seen.add(rel);
      queue.push({ rel, required });
    }
  };
  // The project, and each folder above it inside the repository: Cargo reads
  // their manifests looking for the workspace.
  const parts = folder === "" ? [] : folder.split("/");
  for (let depth = parts.length; depth >= 0; depth--) visit(parts.slice(0, depth).join("/"), depth === parts.length);
  const chain = new Set(seen);
  let workspaceInside = false;

  while (queue.length > 0) {
    if (seen.size > MAX_CARGO_MANIFESTS) return "more Cargo manifests than OpenQodex reads";
    const { rel, required } = queue.shift() as { rel: string; required: boolean };
    const verdict = scannerInput(realRepo, repoDir, rel);
    if (!verdict.ok) {
      if (verdict.reason === null && !required) continue;
      return `${rel}: ${verdict.reason ?? "no such manifest"}`;
    }
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(await readRepoFile(repoDir, rel, CARGO_MANIFEST_MAX_BYTES)) as Record<string, unknown>;
    } catch {
      return `${rel} cannot be read as a Cargo manifest`;
    }
    const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    const problem = (what: string) => `${rel}: ${what} outside the repo`;
    // A path to a folder whose manifest Cargo reads.
    const folderPath = (value: unknown, what: string): string | null => {
      if (typeof value !== "string") return null;
      const inside = insidePath(dir, value);
      if (inside === null) return problem(what);
      const linked = linkOnTheWay(repoDir, inside);
      if (linked !== null) return `${rel}: ${what} ${linked}`;
      visit(inside);
      return null;
    };
    // A path to a file Cargo looks at.
    const filePath = (value: unknown, what: string): string | null => {
      if (typeof value !== "string") return null;
      const inside = insidePath(dir, value);
      if (inside === null) return problem(what);
      const linked = linkOnTheWay(repoDir, inside);
      return linked === null ? null : `${rel}: ${what} ${linked}`;
    };
    const dependencies = (table: unknown): string | null => {
      if (!isTable(table)) return null;
      for (const spec of Object.values(table)) {
        if (isTable(spec)) {
          const found = folderPath(spec.path, "a path dependency");
          if (found) return found;
        }
      }
      return null;
    };
    const checks: (() => string | null)[] = [];
    for (const name of DEPENDENCY_TABLES) checks.push(() => dependencies(doc[name]));
    if (isTable(doc.target)) {
      for (const target of Object.values(doc.target)) {
        if (isTable(target)) for (const name of DEPENDENCY_TABLES) checks.push(() => dependencies(target[name]));
      }
    }
    if (isTable(doc.patch)) for (const registry of Object.values(doc.patch)) checks.push(() => dependencies(registry));
    checks.push(() => dependencies(doc.replace));
    const pkg = isTable(doc.package) ? doc.package : null;
    if (pkg) {
      checks.push(() => folderPath(pkg.workspace, "the workspace root"));
      checks.push(() => filePath(pkg.build, "the build script"));
      checks.push(() => filePath(pkg.readme, "the readme"));
      checks.push(() => filePath(pkg["license-file"], "the licence file"));
      for (const found of DISCOVERED) checks.push(() => filePath(found, "a target folder"));
      if (chain.has(rel) && typeof pkg.workspace === "string") workspaceInside = true;
    }
    for (const name of TARGET_TABLES) {
      const targets = doc[name];
      for (const target of Array.isArray(targets) ? targets : [targets]) {
        if (isTable(target)) checks.push(() => filePath(target.path, "a target path"));
      }
    }
    if (isTable(doc.workspace)) {
      if (chain.has(rel)) workspaceInside = true;
      const ws = doc.workspace;
      checks.push(() => dependencies(ws.dependencies));
      for (const list of [ws.members, ws["default-members"]]) {
        if (!Array.isArray(list)) continue;
        for (const member of list) {
          if (typeof member !== "string") continue;
          checks.push(() => {
            if (insidePath(dir, member) === null) return problem("a workspace member");
            if (/[*?[\]{}!]/.test(member)) return `${rel}: a workspace member pattern, which Cargo expands over the file system`;
            return folderPath(member, "a workspace member");
          });
        }
      }
    }
    for (const check of checks) {
      const found = check();
      if (found !== null) return found;
    }
  }
  // With no [workspace] from the project up to the repository root, Cargo
  // reads the Cargo.toml of each folder above the repository in turn.
  if (!workspaceInside) {
    for (const start of new Set([path.resolve(repoDir), realRepo])) {
      for (let at = path.dirname(start); ; at = path.dirname(at)) {
        if (lstatSync(path.join(at, "Cargo.toml"), { throwIfNoEntry: false }) !== undefined) {
          return "a Cargo.toml in a folder above the repository, which Cargo would read looking for the workspace";
        }
        if (path.dirname(at) === at) break;
      }
    }
  }
  return null;
}
