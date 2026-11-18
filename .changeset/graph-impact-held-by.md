---
"openqodex": minor
---

`openqodex graph impact` now reaches past a change inside a handler a factory defines. Before, a change inside `createSessionHandler`, which `createSessionsRouter` registers with `router.openapi(route, createSessionHandler)`, listed no caller, so the factory and everything that calls it were missing. The answer now lists, apart from the callers, each function that holds the changed code (`held-by`, as a `defines` hop) and the callers of that function (`held-by-caller`), never counted as callers of the change. The review's brief is unchanged. `openqodex graph callees` takes `--edges` too: `--edges calls,defines` walks into the definitions a function holds and prints each such step as "defines", never "calls". Without `--edges` it is unchanged.
