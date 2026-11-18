// A shallow clone of exactly one commit, kept in a cache folder and shared by
// the end-to-end tests of the graph. The clone is built in a temporary folder
// next to `dir` and renamed into place only after the checkout succeeded, so
// a run killed half way never leaves a cache that fails every later run. A
// cache whose HEAD cannot be read or is another commit is replaced.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const headOf = (dir: string): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

export function pinnedClone(dir: string, url: string, sha: string): string {
  if (existsSync(join(dir, ".git")) && headOf(dir) === sha) return dir;
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const building = `${dir}.building-${process.pid}`;
  rmSync(building, { recursive: true, force: true });
  mkdirSync(building);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: building, encoding: "utf8" });
  try {
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", url, sha);
    git("checkout", "-q", "--force", sha);
    rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(building, dir);
    } catch (e) {
      // Another test file renamed its own clone in first; take it when it is right.
      if (headOf(dir) !== sha) throw e;
    }
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
  return dir;
}
