---
"openqodex": patch
---

One defect that two finders title differently is now shown once. Before, it could show twice: as two findings, or as a finding and again as a possible issue. Two findings now merge when neither cites a scanner candidate, both cite the same source or none, and they share the file and the category on overlapping lines. The merged finding keeps the higher severity and the fuller text. Findings on lines that do not overlap, or from different sources, stay apart. A second reviewer's finding joins the first reviewer's finding by this rule only when each is the other's one overlap, so two findings on one broad finding stay apart. The first reviewer's possible issue leaves when the second reviewer counts the same defect as a new finding. The staged review keeps its verifier's ruling: two findings it did not mark as duplicates stay apart.
