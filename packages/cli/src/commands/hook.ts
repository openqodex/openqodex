// `openqodex hook check`: the agent push gate the Claude Code and Codex hook
// entries call before a shell command. `openqodex hook install|uninstall`:
// the optional git pre-push hook, the gate that sees every real push.
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { ChangeScope } from "@openqodex/core";
import { join } from "node:path";
import { promisify } from "node:util";
import { readText, sha256, writeAtomic, writeBackup } from "../agents/files.js";
import { gitPath, repoRootOf } from "../agents/git.js";
import { ownedFile, type Action } from "../agents/plan.js";
import { pushFolders } from "../agents/push-command.js";
import { withBoundary } from "../agents/lock.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
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

async function aliasOf(folder: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", `alias.${name}`], { cwd: folder, timeout: 2000 });
    return stdout.trim() === "" ? null : stdout.trim();
  } catch {
    return null;
  }
}

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
  const roots: string[] = [];
  for (const folder of folders) {
    try {
      const root = await core.findRepoRoot(folder);
      if (!roots.includes(root)) roots.push(root);
    } catch {
      // not a repository: git itself will say so
    }
  }
  const denials: string[] = [];
  const notes: string[] = [];
  for (const repoRoot of roots) {
    const { config } = core.loadConfig(repoRoot);
    const change = await core.getChange({ repoRoot, scope: {}, exclude: config.exclude, defaultBase: config.defaultBase });
    const latest = core.readLatest(repoRoot);
    const report = latest ? core.readReport(repoRoot, join(repoRoot, latest.dir)) : null;
    const decision = core.checkPush({ currentChangeId: change.id, latest, report, config });
    const message = decision.message === null ? null : roots.length > 1 ? `${repoRoot}: ${decision.message}` : decision.message;
    if (decision.decision === "deny") denials.push(message ?? `${repoRoot}: OpenQodex blocks this push`);
    else if (message) notes.push(message);
  }
  if (denials.length > 0) deny([...denials, ...notes].join("\n"));
  else if (notes.length > 0) abstainWith(notes.join("\n"));
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

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 << 20 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readAll(): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.once("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

// One pushed commit and the remote tip it replaces (null: the remote has no
// tip this clone knows and the push starts no new ref from one commit it
// has, so the usual base is used). `local` null: the hook
// ran by hand with no push lines, so the work in place is scanned.
type PushedPair = { base: string | null; local: string | null };

// For a ref the remote does not have yet: the one commit the pushed commit
// grows from that the remote already has, or null when there is not exactly one.
async function newRefBase(repoRoot: string, remoteName: string | undefined, local: string): Promise<string | null> {
  const remotes = remoteName !== undefined && /^[A-Za-z0-9._-]+$/.test(remoteName) ? `--remotes=${remoteName}` : "--remotes";
  const out = await gitOut(repoRoot, ["rev-list", "--boundary", local, "--not", remotes]);
  const boundary = (out ?? "").split("\n").filter((l) => l.startsWith("-")).map((l) => l.slice(1));
  return boundary.length === 1 ? boundary[0] : null;
}

async function pushedPairs(repoRoot: string, input: string, remoteName: string | undefined): Promise<PushedPair[]> {
  const lines = input.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return [{ base: null, local: null }];
  const pairs: PushedPair[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const [, local, , remote] = line.split(/\s+/);
    // An all-zero local sha deletes the remote ref: nothing is sent.
    if (local === undefined || ZERO_SHA.test(local)) continue;
    const known = remote !== undefined && !ZERO_SHA.test(remote) && (await gitOut(repoRoot, ["cat-file", "-e", `${remote}^{commit}`])) !== null;
    const base = known ? remote : remote !== undefined && ZERO_SHA.test(remote) ? await newRefBase(repoRoot, remoteName, local) : null;
    const key = `${base} ${local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ base, local });
  }
  return pairs;
}

// The repo's config and instructions as they are in the work tree, so a scan
// of a pushed commit in a temporary tree is judged by the same settings.
const SETTINGS = [".openqodex.yaml", ".openqodex/config.yaml", ".openqodex/custom-instructions.md", ".openqodex/.gitignore"];

// Replaces the pushed commit's own `.openqodex` folder and root config in the
// temporary checkout with the work tree's settings. What the commit holds there
// never reaches the scan: links that point anywhere, or run state such as a
// receipt. rmSync removes a link itself and never follows one inside a folder
// it removes; the files are then created exclusively in a fresh real folder.
function placeSettings(repoRoot: string, tree: string, readRepoFile: (root: string, path: string) => string | null): void {
  rmSync(join(tree, ".openqodex"), { recursive: true, force: true });
  rmSync(join(tree, ".openqodex.yaml"), { recursive: true, force: true });
  mkdirSync(join(tree, ".openqodex"));
  for (const rel of SETTINGS) {
    // From the work tree through the repo state reader: a link there stops the push scan with one line.
    const text = readRepoFile(repoRoot, rel);
    if (text !== null) writeFileSync(join(tree, rel), text, { flag: "wx" });
  }
}

async function scanIn(cwd: string, scope: ChangeScope): Promise<number> {
  const [{ runScan }, { parseFlags }] = await Promise.all([import("./scan.js"), import("../flags.js")]);
  try {
    return (await runScan({ flags: parseFlags(["--cwd", cwd], {}).global, scope })).exitCode;
  } catch (error) {
    process.stderr.write(`openqodex hook pre-push: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_TOOL_FAILED;
  }
}

// Scans a pushed commit in a temporary detached work tree of it, removed
// afterwards whatever happens.
async function scanCommit(repoRoot: string, sha: string, scope: ChangeScope): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "openqodex-push-"));
  const tree = join(tmp, "tree");
  try {
    if ((await gitOut(repoRoot, ["worktree", "add", "--detach", "--quiet", tree, sha])) === null) {
      process.stderr.write(`openqodex hook pre-push: could not check out ${sha} to scan it\n`);
      return EXIT_TOOL_FAILED;
    }
    placeSettings(repoRoot, tree, (await import("@openqodex/core")).readRepoFile);
    return await scanIn(tree, scope);
  } finally {
    await gitOut(repoRoot, ["worktree", "remove", "--force", tree]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// `openqodex hook pre-push`, run by the git pre-push hook with git's lines on
// stdin: `<local ref> <local sha> <remote ref> <remote sha>`. Each distinct
// (remote tip, pushed commit) pair is scanned against exactly that remote
// tip, so a force push to an ancestor shows what it removes. The pushed
// commit is scanned in place only when it is HEAD and the work tree is clean;
// otherwise in a temporary work tree of that commit. Exit 1 when any scan
// meets block_on_severity.
async function prePush(args: string[]): Promise<number> {
  // Git sets these for hooks; they would point the temporary tree's git at this one.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete process.env[name];
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return fail("openqodex hook pre-push: run it inside a git repository");
  // The team files first, so a temporary tree gets the repo's own settings.
  const { announceRepoFiles } = await import("../agents/repo-folder.js");
  announceRepoFiles(repoRoot);
  const pairs = await pushedPairs(repoRoot, await readAll(), args[0]);
  const head = await gitOut(repoRoot, ["rev-parse", "HEAD"]);
  const clean = (await gitOut(repoRoot, ["status", "--porcelain", "--", ".", ":(exclude).openqodex"])) === "";
  let status = EXIT_OK;
  for (const pair of pairs) {
    const scope: ChangeScope = pair.base === null ? {} : { base: pair.base, exact: true };
    const inPlace = pair.local === null || (pair.local === head && clean);
    const code = inPlace ? await scanIn(repoRoot, scope) : await scanCommit(repoRoot, pair.local!, scope);
    if (code === 1) status = 1;
  }
  return status;
}

// ---------- hook install / uninstall ----------

// The pre-push hook. It hands git's lines to `hook pre-push`. Only exit 1 (a
// finding at or above block_on_severity) stops the push; a scan or a launcher
// that cannot run exits 2 or 127, which never does.
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
// it writes: only exit 1 (a finding at or above block_on_severity) stops the
// push; a tool that fails (exit 2) or cannot start never does.
export function hookLine(command: string): string {
  return `${command} hook pre-push || [ $? -ne 1 ]`;
}

const MANAGED_LINE = (): string => hookLine(`npx -y openqodex@${__OPENQODEX_VERSION__}`);

async function hookFile(): Promise<{ repoRoot: string; path: string } | null> {
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return null;
  return { repoRoot, path: await gitHookPath(repoRoot) };
}

export async function gitHookPath(repoRoot: string): Promise<string> {
  return join(await gitPath(repoRoot, "hooks"), "pre-push");
}

function hookManager(repoRoot: string): string | null {
  if (existsSync(join(repoRoot, ".husky"))) return "husky (.husky/pre-push)";
  for (const name of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) {
    if (existsSync(join(repoRoot, name))) return `lefthook (${name}, under pre-push commands)`;
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
export async function planGitHook(repoRoot: string, record: InstallRecord, home: string, force: boolean): Promise<GitHookPlan> {
  const path = await gitHookPath(repoRoot);
  const launcher = launcherPath(home);
  const manager = hookManager(repoRoot);
  const label = "git pre-push hook";
  if (manager !== null) {
    return {
      path,
      manager,
      foreign: false,
      action: { verb: "keep", path, note: `${label}: this repo manages its hooks with ${manager}; add ${MANAGED_LINE()} there` },
    };
  }
  const script = gitHookScript(launcher);
  const current = readText(path);
  const remember = (): void => {
    record.files = record.files.filter((f) => f.path !== path);
    record.files.push({ path, sha256: sha256(script), usesLauncher: true });
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
      note: `${label}: a scan before every push${foreign ? ` (the old hook is saved beside it)` : ""}`,
      guard: { path, before: current },
      apply: () => {
        if (foreign) {
          const backup = writeBackup(path, current);
          record.backups.push({ path: backup, of: path });
          process.stdout.write(`The previous hook is saved as ${backup}\n`);
        }
        writeAtomic(path, script, 0o755);
        chmodSync(path, 0o755);
        remember();
      },
    },
  };
}

// What removing the pre-push hook would do; null when no hook is there.
// The newest hook --force set aside is put back.
export async function planGitHookRemoval(repoRoot: string, record: InstallRecord, home: string): Promise<Action | null> {
  const path = await gitHookPath(repoRoot);
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
      rmSync(path, { force: true });
      if (restore) {
        renameSync(last.path, path);
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
      `This repo manages its git hooks with ${manager}. Add this line to its pre-push hook:\n  ${MANAGED_LINE()}\nNothing was written.\n`,
    );
    return EXIT_OK;
  }

  return withBoundary(home, { wait: 60_000 }, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      // The hook always calls the launcher, so exit 1 can only be the scan's verdict.
      const runtime = planRuntime(record, __OPENQODEX_VERSION__, home);
      const refused = runtime.find((a) => a.failed);
      if (refused) return fail(`openqodex hook install: ${refused.path}: ${refused.note}`);
      await applyAll(runtime);
      const plan = await planGitHook(target.repoRoot, record, home, force);
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
        `Installed the OpenQodex pre-push hook: ${target.path}\nIt scans what each push sends and stops the push only when the config sets block_on_severity and it is met. Undo: openqodex hook uninstall\n`,
      );
      return EXIT_OK;
    } finally {
      saveRecord(home, record, recordBefore);
    }
  });
}

async function uninstall(args: string[]): Promise<number> {
  if (args.length > 0) return fail(`openqodex hook uninstall: unknown argument: ${args[0]}\n${USAGE}`);
  const target = await hookFile();
  if (target === null) return fail("openqodex hook uninstall: run it inside a git repository");
  const home = openqodexHomeDir();
  return withBoundary(home, { wait: 60_000 }, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      const current = readText(target.path);
      const action = await planGitHookRemoval(target.repoRoot, record, home);
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
      saveRecord(home, record, recordBefore);
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
