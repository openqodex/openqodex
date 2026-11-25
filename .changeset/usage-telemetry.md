---
"openqodex": minor
---

OpenQodex now sends anonymous usage data: the version, your operating system, the agent and model that reviewed, timings, scanner names, finding counts and token counts. It never sends code, paths, repository names or finding text. To turn it off, add `openqodex_telemetry: 0` to `.openqodex/config.yaml`, or set `OPENQODEX_TELEMETRY=0` or `DO_NOT_TRACK=1`. It is always off in CI and with `--offline`. `openqodex guide telemetry` lists every field.
