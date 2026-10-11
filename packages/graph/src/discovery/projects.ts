// The project model: every manifest in the repository, read as text and
// never run. It answers, for one importing file, which workspace package a
// bare specifier names and whether the importer's package declares it,
// which tsconfig governs the file and whether its globs admit it, where the
// Python source roots are, and whether a module that is not in the
// repository is a declared dependency or part of a standard library.
//
// Every read is bounded (1 MB) and goes through the RepoReader, so no link
// below the repository root is followed. Nothing here fetches or executes.
//
// A file the model needs that cannot be read, parsed or followed is never
// dropped quietly: it is kept as a gap (`unreadable`), which the resolver
// turns into an unknown, the impact walk into a floor for the folder the
// file governs, and the build into a partial status. Why a read was
// refused is told from the file's own entry and each folder above it,
// looked at by identity (lstat) one name at a time, never by following a
// link; a dependency declared by a `file:` or `link:` path is placed by the
// same kind of walk.
import { posix, resolve as resolvePath } from "node:path";
import { FolderReader, matchesGlob, type Id } from "@openqodex/core";
import type { Relation } from "../model/records.js";
import type { RepoReader } from "../safe-fs.js";
import type { UnknownSite } from "../types.js";
import { keptText } from "../frameworks/shared/kept.js";
import { LOCKFILE_BYTES, MANIFEST_BYTES, gemfileGems, goModRequires, normalisePy, parseJsonc, pnpmLinks, pnpmPackages, pyprojectDeps, requirementsDeps, requirementsIncludes, setupCfgRequires, yarnLock } from "./manifests.js";
import type { Linkage } from "./manifests.js";

export { LOCKFILE_BYTES, MANIFEST_BYTES, normalisePy, parseJsonc, pnpmLinks, pnpmPackages };
export type { Linkage };

// Folders whose manifests are never the repository's own projects.
const NOT_PROJECTS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv", "vendor", ".openqodex"]);

export type PackageJson = {
  name: string | null;
  version: string | null;
  main: string | null;
  module: string | null;
  exports: unknown; // as written
  type: "module" | "commonjs";
  deps: Map<string, string>; // dependencies, devDependencies, peerDependencies, optionalDependencies: name to the spec as written
  workspaces: string[] | null;
  // Not read from the file: where each dependency declared by a `file:` or
  // `link:` path leads in the work tree, found when the model is built
  // (placePathDeps) and kept with it.
  pathDeps?: [string, LinkPath][];
};

export type NodeProject = { dir: string; file: string; pkg: PackageJson };

export type TsConfig = {
  file: string;
  dir: string;
  // Folder `paths` targets are relative to: baseUrl when set, else the
  // folder of the config that set `paths`.
  pathsBase: string;
  paths: [string, string[]][];
  baseUrl: string | null;
  files: string[] | null; // as resolved from the repo root
  include: string[] | null;
  exclude: string[] | null;
  references: string[]; // folders of referenced projects, from the repo root
  customConditions: string[];
  rootDir: string | null;
  outDir: string | null;
};

export type ProjectModel = {
  node: NodeProject[];
  // Workspace members by package name. A name two members share maps to both.
  members: Map<string, NodeProject[]>;
  workspaceFiles: string[]; // the manifests that declared the workspace
  tsconfigs: Map<string, TsConfig>; // by folder
  pyRoots: string[]; // extra Python source roots: `src` folders holding a package, pyproject and setup folders
  pyDeclared: Set<string>; // normalised distribution names declared by any Python manifest
  goRequires: string[]; // module paths go.mod files require
  gems: Set<string>;
  pnpmLinks: Map<string, Map<string, Linkage>>; // importer folder to dependency name to what the lockfile resolved
  npmLock: Map<string, Linkage>; // "<importer>/node_modules/<name>" or "node_modules/<name>" to linkage
  yarnWorkspace: Set<string>; // names yarn.lock resolves to a workspace
  yarnPublished: Set<string>; // names yarn.lock resolves from a registry
  unreadable: MetadataGap[];
};

// A manifest, lockfile or tsconfig the model needs and could not read,
// parse or follow. `dir`: the folder whose files it governs ("" for the
// whole repository). `affects`: the relations its loss can hide; empty
// when it only decides whether an import from outside the repository is a
// declared dependency, or how sure a workspace binding is. `note`: the
// file, what failed and what the model lacks for it.
export type MetadataGap = { file: string; dir: string; affects: Relation[]; note: string };

const ALL_RELATIONS: Relation[] = ["calls", "inherits", "imports"];

// What the loss of each kind of metadata file can hide, and what the model
// lacks without it: the one table the gap rule reads (docs/graph.md shows
// it). A gap that can hide a relation floors the callers under its folder
// and makes the build partial, so no index of it is kept. A gap that can
// hide none (it only makes a binding less sure, or turns a call into a
// declared module into a miss) is said as an unknown and a reason, and the
// build stays complete: the index digest covers the file, so a kept index
// is never reused once it changes.
export type MetadataKind = "package.json" | "tsconfig" | "pnpm-workspace.yaml" | "go.mod" | "python-manifest" | "Gemfile" | "lockfile";
export const GAP_RULES: Record<MetadataKind, { affects: Relation[]; lacks: string }> = {
  "package.json": { affects: ALL_RELATIONS, lacks: "its package's name, dependencies and workspaces are not known" },
  tsconfig: { affects: ALL_RELATIONS, lacks: "imports through its paths and baseUrl may be missing" },
  "pnpm-workspace.yaml": { affects: ALL_RELATIONS, lacks: "the workspace packages it lists are not known" },
  "go.mod": { affects: ["calls", "imports"], lacks: "the module it names and the modules it requires are not known" },
  "python-manifest": { affects: [], lacks: "the dependencies it declares are not known and imports of them read as misses" },
  Gemfile: { affects: [], lacks: "the gems it names are not known and requires of them read as misses" },
  lockfile: { affects: [], lacks: "which dependencies link workspace packages is not known" },
};

// The unknown record of a gap, for the project the file governs.

// A requirements include as a gap names it: a URL with no user, password,
// query or fragment, and the rest kept by the rule framework facts keep a
// string by (shared/kept.ts: bounded, key-shaped text redacted). One the
// rule does not keep is named only as a file.
function includeShown(spec: string): string {
  let t = spec;
  const scheme = t.indexOf("://");
  if (scheme >= 0) {
    const rest = t.slice(scheme + 3);
    let end = rest.length;
    for (const stop of ["/", "?", "#"]) {
      const i = rest.indexOf(stop);
      if (i >= 0 && i < end) end = i;
    }
    const authority = rest.slice(0, end);
    let path = rest.slice(end);
    for (const stop of ["?", "#"]) {
      const i = path.indexOf(stop);
      if (i >= 0) path = path.slice(0, i);
    }
    t = `${t.slice(0, scheme + 3)}${authority.slice(authority.lastIndexOf("@") + 1)}${path}`;
  }
  return keptText(t) ?? "a file";
}

export function metadataUnknown(g: MetadataGap): UnknownSite {
  return { file: g.file, line: 0, column: 0, name: "", cause: "metadata-unreadable", shape: "other", caller: g.file, scope: "project", note: g.note };
}

// A file the model reads: its text, why it could not be read, or null
// when it is not there at all (removed since git listed it), which is no
// failure.
type Got = { text: string } | { failed: string } | null;

function get(reader: RepoReader, path: string, max: number): Got {
  let text: string | null = null;
  try {
    text = reader.read(path, max);
  } catch {
    text = null;
  }
  // A byte order mark is no part of the text (TypeScript, npm and Python read past it).
  if (text !== null) return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  const why = whyUnread(reader.root, path, max);
  return why === null ? null : { failed: why };
}

// Why the file `path` could not be read, told one name at a time from the
// repository root by identity and never through a link, so nothing outside
// the repository decides it. Null when nothing is there (removed since git
// listed it), which is no failure.
function whyUnread(root: string, path: string, max: number): string | null {
  let folders: FolderReader;
  try {
    folders = new FolderReader(resolvePath(root));
  } catch {
    return "could not be read";
  }
  const names = path.split("/");
  for (let i = 1; i <= names.length; i++) {
    const looked = folders.entry(names.slice(0, i));
    if (!looked.ok) return looked.why === "missing" ? null : "could not be read";
    const st = looked.stat;
    if (i < names.length) {
      if (st.isSymbolicLink()) return `is under ${names.slice(0, i).join("/")}, a link, which the graph does not follow`;
      // A file where a folder should be: nothing is there.
      if (!st.isDirectory()) return null;
      continue;
    }
    if (st.isSymbolicLink()) return "is a link, which the graph does not follow";
    if (!st.isFile()) return "is not a regular file";
    if (st.size > BigInt(max)) return `is over ${max / (1024 * 1024)} MB`;
  }
  return "could not be read";
}

const dirOf = (path: string): string => {
  const d = posix.dirname(path);
  return d === "." ? "" : d;
};

const join = (...parts: string[]): string => {
  const j = posix.normalize(posix.join(...parts.filter((p) => p !== "")));
  return j === "." ? "" : j;
};

// A requirements file by its name: requirements*.txt or requirements*.in
// anywhere, or any .txt or .in file in a folder named requirements.
export const MAX_REQUIREMENT_INCLUDES = 64;
function isRequirementsFile(path: string): boolean {
  const base = posix.basename(path);
  if (!base.endsWith(".txt") && !base.endsWith(".in")) return false;
  return base.startsWith("requirements") || posix.basename(posix.dirname(path)) === "requirements";
}

function skipped(path: string): boolean {
  return path.split("/").some((p) => NOT_PROJECTS.has(p));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

// A package.json whose text could not be read or parsed: its folder is
// still a package (so its files keep their project), with nothing known.
const unknownPackage = (): PackageJson => ({ name: null, version: null, main: null, module: null, exports: null, type: "commonjs", deps: new Map(), workspaces: null });

// The package, or what failed.
function readPackageJson(text: string): PackageJson | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  if (!isObj(v)) return "is not a JSON object";
  const deps = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const d = v[field];
    if (!isObj(d)) continue;
    for (const [k, spec] of Object.entries(d)) if (typeof spec === "string" && !deps.has(k)) deps.set(k, spec);
  }
  const ws = v.workspaces;
  const workspaces = strList(ws) ?? (isObj(ws) ? strList(ws.packages) : null);
  return {
    name: str(v.name),
    version: str(v.version),
    main: str(v.main),
    module: str(v.module),
    exports: v.exports ?? null,
    type: v.type === "module" ? "module" : "commonjs",
    deps,
    workspaces,
  };
}

// Member folders of a workspace: every package.json folder a positive glob
// admits and no negated glob excludes, globs relative to the declaring file.
function membersOf(globs: string[], declaredIn: string, projects: NodeProject[]): NodeProject[] {
  const base = dirOf(declaredIn);
  const pos = globs.filter((g) => !g.startsWith("!")).map((g) => join(base, g.replace(/\/$/, "")));
  const neg = globs.filter((g) => g.startsWith("!")).map((g) => join(base, g.slice(1).replace(/\/$/, "")));
  return projects.filter((p) => p.dir !== base && pos.some((g) => matchesGlob(p.dir, g)) && !neg.some((g) => matchesGlob(p.dir, g)));
}

const TS_CHAIN = 5; // configs one tsconfig and its relative `extends` may read

// tsconfig.json, following relative `extends` (at most five configs). A
// config whose `extends` names a package is read for its own options only.
// What could not be read, parsed or followed is passed to `fail` as a
// clause about `file` ("is not valid JSON"); what was read is kept. Null
// only when `file` itself is not there.
function readTsconfig(reader: RepoReader, file: string, known: { has(path: string): boolean }, fail: (clause: string) => void): TsConfig | null {
  const dir = dirOf(file);
  const out: TsConfig = {
    file,
    dir,
    pathsBase: dir,
    paths: [],
    baseUrl: null,
    files: null,
    include: null,
    exclude: null,
    references: [],
    customConditions: [],
    rootDir: null,
    outDir: null,
  };
  let at = file;
  let pathsSet = false;
  let baseUrlSet = false;
  // How `at` is reached from `file` ("extends ./base.json"), for a failure past it.
  let reached = "";
  const seen = new Set<string>([file]);
  for (let hop = 1; ; hop++) {
    const got = get(reader, at, MANIFEST_BYTES);
    if (got === null && at === file) return null;
    let config: unknown = null;
    let failed: string | null = got === null ? "is not there" : "failed" in got ? got.failed : null;
    if (got !== null && "text" in got) {
      try {
        config = parseJsonc(got.text);
        if (!isObj(config)) failed = "is not a JSON object";
      } catch {
        failed = "is not valid JSON";
      }
    }
    if (failed !== null || !isObj(config)) {
      const why = failed ?? "is not a JSON object";
      fail(reached === "" ? why : `${reached}, which ${why}`);
      break;
    }
    const here = dirOf(at);
    const opts = isObj(config.compilerOptions) ? config.compilerOptions : {};
    // The nearest config's own values win over what it extends.
    if (!baseUrlSet && typeof opts.baseUrl === "string") {
      out.baseUrl = join(here, opts.baseUrl);
      baseUrlSet = true;
    }
    if (!pathsSet && isObj(opts.paths)) {
      out.paths = Object.entries(opts.paths).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((t) => typeof t === "string"));
      out.pathsBase = typeof opts.baseUrl === "string" ? join(here, opts.baseUrl) : here;
      pathsSet = true;
    }
    if (out.customConditions.length === 0 && Array.isArray(opts.customConditions)) out.customConditions = strList(opts.customConditions) ?? [];
    if (out.rootDir === null && typeof opts.rootDir === "string") out.rootDir = join(here, opts.rootDir);
    if (out.outDir === null && typeof opts.outDir === "string") out.outDir = join(here, opts.outDir);
    // `files`, `include` and `exclude` are inherited whole, resolved from the config that wrote them.
    if (out.files === null && Array.isArray(config.files)) out.files = (strList(config.files) ?? []).map((f) => join(here, f));
    if (out.include === null && Array.isArray(config.include)) out.include = (strList(config.include) ?? []).map((g) => join(here, g));
    if (out.exclude === null && Array.isArray(config.exclude)) out.exclude = (strList(config.exclude) ?? []).map((g) => join(here, g));
    if (at === file && Array.isArray(config.references)) {
      for (const r of config.references) {
        if (!isObj(r) || typeof r.path !== "string") continue;
        // A reference names a folder or a tsconfig file in it.
        const ref = join(here, r.path);
        const last = posix.basename(ref);
        out.references.push(last.startsWith("tsconfig") && last.endsWith(".json") ? dirOf(ref) : ref);
      }
    }
    const ext = config.extends;
    const by = at === file ? "" : `extends ${at}, which `;
    if (Array.isArray(ext)) {
      if (ext.some((e) => typeof e === "string" && e.startsWith("."))) fail(`${by}extends a list of configs, which the graph does not follow`);
      break;
    }
    // No `extends`, or one that names a package: nothing more to read.
    if (typeof ext !== "string" || !ext.startsWith(".")) break;
    // As TypeScript resolves it: the path as written, else with `.json` added.
    const next = join(here, ext);
    const target = (next.endsWith(".json") ? [next] : [next, `${next}.json`]).find((c) => known.has(c));
    const step = `${by}extends ${ext}`;
    if (target === undefined) {
      fail(`${step}, which ${next === ".." || next.startsWith("../") ? "is outside the repository" : "is not in the repository"}`);
      break;
    }
    if (seen.has(target)) {
      fail(`${step}, which it already extends`);
      break;
    }
    if (hop >= TS_CHAIN) {
      fail(`${step}, past the ${TS_CHAIN} configs the graph follows in one chain`);
      break;
    }
    seen.add(target);
    at = target;
    reached = step;
  }
  return out;
}

// Whether a tsconfig's `files`, `include` and `exclude` admit `path`, as
// TypeScript reads them: no `files` and no `include` means everything under
// the config's folder; a folder in `include` means everything under it.
export function tsAdmits(config: TsConfig, path: string): boolean {
  const under = (glob: string, p: string): boolean => {
    if (matchesGlob(p, glob)) return true;
    // A pattern with no wildcard in its last part names a folder (or a file).
    const last = glob.split("/").pop() ?? "";
    if (!/[*?]/.test(last)) return glob === "" || p.startsWith(`${glob}/`) || matchesGlob(p, `${glob}/**`);
    return false;
  };
  if (config.files?.includes(path)) return true;
  const include = config.include ?? (config.files === null ? [join(config.dir, "**/*")] : []);
  if (!include.some((g) => under(g, path))) return false;
  const exclude = config.exclude ?? [join(config.dir, "node_modules"), ...(config.outDir ? [config.outDir] : [])];
  return !exclude.some((g) => under(g, path));
}

// The links package-lock.json resolved, or what failed.
function npmLock(text: string): Map<string, Linkage> | string {
  const out = new Map<string, Linkage>();
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  if (!isObj(v)) return "is not a JSON object";
  if (!isObj(v.packages)) return out;
  for (const [key, entry] of Object.entries(v.packages)) {
    if (!key.includes("node_modules/") || !isObj(entry)) continue;
    const resolved = str(entry.resolved) ?? "";
    out.set(key, entry.link === true ? "workspace" : /^https?:/.test(resolved) || typeof entry.version === "string" ? "published" : "unknown");
  }
  return out;
}

// Builds the model from every path git lists (`all`) and the reader of
// the tree they are in.
// `look`, when given, hears of every path the model looks for in git's
// list, found or not (the index digest records them; discovery/trace.ts).
export function discoverProjects(all: readonly string[], reader: RepoReader, look?: (path: string, found: boolean) => void): ProjectModel {
  const listed = new Set(all);
  const known = {
    has(path: string): boolean {
      const found = listed.has(path);
      look?.(path, found);
      return found;
    },
  };
  const unreadable: MetadataGap[] = [];
  // A file the model needs that is over its cap (never read at all),
  // unreadable, not valid or cannot be followed is kept as a gap: what
  // failed, and what the model lacks for it. `read` gives the text of a
  // file a line reader reads, "" when it is not there or failed.
  const gap = (file: string, dir: string, kind: MetadataKind, failed: string) => unreadable.push({ file, dir, affects: GAP_RULES[kind].affects, note: `${file} ${failed}, so ${GAP_RULES[kind].lacks}` });
  const read = (path: string, max: number, dir: string, kind: MetadataKind): string => {
    const got = get(reader, path, max);
    if (got !== null && "failed" in got) gap(path, dir, kind, got.failed);
    return got !== null && "text" in got ? got.text : "";
  };
  const model: ProjectModel = {
    node: [],
    members: new Map(),
    workspaceFiles: [],
    tsconfigs: new Map(),
    pyRoots: [],
    pyDeclared: new Set(),
    goRequires: [],
    gems: new Set(),
    pnpmLinks: new Map(),
    npmLock: new Map(),
    yarnWorkspace: new Set(),
    yarnPublished: new Set(),
    unreadable,
  };
  // Requirements files and the files they include with -r and -c (issue
  // #70): each read once, an include resolved against its file's folder,
  // never outside the repository, at most MAX_REQUIREMENT_INCLUDES followed.
  const requirementsRead = new Set<string>();
  let includesLeft = MAX_REQUIREMENT_INCLUDES;
  const readRequirements = (first: string): void => {
    const queue = [first];
    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (requirementsRead.has(path)) continue;
      requirementsRead.add(path);
      const dir = dirOf(path);
      const text = read(path, MANIFEST_BYTES, dir, "python-manifest");
      for (const n of requirementsDeps(text)) model.pyDeclared.add(n);
      for (const spec of requirementsIncludes(text)) {
        const shown = includeShown(spec);
        const target = spec.includes("://") || spec.startsWith("/") ? null : posix.normalize(posix.join(dir, spec));
        if (target === null || target === ".." || target.startsWith("../")) {
          gap(path, dir, "python-manifest", `includes ${shown}, which is outside the repository and is not read`);
          continue;
        }
        if (requirementsRead.has(target)) continue;
        if (!known.has(target)) {
          gap(path, dir, "python-manifest", `includes ${shown}, which is not in the repository`);
          continue;
        }
        if (includesLeft <= 0) {
          gap(path, dir, "python-manifest", `includes more than ${MAX_REQUIREMENT_INCLUDES} requirements files in all; ${shown} and the rest are not read`);
          continue;
        }
        includesLeft--;
        queue.push(target);
      }
    }
  };
  const pyRoots = new Set<string>();
  const pyPackageDirs = new Set<string>(); // folders holding .py files
  for (const path of all) {
    if (skipped(path)) continue;
    const base = posix.basename(path);
    const dir = dirOf(path);
    if (base === "package.json") {
      const got = get(reader, path, MANIFEST_BYTES);
      const pkg = got === null ? null : "failed" in got ? got.failed : readPackageJson(got.text);
      if (typeof pkg === "string") gap(path, dir, "package.json", pkg);
      if (pkg !== null) model.node.push({ dir, file: path, pkg: typeof pkg === "string" ? unknownPackage() : pkg });
    } else if (base === "tsconfig.json" || (base === "jsconfig.json" && !known.has(join(dir, "tsconfig.json")))) {
      // tsconfig.json wins over jsconfig.json in one folder: that jsconfig.json is never read.
      const config = readTsconfig(reader, path, known, (clause) => gap(path, dir, "tsconfig", clause));
      if (config) model.tsconfigs.set(config.dir, config);
    } else if (base === "pyproject.toml" || base === "setup.cfg" || base === "setup.py") {
      pyRoots.add(dir);
      if (base === "pyproject.toml") for (const n of pyprojectDeps(read(path, MANIFEST_BYTES, dir, "python-manifest"))) model.pyDeclared.add(n);
      else if (base === "setup.cfg") for (const n of setupCfgRequires(read(path, MANIFEST_BYTES, dir, "python-manifest"))) model.pyDeclared.add(n);
    } else if (isRequirementsFile(path)) {
      readRequirements(path);
    } else if (base === "go.mod") {
      model.goRequires.push(...goModRequires(read(path, MANIFEST_BYTES, dir, "go.mod")));
    } else if (base === "Gemfile") {
      for (const g of gemfileGems(read(path, MANIFEST_BYTES, dir, "Gemfile"))) model.gems.add(g);
    } else if (base === "pnpm-lock.yaml" && dir === "") {
      model.pnpmLinks = pnpmLinks(read(path, LOCKFILE_BYTES, "", "lockfile"));
    } else if (base === "package-lock.json" && dir === "") {
      const got = get(reader, path, LOCKFILE_BYTES);
      const lock = got === null ? null : "failed" in got ? got.failed : npmLock(got.text);
      if (typeof lock === "string") gap(path, "", "lockfile", lock);
      else if (lock !== null) model.npmLock = lock;
    } else if (base === "yarn.lock" && dir === "") {
      const y = yarnLock(read(path, LOCKFILE_BYTES, "", "lockfile"));
      model.yarnWorkspace = y.workspace;
      model.yarnPublished = y.published;
    }
    if (path.endsWith(".py")) pyPackageDirs.add(dirOf(path));
  }
  // `src` folders that hold a Python package (a folder of .py files below them).
  for (const d of pyPackageDirs) {
    const parts = d.split("/");
    const i = parts.lastIndexOf("src");
    if (i !== -1 && i < parts.length - 1) pyRoots.add(parts.slice(0, i + 1).join("/"));
  }
  model.pyRoots = [...pyRoots].sort();

  // Workspaces: pnpm-workspace.yaml and package.json `workspaces`.
  const memberSet = new Set<NodeProject>();
  for (const path of all) {
    if (skipped(path)) continue;
    if (posix.basename(path) === "pnpm-workspace.yaml") {
      const globs = pnpmPackages(read(path, MANIFEST_BYTES, dirOf(path), "pnpm-workspace.yaml"));
      if (globs.length > 0) {
        model.workspaceFiles.push(path);
        for (const m of membersOf(globs, path, model.node)) memberSet.add(m);
      }
    }
  }
  for (const p of model.node) {
    if (p.pkg.workspaces && p.pkg.workspaces.length > 0) {
      model.workspaceFiles.push(p.file);
      for (const m of membersOf(p.pkg.workspaces, p.file, model.node)) memberSet.add(m);
    }
  }
  for (const m of memberSet) {
    if (m.pkg.name === null) continue;
    const list = model.members.get(m.pkg.name);
    if (list) list.push(m);
    else model.members.set(m.pkg.name, [m]);
  }
  placePathDeps(model, reader.root);
  return model;
}

// The nearest package.json folder at or above `file`'s folder.
export function nodeProjectOf(model: ProjectModel, file: string): NodeProject | null {
  let best: NodeProject | null = null;
  for (const p of model.node) {
    if ((p.dir === "" || file.startsWith(`${p.dir}/`)) && (best === null || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

// The nearest tsconfig.json (or jsconfig.json) at or above the file, and
// whether its globs admit the file (proved membership).
export function governingTsconfig(model: ProjectModel, file: string): { config: TsConfig; admits: boolean } | null {
  let d = dirOf(file);
  for (;;) {
    const config = model.tsconfigs.get(d);
    if (config) return { config, admits: tsAdmits(config, file) };
    if (d === "") return null;
    d = dirOf(d);
  }
}

// Where a dependency declared by a path (`file:` or `link:`) leads, found
// in the work tree when the model is built (placePath):
// - `folder`: a real folder of the repository, named by the names walked
//   from the root; `member`, the folder of the one workspace package of the
//   dependency's name when the folder reached is that very folder by
//   identity (device and inode), else null;
// - "outside": the path climbs above the repository root;
// - `link`: a name on the way is a symbolic link, which is not followed;
// - `notFolder`: a name on the way is missing or not a folder;
// - "unplaced": an absolute path or one from the home folder.
export type LinkPath = { folder: string; member: string | null } | { link: string } | { notFolder: string } | "outside" | "unplaced";

export type Link = { linkage: Linkage; declaredIn: string; spec: string; path?: LinkPath };

const sameFolder = (a: Id | null | undefined, b: Id | null | undefined): boolean => a != null && b != null && a.dev === b.dev && a.ino === b.ino;

// Walks the path of `spec` from the declaring package's folder `dir`, one
// name at a time from the repository root, as the system would and never
// by spelling alone: each name must be a real folder (a link anywhere on
// the way stops the walk, the last name included), `.` is skipped, and
// `..` is taken only from a folder walked into, which is known to be real,
// so it lands where its name says. Climbing above the root is "outside".
// `members`: the workspace packages of the dependency's name.
function placePath(folders: FolderReader, dir: string, spec: string, members: readonly NodeProject[] | undefined): LinkPath {
  const rest = spec.slice(spec.indexOf(":") + 1);
  if (rest.startsWith("/") || rest.startsWith("~") || /^[A-Za-z]:/.test(rest)) return "unplaced";
  const at: string[] = [];
  // One name further down, when it is a real folder; else what stops the walk there.
  const down = (name: string): LinkPath | null => {
    const names = [...at, name];
    const entry = folders.entry(names);
    if (entry.ok && entry.stat.isSymbolicLink()) return { link: names.join("/") };
    if (!entry.ok || !entry.stat.isDirectory()) return { notFolder: names.join("/") };
    at.push(name);
    return null;
  };
  // As npm and pnpm do (path.resolve), `..` is taken by its spelling: it
  // removes the name before it, whatever that name is on disk. The folders
  // the path then names are walked from the root one at a time, a link
  // anywhere on them refused.
  const joined = posix.normalize(posix.join(dir === "" ? "." : dir, rest));
  if (joined === ".." || joined.startsWith("../")) return "outside";
  for (const name of joined === "." ? [] : joined.split("/")) {
    const stop = down(name);
    if (stop !== null) return stop;
  }
  const reached = folders.ids(at)?.at(-1);
  const member = members?.length === 1 ? members[0]! : null;
  const memberId = member === null ? null : folders.ids(member.dir === "" ? [] : member.dir.split("/"))?.at(-1);
  return { folder: at.join("/"), member: member !== null && sameFolder(reached, memberId) ? member.dir : null };
}

// Places every dependency a package declares by a path (pkg.pathDeps), in
// the work tree under `root` as it is now. Done once, when the model is
// built, so a build reopened from its kept model gives the same answer.
function placePathDeps(model: ProjectModel, root: string): void {
  let folders: FolderReader | null | undefined;
  for (const p of model.node) {
    const placed: [string, LinkPath][] = [];
    for (const [name, spec] of p.pkg.deps) {
      if (!/^(link|file):/.test(spec)) continue;
      if (folders === undefined) {
        try {
          folders = new FolderReader(resolvePath(root));
        } catch {
          folders = null; // the root is not a folder: nothing can be placed
        }
      }
      placed.push([name, folders === null ? "unplaced" : placePath(folders, p.dir, spec, model.members.get(name))]);
    }
    if (placed.length > 0) p.pkg.pathDeps = placed;
  }
}

// How the importer's package is linked to the dependency `name`: declared
// with the workspace protocol (or a file or link path), resolved by a
// lockfile to a workspace link or to a published version, or declared with
// a plain range no lockfile settles. Null when the importer's package does
// not declare it.
export function linkageOf(model: ProjectModel, importer: string, name: string): Link | null {
  const project = nodeProjectOf(model, importer);
  const declaring = project?.pkg.deps.has(name) ? project : model.node.find((p) => p.dir === "" && p.pkg.deps.has(name)) ?? null;
  if (!declaring) return null;
  const spec = declaring.pkg.deps.get(name) as string;
  if (/^(link|file):/.test(spec)) {
    // A model kept before path dependencies were placed has no place for it: never bound.
    const path = declaring.pkg.pathDeps?.find(([n]) => n === name)?.[1] ?? "unplaced";
    return { linkage: "workspace", declaredIn: declaring.file, spec, path };
  }
  if (spec.startsWith("workspace:")) return { linkage: "workspace", declaredIn: declaring.file, spec };
  const fromPnpm = model.pnpmLinks.get(declaring.dir)?.get(name);
  if (fromPnpm && fromPnpm !== "unknown") return { linkage: fromPnpm, declaredIn: declaring.file, spec };
  const fromNpm = model.npmLock.get(declaring.dir === "" ? `node_modules/${name}` : `${declaring.dir}/node_modules/${name}`) ?? model.npmLock.get(`node_modules/${name}`);
  if (fromNpm && fromNpm !== "unknown") return { linkage: fromNpm, declaredIn: declaring.file, spec };
  if (model.yarnWorkspace.has(name)) return { linkage: "workspace", declaredIn: declaring.file, spec };
  if (model.yarnPublished.has(name)) return { linkage: "published", declaredIn: declaring.file, spec };
  return { linkage: "unknown", declaredIn: declaring.file, spec };
}

// Whether a path dependency may bind to the workspace package of its name
// (`memberDir`, null when no workspace package has the name). It binds only
// when its path, walked in the work tree with no link on the way, reaches
// that package's own folder, the same folder by identity: a name match or
// a spelling alone never binds it. Null: no path dependency, or the
// member's folder. "outside": the path leaves the repository, so the code
// is not the repository's and the call is external. A note: why it does
// not bind.
export function pathLinkOff(link: Link, name: string, memberDir: string | null): "outside" | { note: string } | null {
  const path = link.path;
  if (path === undefined) return null;
  if (path === "outside") return "outside";
  const declared = `${link.declaredIn} declares ${name} as ${link.spec}`;
  if (path === "unplaced") return { note: `${declared}, a path the graph cannot place in this repository` };
  if ("link" in path) return { note: `${declared}, whose path passes through ${path.link}, a symbolic link, which the graph does not follow` };
  if ("notFolder" in path) return { note: `${declared}, whose path passes through ${path.notFolder}, which is not a folder in the work tree` };
  if (memberDir !== null && path.member === memberDir) return null;
  const where = path.folder === "" ? "the repository root" : path.folder;
  return { note: memberDir === null ? `${declared}, which leads to ${where}, a folder of this repository that is no workspace package` : `${declared}, which leads to ${where}, not to the workspace package ${memberDir}` };
}

// The package name a bare specifier starts with: `@scope/name` or `name`.
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test sqlite".split(" "),
);

export function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  return NODE_BUILTINS.has(spec.split("/")[0] as string);
}

// The Python 3.11 standard library's top-level module names
// (sys.stdlib_module_names), the ones code imports.
const PY_STDLIB = new Set(
  "__future__ abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cgi cmath code codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd py_compile queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread".split(
    " ",
  ),
);

export function isPyStdlib(module: string): boolean {
  return PY_STDLIB.has(module.split(".")[0] as string);
}

const RUBY_STDLIB = new Set("json set yaml psych fileutils pathname time date tempfile open3 securerandom digest base64 erb logger optparse ostruct forwardable singleton net/http uri openssl socket stringio benchmark pp English shellwords csv bigdecimal zlib timeout monitor".split(" "));

export function isRubyStdlib(spec: string): boolean {
  return RUBY_STDLIB.has(spec) || RUBY_STDLIB.has(spec.split("/")[0] as string);
}

// Go: a standard library path has no dot in its first element.
export function isGoStdlib(spec: string): boolean {
  return !(spec.split("/")[0] as string).includes(".");
}
