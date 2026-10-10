// Reading the frozen snapshot a review runs on: its files, one hash over
// them, line counts, text and the files Git LFS holds. Nothing here writes.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeGit } from "@openqodex/core";

// Snapshot files bigger than this are neither redacted nor hashed by content.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Every regular file under `dir` but the work tree's .git link file, by
// path relative to `dir`. Links (there are none: they were written as
// plain files) and anything else are skipped.
export function snapshotFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (path === ".git") continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

// One hash over every snapshot file's path and content (size and time for a
// file over the limit): taken before the reviewer starts and after it ends.
export function hashSnapshot(dir: string): string {
  const h = createHash("sha256");
  for (const path of snapshotFiles(dir)) {
    const st = lstatSync(join(dir, path));
    h.update(`${path}\0`);
    h.update(st.size > MAX_FILE_BYTES ? `${st.size}:${st.mtimeMs}` : readFileSync(join(dir, path)));
    h.update("\0");
  }
  return h.digest("hex");
}

// Line counts of snapshot files, for the cited lines of dropped candidates.
export function lineCounter(dir: string): (path: string) => number | null {
  const cache = new Map<string, number | null>();
  return (path) => {
    if (cache.has(path)) return cache.get(path) ?? null;
    let n: number | null = null;
    const full = resolve(dir, path);
    const rel = relative(dir, full);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel !== ".git") {
      try {
        const st = lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) {
          const buf = readFileSync(full);
          n = 0;
          for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
          if (buf.length > 0 && buf[buf.length - 1] !== 10) n++;
        }
      } catch {
        n = null;
      }
    }
    cache.set(path, n);
    return n;
  };
}

// The text of a snapshot file, for the lines report.html shows around a
// finding of a whole-repository review: null for a path outside the
// snapshot, a link, a file over MAX_FILE_BYTES or one that is not UTF-8 text.
// The snapshot is already redacted (redactSnapshot).
export function snapshotText(dir: string): (path: string) => string | null {
  return (path) => {
    const full = resolve(dir, path);
    const rel = relative(dir, full);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel === ".git") return null;
    try {
      const st = lstatSync(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      const buf = readFileSync(full);
      const text = buf.toString("utf8");
      return buf.includes(0) || !Buffer.from(text, "utf8").equals(buf) ? null : text;
    } catch {
      return null;
    }
  };
}

// How many of `paths` the checkout stores in Git LFS: their content was not
// fetched, so the files hold pointers.
export async function lfsPaths(tree: string, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const r = await safeGit(tree, ["check-attr", "-z", "--stdin", "filter"], `${paths.join("\0")}\0`);
  if (r.code !== 0) return 0;
  const parts = r.stdout.toString("utf8").split("\0");
  let n = 0;
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") n++;
  return n;
}
