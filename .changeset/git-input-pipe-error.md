---
"openqodex": patch
---

A git command that stops before it has read all of its input (for example `git hash-object --stdin-paths` at a path it cannot open) now fails that one review with git's own message, instead of an uncaught `write EPIPE` that ended the whole process and every other review running in it.
