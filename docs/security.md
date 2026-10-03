# Security

This page says what OpenQodex runs, what it sends where, and what it writes. Report a vulnerability through GitHub's private vulnerability reporting on the openqodex/openqodex repository. Never open a public issue for one.

## What runs

- The `openqodex` CLI, on your Node.
- The built-in scanners that fit the change, from `~/.openqodex/tools/`. Each is pinned to one version. A built-in scanner is never taken from your `PATH`.
- Custom scanners from `.openqodex.yaml` that you approved with `openqodex trust`.
- git, from your `PATH`.

OpenQodex starts every program with an argument list, never through a shell. Scanners get a small set of environment variables: `PATH`, `HOME`, `TMPDIR`, `LANG`, the `LC_` variables, the proxy variables, and what the scanner itself needs. Your other variables, such as API keys, are not passed on.

A repository can hold config files that make a scanner run code or rewrite files. OpenQodex does not load such files for oxlint, golangci-lint, brakeman and rubocop. It uses its own settings for them. ruff and gitleaks read the repository's own settings for rules only. ruff runs with fixes switched off.

## The trust step

A custom scanner is an arbitrary command. It runs on your machine with your permissions. The config file that names it comes from whatever repository you cloned. So nothing installs or runs a custom scanner until you approve that exact entry:

```
npx openqodex trust
```

`trust` downloads the release asset to a quarantine folder before it asks. Nothing is installed or run before your yes. `scan` and `review` never download a custom scanner. `trust` prints the version, the asset, its sha256, the program and the run line, then asks yes or no. The approval covers that repository and that entry only. An edited entry needs a new approval. `scan` and `review` skip an unapproved entry and list it as `untrusted`.

The stored sha256 is checked against the project's checksum file when the project publishes one. Otherwise it is the hash of your first download. `custom-scanners` explains the difference.

Agents that follow the OpenQodex skill are told never to run `openqodex trust` without asking you. In user scope, `init` adds rules so Claude Code runs exactly `review --agent`, `review --finalize`, `review --agent --all` and `review --finalize --all` (each also with ` --offline`), `guide` and `guide <topic>` through the launcher without asking. An `ask` or `deny` rule in your own or your organisation's managed Claude Code settings still wins over these. Any other flag, any other command (`scan`, `doctor`, `trust`, `update`, `init`, `report`) and `init --project` grant nothing.

## What is sent where

OpenQodex and the built-in scanners send no code anywhere. The review runs on the model your agent already uses, which sees what the agent reads. A custom scanner you approved does whatever its own command does.

OpenQodex and the built-in scanners use the network for these things only:

- Scanner downloads on first use. GitHub release files are checked against sha256 sums pinned in the package. semgrep and bandit come from PyPI through uv, with a Python 3.11 that uv downloads. oxlint comes from npm. brakeman and rubocop come from RubyGems. These package installs are pinned by version.
- Semgrep rule packs. semgrep fetches `p/default`, `p/security-audit` and `p/secrets` from the Semgrep registry on each run. Its metrics are off. The rules are never bundled in the package.
- The dependency check. When the change holds a lockfile, osv-scanner sends the names and versions of the dependencies in it to osv.dev. It never sends code.
- Custom scanners. `openqodex trust` reads the release from the GitHub API and downloads the asset. After approval, a custom scanner does whatever its own command does.
- The daily version check, for an install made with `init`. See "Updates" below.

golangci-lint runs with the Go module proxy off, so it downloads no modules.

`--offline` skips osv-scanner and semgrep, which the report lists as disabled. It also turns scanner downloads off and the version check.

## Updates

An install made with `npx openqodex init` runs through the launcher `~/.openqodex/bin/openqodex`. After a `review`, `scan`, `hook check` or `hook pre-push` that the launcher started, at most once every 24 hours, OpenQodex starts a background process and the command exits without waiting for it.

What it sends: GET requests to `registry.npmjs.org` only, over https, with no body and no header but the user agent `openqodex/<version>`. First the openqodex package's release list. Then, for a newer release, its tarball and its attestations. Nothing about you, your code or your repository is sent. Every redirect must stay on `registry.npmjs.org`.

What it installs: a release that is newer than the running one, in the same major version, at least 24 hours old, not deprecated, not a prerelease, and fit for your Node. Before any of its code runs:

- the tarball's sha512 must equal the registry's `dist.integrity`;
- its SLSA provenance must verify in full with Sigstore: the certificate chain to the Fulcio roots, the certificate transparency entry, the transparency log entry and the signature;
- the signing certificate must be issued to `https://github.com/openqodex/openqodex/.github/workflows/release.yml@refs/heads/main` by `https://token.actions.githubusercontent.com`, compared exactly;
- the signed statement must name `pkg:npm/openqodex@<version>` with the downloaded tarball's sha512.

A stolen npm publish token is therefore not enough to reach your machine: the release must come out of this repository's release workflow on `main`. The 24 hour age is a window to deprecate a bad release before installs take it.

The Sigstore trust data (Fulcio roots, log keys) ships inside each release, so verification makes no other network call. When Sigstore rotates a key that an old release does not know, that release cannot verify newer ones. It stays on its version and says once how to update by hand: `npx openqodex@latest init`.

A verified release is unpacked into a temporary folder under `~/.openqodex/runtime/`. A link in the tarball, or a path that leaves the folder, stops it. No install script runs. The new copy must print its own version. Only then, holding the lock below, the updater checks again that updates are still on, that OpenQodex is still installed and that no other update, rollback or `init` changed the active version meanwhile. It then renames the copy to `~/.openqodex/runtime/<version>/` and switches `~/.openqodex/runtime/current` by a second rename. A version folder is never replaced: when one with other contents is already there, the release is skipped. An update writes no agent file and nothing inside a repository.

The lock: while `init`, `init --uninstall`, `hook install`, `update --rollback`, `update --off`, `update --on` or an update's switch runs, OpenQodex briefly opens a listener on 127.0.0.1, on a port between 20000 and 32000 derived from the path of `~/.openqodex`, so that two of them never run at once; it accepts no data and answers nothing, and the operating system closes it when the process ends, however it ends. When the listener cannot be opened at all, those commands stop with one line saying why, and the daily check skips the switch. The port is predictable, so a local program that holds it stops install, uninstall and updates until it lets go; nothing is installed or changed while it is held. A command that waited 60 seconds for it names the port and the line that shows the holder (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), and the daily check records the same as its last error, which `openqodex update --status` and `doctor` show.

Updates are off with `openqodex update --off`, `update: off` in `~/.openqodex/config.yaml`, `OPENQODEX_AUTO_UPDATE=0`, `--offline` or `OPENQODEX_OFFLINE=1`, and whenever `CI` is set. A run through `npx` or a project-scope file never checks.

OpenQodex sends no telemetry. See `telemetry`.

## Secrets

When gitleaks finds a secret in the change, OpenQodex removes it from the brief, every report file and the terminal. It keeps the length and sha256 of each secret, to redact any text the agent quotes.

gitleaks writes its raw report to a temporary file outside the repository. That file holds the matched secrets. OpenQodex deletes it when the run ends. No file OpenQodex keeps holds the secret.

A secret is redacted only when a scanner matched it. When gitleaks did not run, the brief shows the change as it is.

## Where files are written

In your home folder, under `~/.openqodex/` (`OPENQODEX_HOME` moves it):

- `tools/<scanner>/<version>/`: the scanners.
- `tools/uv-python/`: the Python 3.11 for semgrep and bandit.
- `cache/`: the download caches for uv and npm.
- `runtime/<version>/` and `bin/openqodex`: the copy of the package and the launcher that the hooks call, written by `init`. Updates add copies beside it; a copy is never changed after it is written. `init` and `openqodex update` remove copies older than 7 days, except the one `init` installed, the current one and the previous one.
- `runtime/current`: the version the launcher runs, and on a second line the version a rollback goes back to.
- `update.json`: the state of the version check, private to you.
- `config.yaml`: your own settings; today only `update`.
- `install.json`: what `init` and `hook install` wrote, so an uninstall removes only that.
- `trust.json`: your approvals of custom scanners.

In the repository, under `.openqodex/` only:

- `config.yaml` and `custom-instructions.md`: the team's config and instructions for the reviewer, created once and never touched after. They are meant to be committed.
- `.gitignore`: keeps the run state below out of git, so after the first run `git status` shows only the two files above and the `.gitignore`.
- `reviews/<time>-<id>/`: one folder per run, holding the brief, the scan result, the agent's findings and the reports. OpenQodex keeps the newest 20.
- `latest.json`: points at the newest review; the push gate reads only this. `latest-scan.json` points at the newest scan.

OpenQodex never reads or writes `.openqodex/` or the root `.openqodex.yaml` through a symbolic link, at the file or at any folder above it inside the repository. A link there stops the command with one line naming it, or, for a run file such as `latest.json`, counts as no file. Only regular files are read there, each within a size limit, so a link or a device in their place cannot hang a run.

The agent settings and skill files `init` writes are listed in `agents`.

The change itself is worked out without writing inside `.git`. OpenQodex uses a temporary copy of the index and a temporary object folder.
