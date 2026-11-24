#!/usr/bin/env bash
# The GitHub Action's step (action.yml runs it): the full review when the
# step's environment holds ANTHROPIC_API_KEY or `review` is required, the
# scanners only otherwise. Every value comes from the environment, never
# pasted into the script:
#   OPENQODEX_VERSION   the openqodex version to run
#   BASE_SHA            the pull request's base commit, empty outside one
#   BASE_REF            the pull request's base branch, empty outside one
#   PUSH_BEFORE         a push event's previous commit (all zeros for a new ref)
#   DEFAULT_BRANCH      the repository's default branch
#   BLOCK_ON_SEVERITY   empty, or a severity name
#   CONFIG_FROM         base or head
#   EVENT_NAME          the event that started the workflow
#   REVIEW              auto, off or required
#   CLAUDE_CODE_VERSION the Claude Code version the review runs
#   REVIEWERS           the tools of the config's reviewer list, in order
#                       (claude, codex), from the plan step's doctor; empty
#                       when the config lists none
#   ANTHROPIC_API_KEY   the repository's key, set on the step from a secret
#   OPENQODEX_STEP      plan for the Action's first step: the cache key of
#                       the scanner folder, nothing installed or scanned
#   RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, RUNNER_OS, RUNNER_ARCH
#                       set by the runner
# The key leaves the environment on the first line below. Only the review
# command gets it back: doctor, the Claude Code install and a fallback scan
# never see it, and nothing here prints it or writes it to a file.
# The script's own helpers (od, tee, mktemp, sed and the rest) come from the
# system folders only. git, node, npx, npm and claude, and the runtimes the
# scanners use, come from the workflow's PATH only when the file and every
# link on the way to it lie outside the repository; the script runs them by
# their resolved paths, and its programs get a PATH of links to those files
# plus the system folders, never the workflow's PATH.
# The output of every program goes to the job log with workflow commands
# off, so text from the pull request (a file name) cannot write one.
# The scanner install, the review and the scan run under one tool-failure
# policy: a failure sets status tool-failed and warns; the next step decides
# whether that fails the job.
set -eo pipefail

key="${ANTHROPIC_API_KEY-}"
unset ANTHROPIC_API_KEY
workflow_path="${PATH-}"
BOOTSTRAP_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
PATH="$BOOTSTRAP_PATH"
export PATH

plain_name() { [[ "$1" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]] && [[ "$1" != -* ]]; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
# A SemVer release version, which npm installs as it is: MAJOR.MINOR.PATCH
# without leading zeros, each at most 9 digits, and an optional prerelease
# of dot-separated identifiers (letters, digits, hyphens; none empty, no
# leading zero in a number), 64 characters in all at most. Never build
# metadata, a path, a file: or git package, an alias, a tag or a range, nor
# a number or a length npm's version parser refuses and reads as a tag.
SEMVER_NUMBER='(0|[1-9][0-9]{0,8})'
SEMVER_IDENT='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER="^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(-${SEMVER_IDENT}(\\.${SEMVER_IDENT})*)?\$"
is_version() { [ "${#1}" -le 64 ] && [[ "$1" =~ $SEMVER ]]; }

# A wrong input is a workflow error: it fails the step with one line, before
# any program runs.
case "$CONFIG_FROM" in
  base | head) ;;
  *)
    echo "::error title=OpenQodex input::config-from must be base or head"
    exit 1
    ;;
esac
case "$BLOCK_ON_SEVERITY" in
  "" | info | nitpick | minor | major | critical) ;;
  *)
    echo "::error title=OpenQodex input::block-on-severity must be empty or one of info, nitpick, minor, major, critical"
    exit 1
    ;;
esac
case "$REVIEW" in
  auto | off | required) ;;
  *)
    echo "::error title=OpenQodex input::review must be auto, off or required"
    exit 1
    ;;
esac
if ! is_version "$OPENQODEX_VERSION"; then
  echo "::error title=OpenQodex input::version must be an exact release version such as 0.6.1"
  exit 1
fi
if ! is_version "$CLAUDE_CODE_VERSION"; then
  echo "::error title=OpenQodex input::claude-code-version must be an exact release version such as 2.1.289"
  exit 1
fi

# The repository root: the nearest folder up from here that holds .git, so
# a working folder inside the repository still protects all of it. Shell
# builtins only, since no program is trusted yet.
repo_root="$(pwd -P)"
while [ -n "$repo_root" ] && [ ! -e "${repo_root}/.git" ]; do repo_root="${repo_root%/*}"; done
[ -n "$repo_root" ] || repo_root="$(pwd -P)"
in_repo() {
  case "$1/" in "${repo_root}/"*) return 0 ;; esac
  return 1
}

# The workflow's PATH without relative folders and folders in the
# repository, searched for the programs below only: a pull request can
# commit a folder of programs, and a workflow can put such a folder on PATH.
search_path=""
rest="${workflow_path}:"
while [ -n "$rest" ]; do
  entry="${rest%%:*}"
  rest="${rest#*:}"
  case "$entry" in /*) ;; *) continue ;; esac
  real="$(cd -P "$entry" 2>/dev/null && pwd -P)" || continue
  if in_repo "$real"; then continue; fi
  search_path="${search_path:+${search_path}:}${entry}"
done

# The file an absolute path names, each part of the path and each link on
# the way followed one step at a time, printed only when no step lands in
# the repository; status 1 otherwise. So a link the checkout holds, or a
# link that passes through it, never decides what runs.
resolve_outside() {
  local rest="$1" cur="" part link n=0
  case "$rest" in /*) ;; *) return 1 ;; esac
  while [ -n "$rest" ]; do
    part="${rest%%/*}"
    if [ "$part" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    case "$part" in
      "" | .) continue ;;
      ..)
        cur="${cur%/*}"
        continue
        ;;
    esac
    if in_repo "${cur}/${part}"; then return 1; fi
    if [ -L "${cur}/${part}" ]; then
      n=$((n + 1))
      [ "$n" -le 64 ] || return 1
      link="$(readlink "${cur}/${part}")" || return 1
      case "$link" in /*) cur="" ;; esac
      rest="${link}${rest:+/${rest}}"
    else
      cur="${cur}/${part}"
    fi
  done
  [ -f "$cur" ] && [ -x "$cur" ] || return 1
  printf '%s\n' "$cur"
}

# The resolved file of a program on the workflow's PATH, the first one found
# there, when it passes resolve_outside; nothing, and status 1, otherwise.
# The script runs programs by these paths only.
program() {
  local rest="${search_path}:" dir
  while [ -n "$rest" ]; do
    dir="${rest%%:*}"
    rest="${rest#*:}"
    [ -n "$dir" ] || continue
    if [ -f "${dir}/$1" ] && [ -x "${dir}/$1" ]; then
      resolve_outside "${dir}/$1"
      return
    fi
  done
  return 1
}
refuse() {
  echo "::error title=OpenQodex::OpenQodex found no $1 on PATH outside the repository, links followed; it never runs a program the checkout holds"
  exit 1
}
git_bin="$(program git)" || refuse git
node_bin="$(program node)" || refuse node
npx_bin="$(program npx)" || refuse npx
npm_bin="$(program npm)" || npm_bin=""

out_dir="$(mktemp -d "${RUNNER_TEMP}/openqodex-XXXXXX")"
# The PATH the programs get: a folder of links named for each program the
# script validated, pointing at the resolved files, then the system folders.
# A scanner's runtime (ruby, gem, go, uv, xz) is linked the same way when the
# workflow's PATH has one that passes the same check; nothing else from that
# PATH reaches a program.
links="${out_dir}/bin"
mkdir "$links"
ln -s "$git_bin" "${links}/git"
ln -s "$node_bin" "${links}/node"
ln -s "$npx_bin" "${links}/npx"
if [ -n "$npm_bin" ]; then ln -s "$npm_bin" "${links}/npm"; fi
for runtime in ruby gem go uv xz; do
  if file="$(program "$runtime")"; then ln -s "$file" "${links}/${runtime}"; fi
done
PATH="${links}:${BOOTSTRAP_PATH}"
export PATH

# While a program's output goes to the job log, the runner reads no workflow
# command in it: the output sits between ::stop-commands::<token> and
# ::<token>::. The token is new and unpredictable each run, read from
# /dev/urandom by the system od, and never exported, so no program can end
# the stretch early.
token="$(/usr/bin/od -An -N16 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')"

# Runs a command with its stdout and stderr copied to the job log, both on
# stdout so they stay inside the stretch, and its stderr also to the file
# $1 for the reason line. Returns the command's exit code. The Action's own
# annotations are written outside these stretches.
forward() {
  local file="$1" rc
  shift
  echo "::stop-commands::${token}"
  { "$@" 2>&1 1>&3 3>&- | tee "$file"; rc=${PIPESTATUS[0]}; } 3>&1
  printf '\n::%s::\n' "$token"
  return "$rc"
}

# The commit the change is measured from: the pull request's base, a push's
# previous commit, or for a push that creates a branch the merge base with
# the default branch. Fetched when the checkout lacks it.
base=""
if is_sha "$BASE_SHA"; then
  base="$BASE_SHA"
elif [ "$EVENT_NAME" = "push" ] && is_sha "$PUSH_BEFORE"; then
  if [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
    if plain_name "$DEFAULT_BRANCH" && "$git_bin" fetch --no-tags --quiet origin "refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}" 2>/dev/null; then
      base="$("$git_bin" merge-base HEAD "refs/remotes/origin/${DEFAULT_BRANCH}" 2>/dev/null || true)"
    fi
  else
    "$git_bin" cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null || "$git_bin" fetch --no-tags --quiet origin "$PUSH_BEFORE" 2>/dev/null || true
    if "$git_bin" cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then base="$PUSH_BEFORE"; fi
  fi
fi
no_base=""
[ -n "$base" ] || no_base=" This event gives no base to measure the change from, so OpenQodex uses its default scope."

# The reviewers this job may start: the config's list (review.reviewers,
# read from the same commit as the config), else Claude Code alone, as
# before lists existed. A word that is not a reviewer is dropped. Claude
# Code needs the Anthropic key or a runner login; Codex needs a codex on the
# runner's PATH, logged in, since the Action installs none.
listed=""
for tool in ${REVIEWERS-}; do
  case "$tool" in claude | codex) listed="${listed:+${listed} }${tool}" ;; esac
done
wants() { case " ${listed:-claude} " in *" $1 "*) return 0 ;; esac; return 1; }
codex_bin=""
if wants codex; then codex_bin="$(program codex)" || codex_bin=""; fi

# Review mode or scan mode. `note` is the one line that says, in scan mode,
# why there is no review or how to turn it on. The review never runs on
# pull_request_target: that event hands the repository's secrets to a
# workflow run on code from forks.
mode=scan
review_status=off
note=""
if [ "$REVIEW" = "off" ]; then
  note="The review is off: the workflow sets review: off."
elif [ "$EVENT_NAME" = "pull_request_target" ]; then
  note="The review never runs on pull_request_target, which hands the repository's secrets to code from forks, so this job runs the scanners only."
elif [ "$EVENT_NAME" != "pull_request" ] && [ "$EVENT_NAME" != "push" ]; then
  note="The review runs on pull_request and push events only, so this job runs the scanners only."
elif { wants claude && [ -n "$key" ]; } || [ -n "$codex_bin" ] || [ "$REVIEW" = "required" ]; then
  mode=review
elif wants claude; then
  note="To run the full review in this job, set ANTHROPIC_API_KEY on this step from a repository secret; GitHub gives no secrets to a pull request from a fork."
  if wants codex; then note="${note} The config's list also names Codex, and this runner has no codex on its PATH."; fi
else
  note="The config's reviewer list names Codex only, and this runner has no codex on its PATH, logged in, so this job runs the scanners only."
fi

if [ "${OPENQODEX_STEP-}" = "plan" ]; then
  :
elif [ "$mode" = "review" ]; then
  if [ -z "$listed" ] || [ "$listed" = "claude" ]; then
    if [ -n "$key" ]; then who="on the repository's Anthropic API key"; else who="on this runner's Claude Code login"; fi
    echo "OpenQodex review: this job runs the full review of the change, with Claude Code ${CLAUDE_CODE_VERSION} as the reviewer, ${who}.${no_base}"
  else
    echo "OpenQodex review: this job runs the full review of the change, with the config's reviewer list (${listed}), each entry tried in order.${no_base}"
  fi
else
  echo "OpenQodex scanners only: this job runs the scanners on the change and is not a review. The full review runs on your machine with openqodex review.${no_base}"
  echo "$note"
fi

sarif=""
err="${out_dir}/stderr.txt"
# npx and npm run from out_dir, never from the checkout: there npm would read
# the pull request's .npmrc (its own registry) and could run an openqodex the
# pull request committed under node_modules. OpenQodex gets the checkout as --cwd.
repo_dir="$PWD"

# The last non-empty line of a file, safe inside a workflow command: one
# line, no control characters, no %, no run of colons.
last_line() {
  { grep -v '^[[:space:]]*$' "$1" || true; } | tail -n 1 | tr -d '\000-\037\177' | sed -e 's/%/%25/g' -e 's/::*/:/g' | cut -c 1-300
}

# A line for a workflow command: the same rules as last_line. GNU sed and
# cut end their output with a newline and the BSD ones do not, so the text is
# captured and printed again: the result is the same on Linux and macOS.
command_text() {
  local out
  out="$(printf '%s' "$1" | tr -d '\000-\037\177' | sed -e 's/%/%25/g' -e 's/::*/:/g' | cut -c 1-300)"
  printf '%s' "$out"
}

# A line for the job summary: one line, every character markdown or HTML
# gives meaning to escaped (the characters the review report escapes), so
# text from the pull request makes no structure.
summary_text() {
  local out
  out="$(printf '%s' "$1" | tr -d '\000-\037\177' | sed -e 's/[]\`*_[()!<>#|~\\]/\\&/g' | cut -c 1-600)"
  printf '%s' "$out"
}

# The config and the review's custom instructions, always as files in this
# run's own folder, read from the git objects of one commit and never from
# the work tree: in a pull request with config-from: base, the base branch
# (the pull request's own config could hide findings); otherwise the
# checked-out commit. Only a regular file in that commit counts: a link, a
# folder or nothing at the path gives the built-in defaults and no
# instructions. So no command here reads .openqodex/ in the checkout, and a
# link committed there cannot stop one.
config_file="${out_dir}/config.yaml"
instructions_file="${out_dir}/custom-instructions.md"
: > "$config_file"
: > "$instructions_file"
# Writes the file at path $2 of commit $1 to $3 when the commit holds a
# regular file there, by its object id; status 1 otherwise.
blob_to() {
  local entry mode type sha rest
  entry="$("$git_bin" ls-tree --full-tree "$1" -- "$2" 2>/dev/null)" || return 1
  read -r mode type sha rest <<< "$entry"
  [ "$type" = "blob" ] || return 1
  case "$mode" in 100644 | 100755) ;; *) return 1 ;; esac
  "$git_bin" cat-file blob "$sha" > "$3" 2>/dev/null
}
settings_commit=HEAD
if { [ "$EVENT_NAME" = "pull_request" ] || [ "$EVENT_NAME" = "pull_request_target" ]; } && [ "$CONFIG_FROM" = "base" ]; then
  settings_commit=""
  if ! plain_name "$BASE_REF"; then
    echo "::warning title=OpenQodex config::the base branch name is not a plain branch name, so OpenQodex uses the built-in defaults"
  elif ! forward "${out_dir}/fetch.txt" "$git_bin" fetch --no-tags --quiet origin "refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"; then
    echo "::warning title=OpenQodex config::could not fetch the base branch, so OpenQodex uses the built-in defaults, not the pull request's config"
  else
    settings_commit="refs/remotes/origin/${BASE_REF}"
  fi
fi
if [ -n "$settings_commit" ]; then
  blob_to "$settings_commit" .openqodex/config.yaml "$config_file" ||
    blob_to "$settings_commit" .openqodex.yaml "$config_file" ||
    : > "$config_file"
  blob_to "$settings_commit" .openqodex/custom-instructions.md "$instructions_file" ||
    : > "$instructions_file"
fi
config_args=(--config "$config_file")
instructions_ref=none
if [ -n "$settings_commit" ]; then
  instructions_ref="$("$git_bin" rev-parse --verify "${settings_commit}^{commit}")"
fi
instructions_args=(--instructions "$instructions_file" --instructions-ref "$instructions_ref")

# Claude Code at the pinned version: the claude on the workflow's PATH when
# it is that version and passes resolve_outside, else a copy installed from
# npm into the runner's temporary folder, never over a Claude Code the runner
# has. The one chosen is linked as claude in the programs' PATH.
claude_prefix="${RUNNER_TEMP}/openqodex-claude-code"
claude_version() { (cd "$out_dir" && "$1" --version 2>/dev/null) | head -n 1 | cut -d ' ' -f 1; }
install_claude_code() { (cd "$out_dir" && "$npm_bin" install --global --prefix "$claude_prefix" --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"); }
use_claude_code() {
  local claude=""
  if claude="$(program claude)" && [ "$(claude_version "$claude")" = "$CLAUDE_CODE_VERSION" ]; then
    ln -s "$claude" "${links}/claude"
    return 0
  fi
  claude="$(resolve_outside "${claude_prefix}/bin/claude")" || claude=""
  if [ -z "$claude" ] || [ "$(claude_version "$claude")" != "$CLAUDE_CODE_VERSION" ]; then
    [ -n "$npm_bin" ] || return 1
    echo "Installing Claude Code ${CLAUDE_CODE_VERSION} from npm"
    forward "${out_dir}/npm.txt" install_claude_code || return 1
    claude="$(resolve_outside "${claude_prefix}/bin/claude")" || return 1
    [ "$(claude_version "$claude")" = "$CLAUDE_CODE_VERSION" ] || return 1
  fi
  ln -s "$claude" "${links}/claude"
}

# This run's own review folder, one field per line:
#   report    complete, incomplete, unreadable, or none without report.json
#   blocking  1 when a finding (or, in a complete review, a candidate
#             nobody checked) meets the block severity
#   reviewer  the reviewer and its version, from the report, else from
#             reviewer.json
#   missing   what the review is missing
#   started   true or false from reviewer.json, which review writes there
#             when the reviewer starts or none can; empty without it
#   reasons   why no reviewer could start
read_run() {
  "$node_bin" -e '
const fs = require("fs");
const path = require("path");
const file = (name) => path.join(process.argv[1], name);
const parse = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
const read = (name) => (fs.existsSync(file(name)) ? parse(file(name)) : null);
const r = read("report.json");
const s = read("reviewer.json");
const c = (r && r.completion) || {};
const order = ["info", "nitpick", "minor", "major", "critical"];
const at = r ? order.indexOf(r.block_on_severity) : -1;
const complete = Boolean(r) && c.status === "complete" && r.verdict !== "incomplete";
// An incomplete review lists every scanner candidate it never checked; the
// scan that runs after it judges those, so only its findings count here.
const severities = r ? (r.findings || []).map((f) => f.severity).concat(complete ? (r.not_reviewed || []).map((n) => n.reviewSeverity) : []) : [];
const blocking = Boolean(r) && (r.verdict === "blocked" || (at >= 0 && severities.some((x) => order.indexOf(x) >= at)));
const line = (x) => String(x).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
const report = r === null ? "none" : r === undefined ? "unreadable" : complete ? "complete" : "incomplete";
const who = c.reviewer ? `${c.reviewer.driver} ${c.reviewer.version}` : s && s.driver ? `${s.driver} ${s.version}` : "";
const started = s ? (s.started === true ? "true" : "false") : "";
const reasons = s && Array.isArray(s.reasons) ? s.reasons.join("; ") : "";
process.stdout.write([report, blocking ? "1" : "0", line(who), line((c.missing || []).join("; ")), started, line(reasons)].join("\n") + "\n");
' "$1"
}

# What the review came to, from its exit code ($1), the files it wrote in
# this run's own folder ($2) and its stderr ($3): sets review_status, code,
# run_scan, review_reason, reviewer and summary_file. A report counts only
# with the exit code that goes with it: 0 or 1 for a complete one, 2 for an
# incomplete one. Any other end (a crash, a kill, a failure after the report
# was written) is a tool failure, and a blocking finding in a report it left
# still counts. Whether the reviewer started comes from reviewer.json, never
# from what review printed.
review_result() {
  local rc="$1" dir="$2" report="" blocking="" missing="" started="" reasons="" last
  # Empty last fields are cut from the output, so a read can meet its end.
  { IFS= read -r report; IFS= read -r blocking; IFS= read -r reviewer; IFS= read -r missing; IFS= read -r started; IFS= read -r reasons; } <<< "$(read_run "$dir")" || true
  if [ "$report" = "complete" ] || [ "$report" = "incomplete" ]; then summary_file="${dir}/report.md"; fi
  if [ "$report" = "complete" ] && { [ "$rc" = "0" ] || [ "$rc" = "1" ]; }; then
    review_status=complete
    if [ "$blocking" = "1" ] || [ "$rc" = "1" ]; then code=1; else code=0; fi
    return 0
  fi
  if [ "$report" = "none" ] && [ "$rc" = "0" ] && [ -z "$started" ]; then
    review_status=skipped
    code=0
    return 0
  fi
  # The reviewer may have stopped before it checked any scanner finding, or
  # never started: the scan runs too, so a scanner finding still counts.
  run_scan=1
  if [ "$report" = "incomplete" ] && [ "$rc" = "2" ]; then
    review_status=incomplete
    review_reason="${missing:-the review is incomplete}"
  elif [ "$report" = "none" ] && [ "$rc" = "2" ] && [ "$started" = "false" ]; then
    review_status=unavailable
    review_reason="${reasons:-no reviewer could start}"
  else
    if [ "$report" = "complete" ] || [ "$report" = "incomplete" ] || [ "$started" = "true" ]; then review_status=incomplete; else review_status=unavailable; fi
    review_reason="openqodex review stopped with exit code ${rc}"
    last="$(last_line "$3")"
    [ -z "$last" ] || review_reason="${review_reason}: ${last}"
  fi
  if [ "$blocking" = "1" ]; then code=1; else code=2; fi
}

npx_openqodex() { (cd "$out_dir" && "$npx_bin" -y "openqodex@${OPENQODEX_VERSION}" "$@" --cwd "$repo_dir"); }
# The one command that gets the key, in its environment only (never on a
# command line, where other processes could read it).
review_with_key() { (cd "$out_dir" && ANTHROPIC_API_KEY="$key" "$npx_bin" -y "openqodex@${OPENQODEX_VERSION}" "$@" --cwd "$repo_dir"); }

# The plan step: the key the scanner folder is cached under, from the hash of
# the pinned scanner table and the scanners this repository's files call for,
# as doctor --install in the next step installs them, with the same config.
# A release that pins nothing new keeps the key, so the cache is reused; a
# TypeScript repository's key never holds brakeman. It prints the reason
# line of each scanner, installs nothing and runs no scan. When doctor gives
# no plan, the key falls back to the openqodex version.
if [ "${OPENQODEX_STEP-}" = "plan" ]; then
  plan_file="${out_dir}/plan.json"
  set +e
  npx_openqodex doctor --json "${config_args[@]}" > "$plan_file" 2> "${out_dir}/plan-stderr.txt"
  set -e
  plan="$("$node_bin" -e '
const fs = require("fs");
const crypto = require("crypto");
let r;
try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
if (!r || typeof r.toolchain !== "string" || !Array.isArray(r.downloads)) process.exit(0);
const set = r.downloads.filter((x) => typeof x === "string").sort().join(",");
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);
const line = (x) => String(x).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300);
const tools = ((r.reviewers && r.reviewers.entries) || []).map((e) => e && e.tool).filter((t) => t === "claude" || t === "codex");
process.stdout.write(`${r.toolchain.slice(0, 16)}-${sha(set)}\n`);
process.stdout.write(`${tools.join(" ")}\n`);
for (const c of r.selection || []) if (c && c.wanted) process.stdout.write(`${line(c.line)}\n`);
' "$plan_file" || true)"
  cache_part="$(printf '%s\n' "$plan" | head -n 1)"
  if [[ ! "$cache_part" =~ ^[0-9a-f]{16}-[0-9a-f]{16}$ ]]; then cache_part="v${OPENQODEX_VERSION}"; fi
  echo "cache-key=openqodex-tools-${RUNNER_OS-}-${RUNNER_ARCH-}-${cache_part}" >> "$GITHUB_OUTPUT"
  # The list's tools for the next step, each a known word only.
  plan_tools=""
  for tool in $(printf '%s\n' "$plan" | sed -n 2p); do
    case "$tool" in claude | codex) plan_tools="${plan_tools:+${plan_tools} }${tool}" ;; esac
  done
  echo "reviewers=${plan_tools}" >> "$GITHUB_OUTPUT"
  echo "OpenQodex scanners this repository needs:"
  echo "::stop-commands::${token}"
  printf '%s\n' "$plan" | tail -n +3
  printf '\n::%s::\n' "$token"
  exit 0
fi

set +e
forward "$err" npx_openqodex doctor --install "${config_args[@]}"
code=$?
scan_failed=""
run_scan=""
review_reason=""
reviewer=""
summary_file=""
if [ "$code" != "0" ]; then
  code=2
  scan_failed=1
  if [ "$mode" = "review" ]; then
    review_status=unavailable
    review_reason="the scanner install failed, so neither the review nor the scan ran"
  fi
elif [ "$mode" = "scan" ]; then
  run_scan=1
elif wants claude && ! use_claude_code && [ -z "$codex_bin" ]; then
  review_status=unavailable
  review_reason="Claude Code ${CLAUDE_CODE_VERSION} could not be installed from npm"
  run_scan=1
else
  # Codex from the runner's PATH, when the list names it. Claude Code that
  # could not be installed is not on the programs' PATH, so the review
  # passes its entry over with that reason.
  if [ -n "$codex_bin" ]; then ln -s "$codex_bin" "${links}/codex"; fi
  # The run's files go to a folder of this run's own, and review touches
  # nothing under .openqodex/ in the checkout, so a report or a link the pull
  # request committed there is never read and cannot stop the run. The
  # reviewer's web tools are off for this run, whatever the config says.
  # Without a list, Claude Code reviews, as before lists existed; with one,
  # the list decides, and no reviewer it does not name is started.
  report_dir="${out_dir}/review"
  review_err="${out_dir}/review-stderr.txt"
  rargs=(review "${config_args[@]}" "${instructions_args[@]}" --reviewer-web off --report-dir "$report_dir")
  if [ -z "$listed" ]; then rargs+=(--reviewer claude); fi
  if [ -n "$base" ]; then rargs+=(--base "$base"); fi
  if [ -n "$BLOCK_ON_SEVERITY" ]; then rargs+=(--block-on-severity "$BLOCK_ON_SEVERITY"); fi
  if [ -n "$key" ]; then
    forward "$review_err" review_with_key "${rargs[@]}"
  else
    forward "$review_err" npx_openqodex "${rargs[@]}"
  fi
  rc=$?
  review_result "$rc" "$report_dir" "$review_err"
  if [ "$review_status" = "complete" ]; then sarif="${report_dir}/report.sarif"; fi
fi

if [ -n "$run_scan" ]; then
  # The scan's SARIF is the one uploaded: after a review that did not
  # complete, it is the whole set of scanner findings. Its files go to a
  # folder of this run's own, never under .openqodex/ in the checkout.
  review_code="$code"
  sarif="${out_dir}/openqodex.sarif"
  scan_dir="${out_dir}/scan"
  args=(scan "${config_args[@]}" --format sarif --output "$sarif" --report-dir "$scan_dir")
  if [ -n "$base" ]; then args+=(--base "$base"); fi
  if [ -n "$BLOCK_ON_SEVERITY" ]; then args+=(--block-on-severity "$BLOCK_ON_SEVERITY"); fi
  forward "$err" npx_openqodex "${args[@]}"
  code=$?
  # Anything but 0 and 1 (a crash, a kill: 137, 139, 143) is a tool error.
  if [ "$code" != "0" ] && [ "$code" != "1" ]; then
    code=2
    scan_failed=1
  fi
  # In review mode the result is the worse of the review and the scan: a
  # blocking finding from either is 1, and a review that did not complete is
  # a tool failure (2) otherwise.
  if [ "$mode" = "review" ]; then
    if [ "$code" = "1" ] || [ "$review_code" = "1" ]; then code=1; else code=2; fi
  fi
fi
set -e

echo "exit-code=$code" >> "$GITHUB_OUTPUT"
if [ "$code" = "0" ]; then
  echo "status=passed" >> "$GITHUB_OUTPUT"
elif [ "$code" = "1" ]; then
  echo "status=blocked" >> "$GITHUB_OUTPUT"
else
  echo "status=tool-failed" >> "$GITHUB_OUTPUT"
fi
if [ "$review_status" = "complete" ]; then echo "reviewed=true" >> "$GITHUB_OUTPUT"; else echo "reviewed=false" >> "$GITHUB_OUTPUT"; fi
echo "review-status=${review_status}" >> "$GITHUB_OUTPUT"
echo "reviewer=$(command_text "$reviewer")" >> "$GITHUB_OUTPUT"

if [ -n "$scan_failed" ]; then
  reason="$(last_line "$err")"
  [ -n "$reason" ] || reason="exit code $code"
  echo "::warning title=OpenQodex did not run::${reason}"
  echo "OpenQodex did not run: $(summary_text "$reason")" >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$review_status" = "incomplete" ] || [ "$review_status" = "unavailable" ]; then
  echo "::warning title=OpenQodex review did not complete::$(command_text "$review_reason")"
fi

# The job summary: this run's report as it wrote it, or one line on why
# there is none.
{
  case "$review_status" in
    complete)
      head -c 1000000 "$summary_file"
      ;;
    incomplete)
      echo "**The review did not complete:** $(summary_text "$review_reason")"
      echo
      if [ -n "$summary_file" ]; then
        echo "The report this run wrote follows. Its findings passed every check, but this job does not count it as a complete review."
        echo
        head -c 500000 "$summary_file"
        echo
      fi
      echo "The scanner findings below come from a separate scan, because the review did not complete."
      echo
      if [ -f "${scan_dir}/report.md" ]; then head -c 500000 "${scan_dir}/report.md"; fi
      ;;
    unavailable)
      echo "**The review did not complete:** $(summary_text "$review_reason")"
      echo
      if [ -n "$run_scan" ]; then echo "This job ran the scanners only instead."; fi
      ;;
    skipped)
      echo "OpenQodex review: nothing to review. The change has no file left after the config's exclusions."
      ;;
    off)
      if [ -n "$key" ] || [ "$REVIEW" = "required" ]; then echo "$note"; fi
      ;;
  esac
  if [ "$REVIEW" = "required" ] && [ "$review_status" != "complete" ] && [ "$review_status" != "skipped" ]; then
    echo
    echo "review: required is set, and this job has no complete review, so the job fails."
  fi
} >> "$GITHUB_STEP_SUMMARY"
if [ "$REVIEW" = "required" ] && [ "$review_status" != "complete" ] && [ "$review_status" != "skipped" ]; then
  echo "::error title=OpenQodex review required::this job has no complete review (review-status ${review_status})"
fi

if [ -n "$sarif" ] && [ -f "$sarif" ]; then
  echo "sarif=true" >> "$GITHUB_OUTPUT"
  echo "sarif-file=$sarif" >> "$GITHUB_OUTPUT"
else
  echo "sarif=false" >> "$GITHUB_OUTPUT"
fi
