// The server review's snapshot, and the only two ways it reads the content
// of the host's clone. The clone stays the library's private git source: it
// is never checked out, never handed to a scanner or a tool, and nothing is
// written in it.
//   materialize       the head commit's admitted regular files, read with
//                     `git ls-tree` and `git cat-file` and written into a new
//                     folder under the caller's work folder, with the
//                     commit's bytes and executable bit; links and
//                     submodules are left out and recorded, and no .git
//   scopedBaseReader  a base version, for an admitted path only
// The snapshot's tree hash (snapshot.ts) is taken before and after the
// review as for the laptop's snapshot, and for the same admitted files it is
// the same hash.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OpenQodexError, SERVER_GIT_ENV, safeGit } from "@openqodex/core";
import { blobId, langOf, showBlob } from "@openqodex/graph";
import type { ListedFile } from "@openqodex/graph";
import type { Snapshot, SnapshotMaker } from "./review-change.js";
import type { Admit } from "./scopes.js";

// One file written into the snapshot: its path, its mode in the commit and
// git's id of its content.
export type MaterializedFile = { path: string; mode: "100644" | "100755"; blob: string };
// An admitted entry of the commit that is not a regular file, left out.
export type SkippedEntry = { path: string; kind: "link" | "submodule" };
export type Materialized = Snapshot & { files: MaterializedFile[]; skipped: SkippedEntry[] };

// File objects of the head that the clone does not hold (a partial clone
// made with a blob filter): their own reason, naming the fetch to add.
export class MissingObjects extends OpenQodexError {}

// How many bytes of file content one `git cat-file --batch` call carries
// (a single larger file is read on its own).
const BATCH_BYTES = 64 * 1024 * 1024;
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// A path a checkout may write: no empty, "." or ".." part and no ".git"
// part in any case, as git itself refuses to check out.
function checkoutSafe(path: string): boolean {
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

const split = (out: Buffer) => out.toString("utf8").split("\0").filter(Boolean);

type Entry = { mode: string; type: string; id: string; path: string };

// Every entry of the commit's tree, one level of folders flattened: "<mode>
// <type> <id>\t<path>".
async function listTree(clonePath: string, sha: string): Promise<Entry[]> {
  const r = await safeGit(clonePath, ["ls-tree", "-r", "-z", "--full-tree", sha], undefined, { ...SERVER_GIT_ENV });
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`;
    if (/lazy fetch|promisor|missing|could not read|not a tree object|unable to read/i.test(r.stderr)) {
      throw new MissingObjects(`missing objects: the folders of the head commit ${sha.slice(0, 12)} are not all in the clone, and openqodex fetches nothing; fetch the head commit with its trees before the review (${why})`);
    }
    throw new OpenQodexError(`could not list the files of ${sha.slice(0, 12)}: ${why}`);
  }
  return split(r.stdout).map((record) => {
    const tab = record.indexOf("\t");
    const [mode = "", type = "", id = ""] = record.slice(0, tab).split(" ");
    return { mode, type, id, path: record.slice(tab + 1) };
  });
}

// Each id's size, or null for an object the clone does not hold.
async function sizes(clonePath: string, ids: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  const r = await safeGit(clonePath, ["cat-file", "--batch-check"], `${unique.join("\n")}\n`, { ...SERVER_GIT_ENV });
  if (r.code !== 0) throw new OpenQodexError(`could not read the files of the clone: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
  for (const line of r.stdout.toString("utf8").split("\n")) {
    if (line === "") continue;
    const [id = "", type = "", size = ""] = line.split(" ");
    out.set(id, type === "missing" ? null : Number(size));
  }
  return out;
}

// The content of each id, from `git cat-file --batch`: "<id> <type>
// <size>\n<content>\n" per id asked.
async function contents(clonePath: string, ids: string[]): Promise<Map<string, Buffer>> {
  const r = await safeGit(clonePath, ["cat-file", "--batch"], `${ids.join("\n")}\n`, { ...SERVER_GIT_ENV });
  if (r.code !== 0) throw new OpenQodexError(`could not read the files of the clone: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
  const out = new Map<string, Buffer>();
  let at = 0;
  const buf = r.stdout;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl === -1) break;
    const [id = "", type = "", size = ""] = buf.subarray(at, nl).toString("utf8").split(" ");
    if (type !== "blob") throw new OpenQodexError(`could not read the file object ${id.slice(0, 12)} of the clone (${type})`);
    const n = Number(size);
    out.set(id, buf.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

// The admitted regular files of `headSha`, written into a new folder under
// `workDir` (`<workDir>/snapshot-<prefix>XXXXXX/tree`), each with the
// commit's bytes and mode 644 or 755. Links and submodules are recorded in
// `skipped` and never written; nothing outside the admission is written; no
// filter, hook or lazy fetch runs. A commit holding a path no checkout may
// write is refused. Files the clone lacks (a partial clone) end as
// MissingObjects, naming them and the fetch to add. A failure removes the
// folder it made.
export async function materialize(args: { clonePath: string; headSha: string; workDir: string; admit: Admit; prefix?: string }): Promise<Materialized> {
  const { clonePath, headSha, admit } = args;
  if (!FULL_ID.test(headSha)) throw new OpenQodexError(`the head ${JSON.stringify(headSha.slice(0, 80))} is not a full commit id`);
  const entries = await listTree(clonePath, headSha);
  const files: (MaterializedFile & { id: string })[] = [];
  const skipped: SkippedEntry[] = [];
  for (const e of entries) {
    if (!checkoutSafe(e.path)) {
      throw new OpenQodexError(`the commit ${headSha.slice(0, 12)} holds a path no checkout may write (${JSON.stringify(e.path.slice(0, 200))}); the review stops`);
    }
    if (!admit(e.path)) continue;
    if (e.mode === "120000") skipped.push({ path: e.path, kind: "link" });
    else if (e.mode === "160000") skipped.push({ path: e.path, kind: "submodule" });
    else if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755")) files.push({ path: e.path, mode: e.mode, blob: e.id, id: e.id });
  }
  const sized = await sizes(clonePath, files.map((f) => f.id));
  const missing = files.filter((f) => sized.get(f.id) == null).map((f) => f.path);
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(", ");
    throw new MissingObjects(
      `missing objects: ${missing.length} ${missing.length === 1 ? "file" : "files"} of the head commit ${headSha.slice(0, 12)} ${missing.length === 1 ? "is" : "are"} not in the clone (a partial clone made with a blob filter), and openqodex fetches nothing; ` +
        `fetch them before the review (in the clone, git checkout --detach ${headSha} fetches the head's files, or clone without --filter=blob:none); ` +
        `${missing.length > 5 ? "the first: " : ""}${shown}`,
    );
  }

  const folder = mkdtempSync(join(args.workDir, `snapshot-${args.prefix ?? ""}`));
  const tree = join(folder, "tree");
  try {
    mkdirSync(tree);
    const made = new Set<string>();
    // In batches of at most BATCH_BYTES of content, in the tree's order.
    for (let i = 0; i < files.length; ) {
      const batch: typeof files = [];
      let bytes = 0;
      while (i < files.length && (batch.length === 0 || bytes + (sized.get(files[i]!.id) ?? 0) <= BATCH_BYTES)) {
        bytes += sized.get(files[i]!.id) ?? 0;
        batch.push(files[i++]!);
      }
      const read = await contents(clonePath, [...new Set(batch.map((f) => f.id))]);
      for (const f of batch) {
        const content = read.get(f.id);
        if (content === undefined) throw new MissingObjects(`missing objects: ${f.path} of the head commit ${headSha.slice(0, 12)} could not be read from the clone`);
        const full = join(tree, f.path);
        const dir = dirname(full);
        if (!made.has(dir)) {
          mkdirSync(dir, { recursive: true });
          made.add(dir);
        }
        const mode = f.mode === "100755" ? 0o755 : 0o644;
        try {
          writeFileSync(full, content, { flag: "wx", mode });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new OpenQodexError(`two paths of the head commit differ only in case (${f.path}), which the work folder's file system cannot hold apart`);
          }
          throw error;
        }
        // The mode the commit gives, whatever the process's umask.
        chmodSync(full, mode);
      }
    }
    return { folder, tree, files: files.map((f) => ({ path: f.path, mode: f.mode, blob: f.blob })), skipped };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

// The server review's snapshot maker, for runReviewCore: each snapshot is
// materialised from the clone (`make`'s repoRoot) with `admit`. The host
// gives the config, so no settings are placed in it, and the commit's own
// .openqodex folder is never admitted. `made` holds every snapshot made, by
// its tree, for the graph's inventory and the record of what was left out.
export function materializedSnapshots(workDir: string, admit: Admit): SnapshotMaker & { made: Map<string, Materialized & { clonePath: string; sha: string }> } {
  const made = new Map<string, Materialized & { clonePath: string; sha: string }>();
  return {
    made,
    async make(repoRoot, sha, prefix, workingState) {
      if (workingState !== undefined) throw new OpenQodexError("the server review takes commits only, never a working state");
      const snap = await materialize({ clonePath: repoRoot, headSha: sha, workDir, admit, prefix });
      made.set(snap.tree, { ...snap, clonePath: repoRoot, sha });
      return { folder: snap.folder, tree: snap.tree };
    },
    placeSettings() {},
    // The attributes are read from the commit itself, in the clone.
    async lfsPaths(tree, paths) {
      const snap = made.get(tree);
      if (!snap || paths.length === 0) return 0;
      const r = await safeGit(snap.clonePath, ["check-attr", "-z", "--stdin", `--source=${snap.sha}`, "filter"], `${paths.join("\0")}\0`, { ...SERVER_GIT_ENV });
      if (r.code !== 0) return 0;
      const parts = r.stdout.toString("utf8").split("\0");
      let n = 0;
      for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") n++;
      return n;
    },
    async remove(_repoRoot, snapshot) {
      made.delete(snapshot.tree);
      rmSync(snapshot.folder, { recursive: true, force: true });
    },
    removeNow(_repoRoot, snapshot) {
      made.delete(snapshot.tree);
      rmSync(snapshot.folder, { recursive: true, force: true });
    },
  };
}

// The graph's inventory of a materialised snapshot: every file still there,
// each code file with git's id of the bytes it holds now (the secret
// redaction rewrites files in place after the snapshot is made), every
// other file with its id from the commit (only its path is used).
export function snapshotInventory(snap: Pick<Materialized, "tree" | "files">): ListedFile[] {
  const out: ListedFile[] = [];
  for (const f of snap.files) {
    if (langOf(f.path) === null) {
      out.push({ path: f.path, blob: f.blob });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(snap.tree, f.path));
    } catch {
      // removed from the snapshot (too large to check for secrets)
      continue;
    }
    out.push({ path: f.path, blob: blobId(bytes) });
  }
  return out;
}

// Reads the base version of a path from the private clone, for an admitted
// path only: the one way the graph, its packet and the scanners read base
// versions in a server review. A path the admission refuses is never read;
// it is added to `refused` and null comes back, as for a path the base does
// not hold or a file larger than `maxBytes`.
export function scopedBaseReader(args: { clonePath: string; baseSha: string; admit: Admit; refused?: Set<string> }): (path: string, maxBytes: number) => Promise<Buffer | null> {
  return async (path, maxBytes) => {
    if (!args.admit(path)) {
      args.refused?.add(path);
      return null;
    }
    return showBlob(args.clonePath, args.baseSha, path, maxBytes, SERVER_GIT_ENV);
  };
}
