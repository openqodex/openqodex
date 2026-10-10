# Golden run failures

Written before the tests and implementation.

1. A changed finding, candidate, contract, coverage count, receipt kind or brief line disappears in normalisation.
2. Approved clocks, durations, run names, temporary paths, repo ids or reviewer process ids make identical runs differ.
3. A last-review receipt names a hash that does not match the raw report, and capture accepts it.
4. A valid raw receipt keeps its variable raw hash instead of the normalised report hash.
5. A missing, extra or changed output file passes the comparison, or the diff omits its file and line.
6. A new demo secret changes the change id, or replacement misses a demo file holding it.
7. A provider changes its answer to fit changed candidates instead of replaying the fixed submission.
8. A review is incomplete, drops a candidate, omits a required file or exits unexpectedly, and becomes a golden recording.
9. A scanner installation or review writes outside the temporary home and scratch folder, or a failed recording leaves its temporary folders behind.
10. A graph build's generation name, its build, stage or predicted durations, or a reviewer heartbeat line make identical runs differ, or the rest of the graph line in the brief is lost with the duration.
11. The snapshot hash keeps the graph files' timing and differs between identical runs, or capture accepts a raw snapshot hash that does not match the snapshot the reviewer was given, or a real change to a snapshot file leaves the recorded hash unchanged.
12. The frozen answer in stand-ins/submission.json is not the one answer.mjs makes from the recorded candidates, so freezing it again would change what the stand-ins say.

The built CLI with real git and real scanners proves failures 7 to 9 and the raw half of 11. Three full checks and a deliberate brief edit prove repeatability and comparison failure.
