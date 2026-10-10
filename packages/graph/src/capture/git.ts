// The checks every value from the repository passes before it reaches
// git's arguments, and the one way the graph reads a file of a commit.
// Every git call goes through safeGit (packages/core/src/safe-git.ts): no
// hook, no file system monitor, no filter driver, no inherited GIT_*
// variable. A commit or tree id is 40 or 64 lower-case hex characters. A
// path is relative, with no empty, `.` or `..` part and no NUL, line feed
// or carriage return; a path is never placed where git reads an option
// (it always follows `<id>:`).
import { safeGit } from "@openqodex/core";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isSha(value: string): boolean {
  return SHA.test(value);
}

// A relative path inside the repository, as data (a NUL-separated record,
// a file read): no empty, `.` or `..` part, no NUL.
export function isRepoRelative(path: string): boolean {
  if (path === "" || path.length > 4096 || path.startsWith("/") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

// The same, safe in an argument or a line of a line-based git protocol:
// no line feed or carriage return either.
export function isSafeRepoPath(path: string): boolean {
  return isRepoRelative(path) && !path.includes("\n") && !path.includes("\r");
}

// The bytes of `path` in the commit or tree `sha`, or null when either fails
// its check, the file is not there, or it is larger than `maxBytes` (its
// size is asked first, so a larger blob is never read). `env`: variables
// both git calls add (a server review's SERVER_GIT_ENV).
export async function showBlob(root: string, sha: string, path: string, maxBytes: number, env?: Readonly<Record<string, string>>): Promise<Buffer | null> {
  if (!isSha(sha) || !isSafeRepoPath(path)) return null;
  const object = `${sha}:${path}`;
  const extra = env === undefined ? undefined : { ...env };
  const size = await safeGit(root, ["cat-file", "-s", object], undefined, extra);
  if (size.code !== 0) return null;
  const bytes = Number(size.stdout.toString("utf8").trim());
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) return null;
  const r = await safeGit(root, ["cat-file", "blob", object], undefined, extra);
  return r.code === 0 && r.stdout.length <= maxBytes ? r.stdout : null;
}
