// The release refuses to version or publish a commit whose own CI run on
// main did not pass. Given a commit (default GITHUB_SHA), it finds the CI
// workflow's push run for that commit, waits while the run is queued or
// running, and exits 0 only when it completed with success. It exits 1 when
// no run shows up within the grace period (GitHub can take a moment to
// create it), when the run was cancelled, failed or timed out, and when the
// wait runs past its limit.
// Usage: node scripts/release-ci-check.mjs [sha]   (gh reads GH_TOKEN)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MINUTE = 60_000;

// Runs gh and returns its stdout; the test passes its own in place of it.
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

export async function waitForCi({
  sha,
  gh = runGh,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = (line) => console.log(line),
  pollMs = 30_000,
  graceMs = 3 * MINUTE,
  // Main CI runs took 24 to 50 minutes in November 2026.
  timeoutMs = 90 * MINUTE,
}) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
    log(`not a full commit sha: ${sha}`);
    return 1;
  }
  const start = now();
  for (;;) {
    const runs = JSON.parse(gh(["run", "list", "--workflow", "ci.yml", "--commit", sha, "--event", "push", "--json", "status,conclusion,databaseId,headSha", "--limit", "20"]));
    // gh lists the newest run first; a rerun keeps its run id.
    const run = runs.find((r) => r.headSha === sha);
    const waited = now() - start;
    if (run === undefined) {
      if (waited >= graceMs) {
        log(`no CI run for ${sha} after ${Math.round(waited / 1000)} s; the release stops`);
        return 1;
      }
      log(`no CI run for ${sha} yet; looking again in ${pollMs / 1000} s`);
    } else if (run.status === "completed") {
      if (run.conclusion === "success") {
        log(`CI run ${run.databaseId} for ${sha} passed`);
        return 0;
      }
      log(`CI run ${run.databaseId} for ${sha} ended ${run.conclusion}; the release stops`);
      return 1;
    } else if (waited >= timeoutMs) {
      log(`CI run ${run.databaseId} for ${sha} is still ${run.status} after ${Math.round(waited / MINUTE)} minutes; the release stops`);
      return 1;
    } else {
      log(`CI run ${run.databaseId} for ${sha} is ${run.status}; looking again in ${pollMs / 1000} s`);
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await waitForCi({ sha: process.argv[2] ?? process.env.GITHUB_SHA });
}
