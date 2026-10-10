# GitHub Action

The OpenQodex Action checks a pull request's change in one of two modes:

- The review, when the workflow gives the step an Anthropic API key. The Action runs the full `openqodex review` on the change: the scanners, the code graph and a separate Claude Code reviewer, with script checks of its answer. The job summary shows the report, and the findings go to GitHub code scanning as SARIF.
- The scanners only, without a key. The Action runs `openqodex scan`. No model is involved, and the first output line says it is not a review. The findings go to code scanning as SARIF.

## Example workflow: the scanners only

Save this as `.github/workflows/openqodex.yml`:

```yaml
name: OpenQodex

on:
  pull_request:

permissions:
  contents: read
  security-events: write
  actions: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: openqodex/openqodex@v0
```

- `fetch-depth: 0` fetches the full history. The scan needs the pull request's base commit, which a shallow checkout does not have.
- `security-events: write` lets the Action upload SARIF to code scanning.
- `actions: read` is read by the SARIF upload in a private repository.
- `contents: read` lets the job check out the code.

## Example workflow: the review

Add your Anthropic API key as a repository secret named `ANTHROPIC_API_KEY` (Settings, Secrets and variables, Actions). Then set it on the OpenQodex step:

```yaml
name: OpenQodex

on:
  pull_request:

permissions:
  contents: read
  security-events: write
  actions: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: openqodex/openqodex@v0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          review: required
```

Set the key on this step only, never on the job or the workflow, so no other step gets it. The key is not an input: it never appears in the step's list of inputs. Inside the Action, every step but the one that runs the review sets `ANTHROPIC_API_KEY` empty, so setup-node, the cache, the SARIF upload and the last step never hold the key.

Each review spends your repository's own API credit at Anthropic's prices. A review takes one to three minutes, and a very large change uses millions of input tokens ([issue 30](https://github.com/openqodex/openqodex/issues/30)). OpenQodex sets no budget.

## The three review values

- `auto` (the default): the review when the step's environment holds `ANTHROPIC_API_KEY`, the scanners only when it does not.
- `off`: the scanners only, even with a key.
- `required`: the Action always attempts the review, with the key, or with a Claude Code already logged in on a self-hosted runner. The job fails unless the review completes, or the change has nothing to review after the config's exclusions.

Use `required` for a check that a branch protection rule depends on. With `auto`, a green job is not proof of a review: the job also passes when the key is missing, when no reviewer could start, or when the review did not complete. Read the `reviewed` output to tell.

## What a pull request from a fork gets

GitHub gives no secrets to a workflow run for a pull request from a fork, and Dependabot's pull requests get Dependabot's secrets only. Such a pull request gets the scanners only under `auto`, and a failed job under `required`. A maintainer can review it on their own machine with `openqodex review '#<number>'`.

The review never runs on `pull_request_target`. That event hands the repository's secrets to a workflow that checks out code from forks. The Action runs the scanners only there, and says why in the job summary when a key is set or the review is required.

## Inputs

- `version`: the `openqodex` version to run, an exact SemVer release version such as `0.6.1` (a prerelease such as `0.7.0-rc.1` works too; no leading zeros, no build metadata). The default is the version the Action was released with. A path, a `file:` or git package, an alias, a tag such as `latest`, a range or a malformed prerelease such as `1.2.3-..` fails the step before npm runs, since npm would install whatever it names.
- `review`: `auto`, `off` or `required`, as above. Any other value fails the step.
- `claude-code-version`: the Claude Code version the review runs. The default is the version the reviewer was tested with. When the runner's own `claude` is not that version, the Action installs it with `npm install --global --prefix <runner temp>/openqodex-claude-code @anthropic-ai/claude-code@<version>`, and never over a Claude Code the runner has. Anything but an exact release version fails the step, as for `version`.
- `upload-sarif`: `true` or `false`. The default is `true`. Set it to `false` to skip the code scanning upload.
- `block-on-severity`: `info`, `nitpick`, `minor`, `major` or `critical`; any other value fails the step. The job fails on a finding on a changed line at or above it, in both modes. When set, it wins over `review.block_on_severity` in the repository's config. Empty (the default) uses the config.
- `fail-on-tool-error`: `true` or `false`. The default is `false`. With `true`, the job fails when OpenQodex itself could not run the scan, install the scanners or complete the review.
- `config-from`: `base` or `head`. The default is `base`. Any other value fails the step. In a pull request, `base` reads the OpenQodex config and the review's custom instructions from the pull request's base commit, and `head` reads the ones the pull request carries. Other events always read the checked-out files.

## Outputs

- `status`: `passed`, `blocked` (a finding met the block severity) or `tool-failed` (OpenQodex could not run the scan, or the review did not complete).
- `reviewed`: `true` only when this run produced a complete review.
- `review-status`: `complete`, `incomplete` (the reviewer started and did not finish), `unavailable` (no reviewer could start), `skipped` (nothing to review) or `off` (the job ran the scanners only).
- `reviewer`: the reviewer and its version, such as `claude 2.1.289`. Empty when no reviewer started.

## The config a pull request can change

In a `pull_request` workflow the checkout is the pull request's own code, so its `.openqodex/config.yaml` or `.openqodex.yaml` is the pull request author's. That file can hide findings: `review.disabled_rules`, `review.severity_threshold`, `review.paths.exclude`, `scanners.disable` and `review.block_on_severity` all live there. So in a pull request the Action reads the config from the base branch instead. It fetches the base branch (`github.base_ref`), writes its `.openqodex/config.yaml`, or else its `.openqodex.yaml`, to a file under the runner's temporary folder with `git show`, and passes that file to OpenQodex with `--config`. It never falls back to the pull request's own file: a base branch with neither file, a fetch that fails, or a branch name that is not plain letters, digits, `.`, `_`, `/` and `-` gives the built-in defaults, and the last two also show a warning annotation.

The review's custom instructions follow the same rule. `.openqodex/custom-instructions.md` tells the reviewer what to flag and what to leave alone, so a pull request could use its own copy to ask for a clean report. In a pull request the Action writes the base branch's copy to the runner's temporary folder and passes it with `--instructions`; when the base has none, the review has no custom instructions.

A custom scanner never runs on the runner, since no approval is stored there, whichever config is used. The Action passes no `--only` or `--skip`.

A team that wants each pull request's own config and instructions sets `config-from: head`.

On every event, and for both `config-from` values, the Action hands OpenQodex the config and the custom instructions as files in the run's own folder under the runner's temporary folder, never as paths in the checkout. It reads them from git objects of one commit: the base branch for `config-from: base` in a pull request, else the checked-out commit. Only a regular file in that commit counts; a link or a folder at `.openqodex`, `.openqodex/config.yaml`, `.openqodex.yaml` or `.openqodex/custom-instructions.md` counts as no file, so the built-in defaults and no instructions apply, and the link is never followed.

What the Action cannot control: on `pull_request` events GitHub runs the workflow file from the pull request itself, so an author who may change workflows can change or remove this step, or send the secret elsewhere. Branch protection with required status checks, required workflows, or `pull_request_target` used with care are GitHub's own answers to that; the Action cannot defend against an edited workflow.

`block-on-severity` in the workflow also wins over any config, since the workflow file lives on your base branch:

```yaml
      - uses: openqodex/openqodex@v0
        with:
          block-on-severity: major
```

## What it does

1. Sets up Node 22.
2. Restores `~/.openqodex/tools` from the Actions cache. The key is the runner, the sha256 of the pinned scanner table and its lock files, and the scanners this repository's files call for, so a release that pins nothing new reuses the cache. A step before it works that out: the same script in its plan mode does steps 3 and 5, runs `doctor --json`, prints the reason line of each scanner the repository needs, and installs nothing.
3. Takes `ANTHROPIC_API_KEY` out of the step's environment. Only the review command gets it back (step 7). Steps 3 to 9 run as `scripts/action-scan.sh`. The script's own helpers (`od`, `tee`, `mktemp`, `sed` and the rest) come from the system folders `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin` only. It takes `git`, `node`, `npx`, `npm` and `claude` from the workflow's `PATH`, relative folders and folders inside the repository left out, only when every step of the path to the file, links followed, lies outside the repository, and runs them by their resolved paths; a `git`, `node` or `npx` it cannot find there fails the step. The programs it starts get a `PATH` of a folder of links to those files, plus the scanners' runtimes (`ruby`, `gem`, `go`, `uv`, `xz`) when the workflow's `PATH` has ones that pass the same check, then the system folders, never the workflow's `PATH`. A `claude` that is a wrapper needing the workflow's `PATH` does not run there, and the Action installs the pinned Claude Code instead. Everything the programs print goes to the job log with workflow commands off (between `::stop-commands::` and a token new each run), so a file name in the pull request cannot write an annotation or a command.
4. Decides the mode: the review on a `pull_request` or `push` event when the key is set or `review` is `required`, unless `review` is `off`; the scanners only otherwise. The first output line names the mode. In the scanners-only mode, the second line says why there is no review, or how to turn it on.
5. Writes the config and the custom instructions to files in the run's folder, from git objects of the base branch (a pull request with `config-from: base`, after fetching it) or of the checked-out commit (every other case), and passes them with `--config` and `--instructions`.
6. Runs `npx -y openqodex@<version> doctor --install`, which installs the scanners this repository's files call for and waits. A failure here is handled like a scan that could not run (below), and nothing else runs.
7. The review: installs Claude Code at `claude-code-version` when needed (npm runs from the runner's temporary folder, never from the checkout, so the pull request's `.npmrc` does not apply), and runs `npx -y openqodex@<version> review --reviewer claude --reviewer-web off --base <base> --report-dir <folder>`, with `--config`, `--instructions` and `--block-on-severity` when they apply. `--reviewer-web off` turns the reviewer's web tools off for this run whatever the runner's user config says, and the Action never edits that file. The report comes from the new folder under the runner's temporary folder that this run named, never from `.openqodex/` in the checkout, where a pull request could commit a report of its own.
8. The scan: `npx -y openqodex@<version> scan --base <base> --format sarif --report-dir <folder>`, with `--config` from step 5 when there is one. It runs in the scanners-only mode, and in the review mode when the review did not complete or no reviewer could start, always without the key. The SARIF and the scan's files go to a new folder under the runner's temporary folder, never into the checkout. With `--report-dir` and the config and instructions of step 5, `doctor`, the scan and the review create, read and write nothing under `.openqodex/` in the checkout, on every event, so a commit that makes `.openqodex/reviews`, `.openqodex` or a file under it a link cannot stop them or turn a blocking finding into a tool failure. The base is the pull request's base commit; on a `push` event it is the commit the push replaced, or, for a push that creates a branch, the merge base with the repository's default branch. Any other event has no base: the first output line says so and the scan uses its default scope.
9. Writes the outputs and the job summary.
10. Uploads the SARIF to code scanning, when `upload-sarif` is `true` and a report was written.
11. Fails the job on a blocking finding, on `review: required` without a complete review, or on a tool failure with `fail-on-tool-error: true`.

How each review ends:

- Complete: the job summary is the report. The job fails when a finding meets the block severity.
- Incomplete: the reviewer started and did not finish, for example at its time limit or on a refused key. The reviewer may have stopped before it checked any scanner finding, so the job also runs the scan. The summary starts with "The review did not complete" and the reason, then this run's partial report, whose findings passed every check, then the scan's report. The SARIF uploaded to code scanning is the scan's, since it holds every scanner finding; the partial review's findings are in the summary. A finding at the block severity in either report fails the job, under `auto` and `required` alike. Otherwise `status` is `tool-failed`.
- Unavailable: no reviewer could start (no key and no login, or Claude Code could not be installed). The job runs the scanners instead, says why in the summary and a warning annotation, and uploads the scanner findings. A blocking scanner finding fails the job; otherwise `status` is `tool-failed`.
- Skipped: nothing to review after the config's exclusions. The job passes, also under `required`.

A report counts only with the exit code that goes with it: 0 or 1 for a complete review, 2 for an incomplete one. A review that ends any other way (a crash, a kill, or a failure after it wrote its report) is a tool failure whatever its report says: `reviewed` is `false`, the job also runs the scan, and a blocking finding in that report still fails the job. Whether the reviewer started, which tells incomplete from unavailable, comes from the `reviewer.json` that `review` writes in the run's own folder, never from what it printed.

A blocking finding fails the job whatever `fail-on-tool-error` says. An incomplete or unavailable review fails the job only under `fail-on-tool-error: true` or `review: required`.

The scan exits 1 only when `block-on-severity` or the config's `review.block_on_severity` is set and a finding on a changed line meets it. Without either, the job never fails on findings. A suppression comment the change adds, such as `# nosec`, and a changed scanner settings file each count as a minor finding, since nobody reviews them here; `scanners` lists the comments. A scan that fails for its own reasons, for example on a config file it cannot read, exits 2; a scan killed by a signal or ending with any other code counts as exit 2 too. The same holds when the scanner install fails. The job then shows a warning annotation titled "OpenQodex did not run" with the last line OpenQodex printed (control characters and colon runs removed), writes the same line to the job summary with every markdown and HTML character escaped, and sets `status` to `tool-failed`. It does not fail unless `fail-on-tool-error` is `true`.

## What the review mode sends, and the limits of the key's protection

The reviewer is Claude Code. It sends the review brief and the files it reads to Anthropic's API under your key, as any Claude Code session does. The reviewer's web tools are off in the Action. Secrets the scanners found are redacted in the copy of the change the reviewer reads; a secret no scanner matched is not.

The key is handed to the `review` command alone. `doctor`, the Claude Code install and a fallback `scan` run without it, the Action's other steps get it set empty, and the script never prints it or writes it to a file. Inside the review, the scanners and the reviewer each get a short list of environment variables: the scanners never get the key, and the reviewer gets it because Claude Code needs it.

One limit remains: the `review` process itself holds the key while it runs the scanners on the pull request's files, and a list of environment variables is not a wall between processes that run as the same user. What keeps the key away from the pull request's code: the built-in scanners read the code and never run it; no custom scanner runs on a runner, since its approval lives on the machine that gave it; and the reviewer has no shell. A pull request can still quiet a scanner on its own lines, with an inline suppression comment or a scanner settings file ([issue 28](https://github.com/openqodex/openqodex/issues/28)).

## Config

Outside a pull request, and with `config-from: head`, the Action uses the config the checked-out commit holds, read from its git objects as above. Custom scanners need an approval stored on the machine that runs them. The runner has none, so the Action lists custom scanners as `untrusted` and skips them.

## Pre-commit

The repository also ships a pre-commit hook for the pre-push stage. Add this to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/openqodex/openqodex
    rev: v0.11.1
    hooks:
      - id: openqodex-scan
```

Then install the pre-push hook:

```
pre-commit install --hook-type pre-push
```

The hook runs `npx -y openqodex@<version> scan` on the commits not yet pushed plus the working tree. It stops the push only when the scan exits 1. As in the Action, an added suppression comment and a changed scanner settings file count as minor findings. A scan that fails for its own reasons never stops the push. The hook needs Node 22, npx and `sh` on your machine.
