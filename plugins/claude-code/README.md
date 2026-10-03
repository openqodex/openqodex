# OpenQodex for Claude Code

OpenQodex is open source AI code review that runs inside Claude Code, before you push. It runs the scanners that fit your change on the lines you changed, then Claude reviews the change on its own model. A final step with no model checks each finding's format, whether it sits on a changed line, and any scanner it cites.

## What the plugin installs

- The `openqodex` skill. It tells Claude how to run the review: start the scan, verify each scanner finding, review the change, write the findings in a fixed shape and finalize the report.
- A push hook. Before Claude runs `git push`, the hook runs `openqodex hook check` through npx, pinned to the plugin's version. By default it never stops a push: it adds the finding counts of a finished review, or a note that the change was not reviewed. When `.openqodex.yaml` sets `review.block_on_severity`, it denies the push unless a finished review of the current change passed.

## How to use it

Say to Claude:

```
review my change with openqodex
```

The change is the commits not yet pushed plus everything uncommitted. To review the whole repository instead, say "review the whole repo with openqodex".

## What it needs

Nothing to sign up for: no API key and no account. The review runs on the model Claude Code already uses. OpenQodex needs Node 22 or newer and git, on macOS or Linux. On Windows, use WSL.

## Where the report goes

Each run writes a folder under `.openqodex/reviews/` in your repository, with `report.md`, `report.json` and `report.sarif`. Claude tells you the verdict and the path of `report.md`.

## What it runs and sends

The hook and the skill run the `openqodex` package from npm, pinned to one version. The built-in scanners download on first use into `~/.openqodex/tools/`, each pinned to one version. GitHub release files are checked against sha256 sums pinned in the package. semgrep and bandit come from PyPI, oxlint from npm, brakeman and rubocop from RubyGems. semgrep fetches its rule packs from the Semgrep registry on each run. When the change holds a lockfile, osv-scanner sends dependency names and versions to osv.dev. OpenQodex sends no code anywhere and collects no telemetry. A custom scanner named in `.openqodex.yaml` never runs until you approve it with `openqodex trust`, and then does whatever its own command does. `--offline` skips osv-scanner and semgrep and turns scanner downloads off.

## Learn more

- Docs: https://github.com/openqodex/openqodex/tree/main/docs
- Security: https://github.com/openqodex/openqodex/blob/main/docs/security.md
- Privacy: https://github.com/openqodex/openqodex/blob/main/docs/privacy.md

Licensed under Apache 2.0.
