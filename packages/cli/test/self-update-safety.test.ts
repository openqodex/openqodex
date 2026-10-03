// The self-update's commit boundary, immutable runtimes, the active record,
// rollback, uninstall, the stub skill and the Claude Code permission rules.
// Real built CLI, real launcher, real child processes; a child process
// imports this repo's own modules through bundle.ts.
//
// Ways it could fail, written before the code:
//  1. Two workers with different candidates: the older candidate is
//     activated over the newer one, because the start version is not
//     checked again inside the boundary.
//  2. A worker paused after its last eligibility check, then
//     `update --rollback`, then the worker resumes: the rolled-back version
//     is replaced, or updates come back on.
//  3. The same with `init --uninstall`: the resumed worker leaves a runtime,
//     the active record or an update file in the home folder.
//  4. A worker killed while it holds the boundary leaves state that makes
//     the next `init` wait or fail.
//  5. Three processes contending for the boundary: two are inside at once.
//  6. The boundary's listener keeps a process alive after its work is done;
//     or, when another program holds the port, a foreground command gives up
//     without naming the port and how to see the holder.
//  7. An existing runtime folder that differs from the package is replaced
//     by init, or reused by the worker; one with an extra symlink is
//     accepted as identical.
//  8. A crash between publishing the runtime folder and writing the active
//     record leaves the launcher on a half-switched version, or blocks the
//     next run from finishing the switch.
//  9. Rollback reports success while `update: off` could not be written.
// 10. Uninstall leaves files in the home folder that were not there before init.
// 11. A permission rule is written for a launcher path holding `*`, which
//     Claude Code reads as a wildcard.
// 12. A full-text skill an earlier init wrote, still as written, is not
//     replaced by the stub.
// 13. The user-scope skill is the full procedure or lacks "Who reviews";
//     `guide skill` prints the stub or a pinned npx line when started by the
//     launcher; a user-scope Cursor or Cline rule keeps a pinned npx line.
// 14. A review or guide line the stub, `guide skill` or a brief gives the
//     agent still asks for permission in Claude Code; a rule has a wildcard
//     after `review`; trust, report or doctor is allowed; or a rule the
//     developer had is removed.
// 15. `scan --offline --bad-flag` starts a worker; so does a command that failed to parse.
// 16. A project-scope skill tells the agent to use the updating launcher.
// 17. A team file the repo's git ignore rules hide is written and named as one to commit.
// 18. A queued daily worker checks again right after another one did.
// 19. A tarball member that is a link, or that leaves the folder, is unpacked.
// 20. A runtime folder that is itself a link to an identical tree is used.
// 21. Uninstall in one repo removes the launcher while a user-scope Cursor
//     rule in another repo still calls it.
// 22. A worker still talking to the registry when uninstall finishes writes
//     update.json into the removed home.
// 23. A failed cache write after the record switched reports "did not switch".
// 24. A finalize handoff breaks `review --finalize -- <findings path>`.
// 25. After `init --no-repo`, `init --yes` still does not write the team section.
// 26. Two spellings of one home (a link, a trailing slash) get two locks.
// 27. A child spawned inside the boundary keeps the port after its parent exits.
// 28. A temp folder a killed worker left stays for good, and stops uninstall
//     from removing runtime/.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleChildEntry } from "./bundle.js";
import { BIN, cli, env, git, sandbox, snapshot, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const OLDER = "0.98.0";
const NEWER = "0.99.0";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function laptop(s: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = env(s);
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_LAUNCHER", "OPENQODEX_FINALIZE_HANDOFF", "OPENQODEX_UPDATE_PAUSE"]) delete e[key];
  return { ...e, ...extra };
}
function launch(s: Sandbox, args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: laptop(s, extra), cwd: s.repo, input, timeout: 120_000 });
}
function installed(agents = ["claude-code"], files: Record<string, string> = {}): Sandbox {
  const s = sandbox(files);
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", ...agents.flatMap((a) => ["--agent", a])]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}
// The installed runtime with its version string changed: a second real runtime.
function copyRuntime(from: string, to: string, v: string, edit?: (dir: string) => void): string {
  cpSync(from, to, { recursive: true });
  const bin = join(to, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${v}"`));
  edit?.(to);
  return to;
}
const rt = (s: Sandbox, v: string): string => join(s.oqHome, "runtime", v);
const active = (s: Sandbox): string[] => readFileSync(join(s.oqHome, "runtime/current"), "utf8").split("\n").slice(0, 2);
// A verified release as the worker leaves it before the boundary:
// <home>/runtime/<v>.tmp-<id>/unpacked/package.
function unpacked(s: Sandbox, v: string, edit?: (dir: string) => void): string {
  const tmp = join(s.oqHome, "runtime", `${v}.tmp-test${Math.random().toString(16).slice(2, 8)}`);
  copyRuntime(rt(s, version), join(tmp, "unpacked", "package"), v, edit);
  return tmp;
}

let child = "";
beforeAll(async () => {
  expect(existsSync(BIN), "build the CLI first (pnpm build)").toBe(true);
  child = await bundleChildEntry();
}, 60_000);

// Runs `code` in a child node that has the bundled modules as `m`.
function nodeChild(code: string, extra: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(child)});\n${code}`], {
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function exited(p: ReturnType<typeof spawn>): Promise<{ code: number | null; out: string }> {
  let out = "";
  p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  return new Promise((r) => p.once("exit", (code) => r({ code, out })));
}
// A worker's last step: activateUnpacked in a child, printing its result as JSON.
function activation(s: Sandbox, v: string, from: string, extra: Record<string, string> = {}) {
  const tmp = unpacked(s, v);
  const p = nodeChild(
    `const r = await m.activateUnpacked({ home: process.env.H, version: ${JSON.stringify(v)}, from: ${JSON.stringify(from)}, tmp: ${JSON.stringify(tmp)}, env: process.env, wait: 0 }); process.stdout.write(JSON.stringify(r));`,
    { ...laptop(s), H: s.oqHome, ...extra },
  );
  return { p, done: exited(p), tmp };
}
async function untilPaused(s: Sandbox): Promise<void> {
  for (let i = 0; i < 600 && !existsSync(join(s.oqHome, "update-paused")); i++) await sleep(50);
  expect(existsSync(join(s.oqHome, "update-paused")), "the child reached the pause").toBe(true);
}
const resume = (s: Sandbox): void => rmSync(join(s.oqHome, "update-paused"), { force: true });
const pause = (stage: string): Record<string, string> => ({ OPENQODEX_E2E: "1", OPENQODEX_UPDATE_PAUSE: stage });

describe("1. two workers with different candidates", () => {
  it("the older candidate, checked before the newer one was activated, is not activated over it", async () => {
    const s = installed();
    const a = activation(s, OLDER, version, pause("before-boundary"));
    await untilPaused(s);
    const b = activation(s, NEWER, version);
    const rb = await b.done;
    expect(rb.out).toMatch(/"outcome":"activated"/);
    resume(s);
    const ra = await a.done;
    expect(ra.out).toMatch(/"outcome":"refused"/);
    expect(active(s)).toEqual([NEWER, version]);
    expect(existsSync(rt(s, OLDER))).toBe(false);
    expect(existsSync(a.tmp)).toBe(false);
  }, 120_000);
});

describe("2. rollback while a worker waits at the boundary", () => {
  it("the resumed worker leaves the rolled-back version active and updates off", async () => {
    const s = installed();
    expect((await activation(s, OLDER, version).done).out).toMatch(/"outcome":"activated"/);
    const a = activation(s, NEWER, OLDER, pause("before-boundary"));
    await untilPaused(s);
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status, r.stderr).toBe(0);
    resume(s);
    expect((await a.done).out).toMatch(/"outcome":"refused"/);
    expect(active(s)[0]).toBe(version);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
  }, 120_000);
});

describe("3. uninstall while a worker waits at the boundary", () => {
  it("the resumed worker writes nothing and removes what it unpacked", async () => {
    const s = installed();
    const a = activation(s, NEWER, version, pause("before-boundary"));
    await untilPaused(s);
    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    resume(s);
    expect((await a.done).out).toMatch(/"outcome":"gone"/);
    const runtime = join(s.oqHome, "runtime");
    expect(existsSync(runtime) ? readdirSync(runtime) : []).toEqual([]);
    for (const f of ["bin/openqodex", "update.json", "config.yaml", "install.json"]) expect(existsSync(join(s.oqHome, f)), f).toBe(false);
  }, 120_000);
});

describe("4. a worker killed while it holds the boundary", () => {
  it("the next init takes the boundary at once", async () => {
    const s = installed();
    const a = activation(s, NEWER, version, pause("in-boundary"));
    await untilPaused(s);
    a.p.kill("SIGKILL");
    await a.done;
    rmSync(join(s.oqHome, "update-paused"), { force: true });
    const started = Date.now();
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 120_000);
});

describe("5. three processes contending for the boundary", () => {
  it("never has two inside at once, over five rounds", async () => {
    for (let round = 0; round < 5; round++) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-boundary-")));
      const log = join(home, "log");
      const code = `const { appendFileSync } = await import("node:fs"); await m.withBoundary(process.env.H, { wait: 60000 }, async () => { appendFileSync(process.env.L, "in\\n"); await new Promise((r) => setTimeout(r, 120)); appendFileSync(process.env.L, "out\\n"); });`;
      const kids = Array.from({ length: 3 }, () => exited(nodeChild(code, { H: home, L: log })));
      const results = await Promise.all(kids);
      expect(results.map((x) => x.code), results.map((x) => x.out).join("\n")).toEqual([0, 0, 0]);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["in", "out", "in", "out", "in", "out"]);
    }
  }, 120_000);
});

describe("6. the boundary's listener", () => {
  it("does not keep the process alive once the work inside is done", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-boundary-")));
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(child)}); await m.withBoundary(process.env.H, { wait: 0 }, () => "done");`], {
      env: { ...process.env, H: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    const ms = Date.now() - started;
    process.stdout.write(`boundary: a process that took and left it exited in ${ms} ms\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(ms).toBeLessThan(5_000);
  });
});

describe("6b. a program that holds the boundary's port", () => {
  it("makes a foreground command give up after its wait with one line naming the port and how to see the holder", async () => {
    const s = installed();
    const port = Number(spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(child)}); process.stdout.write(String(m.boundaryPort(process.env.H)));`], { env: { ...process.env, H: s.oqHome }, encoding: "utf8" }).stdout);
    const { createServer } = await import("node:net");
    const squatter = createServer((c) => c.destroy());
    await new Promise<void>((r) => squatter.listen({ host: "127.0.0.1", port, exclusive: true }, () => r()));
    try {
      const r = await new Promise<{ code: number | null; err: string }>((done) => {
        const p = spawn("sh", [join(s.oqHome, "bin/openqodex"), "update", "--off"], { env: laptop(s), cwd: s.repo });
        let err = "";
        p.stderr.on("data", (d: Buffer) => (err += d.toString()));
        p.once("exit", (code) => done({ code, err }));
      });
      expect(r.code).toBe(2);
      expect(r.err).toContain(`127.0.0.1:${port}`);
      expect(r.err).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      expect(existsSync(join(s.oqHome, "config.yaml"))).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  }, 120_000);
});

describe("7. runtime folders are never replaced", () => {
  it("init refuses a runtime folder of its version that differs, names it, and leaves it as it is", () => {
    const s = installed();
    writeFileSync(join(rt(s, version), "LOCAL-BUILD"), "x\n");
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain(rt(s, version));
    expect(existsSync(join(rt(s, version), "LOCAL-BUILD"))).toBe(true);
  });

  it("init refuses a runtime folder that matches but holds an extra symbolic link", () => {
    const s = installed();
    symlinkSync("/etc/passwd", join(rt(s, version), "docs", "leak.md"));
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain(rt(s, version));
  });

  it("the worker skips a release whose folder exists with other bytes, and reuses an identical one", async () => {
    const s = installed();
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER, (d) => symlinkSync("/etc/passwd", join(d, "docs", "leak.md")));
    const first = await activation(s, NEWER, version).done;
    expect(first.out).toMatch(/"outcome":"skip"/);
    expect(active(s)[0]).toBe(version);
    rmSync(rt(s, NEWER), { recursive: true });
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER);
    const second = await activation(s, NEWER, version).done;
    expect(second.out).toMatch(/"outcome":"activated"/);
    expect(active(s)).toEqual([NEWER, version]);
  }, 120_000);
});

describe("8. a crash between publishing the runtime and writing the active record", () => {
  it("leaves the launcher on the old version, and the next run finishes the switch", async () => {
    const s = installed();
    const a = activation(s, NEWER, version, pause("after-publish"));
    await untilPaused(s);
    a.p.kill("SIGKILL");
    await a.done;
    resume(s);
    expect(existsSync(join(rt(s, NEWER), "dist/bin.js"))).toBe(true);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
    expect((await activation(s, NEWER, version).done).out).toMatch(/"outcome":"activated"/);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(NEWER);
  }, 120_000);

  it("a record naming a missing runtime runs the baked-in version; the second line is never run", () => {
    const s = installed();
    writeFileSync(join(s.oqHome, "runtime/current"), `0.0.7\n${version}\n`);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
  });
});

describe("9. rollback when the off switch cannot be written", () => {
  it("fails and changes nothing", async () => {
    const s = installed();
    expect((await activation(s, NEWER, version).done).out).toMatch(/"outcome":"activated"/);
    const locked = join(s.root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "config.yaml"), "update: on\n");
    symlinkSync(join(locked, "config.yaml"), join(s.oqHome, "config.yaml"));
    chmodSync(locked, 0o555);
    try {
      const r = launch(s, ["update", "--rollback"]);
      expect(r.status).toBe(2);
      expect(r.stdout).not.toMatch(/Rolled back/);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(active(s)).toEqual([NEWER, version]);
  }, 60_000);
});

describe("10. uninstall", () => {
  it("leaves the home folder as it was before init, after an activation, update --off and a check", async () => {
    const s = sandbox();
    const before = Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"));
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect((await activation(s, NEWER, version).done).out).toMatch(/"outcome":"activated"/);
    expect(launch(s, ["update", "--off"]).status).toBe(0);
    const state = JSON.parse(readFileSync(join(s.oqHome, "update.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(s.oqHome, "update.json"), JSON.stringify({ ...state, checkedAt: new Date().toISOString() }));
    // A lock file an earlier version left.
    writeFileSync(join(s.oqHome, "install.lock"), "12345 token\n");
    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"))).toEqual(before);
  }, 120_000);

  it("leaves a config.yaml the developer wrote", () => {
    const s = sandbox();
    mkdirSync(s.oqHome, { recursive: true });
    writeFileSync(join(s.oqHome, "config.yaml"), "update: off\n# mine\n");
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toBe("update: off\n# mine\n");
  });
});

describe("11. a launcher path with a wildcard character", () => {
  it("gets no permission rules, and init says so in one line", () => {
    const s = sandbox({}, "oq star* ");
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(join(s.home, ".claude/settings.json"), "utf8")) as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow ?? []).toEqual([]);
    expect(r.stdout).toMatch(/permission rules.*\*/);
  });
});

describe("12 and 13. the user-scope skill and the rules", () => {
  const skillPath = (s: Sandbox): string => join(s.home, ".claude/skills/openqodex/SKILL.md");

  it("a full-text skill an earlier init wrote, still as written, is replaced by the stub (failure 12)", () => {
    const s = installed();
    const old = readFileSync(join(rt(s, version), "skills/openqodex/SKILL.md"), "utf8");
    writeFileSync(skillPath(s), old);
    const rec = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { files: { path: string; sha256: string }[] };
    for (const f of rec.files) if (f.path === skillPath(s)) f.sha256 = createHash("sha256").update(old).digest("hex");
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(skillPath(s), "utf8")).toContain("guide skill");
    expect(readFileSync(skillPath(s), "utf8")).not.toContain("## The finding shape");
  });

  it("the user-scope skill is a stub with who reviews, that sends the agent to guide skill (failure 13)", () => {
    const s = installed(["claude-code", "codex", "cursor", "cline"]);
    for (const p of [".claude/skills", ".agents/skills", ".cursor/skills", ".cline/skills"]) {
      const text = readFileSync(join(s.home, p, "openqodex/SKILL.md"), "utf8");
      expect(text, p).toMatch(/^---\nname: openqodex\ndescription: /);
      expect(text, p).toContain("## Who reviews");
      expect(text, p).toContain(`'${join(s.oqHome, "bin/openqodex")}' guide skill`);
      expect(text, p).not.toContain("## The finding shape");
      expect(text, p).not.toMatch(/npx -y openqodex@/);
    }
  });

  it("guide skill through the launcher prints the full procedure with the launcher and no pinned npx line (failure 13)", () => {
    const s = installed();
    const r = launch(s, ["guide", "skill"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("## The finding shape");
    expect(r.stdout).toContain(`'${join(s.oqHome, "bin/openqodex")}' review --agent`);
    expect(r.stdout).not.toMatch(/npx -y openqodex@/);
    expect(r.stdout).not.toContain("guide skill` and follow");
    expect(r.stdout).not.toContain("When the file `~/.openqodex/bin/openqodex` exists");
  });

  it("guide skill not started by the launcher names the pinned npx version (failure 13)", () => {
    const s = sandbox();
    const r = cli(s, ["guide", "skill"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`npx -y openqodex@${version} review --agent`);
    expect(r.stdout).not.toContain("When the file `~/.openqodex/bin/openqodex` exists");
  });

  it("user-scope Cursor and Cline rules call the launcher, not a pinned npx line (failure 13)", () => {
    const s = installed(["cursor", "cline"]);
    const launcher = `'${join(s.oqHome, "bin/openqodex")}'`;
    for (const p of [join(s.repo, ".cursor/rules/openqodex.mdc"), join(s.home, "Documents/Cline/Rules/openqodex.md")]) {
      const text = readFileSync(p, "utf8");
      expect(text, p).not.toMatch(/npx -y openqodex@/);
      expect(text, p).toContain(`${launcher} review --agent`);
      expect(text, p).toContain(`${launcher} guide skill`);
    }
  });

  it("project scope keeps the pinned npx line in the Cursor and Cline rules", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "cursor", "--agent", "cline"]).status).toBe(0);
    for (const p of [".cursor/rules/openqodex.mdc", ".clinerules/openqodex.md"]) {
      expect(readFileSync(join(s.repo, p), "utf8"), p).toContain(`npx -y openqodex@${version} review --agent`);
    }
  });
});

describe("14. Claude Code permission rules", () => {
  // A home whose path needs no shell quoting, so the launcher is written
  // bare and one rule matches it.
  function plain(): { home: string; oqHome: string; repo: string; env: NodeJS.ProcessEnv; run: (args: string[]) => ReturnType<typeof spawnSync> } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oqperm")));
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    git(repo, "init", "-q");
    const oqHome = join(home, ".openqodex");
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, OPENQODEX_HOME: oqHome, OPENQODEX_AUTO_UPDATE: "0" };
    delete e.CODEX_HOME;
    return { home, oqHome, repo, env: e, run: (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env: e, encoding: "utf8", input: "" }) };
  }
  const allow = (settings: string): string[] => (JSON.parse(readFileSync(settings, "utf8")) as { permissions?: { allow?: string[] } }).permissions?.allow ?? [];

  // Claude Code's matching as its permissions page states it: a rule without
  // `*` matches one exact command; a trailing " *" also matches the bare command.
  const covers = (rules: string[], command: string): boolean =>
    rules.some((r) => {
      const body = r.slice("Bash(".length, -1);
      return body.endsWith(" *") ? command === body.slice(0, -2) || command.startsWith(body.slice(0, -1)) : command === body;
    });
  const EXACT = ["review --agent", "review --finalize", "review --agent --all", "review --finalize --all"];
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("allows exactly the review command lines and guide, with no wildcard after review", () => {
    const p = plain();
    const r = p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, String(r.stderr)).toBe(0);
    const launcher = join(p.oqHome, "bin/openqodex");
    const rules = allow(join(p.home, ".claude/settings.json"));
    expect(rules).toEqual([...EXACT, ...EXACT.map((c) => `${c} --offline`), "guide", "guide *"].map((c) => `Bash(${launcher} ${c})`));
    for (const banned of ["scan", "doctor", "trust", "update", "init", "report", "hook"]) {
      expect(rules.filter((x) => x.startsWith(`Bash(${launcher} ${banned}`)), banned).toEqual([]);
    }
  });

  it("every review or guide line the stub, guide skill and a launcher-started brief give the agent is allowed; trust, report and doctor lines are not", () => {
    const p = plain();
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const launcher = join(p.oqHome, "bin/openqodex");
    const rules = allow(join(p.home, ".claude/settings.json"));
    git(p.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
    writeFileSync(join(p.repo, "app.py"), "print('hello')\n");
    const texts = [readFileSync(join(p.home, ".claude/skills/openqodex/SKILL.md"), "utf8")];
    const guide = spawnSync("sh", [launcher, "guide", "skill"], { cwd: p.repo, env: p.env, encoding: "utf8" });
    expect(guide.status, guide.stderr).toBe(0);
    texts.push(guide.stdout);
    for (const args of [["review", "--agent"], ["review", "--agent", "--offline"], ["review", "--agent", "--all"], ["review", "--agent", "--all", "--offline"]]) {
      const r = spawnSync("sh", [launcher, ...args, "--no-install"], { cwd: p.repo, env: p.env, encoding: "utf8" });
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      texts.push(r.stdout);
    }
    const lines = texts.flatMap((x) => [...x.matchAll(new RegExp(`${escape(launcher)} [^\`\n]*`, "g"))].map((m) => m[0].trim()));
    const agentRuns = lines.filter((l) => / (review|guide)\b/.test(l) && !l.includes("<topic>"));
    expect(agentRuns).toContain(`${launcher} guide skill`);
    expect(agentRuns).toContain(`${launcher} review --agent`);
    expect(agentRuns.filter((l) => l.includes("review --finalize")).length).toBeGreaterThanOrEqual(5);
    for (const l of agentRuns) expect(covers(rules, l), l).toBe(true);
    const asked = lines.filter((l) => / (trust|report --send-last|doctor --install)\b/.test(l));
    expect(asked.length).toBeGreaterThan(0);
    for (const l of asked) expect(covers(rules, l), l).toBe(false);
    for (const l of [`${launcher} review --agent --output /etc/x`, `${launcher} review --agent && rm -rf x`]) expect(covers(rules, l), l).toBe(false);
  }, 180_000);

  it("a second init adds no rule, and uninstall removes only the rules init added", () => {
    const p = plain();
    const launcher = join(p.oqHome, "bin/openqodex");
    mkdirSync(join(p.home, ".claude"));
    writeFileSync(join(p.home, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls *)", `Bash(${launcher} guide)`] } }));
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const once = allow(join(p.home, ".claude/settings.json"));
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(allow(join(p.home, ".claude/settings.json"))).toEqual(once);
    expect(p.run(["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(allow(join(p.home, ".claude/settings.json"))).toEqual(["Bash(ls *)", `Bash(${launcher} guide)`]);
  });

  it("a rule an earlier version granted is removed by the next init; the developer's own rule stays", () => {
    const p = plain();
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const launcher = join(p.oqHome, "bin/openqodex");
    const settings = join(p.home, ".claude/settings.json");
    const stale = `Bash(${launcher} scan *)`;
    const mine = `Bash(${launcher} doctor *)`;
    const data = JSON.parse(readFileSync(settings, "utf8")) as { permissions: { allow: string[] } };
    data.permissions.allow.push(stale, mine);
    writeFileSync(settings, `${JSON.stringify(data, null, 2)}\n`);
    const rec = JSON.parse(readFileSync(join(p.oqHome, "install.json"), "utf8")) as { allowRules: { path: string; rule: string }[] };
    rec.allowRules.push({ path: settings, rule: stale });
    writeFileSync(join(p.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(allow(settings)).not.toContain(stale);
    expect(allow(settings)).toContain(mine);
  });

  it("--project writes no permission rule into the repository", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code"]).status).toBe(0);
    expect(allow(join(s.repo, ".claude/settings.json"))).toEqual([]);
  });
});

describe("15. a command that did not parse", () => {
  it("--offline with a bad flag, and a bad flag alone, start no worker", async () => {
    const a = installed();
    const b = installed();
    launch(a, ["scan", "--offline", "--bad-flag"]);
    launch(b, ["scan", "--bad-flag"]);
    await sleep(2500);
    expect(existsSync(join(a.oqHome, "update.json"))).toBe(false);
    expect(existsSync(join(b.oqHome, "update.json"))).toBe(false);
  }, 60_000);
});

describe("16 and 17. what init writes into a repository", () => {
  it("a project-scope skill keeps only the pinned npx commands (failure 16)", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code"]).status).toBe(0);
    const text = readFileSync(join(s.repo, ".claude/skills/openqodex/SKILL.md"), "utf8");
    expect(text).not.toContain("~/.openqodex/bin/openqodex");
    expect(text).toContain(`npx -y openqodex@${version} review --agent`);
  });

  it("a team file the repo ignores is not written and not named to commit (failure 17)", () => {
    const s = sandbox({ ".gitignore": "CLAUDE.md\n" });
    const r = cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.repo, "CLAUDE.md"))).toBe(false);
    expect(r.stdout).toMatch(/CLAUDE\.md.*ignore/);
    expect(r.stdout).toMatch(/Commit AGENTS\.md so/);
  });
});

describe("18. a queued daily worker", () => {
  it("does not check when another checked under an hour ago", () => {
    const s = installed();
    const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(join(s.oqHome, "update.json"), JSON.stringify({ checkedAt: at }));
    const r = launch(s, ["__update"]);
    expect(r.status).toBe(0);
    expect((JSON.parse(readFileSync(join(s.oqHome, "update.json"), "utf8")) as { checkedAt: string }).checkedAt).toBe(at);
  });
});

describe("19. a hostile release archive", () => {
  const gnu = /GNU/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout);
  function tarball(build: (dir: string) => string[]): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "oq-tar-")));
    mkdirSync(join(dir, "package/dist"), { recursive: true });
    writeFileSync(join(dir, "package/dist/bin.js"), "console.log('x')\n");
    const out = join(dir, "x.tgz");
    const r = spawnSync("tar", ["-czf", out, ...build(dir)], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return out;
  }
  async function unpack(tgz: string): Promise<{ out: string; home: string }> {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-hostile-")));
    const p = nodeChild(`try { await m.unpackRelease(process.env.H, "9.9.9", (await import("node:fs")).readFileSync(process.env.T)); } catch (e) { process.stdout.write(String(e.message)); }`, { H: home, T: tgz });
    return { out: (await exited(p)).out, home };
  }
  it("a member that is a link is refused", async () => {
    const r = await unpack(
      tarball((dir) => {
        symlinkSync("/etc/passwd", join(dir, "package/evil"));
        return ["package"];
      }),
    );
    expect(r.out).toMatch(/link/);
    expect(existsSync(join(r.home, "runtime/9.9.9"))).toBe(false);
  });
  it("a member that leaves the folder is refused", async () => {
    const r = await unpack(
      tarball((dir) => {
        writeFileSync(join(dir, "escape"), "x\n");
        return gnu ? ["--transform", "s,^escape,package/../../escape,", "package", "escape"] : ["-s", ",^escape,package/../../escape,", "package", "escape"];
      }),
    );
    expect(r.out).toMatch(/escapes/);
    expect(existsSync(join(r.home, "runtime/escape"))).toBe(false);
  });
});

describe("20 to 27. the third review", () => {
  it("a runtime folder that is a link to an identical tree is refused by the worker and by init (failure 20)", async () => {
    const s = installed();
    const outside = join(s.root, "outside");
    copyRuntime(rt(s, version), outside, NEWER);
    symlinkSync(outside, rt(s, NEWER));
    const r = await activation(s, NEWER, version).done;
    expect(r.out).toMatch(/"outcome":"skip"/);
    expect(active(s)[0]).toBe(version);
    const t2 = installed();
    const elsewhere = join(t2.root, "elsewhere");
    cpSync(rt(t2, version), elsewhere, { recursive: true });
    rmSync(rt(t2, version), { recursive: true });
    symlinkSync(elsewhere, rt(t2, version));
    const i = cli(t2, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(i.status).toBe(2);
    expect(i.stdout + i.stderr).toContain(rt(t2, version));
  }, 120_000);

  it("uninstall in one repo keeps the launcher and runtime while another repo's Cursor rule calls them (failure 21)", () => {
    const s = sandbox();
    const other = join(s.root, "repo b");
    mkdirSync(other);
    git(other, "init", "-q");
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "cursor"]).status).toBe(0);
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "cursor"], { cwd: other }).status).toBe(0);
    const r = cli(s, ["init", "--uninstall", "--yes", "--agent", "cursor"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.oqHome, "bin/openqodex"))).toBe(true);
    const rule = readFileSync(join(other, ".cursor/rules/openqodex.mdc"), "utf8");
    const command = /`('[^']+') review --agent`/.exec(rule)?.[1];
    expect(command).toBe(`'${join(s.oqHome, "bin/openqodex")}'`);
    expect(spawnSync("sh", ["-c", `${command} --version`], { encoding: "utf8", env: env(s) }).stdout.trim()).toBe(version);
  }, 120_000);

  it("a worker paused before the registry request writes no update.json after uninstall (failure 22)", async () => {
    const s = installed();
    const p = spawn("sh", [join(s.oqHome, "bin/openqodex"), "__update"], {
      env: laptop(s, { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_PAUSE: "before-metadata", OPENQODEX_UPDATE_AS: "999.0.0" }),
      cwd: s.repo,
      stdio: "ignore",
    });
    const done = new Promise((r) => p.once("exit", r));
    await untilPaused(s);
    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.oqHome, "update.json"))).toBe(false);
    resume(s);
    await done;
    expect(existsSync(join(s.oqHome, "update.json"))).toBe(false);
  }, 120_000);

  it("a cache write that fails after the record switched still reports activated (failure 23)", async () => {
    const s = installed();
    mkdirSync(join(s.oqHome, "update.json"));
    const r = await activation(s, NEWER, version).done;
    expect(r.out).toMatch(/"outcome":"activated"/);
    expect(active(s)).toEqual([NEWER, version]);
  }, 120_000);

  it("a handoff finalizes a findings path given after -- (failure 24)", async () => {
    const s = installed();
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
    git(s.repo, "add", "app.py");
    expect(launch(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    const dir = join(s.repo, (JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string }).dir);
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { candidates: { id: string }[] };
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { change_id: string };
    writeFileSync(
      join(dir, "agent-findings.json"),
      JSON.stringify({ version: 1, change_id: manifest.change_id, summary: "Looked", reviewer: "subagent", findings: [], dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })) }),
    );
    expect((await activation(s, NEWER, version).done).out).toMatch(/"outcome":"activated"/);
    const r = launch(s, ["review", "--finalize", "--", join(dir, "agent-findings.json")]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(dir, "report.json"))).toBe(true);
  }, 180_000);

  it("init --yes writes the team section after an earlier --no-repo (failure 25)", () => {
    const s = sandbox();
    const first = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(first.stdout).toMatch(/run init --yes without --no-repo/);
    expect(existsSync(join(s.repo, "CLAUDE.md"))).toBe(false);
    const r = cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(s.repo, "CLAUDE.md"), "utf8")).toContain("openqodex:start");
  });

  it("a linked spelling of the home and one with a trailing slash share the lock (failure 26)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-spell-")));
    const link = `${home}-link`;
    symlinkSync(home, link);
    const code = `const m = await import(${JSON.stringify(child)}); await m.withBoundary(process.env.A, { wait: 0 }, async () => { try { await m.withBoundary(process.env.B, { wait: 0 }, () => {}); process.stdout.write("both inside"); } catch (e) { process.stdout.write(e.held ? "held" : e.message); } });`;
    for (const other of [link, `${home}/`, `${link}/`]) {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, A: home, B: other }, encoding: "utf8" });
      expect(r.stdout, `${other}: ${r.stderr}`).toBe("held");
    }
  });

  it("a child spawned inside the boundary does not keep the port once the holder exits (failure 27)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-inherit-")));
    const hold = `const m = await import(${JSON.stringify(child)}); const { spawn } = await import("node:child_process"); await m.withBoundary(process.env.H, { wait: 0 }, () => { spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { detached: true, stdio: "ignore" }).unref(); });`;
    expect(spawnSync(process.execPath, ["--input-type=module", "-e", hold], { env: { ...process.env, H: home }, encoding: "utf8" }).status).toBe(0);
    const again = `const m = await import(${JSON.stringify(child)}); await m.withBoundary(process.env.H, { wait: 0 }, () => process.stdout.write("taken"));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", again], { env: { ...process.env, H: home }, encoding: "utf8" });
    expect(r.stdout, r.stderr).toBe("taken");
  });

  it("a temp folder a killed worker left is removed by the next worker and by uninstall; a live one stays (failure 28)", async () => {
    const s = installed();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    const stale = join(s.oqHome, "runtime", `9.9.9.tmp-${dead}`);
    const live = join(s.oqHome, "runtime", `9.9.8.tmp-${process.pid}`);
    for (const d of [stale, live]) {
      mkdirSync(join(d, "unpacked"), { recursive: true });
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(d, old, old);
    }
    const w = launch(s, ["__update"], { OPENQODEX_E2E: "1", OPENQODEX_UPDATE_AS: "999.0.0" });
    expect(w.status, w.stderr).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.oqHome, "runtime"))).toBe(false);
  }, 120_000);
});
