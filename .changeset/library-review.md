---
"openqodex": minor
---

- `reviewChange(input, reviewer, options)` in the library reviews a change in a host's clone with the host's own model, in the server profile: OpenQodex proves the merge base, builds every request, runs the five read tools over a snapshot of the head commit, asks the host's budget before every model call and records each attempt's usage. The result holds the checked findings, what the reviewer did with each scanner candidate, the coverage, a model completion record (contract `openqodex-model-review-1`) and the report in markdown, SARIF and JSON.
- `previousReviewedSha` reviews only what changed since the last review, with findings still checked on the whole change; `scopes` keeps the change, the snapshot, the scanners, the graph, the tools and the context inside named folders; `context` gives the reviewer lessons, comments, summaries, notes and earlier findings as quoted data; `secondReviewer` runs a second model on the same brief and merges what both found.
- The host gives a budget, required: `authorize` is asked before every model call with the size of the request about to be sent (`requestChars`), and no call starts after `deadlineMs`. `instructions` takes the repository owners' rules, quoted as the laptop quotes its instructions file, and each finding carries the reviewer's `suggestedChange`.
- The library also exports `isFixturePath` and `ruleClassFor`, and a lens marked `security: true` carries `security` when loaded.
- The laptop's `openqodex review` is unchanged.
