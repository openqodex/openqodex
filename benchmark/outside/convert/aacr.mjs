#!/usr/bin/env node
// A saved run's samples on AACR-Bench cases, in the shape AACR-Bench's own
// evaluator reads (their evaluation/evaluate.py, the reader for generic
// comments): one file per pull request, `<instance id>.json`, holding
// `review.comments[]` of { path, start_line, end_line, content } and
// `review.summary` { input_tokens, output_tokens }, plus `duration_seconds`.
// Their reader ignores the rest, so each file also says which of our
// reviews it is (`openqodex`). Files go only under <run>/outside/aacr/:
// <config>/r<repeat>/ per configuration and repeat (the board's tool name
// is openqodex-<config>-r<repeat>), convert.json for what was written, and,
// after their dataset converter ran, dataset.jsonl.
//
//   node benchmark/outside/convert/aacr.mjs convert <run>
//   node benchmark/outside/convert/aacr.mjs dataset <run> <their converter's jsonl>
//   node benchmark/outside/convert/aacr.mjs raw      (the checked dataset file in the cache)
//   node benchmark/outside/convert/aacr.mjs pin      (the board's repository and commit)
//   node benchmark/outside/convert/aacr.mjs cache    (the bench cache, refused inside the repository)
//
// Failure list, written before the code:
// 1. A finding without a line is dropped, so AACR's precision rises: it is
//    held in the list with null lines, as their format allows, and
//    convert.json names it. Unless the board excludes test gaps, every finding shown (on the
//    change and outside it, as our scorer counts them) is written; a
//    finding with no text gets a sentence saying so, since their reader
//    skips an empty comment.
// 2. A sample on a case outside AACR-Bench is converted: a run whose
//    manifest names another suite, or that holds a sample of a case that is
//    not an AACR-Bench case, is refused before anything is written.
// 3. A failed or never-started review vanishes from AACR's denominators
//    (their evaluator leaves out an instance with no result file): every
//    planned review's first attempt gets a file, with no comment when it
//    failed or never started; a retry never replaces it, as in our score.
// 4. A case with an excluded licence class is converted: every case's
//    licence record goes through lib/licence.mjs, licenceExclusion, and
//    one excluded case refuses the whole run. Unverified cases convert
//    for local judging; board submissions still apply publishRefusal.
// 5. Our line count differs from AACR's on the same reports: each comment
//    carries the path and the range our scorer reads (paths normalised, the
//    range [line_number, max(line_end, line_number)]), and the dataset step
//    refuses their reference comments unless they are, in order, the
//    accepted comments our truth copy holds.
// 6. A second conversion mixes with the first, or with metrics their
//    evaluator wrote: a run already converted is refused.
// From the review of PR 155:
// 7. Result files leave the run through a symbolic link: the converter and
//    the dataset step write only in lib/aacr-board.mjs boardFolder(run).
// 8. A held-out (test split) case in a saved run is converted and exported:
//    a case its truth copy or the committed split places in the test split
//    refuses the whole run, named.
// 9. The bench cache lies in the repository, so their checkout and its venv
//    land there: `cache` refuses a cache whose real path is inside it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AACR_BOARD, AACR_K, AACR_READER, boardFolder, instanceIdOf, isTestGap, readAacrOutside, toolName } from "../../lib/aacr-board.mjs";
import { parseCaseId } from "../../lib/cases.mjs";
import { benchCache } from "../../lib/board-files.mjs";
import { cacheRoot, licenceExclusion } from "../../lib/licence.mjs";
import { normPath, population, shownFindings } from "../../lib/score.mjs";
import { checkPinned, rawPath, readSuite } from "../../lib/suites.mjs";
import { loadRun } from "../../score.mjs";
import { nativeReviewBody } from "../../lib/claude-control.mjs";

export { benchCache, instanceIdOf, isTestGap, readAacrOutside };

const BOARDS = JSON.parse(readFileSync(new URL("../boards.json", import.meta.url), "utf8"));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const text = (s) => (typeof s === "string" ? s.trim() : "");

/** One shown finding as a comment their reader takes. */
export function commentOf(f) {
  const start = Number.isInteger(f.line_number) ? f.line_number : null;
  const end = start === null ? null : Math.max(Number.isInteger(f.line_end) ? f.line_end : start, start);
  const prose = [f.problem, f.consequence, f.fix].map(text);
  // A finding from before the prose fields says what it is in its description and suggested change.
  const parts = [text(f.title), ...prose, ...(prose.every((p) => p === "") ? [text(f.description), text(f.suggested_change)] : [])].filter((p) => p !== "");
  // `tier` says whether the review counted it toward the verdict ("finding")
  // or showed it apart ("observation"); the board reads neither, our record does.
  return { path: normPath(f.file_path), start_line: start, end_line: end, content: parts.length > 0 ? parts.join("\n") : "A finding with no text.", tier: f.tier ?? "finding" };
}

// What happened to a planned review's first attempt, as our scorer reads it.
const statusOf = (first) => (first === null ? "unstarted" : nativeReviewBody(first.row) !== null ? first.row.status : first.report === null ? "failed" : first.report.completion?.status === "complete" ? "complete" : "incomplete");

/**
 * Converts the run in `folder`: writes <folder>/outside/aacr/ and returns
 * { out, record } (record is convert.json). Throws, writing nothing, on a
 * run of another suite, a sample of a case outside AACR-Bench, a case the
 * licence rule excludes, or a run converted before.
 */
export function convertRun(folder, { excludeTestGaps = BOARDS.boards.aacr.excludeTestGaps === true } = {}) {
  folder = resolve(folder);
  const manifest = existsSync(join(folder, "manifest.json")) ? readJson(join(folder, "manifest.json")) : null;
  if (!manifest) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const suite = manifest.suite ?? "planted";
  if (suite === "greptile") throw new Error("Greptile uses benchmark/outside/boards/greptile-run.mjs, with caught or missed per case against the chosen truth set");
  if (suite !== "aacr") throw new Error(`${folder}: the run is of suite ${suite}, not aacr; only an AACR-Bench run is converted for its board`);
  if (manifest.mode === "scan") throw new Error(`${folder}: a scanner-only run shows the developer no finding, so it has nothing to convert for the board`);
  const out = boardFolder(folder);
  if (existsSync(out)) throw new Error(`${out} exists already: the run was converted before (and maybe evaluated). Move that folder to the Trash to convert it again.`);
  const run = loadRun(folder);
  const problems = [];
  const heldOut = new Set(readSuite("aacr").split?.cases?.test ?? []);
  for (const [name, spec] of Object.entries(run.specs)) {
    const id = parseCaseId(spec?.id);
    if (id?.suite !== "aacr") {
      problems.push(`${name}: not an AACR-Bench case (its truth copy names ${JSON.stringify(spec?.id ?? null)})`);
      continue;
    }
    const record = spec.source?.licence ?? null;
    const why = record === null ? "its truth copy holds no licence record" : licenceExclusion(record);
    if (why !== null) problems.push(`${name}: ${why}`);
    if (spec.split === "test" || heldOut.has(name)) problems.push(`${name}: held out (the test split); a held-out case is never converted or exported before a release`);
  }
  for (const a of run.attempts) if (parseCaseId(run.specs[a.case]?.id)?.suite !== "aacr") problems.push(`samples/${a.case}/${a.config}: a sample of ${a.case}, which is not an AACR-Bench case`);
  if (problems.length > 0) throw new Error(`${folder} is not converted for AACR-Bench:\n${[...new Set(problems)].join("\n")}`);

  // The population our scorer counts: each planned review by its first attempt.
  const pop = population(manifest, run.attempts);
  if (pop.problems.length > 0) throw new Error(`${folder}: the run's samples do not match its plan:\n${pop.problems.join("\n")}`);
  const { jobs } = pop;
  const instances = new Map();
  for (const name of [...new Set(jobs.map((j) => j.case))].sort()) {
    const spec = run.specs[name];
    const bugs = spec.bugs ?? [];
    const instanceId = instanceIdOf(spec);
    const twin = [...instances.values()].find((i) => i.instanceId === instanceId);
    if (twin) throw new Error(`${folder}: ${twin.case} and ${name} are both the AACR-Bench instance ${instanceId}, so one file would hold two reviews`);
    instances.set(name, { instanceId, caseId: spec.id, case: name, references: bugs.length, left: bugs.filter((b) => b.side === "left").length });
  }
  const files = new Map();
  const commentCounts = new Map();
  const withoutLine = [];
  const failures = [];
  // Board-only rule: use the scorer's test-request predicate without changing our score.
  const forBoard = (report) => shownFindings(report).filter((f) => !excludeTestGaps || !isTestGap(f));
  for (const job of jobs) {
    const first = job.first;
    const shown = forBoard(first?.report ?? null);
    const native = nativeReviewBody(first?.row);
    const comments = native !== null ? native.trim() ? [{ path: null, start_line: null, end_line: null, content: native }] : [] : shown.map(commentOf);
    commentCounts.set(job, comments.length);
    if (native !== null && first.row.status === "failed") failures.push({ caseId: job.caseId, config: job.config, repeat: job.repeat, failure: first.row.failure ?? null });
    comments.forEach((c, index) => {
      if (c.start_line === null) withoutLine.push({ caseId: job.caseId, config: job.config, repeat: job.repeat, index });
    });
    const usage = first?.row?.usage ?? first?.report?.completion?.reviewer?.usage ?? null;
    const dir = join(job.config, `r${job.repeat}`);
    const file = join(dir, `${instances.get(job.case).instanceId}.json`);
    files.set(file, {
      review: { comments, summary: { input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null } },
      duration_seconds: typeof first?.row?.wallMs === "number" ? first.row.wallMs / 1000 : null,
      openqodex: { tool: toolName(job.config, job.repeat), caseId: job.caseId, case: job.case, config: job.config, repeat: job.repeat, attempt: 1, status: statusOf(first), findings: comments.length, observations: comments.filter((c) => c.tier === "observation").length },
    });
  }
  const folders = [...new Set(jobs.map((j) => `${j.config}\0${j.repeat}`))]
    .map((k) => {
      const [config, repeat] = [k.split("\0")[0], Number(k.split("\0")[1])];
      const mine = jobs.filter((j) => j.config === config && j.repeat === repeat);
      const statuses = {};
      for (const j of mine) statuses[statusOf(j.first)] = (statuses[statusOf(j.first)] ?? 0) + 1;
      return { config, repeat, tool: toolName(config, repeat), dir: `${config}/r${repeat}`, files: mine.length, comments: mine.reduce((n, j) => n + commentCounts.get(j), 0), leftOutTestGaps: mine.reduce((n, j) => n + shownFindings(j.first?.report ?? null).length - forBoard(j.first?.report ?? null).length, 0), statuses };
    })
    .sort((a, b) => (a.config < b.config ? -1 : a.config > b.config ? 1 : a.repeat - b.repeat));
  const all = [...instances.values()];
  const total = all.reduce((n, i) => n + i.references, 0);
  const left = all.reduce((n, i) => n + i.left, 0);
  const record = {
    version: 1,
    board: "aacr",
    repo: AACR_BOARD.repo,
    commit: AACR_BOARD.commit,
    reader: AACR_READER,
    lineK: AACR_K,
    run: manifest.runId ?? null,
    suite,
    split: manifest.split ?? null,
    splitHash: manifest.splitHash ?? null,
    tool: "openqodex-<config>-r<repeat>",
    instances: all,
    folders,
    references: { total, left, share: total === 0 ? 0 : left / total },
    excludeTestGaps,
    failures,
    leftOutTestGaps: folders.reduce((n, f) => n + f.leftOutTestGaps, 0),
    withoutLine,
  };
  for (const [file, body] of files) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    writeFileSync(join(out, file), `${JSON.stringify(body, null, 2)}\n`);
  }
  writeFileSync(join(out, "convert.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { out, record };
}

/**
 * Their dataset converter's JSONL narrowed to the run's instances, checked
 * against our truth copies and written as <run>/outside/aacr/dataset.jsonl.
 * Returns { path, instances }. Throws when an instance is missing or twice,
 * or when its reference comments are not, in order, the accepted comments
 * our truth copy holds (path, side and range).
 */
export function filterDataset(folder, theirs) {
  folder = resolve(folder);
  const out = boardFolder(folder);
  const record = readJson(join(out, "convert.json"));
  const want = new Map(record.instances.map((i) => [i.instanceId, i]));
  const lines = new Map();
  for (const line of readFileSync(theirs, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (!want.has(row.instance_id)) continue;
    if (lines.has(row.instance_id)) throw new Error(`${theirs} holds the instance ${row.instance_id} twice`);
    lines.set(row.instance_id, { row, line: line.trim() });
  }
  const problems = [];
  for (const [id, inst] of want) {
    const got = lines.get(id);
    if (!got) {
      problems.push(`${inst.case}: their dataset has no instance ${id}`);
      continue;
    }
    const spec = readJson(join(folder, "cases", `${inst.case}.json`));
    const ours = (spec.bugs ?? []).map((b) => [text(b.file), b.lines[0], b.lines[1], b.side ?? null]);
    const refs = (got.row.reference_comments ?? []).map((r) => [text(r.path), Math.min(r.start_line, r.end_line), Math.max(r.start_line, r.end_line), r.side ?? null]);
    if (JSON.stringify(ours) !== JSON.stringify(refs)) problems.push(`${inst.case}: their ${refs.length} reference comments are not, in order, the ${ours.length} accepted comments of our truth copy (path, lines and side)`);
  }
  if (problems.length > 0) throw new Error(`their dataset does not hold this run's truth:\n${problems.join("\n")}`);
  const path = join(out, "dataset.jsonl");
  writeFileSync(path, [...want.keys()].sort().map((id) => `${lines.get(id).line}\n`).join(""));
  return { path, instances: want.size };
}

/** The pinned positive file in the cache, checked by its sha256. */
export function rawDataset({ cache = cacheRoot() } = {}) {
  const pin = readSuite("aacr").file.dataset.files.positive;
  const path = rawPath(cache, "aacr", pin);
  if (!existsSync(path)) throw new Error(`${pin.path} is not in the cache (${path}); run node benchmark/ingest/aacr.mjs to fetch it`);
  checkPinned(readFileSync(path), pin, path);
  return path;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "pin" && args.length === 0) {
      console.log(`${AACR_BOARD.repo} ${AACR_BOARD.commit}`);
    } else if (command === "cache" && args.length === 0) {
      console.log(benchCache());
    } else if (command === "raw" && args.length === 0) {
      console.log(rawDataset());
    } else if (command === "convert" && args.length === 1) {
      const { out, record } = convertRun(args[0]);
      const r = record.references;
      console.log(`Converted ${record.instances.length} pull requests into ${record.folders.length} folders (${record.folders.map((f) => f.tool).join(", ")}) under ${out}.`);
      console.log(`Test-gap findings left out: ${record.leftOutTestGaps}.`);
      console.log(`Findings held with no line: ${record.withoutLine.length}. Failed or never-started reviews written as empty: ${record.folders.reduce((n, f) => n + (f.statuses.failed ?? 0) + (f.statuses.unstarted ?? 0), 0)}.`);
      console.log(`left-side references: ${r.left} of ${r.total} (${Math.round(r.share * 1000) / 10}%), which no finding can match by line, since their reader puts every finding on the right side.`);
    } else if (command === "dataset" && args.length === 2) {
      const { path, instances } = filterDataset(args[0], args[1]);
      console.log(`Their dataset narrowed to this run's ${instances} pull requests, each checked against our truth copy: ${path}`);
    } else {
      console.error("usage: node benchmark/outside/convert/aacr.mjs convert <run> | dataset <run> <their jsonl> | raw | pin | cache");
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
