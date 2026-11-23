---
"openqodex": patch
---

In a staged review, a finding the verifier marks as a duplicate of another shown finding now gives that finding its severity when higher. Before, a major duplicate folded into a minor finding left only the minor one, so a review that blocks on major findings could pass.
