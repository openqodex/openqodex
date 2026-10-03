# OpenQodex docs

OpenQodex is open source code review that runs inside your coding agent, before you push.

These pages ship inside the npm package. `npx openqodex guide <topic>` prints one in your terminal, offline. The topic is the file name without `.md`.

## Words used in these pages

- Change: the commits not yet pushed plus everything uncommitted, untracked files included.
- Changed lines: the lines the change adds or edits. Context lines around them do not count.
- Scanner: a program that checks code without a model, such as gitleaks or semgrep.
- Finding: one problem at one place in the code, with a severity.
- Candidate: a scanner finding on a changed line, waiting for the agent to verify it.
- Brief: the text `openqodex review --agent` prints for the agent to review from.
- Report: the result of a scan or a review, written as `report.md`, `report.json` and `report.sarif`.
- Verdict: `passed` or `blocked`.

## Pages

- `quickstart`: install OpenQodex and run the first review.
- `cli`: every command, flag and exit code.
- `config`: every key of `.openqodex.yaml`.
- `scanners`: the thirteen built-in scanners.
- `custom-scanners`: add any scanner by its GitHub link.
- `agents`: what `init` writes for each coding agent.
- `github-action`: run the scan on pull requests.
- `security`: what runs, what is sent where, and where files go.
- `telemetry`: there is none.
- `privacy`: the privacy policy: what OpenQodex collects (nothing) and every network call it makes.
- `faq`: short answers.
