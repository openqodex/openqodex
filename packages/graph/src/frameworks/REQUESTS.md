# Requests to the plugin interface and the framework stage

Changes the Next.js, React, Express, FastAPI and Go net/http plugins need from `plugin.ts`, `stage.ts`, `layer.ts` or `registry.ts`, which their builder does not edit. Each says what it is for and how the plugins work around it until then.

1. Registry entries. The five plugins are registered in `registry.ts` (express, fastapi, go-http, nextjs, react, in id order beside django and rails). The README names that file as the one place a plugin is added; without the entries the build never runs the plugins and the corpus cannot score them. The merge keeps both sets of entries.

2. Append without spreading, and all or nothing. `runFrameworks` appends each plugin's output with `push(...list)`. In Node 22 a spread of about 120,000 items overflows the stack, and because the applications are appended before the edges, a plugin that fails there leaves its applications in the build while it is reported as failed. A loop of single pushes, onto lists that are appended to the build only once the plugin's whole output is in hand, fixes both. Until then every 4b plugin keeps each list it returns under its own build cap (applications, roles, edges by kind, unknowns), each well under 60,000. The test links the stage derives itself (`deriveTestCalls`, one per call a test makes) have no cap, so a large test suite can overflow that append on its own; they need a cap per build with one unknown, as the plugins' lists have.

3. Count caps per build, not per application. The stage's `MAX_ENTITIES_PER_APP` and `MAX_EDGES_PER_APP` restart for each application, so a repository of many small applications multiplies the work and the memory they bound. The 4b plugins count every budget once per build and stop with one unknown; the stage's caps would match if they counted the same way.

4. An `injects` edge kind (a registration or handler to a dependency provider). FastAPI's `Depends(f)` and `Security(f)` are dependency injection, not middleware. The FastAPI plugin emits them as ordered `applies_middleware` edges with a note saying each runs before the handler on every request, which is true, and gives `f` the role middleware with detail "fastapi-dependency".

5. A `requests` edge kind (a symbol to a registration, likely). A literal `fetch("/api/users")` in a Next.js or React component names a route of the same application. No edge kind says "this code calls that route", so the plugins record nothing for it.

6. A context entity and `provides` and `consumes` edges. React's `createContext` makes a value whose provider and consumers change together. The React plugin reads the contexts and skips their `Provider` and `Consumer` elements so they are never mistaken for components, but cannot record which component provides or reads which context.

7. Tests that render a parent component. `testsOf` follows call edges and route requests, not `renders` edges, so a test that renders `UserCard` is not listed for `Button`, which `UserCard` renders. Following `renders` backwards from the symbol, as `routesReaching` follows calls, would answer it.

8. Columns. `plugin.ts` says positions are "1-based line, 0-based column, as the language facts", but the language facts use 1-based columns (`extract.ts`, `pos`). The 4b plugins use 1-based columns, as the language facts do; the comment should say so.

9. One owner for the test role. A test file's role (runner dependency, test path, test blocks) is a language matter, but today each plugin assigns it and the shared mapper derives direct-call links per plugin, so two plugins that mark the same file would link its calls twice. The 4b plugins mark only files with framework evidence of their own (a supertest request, a Testing Library render, a TestClient request, a `_test.go` file in a project that serves net/http, a pytest module in a FastAPI project).

10. A Go project's module path and `go` directive through `PluginIndex`. The Go plugin names the default mux after the go.mod path rather than the module, leaves `Detection.version` null, and cannot tell a go.mod below Go 1.22, where `"GET /x"` is a literal path.

11. `Registration.partial` (added on the 4a branch after the interface commit 4b builds on). The 4b plugins leave it absent; a route under a computed mount or include prefix has a null pattern and an unknown that names the computed part.

12. Index a file's methods once in the shared test mapper. `deriveTestCalls` in `shared/tests.ts` finds a test class's methods by scanning every symbol of its file once per test class, so a file of thousands of test classes costs classes times symbols. A map of each file's methods by owner, built once, as the 4b plugins now find components, actions and handlers, keeps it linear.

13. Maven and Gradle dependencies through `PluginInputs` and `PluginIndex.declares`. JUnit detection uses proven annotation identities. A manifest alone detects nothing. The plugin cannot read a declared JUnit version through this contract.
