#!/usr/bin/env node
// The judging step of benchmark/outside/boards/martian.sh: Martian's own
// offline pipeline, at the commit boards.json pins, on the entries the
// converter wrote (outside/convert/martian.mjs), then evaluation.json for
// each tool name (PLAN-benchmark 4.5), which lib/score.mjs
// readMartianEvaluation reads.
//
//   node benchmark/outside/boards/martian-judge.mjs <run> --checkout <their offline folder>
//        --python <their venv python> [--dry-run]
//
// In <run>/outside/martian/work/, a folder of its own, it writes
// results/benchmark_data.json (the converter's entries) and runs, with that
// folder as the working folder and their package on PYTHONPATH:
//   1. code_review_benchmark.step2_extract_comments
//   2. code_review_benchmark.step2_5_dedup_candidates
//   3. code_review_benchmark.step3_judge_comments --dedup-groups results/<model>/dedup_groups.json
//   4. analysis.score_profiles --all-profiles (its table, into pipeline.log)
//   5. score_profiles' own score_tools for each profile, as JSON (totals.json)
// Steps 1 to 3 read the judge's settings from the environment variables
// their code reads, MARTIAN_BASE_URL, MARTIAN_API_KEY and MARTIAN_MODEL:
// the base URL and key from lib/model-env.mjs, MARTIAN_MODEL the deployment
// boards.json names as Martian's judge (boards.martian.judge.deployment),
// which must be probed. Steps 4 and 5 get neither the key nor the URL.
// Then it writes <tool>/evaluation.json for each tool name and eval.json.
//
// Failure list, written before the code:
// 1. The key or base URL is echoed (their code prints the base URL at every
//    step): they live in this process and in the environment of steps 1 to
//    3 only, never in argv, a shell variable or a file. Everything the
//    pipeline prints passes through a filter that replaces them before it
//    reaches the terminal or pipeline.log, and every file under
//    outside/martian/ is checked for them afterwards; a hit fails the step
//    without naming the value. A dry run loads and checks the settings,
//    prints the commands with the values hidden, and starts nothing.
// 2. A crash of the pipeline writes a core file holding the key and URL:
//    every step runs with a core file limit of zero (withoutCore, from
//    aacr-judge.mjs); a dry run reports the limit the steps would get.
// 3. Another commit's code, or a modified one, scores the run: the checkout
//    must be the pinned commit with nothing git sees as changed, and
//    eval.json records its commit and tree.
// 4. A step that failed for some reviews is read as a scored run: their
//    steps print errors and exit 0. An extraction that failed (the review
//    then is judged on its raw comments), a review with no dedup groups, a
//    dedup that fell back to no grouping (their count of fallbacks), a
//    review never judged, and a failed judge call (errors_count) are each a
//    problem; a tool name with one gets no evaluation.json, and the step
//    exits 1.
// 5. A judging mixes with an earlier one, or their code reads a .env file:
//    a run with eval.json or a work folder is refused; the work folder is
//    made new, so it holds no .env.
// 6. Files leave the run through a symbolic link: everything is written in
//    lib/board-files.mjs boardFolder(run, "martian").
// From the review of PR 161:
// 7. A conversion made outside the gate, or of another manifest, is judged:
//    the run's manifest must hash to the sha256 convert.json recorded, the
//    access line convert.json recorded must be in the held-out access log,
//    and the release gate (lib/martian-board.mjs releaseGate, the npm
//    registry asked again) runs again before anything is judged.
// 8. A secret is printed in pieces: each stream of each step has its own
//    filter (lib/board-files.mjs redactor), which holds back a possible
//    start of a secret until the next chunk and replaces the URL-encoded
//    forms too; pipeline.log is written only through such a filter, and the
//    leak check also reads each saved file with its line breaks taken out.
// 9. Their checkout or its venv lies in the repository through a link
//    under the cache: both are refused unless their real paths lie outside.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { boardFolder, checkoutState, leaksIn, outsideRepo, redactor } from "../../lib/board-files.mjs";
import { MARTIAN_BETA, MARTIAN_BOARD, MARTIAN_CITED, MARTIAN_PROFILES, MARTIAN_STEPS, martianEvaluations, releaseGate } from "../../lib/martian-board.mjs";
import { endpointSecrets, loadModelEnv, modelEnvPath, probedDeployment } from "../../lib/model-env.mjs";
import { benchRoot } from "../../lib/cases.mjs";
import { validateComparison, validateRunManifest } from "../../lib/comparison.mjs";
import { canonicalJson } from "../../lib/suites.mjs";
import { accessLogPath } from "../convert/martian.mjs";
import { withoutCore } from "./aacr-judge.mjs";

const BOARDS = JSON.parse(readFileSync(new URL("../boards.json", import.meta.url), "utf8"));
const shown = (p) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const readJsonOr = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map((p) => join(dir, String(p))).filter((p) => statSync(p).isFile());

/** The judge's deployment for Martian, from boards.json, refused unless probed. */
export function martianJudge(boards = BOARDS) {
  const key = boards.boards?.martian?.judge?.deployment;
  const d = key ? boards.deployments?.[key] : undefined;
  if (!d) throw new Error(`refused: boards.json names no deployment for Martian's judge (boards.martian.judge.deployment ${JSON.stringify(key ?? null)})`);
  return { key, ...probedDeployment(d.id, { boards }) };
}

// Their results folder is named after MARTIAN_MODEL, with / as _.
const modelDir = (model) => model.trim().replace(/\//g, "_");

// score_profiles' own score_tools for each of its profiles, printed as JSON.
const TOTALS = [
  "import json, sys",
  "from pathlib import Path",
  "from analysis.score_profiles import PROFILE_CATEGORIES, _load_golden_categories, score_tools",
  "results = Path(sys.argv[1])",
  "evaluations = json.loads((results / sys.argv[2] / 'evaluations.json').read_text())",
  "golden = _load_golden_categories(results)",
  "beta = float(sys.argv[3])",
  "print(json.dumps({'beta': beta, 'profiles': {p: score_tools(evaluations, golden, p, beta) for p in PROFILE_CATEGORIES}}, indent=2))",
].join("\n");

// The pipeline's steps, in order; `judge` steps get the judge's settings.
function steps(model) {
  const dir = modelDir(model);
  return [
    { step: MARTIAN_STEPS.extract, judge: true, args: ["-B", "-P", "-m", "code_review_benchmark.step2_extract_comments"] },
    { step: MARTIAN_STEPS.dedup, judge: true, args: ["-B", "-P", "-m", "code_review_benchmark.step2_5_dedup_candidates"] },
    { step: MARTIAN_STEPS.judge, judge: true, args: ["-B", "-P", "-m", "code_review_benchmark.step3_judge_comments", "--dedup-groups", `results/${dir}/dedup_groups.json`] },
    { step: MARTIAN_STEPS.score, judge: false, args: ["-B", "-P", "-m", "analysis.score_profiles", "--results-dir", "results", "--model", dir, "--all-profiles", "--beta", String(MARTIAN_BETA)] },
    { step: `${MARTIAN_STEPS.score} totals`, judge: false, args: ["-B", "-P", "-c", TOTALS, "results", dir, String(MARTIAN_BETA)], stdout: "totals.json", shownArgs: ["-B", "-P", "-c", "<score_tools for each profile, as JSON>", "results", dir, String(MARTIAN_BETA)] },
  ];
}

export function calibrationSteps(model) {
  return steps(model).map((s) => {
    if (s.step === MARTIAN_STEPS.score) return { ...s, args: [...s.args.slice(0, -3), "--profile", MARTIAN_CITED.profile, "--beta", String(MARTIAN_CITED.beta)] };
    if (s.stdout) return { ...s, args: [...s.args.slice(0, -1), String(MARTIAN_CITED.beta)] };
    return s;
  });
}

// Runs one step, each of its two streams through a filter of its own into
// the terminal and the log (`emit`); with `stdout`, its standard output
// (filtered) is kept apart and returned instead. Returns { code, signal,
// text, stdout }, text being what was emitted.
function runStep(command, args, { cwd, env, emit, secrets, keepStdout, signal }) {
  return new Promise((done) => {
    let text = "";
    let kept = "";
    const sink = (t) => {
      text += t;
      emit(t);
    };
    const err = redactor(secrets, sink);
    const out = redactor(secrets, keepStdout ? (t) => (kept += t) : sink);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => err.write(c));
    child.on("close", (code, signal) => {
      out.end();
      err.end();
      done({ code, signal, text, stdout: kept });
    });
    child.on("error", () => done({ code: 2, signal: null, text: "pipeline process could not start", stdout: "" }));
  });
}

export async function main(argv = process.argv.slice(2), { root = benchRoot } = {}) {
  let folder = null;
  let dry = false;
  let checkout = null;
  let python = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dry = true;
    else if (argv[i] === "--checkout") checkout = argv[++i];
    else if (argv[i] === "--python") python = argv[++i];
    else if (folder === null && !argv[i].startsWith("--")) folder = resolve(argv[i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (folder === null || checkout === null || python === null) throw new Error("usage: martian-judge.mjs <run> --checkout <their offline folder> --python <path> [--dry-run]");
  checkout = resolve(checkout);
  const out = boardFolder(folder, "martian");
  if (!existsSync(join(out, "convert.json"))) throw new Error(`${out} holds no convert.json; martian.sh converts the run first`);
  const convert = JSON.parse(readFileSync(join(out, "convert.json"), "utf8"));
  if (convert.commit !== MARTIAN_BOARD.commit) throw new Error(`${out}/convert.json was written for Martian's board at ${convert.commit}, and boards.json now pins ${MARTIAN_BOARD.commit}; convert the run again`);
  // The conversion is the one the gate let through, of this very manifest (failure 7).
  const manifestBytes = readFileSync(join(folder, "manifest.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== convert.manifestSha256) throw new Error(`refused: the run's manifest is not the one ${out}/convert.json was written for (its sha256 differs); convert the run again`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.package?.spec === "local") {
    const record = JSON.parse(readFileSync(join(root, "index/comparisons", `${manifest.release}.json`), "utf8"));
    validateRunManifest(manifest, record);
    if (!validateComparison(record, { root, build: record.build }).accepted) throw new Error("the comparison record is not accepted");
  }
  const accessLog = accessLogPath();
  const logged = existsSync(accessLog) ? readFileSync(accessLog, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
  const same = (line) => {
    try {
      return canonicalJson(JSON.parse(line)) === canonicalJson(convert.access);
    } catch {
      return false;
    }
  };
  if (!convert.access || !logged.some(same)) throw new Error(`refused: the held-out access the conversion recorded is not in ${accessLog}; a conversion is judged only when its access is logged`);
  outsideRepo(checkout, "Martian's checkout");
  outsideRepo(dirname(dirname(resolve(python))), "the venv of Martian's pipeline");
  const judge = martianJudge();
  // Refuses, naming the file or the field and never a value, when the settings are missing.
  const settings = loadModelEnv();
  const plan = steps(judge.id);
  const work = join(out, "work");
  const sent = convert.tools.filter((t) => !t.held);
  const held = convert.tools.filter((t) => t.held);

  if (dry) {
    console.log(`Dry run: Martian's pipeline at ${MARTIAN_BOARD.commit.slice(0, 12)} would run in ${shown(work)} on ${sent.length} tool names (${sent.map((t) => t.tool).join(", ") || "none"}), from ${shown(checkout)}${existsSync(join(checkout, "code_review_benchmark")) ? "" : " (not fetched yet; martian.sh fetches it)"}:`);
    for (const s of plan) console.log(`  ${shown(python)} ${(s.shownArgs ?? s.args).join(" ")}${s.stdout ? ` > ${s.stdout}` : ""}`);
    console.log(`with MARTIAN_MODEL=${judge.id} (the deployment boards.json names "${judge.key}", probed ${judge.probed}), and MARTIAN_BASE_URL and MARTIAN_API_KEY from ${shown(modelEnvPath())} (values hidden), set for the first three steps only.`);
    for (const t of held) console.log(`Held by the converter, not judged: ${t.tool}: ${t.why}`);
    console.log(`The run's manifest is the one converted, and its access line is in ${shown(accessLog)}. Before judging, the release gate runs again: the npm registry is asked for ${convert.package?.spec ?? "the run's package"}.`);
    const [sh, probe] = withoutCore("/bin/sh", ["-c", "ulimit -c"]);
    console.log(`core file limit for the pipeline: ${spawnSync(sh, probe, { encoding: "utf8" }).stdout.trim()}. Nothing was started.`);
    return 0;
  }

  await releaseGate(JSON.parse(manifestBytes.toString("utf8")));
  if (!existsSync(join(checkout, "code_review_benchmark", "step3_judge_comments.py")) || !existsSync(python)) throw new Error(`their pipeline or its python is not in ${shown(checkout)}; run benchmark/outside/boards/martian.sh --prepare`);
  const state = checkoutState(dirname(checkout));
  if (state.commit !== MARTIAN_BOARD.commit) throw new Error(`their checkout is at ${state.commit || "no commit"}, not the commit boards.json pins (${MARTIAN_BOARD.commit})`);
  if (state.problems.length > 0) throw new Error(`their checkout ${shown(dirname(checkout))} is not the pinned commit as it stands: ${state.problems.join("; ")}. Their code is never patched: move the checkout to the Trash and run martian.sh --prepare`);
  return runPipeline({ out, convert, checkout, python, state, judge, settings });
}

/**
 * Runs the pipeline on the converted run whose board folder is `out`
 * (convert.json read as `convert`) with their code in `checkout` (the
 * offline folder, `state` its checkoutState) and `python`, the judge
 * deployment `judge` (martianJudge) and the endpoint `settings`
 * (lib/model-env.mjs). Writes work/, <tool>/evaluation.json and eval.json;
 * returns 0, or 1 with the problems printed. main() verifies the checkout
 * first.
 */
export async function runPipeline({ out, convert, checkout, python, state, judge, settings, calibration = false, signal, beforeStep }) {
  const secrets = endpointSecrets(settings.baseUrl, settings.apiKey);
  const plan = calibration ? calibrationSteps(judge.id) : steps(judge.id);
  const work = join(out, "work");
  const sent = convert.tools.filter((t) => !t.held);
  const held = convert.tools.filter((t) => t.held);
  if (existsSync(join(out, "eval.json")) || existsSync(work)) throw new Error(`${out} holds eval.json or a work folder: the run was judged before. Move outside/martian to the Trash and run martian.sh again to judge it anew.`);
  if (sent.length === 0) throw new Error(`${out}/convert.json sends no tool name to the judge (every one is held); nothing to judge`);

  // The steps' environment: ours without any judge, OpenAI or Python setting, plus what their code reads.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MARTIAN_|OPENAI_|AZURE_OPENAI_|PYTHON)/.test(k)));
  Object.assign(base, { PYTHONPATH: checkout, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONIOENCODING: "utf-8" });
  const withJudge = { ...base, MARTIAN_BASE_URL: settings.baseUrl, MARTIAN_API_KEY: settings.apiKey, MARTIAN_MODEL: judge.id };
  const results = join(work, "results");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "benchmark_data.json"), readFileSync(join(out, "benchmark_data.json")));
  const version = spawnSync(python, ["--version"], { encoding: "utf8" });
  const startedAt = new Date().toISOString();
  const log = createWriteStream(join(work, "pipeline.log"));
  // Everything shown and logged, already filtered: runStep's filters and say() call it.
  const emit = (t) => {
    process.stdout.write(t);
    log.write(t);
  };
  const say = (t) => {
    const r = redactor(secrets, emit);
    r.write(t);
    r.end();
  };
  const ran = [];
  const problems = [];
  let dedupFallbacks = null;
  for (const s of plan) {
    signal?.throwIfAborted();
    await beforeStep?.({ step: s.step, work });
    say(`\n== ${s.step} ==\n`);
    const r = await runStep(...withoutCore(python, s.args), { cwd: work, env: s.judge ? withJudge : base, emit, secrets, keepStdout: Boolean(s.stdout), signal });
    if (s.stdout) writeFileSync(join(work, s.stdout), r.stdout);
    if (s.step === MARTIAN_STEPS.dedup) dedupFallbacks = Number(/Fallbacks\s*:\s*(\d+)/.exec(r.text)?.[1] ?? NaN);
    ran.push({ step: s.step, exit: r.code, signal: r.signal });
    if (r.code !== 0) {
      problems.push(`${s.step} exited ${r.code ?? r.signal}; the steps after it did not run`);
      break;
    }
  }
  await new Promise((done) => log.end(done));
  if (ran.length === plan.length && dedupFallbacks !== 0) problems.push(Number.isNaN(dedupFallbacks) ? `${MARTIAN_STEPS.dedup} printed no count of fallbacks, so whether every review was grouped is unknown` : `${MARTIAN_STEPS.dedup} fell back to no grouping for ${dedupFallbacks} reviews after three failed model calls, and names none, so no tool name is scored`);

  // What the pipeline wrote, read into evaluation.json per tool name.
  const dir = join(results, modelDir(judge.id));
  const data = readJsonOr(join(results, "benchmark_data.json"), {});
  const candidates = readJsonOr(join(dir, "candidates.json"), {});
  const evaluations = readJsonOr(join(dir, "evaluations.json"), {});
  const totals = readJsonOr(join(work, "totals.json"), null);
  const read = martianEvaluations({ data, candidates, dedup: readJsonOr(join(dir, "dedup_groups.json"), {}), evaluations, totals, judge: { model: judge.id, served: judge.served ?? null }, model: judge.id });
  problems.push(...read.problems);
  const reviews = Object.values(data).flatMap((e) => e.reviews);
  const judged = Object.entries(evaluations).flatMap(([url, tools]) => Object.entries(tools).filter(([tool]) => reviews.some((r) => r.tool === tool && r.pr_url === url)).map(([, ev]) => ev));
  const extracted = Object.values(candidates).flatMap((tools) => Object.entries(tools).filter(([tool]) => sent.some((t) => t.tool === tool)).map(([, list]) => list.length));
  const findings = reviews.reduce((n, r) => n + r.review_comments.length, 0);
  const tools = [];
  for (const t of read.tools) {
    const path = join(out, t.tool, "evaluation.json");
    const ok = t.evaluation !== null && problems.length === 0;
    if (ok) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(t.evaluation, null, 2)}\n`);
    }
    tools.push({ tool: t.tool, evaluation: ok ? relative(out, path) : null, problems: t.problems, core: t.evaluation?.totals?.core ?? null });
  }
  for (const t of held) tools.push({ tool: t.tool, evaluation: null, problems: [`held by the converter: ${t.why}`], core: null });
  const leaks = filesUnder(out).filter((p) => leaksIn(readFileSync(p, "latin1"), secrets));
  problems.push(...read.tools.flatMap((t) => t.problems), ...leaks.map((p) => `${relative(out, p)} holds the judge's key or base URL; move outside/martian to the Trash`));
  const record = {
    version: 1,
    board: "martian",
    repo: MARTIAN_BOARD.repo,
    commit: MARTIAN_BOARD.commit,
    checkout: { commit: state.commit, tree: state.tree },
    judge: { deployment: judge.id, boardsKey: judge.key, probed: judge.probed, servedAtProbe: judge.served ?? null },
    beta: calibration ? MARTIAN_CITED.beta : MARTIAN_BETA,
    python: `${version.stdout}${version.stderr}`.trim(),
    startedAt,
    endedAt: new Date().toISOString(),
    steps: ran,
    extraction: { reviews: reviews.length, findings, extracted: extracted.length, candidates: extracted.reduce((a, b) => a + b, 0), perFinding: findings === 0 ? null : Math.round((extracted.reduce((a, b) => a + b, 0) / findings) * 1000) / 1000 },
    dedup: { fallbacks: dedupFallbacks },
    judging: { reviews: judged.length, errorsCount: judged.reduce((n, ev) => n + (ev.errors_count ?? 0), 0) },
    tools,
    problems,
    log: "work/pipeline.log",
  };
  writeFileSync(join(out, "eval.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nMartian's ${MARTIAN_PROFILES.join(", ")} totals are in each tool name's evaluation.json; the Core profile:`);
  for (const t of tools) console.log(`  ${t.tool}: ${t.core ? `precision ${t.core.precision.toFixed(3)}, recall ${t.core.recall.toFixed(3)}, F1 ${t.core.f1.toFixed(3)}` : "not scored"}`);
  console.log(`eval.json written: ${join(out, "eval.json")}.`);
  if (problems.length > 0) {
    console.error([...new Set(problems)].join("\n"));
    return 1;
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message.replaceAll("\n", " "));
      process.exit(2);
    },
  );
}
