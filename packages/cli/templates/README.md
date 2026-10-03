# Templates that `openqodex init` writes

Each file here is copied or merged by `openqodex init`. Three placeholders are filled at install time and no others exist:

- `{{VERSION}}`: the version of the running `openqodex` package.
- `{{LAUNCHER}}`: the absolute path of the launcher, `~/.openqodex/bin/openqodex` expanded.
- `{{INSTRUCTIONS}}`: the instruction section, `instructions-section.md`, markers included.

## The instruction section

`instructions-section.md` is the marked section (between `<!-- openqodex:start -->` and `<!-- openqodex:end -->`) that tells an agent to review with the openqodex skill, in a separate subagent, when a feature or fix is done. `init` prints it before writing, records it, and `--uninstall` removes exactly that section. It goes into each agent's global instruction file in user scope, into the repo's `CLAUDE.md` and `AGENTS.md` in project scope, and inside the Cursor and Cline rules.

## The team section

`repo/team-section.md` is the marked section a user-scope `init` writes into the repository's own `CLAUDE.md` and `AGENTS.md` (creating a file that is not there), unless `--no-repo`, or a recorded "no" for that repository without `--yes`, says otherwise. It is for a teammate with nothing installed: it names only `npx -y openqodex@{{VERSION}} review --agent` and never the skill or the launcher. Unlike other repository files in user scope, it is not added to `.git/info/exclude`: the developer commits it. It replaces an instruction section found there exactly as written, is recorded with `createdFile`, and `--uninstall` removes exactly it. In project scope the same two files get the instruction section instead.

## The skill in user scope

In user scope the skill is a stub built from `skills/openqodex/SKILL.md`: its frontmatter and title, its "When to run" and "Who reviews" sections, then a procedure that says to run `<launcher> guide skill` and follow what it prints. `guide skill` prints the shipped skill with every `npx -y openqodex@<version>` written as the launcher. Project scope copies the shipped skill with its pinned version. Both drop the paragraph that tells a skill installed by `npx skills add` to prefer the launcher.

The Cursor and Cline rules: in user scope every `npx -y openqodex@{{VERSION}}` becomes the quoted launcher, and `guide` becomes `guide skill`. Project scope keeps them as the templates write them.

## The repo folder

`repo/custom-instructions.md` becomes `.openqodex/custom-instructions.md`, and the default config text from the core package becomes `.openqodex/config.yaml` (not written while a root `.openqodex.yaml` exists). Both are created by `init` in a repo and by the first `scan` or `review`, never touched once they exist, and are meant to be committed. `init` also asks whether to add the git pre-push hook.

The skill itself is not a template: `init` builds it from `skills/openqodex/SKILL.md` in the package, as "The skill in user scope" says.

User scope is the default. Project scope (`--project`) writes into the repository for a team to commit. A repository file written in user scope is added to `.git/info/exclude` so `git status` does not change, except the team section.

Every path below was read from the source named beside it on 2026-10-01. Anything marked "assumption, untested" was not confirmed and must not be written by `init` as if it were.

## Claude Code

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skills/openqodex/SKILL.md` | `~/.claude/skills/openqodex/SKILL.md` | `.claude/skills/openqodex/SKILL.md` |
| Push gate hook | `claude-code/settings-hook.json`, merged | `~/.claude/settings.json` | `.claude/settings.json` |
| Instructions | `instructions-section.md`, between its markers | `~/.claude/CLAUDE.md` | `CLAUDE.md` |
| Team section | `repo/team-section.md`, between its markers | `CLAUDE.md` in the repository, committed | none (the instruction section is there) |

- Settings paths: https://code.claude.com/docs/en/hooks, section "Hook locations".
- Skill paths: the `skills` CLI agent table (github.com/vercel-labs/skills, README, "Supported agents"), and the same hooks page, which names `~/.claude/skills/` and `.claude/skills/`.
- The hook: `matcher: "Bash"` with `if: "Bash(git push*)"` on the handler. The `if` field uses permission-rule syntax and is checked against each subcommand (same hooks page, "Bash if matching"). The page also says a pattern longer than the command name runs the hook anyway when the command holds `$()`, backticks or `$VAR`, so `hook check` must itself confirm the command is a push.
- Merge rule: append the one entry under `hooks.PreToolUse`, keep every other key, do nothing when an entry with the same command already exists.

## Codex CLI

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skills/openqodex/SKILL.md` | see the note below | `.agents/skills/openqodex/SKILL.md` |
| Instructions | `instructions-section.md`, between its markers | `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md` | `AGENTS.md` (replace the text between the markers, or append) |
| Team section | `repo/team-section.md`, between its markers | `AGENTS.md` in the repository, committed | none (the instruction section is there) |
| Push gate hook | `codex/hooks.json`, merged | `~/.codex/hooks.json` | `.codex/hooks.json` |

- Hook file paths, schema and output: https://learn.chatgpt.com/docs/hooks (where https://developers.openai.com/codex/hooks redirects). `codex features list` on Codex CLI 0.160.0 shows `hooks` as stable and on.
- Codex hooks have no `if` field: the matcher is a regular expression on the tool name only. The hook therefore runs before every shell command, and `hook check` must abstain at once, printing nothing, when the command is not a `git push`.
- Codex runs a new user or project hook only after the developer reviews and trusts it with `/hooks` inside Codex; project hooks load only in a trusted project. `init` must print that step.
- Codex's PreToolUse output supports `permissionDecision` deny, `additionalContext` and `systemMessage`; `ask` is parsed but not implemented. Exit code 2 with the reason on stderr also denies.
- Skill path conflict: the `skills` CLI table puts the Codex user skill in `~/.codex/skills/`; the Codex docs (https://learn.chatgpt.com/docs/build-skills) list `$HOME/.agents/skills` and repository `.agents/skills`, and do not list `~/.codex/skills/`. Write `~/.agents/skills/openqodex/SKILL.md`, which the Codex docs name. That Codex 0.160.0 still reads `~/.codex/skills/`: assumption, untested.

## Cursor

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skills/openqodex/SKILL.md` | `~/.cursor/skills/openqodex/SKILL.md` | `.agents/skills/openqodex/SKILL.md` |
| Rule | `cursor/openqodex.mdc` | `.cursor/rules/openqodex.mdc` in the repository, excluded from git | `.cursor/rules/openqodex.mdc` |

- Rule location and frontmatter: https://cursor.com/docs/context/rules. Project rules are `.mdc` files in `.cursor/rules`; the fields are `description`, `globs` and `alwaysApply`; `alwaysApply: true` makes the rule apply to every chat. User rules live in Cursor's settings, not on disk, so there is no user-level rule file.
- Skill paths: the `skills` CLI table, and https://cursor.com/docs/context/skills, which lists `.agents/skills/`, `.cursor/skills/`, `~/.agents/skills/` and `~/.cursor/skills/` (and the Claude and Codex folders for compatibility).
- Cursor hooks (`.cursor/hooks.json`) were not checked: no Cursor hook is written. Assumption, untested, that a rule alone is enough for Cursor to review before pushing.

## Cline

| What | Template | User scope | Project scope |
|---|---|---|---|
| Skill | `skills/openqodex/SKILL.md` | `~/.cline/skills/openqodex/SKILL.md` | `.cline/skills/openqodex/SKILL.md` |
| Rule | `cline/openqodex.md` | `~/Documents/Cline/Rules/openqodex.md` | `.clinerules/openqodex.md` |

- Rule paths: https://docs.cline.bot/features/cline-rules. Cline reads every file in `.clinerules/` (or `.cline/rules/`) at the project root; global rules are in `~/Documents/Cline/Rules` on macOS and Linux (`Documents\Cline\Rules` on Windows), with `~/.cline/rules` and `~/Cline/Rules` also searched. A rule with no frontmatter always applies. The plan's default (rule in the repository, excluded from git) also works; the global rule folder avoids touching the repository.
- Skill path conflict: the `skills` CLI table puts Cline skills in `.agents/skills/` and `~/.agents/skills/`; Cline's docs (https://docs.cline.bot/features/skills) list `.cline/skills/`, `.clinerules/skills/`, `.claude/skills/` and `~/.cline/skills/`, and not `.agents/skills/`. Write the path Cline's docs name. That Cline reads `.agents/skills/`: assumption, untested.

## Not written on Day 0

No MCP server configuration is written for any agent.

## Placeholders

`{{VERSION}}` is the running package version. `{{LAUNCHER}}` is the absolute launcher path, and `init` must substitute it already quoted for a POSIX shell (single quotes, with any single quote inside escaped), because a home folder can contain a space and the hook command is run through a shell.
