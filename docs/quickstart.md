# Quickstart

## Paste this prompt into your agent

```
Install OpenQodex for yourself with `npx -y openqodex@0.11.1 init --yes --agent <host>`, where <host> is the agent you are: claude-code, codex, cursor or cline. Run it from this repository and allow it up to ten minutes: when a reviewer can start, it ends with a review of my current change.
Then tell me the verdict and the findings, or what its last lines say is missing.
```

The agent runs `init` for itself: the same install as the steps below, the push check included, with no question (`--yes`). Then `init` reviews your change and the agent tells you the result. The steps below do the same by hand.

Codex runs commands in a sandbox that by default cannot write outside the project or reach the network: from Codex, run the line in your own terminal instead.

The skill alone, with no push check, launcher or scanner download: `npx skills add openqodex/openqodex -g`. A later `init` replaces it with the skill it keeps up to date.

## Before you start

- Node 22 or newer, and git.
- Claude Code or Codex, installed and logged in. It is the reviewer OpenQodex starts. Without either, `review` runs the scanners, says "Full review unavailable", and names the command with which the agent you are in reviews the change itself.
- macOS or Linux. On Windows, use WSL.
- A git repository with a change in it.

## 1. Install into your agent

In your own terminal:

```
npx openqodex init
```

From inside an agent, the line is `npx -y openqodex@0.11.1 init --yes --agent <host>`, as in the prompt above.

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints each file it will write, for you and for the team, then asks once: "Write these files?". `--yes` skips the question. `agents` lists every file for each agent.

Inside a repository, `init` also:

- adds the git pre-push hook, so every push from that repository is checked for a review, from an agent or by hand. `--hook none` leaves it out.
- adds one line to each agent's global instruction file, such as `~/.claude/CLAUDE.md` for Claude Code: before any push, review the change with the openqodex skill. It prints the line before writing it.
- adds a review section to the repository's `CLAUDE.md` and `AGENTS.md`, so a teammate's agent reviews before it pushes too. `--no-repo` leaves it out.
- creates `.openqodex/config.yaml` and `.openqodex/custom-instructions.md`. Commit both. Write in `custom-instructions.md` what a reviewer of your repository must know: conventions, what never to flag, what always to check. The review brief carries it word for word.

After writing, `init` lists what it wrote for you, with the command that undoes it (`init --uninstall` through the launcher), and what it wrote for the team, to commit. `init --project` instead puts the agent files inside the repository, for the team to commit; the scanners and the record of what `init` wrote stay in `~/.openqodex` on your machine.

`init` also starts the scanner downloads that your repo needs, in the background: the ones its files call for, tracked or untracked, less the paths `review.paths.exclude` leaves out and any scanner `scanners.disable` switches off. It prints one line per scanner saying why, such as `oxlint: JavaScript or TypeScript files, such as app/index.tsx`. `init --dry-run` prints those lines and downloads nothing. Running it outside the agent matters: some agents run commands in a sandbox that cannot download.

Then `init` checks the reviewers: it prints "Reviewer ready" with the Claude Code or Codex it found, or "No reviewer can start yet" with what to fix for each.

Last, `init` reviews, when a reviewer can start: when the repository has a change, it runs `openqodex review` and prints its receipt. When it has none, it asks what to review: the whole repository, a pull request, a branch, or not now. With `--yes` or without a terminal it prints the three commands instead of asking. `--no-review` skips this step. The review waits up to two minutes for a scanner its change needs that is still downloading, names any still going after that, and never fails `init`. One line says how it ended: `First review: finished`, `incomplete`, `skipped` or `unavailable`.

Codex only: open Codex, run `/hooks` and trust the OpenQodex hook. Codex runs a new hook only after you trust it.

## 2. Ask for a review

Say to your agent:

```
review my change with openqodex
```

The agent runs `openqodex review` and shows you the receipt it prints. That one command works out the change, copies it to a temporary folder, runs the scanners and the code graph, and starts its own reviewer: a separate Claude Code or Codex process that reads that copy. The reviewer checks every scanner finding and is given every changed line; a script checks its answer, and OpenQodex writes the report and prints the receipt. It takes one to three minutes and uses your Claude Code or Codex plan. In your terminal, run it by the full path `init` prints, `~/.openqodex/bin/openqodex review`: an npx install puts no `openqodex` on your `PATH`, and `init` never edits your shell profile.

To review the whole repository instead of one change, say:

```
review my whole repo with openqodex
```

The agent runs `openqodex review --all`. The scanners check every file, and the brief tells the reviewer where to start: the most-called functions and the files with the most scanner hits. See `docs/cli.md` for the details.

To review a teammate's branch or a pull request before it merges, without leaving your own work, say:

```
review the branch feature/login with openqodex
review pull request #42 with openqodex
```

The agent runs `openqodex review feature/login` or `openqodex review '#42'`. OpenQodex fetches the branch or the pull request, checks it out in a temporary folder and reviews what it added since it left its base. Your working folder is not touched. See "Reviewing a branch or a pull request" in `docs/cli.md`.

## 3. Read the report, then choose what to fix

The agent shows you the receipt as OpenQodex printed it: the verdict, the reviewer's summary, one line per finding (its number, severity, category, title, file and line), and the absolute paths of `report.html` and `report.md`. Then it asks: "Fix all, or tell me which?"

Open `report.html` in a browser. It shows each changed file as a diff with each finding under its line: the problem, why it matters, the fix and its source. Below are the coverage, the scanners and the blast radius. The page runs no script and loads nothing. Then answer the agent by number, such as "fix 1 and 3", or say "fix all". The agent fixes only the findings you name, runs the review again and shows you the new receipt.

A complete review means every stage ran, every scanner finding was checked and every changed line was put in front of the reviewer; anything not covered is named. It does not mean nothing was missed. The report is in `.openqodex/reviews/<time>-<id>/` in your repo. `.openqodex/.gitignore` keeps the reports out of git; `git status` shows only the two files above and that `.gitignore`, the first time.

The verdict is `passed` unless `.openqodex/config.yaml` sets `review.block_on_severity` and a finding meets it. With no config, OpenQodex warns and never blocks.

## Try it on the demo repo

```
npx openqodex demo /tmp/openqodex-demo
```

`demo` builds a small repo with planted bugs: a secret, a SQL injection, a bad Dockerfile, a vulnerable lockfile, a shell bug and a workflow injection. It scans the change and prints the scanner report. Then run `openqodex review` in that folder, or open it in your agent and ask for a review.

## Without an agent

Run the review yourself:

```
npx openqodex review
```

`openqodex scan` runs the scanners only and prints their findings unchecked. It is the check the pre-commit hook runs, and the GitHub Action without an Anthropic API key; it is not a review.

## First run

Scanners download on first use into `~/.openqodex/tools/`. A review downloads only the scanners its changed files call for. A scanner still installing after 45 seconds keeps going in the background. The report lists it as installing. It joins the next run.

One measured first run, on 2026-10-02, when the demo needed eight scanners: an Apple Silicon Mac, an empty tool folder, a line of 2 MB per second. The first `demo` printed its report in under a minute. That report held the scanners that had finished installing and listed the rest as installing. The next `scan` included all eight. The sixteen scanners the demo needs now take about 1 GB of disk on an Apple Silicon Mac, measured on 2026-10-08.

To download what this repository needs now, run this inside it:

```
npx openqodex doctor --install
```

`--all-scanners` downloads every scanner.

## Next

- `config`: block pushes at a severity, exclude paths, switch scanners off.
- `custom-scanners`: add any scanner by its GitHub link.
- `security`: what runs and what is sent where.
