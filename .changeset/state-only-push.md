---
"openqodex": patch
---

A push that changes only files under `.openqodex/`, such as the config, now goes through in a repository that sets `block_on_severity`: the review has nothing to review there, so the push hooks no longer ask for one.
