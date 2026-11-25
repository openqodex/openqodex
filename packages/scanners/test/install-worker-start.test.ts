// Which program the scanner install starts as its worker, from a throwaway
// script that imports the resolver the way a debug script would. These tests
// import the built package (dist) and start the built CLI: run `pnpm build`
// first. The first one downloads actionlint from GitHub into a fresh home.
//
// Ways it could fail, written before the code (issue #69):
// 1. The worker is the running script (process.argv[1]) started again, so a
//    script that imports the resolver starts itself, and each copy starts
//    another, without end.
// 2. One install starts more than one worker.
// 3. The worker is not the openqodex bin with its __install argument.
// 4. A process that is itself an install worker (the marker in its
//    environment) starts another worker.
// 5. A script names its own file as the install program, and the resolver
//    starts it or the install body runs in it (found by the review of the
//    first fix: the program was a name any caller could set).
// 6. The install body runs in a program other than the openqodex bin, such
//    as a script that imports it and calls it, instead of stopping with one
//    line.
// 7. A process that may not start an install also stops waiting on one that
//    another process already runs (init-review.test.ts, case 12, guards it).
// 8. The watcher counts the worker's brief copy of itself, made when it
//    starts tar, as a second worker, so case 2 fails at random on a loaded
//    machine (issue #331); or a fix for that hides a real second worker.
//
// Every run here is capped: the throwaway script ends at once on its fourth
// start, the watcher kills every worker past the third and fails the test,
// and the script itself is killed after 80 seconds.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");
const bin = join(here, "..", "..", "cli", "dist", "bin.js");
const MARKER = "OPENQODEX_INSTALL_WORKER=1";
const MAX_STARTS = 3;

beforeAll(() => {
  if (!existsSync(dist) || !existsSync(bin)) throw new Error("run pnpm build before these tests");
});

// The throwaway script: notes each start of itself in a file, imports the
// resolver, tries to name its own file as the install program (should the
// package ever let a caller name one), and then either resolves actionlint
// or, with OQ_TEST_CALL=worker, calls the install body itself. A start past
// MAX_STARTS ends at once, so a script that starts itself again shows in the
// count instead of running on.
function throwaway(): { script: string; starts: string } {
  const dir = tempDir("oq-worker-script-");
  const script = join(dir, "debug.mjs");
  const starts = join(dir, "starts");
  writeFileSync(
    script,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(starts)}, process.pid + "\\n");`,
      `if (readFileSync(${JSON.stringify(starts)}, "utf8").trim().split("\\n").length > ${MAX_STARTS}) process.exit(0);`,
      `const tc = await import(${JSON.stringify(dist)});`,
      "if (typeof tc.setInstallWorkerEntry === 'function') tc.setInstallWorkerEntry(process.argv[1]);",
      "if (process.env.OQ_TEST_CALL === 'worker') {",
      '  process.stdout.write(JSON.stringify({ code: await tc.runInstallWorker("actionlint") }));',
      "} else {",
      '  const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null })("actionlint");',
      "  process.stdout.write(JSON.stringify(r));",
      "}",
      "",
    ].join("\n"),
  );
  return { script, starts };
}

type Found = { pid: number; ppid: number; command: string };

// The live processes whose environment holds every one of `vars`, with
// their parents and command lines. Linux keeps a process's environment in
// /proc/<pid>/environ and its parent in the fourth field of /proc/<pid>/stat,
// after the name in brackets; macOS prints the environment after the command
// with `ps -E`.
function processesWith(vars: string[]): Found[] {
  const found: Found[] = [];
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        if (!vars.every((v) => env.includes(v))) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        found.push({ pid: Number(pid), ppid, command: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ") });
      } catch {
        // The process ended or is not ours.
      }
    }
    return found;
  }
  const ps = execFileSync("ps", ["-A", "-E", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+) (.*)$/.exec(line);
    if (m && vars.every((v) => ` ${m[3]} `.includes(` ${v} `))) found.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return found;
}

// The found processes without those whose parent was also found (issue
// #331). The worker runs tar, and Node starts a program by copying the
// worker first: until the copy turns into tar it still shows the worker's
// command line and environment, so a scan that lands in that moment sees it
// as a second worker. A copy's parent is the worker it came from. A second
// worker that one install starts is a child of the script, which is never in
// the list, so it stays and is counted. A worker started by a worker would
// be dropped here; case 4 owns that fault, in its own test below, where the
// script carries the marker and is taken out before this runs.
function withoutChildren(found: Found[]): Found[] {
  const pids = new Set(found.map((p) => p.pid));
  return found.filter((p) => !pids.has(p.ppid));
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

type Run = { home: string; result: Record<string, unknown>; stderr: string; starts: number; workers: Map<number, string> };

// Runs the throwaway script with a fresh home and watches, until it exits,
// every process that carries the worker marker and that home. More than
// MAX_STARTS workers is the fault itself: each is killed and the test fails.
async function runScript(env: Record<string, string>): Promise<Run> {
  const home = tempDir("oq-worker-home-");
  const { script, starts } = throwaway();
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENQODEX_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 80_000,
    killSignal: "SIGKILL",
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (b: Buffer) => (out += String(b)));
  child.stderr.on("data", (b: Buffer) => (err += String(b)));
  let done = false;
  void new Promise<void>((resolve) => child.once("exit", () => resolve())).then(() => (done = true));
  const workers = new Map<number, string>();
  while (!done) {
    // The script is taken out first: in case 4 it carries the marker itself,
    // and a worker it starts must still count.
    const found = processesWith([MARKER, `OPENQODEX_HOME=${home}`]).filter((p) => p.pid !== child.pid);
    for (const { pid, command } of withoutChildren(found)) workers.set(pid, command);
    if (workers.size > MAX_STARTS) {
      for (const pid of workers.keys()) kill(pid);
      if (child.pid !== undefined) kill(child.pid);
      throw new Error(`more than ${MAX_STARTS} install workers started: ${[...workers.values()].join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (out === "") throw new Error(`the script printed nothing: ${err}`);
  return { home, result: JSON.parse(out) as Record<string, unknown>, stderr: err, starts: readFileSync(starts, "utf8").trim().split("\n").length, workers };
}

describe("the watcher's count of workers (8)", () => {
  it("drops the worker's copy of itself, a child of a found process", () => {
    expect(withoutChildren([{ pid: 1, ppid: 100, command: "w" }, { pid: 2, ppid: 1, command: "w" }]).map((p) => p.pid)).toEqual([1]);
  });

  it("drops the copy when it is listed before its parent", () => {
    expect(withoutChildren([{ pid: 2, ppid: 1, command: "w" }, { pid: 1, ppid: 100, command: "w" }]).map((p) => p.pid)).toEqual([1]);
  });

  it("keeps two unrelated processes", () => {
    expect(withoutChildren([{ pid: 1, ppid: 100, command: "w" }, { pid: 2, ppid: 200, command: "w" }]).map((p) => p.pid)).toEqual([1, 2]);
  });

  it("keeps a second worker started by the same script, so case 2 still fails on it", () => {
    expect(withoutChildren([{ pid: 1, ppid: 50, command: "w" }, { pid: 2, ppid: 50, command: "w" }]).map((p) => p.pid)).toEqual([1, 2]);
  });
});

describe("the install worker", () => {
  it("is the openqodex bin with __install, started once, even for a script that tries to name itself (1, 2, 3, 5)", async () => {
    const run = await runScript({});
    expect(run.result).toMatchObject({ ok: true });
    expect(run.starts).toBe(1);
    expect([...run.workers.values()].map((command) => command.includes(`${bin} __install actionlint`))).toEqual([true]);
    expect(readFileSync(join(run.home, "tools", "actionlint", "install.log"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 90_000);

  it("is not started by a process that is itself a worker (4)", async () => {
    const run = await runScript({ OPENQODEX_INSTALL_WORKER: "1" });
    expect(run.result).toEqual({ ok: false, status: "not_installed", reason: "an install process does not start another install" });
    expect(run.starts).toBe(1);
    expect(run.workers.size).toBe(0);
    expect(readdirSync(join(run.home, "tools", "actionlint"))).toEqual([]);
  }, 90_000);

  it("stops with one line when a script that tries to name itself runs the install body (5, 6)", async () => {
    const run = await runScript({ OQ_TEST_CALL: "worker" });
    expect(run.result).toEqual({ code: 1 });
    expect(run.stderr).toBe("openqodex: a scanner install runs only as `openqodex __install <tool>`\n");
    expect(run.starts).toBe(1);
    expect(run.workers.size).toBe(0);
    expect(existsSync(join(run.home, "tools"))).toBe(false);
  }, 90_000);
});
