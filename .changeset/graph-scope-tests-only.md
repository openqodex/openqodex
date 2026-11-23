---
"openqodex": patch
---

A caller list that is a floor now says `Only test files could hide a caller: ...` only when every place that could hide a caller is a path the graph reads as a test. A `scripts/`, `benchmark/` or `corpus/` folder no longer makes a file count as a test by its name alone. The list stays a floor either way; the graph never calls a list complete. The graph also keeps the floor of a function that the walk of `export *` did not reach before its step limit, when a module that stars it is used as a value. Only names that come through a star get that floor: never a default export, a name the module gives itself, or a name a named re-export leaves out.
