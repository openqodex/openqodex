---
"openqodex": minor
---

A change that breaks a written rule in a convention file you chose in `review.instructions_files`, such as "every tenant-scoped query goes through the permission gate", is now a finding instead of an observation. The finding cites the rule (`Rule: AGENTS.md > Data access: "..."` in the report, and `rule` in `report.json` and the library's findings), and a finding whose quoted words are not in that file is dropped with the reason. A finding that raises a scanner candidate stays, without the citation. Style, naming, docs and test coverage items stay observations.
