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
- `pnpm gate`: every check in order, stopping at the first failure. It must be green before any push. CI (`.github/workflows/ci.yml`) runs the same steps. A pull request and its merge queue run get the fast gate on Linux; the full gate runs on Linux and macOS on main and for the version pull request (see below).
- `pnpm changeset`: add a changeset to any pull request with a change a user can see.
- `pnpm docs:index`: regenerates `docs/llms.txt`. The gate checks it with `--check`, and checks the README's facts with `scripts/docs-facts.mjs`.

## Where things live

- `packages/cli`: the `openqodex` binary. It is published as one bundled file, `dist/bin.js`, with no runtime dependencies; every library it uses is a dev dependency that the bundler inlines.
- `packages/core`: the change source, the config parser, the lenses, the review brief, the renderers.
- `packages/scanners`: the scanner adapters, the changed-line filter and the pinned scanner table (`toolchain.json`).
- `packages/graph`: the code graph. `packages/review`: the review engine the library uses. `packages/mcp`: the code graph's MCP server.
- `skills/openqodex/`: the agent skill. `plugins/claude-code/` and `plugins/codex/`: the Claude Code and Codex plugins. `docs/`: the docs, shipped in the package. `examples/demo-repo/`: the sample repo with planted bugs.
- Assets that ship beside the bundle (lenses, docs, skill, templates, toolchain table, demo) are found at run time relative to the installed package through `assetPath()` in `packages/cli/src/assets.ts`, never from the current directory. `scripts/copy-assets.mjs` copies them into `packages/cli` after the build; the copies are gitignored.

## Pull requests and the merge queue

- An ordinary pull request runs one check: the fast gate on Linux, which is the gate without the end-to-end tests and the golden run. The macOS gate and the scanner-only benchmark show as skipped. Run the full gate (`pnpm gate`) on your machine before you push.
- When the pull request is ready, a maintainer adds it to the merge queue. The queue merges it with main and with every pull request ahead of it in the queue, runs the fast gate on that result, and merges the pull request into main when it passes. When it fails, the queue removes the pull request and main does not change. Fix the branch and add it to the queue again.
- The full gate is the gate with the end-to-end tests and the golden run, on Linux and on macOS, and the scanner-only benchmark. It runs for the "Version packages" pull request, on the pull request and in the merge queue, so the queue merges a release only on a green full gate; on a pull request with the label `full-ci`; and on each push to main. A break only the full gate catches shows on main's run and is fixed before the version pull request.
- To run the full gate on any pull request, for example on a scanner or installer change, add the label `full-ci`.
- Each push to main runs the full gate and the release workflow.

## Exit codes

0 clean or warnings only, 1 a finding at or above the block threshold, 2 the tool itself failed.

## Tests

- No test fakes a module that lives in this repo or a binary on this machine. The only fake allowed is a model provider.
- End-to-end first: a feature is proved by running the real CLI on a real repo and reading the saved report.
- A piece that must be tested alone gets its list of failure cases written before its code. Do not add unit tests after the code to raise coverage.

## Writing

Plain English, sentence case, no emoji, no exclamation marks, no em dash character anywhere (prose, code comments, commit messages, changelog). Define a term the first time it appears. `scripts/scrub.mjs` fails the gate on private material and on the em dash.
