// Checks the pinned scanner table against the real downloads.
// `node scripts/refresh-toolchain.mjs --verify` downloads every GitHub release
// asset in packages/scanners/toolchain.json, hashes it, prints one line per
// asset and exits 1 on any mismatch, missing asset or failed download.
// A version bump: edit the table (version, tag, asset names, URLs, sha256 from
// the upstream checksum file), then run this to prove every hash.
//
// A system asset is not a download. It is a program the host's package
// manager installs, on FreeBSD only, and the host checks it at run time.
// The script prints one line for it and counts it as nothing verified.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationPlan } from "./toolchain-assets.mjs";

if (process.argv[2] !== "--verify" || process.argv.length !== 3) {
  process.stderr.write("usage: node scripts/refresh-toolchain.mjs --verify\n");
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const table = JSON.parse(readFileSync(join(root, "packages", "scanners", "toolchain.json"), "utf8"));
const plan = verificationPlan(table.tools);

async function sha256Of(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

async function check({ tool, platform, asset }) {
  const label = `${tool} ${platform}`;
  if (!asset) return `${label}: FAIL no asset`;
  if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) return `${label}: FAIL no sha256`;
  try {
    const actual = await sha256Of(asset.url);
    return actual === asset.sha256 ? `${label}: OK ${actual}` : `${label}: FAIL expected ${asset.sha256}, got ${actual}`;
  } catch (error) {
    return `${label}: FAIL ${error instanceof Error ? error.message : String(error)}`;
  }
}

const downloads = plan.entries.filter((entry) => entry.kind === "release");
const results = new Map();
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < downloads.length) {
      const index = next;
      next += 1;
      const job = downloads[index];
      results.set(job, await check(job));
    }
  }),
);
for (const entry of plan.entries) {
  if (entry.kind === "system") {
    process.stdout.write(`${entry.line}\n`);
    continue;
  }
  process.stdout.write(`${results.get(entry)}\n`);
}
const failed = downloads.filter((entry) => results.get(entry).includes(": FAIL")).length;
const systemCount = plan.systems.length;
process.stdout.write(`${downloads.length - failed} of ${downloads.length} assets verified\n`);
if (systemCount > 0) process.stdout.write(`${systemCount} system assets are checked at run time on the host\n`);
process.exitCode = failed > 0 ? 1 : 0;
