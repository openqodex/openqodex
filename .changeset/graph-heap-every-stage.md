---
"openqodex": patch
---

The code graph's memory bound (`graph.max_heap_mb`) now holds in every stage of a build, not only while files are read. Before, resolving the calls, the framework plugins and the comparison of the export surface with the base ran past it, and a large repository could crash the review with an out-of-memory error. Now a build past the bound stops those stages, returns a partial graph, and says the memory bound stopped it.
