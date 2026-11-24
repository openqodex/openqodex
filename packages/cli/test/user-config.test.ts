// The user config, ~/.openqodex/config.yaml, through the real built CLI and
// the real launcher in temp homes: one reader for every key, so a typo is
// named and never silently becomes a default.
//
// Ways it could fail, written before the code:
//  1. A misspelled key (`updat: off`) leaves automatic updates on, exit 0,
//     and no command names the key.
//  2. A misspelled reviewer key (`reviewer-web: off`) silently keeps the
//     default, and no command names it.
//  3. The update switch and the reviewer read a file that is not a list of
//     keys differently: one turns updates off, the other takes the defaults.
//  4. doctor does not say which value is in force for each key and where
//     it came from.
//  5. `update --off` or `--on` on a file of comments only drops the comments.
//  6. A key OpenQodex itself writes (skip_version) is taken for unknown and
//     pauses updates.
//  7. A skip_version the update cannot read as a version (a part too large
//     to count) passes the config check but is dropped when releases are
//     chosen, so updates run with no threshold.
//  8. doctor does not show reviewer_model and reviewer_effort with their
//     source, or shows a value a review would refuse as if it were in force.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

  it("reviewer-web: off is named with reviewer_web, and doctor shows reviewer_web on (default) (failures 2 and 4)", () => {
    const s = installed();
    writeFileSync(config(s), "reviewer-web: off\nreviewer: codex\n");
    const r = launch(s, ["doctor"]);
    expect(r.stdout).toMatch(/^ {2}reviewer_web +on \(default\)$/m);
    expect(r.stdout).toMatch(/^ {2}reviewer +codex \(config\.yaml\)$/m);
    expect(r.stdout).toMatch(/^ {2}update +on \(default\)$/m);
    expect(r.stdout).toMatch(/unknown key reviewer-web in .*config\.yaml \(did you mean reviewer_web\?\)/);
    expect(r.stdout).toMatch(/^ {2}updates +paused: unknown key reviewer-web/m);
  });

  it("doctor shows reviewer_model and reviewer_effort from the file, Codex's own by default, and a value a review stops on (failure 8)", () => {
    const s = installed();
    writeFileSync(config(s), "reviewer_model: gpt-test-model\n");
    const r = launch(s, ["doctor"]);
    expect(r.stdout).toMatch(/^ {2}reviewer_model +gpt-test-model \(config\.yaml\)$/m);
    expect(r.stdout).toMatch(/^ {2}reviewer_effort +Codex's own \(default\)$/m);
    writeFileSync(config(s), "reviewer_effort: extreme\n");
    const bad = launch(s, ["doctor"]);
    expect(bad.stdout).toMatch(/^ {2}reviewer_model +Codex's own \(default\)$/m);
    expect(bad.stdout).toMatch(/^ {2}reviewer_effort +extreme \(config\.yaml: not low, medium, high, xhigh, a review stops\)$/m);
    expect(bad.stdout).not.toMatch(/unknown key reviewer_/);
  });

  it("an environment switch is named as the source of update off (failure 4)", () => {
    const s = installed();
    const r = spawnSync(process.execPath, [BIN, "doctor"], { encoding: "utf8", env: { ...laptop(s), OPENQODEX_AUTO_UPDATE: "0" }, cwd: s.repo });
    expect(r.stdout).toMatch(/^ {2}update +off \(OPENQODEX_AUTO_UPDATE=0\)$/m);
  });

  it("a file that is a list turns updates off and stops a review, both naming the file (failure 3)", () => {
    const s = installed();
    writeFileSync(config(s), "- update\n- off\n");
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/^updates +off: .*config\.yaml is not a list of keys and values/m);
    const review = launch(s, ["review", "--no-install", "--offline"]);
    expect(review.status).toBe(2);
    expect(review.stderr).toMatch(/config\.yaml is not a list of keys and values/);
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
});
