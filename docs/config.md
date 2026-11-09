# Configuration

OpenQodex reads `.openqodex/config.yaml` in the repository. Every key is optional. With no file, the defaults apply, and OpenQodex warns but never blocks.

- `.openqodex.yaml` at the root, the 0.1.0 location, is still read when `.openqodex/config.yaml` does not exist. With both, OpenQodex reads `.openqodex/config.yaml` only and warns.
- `--config <path>` reads another file instead of either.

An unknown key prints a warning and is ignored. A name in `scanners.disable` that this version does not know is ignored too, with a warning that names the scanner it is near, since a newer version may know it. Any other value of the wrong type or outside its list, an unknown `block_on_severity` included, stops the run with exit 2 and names the key.

`init`, and the first review in a repository, write `.openqodex/config.yaml` with `version: 1` set and every other key as a comment that shows its default. The default lives in OpenQodex, so a release that changes one reaches every repository that never set the key. To set a key, remove the `# ` at the start of its line and of the lines of the blocks above it. A file `init` wrote up to 0.8.1 holds every default as a set value. OpenQodex never rewrites it, and when a later release changes a default it still holds, it says so in a warning.

## Every key

<!-- config-keys:start -->
| Key | Default | What it does |
| --- | --- | --- |
| `version` | `1` | The file format version. 1 is the only one. |
| `min_version` | `null` | The oldest openqodex that may read this file, such as 0.9.0; an older one stops with exit 2 and names the version it needs. |
| `review.severity_threshold` | `minor` | Findings below this severity stay out of the report; one at or above block_on_severity is always shown. |
| `review.block_on_severity` | `null` | Exit 1 and deny the push when a finding on a changed line is at or above this severity; null never blocks. |
| `review.paths.exclude` | `[]` | Globs of files left out of the change. |
| `review.disabled_rules` | `[]` | Globs on a finding's citation, such as gitleaks:generic-api-key or lens:react-*. |
| `review.default_base` | `null` | The branch or ref to diff against when the branch has no upstream; null uses the remote's default branch. |
| `review.include_fixtures` | `false` | Keep scanner findings in test fixtures, mocks and snapshots. |
| `review.instructions_files` | `[]` | Repo-relative convention paths or globs the owners chose for the reviewer. Empty reads none. |
| `review.stages` | `true` | The staged review when openqodex starts its own reviewer: two finder sessions per changed file, then a fresh verifier per batch of candidates. false runs one pass. --agent and --all always run one pass. |
| `scanners.disable` | `[]` | Built-in scanners to switch off, by name. |
| `scanners.custom` | `[]` | Open source scanners to add by GitHub link; each runs only after openqodex trust. |
| `graph.enabled` | `true` | Show the callers and importers of the changed code in the brief. |
| `graph.budget_ms` | `10000` | Time the code graph may take, in milliseconds. |
| `graph.max_files` | `4000` | New parses per build: files past this count wait for a later build. Facts already cached are not counted. |
| `graph.max_file_bytes` | `524288` | Files larger than this, in bytes, are left out of the code graph. |
| `graph.max_cache_mb` | `512` | The size bound of .openqodex/graph/, in MB; the oldest builds and facts no kept build names are removed first. |
| `graph.max_heap_mb` | `1536` | The memory the code graph may use, in MB; files past it are left out and the graph says so. |
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
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
graph:
  enabled: true
```

## Convention files

`review.instructions_files` defaults to `[]`. Only the files the owners list are supplied to the reviewer. There is no automatic discovery during a review.

```yaml
review:
  instructions_files: ["CONTRIBUTING.md", "docs/style.md"]
```

Paths are relative to the repository. Globs use `*`, `**` and `?`. They match tracked regular files in lexical order within each entry. Untracked and ignored files need an explicit path. A source list over 4 MB or 50,000 paths is refused as a whole and noted. Files follow the configured order, with duplicates supplied once. A file is at most 32 KB, and the chosen files together are at most 64 KB. A missing path, link, folder, path outside the repository or file past either cap is skipped whole. The receipt and report notes name every omission. A glob with no match is silent.

`init` lists known candidates with their sizes and asks which files the reviewer may use. With no interactive terminal, including `--yes`, it selects nothing and prints the key to set. A review with an empty list prints one hint when candidates exist. Files containing only shipped OpenQodex sections or an unchanged shipped rule file do not count as candidates. Re-running init keeps existing entries in place, drops deselected candidates and appends new choices. It keeps comments and anchors on retained entries. It writes into `pr_review` when that is the existing block. An agent must ask the developer before adding paths.

The brief quotes the chosen files after `.openqodex/custom-instructions.md`. Only conventions that apply to the changed code count. Stated scopes and exceptions apply. Custom instructions win on conflict; a later file never silently overrides an earlier one.

Exact shipped OpenQodex team and instruction sections, current and previous, are removed from the quoted copy, with a note. An unchanged shipped Cursor or Cline rule file is omitted whole, with a note when chosen. Edited files and edited text between those markers stay. A changed launcher command also makes a shipped rule file an owner-edited file. The manifest binds to each supplied file's original bytes and source. Finalize checks only that selection, so changing a skipped file does not invalidate the review.

Local reviews read the developer's own work tree. The Action reads from the commit used for config. The library reads from the merge base inside the review's scopes. Code exclusions do not exclude chosen settings files. Conventions added to the base branch after divergence are not seen by the library. Supplied files and omissions appear in report notes, including the HTML and Markdown reports.

## Keys from the hosted review

The keys mirror the `.qodex.yaml` file of the hosted Qodex review where the meaning is the same, so one file can serve both.

- `pr_review` is read as `review`, with a warning. A file with both is refused.
- These keys are used by the hosted review only. Each prints a warning naming it and is ignored: `review.enabled`, `review.block_pr_merge`, `review.allow_approve`, `review.authors`, `review.base_branches`, `review.style_placement_threshold` and the whole `probes` block. `review.base_branches` there picks which pull requests are reviewed; `review.default_base` is the local key for the branch a change is compared with.

## Changes between versions

Each rename, removal and default change of a key, and the move of the file, is one row below. OpenQodex reads an old name or place with a warning. `openqodex config migrate` prints the rewrite these rows ask for and writes nothing; `openqodex config migrate --write` writes it and keeps every comment. Nothing rewrites the file unasked, and a rewrite that would change what the config does is refused.

<!-- config-changes:start -->
| Change | Since | What happens |
| --- | --- | --- |
| `.openqodex.yaml` moved to `.openqodex/config.yaml` | 0.2.0 | The old file is still read while the new one is absent. `config migrate` moves it. |
| `pr_review` renamed to `review` | 0.1.0 | It is the hosted name of the review block. Read as `review`, with a warning; a file with both is refused. `config migrate` renames it. |
| `review.enabled` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `review.block_pr_merge` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `review.allow_approve` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `review.authors` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `review.base_branches` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `review.style_placement_threshold` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `probes` of the hosted review | | Ignored, with a warning. `config migrate` keeps it, so one file can serve both. |
| `review.severity_threshold` default `info` to `minor` | 0.2.0 | A file an earlier `init` wrote with every default set that still holds `info` gets a warning. A file at the old place that leaves it unset gets one too. |
<!-- config-changes:end -->

## Severity

OpenQodex uses one scale: `critical`, `major`, `minor`, `nitpick`, `info`. Scanner severities map onto it:

- critical to `critical`
- high to `major`
- medium to `minor`
- low to `nitpick`
- info to `info`

## version

`1`, the only version. Optional.

## min_version

A version such as `0.9.0`. Optional. An older OpenQodex stops with exit 2 and one line that names the version this repository needs and says to run `openqodex update`. Set it when the config uses something only a newer version reads. Versions 0.8.1 and earlier do not know the key: they warn that it is unknown and go on.

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

A big JSON file needs no exclusion. In the default staged review, a successful JSON parse allows structural summary coverage once the changed range exceeds the part budget. Smaller JSON changes are shown as rows. Use exclusions only when you want a file left out of the review.

A renamed file has two paths, and each is matched on its own. A file renamed out of an excluded path is reviewed as a new file, with none of the excluded file's removed lines. A file renamed into an excluded path is reviewed as a deleted file.

Globs match the path from the repository root, with forward slashes:

- `*` matches any characters except `/`.
- `**` matches any characters, `/` included.
- `?` matches one character except `/`.

There is no negation and no character class.

A glob may be at most 1,024 characters, here, in `review.disabled_rules` and in a custom scanner's `paths`. A longer one could not be matched in bounded time, so OpenQodex refuses the file and names the key; it never treats such a glob as matching nothing.

A `**/` prefix does not match a file at the repository root. `**/*.min.js` matches `web/app.min.js` but not `app.min.js`. To match both, list `**/*.min.js` and `*.min.js`.

## review.disabled_rules

A list of globs matched against a finding's citation, `<source>:<rule>`. A matching finding is dropped. The default is an empty list.

- `gitleaks:generic-api-key` drops one gitleaks rule.
- `semgrep:python.lang.*` drops a family of semgrep rules.
- `lens:react-*` drops agent findings that cite a review pattern whose name starts with `react-`.
- `custom:bearer:*` drops every finding of the custom scanner named `bearer`.

## review.default_base

A branch or ref, or `null`. The default is `null`.

With no `--base` and no `--uncommitted`, OpenQodex compares the change with the branch's upstream. When the branch has no upstream, it uses this value: the ref as written, else the branch of that name on `origin`. With `null`, it uses the remote's default branch. A value that names nothing in the repository stops the run and says so.

## review.include_fixtures

`true` or `false`. The default is `false`.

With `false`, scanner findings in test fixtures, mocks, stubs, fakes and snapshots are dropped. A path counts when one of its folders is `fixtures`, `__fixtures__`, `mocks`, `__mocks__`, `snapshots`, `__snapshots__`, `fakes`, `stubs` or `testdata`. It also counts when the file name holds `.fixture.`, `.mock.` or `.stub.` (or their plurals), or ends in `.snap`. Test files themselves are not dropped.

## scanners.disable

A list of built-in scanner names to switch off. The names are `semgrep`, `gitleaks`, `sqllint`, `osv-scanner`, `actionlint`, `hadolint`, `shellcheck`, `ruff`, `brakeman`, `rubocop`, `bandit`, `oxlint` and `golangci`. A disabled scanner is listed in the report as disabled. A name this version does not know is ignored, with a warning that names the scanner it is near, or every name when none is near.

## scanners.custom

A list of custom scanners. Each one needs two keys:

```yaml
scanners:
  custom:
    - source: https://github.com/Bearer/bearer
      run: bearer scan {target} --format sarif --output {report} --quiet --disable-version-check
      target: repo
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

The code graph lists the callers and importers of the code a change touches, for the brief, with what it could not see. `graph` explains it.

The brief lists a function, class or type the change deletes as removed, with each call site that still reaches it. When exactly one file of the change now defines it with the same name and kind, or exactly one definition gained the same body under another name, and no call site still reaches the old place, it is listed as moved to that file and does not raise the risk. A public name the change stops exporting, or binds to another definition, is listed with the places that used it.

- `graph.enabled`: `true` or `false`. The default is `true`.
- `graph.budget_ms`: the time the graph may take, in milliseconds, checked between files in every stage. The default is `10000`. A build past it is partial and says what it left out.
- `graph.max_files`: the most files one build parses. Files whose facts are already in `.openqodex/graph/` do not count, so a large repository completes over a few reviews, or in one `openqodex graph build`. The default is `4000`.
- `graph.max_file_bytes`: a file larger than this, in bytes, is left out of the graph. The default is `524288`.
- `graph.max_cache_mb`: the size bound of `.openqodex/graph/`, in MB. The oldest builds and facts no kept build names are removed first; builds in use are never removed. The default is `512`.
- `graph.max_heap_mb`: the memory the graph may take, in MB. Past it no more files are read, and the graph says how many it left out. The default is `1536`: a whole build of a 14,000-file repository from cached facts needs about 1 GB.

## The user config, ~/.openqodex/config.yaml

One file in your home folder holds what is yours, not the team's. `OPENQODEX_HOME` moves it with the rest of `~/.openqodex/`.

- `update`: `on` or `off`. The default is `on`. `off` stops the daily version check. `openqodex update --off` and `--on` write it.
- `reviewer`: `auto`, `claude`, `codex` or `cursor`. The default is `auto`. The agent `review` starts as its reviewer; `--reviewer` on the command line wins. `claude` and `codex` are enabled; `cursor` makes `review` say why and exit 2. `auto` picks the agent running the command, then Claude Code, then Codex.
- `skip_version`: a version such as `0.9.2`. No default. `openqodex update --rollback` writes it: the update never installs that release or an older one, and stays on for the next. A value that is not such a version pauses automatic updates, naming the value, until it is fixed.
- `reviewer_web`: `on` or `off`. The default is `on`: the reviewer gets Claude Code's WebSearch and WebFetch, or Codex's cached web search. `off` removes them. A reviewer that reads private code and untrusted text and can open web addresses can be talked into sending the code out, so set `off` if you do not accept that (`security`). `--reviewer-web` on the command line wins for one run.

A key OpenQodex does not know is ignored and named, with the known key nearest to it (`updat` is named with `update`), by `review`, `doctor` and `update --status`. While it is there, automatic updates pause: it may be a misspelled `update: off`. A file that does not parse or is not a list of keys and values, or an `update` value that is neither `on` nor `off`, turns updates off until it is fixed. A file that does not parse or is not a list of keys and values, or a `reviewer` or `reviewer_web` value not listed above, stops `review` with one line naming the file. `openqodex doctor` prints each key with the value in force and where it comes from: the file, the default, or an environment variable that turns updates off.

