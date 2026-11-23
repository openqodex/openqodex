---
"openqodex": patch
---

The code graph builds faster on deeply nested code, on barrels whose `export *` paths meet again, and on many `eval` and global-object places. Escape analysis now stops at the time budget; a build it does not finish is partial, so every caller list is a floor. It also walks `export *` on its own step budget, so the comparison of a changed barrel keeps its own, and a function re-exported past that budget's stop by a module used as a value stays a floor. Fewer lists are floors for no reason: a `type` import named `createRequire` is no loader, and a module whose only export is a variable is no script. A Python `cast(...)` counts as `typing.cast` only where its import is seen and no later import of the module replaces it; one in a class body or under an `if` does not. A file that declares more than 4,096 plain global names reads back from saved facts. A graph kept by an older version is built again.
