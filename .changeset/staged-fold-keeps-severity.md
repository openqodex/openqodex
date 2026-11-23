---
"openqodex": patch
---

In a staged review, a finding the verifier marks as a duplicate of another shown finding now gives that finding its severity when higher. Before, a major duplicate folded into a minor finding left only the minor one, so a review that blocks on major findings could pass. The saved submission now carries the raised severity too, so replaying it gives the same verdict. Two findings that share a finding key and were marked as duplicates through a third finding no longer fold each other away: one of them is kept. An observation marked as a duplicate of another observation no longer removes a counted finding that shares its finding key, so that finding still blocks. An observation that shares a counted finding's lines and title no longer raises that finding's severity, folded or not: a counted finding takes its severity only from counted findings.
