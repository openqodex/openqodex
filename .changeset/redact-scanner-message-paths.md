---
"openqodex": patch
---

A scanner finding's message no longer carries the developer's absolute checkout path (for example rubocop's Lint/DuplicateMethods, which names both definitions by the path it was given); toRunDirRelative now rebases the message the same way it already rebases filePath.
