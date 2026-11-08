# Working in this repo

To install or use OpenQodex in another repository, read `docs/for-agents.md`. This file is for work on OpenQodex itself.

OpenQodex is open source AI code review for Claude Code and Codex. It runs before you push, from your coding agent or your terminal. This file tells a coding agent how the repo is built and tested.

## Setup

- Node 22 or newer. The published package must work on Node 22, so test on 22 even if your machine has a newer default.
- pnpm 9 (the version is pinned in `package.json` under `packageManager`).
- `pnpm install`, then `pnpm build`.

## Commands

- `pnpm build`: builds `@openqodex/core`, `@openqodex/scanners`, `@openqodex/graph`, `@openqodex/review` and `@openqodex/mcp`, then the `openqodex` CLI, then copies the shipped assets beside the bundle.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm test:e2e` (runs the built CLI as a real subprocess).
- `pnpm gate:fast`, `pnpm gate` and `pnpm gate:model`: the three tiers below. Each runs its checks in order and stops at the first failure.
- `pnpm changeset`: add a changeset to any pull request with a change a user can see.
- `pnpm docs:index`: regenerates `docs/llms.txt`. The gate checks it with `--check`, and checks the docs' facts with `scripts/docs-facts.mjs`.

## The three tiers

- The fast tier, `pnpm gate:fast` (`scripts/gate-fast.sh`): the shipped instruction templates, build, typecheck, lint, the unit tests of the changed packages and every package that depends on them, the skill and plugin manifests, the config docs, the docs index, the docs facts, the benchmark results and the private material scrub. A change outside `packages/`, or no `origin/main` to compare with, runs every unit test; `--all` does too. It must be green on your machine before every push.
- The real-programs tier, `pnpm gate` (`scripts/gate.sh`): the fast tier's checks with every unit test, plus a check that the required scanners are installed (so a scanner case cannot skip), the speed-ratio tests (`OPENQODEX_GROWTH_TESTS=1`), the end-to-end tests and the golden run (the review of the demo's planted change, compared file by file with `tests/golden/expected`). It runs real scanners and real git, and no model: the model cases skip and print why. A speed-ratio test red on a loaded runner is rerun, as the speed-ratio bullet below says.
- The real-model tier, `pnpm gate:model`: sets `OPENQODEX_MODEL_TESTS=1` and runs the model cases of the end-to-end tests, then the planted scan sample. It refuses to run when `CI` is set, fails when a reviewer login is missing, and fails unless the model cases ran and passed. A maintainer runs it once per release, before the version pull request merges.
- In CI, an ordinary pull request and its merge queue run get the fast tier, on Linux only. CI's fast tier runs every unit test, not only the changed packages', and leaves out the end-to-end tests and the golden run.
- CI runs the real-programs tier in four cases: a push to `main`; a merge queue run whose merge commit message names `/changeset-release/main`; a pull request from the branch `changeset-release/main` of this repository; a pull request with the label `full-ci`. In CI it runs on Linux and macOS, with the scanner-only benchmark.
- The macOS gate and the scanner-only benchmark run only in those four cases. On any other run they show as skipped, and a job skipped by its condition counts as passed.
- The three required checks are `Gate (ubuntu-latest)`, `Gate (macos-latest)` and `Scanner-only benchmark`. The ruleset on main requires them by these names, so the job names in `.github/workflows/ci.yml` never change.
- `scripts/docs-facts.mjs` fails when this section and `ci.yml` disagree.

## Where things live

- `packages/cli`: the `openqodex` binary. It is published as one bundled file, `dist/bin.js`, with no runtime dependencies; every library it uses is a dev dependency that the bundler inlines.
- `packages/core`: the change source, the config parser, the lenses, the review brief, the renderers.
- `packages/scanners`: the scanner adapters, the changed-line filter and the pinned scanner table (`toolchain.json`).
- `packages/graph`: the code graph. `packages/review`: the review engine the library uses. `packages/mcp`: the code graph's MCP server.
- `skills/openqodex/`: the agent skill. `plugins/claude-code/` and `plugins/codex/`: the Claude Code and Codex plugins. `docs/`: the docs, shipped in the package. `examples/demo-repo/`: the sample repo with planted bugs.
- Assets that ship beside the bundle (lenses, docs, skill, templates, toolchain table, demo) are found at run time relative to the installed package through `assetPath()` in `packages/cli/src/assets.ts`, never from the current directory. `scripts/copy-assets.mjs` copies them into `packages/cli` after the build; the copies are gitignored.

## Pull requests and the merge queue

- When the pull request is ready, a maintainer adds it to the merge queue. The queue merges it with main and with every pull request ahead of it in the queue, runs CI on that result, and merges the pull request into main when it passes. When it fails, the queue removes the pull request and main does not change. Fix the branch and add it to the queue again.
- The "Version packages" pull request (the branch `changeset-release/main`) gets the real-programs tier on the pull request and in the merge queue, so the queue merges a release only on a green run. The release workflow pushes its branch with the release token (secret `RELEASE_TOKEN`, a maintainer's fine-grained personal access token limited to this repository), so its pull request run starts on its own; before that it waited for a maintainer's approval click.
- A break only the real-programs tier catches shows on main's run and is fixed before the version pull request.
- To get the real-programs tier on any pull request, for example a scanner or installer change, a maintainer adds the label `full-ci`.
- Each push to main also runs the release workflow.

## Exit codes

0 clean or warnings only, 1 a finding at or above the block threshold, 2 the tool itself failed.

## Tests

- No test fakes a module that lives in this repo or a program on this machine. `vi.mock` is not used. Tests use real temporary folders, real git repositories and real scanner output.
- The only fakes allowed are a model provider and a reviewer driver (`ReviewerDriver`) that stands in for the model.
- A test makes its temporary folders with `tempDir()` from `tests/temp-dirs.mjs`, and its file calls `afterAll(removeTempDirs)`. Each test run keeps its temporary folders in one folder of its own and fails when a test leaves one behind (`tests/temp-guard.ts`).
- End-to-end first: a feature is proved by running the real CLI on a real repo and reading the saved report.
- A piece that must be tested alone starts with its failure cases, listed in a comment at the top of the test file. The tests follow that list, and the code comes last. Do not add unit tests after the code to raise coverage.
- Every test names the failure it guards. It is the one owner of that behaviour, at the strongest boundary that can see it.
- A new test never asserts how the code is written, and never takes its expected value from the code under test.
- A bug report becomes a test on the demo repo before it is fixed. The test fails before the fix, and the test and the fix share one pull request.

## Traps

- `.github/actions/gate/action.yml` runs the steps of `scripts/gate.sh` one for one; change both together. `scripts/docs-facts.mjs` fails when they differ.
- The scanner-only benchmark runs in CI only. It installs every scanner, which needs Ruby 3.3 and Go 1.26, so `pnpm gate` does not run it.
- The first end-to-end run downloads the pinned scanners. In CI the end-to-end tests fail when any scanner is missing.
- The speed-ratio tests compare CPU time on two input sizes against a bound of 8. On a loaded runner a ratio can pass 8 with no code change (issues 215, 275, 296), so they run only on the real-programs tier. A red main run from one of them fails the release workflow's CI check at once. To release that commit, a maintainer reruns the failed CI job, then reruns the release workflow's failed jobs (or pushes another commit); two reds in a row on one file is a bug, not noise.

## Writing

Plain English, sentence case, no emoji, no exclamation marks, no em dash character anywhere (prose, code comments, commit messages, changelog). Define a term the first time it appears. `scripts/scrub.mjs` fails the gate on private material and on the em dash.
