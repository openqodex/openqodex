// The reviewer contract, version 1 (`reviewerContract`): what reviews a
// change for the brain. A reviewer is one of two kinds.
//   agent  a coding agent a driver starts as a process (Claude Code, Codex):
//          it reads the snapshot with its own read-only tools, and the run
//          checks its trace. Today's drivers, unchanged, behind
//          `agentReviewer`.
//   model  a model the host calls through its own client (the server
//          product): the brain owns the loop. It builds every request, runs
//          every tool call with its own five tools over the frozen snapshot,
//          asks the host's budget before every call and records the usage
//          of every response.
// Nothing a reviewer says about itself is proof: what was read, what was
// shown and what was used come from the brain's own records.
import type { Category, Config, ContextItem, Coverage, Disagreement, ModelCompletionRecord, RunManifest, Severity } from "@openqodex/core";
import type { ReviewerDriver, Turn } from "./agents/driver.js";
import type { ReviewScope } from "./incremental.js";
import type { CallRecord, ModelPurpose, ModelReviewEvidence, ReviewerRole, ToolLogEntry, UsageTotals } from "./usage.js";

export const reviewerContract = 1;

// ---------- the model reviewer ----------

// One tool call in a model's reply. `args` is the JSON object the model
// gave; a JSON text holding one object is read as that object.
export type ToolCallRequest = { id: string; name: string; args: unknown };

// A message of the transcript, in no provider's format; the host's client
// maps it to its own. One `tool` message carries the result of one tool
// call, matched by `toolCallId`; `ok` is false when the brain refused the
// call (the text then says why).
export type Message =
  | { role: "system"; text: string }
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; text: string; ok: boolean };

// A tool the brain offers, described by a JSON schema of its arguments.
export type ToolParameter = { type: "string" | "integer"; description: string; minimum?: number };
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, ToolParameter>; required: string[]; additionalProperties: false };
};

// One call to the model. `attempt` is always 1: the host's client makes
// exactly one transport attempt per `complete` and never retries (a retry
// the host hid would be billed and logged as one call). `messages` is the
// whole transcript so far; `tools` the tools the model may call.
export type ModelRequest = {
  callId: string;
  attempt: 1;
  purpose: ModelPurpose;
  messages: Message[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
};

// What the transport returned. A reply with no tool call is the answer.
// `usage` is what the provider reported for this one attempt: `model` the
// model asked for, `servedModel` the one that answered when the provider
// names it, `costUsd` when the host knows it (null or left out when not).
export type ModelUsage = {
  model: string;
  servedModel?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
};
export type ModelResponse = { message: { text: string; toolCalls: ToolCallRequest[] }; usage: ModelUsage };

// The host's model, called once per `complete`, with no prompt, rule,
// filter or retry of its own.
export type ModelReviewer = {
  kind: "model";
  model: string;
  maxOutputTokens: number;
  complete(request: ModelRequest): Promise<ModelResponse>;
};

// ---------- the agent reviewer ----------

// One of today's drivers, started on a snapshot: `send` asks for one answer
// in the same session (the brief, then each correction round) and returns
// the agent's turn; `close` ends its process group. `traced`: the driver's
// trace shows every tool call (Claude Code), so the run checks each path
// and counts reads from it; untraced (Codex), coverage is what the brief and
// the correction rounds carried.
export type AgentReviewer = {
  kind: "agent";
  name: string;
  traced: boolean;
  pid: number | null;
  send(text: string): Promise<Turn>;
  close(): Promise<void>;
  // Ends the process group at once and synchronously, for a signal handler.
  kill?(): void;
};

export type Reviewer = AgentReviewer | ModelReviewer;

// A driver's session behind the agent reviewer shape: the session starts
// here, and every call goes to it unchanged.
export function agentReviewer(driver: ReviewerDriver, opts: { snapshotDir: string; deadline: number; bin: string; web: boolean }): AgentReviewer {
  const session = driver.start(opts);
  const kill = session.kill?.bind(session);
  return {
    kind: "agent",
    name: driver.name,
    traced: driver.traced,
    pid: session.pid,
    send: (text) => session.send(text),
    close: () => session.close(),
    ...(kill ? { kill } : {}),
  };
}

// ---------- the budget ----------

// Asked before every model attempt, with the usage of every attempt so far.
// `false` (or a throw) refuses: nothing is sent, and the whole review ends
// incomplete with the usage so far. `deadlineMs`: how long the review may
// run, in milliseconds from the call to reviewChange. `requestChars`: the
// size of the request about to be sent, the characters of its messages and
// its tool definitions written as JSON, so a host can price the call
// before it is made; with `maxOutputTokens` it bounds what the call costs.
export type AuthorizeRequest = {
  callId: string;
  attempt: 1;
  reviewer: ReviewerRole;
  purpose: ModelPurpose;
  model: string;
  maxOutputTokens: number;
  requestChars: number;
  usageSoFar: UsageTotals;
};
export type Budget = { authorize(call: AuthorizeRequest): Promise<boolean>; deadlineMs: number };

// ---------- reviewChange ----------

// The change to review, in the host's clone. `mergeBaseSha` is the host's
// comparison base (the merge base of the pull request, never the target
// branch's tip); the library proves both are commits in the clone and that
// the merge base is an ancestor of the head, and computes the change itself.
// `config`: the parsed config in force (the defaults when left out).
// `context`: lessons, comments, summaries, notes and earlier findings the
// brief quotes as data (context.ts); an item over 32 KB, items over 128 KB
// together, or a malformed item make the call throw, never cut.
// `instructions`: the repository owners' own rules for the review, as the
// host keeps them: the brief quotes them under the owners' heading with the
// framing the laptop gives .openqodex/custom-instructions.md, so they can
// widen what is flagged and never switch a check off; over 32 KB the call
// throws, never cut. Advisory context belongs in `context`.
// `previousReviewedSha`: the head of the last review; when the clone proves
// it an ancestor of the head, only what changed since is the review's
// obligation, and findings are still anchored on the whole change
// (incremental.ts). `fullReviewRequested`: review the whole change anyway.
// `scopes`: the folders the review stays inside, less review.paths.exclude
// (scopes.ts); left out, the whole repository.
export type ReviewChangeInput = {
  clonePath: string;
  mergeBaseSha: string;
  headSha: string;
  config?: Config;
  previousReviewedSha?: string;
  fullReviewRequested?: boolean;
  scopes?: string[];
  context?: ContextItem[];
  instructions?: string;
};

// `workDir`: the only folder the review writes in (the snapshot and its
// scratch). `installRoot`: the folder the preinstalled scanners are read
// from; nothing is installed. `budget`: required; `authorize` is asked
// before every model call, and `deadlineMs`, counted from the call to
// reviewChange, is checked before each authorize and each transport call. `confidenceFloor`: the lowest confidence a
// finding may have, in the brief and in the check (0.7 when left out); a
// lens's own higher floor still wins. `onProgress`: each progress line.
// `secondReviewer`: a model that reviews the change again after the
// primary, on the same brief and tools, under the same budget (second.ts).
export type ReviewChangeOptions = {
  profile: "server";
  workDir: string;
  installRoot: string;
  budget: Budget;
  confidenceFloor?: number;
  tools: { web: false; shell: false };
  scanners: "preinstalled";
  secondReviewer?: Reviewer;
  onProgress?: (line: string) => void;
};

export type ReviewStatus = "complete" | "complete_blocking" | "incomplete";

// A finding that passed every check. `foundBy`: the names of the reviewers
// that raised it (the model's name), the primary first. `source`: null for
// the reviewer's own finding, a candidate's token, or `lens:<name>`.
// `suggestedChange`: the reviewer's literal replacement for the cited
// lines, or null.
export type ResultFinding = {
  file: string;
  lineStart: number;
  lineEnd: number;
  title: string;
  problem: string;
  consequence: string;
  fix: string;
  suggestedChange: string | null;
  severity: Severity;
  category: Category;
  confidence: number;
  foundBy: string[];
  source: string | null;
  candidate: string | null;
};

// What the reviewer did with one scanner candidate: raised it in a finding,
// or dropped it with a reason and the line that shows why.
export type Disposition = {
  candidate: string;
  token: string;
  file: string;
  line: number;
  outcome: "raised" | "dropped";
  reason: string | null;
  cited: { file: string; line: number } | null;
  by: ReviewerRole;
};

// The review. `status`: "complete" when every condition of a complete
// review holds, "complete_blocking" when it also has a finding at or above
// the config's block_on_severity, else "incomplete" with `reason` (a
// complete review has a `reason` only when there was nothing to review). An
// incomplete review keeps the findings of an answer that passed every
// check. `coverage` and `evidence` are null when the review stopped before
// a reviewer could start (a merge base that could not be proved, nothing
// to review). `evidence`: what the model completion record is built from.
// `scannerVersions`: each scanner that ran and its version. `completion`:
// the model completion record built from `evidence` (model-record.ts), null
// when `evidence` is. `notes`: the second reviewer's failures that leave the
// review complete, and what a scoped review could not hold (a file renamed
// in from outside the scopes, a link or a submodule the snapshot left out,
// a base version outside the scopes that was asked for). `disagreements`: the candidates one reviewer raised and
// the other dropped. `context`: every context item given, in order, as the
// run manifest lists it, with why the brief left one out. `scope`: whether
// the obligation was the delta since the previous review or the whole
// change, and why; null when a proof failed before the decision.
export type ReviewResult = {
  status: ReviewStatus;
  reason?: string;
  scope: ReviewScope | null;
  findings: ResultFinding[];
  dispositions: Disposition[];
  summary: string | null;
  coverage: Coverage | null;
  scannerVersions: Record<string, string | null>;
  trace: ToolLogEntry[];
  usage: { calls: CallRecord[]; totals: UsageTotals };
  evidence: ModelReviewEvidence | null;
  completion: ModelCompletionRecord | null;
  notes: string[];
  disagreements: Disagreement[];
  context: NonNullable<RunManifest["context"]>;
  render: { markdown(): string; sarif(): string; json(): string };
};
