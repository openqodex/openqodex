---
"openqodex": patch
---

Benchmark model reviews retry a dropped connection once, sharing the rate-limit retry. Resuming a run keeps the saved failure and finishes its pending retry; two failures of the same class in one job halt the run and name both failures.
