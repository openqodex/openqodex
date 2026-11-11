---
"openqodex": patch
---

The git pre-push hook no longer lets a push through when the push breaks the config, for example by making `.openqodex` a symbolic link, in a repository whose committed config sets `block_on_severity`: it stops the push and says what is wrong with the config.
