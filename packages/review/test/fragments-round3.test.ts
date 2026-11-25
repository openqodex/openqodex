// Round 3 of long lines as byte fragments. Failures guarded: repeated old-side
// scans, verifier rescans, evidence rescans, parts over the brief bound, labels
// that differ by place, lineBytes on a range, pages without context, a second
// secrets list, cut Reads credited whole, unpaged removed lines, non-text files.
import { afterAll, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFindBrief, buildVerifyBrief, changedHunks, completionRecord, diffIndex, hunkRows, readCoverage, renderReceipt, setFragmentSource, singlePassCoverage, stagedDiffCache } from "@openqodex/core";
import type { HunkRef, ReviewUnit, ReviewerRecord } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { longestBrief, MAX_BRIEF_BYTES, obligations, unitsOf } from "../src/units.js";
import { deliverRanges, redactSnapshot } from "../src/conversation.js";
import { checkEvidence } from "../src/evidence-check.js";
import { fragmentSnapshotText } from "../src/line-fragments.js";
import { lineCounter, snapshotReads } from "../src/snapshot.js";
import { fileCoverageLines } from "../../core/src/render/review.js";
import { candidate, cleanupFixtures, fixture } from "./staged-fixture.js";
afterAll(cleanupFixtures);

const reviewer: ReviewerRecord = { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
type Fixture = ReturnType<typeof fixture>;
const find = (f: Fixture, secrets: string[], extra = 0) => (unit: ReviewUnit, pass: "local" | "contracts") =>
  buildFindBrief({ ...f, secrets, lenses: [], instructions: pass === "contracts" && extra ? "r".repeat(extra) : undefined }, unit, pass);
// The longest real brief of a unit over both passes, as the review measures it.
const longest = (f: Fixture, secrets: string[], extra = 0) => (unit: ReviewUnit) => {
  const local = find(f, secrets, extra)(unit, "local").text;
  const contracts = find(f, secrets, extra)(unit, "contracts").text;
  return Buffer.byteLength(contracts) > Buffer.byteLength(local) ? contracts : local;
};
// A removed line of `old` bytes on line 1, kept in an on-disk patch.
function removedLine(old: string) {
  const f = fixture(["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "keep\n");
  const patch = join(f.dir, "patch");
  writeFileSync(patch, `@@ -1,2 +1 @@\n-${old}\n keep\n`);
  f.change.coverage.clear();
  f.change.deletionPoints.set("a.txt", [{ after: 0, lines: 1, anchors: [1] }]);
  f.change.diffs = [{ path: "a.txt", file: patch }];
  return f;
}

it("R3.1 reads a removed line's old side at most three times across cutter, briefs and pages", () => {
  const secret = "SECRET12345678901234";
  const old = "o".repeat(500_000) + secret + "p".repeat(1024 * 1024 - 500_020);
  const f = removedLine(old);
  redactSnapshot(f.dir, [secret]);
  // Indexing the patch reads it once; the reads after it are the old side's.
  const indexed = diffIndex(f.change, "a.txt")!.readBytes;
  const refs = obligations(f.change, fragmentSnapshotText(f.dir), stagedDiffCache(f.change, [secret]));
  const units = unitsOf(f.change, refs, longest(f, [secret]));
  expect(refs.length).toBeGreaterThanOrEqual(9);
  const texts: string[] = [];
  for (const unit of units) for (const pass of ["local", "contracts"] as const) texts.push(find(f, [secret])(unit, pass).text);
  for (const h of refs) texts.push(deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [secret], unread: [h] }).text);
  expect(texts.some((t) => t.includes(secret))).toBe(false);
  const read = diffIndex(f.change, "a.txt")!.readBytes - indexed;
  console.log(`R3.1 old side read ${read} bytes after a ${indexed} byte index pass, for a ${old.length} byte line in ${refs.length} parts`);
  expect(read).toBeLessThanOrEqual(3 * old.length);
}, 60_000);

it("R3.2 selects verifier parts of a 20 MB line from saved bounds, and a 100 KB quote fast", () => {
  const f = fixture(["a.txt"]);
  const marks = [1, 5, 9, 13, 17].map((mb) => mb * 1024 * 1024);
  let text = "z".repeat(20 * 1024 * 1024);
  marks.forEach((at, i) => { text = text.slice(0, at) + `mark${i}` + text.slice(at + 5); });
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  const candidates = marks.map((_, i) => ({ id: `k${i}`, kind: "finder" as const, candidate: { ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 1, quote: `mark${i}` }] }, foundBy: [] }));
  const before = snapshotReads.bytes;
  const brief = buildVerifyBrief({ ...f, secrets: [], lenses: [] }, { file: "a.txt", hunks: refs, candidates }).text;
  const read = snapshotReads.bytes - before;
  console.log(`R3.2 verify pass read ${read} bytes of a ${text.length} byte line`);
  expect(read).toBeLessThan(3 * text.length);
  expect(brief).toContain("mark0");

  const g = fixture(["b.txt"]);
  const quote = "q".repeat(100 * 1024);
  const wide = "w".repeat(600_000) + quote + "w".repeat(600_000);
  writeFileSync(join(g.dir, "b.txt"), wide + "\n");
  g.change.diffs = [{ path: "b.txt", text: `@@ -0,0 +1 @@\n+${wide}\n` }];
  const parts = obligations(g.change, fragmentSnapshotText(g.dir));
  const quoted = { id: "k1", kind: "finder" as const, candidate: { ...candidate("b.txt"), evidence: [{ file_path: "b.txt", line_number: 1, quote }] }, foundBy: [] };
  const started = performance.now();
  const verify = buildVerifyBrief({ ...g, secrets: [], lenses: [] }, { file: "b.txt", hunks: parts, candidates: [quoted] }).text;
  const ms = performance.now() - started;
  console.log(`R3.2 100 KB quote selected in ${ms.toFixed(0)} ms`);
  expect(verify).toContain("bytes 600,001 to");
  expect(ms).toBeLessThan(1000);
}, 60_000);

it("R3.3 reads a 5 MB neighbour once for 50 citations on short lines", () => {
  const f = fixture(["a.txt"]);
  const rows = Array.from({ length: 60 }, (_, i) => `short row ${i}`);
  rows[30] = "l".repeat(5 * 1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  const read = fragmentSnapshotText(f.dir);
  // The file's line index is built once per review, before any check.
  expect(read.lineCount!("a.txt")).toBe(60);
  const before = snapshotReads.bytes;
  for (let i = 0; i < 50; i++) {
    const line = 29 + (i % 5);
    const row = line === 31 ? 32 : line;
    expect(checkEvidence({ file_path: "a.txt", line_number: row, quote: `short row ${row - 1}` }, read, f.change)).toBeNull();
  }
  const bytes = snapshotReads.bytes - before;
  console.log(`R3.3 50 citations read ${bytes} snapshot bytes beside a ${rows[30]!.length} byte line`);
  expect(bytes).toBeLessThan(1.5 * rows[30]!.length);
}, 60_000);

it("R3.6 recuts parts against the longer pass with the real file list, so every part fits", () => {
  const f = fixture(["a.txt"]);
  const text = "z".repeat(1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  // The review measures with longestBrief; round 2 measured the local pass alone.
  const units = unitsOf(f.change, refs, (unit) => longestBrief(unit, find(f, [], 100 * 1024)));
  for (const unit of units) for (const pass of ["local", "contracts"] as const) expect(Buffer.byteLength(find(f, [], 100 * 1024)(unit, pass).text)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
  expect(refs.some((h) => h.note)).toBe(false);
  expect(readCoverage({ change: f.change, obligations: refs, briefCarried: units.flatMap((u) => u.hunks), trace: [] }).unread).toEqual([]);
  // R3.9: a recut part names its final id.
  expect(refs.every((h, i) => h.id === `h${i + 1}` && h.fragment!.of === h.id)).toBe(true);
}, 60_000);

it("R3.7 labels a renamed file's fragments the same in brief, page, given, missing and per-file line", () => {
  const f = fixture(["a.js"]);
  const added = "n".repeat(300_000);
  const removed = "o".repeat(300_000);
  writeFileSync(join(f.dir, "a.js"), `1\n2\n3\n4\n5\n6\n${added}\n`);
  f.change.files = [{ path: "a.js", status: "renamed", oldPath: "old.js", binary: false }];
  f.change.coverage.set("a.js", makeLineSet([7]));
  f.change.diffs = [{ path: "a.js", text: `@@ -7 +7 @@\n-${removed}\n+${added}\n` }];
  const newLabel = "a.js: line 7, bytes 298,001 to 300,000 of 300,000";
  const oldLabel = "old.js: old line 7, bytes 298,001 to 300,000 of 300,000";
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  const last = [refs.filter((h) => !h.deletion).at(-1)!, refs.filter((h) => h.deletion).at(-1)!];
  const brief = buildFindBrief({ ...f, secrets: [], lenses: [] }, { id: "u1", files: ["a.js"], hunks: last, diffBytes: 0 }, "local").text.split("\n");
  expect(brief).toContain(`+${newLabel}\t${"n".repeat(2000)}`);
  expect(brief).toContain(`-${oldLabel}\t${"o".repeat(2000)}`);
  // Every part but the last 2,000 bytes of each side reached a brief.
  const first = refs.map((h) => last.includes(h) ? { ...h, fragment: { ...h.fragment!, to: 298_000 } } : h);
  const partial = readCoverage({ change: f.change, obligations: refs, briefCarried: first, trace: [] });
  const missingRecord = completionRecord({ change: f.change, coverage: partial, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false });
  const missing = missingRecord.missing;
  expect(missing).toContain(`  ${newLabel}`);
  expect(missing.some((m) => m.startsWith(`  ${oldLabel}`))).toBe(true);
  const page = deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [], unread: partial.unread, earlier: first });
  expect(page.text.split("\n")).toContain(`${newLabel}\t${"n".repeat(2000)}`);
  expect(page.text.split("\n")).toContain(`-${oldLabel}\t${"o".repeat(2000)}`);
  const full = readCoverage({ change: f.change, obligations: refs, briefCarried: first, delivered: page.delivered, trace: [] });
  expect(full.unread).toEqual([]);
  // Each part's heading names the line once, in the label's form.
  expect(brief).toContain("### h6 a.js 7-7 (part 6 of 6) (a.js: line 7, bytes 236,001 to 300,000 of 300,000)");
  expect(brief).toContain("### h3 a.js 7-7 (part 3 of 6) (old.js: old line 7, bytes 236,001 to 300,000 of 300,000) (old lines 7-7)");
  // The receipt names the missing bytes by the same label.
  const report = { completion: missingRecord, findings: [], observations: [], possible: [], not_reviewed: [], notes: [], stats: { files: 1, additions: 1, deletions: 1 }, change_id: "abcdef123456", base: { ref: "main" }, summary: null, verdict: "pass" } as never;
  expect(renderReceipt(report, { html: "r.html", md: "r.md" })).toContain(`Missing: 2 changed ranges were not examined; a.js:7 (deletion a.js#replacement0:7, old lines 7-7); ${oldLabel} (deletion a.js#replacement0:7, old lines 7-7); a.js:7; ${newLabel}\n`);
  // The per-file line prints each path once, from the labels alone.
  expect(fileCoverageLines(full)).toEqual([[`a.js: line 7, bytes 1 to 298,000 of 300,000 brief`, `${newLabel} page`, `old.js: old line 7, bytes 1 to 298,000 of 300,000 (deletion a.js#replacement0:7) brief`, `${oldLabel} (deletion a.js#replacement0:7) page`].join(", ")]);
});

it("R3.10 keeps lineBytes on the one line a page stopped inside", () => {
  const f = fixture(["a.txt"]);
  const rows = Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`);
  rows[201] = "x".repeat(1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  const page = deliverRanges({ snapshotDir: f.dir, secrets: [], unread: [{ path: "a.txt", start: 200, end: 1000, deletion: false }] });
  expect(page.left.length).toBeGreaterThan(0);
  for (const h of page.left) if (h.lineBytes !== undefined || h.fromByte !== undefined) expect(h.end).toBe(h.start);
  expect(page.left[0]).toMatchObject({ start: 202, end: 202, lineBytes: 1024 * 1024 });
});

it("R3.11 pages a 4 MB file of 3.4 KB lines with each byte read under three times, keeping context", () => {
  const f = fixture(["a.txt"]);
  const rows = Array.from({ length: 1200 }, (_, i) => `${i}:`.padEnd(3400, "c"));
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  const size = Buffer.byteLength(rows.join("\n") + "\n");
  const before = snapshotReads.bytes;
  let unread = [{ path: "a.txt", start: 100, end: 1100, deletion: false }];
  const earlier: typeof unread = [];
  const texts: string[] = [];
  for (let round = 0; round < 50 && unread.length; round++) {
    const page = deliverRanges({ snapshotDir: f.dir, secrets: [], unread, earlier });
    texts.push(page.text);
    earlier.push(...page.delivered);
    unread = page.left;
  }
  expect(unread).toEqual([]);
  const read = snapshotReads.bytes - before;
  console.log(`R3.11 pages read ${read} snapshot bytes of a ${size} byte file`);
  expect(read).toBeLessThan(3 * size);
  // Line pages and byte-fragment pages each name their context around the lines they show.
  const paged = texts.flatMap((t) => t.split("\n"));
  const heads = paged.filter((r) => / lines \d+ to \d+ \(with context/.test(r));
  expect(heads.length).toBeGreaterThan(0);
  for (const head of heads) {
    const m = / lines (\d+) to (\d+) \(with context (\d+) to (\d+)\)/.exec(head);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBeLessThan(Number(m![1]));
    expect(Number(m![4])).toBeGreaterThan(Number(m![2]));
  }
  for (const head of paged.filter((r) => r.startsWith("a.txt: line ") && !/, bytes \d/.test(r))) {
    const m = /^a\.txt: line (\d+), (?:in byte fragments(?: \(with context (\d+) to (\d+) before it\))?|context after it \((\d+) to (\d+)\)):$/.exec(head);
    expect(m, head).not.toBeNull();
    if (m![2]) expect([Number(m![2]) < Number(m![1]), Number(m![3])]).toEqual([true, Number(m![1]) - 1]);
    if (m![4]) expect([Number(m![4]), Number(m![5]) > Number(m![1])]).toEqual([Number(m![1]) + 1, true]);
  }
}, 60_000);

it("R3.12 renders a fragment with the change's one secrets list and refuses a different one", () => {
  const f = fixture(["a.txt"]);
  const secret = "SECRET12345678901234";
  const raw = "x".repeat(1990) + secret + "y".repeat(8000);
  writeFileSync(join(f.dir, "a.txt"), raw + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -1 +1 @@\n-${raw}\n+${raw}\n` }];
  redactSnapshot(f.dir, [secret]);
  const refs = obligations(f.change, fragmentSnapshotText(f.dir), stagedDiffCache(f.change, [secret]));
  // A different list throws, since the change's rows use its one grid.
  for (const h of refs) expect(() => hunkRows(f.change, h, ["another"])).toThrow(/differs/);
  for (const h of refs) expect(hunkRows(f.change, h, []).join("\n")).not.toContain(secret.slice(0, 10));
  expect(refs.some((h) => hunkRows(f.change, h, []).join("").includes("[redacted]"))).toBe(true);
});

it("R3.17 credits a cut Read by its bytes only, from the snapshot's long line list", () => {
  const f = fixture(["a.txt"]);
  const rows = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
  rows[9] = "m".repeat(1_000_000);
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  const h = { path: "a.txt", start: 1, end: 20, deletion: false };
  const coverage = readCoverage({ change: f.change, obligations: [h], lineCount: lineCounter(f.dir), trace: [{ tool: "Read", path: "a.txt", range: [1, 20], inside: true, ok: true, byteRanges: [{ line: 10, from: 1, to: 2000 }] }] });
  expect(coverage.covered).toBe(0);
  expect(coverage.unread).toContainEqual(expect.objectContaining({ start: 10, end: 10, fragment: { from: 2001, to: 1_000_000 } }));
});

it("R3.18 pages a 700 KB removed line with stages off until the deletion is given by page", () => {
  const old = "m".repeat(700 * 1024);
  const f = removedLine(old);
  const unreadOf = (delivered: Parameters<typeof singlePassCoverage>[0]["delivered"]) => singlePassCoverage({ change: f.change, diffFiles: new Set(), trace: [], delivered }).unread;
  let unread = unreadOf([]);
  expect(unread).toEqual(changedHunks(f.change));
  const earlier: NonNullable<Parameters<typeof deliverRanges>[0]["earlier"]> = [];
  // The single pass registers the run's secrets list before it pages.
  setFragmentSource(f.change, () => [], []);
  for (let round = 0; round < 5 && unread.length; round++) {
    const page = deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [], unread, earlier });
    expect(page.text).toContain("-a.txt: old line 1, bytes ");
    earlier.push(...page.delivered);
    unread = unreadOf(earlier);
  }
  expect(unread).toEqual([]);
  const given = singlePassCoverage({ change: f.change, diffFiles: new Set(), trace: [], delivered: earlier }).given;
  expect(given).toEqual([expect.objectContaining({ path: "a.txt", deletion: "a.txt#0", by: "page" })]);
}, 60_000);

it("R3.19 recuts a removed line with the run's secrets so offsets follow the redacted grid", () => {
  // A 23-byte secret shifts every later byte by 13 on the redacted grid.
  const secret = "SECRET12345678901234567";
  const old = "o".repeat(1000) + secret + "p".repeat(1024 * 1024) + "q".repeat(5000);
  const redacted = old.replace(secret, "[redacted]");
  const f = removedLine(old);
  const refs = obligations(f.change, fragmentSnapshotText(f.dir), stagedDiffCache(f.change, [secret]));
  const units = unitsOf(f.change, refs, longest(f, [secret], 150 * 1024));
  for (const unit of units) for (const pass of ["local", "contracts"] as const) {
    const text = find(f, [secret], 150 * 1024)(unit, pass).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    expect(text).not.toContain(secret);
  }
  const total = refs[0]!.lineBytes!;
  expect(total).toBe(old.length - secret.length + "[redacted]".length);
  let next = 1;
  for (const h of refs) {
    expect(h.fragment!.from).toBe(next);
    const rows = hunkRows(f.change, h, [secret]);
    expect(rows.length).toBeGreaterThan(0);
    // Each row's bytes are the redacted line's bytes at the labelled offsets.
    for (const row of rows) {
      const [label, text] = row.split("\t");
      const m = /bytes ([\d,]+) to ([\d,]+) of ([\d,]+)$/.exec(label!)!;
      const [from, to, of] = m.slice(1).map((n) => Number(n.replace(/,/g, "")));
      expect(of).toBe(redacted.length);
      expect(text).toBe(redacted.slice(from! - 1, to));
    }
    next = h.fragment!.to + 1;
  }
  expect(next).toBe(total + 1);
}, 60_000);

it("R3.20 reviews a Windows-1252 file's 1 MB changed line by bytes, brief and page agreeing", () => {
  const f = fixture(["a.txt"]);
  const line = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("x".repeat(1024 * 1024 - 4))]);
  writeFileSync(join(f.dir, "a.txt"), Buffer.concat([Buffer.from("head\n"), line, Buffer.from("\ntail\n")]));
  f.change.coverage.set("a.txt", makeLineSet([2]));
  f.change.diffs = [{ path: "a.txt", text: `@@ -2 +2 @@\n-old\n+${line.toString("latin1")}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir)).filter((h) => !h.deletion);
  expect(refs.length).toBeGreaterThan(1);
  expect(refs.every((h) => h.lineBytes === line.length)).toBe(true);
  const briefRows = refs.flatMap((h) => hunkRows(f.change, h)).map((r) => r.slice(1).split("\t")[0]);
  const pageRows: string[] = [];
  let unread: HunkRef[] = refs;
  const earlier: HunkRef[] = [];
  for (let round = 0; round < 10 && unread.length; round++) {
    const page = deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [], unread, earlier });
    pageRows.push(...page.text.split("\n").filter((r) => r.startsWith("a.txt: line 2, bytes ")).map((r) => r.split("\t")[0]!));
    earlier.push(...(page.delivered as HunkRef[]));
    unread = page.left as HunkRef[];
  }
  expect(pageRows).toEqual(briefRows);
  expect(readCoverage({ change: f.change, obligations: refs, delivered: earlier, trace: [] }).unread.filter((h) => !h.deletion)).toEqual([]);
}, 60_000);

