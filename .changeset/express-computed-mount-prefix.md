---
"openqodex": patch
---

An Express router mounted under a prefix the code computes, such as `app.use(process.env.PREFIX, router)`, `` app.use(`/${version}`, router) `` or `app.use(PREFIX, router)` where `PREFIX` holds such a string, no longer has its routes listed without the prefix. Their pattern is now unknown, the mount is reported as an unknown with a computed path, and no test request is linked to them by the path written without the prefix. A first argument the graph cannot show is a string, such as `auth.required` or a parameter, is still read as middleware.
