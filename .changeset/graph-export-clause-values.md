---
"openqodex": patch
---

A router or app given out through the export table (`export { router }`, `export { router as api }` or `export default router`) is now mounted under its prefix, as `export const router = ...` already was. Before, `app.use("/v2", router)` showed its route as `/things` instead of `/v2/things`, and a call of such a value pointed its miss at the wrong file.
