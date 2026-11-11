// What the push hooks decide before a `git push`. They never allow: an allow
// would skip the developer's own permission prompt for the push. They
// abstain (optionally with a note) or, only when block_on_severity is set,
// deny.
//
// The decision reads a gate receipt: the record `review` writes at the end
// of a run into the developer's own OpenQodex home, never the files under
// the repository's .openqodex/, which a branch can carry (the CLI reads and
// writes it, in receipts.ts).
import { countedSeverities, severityBreakdown } from "./render/common.js";
import type { Config, PushDecision, Report, Severity, Verdict } from "./types.js";

const REVIEW_STEP = "run openqodex review";
// The developer chooses what to fix, as the skill says.
const CHOOSE = 'Show the developer the findings and ask: "fix all, or tell me which?"';

// "complete" or "incomplete" for a review `review` ran with its own reviewer
// (its completion record decides); "legacy" for one finished with the older
// two-step protocol, which counts as reviewed and names the agent as the reviewer.
export type ReceiptKind = "complete" | "incomplete" | "legacy";

export type GateReceipt = {
  version: 1;
  change_id: string;
  kind: ReceiptKind;
  verdict: Verdict | null;
  block_on_severity: Severity | null;
  // The base the review measured from: the git pre-push hook measures each
  // pushed commit from it.
  base: { ref: string; sha: string };
  // The report.md path, relative to the repository.
  report: string;
  // The absolute path of report.html; absent in receipts written before it
  // existed, whose messages name `report`.
  html?: string;
  // The counted findings by severity, or null for none.
  counts: string | null;
  // The first missing condition, with its first range when it is coverage.
  missing: string | null;
  written_at: string;
};

// The receipt of a finished run. `dir`: the run folder, relative to the
// repository. `html`: the absolute path of its report.html.
export function gateReceipt(report: Report, kind: ReceiptKind, dir: string, html?: string): GateReceipt {
  const severities = countedSeverities(report);
  const missing = report.completion?.missing ?? [];
  const firstMissing = /^\d+ changed (?:range was|ranges were) not examined$/.test(missing[0] ?? "") ? missing.slice(0, 2).join("; ") : missing[0] ?? null;
  return {
    version: 1,
    change_id: report.change_id,
    kind,
    verdict: kind === "incomplete" ? null : report.verdict,
    block_on_severity: report.block_on_severity,
    base: { ref: report.base.ref, sha: report.base.sha },
    report: `${dir}/report.md`,
    ...(html !== undefined ? { html } : {}),
    counts: kind === "incomplete" || severities.length === 0 ? null : severityBreakdown(severities),
    missing: kind === "incomplete" ? firstMissing : null,
    written_at: new Date().toISOString(),
  };
}

// The lookup both push hooks make, for exactly the change being pushed. A
// complete passing review is silent; a complete blocked one denies when
// block_on_severity is set; none asks for `openqodex review` (and denies when
// a threshold is set, so the agent reviews and retries); an incomplete record
// never blocks. A legacy receipt counts as reviewed, with one line saying it
// was done by the coding agent in use. `receipt`: the record of this change, else
// the newest record of the repository, else null.
export function checkPush(args: { currentChangeId: string; receipt: GateReceipt | null; config: Config }): PushDecision {
  const { currentChangeId, receipt, config } = args;
  const threshold = config.blockOnSeverity;
  const sameId = receipt !== null && receipt.change_id === currentChangeId;

  if (sameId && receipt.kind === "incomplete") {
    return {
      decision: "abstain",
      message: `OpenQodex: the last review of this change was incomplete${receipt.missing ? ` (${receipt.missing})` : ""}, so it does not block. To finish it, ${REVIEW_STEP}. Report: ${receipt.html ?? receipt.report}`,
    };
  }

  const sameChange = sameId && receipt.verdict !== null;
  // The config lives in .openqodex/, outside the change, so raising the
  // threshold does not move the change id: a review judged under another
  // threshold does not count once one is set.
  const otherRule = sameChange && threshold !== null && receipt.block_on_severity !== threshold;
  const reviewed = sameChange && !otherRule;
  const earlier = receipt !== null && !sameId && receipt.kind !== "incomplete";
  const notReviewed = `OpenQodex has not reviewed this change${
    otherRule ? " under the current block_on_severity" : earlier ? " (the last review was of an earlier version)" : ""
  }`;

  if (!reviewed || receipt === null) {
    if (!threshold) return { decision: "abstain", message: `${notReviewed}. Run openqodex review before pushing.` };
    return {
      decision: "deny",
      message: `${notReviewed}, and this repo blocks a push without a passing review (block_on_severity: ${threshold}). Run openqodex review, then push again.`,
    };
  }

  const legacy = receipt.kind === "legacy" ? " It was reviewed by the coding agent you are using." : "";
  if (threshold && receipt.verdict !== "passed") {
    // A receipt from before report.html keeps its message as it was.
    const message =
      receipt.html === undefined
        ? `OpenQodex blocks this push: the review of this change found ${receipt.counts ?? "findings"}, at or above ${threshold} (see ${receipt.report}). Fix them, ${REVIEW_STEP} again, then push.${legacy}`
        : `OpenQodex blocks this push: the review of this change found ${receipt.counts ?? "findings"}, at or above ${threshold}. See ${receipt.html}. ${CHOOSE} Fix only the findings they name, ${REVIEW_STEP} again, show the new receipt, then push.${legacy}`;
    return { decision: "deny", message };
  }
  if (receipt.kind === "legacy") {
    return { decision: "abstain", message: `OpenQodex review of this change: ${receipt.counts ?? "no findings"}. Report: ${receipt.html ?? receipt.report}.${legacy}` };
  }
  return { decision: "abstain", message: null };
}
