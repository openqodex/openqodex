// What the brain measured of one model reviewer's conversation, for its
// completion record (model-record.ts): its own log of every tool call, every
// model attempt, and coverage from what the requests that were sent carried.
// A correction round's ranges count only when the request carrying them was
// sent. Nothing comes from what the reviewer said. Shared by the primary
// and the second reviewer, so both are judged by one rule.
import { modelCoverage } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import type { Conversation } from "./conversation.js";
import { modelToolEntry } from "./model-loop.js";
import type { ModelSession } from "./model-loop.js";
import { redactStored } from "./redact.js";
import { TOOL_NAMES } from "./tools/index.js";
import type { ModelReviewEvidence, ReviewerRole } from "./usage.js";

export function modelEvidence(args: {
  role: ReviewerRole;
  model: string;
  session: ModelSession | null;
  talk: Conversation;
  change: Change;
  snapshot: ModelReviewEvidence["snapshot"];
  briefFiles: ReadonlySet<string>;
  lineCount: (path: string) => number | null;
  secrets: string[];
  startedAt: string;
}): ModelReviewEvidence {
  const { talk, change } = args;
  const sent = args.session?.sentRounds ?? 0;
  const delivered = talk.carried.slice(0, Math.max(0, sent - 1)).flat();
  const toolLog = structuredClone(args.session?.log ?? []);
  const attempts = structuredClone(args.session?.attempts ?? []);
  const coverage = modelCoverage({ change, briefSent: sent > 0, briefFiles: args.briefFiles, toolLog: toolLog.map(modelToolEntry), delivered, lineCount: args.lineCount });
  // Redacted like the agent record: a path or a tool input may hold a secret.
  return redactStored<ModelReviewEvidence>(
    {
      reviewer: args.role,
      model: args.model,
      changeId: change.id,
      snapshot: args.snapshot,
      candidates: { total: talk.required, disposed: talk.disposed },
      coverage,
      briefSent: sent > 0,
      toolLog,
      attempts,
      rounds: talk.rounds,
      submissionErrors: talk.errors,
      failure: talk.failure,
      tools: [...TOOL_NAMES],
      startedAt: args.startedAt,
      endedAt: new Date(talk.endedAt).toISOString(),
      durationMs: talk.endedAt - talk.startedAt,
    },
    args.secrets,
  );
}
