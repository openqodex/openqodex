#!/usr/bin/env bash
# The gate. Runs every check in order and stops at the first failure.
# .github/workflows/ci.yml runs the same steps; keep the two in step.
set -euo pipefail
cd "$(dirname "$0")/.."

step() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

step "build" pnpm build
step "typecheck" pnpm typecheck
step "lint" pnpm lint
step "unit tests" pnpm test
step "e2e tests" pnpm test:e2e
step "golden run" pnpm golden:check
step "skill and plugin manifests" node scripts/validate-skill.mjs
step "config docs" node scripts/config-docs.mjs --check
step "private material scrub" node scripts/scrub.mjs

printf '\ngate: green\n'
