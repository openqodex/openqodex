---
"openqodex": patch
---

`graph references` of a type now lists the places the type is named only in a cast. Four casts were missed before: a TypeScript angle-bracket cast (`<Row>x`), a type named through an import type (`x as import("./types").Row`, also in an annotation, with a path written with escapes, or beside another module's type of the same name), a Python `typing.cast(Foo, x)`, `cast("Foo", x)` or `cast(typ=Foo, val=x)` (not a parameter named `cast`), and a Go type assertion (`v.(Bar)`). The TypeScript ones made the list say it may be short; the Python and Go ones were dropped with no warning.
