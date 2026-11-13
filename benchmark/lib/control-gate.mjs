// Failure cases are listed in test/control-gate.test.mjs before this code.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Accept literal shell words only. Quotes and escapes may group arguments,
// but shell expansion, comments and control syntax never reach Bash.
function words(command) {
  if (typeof command !== "string" || /[\r\n\0`$<>|;&]/.test(command)) return null;
  const args = [];
  let word = "", quote = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && ['"', "\\"].includes(command[i + 1])) word += command[++i];
      else word += c;
    } else if (c === " " || c === "\t") {
      if (started) { args.push(word); word = ""; started = false; }
    } else if (c === "'" || c === '"') {
      quote = c; started = true;
    } else if (c === "\\") {
      if (i + 1 === command.length) return null;
      word += command[++i]; started = true;
    } else {
      if (!/[A-Za-z0-9_./:@%+=,^-]/.test(c)) return null;
      word += c; started = true;
    }
  }
  if (quote !== null) return null;
  if (started) args.push(word);
  return args;
}

let allowed = false;
let updatedInput;
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const args = words(input?.tool_input?.command);
  allowed = input?.hook_event_name === "PreToolUse" && input?.tool_name === "Bash"
    && args?.[0] === "git" && ["diff", "status", "log", "show", "rev-parse"].includes(args[1])
    && !args.slice(2).some((arg, i) => /^--(?:out|ext-diff|textconv)/.test(arg)
      || ["--help", "-h", "--web", "--show-signature"].includes(arg)
      || (/^--(?:format|pretty)(?:=|$)/.test(arg) && /%G/.test(arg.includes("=") ? arg : args[i + 3] ?? "")));
  if (allowed) {
    // Filters can run even when external diffs and text conversion are disabled.
    const filters = spawnSync("git", ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|smudge|required)$"], {
      encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    allowed = filters.status === 0 || filters.status === 1;
    if (allowed) {
      const config = ["diff.external=", "log.showSignature=false"];
      for (const key of filters.stdout.split("\0").filter(Boolean)) config.push(`${key}=${key.endsWith(".required") ? "false" : ""}`);
      const flags = ["diff", "show", "log"].includes(args[1]) ? ["--no-ext-diff", "--no-textconv"] : [];
      updatedInput = { ...input.tool_input, command: ["git", ...config.flatMap((value) => ["-c", value]), args[1], ...flags, ...args.slice(2)].map(shellQuote).join(" ") };
    }
  }
} catch { /* Malformed input is denied with the same one-line reason. */ }

// https://code.claude.com/docs/en/hooks#pretooluse-decision-control
process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse",
  permissionDecision: allowed ? "allow" : "deny",
  permissionDecisionReason: allowed ? "One Git read command allowed." : "Only one git diff, status, log, show or rev-parse read command with literal arguments is allowed; shell syntax, output files and external helpers are denied.",
  ...(allowed ? { updatedInput } : {}),
} })}\n`);
