// Failure list, written before implementation:
// 1. A release run is refused at its argument check because it names the published npm package, although the docs
//    and the converter's release gate say a release run reviews that package. It must reach the later gates.
// 2. The argument check is loosened too far: a packed file or a smoke run is admitted under --release.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";

const AT_ARGS = "--release requires a comparison's local build";
const run = (...extra) => {
  const r = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--release", "compare-2026-10", "--suite", "martian", "--split", "test", "--purpose", "diagnostic", "--reviewers", "claude", "--graph", "on", "--web", "off", "--repeat", "3", "--max-usd", "1", "--max-minutes", "60", "--dry-run", ...extra], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

it("a release run with --package npm:<version> passes the argument check, and a file or smoke package does not", () => {
  expect(run("--package", "npm:0.23.0"), "npm:<version> was refused at the argument check").not.toContain(AT_ARGS);
  expect(run("--package", "file:/nowhere/openqodex-0.23.0.tgz"), "a packed file was admitted under --release").toContain(AT_ARGS);
  expect(run("--package", "npm:0.23.0", "--smoke"), "a smoke run was admitted under --release").toContain("--smoke runs development cases only");
});
