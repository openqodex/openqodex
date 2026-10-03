// Shared setup for the init and hook tests: temp homes and repos whose paths
// contain a space, and runs of the built CLI as a real subprocess.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), rootName)));
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

export function env(s: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // No update worker from a test run through the launcher: it would reach
  // the registry and leave update.json behind. self-update.test.ts turns it on.
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: s.home, OPENQODEX_HOME: s.oqHome, OPENQODEX_AUTO_UPDATE: "0" };
  delete e.OPENQODEX_SKIP;
  // Codex's home would otherwise point init at the real one.
  delete e.CODEX_HOME;
  return { ...e, ...extra };
}

export function cli(s: Sandbox, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BIN, ...args], {
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
