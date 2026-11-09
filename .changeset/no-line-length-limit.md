---
"openqodex": patch
---

Carry changed lines of any length in labelled UTF-8 byte fragments across bounded briefs and pages. Credit a line only after every fragment reaches the reviewer, and name missing bytes when delivery is incomplete.

The visible label changes from "part 1 of 2" to the byte form, such as "a.js: line 7, bytes 1 to 2,000 of 6,000".

A reviewer's Read of a cut line no longer counts as reading the whole line; only the bytes it returned count.

Files that are not UTF-8 text are reviewed by bytes, and a Read credits none of their long lines.
