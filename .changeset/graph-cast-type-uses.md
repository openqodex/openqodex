---
"openqodex": patch
---

`graph references` of a type now lists the places the type is named only in a cast. Four casts were missed before: a TypeScript angle-bracket cast (`<Row>x`), a type named through an import type (`x as import("./types").Row`, also in an annotation), a Python `typing.cast(Foo, x)` or `cast("Foo", x)`, and a Go type assertion (`v.(Bar)`). The TypeScript ones made the list say it may be short; the Python and Go ones were dropped with no warning.
