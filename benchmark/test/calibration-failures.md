# W8-3 failure cases

Written before implementation.

1. A comparison accepts less than 90 percent agreement on either published class.
2. A comparison accepts a calibration from another product build.
3. A judge sees published vendor labels before returning its verdicts.
4. A missing, duplicate or extra vendor label silently changes the denominator.
5. Greptile pools its original truth with Augment's corrected comments.
6. A malformed model answer becomes a missed bug.
7. Martian reports its default F2 instead of the cited Core F1 row.
8. Martian silently skips a golden comment absent from the published evaluations.
9. Aggregate agreement hides the class counts or an empty class.
10. A calibration's claimed agreement differs from its saved label counts.
11. A calibration reference uses another board, prompt or judge.
12. Calibration runs on changed upstream pipeline bytes.
13. The relay omits usage, making cost look like zero.
14. Public GitHub reviews use unauthenticated requests despite an authenticated gh session, or pagination drops comments.
15. A Martian restart pays again for a completed request, or reuses a response for changed request bytes or board pins.
16. One dropped connection restarts completed items instead of retrying only that request.
17. More than three connection drops are retried, or an HTTP failure is treated as a retryable drop.
18. Cached responses lose their usage, or a truncated response is cached as a completed verdict.
19. A cached response writes the upstream key or endpoint to disk.
20. The captured dedup answer repeats indices 5 and 6, is cached, and is replayed instead of making a fresh ask. Existing cache entries must pass the same stage validation as new answers.
21. Invalid JSON, an extraction without string issues, incomplete or duplicate dedup indices, or a match without a boolean and numeric confidence is cached as a verdict.
22. Three invalid answers abort later items, multiply through the pipeline's own retries, disappear from the failure count, or omit their paid usage. Invalid text must survive beside the cache.
23. A failed judge item becomes a negative label or vanishes from the record. Its affected reviews and published class counts must remain in the record as exclusions.
24. A calibration with one excluded deduplication item and agreement on both remaining classes is marked failed or exits 1. The saved Martian record must pass with its failure details intact.
25. Below-bar agreement makes a completed calibration exit 1; only missing agreement or a missing class should do that. Comparison acceptance still enforces its agreement bar or matching ruling.
26. A comparison accepts judge failures without a matching excluded item count and reason.
