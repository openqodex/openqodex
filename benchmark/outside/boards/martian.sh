#!/usr/bin/env bash
# Scores a saved release run's findings on Martian's cases with Martian's own
# offline pipeline, at the commit benchmark/outside/boards.json pins.
#
#   benchmark/outside/boards/martian.sh --prepare
#       fetches their pinned checkout into the bench cache
#       ($OPENQODEX_BENCH_CACHE/upstream/code-review-benchmark@<commit>) and
#       builds its venv beside it (code-review-benchmark@<commit>.venv) with
#       uv, Python 3.11 and their uv.lock, so the checkout holds nothing but
#       the pinned tree; nothing is installed globally.
#   benchmark/outside/boards/martian.sh <run folder> (--wave <id> | --dry-run)
#       1. converts the run (outside/convert/martian.mjs) into
#          <run>/outside/martian/, unless it holds a conversion already;
#          only a release run converts, and the access is logged;
#       2. with --dry-run, checks the judge settings, the conversion's
#          manifest and access line, and prints the commands with their
#          values hidden, and stops;
#       3. prepares their checkout and runs their steps 2, 2.5 and 3 and
#          score_profiles in <run>/outside/martian/work (martian-judge.mjs),
#          which checks the conversion and the release gate again first,
#          and reserves the judging's forecast in the wave named by --wave
#          (benchmark/lib/wave.mjs);
#       4. leaves <tool>/evaluation.json per tool name and eval.json.
#
# The judge's base URL and key never pass through this script:
# martian-judge.mjs reads them with lib/model-env.mjs and puts them only into
# the environment of the pipeline steps that call the judge. This script
# holds no secret, so it prints none, even under bash -x. Core files are off
# for this script and all it starts, so a crash writes none anywhere. The
# bench cache, and every folder used under it, must lie outside this
# repository by its real path. Their code is never patched.
# Run with Node 22 first on PATH. Stops at the first failure.
set -euo pipefail
umask 077
ulimit -c 0

here=$(cd "$(dirname "$0")" && pwd)
convert="$(dirname "$here")/convert/martian.mjs"
judge="$here/martian-judge.mjs"

die() {
  echo "martian.sh: $1" >&2
  exit 2
}

dry=0
prepare_only=0
run=""
wave=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prepare) prepare_only=1 ;;
    --dry-run) dry=1 ;;
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

# The checkout and its venv, each refused when its real path is in the repository.
where() {
  local paths
  paths=$(node "$convert" paths 2>&1) || die "${paths#refused: }"
  { read -r checkout; read -r venv; } <<<"$paths"
}
where
offline="$checkout/offline"
python="$venv/bin/python"

prepare() {
  if [ ! -d "$checkout/.git" ]; then
    mkdir -p "$checkout"
    where
    git -C "$checkout" init -q
    git -C "$checkout" fetch -q --depth 1 "https://github.com/$repo.git" "$commit"
    git -C "$checkout" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  [ "$(git -C "$checkout" rev-parse HEAD)" = "$commit" ] || die "$checkout is not at $commit; move it to the Trash and run --prepare again"
  if [ ! -x "$python" ]; then
    command -v uv >/dev/null || die "uv builds their pipeline's venv and is not on PATH (https://docs.astral.sh/uv/)"
    UV_PROJECT_ENVIRONMENT="$venv" uv sync -q --frozen --no-dev --python 3.11 --project "$offline"
  fi
  where
}

if [ "$prepare_only" = 1 ]; then
  [ -z "$run" ] || die "--prepare takes no run folder"
  prepare
  echo "martian.sh: Martian's pipeline at $commit is ready in $checkout"
  exit 0
fi

[ -n "$run" ] || die "usage: martian.sh --prepare | martian.sh <run folder> (--wave <id> | --dry-run)"
[ "$dry" = 1 ] || [ -n "$wave" ] || die "--wave <id> is required: the judging pays a model (node benchmark/lib/wave.mjs --wave-new <id> starts one)"
[ -f "$run/manifest.json" ] || die "$run holds no manifest.json; it is not a benchmark run"
run=$(cd "$run" && pwd)
out="$run/outside/martian"

if [ -f "$out/convert.json" ]; then
  echo "martian.sh: $out holds a conversion already; martian-judge.mjs checks it against the run's manifest and the access log"
else
  node "$convert" convert "$run"
fi

if [ "$dry" = 1 ]; then
  exec node "$judge" "$run" --dry-run --checkout "$offline" --python "$python"
fi

prepare
exec node "$judge" "$run" --checkout "$offline" --python "$python" --wave "$wave"
