#!/usr/bin/env bash
# The real-model tier: the end-to-end cases that call the real Claude Code
# and the real Codex as the reviewer, then the planted scan sample of the
# benchmark. It spends real usage, so it runs on a logged-in Mac once per
# release, before the version pull request merges, and never in CI. The
# other tiers: pnpm gate:fast before a push, pnpm gate for the real
# programs (scripts/gate.sh says what each runs).
#
# It refuses when CI is set, fails when either login is missing, and fails
# unless every expected model case ran and passed: a case that skipped is
# a failure here. Build first (pnpm build).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${CI:-}" ]; then
  echo "gate:model: refused, CI is set. The model tier runs on a logged-in Mac only." >&2
  exit 2
fi

printf '\n== logins ==\n'
if ! node tests/e2e/logins.mjs; then
  echo "gate:model: both Claude Code and Codex must be installed and logged in." >&2
  exit 1
fi

export OPENQODEX_MODEL_TESTS=1
run_id="$(date -u +%Y-%m-%d)-$(git rev-parse --short=7 HEAD)-model-tier"
out="benchmark/results/$run_id"
mkdir -p "$out"
json="$out/e2e-model.json"

printf '\n== model cases ==\n'
status=0
pnpm vitest run --config vitest.e2e.config.ts tests/e2e/total-review.test.ts tests/e2e/action-review.test.ts --reporter=default --reporter=json --outputFile.json="$json" || status=$?

# Every model case by its file and title: each must be in the report and
# passed. A case added to those groups is added here too.
node - "$json" <<'NODE'
const { readFileSync } = require("node:fs");
const expected = {
  "tests/e2e/total-review.test.ts": [
    "with Claude Code as the reviewer 1, 6.",
    "with Claude Code as the reviewer 9.",
    "with Claude Code as the reviewer 2.",
    "with Claude Code as the reviewer 3.",
    "with Codex as the reviewer 8.",
  ],
  "tests/e2e/action-review.test.ts": [
    "the Action's review mode with the real Claude Code R2, R3, R18, R20, R27, R30.",
    "the Action's review mode with the real Claude Code R6, R7, R11, R12.",
  ],
};
let report;
try { report = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch { console.error(`gate:model: no JSON report at ${process.argv[2]}`); process.exit(1); }
const bad = [];
let passed = 0;
for (const [file, prefixes] of Object.entries(expected)) {
  const result = report.testResults.find((r) => r.name.endsWith(file));
  if (result === undefined) { bad.push(`${file}: not in the report`); continue; }
  for (const prefix of prefixes) {
    const cases = result.assertionResults.filter((a) => a.fullName.startsWith(prefix));
    if (cases.length !== 1) bad.push(`${file}: ${cases.length} cases named "${prefix}", expected 1`);
    else if (cases[0].status !== "passed") bad.push(`${file}: "${cases[0].fullName}" ${cases[0].status}`);
    else passed++;
  }
}
console.log(`model cases: ${passed} of ${Object.values(expected).flat().length} passed; the whole run ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped`);
for (const b of bad) console.error(`gate:model: ${b}`);
process.exit(bad.length === 0 ? 0 : 1);
NODE
if [ "$status" -ne 0 ]; then
  echo "gate:model: the end-to-end run exited $status" >&2
  exit 1
fi

printf '\n== planted scan sample ==\n'
node benchmark/build-cli.mjs
node benchmark/run.mjs --mode scan --suite planted --repeat 1 --out "$out/planted-scan"

printf '\ngate:model: green, run %s\n  model cases: %s\n  planted scan: %s\n' "$run_id" "$json" "$out/planted-scan"
