# The review benchmark

This page is for contributors and for anyone who wants to check a claim about review quality. The benchmark measures how well `openqodex review` finds bugs that were planted on purpose, how often it reports something that is not there, and what each review costs in time and money. It lives in `benchmark/` in the repository; it is not part of the npm package.

A script runs it and a script scores it. No model decides what runs or how a review scores. A model may judge the wording of findings in a separate, optional pass, and that verdict never blocks anything.

## Published results

[Benchmark results](benchmark-results.md) lists the current accepted run of each group in `benchmark/index/accepted.json`. The full page and the README's Benchmark section are generated from `benchmark/index` only. The script never reads a results folder.

Run `node scripts/benchmark-results.mjs` after an accepted index change, then commit both generated pages. Run `node scripts/benchmark-results.mjs --check` to check them without writing. The gate runs this check locally and in CI. A difference fails with exit 1 and the first differing line in each file. `--root <folder>` selects another repository root.

Each full-page row names its configuration, split, subset when present, mode, path and rules version. A row with a split hash shows its first 12 characters. Repeats come from the entry's `repeat` field. Missing measurements are shown as not measured. A run with findings, every one unresolved and none a hit, shows its issue recall as not yet ruled. The full page also shows location recall. The README leaves out a row of a suite with a board, such as AACR-Bench, until the row has board numbers or a ruled hit. The full page shows every row. Precision bounds describe unresolved findings, not confidence intervals. The recall interval is the saved 95% cluster interval.

An A/A twin uses the parent's run id with `-aa` appended. The script pairs it only when its group, bundle hash, case set hash, rules hash and repeats match. Its noise is the absolute difference in issues found across all repeats, also shown per repeat. AACR board numbers come from the entry's `outside.aacr.byConfig.<config>.mean`, using the shape `score.mjs --outside aacr` writes. A row without that block says "not yet board-scored". The publish step copies that block from the run's `score.json` into its index entry. The README puts rows with board numbers in a table of their own. Board numbers do not decide acceptance.

## What it measures

Each case is a small git repository with a base commit and an uncommitted change, the same shape a developer has before a push. The change carries planted bugs, each with a file, a line range, a kind (`bug`, `security`, `performance`, `maintainability` or `style`), a severity and the scanner or the reasoning expected to find it. The benchmark runs the real built CLI on each case, with the real reviewer, with the code graph off and on, three times each.

From the saved reports it counts (score format 3):

- The population: every review the run planned, scored by its first attempt. A review that failed or never started misses every bug of its case and adds no finding. A retry is reported apart, with its cost, and never replaces the first attempt.
- Issue recall: planted bugs found, over planted bugs, overall and for critical and major bugs. A bug found by two findings counts once.
- Precision, as a lower and an upper bound over every finding the developer is shown, except a request for a test on a planted case. A hit, a second hit on a bug already found and a side issue the case lists as real are correct; a finding on a clean case is false. Any other finding (one the case does not list, a near miss, a wrong kind) is unresolved until a person rules on it: the lower bound counts it as wrong, the upper as right.
- Unique-issue precision counts each issue once, and redundancy is the share of findings beyond one per issue.
- Planted-rule precision: the earlier rule, which leaves out duplicates, listed side issues and requests for a test, with the count of those requests. It is computed on planted cases only and never pooled with other numbers.
- A location diagnostic: findings within one line of a planted bug's lines, whatever they say (the line rule of AACR-Bench). It never decides anything.
- Severity agreement: for each bug found, the severity the first finding that found it gave, against the bug's own, on the scale critical, major, minor, nitpick, info. It is exact, one step off, or off by two steps or more, and rated higher or lower than the case says. The score keeps the full table of given against expected severity.
- Who found each bug: a scanner, when one of its candidates, or a finding merged into one, sits on the bug's lines in that review's `scan.json`; the reviewer alone otherwise. A candidate from a scanner the case does not expect counts only when its rule or message names the bug's words, so a finding about another issue inside a wide range is not credited. OpenQodex's own candidates about a changed settings file or an added suppression comment count as the settings or suppression check when a built-in scanner raised them; a custom scanner's rule counts as that custom scanner, whatever its id. The case's expected finder is what this is compared with, never the answer: the score gives the share found by whom the case expects, each expected finder's share, and the bugs the case expected from a scanner that the reviewer found alone. A review that saved no `scan.json` is left out of these shares.
- Clean controls: two cases have no bug. Any finding on them is false. A clean case passes only when its review completed with no finding; an incomplete or failed review fails it.
- Graph disclosure, for the cases that need the graph: whether the brief named the callers the change breaks, and whether it said what the graph could not see (a caller list that is a floor, a call it could not bind).
- Time per review (from the start of the CLI to its exit), reviewer turns, tokens and cost, as the report records them.

## How a finding is scored

A script matches each finding in `report.json` to its case. A finding matches a planted bug only when three things hold: its place (the same file and an overlapping line range), its kind (a category the bug lists) and its words (the finding names one of the bug's `mentions`, at the start of a word). Every plant and every accepted side issue lists its words; the scorer refuses a spec where one does not. The words are how a blast-radius bug is scored: the finding must sit on the changed line and name the caller that breaks.

The checks run in this order, and the first that holds decides:

1. Test gap: a finding of kind `maintainability` or `style` whose title asks for a test ("has no covering test", "lacks tests", "untested"), even when its lines span a planted bug. On a case with planted bugs it is left out of both precision bounds and counted apart in the planted-rule block (the planted cases ship no tests). On a clean case, which ships its tests, it is false.
2. Accepted: a side issue the case lists as real but not planted, matched by place and words. It is correct in precision and left out of planted-rule precision.
3. Hit: a planted bug, matched by place, kind and words. When two bugs share the lines, the one whose anchor line is nearest wins. A second hit on a bug already found in the same review is a duplicate: it is correct in precision, counts once in unique-issue precision, and is left out of planted-rule precision.
4. Near miss or wrong kind: a hit in every way but the lines (within three lines of the range), or in every way but the kind. Neither is a hit; both are unresolved in precision and count against planted-rule precision. A near miss is listed so a spec that names the wrong line can be fixed.
5. Unlisted: anything else. It is unresolved in precision, false in planted-rule precision, and false on a clean case.

Each finding counts for one bug at most. A review that wrote no report misses every bug. A review the product marked incomplete is scored on the findings it holds and counted as incomplete.

Every score carries its rules block: the rules version (8), every constant and list above, and a hash over them and the code that applies them. Version 6 reads pull request truth, whose comments have no kind and no severity: they are matched on the categories they name, and left out of the per-severity tally. Version 7 credits a custom scanner's rule to that custom scanner, whatever its id, and reads a model review's cost and tokens from its sample record. Version 8 applies a person's ruling on a truth item only to the version of the spec it judged (see the review queue below); with no ruling, a score is the same as under version 7. A test fails when a rule changes and the version does not, and two scores whose rules differ are not compared until both are scored again with one scorer.

## The cases

| Case | Language | Planted bugs (severity; expected finder) |
|---|---|---|
| `clean-python-feature` | Python | none (clean) |
| `clean-ts-refactor` | TypeScript | none (clean) |
| `demo-polyglot` | Python, Flask, Docker, shell, a workflow, npm, SQL, Terraform, Kubernetes | the demo repository's fifteen: a secret (critical; gitleaks, semgrep), SQL injection (critical; bandit, semgrep), four Dockerfile issues (minor; hadolint), the container left running as root (major; reasoning), a vulnerable lodash (major; osv-scanner), two shell bugs (shellcheck), workflow script injection (major; actionlint, semgrep, zizmor), an index built without `CONCURRENTLY` (major; squawk), SSH open to every address (critical; trivy, Checkov), a privileged container (critical; Checkov, kube-linter), a pagination off-by-one (major; reasoning) |
| `django-model-view` | Python, Django | a Decimal times a float (major), a field with no migration (major), an order readable by any user (critical), CSRF turned off on a POST (major); reasoning, semgrep for CSRF |
| `django-renamed-view` | Python, Django | a view renamed while the app's `urls.py`, outside the diff, still registers its old name, so loading the URLs fails (critical; reasoning, graph) |
| `express-admin-routes` | JavaScript, Express | a delete route without the admin check (critical), `forEach` with an async callback that is not awaited (major); reasoning |
| `express-route-param` | JavaScript, Express | a handler that now reads `req.params.userId` while its route, registered in another file outside the diff, declares `:id`, so every lookup answers 404 (major; reasoning, graph) |
| `flask-path-traversal` | Python, Flask | a download path built from a parameter (critical), the debug server on every interface (major); semgrep, bandit, reasoning |
| `go-http-handler` | Go | SQL built with `Sprintf` (critical; semgrep, golangci-lint), a mutex left locked on an early return (major), a deferred close before the error check (major) |
| `js-dynamic-dispatch-gap` | JavaScript | a handler made async while its caller, reached only through `table[action](id)`, uses the result as a string (major); the brief must say the graph could not bind that call |
| `kubernetes-host-access` | Kubernetes YAML | the node's Docker socket mounted into a worker (critical), the pod put on the node's network (major); kube-linter, semgrep (trivy and Checkov place both on the manifest's unchanged first lines, so the changed-line filter drops them) |
| `nextjs-react-hooks` | TypeScript, Next.js | hooks after an early return (major), an effect with no dependency list (major), the query string put into the page as HTML (critical), list items without keys (minor) |
| `postgres-migration-locks` | SQL, Postgres | a `NOT NULL` column with no default added to a live table (major), an index built without `CONCURRENTLY` (major); squawk |
| `python-caller-break` | Python | a function that may now return `None`, with callers in another `src` package that add and divide its result (major; reasoning, graph) |
| `rails-controller-model` | Ruby, Rails | SQL built from params (critical), `destroy` left out of the admin check (critical), `permit!` (critical), a welcome email on every save (major); brakeman, semgrep, reasoning |
| `suppression-comments` | Python, JavaScript | a shell injection hidden by `# nosec` (critical), an `eval` hidden by `eslint-disable` and `nosemgrep` (critical); a harmless `# noqa: E501` that must not be reported |
| `terraform-open-ingress` | Terraform, AWS | SSH opened to every address (critical), the orders database made publicly accessible (major); trivy, Checkov |
| `ts-interface-dispatch-break` | TypeScript | an implementation of a `Cache` interface whose `get` now throws where the interface promises an empty string, called only through the interface from two files among many other calls named `get` (major; reasoning, graph) |
| `ts-removed-export` | TypeScript | a renamed export still imported by a file outside the change (major; reasoning, graph); nothing in the diff shows it |
| `ts-workspace-caller-break` | TypeScript, pnpm workspace | `safeGit` changed from returning a string to returning an object, with callers in another package (major; reasoning, graph) |
| `workflow-untrusted-checkout` | GitHub Actions | a `pull_request_target` workflow that runs the pull request's code with a secret (critical), gated by a spoofable `github.actor` check (major); zizmor |

Fifty-one planted bugs in all: 18 critical, 27 major, 6 minor.

Each case is a folder under `benchmark/cases/<case>/`: `case.json` (the spec), `base/` (the base commit), `change/` (the files the change writes) and an optional `delete.txt`. `demo-polyglot` reads `examples/demo-repo` instead, and its secret is generated when the case is built, the same value every time, never committed. The repositories are built in a temporary folder; none is committed. `node benchmark/build.mjs <case>` builds one so you can read it.

## Run it

From a clone, with Node 22, Claude Code installed and logged in:

```
pnpm install
node benchmark/build-cli.mjs           # pnpm build, and a record of the commit and tree it built from
node benchmark/run.mjs --max-usd 25 --max-minutes 150 --dry-run   # print the plan and its estimate, run nothing
node benchmark/run.mjs --max-usd 25 --max-minutes 150             # 21 cases, graph off and on, 3 repeats: 126 reviews
node benchmark/score.mjs benchmark/results/<date>-<commit>
```

The reviews run on your Claude Code account, at its usual cost. Every run names what it may spend and how long it may take, `--max-usd` and `--max-minutes`, and prints its estimate before anything starts: the mean cost and time per review of the indexed run that covered the most of the planned cases, or a default table. A run whose estimate passes either limit is refused unless `--allow-over`. Before each review, no review starts when what is spent, plus the median review so far for each review running and the next, would pass `--max-usd`, or when the time gone plus the median review time would pass `--max-minutes`; `--max-tokens N` (for Codex, which reports tokens and no dollars) and `--max-reviews N` stop launches the same way. Claude Code and Codex report their cost only after a review, so these are forecast stops: the reviews already running finish, and a run can pass `--max-usd` by them. A run stopped by its budget ends as `budget` in its manifest, with the limit, whether it was a hard cap or a forecast, and what was spent; it is not a full run until `--resume`, with a larger limit, runs the rest.

Hard caps that hold every model call before it is sent are in `benchmark/lib/budget.mjs`, for the model reviewers and the wording judge: a model review holds its whole `--review-max-usd` against the run's `--max-usd` before it starts, each call reserves its worst case inside that (its request at 3 UTF-8 bytes per character as input tokens, plus its whole output allowance, at the prices in `benchmark/outside/prices.json`) and gives back the unused part when it reports its cost, and a judge's call reserves its worst case against the run's cap. The reservations go into `budget.jsonl` in the run folder, under a lock every process of the run shares. Once a call costs more than its worst case, nothing more is reserved or sent. `judge.mjs` sends every call through the ledger, so a run's manifest says `judgeIncluded: true`.

Before anything is spent, the run asks the CLI's own `doctor` which scanners each case calls for and whether each is installed. A missing one (brakeman and rubocop need Ruby, golangci-lint needs Go, and with `OPENQODEX_OFFLINE=1` the scanners that go online are switched off) refuses the run unless `--allow-missing-scanners`, and then the manifest records `scannersComplete: false` and the missing scanners, and the run is never accepted: an index entry marked accepted must have ended `finished` with `scannersComplete: true`.

Each Claude Code review records the model that served it in `sample.json` (`model`, `models`, `modelStatus`). The model comes from the `modelUsage` keys of Claude Code's result events. The CLI saves them per round in `report/usage.json`. Reviewer text and the requested model never set it. A review with several models keeps them all and is `mixed`. A round Claude Code answered without naming a model makes the review `unknown`. A review Claude Code never answered names no model (`none`) and is left out. The manifest records the one model the reviews named. Two models, no model, or a model other than `--model` mark the run stopped, with the reason. A run a halt or its budget stopped keeps that reason, and the manifest names the model problem in `modelRefusal`. `trend.mjs --accept` refuses such a run, and a run whose samples have no usage record. The score then prints `Claude Code model: unknown`.

Other flags of `run.mjs`: `--cases a,b`, `--graph off|on|off,on`, `--repeat N` (1 to 6; more than three needs `--allow-more`), `--add-repeats N` with `--out <folder>` (adds repeats to a finished run, keeping every review it planned), `--reviewers claude,codex`, `--model <id>` (Claude Code only: it reaches the reviewer through `ANTHROPIC_MODEL`, and the run stops when Claude Code answers with another model; the Codex reviewer runs with `--ignore-user-config` and takes no model setting, so `--model` with Codex is refused), `--web off|on` (off by default: every case and its discussion is public), `--change <RC-id>` (the reviewer-loop change the run measures), `--concurrency N` (default 1; parallel reviews slow each other), `--resume` (finish a stopped run). Within each repeat the case order is rotated by the repeat number and the configuration order alternates, so drift lands on no one case or configuration.

Claude Code and Codex also review AACR-Bench's development pull requests, with the flags of the model reviewers below (`--suite`, `--subset`, `--cases`):

```
node benchmark/run.mjs --suite aacr --subset dev-smoke --graph on --repeat 1 --max-usd 10 --max-minutes 60
```

Each review gets the merge base as a commit and the pull request's change uncommitted, as for a planted case. The run scores it against the same saved truth as a model review. `--graph` and `--web` work as for planted cases. With `--web on`, the reviewer can read the pull request's review comments, which are the truth. A pull request case's checkout can be large, so it is removed when its review ends.

### Model reviewers: the server path

`--reviewers model:<id>` reviews each case the way a server that hosts OpenQodex does: the library's `reviewChange` in the server profile (`docs/library.md`), with the model as the host's model.

```
node benchmark/run.mjs --reviewers model:scripted --cases flask-path-traversal --repeat 1 --max-usd 1 --max-minutes 10 --review-max-usd 0.5
node benchmark/run.mjs --reviewers model:gpt-6.1-sol --cases aacr/laravel__framework-56591 --repeat 1 --max-usd 2 --max-minutes 30 --review-max-usd 0.5
```

- `<id>` is `scripted`, a deployment that `benchmark/outside/boards.json` records as probed (`gpt-6.1-sol` today), or a name in its `aliases` map that points at one. Anything else is refused before anything runs. The manifest records the model asked for (`requestedModel`), the alias that named it, the settings, and the endpoint as an HMAC-SHA256 of its base URL keyed with the endpoint's key, never the URL or the key; a resume on another base URL or another key is refused. The manifest's `model` is the model the provider named as serving the run's first answered review, and a later review served by another model stops the run.
- `model:scripted` is the scripted model (`benchmark/lib/scripted-model.mjs`), for tests and dry runs. It answers from a script (`--model-script <file>`, by default `benchmark/lib/scripted-model.json`): it drops every scanner candidate the brief names, raises the script's findings and makes no network call. Its calls cost what the script's prices say, zero by default.
- A deployment is called through `benchmark/lib/openai-reviewer.mjs`, at the endpoint that `~/.config/openqodex-bench/azure.env` names (`benchmark/lib/model-env.mjs`). `--model-effort <level>` and `--max-output-tokens <n>` (default 32000) are the adapter's settings.
- Each review gets the case as two commits (the merge base and the head) and a workDir of its own in a short folder under `/tmp`, removed when the review returns. The scanners are read from `--install-root`, the tools folder of an OpenQodex home (by default `$OPENQODEX_HOME/tools` or `~/.openqodex/tools`), and never installed; the scanner preflight runs that home's doctor. The code graph is always on and web access off. `--review-max-usd` is required: every call is held to it before it is sent. Reviews run 2 at a time unless `--concurrency` says otherwise, and `--timeout` is each review's deadline (900 s for planted cases, 1800 s for pull request cases).
- `--cases` may name pull request cases, as `<suite>/<name>` or a full case id, from the development split only; `--suite aacr` without `--cases` runs every usable development case, and `--subset dev-smoke` (or `dev-laptop`) the cases the split file lists there. `--split test` is refused: the held-out cases run only in a release run, and only `--materialise-only` (below) builds one before that. Each case's truth is read from the pinned dataset files and saved with the case in the run's `cases/` folder, with its accepted comments only, so recall counts over those; the rejected comments are left out, and the location diagnostic's count of candidates on them (`knownNoise`) reads 0. Claude Code and Codex review them too, on the laptop path (see Run it above). The manifest records `suite`, `split`, `splitHash` and `subset` (`--subset all` is recorded as no subset). The index entry carries the subset too, and the trend keeps runs of different subsets in different groups, each with its own accepted run; a run with no subset keeps the group it had.
- A model review's sample holds `report/report.json` and `report/report.md` (the library's own renderings), `report/scan.json` (when the library's result carries the scan record), `usage.json`, `completion.json`, `dispositions.json`, `rounds.json`, `progress.txt` and `sample.json`. Its status is the result's (complete with a blocking finding counts as complete). `requestedModel` is the model each call asked for, and `servedModel` the one the provider named as answering: null when it named none, or more than one. The score reads the review's cost and tokens from the sample's `usage` (the library's totals over every model call), and each configuration's `servedModels` lists every model the provider named as serving its reviews.
- The run stops when a review changes its clone (a write outside its workDir), when a review throws, or when a saved file holds the endpoint's key or base URL. Every text a sample would hold is checked for the key and the address before anything of it is written or printed; when one holds either, the sample keeps only the line `refused: the provider's answer held the endpoint's key or address`, and the run stops. Laptop and model reviewers never share a run.

### Outside runs: the package under test, halts, smoke runs and proofs

These flags serve the runs that go to outside boards, and the development runs before them.

- `--package local|npm:<version>|file:<path.tgz>` names the build under test. `local`, the default, is the build `build-cli.mjs` made of this checkout, and the manifest's `package` records its commit. `npm:<version>` is the published `openqodex` at that version: the run reads the registry's answer from https://registry.npmjs.org itself (no npm setting or variable changes the host), takes the tarball it names on that host, checks the downloaded bytes against the registry's sha512 integrity, and keeps both in the clone cache (`$OPENQODEX_BENCH_CACHE/packages/`), where the integrity is checked again on every use. No npm command runs, so nothing is written to `~/.npm`. `file:<path.tgz>` is a packed build, as `npm pack` writes it, such as a release candidate. A tarball is read once, and the run reads those same bytes: it refuses a member with an absolute path, a `..`, a link or anything but a file or a folder under `package/`, before anything is written. The unpacked folder's `record.json` holds the sha256 of every file, and each run checks them all first: a changed, missing or added file means the package is unpacked again from the tarball. A package build is recorded by its name, version, sha256, integrity, size and file count; its build names no commit, and the run's folder is named after `v<version>`. The server path needs a library whose result carries `rounds` and `timings`: the published 0.12.0 does not, so `--package npm:0.12.0` can scan but not review with a model.
- Model runs stop on their own when the setup looks broken, and say which rule stopped them (`ended.halt` in the manifest, `{ rule, why }`): the endpoint refuses the key, the quota or the billing (HTTP 401 or 403, `insufficient_quota`, or a reply that names billing), at once; a model reviewer's served model changes during the run, or one review names two; two reviews in a row do not complete for the same reason (the same kind of provider error, budget refusal, deadline, answer that fails its checks, and so on); and, from the tenth review of an invocation on, more than 20% of reviews did not complete, the mean cost of a finished review is past 1.5 times the estimate, or what the finished reviews cost plus that mean for each review left passes `--max-usd`. Both cost rules count each finished review's own spend; what reviews in flight hold reserved is named apart and never counted. Any other HTTP 429 is a rate limit, not a refusal: the review is tried once more, in its next attempt folder, after the wait the provider names or 10 seconds, never more than a minute; a rate limit that outlasts its retry counts as the review's reason. A saved file that holds this machine's home folder stops the run too. A halt starts no new review; the reviews running finish and are saved with their cost, and `--resume` runs the rest. The counts start again on a resume; the served models seen before do not.
- Every model call holds its worst case in the run's ledger before it is sent (above), so a review whose next call would pass `--review-max-usd` ends incomplete with that call never sent, and a review the run's `--max-usd` has no room for never starts: it leaves no sample and spends nothing, and the run ends `budget`.
- `--smoke` checks that the runner works; it is never a measurement. It takes development cases only (`--split test` and any held-out case are refused), at most 5 reviews per configuration (one repeat unless `--repeat` says otherwise, and no `--add-repeats`), and it stops once the reviewer was invoked 5 times for a configuration, retries and a resumed run's earlier attempts included, saying how many were retries; and the manifest says `smoke: true`, so `publish-run.mjs` refuses it and it is never indexed. For example, the five AACR development cases of `dev-smoke` with the scripted model:

```
node benchmark/run.mjs --reviewers model:scripted --suite aacr --subset dev-smoke --smoke --max-usd 1 --max-minutes 30 --review-max-usd 0.5 --allow-missing-scanners
```

- `--materialise-only` builds every selected case in the shape the run would review it in (two commits for model reviewers, the change uncommitted for Claude Code, Codex and scans) and writes `proof.json` to the run folder: per case, its licence class, upstream's base, head and merge base with their trees, the built trees and whether they are upstream's, the case repository's fsck, and whether the merge base is an ancestor of the head in the clone cache's history. It runs no scanner, no reviewer and no CLI, reads no truth and spends nothing, so it takes no budget flags. It is the one way to build held-out cases before a release: with `--split test`, each suite's held-out cases get one line in `benchmark/index/heldout-access.jsonl` (`purpose: "materialise-only"`) before any is built, and the clone cache logs each case. It exits 0 when every case is proved and 1 when one is not.

```
node benchmark/run.mjs --materialise-only --reviewers model:gpt-6.1-sol --suite aacr --split test
```

- When the clone cache's commit history is too shallow for git to say whether the merge base is an ancestor of the head, the proof deepens that repository's commits cache from the head: 64 commits, then twice as deep each time, up to the merge base search's own bound of 1,048,576. This happens when a later case of the same repository fetched at a smaller depth, which cuts history, or when the commits cache was moved away. The proof records the depths fetched and the commits added (`ancestor.deepening`), and a case still unanswered at the bound is not proved.
- Two merge bases. When the dataset's base and the head have more than one merge base, the materialiser refuses the case until its suite entry freezes one. This happens in a criss-cross history, where the pull request and its target branch each merged the other, as in ClickHouse/ClickHouse#80345. The rule: list every merge base with `git merge-base --all <base> <head>`. Order them by committer date, newest first. Order merge bases with the same committer date by commit id, smallest first. The entry freezes the first. When the dates differ, the first is the merge base that `git merge-base <base> <head>` prints, and `git diff <base>...<head>` diffs against the same one. When two dates are the same, git picks one by the shape of the history, which git does not promise; the commit id makes every machine freeze the same one. For ClickHouse#80345 the dates differ, and GitHub's compare of the same two commits names the same merge base (fe23559f719b). `node benchmark/ingest/aacr.mjs --freeze-merge-base <name>` (or `martian.mjs`) finds the merge bases in the clone cache on commits only, as a build does. It writes the first into the entry as `mergeBaseSha`, with a new hash and id. The split names cases by name, so no case moves. A later ingest keeps the frozen merge base while the base and the head stay the same. A case with one merge base is never frozen, so its id stays. The case repository's record, the proof and the summary name three things: every merge base git found, in the rule's order (`mergeBases`), with the rule itself (`mergeBaseRule`); the one the case is built on; and where that one came from (`mergeBaseFrom`: `git` or `entry`).
- The clone cache (`$OPENQODEX_BENCH_CACHE`, by default `~/.cache/openqodex-bench`) keeps three things. Per repository, it keeps a history of commits only, and a tree cache with each merge base and head fetched with its files. Per case, it keeps a complete repository of two commits. Every commit in a tree cache has a ref (`refs/openqodex/<sha>`), so each tree fetch sends those commits as haves. The server then sends only the objects that the new tree does not share with their trees. So n cases of one repository keep about n + 1 trees; before #160 they kept about 3n. A tree cache filled before #160 gets its refs before its next fetch, and the packs it already holds stay as they are.
- `benchmark/proof.mjs` proves the outside suites before any model is spent on them. It runs `run.mjs --materialise-only` on every Martian case (all held out) and on both sides of AACR's split, in the shape a model review reads (`--shape laptop` for the other), into `benchmark/results/proof-<time>/`. It then writes one summary per suite, committed as `benchmark/index/proof/<suite>-<date>.json`: per case its licence class, upstream's base, head and merge base, the merge base's and the head's tree ids beside the built ones, whether the merge base is an ancestor of the head, any deepening, and the reason when the case did not build or prove. A case counts as proved only when its proof is ok, it has a licence class, its built tree ids equal upstream's (the summary compares the ids itself, not only the proof's flags) and its merge base is proved an ancestor of its head. A usable case with no proof is a failure. The summary names this machine's folders by placeholders (`<cache>`, `<tmp>`, `<home>`, `<checkout>`) and any other absolute path as `<path>`, a drive letter path or one right after a colon included, and it is not written while one remains. `--split test` (or `dev`) proves one side only, and its summary is named `<suite>-<side>-<date>.json`, so it never takes a whole suite's name. The proof folder's `proof-run.json` records the commit the proofs ran on. `--from <folder>` summarises an earlier proof folder again, and refuses a folder whose `proof-run.json` records no commit. A summary's `commit` is the commit the proofs ran on, and `summarisedAt` the commit of the checkout that wrote it. It exits 0 when every case is proved, 1 when one is not, and 2 when the proof could not run.

```
node benchmark/proof.mjs [--suite martian|aacr] [--split test|dev] [--shape server|laptop] [--from <folder>]
```

- The manifest of a model run also names the board a real suite comes from, with the commit `benchmark/outside/boards.json` pins (`board`), and the models the provider named as answering, per configuration (`servedModels`).

`build-cli.mjs` records the commit, the tree the build read (every file the repository sees, staged or not, untracked included) and a hash of the bundle and its assets. `run.mjs` refuses a bundle with another hash, so a run never names a commit its bundle was not built from. "Dirty" in a run means the tree the bundle was built from differs from the commit's tree. The model each reviewer used is read from its own output: Claude Code names it in its answer, and Codex prints it in its header.

Each review runs as `openqodex review --report-dir <sample>/report --reviewer <name> --reviewer-web off --timeout 900`, with `--no-graph` for the graph-off configuration. `--report-dir` means built-in defaults and no custom instructions, so nothing on your machine shapes the review except the reviewer's login.

A run writes one folder, `benchmark/results/<date>-<commit>/`:

- `manifest.json`: the build and where it came from, the machine, every reviewer with its version and model, web access, the timeout, the concurrency, the budget (hard caps apart from forecast stops, with the estimate), whether every scanner was installed, every planned review with its id (`jobs`), written before the first one starts, and how the first invocation ended (`ended.how`: finished, stopped or budget). A resume keeps the original plan, except that `--add-repeats` extends it, and updates the Claude Code model evidence from all saved attempts.
- `resumes.jsonl`: one line when a resume starts, with the budget it runs under, and one when it ends.
- `budget.jsonl`: every cost, reservation and review time the budget counted.
- `cases/`: the specs the run used. The scorer reads these, so a later edit to a case never changes an old run's score.
- `samples/<case>/<configuration>/<n>/`: one attempt at one review: its own files (`report.json`, `brief.md`, `submission.json`, `trace.json`, `scan.json`, `usage.json`), `receipt.txt` (what the review printed), `stderr.txt` and `sample.json` (exit code, time, usage, scanner versions). A second attempt of the same review goes to `<n>-attempt2/`.
- `rows.jsonl`: one line per attempt. Each attempt names its review's id and whether it is the first attempt.
- `score.json` and `outcomes.jsonl`: written by `score.mjs`; `score-<folder>.json` and `outcomes-<folder>.jsonl` when it scored against other specs with `--specs <folder>`. `outcomes.jsonl` has one line per finding of every first attempt, with the finding's id (a hash of the case, its lines and its text) and its outcome; a hit also carries its severity agreement, who found its bug and the scanners that located it. `unresolved.jsonl` lists each finding that still waits for a person's ruling (see the review queue below). Each configuration in `score.json` has a `wording` block with the totals of the run's `judge.json` (or the file `--judge <file>` names), or null when there is none. A legacy run (below) keeps the score its own scorer wrote; `score.mjs` writes its format 3 score only into the folder `--out <folder>` names.
- `judge.json` and `judge-raw/`: written by `judge.mjs` (below), the wording verdicts with the model that answered, and each answer as it came.

`benchmark/results/` is not committed; each run folder stays on the machine that ran it until it is published.

Every attempt is saved as a sample before anything stops. A review that failed, timed out, was stopped or never started is a failure in the table, never a missing row. A reviewer failure gets one more attempt, in its own folder; the score reports that retry apart and keeps the failed first attempt. The run stops at once when the reviewer hits a usage limit, a rate limit or a login wall, and when the same review fails twice with the same cause. It probes the reviewer before the first review and after any review whose reviewer failed. A folder that already holds a run (a manifest or samples) is refused without `--resume`, and one folder takes one runner at a time. `--resume` runs the reviews that have no saved attempt; a review whose first attempt started and never saved keeps that folder, which the score counts as its first attempt, and runs again in its next attempt folder. A resume is refused when the bundle, the machine, a reviewer's version or model, web access, the timeout, the concurrency, the cases, the configurations, the repeats, the scanners found missing or the change differ from the run's; its budget may differ, which is how a run stopped by its budget is finished.

## Where the runs are kept

A run leaves the machine as one file, `<run-id>.tar.gz`, attached to the `benchmark-data` pre-release of the repository (never marked latest). The repository keeps one index entry per run, `benchmark/index/runs/<run-id>.json`: the build, the reviewers and their models, the configurations, the headline numbers per configuration and per case, and the asset's URL, sha256, size, file count and file-list hash.

```
node benchmark/fetch-run.mjs <run-id>                  # download, check, unpack into benchmark/results/<run-id>/
node benchmark/publish-run.mjs benchmark/results/<run-id> --dry-run
```

A run ID starts with the UTC date of the run's start, and the manifest records that start time. `run.mjs` refuses an `--out` folder whose name starts with another date. A folder name without a date, such as a loop candidate's, is accepted. `--resume` and `--add-repeats` keep the run's original date.

When the runner saves a row, each scanner reason replaces the run folder path with `<run>` and the home folder path with `<home>`. A path that only starts with the same text stays. `publish-run.mjs` applies the same rule to a run saved before this rule. It changes the packaged rows, reports and briefs, never the run folder. It prints the number of reasons it redacted.

`fetch-run.mjs` refuses a download whose sha256 or file list is not the one the index entry names. `publish-run.mjs` packages only the run's own files (the manifest, rows, specs, samples and scores; the HTML, markdown and SARIF renderings of each report stay behind), and refuses to publish when any packaged file holds a case's generated secret, a home folder path, a value from the benchmark's model settings file or a privacy pattern below. Every case publishes in full regardless of its source repository's licence class, including copyleft and unverified cases (Sid, 2026-10-12). Briefs, traces and quoted source code are included. When the runner copies a real case's spec, it replaces each em dash in upstream text with a spaced hyphen, as the clean ingest does for quoted upstream text. Publishing preserves punctuation in saved specs and briefs, since they record what the reviewer saw. `--dry-run` packages and unpacks the run without uploading it; only a maintainer uploads.

Publish-run uses these patterns on every packaged file. Entry numbers count nonblank, noncomment patterns.

| Pattern | Applied | Reason |
|---|---|---|
| Public list entry 1, service name | Yes | Identifies a private service. |
| Public list entry 2, service name | Yes | Identifies a private service. |
| Public list entry 3, em dash (U+2014) | No | Typography is a writing rule, and quoted upstream text must retain its punctuation. This is the public list's only punctuation or wording pattern. |
| Every private list entry | Yes | Protects private material. The page does not show these patterns. |
| Generated case secrets | Yes | Prevents planted keys from leaving the machine. |
| Every model settings value of at least eight characters, and each URL host of at least eight characters | Yes | Protects keys, names, hosts and URLs used by the model provider. Values are never printed. |
| This machine's home folder and the cross-platform home-path expression | Yes | Prevents paths under macOS, Linux and Windows home folders from leaving the machine. |

The tracked-files scrub in `scripts/scrub.mjs` still applies every pattern, including typography.

Board numbers can come after a run is published, so they never change its asset. The asset leaves out `outside/`, the folder of the board's own output. The asset's `score.json` leaves out its `outside` block. The scrub still reads the whole `score.json`, because the index entry copies that block. `score.json` names a run folder outside the repository by its relative path, never by an absolute one. On a run that has a `score.json`, `score.mjs --outside aacr` with no other option adds only the `outside` block. It keeps the rest of `score.json`, `outcomes.jsonl` and `unresolved.jsonl` as they are. For a run that already has an index entry, `publish-run.mjs --write-index` changes only the entry's `outside` block and uploads nothing. It refuses a run that packages to another asset than the entry names. Before an `outside` block enters an entry, `publish-run.mjs` computes it again from `outside/aacr`. It refuses a `score.json` whose block differs, such as one edited by hand. `trend.mjs --accept` refuses an entry whose `outside` block differs from the run's `score.json`. A copy fetched from the asset has no board numbers, so accept refuses it for an entry that has them. Accept records the block's hash (`boardHash`) beside the score hash in `benchmark/index/accepted.json`. A board refresh of an accepted entry records it there too. The results script and the trend refuse an accepted entry whose block no longer has that hash.

The 11 runs made before the results left the repository are legacy runs: their index entries say `legacy: true`, carry no intervals and are never accepted as a baseline. Each one's asset also carries, under `_archive/<commit>/`, the scorer of every commit that wrote one of its score files, and `benchmark/legacy/recipes.json` says which scorer and which specs wrote which file and how each number below is read from the runs. After fetching, this rescores a run with its own scorers and checks every number this page quotes from it:

```
node benchmark/legacy/rescore.mjs <run-id>             # or --all, with every legacy run fetched
```

| Run | Index entry | Asset |
|---|---|---|
| The first run | `benchmark/index/runs/2026-10-08-752b77f.json` | [2026-10-08-752b77f.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-08-752b77f.tar.gz) |
| Phase 3, earlier build | `benchmark/index/runs/2026-10-08-588a38c.json` | [2026-10-08-588a38c.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-08-588a38c.tar.gz) |
| Phase 2 | `benchmark/index/runs/2026-10-09-ac9cdae.json` | [2026-10-09-ac9cdae.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-ac9cdae.tar.gz) |
| Phase 2, the retried review | `benchmark/index/runs/2026-10-09-ac9cdae-django-retry.json` | [2026-10-09-ac9cdae-django-retry.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-ac9cdae-django-retry.tar.gz) |
| Phase 3 | `benchmark/index/runs/2026-10-09-95efb19.json` | [2026-10-09-95efb19.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-95efb19.tar.gz) |
| Phase 4a | `benchmark/index/runs/2026-10-09-602a140.json` | [2026-10-09-602a140.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-602a140.tar.gz) |
| Phase 4a, Django with the graph off | `benchmark/index/runs/2026-10-09-602a140-django-graph-off.json` | [2026-10-09-602a140-django-graph-off.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-602a140-django-graph-off.tar.gz) |
| Phase 4b | `benchmark/index/runs/2026-10-09-881318b.json` | [2026-10-09-881318b.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-881318b.tar.gz) |
| Graph off, 18 cases (not quoted here) | `benchmark/index/runs/2026-10-09-4850f66.json` | [2026-10-09-4850f66.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-4850f66.tar.gz) |
| Wave 1 | `benchmark/index/runs/2026-10-09-5227579.json` | [2026-10-09-5227579.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-5227579.tar.gz) |
| Wave 1 review fixes | `benchmark/index/runs/2026-10-09-4a7d198.json` | [2026-10-09-4a7d198.tar.gz](https://github.com/openqodex/openqodex/releases/download/benchmark-data/2026-10-09-4a7d198.tar.gz) |

## Compare two builds

```
node benchmark/score.mjs benchmark/results/<new> --against benchmark/results/<old>
```

A published run is fetched first with `node benchmark/fetch-run.mjs <run-id>`.

The comparison first lists anything that differs besides the build: every reviewer with its version and model, the machine, the concurrency, web access, the timeout, the cases and their specs, the repeats. A different model is not a product change. It scores both runs with the same rules, then shows issue recall, the precision bounds, clean controls, reviews that failed or never started, graph disclosure, time and cost per configuration, before and after, and lists regressions: a planted bug missed in two or more reviews of a configuration, more often than before, or more clean changes with findings. One missed review is a reason to look; two are a bug.

`score.mjs` exits 0 when it scored, 1 when the comparison shows a regression, and 2 when a folder cannot be scored. The exit code is information. Do not gate a release on it alone: a person reads the regression and the reviews behind it.

`--against` reads the older run's specs from that run's own `cases/` folder. The scorer refuses specs that lack the words each plant now needs, so `--against` cannot compare a run made before the words existed, such as `2026-10-08-752b77f`. Score such a run alone with the newer run's specs, then read the two summaries side by side:

```
node benchmark/score.mjs benchmark/results/<old> --specs benchmark/results/<new>/cases
```

This scores the old run's saved reviews against the newer specs. It writes `score-cases.json` and `outcomes-cases.jsonl` into the old run's folder (for a legacy run, into the folder `--out <folder>` names) and names every case whose specs differ from that run's own. Such a case compares fairly only when the code under review is the same in both runs. When the case's code changed, as the Rails case's did after the first run, the old reviews read other code, and that case's numbers do not compare.

## Replays

Three replays use saved reviewer submissions without calling a reviewer:

- `threshold` shows findings down to info severity at the product's confidence floor.
- `union` merges repeats 1 and 2 for each case and configuration, counting each planted bug once. It needs more than one repeat: both repeats must be saved for every case, or it reports `insufficient repeats`.
- `floor` compares confidence floors of 0.6, 0.7, 0.8 and 0.9. A lens's higher floor still applies.

They import the product's own `checkSubmission` and `mergeFindings` from the built packages. Counts use the planted matching rules, without human rulings. They never write into a run folder: output is printed, and optional `--out <file>` must name a file outside the run folders.

```
node benchmark/loop/replay.mjs threshold benchmark/results/<run>
node benchmark/loop/replay.mjs union benchmark/results/<run>
node benchmark/loop/replay.mjs floor benchmark/results/<run>
```

Each command accepts more runs; `--specs <folder>` follows the run it applies to.

Saved inventory lengths take priority. Missing lengths come from `buildCase` in `lib/cases.mjs`, using the supplied specs and source folders pinned to the run's build commit (or source folders saved beside the specs). The replay builds each planted case once per run in a temporary folder outside any repository and removes that folder afterwards. It hashes the built head files by path and content, without modes, and compares them with a reference built from the recorded case. It computes both legacy case hash rules, with and without executable modes, when checking the manifest. A missing manifest hash uses the pinned source as the reference. Scoring amendments and mode changes are accepted when built content matches; different content refuses the case by name.

Line counts follow `snapshot.ts`'s `lineCounter`: count LF bytes and add one for a nonempty final line without LF, for files up to 5 MiB. That helper is not exported. In core's `finalize.ts`, `citesChange` and `checkSubmission` consume these counts to check findings and dropped citations. A pull request case stays unresolved with a reason because this branch has no pull request builder through the clone cache.

## Scanner-only runs

```
node benchmark/build-cli.mjs
node benchmark/run.mjs --mode scan --check-identical                  # every case, scanners only, twice
node benchmark/run.mjs --mode scan --cases a,b --scanner-config <file>
node benchmark/run.mjs --mode scan --suite aacr --subset dev-smoke     # pull request cases, scanners only
```

A scanner-only run runs `openqodex scan --report-dir <sample>/report --no-install` on each case, one at a time, with no reviewer and no model, so it needs no account and spends nothing. It runs in an OpenQodex home of its own: its tool folders are links to the scanners you installed (`$OPENQODEX_HOME/tools`, or `~/.openqodex/tools`), and its approvals and caches are its own. Before the first scan, `openqodex doctor --json` lists every scanner. The run refuses to start when one is not installed. `--allow-missing-scanners` runs without them, and the manifest names each one (`scannersMissing`, with `scannersComplete: false`). A Mac without Ruby, Go or Cargo needs the flag for brakeman, rubocop, golangci and cargo-deny.

Each candidate a scan hands the reviewer is scored against the case's spec by its lines. On a planted bug's lines, it finds the bug when the bug's expected finders name its scanner (or a scanner whose finding was merged into it), or when its rule id or message names one of the bug's words. A later candidate on a bug already found counts as redundancy, never against precision. A candidate on a bug's lines that meets neither test finds nothing and stays unresolved. Every candidate on a clean change is false. The run writes `score.json` under the scan rules (`rules.kind` is `scan`) and `outcomes.jsonl` with one line per candidate.

A pull request case (`--suite aacr`, with `--subset` or `--cases`, as for model reviews) is built from the clone cache in the shape a developer has before a push, and removed after its scan. Its comments name no scanner and no words, so no candidate finds one: a candidate on a comment's lines is unresolved, and the number to read is the location diagnostic, AACR's line rule, as recall over the accepted comments. Pull request cases need their dataset files in the cache (`node benchmark/ingest/aacr.mjs` fetches them); a run never fetches them itself.

The manifest's `external` records what the scans used besides the build: the scanner toolchain hash and versions, the Semgrep rule packs each sample read (by name and the sha256 of their rules, as `scanners` documents), and a hash of what osv-scanner got from osv.dev. Nothing is downloaded again to record them. When two samples read different rules of one pack, the packs are `mixed`, and the accept step refuses the run; `unknown` (a sample recorded no packs) is refused for a scanner-only run too. A comparison of two runs lists a difference there as an input, not as a product change.

The `bench-scan` job in `.github/workflows/ci.yml` runs the planted cases this way in two passes (`--check-identical`), with every scanner installed, and compares the run with the accepted scanner-only run on main (`trend.mjs --against-run`). It runs in the merge queue, on each push to main, and on a pull request that carries the label `full-ci`. A pull request that changes the scanner-only score adds that label, downloads the run from the job's artifact, accepts it with `trend.mjs --accept` and commits the entry. Accept the pull request's run, not a merge queue run: a merge queue run names a commit that main gets only when the queue merges it.

Every Monday, `.github/workflows/bench-weekly.yml` scans AACR-Bench's `dev-smoke` pull requests twice in CI, with every scanner installed (the same setup as the `bench-scan` job, `.github/actions/bench-setup`). It compares the run with the accepted scanner-only run of its group, writes the trend table with each run's location recall into the job summary, and keeps the run folders and the run's index entry as an artifact for 14 days. The clone cache and AACR-Bench's two data files (`node benchmark/ingest/aacr.mjs --data-only`, which fetches nothing else and writes nothing in the repository) are kept in the Actions cache, keyed on the suite, its split and the board pins. The job has an hour: every step before the trend has its own limit (the dev-smoke scan 12 minutes, the full pass 14), so at least 8 minutes stay for the trend, the summary and the artifact, which run after a cancel too. A manual run (`gh workflow run bench-weekly.yml -f full-dev=true`) also scans every development pull request in one pass, scored in the summary and neither compared nor indexed. Until a person accepts the first AACR scanner-only entry from the artifact, the trend step fails: a group with nothing accepted cannot be judged.

`--check-identical` runs a second pass on the same build into `<out>-pass2`, with fresh case repositories, and compares the two scores and every sample's files with the time fields left out. Each Semgrep pack's raw size is left out too: the registry serves one rule set as JSON or as YAML, and the sha256 of the rules is compared instead. `identical.json` in both folders holds the result and the minutes each pass took. The run exits 3 when the passes differ, and says whether their inputs differed or the product's output did.

`--scanner-config <file>` passes `--config <file>` to every scan. The run first runs `openqodex trust --yes` with that file in its own home, for the one repository path each case is built at in turn, and does not start when the trust step fails. The manifest records the file's sha256 and every custom scanner the step approved.

## The release check

```
node benchmark/build-cli.mjs
node benchmark/release-check.mjs                                      # the published package against this checkout, scanners only
node benchmark/release-check.mjs --base npm:0.12.0 --candidate file:openqodex-0.13.0.tgz
node benchmark/release-check.mjs --reviewers claude --max-usd 15 --max-minutes 120
```

Before every release, `release-check.mjs` compares the published package with the build about to be released, on the same cases: the planted cases and AACR-Bench's development subset `dev-laptop`. The base is the version npm's latest tag names, read from https://registry.npmjs.org itself; the candidate is this checkout's build. `--base` and `--candidate` take any `--package` value of `run.mjs`, so a release candidate packed with `npm pack` is `file:<path.tgz>`. `--suites planted` checks the planted cases alone, `--subset` names another AACR subset, and `--cases` names cases of one suite.

Each build runs the scanner-only benchmark twice (`run.mjs --mode scan --check-identical`), with no reviewer and no model, so the check spends nothing. The two builds' scores are compared case by case, the way the `bench-scan` job compares a run with its accepted run: a scanner-only score does not vary from run to run, so every planted bug the published package found and the build misses, every clean control lost, every extra false or unresolved candidate and every scan lost is a loss, whatever its size. The reverse of each is a gain. Inputs that differ between the two runs (a scanner a build pins at another version, other Semgrep rule packs, other osv.dev data) are listed as notes. When the packs differ and something was lost, run the check again before reading the loss as the product's.

Both builds must run the same scanners, or a scanner's bugs would read as lost or gained. `--install-scanners` first runs each build's own `doctor --install --all-scanners`, so a scanner one build pins at another version is installed for both. On a machine that cannot install some scanners (no Ruby, Go or Cargo), `--allow-missing-scanners` runs without them; both builds must then miss the same ones, and the report names them as compared by neither. The scanner pins are part of each package, so a build that pins a scanner at another version is judged with that version: a loss it brings is a loss for the people who install the release, and the report lists each pin that differs.

The install step and the scanner-only runs get a small environment: what node, git and tar need, `HOME`, the OpenQodex home, the benchmark cache, and the Go, Cargo and Ruby variables the scanners' runtimes read. No API key, token or cloud variable of yours reaches the published package's code there. Review runs keep your environment, because the reviewers need their accounts.

`--reviewers` adds review runs, which the caller names and pays for. Each build reviews each suite those reviewers review (Claude Code and Codex the planted cases, model reviewers every suite named), and `--max-usd`, `--max-minutes`, `--review-max-usd` and `--repeat` go to each of those runs as given. The two runs are compared by `loop/compare.mjs`. A gate metric is a loss when its change is in the worse direction and, by `decide.mjs`'s guard rule, past the acceptable loss `benchmark/loop/levers.json` declares for it (2 points of recall or precision, 15% of the base's cost per review, 20% of its time), or when a hard rule breaks. A change the comparison cannot rule out at that size is a note. A gate metric one build measures and the other does not (reviews with no cost on one side) cannot be compared: the check exits 2 naming it, or 1 when it also shows a loss. The published 0.12.0 cannot review with a model (see `--package` above), so `--reviewers model:<id>` against it ends with exit 2.

The check writes `release-check.md` (the report it also prints) and `release-check.json` into `--out` (by default `benchmark/results/<date>-release-check-<base>-<candidate>`), beside each run's folder and its log under `logs/`. `--summary <file>` appends the report to that file, such as a CI job summary. It exits 0 when nothing changed or the build gained (or changed in a way that is neither), 1 with each loss named, and 2 when it could not run: a package that is not there, a run that failed or stopped, two passes that differ, or runs that cannot be compared. On 2 the report says nothing was concluded, never "no change".

The release workflow runs the check on the planted cases before every publish: its `release-check` job works only on a push that publishes (no changeset waits and the version is not on npm yet), installs every scanner both builds pin, and the publishing job waits on it, so any exit but 0 refuses the publish. The job has no secret, a token that can only read and no Actions cache, because it runs the published package's code. The AACR subset is a step of the release checklist in `CONTRIBUTING.md`: its clones and dataset files do not fit the job.

## The wording pass

```
node benchmark/judge.mjs benchmark/results/<run> [--configs a,b] [--limit N] [--resume] [--specs <folder>]
```

A model reads each finding that the script matched to a planted bug, with the bug's planted truth, and says whether its problem, consequence and fix sentences are plain and correct. It judges wording only, never whether the bug was found. It writes `judge.json`, with each review's verdicts, its cost and the model that answered, and prints a table. `score.mjs` copies the totals into each configuration's `wording` in `score.json`. No rule reads them, so the verdict never changes a hit, a count, an exit code or an accept.

The judge is the deployment `benchmark/outside/boards.json` gives the wording role (GPT-5.2), called through the model adapter on the endpoint in `~/.config/openqodex-bench/azure.env` (or the file `OPENQODEX_BENCH_MODEL_ENV` names). Without that file the pass refuses in one line and calls nothing; it never falls back to other settings in the environment. Every call holds its worst case against the run's `--max-usd` in `budget.jsonl` before it is sent, and the pass stops when the cap has no room for the next call; a run that records no cap, such as a legacy run, cannot be judged. A failed call stops the pass and keeps its reservation as spent. Each answer is saved in `judge-raw/` before its verdict goes into `judge.json`, and every file is written beside its place and renamed into it, so a pass cut off part way keeps the last whole `judge.json`. `--resume` judges only the reviews `judge.json` lacks, and takes an answer `judge-raw/` already holds for the same model and findings without calling or charging again; without it an existing `judge.json` or `judge-raw/` is refused. One judge works on a run at a time: it holds `judge.lock` in the run folder, and a second one is refused. Exit codes: 0 judged, 1 stopped by the cap, a failed call or a failed write, 2 refused before any call. The legacy run `2026-10-08-752b77f` keeps the verdicts `claude-sonnet-5` gave it.

## AACR-Bench's own evaluator

```
benchmark/outside/boards/aacr.sh --prepare                        # their pinned checkout and its venv, once
benchmark/outside/boards/aacr.sh benchmark/results/<run> --dry-run
benchmark/outside/boards/aacr.sh benchmark/results/<run> [--rounds 3]
node benchmark/score.mjs benchmark/results/<run> --outside aacr
```

A review run of AACR cases can also be scored by AACR-Bench's own evaluation code, at the commit `benchmark/outside/boards.json` pins. `benchmark/outside/convert/aacr.mjs` writes each planned review's first attempt as one file per pull request, in the shape their reader for generic comments takes, under `<run>/outside/aacr/<config>/r<repeat>/`. The board's tool name is `openqodex-<config>-r<repeat>`. Every shown finding that passes the board conversion rule below is written once, with the path and line range our scorer reads. A finding with no line keeps null lines, which their evaluator reads as the whole file. A failed or never-started review is written as an empty file, so it stays in their denominators. The converter refuses a run of another suite, a sample of a case outside AACR-Bench, a held-out case, and a case whose licence is not verified, before it writes anything. Every board step writes only in `<run>/outside/aacr/`, and refuses a link that leads out of the run.

The AACR converter leaves out each finding that only asks for a test. Such a finding has the kind `maintainability` or `style`, and its title asks for a test or for coverage. The flag `excludeTestGaps` in `benchmark/outside/boards.json` turns the rule on; a board without the flag keeps every finding. `convert.json` records the flag and the number left out, in total and per folder. `score.mjs --outside aacr` compares their line counts with ours on the same reduced set. AACR's flag is true: only one of its 256 golden comments suggests a test, after a code concern. Martian's flag is false: 4 of its 173 golden comments have the category `test_gap`. Its converter does not read the flag. The reviewer, the saved reports and our own score keep every finding.

Their evaluator takes each reference comment in order and finds the first unused finding on the same path and side whose lines overlap or lie within one line. It then asks a judge whether the two say the same thing. The judge is the GPT-5.2 deployment that boards.json names for AACR. `benchmark/outside/boards/aacr-judge.mjs` reads the endpoint's base URL and key with `lib/model-env.mjs`, and starts a relay on 127.0.0.1 at a free port. Their evaluator receives the relay URL as JUDGE_BASE_URL and a random placeholder as JUDGE_API_KEY; the real key stays in the relay process. The relay answers 401 to a request without that placeholder as its bearer token, and forwards nothing for it. The relay removes the top-level `chat_template_kwargs`, `temperature` and `top_p` fields and renames `max_tokens` to `max_completion_tokens`, because Azure's GPT-5.2 reasoning model rejects the vLLM option and nondefault sampling parameters. This uses the model's default sampling instead of AACR's temperature 0.7 and top_p 0.95, preserves the token limit and other request body bytes, and forwards to the configured Azure base URL with the key in the `api-key` header, and returns the upstream response unchanged. It stops when evaluation ends. A startup chat call through the relay checks the judge before round 1; a bind failure or a failed startup call, including 401 or 404, stops the wrapper with exit 2 and one line naming the status and upstream error message with endpoint secrets hidden. `eval.json` records `relay` with `relay: true`, `requests`, `stripped`, `parameterChanges` (counts by original field name) and `upstreamStatuses`, including the startup call. The relay logs no body, header or key. A dry run names the relay and its parameter changes, and starts nothing. The base URL and key never go into argv, a shell variable, a log or a file. A filter on each output stream hides them in everything their evaluator prints. It holds back a possible start of a secret until the next chunk, and it also hides URL-encoded forms. AACR and Martian share these checks and filters in `benchmark/lib/board-files.mjs`. Their client sends only the placeholder as a bearer token to the local relay. Their evaluator runs with core files off, so a crash cannot write the key anywhere. Their mock judge is never used: the wrapper refuses JUDGE_USE_MOCK and a `.env` in their checkout, and `eval.json` records the judge mode their evaluator printed and every failed judge call. The wrapper hashes every working file against the pinned tree, including edits hidden from git by assume-unchanged and ignored files. It checks an existing checkout on a dry run too. `--prepare` builds their venv beside the checkout (`aacr-bench@<commit>.venv`), so the checkout holds only the pinned tree. A checkout with a venv inside it is refused: move it to the Trash and run `--prepare` again. It checks saved files for encoded secrets and secrets split by line breaks. `eval.json` records the checkout commit and tree. The bench cache, which holds their checkout and its venv, must lie outside this repository.

`score.mjs --outside aacr` adds `outside.aacr` to score.json and changes nothing else in it. The block holds their line and semantic precision, recall and F1 per configuration and repeat, and the noise rate (unmatched findings over generated ones, as their docs/metrics.md defines it). It also holds the share of references on the left side, which no finding can match by line, since their reader puts every finding on the right side. Semantic numbers are reported only for a folder that the wrapper evaluated with a model and no failed judge call. Their line counts are compared with our location numbers: on the same files they are equal, and theirs can be lower only where the judge's yes on a finding that an earlier reference took by line ends a reference's search. Nothing in the block decides an accept.

## Why scanner candidates were dropped

```
node benchmark/drops.mjs <run>... [--audit N] [--seed S] [--json]
```

A script puts each scanner candidate the reviewer dropped into one class, from the saved files only. The first class that fits wins, and the candidate's rule, path and cited line are read before the reason's words:

| Class | When | Points at |
| --- | --- | --- |
| config-owned | a settings-file or suppression candidate, or a reason that starts with `repo instructions:` | nothing, unless all of at least 20 are dropped |
| fixture | a path the scan's fixture filter matches, or a reason about fixture, sample or placeholder data | a missing fixture pattern |
| test | a test path, or a reason about a test file or an assert | that rule's adapter, skipped in test paths |
| duplicate | the reason names another candidate, cites a raised candidate's line away from its own, or says it repeats one | dedup |
| out-of-change | the reason says the code is not part of the change | the changed-line filter |
| low-value | style, a nitpick, size, hygiene, no impact | the rule's default or severity |
| rule-fp | anything else: the rule was wrong here | the rule, when one rule holds many |

A drop of any class is tagged `framework-mismatch` when its reason names a framework the scan can detect and found in no project of the change. Flask is detected but never tagged: a scan saved before Flask was detected records a Flask project with no framework. The script prints the counts per run and the rule false positives by rule. `--audit N` prints instead N drops drawn at random (seed 1 unless `--seed` names another) from every run given, as a sheet for a person to rule on. The sheet names no run, build, configuration or case.

## What each scanner contributed

```
node benchmark/scanners.mjs <run> [--specs <folder>] [--out <folder>] [--json]
node benchmark/scanners.mjs <run> --against <baseline> [--specs <folder>] [--input-change pin-bump:<scanner>|semgrep-packs]
        [--decisions <file>] [--change <SC-id>] [--ledger <file>]
```

A script reads each planned job's first attempt that saved a `scan.json`, in a review run or a scanner-only run, and prints six tables: each scanner (what it raised, what each filter and the reviewer did with it, the truth it found), each rule, the drop classes above, the gaps by language and class, the time, and what the ensemble loses without each scanner. It writes them to `scanners.json` in the run folder, or in the folder `--out` names. A legacy run's folder is the published original, so its `scanners.json` is written only with `--out`. `--specs` applies to the run named before it, as in `causes.mjs`.

- A scanner finds a truth item when one of its candidates sits on the item's lines and either the spec expects that scanner or the candidate's rule or message names the item's words. This is the scanner-only scorer's rule. A finding that dedup merged into another scanner's candidate counts for its own scanner, at the lines the scan's trail recorded for it. Where the scan saved no trail, it is placed at the candidate's lines, and the tables say how many were placed so. A candidate on the lines that names nothing of the item is a location match: shown in its own column, never counted as finding it.
- Counts are (sample, truth item) pairs. Every ratio is summed hits over summed checks, never an average of ratios, and every time carries its sample count.
- Unique: a scanner found the item and no other scanner did. Leave one out: the items only that scanner found, and its candidates that absorbed no other scanner's finding.
- The remit is the files the scan handed the scanner (the scan's `selection`), for items on lines the change touched. A miss is an item in the remit of a scanner that ran and did not find it. An item in the remit of a scanner that did not run (not installed, failed, disabled) is an infra miss, counted apart. A scan saved before the selection existed leaves the remit unknown, and the table says so rather than guess.
- A rule meets the default-off bar with at least 30 kept candidates, at least 90% of them dropped, from at least 3 repositories, and no truth item found. Evidence from planted cases alone is provisional.
- A language is a gap when it has at least 10 reachable truth items (or 5% of the run's) and no scanner but semgrep or gitleaks has any in its remit, or those scanners find under 30% of the ones in their remit.

Runs saved before the scan recorded `selection`, `trail`, `stages` and `timings` still print. The script names what they lack first, and reads the scanner stage's time as the slowest scanner's.

`--against <baseline>` judges the run as a change to the scanners. It exits 2, and judges nothing, when either run is from the test split, when the runs differ in suite or mode, when their Semgrep rule packs or scanner toolchains differ or are not recorded, when a scanner did not run where truth lies or may lie in its remit (a scanner a scan names no status for, in a scan that recorded no selection, counts as one that did not run), or when a planned scan is missing. One input may differ: the one the change under test names with `--input-change`, either a version bump of one scanner (`pin-bump:<scanner>`) or the pack list (`semgrep-packs`). A pin bump is checked entry by entry: the script reads the toolchain table and lock files of each run's build commit with git, checks that they hash to the toolchain hash the run recorded, and refuses when any entry or lock file other than the named scanner's differs. Otherwise it applies the first clause of the keep rule, K1. K1 holds when every truth item the baseline found is still found in every sample. A location match on a lost item's lines does not keep it. Then it hands both runs to the acceptance rule in `benchmark/loop/decide.mjs` for the other clauses (a gain, the guards, and a review run), as [The acceptance rule](#the-acceptance-rule) describes under the scanner variant. It reads the rulings of the adjudication file (`--decisions`, `benchmark/review-queue/decisions.jsonl` by default). `--change <SC-id>` reads the change's record from the scanner ledger (`--ledger`, `benchmark/index/ledger/scanner.jsonl` by default) for its time loss and its review run, and refuses when the record names other runs. The script writes no ledger line. It exits 1 when the change is reverted (K1 fails, a removed candidate is ruled a real issue, a guard or the review run fails) and names why, and 0 otherwise: kept, pending rulings, pending the review run, or undecided.

A test-split run prints its tables only with `--release <version>` naming its own release, and is never judged.

## The review queue

A finding that no frozen spec decides (one the case does not list, a near miss, a wrong kind) stays unresolved, however often it recurs: precision counts it wrong in its lower bound and right in its upper. Only a person's ruling moves it.

```
node benchmark/score.mjs <run>                       # also writes unresolved.jsonl
node benchmark/queue.mjs add <run>                   # merges it into benchmark/review-queue/<suite>.jsonl
node benchmark/queue.mjs add --candidates <run>      # the run's scanner candidates that no review raised
node benchmark/queue.mjs sheet <suite> [--seed S]    # the blind sheet, as markdown or with --json
node benchmark/queue.mjs decide <status> <target>... --by <your name> [--note <text>] [--sheet <id>]
node benchmark/queue.mjs decide same-issue <ref> --bug <truth id> --by <your name>
node benchmark/queue.mjs decide confirmed|disputed <case id> --bug <truth id> --run <run> [--specs <folder>] --by <your name>
```

- A finding is the same finding across runs only when its case, its lines and its words (title, problem, consequence, fix) are the same; its id is their sha256. A finding from before those fields existed adds its description and suggested change. Two findings become one issue only when a person consolidates them. A shared line, category, rule or recurrence never groups findings and never carries a ruling from one to another.
- An unresolved finding within one line of a truth item's lines is a location match: `outcomes.jsonl` names the item with `evidenceKind: "location-only"`, and it finds the item only when a person rules it the same issue.
- The queue keeps one item per finding: its words, the code at its lines and the change around them as the reviewer's brief showed them (only the code's sha256 when the case's licence is not permissive), the truth item it sits on, and every run, configuration and review it appeared in. `add` refuses a held-out run and drops every question a ruling has answered.
- `add --candidates <run>` queues the scanner candidates that no review raised and that no frozen evidence decides: every unresolved candidate of a scanner-only run, and each candidate a review dropped. A candidate that finds a truth item, and every candidate on a clean change, is decided already and is not queued. A candidate's identity is its case, its scanner and rule, its file, its lines and its message. Its item holds the message, the place, the rule's link, and the code at its lines from the case built from the live tree, when the run scanned that very case. It never holds the reviewer's reason for a drop. The sheet shows a candidate like a finding, with its rule and message in place of the four parts, and a person rules it the same way, by its ref: `true`, `false`, `same-issue` or `different-issue`, one candidate at a time (never consolidated). Each ruling on a candidate names the version of the case's spec it was scored against (the sha256 of the spec), because a revised spec may list an issue on the candidate's lines: a ruling counts only for that version, and the candidate asks again under another. A planted run whose manifest names a case other than by a planted case name (lower case letters, digits and dashes) is refused before anything is read or built from it.
- The sheet shows the case, the finding, the code and the truth item, in an order drawn from the seed it prints. It shows no run, build, configuration or count, and its text goes through the drop audit's redactor.
- A ruling on a truth item (`same-issue`, `different-issue`, `confirmed`, `disputed`) judges that item as one version of the case's spec writes it, so it records that version: the sha256 of the spec's JSON with its keys sorted. It counts only when a run is scored against a spec with that hash. A case is edited by making a new version, and a truth item that was wrong in one version can be right in the next. A queue item carries the version it was scored against; a bug ruling takes it from the run `--run` names, from the run's own copy of the spec or from the folder `--specs` names. A line without a version counts for none and is listed as ignored.
- A finding can be a truth item that it does not sit on, as when a review reports a missing admin check at the action it exposes rather than at the line that removed the check. `decide same-issue <ref> --bug <truth id>` joins them. `decide` records the ruling only when the item is in the finding's own file, in the spec version the finding was scored against, and the finding sits on a line the change added. The scorer then counts the finding as that item's hit.
- `decide` appends one line to `benchmark/review-queue/decisions.jsonl`, the adjudication file: the target, the status, the person's name, the time, the note and the code the person read. It refuses a name that `benchmark/review-queue/people.json` does not list, and any name with a word that names a model, an agent or a tool: a model never rules. The scorer ignores such a line too and lists it. A person adds a name to `people.json` by hand, in a reviewed pull request.

| Status | Target | Effect on the score |
|---|---|---|
| `same-issue`, `different-issue` | a finding and the truth item it sits on, or for same-issue one `--bug` names in the finding's file | same-issue: the finding finds that item, in recall and precision; different-issue: it never does; either on that spec version only |
| `true`, `false` (or `spec-candidate-accepted`, `spec-candidate-rejected`) | a finding, or an issue a person consolidated | correct or wrong in precision, in every later scoring of that case |
| `consolidate` | two or more findings of one case | one issue in unique-issue precision and redundancy; a ruling on the issue applies to each finding |
| `confirmed`, `disputed` | a truth item of a case, in the spec version of the run `--run` names | labelled in the score's per-bug results on that spec version; recall is unchanged, since a wrong truth item is fixed by a new case version |
| `clean`, `not-clean` | a candidate clean control | the latest ruling decides whether `clean.mjs admit` puts the candidate in the clean suite, and every read of that suite refuses an entry without a standing `clean` ruling; the scorer does not read it |

A ruling acts only on a finding no frozen spec decides: a planted hit, a listed side issue or a finding on a clean case stays as the spec says. The latest line for a target wins. Each score records the adjudication file's sha256 as `decisionsHash`; `score.mjs --decisions <file>` reads another file.

## Submitting to a board

```bash
node benchmark/outside/submit/aacr.mjs <accepted-aacr-run> --out benchmark/results/submit-aacr
node benchmark/outside/submit/martian.mjs <accepted-martian-run> --out benchmark/results/submit-martian
```

AACR writes `submissions/openqodex-<configuration>-r<repeat>/meta.yaml` and `results/<instance_id>.json`, one submission per repeat. Metadata names OpenQodex, the configuration, the run's commit and version, and our local judge as `local_judge_mode` and `local_judge_model`. Comments, time and token counts come from the saved conversion. A missing time or token count stops the export. Its leaderboard allows partial coverage but scores missing samples against the full dataset. The accepted development run covers part of that dataset.

Martian writes `benchmark_data.json` and a judge model folder holding `candidates.json`, `evaluations.json` and `dedup_groups.json`, preserving the saved pipeline output. Until an accepted Martian release run exists, use `benchmark/outside/fixtures/martian` as the input. That output is marked as synthetic fixtures with a stand-in judge. It is not a leaderboard score. Martian's maintainers run their own pipeline for leaderboard inclusion, as described in their [README](https://github.com/withmartian/code-review-benchmark#inclusion-criteria).

Both commands validate their output. Run either script with `--check <output-folder>` to check it again. `submission.json` records provenance and expected files. An existing output folder is refused. These commands call no model, send nothing and open no pull request. A person sends a submission by hand.

## Martian's offline set

Martian's Code Review Bench (https://github.com/withmartian/code-review-benchmark, MIT) publishes 50 pull requests from cal.com, Discourse, Grafana, Keycloak and Sentry, some of them copies with bugs injected, and 173 golden comments: prose with a severity and a category, and no file or line. In this benchmark they are the `martian` suite, origin `injected`.

```
node benchmark/ingest/martian.mjs [--offline]
```

- The ingest reads the five golden files only from their pinned URLs at commit `e616e84` (`benchmark/outside/boards.json`) and stops when a file's sha256 is not its pin. It asks GitHub for each pull request's base and head commits and freezes them, and checks each repository's licence the way the AACR ingest does. It writes `benchmark/suites/martian/cases.json` (links, commits, licences and hashes; no golden comment's text), `benchmark/suites/martian/ingest-report.txt` (every exclusion with its reason) and `benchmark/splits/martian-v1.json`.
- Every Martian pull request is held out. Its golden comments are public, so tuning on them is contamination. A request for its development cases is refused, and so is a split file that places one there.
- At this pin, all 50 pull requests are usable. GitHub names no licence it can classify for Sentry's licence file (NOASSERTION), so Sentry's 10 carry the licence class `unverified`, with a person's reading of that file noted beside it (FSL-1.1-Apache-2.0). Runs publish in full even with unverified cases. Outside converters and board submissions still refuse unverified cases (`publishRefusal` in `benchmark/lib/licence.mjs`). The AACR ingest uses the same licence classes. A pull request with no licence file is still excluded.
- Martian's own pipeline judges a run: it extracts issues from the findings, groups duplicates, judges each against the golden comments, and sums the totals. `readMartianEvaluation` in `benchmark/lib/score.mjs` reads that result back. It keeps Martian's candidate ids, extraction provenance, matches and official totals unchanged. Beside them it adds its own counts: golden comments found, findings matched, and the severity of the first finding behind each found golden comment against the golden severity (Critical critical, High major, Medium minor, Low nitpick). It refuses a finding saved for the judge without a title, problem, consequence or fix. It also refuses official totals that lack any field of Martian's shape, a match that links a candidate of one pull request to a golden comment of another, and matches that name fewer golden comments than the official totals count.
- No Martian run is scored yet.

### Scoring a run with Martian's pipeline

```
benchmark/outside/boards/martian.sh --prepare
benchmark/outside/boards/martian.sh <run> [--dry-run]
```

- `--prepare` fetches Martian's repository at the pinned commit into the bench cache (`$OPENQODEX_BENCH_CACHE/upstream/code-review-benchmark@<commit>`). It builds the venv beside the checkout (`code-review-benchmark@<commit>.venv`) with uv, Python 3.11 and their lock file, so the checkout holds only the pinned tree. The script refuses the cache, the checkout or the venv when its real path lies inside this repository, a link under the cache included.
- The converter (`benchmark/outside/convert/martian.mjs`) runs first. It converts only a release run. A release run's manifest names its `release`, and it reviewed the published package of that release (`run.mjs --package npm:<release>`). The converter asks the npm registry, at its fixed address, for that version's integrity again, and refuses a mismatch. A local build is never a release run. Every Martian case is held out, and this converter is the one path that reads their golden comments. Each conversion appends a line to `benchmark/index/heldout-access.jsonl` before it reads any golden comment. `convert.json` records that line and the sha256 of the manifest it converted. The converter refuses a smoke run, a case whose licence is unverified, a configuration with the graph off, and two configurations that would share a tool name.
- It writes `<run>/outside/martian/benchmark_data.json` in Martian's own input shape. Each pull request is keyed by its golden URL and holds the pinned golden comments. It holds one review per tool name, `openqodex-<config>-r<repeat>`: library for a model reviewer, cli-claude for Claude Code, cli-codex for Codex. Each finding shown to the developer is one comment, whose body is one paragraph: `{title}. {problem} {consequence} Fix: {fix}`. A review that failed or never started is sent with no comment, so its pull request stays in Martian's counts. A finding that lacks a title, problem, consequence or fix is held, not dropped: `convert.json` names it and what it lacks. No review of that tool name is sent.
- Before it judges, the wrapper checks three things. The run's manifest must hash to the sha256 `convert.json` recorded. The access line `convert.json` recorded must be in the access log. The release gate, the registry question included, runs again. It then runs Martian's steps 2, 2.5 and 3 and `score_profiles` on those entries, in `<run>/outside/martian/work`. Their code is never patched. Every working file of the checkout must hash to the blob the pinned commit's tree holds, and no other file may be there. That check reads the files themselves, not git's index. The judge is the deployment `boards.json` names for Martian (GPT-5.2). The base URL and key come from `lib/model-env.mjs` and go only into the environment of the three steps that call the judge. Each output stream passes through a filter of its own, which holds back a possible start of a secret until the next chunk and also replaces URL-encoded forms. `pipeline.log` is written only through it. Afterwards the wrapper checks every file it wrote for the key and URL, also with line breaks taken out. Core files are off. `--dry-run` prints the commands with the values hidden and starts nothing. Martian's client sends the key as a bearer token (`Authorization: Bearer`), not in an `api-key` header; the first judged run checks that the endpoint takes it.
- It writes `<run>/outside/martian/<tool>/evaluation.json` per tool name, in the shape `readMartianEvaluation` reads, and `eval.json` with the checkout's commit and tree, each step's exit code, the candidates per finding, and the problems. A tool name gets no evaluation when one of its reviews was judged on something other than its extracted candidates, has no dedup groups, was never judged, or has a failed judge call. The same holds for every tool name when the dedup step fell back to no grouping.
- A script, not a model, links each candidate Martian extracted to the finding it came from: the finding whose text holds the longest run of the candidate's words. That link feeds only our own counts beside the official ones.
- `benchmark/outside/fixtures/martian/` holds three saved reviews of pull requests that a golden file written for the tests describes. It holds no Martian pull request. It also holds the entries the converter writes for them, and what Martian's pipeline wrote for them with a stand-in judge.

## Clean controls from real pull requests

A clean control is a real change with nothing a reviewer should raise: a review of it should end with no finding. The `clean` suite holds real pull requests that a person ruled clean. Every case is in the development split, and a run selects it with `--suite clean`.

```
node benchmark/ingest/clean.mjs list [--offline]     # candidates and their evidence
node benchmark/ingest/clean.mjs sheet [--seed S]     # the candidates for a person, with the commands to rule
node benchmark/queue.mjs decide clean|not-clean <case id> --by <your name> --sheet clean@S@<version>
node benchmark/ingest/clean.mjs admit                # the suite, from the rulings
```

- `list` takes pull requests from the development repository groups of the AACR split only. It reads GitHub through `gh api` and caches every answer. In each group, it takes the pull requests merged into the default branch from 2026-01-01 to 2026-03-31 in a seeded order, and lists at most 2 (checking at most 12).
- A pull request is a candidate when it passes every check. It is not by a bot. It changes as many lines as AACR's usable cases, from the fewest to the most. Someone other than its author reviewed it, and no review asked for changes. Its licence is usable. In the 90 days after its merge:
  - no later commit or linking issue or pull request names it as a fix, revert or follow-up on the line that names it (its quoted title aside, so a backport or release-note line does not count, and a fix word on another line is about something else), and no linking issue or pull request is labelled as a bug;
  - none of its files is renamed (a later fix under the new name would be missed);
  - no later commit on the default branch changes, removes or inserts next to one of its lines, whatever its message says.
- `list` reads every later commit on the pull request's files. To place the pull request's lines in a commit's parent, it diffs the file at the pull request's head against that parent. A line it cannot follow excludes the pull request, unless GitHub's compare shows that the parent does not hold the pull request's merge (a commit on another branch's line). A commit of 300 files or more whose file list leaves out the file excludes it as too large to check.
- `list` writes `benchmark/suites/clean/candidates.json` (each candidate as a suite entry with its evidence: links, dates and the commits checked) and `benchmark/suites/clean/ingest-report.txt` (the inclusion and exclusion counts, by reason).
- A candidate is not a case. `admit` writes `benchmark/suites/clean/cases.json` and `benchmark/splits/clean-v1.json` from the candidates whose latest ruling is `clean`, signed by a person on `people.json`. It refuses a candidate from a held-out group.
- A ruling names the candidate's id, which hashes its commits and size. A candidate that changes gets a new id and needs a new ruling.
- A ruling also names the sheet it was made on. `decide` refuses a sheet that does not show the current version of `candidates.json`, and records the candidate's evidence hash. `admit` refuses a clean ruling, naming the candidate, when the candidates have a new version or the candidate's evidence moved since the ruling; the sheet is printed and ruled again.
- A candidate carries its licence class into the suite entry and each run's copy of the case. A case whose licence GitHub cannot name gets the class `unverified`. It is used and published in full like any other case (Sid, 2026-10-12). Its licence record's `use` field says `local review and scoring`. That field is outside the case hash, so a case id never moves with it. Outside converters and board submissions still apply `publishRefusal`.
- Every read of the suite refuses an entry without a standing `clean` ruling, so an entry added by hand stops every run of the suite.
- No candidate has been ruled yet, so the suite holds no case.

## Why a truth item was missed

```
node benchmark/causes.mjs <run> [--specs <folder>] [<run> [--specs <folder>]]... [--decisions <file>] [--json]
```

A script gives every truth item a review missed, and every finding counted in precision that finds none, one cause, from the saved files and the rulings only. `score.mjs` writes the same causes into `score.json` (`perBug.<config>.<case>.<bug>.cause`, one per repeat, and the counts per configuration in `byConfig.<config>.causes`) and into `outcomes.jsonl`. `causes.mjs` prints them per run and configuration, then one table across the runs with the reviews each cause holds. `--specs` applies to the run named before it. A scanner-only run has no reviewer, so it gets no causes.

For a miss, the first cause that holds wins:

| Cause | When |
|---|---|
| incomplete | the review did not complete, failed or never started |
| spec-disputed | a person ruled the truth item wrong |
| not-in-brief | no line of the item was in the brief's diff, a correction round or a read |
| not-read | the item's proof outside the change (its `evidence`) was in none of them |
| finalize-floor | the reviewer submitted a finding that finds it, under the confidence floor |
| finalize-threshold | the same, below the severity threshold, so counted and not listed |
| finalize-rejected | a correction round's answer held such a finding, and the final answer left it out |
| line-off | a shown finding finds it but for its lines |
| wrong-kind | a shown finding finds it but for its kind |
| unresolved | a finding nobody has ruled on may be it: one on its lines, or one in its file that names it, of its kind, by a word no other truth item lists |
| candidate-dropped | a dropped scanner candidate located it; each drop is kept with its reason and its class above |
| judged-wrong | none of these: its lines were in front of the reviewer and nothing raised finds it. Each part must be on record (a complete trace or the brief for the lines, `submission.json`, and `rounds.json` when the review took correction rounds); a file the review did not save makes the miss unresolved, never judged wrong |

A counted finding that finds no truth item is `line-off` (a near miss), `wrong-kind`, `real-unlisted` (a person ruled it real), `false` (a person ruled it false, or the spec decides it) or `unresolved` (nobody has ruled). An unresolved cause never points at a change to the reviewer.

## The acceptance rule

A change to the reviewer is kept only when the benchmark shows it is better at what it set out to do and loses no more than it said it might on everything else. Three scripts apply the rule. None of them calls a model.

```
node benchmark/loop/compare.mjs <parent run> <candidate run> [--config <c>] [--parent-repeats 1] [--candidate-repeats 2] [--specs <folder>]
node benchmark/loop/decide.mjs --change <RC-id> --pair <parent run>=<candidate run> [--pair ...] [--stage 1|2|3] [--aa <run a>=<run b>]
node benchmark/loop/validate.mjs --run <saved run> [--specs <folder>]
```

`compare.mjs` scores both runs from their saved files and prints, for each metric, the parent, the candidate, the change with its bounds, and a verdict: better, worse, mixed or no change. A metric with two bounds (recall and precision while some findings are unresolved) has two readings, so each is tested at half the error share: two readings never get two chances to call a change. Splitting is chosen over asking both bounds to agree, because a change in one bound alone, such as new findings nobody has ruled on, is a change worth reporting. When nothing is unresolved, the two bounds are the same and are tested once at the whole share. `decide.mjs` applies the rule to a change recorded by `benchmark/loop/propose.mjs` and appends one line to `benchmark/index/ledger/reviewer.jsonl`, by writing the whole ledger to a temp file and renaming it into place under the ledger's lock, so a reader never sees half a line. A side may name a configuration and repeats: `<run>#<config>@<repeats>`.

The rule:

- Before any run, the change's record names one primary metric and an acceptable loss for every metric. The losses never change after that.
- The candidate is compared with the parent on the same cases, under the same scoring rules, review by review on first attempts. The unit is the case on planted suites and the repository group on real ones, with every repeat inside it. Three reviews of one case that agree count as one case, not three.
- The test is a paired sign-flip test. If the change did nothing, either run's result for a case is as likely to be the other's, so swapping them case by case shows how large a change noise alone makes. A bootstrap is not used: it calls a change carried by a few cases significant however many cases there are.
- Each point where a change can be accepted is a look: stage 2 and stage 3 of every change. Stage 1 can only stop a change and takes none: its line, from `loop.mjs` or `decide.mjs --stage 1`, records no look, and the next decision takes the look stage 1 was read at. The t-th look in the ledger may be wrong with a chance of 0.05 / (t (t + 1)), split equally across the nine metrics. All looks together spend at most 0.05, so a loop that decides often does not accept noise sooner or later.
- Unresolved findings count against the change. The candidate's precision is read at its lower bound and the parent's at its upper bound, and a truth item an unresolved finding may have found counts as missed by the candidate and found by the parent.
- A change is accepted only when the primary is better on the target path, every other metric (and the primary everywhere else) stays strictly inside its loss (a bound on the loss fails) on every path the change touches, every reviewer and each stratum (planted, real and both pooled), no hard rule breaks, every pair has three repeats, and the laptop path has both Claude Code and Codex.
- The hard rules refuse a change whatever the bounds say: a critical issue found in two or more of three reviews is found in one or fewer; a clean change draws findings in two or more of three reviews; a review is newly cut short by the budget; a review is complete while a changed range was not delivered.
- A change is reverted when a metric is past its loss even at its better bound, the primary is clearly worse, or a hard rule breaks. Otherwise a bound wider than its loss is inconclusive, and an inconclusive change is reverted too.
- Stage 1 (one repeat) can only stop a change. At stage 2, a change whose only open question is the primary may add repeats 4 to 6 (stage 3). Stage 3 is final.
- An A/A pair (two runs of the parent build) only sets how many cases and repeats a decision needs. Where its half-width is wider than a loss, the decision is inconclusive until cases or repeats are added. It never widens a loss.
- A metric no review measures, such as findings on clean changes in a run with no clean case, is named in the reason and does not decide. A cost or time guard whose parent value is zero is not measured either. The reason then says "cost not measured on the parent" or "time not measured on the parent". Such a guard neither holds nor breaks, and its A/A width does not block the decision. The other guards and the primary still decide.

The scanner variant decides a change to the scanners, from two runs' scans, through `scanners.mjs --against`. K1 comes first and is hard: no truth item the baseline found is lost. A change that only removes candidates is then decided by dominance, without an interval:

- The candidates of the new run must be an unchanged subset of the old run's in every sample. A candidate whose severity, message or merged findings changed counts as one removed and one added. A sample with no scan on either side refuses the comparison.
- Every removed candidate must be false. A candidate on a clean change is false by construction and needs no ruling. Any other removed candidate needs a person's ruling, made blind on the review queue's sheet (`queue.mjs add --candidates <old run>`, then `sheet` and `decide`). A reviewer that dropped the candidate every time, or a truth list that does not name it, proves nothing: the change waits, as "pending rulings", and the output names each candidate still to rule. A ruling made on another version of the case's spec does not count, and the output names it and says why. Two runs that score a case against different versions of its spec are refused.
- One removed candidate ruled a real issue, or ruled the truth item it sits on, reverts the change.
- When every removed candidate is false, the guards are read per case. Redundant candidates may not rise in any case. Their share of all candidates is shown but does not decide, because removing noise raises it by construction. Recall, critical and major recall, precision under the rulings, and candidates on clean changes may not get worse in any case. The median scan time may rise by less than the record's loss, 20 percent unless the record names one.
- A review run on both paths with three repeats is still required. Until the record holds its result, the change is "pending K4".
- A change that adds or alters a candidate, removes none, or removes one that finds a truth item is not decided by dominance. The paired test for scanner runs is not built yet, so such a change is "undecided".

The variant reads no interval, so it spends no error budget.

`validate.mjs` must pass before the first live decision, and again after any change to the rule's files. `decide.mjs` refuses to write while the last `validation` line in the ledger fails or names an older version of the rule. The version is a hash of the rule's files, which `validate.mjs` takes before it loads them and again before it writes its line; a file edited in between refuses the line. It tests the rule two ways:

- Simulated: 1,000 sequences of 10 looks, each look a change that does nothing, drawn from a world shaped like the saved runs (50 cases with three truth items each, 20 clean cases, three repeats). None may be accepted. The same world must accept a real gain at least once, and a constructed harmful change must be reverted.
- Saved: each pair of disjoint repeats of each configuration of a saved run is a change that does nothing, and the same pair with every hit removed from half the cases is a harmful one. Neither may be accepted.

The validation of the rule as it stands, `VAL-0005`, ran after cost and time guards with a zero parent became not measured. It ran on `2026-10-08-752b77f` scored with `--specs cases-v2`, the same run as `VAL-0004`, which followed the scanner variant and the stage 1 change. The earlier versions, `VAL-0001` to `VAL-0004`, gave the same results. No simulated change that does nothing was accepted in 1,000 sequences: the primary passed by chance at 1 of 10,000 looks, and a guard stopped it. The constructed harmful change was reverted, and the simulated gain was accepted in 4 of 40 tries. On the saved run, none of 18 decisions on changes that do nothing and none of 18 on harmful changes accepted anything, and all 18 harmful ones were reverted on evidence. On the same run, graph off against graph on is inconclusive on recall (1.8 points better at the bound worse for the change, one-sided p 0.25), and repeat 1 against 2, 1 against 3 and 2 against 3 show no change on any metric in either configuration.

The simulation also says how many cases a decision needs. With about 50 cases and 20 clean ones, the size of the laptop acceptance set, the rule accepted a gain that finds three quarters of what the parent missed in 4 of 40 tries: precision and severity agreement vary too much there for their 2 and 3 point losses at one ninth of a look's error budget. With 200 cases it accepted about half. The A/A pairs say how many cases or repeats each decision needs before it runs.

## The loop

`benchmark/loop.mjs` takes one change to the reviewer from its record to a decision, one step at a time. It never calls a model itself: it runs `run.mjs`, which reviews with the reviewer the parent's runs used, and it applies the acceptance rule above.

```
node benchmark/loop.mjs propose <record.json>
node benchmark/loop.mjs step --change <RC-id> --parent <run> [--parent <run> ...] [--candidate <run>] [--checkout <dir>] [--parent-checkout <dir>]
node benchmark/loop.mjs status
```

`propose` is the only way in. It checks the change as `benchmark/loop/propose.mjs` does and writes its record to `benchmark/index/ledger/reviewer.jsonl`.

`step` runs the stage that is due for the change and writes one line to the same ledger. Each `--parent` is a saved run of the parent build: one per path (laptop or server) and group of reviewers the change runs on. The loop makes the change's own runs with the parent's settings: the same cases, reviewers, model settings, scanner folder and repeats. It runs them with `run.mjs` from `--checkout`, a checkout of the change's commit built with `node benchmark/build-cli.mjs` (this repository by default). `--candidate` names a run already made for the change (`run.mjs --change <RC-id>`), so a stage whose runs exist costs nothing. Its run folders go to `benchmark/results/<RC-id>-<parent run>`.

The three stages:

- Stage 1, the screen: one repeat of the change on the path it targets, against the parent's saved runs. It can only stop a change. It stops it when the primary metric is not better than zero for some reviewer on that path, when another metric is worse by more than twice its acceptable loss, when a critical issue the parent found in every review of a case is missed in two or more cases, when the change has spent 40 percent of its cap, or when the rule above already reads harm.
- Stage 2, the decision: three repeats of every reviewer on every path the change runs on, Claude Code and Codex both on the laptop path. The rule decides: accepted, reverted, inconclusive and reverted, or stage 3 when only the primary metric is still open.
- Stage 3, the confirmation: repeats 4 to 6 on the target path, for the change and the parent (`--parent-checkout` names the parent's build). The rule decides, and an inconclusive change is reverted.

Runs of the scripted model are no evidence about a change: it reads no code, so the parent and the change it reviewed agree whatever the change did. A step on them records the spend and "no evidence", takes no look, and neither stops nor passes the change. Only a real reviewer's runs decide.

What the loop refuses, before it runs anything:

- A change that is decided. A stop at stage 1 is a decision, so nothing more runs for it.
- Any held-out run, as a parent or a change's run: a test split run, or a run of a suite held out of the loop. It reads each run's manifest first and refuses before it reads a single review.
- Any change while the earliest-failure signal says stop. The last baseline line in the ledger must carry the signal, and it must say go.
- A decision before a passing validation of the rule as it stands.
- A second change in stage 2 or 3 while one is there, checked again as the line is written. Changes are decided one at a time, so each is compared with the parent the last decision left.
- A parent built from another commit, made more than 7 days ago, a draft, or not finished, and a change's run built from another commit. A parent whose settings differ from the change's runs in anything but the build (another reviewer version, model, script or machine) is not compared: the line says so, and the parent is run again.

A look is a point where a change can be accepted. Stage 2 and stage 3 each take one, and the look number in the line is the one due when the line was written: the loop reads the ledger and writes under one lock, so two changes deciding at once take two numbers. Stage 1 can only stop a change, so it takes no look and spends none of the error budget. Its line records no look number. It reads the rule at the alpha of the look that is due.

Money. Each line records what its runs spent since the ledger last named them, read from each run's `budget.jsonl`, and every run's total, so nothing is counted twice. A run made with the scripted model costs what its script's prices say, which is what a real model would cost for the same tokens. The server path may spend 60 dollars a day (UTC), counted from the day's lines, plus anything the step's own runs spent that the ledger has not recorded yet (a run made before the step). A server run gets as its hard cap the smaller of what is left of the day and what is left of the change's own cap (40 dollars by default), and `budget.mjs` holds every model call to it before the call is sent. So a run stops at the cap even when the forecast said it would fit. The loop starts a stage only when the forecast (what the change's reviews have cost so far, else the parent's) fits in that room. A stage cut short by the day's cap takes no look: the next step, on a later day, finishes it. A stage cut short by the change's own cap is inconclusive and reverted. On the laptop path, a run is held to what is left of the change's 240 reviews. One stage runs reviews at a time. Each `run.mjs` the loop starts runs in a process group of its own, named beside the lock. If a step dies, the next step that runs reviews waits until that `run.mjs` has ended too, then records what the runs spent before it reads the day's room.

## What it does not measure

- How often real changes carry these bugs. The cases are small and synthetic; the share of bugs found here is not the share found in your repository.
- The graph on a large repository. In these cases a search for a name finds every caller, so the graph-off reviewer can find the same callers; the graph's worth on a big codebase is not shown here.
- Scanners that are not installed on the machine that ran. Each sample records which scanners ran; on a Mac without Go or Ruby, golangci-lint, rubocop and brakeman do not run.
- Other reviewers and models, unless the run names them. A run measures one reviewer with one model.
- Run-to-run spread beyond three repeats. The reviewer is a model; three repeats show whether a result holds, not its exact rate.

## The first run

Run `2026-10-08-752b77f` (index entry `benchmark/index/runs/2026-10-08-752b77f.json`): build `752b77f` (openqodex 0.9.0), Claude Code 2.1.294 as the reviewer with `claude-opus-5-5`, on an Apple M5 Pro with Node 22. 14 cases, graph off and on, 3 repeats: 84 reviews, all complete, none failed.

The table is the run scored with the matching rules above, in `score-cases-v2.json`, against `cases-v2/`: the run's own specs with the words each plant and side issue needs added, and nothing else changed. The first scoring, `score.json`, used earlier rules that matched by place and kind alone and counted duplicates as correct; its precision was 101/105 and 102/106. This run was made before the build record existed: its manifest's `dirty: false` means no uncommitted change under `packages/` when the run started, not the tree the bundle was built from.

| Measure | Graph off | Graph on |
|---|---|---|
| Planted bugs found | 96/111 (86%) | 99/111 (89%) |
| critical | 31/33 | 32/33 |
| major | 57/60 | 57/60 |
| minor | 8/18 | 10/18 |
| Findings that are planted bugs | 96/101 (95%) | 99/103 (96%) |
| False findings | 4 | 4 |
| Near misses (one line off) | 1 | 0 |
| Duplicate hits (not counted) | 4 | 3 |
| Clean changes with no finding | 6/6 | 6/6 |
| Callers the change breaks, listed in the brief | 0/15 | 15/15 |
| Graph gaps disclosed in the brief | 0/6 | 3/6 |
| Time per review, mean | 26 s | 25 s |
| Cost per review, mean | $0.10 | $0.11 |

What it showed:

- The four cases whose bug is visible only through a caller outside the diff were found in every review, with the graph off as well as on: in repositories this small, the reviewer finds the callers with its own search. The graph put the callers in the brief every time; it did not change what was found.
- The brief with the graph on says the callers of `onSave` are a floor, but it does not name the computed call `table[action](id)` that reaches it (`js-dynamic-dispatch-gap`, 3 of 3 reviews).
- Most misses are minor Dockerfile issues in the demo repository (an unpinned `apt-get install`, `ADD` for a local file, the pip cache): the scanners raised each one, and the reviewer dropped them as harmless in most reviews.
- Three spec errors in this run's cases were found by reading the reviews, and are fixed for the next run (this run keeps its own copies): the Rails reviewer found the admin check missing from `destroy` at the `destroy` action, a place the spec did not list (2 reviews); the Next.js change drops the base page's search form by accident, a real bug the reviewer reported 5 times, each counted false; and `permit!` sat behind the admin check, so the plant was weak and was never reported (0 of 6). The case now plants it in a self-service profile update. Of the 8 false findings, 7 come from the first two errors. The eighth is real but was not listed: a path traversal in the suppression case's thumbnail command, which the earlier rules had credited to the planted shell injection on the same line. The case now lists it as a side issue.
- The reviewer also asked for tests about once per review (32 and 31 findings); these are counted apart, as the scoring rules above say.
- The wording pass (`judge.json`, judged by `claude-sonnet-5`, which never blocks) read the 203 findings that the earlier rules matched to a planted bug. Graph off and on: the problem sentence was plain in 86% and 90% and correct in 97% and 98%; the consequence plain in 86% and 85%, correct in 97% and 92%; the fix plain in 91% and 95%, correct in 97% and 98%. The judge's answer for 8 findings did not parse.

## The phase 2 run

Run `2026-10-09-ac9cdae` (index entry `benchmark/index/runs/2026-10-09-ac9cdae.json`): build `ac9cdae` (openqodex 0.10.0 with phase 2 of the code graph: calls through interfaces and base classes, functions used as values, type and value uses), Claude Code 2.1.295 as the reviewer with `claude-opus-5-5`, on the same Mac with Node 22. 15 cases, graph on only, 1 repeat. The run is marked dirty because 18 untracked scratch files sat under `.tmp/` in the build's tree; the product code is the commit's. The fixes from the phase's code review came after this build. They change how sure some edges are, not what the five graph cases' briefs say: scored again on the final build with the same brief checks, those briefs still name every gap and every caller.

The `django-model-view` review failed: the Mac went to sleep a second after it started, and the run stopped it after 1,521 s with no report. That one review ran again on the same build, in run `2026-10-09-ac9cdae-django-retry` (`benchmark/index/runs/2026-10-09-ac9cdae-django-retry.json`), and completed. The phase 2 column takes `django-model-view` from that run and every other case from the first. Each folder is scored with its own specs (`score.json`). The first run is scored with `cases-v2/`, as in its own table. `score.mjs --against` scores the earlier run with that run's own specs, which predate the words each plant needs, so this comparison calls the scorer's functions directly (#73).

| Measure (graph on) | First run, `752b77f`, 3 repeats | Phase 2, `ac9cdae`, 1 repeat |
|---|---|---|
| Planted bugs found | 99/111 (89%) | 33/38 (87%) |
| critical | 32/33 | 12/12 |
| major | 57/60 | 20/20 |
| minor | 10/18 | 1/6 |
| Findings that are planted bugs | 99/103 (96%) | 33/33 (100%) |
| False findings | 4 | 0 |
| Clean changes with no finding | 6/6 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 7/7 |
| Graph gaps disclosed in the brief | 3/6 | 3/3 |
| Time per review, mean | 25 s | 34 s |
| Cost per review, mean | $0.11 | $0.11 |

What it showed:

- The line this phase moved is the graph gaps. In `js-dynamic-dispatch-gap` the brief now names the computed call `table[action](id)` and lists the table's entries as its possible targets: 2 of 2 checks, where each review of the first run passed 1 of 2.
- The new case, `ts-interface-dispatch-break`, plants a bug that only a call through an interface reaches. Its brief listed both callers that reach it through the `Cache` interface as possible callers and called the list a floor (3 of 3 checks), and the review found the bug. Graph off was not run, so this run does not show whether the graph made the difference.
- On the 14 cases both runs hold, the review found 32 of 37 plants: every critical and major one. The five misses are minor: three Dockerfile issues and a shell loop in the demo repository that the scanners raised and the reviewer dropped, as in the first run, and the list items without keys in the Next.js case.
- No finding was false. Three findings matched side issues the cases list as real but not planted: the Next.js search form the change drops (listed since the first run, where it counted false 5 times), the Next.js search failure that is never caught, and the race between two redemptions in the Django case.
- The mean time rests on one demo review of 98 s, 82 s of it the reviewer's; the first run's three demo reviews with the graph on took 47 s, 83 s and 50 s. The median review took 28 s.

## Code graph phase 3: the graph command and the MCP server

Run `2026-10-09-95efb19` (index entry `benchmark/index/runs/2026-10-09-95efb19.json`): build `95efb19` of the phase 3 branch (openqodex 0.10.0), Claude Code 2.1.295 with `claude-opus-5-5`, graph on, one repeat: 14 reviews, all complete, none failed. Run `2026-10-08-588a38c` (`benchmark/index/runs/2026-10-08-588a38c.json`) is an earlier build of the same branch, run the same way. The first run is scored against this run's specs (`score-cases.json` in the first run's asset), so every column uses the same rules and words. Its Rails numbers do not compare, since that case's code changed after it ran.

| Measure | First run, graph on (`752b77f`, 3 repeats) | Phase 3, earlier build (`588a38c`) | Phase 3 (`95efb19`) |
|---|---|---|---|
| Planted bugs found | 100/111 (90%) | 33/37 (89%) | 34/37 (92%) |
| critical | 33/36 | 12/12 | 12/12 |
| major | 57/57 | 19/19 | 19/19 |
| minor | 10/18 | 2/6 | 3/6 |
| Findings that are planted bugs | 100/100 (100%) | 33/33 (100%) | 34/36 (94%) |
| False findings | 0 | 0 | 2 |
| Clean changes with no finding | 6/6 | 2/2 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 5/5 | 5/5 |
| Graph gaps disclosed in the brief | 3/6 | 1/2 | 1/2 |
| Time per review, mean | 25 s | 29 s | 52 s |
| Reviewer turns per review, mean | 3.9 | 4.4 | 5.9 |
| Cost per review, mean | $0.11 | $0.12 | $0.37 |

What it showed:

- Phase 3 changes nothing the reviewer sees. The brief of every case in `95efb19` is the same as in `588a38c` and in the first run, apart from the line that gives the graph's build time and the Rails case, whose code changed. No line of bugs found, clean controls or graph disclosure moved by more than one review's spread.
- The two false findings are real issues the specs do not list: the Go search handler never checks `rows.Err()` after its loop, and the Next.js search page lets a late response overwrite newer results.
- Time, turns and cost per review doubled against `588a38c` with the same briefs and the same Claude Code version. The reviewer asked for more correction rounds (1.71 per review against 1.36). The cause is on the reviewer's side, not in the build: the input did not change. Which part (the account the run used, or the model's own variation between runs) was not tested.
- The graph-off configuration was not run: phase 3 does not change it.

## Code graph phase 4a: Django and Rails framework entries

Run `2026-10-09-602a140` (index entry `benchmark/index/runs/2026-10-09-602a140.json`): build `602a140` of the phase 4a branch (openqodex 0.10.0), Claude Code 2.1.295 with `claude-opus-5-5`, graph on, one repeat: 15 reviews, all complete, none failed. The first run is scored against this run's specs (`score-cases-602a140.json` in the first run's asset, named for this run so it sits beside other phases' scores of the same run), so both columns use the same rules and words. Its Rails numbers do not compare, since that case's code changed after it ran.

| Measure (graph on) | First run (`752b77f`, 3 repeats) | Phase 4a (`602a140`, 1 repeat) |
|---|---|---|
| Planted bugs found | 100/111 (90%) | 34/38 (89%) |
| critical | 33/36 | 13/13 |
| major | 57/57 | 19/19 |
| minor | 10/18 | 2/6 |
| Findings that are planted bugs | 100/100 (100%) | 34/34 (100%) |
| False findings | 0 | 0 |
| Clean changes with no finding | 6/6 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 5/5 |
| Graph gaps disclosed in the brief | 3/6 | 1/2 |
| Time per review, mean | 25 s | 28 s |
| Reviewer turns per review, mean | 3.9 | 4.1 |
| Cost per review, mean | $0.11 | $0.11 |

What it showed:

- The new case, `django-renamed-view`, renames a view while `orders/urls.py`, outside the diff, still registers the old name. The brief listed the route `ANY orders/<int:pk>/`, named `orders:detail`, declared at `orders/urls.py:8`, with "no handler now: the handler is missing", and the review found the bug. With the graph off, on the same build, three reviews found it too (run `2026-10-09-602a140-django-graph-off`, `benchmark/index/runs/2026-10-09-602a140-django-graph-off.json`, 3 of 3): in a repository this small the reviewer opens `urls.py` itself. This phase put the broken route in the brief; it moved no line of bugs found.
- On the 14 cases both runs hold, the review found 33 of 37 plants: every critical and major one. The four misses are minor: three Dockerfile issues in the demo repository that the scanners raised and the reviewer dropped, and the list items without keys in the Next.js case, as in the earlier runs.
- No finding was false. Three findings matched side issues the cases list as real but not planted.
- The graph gap line is unchanged: the `js-dynamic-dispatch-gap` brief still does not name the computed call `table[action](id)`. Phase 2 changes that, and this branch does not hold phase 2.

## Code graph phase 4b: the framework plugins

Run `2026-10-09-881318b` (index entry `benchmark/index/runs/2026-10-09-881318b.json`): build `881318b` (openqodex 0.10.0, the Express, React, Next.js, FastAPI and Go net/http plugins), Claude Code 2.1.295 as the reviewer with `claude-opus-5-5`, graph on, one repeat of the 15 cases: 15 reviews, all complete. It is compared with the graph-on reviews of the first run, scored against this run's specs (`baseline-752b77f-score-cases.json` in this run's asset). Eight cases were edited after the first run, so for those the first run reviewed other files than its score assumes: its Rails `permit!` plant sat behind the admin check, and 0 of 3 of its reviews found it.

| Measure | 752b77f, graph on, 3 repeats, 14 cases | 881318b, graph on, 1 repeat, 15 cases |
|---|---|---|
| Planted bugs found | 100/111 (90%) | 35/38 (92%) |
| critical | 33/36 | 12/12 |
| major | 57/57 | 20/20 |
| minor | 10/18 | 3/6 |
| Findings that are planted bugs | 100/100 | 35/35 |
| False findings | 0 | 0 |
| Clean changes with no finding | 6/6 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 5/5 |
| Graph gaps disclosed in the brief | 3/6 | 1/2 |
| `express-route-param` (new: a handler reading a parameter its route does not declare) | not in the run | 1/1 |
| Time per review, mean | 25 s | 27 s |
| Cost per review, mean | $0.11 | $0.12 |

What it showed:

- No benchmark line moved. The plugins put their routes, middleware and test links on the graph, but nothing in the brief reads them yet: the brief lines that show a changed handler's route come with phase 4a's interface work, so this phase's effect on reviews can be measured only once those are merged.
- The reviewer found the new `express-route-param` bug by reading the route file, which the brief lists as a file that imports the changed handler; the brief does not yet say which route the handler serves.
- The three misses are minor: two Dockerfile issues in the demo repository the reviewer dropped as harmless (as in the first run), and the list items without keys in the Next.js case, a candidate the reviewer dropped.

## Code graph wave 1: phases 2, 3, 4a and 4b merged

Run `2026-10-09-5227579` (index entry `benchmark/index/runs/2026-10-09-5227579.json`): build `5227579` of the `graph-wave-1` branch (openqodex 0.10.0 with phases 2, 3, 4a and 4b merged), Claude Code 2.1.295 as the reviewer with `claude-opus-5-5` pinned by `--model`, graph on, one repeat: 17 reviews, all complete, none failed. The first run's graph-on reviews are scored against this run's specs in `baseline-752b77f-score-cases.json` in this run's asset; its Rails numbers do not compare, since that case's code changed after it ran. Each phase column is that phase's own run as its section above gives it, scored with its own specs and cases.

| Measure (graph on) | First run `752b77f`, 3 repeats, 14 cases | Phase 2 `ac9cdae`, 15 cases | Phase 3 `95efb19`, 14 cases | Phase 4a `602a140`, 15 cases | Phase 4b `881318b`, 15 cases | Wave 1 `5227579`, 17 cases |
|---|---|---|---|---|---|---|
| Planted bugs found | 100/111 (90%) | 33/38 (87%) | 34/37 (92%) | 34/38 (89%) | 35/38 (92%) | 37/40 (93%) |
| critical | 33/36 | 12/12 | 12/12 | 13/13 | 12/12 | 13/13 |
| major | 57/57 | 20/20 | 19/19 | 19/19 | 20/20 | 20/21 |
| minor | 10/18 | 1/6 | 3/6 | 2/6 | 3/6 | 4/6 |
| Findings that are planted bugs | 100/100 (100%) | 33/33 (100%) | 34/36 (94%) | 34/34 (100%) | 35/35 (100%) | 37/39 (95%) |
| False findings | 0 | 0 | 2 | 0 | 0 | 1 |
| Clean changes with no finding | 6/6 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| Callers the change breaks, listed in the brief | 15/15 | 7/7 | 5/5 | 5/5 | 5/5 | 7/7 |
| Graph gaps disclosed in the brief | 3/6 | 3/3 | 1/2 | 1/2 | 1/2 | 3/3 |
| Briefs with a framework table | none | 0/15 | 0/14 | 3/15 | 0/15 | 8/17 |
| `django-renamed-view` found | not in the run | not in the run | not in the run | 1/1 | not in the run | 1/1 |
| `express-route-param` found | not in the run | not in the run | not in the run | not in the run | 1/1 | 1/1 |
| Time per review, mean | 25 s | 34 s | 52 s | 28 s | 27 s | 26 s |
| Reviewer turns per review, mean | 3.9 | not given | 5.9 | 4.1 | 4.2 | 4.3 |
| Cost per review, mean | $0.11 | $0.11 | $0.37 | $0.11 | $0.12 | $0.11 |

What it showed:

- The framework line moved. Eight of the 17 briefs carry a table of framework entries, against three in phase 4a's run and none in phase 4b's, whose plugins reached the brief only once 4a's lines were merged: the Django and Rails cases, both Express cases, the Go and Next.js cases, and `suppression-comments`.
- In `express-route-param` the brief now lists the route `GET /users/:id` declared at `src/routes/users.js:7`, handled by `getUser` (certain), so the brief itself shows that the route names the parameter `id`. Phase 4b's brief listed no route. The reviewer found the bug in both runs, and read `src/routes/users.js` in both, so this run does not show that the table changed the outcome.
- In `django-renamed-view` the brief lists the route `ANY orders/<int:pk>/`, named `orders:detail`, as having no handler now, as in phase 4a's run, and the review found the bug, as in that run.
- Phase 2's lines hold after the merge: every graph gap the specs check is disclosed (3 of 3) and every broken caller is listed (7 of 7).
- The three misses: two Dockerfile issues in the demo repository (every run misses some of these), and the Decimal times float in `django-model-view`, which the reviewer reported one line off the planted lines (a near miss by the scoring rules, not a hit).
- The false finding is a minor one in `express-admin-routes`: the purge reply reports the requested count as removed. It follows from the planted unawaited `forEach` two lines above it; the specs do not list it, so it counts false.
- Time, turns and cost per review match the first run's.

### The review fixes

The code review of the merged branch changed what four briefs show: three framework tables no longer say a route whose handler is an inline function or a method of an untyped value has "no handler now" (`express-admin-routes`, `go-http-handler`, `suppression-comments`), and the `django-renamed-view` brief adds the gap at the route that names the missing view. Only those four cases ran again, on build `4a7d198`, in run `2026-10-09-4a7d198` (`benchmark/index/runs/2026-10-09-4a7d198.json`), the same way (graph on, one repeat, `claude-opus-5-5`).

| Measure (graph on, the four cases) | Wave 1 `5227579` | Review fixes `4a7d198` |
|---|---|---|
| Planted bugs found | 8/8 | 8/8 |
| False findings | 1 | 0 |
| Time per review, mean | 22 s | 22 s |
| Cost per review, mean | $0.10 | $0.10 |

No planted bug moved. The false finding of `5227579` (the purge reply's count in `express-admin-routes`) was not raised again; one repeat cannot say whether the brief caused that.

## Claims cite a run

A release note, a README line, a post or a reply that states anything about review quality (bugs found, false findings, speed or cost of a review) cites a published benchmark run: its index entry (`benchmark/index/runs/<run-id>.json`), the score file it quotes from the run's asset (`score.json`, or `score-<folder>.json` with the specs it used), the build and the reviewer's model. A number that no published run backs is not written.

## Chosen convention cases

`--suite conventions` runs three authored cases under `benchmark/suites/conventions/`. They use the demo's Flask items endpoint and add the same `GET /health` handler, named `health_check`. That name and behavior are valid on their own. The violation case chooses `CONTRIBUTING.md`, whose verb-noun rule requires `get_health`. Its truth item expects the rule citation `CONTRIBUTING.md#verb-noun`, naming both the file and the rule. The exception case chooses the same rule with an explicit exemption for this health handler. The no-rule control has no convention file and an empty selection. Both controls are clean, with no accepted extras: format 3 counts any finding on them as false.

These cases use the planted `case.json`, `base/` and `change/` format. They have their own suite name and hashes. To select one case, use `--cases conventions/violation`, or `--suite conventions --cases violation`. They do not enter the frozen corpus or its splits. The laptop runner passes the case config and the base commit as the instructions source. The server runner passes the case's parsed config to the library. Existing suites keep their inputs.

Build the cases without running a reviewer:

```sh
node benchmark/run.mjs --suite conventions --materialise-only --reviewers model:gpt-6.1-sol
```

Run one repeat with the model endpoint already configured:

```sh
node benchmark/run.mjs --suite conventions --reviewers model:gpt-6.1-sol --repeat 1 --max-usd 5 --review-max-usd 1 --max-minutes 15
```

Score the saved run with `node benchmark/score.mjs <run-folder>`. A violation finding must name `CONTRIBUTING.md`. The exception and control must have no findings. The scorer checks those expectations from the saved case specs.
