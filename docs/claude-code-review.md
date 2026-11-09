# Code review in Claude Code

OpenQodex gives you code review in Claude Code before you push. You ask for a review in Claude Code, or run one command in your terminal, and OpenQodex prints one report. It runs on your own Claude Code login, with no other key, account or server.

## What you get

OpenQodex is open source AI code review.
`openqodex review` checks commits not yet pushed and uncommitted work.
It runs scanners that fit the changed files.
A scanner checks code without a model, such as gitleaks or semgrep.
Only scanner findings on changed lines remain.
OpenQodex starts a separate Claude Code reviewer on your own login.
The reviewer reads a frozen copy of the change.
A brief is the starting text OpenQodex sends each reviewer session.
Two finder processes read each [unit](#rows-parts-and-units) of the change, with the code around it.
A unit is a few small files, one part of a big file, or one structural summary.
A fresh verifier process checks every candidate the finders raise.
Only confirmed defects become findings.
Style, naming, docs and test items appear as observations.
Observations do not affect the verdict.
Every scanner finding is checked too.
Scripts check each answer before OpenQodex prints the report.

## Large changes

No limit on file size, file count, line length or diff size decides what is reviewed.
Time and budget bound the review.
This section defines the words the other pages use for large changes.
The legacy single pass (`review.stages: false`) has no parts, structural summaries or coverage labels.
Its limits are under [`review.stages`](config.md#every-key).

### Rows, parts and units

A row is one rendered line of the diff, as a brief or delivery page shows it.
A changed range is a run of added or modified lines, or one deletion.
OpenQodex cuts a large changed range into measured parts.
Each part holds at most 4,000 rendered rows (`DELIVER_LINES`).
Each part holds at most 120 KB of rendered diff (`MAX_UNIT_DIFF_BYTES`).
KB means 1,024 bytes here.
Headers and context lines count towards both limits.
A unit is the work one pair of finder sessions receives.
A unit holds a few small files, one part or one structural summary.
Small files share a unit until their diff reaches 30 KB.
Each finder brief holds at most 256 KB (`MAX_BRIEF_BYTES`), its instructions included.
A range stays unread when its brief cannot fit that bound even alone.
The record names each such range.
The removed lines of a replacement go to one part, and the other parts point to it.
A deleted binary file is one changed range with no lines, because the deletion is the change.

### Delivery pages

A delivery page is a message that carries changed lines a session has not yet seen.
A finder or single-pass session gets one with each correction round, at most two.
Verifier sessions get none.
A delivery page holds at most 4,000 rows and 512 KB, context included.
A range too long for one page continues on the next page.

### Long lines

A line of 2,000 bytes or fewer travels whole.
A line over 2,000 bytes travels as fragments of at most 2,000 bytes each.
A fragment never splits a UTF-8 character, so some fragments are shorter.
Each fragment is labelled with its file, line number and bytes, such as `app.min.js: line 7, bytes 2,001 to 4,000 of 50,000,000`.
A removed line is labelled with its old path and old line number, such as `app.min.js: old line 7, bytes 1 to 2,000 of 6,000`.
A brief carries a long line whole when the line fits its part.
A line bigger than one part is cut into smaller parts until each fits a brief.
When the brief's fixed text alone exceeds its bound, the line stays unread and the record names it.
No line is too long to review; only time and budget bound it.
A line counts as given only when every fragment reached a reviewer.
A long line's fragments may continue on the next delivery page.
A reviewer's own read of a cut line credits only the bytes the read returned.
A read with no recorded byte ranges credits none of a line over 2,000 bytes.
A file that is not UTF-8 text is reviewed by bytes, and a read credits none of its long lines.
Missing bytes are listed beneath their changed range.
The receipt counts ranges, not gaps.

### Big patches

OpenQodex keeps up to 5 MB of a change's patch text in memory.
From that point on, file patches stream to temporary files.
The CLI writes them under `tmp/<change id>/diff/` in the OpenQodex home, `~/.openqodex` by default.
Only your user can read them.
They are removed when the review ends, whether it passed or failed.
Ctrl-C or a stop signal removes them too.
Nothing removes the files left behind by a process killed outright, such as with `kill -9`.
A patch over 5 MB is read from disk in bounded pages, never whole.
Removed lines come from the same patch, so they stay reviewable.

### Structural summaries

A structural summary is text that code builds from a parsed file and sends instead of its source lines.
Its machine label in `report.json` is `digest`.
OpenQodex builds one for a JSON file with a changed range bigger than one part.
The file must parse as JSON, and its file name does not matter.
It also builds one for a dependency store whose changed files together exceed one part.
A dependency store is a folder of downloaded packages.
A path is in a store when it lies inside a folder named `node_modules`, `.pnpm-store`, `.pnpm` or `site-packages`.
Three stores count only as a two-folder pair: `.yarn/cache`, `.cargo/registry` and `.m2/repository`.
So `.yarn` or `.cargo` alone is not a store.
`vendor` is not a store.
Every other file is cut into parts.

A JSON summary gives the top-level shape, its first 50 keys and its depth.
It lists each changed value under 200 characters in full, with its path and line.
Longer values are grouped by path, with the first 120 characters of each.
Records are matched by content first, then by position.
It counts added, removed and changed records for each group of records.
It lists record shapes, and shows each record of an unusual shape up to 2,048 bytes.
It also lists type changes and numeric outliers.
Group descriptions stop at 50 of each kind, and every changed value is still listed.
The old side is unavailable when its patch is over 5 MB or the old file does not parse.
Then the change counts read unknown, and each changed range is named as an omission.

A store summary gives the store folder, file counts by status, total lines and bytes, and content kinds.
It lists the first 50 manifests and the first 50 files marked generated or minified.
A manifest names a package and its version, from `package.json`, `PKG-INFO`, `METADATA`, `Cargo.toml` or a `.pom` file.
It lists the ten largest files.
Each file entry gives its changed ranges.
A text file under 30 lines appears in full.

A long summary continues on further pages, and each page goes to its own unit.
A JSON page never splits an entry or an unusual record.
A store's file list continues across pages, and each page repeats the store summary.
Each summary page credits only its own changed ranges.
When a JSON summary cannot be split into pages that fit, the file is cut into parts instead.
A summary page whose brief still exceeds the 256 KB brief bound stays unread.
The record names each changed range on that page.

A named omission says which lines a summary grouped or shortened, and why.
Named omissions appear in the reviewer's brief and in the saved summary file.
The reviewer can read any range of the source with its tools.
A verifier gets the summary entries its candidates cite, and two source lines either side of each cited line.
Evidence must still quote real source text.

### Verifier briefs

A verifier session gets the candidates for one changed file, at most six at a time.
Its brief holds the parts with candidate lines first, then cited removed lines, then the nearest other parts.
The same 256 KB brief bound applies.
Each part left out gets one heading, such as `(part 3, lines 801 to 1200, not shown; read with your tools)`.
Left-out whole ranges share one line, which ends with `and N more` when it is long.
A batch whose candidate parts cannot fit together is split in two.
A candidate whose own part cannot fit alone is recorded as not verified.

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

- reads a frozen copy of the change in `~/.openqodex/checkouts/`, never your folder. Secrets the scanners found are redacted in every file of that copy first. Every file remains readable regardless of size.
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

Claude Code sends the brief and files it reads to the model your Claude Code login uses.
OpenQodex and the built-in scanners send no code anywhere.
`security` lists every network call.

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

Coverage lists every changed file and how each of its ranges reached the reviewer.
Each range has one coverage label:

- `brief`: the lines reached a finder in its starting brief.
- `page`: the lines arrived on a [delivery page](#delivery-pages).
- `read`: the reviewer's successful tool reads covered the range.
- `structural summary`: a [structural summary](#structural-summaries) covered the range.
- `not examined`: nothing covered the range.

When two of these cover one range, the brief, summary or page is credited before tool reads.
Each interval is listed once.
`brief`, `page` and `read` are full coverage, and there is nothing to do.
`structural summary` means a parser read the range, and the reviewer saw its shape, values and counts.
The summary names what it left out.
When an exact value matters, the reviewer can read the file with its tools.
You can open the saved summary file, described below.

Every unexamined range has its own entry in the report.
The receipt names the first ten, then prints `and N more; the report names each one`.
The receipt's `Changed ranges` line takes one of three forms:

- counts per label, such as `Changed ranges: 40 in a finder's brief, 1 structural summary, 2 by page, 0 read by the reviewer, 0 not examined`;
- `Changed ranges: N examined, M not examined; coverage labels not recorded`, for a record without labels, as from the single pass;
- `Changed ranges: N examined, M not examined; range source counts not recorded`, for a record with labels but no list of ranges.

The same review is in `.openqodex/reviews/<time>-<id>/` in your repository, as `report.html`, `report.md`, `report.json` and `report.sarif`.
A staged review also saves `units.json`: every changed range, its measured parts and their units.
A review with structural summaries also saves `digests/<unit id>.md` for each summary page.
Each such file holds the summary, its processed ranges and its named omissions, with secrets redacted.
These files are for you to read, and they credit no coverage.
`.openqodex/.gitignore` keeps the reports out of git.
Changed-line coverage is stored as intervals, without a line-count ceiling.

### What complete means

A review is complete when its record lists nothing as missing.
The record lists as missing:

- a changed range the reviewer was never shown;
- no reviewer process started;
- a failure, such as a timeout, or a unit no finder examined;
- the snapshot changed while the reviewer read it;
- a scanner candidate with no disposition;
- an answer still failing its checks after the correction rounds;
- finder candidates the verifiers did not verify;
- a budget refusal, or no model call made, for a model reviewer;
- a read outside the snapshot, or outside the review's scopes;
- a successful call to a tool the reviewer was not given.

`review --all` reports range coverage but never requires it.
Complete does not mean nothing was missed.
An incomplete review prints "Review incomplete" and exits 2.

## Next

- `agents`: every file `init` writes for each coding agent.
- `config`: block pushes at a severity, exclude paths, switch scanners off.
- `security`: what runs, what is sent where, and where files go.
