# OpenQodex docs

OpenQodex is open source AI code review for Claude Code and Codex. It runs before you push, from your coding agent or your terminal.

These pages ship inside the npm package. `npx openqodex guide <topic>` prints one in your terminal, offline. The topic is the file name without `.md`.

## Words used in these pages

- Change: the commits not yet pushed plus everything uncommitted, untracked files included.
- Changed lines: the lines the change adds or edits. Context lines around them do not count.
- Scanner: a program that checks code without a model, such as gitleaks or semgrep.
- Finding: one problem at one place in the code, with a severity.
- Candidate: a scanner finding on a changed line, waiting for the agent to verify it.
- Brief: the text `openqodex review` gives its reviewer to review from.
- Report: the result of a scan or a review, written as `report.md`, `report.json` and `report.sarif`, and for a review also as `report.html`, a page that shows each finding under its line of code.
- Receipt: what `review` prints when it ends: the verdict, one line per finding and the absolute paths of `report.html` and `report.md`.
- Verdict: `passed` or `blocked`.

## Pages

- `quickstart`: install OpenQodex and run the first review.
- `claude-code-review`: code review in Claude Code, from install to report.
- `cli`: every command, flag and exit code.
- `config`: every key of `.openqodex/config.yaml`.
- `scanners`: the twenty-two built-in scanners.
- `graph`: the code graph: what it answers, what it cannot see, its folder, its commands and its MCP server for agents.
- `custom-scanners`: add any scanner by its GitHub link.
- `agents`: what `init` writes for each coding agent.
- `github-action`: run the scan on pull requests.
- `library`: review a change with your own model (`reviewChange`), preinstall the scanners for a server image, and import the scanners, the code graph, the lenses, the config parser and the renderers into a Node program.
- `security`: what runs, what is sent where, and where files go.
- `telemetry`: there is none.
- `privacy`: the privacy policy: what OpenQodex collects (nothing) and every network call it makes.
- `faq`: short answers.
- `benchmark`: how review quality is measured, from a clone of the repository, and the rule that a claim about it cites a saved run.
