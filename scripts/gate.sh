#!/usr/bin/env bash
# The gate. Runs every check in order and stops at the first failure.
# The three tiers:
# - fast (pnpm gate:fast, scripts/gate-fast.sh): what to run on a Mac
#   before a push. These steps without the scanner check, the end-to-end
#   tests and the golden run, and only the unit tests the change can reach.
# - real programs (pnpm gate, this file): every step, with the real
#   scanners, the real git and the built CLI, and the slow growth tests
#   (OPENQODEX_GROWTH_TESTS=1). The cases that call a real model skip here.
# - real model (pnpm gate:model, scripts/gate-model.sh): the model cases of
#   the end-to-end tests and the planted scan sample, on a logged-in Mac,
#   once per release. Never in CI.
# CI runs the same steps (.github/actions/gate, which both gate jobs in
# .github/workflows/ci.yml use); keep the two in step. An ordinary pull
# request and its merge queue run leave out the e2e tests and the golden
# run; the full gate runs for the version pull request, the label full-ci
# and main (ci.yml says where).
# One CI job is not mirrored here and runs in CI only: bench-scan, the
# scanner-only benchmark and its trend gate against the accepted run in
# benchmark/index. It installs every scanner, which needs Ruby 3.3 for
# brakeman and rubocop and Go 1.26 for golangci-lint (this Mac has neither).
# bench-weekly.yml, the weekly scanner-only run on real pull requests, shares
# its setup (.github/actions/bench-setup) and is not a pull request check.
set -euo pipefail
cd "$(dirname "$0")/.."

step() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

step "shipped instruction templates" node scripts/instruction-sections.mjs --check
step "build" pnpm build
step "typecheck" pnpm typecheck
step "lint" pnpm lint
export OPENQODEX_GROWTH_TESTS=1
step "required scanners" node scripts/require-scanners.mjs
step "unit tests" pnpm test
step "e2e tests" pnpm test:e2e
step "golden run" pnpm golden:check
step "skill and plugin manifests" node scripts/validate-skill.mjs
step "config docs" node scripts/config-docs.mjs --check
step "docs index" node scripts/docs-index.mjs --check
step "docs facts" node scripts/docs-facts.mjs
step "benchmark results" node scripts/benchmark-results.mjs --check
step "private material scrub" node scripts/scrub.mjs

printf '\ngate: green\n'
