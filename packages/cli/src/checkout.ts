// Temporary detached checkouts of one commit. `review` reads its snapshot,
// and `review <target>` a branch or a pull request, in one under the
// developer's own `<openqodex home>/checkouts/`, created 0700, which is
// removed at the end of the run (or, for `--agent`, outlives the process
// until finalize) and is swept by age.
//
// A target checkout is made from someone else's code, so making it runs
// nothing: no hook, no clean, smudge or process filter (large file storage
// included), no submodule. It carries a marker file beside the tree that
// names the repository, so a later review can tell an abandoned one of its
// own from anything else.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { OpenQodexError, quoteAlternate, readRepoFile, safeGit } from "@openqodex/core";
import { checkoutsDir, lfsPaths } from "@openqodex/review";
import type { SnapshotMaker } from "@openqodex/review";

// How many changed files a checkout stores in Git LFS: the review core's
// count, which the server's snapshots use too.
export { lfsPaths };

const execFileAsync = promisify(execFile);

export const CHECKOUT_MARKER = "openqodex-checkout.json";

// A checkout older than this with no finalize is abandoned.
const ABANDONED_MS = 24 * 3600_000;

export type Checkout = { folder: string; tree: string };
type Marker = { repo: string; sha: string; created: string };

async function gitOut(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 << 20, env: env ?? process.env });
    return stdout.trim();
  } catch {
    return null;
  }
}

// The same folder, however it is spelled (/var and /private/var on macOS).
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// True when `tree` is <home>/checkouts/<one folder>/tree.
export function inCheckouts(tree: string): boolean {
  return sameDir(dirname(dirname(tree)), checkoutsDir());
}

// A target review's checkout, in a new 0700 folder under <home>/checkouts/,
// itself a real folder made 0700. The marker is written first, so even a
// checkout that dies half made is swept later. The work tree is added empty,
// then filled with every filter driver its own effective config names
// switched off: an include can add drivers only for linked work trees, so
// the developer's work tree does not know them all. No missing object is
// fetched: a partial clone without it fails in one line.
// `tree`: fill the work tree from this git tree instead of the commit's, with
// its new objects read from a temporary object folder: the developer's
// committed, uncommitted and untracked work, as the change source staged it.
export async function addTargetCheckout(
  repoRoot: string,
  sha: string,
  prefix: string,
  tree?: { sha: string; objects: string; alternates: string },
): Promise<Checkout> {
  const parent = checkoutsDir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const st = lstatSync(parent);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new OpenQodexError(`${parent} is not a real folder; remove it and run the review again`);
  const folder = mkdtempSync(join(parent, prefix));
  const work = join(folder, "tree");
  const marker: Marker = { repo: repoRoot, sha, created: new Date().toISOString() };
  writeFileSync(join(folder, CHECKOUT_MARKER), `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
  const fail = async (step: string, stderr: string): Promise<never> => {
    await removeCheckout(repoRoot, folder);
    const why = stderr.trim().split("\n")[0] ?? "";
    if (/lazy fetch|promisor|missing (blob|tree|object)|unable to read|bad object/i.test(stderr)) {
      throw new OpenQodexError(`a file of ${sha.slice(0, 12)} is not downloaded in this partial clone, and openqodex fetches nothing for a checkout; run git fetch and try again (${why})`);
    }
    throw new OpenQodexError(`could not ${step} ${sha.slice(0, 12)} to review it: ${why}`);
  };
  const added = await safeGit(repoRoot, ["worktree", "add", "--no-checkout", "--detach", "--quiet", work, sha]);
  if (added.code !== 0) return fail("add a work tree for", added.stderr);
  // core.symlinks=false: a link in the target becomes a small file holding its
  // target text, so no tool that reads the checkout follows it out.
  const env = tree ? { GIT_OBJECT_DIRECTORY: tree.objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(tree.alternates) } : undefined;
  const filled = await safeGit(work, ["-c", "core.symlinks=false", "read-tree", "--reset", "-u", tree?.sha ?? "HEAD"], undefined, env);
  if (filled.code !== 0) return fail("check out", filled.stderr);
  return { folder, tree: work };
}

export async function removeCheckout(repoRoot: string, folder: string): Promise<void> {
  await gitOut(repoRoot, ["worktree", "remove", "--force", join(folder, "tree")]);
  rmSync(folder, { recursive: true, force: true });
}

// The same at once and synchronously, for a signal handler that exits right
// after it: the folder goes, then git forgets the work tree.
export function removeCheckoutNow(repoRoot: string, checkout: Checkout): void {
  rmSync(checkout.folder, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore", timeout: 5_000 });
}

// The marker of a target checkout folder, or null when it is not one of
// ours: a real folder (never a link) directly under <home>/checkouts/,
// holding a regular marker file.
function markerOf(folder: string): (Marker & { mtimeMs: number }) | null {
  try {
    if (!sameDir(dirname(folder), checkoutsDir())) return null;
    const dir = lstatSync(folder);
    const file = lstatSync(join(folder, CHECKOUT_MARKER));
    if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile()) return null;
    const value = JSON.parse(readFileSync(join(folder, CHECKOUT_MARKER), "utf8")) as Marker;
    return typeof value.repo === "string" ? { ...value, mtimeMs: file.mtimeMs } : null;
  } catch {
    return null;
  }
}

// Removes a target checkout only when its folder is ours for this
// repository, so a path read from a run folder can never name anything else.
export async function removeTargetCheckout(repoRoot: string, tree: string): Promise<void> {
  const folder = dirname(tree);
  const marker = markerOf(folder);
  if (marker !== null && marker.repo === repoRoot) await removeCheckout(repoRoot, folder);
}

// The developer's repository when `root` is the tree of a target checkout.
export function checkoutOwner(root: string): string | null {
  return markerOf(dirname(root))?.repo ?? null;
}

// Removes this repository's target checkouts whose marker is older than a
// day: a review that was never finalized. A younger one may belong to a
// review still in progress. Lists only <home>/checkouts/, by lstat, and
// never follows a link. Then git forgets the work trees that are gone.
export async function sweepCheckouts(repoRoot: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(checkoutsDir());
  } catch {
    return;
  }
  let removed = false;
  for (const name of names) {
    const folder = join(checkoutsDir(), name);
    const marker = markerOf(folder);
    if (marker === null || marker.repo !== repoRoot || Date.now() - marker.mtimeMs < ABANDONED_MS) continue;
    rmSync(folder, { recursive: true, force: true });
    removed = true;
  }
  if (removed && existsSync(repoRoot)) await gitOut(repoRoot, ["worktree", "prune"]);
}

// The repo's settings files as they are in its work tree, never the ones the
// checked-out commit holds.
const STATE_SETTINGS = [".openqodex/config.yaml", ".openqodex/custom-instructions.md", ".openqodex/.gitignore"];

// Replaces the checked-out commit's own `.openqodex` folder (and, with
// `rootConfig`, its root config) with the work tree's settings. What the
// commit holds there never reaches the scan: links that point anywhere, or
// run state such as a receipt. rmSync removes a link itself and never follows
// one inside a folder it removes; the files are then created exclusively in
// a fresh real folder. A target review leaves the root config as the target
// has it: it is part of the code under review, and its config is read from
// the developer's repository instead.
export function placeSettings(repoRoot: string, tree: string, rootConfig: boolean): void {
  rmSync(join(tree, ".openqodex"), { recursive: true, force: true });
  if (rootConfig) rmSync(join(tree, ".openqodex.yaml"), { recursive: true, force: true });
  mkdirSync(join(tree, ".openqodex"));
  for (const rel of rootConfig ? [".openqodex.yaml", ...STATE_SETTINGS] : STATE_SETTINGS) {
    // From the work tree through the repo state reader: a link there stops the scan with one line.
    const text = readRepoFile(repoRoot, rel);
    if (text !== null) writeFileSync(join(tree, rel), text, { flag: "wx" });
  }
}

// The review's snapshots, as the review core makes and removes them: a
// detached work tree under <home>/checkouts/ (the working state, or a
// target's head with the developer's settings files placed over the
// commit's).
export const laptopSnapshots: SnapshotMaker = {
  make: addTargetCheckout,
  placeSettings: (repoRoot, tree) => placeSettings(repoRoot, tree, false),
  lfsPaths,
  remove: (repoRoot, snapshot) => removeTargetCheckout(repoRoot, snapshot.tree),
  removeNow: removeCheckoutNow,
};
