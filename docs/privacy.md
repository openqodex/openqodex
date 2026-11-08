# Privacy

This page is the privacy policy for OpenQodex: the `openqodex` package on npm, its skill, its plugins for Claude Code, Codex and Cursor, its GitHub Action and its pre-commit hook. `security` and `telemetry` give the details behind each line.

## What OpenQodex collects

Nothing. OpenQodex collects no usage data, no crash reports and no identifiers. This covers OpenQodex and its built-in scanners. Claude Code, Codex and any custom scanner you approve follow their own policies. It has no server and no account, and it sends no telemetry. semgrep runs with its own metrics switched off.

## Who reviews your code

By default, the review runs in a reviewer process OpenQodex starts on your machine: Claude Code or Codex, on your own login. That process sends the brief and what the reviewer reads to the model your login uses. OpenQodex adds no other model and needs no other key. By default the reviewer can also search the web, and Claude Code can open web pages; `reviewer_web: off` in `~/.openqodex/config.yaml` removes that.

When neither Claude Code nor Codex can be the reviewer, `review` names a fallback, `review --agent`. In that fallback, the coding agent you are in reviews the change itself, on the model that agent already uses. So the session that wrote the code also reviews it. The report says which agent reviewed.

In the GitHub Action's review mode, which runs only when the workflow sets `ANTHROPIC_API_KEY` on the step or asks for `review: required`, the reviewer is Claude Code on the runner. It sends the pull request's change, as the brief and the files it reads, to Anthropic's API under the repository's own key. The reviewer's web tools are off there.

## Every network use

OpenQodex and the built-in scanners send no code anywhere. They use the network for these things only:

- Scanner downloads on first use, into `~/.openqodex/tools/`. GitHub release files are checked against sha256 sums pinned in the package. semgrep, bandit, SQLFluff and Checkov come from PyPI through uv, with a Python 3.11 that uv downloads. brakeman and rubocop come from RubyGems. These package installs are pinned by version.
- Semgrep rule packs. semgrep fetches `p/default`, `p/security-audit` and `p/secrets` from the Semgrep registry on each run.
- The dependency check. At every review and scan of a change, osv-scanner reads every supported lockfile in the repository. It sends the names and versions of the dependencies in them to osv.dev. It never sends code.
- Kubernetes schemas. When the change holds a Kubernetes manifest, kubeconform downloads the JSON schema of each kind it meets from raw.githubusercontent.com, at one commit pinned in the package, so the requests name the kinds you use. It never sends a manifest. Each schema is cached and fetched once.
- The RustSec advisory database. When the change holds a `Cargo.lock`, cargo-deny fetches the database from github.com with git into `~/.openqodex/cache/cargo-deny/`. Nothing about your code or your crates is sent. Cargo itself runs offline.
- Custom scanners. `openqodex trust` reads the scanner's release from the GitHub API and downloads the asset.
- The problem report, only when you choose it. When OpenQodex fails, a scanner breaks, or you run `openqodex report`, it prints the GitHub issue it would create and two choices. Nothing is sent unless you press 1 or run `openqodex report --send-last`. The issue holds the OpenQodex version, the command and its arguments with paths and secrets taken out, the part that failed, a scrubbed error line, the scanner statuses and your platform. It never holds code, file names, paths, repository names, config or secrets.
- The daily version check, for an install made with `init`. It sends GET requests to `registry.npmjs.org` only, with nothing about you, your code or your repository. `security` describes what it checks before it installs a release.
- A review of a branch or a pull request. git fetches it from your own remote with git's own credentials, and the GitHub CLI, when it is installed and signed in, is asked for the pull request's base. OpenQodex reads no token.

`--offline` skips osv-scanner, semgrep, kubeconform and cargo-deny and turns scanner downloads and the version check off.

The plugins, the GitHub Action and the pre-commit hook fetch the `openqodex` package from npm to run it. In its review mode the Action also installs Claude Code from npm, unless the runner already has the pinned version.

The GitHub Action uploads its findings to code scanning in your own repository on GitHub: each finding's message, file path and line numbers, as a SARIF file. Set `upload-sarif: false` in the workflow to turn that off.

## Custom scanners

A custom scanner named in `.openqodex/config.yaml` is a command that runs on your machine with your permissions. It never runs until you approve that exact entry with `openqodex trust`, and an edited entry needs a new approval. After approval, a custom scanner does whatever its own command does, including any network use. OpenQodex does not control it.

## What stays on your machine

Scanners, caches and your approvals stay under `~/.openqodex/`. Each review writes its brief, findings and reports under `.openqodex/` in your repository. When gitleaks finds a secret in the change, OpenQodex removes it from the brief, every report file and the terminal.

## Contact

Questions about this page: siddhant@qodex.ai. Report a vulnerability through GitHub's private vulnerability reporting on the openqodex/openqodex repository, never in a public issue.
