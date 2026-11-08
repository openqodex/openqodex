// Failure list, written before the code (step 2, O10):
// 1. A tune run reads a score case: by id, by the test split ("all" of the
//    held-out side), by the subset score, or under a --change flag.
// 2. The Greptile split loses a case, double-counts one, has a case with no
//    exposure value, or puts an exposed case among the score cases.
// 3. A score run is admitted off a release build, or logs no access.
// 4. A Martian run reports only its score on all cases, so a number on
//    cases a reader saw is read as a clean one.
// 5. A suite with exposure on record runs with no purpose named.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot } from "../lib/cases.mjs";
import { martianCoreOn, martianEvaluations, martianSideBySide, unexposedCases } from "../lib/martian-board.mjs";
import { EXPOSURE_REASONS, SUITES, exposureSplitProblems, readSuite, selectCases } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const split = read(join(benchRoot, SUITES.greptile.split));
const entries = read(join(benchRoot, SUITES.greptile.cases)).cases;
const SCORE = "ai-code-review-evaluation__cal.com-greptile-2";
const TUNE = "ai-code-review-evaluation__cal.com-greptile-3";
const log = () => join(tempDir("oq-purpose-log-"), "heldout-access.jsonl");
const refusal = (args) => {
  const accessLog = log();
  let message = null;
  try {
    selectCases({ suite: "greptile", accessLog, ...args });
  } catch (error) {
    message = error.message;
  }
  return { message, logged: existsSync(accessLog) };
};

describe("the Greptile tune/score split", () => {
  it("validates, adds to 50, gives every case an exposure value, and keeps every score case unexposed", () => {
    expect(split.name, "the suite reads the v2 split").toBe("greptile-v2");
    expect(exposureSplitProblems(split, entries), "the committed split fails its own rules").toEqual([]);
    const names = entries.map((e) => e.name).sort();
    expect([...split.cases.dev, ...split.cases.test].sort(), "tune and score are not the 50 cases once each").toEqual(names);
    expect(names).toHaveLength(50);
    expect(split.subsets.tune.length + split.subsets.score.length, "the counts do not add to 50").toBe(50);
    for (const n of names) {
      const reasons = split.exposure.cases[n]?.reasons;
      expect(Array.isArray(reasons) && reasons.length > 0, `${n} has no exposure value`).toBe(true);
      expect(reasons.every((r) => r === "none" || EXPOSURE_REASONS.includes(r)), `${n} has an unknown exposure reason`).toBe(true);
    }
    for (const n of split.subsets.score) expect(split.exposure.cases[n].reasons, `${n} is a score case and was exposed`).toEqual(["none"]);
    expect(split.subsets.score.length, "fewer score cases than the floor").toBeGreaterThanOrEqual(20);
    expect(split.counts).toMatchObject({ tune: 30, score: 20 });
  });

  it("refuses a split that puts an exposed case among the score cases", () => {
    const bad = structuredClone(split);
    bad.exposure.cases[SCORE].reasons = ["dossier"];
    expect(exposureSplitProblems(bad, entries).join("\n"), "an exposed score case passed").toMatch(SCORE);
  });

  it("refuses a split with a case that has no exposure value", () => {
    const bad = structuredClone(split);
    delete bad.exposure.cases[TUNE];
    expect(exposureSplitProblems(bad, entries).join("\n"), "a case with no exposure passed").toMatch(TUNE);
  });
});

describe("a tune run never reads a score case", () => {
  it("is refused on a score case named by id, before any access is logged", () => {
    const r = refusal({ purpose: "tune", refs: [`greptile/${SCORE}`] });
    expect(r.message, "a tune run named a score case and was admitted").toMatch(`greptile/${SCORE} is a score case`);
    expect(r.logged, "the refusal logged held-out access").toBe(false);
  });

  it("is refused on a score case named by its full case id", () => {
    const entry = entries.find((e) => e.name === SCORE);
    const r = refusal({ purpose: "tune", refs: [`greptile/${SCORE}@${entry.hash.slice(0, 8)}`] });
    expect(r.message, "a full case id slipped past the purpose").toMatch(`greptile/${SCORE} is a score case`);
  });

  it("is refused on all the held-out cases (the test split), even where materialising may select it", () => {
    const r = refusal({ purpose: "tune", split: "test", heldOut: true });
    expect(r.message, "a tune run took the test split").toMatch("the greptile test split holds the score cases");
    expect(r.logged).toBe(false);
  });

  it("is refused on the subset score", () => {
    const r = refusal({ purpose: "tune", subset: "score" });
    expect(r.message, "a tune run took the subset score").toMatch("the subset score is the score cases");
  });

  it("is refused under --change on a score case, and --change under any other purpose", () => {
    expect(refusal({ purpose: "tune", change: "RC-0001", refs: [`greptile/${SCORE}`] }).message, "a loop change read a score case").toMatch("is a score case");
    expect(refusal({ purpose: "score", change: "RC-0001", split: "test", heldOut: true }).message, "a loop change ran as a score run").toMatch("its purpose is tune, not score");
  });

  it("admits the tune side and the subset tune", () => {
    expect(selectCases({ suite: "greptile", purpose: "tune", accessLog: log() }).map((c) => c.name).sort(), "the tune side is not the tune subset").toEqual([...split.subsets.tune].sort());
    expect(selectCases({ suite: "greptile", purpose: "tune", subset: "tune", accessLog: log() })).toHaveLength(30);
  });

  it("refuses a Greptile run that names no purpose", () => {
    expect(refusal({}).message, "a run with no purpose was admitted").toMatch("names its purpose");
  });

  it("refuses a tune run through run.mjs, naming the score case", () => {
    const out = tempDir("oq-purpose-materialise-");
    const r = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--materialise-only", "--suite", "greptile", "--purpose", "tune", "--cases", `greptile/${SCORE}`, "--out", out], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr, "run.mjs did not name the refused case").toMatch(`greptile/${SCORE} is a score case`);
    expect(existsSync(join(out, "proof.json")), "a proof was written for a refused run").toBe(false);
  });
});

describe("a score run is admitted only on a release build", () => {
  it("is refused without a release, before any access is logged", () => {
    const r = refusal({ purpose: "score", split: "test" });
    expect(r.message, "a score run ran without a release").toMatch("held out: no held-out case runs before a release");
    expect(r.logged).toBe(false);
  });

  it("is refused on a build the release does not pin", () => {
    const build = { commit: "0".repeat(40), tree: "0".repeat(40), bundleHash: "0".repeat(64), version: "0.0.0", dirty: false };
    const r = refusal({ purpose: "score", split: "test", release: "compare-2026-10", build, packageRecord: { spec: "local" } });
    // Until O12 re-freezes the record, the stale split pins refuse first;
    // comparison-release.test.mjs proves the build refusal on its own fixture.
    expect(r.message, "a score run off the release build was admitted").toMatch(/build|no longer match/);
    expect(r.logged, "a refused score run logged access").toBe(false);
  });

  it("is refused on the tune side", () => {
    expect(refusal({ purpose: "score" }).message, "a score run read the tune side").toMatch("a score run reads the score cases");
    expect(refusal({ purpose: "score", split: "test", heldOut: true, refs: [`greptile/${TUNE}`] }).message).toMatch(`greptile/${TUNE} is a tune case`);
  });

  it("refuses a score run through run.mjs without --release", () => {
    const r = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--suite", "greptile", "--split", "test", "--purpose", "score", "--max-usd", "1", "--max-minutes", "1"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr, "run.mjs admitted a score run off a release").toMatch("use --release with an accepted comparison");
  });
});

describe("a Martian run reports all cases and the unexposed cases side by side", () => {
  const FIXTURES = join(benchRoot, "outside/fixtures/martian");
  const r = (name) => read(join(FIXTURES, "recorded", name));
  const data = read(join(FIXTURES, "benchmark_data.json"));
  const { tools } = martianEvaluations({ data, candidates: r("candidates.json"), dedup: r("dedup_groups.json"), evaluations: r("evaluations.json"), totals: r("totals.json"), judge: { model: "gpt-5.2", served: "gpt-5.2" }, model: "gpt-5.2" });
  const exposure = { exposure: { cases: { "oq-fixture__ledger-7": { reasons: ["none"] }, "oq-fixture__shop-11": { reasons: ["golden-read"] }, "oq-fixture__shop-12": { reasons: ["none"] } } } };

  it("equals the official Core totals on all cases", () => {
    const all = martianCoreOn(tools[0].evaluation, data, Object.values(data).map((e) => e.openqodex.case));
    const core = r("totals.json").profiles.core["openqodex-library-r1"];
    expect({ tp: all.tp, fp: all.fp, fn: all.fn }, "the recomputed core differs from Martian's").toEqual({ tp: core.tp, fp: core.fp, fn: core.fn });
    expect(all.f1).toBeCloseTo(core.f1, 12);
  });

  it("shows both numbers on one line per tool", () => {
    expect(unexposedCases(exposure)).toEqual(["oq-fixture__ledger-7", "oq-fixture__shop-12"]);
    const [row] = martianSideBySide(tools, data, exposure);
    // ledger-7: two core comments found, no false positive; shop-12: one found, one false positive.
    expect(row.unexposed, "the unexposed score is not over the unexposed cases").toEqual({ cases: 2, tp: 3, fp: 1, fn: 0, precision: 0.75, recall: 1, f1: 6 / 7 });
    expect(row.all).toMatchObject({ cases: 3, tp: 5, fp: 1, fn: 0 });
    expect(row.line, "the line does not show both numbers").toBe("  openqodex-library-r1: all precision 0.833, recall 1.000, F1 0.909 on 3 cases; unexposed precision 0.750, recall 1.000, F1 0.857 on 2 cases");
  });

  it("the committed Martian split marks every case, and 24 are unexposed", () => {
    const martian = readSuite("martian").split;
    expect(Object.keys(martian.exposure.cases)).toHaveLength(50);
    expect(unexposedCases(martian), "the unexposed count moved without a new split").toHaveLength(24);
  });
});
