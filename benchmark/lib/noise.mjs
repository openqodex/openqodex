// The noise of a board number: the spread of its repeats, and how often the
// board's judge disagrees with itself. Used by the Greptile and Martian
// board readers (the range block beside perTool), the comparison record's
// attach step (the repeats pin), calibrate.mjs --judge-twice (the judge's
// disagreement) and trend.mjs (whether a board gain is called).
//
// The range is descriptive, not a confidence interval: the lowest, mean and
// highest value of one metric over a configuration's repeats. It is kept
// apart from the cluster interval of score.mjs, which resamples cases, and
// it never reports the best repeat as the number.
//
// Failure cases: benchmark/test/noise.test.mjs, before this code.
import { createHash } from "node:crypto";
import { compareLabels } from "./calibration.mjs";

// Board runs go with three repeats; a comparison record pins the number.
export const BOARD_REPEATS = 3;
// The fixed number of saved reviews a judge-twice pass judges per board.
export const JUDGE_SAMPLE = 10;

// The one metric per board the range covers: caught cases on Greptile, the
// core profile's F1 on Martian.
const METRICS = {
  greptile: { metric: "caught", value: (t) => t.caught, of: (t) => t.of },
  martian: { metric: "f1", profile: "core", value: (t) => t.official?.core?.f1, of: () => null },
};

/**
 * The range block of a board's perTool: per board configuration, the
 * repeats it holds and the min, mean and max of the board's metric over
 * them. A held tool has no value and is not counted.
 */
export function repeatRange(board, perTool) {
  const m = METRICS[board];
  if (!m) throw new Error(`no repeat range is defined for board ${board}`);
  const by = new Map();
  for (const t of Object.values(perTool)) {
    const v = m.value(t);
    if (!Number.isFinite(v)) continue;
    if (!by.has(t.boardConfig)) by.set(t.boardConfig, { values: [], of: m.of(t) });
    by.get(t.boardConfig).values.push(v);
  }
  const out = {};
  for (const config of [...by.keys()].sort()) {
    const { values, of } = by.get(config);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Rounding can put the mean of equal values a hair outside them.
    const mean = Math.min(max, Math.max(min, values.reduce((a, b) => a + b, 0) / values.length));
    out[config] = { metric: m.metric, ...(m.profile ? { profile: m.profile } : {}), ...(of === null ? {} : { of }), repeats: values.length, min, mean, max };
  }
  return out;
}

// A range's values as shares: caught counts over the cases, F1 as it is.
const share = (r, v) => (Number.isInteger(r.of) && r.of > 0 ? v / r.of : v);

/** Whether two ranges share any value. */
export const rangesOverlap = (a, b) => share(a, a.min) <= share(b, b.max) && share(b, b.min) <= share(a, a.max);

/**
 * Whether the move from `before` to `after` (two range rows of one board
 * configuration) is called a gain. A gain is called only when both runs
 * hold BOARD_REPEATS repeats, their ranges do not overlap, and the mean's
 * rise is larger than the judge's disagreement rate on its sample (null
 * when it was never measured, which calls nothing).
 */
export function boardGain(before, after, { disagreement = null } = {}) {
  const gain = share(after, after.mean) - share(before, before.mean);
  const no = (why) => ({ called: false, gain, why });
  if (before.repeats < BOARD_REPEATS || after.repeats < BOARD_REPEATS) return no(`a range needs ${BOARD_REPEATS} repeats, and the runs hold ${before.repeats} and ${after.repeats}`);
  if (gain <= 0) return no("the mean did not rise");
  if (rangesOverlap(before, after)) return no("the two runs' repeat ranges overlap");
  if (!Number.isFinite(disagreement)) return no("the judge's disagreement with itself is not measured for this board");
  if (gain <= disagreement) return no(`the rise is not larger than the judge's disagreement with itself (${(disagreement * 100).toFixed(1)} percent of its labels)`);
  return { called: true, gain, why: "the ranges do not overlap and the rise is larger than the judge's disagreement with itself" };
}

/** The fixed sample of a board: the first `n` ids in an order seeded by the board's name. */
export function judgeSample(ids, board, n = JUDGE_SAMPLE) {
  const key = (id) => createHash("sha256").update(`judge-twice\0${board}\0${id}`).digest("hex");
  return [...new Set(ids)].map((id) => [key(id), id]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, n).map(([, id]) => id);
}

/** How often two judge passes over the same labels disagree. */
export function disagreementOf(first, second, classes) {
  const counts = compareLabels(second, first, classes);
  return { labels: counts.total, disagree: counts.disagree, rate: counts.total === 0 ? null : counts.disagree / counts.total };
}
