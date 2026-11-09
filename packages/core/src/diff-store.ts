// Retain a bounded in-memory prefix, then stream complete per-file patches.
import { closeSync, mkdirSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Change, DiffEntry } from "./types.js";

const MEMORY_BYTES = 5 * 1024 * 1024;
const owned = new Map<string, () => void>();

// Remove only patches this process created, never a path supplied by a caller.
export function cleanupDiffs(change: Pick<Change, "diffs">): void {
  for (const entry of change.diffs ?? []) if (entry.file) owned.get(entry.file)?.();
}

export class DiffStore {
  private entries = new Map<string, { chunks: Buffer[]; file?: string }>();
  private bytes = 0;
  private spilled = false;
  private folder: string | null = null;
  private hostRoot: string | null = null;
  private next = 0;
  private fd: number | null = null;
  private active: string | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private id: string, private tempRoot?: string) {}

  private flush(): void {
    if (!this.pendingBytes) return;
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    for (let at = 0; at < bytes.length;) at += writeSync(this.fd!, bytes, at, bytes.length - at);
  }

  private close(): void {
    try { this.flush(); }
    finally {
      if (this.fd !== null) closeSync(this.fd);
      this.fd = null;
      this.active = null;
    }
  }

  private write(file: string, chunk: Buffer): void {
    if (this.active !== file) {
      this.close();
      this.fd = openSync(file, "a");
      this.active = file;
    }
    this.pending.push(Buffer.from(chunk));
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= 64 * 1024) this.flush();
  }

  push(path: string, chunk: Buffer): void {
    let entry = this.entries.get(path);
    if (!entry) this.entries.set(path, (entry = { chunks: [] }));
    if (!entry.file && (this.spilled || this.bytes + chunk.length > MEMORY_BYTES)) {
      this.spilled = true;
      if (this.folder === null) {
        this.hostRoot = this.tempRoot ?? mkdtempSync(join(tmpdir(), "openqodex-diff-"));
        this.folder = join(this.hostRoot, this.id, "diff");
        mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      }
      // Concurrent reviews of the same change never overwrite one another.
      let recreated = false;
      for (;;) {
        const file = join(this.folder, `${this.next++}.patch`);
        try {
          const fd = openSync(file, "wx", 0o600);
          closeSync(fd);
          entry.file = file;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" && !recreated) {
            recreated = true;
            mkdirSync(this.folder, { recursive: true, mode: 0o700 });
          } else if (code !== "EEXIST") throw error;
        }
      }
      const file = entry.file;
      const folder = this.folder;
      const parents = [folder, dirname(folder), ...(this.tempRoot === undefined ? [this.hostRoot!] : [])];
      owned.set(file, () => {
        try { unlinkSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        owned.delete(file);
        // Other concurrent reviews may still own files in these directories.
        for (const dir of parents) {
          try { rmdirSync(dir); }
          catch (error) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
      });
      for (const prior of entry.chunks) { this.write(file, prior); this.bytes -= prior.length; }
      entry.chunks = [];
    }
    if (entry.file) this.write(entry.file, chunk);
    else { entry.chunks.push(Buffer.from(chunk)); this.bytes += chunk.length; }
  }

  finish(): DiffEntry[] {
    this.close();
    return [...this.entries].map(([path, entry]) => entry.file ? { path, file: entry.file } : { path, text: Buffer.concat(entry.chunks).toString("utf8") });
  }

  dispose(): void {
    try { this.close(); }
    finally { cleanupDiffs({ diffs: [...this.entries].flatMap(([path, e]) => e.file ? [{ path, file: e.file }] : []) }); }
  }
}
