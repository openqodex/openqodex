---
"openqodex": patch
---

OpenQodex now runs on FreeBSD 15 or later, on amd64 and on arm64. The scanners that FreeBSD's package manager installs, hs-ShellCheck, ruff, hs-hadolint, gitleaks, osv-scanner and zizmor, are found in the localbase, under `/usr/local/bin` by default, and `OPENQODEX_LOCALBASE` moves that place. A program there must be the pinned version or a newer one in the same series, and one that another user can write to is not run. Each architecture pins the version that architecture's package has, so zizmor is pinned at 1.33.1 on amd64 and at 1.32.0 on arm64. The scanners that come as a download, golangci-lint, actionlint and oxlint, are downloaded as they are elsewhere, and actionlint and oxlint have no FreeBSD build for arm64 yet. The other scanners have no FreeBSD support yet and are reported as not installed, with the reason.
