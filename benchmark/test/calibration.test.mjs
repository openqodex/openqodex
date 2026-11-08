// Failure list: calibration-failures.md, written before implementation.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agreementOf, checkedBytes, compareLabels, costOfUsage, finalizeCalibration, hash, martianLabels, validateCalibration } from "../lib/calibration.mjs";
import { greptileInputs, martianInputs } from "../lib/calibration-inputs.mjs";
import { benchRoot } from "../lib/cases.mjs";
import { suiteHashOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { judgeGreptile } from "../outside/boards/greptile-judge.mjs";
import { MARTIAN_CITED } from "../lib/martian-board.mjs";
import { calibrationSteps } from "../outside/boards/martian-judge.mjs";

afterAll(removeTempDirs);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };

const cases = [{ id: "one", comments: ["The callback runs without awaiting it."], truthSets: { greptile: { items: [{ text: "Unawaited callback" }] }, augment: { items: [{ text: "A different corrected issue" }] } } }];
const labels = [{ id: "one", label: "caught" }, { id: "two", label: "missed" }];
const build = { commit: "a".repeat(40), tree: "b".repeat(40), bundleHash: "c".repeat(64), version: "0.12.0" };
const board = { name: "greptile", promptHash: "d".repeat(64), judgeModel: "gpt-5.2" };
function record() {
  const counts = compareLabels(labels, labels, ["caught", "missed"]);
  return { version: 1, board, vendor: "Greptile", labelUnit: "case", build, counts, agreement: agreementOf(counts), judgeModel: board.judgeModel, promptHash: board.promptHash, costUsd: 0.01 };
}

describe("board calibration", () => {
  it("refuses a Greptile calibration suite missing a case from its split before reading public sources", async () => {
    const root = tempDir("oq-calibration-greptile-count-");
    const suite = read(join(benchRoot, "suites/greptile/cases.json"));
    const split = read(join(benchRoot, "splits/greptile-v1.json"));
    suite.cases = suite.cases.slice(0, 1);
    split.cases.dev = split.cases.dev.slice(0, 2);
    suite.hash = suiteHashOf(suite.cases);
    write(join(root, "suites/greptile/cases.json"), suite);
    write(join(root, "splits/greptile-v1.json"), split);
    const count = split.cases.dev.length + split.cases.test.length;
    await expect(greptileInputs({ root })).rejects.toThrow(`Greptile requires all ${count} cases from splits/greptile-v1.json`);
  });
  it("refuses a Martian public review count that differs from its split instead of a literal fifty", async () => {
    const root = tempDir("oq-calibration-martian-count-");
    const suite = read(join(benchRoot, "suites/martian/cases.json"));
    const split = read(join(benchRoot, "splits/martian-v1.json"));
    split.cases.test = split.cases.test.slice(0, 2);
    write(join(root, "suites/martian/cases.json"), suite);
    write(join(root, "splits/martian-v1.json"), split);
    const reviews = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`review-${i}`, {}]));
    const file = join(root, "results/calibration-sources/martian/reviews.json");
    write(file, reviews);
    write(join(root, "suites/martian/verification-source.json"), { path: "reviews.json", sha256: hash(readFileSync(file)) });
    await expect(martianInputs({ root })).rejects.toThrow("Martian requires all 2 public reviews from splits/martian-v1.json");
  });
  for (const name of ["caught", "missed"]) it(`refuses less than 90 percent agreement on ${name}`, () => {
    const r = record(); r.counts.byClass[name] = { agree: 8, disagree: 2, total: 10 }; r.counts.agree = 9; r.counts.disagree = 2; r.counts.total = 11; r.agreement = agreementOf(r.counts);
    expect(() => validateCalibration(r, { build, board })).toThrow(/90 percent/);
  });
  it("refuses a calibration from another build", () => {
    const r = record(); r.build = { ...build, tree: "e".repeat(40) };
    expect(() => validateCalibration(r, { build, board })).toThrow(/build/);
  });
  it("a form calibration cited in a comparison is refused", () => {
    expect(validateCalibration(record(), { build, board })).toMatchObject({ board });
    for (const form of ["flat", "joined", null, undefined]) {
      expect(() => validateCalibration({ ...record(), form }, { build, board })).toThrow(/form calibration/);
    }
  });
  it("refuses judge failures without recorded exclusions even when the remaining labels agree", () => {
    const r = { ...record(), judgeFailures: { items: 1, labels: 2, byClass: { positive: 1, negative: 1 } } };
    expect(() => validateCalibration(r, { build, board })).toThrow(/exclu/);
  });
  it("completes a calibration with an excluded deduplication item and exits 0", () => {
    const r = { ...record(), judgeFailures: { items: 1, reviews: 1, labels: 2, failures: [{ stage: "dedup", attempts: 3 }] } };
    expect(finalizeCalibration(r)).toBe(0);
    expect(r).toMatchObject({ status: "complete", excluded: { count: 1, reason: expect.any(String) } });
    expect(r.counts.total).toBe(2);
    expect(validateCalibration(r, { build, board })).toBe(r);
    r.excluded.count = 2;
    expect(() => validateCalibration(r, { build, board })).toThrow(/exclu/);
    r.excluded.count = 1; r.excluded.reason = "";
    expect(() => validateCalibration(r, { build, board })).toThrow(/exclu/);
  });
  it("completes below-bar agreement and exits 0 while comparison acceptance still refuses it", () => {
    const r = record();
    r.counts.byClass.caught = { total: 10, agree: 8, disagree: 2 };
    Object.assign(r.counts, { total: 11, agree: 9, disagree: 2 });
    r.agreement = agreementOf(r.counts);
    expect(finalizeCalibration(r)).toBe(0);
    expect(r.status).toBe("complete");
    expect(() => validateCalibration(r, { build, board })).toThrow(/90 percent/);
  });
  for (const mode of ["no labels", "empty class", "missing class", "missing agreement"]) it(`marks a calibration failed and exits 1 with ${mode}`, () => {
    const r = record();
    if (mode === "no labels" || mode === "empty class") {
      r.counts = compareLabels(mode === "no labels" ? [] : labels.slice(0, 1), mode === "no labels" ? [] : labels.slice(0, 1), ["caught", "missed"]);
      r.agreement = agreementOf(r.counts);
    } else if (mode === "missing class") delete r.counts.byClass.missed;
    else delete r.agreement;
    expect(finalizeCalibration(r)).toBe(1);
    expect(r.status).toBe("failed");
  });
  it("judges blind before reading published labels", async () => {
    let judged = false;
    const complete = async (request) => {
      expect(JSON.stringify(request)).not.toMatch(/vendor|published|expected|caught|missed/);
      judged = true; return { match: true };
    };
    const verdicts = await judgeGreptile(cases, { truthSet: "greptile", complete });
    const published = () => { expect(judged).toBe(true); return [{ id: "one", label: "caught" }]; };
    expect(compareLabels(verdicts, published(), ["caught", "missed"]).agree).toBe(1);
  });
  it("refuses a missing vendor label instead of skipping the case", () => {
    expect(() => compareLabels(labels, labels.slice(0, 1), ["caught", "missed"])).toThrow(/missing.*two/);
  });
  it("refuses duplicate and extra vendor labels", () => {
    expect(() => compareLabels(labels, [...labels, labels[0]], ["caught", "missed"])).toThrow(/duplicate/);
    expect(() => compareLabels(labels.slice(0, 1), labels, ["caught", "missed"])).toThrow(/extra/);
  });
  it("keeps original and corrected Greptile truth separate", async () => {
    for (const truthSet of ["greptile", "augment"]) {
      await judgeGreptile(cases, { truthSet, complete: async (request) => {
        expect(request.golden).toEqual(cases[0].truthSets[truthSet].items.map((g) => g.text));
        return { match: false };
      } });
    }
  });
  it("refuses malformed model verdicts", async () => {
    await expect(judgeGreptile(cases, { truthSet: "greptile", complete: async () => ({ match: "yes" }) })).rejects.toThrow(/verdict/);
  });
  it("runs the cited Martian Core F1 instead of the default F2", () => {
    expect(MARTIAN_CITED).toMatchObject({ profile: "core", metric: "F1", beta: 1, publishedJudge: "anthropic_claude-opus-4-5-20251101" });
    const score = calibrationSteps("gpt-5.2").find((s) => s.step === "score_profiles");
    expect(score.args.slice(-4)).toEqual(["--profile", "core", "--beta", "1"]);
  });
  it("refuses an unlabelled Martian golden comment", () => {
    const data = { pr: { golden_comments: [{ comment: "one" }, { comment: "two" }] } };
    const evaluations = { pr: { augment: { errors_count: 0, true_positives: [{ golden_comment: "one" }], false_negatives: [] } } };
    expect(() => martianLabels(data, evaluations, "augment")).toThrow(/missing.*two/);
  });
  it("counts positive and negative agreement independently", () => {
    const counts = compareLabels(labels, labels, ["caught", "missed"]);
    expect(counts).toEqual({ total: 2, agree: 2, disagree: 0, byClass: { caught: { total: 1, agree: 1, disagree: 0 }, missed: { total: 1, agree: 1, disagree: 0 } } });
    expect(() => validateCalibration({ ...record(), counts: compareLabels(labels.slice(0, 1), labels.slice(0, 1), ["caught", "missed"]) }, { build, board })).toThrow(/empty class|agreement/);
  });
  it("refuses claimed agreement inconsistent with counts", () => {
    const r = record(); r.agreement.caught = 0.95;
    expect(() => validateCalibration(r, { build, board })).toThrow(/agreement/);
  });
  it("refuses another board prompt or judge", () => {
    for (const field of ["name", "promptHash", "judgeModel"]) {
      const r = record(); r.board = { ...board, [field]: "changed" };
      expect(() => validateCalibration(r, { build, board })).toThrow(/board/);
    }
  });
  it("refuses changed upstream pipeline bytes", () => {
    expect(() => checkedBytes(Buffer.from("changed"), { sha256: "f".repeat(64), path: "judge.py" })).toThrow(/judge.py.*pin/);
  });
  it("refuses missing usage instead of reporting zero cost", () => {
    expect(() => costOfUsage({ responses: 1, missing: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, "gpt-5.2")).toThrow(/usage/);
    expect(costOfUsage({ responses: 1, missing: 0, inputTokens: 1000, outputTokens: 100, cachedTokens: 0 }, "gpt-5.2")).toBeGreaterThan(0);
  });
});
