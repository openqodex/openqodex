// The shared clone helper of the trueforge and Nest end-to-end tests. A run
// killed half way through a clone must not poison the cache for every later
// run, so these tests build the broken caches by hand from a local source.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";
import { pinnedClone } from "./pinned-clone.js";

afterAll(removeTempDirs);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

describe("the pinned clone helper", () => {
  let source: string;
  let first: string;
  let second: string;
  beforeAll(() => {
    source = tempDir("oq-e2e-clone-source-");
    git(source, "init", "-q");
    writeFileSync(join(source, "a.txt"), "one\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "one");
    first = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "a.txt"), "two\n");
    git(source, "commit", "-q", "-a", "-m", "two");
    second = git(source, "rev-parse", "HEAD");
  });

  const cache = () => join(tempDir("oq-e2e-clone-cache-"), "repo");

  it("clones the pinned commit into an empty cache", () => {
    const dir = cache();
    expect(pinnedClone(dir, source, first)).toBe(dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(first);
  });

  it("reuses a cache already at the pinned commit without fetching", () => {
    const dir = cache();
    pinnedClone(dir, source, first);
    expect(pinnedClone(dir, "/nonexistent/source", first)).toBe(dir);
  });

  it("recovers from an interrupted clone: a .git folder whose HEAD has no commit", () => {
    const dir = cache();
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    expect(pinnedClone(dir, source, first)).toBe(dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(first);
  });

  it("recovers from a cache left at another commit", () => {
    const dir = cache();
    pinnedClone(dir, source, second);
    expect(pinnedClone(dir, source, first)).toBe(dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(first);
  });

  it("leaves no cache folder behind when the fetch fails, so the next run starts clean", () => {
    const dir = cache();
    expect(() => pinnedClone(dir, "/nonexistent/source", first)).toThrow();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(join(dir, "..")).filter((n) => n !== "repo")).toEqual([]);
    expect(pinnedClone(dir, source, first)).toBe(dir);
  });
});
