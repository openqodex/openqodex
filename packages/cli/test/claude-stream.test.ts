// The Claude Code driver's stream reader, fed a real recorded run. The
// fixture (fixtures/claude-stream.jsonl) is the stream-json output of one
// short real `claude -p` run with the driver's flags (Claude Code 2.1.289):
// a read inside the folder, a read of /etc/hosts that dontAsk refused, and
// the final answer with its usage. The snapshot path is written as
// __SNAPSHOT__ and put back at run time. The process that prints it is the
// model provider stand-in: a script that replays recorded lines, started by
// the real driver, read by the real parser.
//
// Ways it could fail, written before the code:
//  1. A tool call in the stream is lost, or a read loses what it delivered.
//  2. A tool call the agent's rules refused counts as a successful read.
//  3. The final answer or its usage is not read from the result event.
//  4. One event line with no end, or a huge one, is buffered without a
//     bound, so the review runs out of memory instead of reporting incomplete.
//  5. An answer over the limit, or a trace that keeps growing, is held in
//     memory before any check runs.
//  6. The process group is left running after the driver gives up on it.
//  7. A hook runs inside the reviewer session (a wrapper around the agent
//     or a managed setting adds one) and the review still counts as isolated.
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { claudeDriver, classify } from "@openqodex/review";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const RECORDED = readFileSync(join(here, "fixtures/claude-stream.jsonl"), "utf8");
// The two events a real run printed when a terminal wrapper added a
// SessionStart hook to the reviewer (recorded before hooks were switched off).
const RECORDED_HOOK = readFileSync(join(here, "fixtures/claude-stream-hook.jsonl"), "utf8");

// A stand-in `claude` that waits for the first message on stdin, then prints
// `body` (a JavaScript expression of the lines, evaluated in the stand-in),
// then stays alive with a child of its own until it is killed.
function standIn(body: string): string {
  const dir = tempDir("oq-stand-in-");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const { realpathSync, writeFileSync } = require('node:fs');",
      "const snapshot = realpathSync(process.cwd());",
      "process.stdin.once('data', () => {",
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "  writeFileSync(__filename + '.pids', `${process.pid} ${child.pid}`);",
      `  const out = ${body};`,
      "  process.stdout.write(out);",
      "});",
      "setInterval(() => {}, 1000);",
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

async function runOnce(bin: string) {
  const snapshotDir = realpathSync(tempDir("oq-stream-snap-"));
  const session = claudeDriver.start({ snapshotDir, deadline: Date.now() + 30_000, bin, web: false });
  const turn = await session.send("Review this.");
  await session.close();
  await new Promise((done) => setTimeout(done, 200));
  const pids = readFileSync(`${bin}.pids`, "utf8").split(" ").map(Number);
  return { turn, snapshotDir, pids };
}

describe("the Claude Code stream reader, on a recorded run", () => {
  it("1, 2, 3. reads every tool call, what each read delivered, the refusal, the answer and the usage", async () => {
    const bin = standIn(`${JSON.stringify(RECORDED)}.split('__SNAPSHOT__').join(snapshot)`);
    const { turn, snapshotDir, pids } = await runOnce(bin);
    expect(turn.failure).toBeNull();
    expect(turn.finalText).toBe('{"ok":true}');
    expect(turn.calls.map((c) => [c.tool, c.ok])).toEqual([
      ["Read", true],
      ["Read", false],
    ]);
    expect(turn.calls[0]!.read).toEqual({ path: join(snapshotDir, "calc.py"), start: 1, lines: 3 });
    expect(turn.calls[1]!.read).toBeNull();
    expect(classify(snapshotDir, turn.calls[0]!)).toMatchObject({ path: "calc.py", inside: true, range: [1, 3], ok: true });
    expect(classify(snapshotDir, turn.calls[1]!)).toMatchObject({ path: "/etc/hosts", inside: false, ok: false });
    expect(turn.usage).toEqual({ turns: 3, input_tokens: 4 + 8379 + 938, output_tokens: 127, cost_usd: 0.011735800000000001 });
    expect(turn.sessionId).toBe("36382685-600b-4b4a-963e-5930debfca89");
    expect(pids.filter(alive)).toEqual([]);
  });

  it("7. a hook event in the stream ends the turn as a failure: the reviewer was not isolated", async () => {
    const bin = standIn(`${JSON.stringify(RECORDED_HOOK + RECORDED)}.split('__SNAPSHOT__').join(snapshot)`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/a hook ran in the reviewer session/);
    expect(turn.finalText).toBe("");
    expect(pids.filter(alive)).toEqual([]);
  });

  it("4, 6. an event line past the limit ends the turn as a failure and kills the group", async () => {
    const bin = standIn(`'{"type":"assistant","message":{"content":[{"type":"text","text":"' + 'a'.repeat(40 * 1024 * 1024)`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/event line over/);
    expect(pids.filter(alive)).toEqual([]);
  }, 60_000);

  it("5, 6. an answer past the limit ends the turn as a failure and kills the group", async () => {
    const bin = standIn(`JSON.stringify({ type: 'result', is_error: false, num_turns: 1, result: 'a'.repeat(3 * 1024 * 1024) }) + '\\n'`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/answer over/);
    expect(turn.finalText).toBe("");
    expect(pids.filter(alive)).toEqual([]);
  }, 60_000);

  it("5, 6. a trace that keeps growing past the limit ends the turn as a failure and kills the group", async () => {
    const bin = standIn("Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + i, name: 'Grep', input: { pattern: 'x'.repeat(64 * 1024) } }] } })).join('\\n') + '\\n'");
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/trace over/);
    expect(pids.filter(alive)).toEqual([]);
  }, 60_000);
});
