---
"openqodex": patch
---

A function a framework runs no longer reads as having no callers when a framework plugin skipped its file. Before, a Next.js route handler or a Nest controller action in a file over 256 KB (the plugins' size bound, below the graph's own 512 KB) showed an empty caller list as complete. Now `callers` is a floor that names the file the plugin did not read. A question stopped by its time budget names each point where it stopped in `unknown.gaps`, and a language the build does not read is named at the target's definition.
