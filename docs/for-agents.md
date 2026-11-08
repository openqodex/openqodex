# OpenQodex for AI agents

This page is for an AI coding agent that installs or configures OpenQodex for a developer. A person reads the README instead.

This page describes `openqodex@0.16.0`. The same page ships in the package. After the install, `~/.openqodex/bin/openqodex guide for-agents` prints the copy for the installed version.

The review procedure is not on this page. The openqodex skill holds it. `init` installs that skill. Run `guide skill` to read it (see "Review a change").

## Words

- Change: the commits not yet pushed plus everything uncommitted, untracked files included.
- Changed lines: the lines the change adds or edits.
- Repository: the developer's git repository, where the change is.
- Scanner: a program that checks code without a model, such as gitleaks or semgrep.
- Built-in scanner: one of the 22 built-in scanners that ship with OpenQodex.
- Custom scanner: a scanner that the repository's config adds by its GitHub link.
- Approve: what `openqodex trust` does for a custom scanner. OpenQodex runs a custom scanner only after the developer approves its exact entry.
- Finding: one problem at one place in the code, with a severity.
- Severity: one of `critical`, `major`, `minor`, `nitpick` and `info`, from highest to lowest. OpenQodex maps a scanner's own severity onto this scale: high to major, medium to minor, low to nitpick.
- Reviewer: the separate Claude Code or Codex process that `review` starts. It reads a copy of the repository with the change, made when the review starts.
- Model service: the service of the developer's Claude Code or Codex login that runs the model.
- Receipt: what `review` prints at the end: the verdict, one line per finding and the path of `report.html`.
- Verdict: `passed` or `blocked`.
- Push gate: the Claude Code or Codex hook that looks for a review before `git push`.
- Launcher: `~/.openqodex/bin/openqodex`, the script that `init` writes. The hooks and the skill run OpenQodex through it.
- SARIF: a standard JSON format for scanner results.
- MCP server: a local tool server that an agent starts. OpenQodex's server answers questions about the code graph.

## Before you install

Run these commands from the developer's repository.

| Check | Command | What you need |
|---|---|---|
| Node | `node --version` | 22 or newer |
| git | `git --version` | git installed |
| A reviewer | `claude --version`, `codex --version` | Claude Code or Codex installed. These commands do not show the login; `init` checks it at the end. |

Without Claude Code or Codex, OpenQodex still installs. A review then prints "Full review unavailable". Tell the developer before you install. At the end of the install, `init` prints "Reviewer ready" or what to fix.

CI tests OpenQodex on Node 22, on macOS and on Ubuntu Linux. No test runs on Windows or WSL.

## Install

1. Run this command from the repository. Put the agent you are in place of `<host>`: `claude-code`, `codex`, `cursor` or `cline`.

   ```
   npx -y openqodex@0.16.0 init --yes --agent <host>
   ```

2. Run it in the background. Wait until it exits. It downloads the scanners that the repository needs. Then it reviews the change. The two steps can take several minutes.
3. Find the line that starts with `First review:`. It says `finished`, `incomplete`, `skipped` or `unavailable`.
4. Show the developer the receipt above that line, as printed.

Do not use `npx skills add openqodex/openqodex` for the install. It installs the skill alone, with no push gate and no launcher.

In its default sandbox mode, Codex gives commands no network. In Codex, ask the developer to run the install line in their own terminal.

After the install:

- Codex: the developer opens Codex, runs `/hooks`, and trusts the OpenQodex hook. Until then, Codex skips the push gate.
- Claude Code, Codex, Cursor and Cline read their MCP servers when they start. Ask the developer to restart the agent. Then the agent gets the code graph tools. An MCP server is a local tool server that the agent starts.
- Cursor: the rule goes into each repository. Run `init` again in each repository that needs it.
- Cline with the VS Code extension: `init` prints an MCP server entry. The developer adds it in Cline's "Configure MCP Servers".

## What init wrote

By default, `init` writes the agent files into the developer's home folder (user scope). Cursor is the exception: it has no rule file in the home folder, so its rule goes into the repository. With `--project`, `init` writes the agent files into the repository instead. The team then commits them.

| Agent | Skill | Instructions | Push gate |
|---|---|---|---|
| Claude Code | `~/.claude/skills/openqodex/SKILL.md` | a section in `~/.claude/CLAUDE.md` | a hook in `~/.claude/settings.json` |
| Codex CLI | `~/.agents/skills/openqodex/SKILL.md` | a section in `~/.codex/AGENTS.md` | a hook in `~/.codex/hooks.json` |
| Cursor | `~/.cursor/skills/openqodex/SKILL.md` | the rule `.cursor/rules/openqodex.mdc` in the repository | none |
| Cline | `~/.cline/skills/openqodex/SKILL.md` | the rule `~/Documents/Cline/Rules/openqodex.md` | none |

In the repository, `init` also writes these files:

- `.openqodex/config.yaml`: the repository's config. The team commits it.
- `.openqodex/custom-instructions.md`: what a reviewer of this repository must know. The team commits it.
- A review section in `CLAUDE.md` and `AGENTS.md`, for teammates who installed nothing. `--no-repo` leaves it out.
- The git pre-push hook. `--hook none` leaves it out.

The [agents page](agents.md) lists the files of both scopes, with the MCP server files.

## Review a change

The skill holds the procedure. Run this from the repository, then follow what it prints from step 1:

```
~/.openqodex/bin/openqodex guide skill
```

In project scope, the launcher may not exist on this machine. Then run `npx -y openqodex@0.16.0 guide skill`.

A review can take minutes. OpenQodex stops the reviewer after 30 minutes for a change. With `--all`, it stops the reviewer after 2 hours. An agent's shell tool may stop a command sooner. So run the review in the background and wait until it exits.

## Add a scanner from GitHub

The developer can ask you to add a scanner by its GitHub link. You write the config entry. The developer approves it.

1. Read the scanner's README. Find the flag that makes it write SARIF.
2. If it cannot write SARIF, find the flag that makes it write one JSON document. OpenQodex cannot read JSON Lines or plain text.
3. Find how it installs. OpenQodex can use a GitHub release asset for macOS or Linux. It can also use an exact npm or PyPI version, or a program on `PATH`.
4. Add the entry under `scanners.custom` in `.openqodex/config.yaml`.
5. Ask the developer to approve it with `~/.openqodex/bin/openqodex trust`. `trust` downloads the release asset into a quarantine folder. Then it shows what will run and asks yes or no. The skill's rule: never run `openqodex trust` without asking the developer first.
6. After the approval, run `~/.openqodex/bin/openqodex scan --only custom:<name>`. Tell the developer its status and its findings.

An entry with SARIF output:

```yaml
scanners:
  custom:
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
```

The keys:

| Key | What it is |
|---|---|
| `source` | the scanner's GitHub link, `https://github.com/<owner>/<repo>` |
| `run` | the command line. OpenQodex splits it into words. It starts no shell |
| `name` | the scanner's name in the report. Default: the last part of `source` |
| `version` | a release tag. Default: the latest release |
| `format` | `sarif` (the default) or `json-map` |
| `map` | for `json-map`: dotted paths to the list of results and to each result's file, line, rule, severity and message |
| `paths` | globs of the changed files that make it run. Default: each changed file that `review.paths.exclude` does not leave out |
| `target` | `changed`, the default, passes the changed files. `repo` passes the repository root |
| `timeout_seconds` | the time limit for one run, in seconds. Default: 120 seconds |
| `install` | an asset name pattern, `path`, `{ npm: <package@1.2.3> }` or `{ uv: <package==1.2.3> }` |

`{report}` in `run` is the file the scanner writes its report to. With no `{report}`, OpenQodex reads the report from the scanner's standard output. By default, `{target}` is the changed files. With `target: repo`, `{target}` is the repository root. `{repo}` is the repository root.

Tell the developer when a scanner is not compatible, and why. OpenQodex runs a custom scanner only when `~/.openqodex/trust.json` on that machine holds an approval of that exact entry. A fresh GitHub-hosted runner holds none, so the GitHub Action skips it there.

`~/.openqodex/bin/openqodex guide custom-scanners` gives the asset rules, the `json-map` example and what the stored hash proves.

## Configure the repository

The config belongs to the team. Change it only when the developer asks.

| Key in `.openqodex/config.yaml` | What it does |
|---|---|
| `review.block_on_severity` | a severity. A finding at or above it blocks the push. Default: unset, so nothing blocks |
| `review.paths.exclude` | globs of files left out of the change |
| `review.disabled_rules` | scanner rules to drop, such as `ruff:F401` |
| `scanners.disable` | built-in scanners to switch off, by name |
| `scanners.custom` | custom scanners (see above) |

Write what a reviewer of this repository must know in `.openqodex/custom-instructions.md`. The brief is the text that OpenQodex gives the reviewer. The brief quotes this file word for word. It can also quote [convention files](config.md#convention-files) chosen by the developer. Never add a path on your own. Ask which files the reviewer may use, then set only what they name.

`~/.openqodex/bin/openqodex guide config` lists the keys of the installed version.

## Messages and what to do

| OpenQodex prints | What you do |
|---|---|
| `Full review unavailable` | Tell the developer what it says is missing. If it names a fallback command, follow it. |
| `Review incomplete` | Tell the developer what it says is missing. Never present the scanner findings as a review. |
| a scanner `installing` | Tell the developer. The scanner joins the next run. |
| a scanner `not installed` or `needs Ruby`, `needs Go`, `needs Cargo` | Tell the developer the reason. OpenQodex does not install Ruby, Go or Cargo. |
| a scanner `untrusted` | A custom scanner is not approved. The developer decides. |
| a scanner `disabled` | The config or `--offline` switched it off. |
| files from an older version, and an `init` command | Tell the developer in one line. Give them the command. Run it only if they ask. |
| `OpenQodex had a problem. Nothing has been sent.` | Follow the skill's rule for this message. Never choose to send the report yourself. |

In a sandbox that cannot download, a scanner that is not installed yet cannot install. Ask the developer to run `npx -y openqodex@0.16.0 doctor --install` in their own terminal, inside the repository.

## What leaves the machine

- The reviewer sends the brief and the files it reads to the model service of the developer's login.
- By default, the reviewer can also search the web. `reviewer_web: off` in `~/.openqodex/config.yaml` turns that off.
- Of the built-in scanners, four use the network. As OpenQodex runs them, none of the four sends code. semgrep downloads its rule packs. osv-scanner sends dependency names and versions to osv.dev. kubeconform downloads Kubernetes schemas. cargo-deny downloads the RustSec advisory database.
- `--offline` skips semgrep, osv-scanner, kubeconform and cargo-deny. It also stops scanner downloads. It does not stop the reviewer's model service or an approved custom scanner.
- A custom scanner does whatever its own command does.

The [privacy page](privacy.md) lists each network use of this version.

## Remove OpenQodex

```
~/.openqodex/bin/openqodex init --uninstall
```

It removes what `init` wrote. It keeps a file or a section that the developer edited. The scanners stay in `~/.openqodex/tools/`.

## Read more offline

`~/.openqodex/bin/openqodex guide <topic>` prints one page of the docs. The topics are the file names in `docs/`, such as `quickstart`, `cli`, `config`, `scanners`, `custom-scanners`, `agents`, `security` and `privacy`.
