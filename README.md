<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-dark.png">
  <img alt="OpenQodex" src="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-light.png" width="1280">
</picture>

# OpenQodex

[![npm version](https://img.shields.io/npm/v/openqodex)](https://www.npmjs.com/package/openqodex)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/openqodex/openqodex/actions/workflows/ci.yml/badge.svg)](https://github.com/openqodex/openqodex/actions/workflows/ci.yml)

OpenQodex is open source AI code review for Claude Code and Codex. It runs before you push, from your coding agent or your terminal. One command, `openqodex review`, works out your change: the commits not yet pushed plus everything uncommitted. It runs the scanners that fit the changed files and keeps only findings on the lines you changed. Then it starts its own reviewer, a separate Claude Code or Codex process that reads a frozen copy of the change. The reviewer checks every scanner finding and is given every changed line. OpenQodex checks its answer with scripts, writes one report, and prints a short receipt: the verdict, one line per finding and the path of `report.html`, a local page that shows each finding under its line of code. You choose which findings your agent fixes. It needs Claude Code or Codex installed and logged in, and no other key, account or server.

## Install

For humans, in your terminal:

```
npx openqodex init
```

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints every file it will write and asks once. Then it names the reviewer it found, or what to fix, and reviews your change, or asks what to review when there is none. After that, say to your agent "review my change with openqodex", or run `~/.openqodex/bin/openqodex review` yourself: `init` prints that full path, since an npx install puts no `openqodex` on your `PATH`.

For agents, the same install, run by the agent for itself with no question:

```
npx -y openqodex@0.11.1 init --yes --agent <host>
```

`<host>` is `claude-code`, `codex`, `cursor` or `cline`. Or paste this prompt into your agent:

```
Install OpenQodex for yourself with `npx -y openqodex@0.11.1 init --yes --agent <host>`, where <host> is the agent you are: claude-code, codex, cursor or cline. Run it from this repository and allow it up to ten minutes: when a reviewer can start, it ends with a review of my current change.
Then tell me the verdict and the findings, or what its last lines say is missing.
```

Codex runs commands in a sandbox that by default cannot write outside the project or reach the network: from Codex, run the line in your own terminal instead.

The skill alone, with no push check, launcher or scanner download: `npx skills add openqodex/openqodex -g`. A later `init` replaces it with the skill it keeps up to date.

OpenQodex needs Node 22 or newer and git. It runs on macOS and Linux. On Windows, use WSL.

<!-- recording: added before launch -->

## What it does today

Five commands: `init`, `review`, `update`, `trust` and `graph`. The commands hooks and agents call are listed in [docs/plumbing.md](docs/plumbing.md).

- `openqodex review` runs the whole review in one command: a frozen copy of the change, the scanners, the code graph, a reviewer process OpenQodex starts, script checks of its answer, and one report in `report.html`, `report.md`, `report.json` and `report.sarif`.
- When it ends, the terminal shows a receipt: the verdict, the reviewer's summary, one line per finding (number, severity, category, title, file and line) and the absolute paths of `report.html` and `report.md`. `--format markdown`, `json` or `sarif` still prints the whole report.
- `report.html` is one file on your disk: each changed file as a diff, each finding under its line, then the coverage, the scanners and the blast radius. It runs no script, loads nothing, escapes every string and redacts the secrets the scanners found.
- The skill tells your agent to show you the receipt, ask "Fix all, or tell me which?", and fix only the findings you name. `openqodex findings 1,3` prints the named findings in full for it.
- `openqodex review --all` reviews the whole repository. `openqodex review <branch>` and `openqodex review '#42'` review a branch or a pull request that is not your current work. OpenQodex fetches it, checks it out in a temporary folder and reviews what it added since it left its base.
- The reviewer is Claude Code (`claude -p`) or Codex (`codex exec`). `auto` picks the agent you run the command from, then Claude Code, then Codex; `--reviewer` or `reviewer:` in `~/.openqodex/config.yaml` picks one.
- Claude Code starts with read, search and list tools only, inside the copy of the change, with none of your settings, hooks, plugins, memory or instruction files. Its event stream shows every read, so the report lists the files it read.
- Codex starts in a read-only sandbox that confines reads to the copy of the change and the system folders, with no network for its commands and none of your config, plugins, hooks or the repository's instruction files. It still loads your global `~/.codex/AGENTS.md`, and its event stream does not show every command, so the report says its reads were not recorded. [docs/internal-reviewer-drivers.md](docs/internal-reviewer-drivers.md) gives the tests.
- A review is complete only when every stage ran, every scanner finding was raised or dropped with a reason, and every changed line was in front of the reviewer: in the brief, in a later message from OpenQodex, or, for Claude Code, in a file it read. Anything else prints "Review incomplete" with what is missing, and exits 2.
- A change that only deletes code, such as a removed check, can still carry a finding: the lines next to a deletion count as changed.
- Twenty-two built-in scanners. Every downloaded scanner is pinned to one version. Each runs only when the change holds a file it reads.
- A suppression comment the change adds, such as `# nosec`, and a changed scanner settings file are shown, since the scanner then stays silent: the reviewer checks each one, and a scan counts it as a minor finding.
- Any scanner by its GitHub link, after you approve it with `openqodex trust`.
- A push gate for Claude Code and Codex, and an optional git pre-push hook. Both look for a review of exactly what is pushed; neither scans or reviews by itself. They warn by default and block only when `.openqodex/config.yaml` sets `review.block_on_severity`.
- A GitHub Action that runs the full review on a pull request when the workflow gives it an Anthropic API key, and the scanners only (`openqodex scan`) without one. A pre-commit hook that runs the scanners only; it is not a review.
- `npx openqodex demo` builds a small repo with planted bugs and scans it.
- `openqodex graph callers <symbol>` and the other graph questions answer from the code graph, with the evidence for each item and a note when the list may be short. `init` registers the same questions as an MCP server (`openqodex mcp`, a tool server your agent starts) with each agent it installs into. [docs/graph.md](docs/graph.md) lists the questions.

## What it does not do yet

- The separate reviewer process needs Claude Code or Codex. Without either, `review` prints "Full review unavailable", says what is missing, saves the unchecked scanner findings to a file it names, and names the command with which the agent you are in reviews the change itself (`review --agent`). That report says which agent reviewed.
- No Cursor reviewer. `cursor-agent` has no way to limit its tools to reading or to skip your rules and settings.
- Codex cannot be the reviewer when `openqodex review` runs inside Codex's own sandbox: a second Codex does not start there. `review` then prints "Full review unavailable" and the `review --agent` command.
- A review takes one to three minutes and uses your own Claude Code or Codex plan.
- No review finds everything. The promise is that every stage runs, every scanner finding is checked, every changed line is put in front of the reviewer, and anything skipped is named.
- No review on your own API key without Claude Code or Codex.
- No Homebrew formula, no install script and no Docker image. Install through npm.
- No Windows support outside WSL.
- No offline copy of the vulnerability database. The dependency check asks osv.dev.

## First run

Scanners download on first use into `~/.openqodex/tools/`. A review downloads only the scanners its changed files call for. `init` and `doctor --install` download the ones your repository's files call for and print why for each one, such as `brakeman: Rails app in backend/`. The table below gives each download size.

Installed scanners take more disk than their downloads. The sixteen scanners the demo needs take about 1 GB of disk on an Apple Silicon Mac, measured on 2026-10-08, besides uv's download cache in `~/.openqodex/cache/uv`. semgrep with its Python takes about 250 MB of that, Checkov about 175 MB and trivy about 160 MB.

A scanner install that takes longer than 45 seconds keeps going in the background. The report lists that scanner as installing. The scanner joins the next run. The review `init` ends with waits up to two minutes, since `init` has just started the downloads. To install what a repository needs up front, run `npx openqodex doctor --install` inside it. `--all-scanners` installs every scanner.

One measured first run, on 2026-10-02, when the demo needed eight scanners: an Apple Silicon Mac, an empty tool folder, a line of 2 MB per second. The first `openqodex demo` printed its report in under a minute. That report held the scanners that had finished installing and listed the rest as installing. The next `scan` included all eight scanners. Your times depend on your line.

OpenQodex does not install language runtimes. brakeman needs Ruby 3.0 or newer and rubocop Ruby 2.7 or newer. golangci-lint needs Go. cargo-deny needs Cargo (Rust) and the project's crates in your Cargo cache. Without them, the report lists those scanners as not installed, with the reason.

## Built-in scanners

| Scanner | Version | Runs when the change holds | Needs | Download (Apple Silicon, Linux x64) |
|---|---|---|---|---|
| semgrep | 1.94.0 | any file | Python 3.11, downloaded through uv | about 86 MB with bandit, measured on Apple Silicon |
| gitleaks | 8.21.2 | any file | nothing | 2.9 MB, 3.0 MB |
| bandit | 1.9.4 | `.py`, `.pyi` | the same Python as semgrep | included with semgrep |
| ruff | 0.8.4 | `.py`, `.pyi` | nothing | 9.9 MB, 11.2 MB |
| oxlint | 1.86.0 | `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | nothing | 5.3 MB, 6.1 MB |
| osv-scanner | 2.6.0 | a lockfile, such as `package-lock.json`, `bun.lock`, `uv.lock` or `go.mod` | network access to osv.dev | 52.6 MB, 54.9 MB |
| actionlint | 1.7.7 | `.github/workflows/*.yml` | nothing | 2.0 MB, 2.1 MB |
| hadolint | 2.15.1 | a Dockerfile | nothing | 102.6 MB, 55.7 MB |
| shellcheck | 0.10.0 | `.sh`, `.bash`, or a file with no extension whose first line (`#!`) names sh, bash, dash or ksh | `xz` to unpack | 7.2 MB, 2.4 MB |
| golangci-lint | 2.12.2 | `.go` | Go | 14.4 MB, 15.0 MB |
| brakeman | 6.2.1 | a Ruby or Rails file in a Rails app: a folder whose `Gemfile` or `Gemfile.lock` names rails and that holds `config/application.rb` or `bin/rails` | Ruby 3.0 or newer; see its licence below | from RubyGems, not measured |
| rubocop | 1.69.2 | `.rb`, `.rake`, `.gemspec`, `Rakefile` | Ruby 2.7 or newer | from RubyGems, not measured |
| sqllint | built in | `.sql` | nothing, it runs inside OpenQodex | none |
| squawk | 2.66.0 | `.sql` | nothing | 16.9 MB, 25.7 MB |
| SQLFluff | 4.3.0 | `.sql` | the same Python as semgrep | about 4.6 MB, 6.0 MB of packages |
| zizmor | 1.30.1 | a GitHub workflow, an action's `action.yml`, or `.github/dependabot.yml` | nothing | 8.4 MB, 9.2 MB |
| trivy | 0.75.0 | Terraform, a Kubernetes manifest or a CloudFormation template (its `config` checks only) | nothing | 49.0 MB, 51.7 MB |
| Checkov | 3.3.22 | the same files as trivy | the same Python as semgrep | about 170 MB installed on Apple Silicon |
| TFLint | 0.64.0 | `.tf`, `.tf.json` | nothing | 16.3 MB, 17.1 MB |
| kube-linter | 0.8.3 | a `.yaml` or `.yml` file that holds a Kubernetes object | nothing | 15.3 MB, 16.5 MB |
| kubeconform | 0.8.0 | the same files as kube-linter | network access to raw.githubusercontent.com for schemas | 7.3 MB, 7.5 MB |
| cargo-deny | 0.20.2 | `Cargo.lock` | Cargo (Rust), the project's crates in your Cargo cache, and network access to github.com for the RustSec advisory database | 4.5 MB, 4.9 MB |

[docs/scanners.md](docs/scanners.md) lists every file each scanner reads and what each one sends.

brakeman's licence is the Brakeman Public Use License, which is not an open source licence. It runs only for a Rails app. OpenQodex does not bundle brakeman. It downloads brakeman at run time onto your machine. `scanners.disable: [brakeman]` switches it off.

## Add any scanner

Add a scanner by its GitHub link in your repo's `.openqodex/config.yaml`:

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --disable-telemetry --skip-version-check --skip-check-update --format sarif --output {report} {target}
```

A custom scanner is a command that runs on your machine. It never runs until you approve it:

```
npx openqodex trust
```

`trust` picks the release asset for your machine and downloads it. It shows the version, the asset, its sha256 and the run line, then asks yes or no. An edited entry needs a new approval. [docs/custom-scanners.md](docs/custom-scanners.md) explains each step.

## What goes over the network

- Scanner downloads on first use: GitHub release files checked against pinned sha256 sums, and packages from PyPI and RubyGems, each at the version and sha256 that a lock file in the package names.
- Semgrep rule packs (`p/default`, `p/security-audit`, `p/secrets`), fetched from the Semgrep registry on each run.
- When the change holds a lockfile, osv-scanner sends dependency names and versions to osv.dev. It never sends code. Its other lookups, deps.dev and file hashes, are switched off.
- The reviewer: Claude Code sends the review brief and the files it reads from the copy of the change to the model your Claude Code login uses. It can also open web pages (WebSearch and WebFetch); `reviewer_web: off` in `~/.openqodex/config.yaml` removes the web tools.
- The reviewer, when it is Codex: Codex sends the conversation, which holds the brief, your global `~/.codex/AGENTS.md` and the output of the commands it runs in the copy of the change, to the model your Codex login uses. It can also use Codex's cached web search unless `reviewer_web: off` is set; its commands get no network either way.

- `openqodex trust` reads the custom scanner's release from the GitHub API and downloads it.
- `openqodex review <branch>` or `review '#<number>'` fetches that branch or pull request from your remote with git, and asks `gh` for the pull request's base when `gh` is installed.
- For an install made with `init`, a version check at most once a day: the openqodex release list from registry.npmjs.org, and for a newer release its tarball and signed build record. It sends no code and nothing about you.

`--offline` skips osv-scanner and semgrep and turns scanner downloads, the version check, and the fetch and `gh` call of a branch or pull request review off.

The built-in scanners send no code anywhere. The reviewer's model sees the brief and what the reviewer reads, as with any Claude Code or Codex session. A custom scanner you approved does whatever its own command does. [docs/security.md](docs/security.md) gives the full list.

## Updates

An install made with `npx openqodex init` from 0.3.0 on keeps itself up to date. At most once a day, after a review, a scan or a push check, a background process looks for a new release. The command never waits for it. A release is installed only when it is at least 24 hours old and its signed build record (npm provenance) shows it was built by this repository's release workflow. It goes into a folder of its own beside the version you run, and the switch is one rename of a small file, so a failed or interrupted update leaves the working version in place.

An update writes only that folder, the file that names the active version and its own state. It never writes your settings, a repository or the files `init` wrote for your agents (the skill, the rules, the instruction lines, the Claude Code hook and permission rules). In user scope those files hold no procedure: the skill asks the launcher for the procedure of the version that runs. A release that changes how agents run a review, or the config format, is not installed in the background: the next command says so, and `openqodex update` installs it. When files `init` wrote are from an older version, the next command after an update says how many and that `init` refreshes them; `init` keeps every file you edited. That command also says which version it moved to, and names any change in what leaves your machine, what blocks a push or who reviews. `openqodex update --rollback` goes back, and that release is never installed again; updates stay on, so the next one comes (going back to 0.8.1 or earlier turns them off instead).

Turn it off with `openqodex update --off`, `update: off` in `~/.openqodex/config.yaml` or `OPENQODEX_AUTO_UPDATE=0`. It is also off with `--offline` and when `CI` is set, and paused while that file holds a key OpenQodex does not know.

These do not update: the files `init` wrote for your agents until `init` runs again, files committed with `init --project`, the review section `init` adds to a repository's `CLAUDE.md` and `AGENTS.md`, the skill from `npx skills add` until the next `init` replaces it, the GitHub Action pin, and machines that are offline or stop background processes. An active install is usually one to two days behind a release. An install made with any earlier version needs one `npx openqodex init` to start updating. An install of 0.8.1 or earlier does not know about agent contracts yet: its next update installs the newest release whatever it changes, and the command after it names the files `init` would refresh.

## Packages

| Package | What it is |
|---|---|
| [`openqodex`](https://www.npmjs.com/package/openqodex) | One package. It holds the CLI as one bundled file with no runtime dependencies. The skill, the agent templates, the docs, the review patterns and the demo ship as separate files beside it. |

`@openqodex/core` and `@openqodex/scanners` are internal workspace packages. The CLI bundles them, and they are not published.

## Documentation

The docs ship inside the package. `npx openqodex guide <topic>` prints a page offline.

- [Quickstart](docs/quickstart.md)
- [Commands](docs/cli.md)
- [Plumbing commands](docs/plumbing.md)
- [Configuration](docs/config.md)
- [Scanners](docs/scanners.md)
- [Custom scanners](docs/custom-scanners.md)
- [Agents](docs/agents.md)
- [GitHub Action](docs/github-action.md)
- [Security](docs/security.md)
- [Privacy](docs/privacy.md)
- [FAQ](docs/faq.md)

## Telemetry

None. OpenQodex sends no usage data. semgrep runs with its own metrics switched off. See [docs/telemetry.md](docs/telemetry.md) and the privacy policy, [docs/privacy.md](docs/privacy.md).

## Security

Report a vulnerability through GitHub's private vulnerability reporting on this repo. Never open a public issue for one. See [SECURITY.md](https://github.com/openqodex/openqodex/blob/main/SECURITY.md).

## Status

OpenQodex is new and on the way to 1.0. Commands, flags and the config file can change between minor releases. [CHANGELOG.md](https://github.com/openqodex/openqodex/blob/main/CHANGELOG.md) records every change.

## Made by Qodex

[![Made by Qodex](https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/made-by-qodex.svg)](https://qodex.ai?utm_source=openqodex&utm_medium=readme)

OpenQodex is made by [Qodex](https://qodex.ai?utm_source=openqodex&utm_medium=readme), which also runs a hosted review on every pull request.

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for the scanners' licences.
