// Ways the diff parser could fail:
// 1. A C-quoted header path (non-ASCII, quote, backslash) is kept with its
//    quotes and escapes, so the path names no real file.
// 2. An unquoted path is altered.
// 3. An added source line that starts with "++" is read as a "+++" file
//    header, sending later coverage to a path built from source text.
// 4. A deleted file gets coverage.
// 5. In a zero-context diff, deleted lines advance the new-side counter, so
//    the wrong lines count as changed.
// 6. A second hunk in the same file keeps the first hunk's counter.
// 7. A file name ending in a space loses the space (git ends such a header
//    path with a tab).
import { describe, expect, it } from "vitest";
import { parseDiffCoverage, unquoteDiffPath } from "./diff.js";

// `"src/caf\303\251 menu.ts"` as git prints it, and the path it means.
const QUOTED = 'src/caf\\303\\251 menu.ts"';
const PATH = "src/café menu.ts";
const DIFF =
  `diff --git "a/${QUOTED} "b/${QUOTED}\n` +
  `--- "a/${QUOTED}\n` +
  `+++ "b/${QUOTED}\n` +
  "@@ -1,2 +1,3 @@\n a\n+b\n c\n";

describe("unquoteDiffPath", () => {
  it("decodes octal UTF-8 bytes and C escapes", () => {
    expect(unquoteDiffPath('"b/caf\\303\\251.ts"')).toBe("b/café.ts");
    expect(unquoteDiffPath('"a/say \\"hi\\".md"')).toBe('a/say "hi".md');
    expect(unquoteDiffPath('"a/tab\\there.md"')).toBe("a/tab\there.md");
  });
});

describe("parseDiffCoverage", () => {
  it("anchors coverage on the decoded path", () => {
    expect([...parseDiffCoverage(DIFF).keys()]).toEqual([PATH]);
    expect(Array.from(parseDiffCoverage(DIFF).get(PATH) ?? [])).toEqual(Array.from([1, 2, 3]));
  });

  it("reads an added '++ x' line as content, not as a file header", () => {
    const diff =
      "diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n" +
      "@@ -1,1 +1,3 @@\n a\n+++ added comment\n+b\n";
    const coverage = parseDiffCoverage(diff);
    expect([...coverage.keys()]).toEqual(["q.sql"]);
    expect(Array.from(coverage.get("q.sql") ?? [])).toEqual(Array.from([1, 2, 3]));
  });

  it("gives a deleted file no coverage", () => {
    const diff =
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n" +
      "@@ -1,2 +0,0 @@\n-a\n-b\n";
    expect(parseDiffCoverage(diff).get("gone.ts")).toBeUndefined();
    expect(parseDiffCoverage(diff).size).toBe(0);
  });

  it("counts only added lines in a zero-context diff, across hunks", () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n" +
      "@@ -2 +2 @@\n-old\n+new\n" +
      "@@ -10,2 +9,0 @@\n-x\n-y\n" +
      "@@ -20,0 +20,2 @@\n+p\n+q\n" +
      "\\ No newline at end of file\n";
    expect(Array.from(parseDiffCoverage(diff).get("a.ts") ?? [])).toEqual(Array.from([2, 20, 21]));
  });

  it("keeps a trailing space in a file name", () => {
    // Real git output for a file named "sp " (git adds a tab after the path).
    const diff = "diff --git a/sp  b/sp \nindex 7898192..422c2b7 100644\n--- a/sp \t\n+++ b/sp \t\n@@ -1,0 +2 @@ a\n+b\n";
    expect([...parseDiffCoverage(diff).keys()]).toEqual(["sp "]);
    expect(Array.from(parseDiffCoverage(diff).get("sp ") ?? [])).toEqual(Array.from([2]));
  });
});
