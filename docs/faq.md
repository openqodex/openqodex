# FAQ

## Do I need an API key or an account?

No other key and no account. The reviewer is Claude Code or Codex, on your own login and plan. OpenQodex itself calls no model. Without Claude Code or Codex, there is no full review. The GitHub Action is the exception: its review needs an Anthropic API key.

## Does OpenQodex send my code anywhere?

Not through the built-in scanners. Their network use is listed in `security`: scanner downloads, Semgrep rule packs, dependency names and versions sent to osv.dev, Kubernetes schemas and the RustSec advisory database. The reviewer sends the brief and the files it reads to the model of your Claude Code or Codex login. The brief includes any [convention files](config.md#convention-files) you chose. A custom scanner you approved does whatever its own command does.

## Will it block my push?

Not by default. Without `review.block_on_severity` in `.openqodex/config.yaml`, OpenQodex only warns. Set that key to block pushes at a severity. `OPENQODEX_SKIP=1` lets one push through.

## Why did a scanner not run?

The report lists every selected scanner with a status and a reason. The usual reasons:

- The change holds no file it reads. brakeman reads only a file in a Rails app: a folder whose `Gemfile` or `Gemfile.lock` names rails and that holds `config/application.rb` or `bin/rails`.
- It is still downloading on first use. It joins the next run.
- It needs Ruby or Go, which OpenQodex does not install.
- The agent's sandbox cannot download it. Run `npx openqodex doctor --install` in your own terminal, inside the repository.

## Why is a finding missing that the scanner reports on my whole repo?

OpenQodex keeps only findings on the lines your change adds or edits. Findings elsewhere belong to code you did not touch. A finding the agent places outside the changed lines is listed separately and never counts toward the verdict.

## Why were findings in my test fixtures dropped?

Scanner findings in fixtures, mocks, stubs, fakes and snapshots are dropped by default, because those files hold throwaway data. Set `review.include_fixtures: true` to keep them.

## How do I leave files out of the review?

List globs under `review.paths.exclude`. A `**/` prefix does not match a file at the repository root. To match both, list `**/x` and `x`. `config` has the rules.

## Can I use a scanner that is not built in?

Yes, when it is compatible: it writes SARIF or one JSON document. You or your agent add it to `.openqodex/config.yaml` by its GitHub link. Then you approve it with `openqodex trust`. `custom-scanners` explains how.

## Does it change my repository?

The review writes only inside `.openqodex/`. Its `.gitignore` keeps the reports out of git, so the first run adds only `config.yaml`, `custom-instructions.md` and that `.gitignore` to `git status`; they are meant to be committed. The built-in scanners run with fixes switched off, and their caches live outside the repository. A custom scanner you approved does whatever its own command does. `init` in user scope adds the rule files it writes in the repository to `.git/info/exclude`.

## Where are the reports?

In `.openqodex/reviews/<time>-<id>/` in the repository: `report.html` to open in a browser, `report.md` to read as text, `report.json` and `report.sarif` for tools. A review prints the absolute paths of `report.html` and `report.md` when it ends. `.openqodex/latest.json` points at the newest one.

## Does it work on Windows?

OpenQodex runs on macOS and Linux. CI runs the gate on macOS and on Ubuntu Linux. No test runs on Windows or WSL.

## What is the code graph?

A map of your repository that OpenQodex builds on your machine, with no model. It records every function, class and type, and every call and import between them. A review gives the reviewer what your change reaches in the graph. You or your agent can also ask it questions, such as `openqodex graph callers <name>`. `graph` describes it.

## Does my agent get the code graph through MCP?

Yes, in Claude Code, Cursor and Codex CLI, and in the Cline CLI in user scope. `init` registers an MCP server named `openqodex` with each one. For Goose and the Cline VS Code extension, `init` prints the entry for you to add. Restart the agent after `init`. `agents` lists every file `init` writes.

## Does it work in Goose?

Goose can start a review. Claude Code or Codex must be installed too, to be the reviewer. `init` writes a skill and a section in `.goosehints` for Goose, and no hook. The hints ask Goose to review before a push. The git pre-push hook still checks each push from a repository where `init` added it. This setup was built from Goose's documentation and has not been run against Goose.

## How do I remove it?

`npx openqodex init --uninstall` removes what `init` wrote. Delete `~/.openqodex/` to remove the scanners as well.
