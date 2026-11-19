---
"openqodex": minor
---

The code graph again finds a TypeScript call made through a local copy of an injected member, such as `const repo = this.deps.repo; repo.save(x)`. In 0.20.0 that call was dropped and replaced by a possible link to the `repo` property itself, with nothing to say a caller was missing. The local now takes the member's declared type, so the call is a certain caller of `save` when every step is proved. A property whose declared type is a function type still gets its possible link when the local is called.
