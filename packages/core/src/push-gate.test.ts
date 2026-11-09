// Ways the push gate could fail, written before the code:
// 1. It ever returns "allow".
// 2. With no block_on_severity it denies, or stays silent about an
//    unreviewed change.
// 3. It treats a review of an earlier version of the change as a review of
//    this change.
// 4. With block_on_severity set it lets a blocked or missing review through
//    without denying, or denies a passing review of this change.
// 5. Its message does not say what to run.
// 6. A review judged with no threshold, or another one, passes a push after
//    block_on_severity is set (the config is outside the change id).
// 7. An incomplete record blocks a push, even with block_on_severity set.
// 8. A legacy receipt (the old two-step protocol) counts as a complete
//    record, or suddenly blocks a push the old version let through.
// 9. A complete passing review of this change is not silent.
// 10. A blocked or incomplete review names its report by a path relative to
//     the repository, which nobody can click, or names report.md where
//     report.html exists; or a receipt written before report.html existed no
//     longer gives its message.
// 11. A blocked push tells the agent to fix everything, where the developer
//     chooses what to fix.
// 12. An unread-only failure omits the first range from the push message.
import { describe, expect, it } from "vitest";
import { finalizeReview } from "./finalize.js";
import { checkPush, gateReceipt } from "./push-gate.js";
import { makeChange, makeConfig, makeManifest, makeScan, makeSubmission } from "./test-fixtures.js";
import type { GateReceipt } from "./push-gate.js";
import type { Report } from "./types.js";

const change = makeChange();

const DIR = ".openqodex/reviews/x";

function judged(blockOn: "critical" | null): Report {
  return finalizeReview({
    change,
    scan: makeScan(),
    manifest: makeManifest(change),
    config: makeConfig({ blockOnSeverity: blockOn }),
    submission: makeSubmission(),
  });
}

const HTML = "/abs/repo/.openqodex/reviews/x/report.html";
const complete = (blockOn: "critical" | null): GateReceipt => gateReceipt(judged(blockOn), "complete", DIR, HTML);
const legacy = (blockOn: "critical" | null): GateReceipt => gateReceipt(judged(blockOn), "legacy", DIR);
function incomplete(): GateReceipt {
  const report: Report = { ...judged(null), verdict: "incomplete", findings: [], completion: { status: "incomplete", missing: ["the reviewer timed out and was stopped"] } as unknown as Report["completion"] };
  return gateReceipt(report, "incomplete", DIR);
}

describe("checkPush", () => {
  it("9. is silent for a complete passing review of this change", () => {
    expect(checkPush({ currentChangeId: change.id, receipt: complete(null), config: makeConfig() })).toEqual({ decision: "abstain", message: null });
  });

  it("3. does not count a review of an earlier version", () => {
    const earlier = { ...complete(null), change_id: "0".repeat(64) };
    const d = checkPush({ currentChangeId: change.id, receipt: earlier, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("has not reviewed this change");
    const moved = checkPush({ currentChangeId: change.id, receipt: earlier, config: makeConfig() });
    expect(moved.message).toContain("the last review was of an earlier version");
  });

  it("4, 5. denies a complete blocked review when block_on_severity is set, and says what to run", () => {
    const r = complete("critical");
    expect(r.verdict).toBe("blocked");
    const d = checkPush({ currentChangeId: change.id, receipt: r, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("at or above critical");
    expect(d.message).toContain(HTML);
    expect(d.message).toContain("openqodex review");
  });

  it("10. names report.html by its absolute path, and a receipt from before report.html still gives today's message", () => {
    const blocked = checkPush({ currentChangeId: change.id, receipt: complete("critical"), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(blocked.message).toContain(`See ${HTML}.`);
    expect(blocked.message).not.toContain("report.md");
    const old = { ...complete("critical") } as Partial<GateReceipt>;
    delete old.html;
    const before = checkPush({ currentChangeId: change.id, receipt: old as GateReceipt, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(before.decision).toBe("deny");
    expect(before.message).toContain(`(see ${DIR}/report.md)`);
    const stopped = checkPush({ currentChangeId: change.id, receipt: { ...incomplete(), html: HTML }, config: makeConfig() });
    expect(stopped.message).toContain(`Report: ${HTML}`);
  });

  it("11. a blocked push asks the developer which findings to fix", () => {
    const d = checkPush({ currentChangeId: change.id, receipt: complete("critical"), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.message).toContain("fix all, or tell me which?");
    expect(d.message).toContain("Fix only the findings they name");
    expect(d.message).not.toMatch(/Fix them,/);
  });

  it("4. abstains on a complete passing review of this change when block_on_severity is set", () => {
    const r = { ...complete(null), verdict: "passed" as const, block_on_severity: "critical" as const };
    expect(checkPush({ currentChangeId: change.id, receipt: r, config: makeConfig({ blockOnSeverity: "critical" }) })).toEqual({ decision: "abstain", message: null });
  });

  it("7. an incomplete record of this change never blocks, and says the review did not finish", () => {
    for (const blockOn of [null, "critical"] as const) {
      const d = checkPush({ currentChangeId: change.id, receipt: incomplete(), config: makeConfig({ blockOnSeverity: blockOn }) });
      expect(d.decision).toBe("abstain");
      expect(d.message).toContain("incomplete");
      expect(d.message).toContain("the reviewer timed out");
      expect(d.message).toContain("openqodex review");
    }
  });

  it("8. a legacy receipt counts as reviewed, names the reviewing agent, and blocks only a blocked verdict", () => {
    const passing = { ...legacy(null), verdict: "passed" as const, block_on_severity: "critical" as const };
    const d = checkPush({ currentChangeId: change.id, receipt: passing, config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("abstain");
    expect(d.message).toContain("reviewed by the coding agent you are using");
    const b = checkPush({ currentChangeId: change.id, receipt: legacy("critical"), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(b.decision).toBe("deny");
    expect(b.message).toContain("reviewed by the coding agent you are using");
  });

  it("1. never allows", () => {
    for (const r of [legacy(null), complete(null), complete("critical"), incomplete(), null]) {
      for (const blockOn of [null, "critical"] as const) {
        const d = checkPush({ currentChangeId: change.id, receipt: r, config: makeConfig({ blockOnSeverity: blockOn }) });
        expect(["abstain", "deny"]).toContain(d.decision);
      }
    }
  });

  it("6. denies a passing review made before block_on_severity was set", () => {
    const d = checkPush({ currentChangeId: change.id, receipt: complete(null), config: makeConfig({ blockOnSeverity: "critical" }) });
    expect(d.decision).toBe("deny");
    expect(d.message).toContain("under the current block_on_severity");
  });
});

it("C3 fix 6. an unread-only push message names its heading and first range", () => {
  const report = { ...judged(null), verdict: "incomplete", completion: { status: "incomplete", missing: ["2 changed ranges were not examined", "a.py:4-5 (deletion a.py#0)", "b.py:6-7"] } } as Report;
  const receipt = gateReceipt(report, "incomplete", DIR);
  const result = checkPush({ currentChangeId: change.id, receipt, config: makeConfig() });
  expect(result.message).toContain("2 changed ranges were not examined; a.py:4-5 (deletion a.py#0)");
  expect(result.message).not.toContain("b.py:6-7");
});
