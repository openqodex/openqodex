// The Codex driver, fed a real recorded run. The fixture
// (fixtures/codex-stream.jsonl) is the --json output of one short real
// `codex exec` run with the driver's command line and web search on
// (codex-cli 0.160.0, 2026-10-04): a failed command, a command that read the
// file, a web search, a first message, the final answer and the usage. The
// snapshot path is written as __SNAPSHOT__. The process that prints it is the
// model provider stand-in: a script that replays recorded lines and exits,
// started by the real driver, read by the real parser.
//
// Ways it could fail, written before the code:
//  1. The final answer is taken from an earlier message, or the usage is lost.
//  2. A message followed by a failed turn counts as an answer.
//  3. A stream that ends with no terminal event counts as an answer.
//  4. A nonzero exit after a finished turn counts as an answer.
//  5. A correction round, which is a new run, does not carry the brief, the
//     previous answer and the correction, in that order.
//  6. The process group is left running after the deadline or after close.
//  7. An answer past the size limit is held and checked.
//  8. Web off still gives the model web search; web on gives shell commands
//     network.
//  9. A token of the developer's, or a variable that ties the reviewer to a
//     running Codex session, reaches the reviewer.
// 10. Inside Codex's own sandbox, detection reports Codex as ready, so the
//     run starts a reviewer that dies at once instead of offering the fallback.
// 11. A Codex older than the tested version is started with flags it may not know.
// 12. A version string that is not numbers (a dev build, a changed format)
//     is accepted, so the tested-version check never applies.
// 13. The sandbox did not confine the reviewer (a renamed or ignored
//     permission key in a newer Codex) and the review starts anyway: the
//     per-run probe read a file outside the snapshot, or wrote inside it.
// 14. A broken sandbox that refuses everything, or a probe that errors or
//     times out, is taken as a confined one.
// 15. The probe, run against the real binary, does not tell the review
//     profile (confined) from a profile that reads everywhere (not confined),
//     or leaves its canary or its files behind.
// 16. A probe that printed the inside file and then died (a signal, a
//     nonzero exit) before it tried the outside read and the write passes.
// 17. A relative or empty PATH entry (".", "", "bin") reaches the reviewer or
//     the probe, so a program committed in the snapshot runs in place of a
//     system one (a `cat` that prints the inside file and skips the rest).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CODEX_TESTED, PROBE_REFUSED, codexArgs, codexDriver, codexEnv, codexVersion, olderThanTested, probeSandbox, probeVerdict } from "@openqodex/review";
import { DEPTH_ENV, findOnPath } from "@openqodex/review";
import { openqodexHomeDir } from "../src/launcher.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const RECORDED = readFileSync(join(here, "fixtures/codex-stream.jsonl"), "utf8");
const lines = RECORDED.trim().split("\n");
const COMPLETED = lines[lines.length - 1]!;

// A stand-in `codex` that reads its whole prompt, saves it, starts a child
// of its own, prints `body` (a JavaScript expression of the text, evaluated
// in the stand-in), then exits with `code`, or stays alive when `code` is null.
function standIn(body: string, code: number | null = 0): string {
  const dir = tempDir("oq-codex-stand-in-");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const { appendFileSync, realpathSync } = require('node:fs');",
      "const snapshot = realpathSync(process.cwd());",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => (prompt += c));",
      "process.stdin.on('end', () => {",
      "  appendFileSync(__filename + '.prompts', JSON.stringify(prompt) + '\\n');",
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "  appendFileSync(__filename + '.pids', `${process.pid} ${child.pid} `);",
      `  process.stdout.write(${body}, () => { ${code === null ? "setInterval(() => {}, 1000);" : `process.exit(${code});`} });`,
      "});",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsOf = (bin: string) => (existsSync(`${bin}.pids`) ? readFileSync(`${bin}.pids`, "utf8").trim().split(" ").map(Number) : []);
const promptsOf = (bin: string) => readFileSync(`${bin}.prompts`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
const snap = () => realpathSync(tempDir("oq-codex-snap-"));
const settle = () => new Promise((done) => setTimeout(done, 200));

async function runOnce(bin: string, deadlineMs = 30_000) {
  const session = codexDriver.start({ snapshotDir: snap(), deadline: Date.now() + deadlineMs, bin, web: false });
  const turn = await session.send("Review this.");
  await session.close();
  await settle();
  return { turn, pids: pidsOf(bin) };
}

const text = (s: string) => JSON.stringify(s);

describe("the Codex stream reader, on a recorded run", () => {
  it("1. takes the last message as the answer, the usage from turn.completed, and the commands and search the stream shows", async () => {
    const bin = standIn(`${text(RECORDED)}.split('__SNAPSHOT__').join(snapshot)`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toBeNull();
    expect(JSON.parse(turn.finalText)).toEqual({ bug: "calc.py's add(a, b) returns a - b instead of a + b, so it subtracts rather than adds.", searched: true });
    expect(turn.usage).toEqual({ turns: 1, input_tokens: 52911, output_tokens: 207, cost_usd: null });
    expect(turn.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["shell", false],
      ["shell", true],
      ["web_search", true],
    ]);
    expect(turn.calls[2]!.input).toEqual({ query: "python operator module add" });
    expect(pids.filter(alive)).toEqual([]);
  });

  it("2. a message followed by a failed turn is no answer", async () => {
    const failed = JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
    const bin = standIn(text([...lines.filter((l) => !l.includes('"turn.completed"')), failed, ""].join("\n")));
    const { turn } = await runOnce(bin);
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/stopped with an error \(stream disconnected/);
  });

  it("3. a stream that ends with no terminal event is no answer", async () => {
    const bin = standIn(text([...lines.filter((l) => !l.includes('"turn.completed"')), ""].join("\n")));
    const { turn } = await runOnce(bin);
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/without finishing its turn/);
  });

  it("4. a nonzero exit after a finished turn is no answer", async () => {
    const bin = standIn(text(RECORDED), 1);
    const { turn } = await runOnce(bin);
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/exited \(exit 1\) before it answered/);
  });

  it("5. a correction round is a new run carrying the brief, the previous answer and the correction, in that order, and the usage adds up", async () => {
    const bin = standIn(text(RECORDED));
    const session = codexDriver.start({ snapshotDir: snap(), deadline: Date.now() + 30_000, bin, web: false });
    const first = await session.send("THE BRIEF");
    const second = await session.send("THE CORRECTION");
    await session.close();
    const prompts = promptsOf(bin);
    expect(prompts[0]).toBe("THE BRIEF");
    const p = prompts[1]!;
    const at = [p.indexOf("THE BRIEF"), p.indexOf(first.finalText), p.indexOf("THE CORRECTION")];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(second.usage).toEqual({ turns: 2, input_tokens: 2 * 52911, output_tokens: 2 * 207, cost_usd: null });
    await settle();
    expect(pidsOf(bin).filter(alive)).toEqual([]);
  });

  it("6. a reviewer that never ends is stopped at the deadline with its whole group", async () => {
    const bin = standIn(text(""), null);
    const { turn, pids } = await runOnce(bin, 1_500);
    expect(turn.failure).toMatch(/timed out/);
    expect(pids.length).toBe(2);
    expect(pids.filter(alive)).toEqual([]);
  });

  it("7. an answer past the limit ends the turn as a failure", async () => {
    const bin = standIn(`JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'a'.repeat(3 * 1024 * 1024) } }) + '\\n' + ${text(COMPLETED)} + '\\n'`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/answer over/);
    expect(turn.finalText).toBe("");
    expect(pids.filter(alive)).toEqual([]);
  }, 60_000);
});

describe("the Codex command line and environment", () => {
  it("8. web off disables web search; web on uses the cached search; shell commands get no network either way", () => {
    const off = codexArgs("/snap", false);
    const on = codexArgs("/snap", true);
    expect(off).toContain('web_search="disabled"');
    expect(on).not.toContain('web_search="disabled"');
    expect(on).toContain('web_search="cached"');
    for (const args of [off, on]) {
      expect(args.join(" ")).not.toMatch(/network/);
      expect(args).toContain('default_permissions="openqodex_review"');
      expect(args[args.indexOf("-C") + 1]).toBe("/snap");
    }
  });

  it("17. relative and empty PATH entries never reach the reviewer", () => {
    expect(codexEnv({ PATH: [".", "", "/usr/bin", "bin", "./x", "/bin"].join(":") }).PATH).toBe("/usr/bin:/bin");
  });

  it("9. the environment keeps what Codex needs and drops tokens and session ties", () => {
    const env = codexEnv({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", GITHUB_TOKEN: "t", OPENAI_API_KEY: "k", CODEX_THREAD_ID: "x", CODEX_SANDBOX: "seatbelt", CLAUDECODE: "1" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", [DEPTH_ENV]: "1" });
  });

  it("11. a Codex older than the tested version is refused", () => {
    expect(olderThanTested("0.159.9")).toBe(true);
    expect(olderThanTested("0.99.0")).toBe(true);
    expect(olderThanTested(CODEX_TESTED)).toBe(false);
    expect(olderThanTested("0.161.0")).toBe(false);
    expect(olderThanTested("1.0.0")).toBe(false);
  });
});

describe("the version check", () => {
  it("12. a version that is not numbers is refused", () => {
    expect(codexVersion("codex-cli 0.160.0\n")).toBe("0.160.0");
    expect(codexVersion("codex-cli dev")).toBeNull();
    expect(codexVersion("")).toBeNull();
    expect(codexVersion("codex-cli 0.160")).toBeNull();
  });
});

describe("the per-run sandbox probe", () => {
  const confined = { insideRead: true, outsideRead: false, wrote: false, finished: true, code: 0, signal: null, error: null };

  it("13. a read outside the snapshot or a write inside it refuses the review", () => {
    expect(probeVerdict(confined)).toBeNull();
    expect(probeVerdict({ ...confined, outsideRead: true })).toMatch(PROBE_REFUSED);
    expect(probeVerdict({ ...confined, wrote: true })).toMatch(PROBE_REFUSED);
  });

  it("16. a probe that did not finish (no completion marker, a nonzero exit or a signal) refuses the review", () => {
    expect(probeVerdict({ ...confined, finished: false })).toMatch(PROBE_REFUSED);
    expect(probeVerdict({ ...confined, code: 1 })).toMatch(PROBE_REFUSED);
    expect(probeVerdict({ ...confined, code: null, signal: "SIGKILL" })).toMatch(PROBE_REFUSED);
  });

  it("14. a sandbox that refuses the inside read, or a probe error or timeout, refuses the review", () => {
    expect(probeVerdict({ ...confined, insideRead: false })).toMatch(PROBE_REFUSED);
    expect(probeVerdict({ ...confined, error: "the probe timed out" })).toMatch(PROBE_REFUSED);
  });

  // The real binary, opt in: skipped without codex, in CI and inside a Codex sandbox.
  const bin = process.env.CI || process.env.CODEX_SANDBOX ? null : findOnPath("codex", []);
  it.skipIf(bin === null)("15. with the real codex, the review profile passes, a profile that reads everywhere fails, and nothing is left behind", async () => {
    const home = openqodexHomeDir();
    const snapshotDir = join(home, "checkouts", `probe-test-${process.pid}`);
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "a.txt"), "inside\n");
    expect(await probeSandbox(bin!, snapshotDir)).toBeNull();
    const open = '{":minimal"="read",":project_roots"="read","/"="read"}';
    expect(await probeSandbox(bin!, snapshotDir, open)).toMatch(PROBE_REFUSED);
    expect(readdirSync(home).filter((n) => n.startsWith(".openqodex-probe"))).toEqual([]);
    expect(readdirSync(snapshotDir)).toEqual(["a.txt"]);
    spawnSync("mv", [snapshotDir, join(process.env.HOME ?? "", ".Trash", `probe-test-${process.pid}-${Date.now()}`)]);
  }, 60_000);
});
