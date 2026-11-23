---
"openqodex": patch
---

golangci-lint now reads as failed when one Go module of the change cannot type-check, even when another module gave findings. Before, those findings made the report list golangci as ran, so the developer was never told that a changed package went unchecked. The findings still show. A timeout or the module cap stays a note on a scanner that ran.
