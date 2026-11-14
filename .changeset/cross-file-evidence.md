---
"openqodex": minor
---

A staged review now uses evidence from a second file. The finder that checks interfaces gets, for each declaration the change adds, alters or removes, its callers in other files: the code graph's callers first, then matches by name, at most 8 per declaration, and the brief says how many were cut. The verifier gets the lines a candidate cites in other files, so it can read a caller or a guard there before it confirms or refutes. A finding whose evidence rests on another file keeps those files and lines: `evidence` in `report.json` and in the library's result, and "Evidence in other files" in the report. Findings whose evidence is all in their own file are unchanged.
