// Publishing and attachment recompute the same board blocks from saved reviews.
import { BOARDS, readOutside } from "./outside-boards.mjs";
import { canonical } from "./score.mjs";
import { readDecisions } from "./rulings.mjs";
import { decisionsPath, loadRun, scoreRun } from "../score.mjs";

export function recomputedOutside(folder, names, options = {}) {
  const d = readDecisions(decisionsPath);
  const run = loadRun(folder);
  const { jobs } = scoreRun(run, { decisionsHash: d.hash, decisions: d.lines, people: d.people });
  return readOutside(folder, jobs, run.specs, names, options);
}

export function boardRefusal(folder, runId, outside, options = {}) {
  if (outside === undefined) return null;
  const names = Object.keys(outside);
  if (names.some((name) => !Object.hasOwn(BOARDS, name))) return `refused: ${runId} names a board outside the registry`;
  const recomputed = recomputedOutside(folder, names, options);
  return canonical(outside) === canonical(recomputed) ? null : `refused: ${runId}'s board numbers in score.json are not the ones its board output gives; run node benchmark/score.mjs ${folder} --outside ${names.join(",")} again`;
}
