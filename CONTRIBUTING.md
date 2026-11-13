# Contributing to OpenQodex

Thank you for helping. This page says how to set up the repository, how changes are tested, and what a pull request needs.

## Setup

- Node 22. The published package must work on Node 22, so test on 22 even when your machine has a newer default.
- pnpm 9. `package.json` pins the exact version under `packageManager`.
- git.

```
pnpm install
pnpm build
```

Run the CLI you built from any git repository with a change:

```
node packages/cli/dist/bin.js review
```

## The gate and the tests

`AGENTS.md` owns the rules for the gate and the tests: the three tiers, where CI runs each, and how a test is written. Read it before your first change. Before you push, run:

```
pnpm gate:fast
```

## Changesets

A pull request with a change a user can see carries a changeset:

```
pnpm changeset
```

Pick the `openqodex` package and the bump. Write one line in plain English about what the user sees. The release workflow turns changesets into `CHANGELOG.md`.

## Before a release

The "Version packages" pull request publishes when it merges. Before you merge it, check out its head and compare the build with the published package on the planted cases and AACR-Bench's development subset:

```
node benchmark/build-cli.mjs
node benchmark/ingest/aacr.mjs --data-only
node benchmark/release-check.mjs --install-scanners
```

It runs no model and spends nothing. It must exit 0. Exit 1 names each loss, such as a planted bug the published package found and the new build misses: fix it before the release. Exit 2 means it could not run and shows nothing either way. On a machine without Ruby, Go or Cargo, add `--allow-missing-scanners`. `docs/benchmark.md` ("The release check") says what it compares. The release workflow runs the planted part again before it publishes, and does not publish on any exit but 0.

## After a release

The self-update can only be proven between two real releases. After a publish, run the release check from the previous release to the new one:

```
node scripts/check-self-update.mjs --from <previous> --to <new> --now
```

It installs `<previous>` from npm into a temporary home with `init`, runs the update through the launcher and requires that the launcher then runs `<new>`. Without `--now` it starts the daily check through a normal command instead, which installs only a release at least 24 hours old.

## Docs

The docs in `docs/` ship inside the package. A change to a config key, a flag or a command updates its page in the same pull request. `pnpm docs:index` regenerates `docs/llms.txt`.

## Writing

Plain English, sentence case, no emoji, no exclamation marks. Never use the em dash character, in prose, code comments, commit messages or the changelog. The gate fails on it.

## Sign-off

Every commit carries a Developer Certificate of Origin sign-off. It states that you wrote the change or have the right to submit it under the Apache 2.0 licence. The text is at https://developercertificate.org.

Add the sign-off with `git commit -s`. It adds this line, with your name and email:

```
Signed-off-by: Your Name <you@example.com>
```

## Pull requests

- One change per pull request.
- `pnpm gate:fast` is green on your machine.
- The pull request carries its test, its docs change and its changeset.
- When it is ready, a maintainer adds it to the merge queue. `AGENTS.md` says what the queue runs and what to do when it removes a pull request.
- Security problems are never reported in a pull request or an issue. See `SECURITY.md`.

## Adding a built-in scanner

Open a scanner request issue first. A built-in scanner needs three things. It needs a pinned version for every supported system in `packages/scanners/toolchain.json`. It needs an adapter. It needs a planted bug in the demo repository that the end-to-end test checks. A compatible scanner can already run as a custom scanner without a change here: one that writes SARIF or one JSON document. See `docs/custom-scanners.md`.
