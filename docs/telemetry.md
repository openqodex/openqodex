# Telemetry

OpenQodex sends anonymous usage data. It is on by default. This page lists every field that is sent and every way to turn it off.

## What is sent

One event when a command ends: the command name, its exit code, how long it took, the names of the flags you passed, and, when it failed, the kind of error and its line in the OpenQodex program. Flag values and error messages are not sent.

One event the first time OpenQodex runs on a machine.

Two events for `init`: which agents it set up, and how the first review ended.

One event after a review and after a scan: the verdict, the time of each step, which built-in scanners ran or failed, how many files and lines changed, how many findings there were by severity, which agent reviewed, its version, its model and effort, and token counts.

Every event also has: the OpenQodex version, your operating system and its major version, the processor type, the Node major version, the agent you ran the command from, whether the command ran in a terminal, how OpenQodex was started, a random id for this install, and the age of that id in days.

Every value is a yes or no, a whole number, a word from a fixed list in the OpenQodex program, a version number rebuilt from its digits, or the hash of the install id. A model name that is not on the list of public models is sent as `other`.

### Every event

| Field | Value |
|---|---|
| `installId` | A hash of the random install id. |
| `installAgeDays` | Whole days since the install id was made. |
| `$process_person_profile` | Always `false`: PostHog makes no person profile. |
| `$geoip_disable` | Always `true`: PostHog works out no location. |
| `$lib` | Always `openqodex`. |
| `openqodexVersion` | The OpenQodex version. |
| `platform`, `arch` | Node's name for the operating system and the processor type. |
| `os` | `macOS`, `Linux`, `Windows` or `other`. |
| `osMajor` | The major version of the operating system kernel. |
| `nodeMajor` | The major version of Node. |
| `wsl` | Whether the command ran in WSL. The name of the WSL system is not sent. |
| `hostAgent` | The agent you ran the command from: `claude`, `codex`, `cursor` or `none`. |
| `runner` | `launcher` when the OpenQodex launcher started it, else `package`. |
| `tty` | Whether the output went to a terminal. |

### `command.completed`

One event per command. `hook check` and `mcp` send none.

| Field | Value |
|---|---|
| `command` | The command name, such as `review` or `init`. |
| `sub` | The sub-command, such as `finalize` or `pre-push`, from a fixed list. |
| `exitCode` | 0, 1, 2, 130 or 143. Exit 1 means findings blocked a push. |
| `durationMs` | How long the command took, in milliseconds. |
| `threw`, `interrupted` | Whether the command stopped on an error, or was stopped by Ctrl-C. |
| `errorKind` | `input` for a problem with what you gave it, else `internal`. |
| `errorClass`, `errorCode` | The kind of error and its system code, from fixed lists. |
| `errorLine`, `errorColumn` | Where in the OpenQodex program the error happened. |
| `flags` | The names of the flags you passed. Their values are not sent. |
| `format` | The output format: `terminal`, `markdown`, `json` or `sarif`. |

### `install.first_use`

Sent once, by the first command on a machine. It has only the fields of every event.

### `init.completed` and `init.first_review`

| Field | Value |
|---|---|
| `ended` | How setup ended: `written`, `unchanged`, `unconfirmed`, `cancelled` or `stopped`. |
| `agents` | The agents set up, such as `claude-code` or `codex`. |
| `scope` | `user` or `project`. |
| `hook` | `pre-push` or `none`. |
| `mcp` | Whether the code graph's MCP server was set up. |
| `inRepo`, `interactive` | Whether `init` ran in a git repository, and in a terminal. |
| `exitCode` | The exit code of setup. |
| `result` | How the first review ended: `finished`, `incomplete`, `skipped` or `unavailable`. |
| `reviewerReady` | Whether a reviewer could start. |
| `skipReason` | Why the first review was skipped: `flag`, `no_repo`, `no_change` or `declined`. |

### `review.completed` and `scan.completed`

| Field | Value |
|---|---|
| `mode` | `reviewer` for a separate reviewer process, `agent` for the agent you are in. |
| `scope` | `change`, `target` or `all`. The branch name or pull request link is not sent. |
| `fromInit` | Whether `init` started the review. |
| `ended` | `finished`, `incomplete`, `unavailable`, `nothing`, `interrupted` or `error`. |
| `cleanupFailed` | Whether the review was written and the removal of its temporary copy then failed. |
| `verdict` | `passed`, `blocked` or `incomplete`. |
| `exitCode` | The exit code. |
| `nothing` | For a scan: whether there was no change to scan. |
| `demo` | For a scan: whether `openqodex demo` ran it. |
| `reviewer`, `reviewerVersion` | The reviewer (`claude`, `codex`, `cursor` or `other`) and its version number. |
| `modelRequested` | The model the config or the command line asked for, `default` when none, `other` when it is not a known public model. |
| `modelReported` | The model the reviewer said it used, `unknown` when it named none, `mixed` when it named more than one. |
| `effortRequested` | The reasoning effort asked for, or `default`. |
| `reviewersPassed` | How many entries of `review.reviewers` were passed over. |
| `staged`, `web` | Whether the review was staged, and whether the reviewer had web tools. |
| `sessions`, `rounds`, `turns` | How many reviewer sessions, answers and turns the review took. |
| `inputTokens`, `outputTokens` | The token counts the reviewer reported. |
| `totalMs`, `changeMs`, `scanMs`, `graphMs`, `briefMs`, `reviewerMs`, `finalizeMs` | The time of each step, in milliseconds. |
| `files`, `additions`, `deletions` | How many files and lines the change has. |
| `candidates`, `findings`, `possible`, `observations`, `outsideChange`, `belowThreshold`, `notReviewed`, `dropped`, `lowConfidence` | How many entries each list of the report has. |
| `findingsBySeverity`, `findingsByOrigin` | How many findings there were per severity, and from the reviewer and from scanners. |
| `candidatesTotal`, `candidatesDisposed` | How many scanner findings the reviewer was given and answered. |
| `hunks`, `hunksCovered`, `missingCount` | How many changed parts there were, how many the reviewer was given, and how many gaps the review has. |
| `graph` | The state of the code graph: `ok`, `partial`, `off`, `skipped` or `failed`. |
| `blockOn` | The severity that blocks a push. |
| `scannersRan`, `scannersFailed`, `scannersNotInstalled`, `scannersInstalling`, `scannersDisabled` | The built-in scanners by what happened to each. |
| `scannerMs` | How long each built-in scanner ran. |
| `scannerFailures` | Why each built-in scanner failed, from a fixed list such as `timeout` or `exit`. |
| `customScanners`, `customScannersFailed` | How many custom scanners ran and failed. Their names are not sent. |
| `reportDir`, `blockOnFlag` | Whether `--report-dir` and `--block-on-severity` were given. |

## What is never sent

Code. Diffs. File names and paths. Repository, branch and remote names. Finding text. The brief and the reviewer's answer. Error messages. The names of custom scanners. A model name that is not a known public model: it is sent as `other`. Your user name, your email address and your machine name. OpenQodex reads no login file and no account id.

## The id

The background process of the first command creates a random id in `~/.openqodex/telemetry/id`. Events carry a hash of it. It is not linked to you, your account or your repository. Delete the file to get a new id. An `init --uninstall` that removes the `openqodex` launcher from `~/.openqodex/bin` removes the id too.

## Where it goes

Events go to PostHog, an analytics service, at `eu.i.posthog.com` in the EU. PostHog receives each request from your IP address, as every server does. Each event tells PostHog not to work out a location from it.

## How it is sent

When a command ends, it starts a separate background process and gives it the events. That process reads the config files and the id, makes one request and stops. Your command does not wait for it. If the request fails, the events are dropped. Nothing is kept on disk but the id.

## Turn it off

- For a repository: add `openqodex_telemetry: 0` to `.openqodex/config.yaml`. Commit it, and it is off for everyone who works there.
- For your machine: set `OPENQODEX_TELEMETRY=0` or `DO_NOT_TRACK=1` in your shell profile. This works with every version of OpenQodex.
- For your machine, in a file: add `openqodex_telemetry: 0` to `~/.openqodex/config.yaml`. An OpenQodex older than 0.25.0 that reads the same file does not know the key. It prints a warning and pauses its own automatic updates.

The key takes these values. `0`, `false` and `off` turn usage data off. `1`, `true` and `on` leave it on. Any other value turns it off. In a project's config file, OpenQodex also prints a warning. The variable `OPENQODEX_TELEMETRY` works the same way: any value other than `1`, `true` or `on` turns usage data off.

When it is off, nothing is sent and no id is created. `openqodex doctor` shows whether it is on.

Usage data is always off in CI, in the GitHub Action, with `--offline`, with `--dry-run`, and for commands the reviewer runs.

semgrep runs with its own metrics switched off.
