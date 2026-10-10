// The usage of an agent reviewer, one record per round: the brief, then
// each correction round. A driver reports one running total per session
// (Turn.usage), so a round's tokens and cost are what its total added to the
// one before. What a driver cannot measure stays null: Codex reports no
// cost and names no model, and Claude Code names its models only in its
// result event (modelUsage). No model name is ever made up. The totals the
// report prints (ReviewerRecord.usage) are not touched.
import type { ReviewerUsage } from "@openqodex/core";
import type { ReviewerSession, Turn } from "./agents/driver.js";
import type { CallRecord } from "./usage.js";

const NONE: ReviewerUsage = { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null };

// What a running total added since `before`: null when the driver reported
// no total, and when the total went down, which a running total cannot do.
function added(now: number | null, before: number | null): number | null {
  if (now === null) return null;
  const d = now - (before ?? 0);
  return d < 0 ? null : d;
}

// The record of round `round` (from 1), from the total before it and the turn it ended with.
export function agentRoundCall(args: { driver: string; round: number; before: ReviewerUsage; turn: Turn; durationMs: number }): CallRecord {
  const models = args.turn.models ?? [];
  return {
    callId: `${args.driver}-${args.round}`,
    reviewer: "primary",
    purpose: args.round === 1 ? "brief" : "correction",
    attempt: 1,
    model: models.length === 0 ? null : [...models].sort().join(", "),
    inputTokens: added(args.turn.usage.input_tokens, args.before.input_tokens),
    outputTokens: added(args.turn.usage.output_tokens, args.before.output_tokens),
    costUsd: added(args.turn.usage.cost_usd, args.before.cost_usd),
    outcome: args.turn.failure === null ? "ok" : "failed",
    durationMs: args.durationMs,
  };
}

// `session` with each answer it gives recorded as a round. The turns go back
// to the caller unchanged. A turn that arrives after the conversation gave
// up on it (its deadline passed and the session was closed) is still
// recorded, as failed.
export function meterSession(session: ReviewerSession, opts: { driver: string; now: () => number }): { session: ReviewerSession; calls(): CallRecord[] } {
  const calls: CallRecord[] = [];
  let before = NONE;
  const metered: ReviewerSession = {
    pid: session.pid,
    async send(text: string): Promise<Turn> {
      const started = opts.now();
      const turn = await session.send(text);
      calls.push(agentRoundCall({ driver: opts.driver, round: calls.length + 1, before, turn, durationMs: opts.now() - started }));
      before = turn.usage;
      return turn;
    },
    close: () => session.close(),
    ...(session.kill ? { kill: () => session.kill?.() } : {}),
  };
  return { session: metered, calls: () => [...calls] };
}
