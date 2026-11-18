---
"openqodex": minor
---

The code graph's MCP tools cost an agent less and answer in a form it can use directly. The tool list is 43% smaller: what every tool shares is said once, in the server's instructions. Every answer also comes as `structuredContent`, with an output schema, and its text is unchanged. `context` (`--context` on the command line) adds up to 10 source lines around each place an answer names, read from the held build, with key-shaped tokens redacted. `compact` (`--compact` with `--json`) drops edge ids and import lines from the items, making a long answer about 40% shorter.
