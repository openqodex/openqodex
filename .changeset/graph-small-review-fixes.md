---
"openqodex": minor
---

Three small fixes in the code graph. The `--context` source lines in the command line text keep their indentation instead of printing flat. In an Express file, `exports.x = router` written after `module.exports` is replaced is no longer taken as the export, because Node does not export it; the mount becomes an unknown. The outline of the repository root now lists the files that were not read and sets the floor, as an outline of a folder already did.
