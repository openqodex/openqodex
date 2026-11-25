// Failure list, written before lib/noise.mjs, the trend's board line and
// calibrate.mjs --judge-twice (step 2, O9):
// 1. A board number is one repeat's, or the best repeat's: the range gives
//    the min, mean and max of caught (Greptile) or core F1 (Martian) per
//    board configuration, and a held tool adds no value.
// 2. A gain inside the noise is called: the trend calls no board gain when
//    the two runs' ranges overlap, when the rise is not larger than the
//    judge's disagreement with itself, when that disagreement was never
//    measured, or when a run holds fewer than three repeats.
// 3. The trend reads a disagreement that is not the run's: it reads the
//    judgeVariability of the calibration the run's comparison record pins.
// 4. The disagreement rate counts labels wrongly, or compares two passes
//    over different reviews.
// 5. A judge-twice pass spends before the wave journal holds its forecast,
//    or the second pass runs when the cap leaves no room for it.
// 6. A release review run of a board suite with fewer than three repeats spends
//    before attach refuses it.
// 7. The fixed sample moves between calibrations of the same reviews.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { benchRoot } from "../lib/cases.mjs";
import { agreementPercentages, validateCalibration } from "../lib/calibration.mjs";
import { boardGain, disagreementOf, judgeSample, rangesOverlap, repeatRange } from "../lib/noise.mjs";
import { newWave, outstanding, waveState, WaveRefused } from "../lib/wave.mjs";
import { judgeTwice } from "../outside/calibrate.mjs";
import { boardLine, judgeDisagreement } from "../trend.mjs";

afterAll(removeTempDirs);
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

const greptileTool = (boardConfig, caught, extra = {}) => ({ config: `${boardConfig === "library" ? "model-scripted" : "claude"}-graph-on`, boardConfig, caught, missed: 50 - caught, of: 50, planned: 50, notRun: 0, rate: caught / 50, ...extra });
const martianTool = (repeat, f1) => ({ config: "claude-graph-on", boardConfig: "cli-claude", repeat, official: { core: { tp: 1, fp: 1, fn: 1, f1 } }, ours: {}, candidates: [], matches: [], empty: [] });
const greptileRange = (min, mean, max, repeats = 3) => ({ metric: "caught", of: 50, repeats, min, mean, max });

describe("the range over repeats (failure 1)", () => {
  it("three fake Greptile perTool blocks give caught min 28, mean 30 and max 33 per configuration, not the best repeat", () => {
    const perTool = {
      "openqodex-cli-claude-r1": greptileTool("cli-claude", 29),
      "openqodex-cli-claude-r2": greptileTool("cli-claude", 33),
      "openqodex-cli-claude-r3": greptileTool("cli-claude", 28),
      "openqodex-library-r1": greptileTool("library", 10),
    };
    expect(repeatRange("greptile", perTool)).toEqual({
      "cli-claude": { metric: "caught", of: 50, repeats: 3, min: 28, mean: 30, max: 33 },
      library: { metric: "caught", of: 50, repeats: 1, min: 10, mean: 10, max: 10 },
    });
  });

  it("three fake Martian perTool blocks give core F1 min 0.25, mean 0.375 and max 0.5", () => {
    const range = repeatRange("martian", { a: martianTool(1, 0.5), b: martianTool(2, 0.25), c: martianTool(3, 0.375) });
    expect(range).toEqual({ "cli-claude": { metric: "f1", profile: "core", repeats: 3, min: 0.25, mean: 0.375, max: 0.5 } });
  });

  it("a held tool adds no value, and equal repeats keep the mean inside the range", () => {
    const held = greptileTool("cli-claude", null, { held: [{ case: "x", index: 0, lacking: ["truth"] }], missed: null, rate: null });
    const range = repeatRange("martian", { a: martianTool(1, 0.1), b: martianTool(2, 0.1), c: martianTool(3, 0.1) })["cli-claude"];
    expect(range.mean).toBeLessThanOrEqual(range.max);
    expect(range.mean).toBeGreaterThanOrEqual(range.min);
    expect(repeatRange("greptile", { r1: greptileTool("cli-claude", 30), r2: held })).toEqual({ "cli-claude": { metric: "caught", of: 50, repeats: 1, min: 30, mean: 30, max: 30 } });
  });
});

describe("a board gain (failure 2)", () => {
  it("two ranges that share a value overlap, compared as shares of the cases", () => {
    expect(rangesOverlap(greptileRange(28, 30, 32), greptileRange(32, 33, 35))).toBe(true);
    expect(rangesOverlap(greptileRange(28, 30, 31), greptileRange(32, 33, 35))).toBe(false);
  });

  it("an overlapping pair is not called a gain, however far the mean rose", () => {
    const g = boardGain(greptileRange(20, 25, 34), greptileRange(33, 40, 45), { disagreement: 0 });
    expect(g.called).toBe(false);
    expect(g.why).toMatch(/ranges overlap/);
  });

  it("a rise of 6 points under a judge disagreement of 10 percent is not called a gain; above it, it is", () => {
    // Means 30 and 33 of 50 cases: a rise of 3 cases, 6 points.
    const before = greptileRange(29, 30, 31);
    const after = greptileRange(32, 33, 34);
    const under = boardGain(before, after, { disagreement: 0.1 });
    expect(under.called).toBe(false);
    expect(under.why).toMatch(/not larger than the judge's disagreement with itself \(10\.0 percent/);
    expect(boardGain(before, after, { disagreement: 0.05 }).called).toBe(true);
  });

  it("no gain is called without a measured disagreement, on fewer than three repeats, or when the mean fell", () => {
    expect(boardGain(greptileRange(29, 30, 31), greptileRange(40, 41, 42)).why).toMatch(/not measured/);
    expect(boardGain(greptileRange(30, 30, 30, 1), greptileRange(40, 40, 40, 1), { disagreement: 0 }).why).toMatch(/needs 3 repeats/);
    expect(boardGain(greptileRange(40, 41, 42), greptileRange(29, 30, 31), { disagreement: 0 }).why).toMatch(/did not rise/);
  });

  it("the trend's board line says the range is not a confidence interval and refuses an overlapping pair", () => {
    const entry = (range) => ({ suite: "greptile", outside: { greptile: { range: { library: range } } } });
    const line = boardLine(entry(greptileRange(28, 30, 32)), entry(greptileRange(31, 33, 35)), "model-gpt-6.1-sol-graph-on", { disagreement: 0 });
    expect(line.called).toBe(false);
    expect(line.text).toContain("descriptive and not a confidence interval");
    expect(line.text).toContain("mean 33.0 of 50 caught (31 to 35 over 3 repeats) against mean 30.0 of 50 caught (28 to 32 over 3 repeats)");
    expect(line.text).toContain("no gain is called: the two runs' repeat ranges overlap");
    // A suite with no Greptile or Martian board, or a run with no range, has no board line.
    expect(boardLine({ suite: "planted" }, { suite: "planted" }, "claude-graph-off")).toBeNull();
    expect(boardLine(entry(greptileRange(28, 30, 32)), { suite: "greptile" }, "model-x-graph-on")).toBeNull();
  });
});

it("the trend reads the judge disagreement of the calibration the run's record pins (failure 3)", () => {
  const index = join(tempDir("oq-noise-index-"), "index");
  write(join(index, "calibration/greptile-pinned.json"), { board: { name: "greptile" }, judgeVariability: { rate: 0.2 } });
  write(join(index, "calibration/greptile-newer.json"), { board: { name: "greptile" }, judgeVariability: { rate: 0.9 } });
  write(join(index, "calibration/martian-pinned.json"), { board: { name: "martian" } });
  write(join(index, "comparisons/rel-a.json"), { calibrations: [{ file: "index/calibration/martian-pinned.json" }, { file: "index/calibration/greptile-pinned.json" }] });
  expect(judgeDisagreement(index, { release: "rel-a" }, "greptile")).toBe(0.2);
  expect(judgeDisagreement(index, { release: "rel-a" }, "martian")).toBeNull();
  expect(judgeDisagreement(index, { release: null }, "greptile")).toBeNull();
  expect(judgeDisagreement(index, { release: "rel-missing" }, "greptile")).toBeNull();
  // A suite with no board, whose record pins a calibration file that is gone, reads no disagreement and does not throw.
  write(join(index, "comparisons/rel-gone.json"), { calibrations: [{ file: "index/calibration/gone.json" }] });
  expect(judgeDisagreement(index, { release: "rel-gone" }, undefined)).toBeNull();
});

describe("judging the sample twice", () => {
  const labels = (flip = []) => Array.from({ length: 10 }, (_, i) => ({ id: `case-${i}`, label: flip.includes(i) ? "missed" : "caught" }));

  it("two passes over 10 labels that differ on 2 disagree at a rate of 0.2, and passes over different reviews are refused (failure 4)", () => {
    expect(disagreementOf(labels(), labels([3, 7]), ["caught", "missed"])).toEqual({ labels: 10, disagree: 2, rate: 0.2 });
    expect(disagreementOf(labels([1]), labels([1]), ["caught", "missed"])).toEqual({ labels: 10, disagree: 0, rate: 0 });
    expect(() => disagreementOf(labels(), labels().slice(1), ["caught", "missed"])).toThrow(/label/);
  });

  it("each pass is reserved in the wave before it runs and settled with its cost (failure 5)", async () => {
    const root = tempDir("oq-noise-wave-");
    const wave = newWave("w-twice", { root });
    const seen = [];
    const result = await judgeTwice({ sample: labels().map((l) => l.id), classes: ["caught", "missed"], forecastUsd: 0.4, wave, waveRun: "cal", pass: async (k) => {
      seen.push(outstanding(wave).map((r) => [r.id, r.forecastUsd]));
      return { labels: k === 1 ? labels() : labels([0]), costUsd: 0.3 };
    } });
    expect(seen).toEqual([[["cal:judge-twice-1", 0.4]], [["cal:judge-twice-2", 0.4]]]);
    expect(result).toMatchObject({ labels: 10, disagree: 1, rate: 0.1 });
    expect(result.passes.map((p) => p.costUsd)).toEqual([0.3, 0.3]);
    expect(waveState(wave).settledUsd).toBeCloseTo(0.6, 9);
    expect(outstanding(wave)).toEqual([]);
  });

  it("the second pass never runs when the cap leaves no room for its forecast (failure 5)", async () => {
    const root = tempDir("oq-noise-wave-");
    const wave = newWave("w-full", { root });
    let passes = 0;
    await expect(judgeTwice({ sample: ["a"], classes: ["caught", "missed"], forecastUsd: 6, wave, waveRun: "cal", pass: async () => { passes++; return { labels: [{ id: "a", label: "caught" }], costUsd: 6 }; } })).rejects.toThrow(WaveRefused);
    expect(passes).toBe(1);
    expect(waveState(wave).settledUsd).toBe(6);
  });

  it("a calibration whose judgeVariability rate does not follow from its counts is refused (failure 4)", () => {
    const record = JSON.parse(readFileSync(join(benchRoot, "index/calibration/greptile-2026-10-27.json"), "utf8"));
    const check = (judgeVariability) => validateCalibration({ ...record, judgeVariability }, { build: record.build, board: record.board, agreementRuling: agreementPercentages(record.agreement) });
    const passes = [{ costUsd: 0.1, labels: labels() }, { costUsd: 0.1, labels: labels([2]) }];
    expect(() => check({ sample: ["a"], labels: 10, disagree: 1, rate: 0.1, passes })).not.toThrow();
    expect(() => check({ sample: ["a"], labels: 10, disagree: 1, rate: 0.5, passes })).toThrow(/judgeVariability/);
    expect(() => check({ sample: ["a"], labels: 10, disagree: 1, rate: 0.1, passes: passes.slice(1) })).toThrow(/judgeVariability/);
  });

  it("the sample is the same 10 ids whatever their order, and another board draws its own (failure 7)", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `greptile/case-${i}@abababab`);
    const sample = judgeSample(ids, "greptile");
    expect(sample).toHaveLength(10);
    expect(new Set(sample).size).toBe(10);
    expect(judgeSample([...ids].reverse(), "greptile")).toEqual(sample);
    expect(judgeSample(ids, "martian")).not.toEqual(sample);
  });
});

it("a release review run of a board suite with one repeat is refused before anything is fetched or spent (failure 6)", () => {
  const cache = tempDir("oq-noise-cache-");
  const r = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--suite", "greptile", "--split", "test", "--release", "compare-2026-10", "--repeat", "1", "--reviewers", "model:scripted", "--max-usd", "1", "--max-minutes", "1"], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: cache }, timeout: 60_000 });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--repeat 1: a release review run of a board suite attaches with 3 repeats");
  expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
});
