---
"openqodex": minor
---

An install made with `init` updates itself: at most once a day, after a review, scan or push check run through the launcher, a background check installs a newer release that is at least 24 hours old and whose npm provenance was signed by this repository's release workflow. The command never waits for it, and the next command says once which version it moved to.
New `openqodex update` command: `--now`, `--rollback`, `--off`, `--on` and `--status`. `doctor` shows the update state. Updates are off with `update: off` in `~/.openqodex/config.yaml`, `OPENQODEX_AUTO_UPDATE=0`, `--offline` and in CI.
`review --finalize` runs on the openqodex version that wrote the brief, and the brief's finalize command names that version's own runtime when the launcher started it.
A run through npx or a project-scope file never checks for updates; `doctor`, `review` and `scan` say when that pinned version is behind the newest one a check on this machine saw.
