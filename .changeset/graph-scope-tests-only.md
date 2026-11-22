---
"openqodex": patch
---

A caller list that is a floor now says `Complete in product code` only when every place that could hide a caller is a test file. Files in a `scripts/`, `benchmark/` or `corpus/` folder count as product code, since such a folder can hold an entry point that ships. The note now reads `Complete in product code. Only test files could hide a caller: ...`. The graph also keeps the floor of a function that a long web of `export *` hides from its walk, when its module is used as a value.
