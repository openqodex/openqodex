// The full gate's check before the unit tests: the scanners some unit tests
// run for real (gitleaks, for the secret cases) are installed in the
// end-to-end home those tests read, so on the full gate those cases run and
// never skip. Installs every scanner into that home first (the built CLI's
// doctor --install --all-scanners; a warm cache makes it quick), then fails
// when a required one is not ready.
//
// The home: OPENQODEX_E2E_HOME, or <os tmpdir>/openqodex-e2e-home, the
// folder the end-to-end tests and the unit tests' secret cases both read.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheFolder } from "../tests/temp-dirs.mjs";

const REQUIRED = ["gitleaks"];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.OPENQODEX_E2E_HOME ?? cacheFolder("openqodex-e2e-home");

const r = spawnSync(process.execPath, [join(root, "packages/cli/dist/bin.js"), "doctor", "--install", "--all-scanners", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0" },
});
if (r.status !== 0) {
  console.error(`require-scanners: doctor --install exited ${r.status ?? r.signal} for ${home}`);
  process.exit(1);
}
let scanners;
try {
  scanners = JSON.parse(r.stdout).scanners;
} catch {
  console.error("require-scanners: doctor --json printed no report");
  process.exit(1);
}
const problems = REQUIRED.flatMap((name) => {
  const status = scanners.find((s) => s.scanner === name);
  if (status?.state !== "ready") return [`${name} is ${status?.state ?? "not listed"}${status?.detail ? ` (${status.detail})` : ""}`];
  if (!existsSync(join(home, "tools", name))) return [`${name} is not in ${join(home, "tools")}`];
  return [];
});
if (problems.length > 0) {
  for (const p of problems) console.error(`require-scanners: ${p}`);
  process.exit(1);
}
console.log(`require-scanners: ${REQUIRED.join(", ")} ready in ${home}`);
