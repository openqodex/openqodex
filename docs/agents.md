# Agents

OpenQodex runs inside Claude Code, Cursor, Codex CLI and Cline. `openqodex init` installs it into each one it finds. The review then runs on the agent's own model, with no key.

## Run init

Run it in your own terminal, not inside the agent:

```
npx openqodex init
```

`init` prints every file it will write and asks once. `--agent <name>` picks agents by hand: `claude-code`, `cursor`, `codex`, `cline` or `all`. `--dry-run` prints the plan and writes nothing.

Inside a repository, `init` also asks: "Add the git pre-push hook, so every push from this repo gets a scan, from an agent or by hand?" The default is yes. `--hook pre-push` or `--hook none` answers without asking, and `--yes` answers yes. The answer is recorded for that repository, so a second `init` does not ask again. The hook is described under "A git hook for every tool" below.

## The instruction section

`init` adds a short marked section to each agent's instruction file. It prints the section before writing it:

```
<!-- openqodex:start -->
## Review with OpenQodex
- When a feature or fix is done, and before any push, review it with the openqodex skill: "review my change with openqodex".
- Run that review in a separate subagent: the agent that wrote the code does not judge its own work.
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- The report is in `.openqodex/reviews/`.
<!-- openqodex:end -->
```

The tables below name the file for each agent. Cursor has no instruction file in the home folder, so its rule in the repository carries the same section. In an existing file, the section is appended and your own text stays as it is. `--uninstall` removes exactly that section, and nothing around it.

## The review runs in a separate subagent

The skill hands the review to a subagent whose only task is the review, so the agent that wrote the code does not judge its own work. In Claude Code, that is a subagent started with the Agent tool. In Codex, Cursor and other hosts, the skill uses their sub-task or background agent feature when there is one. Where the host has none, the agent tells you the review is not independent, and the report's summary says so on its first line.

The reviewer may run the project's own tests. It never runs the project's other scripts or starts its services, and it removes anything a test run created.

## The repo folder

Inside a repository, `init` creates two files in `.openqodex/`, and so does the first `review` or `scan` there:

- `.openqodex/config.yaml`: the config, every key at its default with a comment. `config` lists every key. It is not created while a `.openqodex.yaml` sits at the root of the repository; that file is still read, and `init` says how to move it.
- `.openqodex/custom-instructions.md`: what a reviewer of this repository must know: conventions, what never to flag, what always to check. The review brief carries its text word for word. A file over 32 KB stops the review with a message; nothing in it is cut. The brief shows it to the agent as quoted text from the repository, because anyone who can commit can change it. It can widen or narrow what the agent flags, and a candidate dropped because of it says so in the report; it cannot make the agent run a command, skip a step or change the finding shape or the finalize step.

Both are meant to be committed, so the whole team shares them. A file that exists is never touched. `.openqodex/.gitignore` keeps the review reports out of git, so after the first run `git status` shows only these files and the `.gitignore`.

## User scope and project scope

The default is user scope. `init` writes into your home folder, so one install works in every repository. A rule file it must put inside a repository is added to `.git/info/exclude`, so it does not show in `git status`. The two repo folder files below are the exception: they are meant to be committed.

`--project` writes the files into the repository instead, for a team to commit. Run it inside a git repository.

## The launcher

In user scope, the push gate hooks call a launcher, not npx. `init` copies the package to `~/.openqodex/runtime/<version>/` and checks the copy runs. It then writes `~/.openqodex/bin/openqodex`, a small script that runs that copy with your Node. The hooks call that script by its full path, so they do not depend on npx or your `PATH`.

In project scope, the hooks call `npx -y openqodex@<version>`, because the launcher path would not exist on a teammate's machine.

## Claude Code

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.claude/skills/openqodex/SKILL.md` | `.claude/skills/openqodex/SKILL.md` |
| Push gate hook | merged into `~/.claude/settings.json` | merged into `.claude/settings.json` |
| Instructions | a marked section in `~/.claude/CLAUDE.md` | a marked section in `CLAUDE.md` |

The hook is one `PreToolUse` entry. It matches the `Bash` tool and runs only for `git push` commands. It calls `openqodex hook check`.

## Codex CLI

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.agents/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Instructions | a marked section in `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | a marked section in `AGENTS.md` |
| Push gate hook | merged into `~/.codex/hooks.json` | merged into `.codex/hooks.json` |

Codex runs the hook before every shell command. `hook check` returns at once and prints nothing when the command is not a `git push`.

Codex runs a new hook only after you trust it. Open Codex, run `/hooks`, and trust the OpenQodex hook. Until then, Codex skips the push gate. A project hook also needs the project itself to be trusted in Codex.

## Cursor

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cursor/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Rule | `.cursor/rules/openqodex.mdc` in the repository, excluded from git | `.cursor/rules/openqodex.mdc` |

Cursor has no rule file in the home folder, so the rule always goes in the repository. In user scope, run `init` inside each repository where you want the rule. The rule applies to every chat, carries the instruction section, and tells Cursor to review before any `git push`.

OpenQodex writes no Cursor hook. The rule asks Cursor to review, but nothing stops a push from Cursor.

## Cline

| What | User scope | Project scope |
|---|---|---|
| Skill | `~/.cline/skills/openqodex/SKILL.md` | `.cline/skills/openqodex/SKILL.md` |
| Rule | `~/Documents/Cline/Rules/openqodex.md` | `.clinerules/openqodex.md` |

OpenQodex writes no Cline hook. The rule carries the instruction section and asks Cline to review before any `git push`.

## What the push gate does

The gate runs in Claude Code and Codex, through the hooks above. It never approves a push for you: your agent's own permission prompt for `git push` still applies.

Without `review.block_on_severity` in the config, the gate never stops a push:

- When a finished review of the current change has findings, it adds the finding counts and the report path. A clean review adds nothing.
- When none exists, it adds a note that the change was not reviewed and how to review it.

With `review.block_on_severity` set, the gate denies the push unless a finished review of the current change passed. The reason names the next step.

`OPENQODEX_SKIP=1` in the environment lets the push through and says so. It is your switch, not your agent's.

The hook never breaks a push by accident. When `hook check` itself fails, it prints the reason on stderr and lets the agent go on.

## A git hook for every tool

The git pre-push hook covers pushes from any tool, by an agent or by hand. `init` asks to add it; to add it to a repository later:

```
npx openqodex hook install
```

Before each push it runs `openqodex hook pre-push` through the launcher, which scans each commit the push sends. The scan compares that commit with exactly the remote's tip of its branch, so a force push shows the code it removes. A new branch is compared with the commit it grows from that the remote already has, otherwise with the usual base. A commit that is not checked out, or a checkout with uncommitted work, is scanned in a temporary copy of that commit, which is removed afterwards. The repository's config and custom instructions as they are in your checkout apply to every scan. It stops the push only when the config sets `review.block_on_severity` and the scan meets it. A scan that fails for its own reasons never stops the push. `cli` has the details.

## Other ways to install

- The skill alone: `npx skills add openqodex/openqodex`. This writes the skill but no hook.
- Claude Code plugin: the repository holds a plugin marketplace with an `openqodex` plugin. The plugin carries the skill and the push gate hook. Its hook calls `npx -y openqodex@<version>`.
- Codex plugin: `plugins/codex/` packages the skill alone for the OpenAI plugin directory. It writes no hook and no instruction file.
- Cursor plugin: `.cursor-plugin/plugin.json` at the repository root makes the repository a Cursor plugin that carries the skill alone. It holds no rule. The rule that asks Cursor to review before every push comes from `init`, which writes `.cursor/rules/openqodex.mdc` in your repository. A rule shipped inside the plugin would go in a `rules/` folder at the repository root.

## Inside a sandbox

Some agents run commands in a sandbox that cannot reach the network or write outside the project. There, the first review cannot download scanners. Each scanner reports why it was left out, and the review runs with what is available. Run this once in your own terminal to fix it:

```
npx openqodex doctor --install
```

The review writes its files inside the repository, in `.openqodex/`. So it works in a sandbox that can write only the project.

## Uninstall

```
npx openqodex init --uninstall
```

Add `--project` to remove project files. `init` records what it wrote in `~/.openqodex/install.json`. `--uninstall` removes only what that record holds:

- A skill or rule file is removed only when it is unchanged since `init` wrote it.
- The instruction section is removed from each file; your own text in that file stays.
- In the repository you run it in: the git pre-push hook, when it is still the one OpenQodex wrote, and the `.openqodex/config.yaml` and `.openqodex/custom-instructions.md` that `init` created, when they are unchanged and not committed.
- The hook entry is removed from the settings file. Other settings stay. When `init` saved a backup and nothing else changed, the backup is put back.
- The `.git/info/exclude` lines are removed.
- The launcher and the runtime copies are removed when no hook still calls them. The git pre-push hook counts as one.

Scanners stay in `~/.openqodex/tools/`. Delete that folder to remove them too.
