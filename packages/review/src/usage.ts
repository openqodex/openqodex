// What the brain records about a model reviewer's work, shared by the loop
// that records it (model-loop.ts) and the completion record and usage
// rendering built from it. Every value here comes from the brain's own
// measurements: the requests it built, the tool calls it ran and the usage
// each response carried. Nothing comes from what the reviewer says it did.
import type { Coverage, TraceEntry } from "@openqodex/core";

// Which reviewer of the review made a call: the primary, or the second
// reviewer a host may add (step 4).
export type ReviewerRole = "primary" | "second";

// Why a model call was made: for the brief (and the tool calls that answer
// it), for a correction round (and its tool calls), or any call of the
// second reviewer.
export type ModelPurpose = "brief" | "correction" | "second";

// One model attempt, as the brain measured it. `outcome`: "ok" when the
// reviewer returned a response, "failed" when the call threw (or was still
// running when the review stopped), "refused" when the host's budget said
// no and nothing was sent. Tokens and cost are what the response reported;
// null when the attempt returned no response, and for an agent round when
// its driver cannot measure them. `model` is the model asked for; null only
// for an agent round whose driver cannot name one. `attempt` is always 1:
// the contract allows one transport attempt per call and no retry.
export type CallRecord = {
  callId: string;
  reviewer: ReviewerRole;
  purpose: ModelPurpose;
  attempt: 1;
  model: string | null;
  servedModel?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  outcome: "ok" | "failed" | "refused";
  durationMs: number;
};

// The calls added up. `invoked`: calls handed to the transport (ok or
// failed). Tokens and cost are summed over every call that reported usage:
// each one that returned a response, and each failed one that still
// reported what it used (an agent round whose result event was an error).
// A failed call that reported nothing (a transport that threw) is unknown to
// the brain and not in the sums. A sum is null when a counted call could
// not report that part (an agent driver that does not know), and `costUsd`
// is null unless every counted call reported a cost: an unknown is never
// added as zero.
export type UsageTotals = {
  attempts: number;
  invoked: number;
  failed: number;
  refused: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
};

// A failed call that reported any usage, as an agent round can.
const reported = (c: CallRecord) => c.inputTokens !== null || c.outputTokens !== null || (c.costUsd !== undefined && c.costUsd !== null);

export function usageTotals(calls: readonly CallRecord[]): UsageTotals {
  const ok = calls.filter((c) => c.outcome === "ok" || (c.outcome === "failed" && reported(c)));
  const sum = (pick: (c: CallRecord) => number | null | undefined): number | null => {
    let total = 0;
    for (const c of ok) {
      const v = pick(c);
      if (v === null || v === undefined) return null;
      total += v;
    }
    return total;
  };
  return {
    attempts: calls.length,
    invoked: calls.filter((c) => c.outcome !== "refused").length,
    failed: calls.filter((c) => c.outcome === "failed").length,
    refused: calls.filter((c) => c.outcome === "refused").length,
    inputTokens: sum((c) => c.inputTokens),
    outputTokens: sum((c) => c.outputTokens),
    cacheReadTokens: ok.reduce((n, c) => n + (c.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: ok.reduce((n, c) => n + (c.cacheWriteTokens ?? 0), 0),
    costUsd: sum((c) => c.costUsd),
  };
}

// One tool call of a model reviewer, as the brain ran it. The TraceEntry
// fields mean what they mean for an agent: `path` relative to the snapshot
// when `inside`, `range` the first and last line the result carried (after
// any cut). `inside` is false for a path that leaves the snapshot, and null
// for a call that names no tool the brain defined (there is no path to
// place). `ok` is false for a refusal.
//   served     always true: a result, a refusal included, went into the
//              transcript
//   delivered  true once a later request carrying that result was handed
//              to the transport; a result served after the last request
//              never reached the model and counts for nothing
//   inScope    null while the review has no folder scopes; else whether the
//              path the call asked for is inside them (tools/index.ts)
//   reason     why the call was refused or its result cut; null when the
//              result was served whole
//   callId     the model call whose reply asked for the tool
//   toolCallId the tool call's own id in that reply
//   bytes      the size of the result text served
export type ToolLogEntry = TraceEntry & {
  served: true;
  delivered: boolean;
  inScope: boolean | null;
  reason: string | null;
  callId: string;
  toolCallId: string;
  bytes: number;
};

// Everything the model completion record is built from, for one model
// reviewer's conversation. `coverage` follows today's readCoverage rules,
// fed by the delivery log: the brief's diff counts only when a request
// carrying the brief was invoked (`briefSent`), a correction round's ranges
// only when the request carrying them was invoked, and a read_file result
// only when `delivered`. `tools`: the tool names the brain defined; a call
// to any other name is in `toolLog` with `inside: null`. `failure`: why the
// conversation ended without an answer that could be checked (a budget
// refusal reads "budget refused before <purpose> call <n>").
export type ModelReviewEvidence = {
  reviewer: ReviewerRole;
  model: string;
  changeId: string;
  snapshot: { tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  coverage: Coverage;
  briefSent: boolean;
  toolLog: ToolLogEntry[];
  attempts: CallRecord[];
  // Answers asked for: the brief plus the correction rounds.
  rounds: number;
  submissionErrors: string[];
  failure: string | null;
  tools: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
};
