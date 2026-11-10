// Failures guarded: raw secrets, crossed lines, missing old bytes, unsafe cuts,
// fixed block overflow, repeated scans, wrong ids, and distant verifier parts.
import { afterAll, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFindBrief, buildVerifyBrief, diffIndex, hunkRows, lineFragments, readCoverage, stagedDiffCache } from "@openqodex/core";
import type { HunkRef } from "@openqodex/core";
import { obligations, unitsOf } from "../src/units.js";
import { deliverRanges, redactSnapshot } from "../src/conversation.js";
import { fragmentSnapshotText, snapshotByteLines } from "../src/line-fragments.js";
import { snapshotReads } from "../src/snapshot.js";
import { candidate, cleanupFixtures, fixture } from "./staged-fixture.js";
// R2.7 took about 100 ms measured alone; its wall-clock bound is ten times that.
const ALONE_MS = 100;
afterAll(cleanupFixtures);

it("R2.1 uses redacted snapshot bytes in the cutter, brief and page", () => {
  const f = fixture(["a.txt"]);
  const secret = "SECRET12345678901234";
  const raw = "x".repeat(1990) + secret + "y".repeat(200000 - 2010);
  writeFileSync(join(f.dir, "a.txt"), raw + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${raw}\n` }];
  redactSnapshot(f.dir, [secret]);
  const refs = obligations(f.change, fragmentSnapshotText(f.dir), stagedDiffCache(f.change, [secret]));
  const brief = buildFindBrief({ ...f, secrets: [secret], lenses: [] }, { id: "u1", files: ["a.txt"], hunks: [refs[0]!], diffBytes: 0 }, "local");
  expect(brief.text).not.toContain(secret.slice(0, 10));
  expect(brief.text).not.toContain(secret.slice(10));
  expect(refs.at(-1)!.lineBytes).toBe(199990);
  const page = deliverRanges({ snapshotDir: f.dir, secrets: [], unread: [refs[0]!] });
  const rows = brief.text.split("\n").filter((r) => r.startsWith("+a.txt: line 1, bytes "));
  // The page frames its fragments with a heading; the fragment rows match.
  expect(rows.map((r) => r.slice(1))).toEqual(page.text.split("\n").filter((r) => r.startsWith("a.txt: line 1, bytes ")));
  expect(readCoverage({ change: f.change, obligations: refs, briefCarried: refs, trace: [] }).covered).toBe(1);
});
it("R2.2 bounds a snapshot byte read at its own line end", () => {
  const f = fixture(["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "abc\nnext line\n");
  for (const { source } of snapshotByteLines(f.dir, "a.txt", 1, 1)) {
    expect(source.read(1, 2000).toString()).toBe("bc");
    expect(source.read(3, 2000).length).toBe(0);
  }
});
it("R2.3 fragments both sides of a one MB replacement", () => {
  const f = fixture(["a.txt"]);
  const text = "n".repeat(1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -1 +1 @@\n-${"o".repeat(text.length)}\n+${text}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  for (const old of [false, true]) {
    const side = refs.filter((h) => Boolean(h.deletion) === old);
    expect(side.length).toBeGreaterThan(1);
    expect(side[0]!.fragment!.from).toBe(1);
    expect(side.at(-1)!.fragment!.to).toBe(text.length);
    expect(side.every((h) => hunkRows(f.change, h).length > 0)).toBe(true);
  }
  expect(readCoverage({ change: f.change, obligations: refs, briefCarried: refs, trace: [] }).unread).toEqual([]);
});
it("R2.4 decodes invalid bytes leniently and keeps raw byte intervals", () => {
  const bytes = Buffer.concat([Buffer.from("a".repeat(1999)), Buffer.from("😀"), Buffer.from([255]), Buffer.from("b".repeat(2100))]);
  const source = { bytes: bytes.length, read: (from: number, length: number) => bytes.subarray(from, from + length) };
  const parts = [...lineFragments(source)];
  expect(parts[0]!.to).toBe(1999);
  expect(parts[1]!.text).toContain("😀�");
  let next = 1;
  for (const part of parts) { expect(part.from).toBe(next); next = part.to + 1; }
  expect(next).toBe(bytes.length + 1);
});
it("R2.6 caps fragments against 150 KB of fixed brief blocks", () => {
  const f = fixture(["a.txt"]);
  const text = "z".repeat(1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const render = (unit: Parameters<typeof buildFindBrief>[1]) => buildFindBrief({ ...f, secrets: [], lenses: [], instructions: "r".repeat(150 * 1024) }, unit, "local").text;
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  const units = unitsOf(f.change, refs, render);
  expect(units.length).toBeGreaterThan(10);
  expect(units.every((u) => Buffer.byteLength(render(u)) <= 256 * 1024)).toBe(true);
});
it("R2.7 cuts and renders a twenty MB line reading it a bounded number of times", () => {
  const f = fixture(["a.txt"]);
  const text = "z".repeat(20 * 1024 * 1024);
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  const patch = join(f.dir, "patch");
  writeFileSync(patch, `@@ -0,0 +1 @@\n+${text}\n`);
  f.change.diffs = [{ path: "a.txt", file: patch }];
  const started = performance.now();
  const before = snapshotReads.bytes;
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  for (const h of refs) expect(hunkRows(f.change, h).length).toBeGreaterThan(0);
  const ms = performance.now() - started;
  const snapshot = snapshotReads.bytes - before;
  console.log(`R2.7 ${ms.toFixed(0)} ms, ${snapshot} snapshot bytes, ${diffIndex(f.change, "a.txt")!.readBytes} patch bytes`);
  // The line index, the cutter and the rows each read the file once.
  expect(snapshot).toBeLessThanOrEqual(3 * (text.length + 1));
  expect(diffIndex(f.change, "a.txt")!.readBytes).toBeLessThan(3 * text.length);
  expect(ms).toBeLessThan(ALONE_MS * 10);
  // Paging the whole line reads it about once, never once per round.
  const paged = snapshotReads.bytes;
  let unread: HunkRef[] = [{ path: "a.txt", start: 1, end: 1, deletion: false }];
  const earlier: HunkRef[] = [];
  let rounds = 0;
  for (; rounds < 100 && unread.length; rounds++) {
    const page = deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [], unread, earlier });
    earlier.push(...(page.delivered as HunkRef[]));
    unread = page.left as HunkRef[];
  }
  expect(unread).toEqual([]);
  expect(rounds).toBeGreaterThan(30);
  expect(snapshotReads.bytes - paged).toBeLessThan(2.2 * text.length);
}, 20000);
it("R2.9 names each fragment with its final part id", () => {
  const f = fixture(["a.txt"]);
  const text = "z".repeat(400000);
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const refs = obligations(f.change, () => text);
  expect(refs.every((h) => h.fragment!.of === h.id)).toBe(true);
});
it("R2.11 selects a late redacted quote with normalised whitespace", () => {
  const f = fixture(["a.txt"]);
  const secret = "synthetic-secret-r211";
  const text = "z".repeat(4700000) + "needle   target " + secret + "q".repeat(2300000);
  writeFileSync(join(f.dir, "a.txt"), text + "\nnearby quote\n");
  // The review redacts its snapshot first; the reviewer quotes the redacted text.
  redactSnapshot(f.dir, [secret]);
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  const quoted = { ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 1, quote: "needle target [redacted]" }] };
  const brief = buildVerifyBrief({ ...f, secrets: [secret], lenses: [] }, { file: "a.txt", hunks: refs, candidates: [{ id: "k1", kind: "finder", candidate: quoted, foundBy: [] }] }).text;
  expect(brief).toContain("needle   target [redacted]");
  expect(brief).not.toContain(secret);
  expect(brief).not.toContain("bytes 1 to 2,000 of");
});
it("R2.11 picks the fragment nearest a quote on the neighbouring line", () => {
  const f = fixture(["a.txt"]);
  const text = "z".repeat(1_500_000);
  writeFileSync(join(f.dir, "a.txt"), text + "\nnearby quote\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const refs = obligations(f.change, fragmentSnapshotText(f.dir));
  expect(refs.length).toBeGreaterThan(2);
  const quoted = { ...candidate("a.txt"), line_number: 2, evidence: [{ file_path: "a.txt", line_number: 2, quote: "nearby quote" }] };
  const brief = buildVerifyBrief({ ...f, secrets: [], lenses: [] }, { file: "a.txt", hunks: refs, candidates: [{ id: "k1", kind: "finder", candidate: quoted, foundBy: [] }] }).text;
  expect(brief).toContain("to 1,500,000 of 1,500,000\t");
  expect(brief).not.toContain("bytes 1 to 2,000 of");
});
