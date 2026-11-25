// Issue 284: a control review whose only output was a network error was
// saved complete, scored, and its error text sent to the Martian judge.
// Failure list, written before the code:
// 1. A review whose body is an API error, whose run stopped before it
//    completed, whose record names no model or several, or (a model review)
//    whose usage has zero tokens reads as healthy.
// 2. A scanner-only sample, which has no model and no tokens, reads as
//    unhealthy.
// 3. The scorer credits a finding from an unhealthy review.
// 4. A board comment, which a judge reads, is built from an unhealthy review.
// 5. The control runner saves such a review complete at the source.
import { expect, it } from "vitest";
import { boardReview, statusOf } from "../lib/board-reviews.mjs";
import { controlSample } from "../lib/claude-control.mjs";
import { scanSampleRecord } from "../lib/runner.mjs";
import { reviewHealth, scoreJob } from "../lib/score.mjs";

// The saved control sample of keycloak 38446 in run
// 2026-10-28-55a9d696-martian-control, without its command.
const ERROR_BODY = "API Error: Can't reach the API server \u2014 check your internet or DNS (ENOTFOUND)";
const sample38446 = {
  jobId: "martian/keycloak__keycloak-38446@a4a3b579/control-graph-off/1", caseId: "martian/keycloak__keycloak-38446@a4a3b579", firstAttempt: true,
  case: "keycloak__keycloak-38446", config: "control-graph-off", reviewer: "control", graph: "off", repeat: 1, attempt: 1,
  started_at: "2026-10-28T03:00:12.844Z", exit: 0, signal: null, wallMs: 6539746, status: "complete", stopped: null, failure: null,
  reviewerUsed: { name: "claude", version: "2.1.312" }, model: "claude-opus-5-5", models: ["claude-opus-5-5"],
  modelFrom: "the usage record Claude Code returned for this review", modelStatus: "known",
  usage: { turns: 0, input_tokens: 133283, output_tokens: 1402, cost_usd: 0.18671340000000003 },
  nativeBody: ERROR_BODY,
};
// keycloak 40940 of the same run: the same body, no model and zero tokens.
const sample40940 = { ...sample38446, case: "keycloak__keycloak-40940", model: null, models: [], modelStatus: "none", usage: { turns: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 } };

it("the saved 38446 control sample is unhealthy because its body is an API error, though it names its model and has tokens", () => {
  const health = reviewHealth(sample38446);
  expect(health.ok).toBe(false);
  expect(health.reason).toBe("its body is an API error: API Error: Can't reach the API server, check your internet or DNS (ENOTFOUND)");
  expect(reviewHealth(sample40940)).toEqual(health);
  expect(reviewHealth({ ...sample38446, nativeBody: "I found 9 issues." })).toEqual({ ok: true });
});

it("each other rule marks a review unhealthy with its own reason", () => {
  const healthy = { ...sample38446, nativeBody: "I found 9 issues." };
  expect(reviewHealth({ ...healthy, status: "failed", stopped: "stopped by SIGTERM" })).toEqual({ ok: false, reason: "the run stopped while it ran: stopped by SIGTERM" });
  expect(reviewHealth({ ...healthy, model: null, models: [], modelStatus: "none" }).reason).toBe("its record names no model");
  expect(reviewHealth({ ...healthy, models: ["claude-fable-5-1", "claude-opus-5-5"], modelStatus: "mixed" }).reason).toBe("its record names more than one model: claude-fable-5-1, claude-opus-5-5");
  expect(reviewHealth({ ...healthy, usage: { ...healthy.usage, input_tokens: 0, output_tokens: 0 } }).reason).toBe("its usage record has zero tokens");
  // A model review that finished before the run halted is whole.
  const server = { reviewer: "model:gpt-6.1-sol", path: "server", status: "complete", stopped: "the budget", servedModels: ["gpt-6.1-sol"], usage: { input_tokens: 10, output_tokens: 2 } };
  expect(reviewHealth(server)).toEqual({ ok: true });
  expect(reviewHealth({ ...server, status: "incomplete" }).ok).toBe(false);
  expect(reviewHealth({ ...server, servedModels: [] }).reason).toBe("its record names no model");
  expect(reviewHealth({ ...server, servedModels: ["a", "b"] }).reason).toBe("its record names more than one model: a, b");
});

it("a scanner-only sample with zero tokens stays healthy: it has no reviewer, so no model or tokens to check", () => {
  const job = { jobId: "planted/c@abababab/scan/1", caseId: "planted/c@abababab", case: "c", config: "scan", repeat: 1 };
  const row = scanSampleRecord({ job, attempt: 1, result: { code: 0, signal: null, wallMs: 10 }, scan: { candidates: [], scanners: [] }, report: null, startedAt: "t", failure: null, stopped: null });
  expect(row.reviewer).toBeNull();
  expect(reviewHealth({ ...row, usage: { input_tokens: 0, output_tokens: 0 } })).toEqual({ ok: true });
});

// One planted bug and a report whose one finding hits it.
const spec = { id: "hand", clean: false, bugs: [{ id: "sqli", file: "app/search.py", lines: [14, 14], anchor: { line: 14, text: "x" }, mentions: ["sql", "injection"], kind: ["security"], severity: "critical", found_by: ["reasoning"], truth: "t" }] };
const hit = { origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path: "app/search.py", line_number: 14, line_end: 14, title: "SQL injection", problem: "SQL injection", consequence: "c", fix: "f" };
const report = { findings: [hit], outside_change: [], dropped: [], completion: { status: "complete", missing: [], reviewer: { usage: { turns: 1, input_tokens: 100, output_tokens: 10, cost_usd: 0.1 } } } };
const laptopRow = { reviewer: "claude", status: "complete", stopped: null, modelStatus: "known", models: ["claude-opus-5-5"], usage: report.completion.reviewer.usage };

it("scoreJob credits no finding from an unhealthy review, and keeps it in the denominator as a miss", () => {
  const job = { jobId: "planted/hand@abababab/c/1", caseId: "planted/hand@abababab", config: "c", repeat: 1 };
  const healthy = scoreJob({ job: { ...job, health: reviewHealth(laptopRow, report) }, spec, report, row: laptopRow });
  expect(healthy.issueRecall.all).toEqual({ hit: 1, of: 1 });
  const bad = { ...laptopRow, modelStatus: "none", models: [] };
  const unhealthy = scoreJob({ job: { ...job, health: reviewHealth(bad, report) }, spec, report, row: bad });
  expect(unhealthy.status).toBe("failed");
  expect(unhealthy.findings).toEqual([]);
  expect(unhealthy.issueRecall.all).toEqual({ hit: 0, of: 1 });
});

it("boardReview builds no comment from an unhealthy review, so its text never reaches a judge, and statusOf reports it failed", () => {
  const control = { caseId: sample38446.caseId, case: sample38446.case, config: "control-graph-off", repeat: 1, first: { row: sample38446, report: null } };
  const review = boardReview(control);
  expect(review.status).toBe("failed");
  expect(review.comments).toEqual([]);
  expect(review.findingIds).toEqual([]);
  expect(JSON.stringify(review.comments)).not.toContain("API Error");
  expect(statusOf(control.first)).toBe("failed");
  const healthyControl = boardReview({ ...control, first: { row: { ...sample38446, nativeBody: "I found 9 issues." }, report: null } });
  expect(healthyControl.comments.map((c) => c.body)).toEqual(["I found 9 issues."]);
  const laptop = { caseId: "martian/x@abababab", case: "x", config: "claude-graph-on", repeat: 1, first: { row: { ...laptopRow, usage: { input_tokens: 0, output_tokens: 0 } }, report } };
  expect(boardReview(laptop)).toMatchObject({ status: "failed", shown: [], comments: [] });
  expect(boardReview({ ...laptop, first: { row: laptopRow, report } }).comments).toHaveLength(1);
});

it("the control runner saves an API error answer failed at the source, with the health reason", () => {
  const job = { jobId: "martian/k@abababab/control-graph-off/1", caseId: "martian/k@abababab", case: "k", config: "control-graph-off", reviewer: "control", graph: false, repeat: 1 };
  // Claude Code's print mode answered the network error with exit 0, is_error false and no model usage.
  const native = { type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, result: ERROR_BODY };
  const saved = controlSample({ job, attempt: 1, result: { code: 0, signal: null, stdout: JSON.stringify(native), stderr: "", wallMs: 6_300_000 }, command: { command: "claude" }, version: "2.1.312", startedAt: "t" });
  expect(saved.status).toBe("failed");
  expect(saved.failure).toMatch(/^its body is an API error/);
  expect(saved.nativeBody).toBe(ERROR_BODY);
});
