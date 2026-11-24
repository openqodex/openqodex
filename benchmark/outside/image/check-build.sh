#!/usr/bin/env bash
# Guards "a run silently lacks a scanner". The outside benchmark's image must
# not build unless every built-in scanner is installed at its pinned version
# and reports its check case. Three linux/amd64 builds of image/Dockerfile:
#   full      must build, run as a user other than root, and report every
#             built-in ready when checked again in the finished image;
#   no-ruby   (WITH_RUBY=0) must fail, naming brakeman and rubocop, no other;
#   no-rust   (WITH_RUST=0) must fail, naming cargo-deny, no other.
# The full image is kept as $IMAGE_TAG for local runs.
#
# Needs docker that builds linux/amd64. Without it the check prints the reason
# and exits 0 as skipped; with REQUIRE_DOCKER=1 (the workflow) it exits 1.
# Each build's log goes to $OUT (default: a new temporary folder).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
context=$(dirname "$here")
dockerfile="$here/Dockerfile"
tag=${IMAGE_TAG:-openqodex-outside:local}
# The built-in scanners of the openqodex version image/package.json pins
# (0.12.0): 21 in toolchain.json beside uv, and sqllint, which runs inside it.
expected=${EXPECTED_SCANNERS:-22}

skip() {
  if [ "${REQUIRE_DOCKER:-0}" = 1 ]; then
    echo "check-build: failed: $1" >&2
    exit 1
  fi
  echo "check-build: skipped: $1"
  exit 0
}
fail() {
  echo "check-build: failed: $1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || skip "docker is not installed on this machine"
docker info >/dev/null 2>&1 || skip "docker is installed, but its daemon does not answer (docker info failed)"

out=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/oq-image-check.XXXXXX")}
mkdir -p "$out"
echo "check-build: logs in $out"

# build <name> [docker build flags]: one linux/amd64 build; returns its exit code.
build() {
  local name=$1
  shift
  local started=$SECONDS code=0
  echo "check-build: building $name"
  docker build --platform linux/amd64 --progress=plain "$@" -f "$dockerfile" "$context" >"$out/$name.log" 2>&1 || code=$?
  echo "check-build: $name exited $code after $((SECONDS - started)) s"
  return "$code"
}

# The scanners a build's preinstall named as not ready, one per line, sorted.
not_ready() {
  { grep -oE 'not ready: [a-z0-9-]+:' "$1" || true; } | sed -E 's/^not ready: //; s/:$//' | sort -u
}

# The full image checked again at run time, as the user it runs as: after
# the build's last step, and without the build log, which a repeat build
# takes from the cache and leaves empty. Nothing may need installing.
recheck() {
  docker run --rm --platform linux/amd64 --entrypoint node "$tag" /srv/preinstall.mjs >"$out/recheck.log" 2>&1 || true
}

# 1. The full image builds, runs as a user other than root, and has every
# built-in scanner ready.
if ! build full --load -t "$tag"; then
  tail -n 40 "$out/full.log" >&2
  missing=$(not_ready "$out/full.log" | tr '\n' ' ' | sed 's/ $//')
  fail "the full image did not build${missing:+; not ready: $missing} (log: $out/full.log)"
fi
uid=$(docker run --rm --platform linux/amd64 --entrypoint id "$tag" -u 2>&1 || true)
case "$uid" in
  "" | 0 | *[!0-9]*) fail "the full image runs as user ${uid:-unknown}, not as a user other than root" ;;
  *) echo "check-build: full: runs as user $uid" ;;
esac
recheck
if grep -q '^installing ' "$out/recheck.log"; then
  fail "the full image lacked a scanner at run time: $(grep '^installing ' "$out/recheck.log" | tr '\n' ' ')(log: $out/recheck.log)"
fi
# No step of the build or the recheck may create the usage data's install id.
if ! docker run --rm --platform linux/amd64 --entrypoint sh "$tag" -c 'test ! -e "${OPENQODEX_HOME:-$HOME/.openqodex}/telemetry"' >/dev/null 2>&1; then
  fail "the full image holds a telemetry folder in its OpenQodex home; the image must send no usage data"
fi
line=$({ grep -oE '[0-9]+ of [0-9]+ built-in scanners ready.*' "$out/recheck.log" || true; } | tail -n 1)
case "$line" in
  "$expected of $expected built-in scanners ready"*) echo "check-build: full: at run time, $line" ;;
  *) fail "the full image built, but at run time it does not have $expected of $expected built-in scanners ready (it says: ${line:-nothing}; log: $out/recheck.log)" ;;
esac

# 2 and 3. A build without a runtime fails, naming exactly the scanners that need it.
refused() {
  local name=$1 want=$2
  shift 2
  if build "$name" "$@"; then
    fail "$name built, so a run in it would silently lack $want"
  fi
  local got
  got=$(not_ready "$out/$name.log" | tr '\n' ' ' | sed 's/ $//')
  if [ "$got" != "$want" ]; then
    tail -n 40 "$out/$name.log" >&2
    fail "$name failed, but preinstall named ${got:-no scanner} as not ready, not exactly $want (log: $out/$name.log)"
  fi
  echo "check-build: $name refused: not ready: $got"
}
refused no-ruby "brakeman rubocop" --build-arg WITH_RUBY=0
refused no-rust "cargo-deny" --build-arg WITH_RUST=0

echo "check-build: passed: $tag runs as user $uid with every built-in scanner ready; a build without Ruby or Rust is refused"
