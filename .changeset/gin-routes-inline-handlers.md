---
"openqodex": minor
---

`graph routes` now reads gin services: engines, groups with their prefixes, `Use` middleware and handlers. A route handler written in place (`app.get("/x", (c) => ...)`) is now a definition of its own, so the route points at it and the calls inside it have it as their caller. A callback of the same shape that no route binds (`cache.get(key, () => load())`) stays part of the function around it. Each route says whether a test file builds its application (`isTest`), and `--exclude-tests` leaves those routes out.
