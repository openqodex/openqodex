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
// 13. --rollback turns updating off, so the release after the bad one never
//     comes; or it leaves the rolled-back release eligible again. (Reverses
//     the plan's R9, 2026-10-07: rollback skips the version, updates stay on.)
// 21. A rollback to a runtime that cannot read skip_version leaves updates
//     on, and that runtime installs the release just rolled back from
//     (tests/e2e/self-update.test.ts, with the real 0.7.1).
// 22. A background switch leaves old runtimes behind for good: only init and
//     a foreground update pruned them. (Reverses the plan's R7, 2026-10-07.)
// 23. A worker whose own version is no longer the active one (a rollback ran
//     after the command that started it) selects or activates with its own
//     contract against another version's record.
// 24. skip_version written while a release downloads does not stop that
//     release from being activated.
// 25. A release of another contract than the worker keeps is activated
//     when the gate was passed before the boundary.
// 26. A release's code runs (its --version) before its own package.json is
//     compared with the contract the registry claimed.
// 14. Finalize after an activation runs the new version on an old brief.
// 15. Finalize executes a path taken from the manifest.
// 16. The brief's finalize command names a runner other than the launcher,
//     the pinned npx version for an installed package, or the node and entry
//     file of a local build (whose brief the published version may not read).
// 17. A finalize handed to another version hands off again.
// 18. An inherited OPENQODEX_FINALIZE_HANDOFF stops a legitimate handoff.
// 19. finalize --run hands the older runtime both --run and a findings path.
// 20. A release whose own package.json declares another contract than the
//     registry said is activated: the gate would rest on unsigned metadata.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readState, updatesAllowed } from "../src/update/state.js";
import { bundleChildEntry } from "./bundle.js";
import { BIN, cli, env, git, sandbox, type Sandbox } from "./init-helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const NEWER = "0.99.0";
const NOTICE = /openqodex updated to/;
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// How long an activation here waits for its home's lock. The lock is a port
// hashed from the home folder (agents/lock.ts), so the home of another test,
// in this file or one running beside it, can land on the same port and hold
// it for a moment; with no wait the activation then reports busy (#326).
// An init on a loaded machine holds it for seconds, so this waits as long as
// init and a foreground update do. No case here expects busy. The daily
// worker itself still waits 0.
const LOCK_WAIT = 60_000;
// The contract this build declares, as the registry would report it.
const CONTRACT = (() => {
  const p = JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { openqodex: { agentContract: number; configFormat: number } };
  return { agent: p.openqodex.agentContract, config: p.openqodex.configFormat };
})();

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
  // The switches read from the environment and the user config are one
  // decision (updatesAllowed), tested in-process below; `update: off` stays
  // here as the run that proves the launcher's check goes through it.
  const cases: Record<string, { s?: Sandbox; run: (s: Sandbox) => void; setup?: (s: Sandbox) => void }> = {
    control: { run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    recent: { setup: (s) => writeState(s, { checkedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    offlineFlag: { run: (s) => launch(s, ["scan", "--offline", "--no-install"]) },
    configOff: { setup: (s) => writeFileSync(join(s.oqHome, "config.yaml"), "update: off\n"), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
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
  it("update: off in the user config starts no worker (failure 2)", () => expect(checkedAt(cases.configOff.s!)).toBeNull());
  it("a run not started through the launcher starts no worker (failure 3)", () => expect(checkedAt(cases.npx.s!)).toBeNull());
});

describe("which switches allow a check (failure 2)", () => {
  // The decision every launcher run consults before it starts a worker. The
  // launcher run with `update: off` above proves the run goes through it.
  const table: [string, NodeJS.ProcessEnv, string | null, boolean][] = [
    ["no switch set", {}, null, true],
    ["OPENQODEX_OFFLINE=1", { OPENQODEX_OFFLINE: "1" }, null, false],
    ["OPENQODEX_AUTO_UPDATE=0", { OPENQODEX_AUTO_UPDATE: "0" }, null, false],
    ["CI", { CI: "true" }, null, false],
    ["update: off in the user config", {}, "update: off\n", false],
    ["update: on in the user config", {}, "update: on\n", true],
    ["a user config that does not parse", {}, "update: [on\n", false],
  ];
  it.each(table)("%s", (_name, environment, config, allowed) => {
    const home = tempDir("oq-allowed-");
    if (config !== null) writeFileSync(join(home, "config.yaml"), config);
    expect(updatesAllowed(home, environment).allowed).toBe(allowed);
  });
});

describe("what the command prints and returns", () => {
  it("with an update due the exit code is 0 and stdout one JSON document; the notice goes to stderr, once (failures 4, 5 and 6)", async () => {
    const own = installed();
    await activateCopy(own, NEWER, version);
    writeFileSync(join(own.repo, "app.py"), "print('hello')\n");
    // An update is due: this run starts a worker after it, and prints the notice.
    const first = launch(own, ["scan", "--format", "json", "--no-install"]);
    const second = launch(own, ["scan", "--format", "json", "--no-install"], { OPENQODEX_AUTO_UPDATE: "0" });
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(() => JSON.parse(first.stdout)).not.toThrow();
    expect(first.stdout).not.toMatch(NOTICE);
    expect(first.stderr).toContain(`openqodex updated to ${NEWER} (was ${version}). Roll back: openqodex update --rollback`);
    expect(second.stderr).not.toMatch(NOTICE);
  }, 120_000);
});

// A worker's last step for a second real runtime, in a child process that
// imports this repo's worker module (bundle.ts): the copy is unpacked where
// the worker unpacks, then activated through the commit boundary, as a
// worker of version `running` (default `from`) that keeps contract `keep`.
// `said`: the contract the registry would have said the release declares.
type Activation = { said?: unknown; outcome?: string; running?: string; keep?: unknown };
async function activateCopy(s: Sandbox, to: string, from: string, o: Activation = {}): Promise<string> {
  const tmp = join(s.oqHome, "runtime", `${to}.tmp-test`);
  const pkg = join(tmp, "unpacked", "package");
  cpSync(join(s.oqHome, "runtime", version), pkg, { recursive: true });
  const bin = join(pkg, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${to}"`));
  const opts = { version: to, from, tmp, wait: LOCK_WAIT, contract: o.said ?? CONTRACT, running: o.running ?? from, ...(o.keep === undefined ? {} : { keep: o.keep }) };
  const code = `const m = await import(${JSON.stringify(child)}); const r = await m.activateUnpacked({ ...${JSON.stringify(opts)}, home: process.env.H, env: process.env }); process.stdout.write(JSON.stringify(r));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...laptop(s), H: s.oqHome }, encoding: "utf8" });
  expect(r.stdout, r.stderr).toMatch(new RegExp(`"outcome":"${o.outcome ?? "activated"}"`));
  return r.stdout;
}

let child = "";
beforeAll(async () => {
  child = await bundleChildEntry();
}, 60_000);

describe("an activation beside another holder of its home's port", () => {
  it("waits while another process holds the port for a moment, then activates (#326)", async () => {
    const s = installed();
    // A listener on this home's port for one second: what the lock of another
    // test's home that lands on the same port looks like from here.
    const code = `const m = await import(${JSON.stringify(child)}); const { createServer } = await import("node:net"); const server = createServer((c) => c.destroy()); server.listen({ host: "127.0.0.1", port: m.boundaryPort(process.env.H), exclusive: true }, () => { process.stdout.write("held\\n"); setTimeout(() => server.close(), 1000); });`;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...laptop(s), H: s.oqHome }, stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<void>((r) => holder.once("exit", () => r()));
    const held = await new Promise<boolean>((r) => {
      holder.stdout.on("data", (d: Buffer) => d.toString().includes("held") && r(true));
      void exited.then(() => r(false));
    });
    expect(held, "the helper took the port").toBe(true);
    await activateCopy(s, NEWER, version);
    expect(current(s)).toBe(NEWER);
    await exited;
  }, 120_000);
});

describe("runtimes kept by a background switch and by init", () => {
  let s: Sandbox;
  const rt = (v: string) => join(s.oqHome, "runtime", v);
  // Which runtime folders were there right after the switch, before init ran.
  let afterSwitch: Record<string, boolean> = {};
  beforeAll(async () => {
    s = installed();
    // The switch first: it removes openqodex runtimes older than 7 days
    // except the baked-in, current and previous ones.
    for (const v of ["0.0.5", "0.0.6", "0.0.8"]) copyRuntime(s, v);
    for (const v of [version, "0.0.5", "0.0.8"]) age(rt(v), 8);
    await activateCopy(s, NEWER, version);
    afterSwitch = Object.fromEntries([version, NEWER, "0.0.5", "0.0.6", "0.0.8"].map((v) => [v, existsSync(rt(v))]));
    expect(current(s)).toBe(NEWER);
    // Then init, with old runtimes laid out again.
    for (const v of ["0.0.5", "0.0.8"]) copyRuntime(s, v);
    // 0.0.7 is not an openqodex runtime: not ours to remove.
    mkdirSync(rt("0.0.7"));
    writeFileSync(join(rt("0.0.7"), "package.json"), JSON.stringify({ name: "something-else" }));
    writeFileSync(join(s.oqHome, "runtime/current"), `${NEWER}\n0.0.8\n`);
    for (const v of [version, "0.0.5", "0.0.7", "0.0.8", NEWER]) age(rt(v), 8);
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
  }, 120_000);

  it("the switch removes openqodex runtimes older than 7 days except the baked-in, current and previous ones (failure 22)", () => {
    expect(afterSwitch).toEqual({ [version]: true, [NEWER]: true, "0.0.6": true, "0.0.5": false, "0.0.8": false });
  });
  it("init keeps the baked-in runtime even when it is old (failure 11)", () => expect(existsSync(rt(version))).toBe(true));
  it("init keeps the runtime that was current before init, as previous, even when it is old (failure 11)", () => expect(existsSync(rt(NEWER))).toBe(true));
  it("init removes an openqodex runtime older than 7 days that no rule keeps", () => {
    expect(existsSync(rt("0.0.5"))).toBe(false);
    expect(existsSync(rt("0.0.8"))).toBe(false);
  });
  it("init leaves a runtime folder that is not openqodex", () => expect(existsSync(rt("0.0.7"))).toBe(true));
});

// One installed home for the boundary's refusals below. Each case leaves it
// as it found it: the launcher on this version, no other runtime, no config.
let refusals: Sandbox | null = null;
function refusalHome(): Sandbox {
  refusals ??= installed();
  expect(current(refusals)).toBe(version);
  expect(existsSync(join(refusals.oqHome, "runtime", NEWER))).toBe(false);
  expect(existsSync(join(refusals.oqHome, "config.yaml"))).toBe(false);
  return refusals;
}

describe("the contract a release declares", () => {
  it("a release whose own package.json declares another contract than the registry said is skipped, and the launcher stays (failure 20)", async () => {
    const s = refusalHome();
    await activateCopy(s, NEWER, version, { said: { agent: CONTRACT.agent + 1, config: CONTRACT.config }, outcome: "skip" });
    expect(current(s)).toBe(version);
    expect(existsSync(join(s.oqHome, "runtime", NEWER))).toBe(false);
  }, 120_000);
});

describe("a worker that outlives the version that started it", () => {
  it("exits without writing when its own version is not the active one (failure 23)", () => {
    const s = installed();
    copyRuntime(s, NEWER);
    // A rollback, or another switch, ran after the command that started this worker.
    writeFileSync(join(s.oqHome, "runtime/current"), `${NEWER}\n${version}\n`);
    const r = direct(s, ["__update"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(s.oqHome, "update.json"))).toBe(false);
  });

  it("is refused at the boundary when its own version is not the active one (failure 23)", async () => {
    const s = refusalHome();
    const out = await activateCopy(s, NEWER, version, { running: "0.98.0", outcome: "refused" });
    expect(out).toMatch(/0\.98\.0/);
    expect(current(s)).toBe(version);
  }, 120_000);

  it("is refused at the boundary when skip_version was written while it downloaded (failure 24)", async () => {
    const s = refusalHome();
    writeFileSync(join(s.oqHome, "config.yaml"), `skip_version: ${NEWER}\n`);
    try {
      const out = await activateCopy(s, NEWER, version, { outcome: "refused" });
      expect(out).toMatch(/skip_version/);
      expect(current(s)).toBe(version);
      expect(existsSync(join(s.oqHome, "runtime", NEWER))).toBe(false);
    } finally {
      rmSync(join(s.oqHome, "config.yaml"), { force: true });
    }
  }, 120_000);

  it("is refused at the boundary when the release changes the contract it keeps (failure 25)", async () => {
    const s = refusalHome();
    await activateCopy(s, NEWER, version, { keep: { agent: CONTRACT.agent + 1, config: CONTRACT.config }, outcome: "refused" });
    expect(current(s)).toBe(version);
  }, 120_000);
});

describe("a release's own package.json", () => {
  it("is compared with the contract the registry claimed before any of its code runs (failure 26)", () => {
    // The shared home: the unpack refuses before it writes, so the home is
    // left as it was found.
    const s = commandHome();
    // The real package, as a tarball, declaring another contract than the
    // registry claims and printing another version than it is unpacked as:
    // whichever check comes first names itself.
    const dir = join(s.root, "tarball");
    cpSync(join(s.oqHome, "runtime", version), join(dir, "package"), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8")) as Record<string, unknown>;
    pkg.openqodex = { agentContract: CONTRACT.agent + 1, configFormat: CONTRACT.config };
    writeFileSync(join(dir, "package/package.json"), JSON.stringify(pkg));
    expect(spawnSync("tar", ["-czf", join(s.root, "release.tgz"), "-C", dir, "package"]).status).toBe(0);
    const code = `const m = await import(${JSON.stringify(child)}); try { await m.unpackRelease(process.env.H, "0.99.0", (await import("node:fs")).readFileSync(process.env.T), ${JSON.stringify(CONTRACT)}); process.stdout.write("unpacked"); } catch (e) { process.stdout.write(String(e.message)); }`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...laptop(s), H: s.oqHome, T: join(s.root, "release.tgz") }, encoding: "utf8" });
    expect(r.stdout, r.stderr).toContain(
      `declares contract agent ${CONTRACT.agent + 1}, config ${CONTRACT.config}, the registry agent ${CONTRACT.agent}, config ${CONTRACT.config}`,
    );
    expect(r.stdout).not.toMatch(/--version/);
    expect(existsSync(join(s.oqHome, "runtime", "0.99.0"))).toBe(false);
  });
});

// One installed home for the update command's refusals and switches below.
// Each case leaves it as it found it: this version active, no user config.
let updateHome: Sandbox | null = null;
function commandHome(): Sandbox {
  updateHome ??= installed();
  expect(readFileSync(join(updateHome.oqHome, "runtime/current"), "utf8").split("\n")[0]).toBe(version);
  expect(existsSync(join(updateHome.oqHome, "config.yaml"))).toBe(false);
  return updateHome;
}

describe("rollback", () => {
  it("points back at the previous runtime, keeps updates on and skips the release it left (failures 12 and 13)", async () => {
    const s = installed();
    await activateCopy(s, NEWER, version);
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${NEWER} and every older release`);
    expect(current(s)).toBe(version);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
    const config = readFileSync(join(s.oqHome, "config.yaml"), "utf8");
    expect(config).toMatch(new RegExp(`^skip_version: ${NEWER.replaceAll(".", "\\.")}$`, "m"));
    expect(config).not.toMatch(/^update:/m);
    const status = launch(s, ["update", "--status"]).stdout;
    expect(status).toMatch(/^updates +on$/m);
    expect(status).toMatch(new RegExp(`^skipped +${NEWER.replaceAll(".", "\\.")} and every older release`, "m"));
  }, 120_000);

  it("refuses when the previous runtime is gone and leaves the record alone (failure 12)", () => {
    const s = commandHome();
    const record = join(s.oqHome, "runtime/current");
    const was = readFileSync(record, "utf8");
    writeFileSync(record, `${version}\n0.0.9\n`);
    try {
      const r = launch(s, ["update", "--rollback"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/0\.0\.9/);
      expect(readFileSync(record, "utf8")).toBe(`${version}\n0.0.9\n`);
    } finally {
      writeFileSync(record, was);
    }
  });

  it("update --off and --on write the user config; --on refuses a config that does not parse", () => {
    const s = commandHome();
    try {
      expect(launch(s, ["update", "--off"]).status).toBe(0);
      expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
      expect(launch(s, ["update", "--on"]).status).toBe(0);
      expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: on$/m);
      writeFileSync(join(s.oqHome, "config.yaml"), "update: [on\n");
      expect(launch(s, ["update", "--on"]).status).toBe(2);
    } finally {
      rmSync(join(s.oqHome, "config.yaml"), { force: true });
    }
  });

  it("update refuses to run when not started through the launcher", () => {
    const s = commandHome();
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

  it("finalize --run after an activation hands the run to the version that wrote the brief without --run (failure 19)", () => {
    const r = launch(s, ["review", "--finalize", "--run", basename(join(findings(), ".."))]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(findings(), "..", "report.json"))).toBe(true);
    rmSync(join(findings(), "..", "report.json"));
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

  it("a local build not started through the launcher names its own node and entry file, not the published version (failure 16)", () => {
    const r = direct(s, ["review", "--agent", "--no-install"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/npx -y openqodex@\S+ review --finalize/);
    const node = /^[A-Za-z0-9_./@+-]+$/.test(process.execPath) ? process.execPath : `'${process.execPath}'`;
    expect(r.stdout).toContain(`${node} ${/^[A-Za-z0-9_./@+-]+$/.test(BIN) ? BIN : `'${BIN}'`} review --finalize`);
  });

  it("the package run from a node_modules folder, as npx installs it, writes the pinned npx finalize command (failure 16)", () => {
    // The built package laid out the way npx installs the published one.
    const pkg = join(s.root, "npx cache", "node_modules", "openqodex");
    cpSync(join(BIN, "..", ".."), pkg, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
    const r = spawnSync(process.execPath, [join(pkg, "dist", "bin.js"), "review", "--agent", "--no-install"], {
      encoding: "utf8",
      env: laptop(s),
      cwd: s.repo,
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`npx -y openqodex@${version} review --finalize`);
  });
});
