#!/usr/bin/env bash
# The fast gate: what to run on a Mac before a push. The steps of
# scripts/gate.sh in the same order, without the scanner check, the
# end-to-end tests and the golden run, and with only the unit tests the
# change can reach: scripts/gate-select.mjs reads the changed paths against
# origin/main and prints what it picked and why. A change outside the
# packages, a missing origin/main or an empty change runs every unit test;
# --all runs every unit test whatever changed.
# The three tiers: this one; the real programs (pnpm gate, every step,
# without the cases that call a real model); the real model (pnpm gate:model).
set -euo pipefail
cd "$(dirname "$0")/.."

all=0
for arg in "$@"; do
  case "$arg" in
    --all) all=1 ;;
    *) echo "gate-fast: unknown argument $arg (the one option is --all)" >&2; exit 2 ;;
  esac
done

step() {
  printf '\n== %s ==\n' "$1"
  shift
  "$@"
}

unit_tests() {
  local picked
  if [ "$all" = 1 ]; then
    echo "gate-select: the whole unit suite, because --all was given"
    picked=all
  else
    picked="$(node scripts/gate-select.mjs)"
  fi
  if [ "$picked" = all ]; then
    pnpm vitest run
  else
    # shellcheck disable=SC2086
    pnpm vitest run $picked
  fi
}

started=$(date +%s)
step "shipped instruction templates" node scripts/instruction-sections.mjs --check
step "build" pnpm build
step "typecheck" pnpm typecheck
step "lint" pnpm lint
step "unit tests" unit_tests
step "skill and plugin manifests" node scripts/validate-skill.mjs
step "config docs" node scripts/config-docs.mjs --check
step "docs index" node scripts/docs-index.mjs --check
step "docs facts" node scripts/docs-facts.mjs
step "benchmark results" node scripts/benchmark-results.mjs --check
step "private material scrub" node scripts/scrub.mjs

printf '\ngate:fast: green in %s s\n' "$(( $(date +%s) - started ))"
