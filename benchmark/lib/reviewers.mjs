// What the benchmark needs to know about a reviewer before it spends on
// one: its version, whether it is logged in, which model it answers with,
// and, after a failed review, whether a limit or a login wall stopped it.
//
// Failure list, written before the code:
// 1. The probe answers with a different model than the reviewer would
//    (user settings pick another model): it runs with the same isolation
//    flags as the reviewer (no setting sources) and the same environment
//    allowlist, so the model it reports is the reviewer's.
// 2. A usage limit, a rate limit or a login wall reads as a product failure
//    and the run carries on into more failures: the probe's text is checked
//    for them, and the caller stops the run at once.
// 3. The probe hangs: it has a timeout and counts as failed.
// 4. The probe costs more than a few tokens: one short prompt, no tools.
// 5. The Codex model is guessed, or taken from a variable Codex never reads:
//    it is read from the header Codex prints, or recorded as unknown.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function withInput(cmd, args, input, env, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error = null;
    const timer = setTimeout(() => {
      error = `timed out after ${timeoutMs / 1000} s`;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => (error = e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, error });
    });
    child.stdin.end(input);
  });
}

// The environment the Claude Code reviewer gets (packages/review/src/agents/claude.ts reviewerEnv).
const ALWAYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const ANTHROPIC = /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|CUSTOM_HEADERS|DEFAULT_[A-Z_]+_MODEL)$/;

export function claudeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ALWAYS.includes(k) || k.startsWith("LC_") || ANTHROPIC.test(k)) out[k] = v;
  }
  return out;
}

// Words that mean the account, not the product, stopped the review.
export const BLOCKED = /usage limit|rate limit|rate_limit|limit reached|hit your limit|quota|credit balance|overloaded|not logged in|log in|login|authenticat|unauthorized|forbidden|billing/i;

export async function probeClaude({ env = process.env, timeoutMs = 120_000 } = {}) {
  const e = claudeEnv(env);
  let version = null;
  try {
    const { stdout } = await run("claude", ["--version"], { env: e, timeout: 20_000 });
    version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  } catch (error) {
    return { ok: false, blocked: false, version, model: null, text: `claude --version failed: ${String(error.message).split("\n")[0]}` };
  }
  const args = [
    "-p",
    "--output-format", "json",
    "--setting-sources", "",
    "--settings", JSON.stringify({ autoMemoryEnabled: false, hooks: {}, disableAllHooks: true }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--no-session-persistence",
    // --tools takes a list, so the prompt goes on standard input, not after it.
    "--tools", "",
  ];
  const r = await withInput("claude", args, "Reply with the single word ok.", e, timeoutMs);
  const out = r.stdout;
  if (out.trim() === "") {
    const text = `${r.error ?? `exit ${r.code}`} ${r.stderr}`.trim();
    return { ok: false, blocked: BLOCKED.test(text), version, model: null, text };
  }
  let result;
  try {
    result = JSON.parse(out);
  } catch {
    return { ok: false, blocked: BLOCKED.test(out), version, model: null, text: out.slice(0, 500) };
  }
  const models = Object.keys(result.modelUsage ?? {});
  const text = String(result.result ?? "");
  const ok = result.is_error !== true && /\bok\b/i.test(text);
  return { ok, blocked: !ok && BLOCKED.test(text), version, model: models.length === 1 ? models[0] : models.length === 0 ? null : models, text: text.slice(0, 500), costUsd: result.total_cost_usd ?? null };
}

// The environment the Codex reviewer gets (packages/review/src/agents/codex.ts codexEnv).
const CODEX_ALWAYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ", "CODEX_HOME", "CODEX_CA_CERTIFICATE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE"];

export function codexEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (CODEX_ALWAYS.includes(k) || k.startsWith("LC_"))) out[k] = v;
  return out;
}

// Codex's model comes from its own output: the reviewer runs with
// --ignore-user-config and its JSON stream never names the model, so the
// probe runs one tiny `codex exec` the same way (user config ignored) and
// reads the `model:` line of the header Codex prints. The benchmark cannot
// set the Codex model: the driver takes no model setting (run.mjs refuses
// --model with Codex).
export async function probeCodex({ env = process.env, timeoutMs = 120_000 } = {}) {
  const e = codexEnv(env);
  let version = null;
  try {
    const { stdout } = await run("codex", ["--version"], { env: e, timeout: 20_000 });
    version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  } catch (error) {
    return { ok: false, blocked: false, version, model: null, text: `codex --version failed: ${String(error.message).split("\n")[0]}` };
  }
  const dir = mkdtempSync(join(tmpdir(), "oq-bench-codex-"));
  const args = ["exec", "--color", "never", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", dir, "-c", 'approval_policy="never"', "-s", "read-only", "-"];
  const r = await withInput("codex", args, "Reply with the single word ok.", e, timeoutMs).finally(() => rmSync(dir, { recursive: true, force: true }));
  const ok = r.code === 0 && /\bok\b/i.test(r.stdout);
  const model = codexModelFrom(r.stderr);
  return { ok, blocked: !ok && BLOCKED.test(`${r.stderr} ${r.stdout}`), version, model, text: ok ? "ok" : `${r.error ?? `exit ${r.code}`}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}` };
}

export function codexModelFrom(header) {
  return /^model:\s*(\S+)\s*$/m.exec(String(header ?? ""))?.[1] ?? "unknown";
}

export function probeReviewer(name, opts) {
  if (name === "claude") return probeClaude(opts);
  if (name === "codex") return probeCodex(opts);
  return Promise.resolve({ ok: false, blocked: false, version: null, model: null, text: `no probe for reviewer ${name}` });
}

// A review the reviewer did not finish because its process failed, timed
// out or could not start, as opposed to a review the product judged
// incomplete (an unread range, a failed answer check).
export const REVIEWER_FAILED = /^(the reviewer (timed out|stopped|exited|failed|is no longer running)|could not start the reviewer|no reviewer process)/;
