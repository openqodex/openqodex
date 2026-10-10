// The second reviewer (reviewChange's `options.secondReviewer`): a model
// that reviews the change again once the primary is done, never beside it.
// It gets the same brief, the same snapshot, the same five tools and the
// same budget, and the same checks judge its answer, with correction rounds
// and a completion record of its own. Its calls are asked of the budget as
// the second reviewer's, with the usage of the primary's calls counted in.
//
// How its work joins the primary's:
//   findings       merged by finalize's rule for the same finding (the file,
//                  the range, the category, and the candidate, source or
//                  title); the higher severity is kept, then the primary's;
//                  `foundBy` names every reviewer that raised it
//   dispositions   both reviewers' kept, each marked with who made it
//   disagreements  each candidate one raised and the other dropped
//   failures       a budget refusal ends the whole review incomplete (the
//                  record says so in `missing`, the primary's findings stay);
//                  any other failure leaves the review as the primary made it
//                  and is named in the notes and the record
import { findingKey, severityRank } from "@openqodex/core";
import type { Disagreement, ModelCompletionRecord, Report, ReportFinding } from "@openqodex/core";
import type { Conversation } from "./conversation.js";
import { modelSession } from "./model-loop.js";
import type { ModelSession } from "./model-loop.js";
import { redactStored } from "./redact.js";
import type { Budget, Disposition, ModelReviewer } from "./reviewer.js";
import type { ToolBox } from "./tools/index.js";
import type { CallRecord, ModelReviewEvidence } from "./usage.js";

// The second reviewer's run: its name (the model's), its answer when it
// passed every check (else null), the answer as given, and what the brain
// measured of its conversation.
export type SecondRun = { name: string; report: Report | null; submission: unknown; evidence: ModelReviewEvidence };

// Starts the second reviewer's session and runs its conversation through
// `converse` (the primary's brief, checks and correction rounds). `earlier`:
// the primary's calls, which the budget sees as usage so far. `started`
// gets the session as soon as it exists, so a stop can end it.
export async function runSecondReviewer(args: {
  reviewer: ModelReviewer;
  budget?: Budget;
  box: ToolBox;
  earlier: readonly CallRecord[];
  now: () => number;
  deadline?: number;
  started: (session: ModelSession) => void;
  converse: (session: ModelSession) => Promise<Conversation>;
  evidence: (session: ModelSession, talk: Conversation, startedAt: string) => ModelReviewEvidence;
}): Promise<SecondRun> {
  const session = modelSession({ reviewer: args.reviewer, role: "second", box: args.box, budget: args.budget, now: args.now, earlier: args.earlier, ...(args.deadline !== undefined ? { deadline: args.deadline } : {}) });
  args.started(session);
  const startedAt = new Date(args.now()).toISOString();
  const talk = await args.converse(session).finally(() => session.close());
  return { name: args.reviewer.model, report: talk.report, submission: talk.submission, evidence: args.evidence(session, talk, startedAt) };
}

// The two answers' findings as one list, the primary's first, each with the
// names of the reviewers that raised it.
export function mergeFindings(primary: { name: string; findings: ReportFinding[] }, second: { name: string; findings: ReportFinding[] }): { findings: ReportFinding[]; foundBy: string[][] } {
  const merged = new Map<string, { finding: ReportFinding; foundBy: string[] }>();
  for (const f of primary.findings) merged.set(findingKey(f), { finding: f, foundBy: [primary.name] });
  for (const f of second.findings) {
    const same = merged.get(findingKey(f));
    if (!same) merged.set(findingKey(f), { finding: f, foundBy: [second.name] });
    else {
      same.foundBy.push(second.name);
      if (severityRank(f.severity) > severityRank(same.finding.severity)) same.finding = f;
    }
  }
  const all = [...merged.values()];
  return { findings: all.map((m) => m.finding), foundBy: all.map((m) => m.foundBy) };
}

// Each candidate one reviewer raised and the other dropped, in the order
// of the primary's dispositions.
export function disagreementsOf(primary: { name: string; dispositions: Disposition[] }, second: { name: string; dispositions: Disposition[] }): Disagreement[] {
  const theirs = new Map(second.dispositions.map((d) => [d.candidate, d]));
  const out: Disagreement[] = [];
  for (const mine of primary.dispositions) {
    const other = theirs.get(mine.candidate);
    if (!other || other.outcome === mine.outcome) continue;
    const [raised, dropped] = mine.outcome === "raised" ? [primary.name, second.name] : [second.name, primary.name];
    out.push({ candidate: mine.candidate, token: mine.token, raisedBy: raised, droppedBy: dropped, reason: (mine.outcome === "dropped" ? mine : other).reason });
  }
  return out;
}

// The record with the second reviewer's outcome in it: the disagreements,
// and a note when the second reviewer did not complete for a reason other
// than a budget refusal (which `missing` already holds, making the review
// incomplete). Notes and reasons are redacted like the record.
export function withSecondReviewer(record: ModelCompletionRecord, disagreements: Disagreement[], secrets: string[]): ModelCompletionRecord {
  const second = record.second;
  const refused = second?.attempts.some((a) => a.outcome === "refused") ?? false;
  const notes = second && second.status !== "complete" && !refused ? [`the second reviewer (${second.reviewer.model}) did not complete: ${second.missing.join("; ")}`] : [];
  const { trace_complete, ...rest } = record;
  return redactStored({ ...rest, disagreements, notes, trace_complete }, secrets);
}
