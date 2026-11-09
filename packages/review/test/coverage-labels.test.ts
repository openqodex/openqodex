// Failures guarded:
// 1. Single-pass deletions share a made-up id, including saved coverage.
// 2. Summary strings retain every unread range instead of the first ten.
// 3. Empty and single-line missing ranges print reversed or repeated ends.
// 4. Credited parts lose the part numbers kept on their unread siblings.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@openqodex/core";
import { completionRecord, modelCompletionRecord, readCoverage, singlePassCoverage, singlePassModelCoverage } from "../../core/src/completion.js";
import type { Hunk } from "../../core/src/completion.js";
import { fileCoverageLines } from "../../core/src/render/review.js";
import { makeChange } from "../../core/src/test-fixtures.js";
import type { Change, Coverage, ReviewerRecord } from "@openqodex/core";
import { failureOf } from "../../../benchmark/lib/runner.mjs";
import { reviewChange } from "../src/review-change.js";
import { withSecondReviewer } from "../src/second.js";
import { fixtureModel } from "./fixture-model.js";
import { changeRepo, git } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const reviewer: ReviewerRecord = { driver: "fixture", version: "1", pid: null, started_at: "now", ended_at: "now", duration_ms: 0, rounds: 1, usage: { turns: 1, input_tokens: null, output_tokens: null, cost_usd: null } };
function record(change: Change, coverage: Coverage) {
  return completionRecord({ change, coverage, reviewer, snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, trace: [], submissionErrors: [], wholeRepo: false });
}

it("C3 round 2. single-pass unread deletions keep their real ids without inventing saved ids", () => {
  const change = makeChange({ coverage: new Map(), deletionPoints: new Map([["a.py", [
    { after: 4, anchors: [4, 5], lines: 2 },
    { after: 9, anchors: [9, 10], lines: 3 },
  ]]]) });
  const coverage = singlePassCoverage({ change, diffFiles: new Set(), trace: [] });
  expect(record(change, coverage).missing).toEqual(["2 changed ranges were not examined", "a.py:4-5 (deletion a.py#0)", "a.py:9-10 (deletion a.py#1)"]);
  expect(fileCoverageLines({ ...coverage, given: [] })).toEqual(["a.py: 4-5 (deletion) not examined, 9-10 (deletion) not examined"]);
});

it("C3 round 3. the model reviewer's single pass names unread deletions by the same ids as the agent record", () => {
  const change = makeChange({ coverage: new Map(), deletionPoints: new Map([["a.py", [
    { after: 4, anchors: [4, 5], lines: 2 },
    { after: 9, anchors: [9, 10], lines: 3 },
  ]]]) });
  const coverage = singlePassModelCoverage({ change, diffFiles: new Set(), briefSent: true, toolLog: [] });
  const args = { changeId: change.id, model: "m-1", snapshot: { tree: null, before: "same", after: "same" }, candidates: { total: 0, disposed: 0 }, coverage, toolLog: [], attempts: [], tools: [], submissionErrors: [] };
  const unread = (missing: string[]) => missing.filter((line) => line.startsWith("a.py") || line.includes("not examined"));
  expect(unread(modelCompletionRecord({ ...args, deletionPoints: change.deletionPoints }).missing)).toEqual(["2 changed ranges were not examined", "a.py:4-5 (deletion a.py#0)", "a.py:9-10 (deletion a.py#1)"]);
  // Without the change the id is unknown and no id is invented.
  expect(unread(modelCompletionRecord(args).missing)).toEqual(["2 changed ranges were not examined", "a.py:4-5 (deletion)", "a.py:9-10 (deletion)"]);
});

it("C3 round 2. four summaries shorten eleven unread ranges while missing keeps all eleven", async () => {
  const repo = changeRepo();
  mkdirSync(join(repo.dir, "unread"));
  for (let n = 1; n <= 11; n++) writeFileSync(join(repo.dir, "unread", `${String(n).padStart(2, "0")}.txt`), "first\nsecond\n");
  git(repo.dir, "add", "unread");
  git(repo.dir, "commit", "-qm", "Eleven unread ranges");
  const result = await reviewChange({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: git(repo.dir, "rev-parse", "HEAD"), scopes: ["unread"], config: { ...DEFAULT_CONFIG, stages: false, graph: { ...DEFAULT_CONFIG.graph, enabled: false } } }, fixtureModel(), {
    profile: "server", workDir: tempDir("oq-label-work-"), installRoot: tempDir("oq-label-tools-"), tools: { web: false, shell: false }, scanners: "preinstalled", budget: { deadlineMs: 120_000, authorize: async () => false },
  });
  const completion = result.completion!;
  expect(completion.coverage.unread).toHaveLength(11);
  expect(completion.missing.filter((line) => line.startsWith("unread/"))).toHaveLength(11);
  const second = withSecondReviewer({ ...completion, second: { ...completion, attempts: [] } }, [], []);
  const report = JSON.parse(result.render.json());
  const summaries = [result.reason!, second.notes![0]!, JSON.parse(result.render.sarif()).runs[0].invocations[0].toolExecutionNotifications[0].message.text, failureOf({}, report)!.cause];
  for (const text of summaries) {
    expect.soft(text).toContain("11 changed ranges were not examined");
    for (let n = 1; n <= 10; n++) expect.soft(text).toContain(`unread/${String(n).padStart(2, "0")}.txt:1-2`);
    expect.soft(text).not.toContain("unread/11.txt:1-2");
    expect.soft(text).toContain("and 1 more; the report names each one");
  }
});

it("C3 round 2. empty and single-line missing ranges omit the end", () => {
  const change = makeChange();
  const obligations = [{ path: "a.txt", start: 1, end: 0, deletion: false }, { path: "a.py", start: 3, end: 3, deletion: false }];
  expect(record(change, readCoverage({ change, obligations, trace: [] })).missing).toEqual(["2 changed ranges were not examined", "a.txt:1", "a.py:3"]);
});

it("C3 round 2. credited and unread parts both keep their part numbers", () => {
  const change = makeChange({ files: [] });
  const obligations: Hunk[] = [1, 2].map((n) => ({ path: "a.py", start: (n - 1) * 5 + 1, end: n * 5, deletion: false, part: { n, of: 2, whole: "h1" } }));
  const coverage = readCoverage({ change, obligations, briefCarried: [obligations[0]!], trace: [] });
  expect(fileCoverageLines(coverage)).toEqual(["a.py: 1-5 (part 1 of 2) brief, 6-10 (part 2 of 2) not examined"]);
  for (const by of ["brief", "page", "digest", "read"] as const) {
    const covered = readCoverage({ change, obligations: [obligations[0]!], briefCarried: by === "brief" ? [obligations[0]!] : [], digestCarried: by === "digest" ? [obligations[0]!] : [], delivered: by === "page" ? [obligations[0]!] : [], trace: by === "read" ? [{ tool: "Read", path: "a.py", inside: true, ok: true, range: [1, 5] }] : [] });
    expect(covered.given![0]!.part).toEqual({ n: 1, of: 2, whole: "h1" });
    expect(fileCoverageLines(covered)).toEqual([`a.py: 1-5 (part 1 of 2) ${by === "digest" ? "structural summary" : by}`]);
  }
});
