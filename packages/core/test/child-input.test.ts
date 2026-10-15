// Ways writing a child's input to its stdin could fail, written before the fix:
// 1. git exits before it has read all of its input (it stops at the first
//    path it cannot open), the write fails with EPIPE, and with no listener on
//    the pipe that error is uncaught: it ends the whole process, so a server
//    running reviews loses every review it holds, not just this one.
// 2. The call that wrote the input never settles, or settles without git's
//    exit code and message, so the caller cannot say why git failed.
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit } from "../src/safe-git.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function repo(): string {
  const dir = tempDir("oq-child-input-");
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}

describe("input written to a git that stops reading", () => {
  it("settles with git's exit code and message instead of ending the process (failures 1 and 2)", async () => {
    const dir = repo();
    // The first path does not exist, so git stops there. The rest is far
    // more than a pipe holds, so the write is still going when git exits.
    const paths = ["no-such-file.txt", ...Array.from({ length: 200_000 }, (_, i) => `also-missing-${i}.txt`)];
    const r = await safeGit(dir, ["hash-object", "--stdin-paths"], `${paths.join("\n")}\n`);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no-such-file\.txt/);
  });
});
