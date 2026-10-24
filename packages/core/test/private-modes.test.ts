// The modes of what OpenQodex writes. A file that can hold review content,
// a receipt or config is created 0600, and a folder made for one 0700, the
// mode given when it is created (open and mkdir), never by a chmod after.
//
// Ways it could fail, written before the code:
//  1. Such a file is created readable by other users, or a folder made for
//     one is (the repo's .openqodex/ folders were made 0755).
//  2. 0600 content written over an existing file other users can read takes
//     that file's wider mode: the guard created the new file 0600, then set
//     it to the old file's mode (commit 60f8286).
//  3. A file's mode is set by a chmod after it was created, so for a moment
//     it is wider than meant.
//  4. An existing file or folder that other users can read is reused for
//     such content without a word.
//  5. A file the developer owns, which init edits in place and keeps as it
//     is (keepMode), loses its own mode.
//  6. A Windows drive or UNC share becomes a folder name, or mixed slashes
//     leave two folder names joined together.
//  7. The notice of a wider mode prints a relative path climbing out with
//     `../` when the repository is reached through a linked folder, since
//     the guard's own path has its links followed but the root it is shown
//     relative to does not (issue 59).
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Guard, split } from "../src/guarded-fs.js";
import { writeRepoFile } from "../src/repo-state.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const mode = (path: string): number => statSync(path).mode & 0o777;

function repo(): string {
  return realpathSync(tempDir("oq-modes-"));
}

function stderr(): { lines: () => string } {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => spy.mock.calls.map((c) => String(c[0])).join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("files that can hold review content, receipts or config", () => {
  it("a new report file is 0600 and each folder made for it 0700 (failure 1)", () => {
    const root = repo();
    writeRepoFile(root, ".openqodex/reviews/run/report.md", "x\n");
    writeRepoFile(root, ".openqodex/latest.json", "{}\n");
    expect(mode(join(root, ".openqodex/reviews/run/report.md"))).toBe(0o600);
    expect(mode(join(root, ".openqodex/latest.json"))).toBe(0o600);
    for (const dir of [".openqodex", ".openqodex/reviews", ".openqodex/reviews/run"]) expect(mode(join(root, dir)), dir).toBe(0o700);
  });

  it("0600 content over a file other users can read ends 0600, and the change is reported once (failures 2 and 4)", () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex"), { mode: 0o700 });
    writeFileSync(join(root, ".openqodex/latest.json"), "old\n");
    chmodSync(join(root, ".openqodex/latest.json"), 0o644);
    const err = stderr();
    writeRepoFile(root, ".openqodex/latest.json", "new\n", { mode: 0o600 });
    writeRepoFile(root, ".openqodex/latest.json", "newer\n", { mode: 0o600 });
    expect(mode(join(root, ".openqodex/latest.json"))).toBe(0o600);
    expect(readFileSync(join(root, ".openqodex/latest.json"), "utf8")).toBe("newer\n");
    expect(err.lines().match(/latest\.json could be read by other users/g)).toHaveLength(1);
  });

  it("an existing .openqodex folder other users can read is closed to 0700 and reported (failure 4)", () => {
    const root = repo();
    mkdirSync(join(root, ".openqodex"));
    chmodSync(join(root, ".openqodex"), 0o755);
    const err = stderr();
    writeRepoFile(root, ".openqodex/latest.json", "{}\n");
    expect(mode(join(root, ".openqodex"))).toBe(0o700);
    expect(err.lines()).toMatch(/\.openqodex could be read by other users \(mode 0755\); it is now 0700/);
  });

  it("a repository reached through a linked folder reports a notice path relative to the repository, not climbing out with .. (failure 7)", () => {
    const target = realpathSync(tempDir("oq-modes-target-"));
    const link = join(tempDir("oq-modes-link-"), "repo");
    symlinkSync(target, link);
    mkdirSync(join(link, ".openqodex"));
    chmodSync(join(link, ".openqodex"), 0o755);
    const err = stderr();
    writeRepoFile(link, ".openqodex/latest.json", "{}\n");
    expect(err.lines()).toMatch(/^openqodex: \.openqodex could be read by other users/m);
    expect(err.lines()).not.toContain("..");
  });

  it("the guard gives a file its mode only when it creates it, never by a chmod after (failure 3)", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "guarded-fs.ts"), "utf8");
    const start = source.indexOf("\n  write(");
    const write = source.slice(start, source.indexOf("\n  }\n", start));
    expect(write.length).toBeGreaterThan(100);
    expect(write).not.toMatch(/chmod/);
  });

  it("a file the developer owns keeps its own mode when the caller keeps it (failure 5)", () => {
    const root = repo();
    const file = join(root, "CLAUDE.md");
    writeFileSync(file, "mine\n");
    chmodSync(file, 0o644);
    new Guard({ repoRoot: root, gitFolders: [], roots: [] }).write(file, "mine\nand ours\n", { keepMode: true });
    expect(mode(file)).toBe(0o644);
  });
});

describe("Windows walk roots", () => {
  it("keeps a drive out of folder names and separates mixed slashes", () => {
    expect(split("F:\\QodexAI/repo", win32)).toEqual({ root: "F:\\", names: ["QodexAI", "repo"] });
  });

  it("keeps a UNC share out of folder names", () => {
    expect(split("\\\\server\\share\\repo", win32)).toEqual({ root: "\\\\server\\share\\", names: ["repo"] });
  });
});
