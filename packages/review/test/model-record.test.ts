// The model completion record built from the brain's evidence of one model
// review, and the renderers a review result carries.
//
// Ways it could fail, written before the code:
//  1. A tool call served but never sent counts as shown (the evidence's
//     coverage is not what the record carries).
//  2. A refused second call leaves the review complete, or the record loses
//     the first call's usage.
//  3. A refused call is recorded as authorized, or a call that returned no
//     response gets usage it never reported.
//  4. A tool call the brain did not define, or one outside the snapshot, is
//     not named.
//  5. A secret the scanners found reaches the record through a tool call's
//     path or reason.
//  6. The second reviewer's refusal does not make the review incomplete, or
//     its record is lost.
//  7. The result's markdown, SARIF or JSON lose the model record or print the
//     agent's reviewer line.
import { modelCoverage } from "@openqodex/core";
import type { Change, Report } from "@openqodex/core";
import { describe, expect, it } from "vitest";
import { modelRecord, modelReport, reviewRender } from "../src/model-record.js";
import type { CallRecord, ModelReviewEvidence, ToolLogEntry } from "../src/usage.js";

const TOOLS = ["read_file", "search_code", "list_files", "read_diff_for_file", "find_callers"];
const SECRET = ["sk", "live", "Zx9cV8bN7mQ6wE5rT4yU"].join("_");

// One changed file, lines 3 to 5, as the change source gives it.
const change = {
  id: "c".repeat(64),
  files: [{ path: "app/a.py", status: "modified", oldPath: null, binary: false }],
  changedPaths: ["app/a.py"],
  coverage: new Map([["app/a.py", new Set([3, 4, 5])]]),
  deletionPoints: new Map(),
} as unknown as Change;

function read(over: Partial<ToolLogEntry> = {}): ToolLogEntry {
  return { tool: "read_file", path: "app/a.py", range: [1, 20], inside: true, ok: true, served: true, delivered: true, inScope: null, reason: null, callId: "call-1", toolCallId: "t1", bytes: 400, ...over };
}

function call(n: number, over: Partial<CallRecord> = {}): CallRecord {
  return { callId: `call-${n}`, reviewer: "primary", purpose: "brief", attempt: 1, model: "m-1", inputTokens: 1000 * n, outputTokens: 100 * n, costUsd: 0.01, outcome: "ok", durationMs: 800, ...over };
}

function evidence(over: Partial<ModelReviewEvidence> = {}): ModelReviewEvidence {
  const toolLog = over.toolLog ?? [read()];
  return {
    reviewer: "primary",
    model: "m-1",
    changeId: change.id,
    snapshot: { tree: null, before: "h", after: "h" },
    candidates: { total: 0, disposed: 0 },
    coverage: modelCoverage({ change, briefSent: true, briefFiles: new Set(), toolLog: toolLog.map((t) => ({ ...t, in_scope: t.inScope })) }),
    briefSent: true,
    toolLog,
    attempts: [call(1), call(2)],
    rounds: 1,
    submissionErrors: [],
    failure: null,
    tools: TOOLS,
    startedAt: "2026-10-09T10:00:00.000Z",
    endedAt: "2026-10-09T10:00:05.000Z",
    durationMs: 5000,
    ...over,
  };
}

const report = {
  version: 1,
  kind: "review",
  change_id: change.id,
  base: { ref: "main", sha: "b".repeat(40) },
  generated_at: "2026-10-09T10:00:06.000Z",
  verdict: "passed",
  block_on_severity: null,
  summary: "Adds a helper.",
  findings: [],
  below_threshold: 0,
  outside_change: [],
  low_confidence: [],
  not_reviewed: [],
  dropped: [],
  scanners: [],
  impact: null,
  not_reviewed_paths: [],
  stats: { files: 1, additions: 3, deletions: 0 },
} as Report;

describe("the model record from the brain's evidence", () => {
  it("is complete for a review whose every changed range was sent, with every attempt as measured", () => {
    const r = modelRecord(evidence());
    expect(r).toMatchObject({ contract: "openqodex-model-review-1", status: "complete", missing: [], reviewer: { kind: "model", model: "m-1", calls: 2 }, coverage: { hunks: 1, covered: 1 } });
    expect(r.tool_log).toEqual([{ tool: "read_file", path: "app/a.py", range: [1, 20], inside: true, in_scope: null, ok: true, served: true, delivered: true, reason: null }]);
    expect(r.attempts[0]).toEqual({ callId: "call-1", purpose: "brief", attempt: 1, authorized: true, outcome: "ok", usage: { model: "m-1", inputTokens: 1000, outputTokens: 100, costUsd: 0.01 }, durationMs: 800 });
  });

  it("1. a read served but never sent is not shown, and the record says so", () => {
    const r = modelRecord(evidence({ toolLog: [read({ delivered: false })] }));
    expect(r.status).toBe("incomplete");
    expect(r.missing).toContain("1 changed range was not sent to the reviewer: app/a.py:3-5");
  });

  it("2, 3. a refused second call: incomplete, the first call's usage kept, the refused one unauthorized with no usage", () => {
    const r = modelRecord(evidence({ toolLog: [read({ delivered: false })], attempts: [call(1), call(2, { outcome: "refused", inputTokens: null, outputTokens: null, costUsd: null, durationMs: 0 })], failure: "budget refused before brief call 2" }));
    expect(r.status).toBe("incomplete");
    expect(r.missing.filter((m) => m === "budget refused before brief call 2")).toHaveLength(1);
    expect(r.attempts[0]!.usage).toEqual({ model: "m-1", inputTokens: 1000, outputTokens: 100, costUsd: 0.01 });
    expect(r.attempts[1]).toMatchObject({ authorized: false, outcome: "refused", usage: null });
    expect(r.reviewer.calls).toBe(1);
  });

  it("3. a call that threw is authorized, has no usage, and counts as a call", () => {
    const r = modelRecord(evidence({ attempts: [call(1), call(2, { outcome: "failed", inputTokens: null, outputTokens: null, costUsd: null })], failure: "the reviewer failed: socket hang up" }));
    expect(r.attempts[1]).toMatchObject({ authorized: true, outcome: "failed", usage: null });
    expect(r.reviewer.calls).toBe(2);
    expect(r.missing).toContain("the reviewer failed: socket hang up");
  });

  it("4. a tool the brain did not define and a path outside the snapshot are named", () => {
    const r = modelRecord(evidence({ toolLog: [read(), read({ tool: "bash", path: null, range: null, inside: null, ok: false, delivered: true, reason: "not a tool" }), read({ path: "/etc/passwd", range: null, inside: false, ok: false, reason: "outside the snapshot" })] }));
    expect(r.missing).toContain("the reviewer returned a tool call the brain did not define: bash");
    expect(r.missing).toContain("the reviewer tried to read outside the snapshot: /etc/passwd");
  });

  it("5. a secret in a tool call's path or reason is redacted in the record", () => {
    const r = modelRecord(evidence({ toolLog: [read(), read({ path: `app/${SECRET}.py`, range: null, ok: false, reason: `no file app/${SECRET}.py` })] }), { secrets: [SECRET] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("6. the second reviewer's record rides along, and its refusal makes the review incomplete", () => {
    const second = evidence({ reviewer: "second", attempts: [call(1, { reviewer: "second", purpose: "second" }), call(2, { reviewer: "second", purpose: "second", outcome: "refused", inputTokens: null, outputTokens: null, costUsd: null })] });
    const r = modelRecord(evidence(), { second });
    expect(r.second?.attempts).toHaveLength(2);
    expect(r.status).toBe("incomplete");
    expect(r.missing).toContain("the second reviewer: budget refused before second call 2");
  });
});

describe("7. the result's renderers", () => {
  it("print the model line in markdown, carry the record in SARIF and JSON", () => {
    const record = modelRecord(evidence());
    const render = reviewRender(modelReport(report, record));
    expect(render.markdown()).toContain("Reviewed by a model reviewer, m-1, 2 calls, tokens in 3,000, out 300, cost $0.02");
    expect(render.markdown()).not.toMatch(/^Reviewer: /m);
    expect(JSON.parse(render.sarif()).runs[0].properties.completion).toEqual(record);
    expect(JSON.parse(render.json()).completion).toEqual(record);
  });

  it("an incomplete record makes the report incomplete, keeping its findings", () => {
    const record = modelRecord(evidence({ attempts: [call(1, { outcome: "refused", inputTokens: null, outputTokens: null, costUsd: null })], failure: null }));
    const out = modelReport(report, record);
    expect(out.verdict).toBe("incomplete");
    expect(reviewRender(out).markdown()).toMatch(/^# Review incomplete/);
    expect(modelReport(report, modelRecord(evidence())).verdict).toBe("passed");
  });
});
