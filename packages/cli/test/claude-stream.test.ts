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
//  8. The output Claude Code saved for the session (a long search result,
//     text of the reviewed code) stays in its configuration folder after the
//     session ends, whether the turn succeeded or failed (issue 95).
//  9. That cleanup removes something that is not this session's output:
//     another session's folder for the same snapshot, a folder of another
//     working folder, a folder whose name only starts like the snapshot's,
//     or what a link in the projects folder points to.
// 10. A model the login cannot use (one that does not exist), a rate limit
//     or an overload reads as any other error, so a project's reviewer list
//     never moves on to its next entry; or a plain error reads as one of
//     them, so the list starts a second full review for nothing. The
//     fixture claude-stream-bad-model.jsonl is the assistant and result
//     events of a real `claude -p --model bogus-model-xyz` run (Claude Code
//     2.1.331, 2026-11-24), its init event left out.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cannotServe, claudeDriver, classify } from "@openqodex/review";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const RECORDED = readFileSync(join(here, "fixtures/claude-stream.jsonl"), "utf8");
// The two events a real run printed when a terminal wrapper added a
// SessionStart hook to the reviewer (recorded before hooks were switched off).
const RECORDED_HOOK = readFileSync(join(here, "fixtures/claude-stream-hook.jsonl"), "utf8");
const RECORDED_BAD_MODEL = readFileSync(join(here, "fixtures/claude-stream-bad-model.jsonl"), "utf8");

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

  it("R2.17 a read whose line came back cut records the bytes it returned", async () => {
    const cut = RECORDED.replace('"content":"def add(a, b):\\n    return a + b\\n"', `"content":"${"x".repeat(2000)}\\nshort\\n"`);
    expect(cut).not.toBe(RECORDED);
    const { turn, snapshotDir } = await runOnce(standIn(`${JSON.stringify(cut)}.split('__SNAPSHOT__').join(snapshot)`));
    expect(turn.calls[0]!.read).toEqual({ path: join(snapshotDir, "calc.py"), start: 1, lines: 3, byteRanges: [{ line: 1, from: 1, to: 2000 }] });
    expect(classify(snapshotDir, turn.calls[0]!)).toMatchObject({ path: "calc.py", range: [1, 3], byteRanges: [{ line: 1, from: 1, to: 2000 }] });
  });
  it("7. a hook event in the stream ends the turn as a failure: the reviewer was not isolated", async () => {
    const bin = standIn(`${JSON.stringify(RECORDED_HOOK + RECORDED)}.split('__SNAPSHOT__').join(snapshot)`);
    const { turn, pids } = await runOnce(bin);
    expect(turn.failure).toMatch(/a hook ran in the reviewer session/);
    expect(turn.finalText).toBe("");
    expect(pids.filter(alive)).toEqual([]);
  });

  it("10. a model that does not exist is a failure the next list entry may take over, with Claude Code's own words", async () => {
    const { turn, pids } = await runOnce(standIn(JSON.stringify(RECORDED_BAD_MODEL)));
    expect(turn.finalText).toBe("");
    expect(turn.failure).toMatch(/^the reviewer's model cannot serve this review: it does not exist or this login has no access to it \(There's an issue with the selected model \(bogus-model-xyz\)\. It may not exist or you may not have access to it\. model_not_found not_found_error\)$/);
    expect(cannotServe(turn.failure)).toBe(true);
    expect(pids.filter(alive)).toEqual([]);
  });

  it("10. a rejected rate limit and an overload are failures the next entry may take over; a plain error is not", async () => {
    const result = (text: string, type: string | null) => JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: text, ...(type ? { api_error_type: type } : {}) });
    const limited = [JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }), result("Claude AI usage limit reached|1764000000", null), ""].join("\n");
    expect((await runOnce(standIn(JSON.stringify(limited)))).turn.failure).toMatch(/^the reviewer hit /);
    const overloaded = [result("API Error: 529 Overloaded", "overloaded_error"), ""].join("\n");
    const turn = (await runOnce(standIn(JSON.stringify(overloaded)))).turn;
    expect(turn.failure).toMatch(/^the reviewer's model cannot serve this review: it is overloaded/);
    expect(cannotServe(turn.failure)).toBe(true);
    const plain = [result("Execution error", null), ""].join("\n");
    const other = (await runOnce(standIn(JSON.stringify(plain)))).turn;
    expect(other.failure).toMatch(/^the reviewer stopped with an error \(Execution error/);
    expect(cannotServe(other.failure)).toBe(false);
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

// Claude Code's name for a working folder under <configuration folder>/projects,
// as its 2.1.296 code writes it: every character other than a letter or a
// digit becomes "-". The stand-in saves there the way Claude Code does.
const claudeProjectName = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");
const SESSION = "36382685-600b-4b4a-963e-5930debfca89";
const SAVE = [
  "(() => {",
  "  const { mkdirSync } = require('node:fs');",
  "  const dir = require('node:path').join(process.env.CLAUDE_CONFIG_DIR, 'projects', snapshot.replace(/[^a-zA-Z0-9]/g, '-'), " + JSON.stringify(SESSION) + ", 'tool-results');",
  "  mkdirSync(dir, { recursive: true });",
  "  writeFileSync(require('node:path').join(dir, 'toolu_1.txt'), 'def add(a, b):');",
  "})()",
].join("\n");

describe("the output Claude Code saved for the session", () => {
  afterEach(() => vi.unstubAllEnvs());

  // A configuration folder and a home folder of the test's own, never the developer's.
  function config(): string {
    const home = tempDir("oq-claude-home-");
    const dir = join(home, "claude-config");
    mkdirSync(join(dir, "projects"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    return dir;
  }
  const keep = (path: string) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), "not this session's");
    return join(path, "keep.txt");
  };

  it("8. is removed with the snapshot's project folder when the session closes", async () => {
    const cfg = config();
    const bin = standIn(`(${SAVE}, ${JSON.stringify(RECORDED)}.split('__SNAPSHOT__').join(snapshot))`);
    const { turn, snapshotDir } = await runOnce(bin);
    expect(turn.failure).toBeNull();
    expect(turn.sessionId).toBe(SESSION);
    expect(existsSync(join(cfg, "projects", claudeProjectName(snapshotDir)))).toBe(false);
    expect(existsSync(join(cfg, "projects"))).toBe(true);
  });

  it("8. is removed from a relative CLAUDE_CONFIG_DIR, which the agent reads from the snapshot", async () => {
    config();
    vi.stubEnv("CLAUDE_CONFIG_DIR", "relative-config");
    const bin = standIn(`(${SAVE}, ${JSON.stringify(RECORDED)}.split('__SNAPSHOT__').join(snapshot))`);
    const { turn, snapshotDir } = await runOnce(bin);
    expect(turn.failure).toBeNull();
    expect(existsSync(join(snapshotDir, "relative-config", "projects")), "the stand-in saved there").toBe(true);
    expect(existsSync(join(snapshotDir, "relative-config", "projects", claudeProjectName(snapshotDir)))).toBe(false);
  });

  it("8. is removed also when the turn failed", async () => {
    const cfg = config();
    const failed = RECORDED.replace('"is_error":false,"num_turn', '"is_error":true,"num_turn');
    expect(failed).not.toBe(RECORDED);
    const bin = standIn(`(${SAVE}, ${JSON.stringify(failed)}.split('__SNAPSHOT__').join(snapshot))`);
    const { turn, snapshotDir } = await runOnce(bin);
    expect(turn.failure).toMatch(/the reviewer stopped with an error/);
    expect(existsSync(join(cfg, "projects", claudeProjectName(snapshotDir), SESSION))).toBe(false);
  });

  it("8. is removed also when the review is interrupted: kill alone, before the host exits", async () => {
    const cfg = config();
    const bin = standIn(`(${SAVE}, ${JSON.stringify(RECORDED)}.split('__SNAPSHOT__').join(snapshot))`);
    const snapshotDir = realpathSync(tempDir("oq-stream-snap-"));
    const session = claudeDriver.start({ snapshotDir, deadline: Date.now() + 30_000, bin, web: false });
    const turn = await session.send("Review this.");
    expect(existsSync(join(cfg, "projects", claudeProjectName(snapshotDir), SESSION)), "the stand-in saved").toBe(true);
    // The stop handler calls kill and exits the process right after: no close runs.
    session.kill!();
    expect(turn.sessionId).toBe(SESSION);
    expect(existsSync(join(cfg, "projects", claudeProjectName(snapshotDir)))).toBe(false);
  });

  it("9. leaves another session's folder, another working folder's and a look-alike name", async () => {
    const cfg = config();
    const projects = join(cfg, "projects");
    const bin = standIn(`(${SAVE}, ${JSON.stringify(RECORDED)}.split('__SNAPSHOT__').join(snapshot))`);
    // The snapshot's folder name is known only once the run made it, so the
    // neighbours are made by the stand-in's first message, before it saves.
    const snapshotDir = realpathSync(tempDir("oq-stream-snap-"));
    const name = claudeProjectName(snapshotDir);
    const kept = [
      keep(join(projects, name, "another-session", "tool-results")),
      keep(join(projects, "-some-other-folder", SESSION, "tool-results")),
      keep(join(projects, `${name}-x`, SESSION, "tool-results")),
      keep(join(projects, name.slice(0, -1), SESSION, "tool-results")),
    ];
    const session = claudeDriver.start({ snapshotDir, deadline: Date.now() + 30_000, bin, web: false });
    const turn = await session.send("Review this.");
    await session.close();
    expect(turn.failure).toBeNull();
    expect(existsSync(join(projects, name, SESSION))).toBe(false);
    for (const path of kept) expect(existsSync(path), path).toBe(true);
  });

  it("9. leaves what a linked project folder points to", async () => {
    const cfg = config();
    const projects = join(cfg, "projects");
    const outside = tempDir("oq-claude-outside-");
    const kept = keep(join(outside, SESSION, "tool-results"));
    const snapshotDir = realpathSync(tempDir("oq-stream-snap-"));
    symlinkSync(outside, join(projects, claudeProjectName(snapshotDir)));
    // The stand-in saves through the link, as Claude Code would.
    const bin = standIn(`(${SAVE}, ${JSON.stringify(RECORDED)}.split('__SNAPSHOT__').join(snapshot))`);
    const session = claudeDriver.start({ snapshotDir, deadline: Date.now() + 30_000, bin, web: false });
    const turn = await session.send("Review this.");
    await session.close();
    expect(turn.failure).toBeNull();
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(join(outside, SESSION, "tool-results", "toolu_1.txt"))).toBe(true);
  });
});
