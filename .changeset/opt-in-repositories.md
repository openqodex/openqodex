---
"openqodex": minor
---

OpenQodex is now opt-in per repository: agents review before a push only in a repository with an OpenQodex settings file (`.openqodex/config.yaml`, or `.openqodex.yaml` at its root), and the Claude Code and Codex push hooks say nothing anywhere else. The note `init` writes for each agent, the team note in a repository's `CLAUDE.md` and `AGENTS.md`, and the project note are each one line now, and the team note names `npx -y openqodex review` with no version. A review you run by hand in a repository with no settings file still runs; the settings file it creates opts that repository in, and it says so. What you need to do: run `openqodex init` once to replace the old note with the new one, and run it in each repository you want reviewed. An old note you did not edit is replaced in place; one you edited is left as it is.
