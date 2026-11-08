# Scanners

OpenQodex has twenty-two built-in scanners. Most scanners run when the change holds a file they read. Every supported lockfile in the repository is checked against osv.dev at every review and scan of a change. OpenQodex pins each downloaded scanner to one version. OpenQodex does not use a copy of a built-in scanner from your `PATH`.

## Terms

- A finding is one problem at one place in the code, with a severity.
- A candidate is a scanner finding on a changed line. In a review, the reviewer must raise it or drop it with a reason. The reviewer is the separate Claude Code or Codex process that reviews the change.
- The configuration is `.openqodex/config.yaml`. A settings file is a scanner's own file, such as `.ruff.toml`.

Scanners and the review use two severity scales. A scanner reports critical, high, medium, low or info. The review uses critical, major, minor, nitpick or info. OpenQodex maps each scanner severity to one review severity:

| Scanner severity | Review severity |
|---|---|
| critical | critical |
| high | major |
| medium | minor |
| low | nitpick |
| info | info |

On this page, high, medium and low are scanner severities. Major, minor and nitpick are review severities.

Scanner reasons replace the review checkout root with `<checkout>` before they are saved or printed.

## What a run reads and keeps

Pinned versions do not make findings identical on every machine. At run time, semgrep fetches its registry rule packs. OpenQodex does not pin the version of these packs.

A selected scanner reads the whole changed file, except where its section below names a size or parse limit. Some scanners also read the project or folder around the file:

| Scanner | Also reads |
|---|---|
| brakeman | the Rails app |
| golangci-lint | the Go packages |
| cargo-deny | the Rust project |
| trivy, Checkov and TFLint | the folder of each changed Terraform file |

OpenQodex keeps scanner findings on changed lines as candidates. Dependency advisories from osv-scanner outside those lines appear under "Outside the changed lines": shown for information, never counted toward the verdict, and never in the reviewer's brief. Each osv-scanner advisory names its fixed versions or says "No fixed version published". The fixture and disabled-rule filters also apply to these advisories. The severity threshold does not hide them. SARIF includes only findings and unreviewed candidates, so it carries no outside advisories.

OpenQodex keeps the scanner findings on changed lines. Then it drops findings in fixture files, unless `review.include_fixtures` is on. It also drops findings of the rules that `review.disabled_rules` names. Then it merges findings that name the same problem on the same lines. "What scan.json records" below lists these steps.

## All built-in scanners

<!-- scanner-table:start -->
| What it checks | Scanner | Version | Runs for | Needs |
|---|---|---|---|---|
| Secrets in code | gitleaks | 8.21.2 | any file | nothing |
| Security problems in code | semgrep | 1.94.0 | any file | Python 3.11, downloaded through uv; the Semgrep registry |
| Security problems in code | bandit | 1.9.4 | a `.py` or `.pyi` file | the same Python as semgrep |
| Security problems in code | brakeman | 6.2.1 | a Ruby or Rails file in a Rails app | Ruby 3.0 or newer |
| Dependencies with known vulnerabilities | osv-scanner | 2.6.0 | every supported lockfile in the repository at every review and scan of a change | osv.dev |
| Dependencies with known vulnerabilities | cargo-deny | 0.20.2 | `Cargo.lock` | Cargo; github.com for the RustSec database |
| Lint | ruff | 0.8.4 | a `.py` or `.pyi` file | nothing |
| Lint | oxlint | 1.86.0 | a JavaScript or TypeScript file | nothing |
| Lint | rubocop | 1.69.2 | a `.rb`, `.rake` or `.gemspec` file, or a `Rakefile` | Ruby 2.7 or newer |
| Lint | golangci-lint | 2.14.0 | a `.go` file | Go |
| Lint | shellcheck | 0.10.0 | a shell script | `xz` to unpack |
| GitHub Actions workflows | actionlint | 1.7.7 | a workflow under `.github/workflows/` | nothing |
| GitHub Actions workflows | zizmor | 1.30.1 | a workflow, an `action.yml` or `.github/dependabot.yml` | nothing |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | hadolint | 2.15.1 | a Dockerfile | nothing |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | trivy | 0.75.0 | Terraform, a Kubernetes manifest or a CloudFormation template | nothing |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | Checkov | 3.3.22 | the same files as trivy | the same Python as semgrep |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | TFLint | 0.64.0 | a `.tf` or `.tf.json` file | nothing |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | kube-linter | 0.8.3 | a Kubernetes manifest | nothing |
| Dockerfiles, Terraform, Kubernetes and CloudFormation | kubeconform | 0.8.0 | a Kubernetes manifest | raw.githubusercontent.com for schemas |
| SQL and database migrations | sqllint | built in | a `.sql` file | nothing; it runs inside OpenQodex |
| SQL and database migrations | squawk | 2.66.0 | a `.sql` file | nothing |
| SQL and database migrations | SQLFluff | 4.3.0 | a `.sql` file | the same Python as semgrep |
<!-- scanner-table:end -->

`scripts/docs-facts.mjs` checks this table against `packages/scanners/toolchain.json` and the adapter list. It also checks the README's category counts against this table.

## What the checks cover

Several scanners run only part of their checks, as OpenQodex runs them. These are the limits that matter most:

- semgrep runs three registry rule packs: `p/default`, `p/security-audit` and `p/secrets`. The registry can change them between runs.
- trivy runs `trivy config` only, its misconfiguration checks for Terraform, CloudFormation and Kubernetes. It does not run trivy's vulnerability, secret, licence or image scanning.
- Checkov runs its Terraform, CloudFormation and Kubernetes checks only. It does not run Helm, Kustomize, secret, dependency or image checks. Each Checkov finding has the scanner severity medium.
- brakeman runs only for a Rails app. Its licence is not open source.
- osv-scanner checks every lockfile that its section lists in the repository, against osv.dev at every review and scan of a change. `scanners.disable: [osv-scanner]` turns this check off. `--offline` skips it. It does not read `package.json` or `go.sum`.
- cargo-deny checks RustSec advisories and crate sources. It does not check licences.
- golangci-lint runs its default analyzers plus gosec, the Go security checks.
- SQLFluff runs eight rules about wrong results and dead code. OpenQodex switches its layout and style rules off.
- oxlint, rubocop, brakeman, golangci-lint, Checkov, TFLint and kube-linter use OpenQodex's own settings. "Changed scanner settings" below lists the settings files that other scanners read from the repository.
- The sections below give each scanner's exact files, settings and network use.

## Which scanners run, and why

One selector decides which scanners a set of files calls for. A review, a scan, `init`, `doctor --install` and the GitHub Action all use it the same way. A review and a scan ask it about the change and, for osv-scanner only, the repository inventory. `init`, `doctor --install` and the Action ask it about every file of the repository. These are the tracked files and the untracked files that git does not ignore. With the answer, they download ahead the scanners that later reviews will need.

The selector checks these things, in this order:

1. The configuration. A scanner that `scanners.disable` names does not run and does not download. A path that `review.paths.exclude` names calls for no scanner.
2. The file's name: its extension or basename, as each scanner's section lists.
3. The file's project. This is the nearest folder that holds a manifest, from the file's own folder up to the repository root. The manifests are `package.json`, `Gemfile`, `Gemfile.lock`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts` and `composer.json`. OpenQodex reads that project's dependency names from those files as text. It does not run, load or evaluate them. It reads only regular files inside the repository, and it does not read a file through a link. It does not read a manifest over 1 MiB. A file in no project still gets every check that its name calls for. So does a file in a project whose manifests name no framework. Such a file only gets no framework rules.
4. The file's content, for two kinds of file. For a file with no extension, OpenQodex reads the first line. A `#!` line that names sh, bash, dash or ksh makes it a shell script. OpenQodex reads at most the first 256 bytes of such a file. For a `.yaml` or `.yml` file, OpenQodex reads the content. The file holds a Kubernetes object when one document has an `apiVersion:` line and a `kind:` line. Each of the two lines must start with that key and have a value. A file that holds `{{` does not count, because it is a Helm or Go template. OpenQodex reads at most the first 64 KiB of such a file.
5. A reason that the scanner must not run at all. `--offline` skips semgrep, osv-scanner, kubeconform and cargo-deny.

What a project's dependencies switch on:

| Project | Read from | What changes |
|---|---|---|
| React or React Native | `react`, `react-native` or `expo` in `package.json` | oxlint runs its react and jsx-a11y rules on the project's files |
| Next.js | `next` in `package.json` | oxlint also runs its nextjs rules |
| Django, FastAPI, Airflow | `django`, `fastapi` or `apache-airflow` in `pyproject.toml` (its dependency lists), a `requirements*.txt` or a `Pipfile` | ruff adds its `DJ`, `FAST` or `AIR` rules |
| Rails | `rails` or `railties` in the folder's `Gemfile` or `Gemfile.lock`, and `config/application.rb` or `bin/rails` in that folder | brakeman runs, in that folder; rubocop loads its Rails cops |

`init` prints one line for each scanner that it downloads, with the reason. Examples are `brakeman: Rails app in backend/` and `oxlint: JavaScript or TypeScript files, such as web/app/page.tsx; React, accessibility and Next.js rules in web/`. `init --dry-run` prints the same lines and downloads nothing. `doctor` prints them under "This repository needs". The Action prints them in its plan step. A scan records the projects of the changed files and their frameworks in `scan.json`: those in the table, and Flask. Flask comes from `flask` in the same Python files as Django, and it switches nothing on. A framework missing from a project's list is not known to be unused: the list holds only what the files above name.

## Where scanners come from

OpenQodex downloads each scanner on first use into `~/.openqodex/tools/<scanner>/<version>/`. `OPENQODEX_HOME` moves that folder.

- OpenQodex checks each GitHub release asset against the sha256 pinned in the package. It does this before it unpacks the asset.
- semgrep, bandit, SQLFluff and Checkov install from PyPI through uv. Each one gets a Python 3.11 environment of its own. All four use one Python that OpenQodex manages. OpenQodex uses the uv on your `PATH` when there is one. Otherwise it downloads a pinned uv.
- brakeman and rubocop install from RubyGems with your Ruby's `gem` command.
- Each PyPI and RubyGems scanner installs from a lock file in the package: `locks/<scanner>-<platform>.txt`. The lock file pins each package of the scanner's dependency tree to one version and one sha256. Each file must match its sha256 before it installs. The PyPI scanners get exactly the packages of their lock. Each package comes from its wheel, so no build script runs. For brakeman and rubocop, RubyGems installs from the checked files. RubyGems keeps a gem that Ruby itself ships when that gem meets the requirement. In this install, RubyGems does not fetch from the network. The install folder is `<version>-<the lock's sha256>`. So when the pins of a lock change, the scanner installs again into a new folder.

A scanner install that takes longer than 45 seconds keeps going in the background. The report lists that scanner as installing. The scanner joins the next run. `openqodex doctor --install` installs the scanners that the repository's files call for, and waits. With `--all-scanners`, it installs every scanner.

Once a month, a workflow in the OpenQodex repository looks for new scanner releases (`.github/workflows/pin-bump.yml`). It looks for a release that is at least seven days old and newer than the pin. For each such release, it opens a pull request. The pull request holds the new pin, and its sha256 or its new lock file. It also holds the result of the gate on that change. A person merges it. A TFLint bump needs one more step. A person checks the bundled terraform ruleset for a new recommended rule whose message prints an evaluated value. OpenQodex switches such a rule off, as it does `terraform_map_duplicate_keys`.

For kubeconform, the workflow moves the binary only. `toolchain.json` pins the kubeconform schemas apart, under `kubeconform.schemas`. That pin is one commit of `yannh/kubernetes-json-schema` and one Kubernetes version. Refresh the schemas by hand when a new Kubernetes minor version is out:

1. Pick a commit of that repository that holds the version's `-standalone-strict` folder.
2. Set `commit` and `kubernetes` together.
3. Run the kubeconform real-binary checks (`packages/scanners/test/adapters-kube-rust.subprocess.test.ts`).

OpenQodex keeps the schema cache per commit, so a new commit downloads the schemas again.

OpenQodex does not install Ruby or Go. Without them, the report lists the scanners that need them as not installed, with the reason.

## Download and disk sizes

A download size is the size of the release asset, as GitHub reported it on 2026-10-12. The command was `gh api repos/<owner>/<repo>/releases/tags/<tag>`. An installed size is the output of `du -sk ~/.openqodex/tools/<scanner>` on an Apple Silicon Mac on 2026-10-12, divided by 1,024. Download sizes are in MB of 1,000,000 bytes. Installed sizes are in MiB of 1,048,576 bytes. The file size limits elsewhere on this page are in KiB and MiB, of 1,024 and 1,048,576 bytes.

| Scanner | Version | Download, macOS arm64 | Download, Linux x64 | Installed, macOS arm64 |
|---|---|---|---|---|
| gitleaks | 8.21.2 | 2.9 MB | 3.0 MB | 7 MiB |
| osv-scanner | 2.6.0 | 55.1 MB | 57.5 MB | 53 MiB |
| actionlint | 1.7.7 | 2.0 MB | 2.1 MB | 5 MiB |
| hadolint | 2.15.1 | 102.6 MB | 55.7 MB | 98 MiB |
| shellcheck | 0.10.0 | 7.2 MB | 2.4 MB | 58 MiB |
| ruff | 0.8.4 | 9.9 MB | 11.2 MB | 27 MiB |
| golangci-lint | 2.14.0 | 14.8 MB | 15.5 MB | not installed on that Mac (needs Go) |
| oxlint | 1.86.0 | 5.5 MB | 6.4 MB | 12 MiB |
| zizmor | 1.30.1 | 8.4 MB | 9.2 MB | 22 MiB |
| squawk | 2.66.0 | 16.9 MB | 25.7 MB | 16 MiB |
| trivy | 0.75.0 | 49.0 MB | 51.7 MB | 158 MiB |
| TFLint | 0.64.0 | 16.3 MB | 17.1 MB | 50 MiB |
| kube-linter | 0.8.3 | 15.3 MB | 16.5 MB | 46 MiB |
| kubeconform | 0.8.0 | 7.3 MB | 7.5 MB | 13 MiB |
| cargo-deny | 0.20.2 | 4.5 MB | 4.9 MB | not installed on that Mac (needs Cargo) |
| semgrep | 1.94.0 | from PyPI through uv | from PyPI through uv | 184 MiB, plus the shared Python |
| bandit | 1.9.4 | from PyPI through uv | from PyPI through uv | 10 MiB, plus the shared Python |
| SQLFluff | 4.3.0 | from PyPI through uv | from PyPI through uv | 23 MiB, plus the shared Python |
| Checkov | 3.3.22 | from PyPI through uv | from PyPI through uv | 172 MiB, plus the shared Python |
| brakeman | 6.2.1 | from RubyGems | from RubyGems | not installed on that Mac (needs Ruby) |
| rubocop | 1.69.2 | from RubyGems | from RubyGems | not installed on that Mac (needs Ruby) |
| sqllint | built in | no download | no download | none; it runs inside OpenQodex |

The scanners from PyPI and RubyGems have no single release asset, so the table gives no download size for them. The four PyPI scanners share one Python 3.11 that uv manages, in `~/.openqodex/tools/uv-python`. It took 76 MiB on that Mac. uv keeps its download cache in `~/.openqodex/cache/uv`. That cache took 350 MiB on that Mac.

The demo downloads 16 of these scanners: each one with an installed size in the table, except oxlint. With the shared Python, they took 1,018 MiB on that Mac. That sum leaves out uv's download cache.

## Status in the report

The report lists each selected scanner with one status. It does not list a scanner that `--only` or `--skip` left out.

- `ran`: it ran.
- `no_matching_files`: the change holds no file that it reads.
- `installing`: it is downloading for the first time. It joins the next run.
- `not_installed`: OpenQodex could not install it here. The reason says why.
- `failed`: it ran and broke. The reason holds its error.
- `disabled`: `scanners.disable` names it, or `--offline` skipped it.
- `untrusted`: it is a custom scanner that you have not approved.

A scanner that fails or is missing does not change the exit code. The report lists it with the reason. [Exit codes](cli.md#exit-codes) gives each exit code.

## What scan.json records

Each scan and each review writes `scan.json` next to its report. Besides the candidates, it records how the selector chose each scanner for the change. It also records what became of each finding that a scanner raised. So a finding that a filter dropped, or that a merge folded away, still counts for its scanner. OpenQodex does not print these records.

- `outside`: one entry per dependency advisory outside the changed lines, with ids `o1`, `o2` and so on. These stay separate from `candidates`.
- `selection`: one entry for each built-in scanner, then one for each custom scanner, as the selector chose them. `--only` and `--skip` do not change it. Each entry has these fields:
  - `scanner`: the scanner.
  - `wanted`: whether it runs for this change.
  - `paths`: the files that call for it, including inventory lockfiles for osv-scanner. For a custom scanner, these are the changed files that its `paths` globs match.
  - `projects`: the project folders that decide how it runs.
  - `skip`: why it does not run.
- `trail`: one entry for each finding that a scanner raised. It also holds one entry for each settings or suppression candidate that OpenQodex raised about the change. Each entry has `token` (`<scanner>:<rule>`), `file`, `lineStart`, `lineEnd`, the scanner's `severity` and `stage`. `stage` is the step that dropped or kept the finding:
  - `outside-change`: its file is not in the change.
  - `changed-lines`: its file is in the change, but no line of its span changed.
  - `fixture`: its file is a fixture, mock or snapshot, and `review.include_fixtures` is off.
  - `disabled-rule`: `review.disabled_rules` names it.
  - `merged`: it names the same problem on the same lines as a finding that OpenQodex kept. `into` holds that candidate's id.
  - `shown`: it is a dependency advisory shown outside the changed lines. `id` holds its outside id.
  - `kept`: it became a candidate. `id` holds that candidate's id.

  An entry does not hold the finding's message, because a message can quote a secret. The entries come in stage order: kept, shown, merged, disabled-rule, fixture, changed-lines, then outside-change. Within a stage, they come in order of scanner, file, lines and rule. The trail holds at most 5,000 entries. `trailOmitted` counts the rest.
- Each scanner's entry under `scanners`, in `scan.json` and `report.json`, also has these fields:
  - `stages`: how many of its trail entries each step dropped. `changedLines` counts the outside-change and changed-lines entries. `fixtures`, `rules` and `merged` count the other three steps. `shown` counts advisories shown for information, separate from dropped results.
  - `resolveMs`: the time spent to find, check or install its tool before it ran.
  - `files`: the number of files that OpenQodex handed it, including inventory lockfiles.

A scanner's `rawCount` is the number of its trail entries, less OpenQodex's own settings and suppression candidates. The number of all its trail entries is its `keptCount` plus the counts in its `stages`.

## Changed scanner settings

Several scanners read settings or an ignore list from the repository, as OpenQodex runs them. A change to one of these files can hide that scanner's findings.

| Scanner | Files | Where it reads them |
|---|---|---|
| gitleaks | `.gitleaks.toml`, `gitleaks.toml`, `.gitleaksignore` | the repository root only |
| semgrep | `.semgrepignore` | the repository root only |
| hadolint | `.hadolint.yaml`, `.hadolint.yml` | the repository root only |
| actionlint | `.github/actionlint.yaml`, `.github/actionlint.yml` | the repository root only |
| zizmor | `.github/zizmor.yml`, `.github/zizmor.yaml`, `zizmor.yml`, `zizmor.yaml` | the repository root only |
| squawk | `.squawk.toml` | the repository root only |
| trivy | `.trivyignore` | the repository root only |
| ruff | `ruff.toml`, `.ruff.toml`; `pyproject.toml` when the change alters its `[tool.ruff]` table, or the `requires-python` beside that table, which ruff reads as its target version | any folder |
| shellcheck | `.shellcheckrc`, `shellcheckrc` | any folder |
| osv-scanner | `osv-scanner.toml` | any folder |
| SQLFluff | `.sqlfluff`, `.sqlfluffignore`; `setup.cfg`, `tox.ini` and `pep8.ini` when the change alters their `[sqlfluff]` and `[sqlfluff:...]` sections, with their `[DEFAULT]` keys; `pyproject.toml` when the change alters its `[tool.sqlfluff]` table | any folder |
| cargo-deny | `deny.exceptions.toml`, `.deny.exceptions.toml` | any folder |

`pyproject.toml`, `setup.cfg`, `tox.ini` and `pep8.ini` belong to other tools too. So OpenQodex compares only what the scanner reads from them, in the base and in the change. It compares by meaning. It reads `pyproject.toml` with a TOML parser. It reads the INI files by the rules of Python's configparser, as SQLFluff reads them. A version bump in `[project]` raises nothing. A rule switched off in any TOML form raises a candidate, even with a quoted or escaped key. A file that does not parse, or that OpenQodex cannot read, on either side counts as changed.

In a review, each such changed file is a major candidate of that scanner. Its rule is `settings-file`, and it sits on the file's first changed line. The reviewer verifies it, then raises it or drops it with a reason. In a scan, nobody can clear it, so it is a minor finding that counts toward the verdict. A scan is the `scan` command, which the pre-commit hook and the Action run. The scanner still reads the changed file. `scanners.disable` leaves the candidate out with its scanner. `--only` and `--skip` do not leave it out. They pick scanners for one run, and the file still silences the scanner in every other run. OpenQodex lists a changed settings file in a fixture folder too. A settings file outside that folder can extend it (ruff's `extend`). So it can hide findings in code that is not a fixture.

## Suppression comments

A comment in the code can tell a scanner to skip a line, such as `# nosec` for bandit. The scanner obeys it and reports nothing there. So each such comment on a line that the change adds becomes a candidate of the scanner that it silences. The candidate's rule is `openqodex.suppression-added`, and it sits on that line. OpenQodex raises it whether or not that scanner is installed. It raises it only in a file that the scanner checks. Its message names the comment and the scanner. The message does not quote the rest of the line, which can hold a secret.

In a review, the reviewer verifies it, then raises it or drops it with a reason. In a scan, it is a minor finding that counts toward the verdict. So `block_on_severity: minor` blocks on it. The scanner still obeys the comment. A comment that the change did not add raises nothing. `review --all` raises nothing either. `scanners.disable` leaves the candidate out with its scanner. `--only` and `--skip` do not leave it out. `review.disabled_rules: ["*:openqodex.suppression-added"]` turns it off. OpenQodex leaves out a comment in a fixture file, as it leaves out a scanner's finding there. `review.include_fixtures` brings it back. Such a comment only silences findings in its own file, and OpenQodex leaves those findings out too.

`review.severity_threshold` does not hide an added suppression comment or a changed settings file. This holds in a scan, and for such a finding that the reviewer raised. The scanner reports nothing there, so the report lists them at any threshold.

OpenQodex counts a comment where its scanner reads it, except in the known misses at the end of this section. For the scanners that read only comments, OpenQodex first finds the comments of the whole file. So the same text inside a string, a multi-line string or a heredoc does not count. OpenQodex reads the code inside an f-string field, a shell `$( )` or backticks as code, as the scanners do. That holds inside double quotes and an unquoted heredoc too. Both semgrep and gitleaks obey their marker anywhere on the line, also in a string. OpenQodex counts it there too.

A string, heredoc, template, raw string or block comment can be left open at the end of the file. OpenQodex reads such text as code, so a comment after it still counts. A Dockerfile heredoc opens only in `RUN`, `COPY` and `ADD`, as BuildKit reads it. A shell heredoc ends where shellcheck ends it. For example, `<<"E\"OF"` ends at a line `E\"OF`, with blanks allowed after the word. An HCL string ends at its line end, as TFLint reads a valid file. An HCL heredoc ends at the line that reads its word once blanks are trimmed. This holds for `<<` and `<<-` alike. In HCL, `$${` and `%%{` are text. A file over 1,000,000 bytes raises no semgrep candidate, since semgrep skips it.

| Scanner | Comment | Where it counts | Checked against |
|---|---|---|---|
| semgrep | `nosemgrep` or `nosem`, in any case | anywhere on the line | the 1.94.0 binary; [docs](https://docs.semgrep.dev/ignoring-files-folders-code) |
| gitleaks | `gitleaks:allow` | anywhere on the line | the 8.21.2 binary; [detect.go](https://github.com/gitleaks/gitleaks/blob/v8.21.2/detect/detect.go) |
| bandit | `# nosec`, with or without the space | anywhere in a Python comment | the 1.9.4 binary; [manager.py](https://github.com/PyCQA/bandit/blob/1.9.4/bandit/core/manager.py) |
| ruff | `# noqa` in any case; `# ruff: noqa` and `# flake8: noqa`; `isort: skip`, `isort: skip_file`, `# isort: off` | anywhere in a Python comment; `# ruff: noqa` and `# flake8: noqa` on a line of their own | the 0.8.4 binary; [noqa.rs](https://github.com/astral-sh/ruff/blob/0.8.4/crates/ruff_linter/src/noqa.rs), [directives.rs](https://github.com/astral-sh/ruff/blob/0.8.4/crates/ruff_linter/src/directives.rs) |
| shellcheck | `disable=` or `extended-analysis=false` anywhere after `# shellcheck` | a shell comment | the 0.10.0 binary; [Parser.hs](https://github.com/koalaman/shellcheck/blob/v0.10.0/src/ShellCheck/Parser.hs) |
| hadolint | `# hadolint ignore=`, `# hadolint global ignore=`, `# hadolint stage ignore=` | a Dockerfile comment line, also inside a continued instruction | the 2.15.1 binary; [Pragma.hs](https://github.com/hadolint/hadolint/blob/v2.15.1/src/Hadolint/Pragma.hs) |
| oxlint | `eslint-disable`, `oxlint-disable`, each also with `-line` or `-next-line` | the start of a `//` or `/* */` comment | the 1.86.0 binary; [disable_directives.rs](https://github.com/oxc-project/oxc/blob/oxlint_v1.86.0/crates/oxc_linter/src/disable_directives.rs) |
| golangci-lint | `//nolint`; a comment that says `code generated`, `do not edit` or `autogenerated file` in any case; gosec's `#nosec` and `//gosec:disable` | a `//` comment for `//nolint`; a comment before the `package` line for the generated-file words, which skip the whole file; the start of a comment line for `#nosec` | source only: [nolint_filter.go](https://github.com/golangci/golangci-lint/blob/v2.14.0/pkg/result/processors/nolint_filter.go), [exclusion_generated_file_matcher.go](https://github.com/golangci/golangci-lint/blob/v2.14.0/pkg/result/processors/exclusion_generated_file_matcher.go), [gosec analyzer.go](https://github.com/securego/gosec/blob/v2.29.0/analyzer.go) |
| rubocop | `# rubocop:disable` and `# rubocop:todo` with a cop name or `all` | a Ruby comment, `=begin` blocks included | source only: [directive_comment.rb](https://github.com/rubocop/rubocop/blob/v1.69.2/lib/rubocop/directive_comment.rb) |
| zizmor | `# zizmor: ignore[` and a rule list, with one blank after the `#` and after the colon | anywhere on the line: zizmor reads each line of a finding from its first `#`, so for some of its audits it obeys the comment inside a `run:` block or a quoted value too | the 1.30.1 binary; [location.rs](https://github.com/zizmorcore/zizmor/blob/v1.30.1/crates/zizmor/src/finding/location.rs) |
| squawk | `squawk-ignore` and `squawk-ignore-file`, with a rule list or without; `squawk-disable-assume-in-transaction` | the start of a `--` or `/* */` comment, after blanks; never in a string, a dollar-quoted body or a quoted identifier. Block comments nest, as Postgres reads them | the 2.66.0 binary; [ignore.rs](https://github.com/sbdchd/squawk/blob/v2.66.0/crates/squawk_linter/src/ignore.rs) |
| kube-linter | the annotation keys `ignore-check.kube-linter.io/<check>` and `kube-linter.io/ignore-all` | a key of a YAML or JSON mapping, in block or flow style, quoted or with escapes, and a key an alias or a merge key brings in (counted on the alias's line); never in a comment or a value. A file the YAML parser cannot read, or one over 4 MiB, is read line by line instead | the 0.8.3 binary; [ignore.go](https://github.com/stackrox/kube-linter/blob/v0.8.3/pkg/ignore/ignore.go) |
| SQLFluff | `noqa`, `noqa:` with rules, `noqa: disable=` and `noqa: enable=` | anywhere on the line after `--`, `#` or `/*`, and at the start of a line: SQLFluff reads it at the start of a comment or after the comment's last `--`, and which text is a comment depends on the dialect | the 4.3.0 binary; [noqa.py](https://github.com/sqlfluff/sqlfluff/blob/4.3.0/src/sqlfluff/core/rules/noqa.py) |
| SQLFluff | an inline setting, `-- sqlfluff:<key>:<value>` or `--sqlfluff:<key>:<value>`, such as `ignore:linting`, `exclude_rules`, `rules`, `warnings` or the dialect | at the very start of a line, as Python splits lines (a carriage return, a form feed and the Unicode line separators start one too), and after a byte order mark on the first line: it sets SQLFluff's settings for the whole file. Other spacing, upper case, `/* */` or text before it on the line, SQLFluff ignores | the 4.3.0 binary; [fluffconfig.py](https://github.com/sqlfluff/sqlfluff/blob/4.3.0/src/sqlfluff/core/config/fluffconfig.py) |
| trivy | `trivy:ignore:` or `tfsec:ignore:` with a check id, also after other sections such as `exp:` | anywhere on the line, as a word that starts with them once its leading `#`, `/` and `*` are cut: trivy reads every line of a Terraform file and of a CloudFormation YAML template as text, so it obeys one inside a string too. It obeys none in Kubernetes YAML or CloudFormation JSON, where OpenQodex still counts one | the 0.75.0 binary; [parse.go](https://github.com/aquasecurity/trivy/blob/v0.75.0/pkg/iac/ignore/parse.go) |
| Checkov | `checkov:skip=`, `bridgecrew:skip=` or `cortex:skip=` with a check id; the Kubernetes annotation keys `checkov.io/skip<n>`, `bridgecrew.io/skip<n>` and `cortex.io/skip<n>`; a CloudFormation resource's `Metadata` keys `checkov` and `bridgecrew` with a `skip` list | the skip comment anywhere on the line, a string included: Checkov reads a Terraform or CloudFormation resource's lines as text. The annotation and `Metadata` keys as keys of YAML or JSON, in block or flow style or through an alias; the `Metadata` key counts wherever a key is `checkov` or `bridgecrew` | the 3.3.22 binary; [enum.py](https://github.com/bridgecrewio/checkov/blob/3.3.22/checkov/common/comment/enum.py), [kubernetes_utils.py](https://github.com/bridgecrewio/checkov/blob/3.3.22/checkov/kubernetes/kubernetes_utils.py), [context_parser.py](https://github.com/bridgecrewio/checkov/blob/3.3.22/checkov/cloudformation/context_parser.py) |
| TFLint | `tflint-ignore: ` and `tflint-ignore-file: ` with a rule list or `all` | a `#`, `//` or `/* */` HCL comment, never a string or a heredoc body; in a `.tf.json` file, the start of a string. TFLint obeys the file form only at the very start of a file, and in JSON only as the root `"//"` key's value; OpenQodex counts it anywhere | the 0.64.0 binary; [annotation.go](https://github.com/terraform-linters/tflint/blob/v0.64.0/tflint/annotation.go) |

Where OpenQodex reads more than the scanner, it errs towards a candidate that the reviewer drops. These are the known cases:

| Scanner | Where OpenQodex counts more than the scanner |
|---|---|
| semgrep | its marker without the space before it, and in any comment form |
| ruff | `# isort: off` with extra blanks; a `# ruff: noqa` that ruff reads differently |
| shellcheck | a `disable=` inside a quoted value or a trailing note of a directive |
| hadolint | a comment whose rule list hadolint would reject |
| rubocop | a comment whose rule list rubocop would reject; the text of a Ruby `__END__` block, read as code |
| golangci-lint | a generated-file comment that golangci-lint reads differently |
| oxlint | the text of JSX, read as code |
| trivy | its marker in Kubernetes YAML and CloudFormation JSON, which trivy 0.75.0 does not read |
| Checkov | its skip comment in Kubernetes YAML; its `Metadata` key wherever a key is `checkov` or `bridgecrew`, and on any line of a file that is not YAML |
| TFLint | its file form anywhere in a comment |
| each scanner whose comments OpenQodex reads | everything after an opener left open |

hadolint 2.15.1 cannot parse a Dockerfile that has a heredoc. It then reports only a parse error, so its comments in such a file have no effect.

actionlint, brakeman, osv-scanner, sqllint, kubeconform and cargo-deny have no inline suppression comment. Five of them skip findings in other ways:

| Scanner | How it skips findings |
|---|---|
| actionlint | only through its settings file ([usage](https://github.com/rhysd/actionlint/blob/v1.7.7/docs/usage.md)) |
| osv-scanner | only through its settings file ([configuration](https://google.github.io/osv-scanner/configuration/)) |
| brakeman | only through its ignore file ([ignoring false positives](https://brakemanscanner.org/docs/ignoring_false_positives/)) |
| cargo-deny | only through its `deny.toml` ([configuration](https://embarkstudios.github.io/cargo-deny/checks/cfg.html)), which OpenQodex does not load |
| kubeconform | only what its command line names |

OpenQodex finds the comments with a small reader for each comment family, not with a full parser. Sometimes the reader cannot tell a regular expression from a division, as in Ruby `total /2` or JavaScript `} / 2`. Then it also reads a comment that starts in the skipped text.

These are the known misses, where OpenQodex reads less than the scanner:

- In shell, the reader ends a `$( )` early at a `case` pattern inside it.
- In Ruby, the reader takes `buf <<"x"` that appends a string as a heredoc.
- An unchanged comment that silences lines the change adds raises nothing. Examples are an `eslint-disable-next-line` above a new line and a file-level `# ruff: noqa`.
- OpenQodex does not read a file over 64 MiB for suppression comments.

## semgrep

- Version: 1.94.0.
- Runs when: any file changed.
- Needs: Python 3.11, which OpenQodex downloads through uv.
- Rules: the registry packs `p/default`, `p/security-audit` and `p/secrets`.
- Network: semgrep fetches those rule packs from the Semgrep registry on each run. OpenQodex runs it with its metrics switched off. The OpenQodex package does not bundle the rules.
- Records: in `report.json` and `scan.json`, semgrep's entry under `scanners` lists the packs that the scan used, in `rules`. Each pack is `{pack, sha256, bytes}`. `sha256` is the sha256 of the pack's rules in a normal form. Two scans that used different rules show different values. Two scans that used the same rules show the same value. `bytes` is the size of the exact bytes that semgrep read.
- Rule pack forms: the registry sends one rule set in more than one form. One response can list the same rules in another order than the next. Some of its caches send YAML instead of JSON. So `bytes` can differ for the same rules. Compare `sha256` instead.
- Source of the bytes: OpenQodex reads them from the files that semgrep leaves in its temporary folder, before it removes that folder. This needs no second download, and OpenQodex prints nothing more.
- Several runs: a change with many files can make semgrep run more than once. Then semgrep fetches the packs once per run. `rules` lists a pack whose rules changed between runs once per version.
- Missing record: OpenQodex leaves `rules` out when semgrep did not leave one file per pack. It also leaves `rules` out when a file is not a rule pack.
- Normal form: to recompute `sha256` yourself, follow these steps.
  1. Read the pack as JSON, or as YAML when it is not JSON. Read numbers as JavaScript numbers, so an integer above 2^53 loses precision.
  2. Keep only its `rules` list. Drop any other top-level key, such as the JSON form's `missed` count.
  3. Check that each rule is a mapping with a text `id`. Otherwise the file is not a rule pack.
  4. Write each rule as JSON with no spaces. Sort the keys of every object, at every depth, in plain character order. That order compares UTF-16 code units, as JavaScript compares text. Keep the order of lists inside a rule.
  5. Sort the rules by `id` in the same order. Sort two rules with one `id` by their written JSON text.
  6. Join them as `{"rules":[...]}`, and take the sha256 of that UTF-8 text.
- `--offline`: OpenQodex does not run it. The report lists it as disabled.

## gitleaks

- Version: 8.21.2.
- Runs when: any file changed.
- Needs: nothing.
- Writes: OpenQodex links the changed files into a temporary folder outside the repository. Then gitleaks scans that folder. It writes its raw report to a temporary file outside the repository. That file holds the matched secrets. OpenQodex deletes it when the run ends.
- Settings: gitleaks reads the repository's `.gitleaks.toml` or `gitleaks.toml` when one is there.
- Network: OpenQodex starts it with no network option. It needs none.
- Redaction: OpenQodex redacts the secrets that gitleaks finds. It redacts them in the review brief that the reviewer reads, in each report file and in the terminal. In this version, no file that OpenQodex keeps holds such a secret.

## bandit

- Version: 1.9.4.
- Runs when: a `.py` or `.pyi` file changed.
- Needs: the same Python as semgrep.
- Test files: OpenQodex skips bandit's assert check, `B101`, in test files. A test file is a file under a `test`, `tests`, `spec`, `specs`, `e2e`, `__tests__` or `__mocks__` folder. A file whose name starts with `test_`, or holds `_test.`, `_spec.`, `.test.` or `.spec.`, is a test file too. A test checks its results with assert, so there the check raises only noise.
- Second run: OpenQodex runs bandit a second time on the test files, with `-s B101`. So every other bandit check still reads them. `B101` still checks every other Python file, where `python -O` removes the assert.
- Network: OpenQodex starts it with no network option. It needs none.

## ruff

- Version: 0.8.4.
- Runs when: a `.py` or `.pyi` file changed.
- Needs: nothing.
- Settings: ruff reads the repository's own ruff settings. OpenQodex runs it with fixes and its cache switched off, so ruff writes no fix and no cache file.
- Frameworks: in a Django, FastAPI or Airflow project, OpenQodex adds ruff's `DJ`, `FAST` or `AIR` rules with `--extend-select`. These come on top of the repository's own selection. ruff applies a command-line selection after the repository's settings. So an `ignore` in those settings does not take these rules off again. A `# noqa`, `per-file-ignores` and `review.disabled_rules` (such as `ruff:DJ001`) do take them off.
- Network: OpenQodex starts it with no network option. It needs none.

## oxlint

- Version: 1.86.0.
- Runs when: a `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts` or `.cts` file changed.
- Needs: nothing.
- Settings: OpenQodex's own. OpenQodex does not load an oxlint settings file from the repository.
- Frameworks: in a React or React Native project, OpenQodex switches on oxlint's own react and jsx-a11y rules. In a Next.js project, it also switches on the nextjs rules. The oxlint binary holds these rules.
- Review patterns: if oxlint ran its react rules on every changed file, OpenQodex skips one review pattern. That pattern looks for an incomplete `useEffect` dependency list. oxlint checks the same thing (`react-hooks/exhaustive-deps`).
- Network: OpenQodex starts it with no network option. It needs none.

## osv-scanner

- Version: 2.6.0.
- Runs when: there is a change to review or scan and the repository holds a supported lockfile. At every review and scan of a change, osv-scanner checks every lockfile in the table below, less excluded paths and links. `package.json` and `go.sum` are not supported lockfiles. Changed lockfiles and the remaining lockfiles run in parallel, each with its own 90 second budget. A failure in the latter keeps completed chunks and the changed-lockfile findings, and reports partial coverage. Without changed lockfiles, a tree failure is reported as failed.
- Needs: network access to osv.dev.
- Network: osv-scanner sends the names and versions of the dependencies in those lockfiles to osv.dev. As OpenQodex runs it, osv-scanner sends no source code. OpenQodex switches its other lookups off:
  - `--no-resolve`: no transitive resolution of a `pom.xml` through deps.dev.
  - `--experimental-disable-plugins directory`: no file hashes of vendored C and C++ code.
  - `--no-call-analysis all`: no reachability analysis.
- Aliases: osv-scanner can group advisories as aliases of one another. OpenQodex reports such a group as one finding. The finding uses the group's RustSec id when it has one, and otherwise its first id.
- `--offline`: OpenQodex does not run it. The report lists it as disabled.

| Ecosystem | Supported lockfiles |
|---|---|
| JavaScript | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` |
| Python | `Pipfile.lock`, `poetry.lock`, `pdm.lock`, `uv.lock`, `pylock.toml`, a `.txt` file with `requirements` in its name |
| Ruby | `Gemfile.lock`, `gems.locked` |
| PHP | `composer.lock` |
| Rust | `Cargo.lock` |
| Go | `go.mod` |
| Maven and Gradle | `pom.xml`, `gradle.lockfile`, `buildscript-gradle.lockfile`, `gradle/verification-metadata.xml` |
| .NET | `packages.lock.json`, `packages.config`, `<name>.deps.json` |
| Dart | `pubspec.lock` |
| Elixir | `mix.lock` |
| C and C++ | `conan.lock` |
| R | `renv.lock` |
| Haskell | `cabal.project.freeze`, `stack.yaml.lock` |

## actionlint

- Version: 1.7.7.
- Runs when: a `.yml` or `.yaml` file under `.github/workflows/` changed.
- Needs: nothing.
- Network: OpenQodex starts it with no network option. It needs none.

## hadolint

- Version: 2.15.1.
- Runs when: a Dockerfile changed: `Dockerfile`, `Dockerfile.<name>` or `<name>.dockerfile`.
- Needs: nothing.
- Network: OpenQodex starts it with no network option. It needs none.

## shellcheck

- Version: 0.10.0.
- Runs when: a `.sh` or `.bash` file changed. It also runs for a file with no extension whose first line (`#!`) names sh, bash, dash or ksh. An example is `bin/deploy` that starts with `#!/usr/bin/env bash`.
- Needs: `xz` to unpack the download.
- Network: OpenQodex starts it with no network option. It needs none.

## golangci-lint

- Version: 2.14.0.
- Name: `golangci` in the configuration and in the report.
- Runs when: a `.go` file changed. It checks the packages that hold the changed files.
- Needs: Go on your `PATH`.
- Settings: OpenQodex's own, with gosec switched on. OpenQodex does not load a `.golangci.yml` from the repository. As OpenQodex runs it, golangci-lint does not rewrite `go.mod` or `go.sum`.
- Go version: golangci-lint 2.14.0 is built with Go 1.27. It checks code with Go 1.26 or 1.27 on your `PATH`. With a Go newer than 1.27, it cannot check the code. The report then lists `golangci` as failed, with the reason.
- Network: OpenQodex runs it with the Go module proxy off, so it downloads no module. The modules that the repository needs must already be in your Go module cache.
- Skipped: a module's dependencies can be listed in `go.sum` but missing from your Go module cache. The report then lists `golangci` as skipped for that module and names the fix, `go mod download`. The other packages of the change are still checked. When a changed `.go` file has no `go.mod` in its folder or above it, the report lists `golangci` as skipped for that folder. A skip is not a failure. A changed file that does not compile is still a failure, also next to a dependency that is not downloaded.

## brakeman

- Version: 6.2.1.
- Runs when: a Ruby or Rails file changed inside a Rails app. A Rails app is a folder whose `Gemfile` or `Gemfile.lock` names `rails` or `railties`. That folder must also hold `config/application.rb` or `bin/rails`. The files are `.rb`, `.rake`, `.gemspec`, `.erb`, `.haml`, `.slim`, `Gemfile`, `Rakefile` and `config.ru`. A `Gemfile` and an `app/` folder alone do not make a Rails app. A React Native app with Expo Router has both.
- Where it runs: OpenQodex runs brakeman in the Rails app's folder, wherever that folder is in the repository. It runs once for each app that the change touches. OpenQodex rebases brakeman's paths onto the repository root.
- Needs: Ruby 3.0 or newer. It installs from RubyGems.
- Settings: OpenQodex's own. OpenQodex does not load the repository's brakeman settings file.
- Network: OpenQodex starts it with no network option. It needs none.
- Licence: the Brakeman Public Use License, which is not an open source licence. OpenQodex does not bundle brakeman. OpenQodex downloads brakeman at run time onto your machine. Read the licence before you use brakeman. To switch it off, set `scanners.disable: [brakeman]`.

## rubocop

- Version: 1.69.2, with rubocop-rails 2.28.0 and rubocop-performance 1.23.0.
- Runs when: a `.rb`, `.rake` or `.gemspec` file or a `Rakefile` changed. A change to a `Gemfile` alone does not start it. A `Gemfile` declares gems. The cops written for it are outside the Lint, Security and Performance cops that OpenQodex keeps.
- Rails: OpenQodex loads the Rails cops only for a file in a Rails app, as the [brakeman](#brakeman) section defines it.
- Needs: Ruby 2.7 or newer. It installs from RubyGems.
- Settings: OpenQodex's own. OpenQodex does not load a `.rubocop.yml` from the repository, because that file can load Ruby code.
- Network: OpenQodex starts it with no network option. It needs none.

## sqllint

- Version: part of OpenQodex.
- Runs when: a `.sql` file changed.
- Needs: nothing. It runs inside OpenQodex and downloads nothing.
- Checks Postgres migrations for common mistakes, such as a privileged function left callable by every role.
- Network: sqllint runs inside OpenQodex and makes no network request.

## zizmor

- Version: 1.30.1.
- Runs when: one of these files changed:
  - A GitHub workflow: a `.yml` or `.yaml` file directly under `.github/workflows/`, the files actionlint checks.
  - An action's metadata file, `action.yml` or `action.yaml`, in any folder.
  - The file `.github/dependabot.yml` or `.github/dependabot.yaml`.
- Needs: nothing.
- Finds security problems in those files:
  - Text that an attacker controls, expanded into a script (template injection).
  - Dangerous triggers, such as `pull_request_target`.
  - Actions not pinned to a commit.
  - Credentials left in the checkout.
  - Default permissions.
  - Dependabot updates that run a dependency's code.
- Offline: OpenQodex runs it with zizmor's own `--offline` flag. So the audits that ask the GitHub API do not run. OpenQodex passes it no GitHub token.
- Settings: zizmor reads the first of these files at the repository root: `.github/zizmor.yml`, `.github/zizmor.yaml`, `zizmor.yml` and `zizmor.yaml`. That file holds rule settings only: rules switched off, ignore entries, allow lists and severity changes. As OpenQodex runs it, zizmor does not read a zizmor settings file anywhere else.
- Severity: zizmor's own. A finding that zizmor reports with low confidence ranks one step lower.
- Network: OpenQodex runs it offline. In one run on 2026-10-08, with the proxy variables set to a logging proxy, zizmor opened no connection.
- Licence: MIT ([LICENSE](https://github.com/zizmorcore/zizmor/blob/v1.30.1/LICENSE)).

## trivy

- Version: 0.75.0.
- Checks: `trivy config` only, its misconfiguration checks for Terraform, Kubernetes and CloudFormation. OpenQodex does not run trivy's vulnerability, secret or image scanning.
- Runs when: one of these files changed:
  - A `.tf` or `.tf.json` file.
  - A YAML file that holds a Kubernetes object, with a top-level `apiVersion` and `kind`.
  - A CloudFormation template. That is a `.yaml`, `.yml`, `.json` or `.template` file with a top-level `AWSTemplateFormatVersion`. A file with a top-level `Resources` whose entries have a `Type` that starts with `AWS::` is one too.

  OpenQodex reads at most the first 64 KiB of such a file to tell.
- Folder: Terraform reads a module as its whole folder. So trivy gets every `.tf`, `.tf.json`, `terraform.tfvars` and `.auto.tfvars` file of the changed file's folder. It does not get the files of its subfolders.
- Not checked: OpenQodex does not give trivy a Dockerfile, since hadolint checks those. It does not give trivy a Helm template either. A file that holds `{{` is not YAML until Helm renders it. A rendered line is not a line of the template.
- Needs: nothing.
- Where it runs: OpenQodex runs trivy on a copy of those files outside the repository, with no `PATH`. It gets a home, cache and module folder of its own. OpenQodex removes them after the run. trivy loads no `trivy.yaml` (`--config ""`). It loads no check bundle (`--skip-check-update`), so it uses the checks built into the pinned binary. It loads none of your own trivy settings or modules.
- Folders left out: OpenQodex does not run trivy on a folder whose Terraform calls a module from outside the repository. Such a module source can be the Terraform registry, git or a URL. It can also be any source that is not a plain `./` or `../` path. A `../` path that leaves the repository counts too. At version 0.75.0, trivy downloads such a module and starts git to do it. It has no switch to stop that. It also reads a `../` path from the copy, so enough of them reach any folder on your machine. OpenQodex also leaves out a folder that holds a Terraform file it cannot read whole and for certain. The report names the folders that OpenQodex left out. Checkov and TFLint still check them.
- Settings: trivy reads `.trivyignore` at the repository root, a list of check ids to leave out.
- Where a finding goes: on the lines that trivy names as its cause. A cause can be a whole block, such as a resource that lacks an attribute, or a container. Then the finding goes on the block's first line. So a change elsewhere in the block does not bring it back.
- Severity: trivy's own.
- Network: OpenQodex runs it with telemetry and the version check off (`--disable-telemetry`, `--skip-version-check`). In a test run, a proxy that logged each connection saw none.
- Finds misconfigured infrastructure. Examples are a security group open to the internet, a privileged container, an unencrypted bucket and a public database. It also runs the other checks of trivy's misconfiguration scanner.
- Licence: Apache-2.0 ([LICENSE](https://github.com/aquasecurity/trivy/blob/v0.75.0/LICENSE)).
- Pin: the pinned sha256 matches the release's checksum file and GitHub's digest. OpenQodex does not pin trivy 0.69.4, the release that an attacker published on 2026-03-19.

## squawk

- Version: 2.66.0.
- Runs when: a `.sql` file changed, the files sqllint checks.
- Needs: nothing.
- Finds Postgres migration steps that lock or rewrite a busy table, or lose data:
  - An index built without `CONCURRENTLY`.
  - A constraint or foreign key added without `NOT VALID`.
  - A `NOT NULL` column with no default.
  - A column type change.
  - A dropped or renamed column or table.
- Severity: the rules that ask for a habit rank low. These are `IF NOT EXISTS`, lock and statement timeouts, `bigint`, `text`, `timestamptz` and identity columns. The other rules rank medium.
- Settings: squawk reads `.squawk.toml` at the repository root. That file sets the rules left out or added, and the paths left out. It also sets the Postgres version and whether a transaction wraps each file. As OpenQodex runs it, squawk does not read a `.squawk.toml` anywhere else.
- Network: OpenQodex does not run its `upload-to-github` command. In one run on 2026-10-08, with the proxy variables set to a logging proxy, squawk opened no connection.
- Licence: Apache-2.0 or MIT, at your choice ([LICENSE-APACHE](https://github.com/sbdchd/squawk/blob/v2.66.0/LICENSE-APACHE), [LICENSE-MIT](https://github.com/sbdchd/squawk/blob/v2.66.0/LICENSE-MIT)).

## kube-linter

- Version: 0.8.3.
- Runs when: a `.yaml` or `.yml` file that holds a Kubernetes object changed (see "Which scanners run, and why").
- Needs: nothing.
- Finds workload and access risks in each object:
  - A privileged container, or one that can gain privileges.
  - Host network, PID or IPC namespaces.
  - The Docker socket or another sensitive host path mounted.
  - A writable host mount.
  - Unsafe sysctls or proc mounts.
  - A cluster-admin role binding.
  - A `*` in an RBAC rule.
  - A container that may run as root, or with a writable root file system.
  - The `NET_RAW` capability kept.
  - A secret in an environment variable.
  - The `latest` image tag.
  - An SSH port exposed.
  - A probe on a port that the container does not open.
  - An invalid port name.
  - A selector that does not match its pods.
  - CPU or memory left unset.
- Checks: kube-linter's default checks, less two, plus four. OpenQodex leaves out `dangling-service` and `non-existent-service-account`. These two need objects from other files, and OpenQodex passes only the changed files. It adds `wildcard-in-rules`, `cluster-admin-role-binding`, `writable-host-mount` and `unsafe-proc-mount`.
- Severity:
  - High: the privilege, host mount, host namespace, sysctl and RBAC checks.
  - Medium: running as root, a writable root file system, `NET_RAW`, and a secret or duplicate in the environment.
  - Also medium: the `latest` tag, the port checks, a selector mismatch and a removed API version.
  - Low: CPU and memory, anti-affinity, disruption budgets, a Job's time to live and the deprecated `serviceAccount` field.
- Where a finding goes: on the line of the field that its check is about. Since kube-linter reports an object and not a line, OpenQodex reads that line from the manifest with a YAML parser. When the object lacks that field, the finding goes on the nearest field it has. A writable host mount goes on the container's mount of that volume, on its `readOnly` when it has one. A change that makes a mount writable is there, not on the volume.
- Settings: OpenQodex's own. OpenQodex does not load a `.kube-linter.yaml` from the repository. A custom check in that file can download schemas from any address and write a folder anywhere.
- Annotations: kube-linter obeys the ignore annotations on an object. See "Suppression comments".
- Network: OpenQodex starts it with no network option. It needs none.
- Licence: Apache-2.0 ([LICENSE](https://github.com/stackrox/kube-linter/blob/v0.8.3/LICENSE)).

## TFLint

- Version: 0.64.0, with the terraform ruleset 0.15.0 built into the binary.
- Runs when: a `.tf` or `.tf.json` file changed. It checks the folder of each changed file, as trivy gets it.
- Needs: nothing.
- Settings: OpenQodex's own. TFLint runs the bundled terraform ruleset with its `recommended` preset, and no other plugin. That preset holds the rules about mistakes, such as unused declarations and deprecated syntax. It also covers modules without a pinned version and missing version constraints. It leaves out the naming and documentation rules of the `all` preset. OpenQodex does not load a `.tflint.hcl` from the repository.
- Plugins: OpenQodex downloads and starts no TFLint plugin, and it does not run `tflint --init`. TFLint's plugin folder is an empty folder that belongs to the run. So a `.tflint.d` folder in the repository or in your home cannot replace the bundled ruleset. OpenQodex will run a plugin only when TFLint verifies it by signature and OpenQodex pins it. In this version, OpenQodex pins no plugin.
- Modules: OpenQodex switches module calls off (`call_module_type = "none"`), so TFLint reads no module. The terraform ruleset checks each module as written, so this hides none of its findings.
- Evaluated values: TFLint evaluates the Terraform it checks. An expression can read any file that you can read, since `file()` and `fileexists()` take an absolute path. One recommended rule prints an evaluated value in its message: `terraform_map_duplicate_keys`. OpenQodex switches that rule off. With it on, a duplicate map key written as `file("<path>")` would put that file into the report. Each other recommended rule prints names, literals from the Terraform code or fixed text.
- Errors: TFLint can report an error, such as a function it could not evaluate. OpenQodex lists such an error by its file and TFLint's short summary only. It leaves out the detail, which can name a path and say whether a file is there.
- Where it runs: OpenQodex runs TFLint on a copy of the files outside the repository. TFLint gets no `PATH` and a home of its own.
- Severity: an `error` is high. A `warning` is low, and most rules of the ruleset report warnings. A `notice` is info.
- Network: OpenQodex runs it with plugin downloads and module calls off. In a test run, a proxy that logged each connection saw none.
- Finds Terraform mistakes:
  - A variable, local or data source that nothing uses.
  - Deprecated interpolation and index syntax.
  - A module from the registry or git with no pinned version.
  - A provider with no version constraint.
- Licence: MPL-2.0 ([LICENSE](https://github.com/terraform-linters/tflint/blob/v0.64.0/LICENSE)).

## kubeconform

- Version: 0.8.0.
- Runs when: a `.yaml` or `.yml` file that holds a Kubernetes object changed, the files kube-linter checks.
- Needs: network access to raw.githubusercontent.com for schemas.
- Finds an object that the Kubernetes API would refuse:
  - A field that the API does not have, such as a misspelling or a field at the wrong level.
  - A value of the wrong type.
  - A required field missing.
  - A value outside its allowed list.
- Unreadable files: a file that does not read as Kubernetes objects is one finding over the whole file.
- Schemas: kubeconform validates in strict mode against the JSON schemas of Kubernetes 1.37.1. The schemas come from one commit of [yannh/kubernetes-json-schema](https://github.com/yannh/kubernetes-json-schema). `toolchain.json` pins both the version and the commit. For a kind with no schema there, such as a custom resource, kubeconform checks nothing.
- Severity: high for a wrong type, a missing required field or a value outside its list. A file that does not read ranks high too. A field that the API does not have ranks medium.
- Where a finding goes: on the line of its field, as for kube-linter.
- Documents: kubeconform names an object by kind and name only. So OpenQodex hands it each document of a file as a separate file, in a temporary folder outside the repository. Then an error lands in its own document. This holds even when two objects in one file share a kind and a name.
- Messages: kubeconform can name several unknown fields in one message. Each of them becomes a finding of its own, on its own line.
- Settings: none. As OpenQodex runs it, kubeconform reads no settings file.
- Network: kubeconform requests each kind's schema file from raw.githubusercontent.com, such as `deployment-apps-v1.json`. So the requests name the kinds that you use. As OpenQodex runs it, kubeconform does not send a manifest. It caches the schemas under `~/.openqodex/cache/kubeconform/<commit>/`, so it fetches each kind once.
- `--offline`: OpenQodex does not run it. The report lists it as disabled.
- Licence: Apache-2.0 ([LICENSE](https://github.com/yannh/kubeconform/blob/v0.8.0/LICENSE)). The schemas are Apache-2.0 too.

## cargo-deny

- Version: 0.20.2.
- Runs when: a `Cargo.lock` changed. OpenQodex does not check a `Cargo.lock` that has no `Cargo.toml` beside it. The reason names that file.
- Needs: your Rust toolchain's Cargo, and network access to github.com for the RustSec advisory database. The project's crates must already be in your Cargo cache, as after one `cargo build` or `cargo fetch`. OpenQodex does not install Rust and does not download crates. The reason names a crate that is missing from the cache, with the `cargo fetch` to run.
- Finds, from the [RustSec advisory database](https://rustsec.org):
  - A crate version with a known vulnerability, unsound code or no maintainer.
  - A crate from a git repository, or from a registry other than crates.io.
- Does not check: licences and banned crates.
- Severity: a vulnerability ranks high. Unsound code and a crate source other than crates.io rank medium. An unmaintained crate, an informational notice and a git source with no commit named rank low.
- Where a finding goes: on the crate's entry in `Cargo.lock`, from its `name` line to its `version` line. When osv-scanner reports the same advisory on the same lines, the report keeps one of the two findings. It keeps the higher severity and names the other scanner.
- Settings: OpenQodex's own. OpenQodex does not load the repository's `deny.toml`, because it can name advisory database addresses and a database folder anywhere.
- Where Cargo runs: OpenQodex runs Cargo from a folder outside the repository. It names your toolchain by its real files. So Cargo does not read the repository's `.cargo/config.toml`, which can set a rustc wrapper or a source replacement. Cargo does not read `rust-toolchain.toml` either, and installs no toolchain. OpenQodex runs Cargo offline. As OpenQodex runs it, Cargo does not rewrite `Cargo.lock`.
- Projects left out: OpenQodex does not run cargo-deny on a project whose manifests name a path outside the repository. The same holds for a path that the manifests reach through a link. Such a path can be any of these:
  - A path dependency, in any dependency table.
  - A workspace member or root.
  - A patch or a replace path.
  - A target, build script, readme or licence file.

  Cargo reads the manifest of each such folder wherever it lies. So before Cargo starts, OpenQodex checks each manifest that the project's manifests name, in turn. The check fails closed. OpenQodex also holds a project back in these cases:
  - A manifest that a path names is missing, or does not parse as TOML.
  - A workspace lists its members by a pattern such as `crates/*`. Cargo expands it over the file system and follows links there.
  - The project names more than 1000 manifests.
  - The project has no `[workspace]` from its folder up to the repository root. Also, a folder above the repository holds a `Cargo.toml`. Cargo would read that file to look for the workspace.

  The report names each project that OpenQodex held back, and why.
- Exceptions: cargo-deny reads `deny.exceptions.toml` or `.deny.exceptions.toml` beside the project or above it. That file holds licence exceptions only, which OpenQodex does not check. But a broken file stops cargo-deny.
- Network: cargo-deny fetches the RustSec advisory database from github.com into `~/.openqodex/cache/cargo-deny/`. As OpenQodex runs it, cargo-deny sends nothing about your code or your crates.
- `--offline`: OpenQodex does not run it. The report lists it as disabled.
- Licence: MIT or Apache-2.0, at your choice ([LICENSE-MIT](https://github.com/EmbarkStudios/cargo-deny/blob/0.20.2/LICENSE-MIT), [LICENSE-APACHE](https://github.com/EmbarkStudios/cargo-deny/blob/0.20.2/LICENSE-APACHE)).

## Checkov

- Version: 3.3.22.
- Checks: its terraform, cloudformation and kubernetes checks only. OpenQodex does not run its helm or kustomize checks, which start other programs. It does not run Checkov's secret, dependency or image scanning either.
- Runs when: the same files changed as for trivy. Checkov runs beside trivy. Many of its checks name a problem that a trivy check names too.
- Needs: Python 3.11, which OpenQodex downloads through uv, as for semgrep.
- Install: its own environment, from a hash-locked lock file of 96 packages.
- Where it runs: OpenQodex runs Checkov on a copy of the files outside the repository. Checkov gets a home and a temporary folder of its own. Its `PATH` holds only its own environment. So it loads no `.checkov.yaml` from the repository or from your home. Such a file can name a folder or a git repository of Python checks, which Checkov would run.
- Folders left out: OpenQodex does not run Checkov on a folder whose Terraform calls a module by a path that leaves the repository. The same holds for a module called by an absolute path or by an expression. Checkov reads a local module from disk wherever it points. It reads other module sources but downloads none. OpenQodex also leaves out a folder that holds a Terraform file it cannot read whole and for certain.
- Folder choice: OpenQodex decides which folders trivy and Checkov get before either starts. It reads each Terraform file of the folder for its module sources, as HCL reads them. Its reader handles string escapes, heredocs, blocks on one line and comments anywhere a blank may go. OpenQodex withholds a folder from both scanners when the reader cannot account for one of its files whole. These cases cause that:
  - A module source that is not one plain string.
  - A construct that the reader does not model.
  - A block left open.
  - A `.tf.json` file that does not parse, holds a key twice or gives `module` another shape.
  - A file over 4 MiB.
  - More than 500 Terraform files in the folder.

  The report names each folder that OpenQodex withheld.
- Where a finding goes: on the attributes that Checkov says it evaluated, such as the `cidr_blocks` of an `ingress` block. Each attribute counts on its own lines. A change to a line between two of them keeps no finding. An example is a change to a `description` that Checkov did not evaluate. A finding spans the evaluated attributes that the change touched. Sometimes none of the evaluated attributes is in the file, such as an attribute that the resource lacks. Then the finding goes on the first line of the deepest block on their path that is in the file. Without such a block, it goes on the resource's first line. In a JSON file, the finding goes on the resource's first line.
- Severity: medium for each finding. Checkov gives a severity only with the Prisma Cloud platform.
- Overlap with trivy: when trivy and Checkov report one missing setting on the same lines, the report keeps one finding. It keeps the higher severity and names the other scanner. This applies to these settings:
  - An S3 bucket's public access block, versioning and access logging.
  - A database open to the internet, or without IAM database authentication.
  - A container's CPU and memory requests and limits.

  The report keeps the other checks of the two apart, even on one line.
- Network: OpenQodex runs Checkov with these settings:
  - `--skip-download`: Checkov fetches nothing from the platform.
  - No API key: OpenQodex passes none.
  - `--skip-results-upload`: Checkov uploads nothing.
  - `--download-external-modules false`: Checkov downloads no module.
  - `CKV_SKIP_PACKAGE_UPDATE_CHECK=true`: Checkov skips the version lookup on pypi.org that it otherwise makes on each start.

  In a test run, a proxy that logged each connection saw none.
- Time: about 2 seconds on a few small files once installed, measured on Apple Silicon.
- Finds misconfigured infrastructure with its own checks (`CKV_*` and `CKV2_*`). Many of them name the same problems as trivy.
- Licence: Apache-2.0 ([LICENSE](https://github.com/bridgecrewio/checkov/blob/3.3.22/LICENSE)).

## SQLFluff

- Version: 4.3.0.
- Runs when: a `.sql` file changed, the files sqllint checks.
- Needs: Python 3.11, which OpenQodex downloads through uv, as for semgrep and bandit.
- Finds queries that return a wrong result or hold dead code. OpenQodex runs only the eight rules in the table below, whatever the repository's settings select. SQLFluff's layout, capitalisation and quoting rules fire on almost every line of hand-written SQL.
- Severity: as the table below gives. A rule that the repository's settings list under `warnings` ranks info.
- Settings: SQLFluff looks for its settings in the folder of each changed file. It also looks in each folder above it, up to the repository root. It reads `.sqlfluff`, `.sqlfluffignore` and the `[sqlfluff` sections of `setup.cfg`, `tox.ini`, `pep8.ini` and `pyproject.toml`. These settings choose the dialect, the rules left out and the rules that only warn. When no settings file names a dialect, SQLFluff reads the file as `postgres`.
- Where it runs: OpenQodex runs SQLFluff on a copy of the changed `.sql` files and those settings files. So SQLFluff does not read a settings file in a folder above the repository. It does not read your own SQLFluff settings folder, `~/Library/Application Support/sqlfluff` or `~/.config/sqlfluff`.
- Templates: OpenQodex runs SQLFluff with its raw templater and no library path, whatever the settings name. So SQLFluff loads no Jinja macro library or dbt project, and runs no code from the repository. It does not expand Jinja and dbt templates.
- Limits: SQLFluff does not check a statement that it cannot parse in the dialect. OpenQodex does not report that parse error. SQLFluff skips a file over 20,000 bytes, unless its settings raise the limit.
- Network: SQLFluff needs none. In one run on 2026-10-08, with the proxy variables set to a logging proxy, SQLFluff opened no connection.
- Licence: MIT ([LICENSE.md](https://github.com/sqlfluff/sqlfluff/blob/4.3.0/LICENSE.md)).

| Rule | Finds | Severity |
|---|---|---|
| CV05 | a comparison with `NULL` by `=` | medium |
| AM07 | a set query whose sides return different numbers of columns | medium |
| AM08 | a join with no condition | medium |
| RF01 | a reference to a table that is not in `FROM` | medium |
| AL04 | a table alias used twice | medium |
| AL08 | a column alias used twice | low |
| ST03 | a common table expression (CTE) never used | low |
| ST11 | an outer-joined table never used | low |

## Choosing scanners

- `scanners.disable` in `.openqodex/config.yaml` switches built-in scanners off.
- `--only` and `--skip` on `scan` and `review` pick scanners for one run.
- `custom-scanners` explains how to add a compatible scanner from GitHub: one that writes SARIF or one JSON document.
