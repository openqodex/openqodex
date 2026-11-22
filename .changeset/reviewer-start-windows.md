---
"openqodex": patch
---

On Windows, `openqodex review` now finds the separate reviewer as `claude.exe`, `claude.cmd` or another PATHEXT name. It starts an npm-installed reviewer by running the Node script its .cmd file wraps, stops a timed-out reviewer and everything it started with taskkill, and passes TEMP and TMP to it. Nobody has run this on a Windows machine yet.
