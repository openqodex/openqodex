---
"openqodex": minor
---

Keep changed-line coverage for every text file, including changes over 500,000 lines. Coverage uses compact intervals instead of one entry per line. Library callers that pass `coverage` to `runScanners` must build it with the exported `LineSet` (`new LineSet().addRange(start, end)`); a `Map` of `Set<number>` is no longer accepted.
