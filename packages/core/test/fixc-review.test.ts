// Fixes from the Fix C diff review.
//
// Ways it could fail, written before the code:
//  1. An old-line read of a pair with two sections (a type change: a
//     deletion then an addition) searches past the deletion section and
//     returns no row, so valid removed-line evidence is rejected.
//  2. A spilled patch that cannot be removed stops the cleanup, and the
//     patches after it stay on disk.
import { chmodSync, existsSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { indexedLines } from "../src/diff-index.js";
import { DiffStore, cleanupDiffs } from "../src/diff-store.js";
import type { DiffEntry } from "../src/types.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const typeChange = (() => {
  const removed = Array.from({ length: 60 }, (_, i) => `-old line ${i + 1}`).join("\n");
  const added = Array.from({ length: 3 }, (_, i) => `+new line ${i + 1}`).join("\n");
  return [
    "diff --git a/link b/link",
    "deleted file mode 100644",
    "--- a/link",
    "+++ /dev/null",
    "@@ -1,60 +0,0 @@",
    removed,
    "diff --git a/link b/link",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/link",
    "@@ -0,0 +1,3 @@",
    added,
    "",
  ].join("\n");
})();

it("1. an old line inside the deletion section of a type change is found", () => {
  const entry: DiffEntry = { path: "link", text: typeChange };
  const rows = [...indexedLines(entry, { start: 50, end: 50, side: "old" })];
  expect(rows.map((r) => [r.old, r.mark, r.source.read(0, r.source.bytes).toString()])).toEqual([[50, "-", "old line 50"]]);
  const fresh = [...indexedLines(entry, { start: 2, end: 2 })];
  expect(fresh.map((r) => [r.line, r.mark])).toEqual([[2, "+"]]);
});

it("2. a patch that cannot be removed does not strand the patches after it", () => {
  const locked = new DiffStore("locked", tempDir("oq-locked-"));
  const free = new DiffStore("free", tempDir("oq-free-"));
  const big = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+${"x".repeat(6 * 1024 * 1024)}\n`;
  locked.push("a.ts", Buffer.from(big));
  free.push("b.ts", Buffer.from(big));
  const diffs = [...locked.finish(), ...free.finish()];
  expect(diffs.every((d) => d.file && existsSync(d.file))).toBe(true);
  const lockedDir = diffs[0]!.file!.replace(/\/[^/]+$/, "");
  chmodSync(lockedDir, 0o555);
  try {
    expect(() => cleanupDiffs({ diffs })).toThrow();
    expect(existsSync(diffs[0]!.file!)).toBe(true);
    expect(existsSync(diffs[1]!.file!)).toBe(false);
  } finally {
    chmodSync(lockedDir, 0o755);
    cleanupDiffs({ diffs });
  }
  expect(existsSync(diffs[0]!.file!)).toBe(false);
});
