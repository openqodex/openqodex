// The pinned scanner table (toolchain.json), the lock files beside it, and
// where installed tools live.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export type ArchiveKind = "tar.gz" | "tar.xz" | "zip";

export type ReleaseAsset = {
  name: string;
  url: string;
  sha256: string;
  archive: ArchiveKind | "none";
  binaryPath: string; // path of the executable inside the archive, or the asset name
};

type RecipeBase = { version: string; binary: string; needs?: string };

// A registry install (uv, gem) installs exactly the packages its lock file
// names, each checked against its sha256 before it is installed: locks/
// <tool>-<platform>.txt beside toolchain.json, made by scripts/lock-scanners.mjs
// from the fields below. `package`, `with` and `gems` are what the lock was
// made from.
// Data a scanner downloads at run time, pinned beside it: kubeconform's
// Kubernetes JSON schemas, from one commit of `repo` on GitHub, for one
// Kubernetes version (x.y.z).
export type SchemaPin = { repo: string; commit: string; kubernetes: string };

export type Recipe =
  | (RecipeBase & { method: "github-release"; repo: string; tag: string; assets: Partial<Record<Platform, ReleaseAsset | null>>; schemas?: SchemaPin })
  // `with`: extra packages pinned beside the tool, for a dependency the tool
  // itself leaves unpinned (semgrep needs a setuptools that still ships pkg_resources).
  | (RecipeBase & { method: "uv"; package: string; python: string; with?: string[] })
  | (RecipeBase & { method: "gem"; gems: string[] });

export type Toolchain = { schema: 1; tools: Record<string, Recipe> };

// $OPENQODEX_HOME or ~/.openqodex, always absolute: tools run with the repo
// as their working directory, so a relative home would point somewhere else.
export function openqodexHome(): string {
  const fromEnv = process.env.OPENQODEX_HOME;
  return fromEnv && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), ".openqodex");
}

// The install root of an OpenQodex home: <home>/tools.
export function toolsDir(home: string): string {
  return join(home, "tools");
}

// Where installs go. `root`, the install root, holds one folder per tool
// (on the laptop <home>/tools); `cache` holds the installers' download
// caches (on the laptop <home>/cache); `owner` is the folder that holds the
// place (on the laptop the home): installers run in it, and a message names
// it when it cannot be written.
export type InstallPlace = { root: string; cache: string; owner: string };

// The laptop's place: the OpenQodex home's tools and caches.
export function homePlace(home: string = openqodexHome()): InstallPlace {
  return { root: toolsDir(home), cache: join(home, "cache"), owner: home };
}

// The folder of one tool in an install root.
export function toolDir(root: string, tool: string): string {
  return join(root, tool);
}

// The folder of one install. A registry install's folder also names its
// lock's sha256, so a new lock (a dependency pin moved, the version did not)
// installs afresh instead of reusing the old tree.
export function versionDir(root: string, tool: string, recipe: Recipe): string {
  if (recipe.method === "github-release") return join(root, tool, recipe.version);
  return join(root, tool, lockedFolder(recipe.version, lockText(tool)));
}

// "1.9.4-<first 12 hex of the lock's sha256>".
export function lockedFolder(version: string, lock: string | null): string {
  return `${version}-${lock === null ? "nolock" : createHash("sha256").update(lock).digest("hex").slice(0, 12)}`;
}

// Where the executable sits once installed.
export function binaryPath(root: string, tool: string, recipe: Recipe): string {
  return join(versionDir(root, tool, recipe), "bin", recipe.binary);
}

// Written last by every install; a version folder without it is not installed.
export function markerPath(root: string, tool: string, recipe: Recipe): string {
  return join(versionDir(root, tool, recipe), ".installed");
}

export function currentPlatform(): Platform | null {
  const os = process.platform;
  const arch = process.arch;
  if ((os === "darwin" || os === "linux") && (arch === "arm64" || arch === "x64")) return `${os}-${arch}`;
  return null;
}

// The table ships beside the code in every layout: next to the package root of
// the scanners source and dist, and beside the CLI bundle. Found from this
// file, never from the current directory.
function findTable(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, "toolchain.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("toolchain.json is missing from the installed package");
}

let cached: Toolchain | null = null;

export function loadToolchain(): Toolchain {
  cached ??= JSON.parse(readFileSync(findTable(), "utf8")) as Toolchain;
  return cached;
}

function locksDir(): string {
  return join(dirname(findTable()), "locks");
}

// The lock file of a registry install for this machine, or null.
export function lockFile(tool: string): string | null {
  const platform = currentPlatform();
  if (platform === null) return null;
  const file = join(locksDir(), `${tool}-${platform}.txt`);
  return existsSync(file) ? file : null;
}

function lockText(tool: string): string | null {
  const file = lockFile(tool);
  return file === null ? null : readFileSync(file, "utf8");
}

// sha256 of the pinned table and every lock file as shipped: it changes when
// any pin changes and only then, so a cache of the tools folder keyed on it
// survives a release that pins nothing new.
export function toolchainHash(): string {
  const hash = createHash("sha256").update(readFileSync(findTable()));
  const dir = locksDir();
  const locks = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".txt")).sort() : [];
  for (const name of locks) hash.update(`\0${name}\0`).update(readFileSync(join(dir, name)));
  return hash.digest("hex");
}
