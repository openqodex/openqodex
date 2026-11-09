---
"openqodex": patch
---

Name every unexamined changed range separately in saved reports, including part and deletion fragment labels. Show coverage by file and range in Markdown and HTML, and print coverage counts on every review receipt. The receipt names the first ten unexamined ranges and points to the report for the rest.

Count each original range once in the receipt, name unread deletions, sort deletion fragments by old lines, and include files without changed lines in coverage. Keep coverage failures identifiable in benchmark runs and push messages.

Keep single-pass deletion ids accurate, omit repeated or reversed missing range ends, and label credited parts with their part numbers. Shorten incomplete reasons, second reviewer notes, SARIF notifications and benchmark failure summaries to ten unread entries while the completion record keeps every entry.
