---
"openqodex": minor
---

`graph status` and `graph capabilities` now count source files the graph cannot read (Rust, C, C++, C#, Kotlin, Swift, PHP, Scala), by language. A Rust crate no longer looks like an empty repository: the status says "412 Rust files not read: Rust is not supported by this build". The count adds no reason or floor to answers.
