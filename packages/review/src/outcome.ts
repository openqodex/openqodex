// Why a model review is not complete, as codes a host can act on
// (reviewer.ts IncompleteDetail), read from what the brain measured: the
// staged review's own record of each unit and batch it could not finish,
// the model attempts, the conversation's failure, the snapshot's hashes,
// the tool log, the candidates, the answer's checks and the coverage.
// Nothing here changes whether a review is complete; it only says why not.
import { TIMED_OUT } from "./agents/driver.js";
import type { IncompleteCause, IncompleteDetail } from "./reviewer.js";
import type { CallRecord, ModelReviewEvidence } from "./usage.js";

// One cause the staged review recorded, with the unit it belongs to (none
// for a verifier batch or the review as a whole).
export type StagedCause = { cause: IncompleteCause; unit?: string };

// The order `cause` is chosen in: a cause the same call cannot get past
// first, then the ones a rerun may clear, and last the unread ranges, which
// most other causes leave behind them.
const ORDER: readonly IncompleteCause[] = [
  "merge_base_unproven",
  "missing_objects",
  "setup_failed",
  "reviewer_unavailable",
  "secret_in_change",
  "brief_too_big",
  "boundary_breach",
  "budget_refused",
  "deadline_timeout",
  "reviewer_failed",
  "answer_rejected",
  "candidates_not_disposed",
  "range_not_examined",
];

// The causes a later run with the same inputs may get past.
const RETRYABLE: ReadonlySet<IncompleteCause> = new Set(["deadline_timeout", "reviewer_failed", "answer_rejected", "candidates_not_disposed", "range_not_examined"]);

// The cause of one failure line a conversation or a session ended with.
// The lines are the brain's own (model-loop.ts, conversation.ts,
// stages.ts, units.ts); `timedOut` is the line a host gave for its cap.
export function failureCause(line: string, timedOut?: string): IncompleteCause {
  if (line === TIMED_OUT || (timedOut !== undefined && line === timedOut) || /time ran out|did not finish in time/.test(line)) return "deadline_timeout";
  if (/^(?:the second reviewer: )?budget refused before |^the budget refused/.test(line)) return "budget_refused";
  if (/secret the scanners found/.test(line)) return "secret_in_change";
  if (/MAX_BRIEF_BYTES/.test(line)) return "brief_too_big";
  if (/read outside the snapshot/.test(line)) return "boundary_breach";
  return "reviewer_failed";
}

// The detail of a stop before any reviewer ran: one cause, its unit list
// empty.
export function stoppedDetail(cause: IncompleteCause): IncompleteDetail {
  return { cause, causes: [cause], retryable: RETRYABLE.has(cause), units: [] };
}

// Every cause of an incomplete model review, in ORDER. `calls`: every model
// attempt, the second reviewer's included (its budget refusal ends the
// review too). `staged`: what the staged review recorded.
export function incompleteDetail(args: { evidence: ModelReviewEvidence; calls: readonly CallRecord[]; staged: readonly StagedCause[] }): IncompleteDetail {
  const { evidence: e } = args;
  const found = new Set<IncompleteCause>(args.staged.map((s) => s.cause));
  if (args.calls.some((c) => c.outcome === "refused")) found.add("budget_refused");
  if (e.failure) found.add(failureCause(e.failure));
  if (e.snapshot.after === null || e.snapshot.after !== e.snapshot.before) found.add("boundary_breach");
  // The tool calls a model completion record fails a review for: a served
  // call outside the snapshot or the scopes, or to a tool never defined.
  if (e.toolLog.some((t) => t.ok && (!e.tools.includes(t.tool) || t.inside !== true || t.inScope === false))) found.add("boundary_breach");
  if (e.candidates.total > e.candidates.disposed) found.add("candidates_not_disposed");
  if (e.submissionErrors.length > 0) found.add("answer_rejected");
  // A range the units noted (no brief could hold it) is too big; any other
  // unread range was neither shown nor read.
  for (const h of e.coverage.unread) found.add(h.note ? "brief_too_big" : "range_not_examined");
  if (found.size === 0) found.add("reviewer_failed");
  const causes = ORDER.filter((c) => found.has(c));
  const units = [...new Set(args.staged.flatMap((s) => (s.unit ? [s.unit] : [])))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return { cause: causes[0]!, causes, retryable: causes.every((c) => RETRYABLE.has(c)), units };
}
