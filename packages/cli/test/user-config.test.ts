// The user config, ~/.openqodex/config.yaml, through the real built CLI and
// the real launcher in temp homes: one reader for every key, so a typo is
// named and never silently becomes a default.
//
// Ways it could fail, written before the code:
//  1. A misspelled key (`updat: off`) leaves automatic updates on, exit 0,
//     and no command names the key.
//  2. A misspelled reviewer key (`reviewer-web: off`) silently keeps the
//     default, and no command names it.
//  3. A file that is not a list of keys turns updates off silently, or
//     stops a review, which reads nothing from it.
//  4. doctor does not say which value is in force for each key and where
//     it came from.
//  5. `update --off` or `--on` on a file of comments only drops the comments.
//  6. A key OpenQodex itself writes (skip_version) is taken for unknown and
//     pauses updates.
//  7. A skip_version the update cannot read as a version (a part too large
//     to count) passes the config check but is dropped when releases are
//     chosen, so updates run with no threshold.
//  8. The reviewer keys the file held up to 0.23.0 (reviewer, reviewer_web,
//     reviewer_model, reviewer_effort) pause updates as unknown keys, or
//     doctor shows them as if they were in force instead of naming the
//     project lines that replace them.
//  9. openqodex_telemetry: 0, the usage data switch, is taken for an unknown
//     key and pauses updates, or doctor does not say usage data is off and why.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BIN, cli, env, sandbox, type Sandbox } from "./init-helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function laptop(s: Sandbox): NodeJS.ProcessEnv {
  const e = env(s);
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_LAUNCHER"]) delete e[key];
  return e;
}

function launch(s: Sandbox, args: string[]) {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: laptop(s), cwd: s.repo, timeout: 120_000 });
}

function installed(): Sandbox {
  const s = sandbox();
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}

const config = (s: Sandbox): string => join(s.oqHome, "config.yaml");

describe("one reader for the user config", () => {
  it("updat: off pauses automatic updates, and update --status names the key and the one it is near (failure 1)", () => {
    const s = installed();
    writeFileSync(config(s), "updat: off\n");
    const r = launch(s, ["update", "--status"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^updates +paused: unknown key updat in .*config\.yaml \(did you mean update\?\)/m);
  });

  it("reviewer-web: off is named with reviewer_web, and doctor shows update on (default) (failures 2 and 4)", () => {
    const s = installed();
    writeFileSync(config(s), "reviewer-web: off\n");
    const r = launch(s, ["doctor"]);
    expect(r.stdout).toMatch(/^ {2}update +on \(default\)$/m);
    expect(r.stdout).not.toMatch(/^ {2}reviewer_web /m);
    expect(r.stdout).toMatch(/unknown key reviewer-web in .*config\.yaml \(did you mean reviewer_web\?\)/);
    expect(r.stdout).toMatch(/^ {2}updates +paused: unknown key reviewer-web/m);
  });

  it("doctor names the retired reviewer keys and the project lines that replace them, and updates stay on (failure 8)", () => {
    const s = installed();
    writeFileSync(config(s), "reviewer: codex\nreviewer_model: gpt-test-model\nreviewer_effort: high\nreviewer_web: off\n");
    const r = launch(s, ["doctor"]);
    expect(r.stdout).toMatch(/config\.yaml sets reviewer: codex, reviewer_web: off, reviewer_model: gpt-test-model, reviewer_effort: high\. openqodex no longer reads them there/);
    expect(r.stdout).toContain("    - tool: codex");
    expect(r.stdout).toContain('      model: "gpt-test-model"');
    expect(r.stdout).toContain("Your reviewer_web: off still keeps the reviewer's web tools off for now");
    expect(r.stdout).not.toMatch(/^ {2}reviewer(_model|_effort|_web)? +/m);
    expect(r.stdout).not.toMatch(/unknown key reviewer/);
    expect(r.stdout).toMatch(/^ {2}updates +on$/m);
    // A value no tool takes is named as written, on one line, and carried nowhere.
    writeFileSync(config(s), "reviewer_model: {toString: x}\nreviewer_effort: \"high\\nlow\"\n");
    const odd = launch(s, ["doctor"]);
    expect(odd.status, odd.stderr).not.toBe(2);
    expect(odd.stdout).toMatch(/sets reviewer_model: a mapping, reviewer_effort: high\\u000alow\. openqodex no longer reads them there/);
    expect(odd.stdout).not.toContain("- tool:");
  });

  it("an environment switch is named as the source of update off (failure 4)", () => {
    const s = installed();
    const r = spawnSync(process.execPath, [BIN, "doctor"], { encoding: "utf8", env: { ...laptop(s), OPENQODEX_AUTO_UPDATE: "0" }, cwd: s.repo });
    expect(r.stdout).toMatch(/^ {2}update +off \(OPENQODEX_AUTO_UPDATE=0\)$/m);
  });

  it("a file that is a list turns updates off, and a review says so and goes on, both naming the file (failure 3)", () => {
    const s = installed();
    writeFileSync(config(s), "- update\n- off\n");
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/^updates +off: .*config\.yaml is not a list of keys and values/m);
    const review = launch(s, ["review", "--no-install", "--offline"]);
    expect(review.stderr).toMatch(/config\.yaml is not a list of keys and values; automatic updates are off until it is fixed/);
    // The review went on to look at the change: there is none here.
    expect(review.stderr).toMatch(/^Nothing to review: /m);
    expect(review.status).toBe(0);
  });

  it("update --off and --on keep the comments of a file of comments only (failure 5)", () => {
    const s = installed();
    writeFileSync(config(s), "# why: the laptop is on a metered link\n# ask Sam before turning this on\n");
    expect(launch(s, ["update", "--off"]).status).toBe(0);
    expect(readFileSync(config(s), "utf8")).toBe("# why: the laptop is on a metered link\n# ask Sam before turning this on\n\nupdate: off\n");
    expect(launch(s, ["update", "--on"]).status).toBe(0);
    expect(readFileSync(config(s), "utf8")).toBe("# why: the laptop is on a metered link\n# ask Sam before turning this on\n\nupdate: on\n");
  });

  it("skip_version is a key OpenQodex knows: no warning, and updates stay on (failure 6)", () => {
    const s = installed();
    writeFileSync(config(s), "skip_version: 0.9.3\n");
    const r = launch(s, ["update", "--status"]);
    expect(r.stdout).toMatch(/^updates +on$/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/unknown key/);
  });

  it("a skip_version the update cannot read pauses automatic updates with the value named (failure 7)", () => {
    const s = installed();
    writeFileSync(config(s), "skip_version: 99999999999999999999.0.0\n");
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/^updates +paused: unknown value 99999999999999999999\.0\.0 for skip_version in .*config\.yaml/m);
  });

  it("openqodex_telemetry: 0 is a key OpenQodex knows: updates stay on, doctor says usage data is off and why, and no id is made (failure 9)", () => {
    const s = installed();
    writeFileSync(config(s), "openqodex_telemetry: 0\n");
    // Every other switch out of the way; a dead loopback port, so nothing could reach any host.
    const e = { ...laptop(s), OPENQODEX_TELEMETRY_HOST: "http://127.0.0.1:9" };
    for (const key of ["OPENQODEX_TELEMETRY", "OPENQODEX_TELEMETRY_KEY", "DO_NOT_TRACK", "OPENQODEX_REVIEW_DEPTH", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "TF_BUILD", "TEAMCITY_VERSION", "BUILDKITE", "CODEBUILD_BUILD_ID", "BUILDER_OUTPUT"]) delete e[key];
    const status = spawnSync("sh", [join(s.oqHome, "bin/openqodex"), "update", "--status"], { encoding: "utf8", env: e, cwd: s.repo, timeout: 120_000 });
    expect(status.stdout).toMatch(/^updates +on$/m);
    expect(`${status.stdout}${status.stderr}`).not.toMatch(/unknown key/);
    const doctor = spawnSync("sh", [join(s.oqHome, "bin/openqodex"), "doctor", "--json"], { encoding: "utf8", env: e, cwd: s.repo, timeout: 120_000 });
    expect(JSON.parse(doctor.stdout).telemetry).toEqual({ on: false, why: "openqodex_telemetry in the user config" });
    expect(existsSync(join(s.oqHome, "telemetry"))).toBe(false);
  });
});
