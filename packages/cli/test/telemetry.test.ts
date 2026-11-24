// Anonymous usage data, end to end: the built CLI as a real subprocess, its
// detached worker as a real process, and a capture server on loopback as
// the only receiver. The model provider is the one stand-in: a `claude` on
// PATH. No test here reaches the real host: every run names the loopback
// server as its host, and the receiver is never the default.
//
// Ways it could fail, written before the code (numbered by the plan's tests):
//  1. A switch that is off still sends, still creates the id or still prints
//     a line about usage data; or a worker started by hand gets past a switch.
//  2. A wrong value for the key fails or changes the command.
//  3. The first run sends no install.first_use, a later run sends it again,
//     two first runs both send it, or any run prints a line about usage
//     data (usage data is never announced on the terminal).
//  4. A path, a name or a private word is in a payload; or a property or a
//     value is not in the closed lists, or the docs table drifts from them.
//  5. A command waits for the network or hangs; or a worker stuck before
//     its request outlives its 4 second hard stop.
//  6. A delivery or identity failure changes a command's exit code, stdout
//     or stderr.
//  7. An abandoned first review loses the install.
//  8. Uninstall or a dry run sends or leaves state; a declined init makes an id.
//  9. The hot paths (hook check, mcp, the pre-push hook) send or make an id.
// 11. The test harness sends.
// 13. The payload shape drifts from what PostHog takes.
// 14. The work dispatch adds to a command grows without anyone seeing it.
// 15. A private model name passes, or asked-for and reported are merged.
// 16. A review is counted as finished before its cleanup, counted twice, or
//     not counted; a handed-off finalize is counted by the wrong process.
// 17. The feedback question is inside the duration, or holds the event back.
// 18. A relative OPENQODEX_HOME sends the worker to another home's config.
// 19. A custom scanner's name reaches the scanner fields of an event.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { stagedAnswer } from "../../review/test/staged-fake.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
import { run as e2eRun } from "../../../tests/e2e/support.js";
import { AGENT_ENV, agentFreePath, BIN } from "./init-helpers.js";
import type { Report } from "@openqodex/core";
import { canonicalModel, commandProps, propertyNames, PUBLIC_MODELS, reviewProps, scanProps, validate, versionOf } from "../src/telemetry/events.js";
import { telemetryTarget } from "../src/telemetry/config.js";
import { begin, context, dispatch, recordCommand } from "../src/telemetry/dispatch.js";
import { parseFlags } from "../src/flags.js";

afterAll(removeTempDirs);

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = dirname(here);
const repoRoot = dirname(dirname(cliRoot));
const VERSION = (JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string }).version;

// The variables that point git at another repository: a test run from a git
// hook inherits them, and git would then work on the caller's repository.
const GIT_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
// Config a caller's git passes down (git -c, GIT_CONFIG_COUNT): a hooks path
// there would run the caller's hooks in a fixture.
const INHERITED_GIT_CONFIG = /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/;
const gitEnv = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(e)) if (GIT_OVERRIDES.includes(key) || INHERITED_GIT_CONFIG.test(key)) delete e[key];
  return e;
};

// The CI markers, written here rather than read from the code, so a marker
// the code loses fails this file.
const CI_MARKERS = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "TF_BUILD", "TEAMCITY_VERSION", "BUILDKITE", "CODEBUILD_BUILD_ID", "BUILDER_OUTPUT"];
const STRIP = [...CI_MARKERS, ...AGENT_ENV, "DO_NOT_TRACK", "OPENQODEX_OFFLINE", "OPENQODEX_REVIEW_DEPTH", "OPENQODEX_SKIP", "OPENQODEX_LAUNCHER", "OPENQODEX_TELEMETRY_KEY", "OPENQODEX_E2E", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", ...GIT_OVERRIDES];

// No run prints a line about usage data: it is never announced on the terminal.
const ANNOUNCED = /anonymous|sends usage data/i;
// How long a worker may live (its hard stop is 4 seconds), with a margin.
const SETTLE_MS = 4500;

const SQL = "CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n";
// No download from a test: the two scanners a text file calls for, and the
// two downloaded SQL scanners init would fetch for the SQL file, are off.
const BASE = "scanners:\n  disable: [semgrep, gitleaks, squawk, sqlfluff]\n";

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ---------- the capture server ----------

type Hit = { at: number; url: string; headers: IncomingHttpHeaders; body: string; closedAt?: number };
type Mode = "ok" | "hold" | "500" | "drop";
type Server = { url: string; hits: Hit[]; close: () => Promise<void> };
type Envelope = { uuid: string; event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> };

const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

// A receiver on 127.0.0.1. `marker` is written when a request has arrived.
async function capture(mode: Mode = "ok", marker?: string): Promise<Server> {
  const hits: Hit[] = [];
  const open = new Set<Socket>();
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const hit: Hit = { at: Date.now(), url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      req.socket.once("close", () => (hit.closedAt = Date.now()));
      if (marker !== undefined) writeFileSync(marker, "");
      if (mode === "ok") res.end('{"status":1}');
      else if (mode === "500") {
        res.statusCode = 500;
        res.end();
      } else if (mode === "drop") req.socket.destroy();
      // hold: no answer at all
    });
  });
  server.on("connection", (socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const s: Server = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
  servers.push(s);
  return s;
}

// A valid event, for a worker started by hand.
const ENVELOPE: Envelope = { uuid: "1b4e28ba-2fa1-4d2e-883f-0016d3cca427", event: "command.completed", distinct_id: "a".repeat(64), timestamp: "2026-11-24T00:00:00.000Z", properties: { command: "scan", exitCode: 0 } };

const events = (s: Server): Envelope[] => s.hits.flatMap((h) => (JSON.parse(h.body) as { batch: Envelope[] }).batch);
const named = (s: Server, event: string): Envelope[] => events(s).filter((e) => e.event === event);

// ---------- sandboxes and runs ----------

type Box = { root: string; home: string; oqHome: string; repo: string };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// A temp home and a repo with one commit (README and the base config) and
// an uncommitted change (a SQL file sqllint flags, by default).
function box(o: { repoName?: string; homeName?: string; change?: Record<string, string>; config?: string } = {}): Box {
  const root = realpathSync(tempDir("oq-tel-"));
  const home = join(root, o.homeName ?? "home");
  const repo = join(root, o.repoName ?? "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".openqodex"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, ".openqodex/config.yaml"), o.config ?? BASE);
  writeFileSync(join(repo, ".openqodex/custom-instructions.md"), "");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Base");
  for (const [path, text] of Object.entries(o.change ?? { "db/x.sql": SQL })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return { root, home, oqHome: join(home, ".openqodex"), repo };
}

// An install id already made, so the run sends no install.first_use.
const SEEDED = "0f8fad5b-d9cb-469f-a165-70867728950e";
function seedId(b: Box): void {
  mkdirSync(join(b.oqHome, "telemetry"), { recursive: true, mode: 0o700 });
  writeFileSync(join(b.oqHome, "telemetry", "id"), `${SEEDED}\n2026-11-01T00:00:00.000Z\n`, { mode: 0o600 });
}

// Usage data on, aimed at `host`: every switch that would turn it off is
// taken out (CI markers too, so this runs the same on a CI runner), then
// `extra` is applied; a key set to undefined is removed. The host is never
// left out, so no run can reach the real one.
function onEnv(b: Box, host: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(e)) if (STRIP.includes(key) || INHERITED_GIT_CONFIG.test(key)) delete e[key];
  Object.assign(e, { HOME: b.home, OPENQODEX_HOME: b.oqHome, OPENQODEX_AUTO_UPDATE: "0", OPENQODEX_TELEMETRY: "1", OPENQODEX_TELEMETRY_HOST: host, PATH: agentFreePath(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete e[key];
    else e[key] = value;
  }
  return e;
}

type Ran = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; exitAt: number; pid: number };

function start(args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; input?: string; bin?: string }): { pid: number; done: Promise<Ran>; kill: (signal: NodeJS.Signals) => void } {
  const child = spawn(process.execPath, [o.bin ?? BIN, ...args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let exitAt = 0;
  child.stdout.on("data", (b: Buffer) => (stdout += String(b)));
  child.stderr.on("data", (b: Buffer) => (stderr += String(b)));
  child.stdin.on("error", () => undefined);
  child.stdin.end(o.input ?? "");
  child.once("exit", () => (exitAt = Date.now()));
  const done = new Promise<Ran>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr, exitAt, pid: child.pid ?? 0 }));
  });
  return { pid: child.pid ?? 0, done, kill: (signal) => child.kill(signal) };
}

const runCli = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; input?: string; bin?: string }): Promise<Ran> => start(args, o).done;

const SCAN = ["scan", "--only", "sqllint", "--no-install"];

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// The model provider stand-in: a `claude` on PATH that answers detection as
// Claude Code does, then answers every message with an empty, valid
// submission for the change id the brief names. `models` become the keys of
// modelUsage in its result events; `first` is JavaScript it runs when the
// first message arrives; `hang` never answers.
function standIn(o: { version?: string; models?: string[]; first?: string; hang?: boolean } = {}): string {
  const dir = tempDir("oq-tel-bin-");
  writeFileSync(
    join(dir, "claude"),
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      `if (args[0] === '--version') { console.log(${JSON.stringify(o.version ?? "2.1.289 (Claude Code)")}); process.exit(0); }`,
      "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
      `const stagedAnswer = ${stagedAnswer.toString()};`,
      `const models = ${JSON.stringify(o.models ?? [])};`,
      "let id = 'missing';",
      "let first = true;",
      "const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
      "say({ type: 'system', subtype: 'init', session_id: 'fake', tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] });",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk;",
      "  for (let nl = buf.indexOf('\\n'); nl !== -1; nl = buf.indexOf('\\n')) {",
      "    const text = JSON.parse(buf.slice(0, nl)).message.content;",
      "    buf = buf.slice(nl + 1);",
      `    if (first) { first = false; ${o.first ?? ""} }`,
      o.hang ? "    continue;" : "",
      "    id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? id;",
      "    const result = stagedAnswer(text, JSON.stringify({ version: 2, change_id: id, summary: 'Changes the file.', findings: [], dropped: [] }), () => '');",
      "    const usage = models.length === 0 ? {} : { modelUsage: Object.fromEntries(models.map((m) => [m, { inputTokens: 10, outputTokens: 5 }])) };",
      "    say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result, ...usage });",
      "  }",
      "});",
      o.hang ? "setInterval(() => {}, 1000);" : "",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

// This package's files, as npm installs them, copied into `dest`.
function copyPackage(dest: string): void {
  for (const entry of ["dist", "lenses", "docs", "skills", "templates", "demo", "toolchain.json", "locks", "wasm", "package.json"]) {
    if (existsSync(join(cliRoot, entry))) cpSync(join(cliRoot, entry), join(dest, entry), { recursive: true });
  }
}

const withClaude = (bin: string): string => `${bin}${delimiter}${agentFreePath()}`;
const REVIEW = ["review", "--only", "sqllint", "--no-install", "--no-graph"];
// A change with no scanner candidate, so the stand-in's empty answer completes the review.
const NOTES = { "notes.txt": "one line\n" };

// ---------- 1. every switch that is off ----------

describe("a switch that is off (failure 1)", () => {
  type Row = { name: string; prepare?: (b: Box) => void; env?: Record<string, string | undefined>; args?: string[] };
  const project = (text: string) => (b: Box) => writeFileSync(join(b.repo, ".openqodex/config.yaml"), BASE + text);
  const rows: Row[] = [
    ...["0", "false", "off"].map((v): Row => ({ name: `project key ${v}`, prepare: project(`openqodex_telemetry: ${v}\n`) })),
    {
      name: "the legacy .openqodex.yaml alone",
      prepare: (b) => {
        rmSync(join(b.repo, ".openqodex"), { recursive: true });
        writeFileSync(join(b.repo, ".openqodex.yaml"), `${BASE}openqodex_telemetry: 0\n`);
      },
    },
    {
      name: "both project files, the folder's on and the legacy off",
      prepare: (b) => {
        project("openqodex_telemetry: 1\n")(b);
        writeFileSync(join(b.repo, ".openqodex.yaml"), "openqodex_telemetry: 0\n");
      },
    },
    {
      name: "both project files, the folder's off and the legacy on",
      prepare: (b) => {
        project("openqodex_telemetry: 0\n")(b);
        writeFileSync(join(b.repo, ".openqodex.yaml"), "openqodex_telemetry: 1\n");
      },
    },
    {
      name: "a parent folder's config",
      prepare: (b) => {
        mkdirSync(join(b.root, ".openqodex"), { recursive: true });
        writeFileSync(join(b.root, ".openqodex/config.yaml"), "openqodex_telemetry: 0\n");
      },
    },
    {
      name: "a --config file that says 0 while the repository says 1",
      prepare: (b) => {
        project("openqodex_telemetry: 1\n")(b);
        writeFileSync(join(b.root, "off.yaml"), `${BASE}openqodex_telemetry: 0\n`);
      },
      args: ["--config", "../off.yaml"],
    },
    {
      name: "a repository file that says 0 while --config names a file that says 1",
      prepare: (b) => {
        project("openqodex_telemetry: 0\n")(b);
        writeFileSync(join(b.root, "on.yaml"), `${BASE}openqodex_telemetry: 1\n`);
      },
      args: ["--config", "../on.yaml"],
    },
    { name: "the value maybe", prepare: project("openqodex_telemetry: maybe\n") },
    { name: "a list as the value", prepare: project("openqodex_telemetry: [1]\n") },
    { name: "a project config that is a list holding the key", prepare: (b) => writeFileSync(join(b.repo, ".openqodex/config.yaml"), "- openqodex_telemetry: 0\n") },
    { name: "a project config that is not YAML", prepare: (b) => writeFileSync(join(b.repo, ".openqodex/config.yaml"), "scanners: [\n") },
    {
      name: "the user config key",
      prepare: (b) => {
        mkdirSync(b.oqHome, { recursive: true });
        writeFileSync(join(b.oqHome, "config.yaml"), "openqodex_telemetry: 0\n");
      },
    },
    {
      name: "a user config that cannot be read",
      prepare: (b) => {
        mkdirSync(b.oqHome, { recursive: true });
        writeFileSync(join(b.oqHome, "config.yaml"), "updates: [\n");
      },
    },
    { name: "OPENQODEX_TELEMETRY=0", env: { OPENQODEX_TELEMETRY: "0" } },
    { name: "OPENQODEX_TELEMETRY=nope", env: { OPENQODEX_TELEMETRY: "nope" } },
    { name: "DO_NOT_TRACK=1", env: { DO_NOT_TRACK: "1" } },
    ...CI_MARKERS.map((m): Row => ({ name: `${m} set`, env: { [m]: m === "JENKINS_URL" ? "https://ci.invalid/" : "true" } })),
    { name: "--offline", args: ["--offline"] },
    { name: "OPENQODEX_OFFLINE=1", env: { OPENQODEX_OFFLINE: "1" } },
    { name: "OPENQODEX_REVIEW_DEPTH=1", env: { OPENQODEX_REVIEW_DEPTH: "1" } },
    { name: "OPENQODEX_TELEMETRY=1 with CI=1", env: { OPENQODEX_TELEMETRY: "1", CI: "1" } },
    { name: "CI set to an empty value", env: { CI: "" } },
    // Only the value 1 lifts the local-build rule; this run is a local build.
    { name: "OPENQODEX_TELEMETRY=true on a local build", env: { OPENQODEX_TELEMETRY: "true" } },
  ];

  it("no row sends, makes the id or prints a line about it; the same run with the switch on sends", async () => {
    const server = await capture();
    const results = await pool(rows, 6, async (row) => {
      const b = box();
      row.prepare?.(b);
      const r = await runCli([...SCAN, ...(row.args ?? [])], { cwd: b.repo, env: onEnv(b, server.url, row.env) });
      return { row, b, r };
    });
    await sleep(SETTLE_MS);
    expect(server.hits).toEqual([]);
    for (const { row, b, r } of results) {
      expect(existsSync(join(b.oqHome, "telemetry")), row.name).toBe(false);
      expect(r.stderr, row.name).not.toMatch(ANNOUNCED);
    }
    // The control: the same run with nothing switched off is seen.
    const control = await capture();
    const b = box();
    await runCli(SCAN, { cwd: b.repo, env: onEnv(b, control.url) });
    await waitFor(() => control.hits.length > 0, 10_000, "the control's request");
    expect(existsSync(join(b.oqHome, "telemetry", "id"))).toBe(true);
  }, 180_000);

  it("a worker started by hand gets past no switch, and reads the project config when it sends", async () => {
    const server = await capture();
    // Each home has an id, so only a switch can stop the worker sending.
    const worker = async (b: Box, extra: Record<string, string | undefined>): Promise<void> => {
      seedId(b);
      const r = await runCli(["__telemetry"], { cwd: b.root, env: onEnv(b, server.url, { ...extra, OPENQODEX_TELEMETRY_EVENTS: JSON.stringify([ENVELOPE]), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: b.repo, offline: false }) }) });
      expect(r.status).toBe(0);
    };
    for (const extra of [{ CI: "1" }, { OPENQODEX_OFFLINE: "1" }, { OPENQODEX_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }]) await worker(box(), extra);
    // The project said on when the command ran, and off by the time the worker starts.
    const changed = box({ config: `${BASE}openqodex_telemetry: 1\n` });
    writeFileSync(join(changed.repo, ".openqodex/config.yaml"), `${BASE}openqodex_telemetry: 0\n`);
    await worker(changed, {});
    expect(server.hits).toEqual([]);
    // The control: the same worker with nothing off sends the one event.
    await worker(box(), {});
    expect(server.hits).toHaveLength(1);
    expect(events(server).map((e) => e.event)).toEqual(["command.completed"]);
  }, 60_000);

  it("a worker handed an install.first_use drops it: only the worker that makes the id sends one", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    const handed = [{ ...ENVELOPE, uuid: "2c5ea4c0-4067-41b6-a3a7-8bb7a2f1b2b9", event: "install.first_use", properties: {} }, ENVELOPE];
    const r = await runCli(["__telemetry"], { cwd: b.root, env: onEnv(b, server.url, { OPENQODEX_TELEMETRY_EVENTS: JSON.stringify(handed), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: b.repo, offline: false }) }) });
    expect(r.status).toBe(0);
    expect(events(server).map((e) => e.event)).toEqual(["command.completed"]);
  }, 30_000);

  it("a work tree that git is pointed at outside the folder: its switch counts", async () => {
    // The command runs in a repository that is on; GIT_DIR and GIT_WORK_TREE
    // point git at another one, which the command then scans.
    const run = async (value: string): Promise<Server> => {
      const server = await capture();
      const here = box();
      seedId(here);
      const there = box({ config: `${BASE}openqodex_telemetry: ${value}\n` });
      const r = await runCli(SCAN, { cwd: here.repo, env: onEnv(here, server.url, { GIT_DIR: join(there.repo, ".git"), GIT_WORK_TREE: there.repo }) });
      expect(r.status, r.stderr).toBe(0);
      return server;
    };
    const off = await run("0");
    const on = await run("1");
    await waitFor(() => on.hits.length === 1, 10_000, "the control's request");
    await sleep(SETTLE_MS);
    expect(off.hits).toEqual([]);
  }, 60_000);

  it("demo into a folder inside a project that is off sends nothing; into one that is on, it sends", async () => {
    const run = async (value: string): Promise<Server> => {
      const server = await capture();
      const b = box();
      seedId(b);
      const project = join(b.root, "project");
      mkdirSync(project);
      writeFileSync(join(project, ".openqodex.yaml"), `openqodex_telemetry: ${value}\n`);
      // Started in a repository that is on, so only the demo folder's switch can stop it.
      const r = await runCli(["demo", join(project, "demo"), "--no-install"], { cwd: b.repo, env: onEnv(b, server.url) });
      expect(r.status, r.stderr).toBe(0);
      return server;
    };
    const off = await run("0");
    const on = await run("1");
    await waitFor(() => on.hits.length === 1, 10_000, "the control's request");
    await sleep(SETTLE_MS);
    expect(off.hits).toEqual([]);
  }, 120_000);

  it.skipIf(process.platform === "win32")("a git that fails for any reason but no repository means nothing is sent", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    const bin = tempDir("oq-tel-git-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'fatal: something went wrong' >&2\nexit 1\n");
    chmodSync(join(bin, "git"), 0o755);
    const r = await runCli(["__telemetry"], { cwd: b.root, env: onEnv(b, server.url, { PATH: `${bin}${delimiter}${agentFreePath()}`, OPENQODEX_TELEMETRY_EVENTS: JSON.stringify([ENVELOPE]), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: b.repo, offline: false }) }) });
    expect(r.status).toBe(0);
    expect(server.hits).toEqual([]);
    // The control: outside any repository, git says so, and the worker sends.
    const outside = realpathSync(tempDir("oq-tel-norepo-"));
    const c = await runCli(["__telemetry"], { cwd: b.root, env: onEnv(b, server.url, { OPENQODEX_TELEMETRY_EVENTS: JSON.stringify([ENVELOPE]), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: outside, offline: false }) }) });
    expect(c.status).toBe(0);
    expect(server.hits).toHaveLength(1);
  }, 30_000);

  it("--cwd as a link that sits inside a folder that is off sends nothing", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    const off = join(b.root, "off");
    mkdirSync(off);
    writeFileSync(join(off, ".openqodex.yaml"), "openqodex_telemetry: 0\n");
    symlinkSync(b.repo, join(off, "link"));
    const r = await runCli([...SCAN, "--cwd", join(off, "link")], { cwd: b.root, env: onEnv(b, server.url) });
    expect(r.status, r.stderr).toBe(0);
    await sleep(SETTLE_MS);
    expect(server.hits).toEqual([]);
  }, 30_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a --config the command cannot reach turns it off", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    const locked = join(b.root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "c.yaml"), BASE);
    chmodSync(locked, 0o000);
    try {
      const r = await runCli([...SCAN, "--config", join(locked, "c.yaml")], { cwd: b.repo, env: onEnv(b, server.url) });
      expect(r.status, r.stderr).toBe(2);
      await sleep(SETTLE_MS);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(server.hits).toEqual([]);
  }, 30_000);

  it.skipIf(process.platform === "win32")("a user config that is a pipe turns it off, and the worker does not wait on it", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    const made = spawnSync("mkfifo", [join(b.oqHome, "config.yaml")]);
    expect(made.status).toBe(0);
    const started = Date.now();
    const worker = start(["__telemetry"], { cwd: b.root, env: onEnv(b, server.url, { OPENQODEX_TELEMETRY_EVENTS: JSON.stringify([ENVELOPE]), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: b.repo, offline: false }) }) });
    // A read that blocks holds even the hard stop back: this test ends it.
    const backstop = setTimeout(() => worker.kill("SIGKILL"), 8000);
    const r = await worker.done;
    clearTimeout(backstop);
    expect(r.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(server.hits).toEqual([]);
  }, 30_000);
});

// ---------- 2. a wrong value changes nothing but the switch ----------

describe("the key's value (failure 2)", () => {
  it("absent, 0, 1 and maybe give the same scan; maybe adds one warning line", async () => {
    const server = await capture();
    const runs: Record<string, Ran> = {};
    for (const value of ["absent", "0", "1", "maybe"]) {
      const b = box({ config: value === "absent" ? BASE : `${BASE}openqodex_telemetry: ${value}\n` });
      seedId(b);
      runs[value] = await runCli([...SCAN, "--format", "json"], { cwd: b.repo, env: onEnv(b, server.url) });
    }
    const stable = (r: Ran) => {
      const report = JSON.parse(r.stdout) as { verdict: string; findings: Record<string, unknown>[]; scanners: { scanner: string; status: string }[] };
      return {
        exit: r.status,
        verdict: report.verdict,
        findings: report.findings.map((f) => [f.source, f.severity, f.file_path, f.line_number, f.title]),
        scanners: report.scanners.map((s) => [s.scanner, s.status]),
      };
    };
    const first = stable(runs.absent!);
    expect(first.findings).toHaveLength(1);
    for (const value of ["0", "1", "maybe"]) expect(stable(runs[value]!), value).toEqual(first);
    const lines = (r: Ran) => r.stderr.split("\n").filter((l) => l !== "");
    expect(lines(runs.maybe!)).toHaveLength(lines(runs["1"]!).length + 1);
    expect(runs.maybe!.stderr).toContain("openqodex_telemetry: expected 0 or 1");
    expect(runs["1"]!.stderr).not.toContain("openqodex_telemetry");
  }, 60_000);
});

// ---------- 3. the first run ----------

describe("the first run (failure 3)", () => {
  it("makes the id and sends install.first_use once, printing nothing about it; the second run sends none", async () => {
    const server = await capture();
    const b = box();
    const one = await runCli(SCAN, { cwd: b.repo, env: onEnv(b, server.url) });
    expect(one.stderr).not.toMatch(ANNOUNCED);
    await waitFor(() => server.hits.length === 1, 10_000, "the first run's request");
    expect(existsSync(join(b.oqHome, "telemetry", "id"))).toBe(true);
    expect(events(server).map((e) => e.event)).toEqual(["install.first_use", "scan.completed", "command.completed"]);
    const two = await runCli(SCAN, { cwd: b.repo, env: onEnv(b, server.url) });
    expect(two.stderr).not.toMatch(ANNOUNCED);
    await waitFor(() => server.hits.length === 2, 10_000, "the second run's request");
    expect(named(server, "install.first_use")).toHaveLength(1);
    expect(named(server, "command.completed")).toHaveLength(2);
  }, 60_000);

  it("two first runs at once on one home send one install.first_use", async () => {
    const server = await capture();
    const a = box();
    const b = { ...box(), home: a.home, oqHome: a.oqHome };
    const [ra, rb] = await Promise.all([runCli(SCAN, { cwd: a.repo, env: onEnv(a, server.url) }), runCli(SCAN, { cwd: b.repo, env: onEnv(b, server.url) })]);
    expect(ra.stderr + rb.stderr).not.toMatch(ANNOUNCED);
    await waitFor(() => server.hits.length >= 1, 10_000, "a request");
    await sleep(SETTLE_MS);
    expect(named(server, "install.first_use")).toHaveLength(1);
  }, 60_000);
});

// ---------- 4 and 13. what a payload may hold ----------

// Every property name, written here; it must equal the docs table and the code.
const PROPS = [
  "installId", "installAgeDays", "$process_person_profile", "$geoip_disable", "$lib", "openqodexVersion", "platform", "arch", "os", "osMajor", "nodeMajor", "wsl", "hostAgent", "runner", "tty",
  "command", "sub", "exitCode", "durationMs", "threw", "interrupted", "errorKind", "errorClass", "errorCode", "errorLine", "errorColumn", "flags", "format",
  "ended", "agents", "scope", "hook", "mcp", "inRepo", "interactive", "result", "reviewerReady", "skipReason",
  "mode", "fromInit", "cleanupFailed", "verdict", "nothing", "demo", "reviewer", "reviewerVersion", "modelRequested", "modelReported", "effortRequested", "reviewersPassed", "staged", "web",
  "sessions", "rounds", "turns", "inputTokens", "outputTokens", "totalMs", "changeMs", "scanMs", "graphMs", "briefMs", "reviewerMs", "finalizeMs", "files", "additions", "deletions",
  "candidates", "findings", "possible", "observations", "outsideChange", "belowThreshold", "notReviewed", "dropped", "lowConfidence", "findingsBySeverity", "findingsByOrigin",
  "candidatesTotal", "candidatesDisposed", "hunks", "hunksCovered", "missingCount", "graph", "blockOn",
  "scannersRan", "scannersFailed", "scannersNotInstalled", "scannersInstalling", "scannersDisabled", "scannerMs", "scannerFailures", "customScanners", "customScannersFailed", "reportDir", "blockOnFlag",
];

const SCANNERS = ["semgrep", "gitleaks", "sqllint", "osv-scanner", "actionlint", "hadolint", "shellcheck", "ruff", "brakeman", "rubocop", "bandit", "oxlint", "golangci", "zizmor", "trivy", "squawk", "kube-linter", "tflint", "kubeconform", "cargo-deny", "checkov", "sqlfluff"];
const SEVERITIES = ["critical", "major", "minor", "nitpick", "info"];
const BOOLEANS = ["wsl", "tty", "threw", "interrupted", "mcp", "inRepo", "interactive", "reviewerReady", "fromInit", "cleanupFailed", "nothing", "demo", "staged", "web", "reportDir", "blockOnFlag"];
const WORDS: Record<string, readonly string[]> = {
  $lib: ["openqodex"],
  platform: [process.platform, "other"],
  arch: [process.arch, "other"],
  os: ["macOS", "Linux", "Windows", "other"],
  hostAgent: ["claude", "codex", "cursor", "none"],
  runner: ["launcher", "package"],
  command: ["init", "review", "update", "trust", "scan", "doctor", "hook", "guide", "findings", "demo", "report", "config", "graph"],
  sub: ["install", "uninstall", "pre-push", "agent", "finalize", "all", "target", "change", "rollback", "off", "on", "status", "now", "build", "help", "migrate", "search", "symbol", "callers", "callees", "importers", "implementers", "references", "routes", "tests", "path", "impact", "outline", "packages", "cycles", "changes", "unknowns", "explain", "status", "capabilities"],
  errorKind: ["input", "internal"],
  errorClass: ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "AbortError", "ZodError", "other"],
  errorCode: ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EEXIST", "ENOTDIR", "EISDIR", "EMFILE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EPIPE", "other"],
  format: ["terminal", "markdown", "json", "sarif"],
  ended: ["written", "unchanged", "unconfirmed", "cancelled", "stopped", "finished", "incomplete", "unavailable", "nothing", "interrupted", "error"],
  scope: ["user", "project", "change", "target", "all"],
  hook: ["pre-push", "none"],
  result: ["finished", "incomplete", "skipped", "unavailable"],
  skipReason: ["flag", "no_repo", "no_change", "declined"],
  mode: ["reviewer", "agent"],
  verdict: ["passed", "blocked", "incomplete"],
  reviewer: ["claude", "codex", "cursor", "other"],
  effortRequested: ["minimal", "low", "medium", "high", "xhigh", "max", "other", "default"],
  graph: ["ok", "partial", "off", "skipped", "failed"],
  blockOn: SEVERITIES,
};
const LISTS: Record<string, readonly string[]> = {
  flags: ["--cwd", "--config", "--format", "--output", "--no-color", "--quiet", "--verbose", "--no-install", "--offline", "--uncommitted", "--base", "--only", "--skip", "--agent", "--finalize", "--all", "--no-graph", "--run", "--reviewer", "--timeout", "--block-on-severity", "--instructions", "--instructions-ref", "--report-dir", "--reviewer-web", "--reviewer-model", "--reviewer-effort", "--install", "--all-scanners", "--json", "--require-all", "--project", "--hook", "--no-repo", "--no-review", "--mcp", "--no-mcp", "--yes", "-y", "--uninstall", "--dry-run", "--now", "--rollback", "--off", "--on", "--status", "--write", "--repo", "--send-last", "--list", "--revoke", "--force", "--full", "--compact", "--exclude-tests", "--file", "--name", "--tier", "--depth", "--limit", "--cursor", "--generation", "--edges", "--level", "--text", "--tokens", "--budget-ms", "--context"],
  agents: ["claude-code", "cursor", "codex", "cline", "goose"],
  scannersRan: SCANNERS,
  scannersFailed: SCANNERS,
  scannersNotInstalled: SCANNERS,
  scannersInstalling: SCANNERS,
  scannersDisabled: SCANNERS,
};
const MAPS: Record<string, { keys: readonly string[]; values?: readonly string[] }> = {
  findingsBySeverity: { keys: SEVERITIES },
  findingsByOrigin: { keys: ["agent", "scanner"] },
  scannerMs: { keys: SCANNERS },
  scannerFailures: { keys: SCANNERS, values: ["timeout", "exit", "could_not_start", "output_limit", "killed", "no_report", "unreadable_report", "other"] },
};
const MODEL_VALUES = new Set([...PUBLIC_MODELS, "other", "default", "unknown", "mixed"]);

// Why a property's value is not allowed, or null when it is.
function badValue(name: string, v: unknown): string | null {
  const count = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 2_147_483_647;
  if (name === "$process_person_profile") return v === false ? null : "must be false";
  if (name === "$geoip_disable") return v === true ? null : "must be true";
  if (name === "installId") return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? null : "not a hash";
  if (name === "exitCode") return [0, 1, 2, 130, 143].includes(v as number) ? null : "not an exit code";
  if (name === "openqodexVersion" || name === "reviewerVersion") return typeof v === "string" && (v === "unknown" || /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(v)) ? null : "not a version";
  if (name === "modelRequested" || name === "modelReported") return typeof v === "string" && MODEL_VALUES.has(v) ? null : "not a listed model";
  if (BOOLEANS.includes(name)) return typeof v === "boolean" ? null : "not a boolean";
  if (WORDS[name]) return typeof v === "string" && WORDS[name]!.includes(v) ? null : "not in its list";
  if (LISTS[name]) return Array.isArray(v) && v.every((w) => typeof w === "string" && LISTS[name]!.includes(w)) ? null : "a word not in its list";
  if (MAPS[name]) {
    const m = MAPS[name]!;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "not a map";
    for (const [k, x] of Object.entries(v)) {
      if (!m.keys.includes(k)) return `key ${k} not in its list`;
      if (m.values ? !(typeof x === "string" && m.values.includes(x)) : !count(x)) return `value of ${k} not allowed`;
    }
    return null;
  }
  return count(v) ? null : "not a count";
}

// Every check of failures 4 and 13 on one server's requests.
function checkPayloads(server: Server, canaries: string[]): void {
  expect(server.hits.length).toBeGreaterThan(0);
  for (const hit of server.hits) {
    expect(hit.url).toBe("/batch/");
    expect(hit.headers["content-type"]).toBe("application/json");
    // A path or an address has a slash; no allowed value does.
    expect(hit.body).not.toMatch(/[/\\]/);
    const lower = hit.body.toLowerCase();
    for (const canary of canaries) expect(lower, `canary ${canary}`).not.toContain(canary.toLowerCase());
    const body = JSON.parse(hit.body) as { api_key: unknown; batch: unknown };
    expect(Object.keys(body).sort()).toEqual(["api_key", "batch"]);
    expect(body.api_key).toMatch(/^phc_[A-Za-z0-9]+$/);
    expect(Array.isArray(body.batch)).toBe(true);
    for (const e of body.batch as Envelope[]) {
      expect(Object.keys(e).sort()).toEqual(["distinct_id", "event", "properties", "timestamp", "uuid"]);
      expect(["install.first_use", "command.completed", "init.completed", "init.first_review", "review.completed", "scan.completed"]).toContain(e.event);
      expect(e.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(e.distinct_id).toMatch(/^[0-9a-f]{64}$/);
      expect(e.distinct_id).toBe(e.properties.installId);
      expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(e.properties.$process_person_profile).toBe(false);
      expect(e.properties.$geoip_disable).toBe(true);
      for (const [name, value] of Object.entries(e.properties)) {
        expect(PROPS, `${e.event} property ${name}`).toContain(name);
        expect(badValue(name, value), `${e.event} ${name} = ${JSON.stringify(value)}`).toBeNull();
      }
    }
  }
}

describe("what a payload holds (failures 4 and 13)", () => {
  it("the property list equals the docs table and the code's tables", () => {
    const docs = readFileSync(join(repoRoot, "docs/telemetry.md"), "utf8");
    const inDocs = new Set(docs.split("\n").filter((l) => l.startsWith("| `")).flatMap((l) => [...l.split("|")[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)));
    expect([...inDocs].sort()).toEqual([...PROPS].sort());
    expect(propertyNames().sort()).toEqual([...PROPS].sort());
  });

  it("init, scan, a review and a failed command send no canary, and only listed names and values", async () => {
    const server = await capture();
    const custom = "customerproject";
    const b = box({
      repoName: "acme-customerproject-repo",
      homeName: "home-of-jdoe-canary",
      config: `${BASE}  custom:\n    - source: https://github.com/acme-corp/${custom}\n      name: ${custom}\n      run: ${custom} scan {target} --output {report}\nreview:\n  reviewers:\n    - tool: claude\n      model: claude-acme-4-5\n`,
      change: { [`db/${custom}_secret.sql`]: SQL },
    });
    git(b.repo, "checkout", "-q", "-b", `${custom}-branch`);
    git(b.repo, "remote", "add", "origin", `https://github.com/acme-corp/${custom}.git`);
    git(b.repo, "-c", "user.name=Jane Customerproject", "-c", "user.email=jane@customerproject.example", "commit", "-q", "--allow-empty", "-m", "Author canary");
    const path = withClaude(standIn({ version: "acmebuild (Claude Code)", models: ["acme-internal-sonnet"] }));
    const env = onEnv(b, server.url, { PATH: path });
    const init = await runCli(["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { cwd: b.repo, env });
    expect(init.status, init.stderr).toBe(0);
    const scan = await runCli(SCAN, { cwd: b.repo, env });
    expect(scan.status, scan.stderr).toBe(0);
    const review = await runCli(REVIEW, { cwd: b.repo, env });
    expect(review.stdout + review.stderr).toContain("Reviewer");
    const failed = await runCli([...SCAN, "--config", `/${custom}-cfg/missing.yaml`], { cwd: b.repo, env });
    expect(failed.status).toBe(2);
    await waitFor(() => named(server, "command.completed").length >= 4, 15_000, "four commands' events");
    await sleep(SETTLE_MS);
    const id = readFileSync(join(b.oqHome, "telemetry", "id"), "utf8").split("\n")[0]!;
    checkPayloads(server, [custom, "acme", "jdoe", "jane", "claude-acme-4-5", "acme-internal-sonnet", "missing.yaml", b.root, b.repo, b.home, id]);
    // The private names arrived as the closed words, not dropped silently.
    const reviews = named(server, "review.completed");
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    for (const r of reviews) {
      expect(r.properties.modelRequested).toBe("other");
      expect(r.properties.modelReported).toBe("other");
      expect(r.properties.reviewerVersion).toBe("unknown");
    }
    // The custom scanner is not trusted here, so it never runs and is not counted.
    expect(named(server, "scan.completed")[0]!.properties.customScanners).toBe(0);
    expect(named(server, "init.completed")).toHaveLength(1);
  }, 180_000);
});

// ---------- 5. the command never waits ----------

describe("a server that holds its answer (failure 5)", () => {
  it("the command exits while the request is open, and the worker's request cap closes it within 5 seconds", async () => {
    const server = await capture("hold");
    const b = box();
    seedId(b);
    const r = await runCli(SCAN, { cwd: b.repo, env: onEnv(b, server.url) });
    expect(r.status).toBe(0);
    await waitFor(() => server.hits.length === 1, 10_000, "the held request");
    const hit = server.hits[0]!;
    // Whether the worker connected before or after the exit, the exit did not wait for the answer.
    expect(r.exitAt).toBeLessThan(hit.closedAt ?? Number.POSITIVE_INFINITY);
    await waitFor(() => hit.closedAt !== undefined, 6000, "the worker to close the held request");
    expect(hit.closedAt! - hit.at).toBeLessThanOrEqual(5000);
  }, 30_000);

  it("a worker stuck before its request is stopped by its 4 second hard stop", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    // A network stack that never answers and holds the process open, as a
    // hung socket does: fetch is replaced in the worker by a call that keeps
    // a timer alive and never settles, so only the hard stop ends it.
    const stuck = join(b.root, "stuck.cjs");
    writeFileSync(stuck, "globalThis.fetch = () => { setInterval(() => {}, 1000); return new Promise(() => {}); };\n");
    const started = Date.now();
    const worker = start(["__telemetry"], { cwd: b.root, env: onEnv(b, server.url, { NODE_OPTIONS: `--require ${JSON.stringify(stuck)}`, OPENQODEX_TELEMETRY_EVENTS: JSON.stringify([ENVELOPE]), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: b.repo, offline: false }) }) });
    // Without the hard stop it would run forever: this test ends it.
    const backstop = setTimeout(() => worker.kill("SIGKILL"), 8000);
    const r = await worker.done;
    clearTimeout(backstop);
    const took = Date.now() - started;
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(took).toBeGreaterThanOrEqual(4000);
    expect(took).toBeLessThan(7500);
    expect(server.hits).toEqual([]);
  }, 30_000);
});

// ---------- 18. the worker's home ----------

describe("a relative OPENQODEX_HOME (failure 18)", () => {
  it("reaches the worker resolved, so its switch check reads the same user config", async () => {
    const server = await capture();
    const b = box();
    const seen = join(b.root, "worker-home.txt");
    const recorder = join(b.root, "recorder.cjs");
    writeFileSync(recorder, `if (process.argv.includes("__telemetry")) require("node:fs").writeFileSync(${JSON.stringify(seen)}, process.env.OPENQODEX_HOME ?? "");\n`);
    const r = await runCli(SCAN, { cwd: b.repo, env: onEnv(b, server.url, { OPENQODEX_HOME: ".oq", NODE_OPTIONS: `--require ${JSON.stringify(recorder)}` }) });
    expect(r.status, r.stderr).toBe(0);
    await waitFor(() => server.hits.length === 1, 10_000, "the request");
    expect(readFileSync(seen, "utf8")).toBe(join(b.repo, ".oq"));
  }, 30_000);
});

// ---------- 6. failures change nothing ----------

describe("a telemetry failure (failure 6)", () => {
  const same = async (b: Box, host: string, what: string, server?: Server): Promise<void> => {
    const off = await runCli(SCAN, { cwd: b.repo, env: onEnv(b, host, { OPENQODEX_TELEMETRY: "0" }) });
    const on = await runCli(SCAN, { cwd: b.repo, env: onEnv(b, host) });
    expect(on.status, what).toBe(off.status);
    expect(on.stdout, what).toBe(off.stdout);
        expect(on.stderr, what).not.toMatch(/telemetry|usage data/i);
    if (server !== undefined) await waitFor(() => server.hits.length > 0, 10_000, `the request of ${what}`);
  };

  it("a closed port, a 500 answer and a dropped connection", async () => {
    const closed = await capture();
    await closed.close();
    const b1 = box();
    seedId(b1);
    await same(b1, closed.url, "a closed port");
    const s500 = await capture("500");
    const b2 = box();
    seedId(b2);
    await same(b2, s500.url, "a 500 answer", s500);
    const drop = await capture("drop");
    const b3 = box();
    seedId(b3);
    await same(b3, drop.url, "a dropped connection", drop);
  }, 60_000);

  it("a home that cannot be written, an id that is a link, an id that is junk and a home that is a file", async () => {
    const server = await capture();
    const link = box();
    mkdirSync(join(link.oqHome, "telemetry"), { recursive: true });
    writeFileSync(join(link.root, "elsewhere"), `${SEEDED}\n2026-11-01T00:00:00.000Z\n`);
    symlinkSync(join(link.root, "elsewhere"), join(link.oqHome, "telemetry", "id"));
    await same(link, server.url, "an id file that is a link");
    const junk = box();
    mkdirSync(join(junk.oqHome, "telemetry"), { recursive: true });
    writeFileSync(join(junk.oqHome, "telemetry", "id"), "junk\n");
    await same(junk, server.url, "an id file that holds junk");
    expect(readFileSync(join(junk.oqHome, "telemetry", "id"), "utf8")).toBe("junk\n");
    const file = box();
    writeFileSync(join(file.home, "not-a-folder"), "");
    await same({ ...file, oqHome: join(file.home, "not-a-folder") }, server.url, "a home path that is a file");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = box();
      mkdirSync(locked.oqHome, { recursive: true });
      chmodSync(locked.oqHome, 0o555);
      try {
        await same(locked, server.url, "a home that cannot be written");
        // The worker makes the id after the command ends: the home stays locked until it is done.
        await sleep(SETTLE_MS);
        expect(existsSync(join(locked.oqHome, "telemetry"))).toBe(false);
      } finally {
        chmodSync(locked.oqHome, 0o755);
      }
    }
    await sleep(SETTLE_MS);
    expect(server.hits).toEqual([]);
  }, 90_000);
});

// ---------- 7. an abandoned first review ----------

describe("a first review stopped by Ctrl-C (failure 7)", () => {
  it("the install is sent while the review runs, and the stopped review and command after the signal", async () => {
    const server = await capture();
    const b = box({ change: NOTES });
    const started = join(b.root, "reviewer-started");
    const path = withClaude(standIn({ hang: true, first: `require('node:fs').writeFileSync(${JSON.stringify(started)}, '');` }));
    const init = start(["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { cwd: b.repo, env: onEnv(b, server.url, { PATH: path }) });
    await waitFor(() => existsSync(started), 60_000, "the reviewer to start");
    await waitFor(() => named(server, "init.completed").length === 1, 10_000, "init.completed while the review runs");
    init.kill("SIGINT");
    const r = await init.done;
    expect(r.status, r.stderr).toBe(130);
    await waitFor(() => named(server, "review.completed").length === 1, 10_000, "the stopped review's event");
    await sleep(500);
    const review = named(server, "review.completed");
    expect(review).toHaveLength(1);
    expect(review[0]!.properties).toMatchObject({ ended: "interrupted", fromInit: true, exitCode: 130 });
    const command = named(server, "command.completed");
    expect(command).toHaveLength(1);
    expect(command[0]!.properties).toMatchObject({ command: "init", interrupted: true, exitCode: 130 });
  }, 90_000);
});

// ---------- 8 and 9. what sends nothing and makes no id ----------

// Any process a test waits on is started with spawn, never spawnSync: the
// capture server runs in this process and answers only while it is free.
function spawnAsync(command: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += String(b)));
    child.once("error", fail);
    child.once("close", (status) => done({ status, stdout }));
  });
}

// The CLI run in a real terminal (fixtures/pty-run.py).
function pty(cwd: string, env: NodeJS.ProcessEnv, args: string[], steps: [string, string, string?][]): Promise<{ status: number | null; stdout: string }> {
  const python = (process.env.PATH ?? "").split(delimiter).map((d) => join(d, "python3")).find((p) => existsSync(p));
  if (python === undefined) throw new Error("python3 is needed to run the CLI in a terminal");
  return spawnAsync(python, [join(here, "fixtures", "pty-run.py"), JSON.stringify(steps.map((s) => s.filter((x) => x !== undefined))), process.execPath, BIN, ...args], { cwd, env });
}

describe("dry runs, uninstall and a declined init (failure 8)", () => {
  // Each case runs on a home that already has an id where the command could
  // otherwise send, so only the silence rule keeps it from sending.
  it("send nothing, and leave no id where none was", async () => {
    const quiet: [string, Server][] = [];
    const INSTALL = ["init", "--yes", "--hook", "none", "--no-repo", "--no-review"];

    const fresh = box();
    const freshServer = await capture();
    quiet.push(["init --dry-run on a fresh home", freshServer]);
    const d = await runCli(["init", "--dry-run", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo", "--no-review"], { cwd: fresh.repo, env: onEnv(fresh, freshServer.url) });
    expect(d.status, d.stderr).toBe(0);
    expect(d.stderr).not.toMatch(ANNOUNCED);
    expect(existsSync(join(fresh.oqHome, "telemetry"))).toBe(false);

    const dry = box();
    seedId(dry);
    const dryServer = await capture();
    quiet.push(["init --dry-run on a home with an id", dryServer]);
    const d2 = await runCli(["init", "--dry-run", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo", "--no-review"], { cwd: dry.repo, env: onEnv(dry, dryServer.url) });
    expect(d2.status, d2.stderr).toBe(0);

    const un = box();
    const unServer = await capture();
    quiet.push(["init --uninstall that removes the launcher", unServer]);
    const installed = await runCli([...INSTALL, "--agent", "claude-code"], { cwd: un.repo, env: onEnv(un, unServer.url, { OPENQODEX_TELEMETRY: "0" }) });
    expect(installed.status, installed.stderr).toBe(0);
    seedId(un);
    const u = await runCli(["init", "--uninstall", "--yes"], { cwd: un.repo, env: onEnv(un, unServer.url) });
    expect(u.status, u.stderr).toBe(0);
    expect(existsSync(join(un.oqHome, "telemetry"))).toBe(false);

    // Only the id is the uninstall's to remove: anything else in its folder stays.
    const keep = box();
    const keepServer = await capture();
    quiet.push(["init --uninstall with another file beside the id", keepServer]);
    const keepInstalled = await runCli([...INSTALL, "--agent", "claude-code"], { cwd: keep.repo, env: onEnv(keep, keepServer.url, { OPENQODEX_TELEMETRY: "0" }) });
    expect(keepInstalled.status, keepInstalled.stderr).toBe(0);
    seedId(keep);
    writeFileSync(join(keep.oqHome, "telemetry", "notes.txt"), "mine\n");
    const uk = await runCli(["init", "--uninstall", "--yes"], { cwd: keep.repo, env: onEnv(keep, keepServer.url) });
    expect(uk.status, uk.stderr).toBe(0);
    expect(existsSync(join(keep.oqHome, "telemetry", "id"))).toBe(false);
    expect(readFileSync(join(keep.oqHome, "telemetry", "notes.txt"), "utf8")).toBe("mine\n");

    // A telemetry folder that is a link is not the uninstall's: what it points at stays.
    const linked = box();
    const linkedServer = await capture();
    quiet.push(["init --uninstall with the telemetry folder a link", linkedServer]);
    const linkedInstalled = await runCli([...INSTALL, "--agent", "claude-code"], { cwd: linked.repo, env: onEnv(linked, linkedServer.url, { OPENQODEX_TELEMETRY: "0" }) });
    expect(linkedInstalled.status, linkedInstalled.stderr).toBe(0);
    const target = join(linked.home, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "id"), "not openqodex's\n");
    symlinkSync(target, join(linked.oqHome, "telemetry"));
    const ul = await runCli(["init", "--uninstall", "--yes"], { cwd: linked.repo, env: onEnv(linked, linkedServer.url) });
    expect(ul.status, ul.stderr).toBe(0);
    expect(readFileSync(join(target, "id"), "utf8")).toBe("not openqodex's\n");

    // A file where the telemetry folder should be: the uninstall still runs.
    const flat = box();
    const flatServer = await capture();
    quiet.push(["init --uninstall with a file in place of the telemetry folder", flatServer]);
    const flatInstalled = await runCli([...INSTALL, "--agent", "claude-code"], { cwd: flat.repo, env: onEnv(flat, flatServer.url, { OPENQODEX_TELEMETRY: "0" }) });
    expect(flatInstalled.status, flatInstalled.stderr).toBe(0);
    writeFileSync(join(flat.oqHome, "telemetry"), "a file\n");
    const uf = await runCli(["init", "--uninstall", "--yes"], { cwd: flat.repo, env: onEnv(flat, flatServer.url) });
    expect(uf.status, uf.stderr).toBe(0);
    expect(existsSync(join(flat.oqHome, "bin", "openqodex"))).toBe(false);
    expect(readFileSync(join(flat.oqHome, "telemetry"), "utf8")).toBe("a file\n");

    const one = box();
    const oneServer = await capture();
    quiet.push(["init --uninstall of one agent of two, which keeps the id", oneServer]);
    const two = await runCli([...INSTALL, "--agent", "claude-code", "--agent", "cursor"], { cwd: one.repo, env: onEnv(one, oneServer.url, { OPENQODEX_TELEMETRY: "0" }) });
    expect(two.status, two.stderr).toBe(0);
    seedId(one);
    const u1 = await runCli(["init", "--uninstall", "--yes", "--agent", "cursor"], { cwd: one.repo, env: onEnv(one, oneServer.url) });
    expect(u1.status, u1.stderr).toBe(0);
    expect(existsSync(join(one.oqHome, "telemetry", "id"))).toBe(true);

    const declined = box();
    const declinedServer = await capture();
    quiet.push(["an init the developer declines", declinedServer]);
    const n = await pty(declined.repo, onEnv(declined, declinedServer.url), ["init", "--agent", "claude-code", "--no-review"], [["Write these files?", "n"]]);
    expect(n.stdout).toContain("Write these files?");
    expect(existsSync(join(declined.oqHome, "telemetry"))).toBe(false);
    expect(n.stdout).not.toMatch(ANNOUNCED);

    await sleep(SETTLE_MS);
    for (const [what, server] of quiet) expect(server.hits, what).toEqual([]);
  }, 150_000);
});

describe("the hot paths (failure 9)", () => {
  it("hook check and mcp send nothing on a home with an id; the pre-push hook makes no id on a fresh one", async () => {
    const quiet: [string, Server][] = [];
    const b = box();
    seedId(b);
    const checkServer = await capture();
    quiet.push(["hook check", checkServer]);
    const check = await runCli(["hook", "check"], { cwd: b.repo, env: onEnv(b, checkServer.url), input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: b.repo }) });
    expect(check.status, check.stderr).toBe(0);
    const mcpServer = await capture();
    quiet.push(["mcp", mcpServer]);
    const mcp = await runCli(["mcp"], { cwd: b.repo, env: onEnv(b, mcpServer.url) });
    expect(mcp.signal).toBeNull();

    const fresh = box();
    const pushServer = await capture();
    quiet.push(["hook pre-push on a fresh home", pushServer]);
    const prePush = await runCli(["hook", "pre-push"], { cwd: fresh.repo, env: onEnv(fresh, pushServer.url) });
    expect(prePush.stderr).not.toMatch(ANNOUNCED);
    expect(existsSync(join(fresh.oqHome, "telemetry"))).toBe(false);
    await sleep(SETTLE_MS);
    for (const [what, server] of quiet) expect(server.hits, what).toEqual([]);
  }, 60_000);
});

// ---------- 11. the harness itself ----------

describe("the test harness (failure 11)", () => {
  it("runs with usage data off, and the plain e2e run sends nothing and makes no id", async () => {
    expect(process.env.OPENQODEX_TELEMETRY).toBe("0");
    const server = await capture();
    const b = box();
    const tools = join(b.root, "e2e-home");
    const r = e2eRun("telemetry-harness", b.repo, SCAN, { tools, env: { OPENQODEX_TELEMETRY_HOST: server.url } });
    expect(r.status, r.stderr).toBe(0);
    await sleep(SETTLE_MS);
    expect(server.hits).toEqual([]);
    expect(existsSync(join(tools, "telemetry"))).toBe(false);
  }, 30_000);
});

// ---------- 14. what dispatch costs the command ----------

describe("the cost of dispatch (failure 14)", () => {
  it("the real dispatch with a real spawn of the built bundle takes a median under 50 ms", async () => {
    const server = await capture("hold");
    const b = box();
    seedId(b);
    const saved = { env: { ...process.env }, argv1: process.argv[1] };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, onEnv(b, server.url));
    process.argv[1] = BIN;
    const times: number[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        begin("scan", ["--cwd", b.repo]);
        recordCommand({ exitCode: 0, threw: false, interrupted: false });
        const t = performance.now();
        dispatch();
        times.push(performance.now() - t);
      }
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved.env);
      process.argv[1] = saved.argv1!;
    }
    const sorted = [...times].sort((x, y) => x - y);
    const median = (sorted[9]! + sorted[10]!) / 2;
    console.log(`telemetry dispatch: median ${median.toFixed(1)} ms, worst ${sorted[19]!.toFixed(1)} ms over 20 calls`);
    // Each call started a real worker that reached the server.
    await waitFor(() => server.hits.length === 20, 15_000, "twenty workers' requests");
    expect(median).toBeLessThan(50);

    // The CPU time of one worker run, measured inside the worker.
    const ok = await capture();
    const usage = join(b.root, "cpu.json");
    const hook = join(b.root, "cpu.cjs");
    writeFileSync(hook, `process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(usage)}, JSON.stringify(process.cpuUsage())));\n`);
    const w = await spawnAsync(process.execPath, ["--require", hook, BIN, "__telemetry"], { cwd: b.root, env: onEnv(b, ok.url, { OPENQODEX_TELEMETRY_EVENTS: JSON.stringify([ENVELOPE]), OPENQODEX_TELEMETRY_CONTEXT: JSON.stringify({ cwd: b.repo, offline: false }) }) });
    expect(w.status).toBe(0);
    expect(ok.hits).toHaveLength(1);
    const cpu = JSON.parse(readFileSync(usage, "utf8")) as { user: number; system: number };
    console.log(`telemetry worker: ${((cpu.user + cpu.system) / 1000).toFixed(1)} ms of CPU (user ${(cpu.user / 1000).toFixed(1)}, system ${(cpu.system / 1000).toFixed(1)})`);
  }, 60_000);
});

// ---------- 1. the folder the command acts on ----------

describe("the folder and config the switch check reads (failure 1)", () => {
  it("are the ones the command's own flag parser settles on: the last value, flags before --", () => {
    const shapes = [
      ["--cwd", "/a", "--cwd", "/b"],
      ["--cwd=/a", "--cwd", "/b"],
      ["--cwd", "/b", "--cwd=/a"],
      ["--cwd", "/a", "--", "--cwd", "/b"],
      ["--config", "x.yaml", "--config=y.yaml"],
      ["--offline"],
      ["--", "--offline"],
      ["--quiet", "--cwd", "/a", "--config", "c.yaml", "--offline", "--cwd", "/c"],
    ];
    // parseFlags sets OPENQODEX_OFFLINE for --offline; this process gets it back.
    const offline = process.env.OPENQODEX_OFFLINE;
    try {
      for (const args of shapes) {
        const { global, bools } = parseFlags(args, { positionals: 5 });
        expect(context(args), args.join(" ")).toEqual({ cwd: global.cwd, ...(global.config !== undefined ? { config: global.config } : {}), offline: bools.has("--offline") });
      }
    } finally {
      if (offline === undefined) delete process.env.OPENQODEX_OFFLINE;
      else process.env.OPENQODEX_OFFLINE = offline;
    }
  });

  it("--cwd on a repo that is on, then --cwd on one that is off, sends nothing; the other order sends", async () => {
    const server = await capture();
    const on = box();
    const off = box({ config: `${BASE}openqodex_telemetry: 0\n` });
    seedId(on);
    const offHome = { ...off, home: on.home, oqHome: on.oqHome };
    const r = await runCli([...SCAN, "--cwd", on.repo, "--cwd", off.repo], { cwd: on.root, env: onEnv(offHome, server.url) });
    expect(r.status, r.stderr).toBe(0);
    await sleep(SETTLE_MS);
    expect(server.hits).toEqual([]);
    const control = await capture();
    await runCli([...SCAN, "--cwd", off.repo, "--cwd", on.repo], { cwd: on.root, env: onEnv(on, control.url) });
    await waitFor(() => control.hits.length === 1, 10_000, "the control's request");
  }, 60_000);

  it("--cwd as a link into a subfolder of a repo that is off sends nothing", async () => {
    const server = await capture();
    const off = box({ config: `${BASE}openqodex_telemetry: 0\n`, change: { "sub/db/x.sql": SQL } });
    seedId(off);
    const link = join(off.root, "elsewhere", "link");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(off.repo, "sub"), link);
    const r = await runCli([...SCAN, "--cwd", link], { cwd: off.root, env: onEnv(off, server.url) });
    expect(r.status, r.stderr).toBe(0);
    await sleep(SETTLE_MS);
    expect(server.hits).toEqual([]);
  }, 30_000);
});

// ---------- 1. a global install counts as published ----------

describe("a global npm install, run through its link (failure 1)", () => {
  it("is on by default, while a link to a local build stays off", async () => {
    const server = await capture();
    const b = box();
    const prefix = join(b.root, "prefix");
    copyPackage(join(prefix, "lib", "node_modules", "openqodex"));
    mkdirSync(join(prefix, "bin"), { recursive: true });
    // What npm install -g leaves on macOS and Linux: <prefix>/bin/openqodex links into node_modules.
    symlinkSync(join("..", "lib", "node_modules", "openqodex", "dist", "bin.js"), join(prefix, "bin", "openqodex"));
    symlinkSync(BIN, join(prefix, "bin", "local-build"));
    const env = onEnv(b, server.url, { OPENQODEX_TELEMETRY: undefined });
    const telemetry = async (entry: string) => (JSON.parse((await runCli(["doctor", "--json"], { cwd: b.repo, env, bin: entry })).stdout) as { telemetry: unknown }).telemetry;
    expect(await telemetry(join(prefix, "bin", "openqodex"))).toEqual({ on: true, why: "default" });
    expect(await telemetry(join(prefix, "bin", "local-build"))).toEqual({ on: false, why: "a local build" });
  }, 60_000);
});

// ---------- 19. custom scanner names ----------

describe("a custom scanner's name (failure 19)", () => {
  it("is counted in the scanner fields and never named, nor its failure reason", () => {
    const report = {
      verdict: "passed",
      stats: { files: 1, additions: 1, deletions: 0 },
      findings: [],
      scanners: [
        { scanner: "custom:customerproject", status: "ran", durationMs: 5, reason: null },
        { scanner: "custom:acme-internal", status: "failed", durationMs: 5, reason: "customerproject exited 3 in /home/jdoe/acme" },
        // Configured, but no file it reads changed: it did not run, so it is not counted.
        { scanner: "custom:acme-skipped", status: "no_matching_files", durationMs: 0, reason: null },
        { scanner: "sqllint", status: "failed", durationMs: 3, reason: "customerproject crashed at /home/jdoe/acme" },
      ],
    } as unknown as Report;
    const props = scanProps({ report, exitCode: 0, candidates: 0, demo: false, reportDir: false, blockOnFlag: false });
    const event = validate({ ...ENVELOPE, event: "scan.completed", properties: props });
    expect(event).not.toBeNull();
    const wire = JSON.stringify(event);
    for (const canary of ["customerproject", "acme", "jdoe", "custom:"]) expect(wire).not.toContain(canary);
    expect(event!.properties).toMatchObject({ customScanners: 2, customScannersFailed: 1, scannersFailed: ["sqllint"] });
    expect(Object.keys(event!.properties.scannerFailures as object)).toEqual(["sqllint"]);
  });
});

// ---------- 15. model names ----------

describe("model names (failure 15)", () => {
  it("every public model passes as itself, its Bedrock and Vertex forms as the model, anything else as other", () => {
    for (const m of PUBLIC_MODELS) expect(canonicalModel(m), m).toBe(m);
    for (const m of PUBLIC_MODELS.filter((x) => x.startsWith("claude-"))) {
      for (const form of [`anthropic.${m}-20250929-v1:0`, `us.anthropic.${m}-v1:0`, `global.anthropic.${m}-v1`, `${m}@20250929`, `${m}-20250929`, `${m}[1m]`]) expect(canonicalModel(form), form).toBe(m);
    }
    expect(canonicalModel("sonnet[1m]")).toBe("sonnet");
    expect(canonicalModel("openai/gpt-5.5")).toBe("gpt-5.5");
    for (const other of ["gpt-42", "claude-opus-9-9", "customerproject", "acme-internal-sonnet", "claude-acme-4-5", "ft:gpt-4o-mini-2024-07-18:acme::abc123", "us.anthropic.claude-acme-4-5-v1:0", "", 42, null]) {
      expect(canonicalModel(other), String(other)).toBe("other");
    }
  });

  it("a review with no model asked and none named sends default and unknown; two named send mixed", async () => {
    const unnamed = await capture();
    const a = box({ change: NOTES });
    const ra = await runCli(REVIEW, { cwd: a.repo, env: onEnv(a, unnamed.url, { PATH: withClaude(standIn()) }) });
    expect(ra.status, ra.stderr).toBe(0);
    await waitFor(() => unnamed.hits.length > 0, 10_000, "the review's request");
    // failure 16: a normal review is counted once, with its command.
    expect(named(unnamed, "review.completed")).toHaveLength(1);
    expect(named(unnamed, "command.completed")).toHaveLength(1);
    expect(named(unnamed, "review.completed")[0]!.properties).toMatchObject({ ended: "finished", cleanupFailed: false, modelRequested: "default", modelReported: "unknown", reviewer: "claude", reviewerVersion: "2.1.289" });

    const two = await capture();
    const b = box({ change: NOTES });
    const rb = await runCli(REVIEW, { cwd: b.repo, env: onEnv(b, two.url, { PATH: withClaude(standIn({ models: ["claude-opus-5-5", "claude-haiku-4-5"] })) }) });
    expect(rb.status, rb.stderr).toBe(0);
    await waitFor(() => two.hits.length > 0, 10_000, "the review's request");
    expect(named(two, "review.completed")[0]!.properties).toMatchObject({ modelRequested: "default", modelReported: "mixed" });
  }, 120_000);
});

// ---------- 16. a review is counted once, after its cleanup ----------

describe("counting reviews (failure 16)", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a cleanup that fails for real is finished, cleanupFailed and exit 2, counted once", async () => {
    const server = await capture();
    const b = box({ change: NOTES });
    const checkouts = join(b.oqHome, "checkouts");
    const path = withClaude(standIn({ first: `require('node:fs').chmodSync(${JSON.stringify(checkouts)}, 0o555);` }));
    try {
      const r = await runCli(REVIEW, { cwd: b.repo, env: onEnv(b, server.url, { PATH: path }) });
      expect(r.status, r.stderr).toBe(2);
    } finally {
      chmodSync(checkouts, 0o755);
    }
    await waitFor(() => server.hits.length > 0, 10_000, "the review's request");
    await sleep(500);
    const review = named(server, "review.completed");
    expect(review).toHaveLength(1);
    expect(review[0]!.properties).toMatchObject({ ended: "finished", cleanupFailed: true, exitCode: 2 });
    const command = named(server, "command.completed");
    expect(command).toHaveLength(1);
    expect(command[0]!.properties).toMatchObject({ exitCode: 2, threw: true });
  }, 90_000);

  it("a review with no reviewer is counted once, as unavailable", async () => {
    const server = await capture();
    const b = box({ change: NOTES });
    await runCli(REVIEW, { cwd: b.repo, env: onEnv(b, server.url) });
    await waitFor(() => server.hits.length > 0, 10_000, "the review's request");
    await sleep(500);
    expect(named(server, "review.completed")).toHaveLength(1);
    expect(named(server, "review.completed")[0]!.properties.ended).toBe("unavailable");
    expect(named(server, "command.completed")).toHaveLength(1);
  }, 60_000);

  it("init with a first review counts the review once and the command once", async () => {
    const server = await capture();
    const b = box({ change: NOTES });
    const r = await runCli(["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { cwd: b.repo, env: onEnv(b, server.url, { PATH: withClaude(standIn()) }) });
    expect(r.status, r.stderr).toBe(0);
    await waitFor(() => named(server, "command.completed").length > 0, 10_000, "init's command event");
    await sleep(SETTLE_MS);
    expect(named(server, "review.completed")).toHaveLength(1);
    expect(named(server, "review.completed")[0]!.properties).toMatchObject({ fromInit: true, ended: "finished" });
    expect(named(server, "init.first_review")).toHaveLength(1);
    expect(named(server, "init.completed")).toHaveLength(1);
    expect(named(server, "command.completed")).toHaveLength(1);
  }, 90_000);

  it("a handed-off finalize: the child sends the review with its version, the parent the command", async () => {
    const server = await capture();
    const b = box({ change: NOTES });
    seedId(b);
    // A second runtime, as the updater leaves one: this package with its version string changed.
    const other = `${VERSION.split(".").slice(0, 2).join(".")}.99`;
    const runtime = join(b.oqHome, "runtime", other);
    copyPackage(runtime);
    const copy = join(runtime, "dist", "bin.js");
    writeFileSync(copy, readFileSync(copy, "utf8").replaceAll(`"${VERSION}"`, `"${other}"`));
    // The brief, written by the other version, with usage data off.
    const brief = await runCli(["review", "--agent", "--no-install", "--no-graph", "--only", "sqllint"], { cwd: b.repo, env: onEnv(b, server.url, { OPENQODEX_TELEMETRY: "0" }), bin: copy });
    expect(brief.status, brief.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(b.repo, ".openqodex/latest.json"), "utf8")) as { dir: string };
    const dir = join(b.repo, latest.dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { change_id: string; runtime_version: string };
    expect(manifest.runtime_version).toBe(other);
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { candidates: { id: string }[] };
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify({ version: 1, change_id: manifest.change_id, summary: "Looked at the change", reviewer: "subagent", findings: [], dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })) }));
    const r = await runCli(["review", "--finalize"], { cwd: b.repo, env: onEnv(b, server.url) });
    expect(r.status, r.stderr).toBe(0);
    await waitFor(() => server.hits.length >= 2, 10_000, "the parent's and the child's requests");
    await sleep(SETTLE_MS);
    const review = named(server, "review.completed");
    expect(review).toHaveLength(1);
    expect(review[0]!.properties).toMatchObject({ mode: "agent", openqodexVersion: other });
    const command = named(server, "command.completed");
    expect(command).toHaveLength(1);
    expect(command[0]!.properties).toMatchObject({ command: "review", sub: "finalize", openqodexVersion: VERSION, exitCode: 0 });
  }, 120_000);
});

// ---------- 17. the feedback question ----------

describe("the feedback question after an internal error (failure 17)", () => {
  it("the command event leaves before the answer, and its duration leaves out the wait", async () => {
    const marker = join(realpathSync(tempDir("oq-tel-marker-")), "arrived");
    const server = await capture("ok", marker);
    const b = box();
    seedId(b);
    const waitMs = 2000;
    // The answer is typed only once the request has arrived, then after a wait.
    // The marker's path reaches the shell through the environment, so no character in it can break the script.
    const wait = `i=0; while [ ! -f "$OPENQODEX_TEST_FEEDBACK_MARKER" ]; do i=$((i+1)); [ $i -gt 200 ] && exit 1; sleep 0.1; done; sleep ${waitMs / 1000}`;
    const started = Date.now();
    const r = await pty(b.repo, onEnv(b, server.url, { OPENQODEX_TEST_FEEDBACK_MARKER: marker }), [...SCAN, "--output", join(b.root, "missing", "out.txt")], [["Choose 1 or 2", "2", wait]]);
    const elapsed = Date.now() - started;
    expect(r.status, r.stdout).toBe(2);
    const command = named(server, "command.completed");
    expect(command).toHaveLength(1);
    expect(command[0]!.properties).toMatchObject({ threw: true, errorKind: "internal", exitCode: 2 });
    // The run lasted at least the wait longer than the command it measured,
    // however slow the scan was.
    expect(command[0]!.properties.durationMs as number).toBeLessThan(elapsed - waitMs);
  }, 90_000);
});

// ---------- 4. values built from what was typed or found ----------

describe("values built from text (failure 4)", () => {
  it("the error's place comes from a stack frame only, never from digits the message quotes", () => {
    // parseFlags quotes what was typed in its message; here it looks like a place in the bundle.
    const typed = new Error("unknown flag: --x\nsee /home/u4242/bin.js:4242:77");
    expect(commandProps({ command: "scan", args: [], exitCode: 2, durationMs: 1, error: typed, threw: true, interrupted: false })).not.toHaveProperty("errorLine");
    const real = new Error("two\nlines /x/bin.js:1:2");
    real.stack = "Error: two\nlines /x/bin.js:1:2\n    at run (/opt/openqodex/dist/bin.js:10:20)\n    at /opt/openqodex/dist/bin.js:30:40";
    expect(commandProps({ command: "scan", args: [], exitCode: 2, durationMs: 1, error: real, threw: true, interrupted: false })).toMatchObject({ errorLine: 10, errorColumn: 20 });
  });

  it("a version is taken only from a word shaped like one, never from digits in a path", () => {
    expect(versionOf("2.1.289 (Claude Code)")).toBe("2.1.289");
    expect(versionOf("codex-cli 0.46.0")).toBe("0.46.0");
    expect(versionOf("v1.2")).toBe("1.2.0");
    expect(versionOf("cursor-agent 2025.09.18-7ae6800")).toBe("2025.9.18");
    for (const text of ["/Users/12345/.local/bin/claude", "/opt/claude-2.1.0/bin/claude", "build 42", "acmebuild (Claude Code)", "", 7]) expect(versionOf(text), String(text)).toBe("unknown");
  });

  it("the format is the one the command used, and the flags include every flag of the CLI", () => {
    const format = (args: string[]) => commandProps({ command: "scan", args, exitCode: 0, durationMs: 1, threw: false, interrupted: false }).format;
    expect(format(["--format", "markdown", "--format", "json"])).toBe("json");
    expect(format(["--format=sarif"])).toBe("sarif");
    expect(format(["--json"])).toBe("json");
    expect(format(["--", "--format", "json"])).toBe("terminal");
    expect(format([])).toBe("terminal");
    const flags = commandProps({ command: "graph", args: ["callers", "x", "--depth", "2", "--generation", "g1", "--budget-ms=100", "--json"], exitCode: 0, durationMs: 1, threw: false, interrupted: false }).flags;
    expect(flags).toEqual(["--depth", "--generation", "--budget-ms", "--json"]);
  });

  it("one public model under two spellings is that model; two names off the list are mixed", () => {
    const base = { mode: "reviewer", scope: "change", fromInit: false, ended: "finished", cleanupFailed: false, exitCode: 0, reviewer: "claude" } as const;
    expect(reviewProps({ ...base, modelsReported: ["claude-opus-5-5", "anthropic/claude-opus-5-5-20251101"] }).modelReported).toBe("claude-opus-5-5");
    expect(reviewProps({ ...base, modelsReported: ["claude-opus-5-5", "claude-haiku-4-5"] }).modelReported).toBe("mixed");
    expect(reviewProps({ ...base, modelsReported: ["acme-a", "acme-b"] }).modelReported).toBe("mixed");
    expect(reviewProps({ ...base, modelsReported: ["acme-a", "acme-a"] }).modelReported).toBe("other");
  });

  it("a host that ends in ? or # still gets the request at /batch/ on its path", () => {
    for (const host of ["http://127.0.0.1:9/?", "http://127.0.0.1:9/#", "http://127.0.0.1:9//"]) expect(telemetryTarget({ OPENQODEX_TELEMETRY_HOST: host })?.host, host).toBe("http://127.0.0.1:9");
    expect(telemetryTarget({ OPENQODEX_TELEMETRY_HOST: "https://relay.invalid/ph/" })?.host).toBe("https://relay.invalid/ph");
    expect(telemetryTarget({ OPENQODEX_TELEMETRY_HOST: "https://relay.invalid/?x=1" })).toBeNull();
  });

  it("graph names its question as the sub-command when a flag comes first", async () => {
    const server = await capture();
    const b = box();
    seedId(b);
    const r = await runCli(["graph", "--cwd", b.repo, "help"], { cwd: b.root, env: onEnv(b, server.url) });
    expect(r.status, r.stderr).toBe(0);
    await waitFor(() => server.hits.length === 1, 10_000, "the request");
    expect(named(server, "command.completed")[0]!.properties).toMatchObject({ command: "graph", sub: "help" });
  }, 30_000);
});
