# Privacy

This page is the privacy policy for OpenQodex: the `openqodex` package on npm, its skill, its plugins for Claude Code, Codex and Cursor, its GitHub Action and its pre-commit hook. `security` and `telemetry` give the details behind each line.

## What OpenQodex collects

Nothing. OpenQodex collects no usage data, no crash reports and no identifiers. It has no server and no account, and it sends no telemetry. semgrep runs with its own metrics switched off.

## Who reviews your code

The review runs on the coding agent you already use, such as Claude Code, Cursor, Codex or Cline, on the model that agent already uses. That model sees what your agent reads, as it does without OpenQodex. OpenQodex adds no other model and needs no API key.

## Every network call OpenQodex makes

OpenQodex and the built-in scanners send no code anywhere. They use the network for these things only:

- Scanner downloads on first use, into `~/.openqodex/tools/`. GitHub release files are checked against sha256 sums pinned in the package. semgrep and bandit come from PyPI through uv, with a Python 3.11 that uv downloads. oxlint comes from npm. brakeman and rubocop come from RubyGems. These package installs are pinned by version.
- Semgrep rule packs. semgrep fetches `p/default`, `p/security-audit` and `p/secrets` from the Semgrep registry on each run.
- The dependency check. When the change holds a lockfile, osv-scanner sends the names and versions of the dependencies in it to osv.dev. It never sends code.
- Custom scanners. `openqodex trust` reads the scanner's release from the GitHub API and downloads the asset.
- A problem report, only when you choose it. When OpenQodex fails, it shows the GitHub issue it would create and asks. Only your choice 1, or `openqodex report --send-last`, creates that issue on GitHub. The issue holds the command, a short diagnostic, scanner statuses, the operating system, the CPU type and the Node version, never code, diffs, findings, config or logs. `cli` gives the details.

`--offline` skips osv-scanner and semgrep and turns scanner downloads off.

The plugins, the GitHub Action and the pre-commit hook fetch the `openqodex` package from npm to run it.

The GitHub Action uploads its findings to code scanning in your own repository on GitHub: each finding's message, file path and line numbers, as a SARIF file. Set `upload-sarif: false` in the workflow to turn that off.

## Custom scanners

A custom scanner named in `.openqodex.yaml` is a command that runs on your machine with your permissions. It never runs until you approve that exact entry with `openqodex trust`, and an edited entry needs a new approval. After approval, a custom scanner does whatever its own command does, including any network use. OpenQodex does not control it.

## What stays on your machine

Scanners, caches and your approvals stay under `~/.openqodex/`. Each review writes its brief, findings and reports under `.openqodex/` in your repository. When gitleaks finds a secret in the change, OpenQodex removes it from the brief, every report file and the terminal.

## Contact

Questions about this page: siddhant@qodex.ai. Report a vulnerability through GitHub's private vulnerability reporting on the openqodex/openqodex repository, never in a public issue.
