---
"openqodex": patch
---

A method called on a local that holds a function no longer counts as running that function unless the method runs it. `fn.call(x)` and `fn.apply(x)` in JavaScript, `fn.__call__()` in Python and a Java functional interface's own method still do; `fn.bind(x)`, `fn.toString()` and Java's `r.equals(o)` no longer do. A method called on a Java local of a declared type (`Job j = this::work; j.twice()`) is now also listed as a caller of `Job.twice`; before, that method read as having no caller and no floor.
