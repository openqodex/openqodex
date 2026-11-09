// Round 5 of long lines as byte fragments. Failures guarded: a Read credited
// on a non-UTF-8 file, context after a line repeated per part, a heading sent
// with no fragment, a quote match given to the fragment before it, a long
// quote copied whole per fragment, a citation past the end of the file, a
// long cited line streamed once per citation, a note-only unit given finder
// sessions, notes naming bare lines, a decoded cut of a short snapshot line,
// and hunkRefs registering an empty secrets list.
import { afterAll, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFindBrief, buildReviewerBrief, buildVerifyBrief, fragmentLabel, readCoverage, registeredSecrets, stagedDiffCache, verifyPartDistance } from "@openqodex/core";
import type { FindAnswer, HunkRef, ReviewUnit, VerifyBatch } from "@openqodex/core";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { hunkRefs, obligations } from "../src/units.js";
import { deliverRanges } from "../src/conversation.js";
import { checkEvidence, checkFindAnswer } from "../src/evidence-check.js";
import { fragmentSnapshotText, snapshotByteLines } from "../src/line-fragments.js";
import { lineCounter, snapshotReads } from "../src/snapshot.js";
import { runStagedReview } from "../src/stages.js";
import { candidate, cleanupFixtures, fixture, verdict } from "./staged-fixture.js";
afterAll(cleanupFixtures);

type Fixture = ReturnType<typeof fixture>;
// Runs a staged review whose finders raise `raised` from the unit holding
// `owner`, and whose verifiers confirm everything they are sent.
async function staged(f: Fixture, instructions: string, raised?: { owner: (h: HunkRef) => boolean; quote: string }) {
  const shared = { ...f, lenses: [], secrets: [], instructions };
  const mapped = new Map<string, { unit?: ReviewUnit; batch?: VerifyBatch }>();
  const batches: VerifyBatch[] = [];
  let finders = 0;
  const result = await runStagedReview({ ...f, snapshotDir: f.dir, secrets: [], deadline: Date.now() + 120_000, now: Date.now, traced: false, say: () => {},
    findBrief: (unit, pass) => { const b = buildFindBrief(shared, unit, pass); mapped.set(b.text, { unit }); return b; },
    verifyBrief: (batch) => { const b = buildVerifyBrief(shared, batch); mapped.set(b.text, { batch }); return b; },
    openSession: () => ({ close() {}, async send(brief) {
      const b = mapped.get(brief)!;
      let answer: unknown;
      if (b.unit) {
        finders++;
        const ids = b.unit.hunks.map((h) => h.id);
        const own = raised && b.unit.hunks.some(raised.owner);
        answer = { version: "find-1", change_id: f.change.id, unit: b.unit.id, examined: ids, analysis: ids.map((hunk) => ({ hunk, changed: "Values changed.", could_break: "Unsafe inputs." })), candidates: own ? [{ ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 1, quote: raised!.quote }] }] : [] } satisfies FindAnswer;
      } else {
        batches.push(b.batch!);
        answer = { version: "verify-1", change_id: f.change.id, verdicts: b.batch!.candidates.map((c) => verdict(c)) };
      }
      return { finalText: JSON.stringify(answer), calls: [], failure: null, sessionId: null, usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: 0 } };
    } }),
  });
  return { result, batches, finders };
}

it("R5.1 credits nothing of a non-UTF-8 long line to a Read, through the snapshot's line counter", () => {
  const f = fixture(["a.txt"]);
  // 0xe9 alone is not UTF-8, so the snapshot holds the file as bytes.
  const line = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("x".repeat(9_996))]);
  writeFileSync(join(f.dir, "a.txt"), Buffer.concat([Buffer.from("one\n"), line, Buffer.from("\n")]));
  const h = { path: "a.txt", start: 1, end: 2, deletion: false };
  const trace = [{ tool: "Read", path: "a.txt", range: [1, 2] as [number, number], inside: true, ok: true, byteRanges: [{ line: 2, from: 1, to: 2000 }] }];
  const coverage = readCoverage({ change: f.change, obligations: [h], lineCount: lineCounter(f.dir), trace });
  expect(coverage.unread).toContainEqual(expect.objectContaining({ start: 2, end: 2, lineBytes: 10_000, fragment: { from: 1, to: 10_000 } }));
});

it("R5.2 sends the context after a long line once across all its parts", () => {
  const f = fixture(["a.txt"]);
  const total = 20 * 1024 * 1024;
  const rows = Array.from({ length: 10 }, (_, i) => i === 4 ? "z".repeat(total) : `row ${i + 1}`);
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  const part = total / 4;
  let unread: HunkRef[] = Array.from({ length: 4 }, (_, i) => ({ id: `h${i + 1}`, path: "a.txt", start: 5, end: 5, deletion: false, lineBytes: total, fragment: { of: `h${i + 1}`, from: i * part + 1, to: (i + 1) * part } }));
  const earlier: HunkRef[] = [];
  const texts: string[] = [];
  for (let round = 0; round < 100 && unread.length; round++) {
    const page = deliverRanges({ snapshotDir: f.dir, change: f.change, secrets: [], unread, earlier });
    texts.push(page.text);
    earlier.push(...(page.delivered as HunkRef[]));
    unread = page.left as HunkRef[];
  }
  expect(unread).toEqual([]);
  const after = texts.flatMap((t) => t.split("\n")).filter((r) => r.includes("context after it"));
  expect(after).toEqual(["a.txt: line 5, context after it (6 to 8):"]);
}, 60_000);

it("R5.3 never sends a long line's heading without a fragment when its path is 1,000 bytes", () => {
  // macOS caps a whole path at 1,024 bytes, so the base folder is short.
  const base = mkdtempSync("/tmp/oq5-");
  try {
    const dir = Array.from({ length: 6 }, (_, i) => `${i}`.padEnd(160, "d")).join("/");
    const path = `${dir}/${"a".repeat(30)}.txt`;
    expect(Buffer.byteLength(path)).toBe(1000);
    mkdirSync(join(base, dir), { recursive: true });
    const total = 600 * 1024;
    writeFileSync(join(base, path), `${"x".repeat(total)}\nshort\n${"y".repeat(total)}\n`);
    const part = (to: number): HunkRef => ({ id: "h1", path, start: 1, end: 1, deletion: false, lineBytes: total, fragment: { of: "h1", from: 1, to } });
    const page = (unread: HunkRef[]) => deliverRanges({ snapshotDir: base, secrets: [], unread }).text;
    // Line 1's part sets the bytes left when line 3's heading is written. The
    // sweep crosses the band where a heading fits but its first row does not.
    const heading = Buffer.byteLength(`${path}: line 3, in byte fragments:`) + 1;
    const row = Buffer.byteLength(fragmentLabel(path, 3, 1, 2000, total)) + 1 + 2000 + 1;
    const n = 170;
    const left = 512 * 1024 - Buffer.byteLength(page([part(n * 2000)])) - 2;
    let sent = 0;
    let waited = 0;
    for (let k = 1; k <= 2000; k++) {
      const after = left - Buffer.byteLength(fragmentLabel(path, 1, n * 2000 + 1, n * 2000 + k, total)) - k - 2;
      if (after < heading + row - 1100 || after > heading + row + 40) continue;
      const rows = page([part(n * 2000 + k), { id: "h2", path, start: 3, end: 3, deletion: false }]).split("\n");
      const at = rows.findIndex((r) => r.startsWith(`${path}: line 3, in byte fragments`));
      if (at === -1) { waited++; continue; }
      // Context rows may sit between the heading and the first fragment.
      expect(rows.slice(at + 1).find((r) => !/^\d+\t/.test(r)), `k=${k}`).toBe(`${fragmentLabel(path, 3, 1, 2000, total)}\t${"y".repeat(2000)}`);
      sent++;
    }
    expect(sent).toBeGreaterThan(0);
    expect(waited).toBeGreaterThan(0);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

it("R5.4 verifies a quote in the first fragment of part 3 of a 1 MB line with part 3 only", async () => {
  const quote = "the planted unsafe operation";
  const size = 1024 * 1024;
  const probe = fixture(["a.txt"]);
  writeFileSync(join(probe.dir, "a.txt"), "f".repeat(size) + "\n");
  probe.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${"f".repeat(size)}\n` }];
  const third = obligations(probe.change, fragmentSnapshotText(probe.dir)).find((h) => h.part?.n === 3)!;
  const at = third.fragment!.from - 1 + 10;
  const text = "f".repeat(at) + quote + "f".repeat(size - at - quote.length);
  const f = fixture(["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${text}\n` }];
  const instructions = "Repository convention.\n".repeat(1500);
  const { result, batches } = await staged(f, instructions, { owner: (h) => h.fragment!.from <= at + 1 && h.fragment!.to >= at + 1, quote });
  expect(result.missing.filter((m) => m.includes("not verified"))).toEqual([]);
  expect(batches).toHaveLength(1);
  const inventory = batches[0]!.hunks;
  const shown = inventory.filter((h) => batches[0]!.shown!.includes(h.id));
  expect(shown).toHaveLength(1);
  expect(shown[0]!.fragment!.from).toBe(third.fragment!.from);
  expect(result.report.findings).toHaveLength(1);
}, 120_000);

it("R5.5 selects the part of a 200 KB quote on a 20 MB line with small comparisons, in under a second", () => {
  const f = fixture(["a.txt"]);
  const quote = Array.from({ length: 20_000 }, (_, i) => `q${i}`.padEnd(10, "-")).join("");
  const at = 9 * 1024 * 1024 + 777;
  const text = "z".repeat(at) + quote + "z".repeat(20 * 1024 * 1024 - at - quote.length);
  writeFileSync(join(f.dir, "a.txt"), text + "\n");
  const patch = join(f.dir, "patch");
  writeFileSync(patch, `@@ -0,0 +1 @@\n+${text}\n`);
  f.change.diffs = [{ path: "a.txt", file: patch }];
  const parts = obligations(f.change, fragmentSnapshotText(f.dir));
  const cited = [{ id: "k1", kind: "finder" as const, candidate: { ...candidate("a.txt"), evidence: [{ file_path: "a.txt", line_number: 1, quote }] }, foundBy: [] }];
  let largest = 0;
  const includes = String.prototype.includes;
  const indexOf = String.prototype.indexOf;
  String.prototype.includes = function (this: string, ...args: Parameters<typeof includes>) { largest = Math.max(largest, this.length); return includes.apply(this, args); };
  String.prototype.indexOf = function (this: string, ...args: Parameters<typeof indexOf>) { largest = Math.max(largest, this.length); return indexOf.apply(this, args); };
  const started = performance.now();
  let own: HunkRef[];
  try { own = parts.filter((h) => verifyPartDistance(h, cited, f.change) === 0); }
  finally { String.prototype.includes = includes; String.prototype.indexOf = indexOf; }
  const ms = performance.now() - started;
  console.log(`R5.5 ${ms.toFixed(0)} ms, largest comparison string ${largest}`);
  expect(own).toHaveLength(1);
  expect(own[0]!.fragment!.from).toBeLessThanOrEqual(at + 1);
  expect(own[0]!.fragment!.to).toBeGreaterThanOrEqual(at + 1);
  expect(largest).toBeLessThan(20 * 1024);
  expect(ms).toBeLessThan(1000);
}, 60_000);

it("R5.6 rejects a citation past the end of the file beside a long line", () => {
  const f = fixture(["a.txt"]);
  const rows = Array.from({ length: 10 }, (_, i) => i === 8 ? "l".repeat(300 * 1024) : `row ${i + 1}`);
  writeFileSync(join(f.dir, "a.txt"), rows.join("\n") + "\n");
  const read = fragmentSnapshotText(f.dir);
  expect(checkEvidence({ file_path: "a.txt", line_number: 11, quote: "row 10" }, read, f.change)).toMatch(/past the end of the file/);
  expect(checkEvidence({ file_path: "a.txt", line_number: 10, quote: "row 10" }, read, f.change)).toBeNull();
});

it("R5.7 reads a 20 MB cited line once for fifty citations of it", () => {
  const f = fixture(["a.txt"]);
  const words = Array.from({ length: 51 }, (_, i) => `needle number ${i} here`);
  const long = words.map((w) => w + "z".repeat(400 * 1024)).join("");
  writeFileSync(join(f.dir, "a.txt"), `above\n${long}\nbelow\n`);
  f.change.coverage.set("a.txt", makeLineSet([1, 2, 3]));
  const read = fragmentSnapshotText(f.dir);
  const unit: ReviewUnit = { id: "u1", files: ["a.txt"], hunks: [{ id: "h1", path: "a.txt", start: 1, end: 3, deletion: false }], diffBytes: 0 };
  const candidates = Array.from({ length: 17 }, (_, i) => ({ ...candidate("a.txt"), line_number: 2, evidence: [0, 1, 2].map((k) => ({ file_path: "a.txt", line_number: 2, quote: words[i * 3 + k]! })) }));
  const answer = { version: "find-1", change_id: f.change.id, unit: "u1", examined: ["h1"], analysis: [{ hunk: "h1", changed: "Values changed.", could_break: "Unsafe inputs." }], candidates };
  // The line index reads the file once; only the reads after it are counted.
  expect(read.longLines!("a.txt", 1, 3)).toHaveLength(1);
  const before = snapshotReads.bytes;
  const checked = checkFindAnswer(answer, unit, f.change, read);
  const bytes = snapshotReads.bytes - before;
  console.log(`R5.7 read ${bytes} snapshot bytes for 51 citations of a ${long.length} byte line`);
  expect(checked.rejected).toEqual([]);
  expect(bytes).toBeLessThan(1.5 * long.length);
}, 60_000);

it("R5.8 starts no finder session for a unit whose brief holds only a note", async () => {
  const f = fixture(["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "x".repeat(1024 * 1024) + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${"x".repeat(1024 * 1024)}\n` }];
  // About 250 KB of instructions put the fixed blocks within 3 KB under the bound:
  // no fragment fits beside them, but the note-only brief does.
  const { result, finders } = await staged(f, "r".repeat(250 * 1024));
  expect(finders).toBe(0);
  const notes = (result.report.notes ?? []).filter((n) => n.includes("MAX_BRIEF_BYTES"));
  expect(notes).toHaveLength(1);
}, 120_000);

it("R5.9 names a noted fragment entry by its fragment label", async () => {
  const f = fixture(["a.txt"]);
  writeFileSync(join(f.dir, "a.txt"), "x".repeat(1024 * 1024) + "\n");
  f.change.diffs = [{ path: "a.txt", text: `@@ -0,0 +1 @@\n+${"x".repeat(1024 * 1024)}\n` }];
  const { result } = await staged(f, "r".repeat(254 * 1024));
  const notes = (result.report.notes ?? []).filter((n) => n.includes("MAX_BRIEF_BYTES"));
  expect(notes).toEqual(["h1 a.txt: line 1, bytes 1 to 1,048,576 of 1,048,576: The fixed blocks of this file's finder briefs exceed MAX_BRIEF_BYTES alone, so no fragment of this line fits a brief. It remains unread unless paged or read."]);
}, 120_000);

it("R5.10 sends a 1,500-byte Windows-1252 line whole in the single-pass brief", () => {
  const f = fixture(["a.txt"]);
  // 300 bytes of 0xe9 decode to 900 bytes, so the decoded row is 2,100 bytes.
  const line = Buffer.concat([Buffer.from("x".repeat(1200)), Buffer.alloc(300, 0xe9)]);
  writeFileSync(join(f.dir, "a.txt"), Buffer.concat([line, Buffer.from("\n")]));
  f.change.coverage.set("a.txt", makeLineSet([1]));
  const decoded = line.toString("utf8");
  expect(Buffer.byteLength(decoded)).toBe(2100);
  f.change.diffs = [{ path: "a.txt", text: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+${decoded}\n` }];
  const brief = buildReviewerBrief({ change: f.change, scan: f.scan, lenses: [], config: f.config, secrets: [], byteLines: (path, from, to) => snapshotByteLines(f.dir, path, from, to) }).text.split("\n");
  expect(brief.filter((r) => r.includes("bytes 1 to"))).toEqual([]);
  expect(brief).toContain(`+${decoded}`);
});

it("R5.11 keeps hunkRefs from registering a list, so an inventory with secrets can follow", () => {
  const f = fixture(["a.txt"]);
  hunkRefs(f.change);
  expect(registeredSecrets(f.change)).toBeUndefined();
  const list = ["SECRET12345678901234"];
  obligations(f.change, fragmentSnapshotText(f.dir), stagedDiffCache(f.change, list));
  expect(registeredSecrets(f.change)).toBe(list);
});
