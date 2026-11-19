// Ways switching off a repo's filter drivers could fail, written before the fix:
// 1. A driver whose command has spaces and dots is parsed as another driver
//    name, so the real driver stays on.
// 2. A driver with a name `-c key=value` cannot carry (a space, an equals
//    sign) is skipped instead of refused, so it stays on.
// Ways a git call that is given input could fail:
// 3. Git exits before it reads all of its input (it failed early, or it
//    never reads input): writing the rest fails with EPIPE, nothing listens
//    for that error on git's input, and the whole process crashes (a host's
//    worker, twice) instead of seeing a git failure.
// 4. Git exits with 0 without reading its input, and the call reports a
//    success built on input git never read.
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit, safeGitConfig } from "../src/safe-git.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function repo(): string {
  const dir = tempDir("oq-safe-git-");
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}

describe("the filter drivers a folder's git config names", () => {
  it("switches off a driver whose command holds spaces and dots (failure 1)", async () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "filter.lfs.smudge", "sh ./tools/run.sh smudge v1.2 %f"]);
    const args = await safeGitConfig(dir);
    expect(args).toContain("filter.lfs.smudge=");
    expect(args).toContain("filter.lfs.process=");
    expect(args.filter((a) => a.startsWith("filter.") && !a.startsWith("filter.lfs."))).toEqual([]);
  });

  it("refuses a driver whose name cannot be carried by -c, rather than leaving it on (failure 2)", async () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "filter.my filter.smudge", "cat"]);
    await expect(safeGitConfig(dir)).rejects.toThrow(/cannot switch off/);
  });
});

describe("a git call given more input than git reads", () => {
  // Far past a pipe's buffer, so the write is still going when git exits.
  const input = "x".repeat(8 * 1024 * 1024);

  it("returns git's own failure when git exits early with an error (failure 3)", async () => {
    const dir = repo();
    const r = await safeGit(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/none"], input);
    expect(r.code).not.toBe(0);
  });

  it("fails the call, without a crash, when git exits with 0 having read no input (failure 4)", async () => {
    const dir = repo();
    await expect(safeGit(dir, ["version"], input)).rejects.toThrow(/did not read all of its input/);
  });

  it("still passes input to a git that reads all of it", async () => {
    const dir = repo();
    const r = await safeGit(dir, ["hash-object", "--stdin"], input);
    expect(r.code).toBe(0);
    expect(r.stdout.toString("utf8").trim()).toBe(execFileSync("git", ["hash-object", "--stdin"], { input, cwd: dir, encoding: "utf8" }).trim());
  });
});
