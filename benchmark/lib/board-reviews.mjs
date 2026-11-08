// Both boards read the same first attempt and every finding the developer
// saw, including incomplete reports. The frozen suite is the denominator.
// Failure cases are in test/greptile-run.test.mjs and martian-board.test.mjs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cacheRoot } from "./licence.mjs";
import { benchRoot } from "./cases.mjs";
import { nativeReviewBody } from "./claude-control.mjs";
import { boardConfigOf, boardToolName, martianBody } from "./martian-board.mjs";
import { attemptOf, findingId, judgeFieldsMissing, nativeFindingId, normPath, population, shownFindings } from "./score.mjs";
import { readCase, readPinned, readSuite, realCaseId, realSpecProblems, truthHashOf, truthOf } from "./suites.mjs";

export { boardToolName, martianBody, martianToolName } from "./martian-board.mjs";
export { nativeFindingId } from "./score.mjs";

const readJsonOr = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const dirs = (path) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Every saved attempt, in the shape score.mjs population reads. */
export function readAttempts(folder) {
  const out = [];
  for (const c of dirs(join(folder, "samples"))) {
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        const which = attemptOf(n);
        if (which === null) throw new Error(`${dir} is not an attempt folder (<repeat> or <repeat>-attempt<n>)`);
        out.push({ case: c, config, ...which, row: readJsonOr(join(dir, "sample.json")), report: readJsonOr(join(dir, "report", "report.json")) });
      }
    }
  }
  return out;
}

/** What happened to a planned review's first attempt. */
export const statusOf = (first) => first === null ? "unstarted" : nativeReviewBody(first.row) !== null ? first.row.status : first.report === null ? "failed" : first.report.completion?.status === "complete" ? "complete" : "incomplete";

/** A finding lacking any judge sentence holds every review of its tool. */
export function heldFindings(review) {
  return review.shown.flatMap((f, index) => {
    const lacking = judgeFieldsMissing(f);
    return lacking.length === 0 ? [] : [{ tool: review.tool, caseId: review.caseId, case: review.case, index, findingId: review.findingIds[index], lacking }];
  });
}

/** One first attempt as comments, with stable finding or native source ids. */
export function boardReview(job) {
  const first = job.first;
  const status = job.notRun ? "not-run" : statusOf(first);
  const native = nativeReviewBody(first?.row);
  const shown = shownFindings(first?.report ?? null);
  const findingIds = native !== null ? native.trim() ? [nativeFindingId(job.caseId, job.config, job.repeat, native)] : [] : shown.map((f) => findingId(job.caseId, f));
  const comments = native !== null ? native.trim() ? [{ path: null, line: null, body: native, created_at: first.row.started_at ?? null }] : [] : shown.map((f) => ({ path: normPath(f.file_path) || null, line: Number.isInteger(f.line_number) ? f.line_number : null, body: martianBody(f), created_at: first?.row?.started_at ?? null, tier: f.tier ?? "finding" }));
  return { ...job, status, shown, native, findingIds, comments };
}

/**
 * A run's suite cases and one review per suite case per tool name. No truth
 * is read here, so Martian can log its held-out access before reading it.
 */
export function readBoardReviews(folder, { root = benchRoot, heading = `${folder} is not converted for the board:` } = {}) {
  const manifestBytes = readFileSync(join(folder, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const suite = readSuite(manifest.suite, { root });
  const cases = suite.file.cases.map((e) => readCase(realCaseId(manifest.suite, e.name, e.hash), { root }));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const attempts = readAttempts(folder);
  const pop = population(manifest, attempts);
  const problems = [...pop.problems];
  if (pop.jobs.length === 0) problems.push("the run plans no review");
  for (const j of pop.jobs) {
    if (!byId.has(j.caseId)) problems.push(`${j.caseId}: not in the frozen ${manifest.suite} suite`);
    else if (manifest.caseHashes?.[j.case] !== byId.get(j.caseId).hash) problems.push(`${j.caseId}: the run's case hash differs from the frozen suite`);
  }
  for (const c of cases) if (manifest.caseHashes?.[c.name] !== undefined && manifest.caseHashes[c.name] !== c.hash) problems.push(`${c.id}: the run's case hash differs from the frozen suite`);
  const planned = new Set(pop.jobs.map((j) => j.case));
  for (const a of attempts) if (!planned.has(a.case)) problems.push(`samples/${a.case}/${a.config}: a sample of ${a.case}, which the run did not plan`);
  for (const a of pop.unplanned) if (planned.has(a.case)) problems.push(`samples/${a.case}/${a.config}/${a.repeat}: a review the run did not plan`);
  const tools = new Map();
  for (const j of pop.jobs) {
    try {
      const tool = boardToolName(j.config, j.repeat);
      const was = tools.get(tool);
      if (was && was.config !== j.config) problems.push(`${was.config} and ${j.config} would both go by the tool name ${tool}`);
      else tools.set(tool, { tool, config: j.config, repeat: j.repeat, boardConfig: boardConfigOf(j.config) });
    } catch (error) { problems.push(error.message); }
  }
  if (problems.length > 0) throw new Error(`${heading}\n${[...new Set(problems)].join("\n")}`);
  const toolRows = [...tools.values()].sort((a, b) => byName(a.tool, b.tool));
  const reviews = [];
  for (const t of toolRows) {
    const jobs = new Map(pop.jobs.filter((j) => j.config === t.config && j.repeat === t.repeat).map((j) => [j.caseId, j]));
    for (const c of cases) reviews.push(boardReview({ ...(jobs.get(c.id) ?? { case: c.name, caseId: c.id, config: t.config, repeat: t.repeat, first: null, notRun: true }), tool: t.tool }));
  }
  const held = reviews.flatMap(heldFindings);
  return { manifest, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), suite: { name: manifest.suite, cases: cases.map((c) => c.id) }, cases, reviews, tools: toolRows.map((t) => ({ ...t, held: held.some((h) => h.tool === t.tool) })), held };
}

/** Shared rebuild: the judge reads not-run truth; readback supplies saved truth. */
export function greptileInput(folder, truthSet, { root = benchRoot, cache = cacheRoot(), truth = (c) => truthOf(c, { cache }).sets } = {}) {
  const run = readBoardReviews(folder, { root });
  const savedTruth = new Map();
  const notRunTruth = new Map();
  const byId = new Map(run.cases.map((c) => [c.id, c]));
  const truthSets = (review) => {
    const c = byId.get(review.caseId);
    if (review.status === "not-run") {
      if (!notRunTruth.has(c.id)) {
        const sets = truth(c);
        if (!sets || Object.keys(sets).sort().join(",") !== Object.keys(c.truthSets).sort().join(",")) throw new Error(`${c.id}: both truth sets must match the frozen suite`);
        for (const [name, pin] of Object.entries(c.truthSets)) {
          const set = sets[name];
          if (Object.keys(set ?? {}).sort().join(",") !== "items,kind,source" || set.kind !== pin.kind || truthHashOf(set.source) !== truthHashOf(pin.source) || !Array.isArray(set.items) || set.items.length !== pin.items || truthHashOf(set.items) !== pin.hash) throw new Error(`${c.id}: ${name} truth differs from the frozen suite`);
        }
        const identity = Object.fromEntries(Object.entries(sets).map(([name, set]) => [name, { kind: set.kind, source: set.source, items: set.items }]));
        if (truthHashOf(identity) !== c.truthHash) throw new Error(`${c.id}: truth sets differ from their frozen hash`);
        notRunTruth.set(c.id, sets);
      }
      return notRunTruth.get(c.id);
    }
    if (!savedTruth.has(c.id)) {
      const spec = readJsonOr(join(folder, "cases", `${c.name}.json`));
      if (spec?.id !== c.id || spec.hash !== c.hash) throw new Error(`${c.id}: saved case differs from the frozen suite`);
      const problems = realSpecProblems(spec, c.name, { suite: "greptile", root });
      if (problems.length > 0) throw new Error(problems.join("; "));
      savedTruth.set(c.id, spec.truthSets);
    }
    return savedTruth.get(c.id);
  };
  return {
    truthSet, manifestSha256: run.manifestSha256, splitHash: run.manifest.splitHash, suite: run.suite,
    tools: run.tools.map((t) => ({ tool: t.tool, config: t.config, boardConfig: t.boardConfig, held: run.held.filter((h) => h.tool === t.tool).map(({ case: name, index, lacking }) => ({ case: name, index, lacking })) })),
    cases: run.reviews.map((r) => ({
      id: r.caseId, caseId: r.caseId, tool: r.tool, config: r.config,
      boardConfig: run.tools.find((t) => t.tool === r.tool).boardConfig,
      comments: r.comments.map((c) => r.native !== null || c.path === null ? c.body : `${c.path}${c.line === null ? "" : `:${c.line}`}: ${c.body}`),
      status: r.status, truthSets: truthSets(r),
    })),
  };
}

/** Fresh Martian data, from pinned truth and the saved first attempts. */
export function martianConversion(run, { cache = cacheRoot() } = {}) {
  const converted = martianReviewConversion(run);
  const cases = new Map(run.cases.map((c) => [c.id, c]));
  // Each pull request's golden comments, from the pinned file, checked against the frozen truth.
  const data = {};
  const caseRows = [];
  for (const c of [...cases.values()].sort((a, b) => byName(a.name, b.name))) {
    const truth = truthOf(c, { cache });
    const row = readPinned(cache, "martian", { path: c.source.dataset.file, sha256: c.source.dataset.sha256 }).find((r) => r.url === c.source.prUrl);
    data[c.source.prUrl] = { pr_title: row.pr_title ?? null, original_url: row.original_url ?? null, source_repo: basename(c.source.dataset.file, ".json"), golden_comments: row.comments, golden_source_file: basename(c.source.dataset.file), openqodex: { caseId: c.id, case: c.name }, reviews: converted.data[c.source.prUrl].reviews };
    caseRows.push({ caseId: c.id, case: c.name, goldenUrl: c.source.prUrl, golden: truth.items.length, licence: c.source.licence.class });
  }
  return { ...converted, data, caseRows };
}

/** Fresh Martian reviews from first attempts, without reading truth. */
export function martianReviewConversion(run) {
  const cases = new Map(run.cases.map((c) => [c.id, c]));
  const data = Object.fromEntries(run.cases.map((c) => [c.source.prUrl, { reviews: [] }]));
  // Every suite case has a review, including cases the run did not plan.
  const jobs = [...run.reviews].sort((a, b) => byName(a.tool, b.tool) || byName(a.case, b.case));
  const held = run.held.map((h) => ({ tool: h.tool, caseId: h.caseId, case: h.case, goldenUrl: cases.get(h.caseId).source.prUrl, index: h.index, findingId: h.findingId, lacking: h.lacking }));
  const failures = [];
  const heldTools = new Set(held.map((h) => h.tool));
  for (const job of jobs) {
    const url = cases.get(job.caseId).source.prUrl;
    if (job.native !== null && job.status === "failed") failures.push({ caseId: job.caseId, config: job.config, repeat: job.repeat, failure: job.first.row.failure ?? null });
    if (!heldTools.has(job.tool)) data[url].reviews.push({ tool: job.tool, repo_name: null, pr_url: url, review_comments: job.comments, openqodex: { caseId: job.caseId, case: job.case, config: job.config, repeat: job.repeat, attempt: 1, status: job.status, findingIds: job.findingIds } });
  }

  const toolRows = run.tools.map(({ tool, config, boardConfig, repeat }) => {
    const mine = jobs.filter((j) => j.tool === tool);
    const statuses = {};
    for (const j of mine) statuses[j.status] = (statuses[j.status] ?? 0) + 1;
    const lack = held.filter((h) => h.tool === tool);
    const why = lack.length === 0 ? null : `${lack.length} finding${lack.length === 1 ? " lacks" : "s lack"} what Martian's judge reads (${lack.map((h) => `${h.case} index ${h.index}: ${h.lacking.join(", ")}`).join("; ")}); none of this tool name's reviews is sent, since judging it without one of its pull requests would shrink Martian's denominators`;
    return { tool, config, boardConfig, repeat, reviews: mine.length, findings: mine.reduce((n, j) => n + j.shown.length, 0), statuses, held: lack.length > 0, why };
  });
  return { data, jobs, held, failures, toolRows };
}
