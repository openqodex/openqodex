---
"openqodex": patch
---

golangci no longer fails when a module's dependencies are not in the Go module cache. It skips that module and names the fix, `go mod download`. A changed `.go` file with no `go.mod` above it is also a skip, not a failure. A problem report for a golangci failure now names each reason.
