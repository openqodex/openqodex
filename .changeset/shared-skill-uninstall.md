---
"openqodex": patch
---

Uninstalling Codex or Cursor in project scope no longer removes the skill file the other still uses (`.agents/skills/openqodex/SKILL.md`). Uninstall leaves the file while the other agent's own files are still in place, also on a machine with no install record. `install.json` does not change.
