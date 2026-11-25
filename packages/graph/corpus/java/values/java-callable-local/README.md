A local initialized with `this::refresh` calls the referenced method through `r.run()`.
A local initialized with `Factory::make` calls the static method through `s.get()`.
Both calls use the shared value alias rule at tier possible.
Any call on the local, including `c.reversed()` or `f.andThen(g)`, gets a possible edge to the referenced method.
The overloaded reference keeps both candidates at tier possible.

A reassigned local loses its alias, including assignments inside a nested block.
Neither the first value nor the replacement binds at the later call.
The enclosing class declares `run`, which must never bind through the local receiver.

Passing a callable local as an argument remains unsupported.
Local value references are discarded, so `submit(r)` does not carry the alias into `submit`.
The call inside `submit` creates no edge to `refresh` and no miss.

Lambdas and fields holding callables are outside this case.
