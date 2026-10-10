// git in a folder whose files the developer may not have written: the
// temporary checkout of a branch or a pull request, and anything the code
// graph reads. Every program git could start from the repo's config is
// switched off: hooks, the file system monitor, each filter driver the
// folder's own effective config names (an include can add drivers only for
// linked work trees), submodule recursion and fetch-on-demand of missing
// objects. The environment carries no inherited GIT_* variable, so nothing
// set around openqodex points git elsewhere. Read-only callers and the
// checkout itself go through here; diffs add --no-ext-diff and --no-textconv.
import { spawn } from "node:child_process";
import { OpenQodexError } from "./types.js";

export type SafeGitResult = { code: number; stdout: Buffer; stderr: string };

export function safeGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0" };
}

// What every git call on a server review's clone adds (reviewChange): git
// ignores replacement refs (refs/replace), so a ref in the clone can neither
// forge the ancestry the review proves nor swap the files it reads for a
// commit. The laptop's calls do not add it.
export const SERVER_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_NO_REPLACE_OBJECTS: "1" });

const BASE = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false"];

function runGit(cwd: string, argv: string[], input?: string, env?: Record<string, string>): Promise<SafeGitResult> {
  return new Promise((done, fail) => {
    const child = spawn("git", argv, { cwd, env: { ...safeGitEnv(), ...env }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => fail(new OpenQodexError(`could not run git: ${e.message}`)));
    child.on("close", (code) => done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

// The -c settings for one folder, read once per folder: the drivers come
// from that folder's own effective config.
const configs = new Map<string, Promise<string[]>>();

export function safeGitConfig(cwd: string): Promise<string[]> {
  let found = configs.get(cwd);
  if (found === undefined) {
    // Key names only, NUL separated: a value or a driver name with spaces,
    // dots or line breaks cannot be mistaken for another key.
    found = runGit(cwd, [...BASE.flatMap((c) => ["-c", c]), "config", "-z", "--name-only", "--get-regexp", "^filter\\."]).then((r) => {
      // 1 means no filter is configured; anything else means the config could not be read.
      if (r.code !== 0 && r.code !== 1) throw new OpenQodexError(`could not read the git config of ${cwd}: ${r.stderr.trim() || `git exited ${r.code}`}`);
      const drivers = new Set<string>();
      for (const key of r.stdout.toString("utf8").split("\0")) {
        if (key === "") continue;
        const end = key.lastIndexOf(".");
        if (!key.startsWith("filter.") || end <= "filter.".length) continue;
        const driver = key.slice("filter.".length, end);
        // A name that `-c key=value` could not carry faithfully is refused, never skipped.
        if (!/^[A-Za-z0-9_.-]+$/.test(driver)) {
          throw new OpenQodexError(`the git config names a filter driver that openqodex cannot switch off (${JSON.stringify(driver)}); it will not read this folder`);
        }
        drivers.add(driver);
      }
      const all = [...BASE];
      for (const d of drivers) all.push(`filter.${d}.smudge=`, `filter.${d}.clean=`, `filter.${d}.process=`, `filter.${d}.required=false`);
      return all.flatMap((c) => ["-c", c]);
    });
    configs.set(cwd, found);
  }
  return found;
}

// `env`: variables this one call needs, set after the inherited GIT_* ones
// are removed (the review fills its snapshot from a temporary object folder).
export async function safeGit(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<SafeGitResult> {
  return runGit(cwd, [...(await safeGitConfig(cwd)), ...args], input, env);
}
