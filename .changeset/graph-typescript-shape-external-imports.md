---
"openqodex": minor
---

`openqodex graph packages` now counts every line that imports a project. A file that imports one package twice, such as `import type { Turn }` and `import { TurnSchema }` from the same module, or an import and an `export ... from`, kept only its first line, so on TrueForge 8 of the 240 imports of `@truefoundry/trueforge-core` were missing. Each line is now its own import site. `importers` still lists each importing file once.

A call through a TypeScript interface now also reaches the classes that match the interface by shape. TypeScript accepts a class wherever an interface is asked for when it has the interface's members, even without `implements`, so a class that has every member by name (members marked `?` aside) is listed as a possible target, with evidence `by-shape`. At most 20 are kept per call; the rest is a `fan-out-capped` gap that marks the list as incomplete. Such a call no longer leaves an `unsupported-rule` gap when every class of that shape is listed: on TrueForge these gaps fell from 974 to 5, and `ISessionStore` calls from 56 to 0. The gap stays when the interface extends a type from a package, or a class that has the member extends a class from a package.
