---
"openqodex": minor
---

The code graph no longer names a wrong certain caller through TypeScript's `Pick`, `Omit` or `Map`. A call of a member that `Pick<T, K>` or `Omit<T, K>` leaves out is now an unknown instead of a certain caller of T's member, and a `Pick`, `Omit`, `Map` or other built-in generic that the file declares or imports is read as that file's own type. A file of object types nested thousands deep no longer stops the build with a stack overflow. The count of source files in unsupported languages now counts only regular files, never links or paths that are gone.
