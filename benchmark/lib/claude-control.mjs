// Failure cases are listed in test/claude-control.test.mjs before this code.
// Claude Code owns this review. No OpenQodex prompt or engine participates.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git } from "./cases.mjs";
import { claudeEnv } from "./reviewers.mjs";
import { reviewHealth } from "./score.mjs";

const exec = promisify(execFile);
export const CONTROL_PROMPT = "/code-review medium";
export const CONTROL_MODEL_FROM = "the usage record Claude Code returned for this review";
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const gate = fileURLToPath(new URL("./control-gate.mjs", import.meta.url));

export function controlCaseData(repo, spec) {
  return { ...spec, paths: (git(repo, "diff", "--name-only", "-z") + git(repo, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean) };
}

export function controlInput(caseData) {
  if (caseData === undefined) return CONTROL_PROMPT;
  const { title = "", body = "", paths = [] } = caseData;
  return `${CONTROL_PROMPT}\n${JSON.stringify({ title, body, paths })}`;
}

export function controlEnv(env = process.env) {
  const config = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.sshCommand", "/usr/bin/false"], ["diff.external", ""], ["log.showSignature", "false"]];
  const out = { ...claudeEnv(env), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: String(config.length), GIT_PAGER: "cat", PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" };
  for (const [i, [key, value]] of config.entries()) {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return out;
}

// https://code.claude.com/docs/en/code-review#review-a-diff-locally
// In print mode the built-in command waits and returns its findings as text.
export function controlArgs({ maxUsd }) {
  return ["-p", "--output-format", "json", "--permission-mode", "dontAsk",
    "--setting-sources", "", "--settings", JSON.stringify({ autoMemoryEnabled: false, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(gate)}`, onFailure: "block" }] }] } }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--no-session-persistence", "--tools", "Read,Grep,Glob,Bash",
    "--allowedTools", "Read,Grep,Glob,Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git show*),Bash(git rev-parse*)",
    "--max-budget-usd", String(maxUsd)];
}

export function controlVersion(stdout) {
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  const [major, minor, patch] = version.split(".").map(Number);
  const ok = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 295)));
  return { ok, blocked: !ok, version, model: null, text: ok ? "version supported" : "Claude Code 2.1.295 or newer is required" };
}

// A login check, never a paid prompt. Keep the same CLI and login environment
// as the existing Claude reviewer, and never save auth status output.
export async function probeControl({ env = process.env } = {}) {
  const e = controlEnv(env);
  let stdout;
  try { ({ stdout } = await exec("claude", ["--version"], { env: e, timeout: 20_000 })); }
  catch (error) { return { ok: false, blocked: false, version: null, model: null, text: `claude --version failed: ${String(error.message).split("\n")[0]}` }; }
  const supported = controlVersion(stdout);
  if (!supported.ok) return supported;
  const { version } = supported;
  if (!e.ANTHROPIC_API_KEY) {
    let loggedIn = false;
    try { loggedIn = JSON.parse((await exec("claude", ["auth", "status"], { env: e, timeout: 20_000 })).stdout).loggedIn === true; }
    catch { /* An unavailable login is a refusal, with no paid probe. */ }
    if (!loggedIn) return { ok: false, blocked: true, version, model: null, text: "Claude Code is not logged in" };
  }
  return { ok: true, blocked: false, version, model: null, text: "login available" };
}

export function controlSample({ job, attempt, result, command, version, startedAt, stopped = null }) {
  let native = null;
  try { native = JSON.parse(result.stdout); } catch { /* Keep malformed output whole in the sample. */ }
  const models = Object.keys(native?.modelUsage ?? {}).sort();
  const each = Object.values(native?.modelUsage ?? {});
  const sum = (key) => each.reduce((n, m) => n + (typeof m[key] === "number" && Number.isFinite(m[key]) ? m[key] : 0), 0);
  const inputTokens = each.length > 0 ? sum("inputTokens") + sum("cacheReadInputTokens") + sum("cacheCreationInputTokens") : native?.usage?.input_tokens == null ? null : native.usage.input_tokens + (native.usage.cache_read_input_tokens ?? 0) + (native.usage.cache_creation_input_tokens ?? 0);
  const outputTokens = each.length > 0 ? sum("outputTokens") : native?.usage?.output_tokens ?? null;
  const body = typeof native?.result === "string" ? native.result : result.stdout;
  const modelStatus = models.length === 1 ? "known" : models.length > 1 ? "mixed" : "none";
  const usage = { turns: native?.num_turns ?? null, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: native?.total_cost_usd ?? null };
  const ran = result.code === 0 && native?.is_error === false && typeof native.result === "string" && stopped === null;
  // Claude Code answers an API error with exit 0 and is_error false (issue
  // 284): the health rule the scorers apply decides it at the source too.
  const health = reviewHealth({ reviewer: "control", nativeBody: body, stopped, models, modelStatus, usage });
  const complete = ran && health.ok;
  return {
    jobId: job.jobId, caseId: job.caseId, firstAttempt: attempt === 1, case: job.case,
    config: job.config, reviewer: "control", graph: "off", repeat: job.repeat, attempt,
    started_at: startedAt, exit: result.code ?? null, signal: result.signal ?? null,
    wallMs: result.wallMs, status: complete ? "complete" : "failed", stopped,
    failure: complete ? null : stopped ?? (ran ? health.reason : body || result.stderr || `Claude Code exited ${result.code}`),
    command, reviewerUsed: { name: "claude", version },
    model: models.length === 1 ? models[0] : models.length > 1 ? models : null, models,
    modelFrom: CONTROL_MODEL_FROM, modelStatus, usage,
    nativeBody: body,
  };
}

// Failed controls stay in the denominator without sending error text to a judge.
export const nativeReviewBody = (sample) => sample?.reviewer === "control" && typeof sample.nativeBody === "string" ? sample.status === "complete" ? sample.nativeBody : "" : null;
