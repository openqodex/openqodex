// The reviewer contract, version 2 (`reviewerContract`): what reviews a
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
import type { Category, Config, ContextItem, Coverage, Disagreement, ModelCompletionRecord, RuleCitation, RunManifest, RunTimings, ScanResult, Severity } from "@openqodex/core";
import type { ReviewerDriver, Turn } from "./agents/driver.js";
import type { CorrectionRound } from "./conversation.js";
import type { ReviewScope } from "./incremental.js";
import type { CallRecord, ModelPurpose, ModelReviewEvidence, ReviewerRole, ToolLogEntry, UsageTotals } from "./usage.js";

// Version 2 (2026-10-21) widened ReviewerRole with `finder:<unit>:<pass>` and
// `verifier:<n>` and ModelPurpose with `find` and `verify`, for the staged
// review; every record field it added is optional. A host that switches on
// the role or the purpose must accept the new values.
export const reviewerContract = 2;

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
export function agentReviewer(driver: ReviewerDriver, opts: Parameters<ReviewerDriver["start"]>[0]): AgentReviewer {
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
// widen what is flagged and never switch a check off; over 128 KB the call
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

// "nothing_to_review": the head adds no change to review (since the merge
// base, since the previously reviewed commit, or inside the scopes), so no
// reviewer read anything. It is not a clean review: no file was examined.
export type ReviewStatus = "complete" | "complete_blocking" | "incomplete" | "nothing_to_review";

// Why a review is not complete, as one code a host can switch on. The
// review stopped before a reviewer started: "merge_base_unproven" (the
// merge base or the previous review's commit could not be proved),
// "missing_objects" (the clone lacks a tree or a file the review needs),
// "setup_failed" (another step before the reviewer failed), or
// "reviewer_unavailable" (no reviewer could start). The reviewer ran:
// "secret_in_change" (a secret the scanners found was in a file name or a
// changed line, so it was not sent), "brief_too_big" (a part of the change
// does not fit a reviewer's brief beside its fixed blocks: the
// instructions, the context items and the code around the change),
// "boundary_breach" (the snapshot changed, or a tool call went outside the
// snapshot, the scopes or the tools), "budget_refused" (the host's budget
// refused a model call), "deadline_timeout" (the deadline passed),
// "reviewer_failed" (a model call failed, or its reply could not be read),
// "answer_rejected" (the answer still failed its checks after the
// correction rounds), "candidates_not_disposed" (a scanner candidate has no
// disposition) and "range_not_examined" (a changed range was neither shown
// nor read).
export type IncompleteCause =
  | "merge_base_unproven"
  | "missing_objects"
  | "setup_failed"
  | "reviewer_unavailable"
  | "secret_in_change"
  | "brief_too_big"
  | "boundary_breach"
  | "budget_refused"
  | "deadline_timeout"
  | "reviewer_failed"
  | "answer_rejected"
  | "candidates_not_disposed"
  | "range_not_examined";

// `reasonCode`: "nothing_to_review", or the first cause of an incomplete
// review; null for a complete one.
export type ReasonCode = "nothing_to_review" | IncompleteCause;

// What an incomplete review lacks. `causes`: every cause found, the one
// that most decides what to do first (`cause`, as `reasonCode` gives it).
// `retryable`: true when the same call may complete later (a deadline, a
// failed model call, an answer the model may get right next time); false
// when the same inputs fail the same way (a brief too big, a budget the
// host refused, a clone without the objects). `units`: the staged review's
// units that were not examined in full, in order (u1, u2, ...); empty for a
// single pass or when no unit is to blame.
export type IncompleteDetail = { cause: IncompleteCause; causes: IncompleteCause[]; retryable: boolean; units: string[] };

// The code around the change (neighbourhood.ts) as the briefs got it.
// `partial`: the brief says the block is partial. `cause`: "time" (the time
// cap), "bytes" (the packet's byte cap dropped a name the code graph links
// to the change, or a diff page was over its byte budget) or "error" (the
// block could not be built or rendered); null when not partial.
// `droppedLinked`: names the graph links to the change (a touched
// declaration, a certain caller or callee) cut at the byte cap.
// `droppedOther`: names found by text alone cut at the byte cap; they are
// counted, never written in the brief's note.
export type NeighbourhoodStatus = { partial: boolean; cause: "bytes" | "time" | "error" | null; droppedLinked: number; droppedOther: number };

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
  // The lines in other files the finding's evidence rests on; absent when
  // all of it is in the finding's own file.
  evidence?: { file: string; line: number }[];
  // A finding that breaks a written rule of a supplied instruction file.
  rule?: RuleCitation;
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
// the config's block_on_severity, "nothing_to_review" with `reason` when
// the head adds no change to review, else "incomplete" with `reason` and
// `incomplete` (a complete review has no `reason`). `reasonCode`: the
// same, as a code (ReasonCode). `filesExamined` and `hunksExamined`: the
// changed files and changed ranges a reviewer was shown or read, as the
// coverage counts them; 0 when no reviewer ran. `neighbourhood`: how the
// code around the change reached the briefs; null when no reviewer ran. An
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
// `rounds`: every correction round sent, the second reviewer's after the
// primary's (conversation.ts CorrectionRound), redacted like the report.
// `scan`: the scan record, the object the command writes to scan.json (the
// candidates, each scanner's summary, the selection and the trail),
// redacted with every secret the run matched and without the secrets'
// fingerprints, which only the command's own files need; null when the
// review stopped before the scanners ran. `timings`: how long each phase
// took, from the call to the result (RunTimings); the JSON report of a
// review a reviewer was given holds the same object.
export type ReviewResult = {
  status: ReviewStatus;
  reason?: string;
  reasonCode: ReasonCode | null;
  incomplete?: IncompleteDetail;
  filesExamined: number;
  hunksExamined: number;
  neighbourhood: NeighbourhoodStatus | null;
  scope: ReviewScope | null;
  findings: ResultFinding[];
  possible: ResultFinding[];
  dispositions: Disposition[];
  summary: string | null;
  coverage: Coverage | null;
  scannerVersions: Record<string, string | null>;
  trace: ToolLogEntry[];
  usage: { calls: CallRecord[]; totals: UsageTotals };
  rounds: CorrectionRound[];
  evidence: ModelReviewEvidence | null;
  completion: ModelCompletionRecord | null;
  notes: string[];
  disagreements: Disagreement[];
  context: NonNullable<RunManifest["context"]>;
  scan: Omit<ScanResult, "secretFingerprints"> | null;
  timings: RunTimings;
  render: { markdown(): string; sarif(): string; json(): string };
};
