---
"openqodex": minor
---

`openqodex graph routes` and `graph tests` now each decide for themselves whether the graph read what they ask about. A React package beside a Hono app no longer turns `routes` into an empty list that looks complete: it answers `unsupported` and names Hono. A repository with FastAPI routes and a Hono package lists the FastAPI routes as a floor that names Hono. `graph tests` always lists calls from files named like tests as leads beside the framework's test links, and says a floor naming the symbol when no link reaches it. `graph capabilities` says the same per question.
