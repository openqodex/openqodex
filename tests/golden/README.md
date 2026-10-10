# Golden run

One fixed review recorded file by file, so a change to the review code is proved to leave its output the same. `pnpm golden:check` builds the CLI, reviews the demo's planted change with the claude driver and then the codex driver, and compares every output file with `expected/`. It prints a unified diff of each file that differs and exits 1. Use Node 22:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm golden:check
```

Everything is real except the model: the built CLI, git, the graph and the pinned scanner binaries, installed once per run with `doctor --install` into a temporary home. The two stand-ins in `stand-ins/` play `claude` and `codex` on `PATH` and replay one frozen answer, `stand-ins/submission.json`, which raises every scanner candidate and drops none. The demo's generated secret is replaced with one synthetic key (`fixture-secret.mjs`), so the change id is the same on every run.

The review runs with `--skip semgrep,osv-scanner`. Those two read live data on every run: semgrep fetches its rule packs from the Semgrep registry, and osv-scanner looks the lockfile's packages up at osv.dev. A new rule or a new advisory would change the recording with no change to the code. Every other scanner answers from its pinned binary alone, so the recording holds only their candidates. The end-to-end suite (`tests/e2e`) still runs semgrep and osv-scanner live on the demo.

Values that change between two identical runs, such as clocks, durations, temporary paths, run ids and process ids, are replaced with fixed tokens. `normalize.mjs` lists each one with its reason. Change ids, candidate ids, contract versions, coverage, findings, the brief's text and receipt kinds are never replaced.

When the review's output changes on purpose, record it again and commit `expected/` with the change:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm golden:record
```

When the demo's candidates change (a new scanner version, a new planted bug), the stand-ins' answer no longer fits and the recording stops with "did not complete with every scanner candidate raised". Freeze the answer again first, then record:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm golden:answer
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm golden:record
```

`FAILURES.md` lists what the harness guards against; `tests/golden.test.ts` tests the normalisation, the comparison and the frozen answer without running a review.
