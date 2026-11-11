# Templates that `openqodex init` writes

Each file here is copied or merged by `openqodex init`. Three placeholders are filled at install time and no others exist:

- `{{VERSION}}`: the version of the running `openqodex` package.
- `{{LAUNCHER}}`: the absolute path of the launcher, `~/.openqodex/bin/openqodex` expanded.
- `{{INSTRUCTIONS}}`: the instruction section, `instructions-section.md`, markers included.

## The instruction section

`instructions-section.md` is the marked section (between `<!-- openqodex:start -->` and `<!-- openqodex:end -->`) that tells an agent to review with the openqodex skill when a feature or fix is done; OpenQodex starts its own reviewer process. `init` prints it before writing, records it, and `--uninstall` removes exactly that section. It goes into the repo's `CLAUDE.md` and `AGENTS.md` in project scope, and inside the Cursor and Cline rules.

`global-section.md` is the one-line marked section for each agent's global instruction file in user scope (`CLAUDE.md` in Claude Code's folder, `AGENTS.md` in Codex's, `.goosehints` in Goose's): "Before any push, review the change with the openqodex skill." The global file is read in every repository, so it holds the trigger only. It replaces the longer section an earlier `init` wrote there while that one is still as recorded.

## The team section

`repo/team-section.md` is the marked section a user-scope `init` writes into the repository's own `CLAUDE.md` and `AGENTS.md` (creating a file that is not there), unless `--no-repo`, given now or recorded for that repository, says otherwise (`--yes` keeps a recorded "no"). It is for a teammate with nothing installed: it names only `npx -y openqodex@{{VERSION}} review` and never the skill or the launcher. Unlike other repository files in user scope, it is not added to `.git/info/exclude`: the developer commits it. It replaces an instruction section found there exactly as written, is recorded with `createdFile`, and `--uninstall` removes exactly it. In project scope the same two files get the instruction section instead.

## The skill and rules in user scope

Nothing `init` writes in user scope names a version, a review command or who reviews, so an update leaves them as they should be:

- `skill-stub.md` is the user-scope skill: its frontmatter, when to run, then a procedure that says to run `{{LAUNCHER}} guide skill` and follow what it prints. `guide skill` prints the shipped skill with every `npx -y openqodex@<version>` written as the launcher.
- `cursor/openqodex-user.mdc` and `cline/openqodex-user.md` are the user-scope Cursor and Cline rules: the instruction section, then the same `{{LAUNCHER}} guide skill` line.

These files, the global section, the instruction section, the hook and permission rules and the MCP server entries a user-scope `init` writes change only with a new `agentContract` in `package.json` (`src/contract.ts`). `test/agent-contract.test.ts` holds them to the copy checked in under `test/fixtures/agent-contract/<number>/`, and fails when one changes under the same number.

Project scope copies the shipped skill with its pinned version, and the Cursor and Cline rules `cursor/openqodex.mdc` and `cline/openqodex.md` as written. Both scopes drop the paragraph that tells a skill installed by `npx skills add` to prefer the launcher.

## The repo folder

`repo/custom-instructions.md` becomes `.openqodex/custom-instructions.md`, and the default config text from the core package becomes `.openqodex/config.yaml` (not written while a root `.openqodex.yaml` exists). Both are created by `init` in a repo and by the first `scan` or `review`, never touched once they exist, and are meant to be committed. `init` also adds the git pre-push hook unless `--hook none` says otherwise.

The project-scope skill is not a template: `init` copies it from `skills/openqodex/SKILL.md` in the package.

User scope is the default. Project scope (`--project`) writes into the repository for a team to commit. A repository file written in user scope is added to `.git/info/exclude` so `git status` does not change, except the team section.

Every path below was read from the source named beside it on 2026-10-01; the MCP server rows on 2026-10-08. Anything marked "assumption, untested" was not confirmed and must not be written by `init` as if it were.

## The code graph's MCP server

No template: `src/agents/targets.ts` builds each entry, and `src/agents/mcp.ts` merges it. The server is named `openqodex` and is stdio only. In user scope its command is the launcher's absolute path, unquoted (an entry's command runs with no shell), with `args` `["mcp"]`; in project scope the command is `npx` with `args` `["-y", "openqodex@{{VERSION}}", "mcp"]`. A JSON file gets the entry under `mcpServers.openqodex`, created with mode 0600 in user scope and 0644 in project scope; every other key and server stays. Codex's `config.toml` gets a block appended at its end, between the lines `# openqodex:start` and `# openqodex:end`, with the command and each argument written as TOML basic strings. `--no-mcp` leaves all of them out.

## Claude Code

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skill-stub.md` in user scope, `skills/openqodex/SKILL.md` in project scope | `~/.claude/skills/openqodex/SKILL.md` | `.claude/skills/openqodex/SKILL.md` |
| Push gate hook | `claude-code/settings-hook.json`, merged | `~/.claude/settings.json` | `.claude/settings.json` |
| Instructions | `global-section.md` in user scope, `instructions-section.md` in project scope, between their markers | `~/.claude/CLAUDE.md` | `CLAUDE.md` |
| Team section | `repo/team-section.md`, between its markers | `CLAUDE.md` in the repository, committed | none (the instruction section is there) |
| MCP server | `{ "type": "stdio", "command", "args" }` under `mcpServers.openqodex` | `~/.claude.json`, in the home folder itself; `$CLAUDE_CONFIG_DIR/.claude.json` when that is set | `.mcp.json` at the repository root |

- Every user-scope path above except the MCP server's is under `$CLAUDE_CONFIG_DIR` when it is set, the folder Claude Code then reads its settings from (https://code.claude.com/docs/en/settings); `~/.claude` otherwise. `src/agents/homes.ts` resolves it for detection and targets alike.
- Settings paths: https://code.claude.com/docs/en/hooks, section "Hook locations".
- Skill paths: the `skills` CLI agent table (github.com/vercel-labs/skills, README, "Supported agents"), and the same hooks page, which names `~/.claude/skills/` and `.claude/skills/`.
- The hook: `matcher: "Bash"` with `if: "Bash(git push*)"` on the handler. The `if` field uses permission-rule syntax and is checked against each subcommand (same hooks page, "Bash if matching"). The page also says a pattern longer than the command name runs the hook anyway when the command holds `$()`, backticks or `$VAR`, so `hook check` must itself confirm the command is a push.
- Merge rule: append the one entry under `hooks.PreToolUse`, keep every other key, do nothing when an entry with the same command already exists.
- MCP server: https://code.claude.com/docs/en/mcp. "MCP installation scopes": user scope is stored in `~/.claude.json`; "Scope hierarchy and precedence": user-scope servers sit at "the top level of `~/.claude.json`"; "Project scope": `.mcp.json` at the project root, and Claude Code asks for approval before it uses a project server. Claude Code reads an entry with no `type` as a stdio server, and the `add-json` example writes `"type":"stdio"`. With `CLAUDE_CONFIG_DIR` set, `.claude.json` with a top-level `mcpServers` sits in that folder: observed on a Mac with `CLAUDE_CONFIG_DIR` set, 2026-10-08, not documented. Claude Code rewrites `.claude.json` while it runs, so `init` merges into the file as it is just before the write and refuses only when the `openqodex` entry changed after the plan. No permission rule goes with that registration: a rule such as `mcp__openqodex` names a server by its name only (permissions page, "MCP"), and a project's `.mcp.json` or a local-scope entry, which take precedence, can give that name to another server. A rule an earlier build recorded is removed by the next `init`.

## Codex CLI

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skill-stub.md` in user scope, `skills/openqodex/SKILL.md` in project scope | see the note below | `.agents/skills/openqodex/SKILL.md` |
| Instructions | `global-section.md` in user scope, `instructions-section.md` in project scope, between their markers | `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md` | `AGENTS.md` (replace the text between the markers, or append) |
| Team section | `repo/team-section.md`, between its markers | `AGENTS.md` in the repository, committed | none (the instruction section is there) |
| Push gate hook | `codex/hooks.json`, merged | `$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json` | `.codex/hooks.json` |
| MCP server | a `[mcp_servers.openqodex]` table with `command` and `args`, between `# openqodex:start` and `# openqodex:end` | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `.codex/config.toml` |

- The instructions and the hook both follow `CODEX_HOME`, the folder Codex reads its config and hooks from (hooks page below: hooks sit beside the active config layer), resolved by `src/agents/homes.ts`. The skill does not: its folder is `~/.agents/skills` whatever `CODEX_HOME` says. That Codex loads `$CODEX_HOME/hooks.json`: from the docs, untested with a real custom `CODEX_HOME`.

- Hook file paths, schema and output: https://learn.chatgpt.com/docs/hooks (where https://developers.openai.com/codex/hooks redirects). `codex features list` on Codex CLI 0.160.0 shows `hooks` as stable and on.
- Codex hooks have no `if` field: the matcher is a regular expression on the tool name only. The hook therefore runs before every shell command, and `hook check` must abstain at once, printing nothing, when the command is not a `git push`.
- Codex runs a new user or project hook only after the developer reviews and trusts it with `/hooks` inside Codex; project hooks load only in a trusted project. `init` must print that step.
- MCP server: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (where https://developers.openai.com/codex/mcp redirects), "Configure with config.toml" and "STDIO servers": a `[mcp_servers.<name>]` table with `command` and `args` in `~/.codex/config.toml`, or `.codex/config.toml` in trusted projects only. `init` appends its marked block, and adds nothing when the rest of the file already defines `mcp_servers.openqodex` or a key under it, or sets `mcp_servers` to an inline table or another value, because a duplicate key makes Codex refuse the whole file. `src/agents/toml-keys.ts` reads every key path the file defines as TOML 1.0 does (bare, basic with escapes and literal keys; table and array-of-tables headers, dotted keys, inline tables), steps over every value and comment, and runs nothing; a file it cannot read is left untouched with a plan note. Uninstall removes the block while it is still as appended.
- Codex's PreToolUse output supports `permissionDecision` deny, `additionalContext` and `systemMessage`; `ask` is parsed but not implemented. Exit code 2 with the reason on stderr also denies.
- Skill path conflict: the `skills` CLI table puts the Codex user skill in `~/.codex/skills/`; the Codex docs (https://learn.chatgpt.com/docs/build-skills) list `$HOME/.agents/skills` and repository `.agents/skills`, and do not list `~/.codex/skills/`. Write `~/.agents/skills/openqodex/SKILL.md`, which the Codex docs name. That Codex 0.160.0 still reads `~/.codex/skills/`: assumption, untested.

## Cursor

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skill-stub.md` in user scope, `skills/openqodex/SKILL.md` in project scope | `~/.cursor/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Rule | `cursor/openqodex-user.mdc` in user scope, `cursor/openqodex.mdc` in project scope | `.cursor/rules/openqodex.mdc` in the repository, excluded from git | `.cursor/rules/openqodex.mdc` |
| MCP server | `{ "type": "stdio", "command", "args" }` under `mcpServers.openqodex` | `~/.cursor/mcp.json` | `.cursor/mcp.json` |

- Rule location and frontmatter: https://cursor.com/docs/context/rules. Project rules are `.mdc` files in `.cursor/rules`; the fields are `description`, `globs` and `alwaysApply`; `alwaysApply: true` makes the rule apply to every chat. User rules live in Cursor's settings, not on disk, so there is no user-level rule file.
- Skill paths: the `skills` CLI table, and https://cursor.com/docs/context/skills, which lists `.agents/skills/`, `.cursor/skills/`, `~/.agents/skills/` and `~/.cursor/skills/` (and the Claude and Codex folders for compatibility).
- MCP server: https://cursor.com/docs/context/mcp, "Configuration locations" (`~/.cursor/mcp.json` for every project, `.cursor/mcp.json` for one) and the STDIO server table, where `type` is required and is `"stdio"`.
- Cursor hooks (`.cursor/hooks.json`) were not checked: no Cursor hook is written. Assumption, untested, that a rule alone is enough for Cursor to review before pushing.

## Cline

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skill-stub.md` in user scope, `skills/openqodex/SKILL.md` in project scope | `~/.cline/skills/openqodex/SKILL.md` | `.cline/skills/openqodex/SKILL.md` |
| Rule | `cline/openqodex-user.md` in user scope, `cline/openqodex.md` in project scope | `~/Documents/Cline/Rules/openqodex.md` | `.clinerules/openqodex.md` |
| MCP server | `{ "command", "args" }` under `mcpServers.openqodex` | `~/.cline/data/settings/cline_mcp_settings.json`, only when `~/.cline/data` is there | none: a note in the plan |

- Rule paths: https://docs.cline.bot/features/cline-rules. Cline reads every file in `.clinerules/` (or `.cline/rules/`) at the project root; global rules are in `~/Documents/Cline/Rules` on macOS and Linux (`Documents\Cline\Rules` on Windows), with `~/.cline/rules` and `~/Cline/Rules` also searched. A rule with no frontmatter always applies. The plan's default (rule in the repository, excluded from git) also works; the global rule folder avoids touching the repository.
- Skill path conflict: the `skills` CLI table puts Cline skills in `.agents/skills/` and `~/.agents/skills/`; Cline's docs (https://docs.cline.bot/features/skills) list `.cline/skills/`, `.clinerules/skills/`, `.claude/skills/` and `~/.cline/skills/`, and not `.agents/skills/`. Write the path Cline's docs name. That Cline reads `.agents/skills/`: assumption, untested.

- MCP server: https://docs.cline.bot/mcp/configuring-mcp-servers names `~/.cline/data/settings/cline_mcp_settings.json` for the Cline CLI, and no project file. The VS Code extension's file is not documented there, so when Cline is found but `~/.cline/data` is not there, and in project scope, `init` writes nothing for Cline and its plan names the entry to add in Cline's "Configure MCP Servers". The test is `~/.cline/data`, not `~/.cline`: `init` itself makes `~/.cline` for the skill, which would make a second run register the server where the first did not.

## Goose

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skill-stub.md` in user scope, `skills/openqodex/SKILL.md` in project scope | `~/.config/goose/skills/openqodex/SKILL.md` | `.goose/skills/openqodex/SKILL.md` |
| Instructions | `global-section.md` in user scope, `instructions-section.md` in project scope, between their markers | `~/.config/goose/.goosehints` | `.goosehints` |
| MCP server | none: a note in the plan with the entry for `extensions` in `~/.config/goose/config.yaml` | none | none |

Read on 2026-11-11. Goose was not installed: none of this was run against Goose.

- Hints: https://goose-docs.ai/docs/guides/using-goosehints. Global hints are `~/.config/goose/.goosehints`; Goose loads `AGENTS.md` and `.goosehints` from the working folder up to the repository root and combines them.
- Skills: https://goose-docs.ai/docs/guides/context-engineering/using-skills lists `.agents/skills/` and `~/.agents/skills/`, and, for backward compatibility, `.goose/skills/`, `.claude/skills/`, `~/.claude/skills/` and "platform-specific config directories". Goose's source (`crates/goose/src/skills/mod.rs`, `all_skill_dirs_with_config`, main branch) names that folder as `Paths::config_dir().join("skills")`, the `skills` folder inside Goose's config folder (see below).
- Only paths Goose alone reads: `.agents/skills/` and `AGENTS.md` are written by the Codex and Cursor setups, and the install record keeps no owner per path, so uninstalling one agent would remove a file the other still reads.
- MCP server: https://goose-docs.ai/docs/getting-started/using-extensions, "Config Entry": an extension under `extensions` in `~/.config/goose/config.yaml` with `name`, `cmd`, `args`, `enabled` and `type: stdio`. `init` edits no YAML file.
- Hooks: Goose runs hooks from plugins in `~/.agents/plugins/` and `.agents/plugins/` (https://goose-docs.ai/docs/guides/context-engineering/hooks). No Goose hook is written; the plan says so.
- Config folder: `src/agents/homes.ts` (`gooseHome`) gives it for detection and for every user-scope path. It follows Goose's `Paths::config_dir` (`crates/goose/src/config/paths.rs`, main branch): `$GOOSE_PATH_ROOT/config` when `GOOSE_PATH_ROOT` is an absolute path; else the etcetera crate's XDG strategy, which Goose uses on macOS and Linux (https://docs.rs/etcetera/latest/etcetera/app_strategy/fn.choose_app_strategy.html): `$XDG_CONFIG_HOME/goose` when that is an absolute path, else `~/.config/goose`. That Goose reads its global `.goosehints` from that same folder: from the hints page ("goose looks for each configured filename in both global (`~/.config/goose/`) and local project locations"), assumption, untested, when the folder is moved. Windows is not handled.
- Detection: the config folder only. A `goose` on `PATH` is often another program (the pressly/goose database migration tool).

## Placeholders

`{{VERSION}}` is the running package version. `{{LAUNCHER}}` is the absolute launcher path, and `init` must substitute it already quoted for a POSIX shell (single quotes, with any single quote inside escaped), because a home folder can contain a space and the hook command is run through a shell.

The team and instruction sections tell agents to ask the developer before setting `review.instructions_files`. Custom instructions add to the files the owners chose.

Previous team and instruction sections live in `previous/`. Whole historical Cursor and Cline rules live in `previous/rules/`, with their instruction sections filled from the same released tag. Init replaces only the previous instruction sections listed in `targets.ts`. `scripts/instruction-sections.mjs` builds the exact section and whole-file catalogue from these templates. Run it after changing a template. Build never regenerates it; `--check` guards the committed catalogue in the local and CI gates. Tests pin released section hashes, so a shallow checkout needs no release tags.
