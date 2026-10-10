# Library

`openqodex` is also a library. A Node program, on Node 22 or newer, imports the scanners, the code graph, the lenses, the config parser and the renderers from the same package the command comes from, with TypeScript types.

```
npm install openqodex
```

```ts
import { createToolResolver, parseConfig, renderMarkdown, runScanners } from "openqodex";
import { graph, lenses, render, scanners } from "openqodex";
```

Every function is a named export. The four namespaces `scanners`, `graph`, `lenses` and `render` hold the same functions, grouped by what they belong to: `scanners.runScanners` is `runScanners`. The package is ESM only: load it with `import`, not `require`.

Importing the library runs nothing. No command starts, nothing is printed, no environment variable is set, no signal handler is added and no update check runs. A function does its work only when it is called.

`reviewChange` reviews one change with the same brain as `openqodex review`: the scanners, the code graph, the lenses, the brief, the checked answer with its correction rounds, and the completion record. A server product calls it with its own model and gets back findings, the reviewer's dispositions, coverage, a completion record and the usage of every model call.

## Two profiles

A review runs in one of two profiles. The profile is declared, never guessed.

| | laptop (`openqodex review`) | server (`reviewChange`) |
|---|---|---|
| The change | the merge base worked out from your branch | `mergeBaseSha` from the host, proved in the host's clone |
| What is read | a git work tree under `~/.openqodex/checkouts` | the head commit's regular files (inside `scopes`), written under `workDir` from the clone's objects |
| Where it writes | `~/.openqodex` and the repository's `.openqodex/` | only under `workDir` |
| Scanners | installed on first use into `~/.openqodex/tools` | read from `installRoot`, filled beforehand; never installed |
| Reviewer | Claude Code or Codex, with its own read tools | the host's model, with the brain's five tools; no web, no shell |
| Budget | one deadline | `authorize` asked before every model call |
| Confidence floor | 0.7 | `confidenceFloor`, 0.7 when left out |
| Output | stdout, stderr and report files | the result object and `onProgress` lines |

## reviewChange

```ts
import { reviewChange } from "openqodex";

const result = await reviewChange(
  { clonePath, mergeBaseSha, headSha, config },
  reviewer,
  { profile: "server", workDir, installRoot, budget, tools: { web: false, shell: false }, scanners: "preinstalled", onProgress },
);
```

### Input

- `clonePath`: the host's clone. It must hold both commits and the history between them.
- `mergeBaseSha`: the merge base of the pull request, as the host's comparison gives it. It is not the target branch's tip. The library proves that both ids are full commit ids of commits in the clone and that the merge base is an ancestor of the head, then works out the change itself. A diff from the host is never an input.
- `headSha`: the commit under review.
- `config` (optional): a parsed `Config` (`parseConfig`). The defaults when left out. Nothing is read from the clone's own `.openqodex` files.
- `instructions` (optional): the repository owners' own rules for the review, as text of at most 32 KB (more is refused, never cut). The brief quotes them under the owners' heading with the framing the laptop gives `.openqodex/custom-instructions.md`: they decide what to flag and what not to, and they never switch a check off, skip a candidate or change the answer's shape. Give advisory material, such as earlier comments, as `context`.
- `previousReviewedSha`, `fullReviewRequested`, `scopes` and `context` (optional): an incremental review, a review limited to folders, and context items such as lessons and earlier comments. See "Incremental, scoped and context" below.

### Options

- `profile`: `"server"`.
- `workDir`: an absolute folder the review may write in: the snapshot and the scanners' scratch. Nothing is written anywhere else. Give each review its own folder and remove it afterwards. Keep its path to about 50 characters: TFLint's plugin socket goes in `<workDir>/scratch/tmp`, which must be 64 characters or fewer, and TFLint is not run otherwise (the result names the length).
- `installRoot`: the absolute folder the preinstalled scanners are read from (see "Preinstalling the scanners in an image"). It is only read.
- `budget`: `{ authorize, deadlineMs }`, required. See "The budget".
- `confidenceFloor` (optional): the lowest confidence a finding may have, from 0 to 1, 0.7 when left out. The brief tells the reviewer this floor and the check applies it. A lens with a higher floor of its own keeps it.
- `tools`: `{ web: false, shell: false }`. The server reviewer gets the five tools below and no other.
- `scanners`: `"preinstalled"`.
- `onProgress` (optional): called with one line per step.

### Result

- `status`: `complete`, `complete_blocking` (complete, with a finding at or above `block_on_severity`) or `incomplete`.
- `reason`: why the review is incomplete, one line per missing proof. A complete review has a reason only when there was nothing to review.
- `findings`: every finding that passed every check, in the finding shape below.
- `dispositions`: what the reviewer did with each scanner candidate: `raised` with the finding's file and line, or `dropped` with the reason and the line that shows why.
- `summary`: the reviewer's summary, or null.
- `coverage`: which changed lines the reviewer was shown, and how.
- `scannerVersions`: each scanner of the run and its version, null for one that did not run.
- `trace`: every tool call the reviewer made, as the brain ran it.
- `usage`: `{ calls, totals }`. One record per model attempt: `callId`, `reviewer`, `purpose`, the model asked for and the model that answered, input, output, cache-read and cache-write tokens, the cost when the host reported one, the outcome (`ok`, `failed` or `refused`) and the measured duration. The totals add them up; a sum the host could not report is null, never zero.
- `completion`: the model completion record, contract `openqodex-model-review-1`. Its proof is the brain's own data: the snapshot before and after, every changed range with how it was delivered, every tool call, every candidate raised or dropped, and every model attempt with its authorization and usage. Nothing in it comes from the reviewer.
- `scope`: `{ kind, reason }`. `kind` is `delta` when only what changed since `previousReviewedSha` was the reviewer's to review, else `full`; `reason` says why. Null when a proof failed first.
- `notes`: what the review could not hold, one plain line each: a file renamed into the scopes from outside them (reviewed as a new file), a link or a submodule the snapshot left out, a base version outside the scopes that was asked for and not read, and a second reviewer's failure that left the review complete.
- `context`: every context item given, in order, with its hash, and why the brief left one out.
- `disagreements`: the scanner candidates one reviewer raised and the other dropped, when a second reviewer ran.
- `render`: `markdown()`, `sarif()` and `json()`, the report in each format.

An incomplete review keeps every finding already checked.

### The finding shape

Each finding has `file`, `lineStart`, `lineEnd`, `title`, `problem`, `consequence`, `fix`, `suggestedChange` (the reviewer's literal replacement for the cited lines, or null), `severity` (`critical`, `major`, `minor`, `nitpick` or `info`), `category`, `confidence` (0 to 1), `foundBy` (the reviewers that raised it), `source` (null for the reviewer's own finding, a scanner rule such as `semgrep:<rule>`, or `lens:<name>`) and `candidate` (the scanner candidate's id, or null).

### Status reasons

A proof that fails ends the review as incomplete before any model call, with a reason that starts with the proof's name:

- `not a commit`: an id is not a full commit id, or names something other than a commit.
- `missing commit`: a commit is not in the clone. Fetch it.
- `history unknown`: the clone is shallow, so it cannot show that the merge base is an ancestor of the head. Fetch the history between them.
- `diverged`: the merge base is not an ancestor of the head. Pass the pull request's merge base, not the target branch's tip.
- `git failed`: git itself failed in the clone.
- `missing objects`: a tree or a file of the head is not in the clone, as in a partial clone. Fetch them; OpenQodex fetches nothing.

After the review ran, an incomplete review names what is missing: a changed range the reviewer was never shown, a candidate it neither raised nor dropped, an answer that failed its checks after the correction rounds, a budget refusal, a failed model call, or the deadline.

### Incremental, scoped and context

- `previousReviewedSha`: the head of the last review. When it is an ancestor of the head, the reviewer is asked to review only what changed since then, while findings are still placed and checked on the whole change. A commit that merged the base branch in is never a target. When it is missing, not an ancestor, or its history is unknown, or with `fullReviewRequested: true`, the review is a full one and `result.scope` says why.
- `scopes`: folders. The change, the snapshot, the scanners, the graph, the tools, the context and the findings all stay inside them, less `review.paths.exclude`.
- `context`: items `{ kind, text, source, scopes? }`, where `kind` is `lesson`, `comment`, `summary`, `note` or `prior_finding`. Each is shown to the reviewer as quoted data under one heading per kind. An item never grants a tool or changes a rule. An item over 32 KB, or more than 128 KB of items in all, is refused, not cut. An item outside the scopes is left out, and the result says so.
- `secondReviewer` (an option): a second model reviewer runs after the first, with the same brief and tools and its own correction rounds and record. Findings both raise are merged, with `foundBy` naming both. A budget refusal during it ends the whole review as incomplete. Any other failure of the second reviewer changes nothing in the first one's findings, dispositions or status; its record and a note say what happened.

## The reviewer contract

`reviewerContract` is `1`. A reviewer is one of two kinds:

- `agent`: Claude Code or Codex, started by the laptop's drivers. Not used by `reviewChange`.
- `model`: the host's model. `{ kind: "model", model, maxOutputTokens, complete(request) }`.

For a model reviewer the brain owns the loop. It builds every request, runs every tool call itself, asks the budget before every call and records the usage of every response. `complete(request)` gets `{ callId, attempt: 1, purpose, messages, tools, maxOutputTokens }` and returns `{ message: { text, toolCalls }, usage }`, where `usage` is `{ model, servedModel?, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? }` as the provider reported it for this one attempt. A reply with no tool call is the answer. The messages are in no provider's format; the host maps them to its own.

The host's adapter adds no prompt, no rule, no filter and no retry. What the reviewer says it read is never used: coverage counts only what the brain carried in a request it sent.

### One transport attempt per call

`complete` makes exactly one transport attempt. Turn your model client's retries off for review calls. A retry hidden inside `complete` is billed by the provider but recorded by OpenQodex as one call, so the usage no longer matches the bill, and the budget was asked once for two attempts. When the transport fails, throw: the brain records the call as failed.

### The budget

`budget.authorize(call)` is asked before every model attempt, with `{ callId, attempt, reviewer, purpose, model, maxOutputTokens, requestChars, usageSoFar }`. `requestChars` is the size of the request about to be sent: the characters of its messages and its tool definitions written as JSON. With `maxOutputTokens` it bounds what the call can cost, so a host can hold a dollar cap before the call is made. When it returns false, or throws, nothing is sent and the whole review ends as incomplete, with the usage so far and the findings already checked. This holds for a correction round and for the second reviewer too. `budget.deadlineMs` is how long the review may run, from the call to `reviewChange`: once it has passed, the budget is not asked again and no model call starts. A call without a budget throws before any work.

### The five tools

The brain runs these over the frozen snapshot, never over the clone:

- `read_file`: lines of a file, numbered as the file holds them.
- `search_code`: a regular expression over the snapshot's text files, line by line, run without backtracking. A line that holds a redacted secret is never a result.
- `list_files`: the snapshot's files, by glob.
- `read_diff_for_file`: one changed file's diff against the merge base.
- `find_callers`: the callers of a function, method or class, from the code graph built for the review.

Each call is checked before it runs. A path outside the snapshot is refused and logged as outside. With `scopes`, a path outside them is refused as outside the review's scopes, and a listing or a search returns only files inside them; the graph files the brief names, under `.openqodex-review/graph/`, stay readable. Either refusal leaves the review incomplete. A link is never followed, and the snapshot's `.git` entry is never read. Every reply is at most 32 KB, cut only at a whole line, and says so when it was cut. Every reply is redacted of the secrets the scanners found. No tool starts a program. Every call is logged with its path, its range and whether its result was sent to the model in a later request.

## What the server profile never does

- It never installs a scanner, never takes one from `PATH`, and never runs a custom scanner, which needs `openqodex trust` on a laptop.
- It never writes outside `workDir`: no file in the clone's work tree, no receipt, no `last-review`, nothing in `~/.openqodex`. Scanners get `HOME` and `TMPDIR` inside `workDir`.
- It never prints, never adds a signal handler and never writes a `process.env` variable.
- It never gives the reviewer a web tool or a shell.
- It never retries a model call, and never calls the model after the budget refused.
- It never reads an instructions file or a config from the clone: the host gives the config.
- It never updates itself.

## Preinstalling the scanners in an image

A server reads its scanners from an install root that an image build filled. The pinned table is `toolchain.json` in the package (`loadToolchain()`), with a lock file per registry install in `locks/`. Every download is checked against its pinned sha256.

### preinstallScanners

```ts
import { preinstallScanners } from "openqodex";

const result = await preinstallScanners({ installRoot: "/opt/openqodex/tools", require: "all" });
if (!result.ok) {
  console.error(result.missing.join("\n"));
  process.exit(1);
}
```

- `installRoot`: the folder the tools go into, one folder per tool. It must be writable during the build. Nothing is written anywhere else: the installers' download caches go in a temporary folder that is removed at the end.
- `require`: `"all"` for every built-in scanner, or the list of scanners the server will run.
- `onProgress` (optional): one line per install and per check.

It installs every required scanner that is missing, then checks each one: it must be a built-in scanner (a custom scanner is never preinstalled), its runtime must be on the machine, it must be installed at its pinned version, and it must report the finding of its check case. A check case is the smallest input that makes the scanner report a finding, such as a Dockerfile `FROM python:latest` for hadolint. The case runs through the same adapter a review uses, with installs off. cargo-deny's case only proves it runs, since its findings need a project's crates in the Cargo cache.

The result is `{ ok, missing, tools }`. `missing` has one line per scanner that is not ready, such as `golangci: needs Go`. `tools` has, per required scanner, its pinned version, whether it is ready, and one line: what its check case reported, or why it is missing.

At review time, read the root with installs off: `createToolResolver({ allowInstall: false, installRoot })`, or `installRoot` in `reviewChange`'s options. A tool missing there is reported as not installed, with the reason; nothing is downloaded.

### From the command line

```
OPENQODEX_HOME=/opt/openqodex npx openqodex doctor --install --all-scanners --require-all
```

installs every scanner into `/opt/openqodex/tools`, checks each one as `preinstallScanners` does, prints one stderr line per missing scanner (`openqodex: missing: <scanner>: <why>`) and exits 2 when any is missing. With `--json`, the report holds the same result as `required`. The installers' caches stay in `/opt/openqodex/cache`; remove that folder in the same image step to keep the image small.

### What each scanner needs

At install time, the release downloads need the network to github.com, and `tar`, `xz` (shellcheck) and `unzip` (TFLint) to unpack them. Then:

| Scanners | At install | At review |
|---|---|---|
| gitleaks, osv-scanner, actionlint, hadolint, shellcheck, ruff, oxlint, zizmor, squawk, trivy, TFLint, kube-linter, kubeconform | nothing more | nothing |
| semgrep, bandit, SQLFluff, Checkov | uv (from `PATH`, or the pinned uv installed into the root), which downloads Python 3.11 into the root, and PyPI | nothing |
| brakeman | Ruby 3.0 or newer with `gem`, and rubygems.org | the same Ruby |
| rubocop | Ruby 2.7 or newer with `gem`, and rubygems.org | the same Ruby |
| golangci | Go on `PATH` | Go 1.26 on `PATH`, and the reviewed modules in the Go module cache: each review reads them from there into a module cache of its own, and nothing goes to the network |
| cargo-deny | Cargo (Rust) | Cargo, and the crates of the reviewed `Cargo.lock` in the Cargo cache: each review copies what the lock needs from there into a Cargo home of its own, and Cargo runs offline |

At review time, four scanners use the network: semgrep fetches its rule packs from the Semgrep registry, osv-scanner sends dependency names and versions to osv.dev, kubeconform fetches the schemas of the kinds it meets from raw.githubusercontent.com, and cargo-deny fetches the RustSec advisory database from github.com. On a server these caches live in the run's scratch, so each review fetches them again. golangci starts each review with an empty Go build cache, so a Go change takes longer to check than on a laptop. The server profile downloads no Go module: a module whose dependencies are not already in the image's Go module cache is not linted by golangci there.

### A recipe

A server that runs every scanner needing no language runtime, with `openqodex` in its own dependencies:

```dockerfile
FROM node:22-bookworm
# git; xz and unzip unpack the scanner releases.
RUN apt-get update && apt-get install -y --no-install-recommends git xz-utils unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY preinstall.mjs ./
RUN node preinstall.mjs
```

```js
// preinstall.mjs: fails the image build when a scanner is missing or does not run.
import { preinstallScanners } from "openqodex";

const require = ["semgrep", "gitleaks", "squawk", "sqlfluff", "osv-scanner", "actionlint", "zizmor", "hadolint", "trivy", "checkov", "tflint", "kube-linter", "kubeconform", "shellcheck", "ruff", "bandit", "oxlint"];
const result = await preinstallScanners({ installRoot: "/opt/openqodex/tools", require, onProgress: (line) => console.log(line) });
if (!result.ok) {
  console.error(result.missing.join("\n"));
  process.exit(1);
}
```

The server then passes `installRoot: "/opt/openqodex/tools"`. Install the runtimes of the table above in the image before this step to add brakeman, rubocop, golangci or cargo-deny; the check names any that is still missing. The install root holds the tools of one version's table: build the image with the same `openqodex` version the server imports.

## The consumer's steps

1. Clone two commits. Fetch the head and the merge base with the history between them, so the ancestry can be proved. A shallow clone of the head alone ends as `history unknown`.
2. Pass the merge base the host's comparison gives (GitHub's `merge_base_commit`, GitLab's `diff_refs.base_sha`), not the target branch's sha.
3. Map the config. Parse the repository's settings with `parseConfig`, or build a `Config` from your own settings key by key (`config` documents each key). A setting with no counterpart is left out, never guessed.
4. Turn the model client's retries off for review calls, and give `authorize` the product's dollar limits.
5. Give each review a fresh `workDir` and remove it when the review returns.
6. Feed `status` into posting and check runs: an `incomplete` review is not a passed one.

### Bundling

The library finds its files from where it is installed: the lenses in `lenses/`, the pinned scanner table `toolchain.json` with its lock files in `locks/`, and the tree-sitter grammars in `wasm/`, all beside `dist/` in the package. A program that bundles its own code must leave `openqodex` out of the bundle (`external: ["openqodex"]` in esbuild, or the same setting in another bundler), so these files resolve from the installed package. Inlined into a bundle, the library looks for them beside the bundle and finds none of them.

## scanners

`runScanners(args)` runs the built-in scanners that fit the changed files and returns `Promise<RunScannersResult>`, which is `{ scan, secrets, checked }`.

- `repoDir`: the folder the scanners read.
- `changedPaths`: the changed files, relative to `repoDir`.
- `coverage` (optional): a `Map` from each path to the set of its changed line numbers. With it, only findings on changed lines are kept. Without it, every finding in a changed file is kept.
- `baseText` (optional): `(path) => Promise<string | null>`, the base version of a file. With it, a change to what a scanner reads from a shared settings file, such as `pyproject.toml`, is reported.
- `config`: a `Config`, from `parseConfig` or `loadConfig`.
- `resolveTool`: from `createToolResolver`.
- `only` and `skip` (optional): scanner names to run, or to leave out.
- `onProgress` (optional): called with one line per step.
- `scratchRoot` (optional): where the run writes. Left out, the laptop's places: caches under `~/.openqodex/cache` and temporary folders in the system temp folder. Given, every folder the run makes or fills is under this one: caches in `<scratchRoot>/cache`, temporary folders in `<scratchRoot>/tmp`, and every scanner process gets `HOME` `<scratchRoot>/home` and `TMPDIR` `<scratchRoot>/tmp`. Python scanners write no bytecode and Go keeps its build cache in the scratch, so the install root is only read. A Go tool gets a module cache of the run's own, filled from the machine's module cache read as files, and a Cargo tool a Cargo home of the run's own, filled with copies of what each changed `Cargo.lock` needs; the machine's caches are never written. A symbolic link anywhere under the scratch root, an existing folder included, is refused. `<scratchRoot>/tmp` must be 64 characters or fewer for TFLint, whose plugin socket goes there; TFLint fails with the reason otherwise. Two runs with two scratch roots share nothing. The caller removes the folder afterwards.
- `custom` (optional): custom scanners that the command's trust step prepared. Leave it out.

In the result, `scan.candidates` are the findings and `scan.scanners` has one summary per scanner: whether it ran, and why not when it did not. `secrets` holds the raw secrets the scanners matched, for redacting text; never store it. `checked` maps each scanner rule that ran to the files it checked.

`createToolResolver({ allowInstall, installRoot, installBudgetMs, onProgress })` returns a `ResolveTool`: `(scanner) => Promise<ToolResolution>`. A scanner is never taken from PATH. Only the pinned version in `installRoot` is used: one folder per tool, by default `$OPENQODEX_HOME/tools` (`~/.openqodex/tools`). With `allowInstall: false`, a missing tool is reported as not installed and nothing is downloaded. With `allowInstall: true`, a missing tool is installed from the pinned table and checked against its sha256, by the package's own `openqodex` command in a separate process, which installs only into the OpenQodex home: `installRoot` must then be left out or be `$OPENQODEX_HOME/tools`, and any other root throws. Fill another root with `preinstallScanners`. `installBudgetMs` is how long to wait for an install and the runtime checks; left out or `null`, it waits until they are done.

`preinstallScanners({ installRoot, require })` installs and checks the scanners of an image; see "Preinstalling the scanners in an image".

`loadToolchain()` returns the pinned scanner table, `{ schema: 1, tools }`: per tool, its version, how it installs and, for a release download, the URL and sha256 for each platform. A tool installed from a registry (uv, gem) is pinned by a lock file of sha256 hashes in `locks/`.

`toolchainHash()` returns the sha256 of the table and every lock file as shipped. It changes when a pin changes and only then, so it works as a cache key for a tools folder.

## graph

`buildGraph(args)` reads the code of a git work tree and returns `Promise<Graph>`: the definitions, calls and imports of its TypeScript, JavaScript, Python, Go and Ruby files, and how they connect. `args` is a `BuildArgs`:

- `repoRoot`: the folder to read. It must be a git work tree, because the list of files comes from git.
- `files` (optional): paths to read first, such as the changed files, so a cut never leaves them out.
- `only` (optional): the only paths the graph may read.
- `budgetMs`, `maxFiles`, `maxFileBytes`, `maxHeapMb` (optional): the limits, by default 10 seconds, 4,000 parses, 512 KB per file and 1,536 MB.
- `base` (optional): `{ sha, files }`. Each changed file's version at `sha` is parsed too, so a symbol the change removed is known with the callers it leaves behind.
- `store` (optional): where facts are kept between builds. Leave it out to keep nothing.
- `onProgress` (optional): called with one line per step.

`detectImpact(graph, change)` returns the blast radius of a change as an `ImpactSummary`. `change` needs `files` (the changed files) and `coverage` (the changed lines). The summary lists the symbols the change touches or removes, their callers and callees with how certain each link is, the files that import a changed file, what the graph could not see, and a risk level.

`extractFacts(lang, text)` parses the text of one file and returns `Promise<FileFacts | null>`: its definitions, calls and imports, extracted the same way a build does it. `lang` is one of `typescript`, `tsx`, `javascript`, `python`, `go` and `ruby`. It returns `null` when the parse takes longer than two seconds.

`writePacket({ root, repoRoot, graph, impact, baseSha, secrets })` writes the graph's view of a change as files under `.openqodex-review/graph/` in `root`, for a reviewer to read, and returns `Promise<{ dir, files }>`. Every secret in `secrets` is redacted from every file. It throws `PacketCollision` when `root` already holds `.openqodex-review`, and `PacketLeak` when a secret is still found in a written file.

## lenses

A lens is a named bug pattern, one markdown file, that the review hands to the reviewer when a change matches it. The package ships 48.

- `loadLensCatalog(dir)` returns every lens as a `Lens`. `dir` is optional; without it the lenses come from the installed package.
- `defaultLensDir()` returns the folder of the installed package's lenses.
- `selectLensesForDiff({ diff, files, catalog, covered })` returns the lenses that match a change, at most four, most specific first, as `SelectedLens[]`. `diff` is the change's unified diff, `files` the changed paths, `catalog` the lenses to choose from. `covered` (optional) is `(token, file) => boolean`: a lens stands down when a scanner rule that ran already checks what it asks for.
- `selectLenses(change, dir, covered)` does the same from a `Change`, with the lenses in `dir` or the installed package's.

## Config

`parseConfig(source, file, options)` parses the text of a `.openqodex/config.yaml` and returns `{ config, warnings }`. `file` (optional) names the file in messages. It throws when the text is not valid YAML or breaks the schema; the message names the file and, for a wrong key, the key. The keys are documented in `config`.

`loadConfig(repoRoot, path, options)` reads the config of a repository and returns a `LoadedConfig`: `{ config, path, warnings }`. `path` (optional) names the file to read; without it, `.openqodex/config.yaml` is read, or `.openqodex.yaml` when only that one exists. With no file at all, `config` holds the defaults and `path` is `null`.

## render

Each renderer takes a `Report`, the shape `report.json` holds, and returns a string.

- `renderMarkdown(report)`: the markdown report, as `report.md`.
- `renderSarif(report)`: SARIF 2.1.0, as `report.sarif`.
- `renderJson(report)`: the JSON report, as `report.json`.
- `renderReview(report, { format, color })`: the review as the command prints it. `format` is `terminal` or `markdown`; `color` (optional) adds terminal colours.

## Types

The library exports the types its functions take and return. The finding, report and completion types are `Report`, `ReportFinding`, `Verdict`, `CompletionRecord`, `ReviewerRecord`, `StaticFinding`, `Candidate`, `Severity` and `Category`. A review by a model reviewer has its own completion record, `ModelCompletionRecord` (contract `openqodex-model-review-1`). Its parts are `ModelToolEntry`, `ModelAttempt` and `ModelCallUsage`. `Report.completion` holds either record; its type is `AnyCompletionRecord`. The others are `ScannerSource`, `ScannerRunSummary`, `ScanResult`, `RunScannersResult`, `ResolveTool`, `ToolResolution`, `Toolchain`, `Recipe`, `PreinstallOptions`, `PreinstallResult`, `PreinstallTool`, `DiffCoverage`, `Change`, `ChangedFile`, `Config`, `LoadedConfig`, `ParseOptions`, `Lens`, `SelectedLens`, `ImpactSummary`, `Graph`, `BuildArgs`, `FileFacts` and `Lang`.
