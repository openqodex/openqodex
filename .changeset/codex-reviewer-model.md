---
"openqodex": minor
---

You can now choose the Codex reviewer's model and reasoning effort. Set `reviewer_model` (a model id) and `reviewer_effort` (`low`, `medium`, `high` or `xhigh`) in `~/.openqodex/config.yaml`, or pass `--reviewer-model` and `--reviewer-effort` to `review` for one run. Without them Codex keeps its own default. The report's reviewer line and `openqodex doctor` name both. The Claude Code reviewer ignores them.
