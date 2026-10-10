// The completion record of a review by a model reviewer, built from the
// brain's evidence of the conversation (usage.ts: ModelReviewEvidence), and
// the renderers a review result carries. Every value comes from what the
// brain measured; nothing from what the reviewer said.
import { modelCompletionRecord, renderJson, renderMarkdown, renderReview, renderSarif } from "@openqodex/core";
import type { ModelAttempt, ModelCompletionRecord, ModelToolEntry, Report } from "@openqodex/core";
import { redactStored } from "./redact.js";
import type { ReviewResult } from "./reviewer.js";
import type { CallRecord, ModelReviewEvidence, ToolLogEntry } from "./usage.js";

function toolEntry(t: ToolLogEntry): ModelToolEntry {
  return { tool: t.tool, path: t.path, range: t.range, inside: t.inside, in_scope: t.inScope, ok: t.ok, served: t.served, delivered: t.delivered, reason: t.reason };
}

// A call the budget refused was never authorized; only a call that
// returned a response has usage.
function attempt(c: CallRecord, model: string): ModelAttempt {
  return {
    callId: c.callId,
    purpose: c.purpose,
    attempt: c.attempt,
    authorized: c.outcome !== "refused",
    outcome: c.outcome,
    usage:
      c.outcome !== "ok"
        ? null
        : {
            model: c.model ?? model,
            ...(c.servedModel !== undefined ? { servedModel: c.servedModel } : {}),
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
            ...(c.cacheReadTokens !== undefined ? { cacheReadTokens: c.cacheReadTokens } : {}),
            ...(c.cacheWriteTokens !== undefined ? { cacheWriteTokens: c.cacheWriteTokens } : {}),
            ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
          },
    durationMs: c.durationMs,
  };
}

function build(e: ModelReviewEvidence, second?: ModelCompletionRecord): ModelCompletionRecord {
  return modelCompletionRecord({
    changeId: e.changeId,
    model: e.model,
    snapshot: e.snapshot,
    candidates: e.candidates,
    coverage: e.coverage,
    toolLog: e.toolLog.map(toolEntry),
    attempts: e.attempts.filter((c) => c.reviewer === e.reviewer).map((c) => attempt(c, e.model)),
    tools: e.tools,
    submissionErrors: e.submissionErrors,
    failure: e.failure,
    ...(second ? { second } : {}),
  });
}

// The record of the primary reviewer's conversation, with the second
// reviewer's own record beside it when one ran. Redacted like the agent
// record: a path or a reason may hold a secret the scanners found.
export function modelRecord(evidence: ModelReviewEvidence, opts: { second?: ModelReviewEvidence | null; secrets?: string[] } = {}): ModelCompletionRecord {
  return redactStored(build(evidence, opts.second ? build(opts.second) : undefined), opts.secrets ?? []);
}

// The checked report with the model record in it. An incomplete record
// makes the report incomplete; the findings of an answer that passed every
// check stay, printed as the findings so far.
export function modelReport(report: Report, record: ModelCompletionRecord): Report {
  return { ...report, completion: record, ...(record.status !== "complete" ? { verdict: "incomplete" as const } : {}) };
}

// What a review result renders, with today's renderers: the standard report
// in markdown, SARIF with the completion record in its run properties, and
// the report as JSON.
export function reviewRender(report: Report): ReviewResult["render"] {
  return {
    markdown: () => (report.completion ? renderReview(report, { format: "markdown" }) : renderMarkdown(report)),
    sarif: () => renderSarif(report),
    json: () => renderJson(report),
  };
}
