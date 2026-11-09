// 1. A single-pass brief loses a spilled file in either file order.
// 2. Lens triggers miss replaced lines in the last spilled file.
// 3. Indexed hunk reads retain a whole 20 MB patch or miscount a page.
// 4. Per-file lookups scan the diff array for every path.
// 5. Change reports retain a skipped-files row, and whole-repo reports mislabel it.
// 6. A staged cache serves stale rows after an entry's text changes.
// 7. Host-temp patches survive explicit library cleanup.
// 8. The brief describes cumulative budget exhaustion as an oversized file.
// 9. Lens selection materialises oversized diff pages.
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as diff from "../src/diff.js";
import { DiffStore, cleanupDiffs } from "../src/diff-store.js";
import { buildBrief, buildWholeRepoBrief } from "../src/brief.js";
import { stagedDiffCache, hunkRows } from "../src/brief-staged.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { selectLenses } from "../src/lenses.js";
import { renderHtml } from "../src/render/html.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { renderTerminal } from "../src/render/terminal.js";
import { renderReview } from "../src/render/review.js";
import type { Change, DiffEntry, Report, ScanResult } from "../src/types.js";
import { adoptTempDir, removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const scan = { candidates: [], scanners: [] } as unknown as ScanResult;
const patch = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${body}\n`;
function change(diffs: DiffEntry[]): Change {
  return { repoRoot: ".", baseRef: "HEAD", baseSha: "a".repeat(40), id: "b".repeat(64), shortId: "b".repeat(12), files: diffs.map((d) => ({ path: d.path, oldPath: null, status: "modified", binary: false })), changedPaths: diffs.map((d) => d.path), coverage: new Map(), deletionPoints: new Map(), diff: diffs.map((d) => d.text ?? "").join(""), diffs, notReviewed: [], stats: { files: diffs.length, additions: 1, deletions: 1 } };
}
function spilled(bigFirst = false): Change {
  const store = new DiffStore("regression", tempDir("oq-diffs-"));
  const entries = [["small.ts", patch("small.ts", "s".repeat(100 * 1024))], ["last.ts", patch("last.ts", "x".repeat(6 * 1024 * 1024) + "\n-trigger_last()")]];
  for (const [path, text] of bigFirst ? entries.reverse() : entries) store.push(path!, Buffer.from(text!));
  return change(store.finish());
}
const briefArgs = (c: Change) => ({ change: c, scan, config: DEFAULT_CONFIG, lenses: [], secrets: [], findingsPath: "findings.json", finalizeCommand: "finalize" });

it("1. names both files and the brief bound when either file spills first", () => {
  for (const bigFirst of [false, true]) {
    const c = spilled(bigFirst);
    try {
      const block = buildBrief(briefArgs(c)).split("## Diff\n")[1]!.split("## Finding shape")[0]!;
      expect(block).toContain("small.ts");
      expect(block).toContain("last.ts");
      expect(block).toContain("read it with your tools");
      expect(block).not.toContain("The diff has no text lines");
      expect(Buffer.byteLength(block)).toBeLessThan(205 * 1024);
    } finally { cleanupDiffs(c); }
  }
});

it("2. selects hunk-regex and replacement lenses from the last spilled file", () => {
  const c = spilled();
  const dir = tempDir("oq-lenses-");
  writeFileSync(join(dir, "last.md"), "---\nname: last\ndescription: Last replacement\ntriggers:\n  files: ['*.ts']\n  hunk_regex: trigger_last\n  replaced_lines: true\n---\nCheck the replacement.\n");
  try { expect(selectLenses(c, dir).map((l) => l.name)).toEqual(["last"]); }
  finally { cleanupDiffs(c); }
});

it("3. reads a 20 MB patch hunk by hunk with less than 50 MB peak heap growth", () => {
  const file = join(tempDir("oq-index-"), "large.patch");
  writeFileSync(file, "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n");
  const row = "x".repeat(1000);
  for (let n = 1; n <= 210; n++) appendFileSync(file, `@@ -${n * 1000},100 +${n * 1000},100 @@\n${`-old\n+${row}\n`.repeat(100)}`);
  const c = change([{ path: "large.ts", file }]);
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  let count = 0;
  expect(typeof diff.diffHunks).toBe("function");
  for (const text of diff.diffHunks(c, "large.ts")) {
    expect(text).toContain("@@");
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text)!;
    const body = text.slice(text.indexOf("\n") + 1).split("\n");
    const added = body.filter((line) => line.startsWith("+")).length;
    const removed = body.filter((line) => line.startsWith("-")).length;
    expect(Number(header[1] ?? 1)).toBe(removed);
    expect(Number(header[2] ?? 1)).toBe(added);
    count += added;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  const after = process.memoryUsage().heapUsed;
  console.log(`HEAP before=${before} after=${after} peak=${peak} growth=${peak - before} patch=${statSync(file).size}`);
  expect(count).toBe(21_000);
  expect(peak - before).toBeLessThan(50 * 1024 * 1024);
  const selected = [...diff.diffHunks(c, "large.ts", { start: 210_000, end: 210_000 })];
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatch(/^@@ -210000,\d+ \+210000,\d+ @@/);
});

it("4. resolves 50000 paths in less than 200 ms", () => {
  const c = change(Array.from({ length: 50_000 }, (_, i) => ({ path: `${i}.ts`, text: `file ${i}` })));
  const started = performance.now();
  let found = 0;
  for (let i = 0; i < 50_000; i++) if (diff.diffText(c, `${i}.ts`) === `file ${i}`) found++;
  const elapsed = performance.now() - started;
  console.log(`LOOKUPS count=${found} milliseconds=${elapsed.toFixed(2)}`);
  expect(found).toBe(50_000);
  expect(elapsed).toBeLessThan(200);
});

it("5. omits skipped-file rows for changes and accurately names whole-repo skips", () => {
  const report: Report = { version: 1, kind: "review", change_id: "b".repeat(64), base: { ref: "HEAD", sha: "a".repeat(40) }, generated_at: "2026-01-01T00:00:00Z", verdict: "passed", block_on_severity: null, summary: null, findings: [], outside_change: [], not_reviewed: [], dropped: [], low_confidence: [], below_threshold: 0, scanners: [], not_reviewed_paths: ["big.ts"], stats: { files: 1, additions: 1, deletions: 0 } };
  const renders = (r: Report) => [renderHtml({ report: r, display: null }), renderMarkdown(r), renderTerminal(r, { color: false }), renderReview(r, { format: "markdown" })];
  for (const text of renders(report)) {
    expect(text).not.toMatch(/Files outside|Not reviewed: 1 file/);
    expect(text).not.toContain("big.ts");
  }
  for (const text of renders({ ...report, base: { ...report.base, ref: "all" } })) {
    expect(text).toContain("Not reviewed: 1 file, over 5 MB, links or unreadable");
    expect(text).toContain("big.ts");
  }
  const c = { ...change([]), baseRef: "all", notReviewed: ["big.ts"] };
  const text = buildWholeRepoBrief({ ...briefArgs(c), inventory: [], inventoryPath: "inventory.json", hot: [], graphNote: null });
  expect(text).toContain("Not reviewed: 1 file, over 5 MB, links or unreadable");
  expect(text).toContain("read them with your own tools");
});

it("6. invalidates cached rows when an existing entry's text changes", () => {
  const entry = { path: "small.ts", text: patch("small.ts", "first") };
  const c = change([entry]);
  const cache = stagedDiffCache(c);
  const ref = { id: "h1", path: entry.path, start: 1, end: 1, deletion: false };
  expect(hunkRows(c, ref, [], cache).join("\n")).toContain("+first");
  entry.text = patch(entry.path, "second");
  expect(hunkRows(c, ref, [], cache).join("\n")).toContain("+second");
});

it("7. removes owned host-temp patches and their folders on library cleanup", () => {
  const store = new DiffStore("host-library");
  store.push("large.ts", Buffer.from(patch("large.ts", "x".repeat(6 * 1024 * 1024))));
  const c = change(store.finish());
  const file = c.diffs![0]!.file!;
  adoptTempDir(dirname(dirname(dirname(file))));
  expect(existsSync(file)).toBe(true);
  cleanupDiffs(c);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(dirname(dirname(dirname(file))))).toBe(false);
  cleanupDiffs(c);
});

it("8. distinguishes an exhausted brief budget from a file exceeding it", () => {
  const c = change([{ path: "first.ts", text: patch("first.ts", "x".repeat(160 * 1024)) }, { path: "next.ts", text: patch("next.ts", "y".repeat(50 * 1024)) }]);
  const text = buildBrief(briefArgs(c));
  expect(text).toContain("next.ts: the brief's diff budget is used up");
  expect(text).not.toContain("the patch is 51 KB, more than");
});
it("9. skips oversized lens pages with a log note and matches a later hunk", () => {
  const dir = tempDir("oq-lens-limit-");
  writeFileSync(join(dir, "limit.md"), "---\nname: limit\ndescription: Bounded diff\ntriggers:\n  hunk_regex: trigger_later\n---\nCheck it.\n");
  const file = join(dir, "large.patch");
  writeFileSync(file, `@@ -1 +1 @@\n-${"x".repeat(2 * 1024 * 1024)}\n+fresh\n@@ -10 +10 @@\n-before\n+trigger_later\n`);
  const notes: string[] = [];
  // The optional logger makes skipped trigger pages visible to callers.
  expect(selectLenses(change([{ path: "a.ts", file }]), dir, undefined, (note: string) => notes.push(note)).map((l) => l.name)).toEqual(["limit"]);
  expect(notes.join("\n")).toMatch(/skipped.*byte budget/i);
});
