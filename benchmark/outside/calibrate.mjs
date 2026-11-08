#!/usr/bin/env node
// Failure cases: benchmark/test/calibration-failures.md, before this code.
// This command judges saved public vendor reviews. It never runs a product.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, repoRoot } from "../lib/cases.mjs";
import { agreementOf, compareLabels, costOfUsage, finalizeCalibration, hash, martianLabels } from "../lib/calibration.mjs";
import { greptileInputs, martianInputs } from "../lib/calibration-inputs.mjs";
import { martianItems, relayClient } from "../lib/calibration-relay.mjs";
import { boardFingerprint, buildFingerprint } from "../lib/comparison.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { MARTIAN_CITED } from "../lib/martian-board.mjs";
import { bundleHash } from "../lib/runner.mjs";
import { GREPTILE_PROMPT, GREPTILE_PROMPT_HASH, judgeGreptile } from "./boards/greptile-judge.mjs";
import { martianJudge, runPipeline } from "./boards/martian-judge.mjs";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

// Match the private flat helper in martian-board.mjs.
const flat = (s) => (typeof s === "string" ? s.replace(/`{3,}/g, "`").replace(/\s+/g, " ").trim() : "");
function commentsInForm(comments, form) {
  if (form === "flat") return comments.map(flat);
  if (form === "joined") return comments.length ? [comments.join("\n\n")] : [];
  return comments;
}

export function casesInForm(inputs, form) {
  return form ? inputs.cases.map((c) => ({ ...c, comments: commentsInForm(c.comments, form) })) : inputs.cases;
}

export function calibrationPaths(name, startedAt, { form, root = benchRoot } = {}) {
  const date = new Intl.DateTimeFormat("en-CA").format(new Date(startedAt));
  const suffix = form ? `-${form}` : "";
  const filename = `${name}-${date}${suffix}.json`;
  const output = join(root, "index/calibration", filename);
  if (existsSync(output) && !(name === "martian" && read(output).status === "failed")) throw new Error(`${filename} exists; only a failed Martian calibration can be overwritten`);
  const run = join(root, "results", `calibration-${name}-${name === "martian" ? date : startedAt.replace(/[:.]/g, "-")}${suffix}`);
  return { date, output, run };
}

export function writeCalibration(output, record, form) {
  write(output, form ? { ...record, form } : record);
}

// A prepared provenance record is preferred. With a prebuilt worktree,
// HEAD identifies the product only if no package source has changed.
function installedBuild() {
  if (existsSync(join(benchRoot, ".build/provenance.json"))) return buildFingerprint();
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("status", "--porcelain", "--", "packages")) throw new Error("changed product sources need benchmark/build-cli.mjs provenance before calibration");
  const cli = join(repoRoot, "packages/cli");
  if (!existsSync(join(cli, "dist/bin.js"))) throw new Error("build the CLI before calibration");
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), bundleHash: bundleHash(cli), version: read(join(cli, "package.json")).version };
}

function pythonForPipeline() {
  const upstream = join(cacheRoot(), "upstream");
  const candidates = process.env.OPENQODEX_BENCH_PYTHON ? [process.env.OPENQODEX_BENCH_PYTHON] : [
    ...(existsSync(upstream) ? readdirSync(upstream).filter((s) => s.endsWith(".venv")).map((s) => join(upstream, s, "bin/python")) : []), "python3",
  ];
  for (const python of candidates) {
    const r = spawnSync(python, ["-B", "-c", "import openai, tqdm"], { stdio: "ignore", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    if (r.status === 0) return python;
  }
  throw new Error("Martian requires an existing Python with openai and tqdm; set OPENQODEX_BENCH_PYTHON");
}

export async function main(argv = process.argv.slice(2)) {
  const usage = "usage: node benchmark/outside/calibrate.mjs --board greptile|martian [--form flat|joined]";
  if (![2, 4].includes(argv.length) || argv[0] !== "--board" || !["greptile", "martian"].includes(argv[1]) || (argv.length === 4 && (argv[2] !== "--form" || !["flat", "joined"].includes(argv[3])))) throw new Error(usage);
  const name = argv[1]; const form = argv[3]; const startedAt = new Date().toISOString();
  if (form && name !== "greptile") throw new Error("--form is only supported for --board greptile");
  const { date, output, run } = calibrationPaths(name, startedAt, { form });
  const board = boardFingerprint(name); const build = installedBuild();
  mkdirSync(run, { recursive: true });
  const inputs = name === "greptile" ? await greptileInputs() : await martianInputs();
  if ((name === "greptile" ? GREPTILE_PROMPT_HASH : inputs.promptHash) !== board.promptHash) throw new Error("calibration prompts differ from the board pin");
  const python = name === "martian" ? pythonForPipeline() : null;
  let relay;
  try {
    // Request hashes include the model, prompts and review text; the folder
    // also separates board and source pins before a restart can replay them.
    relay = await relayClient(name === "martian" ? { cacheDir: join(run, "verdicts", hash(JSON.stringify({ board, sources: inputs.sources }))) } : {});
    let verdicts; let published; let classes; let score = null; let judgeFailures = null;
    if (name === "greptile") {
      verdicts = await judgeGreptile(casesInForm(inputs, form), { truthSet: "greptile", complete: (request) => relay.complete(GREPTILE_PROMPT, request) });
      write(join(run, "blind-verdicts.json"), verdicts);
      published = inputs.published(); classes = ["caught", "missed"];
    } else {
      const out = join(run, startedAt.replace(/[:.]/g, "-"), "outside/martian");
      write(join(out, "benchmark_data.json"), inputs.data);
      const code = await runPipeline({ out, convert: { tools: [{ tool: "augment", held: false }] }, checkout: inputs.checkout, python, state: inputs.state, judge: martianJudge(), settings: relay.settings, calibration: true, signal: relay.signal, beforeStep: async ({ work }) => {
        const path = join(work, "results", relay.model, "candidates.json");
        await relay.setItems(martianItems(inputs.data, existsSync(path) ? read(path) : {}));
      } });
      relay.signal.throwIfAborted();
      const failures = (await relay.counts()).judgeFailures;
      if (code !== 0 && failures.length === 0) throw new Error(`Martian calibration pipeline exited ${code}; no calibration accepted`);
      const failedReviews = new Set(failures.flatMap((f) => f.reviews));
      const completed = Object.fromEntries(Object.entries(inputs.data).filter(([url]) => !failedReviews.has(url)));
      const evaluations = read(join(out, "work/results", relay.model, "evaluations.json"));
      verdicts = martianLabels(completed, evaluations, "augment");
      write(join(run, "blind-verdicts.json"), verdicts);
      const allPublished = martianLabels(inputs.data, inputs.published(), "augment");
      const failedLabels = allPublished.filter((r) => failedReviews.has(r.id.slice(0, r.id.lastIndexOf("#g"))));
      judgeFailures = { items: failures.length, reviews: failedReviews.size, labels: failedLabels.length, byClass: Object.fromEntries(["positive", "negative"].map((c) => [c, failedLabels.filter((r) => r.label === c).length])), failures, failedLabels };
      published = allPublished.filter((r) => !failedReviews.has(r.id.slice(0, r.id.lastIndexOf("#g")))); classes = ["positive", "negative"];
      score = { ...MARTIAN_CITED, ours: failures.length ? null : read(join(out, "work/totals.json")).profiles.core.augment, cited: read(join(benchRoot, "index/outside-rows.json")).rows.find((r) => r.board === "martian-offline" && r.tool === "augment") };
    }
    const counts = compareLabels(verdicts, published, classes);
    const counters = await relay.counts();
    const record = { version: 1, board, vendor: name === "greptile" ? "Greptile" : "Augment", labelUnit: name === "greptile" ? "case against original Greptile truth" : "golden comment caught or missed across all categories", build, startedAt, endedAt: new Date().toISOString(), promptHash: board.promptHash, judgeModel: relay.model, counts, agreement: agreementOf(counts), costUsd: costOfUsage(counters.usage, relay.model), costBasis: "Reported token usage at the pinned public rates in outside/prices.json, not an invoice.", pricesHash: hash(readFileSync(join(benchRoot, "outside/prices.json"))), relay: counters, sources: inputs.sources, score, labels: verdicts.map((r) => ({ ...r, published: published.find((p) => p.id === r.id).label })) };
    if (judgeFailures) record.judgeFailures = judgeFailures;
    const exitCode = finalizeCalibration(record);
    if (JSON.stringify(installedBuild()) !== JSON.stringify(build)) throw new Error("product build changed during calibration");
    writeCalibration(output, record, form);
    for (const [name, c] of Object.entries(counts.byClass)) console.log(`${name}: ${c.agree}/${c.total} agree (${(100 * c.agree / c.total).toFixed(2)} percent), ${c.disagree} disagree`);
    console.log(`total: ${counts.agree} agree, ${counts.disagree} disagree; cost USD ${record.costUsd.toFixed(6)}`);
    if (judgeFailures) console.log(`judge failures: ${judgeFailures.items} items, ${judgeFailures.reviews} reviews, ${judgeFailures.labels} labels`);
    console.log(`record: benchmark/index/calibration/${name}-${date}${form ? `-${form}` : ""}.json`);
    if (exitCode) console.error(record.failure);
    return exitCode;
  } catch (error) {
    const counters = relay ? await relay.counts().catch(() => null) : null;
    writeCalibration(join(run, "failure.json"), { board: name, startedAt, build, error: error.message, relay: counters }, form);
    throw error;
  } finally { if (relay) await relay.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
