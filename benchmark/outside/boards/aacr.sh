#!/usr/bin/env bash
# Scores a saved run's findings on AACR-Bench cases with AACR-Bench's own
# evaluator, at the commit benchmark/outside/boards.json pins.
#
#   benchmark/outside/boards/aacr.sh --prepare
#       fetches their pinned checkout into the bench cache
#       ($OPENQODEX_BENCH_CACHE/upstream/aacr-bench@<commit>) and builds its
#       venv beside it (aacr-bench@<commit>.venv) with uv and Python 3.11, so
#       the checkout holds nothing but the pinned tree; nothing is installed
#       globally.
#   benchmark/outside/boards/aacr.sh <run folder> [--rounds N] (--wave <id> | --dry-run)
#       1. converts the run (outside/convert/aacr.mjs) into
#          <run>/outside/aacr/, unless it holds a conversion already;
#       2. with --dry-run, checks the judge settings and prints the
#          commands with their values hidden, and stops;
#       3. prepares their checkout, runs their dataset converter on the
#          pinned dataset file in the cache, and keeps the run's pull
#          requests (checked against our truth copies);
#       4. runs their evaluation stage on each configuration and repeat,
#          N rounds (default 3), with a model as judge (aacr-judge.mjs),
#          which reserves the judging's forecast in the wave named by
#          --wave (benchmark/lib/wave.mjs);
#       5. leaves eval.json for node benchmark/score.mjs <run> --outside aacr.
#
# The judge's base URL and key never pass through this script: aacr-judge.mjs
# reads them with lib/model-env.mjs and holds them only in its local relay.
# Their evaluator receives the relay URL and a random placeholder key. This script holds no secret, so it prints
# none, even under bash -x. Core files are off for this script and all it
# starts, so a crash writes neither anywhere. Their mock judge is never
# allowed. The bench cache must lie outside this repository.
# Run with Node 22 first on PATH. Stops at the first failure.
set -euo pipefail
umask 077
ulimit -c 0

here=$(cd "$(dirname "$0")" && pwd)
convert="$(dirname "$here")/convert/aacr.mjs"
judge="$here/aacr-judge.mjs"

die() {
  echo "aacr.sh: $1" >&2
  exit 2
}

rounds=3
wave=""
dry=0
prepare_only=0
run=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prepare) prepare_only=1 ;;
    --dry-run) dry=1 ;;
    --rounds)
      [ $# -ge 2 ] || die "--rounds needs a number"
      rounds=$2
      shift
      ;;
    --wave)
      [ $# -ge 2 ] || die "--wave needs a wave id"
      wave=$2
      shift
      ;;
    -*) die "unknown option $1" ;;
    *)
      [ -z "$run" ] || die "name one run folder"
      run=$1
      ;;
  esac
  shift
done

pin=$(node "$convert" pin)
read -r repo commit <<<"$pin"
cache=$(node "$convert" cache 2>&1) || die "${cache#refused: }"
checkout="$cache/upstream/aacr-bench@$commit"
evaluation="$checkout/evaluation"
venv="$checkout.venv"
python="$venv/bin/python"

prepare() {
  if [ ! -d "$checkout/.git" ]; then
    mkdir -p "$checkout"
    git -C "$checkout" init -q
    git -C "$checkout" fetch -q --depth 1 "https://github.com/$repo.git" "$commit"
    git -C "$checkout" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  [ "$(git -C "$checkout" rev-parse HEAD)" = "$commit" ] || die "$checkout is not at $commit; move it to the Trash and run --prepare again"
  [ -z "$(git -C "$checkout" status --porcelain --untracked-files=all)" ] || die "$checkout has local edits or untracked files; their code is never patched. Move it to the Trash and run --prepare again"
  [ ! -e "$evaluation/.env" ] || die "$evaluation/.env exists; their evaluator would read it. Move it to the Trash"
  if [ ! -x "$python" ]; then
    command -v uv >/dev/null || die "uv builds their evaluator's venv and is not on PATH (https://docs.astral.sh/uv/)"
    uv venv -q --python 3.11 "$venv"
    uv pip install -q --python "$python" -r "$evaluation/requirements.txt"
  fi
}

if [ "$prepare_only" = 1 ]; then
  [ -z "$run" ] || die "--prepare takes no run folder"
  prepare
  echo "aacr.sh: AACR-Bench's evaluator at $commit is ready in $checkout"
  exit 0
fi

[ -n "$run" ] || die "usage: aacr.sh --prepare | aacr.sh <run folder> [--rounds N] (--wave <id> | --dry-run)"
[ "$dry" = 1 ] || [ -n "$wave" ] || die "--wave <id> is required: the judging pays a model (node benchmark/lib/wave.mjs --wave-new <id> starts one)"
[ -f "$run/manifest.json" ] || die "$run holds no manifest.json; it is not a benchmark run"
run=$(cd "$run" && pwd)
out="$run/outside/aacr"

if [ -f "$out/convert.json" ]; then
  echo "aacr.sh: $out holds a conversion already, and it is used as it is"
else
  node "$convert" convert "$run"
fi

if [ "$dry" = 1 ]; then
  exec node "$judge" "$run" --dry-run --rounds "$rounds" --evaluation "$evaluation" --python "$python"
fi

prepare
raw=$(node "$convert" raw)
(cd "$evaluation" && "$python" -B -m converters.aacr_bench --input "$raw" --output "$out/upstream-dataset.jsonl" --validate)
node "$convert" dataset "$run" "$out/upstream-dataset.jsonl"
exec node "$judge" "$run" --rounds "$rounds" --evaluation "$evaluation" --python "$python" --wave "$wave"
