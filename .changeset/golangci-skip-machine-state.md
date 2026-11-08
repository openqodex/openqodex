---
"openqodex": patch
---

golangci no longer fails when a module's dependencies are listed in `go.sum` but are not in the Go module cache. It skips the packages that need them, checks the other packages, and names the fix, `go mod download`. A changed `.go` file with no `go.mod` above it is also a skip, not a failure. A changed file that does not compile is still a failure. A problem report for a golangci failure now names each reason.
