// 1. Concurrent cleanup removes the diff folder before exclusive creation.
// 2. Repeated file sections put all headers ahead of the first section's rows.
// 3. Display readers materialise an oversized page instead of skipping it.
import fs, { readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { DiffStore } from "../src/diff-store.js";
import { diffText } from "../src/diff.js";
import { hunkRows } from "../src/brief-staged.js";
import { buildDisplay } from "../src/render/display.js";
import type { Change } from "../src/types.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
function change(file: string): Change {
  return { repoRoot: ".", baseRef: "HEAD", baseSha: "a".repeat(40), id: "b".repeat(64), shortId: "b".repeat(12), files: [{ path: "a.ts", oldPath: null, status: "modified", binary: false }], changedPaths: ["a.ts"], coverage: new Map(), deletionPoints: new Map(), diff: "", diffs: [{ path: "a.ts", file }], notReviewed: [], stats: { files: 1, additions: 1, deletions: 1 } };
}
it("1. recreates a shared diff folder removed between mkdir and create", () => {
  const root = tempDir("oq-round3-race-");
  const store = new DiffStore("race", root);
  const mkdir = fs.mkdirSync;
  const spy = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(((...args: Parameters<typeof mkdir>) => {
    const result = mkdir(...args);
    rmdirSync(join(root, "race", "diff"));
    return result;
  }) as typeof mkdir);
  syncBuiltinESMExports();
  try {
    store.push("a.ts", Buffer.alloc(5 * 1024 * 1024 + 1, 120));
    const entry = store.finish()[0]!;
    expect(readFileSync(entry.file!).length).toBe(5 * 1024 * 1024 + 1);
  } finally { spy.mockRestore(); syncBuiltinESMExports(); store.dispose(); }
});
it("2. preserves each type-change section header before its own hunk", () => {
  const file = join(tempDir("oq-round3-sections-"), "retained.patch");
  const first = "diff --git a/a.ts b/a.ts\ndeleted file mode 120000\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n";
  const second = "diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+code\n";
  writeFileSync(file, first + second);
  const c = change(file);
  expect(diffText(c, "a.ts")).toBe(first + second);
  const rows = [
    ...hunkRows(c, { id: "h1", path: "a.ts", start: 1, end: 1, old: [1, 1], deletion: { id: "a.ts#0", oldStart: 1, oldEnd: 1 } }),
    ...hunkRows(c, { id: "h2", path: "a.ts", start: 1, end: 1, old: null, deletion: false }),
  ].join("\n");
  expect(rows).toContain("deleted file mode 120000\n--- a/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-target");
  expect(rows).toContain("new file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+code");
});
it("3. skips an oversized display page with a note and preserves later rows", () => {
  const file = join(tempDir("oq-round3-display-"), "retained.patch");
  writeFileSync(file, `@@ -1 +1 @@\n-${"x".repeat(600 * 1024)}\n+fresh\n@@ -10 +10 @@\n-old\n+later\n`);
  const display = buildDisplay({ change: change(file), secrets: [] });
  expect(display.files[0]!.note).toMatch(/skipped.*byte budget/i);
  expect(display.files[0]!.hunks.flatMap((h) => h.rows).map((r) => r.text)).toContain("later");
  expect(display.files[0]!.hunks.flatMap((h) => h.rows).some((r) => r.text.startsWith("xxx"))).toBe(false);
});

it("2b. keeps the new section header when selecting a later page or hunk", () => {
  const file = join(tempDir("oq-round3-section-tail-"), "retained.patch");
  writeFileSync(file, `diff --git a/a.ts b/a.ts\ndeleted file mode 120000\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\ndiff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+${"x".repeat(70 * 1024)}\n+tail\n@@ -0,0 +10 @@\n+later\n`);
  const c = change(file);
  for (const n of [2, 10]) {
    const rows = hunkRows(c, { id: "h1", path: "a.ts", start: n, end: n, old: null, deletion: false }).join("\n");
    expect(rows).toContain("new file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@");
    expect(rows).not.toContain("deleted file mode");
    expect(rows).toContain(n === 2 ? "+tail" : "+later");
  }
});
