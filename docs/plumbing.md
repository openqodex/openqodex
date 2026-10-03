# Plumbing commands

`openqodex --help` lists four commands: `init`, `review`, `update` and `trust`. The commands below still work the same way. They are hidden from `--help` because hooks, the skill, the Action or OpenQodex itself call them, not people in daily use.

## scan

Plain `openqodex review` does the same. Kept under this name for the git pre-push hook of earlier releases, the pre-commit hook and the GitHub Action, which call it.

```
openqodex scan [--base <ref>] [--uncommitted] [--only <list>] [--skip <list>]
```

Runs the scanners on the change and prints the report. No model is involved. The git hook, the pre-commit hook and the GitHub Action run this command.

## doctor

For you, when a scanner is missing or slow to install. The skill asks you to run `doctor --install` once when the agent runs in a sandbox.

```
openqodex doctor [--install] [--json]
```

Prints the Node and git versions, the repository, the config, the OpenQodex home folder and the state of each scanner. It lists custom scanners with their approval state.

- `--install`: download every scanner that fits this machine, and wait for all of them.
- `--json`: print the same facts as JSON.

Under "Updates" it prints the running version and whether the launcher started it, the newest version the last check saw and when, the last check, whether updates are on (and why not), and the last update error. For a version not started through the launcher (npx, a project-scope file), it says when that pinned version is behind the newest one a check saw. Without a check on this machine, it says nothing about that.

`doctor` always prints its table. It then exits 2 in three cases:

- git is missing;
- the config does not load;
- the `--cwd` folder does not exist.

## hook

Called by the agent push hooks and the git pre-push hook that `init` writes. You run `hook install` and `hook uninstall` yourself when you want the git hook without `init`.

```
openqodex hook check
openqodex hook install [--force]
openqodex hook uninstall
```

- `hook check`: the push gate. The Claude Code and Codex hooks call it before a shell command. It reads the hook's JSON on stdin. It always exits 0.
- `hook install`: add a git pre-push hook to this repository. It also sets up the launcher in `~/.openqodex/`, which the hook calls. The hook runs `hook pre-push`, which scans each commit the push sends against the remote's tip of its branch (`agents` has the details). It stops the push only when the scan exits 1. A scan that fails for its own reasons never stops the push.
- `hook install` refuses to replace a hook it did not write. `--force` replaces it and keeps the old hook as `pre-push.openqodex.bak`.
- `hook uninstall`: remove that hook and put back the one it replaced. A hook you edited after install is left in place.

When the repository uses husky or lefthook, `hook install` writes nothing. It prints the line to add to their pre-push hook: `npx -y openqodex@<version> hook pre-push || [ $? -ne 1 ]`. The part after `||` makes the line stop the push only on exit 1, as the hook `hook install` writes does: a scan that fails for its own reasons (exit 2) never stops the push.

`init` asks whether to install the git hook. `agents` explains the push gate.

## guide

For agents: the skill reads the docs offline with it.

```
openqodex guide [skill | topic]
```

`guide skill`, and `guide` with no topic, print the full review procedure of the running version: the shipped skill with every command written for the runner that started it, the launcher's full path when the launcher started it, else `npx -y openqodex@<version>`. The skill `init` writes in user scope is a short stub that tells the agent to run `<launcher> guide skill` and follow what it prints. With a topic, it prints that page of these docs. An unknown topic lists the topics and exits 2.

## demo

For a first look: builds a repo with planted bugs to scan.

```
openqodex demo [dir]
```

Builds the demo repository in `<dir>`, or in a new temporary folder. A relative `<dir>` resolves from the folder you run the command in. The folder must be empty or new. The demo commits a clean baseline, then adds a change with planted bugs and leaves it uncommitted. It scans that change and prints the report. When some scanners are still installing, it says so and asks you to run `scan` again. The secret in the demo is generated each time and works nowhere.

## report

Offered by OpenQodex itself after an internal failure.

```
openqodex report "<what went wrong>"
openqodex report --send-last
```

- `report "<what went wrong>"`: report a problem with OpenQodex. It prints the issue it would create and the two choices, the same as after a failure. It exits 0. Words that hold a path, a file name, a key or token, or an email address are refused with exit 2: remove them and run it again. Your user name and the repository's name are replaced with `<name>`.
- `report --send-last`: print the last issue shown in this repository again, then create it exactly as it was shown. Outside a repository it uses the last one shown outside a repository. It refuses a saved issue that is a link, is not in the saved shape, or changed after it was shown.

The issue holds only the command and its flags, a short diagnostic, the status of each scanner, the operating system, the CPU type and the Node version. For a scanner the diagnostic is its failure class only, such as `exited with code 2` or `timed out after 60 s`, never its output. For an internal error it is the error's class and first line, cut to 120 characters. Every path, file name, key or token, email address, user name and repository name is removed first, and a custom scanner is shown as `custom scanner`. It never holds code, diffs, findings, config or logs.

When the issue could not be saved, OpenQodex says so and does not offer `--send-last`.

In a terminal, press 1 or 2. Any other key, Enter, Ctrl-C or the end of input counts as 2. Without a terminal (an agent, a git hook, CI), OpenQodex prints the issue and how to create it later with `openqodex report --send-last`; doing nothing ignores it.

Choice 1 creates the issue with the GitHub CLI when `gh auth status` says you are signed in. Otherwise it opens the new issue page on GitHub with the title and body filled in, and prints the link. OpenQodex never signs you in. Choice 2 sends nothing. Nothing leaves your machine without choice 1. The last issue shown is kept in `.openqodex/last-report.json`, which git ignores.
