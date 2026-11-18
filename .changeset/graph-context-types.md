---
"openqodex": minor
---

The code graph finds more TypeScript callers, and one wrong caller is gone. A call of `this.method()` inside an instance field initializer now binds to the instance method; before, it was read as a call on the class, and with a static method of the same name it named that static method as a certain caller. A function stored in a `const` inside a test body or another anonymous callback, or in a block at the top of a file, is now a definition, so calls of it bind instead of being listed as dynamic. A `for...of` variable and the first parameter of an array's `forEach`, `map`, `filter`, `find`, `some` or `every` callback now take the element type when the collection is declared as an array, a set or a Map's `values()`; anything else stays an unknown.
