# Agents

OpenQodex runs from Claude Code, Cursor, Codex CLI, Cline and Goose. `openqodex init` installs it into each one it finds. Whichever agent asks for the review, the review itself runs in a reviewer process OpenQodex starts: Claude Code or Codex, on your own login, with no other key. Cursor is not used as a reviewer (`security` says why); in Cursor, Cline and Goose the review works when Claude Code or Codex is installed too. Without either, `review` names the command with which the agent you are in reviews the change itself (see "Who reviews, by what is installed").

## Run init

In your own terminal:

```
npx openqodex init
```

An agent installs OpenQodex for itself with the same command, naming itself and asking nothing: `npx -y openqodex@<version> init --yes --agent <host>`, where `<host>` is `claude-code`, `codex`, `cursor`, `cline` or `goose`. The README and the quickstart give that line with the current version. Codex runs commands in a sandbox that by default cannot write outside the project or reach the network, so from Codex, run it in your own terminal.

`init` prints every file it will write and asks once: "Write these files?". The plan lists each file under the one it is for: "For you, on this machine" (the agent files in your home folder, the launcher, the git hook of this clone) and "For the team, in this repo" (the files to commit). `--agent <name>` picks agents by hand: `claude-code`, `cursor`, `codex`, `cline`, `goose` or `all`. When `init` finds no agent, it asks which of the five to install into, before the plan. `--dry-run` prints the plan and writes nothing. `--yes` writes it without asking.

Inside a repository, the plan also holds the git pre-push hook, so every push from this repo is checked for a review, from an agent or by hand. `--hook none` leaves it out, and `--hook pre-push` puts it back. The choice is recorded for that repository, so a later `init` keeps it. The hook is described under "A git hook for every tool" below.

For each agent, the plan also registers the code graph's MCP server. `--no-mcp` leaves it out. It is described under "The code graph's MCP server" below.

Without a terminal to ask in, `init` writes the plan when it runs inside Claude Code, Codex or Cursor (their shells set `CLAUDECODE`, `CODEX_THREAD_ID` or `CURSOR_AGENT`): the agent ran it on purpose. Anywhere else without a terminal, it prints the plan and the flags that change it, writes nothing and exits 2, until you add `--yes`.

## The instruction section

In user scope, `init` adds one marked line to each agent's global instruction file, which the agent reads in every repository. It prints the line before writing it:

```
<!-- openqodex:start -->
Before any push, review the change with the openqodex skill.
<!-- openqodex:end -->
```

The skill holds the procedure, and a repository's own team section (below) says how that repository reviews. An install made by an earlier version, with the longer section, gets this line in its place on the next `init`, while that section is still exactly as `init` wrote it.

In project scope the repository's `CLAUDE.md` and `AGENTS.md` get a longer section: review with the openqodex skill when a feature or fix is done, and do not push on a blocked verdict unless the developer says so after seeing the findings. The Cursor and Cline rules carry that longer section too: Cursor has no instruction file in the home folder, so its rule in the repository holds it. So does Goose's `.goosehints` in the repository.

The tables below name the file for each agent. In an existing file, the section is appended and your own text stays as it is. `--uninstall` removes exactly that section, and nothing around it.

## The team section in the repository

Inside a repository, the plan of `init` in user scope also holds a review section for this repo's `CLAUDE.md` and `AGENTS.md`, so teammates' agents review before they push too. `--no-repo` leaves it out, and the choice is recorded for that repository: a later `init`, with `--yes` or without, keeps it out. `init --uninstall` in that repository forgets the choice.

The section goes into `CLAUDE.md` and `AGENTS.md` at the root of the repository, and `init` creates a file that is not there. It is meant for a teammate who has installed nothing, so it names only the pinned `npx` command:

```
<!-- openqodex:start -->
## Review with OpenQodex before you push
- Before any `git push`, run `npx -y openqodex@<version> review` from the repository root. It can take minutes, and OpenQodex stops the reviewer after 30 minutes. Run it in the background and wait for it to exit.
- Show the developer the receipt it prints: the verdict, one line per finding and the absolute path of `report.html`. Ask: "Fix all, or tell me which?" Fix only the findings they name (`npx -y openqodex@<version> findings 1,3` prints them in full), then review again and show the new receipt. OpenQodex starts its own reviewer process, so by default the agent that wrote the code does not judge its own work.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- Never add a file to `review.instructions_files` on your own. Ask the developer which files the reviewer may use, then set only what they name.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
```

The two files show in `git status`, and `init` says to commit them. When git ignores one of them in this repository, `init` says so instead, since your team does not get it. `init` writes neither file through a symbolic link. A section you edited is yours: a later `init` and `--uninstall` leave it as it is. `--uninstall` removes our untouched section, and deletes a file only when `init` created it and nothing else is in it. In project scope the same two files carry the instruction section instead, never both.

## The review runs in its own reviewer process

The skill tells the agent to run one command, `review`, wait for it, and show you what it prints: a receipt with the verdict, one line per finding (its number, severity, category, title, file and line) and the absolute path of `report.html`. The agent then asks you "Fix all, or tell me which?" and fixes only the findings you name; `findings <numbers>` prints those in full for it. When you already said what to fix, such as "review and fix everything", it does that without asking again. This is an instruction to the agent, not a lock: the agent can open the report files, and the push gate and your own permission prompts still apply. The agent does not review the change itself and starts no subagent. `review` starts a fresh reviewer process with no memory of the agent's session, inside a frozen copy of the change. Claude Code starts with none of your settings or instruction files and read, search and list tools only. Codex starts in a read-only sandbox with none of your config or the repository's instruction files; it still loads your global `~/.codex/AGENTS.md`. The report says which reviewer ran; the tool writes that line, never the model.

A review can take minutes. OpenQodex stops the reviewer after 30 minutes for a change and after 2 hours for `--all`. Agents often stop a command sooner, so the skill tells the agent to run it in the background; `review` prints a line every 15 seconds while the reviewer works.

The reviewer edits nothing and runs none of the repository's code. Claude Code has no shell. Codex has a shell whose commands can read the copy of the change and the system folders, and cannot write or reach the network.

## Who reviews, by what is installed

| Installed | What `review` gives you |
|---|---|
| Claude Code, logged in | A fresh Claude Code process that OpenQodex starts reviews the change. |
| Codex, logged in, and no Claude Code (or Claude Code logged out) | A fresh Codex process that OpenQodex starts reviews the change. |
| Both, logged in | The agent you run `review` from reviews: Codex from Codex, Claude Code from Claude Code. From anywhere else, Claude Code. `--reviewer codex` or `reviewer: codex` in `~/.openqodex/config.yaml` picks Codex. |
| Only Cursor (or both logged out), or Codex inside Codex's own sandbox | "Full review unavailable", exit 2, and a fallback: run `review --agent` and the agent you are in follows the brief it prints, then `review --finalize`. That report says on its first line after the verdict "Reviewed by the coding agent you are using." |
| None of them | "Full review unavailable", exit 2, and the scanner findings saved to a file as unchecked candidates, never as a review. The fallback line prints too, but no agent is there to follow it. |

The skill tells the agent to follow the fallback when `review` prints it. The push hooks count a fallback review as reviewed, with one line naming who reviewed.

## The repo folder

Inside a repository, `init` creates two files in `.openqodex/`, and so does the first `review` or `scan` there:

- `.openqodex/config.yaml`: the config, every key at its default with a comment. `config` lists every key. It is not created while a `.openqodex.yaml` sits at the root of the repository; that file is still read, and `init` says how to move it.
- `.openqodex/custom-instructions.md`: what a reviewer of this repository must know: conventions, what never to flag, what always to check. The review brief carries its text word for word. A file over 32 KB stops the review with a message; nothing in it is cut. The brief shows it to the reviewer as quoted text from the repository, because anyone who can commit can change it. It can widen or narrow what the reviewer flags, and a candidate dropped because of it says so in the report; it cannot give the reviewer a tool, skip a check or change the finding shape.

The brief can also quote [convention files](config.md#convention-files) chosen by the developer. Never add a path on your own. Ask which files the reviewer may use, then set only what they name.

Both are meant to be committed, so the whole team shares them. A file that exists is never touched. `.openqodex/.gitignore` keeps the review reports out of git, so after the first run `git status` shows only these files and the `.gitignore`.

## User scope and project scope

The default is user scope. `init` writes into your home folder, so one install works in every repository. A rule file it must put inside a repository is added to `.git/info/exclude`, so it does not show in `git status`. The two repo folder files and the team section above are the exception: they are meant to be committed.

`--project` writes the files into the repository instead, for a team to commit. Run it inside a git repository.

In either scope, `init` decides each write from where the path really lands, never from its spelling. It walks the path as the system does, one name at a time, links followed and `.` and `..` taken after them. It refuses the file, with one line, when a link on the way lies in the repository's work tree, whatever the scope (an agent folder you set inside the repository with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` included), or when the path lands outside every folder `init` writes: the repository, its git folders, your home folder, the agents' own folders and `~/.openqodex`, each folder known by its identity on disk (device and inode), so neither case nor Unicode spelling changes the answer. A link outside the repository is yours and is followed, such as a dotfiles link of `~/.claude/settings.json` into a folder in your home. `init` writes through the folder it checked: a temp file created only if nothing is there, written, synced, renamed, and then checked to be the file it wrote in the folder it checked. Its own files in `~/.openqodex` (its record, the launcher, the runtime copies) are written and removed the same way, and a removal never follows a link.

## The launcher

In user scope, the push gate hooks, the skills and the Cursor and Cline rules call a launcher, not npx. Every user-scope install gets it, with or without a hook. `init` copies the package to `~/.openqodex/runtime/<version>/` and checks the copy runs. It writes the version to the first line of `~/.openqodex/runtime/current`, then writes `~/.openqodex/bin/openqodex`, a small script that runs the copy that line names with the Node `init` ran under. For a Node that Homebrew installed, it names Homebrew's stable path, such as `/opt/homebrew/opt/node@22/bin/node`, not the versioned folder the next `brew upgrade` removes. When that Node is gone, the script runs the one your `PATH` names and says so in one line. When the line is missing, is not a version, or names a copy that is gone, the script runs the version `init` installed. The hooks and the skill's commands call that script by its full path, so they do not depend on npx or your `PATH`. A copy is never changed once written: when a folder of the same version with other contents is in the way, `init` stops and names it.

The user-scope skill is a short stub: when to run, and one command, `<launcher> guide skill`, which prints the full procedure of the version the launcher runs, who reviews included, with every command written for the launcher. In user scope the Cursor and Cline rules hold the instruction section and the same `<launcher> guide skill` line. No file `init` writes in user scope names a version, a review command or who reviews, so an update leaves none of them out of date. They change only with a release that changes how agents run a review (its agent contract), together with the permission rules, which name exact command lines. Such a release is never installed in the background: `openqodex update` installs it, and `<launcher> init` then refreshes each file you never edited. After any update, the next command, `doctor` and `update --status` say how many files OpenQodex wrote are from an older version, when any are.

In project scope, the hooks, the skill and the rules call `npx -y openqodex@<version>` and the skill holds the full procedure, because the launcher path would not exist on a teammate's machine. These files, and the review section `init` adds to a repository's `CLAUDE.md` and `AGENTS.md`, stay on the version they name: an update never changes them. Run `init` again to move them.

## The code graph's MCP server

`init` registers an MCP server named `openqodex` with each agent it installs into. The server answers the code graph's questions as tools; `graph` describes the code graph. It runs on your machine as a local process that the agent starts (stdio), and sends nothing anywhere. In user scope it runs the launcher by its full path with the argument `mcp`. In project scope it runs `npx -y openqodex@<version> mcp`, which works on a teammate's machine. An agent reads its MCP servers when it starts: restart it after `init`, which says so.

| Agent | User scope | Project scope |
|---|---|---|
| Claude Code | `mcpServers` in `~/.claude.json` in your home folder, or in `.claude.json` in `$CLAUDE_CONFIG_DIR` when that is set | `mcpServers` in `.mcp.json` at the root of the repository |
| Cursor | `mcpServers` in `~/.cursor/mcp.json` | `mcpServers` in `.cursor/mcp.json` |
| Codex CLI | a `[mcp_servers.openqodex]` table between `# openqodex:start` and `# openqodex:end` at the end of `$CODEX_HOME/config.toml` (`~/.codex/config.toml` by default) | the same block in `.codex/config.toml` |
| Cline | `mcpServers` in `~/.cline/data/settings/cline_mcp_settings.json`, when `~/.cline/data`, the Cline CLI's folder, is there | none |
| Goose | none | none |

- The Claude Code and Cursor entries hold `"type": "stdio"`, `command` and `args`; the Cline entry holds `command` and `args`.
- Claude Code asks you to approve a project server from `.mcp.json` before it uses it.
- Codex reads a project's `.codex/config.toml` only in a trusted project.
- Cline documents a file for its CLI only, and no project file. With the VS Code extension alone, and in project scope, `init` writes no file for Cline and prints the entry to add in Cline's "Configure MCP Servers".
- Goose keeps its servers, which it calls extensions, in `~/.config/goose/config.yaml`. `init` does not edit that file. It prints the entry to add under `extensions` there.
- `init` adds the `openqodex` entry and keeps every other server and setting in the file. A file that does not parse, or whose `mcpServers` is not an object, is left untouched, and `init` exits 2. A server named `openqodex` that `init` did not write is left alone, and so is one you edited.
- In Codex's `config.toml`, `init` first reads every key the file defines, the way TOML reads them: quoted and escaped keys decoded, text inside strings and comments left out. It appends its block only when no key is `mcp_servers.openqodex` or under it, and `mcp_servers` is not set to an inline table or another value. A second definition would make Codex refuse the whole file. A file `init` cannot read as TOML is left untouched, and the plan says so. The table the block opens runs on to the next header, so a key you write after `# openqodex:end` belongs to it; `--no-mcp` and `init --uninstall` then leave the block in place, since removing it would move that key under the table before it, and the plan says so.
- Claude Code rewrites `~/.claude.json` while it runs. `init` reads the file again just before it writes and adds its entry to what is there then. It refuses only when the `openqodex` entry itself changed after the plan was printed.
- `--no-mcp` leaves the server out of the plan and removes the registrations `init` recorded. The choice is recorded for this machine in user scope, and for the repository in project scope, so a later `init`, with `--yes` or without, keeps it out. `--mcp` puts it back. `init --uninstall` forgets the choice.

## Claude Code

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.claude/skills/openqodex/SKILL.md` | `.claude/skills/openqodex/SKILL.md` |
| Push gate hook | merged into `~/.claude/settings.json` | merged into `.claude/settings.json` |
| Instructions | a marked section in `~/.claude/CLAUDE.md` | a marked section in `CLAUDE.md` |
| Permission rules | merged into `permissions.allow` of `~/.claude/settings.json` | none |
| Code graph MCP server | merged into `~/.claude.json` | merged into `.mcp.json` |

When `CLAUDE_CONFIG_DIR` is set, Claude Code reads its settings from that folder instead of `~/.claude`, and so do these user-scope paths. `init` also finds Claude Code by that folder.

The hook is one `PreToolUse` entry. It matches the `Bash` tool and runs only for `git push` commands. It calls `openqodex hook check`.

In user scope, `init` adds rules so Claude Code runs these review commands without asking, and the agent can review unattended: `<launcher> review` and `review --all`, each also with ` --offline` at the end, plus `guide`, `guide skill` and `guide <topic>`, `findings` with any numbers (it only reads the last review's report and prints it), and `graph` with any arguments (it reads the repository and writes only that repository's `.openqodex/graph/` folder and its local refs `refs/openqodex/graph/<tree>`). No rule covers the tools of the code graph's MCP server. A Claude Code rule such as `mcp__openqodex` names a server only by its name, and a repository's `.mcp.json` or a local-scope entry, which Claude Code prefers to the user-scope server `init` registers, can give that name to another server; the rule would let that server's tools run without asking. So Claude Code asks before the server's tools run. A `mcp__openqodex` rule an earlier build added is removed by the next `init`. Each review rule matches one exact line, so the same command with any other flag, such as `--output` or `--config`, a branch or a pull request, or chained with `&&`, still asks you. `scan`, `doctor`, `trust`, `update`, `init` and `report` still ask you. The rules of earlier versions for `review --agent` and `review --finalize` are removed by the next `init`. Project scope writes no permission rule: a committed settings file would decide for every teammate. A rule you already had is left alone, and `init --uninstall` removes only the rules `init` added. When a later version grants a different set, the next `init` removes the rules an earlier version added and adds the new ones. When your home path holds a space or another character the shell would read, the launcher is written in single quotes in the skill and in the rules alike. When the launcher's path holds `*`, which Claude Code reads as a wildcard, `init` writes no rule and says so in one line; Claude Code then asks before each review command.

A skill, rule or permission rule an earlier `init` wrote, such as the full-text skill of 0.2.1, is replaced by the next `init` only while it is still exactly as written. One you edited is left as it is, and `init` says so. A skill file that holds the skill exactly as some version of OpenQodex shipped it, such as the copy `npx skills add` writes, counts as OpenQodex's own too: `init` replaces it with the skill it keeps up to date, in every agent's skill folder.

Neither the skill `init` writes nor `guide skill` carries the sentence that tells an agent to prefer `~/.openqodex/bin/openqodex`: in user scope the launcher already runs every command, and in project scope the skill keeps the version the team committed.

`claude-code-review` walks through a review in Claude Code: install, the reviewer, the push gate and the report.

## Codex CLI

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.agents/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Instructions | a marked section in `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | a marked section in `AGENTS.md` |
| Push gate hook | merged into `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json` by default) | merged into `.codex/hooks.json` |
| Code graph MCP server | a marked block in `$CODEX_HOME/config.toml` (`~/.codex/config.toml` by default) | a marked block in `.codex/config.toml` |

`init` also finds Codex by `$CODEX_HOME`. The skill stays in `~/.agents/skills`, the folder the Codex docs name for skills, whatever `CODEX_HOME` says.

Codex runs the hook before every shell command. `hook check` returns at once and prints nothing when the command is not a `git push`.

Codex runs a new hook only after you trust it. Open Codex, run `/hooks`, and trust the OpenQodex hook. Until then, Codex skips the push gate. A project hook also needs the project itself to be trusted in Codex.

## Cursor

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cursor/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Rule | `.cursor/rules/openqodex.mdc` in the repository, excluded from git | `.cursor/rules/openqodex.mdc` |
| Code graph MCP server | merged into `~/.cursor/mcp.json` | merged into `.cursor/mcp.json` |

Cursor has no rule file in the home folder, so the rule always goes in the repository. In user scope, run `init` inside each repository where you want the rule. The rule applies to every chat, carries the instruction section, and tells Cursor to run `review` before any `git push`. The review itself needs Claude Code or Codex installed: `cursor-agent` cannot be held to reading only, so it is not a reviewer.

OpenQodex writes no Cursor hook. The rule asks Cursor to review, but nothing stops a push from Cursor.

## Cline

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cline/skills/openqodex/SKILL.md` | `.cline/skills/openqodex/SKILL.md` |
| Rule | `~/Documents/Cline/Rules/openqodex.md` | `.clinerules/openqodex.md` |
| Code graph MCP server | merged into `~/.cline/data/settings/cline_mcp_settings.json` when `~/.cline/data` is there | none |

OpenQodex writes no Cline hook. The rule carries the instruction section and asks Cline to review before any `git push`.

## Goose

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.config/goose/skills/openqodex/SKILL.md` | `.goose/skills/openqodex/SKILL.md` |
| Instructions | a marked section in `~/.config/goose/.goosehints` | a marked section in `.goosehints` |
| Code graph MCP server | none: `init` prints the entry to add | none: `init` prints the entry to add |

This setup was built from Goose's documentation and has not been run against Goose.

Goose reads `~/.config/goose/.goosehints` in every session, and the `.goosehints` files from the folder it starts in up to the repository root. `init` writes only files that Goose alone reads. Goose also reads `AGENTS.md` and `.agents/skills`, but the Codex and Cursor setups write there, and uninstalling one of those would remove a file Goose still needs.

`init` finds Goose by the `goose` program on your `PATH`, or by the folder `~/.config/goose`.

OpenQodex writes no Goose hook. The hints ask Goose to review before any `git push`, and the git pre-push hook still checks every push from a repository where `init` added it.

## What the push gate does

The gate runs in Claude Code and Codex, through the hooks above, and in the git pre-push hook below. It looks for the record `review` wrote, in your own `~/.openqodex/receipts/`. The check inside your agent looks for the record of your current work and does not know what a push sends: for a plain `git push` it asks whether your current work has a passing review, and for any other push command it says it cannot tell. The git pre-push hook looks for the record of exactly the change being pushed. Report files a branch carries under `.openqodex/` never count. It never scans, never starts a review, and never approves a push for you: your agent's own permission prompt for `git push` still applies.

- A complete review of this change that passed: the gate says nothing.
- A push whose commits change nothing but files under `.openqodex/`, counted from a commit the remote already has, with no other change in your work tree for the check inside your agent: `review` leaves `.openqodex/` out of every change, so there is nothing to review and the gate says nothing. A base that only a local branch holds, or a replace ref, never counts. The skip trusts this repository's own record of what the remote holds (its remote-tracking refs), as the receipt lookup does. The check inside your agent never skips a force push, or a push that sends more than the current branch.
- A complete review of this change that is blocked: the gate denies the push when `review.block_on_severity` is set, with the counts and the absolute path of `report.html`, and tells the agent to ask you "fix all, or tell me which?" and to fix only the findings you name.
- No review of this change: one line asking you to run `openqodex review`. With `review.block_on_severity` set, the gate denies the push, so an agent runs the review and tries again.
- An incomplete review of this change: one line saying so. It never blocks.
- A review from the older two-step protocol (`review --agent`, then `--finalize`): it counts as reviewed, with one line naming who reviewed.

`OPENQODEX_SKIP=1` in the environment lets the push through and says so. It is your switch, not your agent's.

The hook never breaks a push by accident. When `hook check` itself fails, it prints the reason on stderr and lets the agent go on.

## A git hook for every tool

The git pre-push hook covers pushes from any tool, by an agent or by hand. `init` asks to add it; to add it to a repository later:

```
npx openqodex hook install
```

Before each push it runs `openqodex hook pre-push` through the launcher. For each branch the push sends, it measures the change from the commit the remote already holds for that branch, or, for a new branch, from the merge base with the default branch (`review.default_base`, else the remote's default branch), to the pushed commit. It then looks for the review recorded in your home for exactly that change. When there is none, it also accepts the newest complete review whose range contains the push: its base is the push's base or an ancestor of it, the push's base is an ancestor of the pushed commit (so not a force push over work the review never saw), and the change from its base to the pushed commit is exactly the change it reviewed. So a branch reviewed with no upstream set, which a review measures from the default branch, still counts when it is pushed over its remote tip, while a push of another branch, or of work changed after the review, counts as not reviewed. When a branch the remote has is not reviewed and has no upstream here, the line says to set the upstream (`git branch --set-upstream-to <remote>/<branch>`), run `openqodex review`, then push. It prints the gate's line on stderr and nothing from the scanners. It stops the push only when the config sets `review.block_on_severity` and the review is missing or blocked. A lookup that fails for its own reasons never stops the push.

## Other ways to install

- The skill alone: `npx skills add openqodex/openqodex -g` writes the skill for you, in every repository, and nothing else: no push check, no instruction section, no launcher, no scanner download. Without `-g` it writes the skill into the repository (`.agents/skills/openqodex/`, a `.claude/skills/openqodex` link and `skills-lock.json`) for a team to commit. A later `init` replaces a skill file that is still exactly as shipped with the one it keeps up to date.
- Claude Code plugin: the repository holds a plugin marketplace with an `openqodex` plugin. The plugin carries the skill and the push gate hook. Its hook calls `npx -y openqodex@<version>`.
- Codex plugin: `plugins/codex/` packages the skill alone for the OpenAI plugin directory. It writes no hook and no instruction file.
- Cursor plugin: `.cursor-plugin/plugin.json` at the repository root makes the repository a Cursor plugin that carries the skill alone. It holds no rule. The rule that asks Cursor to review before every push comes from `init`, which writes `.cursor/rules/openqodex.mdc` in your repository. A rule shipped inside the plugin would go in a `rules/` folder at the repository root.

## Inside a sandbox

Some agents run commands in a sandbox that cannot reach the network or write outside the project. There, the first review cannot download scanners, and the reviewer may not reach its model or write in `~/.openqodex/`. Inside Codex's sandbox a second Codex does not start at all: with Codex as the reviewer, `review` prints "Full review unavailable" and the fallback. Each scanner reports why it was left out. Run this once in your own terminal, inside the repository, for the scanners it needs, and run `review` there when the reviewer cannot start inside the sandbox:

```
npx openqodex doctor --install
```

The review writes its reports inside the repository, in `.openqodex/`, and its temporary copy of the change in `~/.openqodex/checkouts/`.

## Uninstall

```
npx openqodex init --uninstall
```

Add `--project` to remove project files. `init` records what it wrote in `~/.openqodex/install.json`. `--uninstall` removes only what that record holds:

- A skill or rule file is removed only when it is unchanged since `init` wrote it.
- The instruction section is removed from each file; your own text in that file stays.
- In the repository you run it in: the git pre-push hook, when it is still the one OpenQodex wrote, and the `.openqodex/config.yaml` and `.openqodex/custom-instructions.md` that `init` created, when they are unchanged and not committed.
- The hook entry is removed from the settings file. Other settings stay. When `init` saved a backup and nothing else changed, the backup is put back.
- The `openqodex` MCP server entry, or Codex's marked block, is removed while it is still as `init` wrote it. Other servers and settings stay; `mcpServers` goes only when `init` added it, and the file only when `init` created it and nothing else is left in it.
- The `.git/info/exclude` lines are removed.
- The launcher and the runtime copies are removed when no hook or MCP server entry still calls them. The git pre-push hook counts as one.

Scanners stay in `~/.openqodex/tools/`. Delete that folder to remove them too.
