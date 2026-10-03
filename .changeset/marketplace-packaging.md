---
"openqodex": patch
---

OpenQodex is packaged for three plugin directories: the Claude Code plugin gains a README and an icon, a new Codex plugin in `plugins/codex/` carries the skill for the OpenAI plugin directory, and `.cursor-plugin/plugin.json` makes the repository a Cursor plugin.
A new privacy page, `docs/privacy.md`, says what OpenQodex collects (nothing) and lists every network call it makes. `openqodex guide privacy` prints it.
The skill's description now names the requests it answers: a code review, a security scan, a diff or a pull request.
The npm package, the GitHub Action and the plugins have new descriptions and keywords, and the README opens with a banner.
