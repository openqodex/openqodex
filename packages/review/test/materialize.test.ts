// The server review's snapshot: only the admitted regular files of the head
// commit, read from the clone's objects (never a checkout of the clone), and
// the one scope-checking way base versions are read from the clone. That the
// snapshot holds no refused file and no link, and records the link, is the
// decisive fixture's to show (scoped-review.test.ts); these cover the rest.
//
// Ways it could fail, written before the code:
//  1. An executable loses its mode, or a file's bytes differ from the
//     commit's: a binary file, a file with no final line break, a file a
//     checkout would convert (eol=crlf), a file whose smudge filter is
//     configured in the clone (and the filter runs).
//  2. The snapshot holds a .git entry (a commit may carry one, written by
//     hand), or the clone is written: .git gains a file or a file there
//     changes its bytes, or a work tree is registered.
//  3. The snapshot's tree hash differs from the hash the laptop's work tree
//     snapshot of the same commit gives for the same admitted files.
//  4. A file object missing from a partial clone is fetched, or ends as a
//     git error rather than its own reason naming the fetch to add; the
//     half-made folder is left in the work folder.
//  5. A base version outside the scopes is read through the base reader,
//     an admitted one is not, or a refused read is not recorded.
//  6. A replacement ref in the clone (refs/replace) swaps what is read for a
//     commit: the snapshot, the scoped change or a base version holds the
//     replacement's files instead of the commit's own.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getAdmittedTreeChange } from "@openqodex/core";
import { addTargetCheckout, removeCheckout } from "../../cli/src/checkout.js";
import { materialize, scopedBaseReader } from "../src/materialize.js";
import { admitted } from "../src/scopes.js";
import { hashSnapshot, snapshotFiles } from "../src/snapshot.js";
import { EXCLUDE, SCOPES, commit, decisiveFixture, git, write } from "./scope-fixture.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
afterEach(() => vi.unstubAllEnvs());

const admit = admitted(SCOPES, EXCLUDE);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Every file under `dir` and the sha256 of its bytes.
function contents(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${join(e.parentPath, e.name).slice(dir.length + 1)} ${sha256(readFileSync(join(e.parentPath, e.name)))}`)
    .sort();
}

describe("the materialised snapshot", () => {
  it("1. keeps the executable mode and the commit's exact bytes, and runs no filter", async () => {
    const dir = tempDir("oq-mat-bytes-");
    git(dir, "init", "-q", "-b", "main");
    const binary = Buffer.from([0, 1, 2, 255, 13, 10, 0]);
    write(dir, "s/bin.dat", binary);
    write(dir, "s/no-eol.txt", "no final line break");
    write(dir, "s/crlf.txt", "one\ntwo\n");
    write(dir, "s/smudged.txt", "plain\n");
    write(dir, "s/tool.sh", "#!/bin/sh\n");
    write(dir, ".gitattributes", "s/crlf.txt text eol=crlf\ns/smudged.txt filter=evil\n");
    git(dir, "add", "-A");
    git(dir, "update-index", "--chmod=+x", "s/tool.sh");
    git(dir, "commit", "-qm", "bytes");
    const marker = join(tempDir("oq-mat-marker-"), "ran");
    git(dir, "config", "filter.evil.smudge", `sh -c 'touch ${marker}; cat'`);
    const head = git(dir, "rev-parse", "HEAD");
    const snap = await materialize({ clonePath: dir, headSha: head, workDir: tempDir("oq-mat-work-"), admit: admitted(["s"], []) });
    for (const path of ["s/bin.dat", "s/no-eol.txt", "s/crlf.txt", "s/smudged.txt", "s/tool.sh"]) {
      expect(readFileSync(join(snap.tree, path)).equals(execFileSync("git", ["cat-file", "blob", `${head}:${path}`], { cwd: dir })), path).toBe(true);
    }
    expect(statSync(join(snap.tree, "s/tool.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(snap.tree, "s/crlf.txt")).mode & 0o777).toBe(0o644);
    expect(snap.files.find((x) => x.path === "s/tool.sh")?.mode).toBe("100755");
    expect(existsSync(marker)).toBe(false);
  });

  it("2. holds no .git entry, refuses a commit that carries one, and writes nothing in the clone", async () => {
    const f = decisiveFixture();
    const before = contents(join(f.dir, ".git"));
    const worktrees = git(f.dir, "worktree", "list");
    const snap = await materialize({ clonePath: f.dir, headSha: f.head, workDir: tempDir("oq-mat-work-"), admit });
    expect(existsSync(join(snap.tree, ".git"))).toBe(false);
    expect(readdirSync(snap.folder)).toEqual(["tree"]);
    expect(contents(join(f.dir, ".git"))).toEqual(before);
    expect(git(f.dir, "worktree", "list")).toBe(worktrees);
    // A commit that carries a .git entry, written by hand, is refused.
    const blob = git(f.dir, "rev-parse", `${f.head}:services/api/handler.ts`);
    const api = execFileSync("git", ["mktree"], { cwd: f.dir, input: `100644 blob ${blob}\t.git\n100644 blob ${blob}\th.ts\n`, encoding: "utf8" }).trim();
    const services = execFileSync("git", ["mktree"], { cwd: f.dir, input: `040000 tree ${api}\tapi\n`, encoding: "utf8" }).trim();
    const root = execFileSync("git", ["mktree"], { cwd: f.dir, input: `040000 tree ${services}\tservices\n`, encoding: "utf8" }).trim();
    const bad = git(f.dir, "commit-tree", root, "-m", "bad");
    const work = tempDir("oq-mat-work-");
    await expect(materialize({ clonePath: f.dir, headSha: bad, workDir: work, admit })).rejects.toThrow(/a path no checkout may write/);
    expect(readdirSync(work)).toEqual([]);
  });

  it("3. its tree hash is the one the laptop's work tree snapshot gives for the same admitted files", async () => {
    vi.stubEnv("OPENQODEX_HOME", tempDir("oq-mat-home-"));
    const f = decisiveFixture();
    // No scope and no link: the snapshots hold the same files.
    const plain = tempDir("oq-mat-plain-");
    git(plain, "init", "-q", "-b", "main");
    write(plain, "a.ts", "export const a = 1;\n");
    write(plain, "deep/b/c.py", "print('c')\n");
    write(plain, "run.sh", "#!/bin/sh\n");
    git(plain, "add", "-A");
    git(plain, "update-index", "--chmod=+x", "run.sh");
    git(plain, "commit", "-qm", "plain");
    const plainHead = git(plain, "rev-parse", "HEAD");
    for (const [dir, head, scope] of [[plain, plainHead, admitted(undefined, [])], [f.dir, f.head, admit]] as const) {
      const laptop = await addTargetCheckout(dir, head, "hash-");
      try {
        const snap = await materialize({ clonePath: dir, headSha: head, workDir: tempDir("oq-mat-work-"), admit: scope });
        // The laptop's snapshot holds every file, links written as plain
        // files: the same admitted files are what is left without the others.
        for (const path of snapshotFiles(laptop.tree)) if (!snap.files.some((x) => x.path === path)) rmSync(join(laptop.tree, path));
        expect(snapshotFiles(laptop.tree)).toEqual(snapshotFiles(snap.tree));
        expect(hashSnapshot(snap.tree)).toBe(hashSnapshot(laptop.tree));
      } finally {
        await removeCheckout(dir, laptop.folder);
      }
    }
  });

  it("4. a file missing from a partial clone is its own reason naming the fetch; nothing is fetched or left behind", async () => {
    const f = decisiveFixture();
    git(f.dir, "config", "uploadpack.allowFilter", "true");
    git(f.dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = join(tempDir("oq-mat-partial-"), "clone");
    git(f.dir, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${f.dir}`, clone);
    const blob = git(clone, "rev-parse", `${f.head}:services/api/handler.ts`);
    const work = tempDir("oq-mat-work-");
    await expect(materialize({ clonePath: clone, headSha: f.head, workDir: work, admit })).rejects.toThrow(
      /^missing objects: 5 files of the head commit [0-9a-f]{12} are not in the clone \(a partial clone made with a blob filter\), and openqodex fetches nothing; .*git checkout --detach [0-9a-f]{40}.*services\/api\/db\/q\.sql/,
    );
    expect(readdirSync(work)).toEqual([]);
    // Still not in the clone: nothing was fetched.
    expect(() => execFileSync("git", ["cat-file", "-e", blob], { cwd: clone, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: "ignore" })).toThrow();
  });
});

describe("the base reader", () => {
  it("5. reads admitted base versions from the clone and refuses, and records, every other path", async () => {
    const f = decisiveFixture();
    const refused = new Set<string>();
    const read = scopedBaseReader({ clonePath: f.dir, baseSha: f.base, admit, refused });
    expect((await read("services/api/handler.ts", 1 << 20))?.toString("utf8")).toContain('from "../../legacy/util"');
    for (const path of ["legacy/util.ts", "canary.txt", "services/api/generated/client.sql", "../canary.txt", "services/api/../../canary.txt"]) {
      expect(await read(path, 1 << 20), path).toBeNull();
    }
    expect([...refused].sort()).toEqual(["../canary.txt", "canary.txt", "legacy/util.ts", "services/api/../../canary.txt", "services/api/generated/client.sql"]);
    // Within the cap only, as the graph asks for it.
    expect(await read("services/api/handler.ts", 10)).toBeNull();
  });
});

describe("replacement refs", () => {
  it("6. swap none of the files read for a commit: the snapshot, the scoped change and a base version are the commit's own", async () => {
    const dir = tempDir("oq-mat-replace-");
    git(dir, "init", "-q", "-b", "main");
    write(dir, "s/a.ts", "base\n");
    const base = commit(dir, "base");
    write(dir, "s/a.ts", "head\n");
    const head = commit(dir, "head");
    // Two other commits, and refs that put them in the place of both.
    git(dir, "checkout", "-q", "--orphan", "fake");
    write(dir, "s/a.ts", "REPLACED-BASE-CANARY\n");
    const fakeBase = commit(dir, "fake base");
    write(dir, "s/a.ts", "REPLACED-HEAD-CANARY\n");
    const fakeHead = commit(dir, "fake head");
    git(dir, "replace", base, fakeBase);
    git(dir, "replace", head, fakeHead);
    const all = admitted(undefined, []);
    const snap = await materialize({ clonePath: dir, headSha: head, workDir: tempDir("oq-mat-replace-work-"), admit: all });
    expect(readFileSync(join(snap.tree, "s/a.ts"), "utf8")).toBe("head\n");
    rmSync(snap.folder, { recursive: true, force: true });
    expect((await scopedBaseReader({ clonePath: dir, baseSha: base, admit: all })("s/a.ts", 1 << 20))?.toString("utf8")).toBe("base\n");
    const { change } = await getAdmittedTreeChange({ repoRoot: dir, baseRef: "main", baseSha: base, headSha: head, exclude: [], admit: all });
    expect(change.diff).toContain("-base\n+head\n");
    expect(change.diff).not.toContain("REPLACED");
  });
});
