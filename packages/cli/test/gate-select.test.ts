// The fast gate's choice of unit tests (scripts/gate-select.mjs).
//
// Ways it could fail, written before the code:
//  1. A change to a package leaves out a package that depends on it, directly
//     or through another one, so a break there passes the fast gate.
//  2. A test that reads another package's files by path (core's tests run
//     packages/cli/dist/bin.js) is left out when that package changes.
//  3. A path outside the packages (root config, the lockfile, tests/,
//     benchmark/), or a file in packages/ that belongs to no package, runs
//     only some tests instead of all of them.
//  4. An empty change, or one that reaches every package, runs a subset.
//  5. A renamed file counts only under its new name, or a staged, unstaged or
//     untracked file is missed; a missing origin/main is read as no change.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { changedPaths, dependencyMap, select } from "../../../scripts/gate-select.mjs";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// base <- mid <- top, and other alone; side's tests read mid's files.
const map = {
  base: { uses: [], readBy: [] },
  mid: { uses: ["base"], readBy: ["packages/side"] },
  top: { uses: ["mid"], readBy: [] },
  other: { uses: [], readBy: [] },
  side: { uses: [], readBy: [] },
};

describe("the packages a change selects", () => {
  it("a package brings every package that depends on it, directly or not (failure 1)", () => {
    expect(select(["packages/base/src/a.ts"], map)).toMatchObject({ all: false, filters: ["packages/base", "packages/mid", "packages/side", "packages/top"] });
    expect(select(["packages/top/src/a.ts"], map)).toMatchObject({ all: false, filters: ["packages/top"] });
  });

  it("a package brings the tests that read its files, but not their dependents (failure 2)", () => {
    const r = select(["packages/mid/test/x.test.ts"], map);
    expect(r).toMatchObject({ all: false, filters: ["packages/mid", "packages/side", "packages/top"] });
    expect(r.reason).toContain("tests that read them: packages/side");
  });

  it("a path outside the packages, or in no package, runs every test and says which path (failure 3)", () => {
    for (const p of ["package.json", "pnpm-lock.yaml", "tests/temp-dirs.mjs", "benchmark/run.mjs", "packages/README.md", "packages/gone/src/a.ts"]) {
      const r = select(["packages/top/src/a.ts", p], map);
      expect(r.all, p).toBe(true);
      expect(r.reason).toContain(p);
    }
  });

  it("an empty change, or one that reaches every package, runs every test (failure 4)", () => {
    expect(select([], map).all).toBe(true);
    expect(select(["packages/base/a.ts", "packages/other/a.ts", "packages/side/a.ts"], map)).toMatchObject({ all: true });
  });

  it("in this repository a core change runs everything, and a cli change runs core's and review's tests too (failures 1, 2)", () => {
    const real = dependencyMap(root);
    // Read from packages/*/package.json and the test files by hand.
    expect(real.scanners.uses).toEqual(["core"]);
    expect(real.review.uses.sort()).toEqual(["core", "graph", "scanners"]);
    expect(real.cli.uses.sort()).toEqual(["core", "graph", "mcp", "review", "scanners"]);
    expect(select(["packages/core/src/types.ts"], real).all).toBe(true);
    // packages/core/test/observations.test.ts runs packages/cli/dist/bin.js;
    // packages/review/test/materialize.test.ts imports packages/cli/src;
    // benchmark/test imports packages/review/dist.
    expect(select(["packages/cli/src/bin.ts"], real)).toMatchObject({ all: false, filters: ["benchmark/test", "packages/cli", "packages/core", "packages/review"] });
  });
});

describe("the changed paths of a checkout", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const repo = () => {
    const dir = tempDir("oq-gate-select-");
    sh(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "packages/a"), { recursive: true });
    for (const f of ["packages/a/old.ts", "packages/a/staged.ts", "packages/a/edited.ts"]) writeFileSync(join(dir, f), `${f}\n`);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "base");
    return dir;
  };

  it("lists both names of a rename and every staged, unstaged and untracked file (failure 5)", () => {
    const dir = repo();
    sh(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    sh(dir, "mv", "packages/a/old.ts", "packages/a/new.ts");
    sh(dir, "commit", "-qm", "rename");
    writeFileSync(join(dir, "packages/a/staged.ts"), "changed\n");
    sh(dir, "add", "packages/a/staged.ts");
    writeFileSync(join(dir, "packages/a/edited.ts"), "changed\n");
    writeFileSync(join(dir, "packages/a/untracked.ts"), "new\n");
    expect(changedPaths(dir)).toEqual({ paths: ["packages/a/edited.ts", "packages/a/new.ts", "packages/a/old.ts", "packages/a/staged.ts", "packages/a/untracked.ts"], reason: null });
  });

  it("a missing origin/main gives no list and says so, so the whole suite runs (failure 5)", () => {
    const r = changedPaths(repo());
    expect(r.paths).toBeNull();
    expect(r.reason).toContain("origin/main is missing");
  });
});
