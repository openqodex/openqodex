// Failures guarded:
// 1. A 65 MB file is removed, or a secret across a chunk boundary survives.
// 2. Streaming replacement changes line numbers or corrupts binary bytes.
// 3. Oversized context prevents delivery of a neighbouring changed line.
// 4. A final newline invents an extra context row.
// 5. Redaction applies the umask instead of retaining the original mode.
// 6. Redaction reports removed files even though it never removes them.
// 7. A window no round can carry is promised after a partially filled round.
// 8. A long source name makes the redaction temporary name too long.
// 10. A page loses its mid-line byte cursor or credits a partial line.
// 9. A window that fits a full page loses its next round after this round fills.
import { chmodSync, closeSync, openSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { deliverRanges, redactSnapshot } from "../src/conversation.js";
import { readLines } from "../src/snapshot.js";
import { completionRecord, readCoverage } from "@openqodex/core";
import { makeChange } from "../../core/src/test-fixtures.js";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
it("7q keeps and redacts a 65 MB file with a secret across a chunk boundary", () => {
  const dir = tempDir("oq-large-redact-");
  const path = join(dir, "big.txt");
  const secret = "synthetic-secret-across-chunks";
  const fd = openSync(path, "w");
  try {
    const chunk = Buffer.alloc(64 * 1024, 97);
    for (let n = 0; n < 1040; n++) writeSync(fd, chunk);
    writeSync(fd, Buffer.from(secret), 0, secret.length, 64 * 1024 - 7);
  } finally { closeSync(fd); }
  expect(redactSnapshot(dir, [secret])).toEqual({ redacted: 1, named: 0 });
  expect(statSync(path).size).toBe(65 * 1024 * 1024 - secret.length + 10);
  const check = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(40);
    readSync(check, bytes, 0, bytes.length, 64 * 1024 - 7);
    expect(bytes.toString()).toBe(`[redacted]${"a".repeat(30)}`);
  } finally { closeSync(check); }
  expect(redactSnapshot(dir, [secret]).redacted).toBe(0);
});
it("keeps line breaks and overwrites binary secrets across chunk boundaries", () => {
  const dir = tempDir("oq-redact-");
  writeFileSync(join(dir, "text"), "before\nalpha-secret\nbeta-secret\nafter\n");
  const bytes = Buffer.alloc(64 * 1024 + 30, 0);
  bytes.write("alpha-secret", 64 * 1024 - 3);
  writeFileSync(join(dir, "binary"), bytes);
  expect(redactSnapshot(dir, ["alpha-secret\nbeta-secret"]).redacted).toBe(2);
  const fd = openSync(join(dir, "binary"), "r");
  try {
    const masked = Buffer.alloc(12);
    readSync(fd, masked, 0, masked.length, 64 * 1024 - 3);
    expect(masked.toString()).toBe("x".repeat(12));
  } finally { closeSync(fd); }
  expect(readLines(dir, "text", 1, 4)).toBe("before\n[redacted]\n[redacted]\nafter\n");
});

it("delivers a changed line beside a 3 MB context line marked not shown", () => {
  const dir = tempDir("oq-wide-context-");
  writeFileSync(join(dir, "a.txt"), `${"x".repeat(3 * 1024 * 1024)}\nchanged\n`);
  const unread = [{ path: "a.txt", start: 2, end: 2, deletion: false }];
  const page = deliverRanges({ snapshotDir: dir, unread, secrets: [] });
  expect(page.delivered).toEqual(unread);
  expect(page.left).toEqual([]);
  expect(page.text).toContain("1\t(not shown: a context line over");
  expect(page.text).toContain("2\tchanged");
});

it("ends context at the last actual line when a file ends in a newline", () => {
  const dir = tempDir("oq-context-end-");
  writeFileSync(join(dir, "a.txt"), "first\nchanged\n");
  const page = deliverRanges({ snapshotDir: dir, unread: [{ path: "a.txt", start: 2, end: 2, deletion: false }], secrets: [] });
  expect(page.text).toBe("a.txt lines 2 to 2 (with context 1 to 2):\n1\tfirst\n2\tchanged");
});

it("preserves the original mode when redacting under a restrictive umask", () => {
  const dir = tempDir("oq-mode-redact-");
  const path = join(dir, "executable");
  writeFileSync(path, "synthetic-secret\n");
  chmodSync(path, 0o751);
  const oldMask = process.umask(0o077);
  try { expect(redactSnapshot(dir, ["synthetic-secret"]).redacted).toBe(1); }
  finally { process.umask(oldMask); }
  expect(statSync(path).mode & 0o777).toBe(0o751);
});

it("reports redacted and named files without a dead removed list", () => {
  const dir = tempDir("oq-redact-result-");
  expect(redactSnapshot(dir, [])).toEqual({ redacted: 0, named: 0 });
});

it("uses the remaining page for fragments when wide context cannot fit", () => {
  const dir = tempDir("oq-impossible-page-");
  // The first line leaves about 100 KB, too little for the 150 KB line.
  writeFileSync(join(dir, "first.txt"), `${"a".repeat(400 * 1024)}\n`);
  writeFileSync(join(dir, "wide.txt"), `${"b".repeat(150 * 1024)}\n`.repeat(7));
  const first = { path: "first.txt", start: 1, end: 1, deletion: false };
  const impossible = { path: "wide.txt", start: 4, end: 4, deletion: false };
  const page = deliverRanges({ snapshotDir: dir, unread: [first, impossible], secrets: [] });
  // A line under the page bound goes whole with its context; no id is invented.
  expect(page.delivered[0]).toEqual(first);
  expect(page.text.split("\n")[0]).toBe("first.txt lines 1 to 1 (with context 1 to 1):");
  expect(page.delivered[1]).toMatchObject({ path: "wide.txt", start: 4, end: 4, fragment: { from: 1 } });
  expect(page.left[0]!.fromByte).toBe(page.delivered[1]!.fragment!.to + 1);
  expect(page.later).toBe(1);
  const next = deliverRanges({ snapshotDir: dir, unread: page.left, earlier: page.delivered, secrets: [] });
  expect(next.left).toEqual([]);
  expect(next.delivered[0]!.fragment!.to).toBe(150 * 1024);
});

it("defers a window that fits a full page but not this round's remaining room", () => {
  const dir = tempDir("oq-deferred-page-");
  // A 500,000-byte line goes as fragments and leaves about 10 KB of the page.
  // The next window of seven 2,000-byte lines then needs about 14 KB.
  writeFileSync(join(dir, "first.txt"), `${"a".repeat(500_000)}\n`);
  writeFileSync(join(dir, "next.txt"), `${"b".repeat(2000)}\n`.repeat(7));
  const first = { path: "first.txt", start: 1, end: 1, deletion: false };
  const next = { path: "next.txt", start: 4, end: 4, deletion: false };
  const page = deliverRanges({ snapshotDir: dir, unread: [first, next], secrets: [] });
  expect(page.delivered).toEqual([first]);
  expect(page.left).toEqual([next]);
  expect(page.later).toBe(1);
  const following = deliverRanges({ snapshotDir: dir, unread: page.left, earlier: page.delivered, secrets: [] });
  expect(following.delivered).toEqual([next]);
  expect(following.left).toEqual([]);
  expect(following.later).toBe(0);
});

it("redacts a secret in a file with a 240-byte name", () => {
  const dir = tempDir("oq-long-name-");
  const name = "a".repeat(240);
  writeFileSync(join(dir, name), "before synthetic-secret after\n");
  expect(redactSnapshot(dir, ["synthetic-secret"])).toEqual({ redacted: 1, named: 0 });
  expect(readLines(dir, name, 1, 1)).toBe("before [redacted] after\n");
});

it("7m resumes the next page at fromByte after ending mid-line", () => {
  const dir = tempDir("oq-fragment-page-");
  writeFileSync(join(dir, "long.txt"), "x".repeat(1024 * 1024) + "\n");
  const unread = [{ path: "long.txt", start: 1, end: 1, deletion: false }];
  const first = deliverRanges({ snapshotDir: dir, unread, secrets: [] });
  expect(first.delivered.length).toBeGreaterThan(0);
  expect(first.left).toHaveLength(1);
  expect(first.left[0]!.fromByte).toBe(first.delivered.at(-1)!.fragment!.to + 1);
  expect(first.left[0]!.fromByte).toBeGreaterThan(1);
  const second = deliverRanges({ snapshotDir: dir, unread: first.left, earlier: first.delivered, secrets: [] });
  expect(second.delivered[0]!.fragment!.from).toBe(first.left[0]!.fromByte);
  expect(second.text).toContain(`bytes ${first.left[0]!.fromByte!.toLocaleString("en-US")} to`);
  const pages = [first, second];
  while (pages.at(-1)!.left.length) {
    const previous = pages.at(-1)!;
    pages.push(deliverRanges({ snapshotDir: dir, unread: previous.left, earlier: pages.flatMap((p) => p.delivered), secrets: [] }));
    expect(pages.length).toBeLessThan(10);
  }
  expect(pages.at(-1)!.delivered.at(-1)!.fragment!.to).toBe(1024 * 1024);
  expect(pages.every((p) => Buffer.byteLength(p.text) <= 512 * 1024)).toBe(true);
  expect(pages.map((p) => p.text).join("\n")).toContain("long.txt: line 1, bytes 1,048,001 to 1,048,576 of 1,048,576\t");
});

it("R2.16 resumes after carried bytes on a different fragment grid", () => {
  const dir = tempDir("oq-grid-");
  writeFileSync(join(dir, "a.txt"), "x".repeat(6000) + "\n");
  const h = { path: "a.txt", start: 1, end: 1, deletion: false, lineBytes: 6000, fragment: { of: "h1", from: 2001, to: 6000 } };
  const page = deliverRanges({ snapshotDir: dir, unread: [h], earlier: [{ ...h, fragment: { of: "h1", from: 1, to: 3000 } }], secrets: [] });
  expect(page.text).toContain("bytes 3,001 to 5,000 of 6,000");
  expect(page.delivered[0]!.fragment!.from).toBe(3001);
});
it("R2.10 refuses a middle fragment without crediting the line", () => {
  const dir = tempDir("oq-refuse-fragment-");
  const secret = "MIDDLESECRET123456789";
  // The line is 6,000 bytes, as lineBytes says: 2,000 + 21 + 3,979.
  writeFileSync(join(dir, "a.txt"), "x".repeat(2000) + secret + "y".repeat(3979) + "\n");
  const h = { id: "h1", path: "a.txt", start: 1, end: 1, deletion: false, lineBytes: 6000, fragment: { of: "h1", from: 2001, to: 4000 } };
  const page = deliverRanges({ snapshotDir: dir, unread: [h], secrets: [secret] });
  expect(page.leak).toBe(true);
  expect(page.delivered).toEqual([]);
  expect(page.left[0]!.fragment).toEqual(h.fragment);
  // The record names the refused fragment's bytes as missing.
  const change = makeChange({ coverage: new Map([["a.txt", makeLineSet([1])]]), deletionPoints: new Map(), files: [] });
  const whole = { ...h, fragment: { of: "h1", from: 1, to: 6000 } };
  const coverage = readCoverage({ change, obligations: [whole], briefCarried: [{ ...h, fragment: { of: "h1", from: 1, to: 2000 } }, { ...h, fragment: { of: "h1", from: 4001, to: 6000 } }], delivered: page.delivered, trace: [] });
  const reviewer = { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
  const missing = completionRecord({ change, coverage, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false }).missing;
  expect(missing).toContain("  a.txt: line 1, bytes 2,001 to 4,000 of 6,000");
});
