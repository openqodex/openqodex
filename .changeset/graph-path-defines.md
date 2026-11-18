---
"openqodex": minor
---

`openqodex graph path` now goes into the functions a function defines in its body, such as a route handler a factory registers on a router or a closure it returns. Before, a factory that hands its handler to `router.openapi(route, handler)` reached nothing the handler calls, so `path createSessionsRouter Sessions.create` found no path. Each such step is its own `defines` hop: the answer reads "createSessionsRouter defines createSessionHandler", then "createSessionHandler calls Sessions.create", and never calls the first step a call. `--edges` takes `defines` too; `callers` and `callees` are unchanged.
