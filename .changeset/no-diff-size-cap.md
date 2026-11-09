---
"openqodex": patch
---

Keep every changed file in large reviews. Patches that overflow memory stream to temporary files, so removed lines remain available to reviewers. The temporary patches are removed when the review ends.

Keep large files visible in agent briefs and lens selection. Read retained patches by indexed hunks, and release temporary patches after scans and failed or cancelled reviews. Push checks compute only the change id.

Remove the public `DIFF_CAP_BYTES` export. Library callers must stop importing it; changed-file diffs are retained without that size cap.

`Change.diffs[].text` is now optional: spilled entries provide a `file` path instead. `Change.diff` holds only the patches kept in memory. Library callers should read retained diffs by range with `diffHunks`.
