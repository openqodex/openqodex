// Briefs and pages share these delivery checks.
// Ways this could fail, written before the replacement:
// 1. A 4,000-character line is omitted or a chunk is missing but coverage completes.
// 2. Splitting a removed line before redaction leaks a secret across chunks.
// 3. Two removed lines lose their separate old-file line numbers.
// 4. A line over the byte budget is counted as supplied instead of named as missing.
// 5. Chunk labels cannot be used to cite a finding on the changed line.
// 6. A correction round uses a different delivery policy from the brief.
// 7. A long line in the brief loses its diff marker, so an added line reads as context.
// 8. A context line over the byte budget keeps a short changed line beside it unsent.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cacheFolder, removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
import { deliverRanges } from "../src/conversation.js";
import { git } from "./repos.js";

afterAll(removeTempDirs);
const gitleaks = [process.env.OPENQODEX_E2E_HOME ?? cacheFolder("openqodex-e2e-home"), join(homedir(), ".openqodex")]
  .map((h) => join(h, "tools/gitleaks")).find((p) => existsSync(p));

// A stand-in edit must change the script; a missed match would test the stock stand-in.
function swap(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

function review(opts: { before?: string; after: string; secret?: string; correction?: boolean; finding?: boolean; stages?: boolean }) {
  const dir = tempDir("oq-long-cli-");
  const home = tempDir("oq-long-home-");
  const provider = tempDir("oq-long-provider-");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "README.txt"), "Base\n");
  if (opts.before) writeFileSync(join(dir, "app/server.py"), opts.before);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  writeFileSync(join(dir, "app/server.py"), opts.after);
  if (opts.correction) writeFileSync(join(dir, "a.txt"), ("x".repeat(202) + "\n").repeat(1000));
  if (opts.secret) {
    mkdirSync(join(home, "tools"));
    cpSync(gitleaks!, join(home, "tools/gitleaks"), { recursive: true });
    writeFileSync(join(dir, "key.txt"), `STRIPE_KEY = "${opts.secret}"\n`);
  }
  let source = readFileSync(resolve("tests/golden/stand-ins/codex.cjs"), "utf8");
  source = swap(source, 'const frozen = JSON.parse(readFileSync(join(folder, "submission.json"), "utf8"));', 'const frozen = { findings: [] };');
  source = swap(source, 'const answer = answerForPrompt(prompt);', `const input = prompt;
    const briefPath = join(folder, "first-input");
    if (!existsSync(briefPath)) writeFileSync(briefPath, input);
    const brief = readFileSync(briefPath, "utf8");
    const transcript = join(folder, "context");
    writeFileSync(transcript, (existsSync(transcript) ? readFileSync(transcript, "utf8") : "") + input);
    const dropped = [...brief.matchAll(/^- (c\\d+) \\[[^\\]]+\\] ([^:]+):(\\d+) /gm)].map((m) => ({ candidate: m[1], reason: "The key is a test fixture.", file_path: m[2], line_number: Number(m[3]) }));
    const findings = ${opts.finding ? 'JSON.parse(readFileSync(join(folder, "finding.json"), "utf8"))' : '[]'};
    const answer = JSON.stringify({ version: 2, change_id: /\x60change_id\x60: \x60([0-9a-f]{12})\x60/.exec(brief)?.[1], summary: "Adds generated text.", findings, dropped });`);
  mkdirSync(join(dir, ".openqodex"));
  writeFileSync(join(dir, ".openqodex/config.yaml"), `review:\n  stages: ${opts.stages ?? false}\n${opts.finding ? "  block_on_severity: critical\n" : ""}`);
  if (opts.finding) writeFileSync(join(provider, "finding.json"), JSON.stringify([{
    severity: "critical", category: "bug", confidence: 0.9, file_path: "app/server.py", line_number: 6,
    title: "Invalid generated value", problem: "The generated value exceeds the parser limit.",
    consequence: "The parser rejects the file.", fix: "Shorten the generated value.", source: null, candidate: null, suggested_change: null,
  }]));
  if (opts.stages) {
    source = swap(readFileSync(resolve("tests/golden/stand-ins/codex.cjs"), "utf8"), 'const frozen = JSON.parse(readFileSync(join(folder, "submission.json"), "utf8"));', 'const frozen = { findings: [] };');
    source = swap(source, 'const answer = answerForPrompt(prompt);', 'writeFileSync(join(folder, "context"), (existsSync(join(folder, "context")) ? readFileSync(join(folder, "context"), "utf8") : "") + prompt); const answer = answerForPrompt(prompt);');
  }
  const executable = join(provider, "codex");
  writeFileSync(executable, `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: provider + delimiter + process.env.PATH, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0" };
  for (const key of ["CODEX_SANDBOX", "CODEX_THREAD_ID", "CLAUDECODE", "OPENQODEX_REVIEW_DEPTH"]) delete env[key as keyof typeof env];
  const out = spawnSync(process.execPath, [resolve("packages/cli/dist/bin.js"), "review", "--reviewer", "codex", "--offline", "--no-color", ...(opts.secret ? ["--only", "gitleaks"] : [])], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
  const runs = join(dir, ".openqodex/reviews");
  const run = join(runs, readdirSync(runs)[0]!);
  return { ...out, context: readFileSync(join(provider, "context"), "utf8"), brief: readFileSync(join(run, "brief.md"), "utf8"), report: JSON.parse(readFileSync(join(run, "report.json"), "utf8")), rounds: readFileSync(join(run, "rounds.json"), "utf8") };
}

function parts(text: string, label: string): string[] {
  return text.split("\n").filter((row) => row.replace(/^[+ -]/, "").startsWith(`${label}, bytes `)).map((row) => row.slice(row.indexOf("\t") + 1));
}

it.each([false, true])("a 4,000-character line counts only with every part delivered, correction %s", (correction) => {
  const line = "x".repeat(2000) + "y".repeat(2000);
  const r = review({ after: line + "\n", correction });
  expect(r.status, r.stderr).toBe(0);
  expect(r.report.completion.status).toBe("complete");
  expect(parts(correction ? r.context : r.brief, "app/server.py: line 1").join("")).toBe(line);
  if (correction) expect(r.rounds).toContain("app/server.py");
  else expect(r.brief).toContain("+app/server.py: line 1, bytes 1 to 2,000 of 4,000\t");
}, 120_000);

it.skipIf(!gitleaks).each([false, true])("a secret crossing a removed line chunk boundary is redacted in every part, correction %s", (correction) => {
  const secret = ["sk", "live", "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQR"].join("_");
  const line = "z".repeat(1995) + secret + "y".repeat(2100);
  const r = review({ before: "keep\n" + line + "\nend\n", after: "keep\nend\n", secret, correction });
  expect(r.status, r.stderr).toBe(0);
  expect(r.context).not.toContain(secret);
  expect(parts(correction ? r.context : r.brief, "app/server.py: old line 2").join("")).toBe(line.replace(secret, "[redacted]"));
}, 120_000);

it.each([false, true])("two long removed lines keep separate old-file line numbers, correction %s", (correction) => {
  const first = "a".repeat(4000);
  const second = "b".repeat(4000);
  const r = review({ before: `keep\n${first}\n${second}\nend\n`, after: "keep\nend\n", correction });
  expect(r.status, r.stderr).toBe(0);
  expect(parts(correction ? r.context : r.brief, "app/server.py: old line 2").join("")).toBe(first);
  expect(parts(correction ? r.context : r.brief, "app/server.py: old line 3").join("")).toBe(second);
}, 120_000);

it("lines over the legacy brief budget reach the reviewer on a page", () => {
  const r = review({ after: "x".repeat(220_000) + "\n" + "y".repeat(220_000) + "\n" });
  expect(r.status, r.stderr).toBe(0);
  expect(r.report.completion.status).toBe("complete");
  expect(r.report.completion.coverage.unread).toEqual([]);
  expect(r.report.completion.coverage.given).toContainEqual(expect.objectContaining({ by: "page", fragment: expect.objectContaining({ from: 1 }) }));
}, 120_000);

it("chunk line numbers let the reviewer cite a finding on the changed line", () => {
  const r = review({ after: "short\n".repeat(5) + "x".repeat(4000) + "\n", finding: true });
  expect(r.status, r.stderr).toBe(1);
  expect(r.brief).toContain("app/server.py: line 6, bytes 2,001 to 4,000 of 4,000");
  expect(r.report.findings[0].line_number).toBe(6);
  expect(r.report.completion.status).toBe("complete");
}, 120_000);

it("a context line over the byte budget is marked as not shown and the changed lines beside it still go", () => {
  const snapshotDir = tempDir("oq-long-context-");
  writeFileSync(join(snapshotDir, "app.js"), `${"a".repeat(600_000)}\nchanged\nkept\n`);
  const deletion = { path: "app.js", start: 1, end: 2, deletion: true };
  const change = { files: [{ path: "app.js", status: "modified" as const, oldPath: null, binary: false }], deletionPoints: new Map([["app.js", [{ after: 1, lines: 1, anchors: [1, 2] }]]]), diffs: [{ path: "app.js", text: "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -2,2 +2,1 @@\n-gone\n changed\n" }] };
  const r = deliverRanges({ snapshotDir, unread: [{ path: "app.js", start: 2, end: 2, deletion: false }, deletion], secrets: [], change });
  expect(r.delivered).toEqual([{ path: "app.js", start: 2, end: 2, deletion: false }, deletion]);
  expect(r.text).toContain("1\t(not shown: a context line over 512 KB)");
  expect(r.text).toContain("2\tchanged");
  expect(r.text).not.toContain("a".repeat(2001));
});


it("R2.12 completes a one MB line with stages enabled", () => {
  const r = review({ after: "x".repeat(1024 * 1024) + "\n", stages: true });
  expect(r.status, r.stderr).toBe(0);
  expect(r.report.completion.status).toBe("complete");
  expect(r.report.completion.coverage.given).toContainEqual(expect.objectContaining({ by: "brief", fragment: expect.objectContaining({ from: 1, to: 1024 * 1024 }) }));
}, 120_000);
