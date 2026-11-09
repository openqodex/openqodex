# Code review in Claude Code

OpenQodex gives you code review in Claude Code before you push. You ask for a review in Claude Code, or run one command in your terminal, and OpenQodex prints one report. It runs on your own Claude Code login, with no other key, account or server.

## What you get

OpenQodex is open source AI code review. One command, `openqodex review`, works out your change: the commits not yet pushed plus everything uncommitted. It runs the scanners that fit the changed files and keeps only findings on the lines you changed. A scanner is a program that checks code without a model, such as gitleaks or semgrep. Then OpenQodex starts its own reviewer: a separate Claude Code process, on your own login, that reads a frozen copy of the change. The review runs in stages: two finder processes read each changed file, or each part of a big one, with the code around the change, and a fresh verifier process checks every candidate they raise. Only a confirmed defect becomes a finding. A style, naming, docs or test item is shown as an observation, apart from the findings and outside the verdict. Every scanner finding is checked too, and every changed line is given to a finder. Scripts check each answer, and OpenQodex prints one report.

Large changed ranges are cut into measured parts. Each part carries at most 4,000 rendered rows (`DELIVER_LINES`) and 120 KB of rendered diff (`MAX_UNIT_DIFF_BYTES`), including headers and page context. Each finder brief is bounded by `MAX_BRIEF_BYTES`, 256 KB. An entry whose fixed brief blocks exceed that bound is noted as unread and is never sent. Every part gets two fresh finder sessions. A single line over a part's budget stays unread unless its full text reaches a reviewer. The completion record credits exact ranges as `brief`, `digest`, `page` or `read`; a deleted binary file has an explicit deletion entry. The single-pass route (`review.stages: false`) keeps its existing limits.

A structural summary, or digest, is built by code from a successful JSON parse or a recognised dependency store path. It replaces rows only when a changed range exceeds the part budget, or the store's changed files exceed that budget together. JSON is recognised by its contents, whatever its extension. Stores are path segments named `node_modules`, `.pnpm-store`, `.pnpm`, `.yarn/cache`, `site-packages`, `.cargo/registry` or `.m2/repository`; `vendor` is excluded. The reviewer sees paths and lines for changed scalar values, shapes, counts, type changes and numeric outliers, or the store's content kinds, manifests, largest files, complete short files and paginated file list. Short scalar values under 200 characters appear in full. Large JSON summaries continue across bounded pages, cutting only between entries and keeping odd records together. Each page credits only its own changed ranges. If the fixed summary alone exceeds the payload budget, the file takes parts. Records are matched by content first, then unmatched records are compared by index. When the old side is unavailable, change counts are unknown and the omission is named. Store summaries show the first 50 manifests and top-of-file generated markers with their counts; the full lists travel with the paginated file entries. Everything else takes parts. The record's `digest` entries and the report note `structural summary coverage` mean those exact ranges were processed and their summary reached a reviewer. Named omissions say what was grouped or shortened; the reviewer can read the source with tools. A saved file under `digests/` is for the developer and credits no coverage. Verifiers receive the fixed summary, entries for cited files or JSON lines, and cited snapshot lines, and evidence must still quote real source text.

Verifier briefs use bounded nearest-first selection under the same `MAX_BRIEF_BYTES` limit. They carry parts holding candidate lines first, then cited deletion fragments, then neighbouring parts in order of distance to the nearest candidate. Parts within 50 lines have priority over more distant parts, rather than a promise of delivery. Each omitted part of a cut entry gets one heading: "part k, lines a to b, not shown; read with your tools". Consecutive omitted whole hunks share a bounded list of changed line ranges, with "and N more" when the list is long. A batch splits by candidate when its candidate parts cannot fit together. If one candidate part and the fixed blocks exceed the bound, the review records that candidate as unverified instead of stopping with an error.

## Install

Run this in your own terminal:

```
npx openqodex init
```

Or ask Claude Code to run `npx -y openqodex@<version> init --yes --agent claude-code` (the README gives the current version): the same install, with no question.

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints every file it will write and asks once. In the default user scope, it writes these for Claude Code:

- the skill, in `~/.claude/skills/openqodex/SKILL.md`.
- the push gate hook, merged into `~/.claude/settings.json`.
- one line in `~/.claude/CLAUDE.md`: before any push, review the change with the openqodex skill.
- permission rules in `~/.claude/settings.json`, so Claude Code runs `review` and `review --all` without asking you.

`agents` lists every file, the project scope and the uninstall.

Other ways to install:

- The Claude Code plugin. The openqodex/openqodex repository holds a plugin marketplace with an `openqodex` plugin. The plugin carries the skill and the push gate hook. Its hook calls `npx -y openqodex@<version>`.
- The skill alone: `npx skills add openqodex/openqodex -g`. This writes the skill but no hook, launcher or scanner download.

OpenQodex needs Node 22 or newer and git. It runs on macOS and Linux. On Windows, use WSL.

## Run a review

Say to Claude Code:

```
review my change with openqodex
```

The skill tells Claude Code to run one command, `openqodex review`, wait for it, and show you the receipt it prints: the verdict, one line per finding and the absolute path of `report.html`. Then Claude Code asks "Fix all, or tell me which?" and fixes only the findings you name. Claude Code does not review the change itself and starts no subagent. In your own terminal, run `~/.openqodex/bin/openqodex review`, the full path `init` prints.

A review uses your own Claude Code plan. It can take minutes. On the 2026-10-09 benchmark run, a review of a small change took about two minutes with Claude Code. `review` prints a line every 15 seconds while the reviewer works. `openqodex review --all` reviews the whole repository instead of one change.

## What the reviewer can and cannot do

The reviewer is a fresh Claude Code process (`claude -p`) with no memory of your session. The reviewer:

- reads a frozen copy of the change in `~/.openqodex/checkouts/`, never your folder. Secrets the scanners found are redacted in every file of that copy first. Every file remains readable regardless of size; time and budget bound the review.
- has the read, search and list tools, plus Claude Code's WebSearch and WebFetch. It has no shell, no edits, no MCP server and no subagent.
- edits nothing and runs none of the repository's code.
- loads none of your Claude Code settings, hooks, plugins, memory or `CLAUDE.md` files as agent instructions. Repository files chosen in `review.instructions_files` are quoted as convention data in the brief. See [Convention files](config.md#convention-files).
- gets only the environment variables Claude Code needs to run and find its login. Other tokens in your shell, such as `GITHUB_TOKEN` or `NPM_TOKEN`, never reach it.

Every reviewer brief explains the frozen copy and says that `[redacted]` is a real value hidden by OpenQodex, never a placeholder or a missing value. To allowlist a known public value, add an `[allowlist]` section to the repository's root `.gitleaks.toml`: `paths` holds path regular expressions and `regexes` holds patterns matching values. Keep the default rules with `[extend]` and `useDefault = true`. The allowlist removes both the matching gitleaks candidates and their redaction, so the reviewer sees those values. See the [gitleaks example](scanners.md#gitleaks).

The verifier refutes placeholder claims where the copy reads `[redacted]`. It cannot yet distinguish a mask from the literal `"[redacted]"` committed by the repository. That literal gets no finding about being a placeholder until the redaction provenance follow-up records which file and line OpenQodex masked.

Claude Code's own permission rules refuse a read outside the frozen copy. OpenQodex also checks every tool call the reviewer makes. A refused attempt outside the copy, or on a tool the reviewer was not given, is listed on the receipt and does not fail the review. A read outside the copy or a successful call to a tool it was not given makes the review incomplete. A call with no result recorded still counts as a read. The report lists the files the reviewer read.

Web search is on by default. A reviewer that reads private code and untrusted text from the change, and can open web addresses, can be talked into putting that code into a web address. Set this in `~/.openqodex/config.yaml` to remove the web tools:

```yaml
reviewer_web: off
```

Claude Code sends the review brief and the files the reviewer reads to the model your Claude Code login uses, as any Claude Code session does. The brief is the text OpenQodex gives the reviewer to review from. OpenQodex and the built-in scanners send no code anywhere. `security` lists every network call.

When Codex is installed and logged in too, a review you run from Claude Code still uses Claude Code. `--reviewer codex` or `reviewer: codex` in `~/.openqodex/config.yaml` picks Codex.

## The push gate

`init` adds one `PreToolUse` hook to Claude Code. It matches the `Bash` tool and runs only for `git push` commands. The hook looks for the record `review` wrote for your current work. It does not know what a push sends: for a plain `git push` it asks whether your current work has a passing review, and for any other push command it says it cannot tell. The git pre-push hook below checks the exact commits a push sends. It never scans, never starts a review, and never approves a push for you.

By default the gate only warns:

- A complete review of this change that passed: the gate says nothing.
- No review of this change: one line asking you to run `openqodex review`.
- An incomplete review of this change: one line saying so. It never blocks.

The gate blocks only when `.openqodex/config.yaml` sets `review.block_on_severity`. Then it denies a push with no review of the change, so Claude Code runs the review and tries again. It also denies a push whose review is blocked, with the counts and the absolute path of `report.html`, and tells Claude Code to ask you which findings to fix. `config` explains how to block pushes at a severity.

`OPENQODEX_SKIP=1` in the environment lets the push through and says so. It is your switch, not your agent's.

Inside a repository, `init` also adds a git pre-push hook, so every push from the repository is checked for a review, from an agent or by hand. `--hook none` leaves it out.

## Review a pull request or a branch

To review a pull request or a branch that is not your current work:

```
openqodex review '#42'
openqodex review <branch>
```

OpenQodex fetches the pull request or the branch, checks it out in a temporary folder and reviews what it added since it left its base. Your working folder is not touched. When `gh` is installed, OpenQodex asks it for the pull request's base. A review of a branch or a pull request names its target, so Claude Code asks you before each one.

## The same review in a GitHub Action

The OpenQodex GitHub Action runs the review on a pull request when the workflow gives it your Anthropic API key. It runs the full `openqodex review`: the scanners and a separate Claude Code reviewer, with script checks of its answer. The job summary shows the report, and the findings go to GitHub code scanning. The reviewer's web tools are off there.

Add the key as a repository secret named `ANTHROPIC_API_KEY`, and set it on the OpenQodex step only. Each review spends your repository's own API credit at Anthropic's prices. Without a key, the Action runs the scanners only (`openqodex scan`), which is not a review. `github-action` gives the workflow and every input.

## What it does not do yet

- The reviewer needs Claude Code or Codex, installed and logged in. Without either, `review` prints "Full review unavailable", says what is missing, saves the unchecked scanner findings to a file it names, and names the command with which the agent you are in reviews the change itself (`review --agent`).
- No review on your own API key without Claude Code or Codex.

## Where the report goes

Claude Code shows you the receipt OpenQodex printed: the verdict (`passed` or `blocked`), the reviewer's summary, one line per finding with its number, severity, category, title, file and line, and the absolute paths of `report.html` and `report.md`.

Open `report.html` in a browser to read the review. It shows each changed file as a diff with each finding under its line: where it is, the problem, why it matters, the fix and its source. Below are the coverage, the scanners and the blast radius. The page runs no script and loads nothing. Then tell Claude Code which findings to fix, by number, or say "fix all".

The same review is in `.openqodex/reviews/<time>-<id>/` in your repository, as `report.html`, `report.md`, `report.json` and `report.sarif`. For staged reviews, `units.json` records the obligation inventory and its measured parts. `.openqodex/.gitignore` keeps the reports out of git.

Changed-line coverage is stored as intervals, so no file loses its coverage because a change has too many lines.

A complete review means every stage ran, every scanner finding was checked and every changed range was read, carried in a brief or page, or processed into a structural summary that reached the reviewer. It does not mean nothing was missed. When a review is not complete, `review` prints "Review incomplete" with what is missing, and exits 2.

## Next

- `agents`: every file `init` writes for each coding agent.
- `config`: block pushes at a severity, exclude paths, switch scanners off.
- `security`: what runs, what is sent where, and where files go.
