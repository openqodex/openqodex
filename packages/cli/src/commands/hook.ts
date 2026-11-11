// `openqodex hook check`: the agent push gate the Claude Code and Codex hook
// entries call before a shell command. `openqodex hook install|uninstall`:
// the optional git pre-push hook, the gate that sees every real push. Both
// look up the review of what is pushed; neither scans nor starts a review.
// The agent hook is a reminder about the developer's current work, not the
// boundary: it does not know what a push sends. The git pre-push hook, which
// git hands the exact ranges, is the authoritative check.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readText, sha256 } from "../agents/files.js";
import { Guard } from "../agents/guarded-fs.js";
import { gitDirs, gitPath, repoRootOf } from "../agents/git.js";
import { ownedFile, type Action } from "../agents/plan.js";
import { pushFolders } from "../agents/push-command.js";
import { withBoundary } from "../agents/lock.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { readHomeReceipt, readHomeReceipts } from "../receipts.js";
import type { GateReceipt } from "@openqodex/core";
import { launcherPath, openqodexHomeDir, planRuntime, shQuote } from "../launcher.js";

const execFileAsync = promisify(execFile);

const USAGE = [
  "usage: openqodex hook check [--agent <claude-code|codex>]   (called by the agent hook, reads its JSON on stdin)",
  "       openqodex hook install [--force]                      (adds a git pre-push hook to this repo)",
  "       openqodex hook uninstall",
  "       openqodex hook pre-push                               (run by the git pre-push hook, reads git's lines on stdin)",
].join("\n");

export const GIT_HOOK_MARKER = "# openqodex pre-push hook: openqodex hook uninstall removes it";

// ---------- hook check ----------

const STDIN_DEADLINE_MS = 3000;
const STDIN_CAP_BYTES = 1 << 20;

type HookInput = { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };

// The whole of stdin, or null when it is not closed within the deadline or
// grows past the cap. Either way the check abstains.
function readStdin(): Promise<string | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (value: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      if (value === null) process.stdin.destroy();
      done(value);
    };
    const timer = setTimeout(() => finish(null), STDIN_DEADLINE_MS);
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDIN_CAP_BYTES) finish(null);
      else chunks.push(chunk);
    });
    process.stdin.once("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", () => finish(null));
  });
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// One output shape for both agents: Claude Code and Codex both read
// hookSpecificOutput.permissionDecision "deny", additionalContext and
// systemMessage from a PreToolUse hook. Never "allow" or "ask".
function abstainWith(message: string): void {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message }, systemMessage: message });
}

function deny(message: string): void {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });
}

export async function aliasOf(folder: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", `alias.${name}`], { cwd: folder, timeout: 2000 });
    return stdout.trim() === "" ? null : stdout.trim();
  } catch {
    return null;
  }
}

type Core = typeof import("@openqodex/core");
type Config = ReturnType<Core["loadConfig"]>["config"];

const git = async (repoRoot: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, timeout: 10_000 });
    return stdout.trim() === "" ? null : stdout.trim();
  } catch {
    return null;
  }
};
const commitOf = (repoRoot: string, rev: string) => git(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);

// The change id of one pushed range, the id a review of it records. The
// range runs from what the remote branch holds (`remoteSha`), or for a new
// branch from the merge base with the base a review uses (review.default_base,
// else the remote's default branch), to the pushed commit. Two ranges count
// as the same when they start at the same commit and end in the same tree:
// the change id hashes the base commit and the diff between them. So a
// review of base B to H does not cover a push of H over a remote commit R
// that is not B, such as a force push over work the review never saw.
async function rangeChangeId(core: Core, repoRoot: string, config: Config, remote: string, localSha: string, remoteSha: string | null): Promise<{ id: string; base: string } | { unknown: string }> {
  let base: string | null = null;
  if (remoteSha !== null) {
    base = await commitOf(repoRoot, remoteSha);
    if (base === null) return { unknown: `the remote's commit ${remoteSha.slice(0, 12)} is not in this repository, so the push cannot be matched to a review; fetch, then push again` };
  } else {
    const named = config.defaultBase !== null ? [config.defaultBase, `${remote}/${config.defaultBase}`] : [`refs/remotes/${remote}/HEAD`];
    for (const ref of named) {
      const sha = await commitOf(repoRoot, ref);
      base = sha === null ? null : await git(repoRoot, ["merge-base", sha, localSha]);
      if (base !== null) break;
    }
    if (base === null) return { unknown: "this push starts a new branch and no base to measure it from was found (review.default_base, or the remote's default branch)" };
  }
  const change = await core.getTreeChange({ repoRoot, baseRef: base, baseSha: base, headSha: localSha, exclude: config.exclude, idOnly: true });
  return { id: change.id, base };
}

// The block_on_severity the config sets in commit `base`, read from git as
// loadConfig reads the work tree: .openqodex/config.yaml, else the legacy
// .openqodex.yaml, and neither through a link or past the size cap. Null
// when that config is missing, a link, too big or not valid, or git cannot
// read it: only a config that validly chose blocking blocks.
async function blockingAt(core: Core, repoRoot: string, base: string): Promise<{ severity: string; file: string } | null> {
  const run = async (args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: repoRoot, timeout: 10_000, maxBuffer: 2 * core.CONFIG_MAX_BYTES, env: { ...process.env, ...core.SERVER_GIT_ENV } })).stdout;
  // One path per call, so other files under .openqodex/ never reach the
  // output: a path names the entry itself, never what a folder holds.
  const entry = async (path: string): Promise<{ mode: string; sha: string; size: number } | null> => {
    const [meta = "", name] = (await run(["ls-tree", "-z", "-l", "--full-tree", base, "--", path])).split("\0")[0]!.split("\t");
    const [mode = "", , sha = "", size] = meta.split(/\s+/);
    return name === path ? { mode, sha, size: Number(size) } : null;
  };
  try {
    const folder = await entry(".openqodex");
    if (folder?.mode === "120000") return null;
    const entries = new Map<string, { mode: string; sha: string; size: number } | null>([
      [core.CONFIG_FILE, folder?.mode === "040000" ? await entry(core.CONFIG_FILE) : null],
      [core.LEGACY_CONFIG_FILE, await entry(core.LEGACY_CONFIG_FILE)],
    ]);
    const files = [core.CONFIG_FILE, core.LEGACY_CONFIG_FILE].filter((f) => entries.get(f) !== null);
    // loadConfig reads both files before it picks one: either one a link,
    // not a file or too big stops it.
    if (files.some((f) => !["100644", "100755"].includes(entries.get(f)!.mode) || !(entries.get(f)!.size <= core.CONFIG_MAX_BYTES))) return null;
    const file = files[0];
    if (file === undefined) return null;
    const text = await run(["cat-file", "blob", entries.get(file)!.sha]);
    const severity = core.parseConfig(text, file, { runtimeVersion: __OPENQODEX_VERSION__ }).config.blockOnSeverity;
    return severity === null ? null : { severity, file };
  } catch {
    return null;
  }
}

// The commits a pushed range starts from, all of them commits the remote
// has: for a branch the remote has, its old tip; for a new branch, the
// nearest ancestors of the pushed commit that a remote-tracking ref of
// `remote` contains, or the pushed commit itself when one does. Neither
// review.default_base nor the remote's HEAD ref is needed. Empty when the
// remote has none of the branch or git fails. Replace refs are off, and
// git's output is read as it comes, so no output limit applies.
async function remoteBases(core: Core, repoRoot: string, remote: string, range: Range): Promise<string[]> {
  if (range.remoteSha !== null) {
    const base = await commitOf(repoRoot, range.remoteSha);
    return base === null ? [] : [base];
  }
  const head = await commitOf(repoRoot, range.local);
  if (head === null) return [];
  return new Promise((done) => {
    const child = spawn("git", ["rev-list", "--boundary", head, "--not", `--remotes=${remote}`], {
      cwd: repoRoot,
      timeout: 10_000,
      env: { ...process.env, ...core.SERVER_GIT_ENV },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const bases: string[] = [];
    let sent = 0;
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("-")) bases.push(line.slice(1));
        else sent++;
      }
    });
    child.once("error", () => done([]));
    child.once("close", (code) => done(code !== 0 ? [] : sent === 0 ? [head] : bases));
  });
}

// The work tree's config cannot be read (`error`). A lookup that fails for
// its own reasons never stops a push, but a push can carry the broken config
// itself. So the push stops when the config in any base of any pushed range
// (remoteBases) chose blocking; otherwise the error stands.
async function brokenConfig(core: Core, repoRoot: string, remote: string, error: unknown): Promise<number> {
  for (const range of pushedRanges(await readAll())) {
    for (const base of await remoteBases(core, repoRoot, remote, range)) {
      const blocking = await blockingAt(core, repoRoot, base);
      if (blocking === null) continue;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `OpenQodex cannot read this repo's config: ${reason}\nThis repo blocks a push without a passing review (block_on_severity: ${blocking.severity} in ${blocking.file} at ${base.slice(0, 12)}). Fix the config, then push again.\n`,
      );
      return 1;
    }
  }
  throw error;
}

// How many saved reviews a push looks through for one that contains it, so a
// push stays fast however many reviews are saved.
const CONTAINING_LIMIT = 20;

// The newest complete review whose range contains the pushed one, among the
// newest saved reviews (CONTAINING_LIMIT), so a later review of other work
// does not hide it. A review contains the push when its base is the push's
// base or an ancestor of it, the push's base is an
// ancestor of the pushed commit (so a force push over a commit the review
// never saw is not contained), and the change from its base to the pushed
// commit is the very change it reviewed (the change id hashes the base and
// the diff, so any other content gives another id). A branch
// reviewed with no upstream is measured from the merge base with the default
// branch, while its push is measured from the remote branch's tip; this
// lets that review count. Returned under the pushed range's id; else null.
async function containingReceipt(core: Core, repoRoot: string, config: Config, saved: GateReceipt[], pushBase: string, localSha: string, pushedId: string): Promise<GateReceipt | null> {
  if (!(await isAncestor(repoRoot, pushBase, localSha))) return null;
  // The change from one base to the pushed commit, worked out once per base.
  const fromBase = new Map<string, string | null>();
  for (const receipt of saved) {
    if (receipt.kind !== "complete") continue;
    let id = fromBase.get(receipt.base.sha);
    if (id === undefined) {
      const base = await commitOf(repoRoot, receipt.base.sha);
      id = base !== null && (await isAncestor(repoRoot, base, pushBase)) ? (await core.getTreeChange({ repoRoot, baseRef: base, baseSha: base, headSha: localSha, exclude: config.exclude, idOnly: true })).id : null;
      fromBase.set(receipt.base.sha, id);
    }
    if (id === receipt.change_id) return { ...receipt, change_id: pushedId };
  }
  return null;
}

async function isAncestor(repoRoot: string, older: string, newer: string, env: Readonly<Record<string, string>> = {}): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: repoRoot, timeout: 10_000, env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  }
}

// The one command shape the agent hook recognises, after trimming: `git
// push`, then plain words separated by single spaces: any of these options,
// an optional remote name, and at most one refspec that is `HEAD` or the
// current branch's name. Anything else (`src:dst`, `+`, `--no-verify`, a
// second refspec, any other option, quotes, `$`, `;`, `&&`, a newline, `-C`,
// a wrapper) is not recognised. The hook never works out what a push sends:
// for a recognised line it asks whether the developer's current work has a
// review.
const PLAIN_OPTIONS = new Set(["-u", "--set-upstream", "-f", "--force", "--force-with-lease"]);
const REMOTE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

// The remote and the refspec the line names, in that order; null when the
// line is not recognised.
function plainWords(command: string): string[] | null {
  const words = command.trim().split(" ");
  if (words[0] !== "git" || words[1] !== "push") return null;
  const rest = words.slice(2).filter((w) => !PLAIN_OPTIONS.has(w));
  if (rest.length > 2 || (rest[0] !== undefined && !REMOTE.test(rest[0])) || (rest[1] !== undefined && !BRANCH.test(rest[1]))) return null;
  return rest;
}

// The refspec the line names, "" for none; null when the line is not recognised.
export function plainPush(command: string): string | null {
  const rest = plainWords(command);
  return rest === null ? null : (rest[1] ?? "");
}

// Whether the remote already has `sha`: a remote-tracking ref of `remote`
// contains it. A commit only a local branch holds does not count. Replace
// refs are off, as onlyStateChanged reads the change.
async function remoteHolds(core: Core, repoRoot: string, remote: string, sha: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["for-each-ref", "--count=1", "--format=%(refname)", `--contains=${sha}`, `refs/remotes/${remote}/`], { cwd: repoRoot, timeout: 10_000, env: { ...process.env, ...core.SERVER_GIT_ENV } });
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}

// The commits from `base`, which the remote has (`held`, else a
// remote-tracking ref of `remote` contains it), to `head` change nothing but
// .openqodex/, which a review leaves out: no review can record such a push.
// A git error is false, so the push is looked up as before.
async function onlyState(core: Core, repoRoot: string, remote: string, base: string, head: string, held: boolean): Promise<boolean> {
  try {
    return (held || (await remoteHolds(core, repoRoot, remote, base))) && (await core.onlyStateChanged(repoRoot, base, head));
  } catch {
    return false;
  }
}

const FORCE_OPTIONS = new Set(["-f", "--force", "--force-with-lease"]);

// The agent hook's skip, for a recognised line: HEAD changes nothing but
// .openqodex/ from the review's `base` (onlyState), and the work tree and
// index change nothing but .openqodex/ from HEAD, so the developer's current
// work is what the push sends. The remote is the one the line names, else
// the one git pushes the current branch to. Never for a push that could
// remove commits from the remote branch (a force option, or a remote tip
// that is not an ancestor of HEAD), or that sends more than the current
// branch (push.default matching, a remote's push refspecs or mirror
// setting, push.followTags).
async function onlyStateWork(core: Core, repoRoot: string, command: string, base: string): Promise<boolean> {
  const current = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = await commitOf(repoRoot, "HEAD");
  const words = plainWords(command);
  if (current === null || head === null || words === null) return false;
  if (command.trim().split(" ").some((w) => FORCE_OPTIONS.has(w))) return false;
  const remote =
    words[0] ??
    (await git(repoRoot, ["config", "--get", `branch.${current}.pushRemote`])) ??
    (await git(repoRoot, ["config", "--get", "remote.pushDefault"])) ??
    (await git(repoRoot, ["config", "--get", `branch.${current}.remote`])) ??
    "origin";
  const pushDefault = await git(repoRoot, ["config", "--get", "push.default"]);
  if (pushDefault === "matching") return false;
  if ((await git(repoRoot, ["config", "--get-all", `remote.${remote}.push`])) !== null) return false;
  if ((await git(repoRoot, ["config", "--type=bool", "--get", `remote.${remote}.mirror`])) === "true") return false;
  if ((await git(repoRoot, ["config", "--type=bool", "--get", "push.followTags"])) === "true") return false;
  // The remote branch the push updates: the upstream's name under
  // push.default upstream with no refspec, else the current branch's.
  const merge = words[1] === undefined && pushDefault === "upstream" ? await git(repoRoot, ["config", "--get", `branch.${current}.merge`]) : null;
  const target = merge?.replace(/^refs\/heads\//, "") ?? current;
  const tip = await commitOf(repoRoot, `refs/remotes/${remote}/${target}`);
  if (tip !== null && !(await isAncestor(repoRoot, tip, head, core.SERVER_GIT_ENV))) return false;
  if (!(await onlyState(core, repoRoot, remote, base, head, false))) return false;
  try {
    const work = await core.getChange({ repoRoot, scope: { uncommitted: true }, exclude: [], idOnly: true });
    return work.id === core.emptyChangeId(work.baseSha);
  } catch {
    return false;
  }
}

const CANNOT_TELL = "OpenQodex could not tell what this push sends; run openqodex review and push with plain git push";

async function decide(input: HookInput): Promise<void> {
  if (typeof input.tool_name === "string" && input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const folders = await pushFolders(command, cwd, aliasOf);
  if (folders.length === 0) return;

  if (process.env.OPENQODEX_SKIP === "1") {
    abstainWith("OpenQodex check skipped (OPENQODEX_SKIP is set)");
    return;
  }

  // Loaded only for a push, so every other shell command stays fast.
  const core = await import("@openqodex/core");
  const spec = plainPush(command);
  // A recognised line runs in `cwd`; any other is checked in the folders it
  // pushes from, as one the hook cannot tell.
  const roots: string[] = [];
  for (const folder of spec !== null ? [cwd] : folders) {
    try {
      const root = await core.findRepoRoot(folder);
      if (!roots.includes(root)) roots.push(root);
    } catch {
      // not a repository: git itself will say so
    }
  }
  const denials = new Set<string>();
  const notes = new Set<string>();
  const home = openqodexHomeDir();
  for (const repoRoot of roots) {
    const { config } = core.loadConfig(repoRoot, undefined, { runtimeVersion: __OPENQODEX_VERSION__ });
    const where = (m: string) => (roots.length > 1 ? `${repoRoot}: ${m}` : m);
    const branch = spec === null || spec === "" || spec === "HEAD" ? null : await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (spec === null || (spec !== "" && spec !== "HEAD" && spec !== branch)) {
      // Not recognised: no record, never reviewed. It denies under a threshold.
      if (config.blockOnSeverity !== null) denials.add(where(CANNOT_TELL));
      else notes.add(where(CANNOT_TELL));
      continue;
    }
    // The developer's current work, as the default review takes it.
    const change = await core.getChange({ repoRoot, scope: {}, exclude: config.exclude, defaultBase: config.defaultBase, idOnly: true });
    if (await onlyStateWork(core, repoRoot, command, change.baseSha)) continue;
    // Only the record in the developer's own home counts, never one under
    // the repository's .openqodex/, which a branch can carry.
    const receipt = readHomeReceipt(home, repoRoot, change.id) ?? readHomeReceipt(home, repoRoot, "latest");
    const decision = core.checkPush({ currentChangeId: change.id, receipt, config });
    if (decision.decision === "deny") denials.add(where(decision.message ?? "OpenQodex blocks this push"));
    else if (decision.message) notes.add(where(decision.message));
  }
  if (denials.size > 0) deny([...denials, ...notes].join("\n"));
  else if (notes.size > 0) abstainWith([...notes].join("\n"));
}

async function check(): Promise<number> {
  try {
    const raw = await readStdin();
    if (raw === null) return EXIT_OK;
    const input = JSON.parse(raw) as unknown;
    if (typeof input !== "object" || input === null) return EXIT_OK;
    await decide(input as HookInput);
  } catch (error) {
    // Never break a push by accident: say why on stderr, print nothing.
    process.stderr.write(`openqodex hook check: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return EXIT_OK;
}

// ---------- hook pre-push ----------

const ZERO_SHA = /^0+$/;

function readAll(): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.once("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

// The ranges a push sends, from git's lines on stdin: `<local ref> <local
// sha> <remote ref> <remote sha>`. An all-zero local sha deletes the remote
// ref and sends nothing; an all-zero remote sha starts a new branch (null).
// No lines (a push that sends nothing) is no range: nothing to check.
type Range = { localRef: string; local: string; remoteRef: string; remoteSha: string | null };

function pushedRanges(input: string): Range[] {
  const lines = input.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const out = new Map<string, Range>();
  for (const l of lines) {
    const [localRef = "", local, remoteRef = "", remote] = l.split(/\s+/);
    if (local === undefined || ZERO_SHA.test(local)) continue;
    const remoteSha = remote === undefined || ZERO_SHA.test(remote) ? null : remote;
    if (remoteSha === local) continue; // the remote has it already: nothing is sent
    out.set(`${local} ${remoteSha}`, { localRef, local, remoteRef, remoteSha });
  }
  return [...out.values()];
}

// `openqodex hook pre-push <remote>`, run by the git pre-push hook. The same
// lookup as the agent hook (core checkPush), for exactly what is pushed: each
// pushed range (rangeChangeId) must be a change a review recorded in the
// developer's home covered. It prints no scanner output and never starts a
// review. Exit 1 only when the lookup denies (block_on_severity is set and
// the review is missing or blocked, or the work tree's config cannot be read
// and a pushed range's base chose blocking: brokenConfig); an incomplete
// review never blocks.
async function prePush(args: string[]): Promise<number> {
  // Git sets these for hooks; they would point git at another index or tree.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete process.env[name];
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return fail("openqodex hook pre-push: run it inside a git repository");
  const core = await import("@openqodex/core");
  const remote = args[0] ?? "origin";
  let config: Config;
  try {
    ({ config } = core.loadConfig(repoRoot, undefined, { runtimeVersion: __OPENQODEX_VERSION__ }));
  } catch (error) {
    return brokenConfig(core, repoRoot, remote, error);
  }
  const home = openqodexHomeDir();
  // Only the records in the developer's own home count (see hook check).
  const newest = readHomeReceipt(home, repoRoot, "latest");
  const saved = readHomeReceipts(home, repoRoot, CONTAINING_LIMIT);
  const messages = new Set<string>();
  let denied = false;
  for (const range of pushedRanges(await readAll())) {
    let changeId = "";
    const found = await rangeChangeId(core, repoRoot, config, remote, range.local, range.remoteSha);
    // The remote's old tip is a commit the remote has; a new branch's base
    // counts only when a remote-tracking ref contains it.
    if ("id" in found && (await onlyState(core, repoRoot, remote, found.base, range.local, range.remoteSha !== null))) continue;
    if ("id" in found) changeId = found.id;
    else messages.add(`OpenQodex could not tell what this push sends (${found.unknown}); run openqodex review, then push again.`);
    const exact = changeId === "" ? null : readHomeReceipt(home, repoRoot, changeId);
    const receipt = exact ?? ("id" in found ? await containingReceipt(core, repoRoot, config, saved, found.base, range.local, changeId) : null) ?? newest;
    const decision = core.checkPush({ currentChangeId: changeId, receipt, config });
    if (decision.decision === "deny") denied = true;
    if (decision.message === null) continue;
    // A branch the remote has, with no upstream here: a review measures it
    // from another base than the push, so say how to line the two up.
    const unreviewed = decision.message.startsWith("OpenQodex has not reviewed");
    const branch = range.remoteRef.replace(/^refs\/heads\//, "");
    const upstream = range.localRef.startsWith("refs/heads/") ? await git(repoRoot, ["for-each-ref", "--format=%(upstream)", range.localRef]) : null;
    const local = range.localRef.replace(/^refs\/heads\//, "");
    const fix = unreviewed && range.remoteSha !== null && upstream === null ? ` If you reviewed it already, set the branch's upstream (git branch --set-upstream-to ${shQuote(`${remote}/${branch}`)} ${shQuote(local)}), run openqodex review on that branch, then push.` : "";
    messages.add(`${decision.message}${fix}`);
  }
  for (const m of messages) process.stderr.write(`${m}\n`);
  return denied ? 1 : EXIT_OK;
}

// ---------- hook install / uninstall ----------

// The pre-push hook. It hands git's lines to `hook pre-push`. Only exit 1
// (block_on_severity is set and no passing review of what is pushed exists)
// stops the push; a lookup or a launcher that cannot run exits 2 or 127,
// which never does.
export function gitHookScript(launcher: string): string {
  return [
    "#!/bin/sh",
    GIT_HOOK_MARKER,
    `${shQuote(launcher)} hook pre-push "$@"`,
    "status=$?",
    '[ "$status" -eq 1 ] && exit 1',
    "exit 0",
    "",
  ].join("\n");
}

// The line to add to a pre-push hook openqodex does not write (husky,
// lefthook, a hook of the developer's own). The same exit mapping as the hook
// it writes: only exit 1 stops the push; a tool that fails (exit 2) or
// cannot start never does. `args` hands on git's hook arguments (the remote
// name and URL): "$@" in a shell hook; empty for lefthook (see hookManager).
export function hookLine(command: string, args = '"$@"'): string {
  return `${command} hook pre-push ${args === "" ? "" : `${args} `}|| [ $? -ne 1 ]`;
}

const MANAGED_LINE = (manager: HookManager): string => hookLine(`npx -y openqodex@${__OPENQODEX_VERSION__}`, manager.args);

async function hookFile(): Promise<{ repoRoot: string; path: string } | null> {
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return null;
  return { repoRoot, path: await gitHookPath(repoRoot) };
}

export async function gitHookPath(repoRoot: string): Promise<string> {
  return join(await gitPath(repoRoot, "hooks"), "pre-push");
}

// A hook manager the repo uses, and how its pre-push command gets git's
// arguments. Husky runs .husky/pre-push as a shell script with git's
// arguments. Lefthook inserts them raw in place of {1} and {2} in its `run`
// line, so a remote URL holding a quote and `$(...)` would run as shell code:
// the lefthook line passes none, and the push is looked up against origin.
type HookManager = { label: string; args: string };

function hookManager(repoRoot: string): HookManager | null {
  if (existsSync(join(repoRoot, ".husky"))) return { label: "husky (.husky/pre-push)", args: '"$@"' };
  for (const name of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) {
    if (existsSync(join(repoRoot, name))) return { label: `lefthook (${name}, under pre-push commands)`, args: "" };
  }
  return null;
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return EXIT_TOOL_FAILED;
}

async function applyAll(actions: Action[]): Promise<void> {
  for (const a of actions) {
    if (!a.apply) continue;
    if (a.guard && readText(a.guard.path) !== a.guard.before) throw new Error(`changed while openqodex was running, nothing written to ${a.guard.path}`);
    await a.apply();
  }
}

// The answer init records for its hook question; `hook install` records
// yes and `hook uninstall` forgets it, so a later init does not undo either.
export function setHookChoice(record: InstallRecord, repo: string, hook: "pre-push" | "none"): void {
  record.hookChoices = record.hookChoices.filter((c) => c.repo !== repo);
  record.hookChoices.push({ repo, hook });
}

export type GitHookPlan = {
  path: string;
  // Set when the repo runs its hooks through a hook manager: nothing is written.
  manager: string | null;
  // A pre-push hook that is not ours is there and --force was not given.
  foreign: boolean;
  action: Action;
};

// What installing the pre-push hook would do. The runtime and launcher it
// calls are planned separately (planRuntime).
export async function planGitHook(repoRoot: string, record: InstallRecord, home: string, force: boolean, guard: Guard): Promise<GitHookPlan> {
  const path = await gitHookPath(repoRoot);
  // The hooks folder git names (core.hooksPath can move it) is one init writes.
  guard.add(dirname(path));
  const launcher = launcherPath(home);
  const manager = hookManager(repoRoot);
  const label = "git pre-push hook";
  if (manager !== null) {
    return {
      path,
      manager: manager.label,
      foreign: false,
      action: { verb: "keep", path, note: `${label}: this repo manages its hooks with ${manager.label}; add ${MANAGED_LINE(manager)} there` },
    };
  }
  const script = gitHookScript(launcher);
  const current = readText(path);
  // An entry already there keeps its place, so a run that changes nothing
  // leaves the record byte for byte as it was.
  const remember = (): void => {
    const entry = { path, sha256: sha256(script), usesLauncher: true };
    const at = record.files.findIndex((f) => f.path === path);
    if (at === -1) record.files.push(entry);
    else record.files = record.files.map((f, i) => (i === at ? entry : f)).filter((f, i) => i === at || f.path !== path);
  };
  if (current === script) {
    remember();
    return { path, manager, foreign: false, action: { verb: "skip", path, note: `${label} already present` } };
  }
  const foreign = current !== null && !ownedFile(record, path, current);
  if (foreign && !force) {
    return {
      path,
      manager,
      foreign: true,
      action: { verb: "keep", path, note: `${label}: a hook openqodex did not write is there; add ${hookLine(shQuote(launcher))} to it, or run openqodex hook install --force` },
    };
  }
  return {
    path,
    manager,
    foreign: false,
    action: {
      verb: current === null ? "create" : foreign ? "replace" : "update",
      path,
      note: `${label}: a review check before every push${foreign ? ` (the old hook is saved beside it)` : ""}`,
      guard: { path, before: current },
      apply: () => {
        if (foreign) {
          const backup = guard.backup(path, current);
          record.backups.push({ path: backup, of: path });
          process.stdout.write(`The previous hook is saved as ${backup}\n`);
        }
        guard.write(path, script, { mode: 0o755 });
        remember();
      },
    },
  };
}

// What removing the pre-push hook would do; null when no hook is there.
// The newest hook --force set aside is put back.
export async function planGitHookRemoval(repoRoot: string, record: InstallRecord, home: string, guard: Guard): Promise<Action | null> {
  const path = await gitHookPath(repoRoot);
  guard.add(dirname(path));
  const current = readText(path);
  const ours = current !== null && (ownedFile(record, path, current) || current === gitHookScript(launcherPath(home)));
  const recorded = record.files.some((f) => f.path === path);
  const forget = (): void => {
    record.files = record.files.filter((f) => f.path !== path);
  };
  if (!ours) {
    forget();
    if (current === null) return null;
    return recorded ? { verb: "keep", path, note: "git pre-push hook was edited after install; left in place" } : null;
  }
  const backups = record.backups.filter((b) => b.of === path);
  const last = backups[backups.length - 1];
  const restore = last !== undefined && readText(last.path) !== null;
  return {
    verb: restore ? "restore" : "remove",
    path,
    note: restore ? "git pre-push hook removed; the previous hook is put back" : "git pre-push hook",
    guard: { path, before: current },
    apply: () => {
      guard.remove(path);
      if (restore) {
        guard.rename(last.path, path);
        record.backups = record.backups.filter((b) => b !== last);
      }
      forget();
    },
  };
}

async function install(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const unknown = args.filter((a) => a !== "--force");
  if (unknown.length > 0) return fail(`openqodex hook install: unknown argument: ${unknown[0]}\n${USAGE}`);
  const target = await hookFile();
  if (target === null) return fail("openqodex hook install: run it inside a git repository");
  const home = openqodexHomeDir();
  const launcher = launcherPath(home);
  const manager = hookManager(target.repoRoot);
  if (manager !== null) {
    process.stdout.write(
      `This repo manages its git hooks with ${manager.label}. Add this line to its pre-push hook:\n  ${MANAGED_LINE(manager)}\nNothing was written.\n`,
    );
    return EXIT_OK;
  }

  const guard = new Guard({ repoRoot: target.repoRoot, gitFolders: await gitDirs(target.repoRoot), roots: [home] });
  return withBoundary(home, { wait: 60_000 }, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      // The hook always calls the launcher, so exit 1 can only be the scan's verdict.
      const runtime = planRuntime(record, __OPENQODEX_VERSION__, home, guard);
      const refused = runtime.find((a) => a.failed);
      if (refused) return fail(`openqodex hook install: ${refused.path}: ${refused.note}`);
      await applyAll(runtime);
      const plan = await planGitHook(target.repoRoot, record, home, force, guard);
      if (plan.foreign) {
        return fail(
          `openqodex hook install: ${target.path} already exists and is not ours. Add this line to it:\n  ${hookLine(shQuote(launcher))}\nor run openqodex hook install --force to replace it (the old hook is kept beside it).`,
        );
      }
      if (plan.action.verb === "skip") {
        process.stdout.write(`The OpenQodex pre-push hook is already installed: ${target.path}\n`);
        return EXIT_OK;
      }
      await applyAll([plan.action]);
      setHookChoice(record, target.repoRoot, "pre-push");
      process.stdout.write(
        `Installed the OpenQodex pre-push hook: ${target.path}\nBefore each push it checks for a review of what the push sends (openqodex review), and stops the push only when the config sets block_on_severity and that review is missing or blocked. Undo: openqodex hook uninstall\n`,
      );
      return EXIT_OK;
    } finally {
      saveRecord(home, record, recordBefore, guard);
    }
  });
}

async function uninstall(args: string[]): Promise<number> {
  if (args.length > 0) return fail(`openqodex hook uninstall: unknown argument: ${args[0]}\n${USAGE}`);
  const target = await hookFile();
  if (target === null) return fail("openqodex hook uninstall: run it inside a git repository");
  const home = openqodexHomeDir();
  const guard = new Guard({ repoRoot: target.repoRoot, gitFolders: await gitDirs(target.repoRoot), roots: [home] });
  return withBoundary(home, { wait: 60_000 }, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      const current = readText(target.path);
      const action = await planGitHookRemoval(target.repoRoot, record, home, guard);
      if (action === null || action.apply === undefined) {
        process.stdout.write(
          current === null
            ? "No pre-push hook is installed.\n"
            : action !== null
              ? `${target.path} was edited after install; left in place.\n`
              : `${target.path} is not the OpenQodex hook; left in place.\n`,
        );
        return EXIT_OK;
      }
      await applyAll([action]);
      // A later init asks again.
      record.hookChoices = record.hookChoices.filter((c) => c.repo !== target.repoRoot);
      process.stdout.write(
        action.verb === "restore"
          ? `Removed the OpenQodex pre-push hook and put the previous hook back: ${target.path}\n`
          : `Removed the OpenQodex pre-push hook: ${target.path}\n`,
      );
      return EXIT_OK;
    } finally {
      saveRecord(home, record, recordBefore, guard);
    }
  });
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "check") return await check();
    if (sub === "pre-push") return await prePush(rest);
    if (sub === "install") return await install(rest);
    if (sub === "uninstall") return await uninstall(rest);
  } catch (error) {
    return fail(`openqodex hook ${sub}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fail(USAGE);
}
