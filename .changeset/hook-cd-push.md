---
"openqodex": patch
---

The push check inside Claude Code and Codex now recognises the push lines agents usually type, such as `cd /path/to/worktree && git push -u origin my-branch 2>&1 | tail -5`, and judges them in the folder the `cd` names, instead of saying it could not tell what the push sends (issue 346).
