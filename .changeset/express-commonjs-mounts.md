---
"openqodex": minor
---

An Express router brought in with CommonJS (`require`, `module.exports`) now keeps its mount path, so `GET /:id` under `app.use('/users', users)` is `GET /users/:id`. A require the graph cannot follow is now reported as an unknown on the mount instead of silently dropping the prefix. An export written more than once (`module.exports = { users: a, users: b }`, `exports.users` assigned twice, or a member replaced by a later `module.exports`) is reported as unknown on the mount instead of taking the first write.
