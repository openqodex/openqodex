// The usage of an agent reviewer, one record per round, through the real
// drivers. The `claude` and `codex` programs are model provider stand-ins:
// scripts that answer each message with the events the real agents print,
// started by the real driver and read by its real parser.
//
// Ways it could fail, written before the code:
//  1. A round's record carries the session's running total instead of what
//     that round added, so the rounds add up to more than the session used.
//  2. A value the driver cannot measure (Codex's cost, a total the agent did
//     not report) is recorded as zero instead of null.
//  3. A model name is made up: Codex is given one, or Claude Code's is
//     guessed when its result event names none.
//  4. Claude Code's model name is lost although its result event names it.
//  5. A round that failed is recorded as answered, or not recorded at all.
//  6. Metering changes what the conversation gets back from the driver.
//  7. The totals leave out what a failed round reported it used (a result
//     event that was an error), or count a failed call that reported
//     nothing as zero or as unknown.
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeDriver } from "../src/agents/claude.js";
import { codexDriver } from "../src/agents/codex.js";
import type { Turn } from "../src/agents/driver.js";
import { agentRoundCall, meterSession } from "../src/agent-usage.js";
import { usageTotals } from "../src/usage.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// A stand-in program named `name` whose body runs once per run.
function standIn(name: string, body: string): string {
  const dir = tempDir("oq-usage-stand-in-");
  const bin = join(dir, name);
  writeFileSync(bin, [`#!${process.execPath}`, body, ""].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

// Claude Code: one session, one result event per message, its usage the
// session's running total as Claude Code reports it (modelUsage per model,
// total_cost_usd). `totals` holds each answer's running total.
function claudeStandIn(totals: { model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }[]): string {
  return standIn(
    "claude",
    `const totals = ${JSON.stringify(totals)};
let n = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  const t = totals[n++];
  const modelUsage = t.model === null ? {} : { [t.model]: { inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite, costUSD: t.cost } };
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{}", num_turns: 2, total_cost_usd: t.cost, modelUsage }));
});
setInterval(() => {}, 1000);`,
  );
}

const snapshot = () => realpathSync(tempDir("oq-usage-snap-"));

describe("an agent reviewer's usage, per round", () => {
  it("1, 4, 6. Claude Code: each round is what it added to the running total, under the model its result event named", async () => {
    const bin = claudeStandIn([
      { model: "claude-opus-5-5", input: 4, output: 127, cacheRead: 8379, cacheWrite: 938, cost: 0.0117 },
      { model: "claude-opus-5-5", input: 10, output: 300, cacheRead: 16000, cacheWrite: 1000, cost: 0.03 },
    ]);
    let clock = 1000;
    const metered = meterSession(claudeDriver.start({ snapshotDir: snapshot(), deadline: Date.now() + 30_000, bin, web: false }), { driver: "claude", now: () => (clock += 500) });
    const first = await metered.session.send("Review this.");
    const second = await metered.session.send("Fix these.");
    await metered.session.close();
    // The conversation gets the driver's own turns, running totals and all.
    expect(first.usage).toEqual({ turns: 2, input_tokens: 4 + 8379 + 938, output_tokens: 127, cost_usd: 0.0117 });
    expect(second.usage).toEqual({ turns: 4, input_tokens: 10 + 16000 + 1000, output_tokens: 300, cost_usd: 0.03 });
    const calls = metered.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ callId: "claude-1", reviewer: "primary", purpose: "brief", attempt: 1, model: "claude-opus-5-5", inputTokens: 9321, outputTokens: 127, costUsd: 0.0117, outcome: "ok", durationMs: 500 });
    expect(calls[1]).toMatchObject({ callId: "claude-2", purpose: "correction", model: "claude-opus-5-5", inputTokens: 17010 - 9321, outputTokens: 173, outcome: "ok", durationMs: 500 });
    expect(calls[1]!.costUsd).toBeCloseTo(0.0183, 10);
    const totals = usageTotals(calls);
    expect(totals.inputTokens).toBe(17010);
    expect(totals.outputTokens).toBe(300);
    expect(totals.costUsd).toBeCloseTo(0.03, 10);
  });

  it("3. Claude Code: a result event that names no model leaves the model and the tokens null", async () => {
    const bin = claudeStandIn([{ model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 }]);
    const metered = meterSession(claudeDriver.start({ snapshotDir: snapshot(), deadline: Date.now() + 30_000, bin, web: false }), { driver: "claude", now: Date.now });
    await metered.session.send("Review this.");
    await metered.session.close();
    expect(metered.calls()[0]).toMatchObject({ model: null, inputTokens: null, outputTokens: null, costUsd: 0.01, outcome: "ok" });
  });

  it("2, 3. Codex: tokens per round from its turn events, no cost and no model", async () => {
    const bin = standIn(
      "codex",
      `let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const round = input.includes("Fix these.") ? 2 : 1;
  const emit = (e) => console.log(JSON.stringify(e));
  emit({ type: "thread.started", thread_id: "t" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "a", type: "agent_message", text: "{}" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1000 * round, cached_input_tokens: 0, output_tokens: 100 * round } });
});`,
    );
    const metered = meterSession(codexDriver.start({ snapshotDir: snapshot(), deadline: Date.now() + 30_000, bin, web: false }), { driver: "codex", now: Date.now });
    await metered.session.send("Review this.");
    await metered.session.send("Fix these.");
    await metered.session.close();
    const calls = metered.calls();
    expect(calls.map((c) => [c.callId, c.purpose, c.model, c.inputTokens, c.outputTokens, c.costUsd, c.outcome])).toEqual([
      ["codex-1", "brief", null, 1000, 100, null, "ok"],
      ["codex-2", "correction", null, 2000, 200, null, "ok"],
    ]);
    expect(usageTotals(calls).costUsd).toBeNull();
  });

  it("5. a round that failed is recorded as failed, with what its total says it added", () => {
    const before = { turns: 3, input_tokens: 9321, output_tokens: 127, cost_usd: 0.0117 };
    const turn: Turn = { finalText: "", calls: [], usage: before, sessionId: null, failure: "the reviewer timed out and was stopped" };
    expect(agentRoundCall({ driver: "claude", round: 2, before, turn, durationMs: 90_000 })).toMatchObject({ callId: "claude-2", purpose: "correction", outcome: "failed", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 90_000 });
  });

  it("1, 2. a total that is not reported or that went down gives null, never a made-up difference", () => {
    const before = { turns: 1, input_tokens: 500, output_tokens: 50, cost_usd: null };
    const turn: Turn = { finalText: "{}", calls: [], usage: { turns: 2, input_tokens: 400, output_tokens: null, cost_usd: null }, sessionId: null, failure: null };
    expect(agentRoundCall({ driver: "codex", round: 2, before, turn, durationMs: 1 })).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, model: null });
  });
});

describe("the totals of failed calls", () => {
  it("7. add what a failed round reported, and leave out a failed call that reported nothing", () => {
    const base = { reviewer: "primary" as const, purpose: "brief" as const, attempt: 1 as const, model: "claude-opus-5-5", durationMs: 1 };
    const totals = usageTotals([
      { ...base, callId: "claude-1", inputTokens: 1000, outputTokens: 100, costUsd: 0.01, outcome: "ok" },
      // A round whose result event was an error, with what it used.
      { ...base, callId: "claude-2", inputTokens: 500, outputTokens: 50, costUsd: 0.005, outcome: "failed" },
      // A transport that threw: nothing reported.
      { ...base, callId: "claude-3", inputTokens: null, outputTokens: null, outcome: "failed" },
    ]);
    expect(totals).toMatchObject({ attempts: 3, invoked: 3, failed: 2, inputTokens: 1500, outputTokens: 150 });
    expect(totals.costUsd).toBeCloseTo(0.015, 10);
  });
});
