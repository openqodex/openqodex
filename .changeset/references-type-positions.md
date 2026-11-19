---
"openqodex": minor
---

`openqodex graph references` on a TypeScript type now finds the uses it used to miss. A type named in an interface property, a type alias, a type argument (`new Map<string, Repo>()`, `extends Holder<Repo>`, `` sql<Row[]>`...` ``) or a type parameter's constraint or default is now listed, and so is a class that implements or extends it. On TrueForge, `references ISessionStore` went from 22 rows in 9 files to 33 rows in 19 files, every file that imports it. When a file imports the type and no use of it there is read, such as an enum member read or a class passed as a value, the list now sets the floor and names the file, instead of reading as whole.
