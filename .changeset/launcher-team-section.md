---
"openqodex": minor
---

`init` inside a repository adds a short review section to the repository's `CLAUDE.md` and `AGENTS.md`, so a teammate's agent reviews before pushing with nothing installed; the files show in `git status` to be committed. `--no-repo` skips it, and `--uninstall` removes exactly that section.
Every user-scope install gets the launcher in `~/.openqodex/bin/`, even for Cursor or Cline alone. The user-scope skill is now a short stub that runs `<launcher> guide skill` for the full procedure of the active version, and the user-scope Cursor and Cline rules call the launcher instead of `npx -y openqodex@<version>`. The next `init` replaces a skill or rule an earlier `init` wrote, while it is unchanged.
New `guide skill`: prints the review procedure of the running version, with its commands written for the launcher when the launcher started it.
The launcher runs the version named on the first line of `~/.openqodex/runtime/current`, and the version `init` installed when that line is missing, malformed or names a copy that is gone. A runtime copy is never replaced once written.
The skill installed with `npx skills add` uses `~/.openqodex/bin/openqodex` when it exists.
