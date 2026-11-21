---
"openqodex": patch
---

Fewer caller lists of TypeScript and JavaScript functions say "list incomplete" when nothing can reach the function unseen. A callback elsewhere in the package no longer marks every function's list incomplete. The list stays a floor, with a reason that names the place, when the function is used as a value (passed, stored, picked by a ternary, bound), when its module is passed on or indexed, when code is built at run time (`eval`, `new Function`), or when a module loaded by a computed path may offer it. A file the reader cannot vouch for (a global object, `this` outside a class, `import.meta`, code made from a string) keeps every function of its project a floor. A graph kept by an older version is built again.
