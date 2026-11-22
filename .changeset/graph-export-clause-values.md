---
"openqodex": patch
---

A router or app given out through the export table (`export { router }`, `export { router as api }` or `export default router`) is now mounted under its prefix, as `export const router = ...` already was. Before, `app.use("/v2", router)` showed its route as `/things` instead of `/v2/things`, and a call of such a value pointed its miss at the wrong file. Express, Hono and FastAPI no longer mount a whole router where only a member of it is given (`app.use("/v2", router.handler)`). A name two `export *` offer, a value in one module and a function in the other, is now ambiguous instead of a certain call of the function, and a module's own `export const x` wins over an `export *` that offers `x`.
