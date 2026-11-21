---
"openqodex": patch
---

A caller list that is a floor now says where a missing caller could be. When every place that could hide one is a test, fixture, corpus, benchmark or top-level script file, `unknown.scope` is `tests` and `unknown.note` says so in one sentence, naming up to three of those places: `Complete in product code. Only test, benchmark or script files could hide a caller: ...`. The command line prints that sentence after `floor:`. Any other floor has `scope` `all` and keeps its reasons as before. The list stays a floor in both cases. A read of a parameter or local named `require` no longer counts as loading a module by a computed path, unless `createRequire` made it.
