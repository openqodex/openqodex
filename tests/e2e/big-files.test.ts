// Failures guarded:
// 1. A 6 MB snapshot file cannot be paged or supply evidence at line 100,000.
// 2. Equal size and mtime hide a content change, or read_file refuses its lines.
import { closeSync, openSync, readFileSync, readSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { CompletionRecord } from "@openqodex/core";
import "./global-setup.js";
import { baseline, git, readJson, report, reportDir, run, stagedProviderEnv } from "./support.js";
import { hashSnapshot } from "../../packages/review/src/snapshot.js";
import { runTool } from "../../packages/review/src/tools/index.js";
import { fixture, cleanupFixtures } from "../../packages/review/test/staged-fixture.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);
afterAll(cleanupFixtures);
it("7p pages a 6 MB file and accepts its evidence at line 100,000", async () => {
  const dir = baseline();
  const path = join(dir, "big.txt");
  const fd = openSync(path, "w");
  try {
    const chunk = Buffer.from(`${"x".repeat(62)}\n`.repeat(1000));
    for (let n = 0; n < 100; n++) writeSync(fd, chunk);
  } finally { closeSync(fd); }
  git(dir, "add", "big.txt");
  git(dir, "commit", "-qm", "Large baseline");
  const edit = openSync(path, "r+");
  try {
    // 4,000 changed rows exceed the file's brief allowance and take pages.
    for (let n = 96_001; n <= 100_000; n++) {
      const text = n === 100_000 ? `unsafe operation${" ".repeat(46)}\n` : `${"y".repeat(62)}\n`;
      writeSync(edit, Buffer.from(text), 0, 63, (n - 1) * 63);
    }
  } finally { closeSync(edit); }
  const env = stagedProviderEnv();
  const provider = env.PATH!.split(delimiter)[0]!;
  const template = { severity: "major", category: "bug", file_path: "big.txt", line_number: 100_000, line_end: 100_000, title: "Unsafe large file operation", problem: "The operation accepts unsafe inputs.", consequence: "The affected path can fail.", fix: "Validate inputs before this operation." };
  writeFileSync(join(provider, "find-answers.json"), JSON.stringify({ "big.txt": [template] }));
  const result = run("big-file", dir, ["review", "--reviewer", "claude", "--offline", "--no-install", "--no-color"], { env });
  expect(result.status, result.stderr).toBe(0);
  const saved = report(dir);
  expect((saved.completion as CompletionRecord).status).toBe("complete");
  expect(saved.findings).toContainEqual(expect.objectContaining({ file_path: "big.txt", line_number: 100_000 }));
  const rounds = readJson<{ delivered: { path: string; start: number; end: number }[] }[]>(join(reportDir(dir), "rounds.json"));
  expect(rounds.some((r) => r.delivered.some((h) => h.path === "big.txt" && h.start <= 100_000 && h.end >= 100_000))).toBe(true);
  const { change } = fixture();
  const reportedSnapshot = readFileSync(join(provider, "snapshot-path"), "utf8").trim();
  expect(reportedSnapshot).not.toBe(dir);
  // The run removes its live snapshot. The provider retains the snapshot
  // it was given, as in redaction-brief.test.ts, for checks after cleanup.
  const snapshotDir = join(provider, "snapshot");
  const tool = await runTool({ snapshotDir, change, secrets: [], graph: null, graphNote: null }, "read_file", { path: "big.txt", start: 100_000, lines: 1 });
  expect(tool).toMatchObject({ ok: true, range: [100_000, 100_000] });
  expect(tool.text).toBe(`big.txt lines 100000 to 100000 of 100000\n100000\tunsafe operation${" ".repeat(46)}`);
  const copy = tempDir("oq-large-hash-");
  const copyPath = join(copy, "big.txt");
  const original = openSync(path, "r");
  const target = openSync(copyPath, "w");
  try {
    // Copy in bounded chunks, then alter a byte without altering size or mtime.
    const chunk = Buffer.alloc(64 * 1024);
    for (let n = readSync(original, chunk); n > 0; n = readSync(original, chunk)) writeSync(target, chunk, 0, n);
  } finally { closeSync(original); closeSync(target); }
  utimesSync(copyPath, 1000, 1000);
  const before = hashSnapshot(copy);
  const alter = openSync(copyPath, "r+");
  try { writeSync(alter, Buffer.from("z"), 0, 1, 0); } finally { closeSync(alter); }
  utimesSync(copyPath, 1000, 1000);
  expect(hashSnapshot(copy)).not.toBe(before);
}, 300_000);
