---
"openqodex": patch
---

A scanner that ends on a signal OpenQodex did not send now says which signal, and the end of what it printed to stderr. The reason read only "sqlfluff was killed" before, so a crash (SIGSEGV, SIGABRT) and a kill from outside the run (SIGKILL) looked the same. It now reads, for example, "sqlfluff was killed by SIGKILL".
