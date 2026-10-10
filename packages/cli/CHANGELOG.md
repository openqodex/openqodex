# openqodex

## 0.11.1

### Patch Changes

- [#98](https://github.com/openqodex/openqodex/pull/98) [`6b65f88`](https://github.com/openqodex/openqodex/commit/6b65f889a578fe6cefde8d4ab026a4cb51148e26) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The code graph builds faster: each JavaScript or TypeScript file's parse tree is walked once for the call graph and the Express, React and Next.js plugins (the Django, Rails, FastAPI and Go readers keep their own walk), a node of the tree is read only where a rule needs it, and each file's project and Rails application are looked up once per build. On this repository a build with no kept facts takes about 1.4 times as long as before the framework plugins (it took 1.7 times), and a build from kept facts about 1.4 times (it took 1.7 times).

  - The kept facts in `.openqodex/graph/` are smaller: the Express plugin keeps a variable's value only where it can read it (16.4 MB on this repository, from 22.2 MB). The plugin interface is now version 4 and the Express plugin version 7, so the first build after the update parses every file again.

- [#96](https://github.com/openqodex/openqodex/pull/96) [`52b9383`](https://github.com/openqodex/openqodex/commit/52b9383ee86a7502838370994d2f3f60cd2343cf) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - A large review no longer ends incomplete because Claude Code, as the reviewer, tried to read back a long search result it had saved in its own configuration folder. A read of the output saved for that review's session counts as the agent's own; a read of anything else in that folder still makes the review incomplete.
  - A large review no longer ends incomplete because of a deletion the brief had no room for. The correction round now shows the removed lines between the two lines around the deletion, and the round no longer promises that ranges it can never send will follow.
  - `review.paths.exclude` now applies to both paths of a renamed file. A file renamed out of an excluded folder is reviewed as a new file, without the excluded file's removed lines, and a file renamed into an excluded folder is reviewed as a deleted file.

## 0.11.0

### Minor Changes

- [#88](https://github.com/openqodex/openqodex/pull/88) [`70f42f0`](https://github.com/openqodex/openqodex/commit/70f42f0acfb5cb75b9a69f11c8bae0140953efbf) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The code graph follows calls through interfaces, abstract classes and base classes. A call on a value typed by an interface or a base type binds to the member it declares, and each implementation or override that may run instead is listed as a possible caller of that call. Before, a change to a class behind an interface listed no caller, and a call through `this` or `self` in a base class never reached the subclasses that override it.

  - Each language's own lookup order picks the method: Python's method resolution order (so a diamond picks the class Python picks), Go's shallowest embedding and its method sets, Ruby's prepend, include and extend order. A Go type implements an interface when its methods cover it by name, and a Python class a Protocol the same way.
  - A function passed to an in-repo function that calls that parameter, a local given one function and then called, an entry of a literal table called by a computed key, and a function returned by name and then called are listed as possible callers. A wrapper that never calls what it is given is not.
  - The brief lists possible callers apart from certain and likely ones, at most 20 inline, and never counts them as callers; a possible caller makes the list a floor. It also lists where the touched code is used as a value or named as a type, and what implements or overrides it.
  - A call through an interface keeps at most 32 possible implementations, and says how many it left out. A call through a TypeScript interface says that an object of the same shape may answer it without declaring `implements`.
  - The review's packet gives each caller its level and counts per level, and adds `implementers/` and `references/` pages for each touched symbol.
  - Text from the repository in the brief's graph block and in the packet's `index.md`, such as a file name with a line break in it, stays on its own line and opens no markdown: names are code spans, paths and notes are escaped ([#71](https://github.com/openqodex/openqodex/issues/71)).

- [#88](https://github.com/openqodex/openqodex/pull/88) [`384ef20`](https://github.com/openqodex/openqodex/commit/384ef20e50c24060324f193783963bb5d4f7c43d) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `openqodex graph` is now a command in the menu. Beside callers, callees, importers, changes, unknowns and explain, it answers what extends a class or implements an interface, what overrides or implements a method, who uses a symbol as a value or a type, how two functions are connected, what a change or one symbol reaches (the walk the review uses), what a file or folder defines, which projects depend on a project, and which import cycles exist. Every answer carries the evidence and level of each item, true counts, and whether it may be short (a floor) and why. `openqodex graph help` lists the questions.

  - A question this release cannot answer says so and exits 2 instead of answering with an empty list: routes, in a repository where no framework plugin finds an application. Where no framework plugin finds an application, tests are named by their file names only and come back as leads, never counted. A class whose base is written as an expression, such as `extends mixin(Base)`, is not read yet: the graph records it as a gap on that class, and `implementers` says its answer may be short, naming the class, while the graph holds one in the same language.
  - Each question has a 1 second budget and a page of 50 items by default: `--budget-ms`, `--limit`, `--cursor` and `--tokens` change them. A walk stopped by its budget names where it stopped and never counts what lies past it; ask again with a larger `--budget-ms`, or, in the MCP server, with its cursor, which goes on from where it stopped.
  - `openqodex mcp` serves the same questions to your coding agent as MCP tools, over stdio only, for the repository it starts in. It holds one build for the whole session, says when files changed since (a manifest or a tsconfig included), and moves to a new build with `graph_refresh`. It keeps the last comparison of `graph_changes` and `graph_impact`, so its cursor pages that comparison, and refuses a cursor made against another base. It runs one build at a time and answers `busy` when four already wait. A cancelled question stops its walk. It refuses another repository or a path outside the repository. The Claude Code plugin starts it.
  - `init` registers the code graph's MCP server, named `openqodex`, with each agent it installs into: in `~/.claude.json` for Claude Code, `~/.cursor/mcp.json` for Cursor, a marked block in `~/.codex/config.toml` for Codex, and the Cline CLI's settings file. With `--project` it writes `.mcp.json`, `.cursor/mcp.json` and `.codex/config.toml` in the repository with the pinned `npx` command. Every other server and setting in those files stays, and `init --uninstall` removes only the entry it added. A Codex `config.toml` that already defines the server in any spelling, or that does not read as TOML, is left untouched.
  - `init --no-mcp` leaves the MCP server out and removes the registrations an earlier `init` made; a later `init` keeps that choice until `init --mcp`.
  - In user scope, Claude Code may now run `<launcher> graph` with any arguments without asking. No rule covers the MCP server's tools: a rule would name the server only by its name, which a repository's `.mcp.json` can give to another server, so Claude Code asks before they run. Run `init` once after updating to get this rule and the MCP server.

- [#88](https://github.com/openqodex/openqodex/pull/88) [`0c0f51e`](https://github.com/openqodex/openqodex/commit/0c0f51ea3d0577599cc2686f33ea92674c88ed8c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The review brief now lists the Django and Rails routes that reach the changed code, with their full paths and names, routes left without a handler, the templates and views it renders, a changed model's migrations, and the tests that call it, request its route or name it.
  A route stays listed when its view or action is deleted, and the brief says it has no handler now.
  Django and Rails are read only when a manifest declares them and the project has the framework's own settings or routes file; nothing from the repository is imported or run, and no regular expression from it is built.
  Every route path, route name and template name quoted in the brief is on one line, cut to 120 characters and set inside a table cell.
  Python dependencies declared in files that a requirements file includes with `-r` or `-c`, in a `requirements/` folder or in pip-tools `.in` files are now read, so Django is found in those layouts.
  The Django and Rails facts cached under `.openqodex/graph/` keep a string from your code only where the plugin reads its value (a route path, a route name, a template, a model, table or field name), with key-shaped tokens redacted and nothing over 512 characters kept, so a key in a setting, a route option, a route path or a test request is not copied there.

- [#88](https://github.com/openqodex/openqodex/pull/88) [`0c95abf`](https://github.com/openqodex/openqodex/commit/0c95abf28b6e4733685c1c7495e3d9c1b97b2302) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The code graph reads Express, React, Next.js, FastAPI and Go net/http code: each route with its full path and the function that handles it, the routers and middleware in front of it, components and the components they render, hooks, and the tests that request a route or render a component. A route whose handler is missing, wrapped or computed stays listed with a note saying why, and two applications in one repository never share routes.
  What a framework plugin cannot read is recorded as an unknown with its reason, never left out: a computed path or prefix, a name a parameter or local shadows, a list longer than the plugin reads, a test request it cannot compare with a route, and a budget it reached.
  The review brief lists what these plugins find in the same framework tables as Django and Rails: the routes that reach the changed code, routes left without a handler, and the tests that call it, request its route or render it.
  The framework facts cached under `.openqodex/graph/` keep a string from your code only where a plugin reads one (a route path, a prefix, a method, a request path), applied to the whole value a concatenation makes, with key-shaped tokens redacted and nothing over 512 characters kept, so a key, a header or any other literal in the code is not copied there.

- [#88](https://github.com/openqodex/openqodex/pull/88) [`9c02a02`](https://github.com/openqodex/openqodex/commit/9c02a0245c6d2bf4e75b76f8a3e2ac88f93a8d84) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - Every framework plugin keeps a string from your code by one rule, applied to the whole value it reads: a concatenation whose pieces join into a key, a later piece of a URL that is not part of its path, a request's query, an object's key, a decorator's argument and a lookup on a plain dictionary are not copied into `.openqodex/graph/`. A key-shaped token is now also found after a `_` or `-` inside a longer name, and a redacted token is named by a short hash, so a template or a route named with one still resolves. A string over 512 characters is no longer cut and kept; it is read as a value the graph does not know. A requirements file that includes a URL names it in the gap without its user, password or query.

  - Every gap the framework plugins record that can hide an entry of a change now reaches the brief and the review packet, with its cause: a gap of the application or project, such as a computed mount prefix or root URL module in a file the change did not touch, a cap counted across the build, the touched symbols past the first 25, and a route walk that stopped at its cap. The packet's `unknowns.json` lists the framework gaps beside the graph's. `graph routes` and `graph tests` count a gap that names no relation, such as a file past the per-file fact cap, as a floor, and `graph impact` lists every use of a touched symbol rather than the 200 the brief keeps. The Django plugin says when a field's base classes go deeper than it follows, when a test request matches more routes than it links, and when its work budget runs out inside a request.
  - The graph states as certain only what it read: a method found past a base written as an expression is likely at most; an Express file whose facts pass the per-file cap keeps its scope records, so a parameter named like the module's application is never taken for it; the brief says "no handler now" only for a handler that is gone; a Django router joined into `urlpatterns` that a later statement replaces is not served, a list joined with `+` holds only what it held at the join, and an item written by index is a gap; a FastAPI route keeps its path as written; and a FastAPI test client's request is joined to the path of its base URL ([#81](https://github.com/openqodex/openqodex/issues/81)). The Django field ancestry walk is budgeted and remembers its answers, so a lattice of field classes no longer takes exponential time.
  - A graph build kept in `.openqodex/graph/` now stores a file you edited at the same size in the second git last wrote its index as it is after the edit; before, the kept copy could hold the file as it was before the edit.
  - The framework plugin API is now version 3: a plugin can read a file as one reader of a walk the plugins share, so the Express, React and Next.js readers walk each JavaScript file once. Kept facts in `.openqodex/graph/` are read again once, on the first build after the update.

- [#79](https://github.com/openqodex/openqodex/pull/79) [`94e43e1`](https://github.com/openqodex/openqodex/commit/94e43e1e7756871999f0e8b506a3c866372bef80) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - Nine new built-in scanners, twenty-two in all. Each is pinned to one version, checked against its sha256 or a hash-locked lock file, and runs only when the change holds a file it reads.
  - zizmor 1.30.1 checks GitHub workflows, action files and the Dependabot config for security problems, such as a pull request title expanded into a script or a `pull_request_target` workflow that runs the pull request's code. It runs offline.
  - squawk 2.66.0 checks Postgres migrations for steps that lock or rewrite a busy table, such as an index built without `CONCURRENTLY` or a `NOT NULL` column with no default.
  - SQLFluff 4.3.0 checks SQL for queries that return a wrong result or hold dead code, on eight rules only and with no templating, so no code from the repository runs.
  - trivy 0.75.0 runs its misconfiguration checks on changed Terraform, Kubernetes and CloudFormation files. It is never handed a Terraform folder that calls a module it would download, and the report names such a folder.
  - Checkov 3.3.22 runs its own checks on the same files. It loads no `.checkov.yaml` from the repository or your home, so no external Python check runs, and it sends nothing.
  - TFLint 0.64.0 runs the core Terraform rules with OpenQodex's own settings: no plugin, no `.tflint.hcl` from the repository, and no value it evaluates in a finding.
  - kube-linter 0.8.3 checks changed Kubernetes manifests, each finding on the line of the field it names.
  - kubeconform 0.8.0 checks changed Kubernetes objects against pinned schemas it downloads once from raw.githubusercontent.com. `--offline` skips it.
  - cargo-deny 0.20.2 checks a changed `Cargo.lock` against the RustSec advisory database, which it fetches from github.com. It needs your own Cargo and never downloads crates. `--offline` skips it.
  - A suppression a change adds for zizmor, squawk, SQLFluff, trivy, Checkov, TFLint or kube-linter (an ignore comment, `checkov:skip`, `tflint-ignore`, a kube-linter ignore annotation) is shown as a finding for the reviewer to check, as for the existing scanners. kubeconform and cargo-deny obey no inline marker.
  - One problem that several scanners report on the same lines is shown once, the higher severity, naming the other scanners: a workflow script injection from semgrep, actionlint and zizmor, a RustSec advisory from osv-scanner and cargo-deny, and nine missing settings that trivy and Checkov both check.
  - A changed `pyproject.toml`, `setup.cfg`, `tox.ini` or `pep8.ini` is now compared by what ruff or SQLFluff reads from it, so a setting written in another form, such as an escaped TOML key or a `[DEFAULT]` key, raises the settings note, and a version bump in `[project]` still raises none.
  - The demo repository plants a Postgres migration that blocks writes, an SSH port open to the internet in Terraform and a privileged Kubernetes container.
  - The benchmark gains four cases for the new scanners: workflow security, Postgres migrations, Terraform open to the internet and Kubernetes host access.

### Patch Changes

- [#78](https://github.com/openqodex/openqodex/pull/78) [`c08cb86`](https://github.com/openqodex/openqodex/commit/c08cb86843843b3976535af4531087cb92887f0a) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - A scanner install now always runs as the openqodex program of the installed package, found from the package itself, with its hidden install command; never as whatever script loaded the installer, and no caller can name another program. Before, a script that imported the scanner installer started itself again as its install process, and each copy did the same, without end. An install process now never starts another one, and the install step stops with one line when any other program runs it.
  - The test suite now removes every temp folder it makes, after stopping only the background processes its own tests started, and a test run fails when a folder is left behind. Before, each init test left a copy of the openqodex runtime, about 9 MB, in the system temp folder.
  - A semgrep scan no longer leaves its three rule-pack files, about 2.7 MB, in the system temp folder each time it runs. Semgrep now gets a temp folder of its own, removed after the scan.

## 0.10.0

### Minor Changes

- [#65](https://github.com/openqodex/openqodex/pull/65) [`d42e17e`](https://github.com/openqodex/openqodex/commit/d42e17ea476fa26a41f399613479fc5d2eece29b) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The code graph finds callers across the packages of a workspace (pnpm, npm or yarn workspaces), through the nearest tsconfig.json of each file, and across Python `src` roots. Before, a change to a function of one package listed no caller in another.
  - Every caller in the brief says how sure the graph is: certain (an import, a definition in the same scope or a known receiver type proves it) or likely, with a note naming the convention it rests on, such as a workspace package reached through its built `dist` entry with no tsconfig `paths`, project reference or source condition mapping it to source, or possible, when a name two `export *` statements bring from different modules could be either. A method inherited from a base class is no surer than the binding of the base. A path a package's `exports` map does not expose, a Python module found in two places and a call on a value typed `any`, `unknown` or `object` are never bound, and each is said with its cause.
  - The brief's block is now "What this change reaches". It lists the public names the change stopped exporting or bound to another definition, with every place that used them and what each binds now; a function moved to another file under another name with the same body as moved and renamed; and what the graph could not see near the change, with the cause. A caller list that may be short is marked as a floor, with the reasons.
  - Every cut the graph makes says what it left out: a hub's callers past the 20 nearest, the second hop past 20 callers of each caller, files past the parse cap, the time budget or the memory bound.
  - The graph keeps its work between reviews in the repository's `.openqodex/graph/`, ignored by the folder's own `.gitignore`: a file that did not change is never parsed again. Builds are kept whole and never changed after they are written; a review holds the build it read until it ends; the folder is held under `graph.max_cache_mb` (512 MB by default). With `--report-dir` nothing is kept. The folder is used only while it and each file read from it are yours alone: a folder other users can write is refused with the reason and the graph is built in memory, and a build or a facts file is used only when `~/.openqodex/graph/` records it, for this repository, as one your own runs saved; anything else is parsed again.
  - Each kept build's files stay readable with `git show <tree>:<path>` through a local ref, `refs/openqodex/graph/<tree>`, deleted with the build. A plain `git push` does not send it.
  - The review writes the graph's files into its snapshot under `.openqodex-review/graph/` (every caller, the second hop, what the change calls, importers, the changed public names, what the graph could not see, the base version of removed code), so its reviewer can open everything the brief leaves out without leaving the snapshot. Before, the brief pointed at `impact.json` beside it, outside the folder the reviewer may read, and following it ended the review ([#58](https://github.com/openqodex/openqodex/issues/58)).
  - When the build the next review needs is predicted, from this machine's own measurements, to take under five seconds, the graph is built fresh from what is cached. Over five seconds, a graph command uses the kept index of the same files when there is one, and a review builds under its time budget and keeps an index.
  - `graph.max_files` now counts new parses, never files whose facts are cached. New keys: `graph.max_cache_mb` and `graph.max_heap_mb`.
  - The graph also runs when a change edits only a manifest (`package.json`, `tsconfig.json`, `pyproject.toml`, `go.mod`, ...), and lists the imports whose target it changed.
  - A manifest, lockfile or tsconfig the graph cannot read is named with what failed. One whose loss can hide a call (a `package.json`, a tsconfig, a workspace file, a `go.mod`) also marks the build partial and floors the callers in its folder; `docs/graph.md` has the table. A name re-exported through more than 8 modules is said as such. A `file:` or `link:` dependency binds to a workspace package only when its path leads to that package's folder.
  - A kept index is reused only when every file the project model read or looked for (tsconfig chains, whatever they are named, manifests, workspace files, lockfiles) and every file left out are the same as when it was built.
  - Hidden commands, which may change before 1.0: `openqodex graph build | status | search | symbol | callers | callees | importers | changes | unknowns | explain | capabilities`, with `--json`. `docs/graph.md` describes the graph.

## 0.9.0

### Minor Changes

- [#62](https://github.com/openqodex/openqodex/pull/62) [`45267e0`](https://github.com/openqodex/openqodex/commit/45267e0376d81ad8d7e2fa92995323031f6f2172) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `init` follows `CLAUDE_CONFIG_DIR` and `CODEX_HOME`: it finds Claude Code and Codex by those folders and writes the skill, the instructions and the push hook where each agent reads them, never half in the default folder.

  - Inside Cursor's agent, `review` tries Cursor first among the reviewers, as it does for Claude Code and Codex, and `init` knows it runs inside an agent.
  - `init` replaces a skill file that holds the skill exactly as some version shipped it, such as the copy `npx skills add` writes, with the skill it keeps up to date. Before, it kept that copy as yours and it never updated. A copy you edited is still left alone.
  - `init` asks one question, "Write these files?", after a plan that lists every file under "For you, on this machine" or "For the team, in this repo". The git pre-push hook and the team review section are lines of that plan, on by default; `--hook none` and `--no-repo` leave them out. Before, it asked up to three questions.
  - Inside Claude Code, Codex or Cursor with no terminal, `init` writes its plan without `--yes`. With no terminal and no agent it still exits 2, now after printing the plan and the flags that change it.
  - Answering no to "Write these files?" stops `init`: it writes nothing, removes nothing from `~/.openqodex` and starts no review. Before, the review after `init` still ran and created the `.openqodex` folder, and old runtimes, receipts and locks were cleaned up anyway.
  - When `init` finds no coding agent and has a terminal, it asks which of Claude Code, Cursor, Codex CLI and Cline to install into. Without a terminal it still exits 2 with the `--agent` list.
  - The line `init` adds to each agent's global instruction file (such as `~/.claude/CLAUDE.md`) is now one sentence: "Before any push, review the change with the openqodex skill." The next `init` puts it in place of the longer section of earlier versions. Project scope and the Cursor and Cline rules keep the longer section.
  - After writing, `init` lists what it wrote for you, with the command that undoes it, and what it wrote for the team, to commit, and names `init --project`, which puts the agent files inside the repository instead (the scanners and `init`'s record stay in `~/.openqodex`).
  - Every command `init` prints (the next review, the undo, `init --project`) starts with the launcher's full path, so it runs when pasted: an npx install puts no `openqodex` on your `PATH`, and `init` never edits a shell profile. Its last line is the command to run next.
  - `init` checks every reviewer at once after writing and prints "Reviewer ready" with the one it found, or "No reviewer can start yet" with each one's reason and fix and the `review --agent` command. It no longer runs a first review that cannot start, and it ends with one line: `First review: finished`, `incomplete`, `skipped` or `unavailable`.
  - The review `init` ends with waits up to two minutes for a scanner its change needs that `init` has just started downloading, then names any still downloading. Before, it ran with downloads off, so the first review had the fewest scanners of any.
  - The README, the quickstart and the skill give agents one install line, `npx -y openqodex@<version> init --yes --agent <host>`: the same install as `init` in a terminal, push check included. `npx skills add openqodex/openqodex -g` stays as the skill-only option, labelled so, in user scope so it writes nothing into the repository.
  - `init --yes` keeps what a repository chose before (`--no-repo`, `--hook none`) and takes the defaults only for what it never answered. Before, `--yes` put the team review section back where the repository had left it out.
  - With no terminal, no agent and no `--yes`, `init` writes nothing at all, its record of choices included, and runs no review, even when there is no file to write.
  - `init` says every push from the repository is checked only when its git pre-push hook is in place. Where husky or lefthook runs the hooks, or a pre-push hook it did not write is there, it says the hook is not set up and what to add.
  - `init` decides each write from where the path really lands, never from its spelling: it never writes through a symbolic link that lies in the repository, in either scope (an agent folder set inside the repository with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` included), nor to a place outside the repository, your home folder, the agents' folders and `~/.openqodex`. It checks each path when it plans the file and again right before the write lands. A link outside the repository, such as a dotfiles link into your home, is still followed; one that lands outside those folders is now refused.
  - Every file `init` writes, renames or removes, OpenQodex's own record, launcher and runtime copies in `~/.openqodex` included, goes through one checked path that knows each folder by its identity on disk, not its spelling: a repository named in another case or Unicode form, or a work tree inside its bare repository, no longer slips past the link check, and `install.json` or `runtime/` as a link to somewhere else is refused, never written or cleaned up through.
  - In a terminal, `init` also asks "Write these files?" when it would only record a choice or clean up old runtimes, receipts or lock files.
  - A skill file that spells out the placeholder the ownership check uses is kept as yours.

- [#62](https://github.com/openqodex/openqodex/pull/62) [`568d264`](https://github.com/openqodex/openqodex/commit/568d264ef2f9da5872b3786e19ab2612e0ee1e3b) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `review` now ends with a short receipt instead of the whole report: the verdict, the reviewer's summary, one line per finding (number, severity, category, title, file and line) and the absolute paths of `report.html` and `report.md`, which `--quiet` keeps. `--format markdown`, `json` and `sarif` still print the whole report. Each review writes `report.html`, one local page with each changed file as a diff and each finding under its line, then the coverage, the scanners and the blast radius; it runs no script, loads nothing and redacts the secrets the scanners found. The skill (which `guide skill` prints), the project Cursor and Cline rules, the team section and the push gate tell the agent to show the receipt, ask "Fix all, or tell me which?" and fix only the findings you name; the new `openqodex findings 1,3` prints the named findings in full. The report prints the reviewer's summary, and its coverage says "Files the reviewer opened" and "Files not opened (their changed lines were in the brief)". Each line of a multi-line secret, such as a private key, is now redacted wherever it appears alone. `--report-dir` reached through a symbolic link stops `review` and `scan` with exit 2 before anything is written, and a link the repository holds is refused at every write after that. When the first review after `init` could not write `report.html`, `init` says `First review: incomplete` with that reason.

- [#62](https://github.com/openqodex/openqodex/pull/62) [`584ee32`](https://github.com/openqodex/openqodex/commit/584ee322b6c0a07980a50d39370d6674aa21ab9b) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - Scanners now download only where a repository's files call for them. `doctor --install` inside a repository installs the scanners its files need, less `scanners.disable` and `review.paths.exclude`, and prints why for each one; `doctor --install --all-scanners` installs every scanner, as `doctor --install` did before. `init` picks its downloads the same way, from tracked and untracked files alike, prints one line per scanner it downloads, such as `brakeman: Rails app in backend/`, and `init --dry-run` prints those lines without downloading. The GitHub Action installs what the repository needs and keys its cache on the pinned scanner versions and those scanners, so a release that pins nothing new reuses the cache.

  Each changed file now belongs to its nearest project, read from that project's manifests as text. brakeman runs only for a file in a Rails app (rails in the `Gemfile` or `Gemfile.lock`, and `config/application.rb` or `bin/rails`), from that app's folder, so a Rails app in `backend/` is scanned and a React Native app's CocoaPods `Gemfile` no longer pulls in brakeman. rubocop no longer runs for a `Gemfile` alone and loads its Rails cops only in a Rails app. oxlint runs its React, accessibility and Next.js rules in projects that depend on them, and then the reviewer is no longer handed the `useEffect` dependency pattern oxlint already checks. ruff adds its Django, FastAPI and Airflow rules in those projects. shellcheck checks an extensionless script whose first line names sh or bash. `scan.json` records the projects of the change.

  osv-scanner moves to 2.6.0 and reads `bun.lock`, `uv.lock`, `pdm.lock`, `pylock.toml`, the NuGet lockfiles and more; it no longer gets `go.sum`, which it cannot read and which stopped the whole lockfile check. It sends dependency names and versions to osv.dev only: its deps.dev and file-hash lookups are off. Aliased advisories are one finding, and a lockfile with no package is no longer a failure.

  oxlint moves to 1.86.0 and installs from its GitHub release, checked against its sha256, with no npm. semgrep, bandit, brakeman and rubocop install from lock files shipped in the package that name every dependency at one version with its sha256, and each download is checked against it, so their dependencies no longer float between machines. brakeman now asks for Ruby 3.0 or newer, which its pinned gem needs.

  The README and docs now say which scanners download when, and every trivy example passes `--disable-telemetry --skip-version-check --skip-check-update`.

- [#62](https://github.com/openqodex/openqodex/pull/62) [`f443f76`](https://github.com/openqodex/openqodex/commit/f443f76fd21ffed4c3b7ff24890ecdb1f76250e8) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The skill, the Cursor and Cline rules and the instruction section `init` writes in user scope no longer hold the review procedure, who reviews or a version: they say when to review and to run `<launcher> guide skill`, which prints the procedure of the version that runs. The next `init` puts them in place of the older ones you never edited.
  - The daily update installs only a release with the same agent contract and config format as the version you run. A release that changes how agents run a review, or the config format, waits: the next command says so once, `update --status` names it, and `openqodex update` installs it, then says to run `init`. Each release declares both numbers in its `package.json`, and its own copy must say what the registry said.
  - After an update the next command lists, below the line that names the two versions, every release notice in between: a change to what leaves your machine, what blocks a push or who reviews. The 0.5.0 and 0.6.0 changes are in the list, the reviewer's web tools turned on by default among them. `update --status` and `doctor` list those of the last update.
  - After an update the next command, `update --status` and `doctor` say how many files OpenQodex wrote for your agents are from an older version, and that `init` refreshes them. A file you edited is never counted, and `init` keeps it. The update itself still writes no agent file.
  - `openqodex update --rollback` no longer turns updates off: it writes `skip_version: <the version left>` to `~/.openqodex/config.yaml`, so that release and every older one is never installed again and the next release still comes. Going back to 0.8.1 or earlier, which cannot read `skip_version`, still turns updates off.
  - The daily update removes runtime copies older than 7 days, except the one `init` installed, the current and the previous one, right after it switches versions. Before, only `init` and a foreground `update` did.
  - The launcher runs Homebrew's stable path to Node, such as `/opt/homebrew/opt/node@22/bin/node`, not the versioned folder a `brew upgrade` removes, so a push from a git client with no Node on its `PATH` is still checked after the upgrade. When the Node it was set up with is gone, it runs the one on your `PATH` and says so in one line.
  - `~/.openqodex/config.yaml` is read by one reader. A key it does not know is named with the known key nearest to it (`updat` is named with `update`), and automatic updates pause until it is fixed. A file that is not a list of keys turns updates off and stops a review, naming the file. `doctor` prints each key with the value in force and where it comes from. `update --off` and `--on` keep the comments of a file of comments only.
  - `init` and the first review write `.openqodex/config.yaml` with `version: 1` set and every other key as a comment showing its default, so a later default change reaches the repository. A file an earlier `init` wrote is never rewritten; a warning says when it still holds a default a release changed.
  - A scanner name in `scanners.disable` that this version does not know is ignored with a warning naming the nearest scanner, and the review runs; before, it stopped with exit 2 and the push went through. An unknown `block_on_severity` still stops the run.
  - The new optional `min_version` key of the repo config stops an older OpenQodex with one line naming the version the repository needs.
  - `openqodex config migrate` prints the rewrite the table of config changes asks for (renamed keys, removed keys, the 0.1.0 root file moved into `.openqodex/`), and `--write` applies it, keeping every comment. `config` in the docs lists every change.
  - Every file OpenQodex creates that can quote your code or hold a review, a record or a setting is readable by you only (0600), in folders only you can open (0700), each given its mode when it is created. A report or receipt, or the `.openqodex/`, `.openqodex/reviews/`, `--report-dir` or receipt folder it goes in, that an earlier version or run left readable by others is closed to you the next time OpenQodex writes there, and named once.
  - The update's unpacking, the receipts in `~/.openqodex` and the files under a repository's `.openqodex/` are written through the same checked writer as `init`: a link that leads outside OpenQodex's home or lies in the repository is refused. Under `~/.openqodex/receipts/`, `runs/`, `last-review/` and `runtime/` any link, the file itself included, is refused, and a record read through one counts as none.
  - A background update started by a version that a rollback has since left ends without writing. The update reads the user config again just before it switches, so a `skip_version` written while it downloaded still holds, and it compares a release's own contract with the registry's claim before running anything of it.
  - A `skip_version` the update cannot read as a version pauses automatic updates and names the value; before, updates ran with no threshold.
  - The line after an update names each repository whose Cursor rule is stale and says to run `init` in each, and leaves out a rule behind a link the repository holds, which `init` would refuse.

## 0.8.1

### Patch Changes

- [#54](https://github.com/openqodex/openqodex/pull/54) [`8c9041a`](https://github.com/openqodex/openqodex/commit/8c9041a2467f7c6b345ddeefb62618bc21138c12) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A new docs page, `claude-code-review`, on code review in Claude Code.

- [#55](https://github.com/openqodex/openqodex/pull/55) [`0d9bcbe`](https://github.com/openqodex/openqodex/commit/0d9bcbe94db2088423657b1eb0e452a7e9206111) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The README, the docs, the Claude Code plugin's README, `openqodex --help` and the CLI's messages now name `.openqodex/config.yaml` as the config file. A root `.openqodex.yaml` is still read when `.openqodex/config.yaml` does not exist.
  `openqodex --help`, the docs index and the Claude Code marketplace entry now describe OpenQodex as it works today: AI code review before you push, from your coding agent or your terminal, with the scanners and a separate reviewer.

## 0.8.0

### Minor Changes

- [#52](https://github.com/openqodex/openqodex/pull/52) [`aff7254`](https://github.com/openqodex/openqodex/commit/aff72548d1bd91466218d37d90778d71174e5165) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A suppression comment the change adds, such as `# nosec`, `# noqa`, `nosemgrep`, `gitleaks:allow`, `# shellcheck disable=`, `# hadolint ignore=`, `//nolint`, `# rubocop:disable` or `eslint-disable`, is now a candidate of the scanner it silences, rule `openqodex.suppression-added`. The reviewer keeps or drops it. The same text inside a string does not count, except for semgrep and gitleaks, which obey it anywhere on the line. `scanners` lists every comment and where it counts.

  `scan`, the pre-commit hook and the GitHub Action now count an added suppression comment and a changed scanner settings or ignore file as a minor finding, so `block_on_severity: minor` blocks on them. `review.severity_threshold` never hides them, and neither `--only`, `--skip` nor the fixture filter leaves out a changed settings file any more, since a root config can extend one in a fixture folder. The report no longer has a separate "This change edits a scanner settings file" list, and `report.json` no longer has `settings_changes`.

  A scanner's finding on the same line no longer hides one of these candidates, for example semgrep's secret finding beside an added `gitleaks:allow`.

### Patch Changes

- [#52](https://github.com/openqodex/openqodex/pull/52) [`4764f0e`](https://github.com/openqodex/openqodex/commit/4764f0e8f2d45dd6dfbb79402b8e8d12a30507e2) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The blast radius no longer reports a function that moved to another file as "removed, still called". It lists it as "moved to" its new file, and a move does not raise the risk.
  A call to a function loaded with `await import()` inside another function is now traced to that function. Before, it counted as a call to a removed function of the same name in the caller's own file.
  A name an import binds inside a function (`await import()`, `require`, or a Python import) now counts only in that function, so a call elsewhere in the file that is broken stays reported.
  A name bound by destructuring, such as `const { a } = x`, a parameter `{ a }`, an assignment `({ a } = x)` or Python `a, b = pair`, now hides a function or an import of the same name, so its calls are no longer traced there.
  A `let` or `const` declared in a block, a loop or a catch clause now hides a function of the same name only inside that block.
  A method call on an object made from a class or a function that an import inside a function loaded is traced again, also after the code assigns that class name something else. A call on a name that the function declares later, such as one a closure uses before the declaration, follows that declaration, not an outer variable of the same name.
  A file with thousands of nested blocks no longer slows the code graph down: calls nested more than 256 scopes deep are left unresolved.
  A file that git sees as renamed is now checked: a caller that still imports the old path is reported as "removed, still called".

## 0.7.1

### Patch Changes

- [#49](https://github.com/openqodex/openqodex/pull/49) [`d27a66b`](https://github.com/openqodex/openqodex/commit/d27a66b4d97d984f7ff70e93be167793e860d1ec) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A review no longer ends incomplete when the reviewer searches with a brace list of paths, such as `{src/**,scripts/*.mjs}`, that stays inside the change; a list with any path outside still ends it.

  A review no longer ends incomplete when the reviewer reads or searches a name with two dots in it, such as Next.js's `app/[...slug]/page.tsx`; a `..` step that climbs out still ends it.

  A review no longer ends incomplete when the reviewer reads a file named with `$` or `%`, such as Remix's `app/routes/posts.$slug.tsx`, that exists in the change; a path like `$HOME/.ssh/id_rsa` that names no such file still ends it.

  The check of what the reviewer read now reads each call as Claude Code does: a Grep file filter split at a space or comma, a filter that starts with `!`, or a path with spaces around it ends the review when any reading points outside the change, and on a disk that keeps case, a folder whose name differs from the change's copy only in case counts as outside.

## 0.7.0

### Minor Changes

- [#46](https://github.com/openqodex/openqodex/pull/46) [`ee608c8`](https://github.com/openqodex/openqodex/commit/ee608c849458cdfccadda00e0c34dcb46cd57bc2) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The GitHub Action runs the full review on a pull request when the workflow sets `ANTHROPIC_API_KEY` on its step from a secret: the scanners, the code graph and a Claude Code reviewer, with the report in the job summary and the findings in code scanning. Without a key it runs the scanners only, as before, and says in one line how to turn the review on. Each review spends the repository's own API credit.
  - The new Action input `review` takes `auto` (the review with a key, the default), `off` or `required`, which fails the job without a complete review. The new input `claude-code-version` pins the Claude Code the Action installs. The new outputs `reviewed`, `review-status` and `reviewer` say what ran.
  - In a pull request the Action's review reads the custom instructions from the base branch, like the config, so a pull request cannot write its own. The reviewer's web tools are off in the Action, the key reaches the review command alone, and the review never runs on `pull_request_target`.
  - When the Action's review does not complete, the job also runs the scanners, so an incomplete review never hides a scanner finding: the summary shows the partial review and then the scan, code scanning gets the scan's findings, and a blocking finding from either fails the job.
  - The Action's `version` and `claude-code-version` inputs take an exact SemVer release version only, such as `0.6.1`; a tag such as `latest`, a range, a path or a `file:` package now fails the step. The Action runs its helpers from the system folders only, runs `git`, `node`, `npx`, `npm` and `claude` only from outside the checkout and gives its programs a PATH of those alone plus the system folders, keeps every program's output from writing workflow commands into the job log, escapes the text it puts in the job summary, and sets the key empty on its other steps. A pull request that commits `.openqodex/reviews` or `.openqodex` as a link no longer turns a blocking finding into a tool failure.
  - `openqodex review` takes `--block-on-severity`, as `scan` does, `--instructions <file>` to read the owners' instructions from another file, `--reviewer-web on|off` to set the reviewer's web tools for one run over the user config, and `--report-dir <folder>` to write every file of the run, and a `reviewer.json` that says whether a reviewer started and which, to a folder of your choice instead of `.openqodex/`, touching nothing under `.openqodex/` in the repository. `openqodex scan` takes `--report-dir` too.
  - A `.openqodex/latest.json` that is a link no longer fails a finished review: `review` warns and keeps its exit code.
  - The markdown scan report escapes every markdown and HTML character in scanner messages and reasons, as the review report does.

## 0.6.1

### Patch Changes

- [#41](https://github.com/openqodex/openqodex/pull/41) [`9c0a2e5`](https://github.com/openqodex/openqodex/commit/9c0a2e541a7aac5c672cb25391aada25744905b9) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The package and the three plugins now name https://qodex.ai/openqodex as their homepage.

- [#20](https://github.com/openqodex/openqodex/pull/20) [`da8878f`](https://github.com/openqodex/openqodex/commit/da8878fd4fe1eb746afde985a4002207952b8b24) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - OpenQodex is packaged for three plugin directories: the Claude Code plugin gains a README and an icon, a new Codex plugin in `plugins/codex/` carries the skill for the OpenAI plugin directory, and `.cursor-plugin/plugin.json` makes the repository a Cursor plugin.
  A new privacy page, `docs/privacy.md`, says what OpenQodex collects (nothing) and lists every network call it makes. `openqodex guide privacy` prints it.
  The skill's description now names the requests it answers: a code review, a security scan, a diff or a pull request.
  The npm package, the GitHub Action and the plugins have new descriptions and keywords, and the README opens with a banner.

## 0.6.0

### Minor Changes

- [#35](https://github.com/openqodex/openqodex/pull/35) [`dfef509`](https://github.com/openqodex/openqodex/commit/dfef5093ded29019f795e98108b02362d4b2f5c4) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - Codex can now be the reviewer. `openqodex review --reviewer codex` runs the full review with `codex exec` on your Codex login, and `auto` picks Codex when you run the command from Codex or when Codex is the only reviewer installed.
  The Codex reviewer reads the copy of the change in a read-only sandbox with no network for its commands. It still loads your global `~/.codex/AGENTS.md`.
  Before each Codex review, OpenQodex checks that the sandbox refuses a read outside the copy and a write inside it. If it does not, the review does not start and you get "Full review unavailable" with the fallback.
  With Codex, the report says file reads were not recorded, because Codex does not show every command it runs. Changed lines count only when the brief or a correction round put them in front of the reviewer.
  Inside Codex's own sandbox, where a second Codex cannot start, `review --reviewer codex` prints "Full review unavailable" and the `review --agent` fallback.
  The reviewer brief no longer tells the reviewer which tools it has; it says to inspect the copy with its own tools, edit nothing and run none of the repository's code.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`8e614e4`](https://github.com/openqodex/openqodex/commit/8e614e493386a0e371afc21594a3e8fe9bc0c20a) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The reviewer can now search the web and open web pages by default; set `reviewer_web: off` in `~/.openqodex/config.yaml` to remove the web tools.

### Patch Changes

- [#37](https://github.com/openqodex/openqodex/pull/37) [`0b0b923`](https://github.com/openqodex/openqodex/commit/0b0b923c911d6591bf25e924638183bb85cc0ef0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A scanner download that is stopped for being too large or too slow no longer leaves its partial file behind.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`59bb4b6`](https://github.com/openqodex/openqodex/commit/59bb4b60353da73ae96f2a1d26a7e7dd239f8e1e) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The terminal report no longer prints a line reading only "agent" under a finding the reviewing agent raised from its own reading; a scanner finding the agent verified still names its scanner.

  - The line `hook install` prints for husky or a pre-push hook of your own now passes git's hook arguments (`"$@"`), so a push to a remote other than origin is checked against that remote. The lefthook line passes none, because lefthook would put a remote URL into the command as raw shell text; with lefthook a push is still checked against origin.
  - `docs/security.md` now lists the problem report among the network uses: what the issue holds, and that it is sent only when you choose it.
  - The skill now says that two scanners go online: semgrep downloads its rule packs, and osv-scanner sends dependency names and versions to osv.dev. `--offline` skips both.
  - A brief written by a local build of OpenQodex (run with `node <path>/dist/bin.js`) now names that same node and file in its finalize command, and in the fallback line when no reviewer can start, instead of `npx -y openqodex@<version>`. A run through npx or the launcher is unchanged.
  - `init` and the first scan or review no longer tell you to commit a file that git ignores in your repository; they say it is ignored and not shared with your team.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`379c2ca`](https://github.com/openqodex/openqodex/commit/379c2ca96ef8798c838f9e4c9d51556abb76aa91) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - In a work tree nested inside its bare repository (such as `repo.git/main`), the review after `init` no longer includes the files `init` itself wrote.

- [#35](https://github.com/openqodex/openqodex/pull/35) [`1ce2fac`](https://github.com/openqodex/openqodex/commit/1ce2fac3df1173a986a044d87e47ecedc3030f19) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The pre-push hook now finds a complete review of the pushed branch even after a later review of other work.

## 0.5.0

### Minor Changes

- [#31](https://github.com/openqodex/openqodex/pull/31) [`4e5b25d`](https://github.com/openqodex/openqodex/commit/4e5b25dc75f653f1b640c852d1396faa8a3f9648) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - The GitHub Action reads a pull request's OpenQodex config from its base branch, so the pull request cannot hide findings through its own config; when the base cannot be read it uses the built-in defaults, never the pull request's file. The new input `config-from: head` reads the pull request's config instead. A wrong `config-from` or `block-on-severity` value now fails the step.

  - The GitHub Action handles a failed scanner install like a failed scan: a warning and `status: tool-failed`, and a failed job only with `fail-on-tool-error: true`. An incomplete review in SARIF is now a failed run that names what is missing.
  - The push hooks check each range a push sends against the commit the remote holds, so a force push over work the review never saw is not covered by it. The agent hook checks your current work for a plain `git push` and says it cannot tell for any other push command (a deny when `block_on_severity` is set); the git pre-push hook stays the check that sees the exact commits. A pre-push that sends nothing passes.
  - A review stops before the reviewer starts when a file name holds a secret the scanners found, and the reviewer's trace is redacted like the report.
  - A review counts a changed file that was too large to map or brief as unread until the reviewer reads it.
  - A finding must start on a changed line and end within the file and 200 lines.
  - Ctrl-C during a review stops the reviewer and its children and removes the snapshot.
  - The review `init` ends with now reviews your own earlier edits to files init writes, such as CLAUDE.md, without init's own section.
  - A review from the older two-step protocol counts for the push hooks only when this machine ran its scan.
  - The review `init` ends with now runs when `init` also installs the git pre-push hook or adds a `.git/info/exclude` line; before, it stopped with "the review after init did not run".
  - The git pre-push hook accepts a review of a branch made with no upstream set when it is pushed over its remote tip, as long as the review covered exactly the pushed commit; before, such a push counted as unreviewed and, under `block_on_severity`, was stopped every time. When a branch the remote has is still unreviewed and has no upstream, the hook's line says to set the upstream, review, then push.
  - When no reviewer can start (only Codex or only Cursor installed, or Claude Code logged out), `review` now names a fallback after "Full review unavailable": the agent you are in runs `review --agent` and follows the brief it prints. The skill tells the agent to follow it.
  - A review finished through `review --agent` and `review --finalize` says "Reviewed by the coding agent you are using." on the first line after the verdict, in the terminal, `report.md`, `report.json` (`reviewed_by`) and `report.sarif` (a run property). Its brief ends by telling the agent to show you the report as printed.

- [#31](https://github.com/openqodex/openqodex/pull/31) [`a3eb515`](https://github.com/openqodex/openqodex/commit/a3eb5158089cd42d43c35cb6cca92d22bdbad28c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `--reviewer` now takes `auto`, `claude`, `codex` or `cursor`, and `reviewer:` in `~/.openqodex/config.yaml` sets it for every review. Only Claude Code is enabled as a reviewer: Codex and Cursor say why they are not and the review exits 2.

  - `reviewer_web: on` in `~/.openqodex/config.yaml` gives the reviewer Claude Code's web tools. It is off by default.
  - `init` now ends with a review of your change, or asks what to review when there is none (the whole repository, a pull request, a branch, or not now). Without a terminal it prints the three commands. `--no-review` skips it, and a review that cannot run never fails `init`.
  - The push hooks now look up the review of exactly what is pushed. A complete passing review is silent, a missing one asks for `openqodex review`, an incomplete one never blocks, and a review from the older two-step protocol counts, with a line naming who reviewed.
  - The push hooks trust only the review record in your own `~/.openqodex/receipts/`, never report files a branch carries under `.openqodex/`. `init` and `update` remove records older than 30 days.
  - The git pre-push hook no longer scans or prints scanner findings.
  - The GitHub Action says first that it runs the scanners only. A tool failure (exit 2) no longer fails the job: it shows a warning annotation and a job summary line, and sets the new `status` output to `tool-failed`. The new input `fail-on-tool-error: true` fails the job instead, and the new input `block-on-severity` sets a gate that the pull request's own config cannot weaken.
  - `scan --block-on-severity <severity>` wins over the config's `review.block_on_severity`.
  - The skill, the agent rules and the team section now give the agent one command, `review`, and tell it to show the report exactly as printed. Claude Code is allowed to run `review` and `review --all` without asking; the older `review --agent` and `review --finalize` rules are removed.
  - Progress shows one line for the scanner stage, such as "Scanners: 6 ran, 5 had nothing to check, 14 candidates to check", instead of a line per scanner.

- [#31](https://github.com/openqodex/openqodex/pull/31) [`93a4a4a`](https://github.com/openqodex/openqodex/commit/93a4a4a48a8ae212de14d564b27bd671fb052738) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `openqodex review` now does the whole review in one run: it copies your change into a temporary snapshot, runs the scanners and the code graph on it, starts Claude Code as a separate reviewer that can only read the snapshot, checks the answer with a script and prints one report. Each finding says where, the problem, why it matters and the fix, and the report ends with which reviewer ran, how long it took and what it used.
  - A review is complete only when every scanner candidate was raised or dropped with a reason and every changed range was given to the reviewer. Otherwise the report says what is missing and the command exits 2.
  - With no reviewer installed and logged in, `review` prints "Full review unavailable", says what is missing, saves the unchecked scanner candidates to a file and exits 2. It never shows scanner output as a review.
  - New flags: `--reviewer auto|claude` and `--timeout <seconds>` (600 by default).
  - `review --agent` and `review --finalize` still work for older skills; a review finished that way is recorded as a legacy review.

## 0.4.0

### Minor Changes

- [#25](https://github.com/openqodex/openqodex/pull/25) [`000d3df`](https://github.com/openqodex/openqodex/commit/000d3dfda4105f9a0127b2584938c58c01677b8c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - - `openqodex review <branch>` and `openqodex review '[#42](https://github.com/openqodex/openqodex/issues/42)'` (or a pull request link) review a branch or a pull request that is not your current work. OpenQodex fetches it, checks it out in a temporary folder without running anything from it, and reviews what it added since it left its base. Your own settings and approvals apply, never the target's.
  - The base of a branch or pull request review comes from `--base`, the pull request's base when `gh` is installed, `review.default_base`, or the remote's default branch, and the output says which.
  - `review --finalize --run <id>` finalizes one run by name; the brief of a branch or pull request review prints it.
  - A change to a scanner's own settings or ignore file, such as `.gitleaksignore` or `ruff.toml`, is raised as a candidate the reviewer must clear, since it can hide that scanner's findings. A scan shows it as a note that never counts toward the verdict.
  - A change that only deletes code can now carry a finding that counts: the lines next to a deletion count as changed, and the brief lists each deletion point (issue [#22](https://github.com/openqodex/openqodex/issues/22)).

## 0.3.0

### Minor Changes

- [#21](https://github.com/openqodex/openqodex/pull/21) [`db539cd`](https://github.com/openqodex/openqodex/commit/db539cd986ba385aaf53d88cc689b206f4ac73ad) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `init` inside a repository adds a short review section to the repository's `CLAUDE.md` and `AGENTS.md`, so a teammate's agent reviews before pushing with nothing installed; the files show in `git status` to be committed. `--no-repo` skips it, and `--uninstall` removes exactly that section.
  Every user-scope install gets the launcher in `~/.openqodex/bin/`, even for Cursor or Cline alone. The user-scope skill is now a short stub that runs `<launcher> guide skill` for the full procedure of the active version, and the user-scope Cursor and Cline rules call the launcher instead of `npx -y openqodex@<version>`. The next `init` replaces a skill or rule an earlier `init` wrote, while it is unchanged.
  New `guide skill`: prints the review procedure of the running version, with its commands written for the launcher when the launcher started it.
  The launcher runs the version named on the first line of `~/.openqodex/runtime/current`, and the version `init` installed when that line is missing, malformed or names a copy that is gone. A runtime copy is never replaced once written.
  The skill installed with `npx skills add` uses `~/.openqodex/bin/openqodex` when it exists.

- [#21](https://github.com/openqodex/openqodex/pull/21) [`3f53203`](https://github.com/openqodex/openqodex/commit/3f53203a0e3e01ca87f65b003266375f69be6353) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - In user scope, `init` adds rules so Claude Code runs the exact review command lines the skill names (`review --agent`, `review --finalize`, their `--all` and `--offline` forms) and `guide` without asking. When the launcher's path holds `*`, no rule is written and `init` says so, so a review can run unattended; any other flag or command still asks. `init --uninstall` removes exactly the rules it added.
  The skill `init` writes in project scope keeps the committed `npx -y openqodex@<version>` commands and no longer tells an agent to prefer the launcher.
  `init` skips the team review section for a `CLAUDE.md` or `AGENTS.md` the repository's git ignore rules hide, and says why.
  `init --uninstall` removes the update state, and `~/.openqodex/config.yaml` when `openqodex update` created it and it is unchanged.
  `openqodex update --rollback` turns updates off before anything else and changes nothing when it cannot.
  `openqodex --help` now shows four commands; `scan` is part of `review`; the other commands still work.
  `init`, uninstall, `hook install` and the update's switch take one lock that the operating system releases when a process ends: a listener on 127.0.0.1 that accepts no data. Lock files from earlier versions are removed by `init`.

- [#21](https://github.com/openqodex/openqodex/pull/21) [`23f6714`](https://github.com/openqodex/openqodex/commit/23f67146e67cda5abb195577fe63a70d5e23adc9) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - An install made with `init` updates itself: at most once a day, after a review, scan or push check run through the launcher, a background check installs a newer release that is at least 24 hours old and whose npm provenance was signed by this repository's release workflow. The command never waits for it, and the next command says once which version it moved to.
  New `openqodex update` command: `--now`, `--rollback`, `--off`, `--on` and `--status`. `doctor` shows the update state. Updates are off with `update: off` in `~/.openqodex/config.yaml`, `OPENQODEX_AUTO_UPDATE=0`, `--offline` and in CI.
  `review --finalize` runs on the openqodex version that wrote the brief, and the brief's finalize command names that version's own runtime when the launcher started it.
  A run through npx or a project-scope file never checks for updates; `doctor`, `review` and `scan` say when that pinned version is behind the newest one a check on this machine saw.

### Patch Changes

- [#21](https://github.com/openqodex/openqodex/pull/21) [`58b8578`](https://github.com/openqodex/openqodex/commit/58b8578b24a5722c219d0534a74ed2651ac77c5a) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - A review no longer misses a file edited at the same size within the same second that git last wrote its index.

## 0.2.1

### Patch Changes

- [#14](https://github.com/openqodex/openqodex/pull/14) [`39aeb9f`](https://github.com/openqodex/openqodex/commit/39aeb9f07f0e51819bdcc0369e329d70c0f5218d) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The push hook no longer follows links when it copies the repo's settings into its temporary checkout, so a pushed commit cannot make it write or delete a file outside that checkout.
  A pushed commit's own `.openqodex` folder never reaches the push scan.
  OpenQodex never reads or writes `.openqodex/` or the root `.openqodex.yaml` through a symbolic link at any level: a link there stops `init`, `init --uninstall`, `report`, `hook check`, `hook pre-push` and `review --finalize` with one line, or counts as no file for a run receipt, instead of reading or writing outside the repository.
  `--config` and `--output` that name a path under `.openqodex/` follow the same rule, and the message for a linked path says to replace the link with a real file.
  A `--config` or `--output` path that reaches `.openqodex/` through a symbolic link elsewhere in the repo is refused with a message that says to name the file directly.
  Files under `.openqodex/` and the config are read only when they are regular files within a size limit, so a link to a device or a named pipe can no longer hang a push or a review.
  The line `hook install` prints for husky, lefthook or a hook it did not write now ends in `|| [ $? -ne 1 ]`, so only a finding at the block threshold stops the push and a tool failure never does.
  Custom instructions are shown to the review agent as quoted text that can only widen or narrow what is flagged; a candidate dropped because of them says so in its reason.

## 0.2.0

### Minor Changes

- [#7](https://github.com/openqodex/openqodex/pull/7) [`ee91b7d`](https://github.com/openqodex/openqodex/commit/ee91b7d43ced9298e24e73b919ce2fec4137e58c) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `init` asks to add the git pre-push hook, adds a section to each agent's instruction file saying to review in a separate subagent when a feature or fix is done, and creates `.openqodex/config.yaml` and `.openqodex/custom-instructions.md` for the team to commit; the review brief carries the custom instructions word for word, and a scan no longer makes the push gate forget a finished review.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`c70e992`](https://github.com/openqodex/openqodex/commit/c70e99298d887be147323a4ba51b029414030634) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - `openqodex review --all` reviews the whole repository: the scanners check every file, and your agent reviews on top of their results, starting from the most-called functions and the files with the most scanner hits.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`762bbb0`](https://github.com/openqodex/openqodex/commit/762bbb004ba36dbc5acfae2f65b041fbf93d03f0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - Config moves to `.openqodex/config.yaml`, created with every key and its default on the first run; the root `.openqodex.yaml` is still read. New keys: `review.severity_threshold` (default `minor`: nitpick and info findings stay out of the report unless set to `info`), `review.default_base`, and `graph.enabled`, `graph.budget_ms`, `graph.max_files`, `graph.max_file_bytes`. Keys of the hosted `.qodex.yaml` that have no local meaning warn and are ignored; `pr_review` is accepted as an alias of `review`.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`762bbb0`](https://github.com/openqodex/openqodex/commit/762bbb004ba36dbc5acfae2f65b041fbf93d03f0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - When OpenQodex itself fails, or a scanner fails, it prints the exact text of a GitHub issue and offers two choices: 1 create the issue, 2 ignore. Nothing is sent without that choice. `openqodex report "<what went wrong>"` offers the same for anything else. The issue never holds code, paths, file names or secrets.

- [#7](https://github.com/openqodex/openqodex/pull/7) [`762bbb0`](https://github.com/openqodex/openqodex/commit/762bbb004ba36dbc5acfae2f65b041fbf93d03f0) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - The review brief now carries a code graph of the repo: which functions the change touches, who calls them with the exact call lines, which files import a changed file, and functions the change removed that other code still calls. It covers TypeScript, JavaScript, Python, Go and Ruby, binds a call only when the code proves the target, builds in a few seconds and caches per file under `.openqodex/graph/`. `graph.enabled: false` in the config or `--no-graph` turns it off.

## 0.1.0

### Minor Changes

- [#3](https://github.com/openqodex/openqodex/pull/3) [`8003022`](https://github.com/openqodex/openqodex/commit/8003022c393621be062ecb1b8aac35b822f3b028) Thanks [@siddhant-mohan](https://github.com/siddhant-mohan)! - First release of OpenQodex, open source code review that runs inside your coding agent before you push.

  - `openqodex review --agent` works out your change, runs the scanners that fit it, and prints a review brief for your agent.
  - `openqodex review --finalize` checks the agent's findings without a model and writes the report as Markdown, JSON and SARIF.
  - `openqodex scan` runs the scanners only, for git hooks, pre-commit and CI.
  - Thirteen built-in scanners, each run only when the change holds a file it reads, and only findings on changed lines kept.
  - Scanners download on first use at pinned versions; a slow install finishes in the background and joins the next run.
  - Any scanner can be added by its GitHub link in `.openqodex.yaml` and runs only after `openqodex trust` approves it.
  - `openqodex init` installs the skill and the push gate into Claude Code, Codex CLI, Cursor and Cline, and `--uninstall` removes them.
  - The push gate warns by default and blocks only when `.openqodex.yaml` sets `review.block_on_severity`.
  - `openqodex hook install` adds an optional git pre-push hook.
  - `openqodex doctor` shows which scanners are ready, and `--install` installs them all.
  - `openqodex demo` builds a small repository with planted bugs and scans it.
  - `openqodex guide` prints the docs offline.
  - A GitHub Action and a pre-commit hook run the scan.
  - `--offline` skips osv-scanner and semgrep, the two built-in scanners that go online, and turns scanner downloads off.
