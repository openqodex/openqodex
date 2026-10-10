// What the graph is built from: every eligible file of a folder git knows,
// with its content hash. The hash is git's blob id, so a file whose index
// entry is still valid is not read at all to name its facts: `git ls-files
// -s` gives the id, and `git diff-files` lists the files that changed since
// (git re-hashes the ones whose timestamps it cannot trust). Changed and
// untracked files are read and hashed here.
//
// Every git call goes through safeGit: the folder may be the temporary
// checkout of a branch or a pull request, whose files must start no program.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { extname, join } from "node:path";
import { safeGit } from "@openqodex/core";
import type { RepoReader } from "../safe-fs.js";
import type { Lang } from "../types.js";

const EXT_LANG: Record<string, Lang> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rb": "ruby",
  ".rake": "ruby",
};

// Folders that hold generated, vendored or installed code, never the repo's
// own, and the tool's own folders.
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  ".openqodex",
  ".openqodex-review",
]);

export function langOf(path: string): Lang | null {
  if (path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts") || /\.min\.[cm]?js$/.test(path)) return null;
  if (path.split("/").some((part) => SKIP_DIRS.has(part))) return null;
  return EXT_LANG[extname(path).toLowerCase()] ?? null;
}

// git's id of a blob with these bytes.
export function blobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export type InventoryEntry = { path: string; lang: Lang; blob: string; bytes: number };

export type Inventory = {
  all: string[]; // every path git lists (tracked and untracked, not ignored)
  entries: InventoryEntry[]; // eligible files the graph may read, in git's order
  tooBig: string[]; // eligible files over the size cap
  unreadable: string[]; // eligible files that vanished or are not regular files
  readFromDisk: number; // files read here to hash them
};

const split = (out: Buffer) => out.toString("utf8").split("\0").filter(Boolean);

// The inventory of `root`, a git work tree. `only`: the paths the graph may
// read (a whole-repository review passes its own list).
export async function takeInventory(root: string, reader: RepoReader, opts: { maxFileBytes: number; only?: ReadonlySet<string> }): Promise<Inventory> {
  const [staged, changed, others] = await Promise.all([
    safeGit(root, ["ls-files", "-s", "-z", "--cached"]),
    safeGit(root, ["diff-files", "--name-only", "-z", "--no-ext-diff"]),
    safeGit(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  if (staged.code !== 0) throw new Error(`git ls-files failed: ${staged.stderr.trim()}`);
  if (others.code !== 0) throw new Error(`git ls-files failed: ${others.stderr.trim()}`);
  const dirty = new Set(changed.code === 0 ? split(changed.stdout) : []);
  // An index entry is "<mode> <id> <stage>\t<path>".
  const indexed = new Map<string, { mode: string; id: string }>();
  for (const rec of split(staged.stdout)) {
    const tab = rec.indexOf("\t");
    const [mode, id] = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    if (!indexed.has(path) && mode && id) indexed.set(path, { mode, id });
  }
  const all = [...new Set([...indexed.keys(), ...split(others.stdout)])].filter((p) => opts.only === undefined || opts.only.has(p));
  const out: Inventory = { all, entries: [], tooBig: [], unreadable: [], readFromDisk: 0 };
  for (const path of all) {
    const lang = langOf(path);
    if (lang === null) continue;
    const entry = indexed.get(path);
    // A link (120000) or a submodule (160000) is not a file of this repository.
    if (entry && entry.mode !== "100644" && entry.mode !== "100755") continue;
    // A clean tracked file is one git has just matched to its index entry,
    // and git never looks past a link on a path, so its spelled path holds
    // no link. Any other file (changed, untracked) is looked at by identity:
    // a folder that became a link (git then lists its files as changed) is
    // never looked through, and what lies outside decides nothing.
    let st: { isFile(): boolean; isSymbolicLink(): boolean; size: number | bigint } | null;
    if (entry && !dirty.has(path)) {
      try {
        st = lstatSync(join(root, path));
      } catch {
        st = null; // gone since git listed it
      }
    } else {
      const looked = reader.entry(path);
      st = looked.ok ? looked.stat : null;
    }
    if (st === null) {
      out.unreadable.push(path);
      continue;
    }
    if (!st.isFile()) {
      if (!st.isSymbolicLink()) out.unreadable.push(path);
      continue;
    }
    const size = Number(st.size);
    if (size > opts.maxFileBytes) {
      out.tooBig.push(path);
      continue;
    }
    if (entry && !dirty.has(path)) {
      out.entries.push({ path, lang, blob: entry.id, bytes: size });
      continue;
    }
    const bytes = reader.readBytes(path, opts.maxFileBytes);
    if (bytes === null) {
      out.unreadable.push(path);
      continue;
    }
    out.readFromDisk++;
    out.entries.push({ path, lang, blob: blobId(bytes), bytes: bytes.length });
  }
  return out;
}

// A file of a folder git does not know, named by the caller with git's id of
// the bytes it holds now: the server review's materialised snapshot.
export type ListedFile = { path: string; blob: string };

// The inventory of `root` from the caller's list instead of git's: only the
// listed paths exist for the graph, in the list's order; no git runs. Each
// eligible file is looked at by identity, as an untracked file is above: a
// link is never looked through and is left out, anything else that is not
// a regular file is unreadable. Its content id is the caller's; a file that
// changed since the list was made is keyed by what is read when it is
// parsed, and the build says so.
export function listInventory(root: string, reader: RepoReader, opts: { files: readonly ListedFile[]; maxFileBytes: number; only?: ReadonlySet<string> }): Inventory {
  const listed = new Map<string, string>();
  for (const f of opts.files) if (!listed.has(f.path)) listed.set(f.path, f.blob);
  const all = [...listed.keys()].filter((p) => opts.only === undefined || opts.only.has(p));
  const out: Inventory = { all, entries: [], tooBig: [], unreadable: [], readFromDisk: 0 };
  for (const path of all) {
    const lang = langOf(path);
    if (lang === null) continue;
    const looked = reader.entry(path);
    if (!looked.ok) {
      out.unreadable.push(path);
      continue;
    }
    if (!looked.stat.isFile()) {
      if (!looked.stat.isSymbolicLink()) out.unreadable.push(path);
      continue;
    }
    const size = Number(looked.stat.size);
    if (size > opts.maxFileBytes) {
      out.tooBig.push(path);
      continue;
    }
    out.entries.push({ path, lang, blob: listed.get(path) as string, bytes: size });
  }
  return out;
}

// sha256 over the sorted paths and their content ids plus the analysis
// configuration: the graph input digest. Two captures with the same digest
// give the same graph.
export function inventoryDigest(entries: readonly InventoryEntry[], config: unknown): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(config));
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`\0${e.path}\0${e.blob}`);
  return h.digest("hex");
}
