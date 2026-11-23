---
"openqodex": patch
---

A caller list is a floor whenever the graph gave up somewhere that could hide a caller. Three places that gave up in silence now say so: a call of what another call returns, past the 32 functions listed; an `export *` branch too deep to follow when another branch gives the same name (issue 448); and a framework plugin that stopped at a cap or a step budget, which now floors the callers of the code the framework may run. `callers` and `callees` answers carry a new field, `unknown.gaps`: each place the graph gave up, with its cause, file, line and what to check next. `reasons`, `causes` and every other field stay as they were. The note on a floor whose hidden callers can only be in tests now reads `Only test files could hide a caller: ...`; the graph never calls a list complete. Kept indexes are built again once.
