---
name: openqodex
description: Code review for the current change, before it is pushed. Use before every git push, when asked for a code review, a security scan, or to review changes, a diff or a pull request, and when a push was blocked or warned by OpenQodex.
---

# OpenQodex: review the change before it is pushed

## When to run

- Before any `git push`.
- When the developer asks you to review their changes.
- When a push was blocked or warned by the OpenQodex hook.
- After fixing findings, to check the change again.

## Procedure

Run this from the repository and follow what it prints, from step 1 of its procedure:

```
/home/dev/.openqodex/bin/openqodex guide skill
```

It prints the review procedure of the OpenQodex version installed here, with the exact commands to run. Read it each time: it changes when OpenQodex updates.
