// Failure list, written before implementation:
// 1. Control dispatch runs OpenQodex or sends its brief instead of the native command.
// 2. A native review body is shortened or rewritten into engine findings.
// 3. A sample loses command, CLI version, served model, time or cost.
// 4. Requested models or missing usage are recorded as served models, or
//    a requested model that differs from usage loses its mismatch record.
// 5. A failed native review looks complete or loses its native output.
// 6. The control is run twice under graph settings it does not use.
// 7. Settings omit the trusted Bash gate or disable it, or lose the tool fences.
// 8. Git inherits global or system config, hooks, a file monitor or SSH access.
// 9. Case titles, bodies or paths enter shell code or arguments, or lose bytes.
// 10. Repository config enables an external diff, signature verification or pager.
// 11. Status refreshes index metadata because optional locks remain enabled.
// 12. A version older than 2.1.295 accepts a hook that fails open.
// 13. Per-model or cache tokens are omitted from the control's usage totals.
// 14. Added, untracked files are omitted from the control's case paths.
// 15. A missing Claude binary rejects the probe instead of refusing the run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CONTROL_PROMPT, controlCaseData, controlEnv, controlSample, nativeReviewBody, probeControl } from "../lib/claude-control.mjs";
import { buildCase, git } from "../lib/cases.mjs";
import { claudeRunModels, laptopInvocation, planJobs } from "../lib/runner.mjs";

const job = { jobId: "planted/test@abcdef01/control-graph-off/1", caseId: "planted/test@abcdef01", case: "test", config: "control-graph-off", reviewer: "control", graph: false, repeat: 1 };
const body = "## Review\n\nKeep  all whitespace.\n```js\nthrow new Error('bug');\n```\n" + "Native detail.\n".repeat(100);
const answer = { result: body, is_error: false, modelUsage: { "served-model": { inputTokens: 42, outputTokens: 7 } }, usage: { input_tokens: 42, output_tokens: 7 }, num_turns: 3, total_cost_usd: 0.12 };
const invocation = laptopInvocation({ cli: "/built/dist/bin.js", repo: "/case", reportDir: "/sample/report", job, web: "off", timeout: 60, maxUsd: 0.8 });
const sample = (native = answer) => controlSample({ job, attempt: 1, result: { code: native.is_error ? 1 : 0, signal: null, stdout: JSON.stringify(native), stderr: "", wallMs: 1234 }, command: invocation, version: "2.1.296", startedAt: "2026-10-14T00:00:00Z" });

it("dispatches control directly to Claude Code's native review command without a brief", () => {
  expect(invocation.command).toBe("claude");
  expect(invocation.input).toBe(CONTROL_PROMPT);
  expect(CONTROL_PROMPT).toBe("/code-review medium");
  expect(invocation.args).not.toContain("/built/dist/bin.js");
  expect(invocation.args).not.toContain("--disable-slash-commands");
  expect(invocation.args).toContain("--max-budget-usd");
  expect(JSON.stringify(invocation)).not.toMatch(/brief|report-dir|scanner|graph/i);
});
it("wires the trusted Bash gate without losing the settings or tool fences", () => {
  const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
  const gate = fileURLToPath(new URL("../lib/control-gate.mjs", import.meta.url));
  expect(settings).toEqual({ autoMemoryEnabled: false, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `'${process.execPath.replaceAll("'", "'\\''")}' '${gate.replaceAll("'", "'\\''")}'`, onFailure: "block" }] }] } });
  expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
  expect(invocation.args[invocation.args.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git show*),Bash(git rev-parse*)");
  const result = spawnSync(settings.hooks.PreToolUse[0].hooks[0].command, { shell: true, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git diff; id" } }), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});
it("isolates Git config and overrides hooks, file monitors and SSH in the real environment", () => {
  const env = controlEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/untrusted", GIT_CONFIG_SYSTEM: "/untrusted", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/untrusted" });
  expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  for (const [key, value] of [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.sshCommand", "/usr/bin/false"]]) {
    const result = spawnSync("git", ["config", "--get", key], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(value);
  }
});
for (const [key, value] of [["diff.external", ""], ["log.showSignature", "false"]]) it(`overrides repository ${key} in Git's command config`, () => {
  const result = spawnSync("git", ["config", "--get", key], { env: controlEnv({ PATH: process.env.PATH }), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(value);
});
it("forces both Git pager variables to cat", () => {
  expect(controlEnv({ GIT_PAGER: "/untrusted", PAGER: "/untrusted" })).toMatchObject({ GIT_PAGER: "cat", PAGER: "cat" });
});
it("disables optional Git locks so status cannot refresh index metadata", () => {
  const root = fileURLToPath(new URL("../results/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "control-status-"));
  const env = controlEnv({ PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "1" });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    git("init", "-q");
    const file = join(cwd, "sample.txt");
    writeFileSync(file, "unchanged\n");
    git("add", ".");
    git("-c", "user.name=Gate test", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Base");
    const index = join(cwd, ".git", "index");
    const before = readFileSync(index);
    utimesSync(file, 0, 0);
    git("status", "--short");
    expect(readFileSync(index)).toEqual(before);
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
for (const [stdout, ok] of [["2.1.294 (Claude Code)\n", false], ["2.1.295 (Claude Code)\n", true], ["2.1.296 (Claude Code)\n", true], ["2.2.0 (Claude Code)\n", true], ["3.0.0 (Claude Code)\n", true], ["unknown\n", false]]) it(`${ok ? "accepts" : "refuses"} control version ${stdout.trim()}`, async () => {
  const { controlVersion } = await import("../lib/claude-control.mjs");
  const result = controlVersion(stdout);
  expect(result.ok).toBe(ok);
  if (!ok) {
    expect(result).toMatchObject({ blocked: true, model: null });
    expect(result.text).toMatch(/^[^\r\n]*2\.1\.295[^\r\n]*$/);
  }
});
it("delivers a case title with a shell operator and quote unchanged through stdin", () => {
  const caseData = { title: 'Fix "value"; id', body: "Text with $(id), `id` and a newline\nkept.", paths: ['src/a"; id.ts', "src/a b.ts"] };
  const call = laptopInvocation({ job, maxUsd: 0.8, caseData });
  expect(call.command).toBe("claude");
  expect(call.args).toEqual(invocation.args);
  // A real stdin reader checks transport without replacing Claude or spending on a review.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(0));'], { input: call.input, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.startsWith(`${CONTROL_PROMPT}\n`)).toBe(true);
  expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1))).toEqual(caseData);
});
it("includes added untracked files in the control's case paths", () => {
  const root = mkdtempSync(join(tmpdir(), "oq-control-paths-"));
  try {
    const { dir, spec } = buildCase("ts-removed-export", join(root, "repo"));
    const added = "added file.ts";
    writeFileSync(join(dir, added), "export const added = true;\n");
    const paths = [...git(dir, "diff", "--name-only", "-z").split("\0").filter(Boolean), added];
    const call = laptopInvocation({ job, maxUsd: 0.8, caseData: controlCaseData(dir, spec) });
    expect(JSON.parse(call.input.slice(call.input.indexOf("\n") + 1)).paths).toEqual(paths);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("refuses a missing Claude binary without rejecting the control probe", async () => {
  await expect(probeControl({ env: { PATH: "/nonexistent-openqodex-control-bin" } })).resolves.toMatchObject({ ok: false, blocked: false, version: null, model: null, text: expect.stringContaining("claude --version failed:") });
});
it("keeps the native body whole without a brief or engine output", () => {
  const s = sample();
  expect(s.nativeBody).toBe(body);
  for (const key of ["brief", "report", "findings", "scanners", "graphStatus", "timings"]) expect(s).not.toHaveProperty(key);
  expect(nativeReviewBody(s)).toBe(body);
  expect(nativeReviewBody({ reviewer: "claude" })).toBe(null);
});
it("records command, version, served model, time and cost from native usage", () => {
  expect(sample()).toMatchObject({ command: invocation, reviewerUsed: { name: "claude", version: "2.1.296" }, model: "served-model", models: ["served-model"], modelStatus: "known", started_at: "2026-10-14T00:00:00Z", wallMs: 1234, usage: { input_tokens: 42, output_tokens: 7, cost_usd: 0.12 }, status: "complete" });
});
it.each([
  ["two models", { ...answer, modelUsage: { first: { inputTokens: 42, cacheReadInputTokens: 100, cacheCreationInputTokens: 25, outputTokens: 7 }, second: { inputTokens: 8, cacheReadInputTokens: 20, cacheCreationInputTokens: 5, outputTokens: 3 } } }, { input_tokens: 200, output_tokens: 10 }],
  ["usage only", { ...answer, modelUsage: undefined, usage: { ...answer.usage, cache_read_input_tokens: 100, cache_creation_input_tokens: 25 } }, { input_tokens: 167, output_tokens: 7 }],
])("counts all input, cache and output tokens from %s", (_label, native, expected) => {
  expect(sample(native).usage).toMatchObject(expected);
});
it("records missing and mixed usage without inventing a served model", () => {
  expect(sample({ ...answer, modelUsage: {} })).toMatchObject({ model: null, modelStatus: "none" });
  expect(sample({ ...answer, modelUsage: { first: {}, second: {} } })).toMatchObject({ model: ["first", "second"], modelStatus: "mixed" });
});
it("keeps the usage model and records a mismatch with the requested model", () => {
  const s = sample();
  const observed = claudeRunModels([s], "requested-model", "control");
  expect(s.model).toBe("served-model");
  expect(observed).toMatchObject({ model: "served-model", why: "Claude Code requested model requested-model, but samples were served by served-model" });
});
it("keeps a failed review's body and refuses to mark it complete", () => {
  expect(sample({ ...answer, is_error: true })).toMatchObject({ status: "failed", nativeBody: body });
});
it("refuses graph-on configurations for a control reviewer", () => {
  expect(() => planJobs({ cases: ["test"], caseIds: { test: job.caseId }, reviewers: ["control"], graph: ["on"], repeat: 1 })).toThrow(/control.*graph/);
});
it("accepts --reviewers control without launching a paid probe on a dry run", () => {
  const r = spawnSync(process.execPath, ["benchmark/run.mjs", "--reviewers", "control", "--cases", "ts-removed-export", "--repeat", "1", "--max-usd", "0.8", "--max-minutes", "2", "--dry-run"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("control-graph-off");
  expect(r.stdout).not.toContain("Scanners:");
});
