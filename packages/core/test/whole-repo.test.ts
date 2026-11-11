// Ways the whole-repo scope (`review --all`) could fail, each one a test below:
// 1. An untracked file is missing, or a gitignored file, an excluded file or
//    the tool's own .openqodex/ folder is included.
// 2. A line count is short (the last line without a trailing newline, above
//    all), so a finding on that line would be rejected; or a binary file gets
//    a line count; or a set of every line number is built per file, which
//    exhausts memory on a large repo.
// 3. The id does not move after an edit that is not staged, an edit to an
//    untracked file or a mode change, so finalize accepts findings written
//    for code that has since changed; or it moves between two runs on the
//    same content, so every finalize says the change moved.
// 4. A file over the 5 MB cap is read whole into the scope instead of being
//    listed as not reviewed.
// 5. A repo with no commits fails instead of reviewing what is on disk.
// 6. A tracked folder replaced by a symbolic link to a folder outside the
//    repo brings the outside files into the scope, so their lines are
//    reviewed and finalize accepts findings on them.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WHOLE_REPO_MAX_BYTES, getWholeRepo } from "../src/change.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const roots: string[] = [];
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
  if (savedEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.system;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
}

function write(repo: string, path: string, content: string | Buffer): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

// A committed repo with a tracked file, an ignored file, an untracked file,
// an excluded file, a binary file and the tool's own state folder.
function repo(): string {
  const dir = tempDir("oq-whole-test-");
  roots.push(dir);
  git(dir, "init", "-q");
  write(dir, ".gitignore", "build/\n");
  write(dir, "src/app.py", "def f():\n    return 1\n");
  write(dir, "logo.bin", Buffer.from([0x89, 0x50, 0x00, 0x01, 0x0a]));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  write(dir, "build/out.js", "generated\n");
  write(dir, "notes/todo.txt", "one\ntwo\nthree");
  write(dir, "vendor/lib.js", "x\n");
  write(dir, ".openqodex/latest.json", "{}\n");
  return dir;
}

describe("getWholeRepo", () => {
  it("lists tracked and untracked files and leaves out ignored, excluded and its own state files", async () => {
    const dir = repo();
    const whole = await getWholeRepo({ repoRoot: dir, exclude: ["vendor/**"] });
    expect(whole.files.map((f) => f.path)).toEqual([".gitignore", "logo.bin", "notes/todo.txt", "src/app.py"]);
    expect(whole.files.every((f) => f.status === "added")).toBe(true);
    expect(whole.baseRef).toBe("all");
    expect(whole.diff).toBe("");
  });

  it("counts every line of every text file, the last line too, gives none to a binary file and builds no line sets", async () => {
    const dir = repo();
    const whole = await getWholeRepo({ repoRoot: dir, exclude: [] });
    expect(whole.lines.get("notes/todo.txt")).toBe(3);
    expect(whole.lines.get("src/app.py")).toBe(2);
    expect(whole.lines.has("logo.bin")).toBe(false);
    expect(whole.files.find((f) => f.path === "logo.bin")?.binary).toBe(true);
    expect(whole.coverage.size).toBe(0);
    // .gitignore, notes/todo.txt, src/app.py, vendor/lib.js
    expect(whole.stats.additions).toBe(1 + 3 + 2 + 1);
  });

  it("keeps the same id for the same content and moves it after an unstaged edit, an untracked edit or a mode change", async () => {
    const dir = repo();
    const id = async () => (await getWholeRepo({ repoRoot: dir, exclude: [] })).id;
    const first = await id();
    expect(await id()).toBe(first);
    write(dir, "src/app.py", "def f():\n    return 2\n");
    const afterTracked = await id();
    expect(afterTracked).not.toBe(first);
    write(dir, "notes/todo.txt", "one\ntwo\nfour");
    const afterUntracked = await id();
    expect(afterUntracked).not.toBe(afterTracked);
    chmodSync(join(dir, "src/app.py"), 0o755);
    expect(await id()).not.toBe(afterUntracked);
  });

  it("lists a file over the 5 MB cap as not reviewed instead of reading it into the scope", async () => {
    const dir = repo();
    write(dir, "dump.sql", Buffer.alloc(WHOLE_REPO_MAX_BYTES + 1, 0x61));
    const whole = await getWholeRepo({ repoRoot: dir, exclude: [] });
    expect(whole.notReviewed).toEqual(["dump.sql"]);
    expect(whole.files.some((f) => f.path === "dump.sql")).toBe(false);
  });

  it("never reads a file through a folder that is a symbolic link to outside the repo", async () => {
    const dir = repo();
    const outside = tempDir("oq-whole-outside-");
    roots.push(outside);
    writeFileSync(join(outside, "app.py"), "secret = 1\n");
    rmSync(join(dir, "src"), { recursive: true });
    symlinkSync(outside, join(dir, "src"));
    const whole = await getWholeRepo({ repoRoot: dir, exclude: [] });
    expect(whole.files.some((f) => f.path.startsWith("src"))).toBe(false);
    expect(whole.lines.has("src/app.py")).toBe(false);
  });

  it("reviews what is on disk in a repository with no commits", async () => {
    const dir = tempDir("oq-whole-test-");
    roots.push(dir);
    git(dir, "init", "-q");
    write(dir, "a.py", "x = 1\n");
    const whole = await getWholeRepo({ repoRoot: dir, exclude: [] });
    expect(whole.files.map((f) => f.path)).toEqual(["a.py"]);
    expect(whole.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
