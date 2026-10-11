// Ways the glob matcher could fail:
// 1. "*" crosses a slash, so "vendor/*" excludes nested folders it should not.
// 2. "**" stops at a slash.
// 3. A pattern matches a prefix or a suffix instead of the whole path.
// 4. A regex metacharacter in the pattern throws or matches something else.
// 5. "?" matches a slash or more than one character.
// 6. "**" stops at a newline in a file name, or the end anchor matches
//    before a final newline.
// 7. A pattern with many stars, written by the repository, backtracks
//    against a long path and holds the review for minutes or hours.
// 8. A pattern too long to match in bounded time is matched anyway.
import { describe, expect, it } from "vitest";
import { MAX_GLOB, matchesGlob } from "./glob.js";

describe("matchesGlob", () => {
  it("stops * at a path separator and lets ** cross it", () => {
    expect(matchesGlob("release/1.4", "release/*")).toBe(true);
    expect(matchesGlob("release/1.4/hotfix", "release/*")).toBe(false);
    expect(matchesGlob("release/1.4/hotfix", "release/**")).toBe(true);
    expect(matchesGlob("master", "release/*")).toBe(false);
  });

  it("anchors at both ends", () => {
    expect(matchesGlob("release/1.4", "release")).toBe(false);
    expect(matchesGlob("src/vendor/a.js", "vendor/**")).toBe(false);
  });

  it("matches a prefix family and a whole linter in rule tokens", () => {
    expect(matchesGlob("lens:react-state-set-in-render", "lens:react-*")).toBe(true);
    expect(matchesGlob("lens:async-floating-promise", "lens:react-*")).toBe(false);
    expect(matchesGlob("semgrep:javascript.lang.security.audit.sql-injection", "semgrep:*")).toBe(true);
    expect(matchesGlob("gitleaks:generic-api-key", "semgrep:*")).toBe(false);
  });

  it("treats regex metacharacters literally and never throws", () => {
    expect(() => matchesGlob("x", "release/[v1")).not.toThrow();
    expect(matchesGlob("x", "release/[v1")).toBe(false);
    expect(matchesGlob("release/[v1", "release/[v1")).toBe(true);
    expect(matchesGlob("aXmin.js", "a.min.js")).toBe(false);
  });

  it("matches one non-slash character with ?", () => {
    expect(matchesGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("a/.ts", "a?.ts")).toBe(false);
    expect(matchesGlob("a12.ts", "a?.ts")).toBe(false);
  });

  it("crosses a newline with ** and anchors at the true end", () => {
    expect(matchesGlob("vendor/a\nb.js", "vendor/**")).toBe(true);
    expect(matchesGlob("a.js\n", "a.js")).toBe(false);
    expect(matchesGlob("a.js\n", "*.js")).toBe(false);
  });

  it("treats a run of stars as one ** and a star next to ** as **", () => {
    expect(matchesGlob("a/b/c.ts", "a/***")).toBe(true);
    expect(matchesGlob("a/b/c.ts", "a/****.ts")).toBe(true);
    expect(matchesGlob("a/b/c.ts", "a/*/*")).toBe(true);
    expect(matchesGlob("a/b/c.ts", "a/*")).toBe(false);
    expect(matchesGlob("", "**")).toBe(true);
    expect(matchesGlob("", "*")).toBe(true);
    expect(matchesGlob("", "?")).toBe(false);
  });

  it("matches a hostile pattern against a long path in bounded time", () => {
    // A backtracking matcher takes longer than the test timeout on any one
    // of these; the linear one takes milliseconds for all of them.
    const path = "a".repeat(4096);
    const started = performance.now();
    expect(matchesGlob(path, `${"*a".repeat(200)}b`)).toBe(false);
    expect(matchesGlob(path, `${"**a".repeat(200)}b`)).toBe(false);
    expect(matchesGlob(`${"a/".repeat(2048)}x`, `${"**/".repeat(300)}y`)).toBe(false);
    expect(matchesGlob(path, `${"*a".repeat(200)}*`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("matches nothing with a pattern over the length cap", () => {
    const glob = `${"x".repeat(MAX_GLOB)}*`;
    expect(matchesGlob(`${"x".repeat(MAX_GLOB)}y`, glob)).toBe(false);
    expect(matchesGlob(`${"x".repeat(MAX_GLOB - 1)}y`, glob.slice(1))).toBe(true);
  });
});
