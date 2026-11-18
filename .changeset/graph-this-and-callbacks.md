---
"openqodex": minor
---

The code graph no longer names a wrong TypeScript caller through `this`. A call of `this.method()` inside an object's own method, or inside a `function` nested in a class, was taken as a call on the class, though `this` there is the object or whatever the caller binds. It is now listed as an unknown. Arrows keep the class's `this` as before. An untyped parameter of a callback now takes its type from the function type the called repository function declares for it, so `tracing.withSpan("x", (span) => span.setOutput(o))` finds its caller.
