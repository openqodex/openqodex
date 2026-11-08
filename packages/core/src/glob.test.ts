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
// 9. The heaviest config the config's byte cap admits, 1,000 globs at the
//    length cap, does not finish against a change of 100 files.
import { describe, expect, it } from "vitest";
import { CONFIG_MAX_BYTES, parseConfig } from "./config.js";
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
    // This guards against the old backtracking matcher, which ran for
    // minutes on any one of these; the linear one takes milliseconds for all
    // four. The 2 s limit sits far above that so a slow or busy machine never
    // fails it: it catches the old exponential behaviour, not noise.
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

  // The shape the Action accepts at its largest: a config of 1,000 globs at
  // the length cap, about all that fits under the config's byte cap, against
  // a change of 100 files. Every glob runs against every path, since none
  // matches. It sets no time limit of its own; it shows the work finishes.
  // The long timeout only ends a run that hangs. One more path has 600
  // characters the star globs match and a suffix they do not, so the old
  // backtracking matcher hangs on it; the ordinary paths fail it fast.
  it("finishes 1,000 globs at the length cap against 100 paths", () => {
    const shapes = ["*a".repeat(MAX_GLOB / 2), `${"**a".repeat(341)}a`, "?".repeat(MAX_GLOB), `${"a/".repeat(MAX_GLOB / 2 - 1)}**`];
    const lines = Array.from({ length: 1000 }, (_, i) => `      - "${shapes[i % shapes.length]}"\n`);
    const source = `review:\n  paths:\n    exclude:\n${lines.join("")}`;
    expect(source.length).toBeLessThan(CONFIG_MAX_BYTES);
    const { exclude } = parseConfig(source).config;
    expect(exclude).toHaveLength(1000);
    expect(exclude.every((g) => g.length === MAX_GLOB)).toBe(true);
    const paths = Array.from({ length: 100 }, (_, i) => `packages/module-${i}/src/components/widget-${i}/index.test.tsx`);
    paths.push(`${"a".repeat(600)}.ts`);
    expect(paths.filter((path) => exclude.some((g) => matchesGlob(path, g)))).toEqual([]);
  }, 300_000);
});
