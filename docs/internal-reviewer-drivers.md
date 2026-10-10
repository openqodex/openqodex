# Reviewer drivers

This page is for contributors. It records how `openqodex review` starts its own reviewer process, and what was observed with the real binary before a driver was enabled. A driver is enabled only when its isolation was shown by a real run. A limit that no setting removes is stated below and in the user docs.

The reviewer is a separate coding-agent process that openqodex starts, without a window, for one review. It reads a frozen copy of the change (the snapshot) and answers with one JSON object. The trace is the agent's own event stream: every tool call, its input and whether it succeeded.

## Claude Code

Tested with Claude Code 2.1.289 (`claude --version`) on macOS, 2026-10-03, on a throwaway folder and on the demo repo.

### The command line

The driver starts this command without a shell, with the snapshot as the working directory, and writes the brief to standard input:

```
claude -p --output-format stream-json --verbose --input-format stream-json
  --tools Read,Grep,Glob
  --permission-mode dontAsk
  --setting-sources ""
  --settings {"autoMemoryEnabled":false,"hooks":{},"disableAllHooks":true}
  --strict-mcp-config --mcp-config {"mcpServers":{}}
  --disable-slash-commands
  --no-session-persistence
```

The child gets an environment built from an allowlist (`reviewerEnv` in `packages/review/src/agents/claude.ts`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, locale, `TERM`, `TZ`, `CLAUDE_CONFIG_DIR`, proxy and CA settings, the `ANTHROPIC_*` key, URL and model variables, and the Bedrock, Vertex or Foundry variables only when the matching `CLAUDE_CODE_USE_*` flag is set; plus `OPENQODEX_REVIEW_DEPTH=1`. No other variable is copied, so no developer token and nothing that ties the child to a running Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, messaging sockets) reaches it. A run from inside a Claude Code session with this environment worked as the runs below did.

### What each flag was observed to do

| Flag | Observed |
|---|---|
| `-p` with `--input-format stream-json` | A fresh session that reads user messages as JSON lines on standard input. After each answer it prints a `result` event and waits for the next message, so a correction round goes to the same session. Closing standard input ends the process with exit 0. |
| `--output-format stream-json --verbose` | One JSON event per line: an `init` event (tools, MCP servers, plugins, permission mode, memory paths, version), every `tool_use` with its input, every `tool_result` with `is_error`, a `permission_denied` event for each refusal, and a `result` event with the final text, turns, usage and cost. For a Read, `tool_use_result.file` gives the path, `startLine` and `numLines` delivered. |
| `--tools Read,Grep,Glob` | The `init` event lists exactly `Glob`, `Grep`, `Read`. Asked to run `ls /` and to write a file, the model answered that it has no Bash or Write tool; no such tool call appears in the trace. The `Agent` tool is absent, so no subagent can start. |
| `--permission-mode dontAsk` | Reads inside the working directory succeed. A Read of an absolute path outside it (`/tmp/.../outside/secret.txt`, `/etc/hosts`, a decoy ssh config), a relative path that leaves it (`../outside/secret.txt`), a Read through a link inside the folder that points outside, and a Grep or Glob rooted outside (`/tmp/...`, `/`) were each refused with a `permission_denied` event and an error result. A recursive Grep and a `**/*` Glob in the folder did not follow the link out. |
| `--tools Read,Grep,Glob,WebSearch,WebFetch --allowedTools WebSearch,WebFetch` (the default; dropped with `reviewer_web: off` or `review --reviewer-web off`) | The `init` event lists the five tools. Without `--allowedTools`, `dontAsk` refused both web tools ("Permission to use WebFetch has been denied because Claude Code is running in don't ask mode"); with it, a WebFetch of example.com and a WebSearch both returned results (2026-10-03). |
| `--setting-sources ""` | No user, project or local settings file is read. In the same folder, a run without this flag loaded the project `CLAUDE.md` canary (the answer ended with the canary word) and the user's global instructions (the answer quoted them, about 155,000 input tokens); with it, the input was about 4,500 tokens and neither canary nor any sentence of the global file appeared anywhere in the event stream. With `--include-hook-events`, a run reading user settings showed 11 hook events; this run showed none. |
| `--settings {"autoMemoryEnabled":false,"hooks":{},"disableAllHooks":true}` | The `init` event has no `memory_paths`: auto memory is off. With `disableAllHooks`, a SessionStart hook that a terminal wrapper (cmux) added to every `claude` it starts no longer ran: 2 hook events without it, 0 with it (2026-10-04, Claude Code 2.1.289). The driver also stops the run if any hook event appears in the stream. A repository `AGENTS.md` with a canary instruction was not followed. |
| `--strict-mcp-config --mcp-config {"mcpServers":{}}` | The `init` event lists no MCP server. |
| `--disable-slash-commands` | The `init` event lists no skill and no slash command. |
| `--no-session-persistence` | Nothing is saved for a later `--resume`; the correction rounds use the open process instead. |

`AGENTS.md`: a canary there was not loaded in any run, with or without settings. The built-in plugins (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`) stay listed; they are part of Claude Code and read no repository instruction file in this configuration.

### Where it works

- Started from a Bash tool inside a running Claude Code session: works, with the same tools and the same refusals.
- Started from a plain environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR` and the developer's own `CLAUDE_CONFIG_DIR`): works. Without `USER` the login in the macOS keychain is not found and the run ends with "Not logged in".
- A temporary `CLAUDE_CONFIG_DIR` loses the login, so the driver keeps the developer's own configuration folder and excludes its contents with the flags above.

### Detecting it

- `claude --version` prints the version.
- `claude auth status` prints JSON with `loggedIn`. Exit 1 and `"loggedIn": false` mean the reviewer cannot start.

### Usage

Each `result` event carries `num_turns` and `usage` for that turn (input, output and cache tokens), and `total_cost_usd` and `modelUsage` for the session so far. The driver adds up the turns and takes tokens and cost from the last `result` event.

### The boundary and the alarm

The boundary is Claude Code's own permission rules: `--tools Read,Grep,Glob` and `--permission-mode dontAsk` with no settings source, which refused every read outside the working folder in the runs above. The alarm is the tool's own check of the event stream (`packages/review/src/agents/trace.ts`), which does not trust the boundary and fails closed:

- the run fails when the `init` event lists any tool beyond Read, Grep and Glob, any MCP server or a memory path; the `Agent` tool is never listed, so no subagent or nested turn can make a call the stream does not show, and every `tool_use` in the stream is checked whichever turn it came from;
- every tool call counts from the moment the agent asks for it, with or without a result; a tool name other than the three makes the review incomplete;
- every path-bearing input (`file_path`, `path`, `notebook_path`, `cwd`, `directory`, and a `pattern` or `glob` that starts at `/`, `~`, a drive or `..`) is resolved against the snapshot, then through the real path of its deepest existing folder, and compared case-insensitively on macOS and Windows; a path with `$`, `%` or a NUL is refused, `~` is the home folder;
- an input that is not an object, or a path field that is not text, makes the review incomplete;
- any attempt outside the snapshot makes the review incomplete, even one the agent refused;
- one place outside the snapshot is the agent's own. Claude Code saves a tool result too large to hand the model at `<configuration folder>/projects/<its name for the working folder>/<session id>/tool-results/<tool call id>.txt` and tells the model to read it back. A call on the `tool-results` folder of this session (the session id from the `init` event; the configuration folder from `CLAUDE_CONFIG_DIR`, else `~/.claude`, as `init` reads it) is kept in `trace.json` with `own: true` and does not make the review incomplete: it holds only what this session's own calls returned, and each of those calls was checked. Any other path in the configuration folder (the login, another session's output, a transcript) stays outside. With Claude Code 2.1.296, `dontAsk` refused that read (2026-10-09).

The snapshot holds no links (they are written as plain files) and secrets the scanners found are redacted in every file of it before the reviewer starts; a file too large to check is removed from it.

### What the agent stores

With `--no-session-persistence` and auto memory off, real runs with Claude Code 2.1.289 left no transcript, no `history.jsonl` line and no project entry for a snapshot folder in the configuration folder (searched for the brief's text and the snapshot paths after the runs). A tool result too large to hand the model is the exception: Claude Code 2.1.296 saved it at `projects/<snapshot folder name>/<session id>/tool-results/` in the configuration folder, and it stays there after the run (2026-10-09). An earlier run without `autoMemoryEnabled: false` left one empty `projects/<folder>/memory` folder; with the flag, none. The driver keeps the developer's configuration folder because a temporary one loses the login.

### Not covered

- Managed (policy) settings set by an organisation still apply; they can add hooks or permission rules. The trace check above still fails a run that reads outside the snapshot.
- Each new Claude Code version can change these flags. Re-run these checks before raising the tested version.

## Codex

Enabled since 0.6.0, with two stated limits. Tested with codex-cli 0.160.0 (`/opt/homebrew/bin/codex --version`) on macOS, 2026-10-03 and 2026-10-04, logged in with a ChatGPT account, on throwaway folders under `~/.openqodex/` with canaries. The driver is `packages/review/src/agents/codex.ts`. It refuses a Codex older than 0.160.0, and a Codex whose `--version` prints no version number.

### The command line

The driver starts this command without a shell, with the snapshot as the working directory, and writes the prompt to standard input. Its environment comes from an allowlist (`codexEnv`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, locale, `TERM`, `TZ`, `CODEX_HOME`, `CODEX_CA_CERTIFICATE`, `SSL_CERT_FILE` and proxy settings, plus `OPENQODEX_REVIEW_DEPTH=1`. No `OPENAI_API_KEY`, no `CODEX_THREAD_ID` and no `CODEX_SANDBOX` reach it. Only absolute `PATH` entries are kept: an empty or relative one would resolve inside the snapshot.

```
codex exec --json --color never --ephemeral --skip-git-repo-check
  --ignore-user-config --ignore-rules
  -C <snapshot>
  -c approval_policy="never"
  -c default_permissions="openqodex_review"
  -c permissions.openqodex_review.filesystem={":minimal"="read",":project_roots"="read","/tmp"="deny"}
  -c web_search="disabled"            (web_search="cached" unless reviewer_web: off)
  -c project_doc_max_bytes=0
  -c allow_login_shell=false
  -c shell_environment_policy.inherit="core"
  -c skills.include_instructions=false -c skills.bundled.enabled=false
  --disable plugins --disable apps --disable hooks --disable multi_agent --disable memories
  --disable browser_use --disable computer_use --disable image_generation --disable skill_search
  --disable tool_suggest --disable goals --disable in_app_browser --disable view_image
  -
```

`codex sandbox -c ... -- <command>` runs one command under the same sandbox without a model, and `codex debug prompt-input -c ...` prints what the model would be given; both cost nothing and were used for most checks below.

### What each part was observed to do

| Part | Observed |
|---|---|
| `exec --json` | One JSON event per line: `thread.started`, `turn.started`, `item.started` and `item.completed` for messages, commands and web searches, `turn.completed` with `usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). `cached_input_tokens` is part of `input_tokens`. A run can print more than one `agent_message`; the last one is the answer. The run ends after one answer. |
| `--ephemeral` | No rollout file was written for the test folder. A follow-up in the same session is not possible, so each correction round is a new run that carries the brief, every earlier answer and every earlier correction, in order. A subagent cannot start: `spawn_agent` failed with "no rollout found for thread id". |
| `-s read-only` alone | Writes and network were refused, but every read was allowed: `cat` of a file in another `/tmp` folder, of `/etc/hosts` and `ls ~/.ssh` all succeeded. So the driver does not use it. |
| the `openqodex_review` permission profile | Reads outside the folder were refused (`Operation not permitted`): a file in a home folder outside it, `~/.ssh`, `~/.codex`, `~/Projects`, `$TMPDIR`, and `/tmp` with the `/tmp` deny entry. Reads inside it worked. `/etc` and the system folders `:minimal` names stay readable; without `:minimal` no command could start. `touch` was refused. `curl` could not resolve a host. The patch tool was refused ("writing is blocked by read-only sandbox"). Programs outside those folders do not start: in a real review `rg` was "command not found", and the model used `ls`, `find` and `sed`. |
| `web_search="disabled"` | The model reported no web search tool. |
| `web_search="cached"` | Asked to search, the model ran one search; the stream showed a `web_search` item with the query and its results (2026-10-04). Shell commands still had no network: the profile has no network entry. |
| `project_doc_max_bytes=0` | A canary `AGENTS.md` in the folder did not appear in the prompt input or the answer. |
| `skills.include_instructions=false` | Without it, a canary skill in the folder's `.agents/skills/` was listed to the model, which then followed it. With it, the skills block is gone from the prompt input. |
| `--ignore-user-config` | The developer's `config.toml` (MCP servers, plugins, model, trusted projects) is not read. A canary `developer_instructions` in the folder's `.codex/config.toml` did not appear either way: the folder is not a trusted project. |

### The per-run probe of the boundary

The read confinement rests on two `-c` keys (`default_permissions` and `permissions.openqodex_review.filesystem`). A newer Codex could rename or ignore them, and the event stream would not show it. So every review proves the boundary before the first model run (`probeSandbox`). It runs one command, with no model, under `codex sandbox` with the same two keys, in the snapshot folder:

- it reads a canary file that openqodex writes in its home folder (`~/.openqodex/.openqodex-probe-<random>`, mode 0600, random content), outside the snapshot;
- it reads a file with random content that openqodex writes inside the snapshot;
- it tries to create a file inside the snapshot;
- it prints a random marker as its last act.

The script runs every program by absolute path (`/bin/cat`) with `PATH=/usr/bin:/bin`, so a program committed in the snapshot cannot stand in for one. It handles each expected refusal itself, so the marker prints only when every step ran. The review starts only when the probe exits 0 with no signal, the marker came back, the inside read worked, the canary's content did not come back and no file was created. Any other result, a probe that cannot start, or one that runs past 30 seconds ends the run as "Full review unavailable" with "Codex's sandbox did not confine reads to the review copy; the review did not start" and the `review --agent` fallback. The canary and both probe files are removed whatever happened, before the snapshot is hashed. A Ctrl-C or a kill during the probe ends the probe's process group and removes the files before `review` exits. `codex sandbox` passes on the command's exit status (3 for `exit 3`, 137 for a killed shell).

Observed with codex-cli 0.160.0 (2026-10-04):

- With the review profile, `cat` of the canary printed "Operation not permitted", `cat` of the inside file printed its content, and the write printed "Operation not permitted".
- With a profile that adds `"/"="read"`, the canary's content came back, so the probe refuses it. `packages/cli/test/codex-stream.test.ts` runs both against the real binary when Codex is installed (skipped in CI).
- `codex sandbox -c default_permissions="nope"` stops with "default_permissions refers to undefined profile `nope`". With the key misspelled it stops with "config defines `[permissions]` profiles but does not set `default_permissions`". Both print no canary content, so the probe refuses them.
- `codex sandbox` takes the same `-c` keys but has no `--ignore-user-config`: the probe reads the developer's `config.toml`, while `codex exec` does not. The `-c` keys override the same keys in that file. The probe proves that this Codex binary applies these keys to a sandboxed command; it runs through `codex sandbox`, not through `codex exec` itself, which cannot run a command without a model.
- Each probe took well under a second.

### The two limits

1. The developer's global instructions are loaded. `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) appeared in the prompt input with every flag above, and the model quoted its first sentence. No configuration key removed it (`instructions`, `user_instructions`, `agents_md.enabled`, `include_agents_md`, `features.agents_md` were tried). Only a different `CODEX_HOME` leaves it out, and that moves the login: a copy of `auth.json` would refresh its token on its own and can leave the developer's real login with a used refresh token. The driver keeps the developer's `CODEX_HOME`. In one real run the model looked for `CLAUDE.md` and `AGENT.md` files in the snapshot because the global file told it to.
2. The event stream does not show every command. Every current model in the catalog (`codex debug models`) has `tool_mode: code_mode_only` except gpt-5.5: the shell is a nested tool inside a code tool. In one run on 2026-10-03, two shell commands ran (their output came back in the answer) and no `command_execution` event appeared in the stream. In the runs on 2026-10-04 every command did appear. Nothing guarantees it, so the driver says `traced: false`.

What `traced: false` changes in the run (`packages/review/src/review-change.ts`, `packages/review/src/conversation.ts`, `packages/core/src/completion.ts`):

- No read in the stream counts as coverage. A changed range counts only when its diff is in the brief or the run sent it in a correction round. A range still not sent after two rounds makes the review incomplete ("not given to the reviewer").
- The commands and searches the stream shows are kept in `trace.json` with `inside: null` and their input under `detail`. They never pass or fail a review: there is no "read outside the snapshot" alarm and no "tool it was not given" check. The sandbox is the boundary.
- The completion record holds `trace_complete: false`, and empty `files_read` and `files_not_read`. The report prints "Files the reviewer opened: not recorded by Codex" and "Reads outside the snapshot: not recorded by Codex".

Read confinement held in every test: the permission profile is a real boundary, stronger than `-s read-only`. The code tool's own JavaScript runtime has no file or network access (`require`, `import("node:fs")` and `fetch` were all undefined or refused).

### Detecting it

- `codex --version` prints `codex-cli 0.160.0`.
- `codex login status` prints "Logged in using ChatGPT" and exits 0 when logged in. With an empty `CODEX_HOME` it prints "Not logged in" and exits 1. The driver takes exit 0 as logged in.
- A Codex session sets these variables for the commands it runs (seen in a `codex exec` run, 2026-10-04): `CODEX_THREAD_ID` and `CODEX_SESSION_ID` (the thread id), `CODEX_VERSION` and `CODEX_CI=1`. Under a sandbox it also sets `CODEX_SANDBOX=seatbelt`, and `CODEX_SANDBOX_NETWORK_DISABLED=1` when network is off. `hostAgent` takes `CODEX_THREAD_ID` as "running inside Codex". The interactive Codex was not run for this; the binary holds the same name.

### Where it works

- Started from a Bash tool inside a running Claude Code session, with the allowlist environment: it works.
- Started from inside a Codex sandbox (`codex sandbox -- codex exec ...`), with network off, and again with `workspace-write` and network on: `codex exec` exits 1 at once with "Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)" and prints no event. `codex --version` and `codex login status` still work there. So `detect` reports Codex as unavailable whenever `CODEX_SANDBOX` is set, and `review` prints "Full review unavailable" with the `review --agent` fallback instead of starting a run that cannot answer.

### Usage

Each `turn.completed` event carries `usage`. The driver adds `input_tokens` and `output_tokens` over all runs of a review and counts one turn per run. A ChatGPT login has no price per run, so the report shows no cost. The test runs on 2026-10-03 used 51,000 to 92,000 input tokens (most of them cached) and 600 to 950 output tokens per run, in 45 seconds or less. The web search run on 2026-10-04 used 52,911 in and 207 out. A real review of a six-line change with one planted SQL injection took 31 seconds, one run, 50,384 tokens in and 641 out, and reported the injection (2026-10-04).

### What would remove the limits

A switch that leaves out `$CODEX_HOME/AGENTS.md` without moving the login, and an event for every command the code tool runs. Re-run the checks above on each new Codex version before raising the tested version.

## Cursor

Not enabled. `cursor-agent` 2025.09.18-7ae6800 was on this Mac and not logged in. Its help shows `-p` ("Has access to all tools, including write and bash"), `--output-format stream-json`, `--model`, `--force` and `--resume`: no option to limit its tools, no read-only sandbox, no switch to skip the repository's rules or the developer's settings. None of the checks above can pass with those options, so no invocation was built. Cursor users get the full review through Claude Code or Codex when one is installed.
