// Failures guarded:
// 1. A 65 MB file is removed, or a secret across a chunk boundary survives.
// 2. Streaming replacement changes line numbers or corrupts binary bytes.
// 3. Oversized context prevents delivery of a neighbouring changed line.
// 4. A final newline invents an extra context row.
// 5. Redaction applies the umask instead of retaining the original mode.
// 6. Redaction reports removed files even though it never removes them.
// 7. A window no round can carry is promised after a partially filled round.
// 8. A long source name makes the redaction temporary name too long.
// 9. A window that fits a full page loses its next round after this round fills.
import { chmodSync, closeSync, openSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { deliverRanges, redactSnapshot } from "../src/conversation.js";
import { readLines } from "../src/snapshot.js";
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

it("does not defer an impossible window when the round has only 100 KB left", () => {
  const dir = tempDir("oq-impossible-page-");
  writeFileSync(join(dir, "first.txt"), `${"a".repeat(100 * 1024)}\n`.repeat(4));
  writeFileSync(join(dir, "wide.txt"), `${"b".repeat(150 * 1024)}\n`.repeat(7));
  const first = { path: "first.txt", start: 1, end: 1, deletion: false };
  const impossible = { path: "wide.txt", start: 4, end: 4, deletion: false };
  const page = deliverRanges({ snapshotDir: dir, unread: [first, impossible], secrets: [] });
  expect(page.delivered).toEqual([first]);
  expect(page.left).toEqual([impossible]);
  expect(page.later).toBe(0);
});

it("defers a window that fits a full page but not this round's remaining room", () => {
  const dir = tempDir("oq-deferred-page-");
  writeFileSync(join(dir, "first.txt"), `${"a".repeat(100 * 1024)}\n`.repeat(4));
  writeFileSync(join(dir, "next.txt"), `${"b".repeat(30 * 1024)}\n`.repeat(7));
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
