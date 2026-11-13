// Failures guarded:
// 1. Byte offsets or counts drift on CRLF, missing final newline or empty files.
// 2. Any NUL, UTF-16, Latin-1 or invalid UTF-8 anywhere refuses the whole file.
// 3. A large file cannot be read, paged or cited at line 100,000.
// 4. Equal size and mtime hide a large file's changed content from the hash.
// 5. Short lines make the index grow beyond 1 MB for a 65 MB file.
// 6. Search stops on an oversized line instead of finding later matches.
// 7. Display reads a large file whole or prevents completion.
// 8. Oversized neighbours block evidence or oversized citations claim to be binary.
// 9. Wide rows leave more than 1 MB between index anchors.
// 10. Releasing a review retains its cached line indexes.
// 11. An excerpt span past EOF consumes the row budget instead of showing rows.
// 12. An over-budget excerpt discards earlier spans or claims the file is unreadable.
// 13. A read stopped by an oversized row keeps asking for that same row.
import { closeSync, openSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as snapshot from "../src/snapshot.js";
import { hashSnapshot, lineCounter, lineIndex, readLines, snapshotText } from "../src/snapshot.js";
import { buildExcerptDisplay, completionRecord, readCoverage, renderHtml, scanReport } from "@openqodex/core";
import { fragmentSnapshotText } from "../src/line-fragments.js";
import { deliverRanges } from "../src/conversation.js";
import { checkEvidence, checkFindAnswer, checkVerifyAnswer } from "../src/evidence-check.js";
import { runTool } from "../src/tools/index.js";
import { fixture, cleanupFixtures, candidate, verdict } from "./staged-fixture.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
afterAll(cleanupFixtures);

it.each([
  ["CRLF", "é\r\nb\r\n", [0], "b\r\n"],
  ["no trailing newline", "a\nb", [0], "b"],
  ["empty file", "", [], ""],
])("indexes byte offsets and reads %s without inventing a final line", (_name, content, offsets, second) => {
  const dir = tempDir("oq-index-");
  writeFileSync(join(dir, "a.txt"), content);
  expect(lineIndex(dir, "a.txt")?.starts).toEqual(offsets);
  expect(lineCounter(dir)("a.txt")).toBe(content === "" ? 0 : 2);
  expect(readLines(dir, "a.txt", 2, 2)).toBe(second);
  expect(readLines(dir, "a.txt", 20, 30)).toBe("");
});

it.each([["NUL", Buffer.from([0])], ["invalid UTF-8", Buffer.from([0xff])], ["UTF-16", Buffer.from("bad", "utf16le")], ["Latin-1", Buffer.from([0xe9])]])("refuses the whole file as text with %s anywhere, and pages it by bytes", async (_name, bad) => {
  const { change } = fixture(["a.txt"]);
  const dir = tempDir("oq-index-");
  writeFileSync(join(dir, "a.txt"), Buffer.concat([Buffer.from(`safe\n${"x".repeat(64 * 1024)}\n`), bad, Buffer.from("\nend")]));
  expect(readLines(dir, "a.txt", 1, 1)).toBeNull();
  expect(readLines(dir, "a.txt", 2, 2)).toBeNull();
  expect(readLines(dir, "a.txt", 3, 9)).toBeNull();
  expect(lineIndex(dir, "a.txt")?.text).toBe(false);
  const out = await runTool({ snapshotDir: dir, change, secrets: [], graph: null, graphNote: null }, "read_file", { path: "a.txt", start: 1, lines: 1 });
  expect(out.ok).toBe(false);
  // Fragments are bytes, so a file that is not text is still paged by bytes.
  expect(deliverRanges({ snapshotDir: dir, unread: [{ path: "a.txt", start: 1, end: 1, deletion: false }], secrets: [] }).delivered).toEqual([{ path: "a.txt", start: 1, end: 1, deletion: false, lineBytes: 4, fragment: { from: 1, to: 4 } }]);
  expect(checkEvidence({ file_path: "a.txt", line_number: 1, quote: "safe" }, snapshotText(dir), change)).not.toBeNull();
});

it("reads, pages and accepts evidence at line 100,000 of a 6 MB file", async () => {
  const { change } = fixture();
  const dir = tempDir("oq-large-index-");
  const path = join(dir, "big.txt");
  const fd = openSync(path, "w");
  const row = `${"x".repeat(62)}\n`;
  try {
    for (let n = 1; n <= 100_000; n++) writeSync(fd, n === 100_000 ? "unsafe operation\n" : row);
  } finally { closeSync(fd); }
  expect(lineCounter(dir)("big.txt")).toBe(100_000);
  expect(readLines(dir, "big.txt", 100_000, 100_002)).toBe("unsafe operation\n");
  expect(lineIndex(dir, "big.txt")).toBe(lineIndex(dir, "big.txt"));
  const tool = await runTool({ snapshotDir: dir, change, secrets: [], graph: null, graphNote: null }, "read_file", { path: "big.txt", start: 100_000, lines: 1 });
  expect(tool).toMatchObject({ ok: true, range: [100_000, 100_000] });
  expect(tool.text).toContain("100000\tunsafe operation");
  const page = deliverRanges({ snapshotDir: dir, unread: [{ path: "big.txt", start: 100_000, end: 100_000, deletion: false }], secrets: [] });
  expect(page.delivered).toHaveLength(1);
  expect(page.text).toContain("100000\tunsafe operation");
  expect(checkEvidence({ file_path: "big.txt", line_number: 100_000, quote: "unsafe operation" }, snapshotText(dir), change)).toBeNull();
});

it("hashes large content even when size and mtime agree", () => {
  const dirs = [tempDir("oq-hash-"), tempDir("oq-hash-")];
  for (const [i, dir] of dirs.entries()) {
    const path = join(dir, "big.txt");
    const fd = openSync(path, "w");
    try { for (let n = 0; n < 96; n++) writeSync(fd, Buffer.alloc(64 * 1024, 97 + i)); }
    finally { closeSync(fd); }
    utimesSync(path, 1_000, 1_000);
  }
  expect(hashSnapshot(dirs[0]!)).not.toBe(hashSnapshot(dirs[1]!));
});

it("indexes 65 MB of two-byte lines with under 1 MB of anchors and reads the last lines", () => {
  const dir = tempDir("oq-short-lines-");
  const fd = openSync(join(dir, "big.txt"), "w");
  try {
    const chunk = Buffer.alloc(64 * 1024, "a\n");
    for (let n = 0; n < 1040; n++) writeSync(fd, chunk);
  } finally { closeSync(fd); }
  const index = lineIndex(dir, "big.txt")!;
  expect(index.starts.length).toBeLessThan(1024 * 1024 / 8);
  expect(lineCounter(dir)("big.txt")).toBe(34_078_720);
  expect(readLines(dir, "big.txt", 34_078_718, 34_078_722)).toBe("a\na\na\n");
});

it("searches beyond a 1.2 MB line and keeps later line numbers", async () => {
  const { change, dir } = fixture();
  writeFileSync(join(dir, "search.txt"), `${"x".repeat(1200 * 1024)}\nneedle after oversized row\n`);
  const out = await runTool({ snapshotDir: dir, change, secrets: [], graph: null, graphNote: null }, "search_code", { pattern: "needle", glob: "search.txt" });
  expect(out.ok).toBe(true);
  expect(out.text).toContain("search.txt:2: needle after oversized row");
  expect(out.reason).toContain("1 rows over 1 MB were not searched");
  expect(out.text).toContain("1 rows over 1 MB were not searched");
});

it("shows excerpt lines from a 6 MB file while the review completes", () => {
  const { change, dir } = fixture(["a.txt"]);
  const fd = openSync(join(dir, "a.txt"), "w");
  try {
    for (let n = 0; n < 96; n++) writeSync(fd, Buffer.alloc(64 * 1024, "a\n"));
  } finally { closeSync(fd); }
  const read = snapshotText(dir, 5 * 1024 * 1024);
  expect(read("a.txt") === null).toBe(true);
  const display = buildExcerptDisplay({ changeId: change.id, cited: [{ file_path: "a.txt", line_number: 1, line_end: 1 }], read, secrets: [] });
  expect(display.files[0]?.note).toBeNull();
  expect(display.files[0]?.hunks[0]?.rows).toEqual([1, 2, 3, 4].map((n) => ({ kind: "context", old: null, new: n, text: "a" })));
  const page = deliverRanges({ snapshotDir: dir, unread: [{ path: "a.txt", start: 1, end: 1, deletion: false }], secrets: [] });
  const completion = completionRecord({ change, reviewer: { driver: "model", version: "fixture", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } }, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, coverage: readCoverage({ change, briefFiles: new Set(), trace: [], lineCount: lineCounter(dir), delivered: page.delivered }), trace: [], submissionErrors: [], wholeRepo: false });
  expect(completion.status).toBe("complete");
});

it("accepts a quote inside a long line without reading that line whole", () => {
  const { change, dir } = fixture();
  writeFileSync(join(dir, "a.txt"), `unsafe operation ${"x".repeat(6 * 1024 * 1024)}\n`);
  expect(checkEvidence({ file_path: "a.txt", line_number: 1, quote: "unsafe operation" }, fragmentSnapshotText(dir), change)).toBeNull();
});

it("accepts evidence two rows from a 250 KB line", () => {
  const { change, dir } = fixture();
  writeFileSync(join(dir, "a.txt"), `unsafe operation\nshort\n${"x".repeat(250 * 1024)}\n`);
  expect(checkEvidence({ file_path: "a.txt", line_number: 1, quote: "unsafe operation" }, snapshotText(dir), change)).toBeNull();
});

it("accepts oversized finder and verifier anchors and their fragment quotes", () => {
  const { change, dir } = fixture(["a.txt"]);
  writeFileSync(join(dir, "a.txt"), `${"x".repeat(250 * 1024)}\nsafe operation\n`);
  const c = { ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 2, quote: "safe operation" }] };
  const unit = { id: "u1", files: ["a.txt"], diffBytes: 0, hunks: [{ id: "h1", path: "a.txt", start: 1, end: 1, deletion: false }] };
  const found = checkFindAnswer({ version: "find-1", change_id: change.id, unit: "u1", examined: ["h1"], analysis: [{ hunk: "h1", changed: "Changed.", could_break: "Output." }], candidates: [c] }, unit, change, snapshotText(dir));
  const item = { id: "k1", kind: "finder" as const, candidate: c, foundBy: [] };
  const verified = checkVerifyAnswer({ version: "verify-1", change_id: change.id, verdicts: [verdict(item)] }, { file: "a.txt", hunks: unit.hunks, candidates: [item] }, change, snapshotText(dir), lineCounter(dir));
  expect(found.errors).toEqual([]);
  expect(found.rejected).toEqual([]);
  expect(found.answer.candidates).toEqual([c]);
  expect(verified.errors).toEqual([]);
  expect(checkEvidence({ file_path: "a.txt", line_number: 1, quote: "x" }, fragmentSnapshotText(dir), change)).toBeNull();
});

it("clips an indexed excerpt span at the end of a 10-line file", () => {
  const { change, dir } = fixture(["a.txt"]);
  const rows = Array.from({ length: 10 }, (_, k) => `row ${k + 1}`);
  writeFileSync(join(dir, "a.txt"), `${rows.join("\n")}\n`);
  const display = buildExcerptDisplay({ changeId: change.id, cited: [{ file_path: "a.txt", line_number: 1, line_end: 2_500_000 }], read: snapshotText(dir), secrets: [] });
  expect(display.files[0]?.note).toBeNull();
  expect(display.files[0]?.hunks[0]?.rows).toEqual(rows.map((text, k) => ({ kind: "context", old: null, new: k + 1, text })));
  expect(display.rows).toBe(10);
});

it.each([false, true])("keeps earlier excerpt spans and names the display limit when a text span is over budget (earlier: %s)", (earlier) => {
  const { change, dir, scan, config } = fixture(["a.txt"]);
  writeFileSync(join(dir, "a.txt"), `${"short\n".repeat(11)}${"x".repeat(8 * 1024 * 1024)}\n`);
  const cited = [...(earlier ? [{ file_path: "a.txt", line_number: 1, line_end: 1 }] : []), { file_path: "a.txt", line_number: 12, line_end: 12 }];
  const display = buildExcerptDisplay({ changeId: change.id, cited, read: snapshotText(dir), secrets: [] });
  expect(display.files[0]?.note).toContain("the display limit");
  expect(display.files[0]?.hunks.flatMap((h) => h.rows)).toEqual(earlier ? [1, 2, 3, 4].map((n) => ({ kind: "context", old: null, new: n, text: "short" })) : []);
  expect(display.rows).toBe(earlier ? 4 : 0);
  const html = renderHtml({ report: scanReport({ change, scan, config }), display });
  expect(html).toContain("the display limit");
  expect(html.match(/<tr class="line /g) ?? []).toHaveLength(earlier ? 4 : 0);
});

it.each([1, 2])("continues after oversized row %s without crediting it as read", async (wide) => {
  const { change, dir } = fixture(["a.txt"]);
  writeFileSync(join(dir, "a.txt"), `${wide === 2 ? "first\n" : ""}${"x".repeat(40 * 1024)}\nafter\n`);
  const box = { snapshotDir: dir, change, secrets: [], graph: null, graphNote: null };
  const out = await runTool(box, "read_file", { path: "a.txt" });
  expect(out.text).toContain(`line ${wide} is longer than the 32 KB a reply may carry; continue from line ${wide + 1}`);
  expect(out.reason).toContain(`continue from line ${wide + 1}`);
  expect(out).toMatchObject(wide === 1 ? { ok: false, range: null } : { ok: true, range: [1, 1] });
  const next = await runTool(box, "read_file", { path: "a.txt", start: wide + 1 });
  expect(next).toMatchObject({ ok: true, range: [wide + 1, wide + 1] });
  expect(next.text).toContain(`${wide + 1}\tafter`);
});

it("anchors 200 wide rows by bytes and reads the last line", () => {
  const dir = tempDir("oq-wide-anchors-");
  const row = `${"x".repeat(60 * 1024)}\n`;
  const fd = openSync(join(dir, "wide.txt"), "w");
  try { for (let n = 0; n < 200; n++) writeSync(fd, row); }
  finally { closeSync(fd); }
  const index = lineIndex(dir, "wide.txt")!;
  expect(index.starts.length).toBeGreaterThanOrEqual(11);
  const ends = [...index.starts, index.size];
  for (let n = 1; n < ends.length; n++) expect(ends[n]! - ends[n - 1]!).toBeLessThanOrEqual(1024 * 1024 + 61 * 1024);
  expect(readLines(dir, "wide.txt", 200, 200)).toBe(row);
});

it.each(["LE", "BE"])("refuses a UTF-16 %s BOM and CJK text without NUL bytes", (order) => {
  const dir = tempDir("oq-utf16-bom-");
  const bytes = Buffer.from("漢字", "utf16le");
  if (order === "BE") bytes.swap16();
  const content = Buffer.concat([Buffer.from(order === "LE" ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
  expect(content.includes(0)).toBe(false);
  writeFileSync(join(dir, "a.txt"), content);
  expect(lineIndex(dir, "a.txt")?.text).toBe(false);
  expect(readLines(dir, "a.txt", 1, 1)).toBeNull();
});

it("releases only the finished review's cached indexes", () => {
  const dirs = [tempDir("oq-index-release-"), tempDir("oq-index-release-")];
  for (const dir of dirs) writeFileSync(join(dir, "a.txt"), "text\n");
  const before = dirs.map((dir) => lineIndex(dir, "a.txt"));
  snapshot.clearLineIndexes(dirs[0]!);
  expect(lineIndex(dirs[0]!, "a.txt")).not.toBe(before[0]);
  expect(lineIndex(dirs[1]!, "a.txt")).toBe(before[1]);
});
