# Commands

Run every command with `npx openqodex <command>`, or `openqodex <command>` when the package is installed. `openqodex --help` lists the four commands below: `init`, `review`, `update` and `trust`. The commands that hooks, the skill and the Action call (`scan`, `doctor`, `hook`, `guide`, `demo`, `report`) still work; `plumbing` describes them.

## Exit codes

- `0`: clean, or warnings only.
- `1`: a finding at or above `review.block_on_severity`. Without that key, no command exits 1.
- `2`: OpenQodex itself failed: a wrong flag, an invalid config, not a git repository, a stale review, or an internal error. `doctor` prints its table first and then exits 2.

A scanner that fails or is missing never changes the exit code. The report lists it with the reason.

When OpenQodex itself fails (exit 2 with `openqodex failed:`) or a scanner ends `failed`, OpenQodex prints the GitHub issue it would create and two choices: `1 create a GitHub issue` and `2 ignore`. `report` explains the choices. A missing scanner, a wrong flag or a finding never prints them. `hook check` never prints them.

## Which change is checked

By default the change is the commits not yet pushed plus everything uncommitted, untracked files included. OpenQodex finds the base in this order:

1. `--base <ref>`: the point where the current branch left that ref.
2. `--uncommitted`: the last commit, `HEAD`. Only uncommitted work counts.
3. The point where the branch left its upstream branch.
4. The point where the branch left the remote's default branch (`origin/HEAD`).
5. The last commit, `HEAD`.

A repository with no commits checks every file. OpenQodex never fetches from a remote.

## Shared flags

`scan`, `review`, `doctor`, `trust` and `guide` accept these flags. `demo` accepts only `--no-color`, `--quiet`, `--verbose`, `--no-install` and `--offline`. `init`, `hook` and `update` accept none of them.

- `--cwd <dir>`: find the repository from `<dir>`. A relative `--output` path still resolves from the folder you ran the command in.
- `--config <path>`: read this config file instead of `.openqodex.yaml` at the repo root.
- `--format <terminal|markdown|json|sarif>`: the report format. The default is `terminal`. Only `scan` and `review` use it.
- `--output <file>`: write the report to `<file>` instead of stdout. Only `scan` and `review` use it.
- `--no-color`: no colour. `NO_COLOR` set in the environment does the same.
- `--quiet`: no progress lines on stderr.
- `--verbose`: print the stack when OpenQodex itself fails.
- `--no-install`: do not download missing scanners. The report lists them as not installed.
- `--offline`: no built-in scanner goes online. osv-scanner and semgrep are skipped and listed as disabled. Scanner downloads are off. The daily version check does not start after this run.

`doctor --install` together with `--offline` or `--no-install` exits 2.

Progress goes to stderr. The report goes to stdout.

`openqodex --version` prints the version. `openqodex --help` lists the commands.

## review

```
openqodex review [--agent | --finalize [path]] [--all | --base <ref> | --uncommitted] [--no-graph] [--only <list>] [--skip <list>]
```

- `--agent`: run the scanners, write the brief and print it. Your agent runs this.
- `--finalize [path]`: check the agent's findings and write the report. Without a path it reads `agent-findings.json` in the newest report folder. With a path it finds the run by the `change_id` in that file.
- Neither flag: run the scanners on the change and print their report, with the formats, flags and exit codes above. Then one line on stderr says how to get the full review from your agent, so `--format json` stays one JSON document. `scan` (see `plumbing`) does the same without that line.
- `--base`, `--uncommitted`: see "Which change is checked".
- `--all`: review the whole repository instead of the change. See "Reviewing the whole repository".
- `--no-graph`: do not build the code graph for this run.
- `--only <list>`: run only these scanners, comma separated.
- `--skip <list>`: skip these scanners, comma separated.

A scanner name is a built-in name such as `semgrep`, or `custom:<name>` for a custom scanner.

`--finalize` exits 2 when:

- the findings file breaks the shape, naming the first wrong field;
- the change moved since the brief;
- the config changed since the brief;
- a finding cites a scanner rule or candidate that is not in this scan;
- the brief was written by another openqodex version that is not installed in `~/.openqodex/runtime/`.

When the launcher started the review, the brief's finalize command is the plain line `<launcher> review --finalize`, with `--all` and `--offline` as the review had them, run from the repository root; it finds the run through `.openqodex/latest.json` (`latest-all.json` for `--all`). With `--config`, or when npx started the review, the command names the repository, the config and the findings file, so it works from any folder. When the version that runs `--finalize` is not the one that wrote the brief, and that one is installed by `init` or an update, it hands the run to that version by its findings file and exits with its code. A version reached that way never hands off again.

It never repairs a finding. Fix what it names, or run `review --agent` again.

### Reviewing the whole repository

`review --all` treats every file in the repository as the change: every tracked file and every untracked file git does not ignore, as they are on disk, minus `exclude` and `.openqodex/`. Every line of every text file is in scope, so the scanners report on the whole repository with no changed-line filter. Submodules, symbolic links, unreadable files and files over 5 MB are listed in the brief as left out.

There is no scan-only report of the whole repository. With or without `--agent`, the command runs the scanners and prints a brief for your agent: the most-called functions from the code graph and the files with the most scanner hits, as places to start; the 50 most severe scanner candidates, with all of them in `candidates.json`; the matching patterns; and the file inventory in `inventory.json`. Without `--agent` it adds one line saying the review is done when your agent finalizes it. Ask your agent: review my whole repo with openqodex.

`review --finalize` then works as for a change; with `--all` and no path it finalizes the newest whole-repo run. A finding must name a file in the inventory and a line that exists in it, or finalize exits 2. Any edit to any file after the brief moves the review id, and finalize says the change moved. A whole-repo run keeps its own receipt in `.openqodex/latest-all.json`, so it never replaces the review of the change you are about to push.

The brief includes `.openqodex/custom-instructions.md` when the repo has one; a file over 32 KB is refused, never cut. The brief shows it to the agent as quoted text from the repository, because anyone who can commit can change it. It can widen or narrow what the agent flags, and a candidate dropped because of it says so in the report; it cannot make the agent run a command, skip a step or change the finding shape or the finalize step. A scanner given more files than one process can take runs once per batch of files, within its usual time limit.

`--all` cannot be combined with `--base` or `--uncommitted`. The git hook and the GitHub Action never run it.

## init

```
openqodex init [--agent <name>]... [--project] [--hook <pre-push|none>] [--no-repo] [--yes] [--uninstall] [--dry-run]
```

Installs OpenQodex into your coding agents.

- `--agent <name>`: `claude-code`, `cursor`, `codex`, `cline` or `all`. Repeat it for several. Without it, `init` uses every agent it finds.
- `--project`: write the files into the repository for a team to commit. The default writes them in your home folder.
- `--hook <pre-push|none>`: answer the pre-push hook question without asking. Without it, `init` asks once per repository and records the answer.
- `--no-repo`: do not add the team review section to the repository's `CLAUDE.md` and `AGENTS.md`. Without it, `init` without `--project` asks once per repository (default yes) and records the answer; `--yes` or `--no-repo` on a later run replaces the recorded answer. A file the repository's git ignore rules hide is left alone, with one line saying why, since it could not be committed.
- `--yes`, `-y`: do not ask. It adds the team review section, even where this repository answered no before (only `--no-repo` keeps it out), and adds the pre-push hook unless this repository answered no to it before or `--hook none` says so. Without a terminal, `init` needs this flag.
- `--uninstall`: remove what `init` wrote. A file you edited after `init` is left in place.
- `--dry-run`: print the plan and write nothing.

`init` does not take the flags listed under "Flags every command below accepts". `agents` lists each file it writes.

## trust

```
openqodex trust [--yes] [--list] [--revoke <name>]
```

Approves the custom scanners in `.openqodex.yaml`. For each new or changed entry, it downloads the release asset. It shows what will run and asks yes or no.

- `--yes`: approve every pending entry without asking. Use it only for entries you have read.
- `--list`: print each custom scanner and its state: trusted, not approved, or changed since approval.
- `--revoke <name>`: remove the approval for one scanner.

Without a terminal and without `--yes`, `trust` exits 2. `custom-scanners` explains the whole step.

## update

```
openqodex update [--now | --rollback | --off | --on | --status]
```

Checks npm for a newer release and installs it now, in the foreground, the same way the daily check does. It works only for an install made with `npx openqodex init`: run through `~/.openqodex/bin/openqodex`, which hooks and the installed skill call. Run any other way (npx, a project-scope file), it exits 2 and says to run `npx openqodex init`.

- No flag: install the newest release that is at least 24 hours old and whose build record verifies, then print what happened.
- `--now`: also install a release younger than 24 hours. Verification is the same.
- `--rollback`: turn updates off, then point the launcher back at the version that was active before the last update. It exits 2 and changes nothing when that version's copy is gone or when `update: off` cannot be written.
- `--off`, `--on`: write `update: off` or `update: on` to `~/.openqodex/config.yaml`. `init --uninstall` removes that file when `update` created it and it is unchanged, and removes the update state.
- `--status`: print the same update lines as `doctor`.

Each release is checked before anything of it runs: its sha512 must match the registry's, and its npm provenance must be signed by this repository's release workflow on `main` (see `security`). A release that fails is skipped, recorded, and not downloaded again for 7 days. An update writes no agent file and never writes inside a repository: the user-scope skill asks the launcher for the procedure with `guide skill`, so it always matches the active version. A foreground `update`, `--rollback`, `--off` and `--on` wait up to 60 seconds while another `init`, uninstall or update runs, then exit 2 with one line. `update` also removes runtime copies older than 7 days, except the one `init` installed, the current one and the previous one.

After an update the next command prints one line on stderr: `openqodex updated to X (was Y). Roll back: openqodex update --rollback`. The agent push hook does not print it.

## Environment variables

- `OPENQODEX_HOME`: where OpenQodex keeps scanners, the launcher and approvals. The default is `~/.openqodex`.
- `OPENQODEX_SKIP=1`: the push gate lets the push through and says so. It is your switch, not your agent's.
- `OPENQODEX_AUTO_UPDATE=0`: no daily version check. `OPENQODEX_OFFLINE=1` and a set `CI` variable do the same.
- `NO_COLOR`: no colour in the terminal report.
