---
"openqodex": patch
---

- A glob in `review.paths.exclude`, `review.disabled_rules`, a lens or a custom scanner's `paths` is matched in time that grows with the pattern times the path, never more. A pattern with many stars, such as one a pull request writes into the config, no longer backtracks against a long path and holds the review. A pattern longer than 1,024 characters matches nothing.
- The README and the Claude Code plugin's README say what each push check sees: the check inside your agent looks for a review of your current work and does not know what a push sends; the git pre-push hook that `init` adds checks exactly what is pushed.
