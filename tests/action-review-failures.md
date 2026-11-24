# The Action's review mode: ways it can fail

Written before the tests. Each test of the review mode names the lines it guards ("R" and the number). `packages/cli/test/action.test.ts` runs the script without a reviewer, `packages/cli/test/total-review.test.ts` runs the new `review` flags with a stand-in model, and `tests/e2e/action-review.test.ts` runs the script with the real Claude Code.

1. A pull request commits files under `.openqodex/reviews/` and a `.openqodex/latest.json` that look like a complete, passing review, and the Action shows them, uploads them or reports `reviewed=true`.
2. A pull request changes `.openqodex/custom-instructions.md` to tell the reviewer to pass everything, and the review reads the pull request's text as the owners' instructions.
3. A pull request changes `.openqodex/config.yaml` or `.openqodex.yaml` to exclude files, disable scanners or lower the block severity, and the review reads that file.
4. The API key reaches `doctor`, the scanner install, the Claude Code install, a fallback `scan` or a scanner process.
5. The key appears in the job log, the job summary, an output, or a file under the runner's temporary folder.
6. The review ends incomplete (a timeout, a reviewer error, an answer that fails its checks) and the job reports `reviewed=true` or `review-status=complete`.
7. An incomplete review that left a report is replaced by the scan, so the findings that passed every check are lost from the job summary or the verdict.
8. No reviewer can start (no key and no login, or Claude Code fails to install), and the job shows no scanner findings and no reason.
9. The change is empty after the config's exclusions, and `review: required` fails the job, or the outputs claim a review ran.
10. The workflow runs on `pull_request_target`, and the Action reviews a fork's code with the repository's key.
11. A blocking finding comes with an incomplete review, and `fail-on-tool-error: false` lets the job pass.
12. `review: required` is set, this run has no complete review, and the job passes.
13. A wrong `review` or `claude-code-version` value is taken silently.
14. `review: auto` with no key runs anything but the scanner path of earlier versions, or its message does not say how to turn the review on.
15. The reviewer keeps its web tools in the Action because `reviewer_web: off` was written to a folder OpenQodex does not read (`OPENQODEX_HOME`).
16. The Action leaves the runner's own `config.yaml` in the OpenQodex home folder changed after the job (a self-hosted runner keeps its home folder).
17. Claude Code runs at a version other than the pinned one, or the script runs a `claude` program that the checkout holds.
18. The `block-on-severity` input is ignored in review mode.
19. Text from the pull request (a file name, a finding title, a reviewer's message) writes a workflow command or markdown structure into the annotation or the job summary.
20. The outputs `reviewed`, `review-status` and `reviewer` are missing, or say a review ran when it did not.
21. npm runs in the checkout, so the pull request's `.npmrc` points `npx` at a registry of its own, or a committed `node_modules` supplies the `openqodex` that runs, and that program gets the key.
22. The reviewer stops before any answer passes its checks (a timeout, an error, a refused key), so the partial report holds no findings, and a secret the scanners found is neither shown nor counted, where the scanners-only mode fails the job on it at the block severity.

Added after the code review of the first build:

23. The script runs a program from the checkout: `claude`, `node`, `npx`, `npm` or `git` reached through a link (or a chain of links) in a PATH folder outside the checkout, through a link chain with any step inside the repository even when it ends outside, from a relative PATH folder, or from a PATH folder inside the repository but outside the working folder.
24. The `version` or `claude-code-version` input names a path, a `file:` or git package, an alias, a tag, a range, or a malformed prerelease such as `1.2.3-..` that npm reads as a tag, and npm installs a package the pull request controls.
25. Text a program prints to the job log (a file name with a line break followed by `::error::`) is read by the runner as a workflow command.
26. Turning the reviewer's web tools off edits the runner's user config: a config written as a flow mapping (`{reviewer_web: on}`) becomes invalid YAML, an unwritable file leaves the web tools on, or a killed job leaves the file changed.
27. `review` ends abnormally (a crash, a kill, or a failure after its report was written) and the Action takes the report's verdict as the result; or a review that stopped after the reviewer started is called unavailable; or a `.openqodex/latest.json` link the pull request planted changes the result.
28. Text from the pull request makes markdown or HTML structure in the job summary through the scan report (a scanner's reason, a finding's message) or the tool-failure line.
29. A step of the Action other than the one that runs the script holds the key.

Added after the second code review:

30. A pull request commits `.openqodex/reviews`, `.openqodex` or a file under it as a link, the scan or the review stops on it, and a blocking finding becomes a tool failure that the job passes by default; or something is written through the link.
31. A helper the script runs (`od`, `tee`, `mktemp`, `sed` and the rest) is found through the workflow's PATH, so a program there runs or chooses the stop-commands token; or a program the script starts finds another program through the workflow's PATH.
32. A review whose reviewer started and then ended without a report leaves the `reviewer` output empty.

Added after the third code review:

33. On a push event or with `config-from: head`, a commit makes `.openqodex`, `.openqodex/config.yaml` or `.openqodex/custom-instructions.md` a link, and `doctor`, the scan or the review reads it from the checkout: the link stops the run, so a blocking finding becomes a tool failure, or the run reads the file the link points at.
34. The `version` or `claude-code-version` input is longer than 64 characters, or has a major, minor or patch number over 9 digits, which npm's version parser refuses and reads as a tag.

35. A chosen convention file committed as a link is followed or stops a review, instead of being omitted by name while the review completes.

Added with the project's reviewer list (`review.reviewers`):

36. The Action ignores the config's reviewer list: it forces Claude Code when the list names Codex first, or when it could not read the list; reads the list from the pull request's head when `config-from` is base; or reads the config from the base branch's tip, which can move between the Action's steps, instead of the pull request's base commit.
37. A list that names only Codex, on a runner with no codex or a logged-out one, installs Claude Code or reviews with it, instead of running the scanners only and saying why in the log and the job summary.
38. With no list, the review no longer runs with Claude Code alone, as it did before lists existed.
