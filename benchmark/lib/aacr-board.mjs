// AACR-Bench as an outside board: the names its evaluator files go by, and
// the reader of what its evaluator wrote, which score.mjs --outside aacr
// puts beside our score. The converter (outside/convert/aacr.mjs) writes
// the files; the wrapper (outside/boards/aacr.sh) runs their evaluator.
//
// What their evaluator computes (evaluation/evaluate.py and judge.py at the
// commit boards.json pins), read before this code: per instance, each
// reference comment in order takes the first generated comment, in order,
// that passes three stages: the same path (backslashes made slashes; an
// empty path on either side passes), the same side (a missing side passes;
// their reader puts every generated comment on the right side), and lines
// overlapping or at most k apart (a missing line on either side passes).
// A generated comment gives at most one line match. A fourth stage asks a
// judge whether the two say the same thing; the first yes ends that
// reference's search. Line precision is line matches over generated
// comments, line recall line matches over reference comments, summed over
// the instances that have a result file. An instance with no result file is
// left out of every count.
//
// Failure list, written before the code:
// 1. AACR's mock judge scores a run as if a model judged it: semantic
//    numbers are reported only from an evaluation the wrapper ran, whose
//    record (eval.json) says a model answered (mode llm) with no failed
//    judge call; otherwise they are null with the reason.
// 2. Our line count differs from AACR's on the same reports, unnoticed:
//    each of their rounds is compared with our location numbers for the
//    same configuration and repeat, and lineEqual says whether all agree.
//    Their count can be lower than ours only when the judge said yes to a
//    comment an earlier reference had taken by line (the stage 4 stop).
//    Ours are counted on the set the converter wrote: every shown finding
//    but the test gaps convert.json says it left out (isTestGap), so a
//    lost finding still differs.
// 3. A missing result file shrinks their denominators unnoticed: a round
//    with a missing instance is never line-equal.
// 4. The diagnostics change our score: the reader returns a block for
//    score.json's outside.aacr and reads nothing else of the score.
// 5. Result files leave the run through a symbolic link: every step that
//    writes for the board writes in boardFolder(run), which refuses a path
//    whose real location is not inside the run's real folder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boardFolder as boardFolderFor } from "./board-files.mjs";
import { hashFolder } from "./index.mjs";
import { lineMatches, TEST_ONLY, TEST_ONLY_KINDS } from "./score.mjs";

const BOARDS = JSON.parse(readFileSync(new URL("../outside/boards.json", import.meta.url), "utf8"));
export const AACR_BOARD = Object.freeze({ repo: BOARDS.boards.aacr?.repo, commit: BOARDS.boards.aacr?.commit, source: BOARDS.boards.aacr?.source });
// Their reader for generic comments: `ocr` is only the parser's label, the
// one their CLI takes for a reviewer it does not run.
export const AACR_READER = "ocr";
export const AACR_K = 1;
export const AACR_OUTSIDE_LABEL = "AACR-Bench's own evaluator on this run's findings: a board output and a diagnostic, never an acceptance metric. Line numbers come from its path, side and line stages; semantic numbers only from a judged evaluation the wrapper ran.";

// A finding that only asks for a test: a board submission rule, never our
// score's. The scorer's test-request title and kinds, and also titles that
// say only "uncovered" or ask for coverage.
const MISSING_COVERAGE = /\buncovered\b|\b(no|missing|lacks?|lacking|without|needs?|add)\b[^.]{0,60}\bcoverage\b/i;
export const isTestGap = (f) => TEST_ONLY_KINDS.includes(f.category) && (TEST_ONLY.test(String(f.title ?? "")) || MISSING_COVERAGE.test(String(f.title ?? "")));

/** The tool name a configuration and repeat go by on the board. */
export const toolName = (config, repeat) => `openqodex-${config}-r${repeat}`;

/**
 * The instance id their dataset converter gives a pull request:
 * owner__name@<head 7>, with owner and name from the pull request URL as
 * their converter reads it. `spec` is a run's truth copy of the case.
 */
export function instanceIdOf(spec) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(spec?.source?.prUrl ?? "");
  const head = spec?.materialise?.headSha;
  if (!m || typeof head !== "string" || head.length < 7) throw new Error(`${spec?.id ?? "a case"}: its truth copy names no pull request URL and head commit, so it has no AACR-Bench instance id`);
  return `${m[1]}__${m[2]}@${head.slice(0, 7)}`;
}

/**
 * <run>/outside/aacr by its real path, the folder every board step writes
 * in; a thrown refusal when it, or a folder on the way to it, is a link
 * that leads out of the run or nowhere.
 */
export const boardFolder = (folder) => boardFolderFor(folder, "aacr");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const rate = (hit, of) => (of === 0 ? 0 : hit / of);
const f1 = (p, r) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Why a folder's semantic numbers are not reported, or null when they are.
function unjudged(evalRecord, entry) {
  if (!evalRecord) return "no judged evaluation: the folder's metrics did not come from the wrapper (no eval.json), so a mock judge may have answered";
  if (!entry) return "no judged evaluation of this folder in eval.json";
  if (entry.mode !== "llm") return `the ${entry.mode ?? "unknown"} judge answered, not a model (their evaluator falls back to a mock judge without a key)`;
  if (entry.judgeErrors !== 0) return `${entry.judgeErrors ?? "an unknown number of"} judge calls failed, and their evaluator counts a failed call as no match`;
  return null;
}

/**
 * The outside.aacr block of score.json for the run in `folder`: their
 * evaluator's numbers per configuration and repeat, beside our location
 * numbers from the scored `jobs` (score.mjs scoreRun) on the specs they were
 * scored against (`specs`, by case name). Throws when the run was never
 * converted.
 */
export function readAacrOutside(folder, jobs, specs) {
  const out = join(folder, "outside", "aacr");
  const paths = [];
  const read = (path) => { paths.push(`outside/aacr/${path}`); return readJson(join(out, path)); };
  if (!existsSync(join(out, "convert.json"))) throw new Error(`${out} holds no convert.json; convert the run first (benchmark/outside/boards/aacr.sh)`);
  const convert = read("convert.json");
  const evalRecord = existsSync(join(out, "eval.json")) ? read("eval.json") : null;
  const problems = [];
  const folders = [];
  for (const f of convert.folders) {
    const dir = join(out, f.dir);
    const entry = evalRecord?.folders?.find((x) => x.config === f.config && x.repeat === f.repeat) ?? null;
    const files = entry ? entry.metrics : readdirSync(dir).filter((n) => /^metrics_ocr_.*\.json$/.test(n) && n !== "metrics_ocr_average.json").sort();
    // Our line rule on the findings the converter wrote: the test gaps it left out are left out here too.
    const ours = { matches: 0, generated: 0, expected: 0 };
    let leftOut = 0;
    for (const j of jobs.filter((x) => x.config === f.config && x.repeat === f.repeat)) {
      const kept = convert.excludeTestGaps === true ? j.findings.filter((x) => !isTestGap(x)) : j.findings;
      const l = lineMatches(kept, specs[j.case].bugs ?? []);
      ours.matches += l.matches;
      ours.generated += l.generated;
      ours.expected += l.expected;
      leftOut += j.findings.length - kept.length;
    }
    if (leftOut !== (f.leftOutTestGaps ?? 0)) problems.push(`${f.dir}: convert.json says ${f.leftOutTestGaps ?? 0} test-gap findings were left out, but the rule leaves out ${leftOut} of ours`);
    const rounds = files.map((name) => {
      const s = read(`${f.dir}/${name}`).summary;
      return { file: name, evaluated: s.evaluated_instances, missing: s.missing_instances, expected: s.expected_notes, generated: s.generated_notes, lineMatches: s.matched_line_notes, semanticMatches: s.matched_semantic_notes };
    });
    if (rounds.length === 0) problems.push(`${f.dir}: their evaluator has written no metrics file here`);
    const lineEqual = rounds.length > 0 && rounds.every((r) => r.missing === 0 && r.lineMatches === ours.matches && r.generated === ours.generated && r.expected === ours.expected);
    if (rounds.length > 0 && !lineEqual) problems.push(`${f.dir}: their line counts (${rounds.map((r) => `${r.lineMatches} of ${r.generated} generated, ${r.expected} expected, ${r.missing} missing`).join("; ")}) differ from ours (${ours.matches} of ${ours.generated}, ${ours.expected} expected)`);
    const why = rounds.length === 0 ? "not evaluated" : unjudged(evalRecord, entry);
    // Line numbers from the first round: rounds differ only through the judge's stage 4 stop.
    const first = rounds[0] ?? null;
    const line = first === null ? null : { matches: first.lineMatches, generated: first.generated, expected: first.expected, precision: rate(first.lineMatches, first.generated), recall: rate(first.lineMatches, first.expected), f1: f1(rate(first.lineMatches, first.generated), rate(first.lineMatches, first.expected)) };
    // A judged folder's semantic numbers: the mean over its rounds, as their pipeline averages them.
    const sem = (r) => ({ precision: rate(r.semanticMatches, r.generated), recall: rate(r.semanticMatches, r.expected) });
    const semantic =
      why !== null
        ? null
        : {
            matches: mean(rounds.map((r) => r.semanticMatches)),
            precision: mean(rounds.map((r) => sem(r).precision)),
            recall: mean(rounds.map((r) => sem(r).recall)),
            f1: mean(rounds.map((r) => f1(sem(r).precision, sem(r).recall))),
            // docs/metrics.md: unmatched over generated; their evaluator does not print it.
            noiseRate: mean(rounds.map((r) => rate(r.generated - r.semanticMatches, r.generated))),
          };
    folders.push({ config: f.config, boardConfig: f.config, repeat: f.repeat, tool: f.tool, metrics: files, rounds, ours, lineEqual, line, judged: why === null, why, semantic });
  }
  const byConfig = {};
  for (const config of [...new Set(folders.map((f) => f.config))].sort()) {
    const repeats = folders.filter((f) => f.config === config).sort((a, b) => a.repeat - b.repeat);
    const sum = (k) => repeats.reduce((a, r) => a + (r.line?.[k] ?? 0), 0);
    const [m, g, e] = [sum("matches"), sum("generated"), sum("expected")];
    const semantic = repeats.every((r) => r.semantic !== null) ? Object.fromEntries(["precision", "recall", "f1", "noiseRate"].map((k) => [k, mean(repeats.map((r) => r.semantic[k]))])) : null;
    byConfig[config] = { repeats, mean: { line: { matches: m, generated: g, expected: e, precision: rate(m, g), recall: rate(m, e), f1: f1(rate(m, g), rate(m, e)) }, semantic } };
  }
  return {
    evidenceHash: hashFolder(folder, paths).listHash,
    label: AACR_OUTSIDE_LABEL,
    board: { repo: AACR_BOARD.repo, commit: AACR_BOARD.commit, source: AACR_BOARD.source },
    reader: convert.reader,
    lineK: convert.lineK,
    references: convert.references,
    withoutLine: convert.withoutLine.length,
    judge: evalRecord ? { deployment: evalRecord.judge?.deployment ?? null, rounds: evalRecord.rounds ?? null } : null,
    folders,
    byConfig,
    problems,
  };
}
