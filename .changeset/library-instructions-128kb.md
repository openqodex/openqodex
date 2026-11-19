---
"openqodex": minor
---

`reviewChange` now takes the owners' instructions up to 128 KB, raised from 32 KB, so a host that keeps longer review notes can give them whole. Over 128 KB they are still refused, never cut. The instructions share each finder brief's 256 KB with the context items and the diff, so long instructions leave less room for the change, and a part that cannot fit is named as unread. The laptop's `.openqodex/custom-instructions.md` and `--instructions` keep their 32 KB limit.
