// Shared setup for the init and hook tests: temp homes and repos whose paths
// contain a space, and runs of the built CLI as a real subprocess.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../../tests/temp-dirs.mjs";

export const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

export type Sandbox = { root: string; home: string; oqHome: string; repo: string };

// GIT_OPTIONAL_LOCKS=0 so git status never rewrites the index between snapshots.
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// A temp home and a temp repo with one commit holding `files`. The default
// repo tracks no file, so `init` starts no scanner install from a test.
export function sandbox(files: Record<string, string> = {}, rootName = "oq test "): Sandbox {
  const root = realpathSync(tempDir(rootName));
  const home = join(root, "home dir");
  const repo = join(root, "the repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  // Git may start background maintenance after a commit and leave a lock file
  // for a moment; the snapshot tests compare every file, so switch it off.
  git(repo, "config", "maintenance.auto", "false");
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "start");
  return { root, home, oqHome: join(home, ".openqodex"), repo };
}

// What ties a run to the developer's own agents: their config folders, which
// would point init at the real ones (Goose's moves with XDG_CONFIG_HOME and
// GOOSE_PATH_ROOT), and the markers of the agent session the tests may run
// in, which would decide init's consent and the reviewer order.
export const AGENT_ENV = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "GOOSE_PATH_ROOT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SANDBOX", "CURSOR_AGENT"];

// A PATH with git, node and the system folders and no coding agent, so
// init's reviewer check never runs a real claude or codex, which would write
// into the test home. Git and node are linked from where this PATH finds them.
let agentFree: string | null = null;
export function agentFreePath(): string {
  if (agentFree !== null) return agentFree;
  const dir = realpathSync(tempDir("oq-agent-free-bin-"));
  for (const name of ["git", "node"]) {
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
      if (folder !== "" && existsSync(join(folder, name))) {
        symlinkSync(realpathSync(join(folder, name)), join(dir, name));
        break;
      }
    }
  }
  agentFree = [dir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  return agentFree;
}

export function env(s: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // No update worker from a test run through the launcher: it would reach
  // the registry and leave update.json behind. self-update.test.ts turns it on.
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: s.home, OPENQODEX_HOME: s.oqHome, OPENQODEX_AUTO_UPDATE: "0", PATH: agentFreePath() };
  delete e.OPENQODEX_SKIP;
  for (const key of AGENT_ENV) delete e[key];
  return { ...e, ...extra };
}

// The CLI run in a real terminal (fixtures/pty-run.py): `steps` are the
// [text to wait for, keys to type] pairs, "\r" for Enter. stdout holds what
// the terminal showed, colours taken out. `init` gets --no-review as in cli().
const PTY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pty-run.py");
export function inTerminal(s: Sandbox, args: string[], steps: ([string, string] | [string, string, string])[], opts: { env?: Record<string, string>; review?: boolean } = {}): SpawnSyncReturns<string> {
  const python = (process.env.PATH ?? "").split(delimiter).map((d) => join(d, "python3")).find((p) => existsSync(p));
  if (python === undefined) throw new Error("python3 is needed to run the CLI in a terminal");
  const argv = args[0] === "init" && !opts.review ? [...args, "--no-review"] : args;
  return spawnSync(python, [PTY, JSON.stringify(steps), process.execPath, BIN, ...argv], { cwd: s.repo, env: env(s, opts.env), encoding: "utf8", timeout: 90_000 });
}

// The prompts a terminal run asked, each once, as clack prints them after the
// answer ("◇  Write these files?").
export function promptsAsked(stdout: string): string[] {
  return [...new Set(stdout.split("\n").filter((l) => l.startsWith("◇")).map((l) => l.slice(1).trim()))];
}

// `init` gets --no-review unless `review` is set: the tests of what init
// installs compare files before and after, and the review it ends with
// writes a report folder. init-review.test.ts tests that review.
export function cli(s: Sandbox, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string>; review?: boolean } = {}): SpawnSyncReturns<string> {
  const argv = args[0] === "init" && !opts.review ? [...args, "--no-review"] : args;
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: opts.cwd ?? s.repo,
    env: env(s, opts.env),
    input: opts.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
  });
}

// Every file under `dir` (relative path to sha256), symlinks and all.
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

// The whole sandbox: home, the repo's work tree and its .git folder.
export function snapshot(s: Sandbox): Record<string, string> {
  return tree(s.root);
}

export function status(s: Sandbox): string {
  return git(s.repo, "status", "--porcelain", "--untracked-files=all");
}
