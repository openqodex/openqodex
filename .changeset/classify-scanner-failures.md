---
"openqodex": patch
---

- When a scanner fails, the feedback offer now names the cause for the common cases OpenQodex phrases itself, instead of grouping them all under "failed for a reason not listed". A cargo-deny run that could not fetch the advisory database, hit a cold Cargo cache, or could not read the project with cargo metadata, and a golangci run where a package could not be type checked or a changed file had no Go module, each read as their own failure class. The reason text is still only matched, never kept, so no path, crate name or stderr reaches the issue.
