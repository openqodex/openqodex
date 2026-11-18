---
"openqodex": minor
---

A TypeScript or JavaScript file now belongs to its npm package even when a Python script sits in a folder below it (issue #354). Before, one `.py` file under `src/` made the Python folder the project of every TypeScript file beside it, so Express, React, Next.js and Hono readers saw no dependencies and read no routes. Each file now takes the nearest project of its own language, and the Hono reader's own lookup is gone.
