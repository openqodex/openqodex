---
"openqodex": minor
---

Six dead ends of the code graph answers are fixed. A `callers` answer that could not bind same-name calls now opens with a warning that says so and points to `graph unknowns --name`, in the command line, the JSON and the MCP answer. `implementers` on a file answers with the classes and interfaces the file defines, so the next question names one. `unknowns --file` says how many rows come from other files of the same package, and why. A `search` with exactly one definition of the exact name also names it as `target`. `outline .` and an empty path mean the repository root. A truncated JSON or MCP answer carries the same paging sentence the command line prints (`truncated.note`).
