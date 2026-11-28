---
"openqodex": patch
---

In a staged library review, a budget refusal of a finder call no longer stops the verifiers. Before, one refused finder call ended every later call, so a large change that spent its allowance on finders posted no finding at all. Now the finders stop, the units they did not reach are named as not examined, and the verifiers still check what the finders found, asking `authorize` before each call. A host can keep money for verification by refusing finder calls past a share of its cap.
