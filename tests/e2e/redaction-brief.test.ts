// Failure case: staged briefs leave the reviewer to mistake a masked value for a placeholder.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import "./global-setup.js";
import { baseline, git, report, reportDir, run, stagedProviderEnv } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

it("the staged briefs leave the reviewer to guess what [redacted] is", () => {
  const dir = baseline();
  // Synthetic value with a key name that gitleaks's generic-api-key rule matches.
  const value = "a1396f4c62e8d03b7f529a16cd48b0e569fa207d3c8e61b45a90df732b6c148e";
  const file = join(dir, "digest.json");
  writeFileSync(file, JSON.stringify({ api_key: value, version: 1 }) + "\n");
  git(dir, "add", "digest.json");
  git(dir, "commit", "-qm", "Add baseline digest");
  writeFileSync(file, JSON.stringify({ api_key: value, version: 2 }) + "\n");
  const env = stagedProviderEnv();
  const result = run("redaction-brief", dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--no-color"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(report(dir).completion!.status).toBe("complete");
  const snapshot = join(env.PATH!.split(delimiter)[0]!, "snapshot", "digest.json");
  expect(readFileSync(snapshot, "utf8")).toBe('{"api_key":"[redacted]","version":2}\n');
  const briefs = join(reportDir(dir), "briefs");
  const names = readdirSync(briefs);
  expect(names.some((name) => name.startsWith("finder-"))).toBe(true);
  expect(names.some((name) => name.startsWith("verifier-"))).toBe(true);
  for (const name of names) {
    const text = readFileSync(join(briefs, name), "utf8");
    expect(text).toContain("The current folder holds a frozen copy of the code under review, with the change applied. Read it only through the tools you were given; it is the only place you can read, and you never run the repository's code.");
    expect(text).toContain("OpenQodex replaced every value the secret scanner matched with `[redacted]`, in this copy and in the diff. Treat `[redacted]` as a real value you cannot see, never as a placeholder or a missing value; raise no finding about the masking itself.");
    if (name.startsWith("verifier-")) {
      expect(text).toContain("A claim that a value is a placeholder, missing or redacted, where the copy reads `[redacted]`, is refuted.");
    }
  }
});
