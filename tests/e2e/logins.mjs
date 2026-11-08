// Whether the real reviewers can run here: the one check the end-to-end
// model cases (tests/e2e/support.ts) and the model tier
// (scripts/gate-model.sh) share. Each function returns the reason a reviewer
// cannot run, or null when it can.
//
// Run as a script it prints one line per reviewer and exits 1 when either
// cannot run.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const offline = () => process.env.OPENQODEX_E2E_OFFLINE === "1";

// Claude Code: installed, logged in and not offline.
export function reviewerMissing() {
  if (offline()) return "OPENQODEX_E2E_OFFLINE=1";
  const status = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 30_000 });
  if (status.error) return "claude is not installed";
  try {
    if (JSON.parse(status.stdout).loggedIn !== true) return "claude is not logged in";
  } catch {
    return "claude auth status printed no status";
  }
  return null;
}

// Codex: installed, logged in, not offline and not in CI (CI has no Codex login).
export function codexMissing() {
  if (offline()) return "OPENQODEX_E2E_OFFLINE=1";
  if (process.env.CI) return "CI is set";
  if (process.env.CODEX_SANDBOX) return "inside a Codex sandbox";
  const status = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 30_000 });
  if (status.error) return "codex is not installed";
  if (status.status !== 0) return "codex is not logged in";
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const claude = reviewerMissing();
  const codex = codexMissing();
  process.stdout.write(`Claude Code: ${claude ?? "logged in"}\nCodex: ${codex ?? "logged in"}\n`);
  process.exit(claude === null && codex === null ? 0 : 1);
}
