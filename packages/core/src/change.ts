// The git change source: what the developer changed, relative to a base,
// including untracked files, without writing anything inside `.git`.
//
// Untracked files are staged into a copy of the index that lives in a temp
// folder, with new blobs written to a temp object folder that borrows the
// repo's own objects as an alternate. Every diff is then taken from that one
// temp index with `--cached`, so the user's index, objects and hooks are never
// touched and the whole thing works with `.git` read-only.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readlink, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createCoverageParser, unquoteDiffPath } from "./diff.js";
import { DiffStore } from "./diff-store.js";
import { matchesGlob } from "./glob.js";
import { STATE_DIR } from "./report-files.js";
import { SERVER_GIT_ENV, safeGitEnv } from "./safe-git.js";
import type { Change, ChangedFile, ChangeScope, DeletionPoint } from "./types.js";
import { OpenQodexError } from "./types.js";

// The whole-repo listing keeps its own file-size rule.
export const WHOLE_REPO_MAX_BYTES = 5 * 1024 * 1024;

// Coverage needs only the first character of a patch line and the headers.
const COVERAGE_MAX_LINE_BYTES = 64 * 1024;

// Our own run state never counts as part of a change.
const STATE_PATHSPEC = `:(top,exclude)${STATE_DIR}`;

// Settings that would make git write inside `.git`, run user code, or change
// the shape of its output, switched off for every call.
const GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.splitIndex=false",
  "gc.auto=0",
  "maintenance.auto=false",
];

const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--find-renames",
  "--inter-hunk-context=0",
  "--ignore-submodules=none",
  "--submodule=short",
];

type GitResult = { code: number; stdout: Buffer; stderr: string };

// Settings for one call, on top of GIT_CONFIG. `input`: what git reads on
// its standard input; left out, it reads nothing.
type GitOptions = { env?: NodeJS.ProcessEnv; config?: string[]; input?: string };

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  // It would override -U0 and widen the changed lines.
  delete out.GIT_DIFF_OPTS;
  return out;
}

function spawnGit(cwd: string, args: string[], opts: GitOptions): ChildProcessByStdio<Writable | null, Readable, Readable> {
  const argv: string[] = [];
  for (const c of [...GIT_CONFIG, ...(opts.config ?? [])]) argv.push("-c", c);
  argv.push(...args);
  return spawn("git", argv, { cwd, env: childEnv(opts.env ?? process.env), stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
}

function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((done, fail) => {
    const child = spawnGit(cwd, args, opts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => fail(new OpenQodexError(`could not run git: ${e.message}`)));
    child.on("close", (code) =>
      done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

function failure(args: string[], code: number, stderr: string): OpenQodexError {
  if (/lazy fetch|promisor|missing (blob|tree|object)/i.test(stderr)) {
    return new OpenQodexError(
      "a file this change needs is not downloaded in this partial clone, and openqodex never fetches; " +
        `run git fetch and try again (git ${args[0]}: ${stderr.trim()})`,
    );
  }
  return new OpenQodexError(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
}

async function gitOk(cwd: string, args: string[], opts?: GitOptions): Promise<Buffer> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw failure(args, r.code, r.stderr);
  return r.stdout;
}

// Runs git and hands stdout over one line at a time. A line longer than
// maxLine is cut to its first maxLine bytes and flagged, so memory stays
// bounded whatever the size of the output.
function gitLines(
  cwd: string,
  args: string[],
  opts: GitOptions,
  maxLine: number,
  onLine: (line: string, cut: boolean) => void,
): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawnGit(cwd, args, opts);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let cut = false;
    const keep = (b: Buffer): void => {
      const room = maxLine - pendingBytes;
      if (b.length > room) cut = true;
      const part = b.length > room ? b.subarray(0, Math.max(room, 0)) : b;
      if (part.length > 0) {
        pending.push(Buffer.from(part));
        pendingBytes += part.length;
      }
    };
    const flush = (): void => {
      onLine(Buffer.concat(pending).toString("utf8"), cut);
      pending = [];
      pendingBytes = 0;
      cut = false;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        keep(chunk.subarray(start, nl));
        flush();
        start = nl + 1;
      }
      if (start < chunk.length) keep(chunk.subarray(start));
    });
    const err: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => fail(new OpenQodexError(`could not run git: ${e.message}`)));
    child.on("close", (code) => {
      if (pendingBytes > 0 || cut) flush();
      if (code === 0) done();
      else fail(failure(args, code ?? 1, Buffer.concat(err).toString("utf8")));
    });
  });
}

async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  const r = await git(cwd, args);
  if (r.code !== 0) return null;
  const line = r.stdout.toString("utf8").trim();
  return line === "" ? null : line;
}

export async function findRepoRoot(cwd: string): Promise<string> {
  const root = await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) throw new OpenQodexError("not a git repository");
  return root;
}

type Base = { ref: string; sha: string };

async function mergeBaseWithHead(repoRoot: string, ref: string): Promise<string | null> {
  return gitLine(repoRoot, ["merge-base", "HEAD", ref]);
}

async function resolveBase(repoRoot: string, scope: ChangeScope, defaultBase: string | null): Promise<Base> {
  const head = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);

  if (scope.base !== undefined) {
    const sha = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${scope.base}^{commit}`]);
    if (sha === null) throw new OpenQodexError(`base not found: ${scope.base}`);
    if (scope.exact) return { ref: scope.base, sha };
    // The change is what this branch did since it left the base, so commits
    // that landed on the base afterwards are not shown as reverted.
    const mb = head === null ? null : await mergeBaseWithHead(repoRoot, sha);
    return { ref: scope.base, sha: mb ?? sha };
  }

  if (head === null) {
    // No commits yet: everything in the working tree is the change.
    const empty = await gitOk(repoRoot, ["hash-object", "-t", "tree", "--stdin"]);
    return { ref: "empty tree", sha: empty.toString("utf8").trim() };
  }
  if (scope.uncommitted) return { ref: "HEAD", sha: head };

  const upstream = await gitLine(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream !== null) {
    const mb = await mergeBaseWithHead(repoRoot, upstream);
    if (mb !== null) return { ref: upstream, sha: mb };
  }

  // review.default_base: the ref as written, else the same name on origin,
  // so a branch that was never checked out here is still found.
  if (defaultBase !== null) {
    for (const ref of [defaultBase, `origin/${defaultBase}`]) {
      const sha = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
      const mb = sha === null ? null : await mergeBaseWithHead(repoRoot, sha);
      if (mb !== null) return { ref, sha: mb };
    }
    throw new OpenQodexError(
      `review.default_base: ${defaultBase} is not a ref here or a branch on origin, or shares no history with HEAD; fetch it or change the config`,
    );
  }

  const remoteHead = await gitLine(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead !== null) {
    const mb = await mergeBaseWithHead(repoRoot, remoteHead);
    if (mb !== null) return { ref: remoteHead.replace(/^refs\/remotes\//, ""), sha: mb };
  }

  return { ref: "HEAD", sha: head };
}

function splitNul(buf: Buffer): string[] {
  const parts = buf.toString("utf8").split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function parseNameStatus(buf: Buffer): Omit<ChangedFile, "binary">[] {
  const parts = splitNul(buf);
  const files: Omit<ChangedFile, "binary">[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++][0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push(code === "R" ? { path, status: "renamed", oldPath } : { path, status: "added", oldPath: null });
    } else {
      const path = parts[i++];
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      files.push({ path, status, oldPath: null });
    }
  }
  return files;
}

type NumStat = { additions: number; deletions: number; binary: boolean };

// `--numstat -z`: "<add>\t<del>\t<path>\0", or for a rename
// "<add>\t<del>\t\0<old>\0<new>\0". A binary file shows "-" for both counts.
// Keyed by the new path; records for the same path are added together.
function parseNumstat(buf: Buffer): Map<string, NumStat> {
  const parts = splitNul(buf);
  const out = new Map<string, NumStat>();
  for (let i = 0; i < parts.length; ) {
    const [add, del, inline] = parts[i++].split("\t");
    let path = inline;
    if (path === "") {
      path = parts[i + 1];
      i += 2;
    }
    const binary = add === "-" && del === "-";
    const prev = out.get(path) ?? { additions: 0, deletions: 0, binary: false };
    out.set(path, {
      binary: prev.binary || binary,
      additions: prev.additions + (binary ? 0 : Number(add)),
      deletions: prev.deletions + (binary ? 0 : Number(del)),
    });
  }
  return out;
}

const EXTENDED_HEADER =
  /^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|index) /;

// The path a "diff --git a/<p> b/<p>" line names when both sides are the same
// path (every pair except a rename), or null.
function samePathFromHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if ((rest.length - 1) % 2 !== 0) return null;
  const half = (rest.length - 1) / 2;
  if (rest[half] !== " ") return null;
  const a = unquoteDiffPath(rest.slice(0, half));
  const b = unquoteDiffPath(rest.slice(half + 1));
  if (!a.startsWith("a/") || !b.startsWith("b/") || a.slice(2) !== b.slice(2)) return null;
  return a.slice(2);
}

// Streams a patch and hands each line to onLine together with the path of
// the file pair it belongs to. A pair can produce more than one block (a
// type change is shown as a deletion and an addition), so callers key by
// path, never by position. The path is known once the extended header lines
// are past; the block is held until then, and those lines are short.
async function streamPatch(
  run: (onLine: (line: string, cut: boolean) => void) => Promise<void>,
  onLine: (path: string | null, line: string, cut: boolean) => void,
): Promise<void> {
  let held: string[] = [];
  let path: string | null = null;
  let deciding = false;
  const release = (): void => {
    deciding = false;
    for (const l of held) onLine(path, l, false);
    held = [];
  };
  await run((line, cut) => {
    if (line.startsWith("diff --git ")) {
      if (deciding) release();
      path = samePathFromHeader(line);
      deciding = true;
      held = [line];
      return;
    }
    if (deciding) {
      if (line.startsWith("rename to ")) path = unquoteDiffPath(line.slice("rename to ".length));
      if (EXTENDED_HEADER.test(line)) {
        held.push(line);
        return;
      }
      release();
    }
    onLine(path, line, cut);
  });
  if (deciding) release();
}

// Payload rows stream as bytes, including a single row larger than memory.
// Only git's short header lines wait for a newline to determine their path.
async function streamPatchBytes(cwd: string, args: string[], opts: GitOptions, onBytes: (path: string | null, bytes: Buffer) => void): Promise<void> {
  const child = spawnGit(cwd, args, opts);
  const errors: Buffer[] = [];
  child.stderr.on("data", (b: Buffer) => errors.push(b));
  const ended = new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("close", (code) => code === 0 ? done() : fail(failure(args, code ?? 1, Buffer.concat(errors).toString("utf8"))));
  });
  // An output write can fail before git exits; still reap that process.
  void ended.catch(() => {});
  let path: string | null = null;
  let deciding = false;
  let inHunk = false;
  let held: Buffer[] = [];
  let header: Buffer[] = [];
  let atStart = true;
  let payload = false;
  const release = () => {
    deciding = false;
    for (const bytes of held) onBytes(path, bytes);
    held = [];
  };
  const line = (bytes: Buffer) => {
    const text = bytes.toString("utf8").replace(/\n$/, "");
    if (text.startsWith("diff --git ")) {
      if (deciding) release();
      inHunk = false;
      deciding = true;
      path = samePathFromHeader(text);
      held = [bytes];
      return;
    }
    if (deciding) {
      if (text.startsWith("rename to ")) path = unquoteDiffPath(text.slice("rename to ".length));
      if (EXTENDED_HEADER.test(text)) { held.push(bytes); return; }
      release();
    }
    if (text.startsWith("@@")) inHunk = true;
    onBytes(path, bytes);
  };
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      let payloadStart = -1;
      for (let at = 0; at < bytes.length;) {
        const nl = bytes.indexOf(10, at);
        const end = nl === -1 ? bytes.length : nl + 1;
        if (atStart) payload = inHunk && [32, 43, 45, 92].includes(bytes[at]!);
        const part = bytes.subarray(at, end);
        if (payload) {
          if (payloadStart === -1) payloadStart = at;
        } else {
          // Batch payload by stdout chunk, rather than allocating per row.
          if (payloadStart !== -1) { onBytes(path, bytes.subarray(payloadStart, at)); payloadStart = -1; }
          header.push(Buffer.from(part));
        }
        if (nl !== -1 && !payload) { line(Buffer.concat(header)); header = []; }
        atStart = nl !== -1;
        at = end;
      }
      if (payloadStart !== -1) onBytes(path, bytes.subarray(payloadStart));
    }
    if (header.length) line(Buffer.concat(header));
    if (deciding) release();
    await ended;
  } catch (error) {
    child.kill();
    await ended.catch(() => {});
    throw error;
  }
}

function excluded(path: string, exclude: string[]): boolean {
  if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) return true;
  return exclude.some((g) => matchesGlob(path, g));
}

// Diff flags and pathspecs that keep excluded paths out of rename pairing.
type RenameSplit = { flags: string[]; specs: string[] };

// Every path a listing names, both sides of a rename included.
function listedPaths(files: Omit<ChangedFile, "binary">[]): string[] {
  return files.flatMap((f) => (f.oldPath === null ? [f.path] : [f.path, f.oldPath]));
}

// The folders above every path: `a/b/c.ts` gives `a` and `a/b`. A pathspec
// names a folder's files as well as a file of that name, and one path can be
// a file on one side and a folder on the other (a file `cache` replaced by
// `cache/new.ts`), so a path in this set is never left out by pathspec.
function foldersOf(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) out.add(p.slice(0, i));
  return out;
}

// The exclude list is judged on each side of a rename on its own. A file
// renamed out of an excluded path is an addition, one renamed into an
// excluded path is a deletion, so no line of an excluded file reaches the
// change and no admitted file leaves it unseen. Git pairs a rename only
// between paths its pathspec admits: when a rename crosses the exclude line,
// every excluded path that can be a side of a rename (added, deleted or
// renamed) is left out by pathspec, so git cannot pair it with another.
// When a pathspec would also leave out a listed path below it, or past the
// pathspec bound, renames are not paired at all, and the exclude list then
// drops each excluded side as a file of its own. Null when no rename
// crosses the line.
function renameSplit(files: Omit<ChangedFile, "binary">[], exclude: string[]): RenameSplit | null {
  if (!files.some((f) => f.oldPath !== null && excluded(f.oldPath, exclude) !== excluded(f.path, exclude))) return null;
  const sides = listedPaths(files.filter((f) => f.status !== "modified")).filter((p) => excluded(p, exclude));
  const folders = foldersOf(listedPaths(files));
  const specs = sides.some((p) => folders.has(p)) ? null : boundedSpecs(sides);
  return specs === null ? { flags: ["--no-renames"], specs: [] } : { flags: [], specs };
}

// git separates alternate object folders with ":", so a path is C-quoted to
// survive a colon (or a leading quote) in it.
export function quoteAlternate(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Every configured filter driver is switched off for the temp add: a clean
// filter is the user's own program and may write inside .git (large file
// storage does). The file is then staged as it sits on disk.
async function filtersOff(repoRoot: string): Promise<string[]> {
  const r = await git(repoRoot, ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
  if (r.code !== 0) return [];
  const off = new Set<string>();
  for (const line of r.stdout.toString("utf8").split("\n")) {
    const key = line.split(" ", 1)[0];
    if (key === "") continue;
    off.add(`${key}=`);
    off.add(`${key.slice(0, key.lastIndexOf("."))}.required=false`);
  }
  return [...off];
}

// The most bytes of pathspecs passed to one git call.
const MAX_SKIP_PATHSPEC_BYTES = 64 * 1024;

// Pathspecs that leave `paths` out of a diff, or null past the bound.
function boundedSpecs(paths: string[]): string[] | null {
  const specs = paths.map((p) => `:(top,literal,exclude)${p}`);
  const bytes = specs.reduce((n, s) => n + Buffer.byteLength(s) + 1, 0);
  return bytes <= MAX_SKIP_PATHSPEC_BYTES ? specs : null;
}

// Pathspecs that keep git from producing patches for files left out anyway.
// Only an optimisation: past the bound the list is not passed and the
// streamed lines for those files are dropped instead. A path with a listed
// path below it is never passed (foldersOf).
function skipPathspecs(paths: string[], listed: string[]): string[] {
  const folders = foldersOf(listed);
  return boundedSpecs(paths.filter((p) => !folders.has(p))) ?? [];
}

export async function getChange(args: {
  repoRoot: string;
  scope: ChangeScope;
  exclude: string[];
  // Config.defaultBase: what the default scope diffs against with no upstream.
  defaultBase?: string | null;
  // Called with the git tree of the working state the change is taken from,
  // while its objects still exist: `objects` holds the new ones and
  // `alternates` the repo's own. The review copies its snapshot from it, so
  // the snapshot and the change are the same state by construction.
  onTree?: (tree: { sha: string; objects: string; alternates: string }) => Promise<void>;
  // Files to take as they were, not as they are on disk: the path relative
  // to the repo and its earlier text, or null for a file that did not exist.
  // `init` passes the files it wrote, so the change is the developer's own.
  overlay?: { path: string; content: string | null }[];
  // Review state tmp folder, or the host temp folder for library callers.
  tempRoot?: string;
  // Identity checks never build coverage or retain a patch.
  idOnly?: boolean;
}): Promise<Change> {
  const { repoRoot, scope, exclude } = args;
  const base = await resolveBase(repoRoot, scope, args.defaultBase ?? null);

  const absGitPath = async (name: string): Promise<string> => {
    const p = (await gitOk(repoRoot, ["rev-parse", "--git-path", name])).toString("utf8").trim();
    return isAbsolute(p) ? p : resolve(repoRoot, p);
  };
  const indexPath = await absGitPath("index");
  const objectsPath = await absGitPath("objects");
  const noFilters = await filtersOff(repoRoot);

  const tmp = await mkdtemp(join(tmpdir(), "openqodex-change-"));
  try {
    const tmpIndex = join(tmp, "index");
    const tmpObjects = join(tmp, "objects");
    await mkdir(tmpObjects);
    if (existsSync(indexPath)) {
      await copyFile(indexPath, tmpIndex);
      // Git trusts a file's stat over its content unless the entry is as new
      // as the index itself (a "racy" entry). The copy would carry a later
      // time and hide an edit made at the same size in the second the index
      // was written; the original's time, rounded down, keeps that check.
      const at = Math.floor((await stat(indexPath)).mtimeMs / 1000);
      await utimes(tmpIndex, at, at);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_OBJECT_DIRECTORY: tmpObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(objectsPath),
    };

    // No exclude pathspec here: git refuses a pathspec that names a path the
    // repo's own .gitignore ignores. The report folder is left out by the
    // pathspec on every diff below instead.
    await gitOk(repoRoot, ["add", "-A", "--", "."], { env, config: noFilters });
    for (const [i, o] of (args.overlay ?? []).entries()) {
      if (o.content === null) {
        await gitOk(repoRoot, ["update-index", "--force-remove", "--", o.path], { env });
        continue;
      }
      const file = join(tmp, `overlay-${i}`);
      await writeFile(file, o.content);
      const blob = (await gitOk(repoRoot, ["hash-object", "-w", "--no-filters", "--", file], { env })).toString("utf8").trim();
      await gitOk(repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},${o.path}`], { env });
    }
    if (args.onTree) {
      // Written into the temp object folder, like the blobs `add` wrote.
      const sha = (await gitOk(repoRoot, ["write-tree"], { env })).toString("utf8").trim();
      await args.onTree({ sha, objects: tmpObjects, alternates: objectsPath });
    }

    return await diffChange({ repoRoot, baseRef: base.ref, baseSha: base.sha, range: ["--cached", base.sha], env, exclude, tempRoot: args.tempRoot, idOnly: args.idOnly });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// A change between two commits, read from their trees alone: the files on
// disk and the index play no part, so nothing placed in a checkout of the
// head can show in it or hide part of it. `baseSha` is the merge base, so
// what landed on the base after the split is not shown as reverted.
export async function getTreeChange(args: {
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  exclude: string[];
  tempRoot?: string;
  // Identity checks never build coverage or retain a patch.
  idOnly?: boolean;
}): Promise<Change> {
  return diffChange({ ...args, range: [args.baseSha, args.headSha], env: process.env });
}

// A path a checkout may write: no empty, "." or ".." part and no ".git"
// part in any case, as git itself refuses to check out.
function checkoutSafe(path: string): boolean {
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

// A git folder of the server diff's own, made under `tmp`: no work tree, no
// index, no info/attributes, no config of the clone, the machine or the
// user, and no refs (so no replacement ref either). It reads the clone's
// objects through `alternates` and writes new ones into `objects`. So no
// .gitattributes decides how a file is diffed: a refused one, or one a pull
// request adds, could mark admitted code -diff and hide its changed lines
// from the review; git then tells a binary file by its content alone. The
// variables to run git with in it are returned.
async function isolatedGit(tmp: string, format: string, objects: string, alternates: string): Promise<NodeJS.ProcessEnv> {
  const gitDir = join(tmp, "git");
  const env: NodeJS.ProcessEnv = {
    ...safeGitEnv(),
    ...SERVER_GIT_ENV,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    // The user's own attributes file is found from these when no config
    // names one.
    HOME: tmp,
    XDG_CONFIG_HOME: tmp,
  };
  await gitOk(tmp, ["init", "-q", "--bare", "--template=", `--object-format=${format}`, gitDir], { env });
  return { ...env, GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(alternates) };
}

// One commit's tree with only the admitted paths, written into the isolated
// git folder's objects through a temporary index: git's own listing of the
// commit, filtered, read back as an index and written as a tree. A missing
// file object (a partial clone) is no obstacle here; the diff names it.
// `ids`: every path of the commit and its object id; `refused`: the refused
// file paths and their ids, which nothing reads.
async function admittedTree(cwd: string, env: NodeJS.ProcessEnv, sha: string, admit: (path: string) => boolean, index: string): Promise<{ tree: string; ids: Map<string, string>; refused: Map<string, string> }> {
  const listed = await gitOk(cwd, ["ls-tree", "-r", "-z", "--full-tree", sha], { env });
  const keep: string[] = [];
  const ids = new Map<string, string>();
  const refused = new Map<string, string>();
  // Each record is "<mode> <type> <id>\t<path>", the form --index-info reads.
  for (const record of splitNul(listed)) {
    const tab = record.indexOf("\t");
    const path = record.slice(tab + 1);
    if (!checkoutSafe(path)) {
      throw new OpenQodexError(`the commit ${sha.slice(0, 12)} holds a path no checkout may write (${JSON.stringify(path.slice(0, 200))}); the review stops`);
    }
    const [, type = "", id = ""] = record.slice(0, tab).split(" ");
    ids.set(path, id);
    if (admit(path)) keep.push(record);
    else if (type === "blob") refused.set(path, id);
  }
  const withIndex = { ...env, GIT_INDEX_FILE: index };
  await gitOk(cwd, ["update-index", "-z", "--index-info"], { env: withIndex, input: keep.map((r) => `${r}\0`).join("") });
  const written = await gitOk(cwd, ["write-tree", "--missing-ok"], { env: withIndex });
  return { tree: written.toString("utf8").trim(), ids, refused };
}

// The change between two commits over the admitted paths only (the server
// review's folder scopes and review.paths.exclude, decided by `admit`). Both
// commits' trees are rebuilt with only the admitted paths, in a git folder
// of its own (isolatedGit: the clone is never written, and no attributes,
// config or replacement ref of the clone plays a part), and diffed as
// getTreeChange diffs two commits. So a refused file is in no part of the
// change, and a file moved into the admitted paths from a refused one is a
// new file: its earlier version is never read. `renamedIn` names each file
// moved in unchanged, told from object ids alone (a file moved with edits
// is told only by reading the outside file, which is refused). A commit
// holding a path no checkout may write is refused, as a checkout would
// refuse it. `tempRoot`: the folder the isolated git folder, its index and
// objects are made in (a server review's scratch); the system temp folder
// when left out.
export async function getAdmittedTreeChange(args: {
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  exclude: string[];
  admit: (path: string) => boolean;
  tempRoot?: string;
  // Identity checks never build coverage or retain a patch.
  idOnly?: boolean;
}): Promise<{ change: Change; renamedIn: string[] }> {
  const { repoRoot, admit } = args;
  const objectsPath = (await gitOk(repoRoot, ["rev-parse", "--git-path", "objects"])).toString("utf8").trim();
  const alternates = isAbsolute(objectsPath) ? objectsPath : resolve(repoRoot, objectsPath);
  const format = (await gitOk(repoRoot, ["rev-parse", "--show-object-format"])).toString("utf8").trim();
  const tmp = await mkdtemp(join(args.tempRoot ?? tmpdir(), "openqodex-scope-"));
  try {
    const objects = join(tmp, "objects");
    await mkdir(objects);
    const env = await isolatedGit(tmp, format, objects, alternates);
    const base = await admittedTree(tmp, env, args.baseSha, admit, join(tmp, "index-base"));
    const head = await admittedTree(tmp, env, args.headSha, admit, join(tmp, "index-head"));
    const change = await diffChange({ repoRoot, cwd: tmp, baseRef: args.baseRef, baseSha: args.baseSha, exclude: args.exclude, range: [base.tree, head.tree], env, tempRoot: args.tempRoot, idOnly: args.idOnly });
    // A file moved in from outside: one the change adds whose object is a
    // refused base file's, where that base path is gone from the head.
    const movedOut = new Set<string>();
    for (const [path, id] of base.refused) if (!head.ids.has(path)) movedOut.add(id);
    const renamedIn = change.files.filter((f) => f.status === "added" && movedOut.has(head.ids.get(f.path) ?? "")).map((f) => f.path);
    return { change, renamedIn };
  } catch (error) {
    // The isolated git folder knows nothing of the clone's promisor remote,
    // so git names a file object a partial clone lacks as one it cannot read.
    if (error instanceof OpenQodexError && /unable to read [0-9a-f]{40,64}/.test(error.message)) {
      throw new OpenQodexError(`a file this change needs is not downloaded in this partial clone, and openqodex never fetches; run git fetch and try again (${error.message})`);
    }
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The line count of each blob, by its object id, from one `git cat-file
// --batch` for all of them; 0 for no id. Only full object ids go to git, one
// per line, so no file name (one holding a line break, say) can become a
// request of its own.
async function lineCounts(cwd: string, ids: (string | null)[], env: NodeJS.ProcessEnv): Promise<number[]> {
  const asked = ids.map((id) => (id !== null && OBJECT_ID.test(id) && !/^0+$/.test(id) ? id : null));
  const counted = await batchLineCounts(cwd, asked.filter((id): id is string => id !== null), env);
  let k = 0;
  return asked.map((id) => (id === null ? 0 : (counted[k++] as number)));
}

// Counted as the output streams, so no blob is held whole.
function batchLineCounts(repoRoot: string, specs: string[], env: NodeJS.ProcessEnv): Promise<number[]> {
  if (specs.length === 0) return Promise.resolve([]);
  return new Promise((done, fail) => {
    const argv: string[] = [];
    for (const c of GIT_CONFIG) argv.push("-c", c);
    const child = spawn("git", [...argv, "cat-file", "--batch"], { cwd: repoRoot, env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    const counts: number[] = [];
    let header = Buffer.alloc(0); // bytes of a header line not yet ended
    let left = -1; // content bytes still to read for the current blob, -1 between blobs
    let lines = 0;
    let last = 10; // the last content byte seen
    let size = 0;
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      let i = 0;
      while (i < chunk.length) {
        if (left === -1) {
          const nl = chunk.indexOf(10, i);
          if (nl === -1) {
            header = Buffer.concat([header, chunk.subarray(i)]);
            return;
          }
          const line = Buffer.concat([header, chunk.subarray(i, nl)]).toString("utf8");
          header = Buffer.alloc(0);
          i = nl + 1;
          const m = / (\S+) (\d+)$/.exec(line);
          if (!m || line.endsWith(" missing")) {
            counts.push(0);
            continue;
          }
          size = Number(m[2]);
          left = size;
          lines = 0;
          last = 10;
        } else if (left > 0) {
          const part = chunk.subarray(i, i + left);
          for (let j = part.indexOf(10); j !== -1; j = part.indexOf(10, j + 1)) lines++;
          last = part[part.length - 1] as number;
          left -= part.length;
          i += part.length;
        } else {
          // The newline git writes after each blob's content.
          counts.push(size > 0 && last !== 10 ? lines + 1 : lines);
          left = -1;
          i += 1;
        }
      }
    });
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => fail(new OpenQodexError(`could not run git: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0 || counts.length !== specs.length) fail(failure(["cat-file"], code ?? 1, Buffer.concat(err).toString("utf8")));
      else done(counts);
    });
    child.stdin.end(`${specs.join("\n")}\n`);
  });
}

// `--raw -z --no-abbrev`: ":<mode> <mode> <id> <id> <status>\0<path>\0",
// with the old path first for a rename or a copy. The new side's object id
// of each file, by its new path.
function newSideIds(buf: Buffer): Map<string, string> {
  const parts = splitNul(buf);
  const out = new Map<string, string>();
  for (let i = 0; i < parts.length; ) {
    const [, , , id = "", status = ""] = (parts[i++] as string).split(" ");
    if (status.startsWith("R") || status.startsWith("C")) i++;
    out.set(parts[i++] as string, id);
  }
  return out;
}

// Change.id: the base and git's raw listing of the change, our own run
// state left out.
function changeId(baseSha: string, raw: Buffer): string {
  return createHash("sha256").update(`${baseSha}\n`).update(raw).digest("hex");
}

// The id of a change from `baseSha` that changes nothing but our own run
// state (.openqodex/): a review of it has nothing to review and records
// nothing, so a push gate has nothing to look up.
export function emptyChangeId(baseSha: string): string {
  return changeId(baseSha, Buffer.alloc(0));
}

// Whether the commits `baseSha` to `headSha` change nothing but our own run
// state, read as git stores them: replace refs off (SERVER_GIT_ENV), so a
// replacement cannot show a commit with a tree it does not have.
export async function onlyStateChanged(repoRoot: string, baseSha: string, headSha: string): Promise<boolean> {
  const change = await diffChange({ repoRoot, baseRef: baseSha, baseSha, range: [baseSha, headSha], env: { ...process.env, ...SERVER_GIT_ENV }, exclude: [], idOnly: true });
  return change.id === emptyChangeId(baseSha);
}

// Everything after the two sides are known: the file list, the id, the
// changed lines and the brief's diff, from `git diff <range>`. `cwd`: where
// git runs, `repoRoot` when left out.
async function diffChange(args: {
  repoRoot: string;
  cwd?: string;
  baseRef: string;
  baseSha: string;
  range: string[];
  env: NodeJS.ProcessEnv;
  exclude: string[];
  tempRoot?: string;
  // Identity checks never build coverage or retain a patch.
  idOnly?: boolean;
}): Promise<Change> {
  const { repoRoot, exclude, env } = args;
  const cwd = args.cwd ?? repoRoot;
  // Set when a rename crosses the exclude line (renameSplit), for every diff after the first listing.
  let split: RenameSplit = { flags: [], specs: [] };
  const diffArgs = (extra: string[], skip: string[] = []): string[] => [
    "diff",
    ...DIFF_FLAGS,
    ...split.flags,
    ...extra,
    ...args.range,
    "--",
    STATE_PATHSPEC,
    ...split.specs,
    ...skip,
  ];
  let [nameStatus, numstatBuf, raw] = await Promise.all([
    args.idOnly ? Promise.resolve(Buffer.alloc(0)) : gitOk(cwd, diffArgs(["--name-status", "-z"]), { env }),
    args.idOnly ? Promise.resolve(Buffer.alloc(0)) : gitOk(cwd, diffArgs(["--numstat", "-z"]), { env }),
    gitOk(cwd, diffArgs(["--raw", "-z", "--no-abbrev"]), { env }),
  ]);

  // The id stays the first listing's, excluded files included.
  const id = changeId(args.baseSha, raw);
  if (args.idOnly) return {
    repoRoot, baseRef: args.baseRef, baseSha: args.baseSha, id, shortId: id.slice(0, 12),
    files: [], changedPaths: [], coverage: new Map(), deletionPoints: new Map(), diff: "", diffs: [], notReviewed: [], uncovered: [], stats: { files: 0, additions: 0, deletions: 0 },
  };
  const crossing = renameSplit(parseNameStatus(nameStatus), exclude);
  if (crossing !== null) {
    split = crossing;
    [nameStatus, numstatBuf] = await Promise.all([gitOk(cwd, diffArgs(["--name-status", "-z"]), { env }), gitOk(cwd, diffArgs(["--numstat", "-z"]), { env })]);
  }
  const numstat = parseNumstat(numstatBuf);

  // Counts establish the admitted files before either patch pass.
  const pairs = parseNameStatus(nameStatus);
  const listed = listedPaths(pairs);
  const files: ChangedFile[] = [];
  const skipped: string[] = []; // excluded by the developer
  const covered = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const pair of pairs) {
    if (excluded(pair.path, exclude)) {
      skipped.push(pair.path);
      continue;
    }
    const stat = numstat.get(pair.path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({ ...pair, binary: stat.binary });
    additions += stat.additions;
    deletions += stat.deletions;
    if (pair.status !== "deleted") {
      covered.add(pair.path);
    }
  }

  const textArgs = ["--src-prefix=a/", "--dst-prefix=b/"];
  const opts = { env };

  const parser = createCoverageParser();
  await streamPatch(
    (onLine) =>
      gitLines(
        cwd,
        // A file left out of the brief keeps its coverage: its changed lines
        // must then be read through the tools, or they count as unread.
        diffArgs(["-U0", ...textArgs], skipPathspecs(skipped, listed)),
        opts,
        COVERAGE_MAX_LINE_BYTES,
        onLine,
      ),
    (path, line) => {
      if (path !== null && covered.has(path)) parser.push(line);
      else if (line.startsWith("diff --git ")) parser.push(line);
    },
  );
  const coverage = parser.result();
  for (const path of coverage.keys()) if (!covered.has(path)) coverage.delete(path);
  // Each deletion's anchors are the new file's lines on either side of it
  // that exist: one past the end is none, and an emptied file has line 1.
  // A deleted file keeps line 1 of its path as its one anchor.
  const deletionPoints = new Map<string, DeletionPoint[]>();
  const withPoints = [...parser.deletionPoints()].filter(([path]) => covered.has(path));
  const ids = newSideIds(raw);
  const counts = await lineCounts(cwd, withPoints.map(([path]) => ids.get(path) ?? null), env);
  for (const [i, [path, points]] of withPoints.entries()) {
    const count = counts[i] as number;
    deletionPoints.set(
      path,
      points.map((p) => ({
        ...p,
        anchors: count === 0 ? [1] : [p.after, p.after + 1].filter((n) => n >= 1 && n <= count),
      })),
    );
  }
  for (const f of files) {
    if (f.status === "deleted") deletionPoints.set(f.path, [{ after: 0, lines: numstat.get(f.path)?.deletions ?? 0, anchors: [1] }]);
  }

  const store = new DiffStore(id, args.tempRoot);
  const admitted = new Set(files.map((f) => f.path));
  let diffs: Change["diffs"];
  try {
    await streamPatchBytes(cwd, diffArgs(["-U3", ...textArgs], skipPathspecs(skipped, listed)), opts,
      (path, bytes) => { if (path !== null && admitted.has(path)) store.push(path, bytes); });
    const retained = new Map(store.finish().map((d) => [d.path, d]));
    diffs = files.flatMap((f) => retained.has(f.path) ? [retained.get(f.path)!] : []);
  } catch (error) {
    store.dispose();
    throw error;
  }
  const diff = diffs.map((d) => d.text ?? "").join("");
  const changedPaths = files.filter((f) => f.status !== "deleted").map((f) => f.path);

  return {
    repoRoot,
    baseRef: args.baseRef,
    baseSha: args.baseSha,
    id,
    shortId: id.slice(0, 12),
    files,
    changedPaths,
    coverage,
    deletionPoints,
    diff,
    diffs,
    notReviewed: [],
    uncovered: [],
    stats: { files: files.length, additions, deletions },
  };
}

// ---------- the whole repo (`review --all`) ----------

// The whole-repo scope. `coverage` is empty: every line of every file is in
// scope, so no line set is built; `lines` holds each text file's line count
// and `sizes` its bytes, for finalize and the brief's inventory.
export type WholeRepo = Change & { lines: Map<string, number>; sizes: Map<string, number> };

// git's own test for a binary file: a NUL byte in the first 8000 bytes.
const BINARY_PROBE_BYTES = 8000;

function lineCount(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return buf.length > 0 && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

// The blob hash git would give these bytes, so an untracked file and an
// unstaged edit move the id exactly like a staged one.
function blobHash(buf: Buffer): string {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

// The same hash for a file too large to hold in memory, read from an open handle.
function streamBlobHash(handle: FileHandle, size: number): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha1").update(`blob ${size}\0`);
    handle
      .createReadStream({ autoClose: false })
      .on("data", (b) => hash.update(b))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });
}

// True when every folder on the way to `rel` is a real folder, never a link,
// so a repo cannot point a path at files outside itself. Cached per folder.
function realFolders(repoRoot: string): (rel: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  const folder = (rel: string): Promise<boolean> => {
    if (rel === "") return Promise.resolve(true);
    let ok = seen.get(rel);
    if (ok === undefined) {
      const cut = rel.lastIndexOf("/");
      ok = folder(cut === -1 ? "" : rel.slice(0, cut)).then(async (parent) => {
        if (!parent) return false;
        const st = await lstat(join(repoRoot, rel)).catch(() => null);
        return st !== null && st.isDirectory() && !st.isSymbolicLink();
      });
      seen.set(rel, ok);
    }
    return ok;
  };
  return (rel) => {
    const cut = rel.lastIndexOf("/");
    return folder(cut === -1 ? "" : rel.slice(0, cut));
  };
}

// Every file in the repo as it sits on disk: tracked files plus untracked
// files git does not ignore, minus `exclude` and `.openqodex/`. Each is an
// added file whose every line is in scope. The id hashes path, mode and
// content of every file, so an edit anywhere moves it. Files are opened
// without following a link, through real folders only. Submodules, nested
// repositories, symbolic links, unreadable files and files over 5 MB are
// listed as not reviewed and left out of the scope.
export async function getWholeRepo(args: { repoRoot: string; exclude: string[] }): Promise<WholeRepo> {
  const { repoRoot, exclude } = args;
  const head = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const baseSha = head ?? (await gitOk(repoRoot, ["hash-object", "-t", "tree", "--stdin"])).toString("utf8").trim();

  // `-s -z`: "<mode> <hash> <stage>\t<path>\0". A conflicted path appears once per stage.
  const modes = new Map<string, string>();
  for (const rec of splitNul(await gitOk(repoRoot, ["ls-files", "-s", "-z"]))) {
    const tab = rec.indexOf("\t");
    modes.set(rec.slice(tab + 1), rec.slice(0, rec.indexOf(" ")));
  }
  const untracked = splitNul(await gitOk(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const paths = [...new Set([...modes.keys(), ...untracked])].filter((p) => !excluded(p, exclude)).sort();
  const inRealFolders = realFolders(repoRoot);

  const files: ChangedFile[] = [];
  const lines = new Map<string, number>();
  const sizes = new Map<string, number>();
  const notReviewed: string[] = [];
  const idLines: string[] = [];
  let total = 0;
  for (const path of paths) {
    const name = path.replace(/\/$/, "");
    if (!(await inRealFolders(name))) {
      // Reached through a link: not the repo's own file. A folder that is
      // gone (a deleted tracked file) is simply not there.
      if (await lstat(join(repoRoot, name)).then(() => true, () => false)) {
        notReviewed.push(name);
        idLines.push(`${name}\tlinked`);
      }
      continue;
    }
    const full = join(repoRoot, name);
    const stat = await lstat(full).catch(() => null);
    if (stat === null) continue; // deleted in the working tree: not part of the repo any more
    // A submodule, a nested repository (git lists it as "dir/") or a link.
    if (modes.get(path) === "160000" || !stat.isFile()) {
      notReviewed.push(name);
      const target = stat.isSymbolicLink() ? await readlink(full).catch(() => "") : "";
      idLines.push(`${name}\t${modes.get(path) ?? (stat.isSymbolicLink() ? "120000" : "040000")}\t${target}`);
      continue;
    }
    const mode = stat.mode & 0o100 ? "100755" : "100644";
    let handle: FileHandle;
    try {
      handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      notReviewed.push(name);
      idLines.push(`${name}\t${mode}\tunreadable`);
      continue;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        notReviewed.push(name);
        idLines.push(`${name}\t${mode}\tnot a file`);
        continue;
      }
      if (st.size > WHOLE_REPO_MAX_BYTES) {
        notReviewed.push(name);
        idLines.push(`${name}\t${mode}\t${await streamBlobHash(handle, st.size).catch(() => "unreadable")}`);
        continue;
      }
      const buf = await handle.readFile();
      idLines.push(`${name}\t${mode}\t${blobHash(buf)}`);
      const binary = buf.subarray(0, BINARY_PROBE_BYTES).includes(0);
      files.push({ path: name, status: "added", oldPath: null, binary });
      sizes.set(name, buf.length);
      if (binary) continue;
      const n = lineCount(buf);
      lines.set(name, n);
      total += n;
    } catch {
      notReviewed.push(name);
      idLines.push(`${name}\t${mode}\tunreadable`);
    } finally {
      await handle.close();
    }
  }

  const id = createHash("sha256").update(idLines.join("\n")).digest("hex");
  return {
    repoRoot,
    baseRef: "all",
    baseSha,
    id,
    shortId: id.slice(0, 12),
    files,
    changedPaths: files.map((f) => f.path),
    coverage: new Map(),
    deletionPoints: new Map(),
    diff: "",
    notReviewed,
    stats: { files: files.length, additions: total, deletions: 0 },
    lines,
    sizes,
  };
}
