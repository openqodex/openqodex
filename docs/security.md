# Security

This page says what OpenQodex runs, what it sends where, and what it writes. Report a vulnerability through GitHub's private vulnerability reporting on the openqodex/openqodex repository. Never open a public issue for one.

## What runs

- The `openqodex` CLI, on your Node.
- The built-in scanners that fit the change, from `~/.openqodex/tools/`. Each is pinned to one version. A built-in scanner is never taken from your `PATH`.
- Custom scanners from `.openqodex/config.yaml` that you approved with `openqodex trust`.
- `openqodex mcp`, the code graph's tool server, when an agent you registered it with starts it (see "The code graph's MCP server" below).
- git, from your `PATH`.

OpenQodex starts every program with an argument list, never through a shell. Scanners get a small set of environment variables: `PATH`, `HOME`, `TMPDIR`, `LANG`, the `LC_` variables, the proxy variables, and what the scanner itself needs. Your other variables, such as API keys, are not passed on.

A repository can hold config files that make a scanner run code or rewrite files. OpenQodex does not load such files for oxlint, golangci-lint, brakeman and rubocop. It uses its own settings for them. ruff and gitleaks read the repository's own settings for rules only. ruff runs with fixes switched off.

A built-in scanner is handed only changed files that are regular files inside the repository, reached through no symbolic link. A change can add a file that links anywhere on your machine under a name a scanner checks, such as `report.sql` or a workflow; that file is not handed to any built-in scanner, and the scanner's line in the report names it with the reason.

A change can also tell a scanner to skip its own lines: with a suppression comment such as `# nosec`, or with an edit to a settings or ignore file the scanner reads. The scanner still obeys either one. OpenQodex shows each one as a candidate: the reviewer keeps or drops it in a review, and a scan counts it as a minor finding. `scanners` lists the comments.

## The trust step

A custom scanner is an arbitrary command. It runs on your machine with your permissions. The config file that names it comes from whatever repository you cloned. So nothing installs or runs a custom scanner until you approve that exact entry:

```
npx openqodex trust
```

`trust` downloads the release asset to a quarantine folder before it asks. Nothing is installed or run before your yes. `scan` and `review` never download a custom scanner. `trust` prints the version, the asset, its sha256, the program and the run line, then asks yes or no. The approval covers that repository and that entry only. An edited entry needs a new approval. `scan` and `review` skip an unapproved entry and list it as `untrusted`.

The stored sha256 is checked against the project's checksum file when the project publishes one. Otherwise it is the hash of your first download. `custom-scanners` explains the difference.

Agents that follow the OpenQodex skill are told never to run `openqodex trust` without asking you. In user scope, `init` adds rules so Claude Code runs exactly `review` and `review --all` (each also with ` --offline`), `guide` and `guide <topic>` through the launcher without asking, and `findings` with any numbers and `graph` with any arguments (`graph` reads the repository and writes only its `.openqodex/graph/` folder and the local refs `refs/openqodex/graph/<tree>`). No rule covers the tools of the code graph's MCP server: a rule names a server only by its name, and a repository's `.mcp.json` or a local-scope entry can give that name to another server, so Claude Code asks before the server's tools run. `init` removes the rules for the older two-step lines (`review --agent`, `review --finalize`) that an earlier `init` added. A review of a branch or a pull request names its target, so Claude Code asks before each one. An `ask` or `deny` rule in your own or your organisation's managed Claude Code settings still wins over these. Any other flag, any other command (`scan`, `doctor`, `trust`, `update`, `init`, `report`) and `init --project` grant nothing.

## What is sent where

OpenQodex and the built-in scanners send no code anywhere. The review runs on the model your Claude Code or Codex login uses: the reviewer process sends it the brief and what the reviewer reads (see "The reviewer process"). By default the reviewer can also search the web, and Claude Code can open web pages; `reviewer_web: off` in `~/.openqodex/config.yaml` removes that. A custom scanner you approved does whatever its own command does.

In the GitHub Action's review mode, the reviewer is Claude Code on the runner, and it sends the brief and what it reads to Anthropic's API under the repository's own key, the `ANTHROPIC_API_KEY` secret the workflow sets on the step. The reviewer's web tools are off there. The key is handed to the `review` command alone, never to `doctor`, the Claude Code install or a fallback `scan`. The `review` process holds the key while it runs the scanners on the pull request's files; `github-action` says what keeps it from the pull request's code, and what does not.

The runner starts the step's shell from the job's `PATH` before the Action's script takes control. A workflow whose earlier steps add a folder the pull request controls to `PATH` is outside what the Action can protect: that folder's `bash` would run the step, with the key in its environment.

The script's check that a program does not lie inside the repository compares paths as they are spelled. On a file system that ignores letter case, a `PATH` folder outside the repository that an attacker already controls could link back into it under a different capitalisation; like the first limit, this needs a `PATH` folder the attacker controls before the Action starts.

OpenQodex and the built-in scanners use the network for these things only:

- Scanner downloads on first use. GitHub release files are checked against sha256 sums pinned in the package. semgrep, bandit, SQLFluff and Checkov come from PyPI through uv, with a Python 3.11 that uv downloads, and brakeman and rubocop come from RubyGems. Each of these installs from a lock file in the package that names every package of its dependency tree at one version with its sha256, and each file is checked against that sha256 before it is installed. semgrep, bandit, SQLFluff and Checkov get exactly the packages of their lock, each from its wheel, so no build script runs. RubyGems takes the checked files, or a gem Ruby itself ships when that one meets the requirement. Which scanners download is worked out on your machine from your repository's files (see `scanners`); nothing is sent to work it out.
- Semgrep rule packs. semgrep fetches `p/default`, `p/security-audit` and `p/secrets` from the Semgrep registry on each run. Its metrics are off. The rules are never bundled in the package.
- The dependency check. When the change holds a lockfile, osv-scanner sends the names and versions of the dependencies in it to osv.dev. It never sends code. Its other lookups are switched off: no transitive resolution through deps.dev, no file hashes of vendored C and C++ code, no reachability analysis.
- Kubernetes schemas. When the change holds a Kubernetes manifest, kubeconform downloads the JSON schema of each kind it meets from raw.githubusercontent.com, at one commit pinned in the package, so the requests name the kinds you use. It never sends a manifest. Each schema is cached and fetched once.
- The RustSec advisory database. When the change holds a `Cargo.lock`, cargo-deny fetches the database from github.com with git into `~/.openqodex/cache/cargo-deny/`. Nothing about your code or your crates is sent. Cargo itself runs offline.
- Custom scanners. `openqodex trust` reads the release from the GitHub API and downloads the asset. After approval, a custom scanner does whatever its own command does.
- The problem report, only when you choose it. When OpenQodex fails, a scanner breaks, or you run `openqodex report`, it prints the GitHub issue it would create and two choices. Nothing is sent unless you press 1 or run `openqodex report --send-last`. Then, when the GitHub CLI `gh` is installed and signed in, `gh` creates the issue in `openqodex/openqodex` with your GitHub account. Otherwise OpenQodex opens GitHub's new-issue page in your browser, or prints its link, with the title and body filled in, and you submit it there. The issue holds the OpenQodex version, the command and its arguments with paths and secrets taken out, the part of OpenQodex that failed, a scrubbed error line, the scanner statuses and your platform (OS, CPU type, Node major version). It never holds code, file names, paths, repository names, config or secrets.
- The daily version check, for an install made with `init`. See "Updates" below.
- A review of a branch or a pull request (`review <branch>`, `review '#<number>'`). git fetches the branch or `pull/<number>/head` from your remote with its own credentials, and `gh`, when it is installed and signed in, is asked for the pull request's base. OpenQodex reads no token. The target is checked out in `~/.openqodex/checkouts/`, a folder only you can open, with every git hook and filter switched off, so checking it out runs nothing from it, and a link in it becomes a small plain file. The scanners you approved for this repository do run on the target's files, with this repository's settings; one named only in the target's config never runs. If you review pull requests from people you do not trust, approve only custom scanners that do not execute the code they scan.

golangci-lint runs with the Go module proxy off, so it downloads no modules.

`--offline` skips osv-scanner, semgrep, kubeconform and cargo-deny, which the report lists as disabled. It also turns scanner downloads off and the version check. A review of a branch or a pull request with `--offline` fetches nothing and calls no `gh`.

## Updates

An install made with `npx openqodex init` runs through the launcher `~/.openqodex/bin/openqodex`. After a `review`, `scan`, `hook check` or `hook pre-push` that the launcher started, at most once every 24 hours, OpenQodex starts a background process and the command exits without waiting for it.

What it sends: GET requests to `registry.npmjs.org` only, over https, with no body and no header but the user agent `openqodex/<version>`. First the openqodex package's release list. Then, for a newer release, its tarball and its attestations. Nothing about you, your code or your repository is sent. Every redirect must stay on `registry.npmjs.org`.

What it installs: a release that is newer than the running one, in the same major version, at least 24 hours old, not deprecated, not a prerelease, fit for your Node, newer than the `skip_version` a rollback left, and with the same agent contract and config format as the running one. A release that changes either waits for `openqodex update`. Before any of its code runs:

- the tarball's sha512 must equal the registry's `dist.integrity`;
- its SLSA provenance must verify in full with Sigstore: the certificate chain to the Fulcio roots, the certificate transparency entry, the transparency log entry and the signature;
- the signing certificate must be issued to `https://github.com/openqodex/openqodex/.github/workflows/release.yml@refs/heads/main` by `https://token.actions.githubusercontent.com`, compared exactly;
- the signed statement must name `pkg:npm/openqodex@<version>` with the downloaded tarball's sha512;
- the `package.json` in the tarball must declare the agent contract and config format the registry said it does.

A stolen npm publish token is therefore not enough to reach your machine: the release must come out of this repository's release workflow on `main`. The 24 hour age is a window to deprecate a bad release before installs take it.

The Sigstore trust data (Fulcio roots, log keys) ships inside each release, so verification makes no other network call. When Sigstore rotates a key that an old release does not know, that release cannot verify newer ones. It stays on its version and says once how to update by hand: `npx openqodex@latest init`.

A verified release is unpacked into a temporary folder under `~/.openqodex/runtime/`. A link in the tarball, or a path that leaves the folder, stops it. No install script runs. The new copy must print its own version. Only then, holding the lock below, the updater reads the user config again and checks that updates are still on, that `skip_version` does not exclude the release, that a background update keeps its contract, that OpenQodex is still installed, and that the active version is still both the one it started from and its own: an update started by a version a rollback has since left ends without writing. It then renames the copy to `~/.openqodex/runtime/<version>/` and switches `~/.openqodex/runtime/current` by a second rename. A version folder is never replaced: when one with other contents is already there, the release is skipped. An update writes no agent file and nothing inside a repository.

The lock: while `init`, `init --uninstall`, `hook install`, `update --rollback`, `update --off`, `update --on` or an update's switch runs, OpenQodex briefly opens a listener on 127.0.0.1, on a port between 20000 and 32000 derived from the path of `~/.openqodex`, so that two of them never run at once; it accepts no data and answers nothing, and the operating system closes it when the process ends, however it ends. When the listener cannot be opened at all, those commands stop with one line saying why, and the daily check skips the switch. The port is predictable, so a local program that holds it stops install, uninstall and updates until it lets go; nothing is installed or changed while it is held. A command that waited 60 seconds for it names the port and the line that shows the holder (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), and the daily check records the same as its last error, which `openqodex update --status` and `doctor` show.

Updates are off with `openqodex update --off`, `update: off` in `~/.openqodex/config.yaml`, `OPENQODEX_AUTO_UPDATE=0`, `--offline` or `OPENQODEX_OFFLINE=1`, and whenever `CI` is set. They pause while `~/.openqodex/config.yaml` holds a key OpenQodex does not know. A run through `npx` or a project-scope file never checks.

OpenQodex sends no telemetry. See `telemetry`.

## The reviewer process

`openqodex review` starts Claude Code (`claude -p`) or Codex (`codex exec`) as its reviewer. Cursor is not used as a reviewer: with the version tested, it cannot be limited to reading. `docs/internal-reviewer-drivers.md` in the repository records the tests.

### Claude Code

Claude Code sends the review brief and the files the reviewer reads to the model your Claude Code login uses, as any Claude Code session does. The reviewer:

- reads a snapshot of the change in `~/.openqodex/checkouts/`, never your folder. Secrets the scanners found are redacted in every file of the snapshot first, and a file too large to check is left out of it.
- has the read, search and list tools, plus Claude Code's WebSearch and WebFetch: no shell, no edits, no MCP server, no subagent. So the reviewer reads your code and can open web pages. A reviewer that reads private code and untrusted text from the change and can open web addresses can be talked into putting that code into a web address. `reviewer_web: off` in `~/.openqodex/config.yaml` removes the web tools; set it when you do not accept that risk. Claude Code's own permission rules refuse a read outside the snapshot; that is the boundary. OpenQodex also checks every tool call in the agent's event stream and marks the review incomplete when one names a path outside the snapshot, an unknown tool or an input it cannot read; that is the alarm. A call on the output Claude Code saved for this review's own session, in its configuration folder, does not count as outside: that file holds only what the reviewer's own checked calls returned.
- loads none of your Claude Code settings, hooks, plugins, memory or `CLAUDE.md` files, and none of the repository's.
- gets an environment built from a short allowlist: the variables Claude Code needs to run and find its login (`PATH`, `HOME`, `USER`, `CLAUDE_CONFIG_DIR`, proxy settings, `ANTHROPIC_*` keys, and cloud provider variables only when Claude Code is set to that provider). Other tokens in your shell, such as `GITHUB_TOKEN` or `NPM_TOKEN`, never reach it.

The reviewer runs with session saving off (`--no-session-persistence`). After real runs with Claude Code 2.1.289, no transcript, history line or project entry for a snapshot was found in the Claude Code configuration folder. One thing is saved there: when a search or read returns more text than Claude Code hands the model at once, Claude Code 2.1.296 saves that text under `projects/` in its configuration folder, and it stays there after the review. Claude Code's own logs and telemetry follow its own settings.

### Codex

Codex sends the conversation to the model your Codex login uses, as any Codex session does. The conversation holds the review brief, your global `~/.codex/AGENTS.md` and the output of each command the reviewer runs. Each correction round is a new Codex run that carries the whole conversation so far. The reviewer:

- reads the same redacted snapshot in `~/.openqodex/checkouts/`, never your folder.
- runs under a Codex permission profile: its commands can read the snapshot and the system folders Codex's `:minimal` set names (such as `/usr` and `/etc`), and nothing else. `/tmp`, your home folder, `~/.ssh` and `~/.codex` are refused. Writes and network are refused. That sandbox is the boundary. Before each review, OpenQodex proves it with a command run under the same profile without a model: a read of a file outside the snapshot and a write inside it must both be refused, or the review does not start.
- loads your global `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`). No Codex setting leaves it out. If you keep instructions there, the reviewer sees them, including the section `init` adds for Codex.
- loads none of your `config.toml`, rules, MCP servers, plugins, hooks, memories or skills, and none of the repository's `AGENTS.md` or skills.
- has Codex's web search by default, as the cached search, which answers from OpenAI's search index and opens no address the model names. `reviewer_web: off` removes it.
- gets an environment built from a short allowlist: `PATH`, `HOME`, `USER`, `CODEX_HOME`, proxy and certificate settings. Other tokens in your shell, including `OPENAI_API_KEY` and `GITHUB_TOKEN`, never reach it. Its commands see a smaller set still (Codex's `core` environment).

There is no alarm for Codex. Its event stream does not show every command it runs, so OpenQodex cannot check from it which files were read. The commands it does show are kept in the run folder as a list for you to read; they never pass or fail a review. Coverage counts only the changed lines in the brief and those OpenQodex sent in a correction round, and the report says file reads were not recorded by Codex.

Codex runs with `--ephemeral`: after real runs with codex-cli 0.160.0, no session file was written for the snapshot folder. Codex's own logs follow its own settings.

The run folder of a review holds the brief, the scan, the reviewer's answer and the list of its tool calls: paths and line ranges for Claude Code, and the command lines Codex showed for Codex, never their output. Each file is created readable by you only, and secrets are redacted in all of them.

### A model reviewer (the library)

A program that imports OpenQodex as a library (`library`) reviews a change with its own model through `reviewChange`. That reviewer is not a process: OpenQodex builds every request, the program's own client sends it to the program's model, and OpenQodex runs every tool call the model asks for itself. OpenQodex sends nothing to any model by itself.

What the model can read:

- the review brief: the change's diff, the scanner candidates, the code graph's view of the change and the lenses, with the secrets the scanners found redacted;
- through five tools, and nothing else: the lines of a file, a search of the files by regular expression, the list of files, the diff of one changed file, and the callers of a symbol from the code graph. They read a snapshot of the head commit made under the program's work folder, never the program's clone or any other folder. The snapshot holds only the commit's regular files, written from the clone's objects: a link or a submodule is left out, and the result says so. With folder scopes, it holds only the files inside them. Every reply is at most 32 KB and has the scanners' secrets redacted, and a search never answers on a line that holds one.

What the model cannot read or do:

- anything outside the snapshot: the clone's `.git` folder, another folder of the machine, the program's environment or files. A path outside is refused, and the refusal is logged with the review. With folder scopes, a path outside them is refused the same way. Either refusal leaves the review incomplete.
- the web, or a shell: it has no tool for either, and no tool starts a program.
- change a rule of the review: context the program adds (earlier comments, lessons) is shown as quoted data, never as an instruction, and never grants a tool.

What the model says it read is never used as proof. The completion record counts only what OpenQodex carried in a request the program's client sent, and each tool result is marked as sent or not. The scanners of such a review run from the program's preinstalled install root with installs off, and write only under the review's work folder, with their `HOME` and `TMPDIR` there.

## The code graph's MCP server

`openqodex mcp` serves the code graph to the agent that starts it, over that process's standard input and output only. It opens no network port and accepts no other connection: no other program, local or remote, can ask it anything.

It reads the graph of the repository it was started in, and nothing else: the files of that repository's work tree that git lists (tracked and untracked, never ignored ones), which the graph is built from, for a comparison with the base the base version of each changed file from the repository's git objects, the repository's config, its `.openqodex/graph/` folder, and the graph's record for that repository in `~/.openqodex/graph/`. A question that names another repository, a path outside the repository (absolute, or with a `..` part) or a build id that is not one is refused before anything is read for it. No tool returns the contents of a file or searches text, and nothing from the repository is run. It writes only what `openqodex graph` writes: builds and facts in `.openqodex/graph/`, its lease file there, and the local ref `refs/openqodex/graph/<tree>` of each kept capture.

Its answers hold names, paths, line numbers and notes about your code, never its source lines. They go to the agent that asked, which sends them to its model with the rest of what it reads, as it does with your files.

## Secrets

When gitleaks finds a secret in the change, OpenQodex removes it from the brief, every report file and the terminal. Each line of a secret that spans several lines, such as a private key, counts as the secret too, wherever it appears alone. It keeps the length and sha256 of each secret and of each such line, to redact any text the agent quotes. Every output of a review (`report.html`, `report.md`, `report.json`, `report.sarif`, the receipt and the paths it prints) is drawn from one redacted copy of the report.

gitleaks writes its raw report to a temporary file outside the repository. That file holds the matched secrets. OpenQodex deletes it when the run ends. No file OpenQodex keeps holds the secret.

A secret is redacted only when a scanner matched it. When gitleaks did not run, the brief shows the change as it is.

## The HTML report

`report.html` quotes the code under review, the reviewer's text and the scanners' messages, any of which can be hostile. So:

- It holds the changed lines with their old and new line numbers (for a review of the whole repository, a few lines around each cited line), every finding with its suggested change, the dropped scanner candidates, the coverage, the scanners and the blast radius. Nothing else from your machine.
- Every secret a scanner matched is redacted before the page is written, on both sides of the diff, a secret over several lines (a private key) included, with every line number kept. A secret no scanner matched is shown, as in the brief.
- Every string is escaped, and every anchor in the page is generated, never taken from a path. There is no script, no form, no frame and no inline style. The page's content policy allows only its own stylesheet, by its hash, and loads nothing: no font, image or other file. Opening it sends nothing anywhere. Its one outgoing link, in the closing line, sends no referrer.
- It is written readable by you only, like every file of the run, and only on your disk. OpenQodex never opens a browser and never uploads it. In the GitHub Action it stays in the run folder on the runner; the Action uploads no HTML.
- `review --agent` saves the same redacted lines as `display.json` beside the brief, readable by you only, so `review --finalize` can draw the page after the secrets are gone from memory. It records the sha256 of this file and of the run's other files, `scan.json` with the secrets' fingerprints among them, in `~/.openqodex/runs/`. Finalize checks them before it renders anything: a run file a branch carries, or one changed since, gives a page without code that `findings` and the push hooks do not count.
- The page and `display.json` are bounded: at most 5,000 files are listed and the rest counted; at most 50,000 lines of code are shown, and a listed file past that keeps its name with a note.

## Where files are written

In your home folder, under `~/.openqodex/` (`OPENQODEX_HOME` moves it). The records below (`receipts/`, `runs/`, `last-review/`) are read only from a folder that lies, by identity, under `~/.openqodex/` with no link on the way, through a handle opened without following a link: a record folder or file that is a link counts as no record.

- `tools/<scanner>/<version>/`: the scanners.
- `tools/uv-python/`: the Python 3.11 for semgrep, bandit, SQLFluff and Checkov.
- `cache/`: the download caches for uv and npm.
- `runtime/<version>/` and `bin/openqodex`: the copy of the package and the launcher that the hooks call, written by `init`. Updates add copies beside it; a copy is never changed after it is written. `init`, `openqodex update` and the background check right after it switches remove copies older than 7 days, except the one `init` installed, the current one and the previous one.
- `runtime/current`: the version the launcher runs, and on a second line the version a rollback goes back to.
- `update.json`: the state of the version check, private to you.
- `config.yaml`: your own settings: `update`, `reviewer` (which agent reviews), `reviewer_web` (the reviewer's web tools, on by default; `off` removes them) and `skip_version` (the release a rollback left, never installed again).
- `install.json`: what `init` and `hook install` wrote, so an uninstall removes only that.
- `receipts/<repo id>/`: one small record per reviewed change, readable by you only, written by `review` at the end of a run (and by `review --finalize` for the older two-step protocol, only for a run whose scan this machine ran). The push hooks decide from these records only. The files under the repository's `.openqodex/` are the readable report, never the proof: a branch can carry those files, so a record found only there counts as no review. The check inside your agent is a reminder about your current work: it does not know what a push sends. For a plain `git push` it asks whether your current work has a passing review; any other push command it cannot tell, and says so (a deny when `block_on_severity` is set). The git pre-push hook that `init` adds is the check that sees the exact commits a push sends, and `git push --no-verify` skips it. `init` and `openqodex update` remove records older than 30 days.
- `runs/<repo id>/`: one record per `review --agent` run of any kind, readable by you only: the change and the hashes of the run files it wrote, so `review --finalize` can tell a run this machine scanned from one a branch carries. Removed with the receipts.
- `last-review/<repo id>/`: the run folder, change and `report.json` sha256 of the last review of each repository run on this machine, readable by you only. `openqodex findings` prints that review's report only while it has that hash, never one a branch carries under `.openqodex/reviews/`. Removed with the receipts.
- `graph/<repo id>.json`: for one repository, which repository it is (the real path of its root folder and that folder's inode), the checksum of each code graph build kept in its `.openqodex/graph/`, and the checksum of each facts file the graph wrote there. A build is used only when this record holds its checksum, and a facts file only when its bytes match the checksum recorded when OpenQodex wrote it, so a build or a facts file copied, planted or changed in the repository's folder is never read, even one your own user wrote there: such a facts file is parsed again. A record whose repository is not this one (copied from another repository, or kept from one that stood at the same path before) vouches for nothing. Each saved build and each collection drops the entries of builds and facts files that are gone.
- `trust.json`: your approvals of custom scanners.

In the repository, under `.openqodex/` only:

- `config.yaml` and `custom-instructions.md`: the team's config and instructions for the reviewer, created once and never touched after. They are meant to be committed.
- `.gitignore`: keeps the run state below out of git, so after the first run `git status` shows only the two files above and the `.gitignore`.
- `reviews/<time>-<id>/`: one folder per run, holding the brief, the scan result, the reviewer's answer, the list of its tool calls and the reports, `report.html` among them. OpenQodex keeps the newest 20.
- `latest.json`: points at the newest review, for you and older tools; the push gate does not trust it (see `receipts/` above). `latest-scan.json` points at the newest scan.
- `graph/`: the code graph (`graph`): the facts of each file the graph read, one folder per build, the leases of the processes that hold a build open, and the rates this machine measured. It follows the rules below like every file under `.openqodex/`: no link is followed, every read is bounded, each file is 0600 and each folder 0700, and a build is written whole and checked before it is used. When any file under it is tracked by git, or when the folder or one of its own folders belongs to another user or other users can write it, the graph does not use the folder, builds in memory and says why. A facts file another user owns or other users can write is parsed again, never read, and a build or a facts file is used only when `~/.openqodex/graph/` holds its checksum (above). It is held under `graph.max_cache_mb` (512 MB by default). Facts name the functions, classes and imports of your code, and the strings the framework plugins read: route paths, prefixes and options, HTTP methods, request paths, route names, module paths, template names, model, table, column and field names, and config key names. One over 512 characters is not kept, a key-shaped token in a kept one is replaced by `[redacted:` and eight hex digits of its hash `]`, and one whose percent-decoded form hides a key is not kept (`graph`); they hold no other source text.

`init` decides each write from where the path really lands, never from its spelling: it walks the path as the system does, links followed and `.` and `..` taken after them. It refuses a link that lies in the repository's work tree, in either scope and for an agent folder set inside the repository with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` alike, and a path that lands outside the repository, its git folders, your home folder, the agents' own folders and `~/.openqodex`. Each folder is known by its identity on disk (device and inode), not by how its name is spelled. A write goes through the folder it checked: a temp file created only if nothing is there, written, synced and renamed, and afterwards the final name must hold that very file in that very folder, or the write is undone where it can be and fails. Node has no rename relative to an open folder, so that check after the rename is the closing one. Its own files in `~/.openqodex` (its record, the launcher, the runtime copies, receipts, the update's unpacking) and the files under the repository's `.openqodex/` are written and removed the same way, and a removal never follows a link.

Under `~/.openqodex/receipts/`, `runs/`, `last-review/` and `runtime/`, which only OpenQodex writes, a symbolic link anywhere on the way, the file itself included, is refused rather than followed, so a receipt, a record or a runtime write cannot land on another file of your home.

Every file OpenQodex creates that can quote your code or hold a review, a record or a setting is readable by you only (0600), and each folder it makes for one only you can open (0700). Each gets its mode when it is created, never by a change after. A file of yours that `init` edits in place, such as `~/.claude/settings.json` or a repository's `CLAUDE.md`, keeps its own mode. A report or receipt that other users could read, or the `.openqodex/`, `.openqodex/reviews/`, `--report-dir` or receipt folder it goes in, as an earlier version or run left them, is replaced or closed to you the next time OpenQodex writes there, and named once on stderr. A link outside the repository, such as a dotfiles link of `~/.claude/settings.json` into your home, is the developer's and is followed.

OpenQodex never reads or writes `.openqodex/` or the root `.openqodex.yaml` through a symbolic link, at the file or at any folder above it inside the repository. A link there stops the command with one line naming it, or, for a run file such as `latest.json`, counts as no file. Only regular files are read there, each within a size limit, so a link or a device in their place cannot hang a run.

The agent settings and skill files `init` writes are listed in `agents`.

The change itself is worked out without writing inside `.git`. OpenQodex uses a temporary copy of the index and a temporary object folder.

The code graph keeps the bytes each kept build read: it writes them as a git tree into the repository's own objects, through a temporary copy of the index, and holds that tree with a local ref, `refs/openqodex/graph/<tree>`, while a build of it is kept; the ref is deleted with the last such build. Your index, your branches and your working files are not touched. The ref is local: a plain `git push` does not send it, `git push --mirror` would. With `--report-dir` nothing is written there.

The review writes the graph's files into its own snapshot, under `.openqodex-review/graph/`, before the snapshot is hashed, so its reviewer reads them without leaving the snapshot. They pass through the same secret redaction as the brief. A change that holds a path named `.openqodex-review` stops the review rather than having it overwritten.
