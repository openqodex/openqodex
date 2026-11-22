---
"openqodex": patch
---

On native Windows, `openqodex review` can now find Claude Code as the separate reviewer, as `claude.exe`, `claude.cmd` or another PATHEXT name, and passes over a `.cmd` file it cannot start. It starts an npm-installed Claude Code by running the Node script its `.cmd` file wraps. It stops a timed-out reviewer and what it started with taskkill, and says on stderr when taskkill fails. Known gaps: programs a reviewer started and left running after it exited are not stopped, and Codex is not offered as the reviewer on native Windows, since OpenQodex cannot check its read boundary there. Nobody has run any of this on a Windows machine yet.
