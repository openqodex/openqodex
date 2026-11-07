// The one way OpenQodex changes a file it does not own outright: every
// write, rename and delete is decided by filesystem identity and done
// through checked handles. init and the commands around it, the update
// worker, the home receipts and the repository's .openqodex files write no
// other way (packages/cli/test/guarded-writes.test.ts checks).
//
// Deciding. A path is walked the way the system walks it: one name at a
// time from the root, each name looked up without following it, a link
// followed where it stands, `.` and `..` taken after the links before them.
// Every folder reached is known by its device and inode, never by how it
// was spelled, so case, Unicode normalisation and different spellings of
// one folder stop mattering. Then:
// - a link whose own folder lies, by identity, in the repository's work
//   tree, and not in a git folder that itself lies inside the work tree, is
//   refused: the repository decides where it points (agents/git.ts
//   inWorkTree draws the same line). A link anywhere else is the
//   developer's own (a dotfiles repo links ~/.claude/settings.json) and is
//   followed;
// - the folder the path lands in must lie, by identity, under one of the
//   folders init may write (each opened once, when the guard is made).
//
// Doing. A write opens the verified folder (O_DIRECTORY | O_NOFOLLOW) and
// keeps the handle, creates its temp file with O_CREAT | O_EXCL | O_NOFOLLOW,
// writes, fsyncs and renames it into place. Node has no renameat(2), so the
// rename goes by path; the closing check is that, after it, the final path
// holds the very file written (same device and inode as the open handle) in
// the very folder verified. On any mismatch it removes what it can and
// fails. A delete never follows a link, and checks the identity of the
// folder before each name it removes inside it.
//
// Reading. FolderReader reads under a root known by identity: every read
// walks from that root down one name at a time, each name a real folder
// (lstat: a link is not one), opens the file without following a link,
// then walks again and requires the same folders, by device and inode, and
// the opened file at its name. A link put on the way before the open, or
// put there and taken away again around it, fails one of those checks.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

// Both macOS and Linux define these; a platform without them gets 0, and
// the identity checks after each step still hold.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_LINKS = 40;

export type Id = { dev: bigint; ino: bigint };

// What a write reports: a file it replaced, or the folder it landed in,
// that let other users read more than the write asked for.
export type Wider = (path: string, mode: number, kind: "file" | "folder") => void;

function same(a: Id | null | undefined, b: Id | null | undefined): boolean {
  return a != null && b != null && a.dev === b.dev && a.ino === b.ino;
}

function lstatOf(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function idOf(st: BigIntStats | null): Id | null {
  return st === null ? null : { dev: st.dev, ino: st.ino };
}

type Step = { name: string; id: Id };

// Where a path leads. `chain`: the folders that exist from the root down,
// each by name and identity; `dir`: the last of them as a path. `pending`:
// the names below it that do not exist yet, the last one the final name.
// `final`: the final name; `stat`: its lstat when it exists.
type Walk = { chain: Step[]; dir: string; pending: string[]; final: string; stat: BigIntStats | null };

function rootStep(root: string): Step {
  return { name: root, id: idOf(lstatSync(root, { bigint: true }))! };
}

// Windows takes either slash between names.
const SEPS = sep === "\\" ? /[\\/]/ : "/";

// The root a path starts from (`/`, `F:\`, `\\server\share\`) and the names
// below it. Starting every path at `sep` would make the drive a name: on
// Windows `F:\a` became the folder `\F:` and a mkdir of `F:\F:`.
export function split(path: string, paths = { parse, sep }): { root: string; names: string[] } {
  const root = paths.parse(path).root;
  const separators = paths.sep === "\\" ? /[\\/]/ : "/";
  return { root, names: path.slice(root.length).split(separators) };
}

// Walks `path` as the system does. `followLast`: a link as the last name is
// followed too (where a write lands) or kept as itself (what a delete
// takes). `onLink` sees the folders above each link before it is followed.
// With `folders`, every name is taken as a folder and the walk returns where
// the path stands, existing or not (`final` empty).
function walk(path: string, followLast: boolean, onLink: (chain: Step[], at: string) => void, folders = false): Walk {
  if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path`);
  const start = split(path);
  let parts = start.names;
  let chain = [rootStep(start.root)];
  let at = start.root;
  const pending: string[] = [];
  let links = 0;
  while (parts.length > 0) {
    const name = parts.shift()!;
    if (name === "" || name === ".") continue;
    const last = parts.every((p) => p === "" || p === ".");
    if (name === "..") {
      if (pending.length > 0) throw new Error(`${path} climbs with .. out of a folder that does not exist`);
      if (chain.length > 1) chain = chain.slice(0, -1);
      at = dirname(at);
      continue;
    }
    if (pending.length > 0) {
      pending.push(name);
      continue;
    }
    const next = join(at, name);
    const st = lstatOf(next);
    if (st === null) {
      pending.push(name);
      continue;
    }
    if (st.isSymbolicLink() && !(last && !followLast && !folders)) {
      onLink(chain, next);
      if (++links > MAX_LINKS) throw new Error(`more than ${MAX_LINKS} symbolic links on the way to ${path}`);
      const target = readlinkSync(next);
      if (isAbsolute(target)) {
        const to = split(target);
        parts = [...to.names, ...parts];
        chain = [rootStep(to.root)];
        at = to.root;
      } else {
        parts = [...target.split(SEPS), ...parts];
      }
      continue;
    }
    if (st.isDirectory() && (folders || !last)) {
      chain = [...chain, { name, id: idOf(st)! }];
      at = next;
      continue;
    }
    if (!last || folders) throw new Error(`${next} is not a folder`);
    return { chain, dir: at, pending: [], final: name, stat: st };
  }
  if (folders) return { chain, dir: at, pending, final: "", stat: null };
  if (pending.length > 0) return { chain, dir: at, pending, final: pending[pending.length - 1]!, stat: null };
  throw new Error(`${path} names no file`);
}

// A folder init may write: where its path stands by identity, `anchor` the
// deepest folder of it that exists, `tail` the names below that do not yet.
type Root = { anchor: Id; tail: string[]; ids: Id[] };

export type Roots = {
  // The repository's work tree; null outside a repository.
  repoRoot: string | null;
  // Its git folders. Only one that lies inside the work tree exempts the
  // links under it; a common git folder that holds the work tree does not.
  gitFolders: string[];
  // Every other folder init may write: the home folder, the agents' own
  // folders, OpenQodex's home.
  roots: string[];
  // false: the work tree and its git folders only decide which links are
  // refused, and nothing is written there but under `roots` (a --report-dir
  // writer). Default true: they are folders this guard writes too.
  writeRepo?: boolean;
};

export class Guard {
  private roots: Root[] = [];
  private tree: Id | null = null;
  private exempt: Id[] = [];
  // With `noLinks`, a link anywhere under a root, the final name included,
  // is refused, not followed.
  private noLinks: boolean;

  constructor(r: Roots & { noLinks?: boolean }) {
    this.noLinks = r.noLinks === true;
    const none = (): void => undefined;
    const writeRepo = r.writeRepo !== false;
    if (r.repoRoot !== null) {
      const w = walk(r.repoRoot, true, none, true);
      if (w.pending.length === 0) this.tree = w.chain[w.chain.length - 1]!.id;
      if (writeRepo) this.add(r.repoRoot);
    }
    for (const g of r.gitFolders) {
      const w = walk(g, true, none, true);
      if (w.pending.length > 0) continue;
      const ids = w.chain.map((s) => s.id);
      const at = ids.findIndex((id) => same(id, this.tree));
      // Inside the work tree, and not the work tree itself.
      if (at !== -1 && at < ids.length - 1) this.exempt.push(ids[ids.length - 1]!);
      if (writeRepo) this.add(g);
    }
    for (const root of r.roots) this.add(root);
  }

  // Adds a folder init may write, such as the hooks folder git names.
  add(root: string): void {
    try {
      const w = walk(root, true, () => undefined, true);
      this.roots.push({ anchor: w.chain[w.chain.length - 1]!.id, tail: w.pending, ids: w.chain.map((s) => s.id) });
    } catch {
      // A root that cannot be walked holds nothing init writes.
    }
  }

  private refuseRepoLink = (chain: Step[], at: string): void => {
    if (this.noLinks && this.roots.some((r) => chain.some((s) => same(s.id, r.anchor)))) {
      throw new Error(`${at} is a symbolic link; openqodex writes no file there through a link`);
    }
    if (this.tree === null) return;
    const ids = chain.map((s) => s.id);
    const w = ids.findIndex((id) => same(id, this.tree));
    if (w === -1) return;
    if (ids.some((id, i) => i > w && this.exempt.some((g) => same(g, id)))) return;
    throw new Error(`${at} is a symbolic link inside the repository; openqodex does not write through links the repository holds`);
  };

  // True when a folder chain, with names still to create below it, lies
  // under a root by identity.
  private under(chain: Step[], below: string[]): boolean {
    return this.roots.some((r) => {
      const at = chain.findIndex((s) => same(s.id, r.anchor));
      if (at === -1) return false;
      const after = [...chain.slice(at + 1).map((s) => s.name), ...below];
      return r.tail.every((name, i) => after[i] === name);
    });
  }

  // Where a write (or, with followLast false, a delete) of `path` lands, or
  // the reason it may not.
  check(path: string, followLast = true): Walk {
    const w = walk(path, followLast, this.refuseRepoLink);
    if (!this.under(w.chain, w.pending.slice(0, -1))) {
      throw new Error(`${path} lands in ${w.dir}, outside every folder openqodex writes to`);
    }
    return w;
  }

  // Makes the folders a write needs, one at a time, each checked to be a
  // real folder in the folder before it. Returns the last one as a path
  // and an open handle on it.
  private folderOf(w: Walk, mode = 0o700): { dir: string; fd: number; id: Id } {
    let dir = w.dir;
    let id = w.chain[w.chain.length - 1]!.id;
    for (const name of w.pending.slice(0, -1)) {
      const next = join(dir, name);
      try {
        mkdirSync(next, mode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const st = lstatOf(next);
      if (st === null || !st.isDirectory() || st.isSymbolicLink()) throw new Error(`${next} is not a folder openqodex made`);
      if (!same(idOf(lstatOf(dir)), id)) throw new Error(`${dir} changed while openqodex was writing in it`);
      dir = next;
      id = idOf(st)!;
    }
    const fd = openSync(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    if (!same(idOf(fstatSync(fd, { bigint: true })), id)) {
      closeSync(fd);
      throw new Error(`${dir} changed while openqodex was writing in it`);
    }
    return { dir, fd, id };
  }

  // Writes `data` where `path` lands, as a new file renamed into place
  // (with `exclusive`, created where nothing is: false says something was).
  // A file gets its mode when it is created, never by a chmod after: `mode`
  // (default 0600), or with `keepMode` the mode of the file it replaces, for
  // a file the developer owns that init edits in place. Folders it makes on
  // the way get `folderMode` (default 0700) when they are made.
  //
  // Without keepMode, `wider` hears of what other users could read more of
  // than asked for: the file it replaced (its content now has `mode`), and
  // the folder it landed in when that folder was already there.
  write(
    path: string,
    data: string | Buffer,
    opts: { mode?: number; keepMode?: boolean; exclusive?: boolean; folderMode?: number; wider?: Wider } = {},
  ): boolean {
    const w = this.check(path);
    if (w.stat !== null && !w.stat.isFile()) throw new Error(`${join(w.dir, w.final)} is not a regular file`);
    if (opts.exclusive && w.stat !== null) return false;
    const folderMode = opts.folderMode ?? 0o700;
    const madeFolders = w.pending.length > 1;
    const folder = this.folderOf(w, folderMode);
    const final = join(folder.dir, w.final);
    const before = w.stat === null ? null : Number(w.stat.mode & 0o777n);
    const mode = opts.keepMode && before !== null ? before : (opts.mode ?? 0o600);
    const tmp = opts.exclusive ? final : join(folder.dir, `.${w.final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    let fd: number;
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
    } catch (error) {
      closeSync(folder.fd);
      if (opts.exclusive && (error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const written = idOf(fstatSync(fd, { bigint: true }))!;
    const ours = (p: string): boolean => same(idOf(lstatOf(p)), written);
    try {
      if (!ours(tmp) || !same(idOf(lstatOf(folder.dir)), folder.id)) throw new Error(`${folder.dir} changed while openqodex was writing in it`);
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
      if (!opts.exclusive) renameSync(tmp, final);
      // The closing check, since Node has no renameat(2) and the rename went
      // by path: the final path must hold the file just written, in the
      // folder verified when the handle was opened.
      if (!ours(final) || !same(idOf(lstatOf(folder.dir)), idOf(fstatSync(folder.fd, { bigint: true })))) {
        if (ours(final)) unlinkSync(final);
        throw new Error(`${final} is not where openqodex wrote it; the write was undone where it could be`);
      }
      if (!opts.keepMode && opts.wider !== undefined) {
        if (before !== null && (before & ~mode) !== 0) opts.wider(final, before, "file");
        const dirMode = Number(fstatSync(folder.fd, { bigint: true }).mode & 0o777n);
        if (!madeFolders && (dirMode & ~folderMode) !== 0) opts.wider(folder.dir, dirMode, "folder");
      }
      return true;
    } catch (error) {
      // The temp file, or the file an exclusive write made: ours to remove.
      if (ours(tmp)) unlinkSync(tmp);
      throw error;
    } finally {
      closeSync(fd);
      closeSync(folder.fd);
    }
  }

  // Takes from the existing folder `path` every permission `mode` does not
  // give, through a handle on the folder checked by identity; never follows
  // a link. The folder lies under a root, or is a root itself as it stood
  // when the guard was made (the one folder a --report-dir writer writes):
  // taking permissions away from it widens nothing. Returns the mode it had
  // when it took any, else null.
  narrowFolder(path: string, mode: number): number | null {
    const w = walk(path, false, this.refuseRepoLink);
    const isRoot = w.stat !== null && this.roots.some((r) => r.tail.length === 0 && same(r.anchor, idOf(w.stat)));
    if (!isRoot && !this.under(w.chain, w.pending.slice(0, -1))) {
      throw new Error(`${path} lands in ${w.dir}, outside every folder openqodex writes to`);
    }
    if (w.stat === null || !w.stat.isDirectory()) return null;
    const had = Number(w.stat.mode & 0o777n);
    if ((had & ~mode) === 0) return null;
    const fd = openSync(join(w.dir, w.final), constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      if (!same(idOf(fstatSync(fd, { bigint: true })), idOf(w.stat))) throw new Error(`${join(w.dir, w.final)} changed while openqodex was checking it`);
      fchmodSync(fd, had & mode);
      return had;
    } finally {
      closeSync(fd);
    }
  }

  // Reads the regular file `path` names, at most `maxBytes`; null when it is
  // missing. Decided as a delete is (the last name not followed): the
  // folder it lies in must be, by identity, under a root, and with
  // `noLinks` no link may stand on the way. Then the file is opened without
  // following a link, and the open handle must be the very file walked to,
  // in the very folder verified, before a byte is read through it. A link
  // at the file, a folder swapped meanwhile, anything but a regular file or
  // one past the bound throws.
  read(path: string, maxBytes: number): Buffer | null {
    const w = this.check(path, false);
    if (w.stat === null) return null;
    if (!w.stat.isFile()) throw new Error(`${join(w.dir, w.final)} is not a regular file`);
    const want = idOf(w.stat)!;
    const folder = w.chain[w.chain.length - 1]!.id;
    const fd = openSync(join(w.dir, w.final), constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile() || !same(idOf(st), want) || !same(idOf(lstatOf(w.dir)), folder)) throw new Error(`${join(w.dir, w.final)} changed while openqodex was reading it`);
      if (st.size > BigInt(maxBytes)) throw new Error(`${join(w.dir, w.final)} is over ${maxBytes} bytes`);
      const buf = Buffer.alloc(Number(st.size));
      let off = 0;
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, off);
        if (n === 0) break;
        off += n;
      }
      return buf.subarray(0, off);
    } finally {
      closeSync(fd);
    }
  }

  // A copy of `data` beside `path`, as `<path>.openqodex.bak` or `.bak.2`,
  // `.bak.3`, ...; created exclusively and private (0600).
  backup(path: string, data: string): string {
    const w = this.check(path, false);
    const base = join(w.dir, w.final);
    for (let n = 1; ; n++) {
      const candidate = `${base}.openqodex.bak${n === 1 ? "" : `.${n}`}`;
      if (this.write(candidate, data, { mode: 0o600, exclusive: true })) return candidate;
    }
  }

  // Removes the file or link `path` names, never what a link points at;
  // nothing when it is missing. A folder is refused: removeTree takes one.
  remove(path: string): void {
    const w = this.check(path, false);
    if (w.stat === null) return;
    if (w.stat.isDirectory()) throw new Error(`${join(w.dir, w.final)} is a folder`);
    this.unlinkIn(w.dir, w.chain[w.chain.length - 1]!.id, w.final, idOf(w.stat)!);
  }

  // Unlinks `name` in the folder `dir` known as `id`, when both are still
  // the ones checked; after it, the folder must still be that folder.
  private unlinkIn(dir: string, id: Id, name: string, entry: Id): void {
    const fd = openSync(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      if (!same(idOf(fstatSync(fd, { bigint: true })), id)) throw new Error(`${dir} changed while openqodex was removing in it`);
      const p = join(dir, name);
      if (!same(idOf(lstatOf(p)), entry)) throw new Error(`${p} changed while openqodex was removing it`);
      unlinkSync(p);
      if (!same(idOf(lstatOf(dir)), id)) throw new Error(`${dir} changed while openqodex was removing in it`);
    } finally {
      closeSync(fd);
    }
  }

  // Removes a folder and everything in it, never following a link: a link
  // inside is removed as itself, and the folder's identity is checked again
  // before each name removed in it. A link or file at `path` is removed as
  // itself. Nothing when it is missing.
  removeTree(path: string): void {
    const w = this.check(path, false);
    if (w.stat === null) return;
    if (!w.stat.isDirectory()) return this.remove(path);
    this.clearFolder(join(w.dir, w.final), idOf(w.stat)!);
    this.rmdirIn(w.dir, w.chain[w.chain.length - 1]!.id, w.final, idOf(w.stat)!);
  }

  private clearFolder(dir: string, id: Id): void {
    const fd = openSync(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      if (!same(idOf(fstatSync(fd, { bigint: true })), id)) throw new Error(`${dir} changed while openqodex was removing in it`);
      for (const name of readdirSync(dir)) {
        if (!same(idOf(lstatOf(dir)), id)) throw new Error(`${dir} changed while openqodex was removing in it`);
        const st = lstatOf(join(dir, name));
        if (st === null) continue;
        if (st.isDirectory()) {
          this.clearFolder(join(dir, name), idOf(st)!);
          this.rmdirIn(dir, id, name, idOf(st)!);
        } else this.unlinkIn(dir, id, name, idOf(st)!);
      }
    } finally {
      closeSync(fd);
    }
  }

  private rmdirIn(dir: string, id: Id, name: string, entry: Id): void {
    if (!same(idOf(lstatOf(dir)), id)) throw new Error(`${dir} changed while openqodex was removing in it`);
    const p = join(dir, name);
    if (!same(idOf(lstatOf(p)), entry)) throw new Error(`${p} changed while openqodex was removing it`);
    rmdirSync(p);
  }

  // Removes the folder `path` when it is empty; true when it did.
  removeEmptyFolder(path: string): boolean {
    const w = this.check(path, false);
    if (w.stat === null || !w.stat.isDirectory()) return false;
    if (readdirSync(join(w.dir, w.final)).length > 0) return false;
    this.rmdirIn(w.dir, w.chain[w.chain.length - 1]!.id, w.final, idOf(w.stat)!);
    return true;
  }

  // Makes the folder `path`, which must not exist yet, and its parents,
  // each with `mode` (default 0700) when it is made.
  makeFolder(path: string, mode = 0o700): void {
    const w = this.check(join(path, ".openqodex-folder"));
    if (w.pending.length < 2) throw new Error(`${path} is there already`);
    closeSync(this.folderOf(w, mode).fd);
  }

  // Renames `from` to `to`, a name that must be free; afterwards `to` must
  // hold what `from` held.
  rename(from: string, to: string): void {
    const a = this.check(from, false);
    if (a.stat === null) throw new Error(`${from} is not there`);
    const b = this.check(to, false);
    if (b.stat !== null) throw new Error(`${to} is there already`);
    const moved = idOf(a.stat)!;
    const src = join(a.dir, a.final);
    if (!same(idOf(lstatOf(src)), moved)) throw new Error(`${src} changed while openqodex was moving it`);
    const folder = this.folderOf(b);
    try {
      const dst = join(folder.dir, b.final);
      renameSync(src, dst);
      // The closing check, as for a write.
      if (!same(idOf(lstatOf(dst)), moved) || !same(idOf(lstatOf(folder.dir)), folder.id)) throw new Error(`${dst} is not where openqodex moved ${src}`);
    } finally {
      closeSync(folder.fd);
    }
  }

  // Copies the folder `src` (this package: plain files and folders) to a
  // new folder `dst`, file by file through `write`. `skipTop` names entries
  // left out at the top. A link or anything else in `src` is refused.
  copyTree(src: string, dst: string, skipTop: string[] = []): void {
    this.makeFolder(dst);
    const copy = (from: string, to: string, top: boolean): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (top && skipTop.includes(entry.name)) continue;
        const a = join(from, entry.name);
        const b = join(to, entry.name);
        if (entry.isDirectory()) {
          this.makeFolder(b);
          copy(a, b, false);
        } else if (entry.isFile()) {
          this.write(b, readFileSync(a), { exclusive: true, mode: Number(lstatSync(a).mode & 0o777) });
        } else throw new Error(`${a} is not a plain file or folder`);
      }
    };
    copy(src, dst, true);
  }
}

// ---------- reading ----------

// Why a read gave nothing: "missing", nothing there; "refused", a link, a
// name that is not a folder or not a regular file, a file over the bound,
// or folders that changed during the read; "untrusted", a folder or the
// file that `accept` did not take.
export type ReadRefusal = "missing" | "refused" | "untrusted";
export type ReadResult = { ok: true; data: Buffer; stat: BigIntStats } | { ok: false; why: ReadRefusal };
export type EntryResult = { ok: true; stat: BigIntStats } | { ok: false; why: ReadRefusal };

// What a reader takes on the way: the lstat of each folder below the root
// and of the entry read, with its depth (0 for the first name below the
// root).
export type Accept = (st: BigIntStats, depth: number) => boolean;

// True when only this process's user can change the file or folder: that
// user owns it, and neither its group nor other users may write it. Other
// users may read it. A platform without user ids (Windows) has no owner or
// mode bits that say this, and is not judged. The user id is asked once:
// a build judges every folder of 14,000 reads.
const MY_UID = process.getuid?.();
export function writableByMeAlone(st: { uid: number | bigint; mode: number | bigint }): boolean {
  if (MY_UID === undefined) return true;
  return Number(st.uid) === MY_UID && (Number(st.mode) & 0o022) === 0;
}

function lstatQuiet(path: string): BigIntStats | null | "error" {
  try {
    return lstatSync(path, { bigint: true, throwIfNoEntry: false }) ?? null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? null : "error";
  }
}

function sameIds(a: Id[], b: Id[]): boolean {
  return a.length === b.length && a.every((id, i) => same(id, b[i]));
}

// One plain name: never empty, ".", ".." or holding a separator.
function plainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes(sep);
}

export class FolderReader {
  private readonly rootId: Id;
  // The root with no separator at its end ("" for the file system's root),
  // so a path below it is this plus a separator and each name: every name
  // is checked to be plain, and joining by hand costs less than join() on
  // the 14,000 reads of one build.
  private readonly base: string;

  // `root`, an absolute path, is known by its identity from now on. It is
  // found with stat, which follows a link: the path to the root is the
  // caller's own, as the Guard takes it. Throws when the root is not a
  // folder.
  constructor(
    readonly root: string,
    private readonly accept: Accept = () => true,
  ) {
    if (!isAbsolute(root)) throw new Error(`${root} is not an absolute path`);
    const st = statSync(root, { bigint: true });
    if (!st.isDirectory()) throw new Error(`${root} is not a folder`);
    this.rootId = idOf(st)!;
    this.base = join(root).replace(/[\\/]+$/, "");
  }

  private pathOf(names: string[]): string {
    let at = this.base;
    for (const name of names) at += sep + name;
    return at === "" ? sep : at;
  }

  // The identities of the root and of each folder `names` names under it,
  // from the root down; or why not.
  private walkIds(names: string[]): Id[] | ReadRefusal {
    let root: BigIntStats;
    try {
      root = statSync(this.root, { bigint: true });
    } catch {
      return "refused";
    }
    if (!same(idOf(root), this.rootId)) return "refused";
    const ids = [this.rootId];
    let at = this.base;
    for (const [depth, name] of names.entries()) {
      if (!plainName(name)) return "refused";
      at += sep + name;
      const st = lstatQuiet(at);
      if (st === null) return "missing";
      // isDirectory is false for a link: lstat does not follow it.
      if (st === "error" || !st.isDirectory()) return "refused";
      if (!this.accept(st, depth)) return "untrusted";
      ids.push(idOf(st)!);
    }
    return ids;
  }

  // The identities of the folders from the root down to `names`, when each
  // is a real folder `accept` takes; null otherwise.
  ids(names: string[]): Id[] | null {
    const ids = this.walkIds(names);
    return Array.isArray(ids) ? ids : null;
  }

  // The folder `names` as a path, when every folder from the root down to
  // it is a real folder `accept` takes; null otherwise. A caller that reads
  // through the path checks again after (`list`, `read` and `entry` do).
  folder(names: string[]): string | null {
    return this.ids(names) === null ? null : this.pathOf(names);
  }

  // The names in the folder `names`, read between two walks that find the
  // same folders; null when they do not.
  list(names: string[]): { dir: string; names: string[] } | null {
    const before = this.ids(names);
    if (before === null) return null;
    const dir = this.pathOf(names);
    let found: string[];
    try {
      found = readdirSync(dir);
    } catch {
      return null;
    }
    const after = this.ids(names);
    return after !== null && sameIds(before, after) ? { dir, names: found } : null;
  }

  // The lstat of the entry `names` names (any kind: the caller judges it),
  // taken between two walks that find the same folders, when `accept` takes
  // it.
  entry(names: string[]): EntryResult {
    if (names.length === 0 || !plainName(names[names.length - 1]!)) return { ok: false, why: "refused" };
    const folders = names.slice(0, -1);
    const before = this.walkIds(folders);
    if (!Array.isArray(before)) return { ok: false, why: before };
    const st = lstatQuiet(this.pathOf(names));
    if (st === null) return { ok: false, why: "missing" };
    if (st === "error") return { ok: false, why: "refused" };
    const after = this.ids(folders);
    if (after === null || !sameIds(before, after)) return { ok: false, why: "refused" };
    return this.accept(st, names.length - 1) ? { ok: true, stat: st } : { ok: false, why: "untrusted" };
  }

  // The regular file `names` names, read whole when it holds at most
  // `maxBytes`. The file is opened without following a link and without
  // blocking (a named pipe cannot hold the open); after the open the
  // folders from the root down must be the same ones, and the name must
  // hold the very file opened.
  read(names: string[], maxBytes: number): ReadResult {
    if (names.length === 0 || !plainName(names[names.length - 1]!)) return { ok: false, why: "refused" };
    const folders = names.slice(0, -1);
    const before = this.walkIds(folders);
    if (!Array.isArray(before)) return { ok: false, why: before };
    const abs = this.pathOf(names);
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    } catch (error) {
      return { ok: false, why: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "refused" };
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) return { ok: false, why: "refused" };
      if (!this.accept(st, names.length - 1)) return { ok: false, why: "untrusted" };
      if (st.size > BigInt(maxBytes)) return { ok: false, why: "refused" };
      const after = this.ids(folders);
      const at = lstatQuiet(abs);
      if (after === null || !sameIds(before, after) || at === null || at === "error" || !same(idOf(at), idOf(st))) return { ok: false, why: "refused" };
      const size = Number(st.size);
      const data = Buffer.allocUnsafe(size);
      let off = 0;
      while (off < size) {
        const n = readSync(fd, data, off, size - off, off);
        if (n === 0) break;
        off += n;
      }
      const end = fstatSync(fd, { bigint: true });
      const named = lstatQuiet(abs);
      const finalFolders = this.ids(folders);
      if (off !== size || end.size !== st.size || end.mtimeNs !== st.mtimeNs || end.ctimeNs !== st.ctimeNs ||
          named === null || named === "error" || !same(idOf(named), idOf(st)) ||
          finalFolders === null || !sameIds(before, finalFolders)) return { ok: false, why: "refused" };
      return { ok: true, data, stat: st };
    } catch {
      return { ok: false, why: "refused" };
    } finally {
      closeSync(fd);
    }
  }
}

// A guard for OpenQodex's own home alone, for the writers that run outside
// init (the update worker, `hook install`, the home receipts); one per home
// in this process. `strict`: no link at all under the home, the final file
// included, for the folders only OpenQodex writes and reads back (receipts/,
// runs/, last-review/, runtime/): there a link is never the developer's, so
// a receipt written through receipts/<repo>/latest.json -> ../../config.yaml
// cannot land on another file of the home, and a record read through a
// linked folder is no record.
const homeGuards = new Map<string, Guard>();
export function homeGuard(home: string, strict = false): Guard {
  const key = `${strict ? "strict" : "plain"}\0${home}`;
  let g = homeGuards.get(key);
  if (g === undefined) {
    g = new Guard({ repoRoot: null, gitFolders: [], roots: [home], noLinks: strict });
    homeGuards.set(key, g);
  }
  return g;
}

// The `wider` of a write that holds review content, a receipt or config:
// a folder other users could read is closed to `folderMode` through the
// guard, and each file or folder is named once in this process, on
// stderr, by its path from `root`. `path` always comes from a `Walk`, so
// its links are already followed; `root` is resolved the same way here, or
// a repository reached through a linked folder (/tmp on macOS, linked to
// /private/tmp) would print a notice path climbing out with `../` instead
// of one relative to the repository.
const reported = new Set<string>();
export function closeWider(guard: Guard, root: string, folderMode = 0o700): Wider {
  const resolvedRoot = (() => {
    try {
      return walk(root, true, () => undefined, true).dir;
    } catch {
      return root;
    }
  })();
  return (path, mode, kind) => {
    const octal = (m: number): string => `0${m.toString(8)}`;
    const shown = relative(resolvedRoot, path) || path;
    if (kind === "folder") {
      try {
        if (guard.narrowFolder(path, folderMode) === null) return;
      } catch {
        // could not be closed: said below as it is
        if (reported.has(path)) return;
        reported.add(path);
        process.stderr.write(`openqodex: ${shown} can be read by other users (mode ${octal(mode)}); run chmod ${octal(folderMode)} on it\n`);
        return;
      }
    }
    if (reported.has(path)) return;
    reported.add(path);
    process.stderr.write(
      kind === "folder"
        ? `openqodex: ${shown} could be read by other users (mode ${octal(mode)}); it is now ${octal(folderMode)}, readable only by you\n`
        : `openqodex: ${shown} could be read by other users (mode ${octal(mode)}); it was replaced by a file only you can read\n`,
    );
  };
}
