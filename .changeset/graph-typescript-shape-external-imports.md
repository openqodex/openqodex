---
"openqodex": minor
---

`openqodex graph packages` now counts every line that imports a project. A file that imports one package twice, such as `import type { Turn }` and `import { TurnSchema }` from the same module, or an import and an `export ... from`, kept only its first line, so on TrueForge 8 of the 240 imports of `@truefoundry/trueforge-core` were missing. Each line is now its own import site. `importers` still lists each importing file once.
