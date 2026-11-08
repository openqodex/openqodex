#!/usr/bin/env node
// Judge a saved run, with the frozen suite as its denominator. Empty
// reviews miss by script. Only a scripted model provider stands in for the
// judge in test/greptile-run.test.mjs, whose failure list precedes this code.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boardFolder } from "../../lib/board-files.mjs";
import { greptileInput, readBoardReviews } from "../../lib/board-reviews.mjs";
import { benchRoot } from "../../lib/cases.mjs";
import { relayClient } from "../../lib/calibration-relay.mjs";
import { validateComparison, validateRunManifest } from "../../lib/comparison.mjs";
import { value } from "../../lib/score.mjs";
import { GREPTILE_PROMPT, GREPTILE_PROMPT_HASH, judgeGreptile } from "./greptile-judge.mjs";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };

function options(argv) {
  const [folder, ...args] = argv;
  const opts = { folder, release: null, dryRun: false, force: false, maxUsd: null };
  if (!folder || folder.startsWith("--")) throw new Error("usage: greptile-run.mjs <run> --release <name> [--dry-run (refuses a folder holding eval.json)] [--max-usd <n>] [--force (priced runs only; after judging succeeds, moves old outside/greptile/ to outside/greptile.superseded-<UTC timestamp>/; nothing is deleted)]");
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--force") opts.force = true;
    else if (flag === "--release" && args[i + 1]) {
      opts.release = args[++i];
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(opts.release)) throw new Error("--release must name a comparison record");
    } else if (flag === "--max-usd" && args[i + 1]) {
      opts.maxUsd = Number(args[++i]);
      if (!Number.isFinite(opts.maxUsd) || opts.maxUsd < 0) throw new Error("--max-usd must be a nonnegative dollar amount");
    } else throw new Error(`unknown or incomplete option ${flag}`);
  }
  if (opts.release === null) throw new Error("--release <name> is required");
  if (opts.force && opts.dryRun) throw new Error("--force is accepted only on a priced run");
  return opts;
}

/** Convert and, unless dry, judge a run through the uncached relay. */
export async function main(argv = process.argv.slice(2), { root = benchRoot } = {}) {
  const opts = options(argv);
  const record = read(join(root, "index/comparisons", `${opts.release}.json`));
  if (record.release !== opts.release) throw new Error("comparison record names another release");
  // Record validation covers the calibration bytes.
  if (!validateComparison(record, { root, build: record.build }).accepted) throw new Error("the comparison record is not accepted");
  return judgeRun(opts, record, { root });
}

/** Judge with the accepted record supplied by main, or a fixture record. */
export async function judgeRun(opts, record, { root = benchRoot } = {}) {
  const pin = record.boards.greptile;
  const truthSet = pin.profile;
  if (!["greptile", "augment"].includes(truthSet)) throw new Error(`record profile ${truthSet}: choose greptile or augment`);
  if (GREPTILE_PROMPT_HASH !== pin.promptHash) throw new Error("Greptile prompts differ from the board pin");
  let calibration;
  for (const ref of record.calibrations) {
    const candidate = read(join(root, ref.file));
    if (candidate.board.name === "greptile") calibration = candidate;
  }
  if (!calibration) throw new Error("the comparison record has no Greptile calibration");
  const folder = resolve(opts.folder);
  const out = boardFolder(folder, "greptile");
  if (existsSync(join(out, "eval.json"))) {
    if (opts.dryRun) throw new Error(`${join(out, "eval.json")} exists already; a dry run would leave input.json disagreeing with the saved verdicts`);
    if (!opts.force) throw new Error(`${join(out, "eval.json")} exists already; use --force on a priced run to move the old evaluation aside`);
  }
  const manifest = read(join(folder, "manifest.json"));
  if (manifest.suite !== "greptile") throw new Error(`the run is of suite ${manifest.suite}, not greptile`);
  if (manifest.mode === "scan") throw new Error("a scanner-only run shows no review for the board to judge");
  const run = readBoardReviews(folder, { root, heading: `${folder} is not converted for Greptile's board:` });
  if (run.manifest.splitHash !== record.suites.greptile.splitHash) throw new Error("the run's split hash differs from the accepted Greptile suite");
  validateRunManifest(manifest, record);
  if (opts.maxUsd !== null && opts.maxUsd > record.capUsd) throw new Error(`--max-usd ${opts.maxUsd} exceeds the record cap ${record.capUsd}`);
  const input = greptileInput(folder, truthSet, { root });
  const held = new Set(run.tools.filter((t) => t.held).map((t) => t.tool));
  for (const t of run.tools) {
    const mine = input.cases.filter((c) => c.tool === t.tool);
    const withComments = mine.filter((c) => c.comments.length > 0).length;
    const notRun = mine.filter((c) => c.status === "not-run").length;
    console.log(`${t.tool}: ${mine.length} cases, ${mine.length - notRun} planned, ${notRun} not-run; ${withComments} with comments, ${mine.length - withComments} without, ${t.held ? mine.length : 0} held.`);
    if (t.held) console.log(`Held, not sent: ${t.tool}: ${run.held.filter((h) => h.tool === t.tool).map((h) => `${h.case} index ${h.index}: lacks ${h.lacking.join(", ")}`).join("; ")}`);
  }
  const unitUsd = calibration.costUsd / calibration.counts.total;
  const judgedCases = input.cases.filter((c) => !held.has(c.tool) && c.comments.length > 0).length;
  const forecast = judgedCases * unitUsd;
  console.log(`Forecast: USD ${forecast.toFixed(6)} for ${judgedCases} judged cases at USD ${unitUsd.toFixed(8)} per case from calibration.`);
  if (opts.dryRun) { write(join(out, "input.json"), input); return 0; }
  if (opts.maxUsd === null) throw new Error("--max-usd is required for a priced run");
  if (forecast > opts.maxUsd) throw new Error(`forecast USD ${forecast.toFixed(6)} exceeds --max-usd ${opts.maxUsd}`);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const pending = boardFolder(folder, `greptile.pending-${stamp}`);
  const superseded = boardFolder(folder, `greptile.superseded-${stamp}`);
  if (existsSync(pending) || existsSync(superseded)) throw new Error("the pending or superseded folder exists already; the old evaluation stays in place");
  write(join(pending, "input.json"), input);

  let relay;
  try {
    if (judgedCases > 0) relay = await relayClient({});
    const perTool = {};
    for (const t of run.tools) {
      // Keep suite order in the file, including misses which use no model.
      const mine = input.cases.filter((c) => c.tool === t.tool);
      const of = run.suite.cases.length;
      const notRun = mine.filter((c) => c.status === "not-run").length;
      if (t.held) {
        perTool[t.tool] = { config: t.config, boardConfig: t.boardConfig, held: input.tools.find((row) => row.tool === t.tool).held, caught: null, missed: null, of, planned: of - notRun, notRun, rate: null };
        continue;
      }
      const reasons = [];
      const judged = await judgeGreptile(mine.filter((c) => c.comments.length > 0), { truthSet, complete: async (request) => {
        const answer = await relay.complete(GREPTILE_PROMPT, request);
        reasons.push(typeof answer.reasoning === "string" ? answer.reasoning : "judge");
        return answer;
      } });
      const labels = new Map(judged.map((v, i) => [v.id, { ...v, reason: reasons[i] }]));
      const verdicts = mine.map((c) => labels.get(c.id) ?? { id: c.id, label: "missed", reason: ["not-run", "failed", "unstarted"].includes(c.status) ? c.status : "empty" });
      const caught = verdicts.filter((v) => v.label === "caught").length;
      perTool[t.tool] = { config: t.config, boardConfig: t.boardConfig, caught, missed: of - caught, of, planned: of - notRun, notRun, rate: value({ hit: caught, of }) };
      write(join(pending, t.tool, "verdicts.json"), verdicts);
    }
    const counts = relay ? await relay.counts() : null;
    write(join(pending, "eval.json"), {
      version: 1, board: { name: pin.name, repository: pin.repository, commit: pin.commit, judgeModel: pin.judgeModel, promptHash: pin.promptHash },
      truthSet, judgeModel: relay?.model ?? null, promptHash: GREPTILE_PROMPT_HASH,
      manifestSha256: run.manifestSha256, splitHash: run.manifest.splitHash, relay: counts, perTool,
    });
  } finally { if (relay) await relay.close(); }
  if (existsSync(out)) renameSync(out, superseded);
  renameSync(pending, out);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message.replaceAll("\n", " ")); process.exitCode = 2; });
