<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-dark.png">
  <img alt="OpenQodex" src="https://raw.githubusercontent.com/openqodex/openqodex/main/.github/assets/readme-banner-light.png" width="1280">
</picture>

# OpenQodex

[![npm version](https://img.shields.io/npm/v/openqodex)](https://www.npmjs.com/package/openqodex)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/openqodex/openqodex/actions/workflows/ci.yml/badge.svg)](https://github.com/openqodex/openqodex/actions/workflows/ci.yml)

OpenQodex is open source AI code review for Claude Code, Cursor, Codex and Cline. It runs inside your coding agent, before you push. It works out your change: the commits not yet pushed plus everything uncommitted. It runs the scanners that fit the changed files and keeps only findings on the lines you changed. Your agent then reviews the change on its own model and writes its findings in a fixed shape. OpenQodex checks those findings without a model and writes the report. It needs no key, no account and no server.

## Install

For humans, in your terminal:

```
npx openqodex init
```

`init` finds Claude Code, Cursor, Codex CLI and Cline on your machine. It prints every file it will write and asks once. Then say to your agent: "review my change with openqodex".

For agents:

```
npx skills add openqodex/openqodex
```

Or paste this prompt into your agent:

```
Install the OpenQodex skill with `npx skills add openqodex/openqodex`.
Then review my current change with openqodex and tell me the verdict and the findings.
```

OpenQodex needs Node 22 or newer and git. It runs on macOS and Linux. On Windows, use WSL.

<!-- recording: added before launch -->

## What it does today

- `openqodex review --agent` writes a review brief for your agent: the scanner findings to verify, review patterns that fit the change, and the diff.
- `openqodex review --finalize` checks the agent's findings without a model and writes `report.md`, `report.json` and `report.sarif`.
- `openqodex scan` runs the scanners only, for git hooks, pre-commit and CI.
- Thirteen built-in scanners. Every downloaded scanner is pinned to one version. Each runs only when the change holds a file it reads.
- Any scanner by its GitHub link, after you approve it with `openqodex trust`.
- A push gate for Claude Code and Codex. It warns by default. It blocks only when `.openqodex.yaml` sets `review.block_on_severity`.
- A GitHub Action and a pre-commit hook that run `openqodex scan`.
- `openqodex demo` builds a small repo with planted bugs and scans it.

## What it does not do yet

- No review on your own API key. The review runs on your agent's model only.
- No tool server for agents (MCP).
- No Homebrew formula, no install script and no Docker image. Install through npm.
- No Windows support outside WSL.
- No offline copy of the vulnerability database. The dependency check asks osv.dev.

## First run

Scanners download on first use into `~/.openqodex/tools/`. Only the scanners your change needs download. The table below gives each download size.

Installed scanners take more disk than their downloads. The eight scanners the demo needs take about 700 MB of disk on an Apple Silicon Mac. semgrep with its Python takes about 440 MB of that.

A scanner install that takes longer than 45 seconds keeps going in the background. The report lists that scanner as installing. The scanner joins the next run. To install every scanner up front, run `npx openqodex doctor --install`.

One measured first run: an Apple Silicon Mac, an empty tool folder, a line of 2 MB per second. The first `openqodex demo` printed its report in under a minute. That report held the scanners that had finished installing and listed the rest as installing. The next `scan` included all eight scanners. Your times depend on your line.

OpenQodex does not install language runtimes. brakeman and rubocop need Ruby 2.7 or newer. golangci-lint needs Go. Without them, the report lists those scanners as not installed, with the reason.

## Built-in scanners

| Scanner | Version | Runs when the change holds | Needs | Download (Apple Silicon, Linux x64) |
|---|---|---|---|---|
| semgrep | 1.94.0 | any file | Python 3.11, downloaded through uv | about 86 MB with bandit, measured on Apple Silicon |
| gitleaks | 8.21.2 | any file | nothing | 2.9 MB, 3.0 MB |
| bandit | 1.9.4 | `.py`, `.pyi` | the same Python as semgrep | included with semgrep |
| ruff | 0.8.4 | `.py`, `.pyi` | nothing | 9.9 MB, 11.2 MB |
| oxlint | 1.71.0 | `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | npm, which ships with Node | 7.3 MB, 8.2 MB |
| osv-scanner | 1.9.2 | a lockfile, such as `package-lock.json` or `go.sum` | network access to osv.dev | 31.8 MB, 32.1 MB |
| actionlint | 1.7.7 | `.github/workflows/*.yml` | nothing | 2.0 MB, 2.1 MB |
| hadolint | 2.15.1 | a Dockerfile | nothing | 102.6 MB, 55.7 MB |
| shellcheck | 0.10.0 | `.sh`, `.bash` | `xz` to unpack | 7.2 MB, 2.4 MB |
| golangci-lint | 2.12.2 | `.go` | Go | 14.4 MB, 15.0 MB |
| brakeman | 6.2.1 | a Ruby or Rails file, in a repo with a `Gemfile` and an `app/` folder | Ruby 2.7 or newer; see its licence below | from RubyGems, not measured |
| rubocop | 1.69.2 | `.rb`, `.rake`, `.gemspec`, `Gemfile`, `Rakefile` | Ruby 2.7 or newer | from RubyGems, not measured |
| sqllint | built in | `.sql` | nothing, it runs inside OpenQodex | none |

[docs/scanners.md](docs/scanners.md) lists every file each scanner reads and what each one sends.

brakeman's licence is the Brakeman Public Use License, which is not an open source licence. OpenQodex does not bundle brakeman. It downloads brakeman at run time onto your machine. `scanners.disable: [brakeman]` switches it off.

## Add any scanner

Add a scanner by its GitHub link in `.openqodex.yaml` at the root of your repo:

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
```

A custom scanner is a command that runs on your machine. It never runs until you approve it:

```
npx openqodex trust
```

`trust` picks the release asset for your machine and downloads it. It shows the version, the asset, its sha256 and the run line, then asks yes or no. An edited entry needs a new approval. [docs/custom-scanners.md](docs/custom-scanners.md) explains each step.

## What goes over the network

- Scanner downloads on first use: GitHub release files checked against pinned sha256 sums, and pinned packages from PyPI, npm and RubyGems.
- Semgrep rule packs (`p/default`, `p/security-audit`, `p/secrets`), fetched from the Semgrep registry on each run.
- When the change holds a lockfile, osv-scanner sends dependency names and versions to osv.dev. It never sends code.

- `openqodex trust` reads the custom scanner's release from the GitHub API and downloads it.

`--offline` skips osv-scanner and semgrep and turns scanner downloads off.

The built-in scanners send no code anywhere. Your agent's model sees what your agent reads, as always. A custom scanner you approved does whatever its own command does. [docs/security.md](docs/security.md) gives the full list.

## Packages

| Package | What it is |
|---|---|
| [`openqodex`](https://www.npmjs.com/package/openqodex) | One package. It holds the CLI as one bundled file with no runtime dependencies. The skill, the agent templates, the docs, the review patterns and the demo ship as separate files beside it. |

`@openqodex/core` and `@openqodex/scanners` are internal workspace packages. The CLI bundles them, and they are not published.

## Documentation

The docs ship inside the package. `npx openqodex guide <topic>` prints a page offline.

- [Quickstart](docs/quickstart.md)
- [Commands](docs/cli.md)
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
