// Each test guards the numbered failure in golden/FAILURES.md.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { normalize, normalizedLastReview, normalizedSnapshotHash, snapshotHash } from "./golden/normalize.mjs";
import { compareTrees } from "./golden/check.mjs";
import { fixDemoSecret } from "./golden/fixture-secret.mjs";
import { answerText } from "./golden/answer.mjs";
import { removeTempDirs, tempDir } from "./temp-dirs.mjs";

afterAll(removeTempDirs);
const context = { home: "/tmp/home", demo: "/tmp/demo", snapshot: "/tmp/home/checkouts/work-abc/tree", runId: "20261009-120000-abcdefabcdef", repoId: "a".repeat(64), pid: 1234 };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("1. keeps findings, ids, contracts, coverage, receipt kinds and brief text", () => {
  const text = JSON.stringify({ change_id: "b".repeat(64), candidate: "c1", contract: "openqodex-review-2", coverage: { covered: 4 }, kind: "complete", problem: "Wait 1234 ms on 2026-10-09T12:00:00.000Z." });
  expect(normalize("report.json", text, context)).toBe(text);
  const brief = "Raise c1. Budget 1234 ms. Date 2026-10-09T12:00:00.000Z.\n";
  expect(normalize("brief.md", brief, context)).toBe(brief);
});

it("2. replaces only the approved variable fields and their rendered forms", () => {
  const text = '{"created_at":"2026-10-09T12:00:00.000Z","written_at":1791547200000,"durationMs":42,"reviewer":{"pid":1234},"dir":"/tmp/demo/.openqodex/reviews/20261009-120000-abcdefabcdef"}';
  expect(normalize("report.json", text, context)).toBe('{"created_at":"<TIMESTAMP>","written_at":"<TIMESTAMP>","durationMs":"<DURATION_MS>","reviewer":{"pid":"<REVIEWER_PID>"},"dir":"<DEMO>/.openqodex/reviews/<RUN_ID>"}');
  expect(normalize("stderr.txt", "Reviewer: claude 2.1.289 started (process 1234)\n", context)).toContain("(process <REVIEWER_PID>)");
  expect(normalize("trace.json", `{"path":"${context.snapshot}/app/config.py"}`, context)).toContain("<SNAPSHOT>/app/config.py");
  expect(normalize("report.json", '{"generated_at":"2026-10-09T12:00:00.000Z"}', context)).toContain('"<TIMESTAMP>"');
  expect(normalize("report.html", '<dt>Generated</dt><dd>2026-10-09 12:00 UTC</dd>', context)).toBe('<dt>Generated</dt><dd><TIMESTAMP></dd>');
});

it("3. refuses a last-review hash that does not match the raw report", () => {
  expect(() => normalizedLastReview('{"report_sha256":"bad"}', "{}\n", "{}\n", context)).toThrow(/raw report hash/);
});

it("4. records the hash of the normalised report after verifying the raw hash", () => {
  const raw = '{"durationMs":42}\n';
  const normalized = normalize("report.json", raw, context);
  const receipt = normalizedLastReview(JSON.stringify({ report_sha256: hash(raw) }), raw, normalized, context);
  expect(JSON.parse(receipt).report_sha256).toBe(hash(normalized));
});

it("5. reports missing, extra and changed files with a unified diff and line", () => {
  const expected = tempDir("oq-golden-expected-");
  const actual = tempDir("oq-golden-actual-");
  writeFileSync(join(expected, "brief.md"), "first\noriginal\n");
  writeFileSync(join(actual, "brief.md"), "first\nedited\n");
  writeFileSync(join(expected, "missing.txt"), "missing\n");
  writeFileSync(join(actual, "extra.txt"), "extra\n");
  const result = compareTrees(expected, actual);
  expect(result.files).toBe(3);
  expect(result.differences).toBe(3);
  expect(result.changed).toEqual(["brief.md", "extra.txt", "missing.txt"]);
  expect(result.diff).toContain("expected/brief.md");
  expect(result.diff).toContain("@@ -1,2 +1,2 @@");
  expect(result.diff).toContain("-original\n+edited");
  expect(result.diff).toContain("missing.txt");
  expect(result.diff).toContain("extra.txt");
});

it("6. replaces the generated secret in every demo file that holds it", () => {
  const demo = tempDir("oq-golden-secret-");
  mkdirSync(join(demo, "app"));
  const secret = "sk_" + "live_" + "123456789012345678901234";
  writeFileSync(join(demo, "app/config.py"), `KEY = "${secret}"\n`);
  writeFileSync(join(demo, "copy.txt"), `${secret}\n${secret}\n`);
  const result = fixDemoSecret(demo);
  expect(result.files).toEqual(["app/config.py", "copy.txt"]);
  expect(result.replacements).toBe(3);
});

it("10. replaces the graph's generation, build, stage and predicted times and heartbeat lines, and keeps the rest", () => {
  const generation = "0mv1cli160000-5qw-092d5271";
  const ctx = { ...context, generation };
  const graphLine = (seconds: string) => `Built on this machine from 4 files of 4 eligible files in ${seconds} s, fresh from cached facts; 6 call sites in the repository could not be bound.\n`;
  expect(normalize("brief.md", graphLine("0.2"), ctx)).toBe(graphLine("<SECONDS>"));
  expect(normalize("brief.md", graphLine("1.0"), ctx)).toBe(normalize("brief.md", graphLine("0.2"), ctx));
  const status = JSON.stringify({ generation, durationMs: 41, predictedMs: 120, stages: { parse: 12, facts: 3 }, mode: "fresh", parses: 5 }, null, 2);
  expect(JSON.parse(normalize("status.json", status, ctx))).toEqual({ generation: "<GRAPH_GENERATION>", durationMs: "<DURATION_MS>", predictedMs: "<DURATION_MS>", stages: { parse: "<DURATION_MS>", facts: "<DURATION_MS>" }, mode: "fresh", parses: 5 });
  expect(normalize("status.json", '{"predictedMs": null}', ctx)).toBe('{"predictedMs": null}');
  const stderr = "Code graph: 4 files in 0.3 s (5 parsed, 0 from cache, fresh)\nReviewer still working: 15 s\nReport: x\n";
  expect(normalize("stderr.txt", stderr, ctx)).toBe("Code graph: 4 files in <SECONDS> s (5 parsed, 0 from cache, fresh)\nReport: x\n");
  expect(normalize("report.md", "Reviewer: codex 0.160.0, 4 s, 1 turn\n| semgrep | ran | 1.94.0 | 10 | 9 | 3.4 s |  |\n", ctx)).toBe("Reviewer: codex 0.160.0, <SECONDS> s, 1 turn\n| semgrep | ran | 1.94.0 | 10 | 9 | <SECONDS> s |  |\n");
  expect(normalize("report.html", "Built on this machine from the call graph of 4 files in 0.2 s; 6 call sites", ctx)).toBe("Built on this machine from the call graph of 4 files in <SECONDS> s; 6 call sites");
});

function snapshotDir(files: Record<string, string>): string {
  const dir = tempDir("oq-golden-snapshot-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

it("11. records one snapshot hash for identical runs, refuses a raw hash that does not match, and changes with a file", () => {
  const status = (ms: number, generation: string) => JSON.stringify({ generation, durationMs: ms, stages: { parse: ms } }, null, 2);
  const first = snapshotDir({ "app/x.py": "print(1)\n", ".openqodex-review/graph/status.json": status(12, "gen-first") });
  const second = snapshotDir({ "app/x.py": "print(1)\n", ".openqodex-review/graph/status.json": status(99, "gen-second"), ".git/HEAD": "ref: refs/heads/main\n" });
  const changed = snapshotDir({ "app/x.py": "print(2)\n", ".openqodex-review/graph/status.json": status(12, "gen-first") });
  const rawFirst = snapshotHash(first);
  const rawSecond = snapshotHash(second);
  expect(rawFirst).not.toBe(rawSecond);
  const recorded = normalizedSnapshotHash(first, [rawFirst, rawFirst], { ...context, generation: "gen-first" });
  expect(normalizedSnapshotHash(second, [rawSecond, rawSecond], { ...context, generation: "gen-second" })).toBe(recorded);
  expect(() => normalizedSnapshotHash(first, [rawFirst, "0".repeat(64)], context)).toThrow(/does not match the snapshot/);
  expect(normalizedSnapshotHash(changed, [snapshotHash(changed)], { ...context, generation: "gen-first" })).not.toBe(recorded);
  const report = `{"snapshot": {"before": "${rawFirst}", "after": "${rawFirst}"}}`;
  expect(normalize("report.json", report, { ...context, snapshotHash: { raw: rawFirst, normalized: recorded } })).toBe(`{"snapshot": {"before": "${recorded}", "after": "${recorded}"}}`);
});

it("12. the frozen answer is the one answer.mjs makes from the recorded candidates", () => {
  const golden = (path: string) => readFileSync(new URL(`./golden/${path}`, import.meta.url), "utf8");
  const scan = JSON.parse(golden("expected/claude/run/scan.json"));
  const manifest = JSON.parse(golden("expected/claude/run/manifest.json"));
  expect(answerText(scan, manifest.change_id)).toBe(golden("stand-ins/submission.json"));
});
