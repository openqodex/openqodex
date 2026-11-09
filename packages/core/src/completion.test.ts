// The two completion records. The agent record keeps its existing fields
// and adds refused requests; a model reviewer gets its own record,
// built from the brain's logs (what each request carried, every tool call
// served, every model attempt and its authorization), never from the
// reviewer's word. Also the reviewer line each prints.
//
// Ways it could fail, written before the code:
//  1. The agent record changes beyond the added refused field: a field is
//     renamed, moved or given another value. The push hooks, the Action and the
//     golden run read it.
//  2. The agent review's markdown, terminal text, receipt, SARIF or HTML
//     changes.
//  3. A tool result the brain served but never sent in a request counts as
//     shown, so a range the model never saw completes the review.
//  4. A read cut by the 32 KB bound counts its whole file as shown.
//  5. The brief counts as shown when its request was never sent (the budget
//     refused the first call).
//  6. A refused call fails the review, hides a served outside read or is not
//     shown on the receipt. A served outside or unscoped read, or a served
//     tool the reviewer was not given, leaves it complete.
//  7. A budget refusal leaves the record complete, or the record loses the
//     usage of the attempts made before it.
//  8. A tool name the brain never defined, returned by the model, is not
//     named in the record.
//  9. An undisposed candidate, a failed submission check or a changed
//     snapshot leaves the model record complete.
// 10. The model record's reviewer line prints an unknown cost or token count
//     as a number instead of "not reported".
// 12. Partial brief ranges or deletion fragments credit a whole obligation.
// 11. The markdown, HTML or SARIF of a model review loses the model record
//     or prints the agent's reviewer line instead of the model's.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeLineSet } from "../../../tests/line-set.mjs";
import { budgetRefusedLine, completionRecord, modelCompletionRecord, singlePassModelCoverage, readCoverage, singlePassCoverage } from "./completion.js";
import type { Hunk } from "./completion.js";
import { checkSubmission } from "./finalize.js";
import { buildDisplay } from "./render/display.js";
import { renderHtml } from "./render/html.js";
import { renderReceipt, renderReview } from "./render/review.js";
import { renderSarif } from "./render/sarif.js";
import { SQL_CANDIDATE, makeChange, makeConfig, makeManifest, makeScan } from "./test-fixtures.js";
import type { ModelAttempt, ModelCompletionRecord, ModelToolEntry, Report, ReviewerRecord } from "./types.js";

// Recorded from the code before the model record existed (2026-10-09), on the
// fixture inputs below. Any difference is a change to the agent record or its
// report, which the push hooks, the Action and the golden run read. The
// verdict's count of scanners that did not run was added on 2026-10-12
// (issue 166): the fixture scan has one scanner not installed.
const FROZEN = {
  traced: "{\"version\":1,\"contract\":\"openqodex-review-2\",\"status\":\"complete\",\"missing\":[],\"refused\":[],\"reviewer\":{\"driver\":\"claude\",\"version\":\"2.1.289\",\"pid\":4242,\"started_at\":\"2026-10-03T10:00:00.000Z\",\"ended_at\":\"2026-10-03T10:01:12.000Z\",\"duration_ms\":72000,\"rounds\":2,\"usage\":{\"turns\":10,\"input_tokens\":45000,\"output_tokens\":3000,\"cost_usd\":0.31}},\"snapshot\":{\"change_id\":\"3f9a1c0b2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4\",\"tree\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"before\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"after\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},\"candidates\":{\"total\":3,\"disposed\":3},\"coverage\":{\"hunks\":2,\"covered\":2,\"unread\":[],\"files_read\":[\"app/search.py\"],\"files_not_read\":[\"app/settings.py\"]},\"outside_reads\":[],\"trace_complete\":true}",
  untraced: "{\"version\":1,\"contract\":\"openqodex-review-2\",\"status\":\"incomplete\",\"missing\":[\"the reviewer timed out and was stopped\",\"the snapshot changed while the reviewer read it\",\"1 scanner candidate has no disposition\",\"the reviewer's answer still failed 1 check after the correction rounds\",\"1. a problem\",\"2 changed ranges were not given to the reviewer: app/search.py:14-15, app/settings.py:1-3\"],\"refused\":[],\"reviewer\":{\"driver\":\"codex\",\"version\":\"0.160.0\",\"pid\":4242,\"started_at\":\"2026-10-03T10:00:00.000Z\",\"ended_at\":\"2026-10-03T10:01:12.000Z\",\"duration_ms\":72000,\"rounds\":2,\"usage\":{\"turns\":2,\"input_tokens\":2000,\"output_tokens\":1000,\"cost_usd\":null}},\"snapshot\":{\"change_id\":\"3f9a1c0b2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4\",\"tree\":null,\"before\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"after\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},\"candidates\":{\"total\":3,\"disposed\":2},\"coverage\":{\"hunks\":2,\"covered\":0,\"unread\":[{\"path\":\"app/search.py\",\"start\":14,\"end\":15,\"deletion\":false},{\"path\":\"app/settings.py\",\"start\":1,\"end\":3,\"deletion\":false}],\"files_read\":[],\"files_not_read\":[]},\"outside_reads\":[],\"trace_complete\":false}",
  md: "# Blocked: 1 finding at or above major \\(1 critical\\); 1 of 4 scanners did not run\n\nChange 3f9a1c0b2d4e against origin/main, 2 files, +5 -1\n\nSummary: Builds the search query from request input and adds a settings module.\n\nCounts: 1 finding \\(1 critical\\), 2 scanner candidates dropped\n\n## Findings \\(1\\)\n\n### 1. Critical security: Query built from request input\n\n- **Where:** app/search.py:14\n- **Problem:** The search query puts q from the request straight into the SQL text.\n- **Why it matters:** Anyone who can call search can read or change every row.\n- **Fix:** Pass q as a bound parameter to cur.execute.\n- **Source:** semgrep:python.lang.security.audit.formatted-sql-query\n\n## Dropped scanner candidates \\(2\\)\n\n### c2 at app/settings.py:3: The key is a documented local sample. \\(see app/settings.py:3\\)\n\n- **Source:** gitleaks:generic-api-key\n\n### c3 at app/settings.py:1: The import is used by the next change. \\(see app/settings.py:1\\)\n\n- **Source:** ruff:F401\n\n## Coverage\n\n- **Files the reviewer opened:** app/search.py\n- **Files not opened (their changed lines were in the brief):** app/settings.py\n- **Changed ranges given to the reviewer:** 2 of 2\nScanners: 3 scanners ran, 1 had nothing to check, 1 not included \\(brakeman: needs Ruby 2.7 or newer\\)\n\nReviewer: claude 2.1.289, 72 s, 10 turns, 1 correction round, 45,000 tokens in, 3,000 out, $0.31\n\nMade by Qodex: review on every pull request at https://qodex.ai\n",
  term: "Blocked: 1 finding at or above major (1 critical); 1 of 4 scanners did not run\nChange 3f9a1c0b2d4e against origin/main, 2 files, +5 -1\nSummary: Builds the search query from request input and adds a settings module.\nCounts: 1 finding (1 critical), 2 scanner candidates dropped\n\nFindings (1)\n1. Critical security: Query built from request input\n   Where: app/search.py:14\n   Problem: The search query puts q from the request straight into the SQL text.\n   Why it matters: Anyone who can call search can read or change every row.\n   Fix: Pass q as a bound parameter to cur.execute.\n   Source: semgrep:python.lang.security.audit.formatted-sql-query\n\nDropped scanner candidates (2)\nc2 at app/settings.py:3: The key is a documented local sample. (see app/settings.py:3)\n   Source: gitleaks:generic-api-key\nc3 at app/settings.py:1: The import is used by the next change. (see app/settings.py:1)\n   Source: ruff:F401\n\nCoverage\n   Files the reviewer opened: app/search.py\n   Files not opened (their changed lines were in the brief): app/settings.py\n   Changed ranges given to the reviewer: 2 of 2\nScanners: 3 scanners ran, 1 had nothing to check, 1 not included (brakeman: needs Ruby 2.7 or newer)\nReviewer: claude 2.1.289, 72 s, 10 turns, 1 correction round, 45,000 tokens in, 3,000 out, $0.31\nMade by Qodex: review on every pull request at https://qodex.ai\n",
  mdIncomplete: "# Review incomplete: this is not a review of the change\n\nChange 3f9a1c0b2d4e against origin/main, 2 files, +5 -1\n\nSummary: Builds the search query from request input and adds a settings module.\n\n## Missing\n\n### the reviewer timed out and was stopped\n\n### the snapshot changed while the reviewer read it\n\n### 1 scanner candidate has no disposition\n\n### the reviewer's answer still failed 1 check after the correction rounds\n\n### 1. a problem\n\n### 2 changed ranges were not given to the reviewer: app/search.py:14-15, app/settings.py:1-3\n\n## Findings so far \\(the change was not fully reviewed\\) \\(1\\)\n\n### 1. Critical security: Query built from request input\n\n- **Where:** app/search.py:14\n- **Problem:** The search query puts q from the request straight into the SQL text.\n- **Why it matters:** Anyone who can call search can read or change every row.\n- **Fix:** Pass q as a bound parameter to cur.execute.\n- **Source:** semgrep:python.lang.security.audit.formatted-sql-query\n\n## Dropped scanner candidates \\(2\\)\n\n### c2 at app/settings.py:3: The key is a documented local sample. \\(see app/settings.py:3\\)\n\n- **Source:** gitleaks:generic-api-key\n\n### c3 at app/settings.py:1: The import is used by the next change. \\(see app/settings.py:1\\)\n\n- **Source:** ruff:F401\n\n## Coverage\n\n- **Files the reviewer opened:** not recorded by Codex\n- **Reads outside the snapshot:** not recorded by Codex\n- **Changed ranges given to the reviewer:** 0 of 2\nScanners: 3 scanners ran, 1 had nothing to check, 1 not included \\(brakeman: needs Ruby 2.7 or newer\\)\n\nReviewer: codex 0.160.0, 72 s, 2 turns, 1 correction round, 2,000 tokens in, 1,000 out\n\nMade by Qodex: review on every pull request at https://qodex.ai\n",
  receipt: "Blocked: 1 finding at or above major (1 critical); 1 of 4 scanners did not run\nChange 3f9a1c0b2d4e against origin/main, 2 files, +5 -1\nSummary: Builds the search query from request input and adds a settings module.\n1. Critical security: Query built from request input (app/search.py:14)\nReport: /r/report.html\nMarkdown: /r/report.md\n",
  sarif: "437a5b05d3a6d134cb617113c6ff5eb8934bc6c3e1d2559ecabc93cb3e6284e3",
  sarifIncomplete: "af49b4b3be1ff4bdcd3bc0669474de26dc58588aeaba0994599c68424ac1744c",
  // Change reports omit the retired size-exclusion accounting row.
  html: "5815cf09810313cced518d9a713bd7bedaccd40b0b62d515cd49ae4dfb417cf2",
  htmlIncomplete: "0addaa1ee593952e7544494878810b85de8608a46d379d423b2b462a5c02f581",
};

const reviewer: ReviewerRecord = {
  driver: "claude",
  version: "2.1.289",
  pid: 4242,
  started_at: "2026-10-03T10:00:00.000Z",
  ended_at: "2026-10-03T10:01:12.000Z",
  duration_ms: 72_000,
  rounds: 2,
  usage: { turns: 10, input_tokens: 45_000, output_tokens: 3_000, cost_usd: 0.31 },
};

const submission = {
  version: 2,
  change_id: "3f9a1c0b2d4e",
  summary: "Builds the search query from request input and adds a settings module.",
  findings: [
    {
      severity: "critical",
      category: "security",
      confidence: 0.9,
      file_path: "app/search.py",
      line_number: 14,
      title: "Query built from request input",
      problem: "The search query puts q from the request straight into the SQL text.",
      consequence: "Anyone who can call search can read or change every row.",
      fix: "Pass q as a bound parameter to cur.execute.",
      source: SQL_CANDIDATE.token,
      candidate: "c1",
    },
  ],
  dropped: [
    { candidate: "c2", reason: "The key is a documented local sample.", file_path: "app/settings.py", line_number: 3 },
    { candidate: "c3", reason: "The import is used by the next change.", file_path: "app/settings.py", line_number: 1 },
  ],
};

// The fixture change has two changed ranges: app/search.py:14-15 and app/settings.py:1-3.
const lineCount = (path: string) => (path === "app/search.py" ? 40 : path === "app/settings.py" ? 3 : null);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function checkedReport(): Report {
  const change = makeChange();
  const r = checkSubmission({ change, scan: makeScan(), manifest: makeManifest(change), config: makeConfig({ blockOnSeverity: "major" }), submission, lineCount });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return { ...r.report, generated_at: "2026-10-03T10:01:13.000Z" };
}

describe("1, 2. the agent record and its report", () => {
  const change = makeChange();
  const trace = [
    { tool: "Read", path: "app/search.py", inside: true, range: [1, 40] as [number, number], ok: true },
    { tool: "Grep", path: null, inside: true, range: null, ok: true },
  ];
  const coverage = singlePassCoverage({ change, diffFiles: new Set(["app/settings.py"]), trace, lineCount });
  const traced = completionRecord({ change, reviewer, snapshot: { tree: "a".repeat(40), before: "b".repeat(64), after: "b".repeat(64) }, candidates: { total: 3, disposed: 3 }, coverage, trace, submissionErrors: [], wholeRepo: false });
  const untraced = completionRecord({
    change,
    reviewer: { ...reviewer, driver: "codex", version: "0.160.0", usage: { turns: 2, input_tokens: 2000, output_tokens: 1000, cost_usd: null } },
    snapshot: { tree: null, before: "b".repeat(64), after: "c".repeat(64) },
    candidates: { total: 3, disposed: 2 },
    coverage: singlePassCoverage({ change, diffFiles: new Set(), trace: [], lineCount }),
    trace: [{ tool: "exec", path: null, inside: null, range: null, ok: true, detail: "cat x" }],
    submissionErrors: ["1. a problem"],
    wholeRepo: false,
    failure: "the reviewer timed out and was stopped",
    traced: false,
  });
  const report: Report = { ...checkedReport(), completion: traced };
  const incomplete: Report = { ...checkedReport(), verdict: "incomplete", completion: untraced };
  const display = buildDisplay({ change, secrets: [] });

  it("6. a refused outside read fails the agent record or hides a served read", () => {
    const refused = { tool: "Read", path: "/dev/null", inside: false, range: null, ok: false };
    const r = completionRecord({ change, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, coverage, trace: [refused], submissionErrors: [], wholeRepo: false });
    expect(r.status).toBe("complete");
    expect(r.refused).toEqual(["/dev/null"]);
    expect(r.outside_reads).toEqual(["/dev/null"]);
    const served = completionRecord({ change, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, coverage, trace: [refused, { ...refused, path: "/outside", ok: true }], submissionErrors: [], wholeRepo: false });
    expect(served.status).toBe("incomplete");
    expect(served.missing).toEqual(["the reviewer read outside the snapshot: /outside"]);
    const mixed = { ...checkedReport(), verdict: "incomplete" as const, completion: served };
    for (const text of [renderReceipt(mixed, { html: "/r/report.html", md: "/r/report.md" }), renderReview(mixed, { format: "terminal", color: false })]) {
      expect(text).toContain("These requests were refused and were not served: /dev/null");
      expect(text).toContain("the reviewer read outside the snapshot: /outside");
      expect(text).not.toContain("nothing outside");
    }
  });

  it("6. a served tool the reviewer was not given leaves the agent record complete", () => {
    const call = { tool: "Bash", path: null, inside: true, range: null, ok: true };
    const served = completionRecord({ change, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, coverage, trace: [call], submissionErrors: [], wholeRepo: false });
    expect(served.status).toBe("incomplete");
    expect(served.missing).toEqual(["the reviewer used a tool it was not given: Bash"]);
    expect(served.refused).toEqual([]);
    const refused = completionRecord({ change, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, coverage, trace: [{ ...call, ok: false }], submissionErrors: [], wholeRepo: false });
    expect(refused.status).toBe("complete");
    expect(refused.missing).toEqual([]);
    expect(refused.refused).toEqual(["Bash"]);
  });

  it("1. the agent records change only by the added refused field", () => {
    expect(JSON.stringify(traced)).toBe(FROZEN.traced);
    expect(traced.refused).toEqual([]);
    expect(JSON.stringify(untraced)).toBe(FROZEN.untraced);
    expect(untraced.refused).toEqual([]);
  });
  it("2. the markdown, terminal text and receipt of a complete and an incomplete agent review are as recorded", () => {
    expect(renderReview(report, { format: "markdown" })).toBe(FROZEN.md);
    expect(renderReview(report, { format: "terminal", color: false })).toBe(FROZEN.term);
    expect(renderReview(incomplete, { format: "markdown" })).toBe(FROZEN.mdIncomplete);
    expect(renderReceipt(report, { html: "/r/report.html", md: "/r/report.md" })).toBe(FROZEN.receipt);
  });
  it("2. the SARIF and the HTML of a complete and an incomplete agent review are as recorded", () => {
    for (const [r, hash] of [[report, FROZEN.sarif], [incomplete, FROZEN.sarifIncomplete]] as const) {
      const sarif = JSON.parse(renderSarif(r));
      expect(sarif.runs[0].properties.completion.refused).toEqual([]);
      delete sarif.runs[0].properties.completion.refused;
      expect(sha(`${JSON.stringify(sarif, null, 2)}\n`)).toBe(hash);
    }
    expect(sha(renderHtml({ report, display, version: "0.0.0", reportMd: "/r/report.md" }))).toBe(FROZEN.html);
    expect(sha(renderHtml({ report: incomplete, display, version: "0.0.0", reportMd: "/r/report.md" }))).toBe(FROZEN.htmlIncomplete);
  });
});

// The tools the brain defines for a model reviewer (packages/review/src/tools).
const TOOLS = ["read_file", "search_code", "list_files", "read_diff_for_file", "find_callers"];

function read(path: string, range: [number, number], over: Partial<ModelToolEntry> = {}): ModelToolEntry {
  return { tool: "read_file", path, range, inside: true, in_scope: null, ok: true, served: true, delivered: true, reason: null, ...over };
}

function answered(callId: string, purpose: string, input: number, output: number, cost?: number | null, servedModel?: string): ModelAttempt {
  return {
    callId,
    purpose,
    attempt: 1,
    authorized: true,
    outcome: "ok",
    usage: { model: "m-1", ...(servedModel ? { servedModel } : {}), inputTokens: input, outputTokens: output, ...(cost === undefined ? {} : { costUsd: cost }) },
    durationMs: 1200,
  };
}

function refused(callId: string, purpose: string): ModelAttempt {
  return { callId, purpose, attempt: 1, authorized: false, outcome: "refused", usage: null, durationMs: 0 };
}

type Log = { briefSent?: boolean; diffFiles?: Set<string>; delivered?: Hunk[]; toolLog?: ModelToolEntry[] };

// A model review that read both changed files with read_file in its first
// reply; the second request carried both results and got the answer. The
// brief carried no diff, so coverage comes from the reads alone.
function modelArgs(over: Partial<Parameters<typeof modelCompletionRecord>[0]> & Log = {}): Parameters<typeof modelCompletionRecord>[0] {
  const { briefSent = true, diffFiles = new Set<string>(), delivered = [], toolLog = [read("app/search.py", [1, 40]), read("app/settings.py", [1, 3])], ...rest } = over;
  const change = makeChange();
  return {
    changeId: change.id,
    model: "m-1",
    snapshot: { tree: "a".repeat(40), before: "b".repeat(64), after: "b".repeat(64) },
    candidates: { total: 3, disposed: 3 },
    coverage: singlePassModelCoverage({ change, briefSent, diffFiles, toolLog, delivered, lineCount }),
    toolLog,
    attempts: [answered("call-1", "brief", 2000, 100, 0.01), answered("call-2", "brief", 3000, 500, 0.01)],
    tools: TOOLS,
    submissionErrors: [],
    failure: null,
    ...rest,
  };
}

describe("the model record", () => {
  it("is complete when every changed range was sent and every check holds, and says what it is", () => {
    const r = modelCompletionRecord(modelArgs());
    expect(r).toMatchObject({
      contract: "openqodex-model-review-1",
      status: "complete",
      missing: [],
      reviewer: { kind: "model", model: "m-1", servedModels: [], calls: 2 },
      snapshot: { change_id: makeChange().id, tree: "a".repeat(40) },
      candidates: { total: 3, disposed: 3 },
      coverage: { hunks: 2, covered: 2, unread: [], files_read: ["app/search.py", "app/settings.py"], files_not_read: [] },
      trace_complete: true,
    });
    expect(r.tool_log).toHaveLength(2);
    expect(r.attempts.map((a) => a.callId)).toEqual(["call-1", "call-2"]);
    expect("version" in r).toBe(false);
  });

  it("counts the brief, a correction round and a sent read alike", () => {
    const r = modelCompletionRecord(modelArgs({ diffFiles: new Set(["app/settings.py"]), delivered: [{ path: "app/search.py", start: 14, end: 15, deletion: false }], toolLog: [] }));
    expect(r.status).toBe("complete");
    expect(r.coverage.covered).toBe(2);
  });

  it("3. a read served but never sent leaves its range unread and names it", () => {
    const r = modelCompletionRecord(modelArgs({ toolLog: [read("app/search.py", [1, 40]), read("app/settings.py", [1, 3], { delivered: false })] }));
    expect(r.status).toBe("incomplete");
    expect(r.coverage.unread).toEqual([{ path: "app/settings.py", start: 1, end: 3, deletion: false }]);
    expect(r.missing).toContain("1 changed range was not sent to the reviewer: app/settings.py:1-3");
    expect(r.tool_log[1]).toMatchObject({ served: true, delivered: false });
  });

  it("4. a read cut by the bound counts only the lines it carried", () => {
    const r = modelCompletionRecord(modelArgs({ toolLog: [read("app/search.py", [1, 14]), read("app/settings.py", [1, 3])] }));
    expect(r.status).toBe("incomplete");
    expect(r.missing.join("\n")).toContain("app/search.py:14-15");
  });

  it("5. the brief's diff does not count when the request carrying it was never sent", () => {
    const sent = modelCompletionRecord(modelArgs({ diffFiles: new Set(["app/search.py", "app/settings.py"]), toolLog: [] }));
    expect(sent.coverage.covered).toBe(2);
    const r = modelCompletionRecord(modelArgs({ briefSent: false, diffFiles: new Set(["app/search.py", "app/settings.py"]), toolLog: [], attempts: [refused("call-1", "brief")] }));
    expect(r.status).toBe("incomplete");
    expect(r.coverage.covered).toBe(0);
    expect(r.reviewer.calls).toBe(0);
    expect(r.missing).toContain("budget refused before brief call 1");
  });

  it("6. a refused outside or unscoped read makes the review incomplete", () => {
    for (const entry of [read("/etc/passwd", [1, 1], { inside: false, ok: false }), read("vendor/lib.py", [1, 1], { in_scope: false, ok: false })]) {
      const r = modelCompletionRecord(modelArgs({ toolLog: [...modelArgs().toolLog, entry] }));
      expect(r.status).toBe("complete");
      expect(r.refused).toEqual([entry.path]);
      expect(r.missing).toEqual([]);
    }
  });

  it("6. a served result outside the snapshot or scopes leaves the review complete", () => {
    const outside = read("/etc/passwd", [1, 1], { inside: false });
    const r = modelCompletionRecord(modelArgs({ toolLog: [...modelArgs().toolLog, outside] }));
    expect(r.status).toBe("incomplete");
    expect(r.missing).toContain("the reviewer read outside the snapshot: /etc/passwd");
    const unscoped = read("vendor/lib.py", [1, 1], { in_scope: false });
    const s = modelCompletionRecord(modelArgs({ toolLog: [...modelArgs().toolLog, unscoped] }));
    expect(s.status).toBe("incomplete");
    expect(s.missing).toContain("the reviewer asked for a path outside the review's scopes: vendor/lib.py");
  });

  it("7. a refused second call makes it incomplete and keeps the first attempt's usage", () => {
    const first = answered("call-1", "brief", 2000, 100, 0.01);
    const r = modelCompletionRecord(
      modelArgs({
        toolLog: [read("app/search.py", [1, 40], { delivered: false }), read("app/settings.py", [1, 3], { delivered: false })],
        attempts: [first, refused("call-2", "brief")],
        failure: budgetRefusedLine("brief", 2),
      }),
    );
    expect(r.status).toBe("incomplete");
    expect(r.missing.filter((m) => m === "budget refused before brief call 2")).toHaveLength(1);
    expect(r.attempts[0]).toEqual(first);
    expect(r.attempts[1]).toMatchObject({ callId: "call-2", authorized: false, outcome: "refused", usage: null });
    expect(r.reviewer.calls).toBe(1);
  });

  it("8. a refused tool the brain did not define fails the review", () => {
    const unknown: ModelToolEntry = { tool: "run_shell", path: null, range: null, inside: null, in_scope: null, ok: false, served: true, delivered: false, reason: "not a tool the brain defined" };
    const r = modelCompletionRecord(modelArgs({ toolLog: [...modelArgs().toolLog, unknown] }));
    expect(r.status).toBe("complete");
    expect(r.refused).toEqual(["run_shell"]);
    expect(r.missing).toEqual([]);
    const served = modelCompletionRecord(modelArgs({ toolLog: [...modelArgs().toolLog, { ...unknown, ok: true }] }));
    expect(served.status).toBe("incomplete");
    expect(served.missing).toContain("the reviewer returned a tool call the brain did not define: run_shell");
  });

  it("9. an undisposed candidate, a failed check or a changed snapshot makes it incomplete", () => {
    expect(modelCompletionRecord(modelArgs({ candidates: { total: 3, disposed: 2 } })).missing).toContain("1 scanner candidate has no disposition");
    const checks = modelCompletionRecord(modelArgs({ submissionErrors: ["1. the summary is empty"] }));
    expect(checks.missing).toEqual(["the reviewer's answer still failed 1 check after the correction rounds", "1. the summary is empty"]);
    const moved = modelCompletionRecord(modelArgs({ snapshot: { tree: null, before: "b".repeat(64), after: "c".repeat(64) } }));
    expect(moved.missing).toContain("the snapshot changed while the reviewer read it");
  });

  it("names only the served models the responses named, never the one asked for in their place", () => {
    const r = modelCompletionRecord(modelArgs({ attempts: [answered("call-1", "brief", 1, 1, 0, "m-1-0925"), answered("call-2", "brief", 1, 1, 0)] }));
    expect(r.reviewer.servedModels).toEqual(["m-1-0925"]);
  });

  it("8. a call to an undefined tool, which has no place to check, counts as undefined and never as outside", () => {
    const unknown: ModelToolEntry = { tool: "run_shell", path: null, range: null, inside: null, in_scope: null, ok: false, served: true, delivered: true, reason: "not a tool the brain defined" };
    const r = modelCompletionRecord(modelArgs({ toolLog: [...modelArgs().toolLog, unknown] }));
    expect(r.missing).toEqual([]);
    expect(r.refused).toEqual(["run_shell"]);
  });
});

function modelReport(over: Partial<Parameters<typeof modelCompletionRecord>[0]> & Log = {}): Report & { completion: ModelCompletionRecord } {
  return { ...checkedReport(), completion: modelCompletionRecord(modelArgs(over)) };
}

describe("the model review's report", () => {
  it("10. prints the model reviewer line, with unknown values as not reported", () => {
    const known = renderReview(modelReport(), { format: "terminal", color: false });
    expect(known).toContain("Reviewed by a model reviewer, m-1, 2 calls, tokens in 5,000, out 600, cost $0.02");
    const unknownCost = renderReview(modelReport({ attempts: [answered("call-1", "brief", 2000, 100, 0.01), answered("call-2", "brief", 3000, 500, null)] }), { format: "terminal", color: false });
    expect(unknownCost).toContain("Reviewed by a model reviewer, m-1, 2 calls, tokens in 5,000, out 600, cost not reported");
    const none = renderReview(modelReport({ briefSent: false, attempts: [refused("call-1", "brief")] }), { format: "terminal", color: false });
    expect(none).toContain("Reviewed by a model reviewer, m-1, 0 calls, tokens in not reported, out not reported, cost not reported");
  });

  it("10. names the served model when another one answered", () => {
    const text = renderReview(modelReport({ attempts: [answered("call-1", "brief", 1, 1, 0, "m-1-0925"), answered("call-2", "brief", 1, 1, 0, "m-1-0925")] }), { format: "terminal", color: false });
    expect(text).toContain("Reviewed by a model reviewer, m-1 (served by m-1-0925), 2 calls");
  });

  it("11. markdown and HTML print the model line and never the agent's", () => {
    const report = modelReport();
    const md = renderReview(report, { format: "markdown" });
    expect(md).toContain("Reviewed by a model reviewer, m-1, 2 calls, tokens in 5,000, out 600, cost $0.02");
    expect(md).not.toContain("Reviewer: none started");
    expect(md).toContain("**Files the reviewer opened:** app/search.py, app/settings.py");
    const html = renderHtml({ report, display: buildDisplay({ change: makeChange(), secrets: [] }), version: "0.0.0", reportMd: "/r/report.md" });
    expect(html).toContain("Reviewed by a model reviewer, m-1, 2 calls, tokens in 5,000, out 600, cost $0.02");
    expect(html).not.toContain("not recorded in this report");
  });

  it("11. SARIF run properties carry the model record, and an incomplete one fails the invocation", () => {
    const report = modelReport();
    const run = JSON.parse(renderSarif(report)).runs[0];
    expect(run.properties.completion).toEqual(report.completion);
    expect(run.invocations[0].executionSuccessful).toBe(true);
    const refusedReport: Report = { ...modelReport({ briefSent: false, attempts: [refused("call-1", "brief")], toolLog: [] }), verdict: "incomplete" };
    const failed = JSON.parse(renderSarif(refusedReport)).runs[0];
    expect(failed.invocations[0].executionSuccessful).toBe(false);
    expect(failed.invocations[0].toolExecutionNotifications[0].message.text).toContain("budget refused before brief call 1");
  });
});

it("credits exact intervals once and leaves the rest of a file unread", () => {
  const change = makeChange({ coverage: new Map([["app/search.py", makeLineSet([1, 2, 8, 9])]]) });
  const first = { path: "app/search.py", start: 1, end: 2, deletion: false };
  const coverage = readCoverage({ change, briefCarried: [first, first], trace: [] });
  expect(coverage.covered).toBe(1);
  expect(coverage.unread).toEqual([{ ...first, start: 8, end: 9 }]);
  expect(coverage.given).toEqual([{ path: first.path, start: 1, end: 2, by: "brief" }]);
});
it("does not credit a deletion parent for only one old-side fragment", () => {
  const change = makeChange({ coverage: new Map(), deletionPoints: new Map([["app/search.py", [{ after: 1, anchors: [1, 2], lines: 4 }]]]) });
  const base = { path: "app/search.py", start: 1, end: 2, deletion: { id: "app/search.py#0", oldStart: 1, oldEnd: 4 } };
  const refs = [1, 3].map((from, i) => ({ ...base, id: `h${i + 1}`, old: [from, from + 1] as [number, number], deletion: { ...base.deletion, oldStart: from, oldEnd: from + 1 } }));
  const partial = readCoverage({ change, obligations: refs, briefCarried: [refs[0]!], trace: [] });
  expect(partial.unread).toHaveLength(1);
  expect(partial.covered).toBe(1);
  const full = readCoverage({ change, obligations: refs, briefCarried: refs, delivered: refs, trace: [] });
  expect(full.unread).toEqual([]);
  expect(full.given).toHaveLength(2);
  expect(full.given!.every((g) => g.by === "brief")).toBe(true);
});

it("records each source's exact interval before fallback reads", () => {
  const change = makeChange({ coverage: new Map([["app/search.py", makeLineSet(Array.from({ length: 10 }, (_, i) => i + 1))]]) });
  const coverage = readCoverage({ change, briefCarried: [{ path: "app/search.py", start: 1, end: 4, deletion: false }], delivered: [{ path: "app/search.py", start: 5, end: 6, deletion: false }], trace: [{ tool: "Read", path: "app/search.py", range: [1, 10], inside: true, ok: true }] });
  expect(coverage.unread).toEqual([]);
  expect(coverage.given).toEqual([
    { path: "app/search.py", start: 1, end: 4, by: "brief" },
    { path: "app/search.py", start: 5, end: 6, by: "page" },
    { path: "app/search.py", start: 7, end: 10, by: "read" },
  ]);
});
