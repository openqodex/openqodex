---
"openqodex": minor
---

A graph question on an unchanged work tree is about five times faster. When `.openqodex/graph/` already holds a complete build of the same files with its index, `openqodex graph <question>` and the MCP tools load that index instead of resolving the whole graph again from cached facts, and give the same answer byte for byte. A complete build now keeps its index under the five-second line too, so the next question finds it. An index that is cut short, changed or removed is never used: the question builds from facts as before. A review and `graph build --full` still always build. Separately, a git call that is given input no longer crashes the process when git exits before reading all of it: it fails like any other git call.
