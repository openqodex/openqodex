---
"openqodex": patch
---

Keep snapshot files of every size in the review. Large files are redacted by streaming, read by indexed line ranges and hashed by content, so their changed lines and evidence remain available.

Send a file that is not UTF-8 text by its bytes, line by line, with long lines in byte fragments. Keep line indexes small for files with many short lines and fast for wide rows. Search reports how many oversized rows it skipped. Display reads only excerpt lines, and an oversized neighbour no longer blocks valid evidence. Name an oversized cited line explicitly, avoid promising pages no round can carry, and preserve file permissions during redaction even with long file names. Paging stops at the last actual line: a final newline no longer adds an empty context row numbered one past the line count.

Accept findings on wide changed lines when their evidence comes from another line. Clip report excerpts at the file's end and keep earlier excerpts when the display budget fills. A tool read stopped by an oversized row names the next line to request.
