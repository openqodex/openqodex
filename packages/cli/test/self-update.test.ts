// The self-update, through the real built CLI and the real launcher in temp
// homes, with no registry: the trigger, the switches, the notice, retention,
// rollback and finalize across versions. A second real runtime is activated
// by the worker's own commit step in a child process. The boundary, crash and
// race cases are in self-update-safety.test.ts; the download and
// verification of real releases in tests/e2e/self-update.test.ts.
//
// Ways it could fail, written before the code:
//  1. A check starts within 24 hours of the last one.
//  2. --offline, OPENQODEX_AUTO_UPDATE=0, CI, `update: off` in the user
//     config, or a user config that does not parse still starts a worker.
//  3. A run not started through the launcher (npx, project scope) starts a worker.
//  4. The update changes the command's exit code.
//  5. The update writes anything on stdout, so --format json breaks.
//  6. The "updated" notice prints twice.
// 11. Old runtimes are deleted while they are the baked-in, current or previous one.
// 12. Rollback leaves the launcher pointing at a missing runtime.
// 13. --rollback does not turn updating off.
// 14. Finalize after an activation runs the new version on an old brief.
// 15. Finalize executes a path taken from the manifest.
// 16. The brief's finalize command names a runner other than the launcher or the pinned npx version.
// 17. A finalize handed to another version hands off again.
// 18. An inherited OPENQODEX_FINALIZE_HANDOFF stops a legitimate handoff.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readState } from "../src/update/state.js";
import { bundleChildEntry } from "./bundle.js";
import { BIN, cli, env, git, sandbox, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const NEWER = "0.99.0";
const NOTICE = /openqodex updated to/;
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The environment of a developer's laptop: no CI, no switch set.
function laptop(s: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = env(s);
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_LAUNCHER"]) delete e[key];
  return { ...e, ...extra };
}

function launch(s: Sandbox, args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: laptop(s, extra), cwd: s.repo, input, timeout: 120_000 });
}

function direct(s: Sandbox, args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: laptop(s, extra), cwd: s.repo, input, timeout: 120_000 });
}

function installed(agents = ["claude-code"]): Sandbox {
  const s = sandbox();
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", ...agents.flatMap((a) => ["--agent", a])]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}

function writeState(s: Sandbox, state: Record<string, unknown>): void {
  writeFileSync(join(s.oqHome, "update.json"), `${JSON.stringify(state)}\n`);
}

// A second real runtime: the installed copy with its version string changed,
// recorded in install.json the way the updater records one.
function copyRuntime(s: Sandbox, to: string, edit?: (dir: string) => void): string {
  const dir = join(s.oqHome, "runtime", to);
  cpSync(join(s.oqHome, "runtime", version), dir, { recursive: true });
  const bin = join(dir, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${to}"`));
  edit?.(dir);
  return dir;
}

function current(s: Sandbox): string {
  return readFileSync(join(s.oqHome, "runtime/current"), "utf8").split("\n")[0]!;
}

function age(path: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}

describe("when a check starts", () => {
  // Each sandbox runs one command through the launcher (or not) with an
  // update due, then the test waits once. A worker writes checkedAt as its
  // first act, so a missing checkedAt after the wait means none started.
  const cases: Record<string, { s?: Sandbox; run: (s: Sandbox) => void; setup?: (s: Sandbox) => void }> = {
    control: { run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    recent: { setup: (s) => writeState(s, { checkedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    offlineFlag: { run: (s) => launch(s, ["scan", "--offline", "--no-install"]) },
    offlineEnv: { run: (s) => launch(s, ["hook", "check"], { OPENQODEX_OFFLINE: "1" }, "{}") },
    envSwitch: { run: (s) => launch(s, ["hook", "check"], { OPENQODEX_AUTO_UPDATE: "0" }, "{}") },
    ci: { run: (s) => launch(s, ["hook", "check"], { CI: "true" }, "{}") },
    configOff: { setup: (s) => writeFileSync(join(s.oqHome, "config.yaml"), "update: off\n"), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    configBroken: { setup: (s) => writeFileSync(join(s.oqHome, "config.yaml"), "update: [on\n"), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    npx: { run: (s) => direct(s, ["hook", "check"], {}, "{}") },
  };
  const checkedAt = (s: Sandbox): unknown => readState(s.oqHome).checkedAt;
  let before: Record<string, unknown> = {};

  beforeAll(async () => {
    for (const c of Object.values(cases)) {
      c.s = installed();
      c.setup?.(c.s);
    }
    before = Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, checkedAt(c.s!)]));
    for (const c of Object.values(cases)) c.run(c.s!);
    // A worker that started has written checkedAt by now.
    for (let i = 0; i < 50 && checkedAt(cases.control.s!) === null; i++) await sleep(100);
    await sleep(1500);
  }, 120_000);

  it("a launcher run with a check due starts a worker (the control for the cases below)", () => {
    expect(checkedAt(cases.control.s!)).not.toBeNull();
  });
  it("a check does not start within 24 hours of the last (failure 1)", () => {
    expect(checkedAt(cases.recent.s!)).toBe(before.recent);
  });
  it("--offline starts no worker (failure 2)", () => expect(checkedAt(cases.offlineFlag.s!)).toBeNull());
  it("OPENQODEX_OFFLINE=1 starts no worker (failure 2)", () => expect(checkedAt(cases.offlineEnv.s!)).toBeNull());
  it("OPENQODEX_AUTO_UPDATE=0 starts no worker (failure 2)", () => expect(checkedAt(cases.envSwitch.s!)).toBeNull());
  it("CI starts no worker (failure 2)", () => expect(checkedAt(cases.ci.s!)).toBeNull());
  it("update: off in the user config starts no worker (failure 2)", () => expect(checkedAt(cases.configOff.s!)).toBeNull());
  it("a user config that does not parse starts no worker (failure 2)", () => expect(checkedAt(cases.configBroken.s!)).toBeNull());
  it("a run not started through the launcher starts no worker (failure 3)", () => expect(checkedAt(cases.npx.s!)).toBeNull());
});

describe("what the command prints and returns", () => {
  let s: Sandbox;
  beforeAll(() => {
    s = installed();
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
  });

  it("the exit code is the same with an update due and with updates off (failure 4)", () => {
    const due = launch(s, ["scan", "--format", "json", "--no-install"]);
    const off = launch(s, ["scan", "--format", "json", "--no-install"], { OPENQODEX_AUTO_UPDATE: "0" });
    expect(due.status).toBe(off.status);
  });

  it("the notice goes to stderr, once, and stdout stays one JSON document (failures 5 and 6)", async () => {
    await activateCopy(s, NEWER, version);
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
    const first = launch(s, ["scan", "--format", "json", "--no-install"], { OPENQODEX_AUTO_UPDATE: "0" });
    const second = launch(s, ["scan", "--format", "json", "--no-install"], { OPENQODEX_AUTO_UPDATE: "0" });
    expect(() => JSON.parse(first.stdout)).not.toThrow();
    expect(first.stdout).not.toMatch(NOTICE);
    expect(first.stderr).toContain(`openqodex updated to ${NEWER} (was ${version}). Roll back: openqodex update --rollback`);
    expect(second.stderr).not.toMatch(NOTICE);
  });
});

// A worker's last step for a second real runtime, in a child process that
// imports this repo's worker module (bundle.ts): the copy is unpacked where
// the worker unpacks, then activated through the commit boundary.
async function activateCopy(s: Sandbox, to: string, from: string): Promise<void> {
  const tmp = join(s.oqHome, "runtime", `${to}.tmp-test`);
  const pkg = join(tmp, "unpacked", "package");
  cpSync(join(s.oqHome, "runtime", version), pkg, { recursive: true });
  const bin = join(pkg, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${to}"`));
  const code = `const m = await import(${JSON.stringify(child)}); const r = await m.activateUnpacked({ home: process.env.H, version: ${JSON.stringify(to)}, from: ${JSON.stringify(from)}, tmp: ${JSON.stringify(tmp)}, env: process.env, wait: 0 }); process.stdout.write(JSON.stringify(r));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...laptop(s), H: s.oqHome }, encoding: "utf8" });
  expect(r.stdout, r.stderr).toMatch(/"outcome":"activated"/);
}

let child = "";
beforeAll(async () => {
  child = await bundleChildEntry();
}, 60_000);

describe("runtimes kept by init", () => {
  let s: Sandbox;
  const rt = (v: string) => join(s.oqHome, "runtime", v);
  beforeAll(async () => {
    s = installed();
    for (const v of ["0.0.5", "0.0.6", "0.0.8"]) copyRuntime(s, v);
    // 0.0.7 is not an openqodex runtime: not ours to remove.
    mkdirSync(rt("0.0.7"));
    writeFileSync(join(rt("0.0.7"), "package.json"), JSON.stringify({ name: "something-else" }));
    writeFileSync(join(s.oqHome, "runtime/current"), `${NEWER}\n0.0.8\n`);
    copyRuntime(s, NEWER);
    for (const v of [version, "0.0.5", "0.0.7", "0.0.8", NEWER]) age(rt(v), 8);
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
  }, 120_000);

  it("keeps the baked-in runtime even when it is old (failure 11)", () => expect(existsSync(rt(version))).toBe(true));
  it("keeps the runtime that was current before init, as previous, even when it is old (failure 11)", () => expect(existsSync(rt(NEWER))).toBe(true));
  it("keeps a runtime younger than 7 days", () => expect(existsSync(rt("0.0.6"))).toBe(true));
  it("removes an openqodex runtime older than 7 days that no rule keeps", () => {
    expect(existsSync(rt("0.0.5"))).toBe(false);
    expect(existsSync(rt("0.0.8"))).toBe(false);
  });
  it("leaves a runtime folder that is not openqodex", () => expect(existsSync(rt("0.0.7"))).toBe(true));
  it("init points the record at its own version with the earlier one as previous", () => {
    expect(readFileSync(join(s.oqHome, "runtime/current"), "utf8")).toBe(`${version}\n${NEWER}\n`);
  });
});

describe("rollback", () => {
  it("points back at the previous runtime and turns updating off (failures 12 and 13)", async () => {
    const s = installed();
    await activateCopy(s, NEWER, version);
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status, r.stderr).toBe(0);
    expect(current(s)).toBe(version);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/off/);
  }, 120_000);

  it("refuses when the previous runtime is gone and leaves the record alone (failure 12)", () => {
    const s = installed();
    writeFileSync(join(s.oqHome, "runtime/current"), `${version}\n0.0.9\n`);
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/0\.0\.9/);
    expect(current(s)).toBe(version);
  });

  it("update --off and --on write the user config; --on refuses a config that does not parse", () => {
    const s = installed();
    expect(launch(s, ["update", "--off"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
    expect(launch(s, ["update", "--on"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: on$/m);
    writeFileSync(join(s.oqHome, "config.yaml"), "update: [on\n");
    expect(launch(s, ["update", "--on"]).status).toBe(2);
  });

  it("update refuses to run when not started through the launcher", () => {
    const s = installed();
    const r = direct(s, ["update"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/npx openqodex init/);
  });
});

describe("finalize across versions", () => {
  let s: Sandbox;
  let brief = "";
  const findings = (): string => {
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string };
    return join(s.repo, latest.dir, "agent-findings.json");
  };
  const manifestPath = (): string => join(findings(), "..", "manifest.json");
  const submit = (): void => {
    const dir = join(findings(), "..");
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { change_id?: string; candidates: { id: string }[] };
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as { change_id: string };
    writeFileSync(
      findings(),
      JSON.stringify({
        version: 1,
        change_id: manifest.change_id,
        summary: "Looked at the change",
        reviewer: "subagent",
        findings: [],
        dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })),
      }),
    );
  };

  beforeAll(async () => {
    s = installed();
    writeState(s, { checkedAt: new Date().toISOString() });
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
    git(s.repo, "add", "app.py");
    const r = launch(s, ["review", "--agent", "--no-install"]);
    expect(r.status, r.stderr).toBe(0);
    brief = r.stdout;
    submit();
    await activateCopy(s, NEWER, version);
  }, 180_000);

  it("the brief names the launcher, as the skill and the permission rule write it, not npx (failure 16)", () => {
    // The sandbox path has a space, so the launcher is quoted.
    expect(brief).toContain(`'${join(s.oqHome, "bin", "openqodex")}' review --finalize`);
    expect(brief).not.toMatch(/npx -y openqodex@\S+ review --finalize/);
    expect(JSON.parse(readFileSync(manifestPath(), "utf8"))).toMatchObject({ version: 3, runtime_version: version });
  });

  it("the new runtime does not finalize a brief from another version when that runtime folder is gone (failure 14)", () => {
    const dir = join(s.oqHome, "runtime", version);
    renameSync(dir, `${dir}.aside`);
    const r = launch(s, ["review", "--finalize"]);
    renameSync(`${dir}.aside`, dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`written by openqodex ${version.replaceAll(".", "\\.")}.*review --agent`));
    expect(existsSync(join(findings(), "..", "report.json"))).toBe(false);
  });

  it("a runtime reached by a handoff, marked by the hidden argument, does not hand off again (failure 17)", () => {
    const r = launch(s, ["review", "--finalize", "--handed-off"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/handed/);
    expect(existsSync(join(findings(), "..", "report.json"))).toBe(false);
  });

  it("finalize after an activation runs the version that wrote the brief, even with an inherited handoff variable (failures 14 and 18)", () => {
    const r = launch(s, ["review", "--finalize"], { OPENQODEX_FINALIZE_HANDOFF: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(findings(), "..", "report.json"))).toBe(true);
  });

  it("finalize never executes a path from the manifest (failure 15)", () => {
    const marker = join(s.root, "ran");
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as Record<string, unknown>;
    for (const bad of [`1.0.0; touch ${marker}`, "../../../../tmp/x", "0.0.1/../0.0.2"]) {
      writeFileSync(manifestPath(), JSON.stringify({ ...manifest, runtime_version: bad }));
      const r = launch(s, ["review", "--finalize"]);
      expect(r.status, bad).toBe(2);
      expect(existsSync(marker)).toBe(false);
    }
    writeFileSync(manifestPath(), JSON.stringify(manifest));
  });

  it("a run not started through the launcher writes today's npx finalize command (failure 16)", () => {
    const r = direct(s, ["review", "--agent", "--no-install"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`npx -y openqodex@${version} review --finalize`);
  });
});
