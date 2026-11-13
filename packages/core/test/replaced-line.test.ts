// Ways the replaced-line lens could fail, written before the code:
// 1. The replacement trigger is malformed but silently accepted.
// 2. C, C++, Rust or another source language never selects the lens.
// 3. Pure additions or deletions select it because file headers look changed.
// 4. Removed and added lines in different hunks, files or context blocks pair up.
// 5. A replacement in prose pairs with a source file's pure addition.
// 6. Quoted paths, header-like source text or a no-newline marker hide a replacement.
// 7. The shipped frontmatter does not parse, or the reviewer brief omits the lens.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewerBrief } from "../src/brief.js";
import { defaultLensDir, loadLensCatalog, parseLens, selectLenses, selectLensesForDiff } from "../src/lenses.js";
import { makeChange, makeConfig, makeScan } from "../src/test-fixtures.js";

const NAME = "replaced-line-drops-behavior";
const EXTENSIONS = ["c", "cc", "cpp", "cxx", "C", "h", "hh", "hpp", "hxx", "rs", "cs", "php", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "pyi", "go", "rb", "java", "kt", "kts", "swift", "m", "mm", "scala", "sc", "sh", "bash", "zsh", "sql", "lua", "pl", "pm", "r", "R", "dart", "ex", "exs", "erl", "hrl", "hs", "clj", "cljs", "cljc", "vue", "svelte"];
const diff = (path: string, payload = "-return ptr ? *ptr : 0;\n+return *ptr;") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${payload}\n`;
const selected = (text: string, files: string[]) => selectLensesForDiff({ diff: text, files, catalog: loadLensCatalog() }).map((l) => l.name);

describe("the replaced-line lens", () => {
  it("rejects a replacement trigger that is not a boolean", () => {
    expect(() => parseLens("---\nname: x\ndescription: x\ntriggers:\n  replaced_lines: yes\n---\nbody")).toThrow(/replaced_lines/);
  });

  it.each(EXTENSIONS)("does not miss replacements in .%s source files at either depth", (extension) => {
    for (const path of [`value.${extension}`, `src/value.${extension}`]) {
      expect(selected(diff(path), [path]), path).toContain(NAME);
    }
  });

  it.each(["+return *ptr;", "-return ptr ? *ptr : 0;"])("does not mistake a one-sided hunk for a replacement: %s", (payload) => {
    expect(selected(diff("value.c", payload), ["value.c"])).not.toContain(NAME);
  });

  it.each([
    "-old();\n@@ -10,0 +10 @@\n+new();",
    "-old();\n unchanged();\n+new();",
    "-old();\ndiff --git a/other.c b/other.c\n--- a/other.c\n+++ b/other.c\n@@ -0,0 +1 @@\n+new();",
  ])("does not pair lines across a boundary: %s", (payload) => {
    expect(selected(diff("value.c", payload), ["value.c", "other.c"])).not.toContain(NAME);
  });

  it("does not borrow a prose replacement for a source file with only additions", () => {
    expect(selected(diff("README.md") + diff("value.c", "+return *ptr;"), ["README.md", "value.c"])).not.toContain(NAME);
  });

  it("does not select a replacement outside the supplied changed files", () => {
    expect(selected(diff("value.c"), ["other.c"])).not.toContain(NAME);
  });

  it("keeps quoted paths, header-like payload and no-newline markers inside their hunk", () => {
    const text = 'diff --git "a/caf\\303\\251.c" "b/caf\\303\\251.c"\n--- "a/caf\\303\\251.c"\n+++ "b/caf\\303\\251.c"\n@@ -1 +1 @@\n--- old;\n\\ No newline at end of file\n+++ new;\n';
    expect(selected(text, ["café.c"])).toContain(NAME);
  });

  it("parses the shipped frontmatter with a replacement trigger and no content regex", () => {
    const lens = parseLens(readFileSync(join(defaultLensDir(), `${NAME}.md`), "utf8"));
    expect(lens.triggers.replacedLines).toBe(true);
    expect(lens.triggers.hunkRegex).toBeUndefined();
    expect(lens.confidenceFloor).toBe(0.7);
  });

  it("does not omit the selected lens from the reviewer brief for a C replacement", () => {
    const change = makeChange({ diff: diff("value.c"), files: [{ path: "value.c", status: "modified", oldPath: null, binary: false }], changedPaths: ["value.c"] });
    const out = buildReviewerBrief({ change, scan: makeScan({ candidates: [] }), lenses: selectLenses(change), config: makeConfig(), secrets: [] });
    expect(out.text).toContain(`### ${NAME}`);
    expect(out.text).toContain("These include conditions, calls, resource releases and error handling.");
  });
});
