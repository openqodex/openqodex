---
"openqodex": patch
---

A repository reached through a linked folder (`/tmp` on macOS, linked to `/private/tmp`) printed the "could be read by other users" notice with a path climbing out of the repository with `../../../../private/...` instead of a path relative to it. The checked writer followed links when it walked the path it wrote, but not when it walked the root the notice is shown relative to. It now resolves the root the same way.
