// A second reviewer through reviewChange, on a real git clone, with the
// fixture model as the only stand-in for both reviewers: it runs after the
// primary on the same brief and tools, under the same budget, and its
// findings join the primary's with each finding naming who found it.
//
// Ways it could fail, written before the code:
//  1. A finding both reviewers raise is listed twice, keeps the lower
//     severity, or loses a reviewer's name; a finding only the second raised
//     is missing or credited to the primary.
//  2. One reviewer's dispositions replace the other's, or a candidate one
//     raised and the other dropped is not recorded as a disagreement in the
//     result and in the completion record.
//  3. The second reviewer starts before the primary's last call, its calls
//     are not asked of the budget as the second's, or the budget is shown
//     usage without the primary's calls and so under-counts the review.
//  4. A second reviewer that fails makes the review incomplete, or its
//     failure is named neither in the notes nor in the record.
//  5. A budget refusal during the second reviewer leaves the review
//     complete, or drops the primary's findings or usage.
//  6. A second reviewer that fails after an answer that passed its checks
//     still joins with that answer: its findings, dispositions or
//     disagreements change the primary's outcome.
//  7. The rendered report (JSON, markdown, SARIF) leaves out who found each
//     finding, the candidates the second reviewer dropped, or the notes.
import { afterAll, describe, expect, it } from "vitest";
import { reviewChange } from "../src/review-change.js";
import type { AuthorizeRequest, ReviewChangeOptions } from "../src/reviewer.js";
import { fixtureModel } from "./fixture-model.js";
import type { Finding, FixtureOptions } from "./fixture-model.js";
import { changeRepo } from "./repos.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const SUBTRACTION: Finding = {
  severity: "major",
  category: "bug",
  confidence: 0.75,
  file_path: "src/math.ts",
  line_number: 2,
  title: "Subtraction in add",
  problem: "The add function subtracts its second argument.",
  consequence: "Every caller gets a wrong sum.",
  fix: "Return a plus b.",
  source: null,
  candidate: null,
};

async function run(second: FixtureOptions, refuseAt?: number, big = false) {
  const repo = changeRepo({ big });
  const primary = fixtureModel({ findings: [SUBTRACTION] });
  const other = fixtureModel({ model: "second-model", ...second });
  const asked: AuthorizeRequest[] = [];
  const options: ReviewChangeOptions = {
    profile: "server",
    workDir: tempDir("oq-second-work-"),
    installRoot: tempDir("oq-second-install-"),
    tools: { web: false, shell: false },
    scanners: "preinstalled",
    secondReviewer: other,
    budget: {
      deadlineMs: 120_000,
      authorize: async (call) => {
        asked.push(structuredClone(call));
        return asked.length !== refuseAt;
      },
    },
  };
  const result = await reviewChange({ clonePath: repo.dir, mergeBaseSha: repo.base, headSha: repo.head }, primary, options);
  return { result, primary, other, asked };
}

describe("a second reviewer through reviewChange", () => {
  it("1, 2, 3. merges a shared finding under both names, keeps both disposition sets and records the disagreement", async () => {
    // The second raises the subtraction as critical and raises the
    // candidate the primary dropped.
    const { result, primary, other, asked } = await run({ findings: [{ ...SUBTRACTION, severity: "critical" }], raise: true });
    expect(result.status).not.toBe("incomplete");
    expect(result.notes).toEqual([]);
    const shared = result.findings.filter((f) => f.title === "Subtraction in add");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ severity: "critical", foundBy: ["fixture-model", "second-model"] });
    const candidate = result.findings.filter((f) => f.candidate !== null);
    expect(candidate.length).toBeGreaterThan(0);
    for (const f of candidate) expect(f.foundBy).toEqual(["second-model"]);
    const ids = candidate.map((f) => f.candidate);
    expect(result.dispositions.map((d) => [d.by, d.candidate, d.outcome])).toEqual([
      ...ids.map((id) => ["primary", id, "dropped"]),
      ...ids.map((id) => ["second", id, "raised"]),
    ]);
    const disagreements = ids.map((id) => ({ candidate: id, raisedBy: "second-model", droppedBy: "fixture-model", reason: "The function is internal and never exposed." }));
    expect(result.disagreements).toMatchObject(disagreements);
    expect(result.completion?.disagreements).toMatchObject(disagreements);
    expect(result.completion?.second).toMatchObject({ contract: "openqodex-model-review-1", status: "complete", reviewer: { model: "second-model" } });
    // One after the other, under one budget that sees the whole review's usage.
    const firstOfSecond = asked.findIndex((a) => a.reviewer === "second");
    expect(asked.slice(0, firstOfSecond).every((a) => a.reviewer === "primary")).toBe(true);
    expect(asked.slice(firstOfSecond).map((a) => [a.reviewer, a.purpose, a.callId, a.model])).toEqual(other.requests.map((_, i) => ["second", "second", `second-${i + 1}`, "second-model"]));
    expect(asked[firstOfSecond]!.usageSoFar.invoked).toBe(primary.requests.length);
    expect(result.usage.calls.map((c) => c.reviewer)).toEqual([...primary.requests.map(() => "primary"), ...other.requests.map(() => "second")]);
  });

  it("4. a second reviewer that fails leaves the review complete and names the failure in the notes and the record", async () => {
    const { result, other } = await run({ throwOn: 1 });
    expect(other.requests).toHaveLength(1);
    expect(result.status).toBe("complete");
    expect(result.notes).toEqual(["the second reviewer (second-model) did not complete: the model call failed: connection reset by the provider"]);
    expect(result.completion?.status).toBe("complete");
    expect(result.completion?.notes).toEqual(result.notes);
    expect(result.completion?.second?.missing).toContain("the model call failed: connection reset by the provider");
    expect(result.findings.map((f) => [f.title, f.foundBy])).toEqual([["Subtraction in add", ["fixture-model"]]]);
  });

  it("5. a budget refusal during the second reviewer ends the review incomplete, with the primary's findings and usage kept", async () => {
    // The primary answers in one call; the budget refuses the second's first.
    const { result, primary, other } = await run({ raise: true }, 2);
    expect(primary.requests).toHaveLength(1);
    expect(other.requests).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("the second reviewer: budget refused before second call 1");
    expect(result.findings.map((f) => [f.title, f.foundBy])).toEqual([["Subtraction in add", ["fixture-model"]]]);
    expect(result.usage.calls.map((c) => [c.callId, c.outcome])).toEqual([
      ["primary-1", "ok"],
      ["second-1", "refused"],
    ]);
  });

  it("6. a second reviewer that fails after a checked answer changes nothing in the primary's outcome", async () => {
    // Its first answer passes every check with a critical finding but leaves
    // b/second.txt unread; the correction call that would carry it fails.
    const { result, other } = await run({ findings: [{ ...SUBTRACTION, severity: "critical" }], throwOn: 2 }, undefined, true);
    expect(other.requests).toHaveLength(2);
    expect(result.status).toBe("complete");
    expect(result.findings.map((f) => [f.title, f.severity, f.foundBy])).toEqual([["Subtraction in add", "major", ["fixture-model"]]]);
    expect(result.dispositions.every((d) => d.by === "primary")).toBe(true);
    expect(result.disagreements).toEqual([]);
    expect(result.notes).toEqual(["the second reviewer (second-model) did not complete: the model call failed: connection reset by the provider"]);
  });

  it("7. every rendering carries who found each finding, the second reviewer's drops and the notes", async () => {
    // Both raise the subtraction; both drop the SQL candidate.
    const joined = await run({ findings: [{ ...SUBTRACTION, severity: "critical" }] });
    const json = JSON.parse(joined.result.render.json()) as { findings: { title: string; found_by: string[] }[]; dropped: unknown[]; second_dropped: { candidate: { id: string }; reason: string }[] };
    expect(json.findings.map((f) => [f.title, f.found_by])).toEqual([["Subtraction in add", ["fixture-model", "second-model"]]]);
    expect(json.second_dropped.length).toBe(json.dropped.length);
    expect(json.second_dropped.length).toBeGreaterThan(0);
    const markdown = joined.result.render.markdown();
    expect(markdown).toContain("**Found by:** fixture-model, second-model");
    expect(markdown).toContain(`## Dropped by the second reviewer \\(${json.second_dropped.length}\\)`);
    const sarif = JSON.parse(joined.result.render.sarif()) as { runs: { results: { properties: { found_by?: string[] } }[] }[] };
    expect(sarif.runs[0]!.results.map((r) => r.properties.found_by)).toContainEqual(["fixture-model", "second-model"]);
    // A second reviewer that failed: its note in every rendering.
    const failed = await run({ throwOn: 1 });
    const note = "the second reviewer (second-model) did not complete: the model call failed: connection reset by the provider";
    expect(JSON.parse(failed.result.render.json()).notes).toEqual([note]);
    expect(failed.result.render.markdown()).toContain("## Notes");
    // Markdown escapes the brackets around the model's name.
    expect(failed.result.render.markdown()).toContain("did not complete: the model call failed: connection reset by the provider");
    expect(JSON.parse(failed.result.render.sarif()).runs[0].properties.completion.notes).toEqual([note]);
  });
});
