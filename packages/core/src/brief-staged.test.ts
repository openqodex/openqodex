// Ways staged briefs could fail, written before the code:
// 1. A unit receives another unit's hunks, including hunks of the same file.
// 2. A deletion loses its removed lines or the anchors that locate them.
// 3. Finder instructions expose scanner candidates or ask to dispose of them.
// 4. Finder and single-pass confidence floors become the same.
// 5. A verifier loses a candidate or allows unresolved scanner candidates.
// 6. The verifier example fails the final submission's prose or anchor checks.
// 7. A staged brief loses owner, convention, host, target or lens context.
// 8. A diff fence or matched secret escapes through a new staged block.
// 9. A brief keeps the old suppression rule or leaves the pass unspecified.
// 10. Trimmed diff rows keep stale line numbers or share an incorrect header.
// 11. An empty hunk consumes the file header, or equal deletion anchors
//     cause both hunks to show both removed runs.
// 12. Verification loses owner scope, scanner dispositions through dedupe,
//     or the confidence floors used by assembly.
// 13. A scanner-first batch gets a finder id in its answer example.
// 14. A brief still asks for a missing-test finding.
import { describe, expect, it } from "vitest";
import { buildFindBrief, buildVerifyBrief, FINDER_CONFIDENCE_FLOOR } from "./brief-staged.js";
import type { StagedBriefArgs, VerifyBatch } from "./brief-staged.js";
import { buildReviewerBrief } from "./brief.js";
import { checkSubmission } from "./finalize.js";
import { redactSecrets } from "./redact.js";
import { makeChange, makeConfig, makeManifest, makeScan, SECRET, SQL_CANDIDATE } from "./test-fixtures.js";
import type { FindCandidate, ReviewUnit, RunTarget, SubmissionV2, VerifyAnswer } from "./types.js";

const searchDiff = [
  "diff --git a/app/search.py b/app/search.py",
  "--- a/app/search.py", "+++ b/app/search.py",
  "@@ -14 +14,2 @@",
  '-    cur.execute("SELECT * FROM items WHERE name = %s", (q,))',
  '+    cur.execute(f"SELECT * FROM items WHERE name = \'{q}\'")',
  "+    return cur.fetchall()",
  "@@ -40 +41 @@", "-old_second_hunk()", "+other_unit_only()",
  "@@ -50,2 +50,0 @@", "-removed_guard()", "-removed_return()", "",
].join("\n");
const change = makeChange({ diffs: [
  { path: "app/search.py", text: searchDiff },
  { path: "app/settings.py", text: `diff --git a/app/settings.py b/app/settings.py\n--- /dev/null\n+++ b/app/settings.py\n@@ -0,0 +1 @@\n+${SECRET}\n` },
], deletionPoints: new Map([["app/search.py", [{ after: 50, lines: 2, anchors: [50, 51] }]]]) });
const unit: ReviewUnit = {
  id: "u1", files: ["app/search.py"],
  hunks: [{ id: "h1", path: "app/search.py", start: 14, end: 15, deletion: false }], diffBytes: searchDiff.length,
};
const candidate: FindCandidate = {
  severity: "critical", category: "security", confidence: 0.9,
  file_path: "app/search.py", line_number: 14, line_end: 14,
  title: "Query built from request input",
  claim: "The query includes request input directly. A caller can change which rows the query returns.",
  evidence: [{ file_path: "app/search.py", line_number: 14, quote: '    cur.execute(f"SELECT * FROM items WHERE name = \'{q}\'")' }],
};
const batch: VerifyBatch = {
  file: "app/search.py", hunks: unit.hunks,
  candidates: [
    { id: "k1", kind: "finder", candidate, foundBy: ["finder:u1:local", "finder:u1:contracts"] },
    { id: "c1", kind: "scanner", candidate: SQL_CANDIDATE },
  ],
};

function args(over: Partial<StagedBriefArgs> = {}): StagedBriefArgs {
  return { change, scan: makeScan(), lenses: [], config: makeConfig(), secrets: [SECRET], ...over };
}

function answer(text: string): VerifyAnswer {
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!) as VerifyAnswer;
}

describe("find brief", () => {
  it("shows only this unit's hunks, including when another unit shares its file", () => {
    const { text, diffFiles } = buildFindBrief(args(), unit, "local");
    expect(text).toContain("### h1 app/search.py 14-15");
    expect(text).toContain("+    return cur.fetchall()");
    expect(text).toContain('-    cur.execute("SELECT * FROM items WHERE name = %s", (q,))');
    expect(text).not.toContain("other_unit_only");
    expect(text).not.toContain("removed_guard");
    expect(text).not.toContain("app/settings.py");
    expect(diffFiles).toEqual(new Set(unit.files));
  });

  it("does not count a file with missing diff text as delivered", () => {
    const { diffFiles } = buildFindBrief(args({ change: { ...change, diffs: [] } }), unit, "local");
    expect(diffFiles.has("app/search.py")).toBe(false);
  });

  it("does not count a file as delivered when one of its unit hunks has no rows", () => {
    const { diffFiles } = buildFindBrief(args(), { ...unit, hunks: [
      ...unit.hunks, { id: "h0", path: "app/search.py", start: 1, end: 1, deletion: false },
    ] }, "local");
    expect(diffFiles.has("app/search.py")).toBe(false);
  });

  it("leaves a hunk past the brief's diff budget to the tools and does not count its file as delivered", () => {
    // Three hundred lines of a thousand characters each: one indivisible hunk over 200 KB.
    const wide = Array.from({ length: 300 }, (_, i) => `+${"x".repeat(1000)}${i}`).join("\n");
    const bigDiff = `diff --git a/app/wide.py b/app/wide.py\n--- /dev/null\n+++ b/app/wide.py\n@@ -0,0 +1,300 @@\n${wide}\n`;
    const wideUnit: ReviewUnit = { id: "u2", files: ["app/wide.py", "app/search.py"], hunks: [
      { id: "h1", path: "app/wide.py", start: 1, end: 300, deletion: false },
      { id: "h2", path: "app/search.py", start: 14, end: 15, deletion: false },
    ], diffBytes: bigDiff.length + searchDiff.length };
    const { text, diffFiles } = buildFindBrief(args({ change: { ...change, diffs: [...change.diffs!, { path: "app/wide.py", text: bigDiff }] } }), wideUnit, "local");
    expect(text).toContain("### h1 app/wide.py 1-300");
    expect(text).toMatch(/This hunk is \d+ KB, more than the 200 KB a brief carries for one hunk\. Read its lines with your tools\./);
    expect(text).not.toContain("x".repeat(1000));
    expect(text).toContain("+    return cur.fetchall()");
    expect(diffFiles.has("app/wide.py")).toBe(false);
    expect(diffFiles.has("app/search.py")).toBe(true);
  });

  it("shows the file header once when the unit has several hunks in that file", () => {
    const grouped = { ...unit, hunks: [...unit.hunks, { id: "h2", path: "app/search.py", start: 41, end: 41, deletion: false }] };
    const { text } = buildFindBrief(args(), grouped, "local");
    expect(text).toContain("### h2 app/search.py 41-41");
    expect(text).toContain("+other_unit_only()");
    expect(text.match(/^diff --git a\/app\/search.py b\/app\/search.py$/gm)).toHaveLength(1);
  });

  it("trims a shared unified hunk to the unit's assigned range", () => {
    const diff = "diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py\n@@ -14,3 +14,3 @@\n-old_first()\n+new_first()\n context()\n-old_second()\n+new_second()\n";
    const { text } = buildFindBrief(args({ change: makeChange({ diffs: [{ path: "app/search.py", text: diff }] }) }), { ...unit, hunks: [{ ...unit.hunks[0]!, end: 14 }] }, "local");
    expect(text).toContain("-old_first()\n+new_first()");
    expect(text).not.toContain("second()");
    expect(text).not.toContain(" context()");
  });

  it.each(["find", "verify"] as const)("numbers separate ranges correctly after omitted context in the %s brief", (kind) => {
    const diff = [
      "diff --git a/app/search.py b/app/search.py", "--- a/app/search.py", "+++ b/app/search.py",
      "@@ -11,6 +11,7 @@", " context_11()", " context_12()", " context_13()", "+inserted()",
      " context_14()", " context_15()", "-old_second()", "+new_second()", "",
    ].join("\n");
    const input = args({ change: makeChange({ diffs: [{ path: "app/search.py", text: diff }] }) });
    const hunks = [
      { id: "h1", path: "app/search.py", start: 14, end: 14, deletion: false },
      { id: "h2", path: "app/search.py", start: 17, end: 17, deletion: false },
    ];
    const { text } = kind === "find"
      ? buildFindBrief(input, { ...unit, hunks }, "local")
      : buildVerifyBrief(input, { ...batch, hunks });
    expect(text).toContain("@@ -13,0 +14,1 @@\n+inserted()");
    expect(text).toContain("@@ -16,1 +17,1 @@\n-old_second()\n+new_second()");
    expect(text).not.toContain("@@ -11,6 +11,7 @@");
    expect(text).not.toContain("context_11()");
  });

  it("gives separated shown runs their own header and counts", () => {
    const diff = "diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py\n@@ -14 +14,2 @@\n-old()\n+first()\n+second()\n";
    const { text } = buildFindBrief(args({ change: makeChange({ diffs: [{ path: "app/search.py", text: diff }] }) }), {
      ...unit, hunks: [{ id: "h1", path: "app/search.py", start: 15, end: 15, deletion: false }],
    }, "local");
    expect(text).toContain("@@ -14,1 +13,0 @@\n-old()\n@@ -14,0 +15,1 @@\n+second()");
    expect(text).not.toContain("+first()");
  });

  it("keeps the file header for the first hunk that has rows", () => {
    const { text } = buildFindBrief(args(), { ...unit, hunks: [
      { id: "h0", path: "app/search.py", start: 1, end: 1, deletion: false }, ...unit.hunks,
    ] }, "local");
    const shown = text.slice(text.indexOf("### h1 app/search.py"));
    expect(shown).toContain("diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py");
    expect(text.match(/^diff --git /gm)).toHaveLength(1);
  });

  it("keeps removed replacement text across a no-newline marker", () => {
    const diff = "diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py\n@@ -14 +14 @@\n-old()\n\\ No newline at end of file\n+new()\n";
    const { text } = buildFindBrief(args({ change: makeChange({ diffs: [{ path: "app/search.py", text: diff }] }) }), unit, "local");
    expect(text).toContain("-old()\n\\ No newline at end of file\n+new()");
  });

  it("shows removed lines and deletion anchors without another hunk's text", () => {
    const deleted = { ...unit, hunks: [{ id: "h3", path: "app/search.py", start: 50, end: 51, deletion: true }] };
    const { text } = buildFindBrief(args(), deleted, "local");
    expect(text).toContain("### h3 app/search.py 50-51");
    expect(text).toContain("-removed_guard()\n-removed_return()");
    expect(text).toContain("Cite deletion anchor 50 or 51");
    expect(text).not.toContain("other_unit_only");
  });

  it("shows deletion text between its anchors when the diff holds context", () => {
    const diff = "diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py\n@@ -50,4 +50,2 @@\n before()\n-removed_guard()\n-removed_return()\n after()\n";
    const { text } = buildFindBrief(args({ change: { ...change, diffs: [{ path: "app/search.py", text: diff }] } }), { ...unit, hunks: [{ id: "h3", path: "app/search.py", start: 50, end: 51, deletion: true }] }, "local");
    expect(text).toContain(" before()\n-removed_guard()\n-removed_return()\n after()");
  });

  it("matches deletions with the same anchors to separate removed runs in order", () => {
    const diff = "diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py\n@@ -1,3 +1 @@\n-a\n b\n-c\n";
    const input = args({ change: makeChange({
      diffs: [{ path: "app/search.py", text: diff }],
      deletionPoints: new Map([["app/search.py", [
        { after: 0, lines: 1, anchors: [1] }, { after: 1, lines: 1, anchors: [1] },
      ]]]),
    }) });
    const { text } = buildFindBrief(input, { ...unit, hunks: [
      { id: "h1", path: "app/search.py", start: 1, end: 1, deletion: true, point: 0 },
      { id: "h2", path: "app/search.py", start: 1, end: 1, deletion: true, point: 1 },
    ] }, "local");
    const first = text.slice(text.indexOf("### h1"), text.indexOf("### h2"));
    const second = text.slice(text.indexOf("### h2"));
    expect(first).toContain("@@ -1,2 +1,1 @@\n-a\n b");
    expect(first).not.toContain("\n-c\n");
    expect(second).toContain("@@ -2,2 +1,1 @@\n b\n-c");
    expect(second).not.toContain("\n-a\n");
  });

  it("never exposes scanner candidates or their disposition instructions through shared blocks", () => {
    const { text } = buildFindBrief(args({ instructions: "Owners' scope.", instructionFiles: [{ path: "STYLE.md", text: "Use clear names." }], context: [{ kind: "note", source: "host", text: "Changed query." }] }), unit, "contracts");
    expect(text).not.toMatch(/scanner candidate|raised or dropped|`dropped`|repo instructions:/i);
    expect(text).not.toContain(SQL_CANDIDATE.token);
    expect(text).not.toContain(SQL_CANDIDATE.message);
  });

  it("uses the finder floor while the single-pass reviewer keeps 0.7", () => {
    expect(buildFindBrief(args(), unit, "local").text).toContain(`confidence ${FINDER_CONFIDENCE_FLOOR} or higher`);
    expect(buildReviewerBrief(args()).text).toContain("Findings under 0.7");
  });

  it.each(["local", "contracts"] as const)("states the questions of the %s pass", (pass) => {
    const { text } = buildFindBrief(args(), unit, pass);
    expect(text).toContain(`Pass: ${pass}`);
    expect(text).toContain(pass === "local" ? "error paths, data flow and defaults" : "schema, config and API surface");
    expect(text).toContain("Name the question you are answering before each read");
  });

  it("keeps owner, convention, host, target, neighbourhood and lens blocks in order", () => {
    const target: RunTarget = { spec: "feature", base_ref: "main", base_source: "--base", base_sha: "a".repeat(40), merge_base: "a".repeat(40), head_sha: "b".repeat(40), repo_root: "/tmp/repo", checkout: "/tmp/target" };
    const { text } = buildFindBrief(args({ target, instructions: "Scope.", instructionFiles: [{ path: "STYLE.md", text: "Rule." }], context: [{ kind: "comment", source: "host", text: "Context." }], neighbourhoodBlock: "## Code around the change\n\nA caller.", lenses: [{ name: "query", description: "Queries", body: "Check parameters.", confidenceFloor: 0.8 }] }), unit, "local");
    const headings = ["# OpenQodex review brief: find pass", "## Where to read the code", "## Instructions from this repo's owners", "## Conventions chosen by this repo's owners", "## Comments given with this review", "## Your unit", "### h1 app/search.py 14-15", "## Code around the change", "## Patterns to weigh", "## Your pass", "## How to work", "## Answer"];
    const positions = headings.map((heading) => text.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).not.toContain("run finalize");
    expect(text).toContain("set `lens` to its name");
  });
});

describe("verify brief", () => {
  it("shows owner scope and conventions with the rule for refuting excluded candidates", () => {
    const { text } = buildVerifyBrief(args({
      instructions: "Do not flag query examples under fixtures/.",
      instructionFiles: [{ path: "STYLE.md", text: "Use clear parameter names." }],
    }), batch);
    expect(text).toContain("## Instructions from this repo's owners");
    expect(text).toContain("> Do not flag query examples under fixtures/.");
    expect(text).toContain("## Conventions chosen by this repo's owners");
    expect(text).toContain("> Use clear parameter names.");
    expect(text).toContain("Refute a candidate the owners' instructions put out of scope with a reason starting `repo instructions:`.");
    expect(text).not.toContain("`summary`");
    expect(text).not.toContain("`dropped`");
  });

  it("confirms duplicates and keeps the scanner candidate as the survivor", () => {
    const { text } = buildVerifyBrief(args(), batch);
    expect(text).toContain("Every duplicate carries verdict `confirmed` and `duplicate_of` the surviving id.");
    expect(text).toContain("When a scanner candidate is among duplicates, keep the scanner candidate as the survivor.");
    expect(text).toContain("Mark the finder candidate `duplicate_of` the scanner candidate.");
  });

  it("shows a finder candidate's lens and its confidence floor", () => {
    const { text } = buildVerifyBrief(args({ lenses: [{ name: "query", description: "Queries", body: "Check parameters.", confidenceFloor: 0.85 }] }), {
      ...batch, candidates: [{ id: "k1", kind: "finder", candidate: { ...candidate, lens: "query" }, foundBy: ["local"] }],
    });
    expect(text).toContain("Lens: query (floor 0.85)");
    expect(text).toContain("Findings at 0.7 or higher, and at a cited lens's floor, count toward the verdict. Findings from 0.5 up to the floor are shown as possible issues and never counted. Findings under 0.5 are dropped.");
  });

  it("states the configured verifier floor instead of the default", () => {
    const { text } = buildVerifyBrief(args({ confidenceFloor: 0.85 }), batch);
    expect(text).toContain("Findings at 0.85 or higher, and at a cited lens's floor, count toward the verdict. Findings from 0.5 up to the floor are shown as possible issues and never counted. Findings under 0.5 are dropped.");
    expect(text).not.toContain("Findings under 0.7");
  });

  it("lists every batch candidate with the claim, evidence, passes or scanner token", () => {
    const { text } = buildVerifyBrief(args(), batch);
    for (const item of batch.candidates) expect(text).toContain(`### ${item.id} (${item.kind})`);
    expect(text).toContain("finder:u1:local, finder:u1:contracts");
    expect(text).toContain(candidate.claim);
    expect(text).toContain(candidate.evidence[0]!.quote);
    expect(text).toContain(SQL_CANDIDATE.token);
    expect(text).toContain(SQL_CANDIDATE.message);
    expect(text).toContain(`- Severity: ${SQL_CANDIDATE.reviewSeverity}\n- Category: security`);
    expect(text).toContain("A scanner candidate is always confirmed or refuted, never unresolved.");
    expect(text).toContain("Never add a candidate of your own.");
  });

  it("shows the batch's hunks and neighbourhood without another file's diff", () => {
    const block = "## Code around the change\n\nCaller context.";
    const { text } = buildVerifyBrief(args({ neighbourhoodBlock: block }), batch);
    expect(text).toContain("## The file\n\napp/search.py");
    expect(text).toContain("### h1 app/search.py 14-15");
    expect(text.indexOf(block)).toBeLessThan(text.indexOf("## Candidates to verify"));
    expect(text).not.toContain("other_unit_only");
    expect(text).not.toContain("app/settings.py");
  });

  it("provides a confirmed example accepted by the final submission's prose and anchor checks", () => {
    const example = answer(buildVerifyBrief(args(), batch).text);
    const confirmed = example.verdicts[0]!;
    expect(confirmed.verdict).toBe("confirmed");
    const submission: SubmissionV2 = {
      version: 2, change_id: example.change_id, summary: "Reviews the search query.",
      findings: [{ ...confirmed, category: candidate.category, source: null }], dropped: [],
    };
    const checked = checkSubmission({ change, scan: makeScan({ candidates: [] }), manifest: makeManifest(change), config: makeConfig(), submission, lineCount: () => 100 });
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(checked.ok).toBe(true);
  });

  it("uses the scanner id in a scanner-first batch's confirmed example", () => {
    const example = answer(buildVerifyBrief(args(), { ...batch, candidates: [...batch.candidates].reverse() }).text);
    const confirmed = example.verdicts[0]!;
    expect(confirmed.id).toBe(SQL_CANDIDATE.id);
    expect(confirmed.line_number).toBe(SQL_CANDIDATE.lineStart);
    const submission: SubmissionV2 = {
      version: 2, change_id: example.change_id, summary: "Reviews the search query.",
      findings: [{ ...confirmed, category: "security", source: SQL_CANDIDATE.token, candidate: confirmed.id }], dropped: [],
    };
    const checked = checkSubmission({ change, scan: makeScan({ candidates: [SQL_CANDIDATE] }), manifest: makeManifest(change), config: makeConfig(), submission, lineCount: () => 100 });
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(checked).toMatchObject({ ok: true, required: 1, disposed: 1 });
  });
});

describe("staged brief redaction and framing", () => {
  it.each(["find", "verify"] as const)("never asks for missing-test findings in the %s brief", (kind) => {
    const { text } = kind === "find" ? buildFindBrief(args(), unit, "contracts") : buildVerifyBrief(args(), batch);
    expect(text).not.toContain("raise one low-severity finding");
  });

  it.each(["find", "verify"] as const)("redacts secrets in every %s brief block", (kind) => {
    const leakyArgs = args({ instructions: SECRET, instructionFiles: [{ path: "STYLE.md", text: SECRET }], context: [{ kind: "note", source: "host", text: SECRET }], impactBlock: `## Impact\n\n${SECRET}`, neighbourhoodBlock: `## Code around the change\n\n${SECRET}`, lenses: [{ name: "secret", description: SECRET, body: SECRET, confidenceFloor: 0.7 }] });
    const leakyUnit = { ...unit, files: ["app/settings.py"], hunks: [{ id: "h4", path: "app/settings.py", start: 1, end: 1, deletion: false }] };
    const leakyBatch: VerifyBatch = { ...batch, candidates: [
      { id: "k1", kind: "finder", candidate: { ...candidate, claim: SECRET, evidence: [{ file_path: "app/search.py", line_number: 14, quote: SECRET }] }, foundBy: ["local"] },
      { id: "c1", kind: "scanner", candidate: { ...SQL_CANDIDATE, message: SECRET } },
    ] };
    const { text } = kind === "find" ? buildFindBrief(leakyArgs, leakyUnit, "local") : buildVerifyBrief(leakyArgs, leakyBatch);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[redacted]");
    expect(redactSecrets(text, [SECRET])).toBe(text);
    expect(text).not.toContain(["A wrong finding", "is worse than a missed one"].join(" "));
  });

  it("uses a fence longer than backticks in the unit's diff", () => {
    const diff = "diff --git a/app/search.py b/app/search.py\n--- a/app/search.py\n+++ b/app/search.py\n@@ -14 +14 @@\n-old()\n+```\n";
    const { text } = buildFindBrief(args({ change: makeChange({ diffs: [{ path: "app/search.py", text: diff }] }) }), unit, "local");
    expect(text).toContain("````diff\n");
  });
});

// Failure cases: the briefs omit the causal chain or advertise stale limits.
it("asks both sessions to name each causal step and allows three claim and problem sentences", () => {
  const finder = buildFindBrief(args(), unit, "local").text;
  const verifier = buildVerifyBrief(args(), batch).text;
  expect(finder).toContain("Name the code that makes it happen at each step");
  expect(finder).toContain("a bare `pass`, an empty handler");
  expect(finder).toContain("At most 3 sentences in `claim`");
  expect(verifier.match(/keep the candidate's cause and consequence/g)).toHaveLength(2);
  expect(verifier).toContain("Correct a detail only when you cite the line that refutes it");
  expect(verifier).toContain("At most 3 sentences in `problem`");
  expect(verifier).toContain("At most 2 sentences in `consequence`");
  expect(buildReviewerBrief(args()).text).toContain("At most 3 sentences in `problem`");
});

// Failure case: the finder examines hunks without following their combined flow.
it("asks the finder to follow changed operations through the whole flow across hunks", () => {
  const text = buildFindBrief(args(), unit, "local").text;
  expect(text).toContain("Then follow each changed condition, mutation, async completion and cleanup through the whole flow it belongs to.\nLook across the other hunks of this unit and the code around the change.");
  const shape = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);
  expect(Object.keys(shape)).toEqual(["version", "change_id", "unit", "examined", "analysis", "candidates"]);
});

// Failure case: the verifier calibrates to findings disappearing under the floor.
it("tells the verifier that possible issues are shown and never counted", () => {
  expect(buildVerifyBrief(args(), batch).text).toContain("Findings at 0.7 or higher, and at a cited lens's floor, count toward the verdict. Findings from 0.5 up to the floor are shown as possible issues and never counted. Findings under 0.5 are dropped.");
});
