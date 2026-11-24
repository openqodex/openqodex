---
"openqodex": patch
---

The benchmark can run a release on the published npm package with `--package npm:<release>`. Before the package's code runs, the run checks its record and asks the npm registry for that version's integrity again. A cached unpacked package is unpacked again when any file or its `record.json` differs from the tarball. The benchmark guide in `docs/benchmark.md` describes both.
