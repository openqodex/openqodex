---
"openqodex": patch
---

`graph callers` of a Python function now lists the places it is used as a decorator without parentheses (`@wrap` or `@pkg.wrap`, also on a method). Before, only `@wrap()` counted, so a function used only as `@wrap` read as having no callers.
