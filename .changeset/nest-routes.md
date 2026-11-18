---
"openqodex": minor
---

The code graph now reads Nest applications. `openqodex graph routes` lists every route a Nest app serves with its method, its full path, the controller method that handles it and the application that serves it, instead of answering that no framework is read. Paths are composed the way Nest composes them: the global prefix and its exclusions, URI versions, `RouterModule` paths, the controller's path and the method's path. A controller counts for an application only when a module its root module imports declares it. A part the graph cannot read, such as a prefix computed at run time, leaves the route with no path and says why, rather than guessing a path the server does not answer. Guards and interceptors are listed as each route's middleware.
