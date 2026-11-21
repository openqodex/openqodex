---
"openqodex": patch
---

The code graph's MCP tools now send each answer once, so an answer costs an agent half what it did. Since 0.20.0, every answer came twice: as text and again as `structuredContent`. Each answer is now one text block of JSON, the same JSON `openqodex graph --json` prints. The tools no longer declare an output schema, since that schema obliges the second copy. On this repository, a `graph_routes` answer went from 141,416 bytes to 72,973.
