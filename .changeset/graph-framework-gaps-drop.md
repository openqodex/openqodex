---
"openqodex": patch
---

A function a framework runs no longer reads as having no callers when its route was written with a computed path. Before, a FastAPI route on an f-string path, a Go route on a constant longer than the string limit, or an Express route on a computed path dropped its handler, and `callers` showed an empty list as complete. Now every framework gap that can drop a route floors callers, and each cause is listed in one table that a new cause must join. A handler imported from another project is now floored by a gap in the project that imports it. A Rails work budget that runs out now floors callers in every project, not only the root one.

A Python function passed inside parentheses, as in `Depends(((dep)))` or `x = (handler)`, now counts as used as a value, so its callers floor as they do without the parentheses.

A Next.js middleware whose matcher is computed or cut now floors only the middleware's own callers, not every function of its project. The MCP server's instructions now say that a `callers` floor covers the target only, so a caller of a caller can be missing past one hop.
