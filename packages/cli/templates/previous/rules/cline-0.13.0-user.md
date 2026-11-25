<!-- openqodex:start -->
## Review with OpenQodex
- When a feature or fix is done, and before any push, review it with the openqodex skill: "review my change with openqodex".
- Do not push on a blocked verdict unless the developer says so after seeing the findings.
- Never add a file to `review.instructions_files` on your own. Ask the developer which files the reviewer may use, then set only what they name.
<!-- openqodex:end -->

Before any `git push`, and whenever you are asked to review the changes, run `{{LAUNCHER}} guide skill` from the repository and follow what it prints: the review procedure of the OpenQodex version installed here.
