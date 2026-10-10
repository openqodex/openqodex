---
"openqodex": minor
---

- `preinstallScanners({ installRoot, require })` in the library installs the scanners a server image needs into a folder you name, then checks each one: installed at its pinned version, with its runtime, and reporting the finding of a tiny check input through the real tool. It returns one line per scanner that is not ready.
- `openqodex doctor --install --all-scanners --require-all` does the same check after its install, prints one line per missing scanner and exits 2 when any is missing.
- `createToolResolver` takes an `installRoot`, the folder the pinned scanners are read from, and `runScanners` takes a `scratchRoot`: a server run then writes only inside that folder, scanners included, and two runs at once share nothing. Without them, everything works as before.
