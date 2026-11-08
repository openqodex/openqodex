// Martian's offline Code Review Bench as an outside board: the names our
// reviews go by there, the one paragraph each finding is sent as, and the
// reading of what Martian's own pipeline wrote back into evaluation.json
// (PLAN-benchmark 4.5), which lib/score.mjs readMartianEvaluation reads.
// The converter (outside/convert/martian.mjs) writes the entries; the
// wrapper (outside/boards/martian.sh and martian-judge.mjs) runs the
// pipeline and calls martianEvaluations.
//
// What Martian's pipeline does, read in its code at the commit boards.json
// pins, before this code:
// - step2_extract_comments joins every comment body of one review with
//   "\n\n---\n\n" and has the model extract issues from that text; a review
//   whose joined text is shorter than 20 characters is not extracted, and an
//   extraction that fails leaves the review with no entry in candidates.json
//   (it prints the error count and carries on). Path and line are dropped.
// - step2_5_dedup_candidates groups duplicate candidates of one review by
//   index (only the candidates with text, and only two or more), falling
//   back to one group per candidate when the model fails three times; it
//   prints how many fell back and names none.
// - step3_judge_comments asks the model, for every golden comment and every
//   candidate, whether they are the same issue. Each golden comment keeps
//   the one candidate it matched with the highest confidence (the first on
//   a tie); a matched candidate's dedup siblings are not counted as false.
//   A review with no candidates entry is judged on its raw comment bodies.
//   Golden comments and candidates are keyed by text.
// - analysis/score_profiles sums each tool's true positives and misses by
//   the golden category's profile (strict, core, all) and all its false
//   positives, and gives precision, recall, F1 and F-beta (beta 2 unless
//   told otherwise).
//
// Failure list, written before the code:
// 1. A finding's fix sentence becomes a second extracted issue: a finding
//    is sent as one paragraph, "{title}. {problem} {consequence} Fix:
//    {fix}", with every run of white space one space and every fence of
//    backticks one backtick, so no list or code block can start in it.
// 2. One finding extracted into two issues, or one candidate matched to two
//    golden comments, loses a match: every candidate Martian extracted is
//    kept by its index (its upstream id is <golden URL>#<index>), and every
//    true positive of every review becomes a match line; a candidate text
//    held by two candidates gives a line for each, as Martian's text keys
//    count them as one.
// 3. A review judged on something other than its extracted candidates (an
//    extraction that failed, so Martian fell back to the raw comments), a
//    review never judged, one with a failed judge call, or a match naming a
//    candidate or golden comment the files do not hold, is read as scored:
//    each is a problem of its tool name, and a tool name with a problem
//    gets no evaluation.
// 4. Two configurations go by one tool name, or a configuration that is not
//    the product as it ships (the code graph off) is named as it:
//    boardConfigOf names model reviewers library, Claude Code cli-claude
//    and Codex cli-codex, and refuses the graph off.
// 5. The finding behind a candidate is guessed by a model: a script
//    attributes each candidate to the finding whose text holds the longest
//    run of its words, then the most of its words; a tie keeps every tied
//    finding, and the method and score are recorded beside it. This feeds
//    only our own counts (lib/score.mjs ours), never the official ones.
// From the review of PR 161:
// 6. A forged or local manifest reads Martian's held-out golden comments by
//    naming a release: releaseGate takes a run as a release run only when
//    its manifest names a release, is no smoke run, and records the
//    published package of that release (run.mjs --package npm:<release>:
//    openqodex at that version, its tarball's sha256 and sha512 integrity),
//    and the npm registry, asked again at its fixed address, gives that
//    version the same integrity. The registry serves no sha256 of a
//    tarball, only its sha512 integrity (and a sha1), so the integrity is
//    what ties the record to the published build. An accepted comparison
//    also admits its pinned clean local build, explicitly labelled local.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_NAME } from "./package.mjs";
import { benchRoot } from "./cases.mjs";
import { comparisonRelease } from "./comparison.mjs";
import { boardReview, martianReviewConversion, readAttempts, readBoardReviews } from "./board-reviews.mjs";
import { hashFolder, sha256 } from "./index.mjs";
import { canonical, martianFindings, martianGolden, population, readMartianEvaluation } from "./score.mjs";
import { martianTruth, truthHashOf } from "./suites.mjs";

const BOARDS = JSON.parse(readFileSync(new URL("../outside/boards.json", import.meta.url), "utf8"));
export const MARTIAN_BOARD = Object.freeze({ repo: BOARDS.boards.martian.repo, commit: BOARDS.boards.martian.commit, source: BOARDS.boards.martian.source });
// score_profiles' own default F-beta.
export const MARTIAN_BETA = 2;
export const MARTIAN_CITED = Object.freeze({ profile: "core", metric: "F1", beta: 1, publishedJudge: "anthropic_claude-opus-4-5-20251101" });
export const MARTIAN_PROFILES = ["strict", "core", "all"];
export const MARTIAN_STEPS = Object.freeze({ extract: "step2_extract_comments", dedup: "step2_5_dedup_candidates", judge: "step3_judge_comments", score: "score_profiles" });
// Step 2 extracts a review only when its joined text has this many characters.
const EXTRACT_MIN = 20;
const SEPARATOR = "\n\n---\n\n";

// ---------- the release gate ----------

// The npm registry, at its fixed address.
export const REGISTRY = "https://registry.npmjs.org";
const firstLine = (error) => String(error?.message ?? error).split("\n")[0];

/** The registry's record of openqodex at `version` (its dist holds the integrity). */
export async function npmRegistryAnswer(version) {
  const r = await fetch(`${REGISTRY}/${PACKAGE_NAME}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`it answered ${r.status} for ${PACKAGE_NAME}@${version}`);
  return r.json();
}

/**
 * The release a run's manifest makes it, checked: { release, package }, or
 * a thrown refusal ("refused: ..."). `registry(version)` answers as the npm
 * registry does (npmRegistryAnswer).
 */
export async function releaseGate(manifest, { registry = npmRegistryAnswer, root = benchRoot } = {}) {
  if (manifest?.smoke === true) throw new Error("refused: the run is a smoke run, which checks the runner and is never a measurement; nothing of it goes to a board, and it never reads a held-out case");
  const release = manifest?.release;
  if (typeof release !== "string" || release.trim() === "") throw new Error("refused: the run is not a release run (its manifest names no release). Every Martian case is held out, and only a release run's samples are converted, the one way their golden comments are read");
  const p = manifest.package ?? null;
  if (p?.spec === "local") return comparisonRelease(manifest, { root });
  const named = p === null ? "no package record" : p.spec === "local" ? `the local build${p.commit ? ` at ${String(p.commit).slice(0, 12)}` : ""}` : `${p.spec ?? "an unnamed package"} (${p.name ?? "no name"}@${p.version ?? "no version"})`;
  if (p === null || p.spec !== `npm:${release}` || p.name !== PACKAGE_NAME || p.version !== release) throw new Error(`refused: the run names the release ${release}, but it reviewed ${named}, not ${PACKAGE_NAME}@${release} from npm (run.mjs --package npm:${release}); a release run reviews the published package of its release, and a local build is never one`);
  if (!/^[0-9a-f]{64}$/.test(String(p.sha256)) || !String(p.integrity).startsWith("sha512-") || p.registryIntegrity !== p.integrity) throw new Error(`refused: the run's package record of ${PACKAGE_NAME}@${release} does not hold a tarball sha256 and a sha512 integrity that equals the one the registry gave when it was fetched`);
  let answer;
  try {
    answer = await registry(release);
  } catch (error) {
    throw new Error(`refused: the npm registry (${REGISTRY}) could not confirm ${PACKAGE_NAME}@${release}: ${firstLine(error)}`);
  }
  if (answer?.name !== PACKAGE_NAME || answer?.version !== release || answer?.dist?.integrity !== p.integrity) throw new Error(`refused: the npm registry (${REGISTRY}) gives ${answer?.name}@${answer?.version} the integrity ${answer?.dist?.integrity}, and the run's package record of ${PACKAGE_NAME}@${release} holds ${p.integrity}; the run did not review the published build of its release`);
  return { release, package: p };
}

/**
 * The board configuration a run's configuration id (<reviewer>-graph-<on|off>,
 * lib/runner.mjs planJobs) goes by, or a thrown refusal.
 */
export function boardConfigOf(config) {
  const m = /^(.+)-graph-(on|off)$/.exec(String(config));
  if (!m) throw new Error(`${config}: not a review configuration (<reviewer>-graph-<on|off>), so the board has no name for it`);
  if (m[1] === "control" && m[2] === "off") return "control";
  if (m[2] !== "on") throw new Error(`${config}: the board scores OpenQodex as it ships, with the code graph built; a configuration with the graph off has no tool name there`);
  if (m[1] === "claude") return "cli-claude";
  if (m[1] === "codex") return "cli-codex";
  if (m[1].startsWith("model-")) return "library";
  throw new Error(`${config}: the board has no configuration for the reviewer ${m[1]}`);
}

/** The tool name a configuration and repeat go by on the board. */
export const boardToolName = (config, repeat) => boardConfigOf(config) === "control" ? `claude-code-control-r${repeat}` : `openqodex-${boardConfigOf(config)}-r${repeat}`;
export const martianToolName = boardToolName;

const flat = (s) => (typeof s === "string" ? s.replace(/`{3,}/g, "`").replace(/\s+/g, " ").trim() : "");

/** One finding as the one paragraph Martian's extraction reads. */
export function martianBody(f) {
  const title = flat(f.title);
  return `${/[.!?]$/.test(title) ? title : `${title}.`} ${flat(f.problem)} ${flat(f.consequence)} Fix: ${flat(f.fix)}`;
}

// ---------- which finding a candidate came from ----------

const words = (s) => String(s).toLowerCase().match(/[a-z0-9_]+/g) ?? [];

// The longest run of words `a` and `b` hold in the same order, unbroken.
function longestRun(a, b) {
  let best = 0;
  let prev = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    const row = Array.from({ length: b.length + 1 }, () => 0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    prev = row;
  }
  return best;
}

/**
 * The findings a candidate's text came from, among `findings` ({ findingId,
 * body } in report order): the one whose body holds the longest run of the
 * candidate's words, then the largest share of its words of three letters
 * or more; every finding tied at the top.
 */
export function attributeCandidate(text, findings) {
  const cand = words(text);
  const distinct = [...new Set(cand.filter((w) => w.length >= 3))];
  const scored = findings.map((f) => {
    const body = words(f.body);
    const inBody = new Set(body);
    return { findingId: f.findingId, run: longestRun(cand, body), share: distinct.length === 0 ? 0 : distinct.filter((w) => inBody.has(w)).length / distinct.length };
  });
  const top = scored.reduce((best, s) => (best === null || s.run > best.run || (s.run === best.run && s.share > best.share) ? s : best), null);
  const tied = top === null ? [] : scored.filter((s) => s.run === top.run && s.share === top.share);
  return { sourceFindingIds: [...new Set(tied.map((s) => s.findingId))], attribution: { method: "longest common run of words, then the share of its words", run: top?.run ?? 0, share: top === null ? 0 : Math.round(top.share * 1000) / 1000, tied: tied.length } };
}

// ---------- reading what the pipeline wrote ----------

/**
 * evaluation.json for each tool name in `data` (the benchmark_data.json the
 * converter wrote), from what Martian's pipeline wrote: `candidates`
 * (candidates.json), `dedup` (dedup_groups.json), `evaluations`
 * (evaluations.json), `totals` ({ beta, profiles: { <profile>: { <tool>:
 * totals } } }, score_profiles' score_tools for each profile), `judge` ({
 * model, served }) and `model` (the MARTIAN_MODEL their results folder is
 * named after). Returns { tools: [{ tool, evaluation, problems }], problems }
 * with one entry per tool name in name order; an evaluation is null when a
 * problem names its tool, and `problems` names what concerns them all.
 */
export function martianEvaluations({ data, candidates, dedup, evaluations, totals, judge, model }) {
  const byTool = new Map();
  for (const [url, entry] of Object.entries(data)) {
    for (const review of entry.reviews ?? []) {
      if (!byTool.has(review.tool)) byTool.set(review.tool, []);
      byTool.get(review.tool).push({ url, entry, review });
    }
  }
  const extraction = { model, step: MARTIAN_STEPS.extract, file: `work/results/${model}/candidates.json` };
  const tools = [];
  for (const tool of [...byTool.keys()].sort()) {
    const problems = [];
    const cands = [];
    const matches = [];
    for (const { url, entry, review } of byTool.get(tool)) {
      const caseId = entry.openqodex?.caseId;
      const goldenIds = new Map((entry.golden_comments ?? []).map((g, i) => [g.comment, `${caseId}#g${i + 1}`]));
      const bodies = (review.review_comments ?? []).map((c) => c.body).filter(Boolean);
      const extracted = candidates?.[url]?.[tool];
      if (extracted === undefined && bodies.join(SEPARATOR).trim().length >= EXTRACT_MIN) problems.push(`${url}: ${tool} has no extracted candidates though its review has text, so Martian judged its raw comments instead (step 2 failed for it)`);
      // The candidates step 3 judged, in its order: the extracted ones with
      // text, or the raw comment bodies of a review step 2 left alone.
      const list = extracted === undefined ? bodies.map((text, i) => ({ id: `${url}#comment${i}`, text, step: "raw comment, below step 2's minimum" })) : extracted.map((c, i) => ({ id: `${url}#${i}`, text: c?.text })).filter((c) => c.text);
      const groups = dedup?.[url]?.[tool];
      if (extracted !== undefined && list.length >= 2 && !Array.isArray(groups)) problems.push(`${url}: ${tool} has ${list.length} candidates and no dedup groups`);
      const ev = evaluations?.[url]?.[tool];
      if (!ev) problems.push(`${url}: ${tool} was not judged (step 3 has no evaluation of it)`);
      else {
        if (ev.skipped) problems.push(`${url}: ${tool} was skipped by step 3 (${ev.reason ?? "no reason given"})`);
        if (ev.errors_count !== 0) problems.push(`${url}: ${tool} has ${ev.errors_count ?? "an unknown number of"} failed judge calls, which step 3 counts as no match`);
        if (ev.total_candidates !== list.length) problems.push(`${url}: ${tool} was judged on ${ev.total_candidates} candidates, and the files hold ${list.length}`);
        if (ev.total_golden !== goldenIds.size) problems.push(`${url}: ${tool} was judged against ${ev.total_golden} golden comments, and the entry holds ${goldenIds.size}`);
      }
      const findings = (review.openqodex?.findingIds ?? []).map((findingId, i) => ({ findingId, body: review.review_comments?.[i]?.body ?? "" }));
      const falsePositives = new Set((ev?.false_positives ?? []).map((fp) => fp.candidate));
      list.forEach((c, k) => {
        const group = Array.isArray(groups) ? groups.findIndex((g) => Array.isArray(g) && g.includes(k)) : list.length === 1 ? 0 : -1;
        const { sourceFindingIds, attribution } = attributeCandidate(c.text, findings);
        if (sourceFindingIds.length === 0) problems.push(`${url}: ${tool}'s candidate ${c.id} has no finding of the review to come from`);
        cands.push({ candidateId: c.id, prUrl: url, sourceFindingIds, attribution, extractedText: c.text, officialFp: falsePositives.has(c.text), extraction: c.step ? { model: null, step: c.step, file: null } : extraction, dedupGroup: group === -1 ? null : group });
      });
      for (const tp of ev?.true_positives ?? []) {
        const goldenId = goldenIds.get(tp.golden_comment);
        const ids = list.filter((c) => c.text === tp.matched_candidate).map((c) => c.id);
        if (goldenId === undefined) problems.push(`${url}: ${tool} has a match on a golden comment that is not among the entry's golden comments`);
        if (ids.length === 0) problems.push(`${url}: ${tool} has a match on a candidate that is not among its extracted candidates`);
        if (goldenId !== undefined) for (const candidateId of ids) matches.push({ candidateId, goldenId, verdict: "match", confidence: tp.confidence ?? null });
      }
    }
    const official = { beta: totals?.beta };
    for (const p of MARTIAN_PROFILES) {
      official[p] = totals?.profiles?.[p]?.[tool];
      if (!official[p]) problems.push(`score_profiles gave no ${p} totals for ${tool}`);
    }
    const first = byTool.get(tool)[0].review.openqodex ?? {};
    const evaluation = problems.length > 0 ? null : { version: 1, board: { repo: MARTIAN_BOARD.repo, commit: MARTIAN_BOARD.commit }, toolName: tool, config: first.config ?? null, repeat: first.repeat ?? null, judge, candidates: cands, matches, totals: official };
    tools.push({ tool, evaluation, problems });
  }
  return { tools, problems: typeof totals?.beta === "number" ? [] : ["score_profiles gave no beta"] };
}

/** Check saved reviews and frozen truth hashes; never read pinned truth or work/. */
export function readMartianOutside(folder, jobs, specs, options = {}) {
  const out = join(folder, "outside", "martian");
  if (!existsSync(join(out, "convert.json"))) throw new Error(`${out} holds no convert.json; convert the run first (benchmark/outside/boards/martian.sh <run>)`);
  const paths = [];
  const read = (path) => { paths.push(`outside/martian/${path}`); return JSON.parse(readFileSync(join(out, path), "utf8")); };
  const convert = read("convert.json");
  const manifestBytes = readFileSync(join(folder, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const need = (ok, why) => { if (!ok) throw new Error(`Martian ${why}`); };
  need(convert.manifestSha256 === sha256(manifestBytes), "manifest sha256 differs from this run's manifest hash");
  const pin = BOARDS.boards.martian;
  const model = BOARDS.deployments[pin.judge.deployment].id;
  need(convert.version === 1 && convert.board === "martian" && convert.repo === pin.repo && convert.commit === pin.commit, "conversion board pins differ from boards.json");
  need(manifest.suite === "martian" && convert.splitHash === manifest.splitHash, "suite or split hash differs from this run");
  if (!existsSync(join(out, "eval.json"))) throw new Error(`${out} holds no eval.json; judge the run first (benchmark/outside/boards/martian.sh <run>)`);
  const evaluated = read("eval.json");
  need(evaluated.version === 1 && evaluated.board === "martian" && evaluated.repo === pin.repo && evaluated.commit === pin.commit && evaluated.judge?.deployment === model, "evaluation board commit or judge differs from boards.json");
  need(Array.isArray(evaluated.problems) && evaluated.problems.length === 0, `evaluation has problems: ${evaluated.problems?.join("; ") ?? "no problem list"}`);
  const data = read("benchmark_data.json");
  const entries = Object.values(data);
  need(Array.isArray(convert.cases) && entries.length === convert.cases.length && entries.every((e) => convert.cases.some((c) => c.caseId === e.openqodex?.caseId)), "benchmark_data cases differ from convert.json");
  const run = readBoardReviews(folder, options);
  const cases = new Map(run.cases.map((c) => [c.source.prUrl, c]));
  const fresh = martianReviewConversion(run).data;
  for (const url of new Set([...Object.keys(data), ...Object.keys(fresh)])) {
    const c = cases.get(url);
    need(c && canonical(data[url]?.reviews) === canonical(fresh[url]?.reviews) && canonical(data[url]?.openqodex) === canonical({ caseId: c.id, case: c.name }), `${c?.id ?? data[url]?.openqodex?.caseId}: benchmark_data.json differs from a fresh conversion of this run`);
    need(Array.isArray(data[url].golden_comments) && truthHashOf(martianTruth({ comments: data[url].golden_comments }).items) === c.truthHash, `${c.id}: golden comments differ from the frozen truth hash`);
  }
  const golden = entries.flatMap((e) => martianGolden(e.openqodex.caseId, martianTruth({ comments: e.golden_comments })));
  const planned = population(manifest, readAttempts(folder));
  need(planned.problems.length === 0, planned.problems.join("; "));
  const reviews = planned.jobs.map(boardReview);
  const expected = [...new Set(jobs.map((j) => boardToolName(j.config, j.repeat)))].sort();
  need(Array.isArray(convert.tools) && convert.tools.length > 0 && new Set(convert.tools.map((t) => t.tool)).size === convert.tools.length, "conversion needs one row per tool");
  need(canonical(convert.tools.map((t) => t.tool).sort()) === canonical(expected), "converted tools differ from the run's planned jobs");
  need(canonical((evaluated.tools ?? []).map((t) => t.tool).sort()) === canonical(expected), "evaluated tools differ from the conversion");
  const perTool = {};
  for (const t of convert.tools) {
    need(t.tool === boardToolName(t.config, t.repeat) && t.boardConfig === boardConfigOf(t.config), `${t.tool}: config or boardConfig differs from its tool name`);
    const record = evaluated.tools.find((row) => row.tool === t.tool);
    if (t.held) {
      need(typeof t.why === "string" && t.why.trim() !== "" && record?.evaluation === null && record.core === null && canonical(record.problems) === canonical([`held by the converter: ${t.why}`]), `${t.tool}: held conversion and evaluation differ`);
      perTool[t.tool] = { config: t.config, boardConfig: t.boardConfig, repeat: t.repeat, held: t.why, official: null, ours: null, candidates: [], matches: [], empty: [] };
      continue;
    }
    const mine = reviews.filter((r) => r.config === t.config && r.repeat === t.repeat);
    const findings = mine.flatMap((r) => r.native === null ? martianFindings(r.caseId, r.first?.report ?? null) : r.findingIds.map((findingId) => ({ findingId, caseId: r.caseId, config: r.config, repeat: r.repeat, index: 0, severity: null, source: "native", text: r.native })));
    const empty = [];
    for (const e of entries) {
      const review = (e.reviews ?? []).find((r) => r.tool === t.tool);
      need(review && Array.isArray(review.review_comments), `${t.tool}: a suite case has no converted review`);
      const caseId = e.openqodex.caseId;
      if (specs[e.openqodex.case]?.truthCount?.items !== undefined) need(specs[e.openqodex.case].truthCount.items === e.golden_comments.length, `${caseId}: golden comment count differs from the saved case`);
      if (review.review_comments.length === 0) {
        const notRun = (convert.notRun ?? []).some((r) => r.tool === t.tool && r.caseId === caseId);
        const failed = (convert.failures ?? []).find((r) => r.config === t.config && r.repeat === t.repeat && r.caseId === caseId);
        const reason = notRun ? "not-run" : review.openqodex.status === "complete" || review.openqodex.status === "incomplete" ? "empty" : review.openqodex.status;
        empty.push({ caseId, reason, ...(failed ? { failure: failed.failure } : {}) });
      }
    }
    need(record?.evaluation === `${t.tool}/evaluation.json` && record.problems?.length === 0, `${t.tool}: evaluation is missing or has problems`);
    const evaluation = read(`${t.tool}/evaluation.json`);
    need(evaluation.toolName === t.tool && evaluation.config === t.config && evaluation.repeat === t.repeat && evaluation.board?.repo === pin.repo && evaluation.board?.commit === pin.commit && evaluation.judge?.model === model, `${t.tool}: evaluation tool or board pins differ`);
    const result = readMartianEvaluation(evaluation, { findings, golden, isNative: (f) => boardConfigOf(f.config) === "control" && boardToolName(f.config, f.repeat) === evaluation.toolName });
    need(canonical(record.core) === canonical(result.official.core), `${t.tool}: eval.json core summary differs from its evaluation`);
    // A candidate's words stay in evaluation.json; in the entry an em dash becomes a comma, as in a judge reason, so the entry passes the scrub.
    const candidates = result.candidates.map((c) => (typeof c.extractedText === "string" ? { ...c, extractedText: c.extractedText.replace(/\s*\u2014\s*/g, ", ") } : c));
    perTool[t.tool] = { config: t.config, boardConfig: t.boardConfig, repeat: t.repeat, official: result.official, ours: result.ours, candidates, matches: result.matches, empty };
  }
  return { board: { repo: pin.repo, commit: pin.commit }, judge: evaluated.judge, profile: "core", perTool, evidenceHash: hashFolder(folder, paths).listHash };
}
