---
"openqodex": patch
---

A FastAPI or Nest function the framework runs no longer reads as having no callers when a plugin limit dropped its route, dependency or guard. Before, a FastAPI dependency written past a reader limit (a long dotted name, deep parentheses, a path of many literal pieces, a parameter past the 64th), a Nest controller written inside a function late in a long file, a guard past the 64th in one `UseGuards`, and a route inherited by a class with over 1,000 members showed an empty caller list as complete. Now `callers` is a floor that names the place. A build that stops a file at the 2 s parse limit names that file in its reasons, and a framework cut of routes no application reaches floors callers in every project, not only the root one.
