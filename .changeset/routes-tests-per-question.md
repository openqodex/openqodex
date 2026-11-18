---
"openqodex": minor
---

`openqodex graph routes` and `graph tests` now each decide for themselves whether the graph read what they ask about. A React package beside an app in a framework this build does not read (for example Koa) no longer turns `routes` into an empty list that looks complete: it answers `unsupported` and names the framework. A repository with FastAPI routes and a Koa package lists the FastAPI routes as a floor that names Koa. `graph tests` always lists calls from files named like tests as leads beside the framework's test links, and says a floor naming the symbol when no link reaches it. `graph capabilities` says the same per question.
