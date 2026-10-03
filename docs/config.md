# Configuration

OpenQodex reads `.openqodex/config.yaml` in the repository. Every key is optional. With no file, the defaults apply, and OpenQodex warns but never blocks.

- `.openqodex.yaml` at the root, the 0.1.0 location, is still read when `.openqodex/config.yaml` does not exist. With both, OpenQodex reads `.openqodex/config.yaml` only and warns.
- `--config <path>` reads another file instead of either.

An unknown key prints a warning and is ignored. A value of the wrong type stops the run with exit 2 and names the key.

## Every key

<!-- config-keys:start -->
| Key | Default | What it does |
| --- | --- | --- |
| `version` | `1` | The file format version. 1 is the only one. |
| `review.severity_threshold` | `minor` | Findings below this severity stay out of the report; one at or above block_on_severity is always shown. |
| `review.block_on_severity` | `null` | Exit 1 and deny the push when a finding on a changed line is at or above this severity; null never blocks. |
| `review.paths.exclude` | `[]` | Globs of files left out of the change. |
| `review.disabled_rules` | `[]` | Globs on a finding's citation, such as gitleaks:generic-api-key or lens:react-*. |
| `review.default_base` | `null` | The branch or ref to diff against when the branch has no upstream; null uses the remote's default branch. |
| `review.include_fixtures` | `false` | Keep scanner findings in test fixtures, mocks and snapshots. |
| `scanners.disable` | `[]` | Built-in scanners to switch off, by name. |
| `scanners.custom` | `[]` | Open source scanners to add by GitHub link; each runs only after openqodex trust. |
| `graph.enabled` | `true` | Show the callers and importers of the changed code in the brief. |
| `graph.budget_ms` | `10000` | Time the code graph may take, in milliseconds. |
| `graph.max_files` | `4000` | Files past this count are left out of the code graph. |
| `graph.max_file_bytes` | `524288` | Files larger than this, in bytes, are left out of the code graph. |
<!-- config-keys:end -->

## A full example

```yaml
version: 1
review:
  severity_threshold: minor
  block_on_severity: critical
  paths:
    exclude: ["vendor/**", "**/*.min.js", "*.min.js"]
  disabled_rules: ["gitleaks:generic-api-key", "lens:react-*"]
  default_base: develop
  include_fixtures: false
scanners:
  disable: [brakeman]
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
graph:
  enabled: true
```

## Keys from the hosted review

The keys mirror the `.qodex.yaml` file of the hosted Qodex review where the meaning is the same, so one file can serve both.

- `pr_review` is read as `review`, with a warning. A file with both is refused.
- These keys are used by the hosted review only. Each prints a warning naming it and is ignored: `review.enabled`, `review.block_pr_merge`, `review.allow_approve`, `review.authors`, `review.base_branches`, `review.style_placement_threshold` and the whole `probes` block. `review.base_branches` there picks which pull requests are reviewed; `review.default_base` is the local key for the branch a change is compared with.

## Severity

OpenQodex uses one scale: `critical`, `major`, `minor`, `nitpick`, `info`. Scanner severities map onto it:

- critical to `critical`
- high to `major`
- medium to `minor`
- low to `nitpick`
- info to `info`

## version

`1`, the only version. Optional.

## review.severity_threshold

One of `critical`, `major`, `minor`, `nitpick`, `info`. The default is `minor`, the same as the hosted review.

A finding below this severity is left out of the report's findings and counted in `below_threshold` instead. Set `info` to see everything. A finding at or above `block_on_severity` is always shown, whatever this is set to. Scanner results the agent did not review are never hidden by it.

## review.block_on_severity

One of `critical`, `major`, `minor`, `nitpick`, `info`. The default is unset.

- Unset: OpenQodex warns and never blocks. No command exits 1. The push gate never denies a push.
- Set: the verdict is `blocked` when a finding on a changed line is at or above this severity. `scan` and `review` exit 1. The push gate denies a push unless a finished review of the current change passed.

Findings outside the changed lines never count toward the verdict.

## review.paths.exclude

A list of globs. The default is an empty list. A matching file is left out of the change. The brief does not show it, and no finding in it is kept. Scanners do not receive it as a changed file. A scanner that reads a whole project, such as brakeman or golangci-lint, may still read it.

Globs match the path from the repository root, with forward slashes:

- `*` matches any characters except `/`.
- `**` matches any characters, `/` included.
- `?` matches one character except `/`.

There is no negation and no character class.

A `**/` prefix does not match a file at the repository root. `**/*.min.js` matches `web/app.min.js` but not `app.min.js`. To match both, list `**/*.min.js` and `*.min.js`.

## review.disabled_rules

A list of globs matched against a finding's citation, `<source>:<rule>`. A matching finding is dropped. The default is an empty list.

- `gitleaks:generic-api-key` drops one gitleaks rule.
- `semgrep:python.lang.*` drops a family of semgrep rules.
- `lens:react-*` drops agent findings that cite a review pattern whose name starts with `react-`.
- `custom:trivy:*` drops every finding of the custom scanner named `trivy`.

## review.default_base

A branch or ref, or `null`. The default is `null`.

With no `--base` and no `--uncommitted`, OpenQodex compares the change with the branch's upstream. When the branch has no upstream, it uses this value: the ref as written, else the branch of that name on `origin`. With `null`, it uses the remote's default branch. A value that names nothing in the repository stops the run and says so.

## review.include_fixtures

`true` or `false`. The default is `false`.

With `false`, scanner findings in test fixtures, mocks, stubs, fakes and snapshots are dropped. A path counts when one of its folders is `fixtures`, `__fixtures__`, `mocks`, `__mocks__`, `snapshots`, `__snapshots__`, `fakes`, `stubs` or `testdata`. It also counts when the file name holds `.fixture.`, `.mock.` or `.stub.` (or their plurals), or ends in `.snap`. Test files themselves are not dropped.

## scanners.disable

A list of built-in scanner names to switch off. The names are `semgrep`, `gitleaks`, `sqllint`, `osv-scanner`, `actionlint`, `hadolint`, `shellcheck`, `ruff`, `brakeman`, `rubocop`, `bandit`, `oxlint` and `golangci`. A disabled scanner is listed in the report as disabled.

## scanners.custom

A list of custom scanners. Each one needs two keys:

```yaml
scanners:
  custom:
    - source: https://github.com/aquasecurity/trivy
      run: trivy config --format sarif --output {report} {target}
```

A custom scanner never runs until you approve it with `openqodex trust`. `custom-scanners` explains the step.

### source

The GitHub link of the scanner's repository, `https://github.com/<owner>/<repo>`. Required.

### run

The command line. Required. OpenQodex splits it into words and starts the first word as the program. It never runs the line through a shell, so pipes, `&&` and `$VAR` have no effect.

Three placeholders are filled in:

- `{report}`: the file the scanner writes its report to.
- `{target}`: the files to scan. See `target`.
- `{repo}`: the repository root.

### name

The scanner's name in the report, as `custom:<name>`. The default is the repository name from `source`. Letters, digits, dot, dash and underscore only. Two entries cannot share a name.

### version

The release to use, such as `0.58.1`. The default is the latest release at the time you run `openqodex trust`.

### format

`sarif` or `json-map`. The default is `sarif`. `json-map` reads any JSON report through a `map` block.

### map

Required when `format` is `json-map`. Each value is a dotted path into the report, with `[n]` for a list index.

- `items`: the path to the list of results. `.` means the report itself is the list. Required.
- `file`: the file path in one result. Required.
- `line`: the start line. Required.
- `end_line`: the end line. Optional.
- `rule`: the rule id. Required.
- `severity`: the scanner's severity. Optional.
- `message`: the message. Required.
- `reference`: a link for the rule. Optional.
- `severity_map`: maps the scanner's severity words to `critical`, `high`, `medium`, `low` or `info`. A word not in the map reads as `medium`.

`custom-scanners` has a worked example.

### paths

A list of globs. The scanner runs only when a changed file matches one, and receives only matching files. The default is every changed file.

### target

`changed` or `repo`. The default is `changed`.

- `changed`: `{target}` is the changed files.
- `repo`: `{target}` is the repository root.

Either way, only findings on changed lines are kept.

### timeout_seconds

A whole number of seconds. The default is `120`.

### install

How OpenQodex gets the scanner. The default downloads the GitHub release asset that fits your machine. Use one of these forms instead:

- `install: path`: use the program already on your `PATH`. Nothing is downloaded.
- `install: { asset: <name> }`: the release asset to download, when OpenQodex cannot pick one.
- `install: { binary: <path> }`: the program's path inside the asset, when it is not at the top.
- `install: { sha256: <hex> }`: the expected sha256 of the asset, in lowercase hex.
- `install: { npm: <package@version> }`: install the scanner from npm.
- `install: { uv: <package==version> }`: install the scanner from PyPI through uv.

`asset`, `binary` and `sha256` combine. `npm` and `uv` stand alone.

## graph

The code graph lists the callers and importers of the code a change touches, for the brief.

- `graph.enabled`: `true` or `false`. The default is `true`.
- `graph.budget_ms`: the time the graph may take, in milliseconds. The default is `10000`.
- `graph.max_files`: the most files the graph reads. The default is `4000`.
- `graph.max_file_bytes`: a file larger than this, in bytes, is left out of the graph. The default is `524288`.

## The user config, ~/.openqodex/config.yaml

One file in your home folder holds what is yours, not the team's. It has one key today, and `OPENQODEX_HOME` moves it with the rest of `~/.openqodex/`.

- `update`: `on` or `off`. The default is `on`. `off` stops the daily version check. `openqodex update --off` and `--on` write it.

A file that does not parse, or an `update` value that is neither `on` nor `off`, turns updates off until it is fixed. `openqodex doctor` says why updates are off.

