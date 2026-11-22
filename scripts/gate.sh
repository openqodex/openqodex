#!/usr/bin/env bash
# The gate. Runs every check in order and stops at the first failure.
# The three tiers:
# - fast (pnpm gate:fast, scripts/gate-fast.sh): what to run on a Mac
#   before a push. The steps below without --full, and only the unit tests
#   the change can reach.
# - real programs (pnpm gate --full, this file): every step, with the real
#   scanners, the real git and the built CLI, and the slow growth tests
#   (OPENQODEX_GROWTH_TESTS=1). The cases that call a real model skip here.
#   Without --full (pnpm gate) it leaves out the steps marked full_step:
#   the scanner check, the end-to-end tests and the golden run, and the
#   growth tests; that is the fast gate CI runs on every pull request.
# - real model (pnpm gate:model, scripts/gate-model.sh): the model cases of
#   the end-to-end tests and the planted scan sample, on a logged-in Mac,
#   once per release. Never in CI.
# CI runs the same steps (.github/actions/gate, which both gate jobs in
# .github/workflows/ci.yml use); keep the two in step, and a step this file
# marks full_step is a step the action runs only when full is true. Pull
# requests, the merge queue and pushes to main run the fast gate; the full
# gate runs in the nightly run, in the release and on the label full-ci
# (ci.yml says where).
# One CI job is not mirrored here and runs in CI only: bench-scan, the
# scanner-only benchmark and its trend gate against the accepted run in
# benchmark/index. It installs every scanner, which needs Ruby 3.3 for
# brakeman and rubocop and Go 1.26 for golangci-lint (this Mac has neither).
# bench-weekly.yml, the weekly scanner-only run on real pull requests, shares
# its setup (.github/actions/bench-setup) and is not a pull request check.
set -euo pipefail
cd "$(dirname "$0")/.."

full=0
for arg in "$@"; do
  case "$arg" in
    --full) full=1 ;;
    *) echo "gate: unknown argument $arg (the one option is --full)" >&2; exit 2 ;;
  esac
done

step() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

# A step of the full gate only; without --full it says so and moves on.
full_step() {
  if [ "$full" = 1 ]; then
    step "$@"
  else
    printf '\n== %s == left out: pnpm gate --full runs it\n' "$1"
  fi
}

step "shipped instruction templates" node scripts/instruction-sections.mjs --check
step "build" pnpm build
step "typecheck" pnpm typecheck
step "lint" pnpm lint
if [ "$full" = 1 ]; then export OPENQODEX_GROWTH_TESTS=1; fi
full_step "required scanners" node scripts/require-scanners.mjs
step "unit tests" pnpm test
full_step "e2e tests" pnpm test:e2e
full_step "golden run" pnpm golden:check
step "skill and plugin manifests" node scripts/validate-skill.mjs
step "config docs" node scripts/config-docs.mjs --check
step "docs index" node scripts/docs-index.mjs --check
step "docs facts" node scripts/docs-facts.mjs
step "benchmark results" node scripts/benchmark-results.mjs --check
step "private material scrub" node scripts/scrub.mjs

if [ "$full" = 1 ]; then printf '\ngate --full: green\n'; else printf '\ngate: green (without the full steps; pnpm gate --full runs them)\n'; fi
