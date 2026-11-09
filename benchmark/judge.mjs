#!/usr/bin/env node
// The optional wording pass: a model reads each finding that the script
// already matched to a planted bug and says, for its problem, consequence
// and fix sentences, whether each is plain and whether it is correct
// against the planted truth. It judges wording only. score.mjs folds its
// totals into each configuration's `wording` in score.json, which no rule,
// exit code or accept reads, and this script exits 0 whatever the verdicts
// are.
//
//   node benchmark/judge.mjs <results folder> --wave <id> [--configs a,b] [--limit <reviews>]
//                            [--resume] [--specs <folder of <case>.json>]
//
// The judge is the deployment benchmark/outside/boards.json gives the
// wording role (GPT-5.2), on the endpoint the model settings file names
// (lib/model-env.mjs), through the model adapter (lib/openai-reviewer.mjs).
// Every call is held to the run's hard cap in the run's budget ledger
// (lib/budget.mjs meteredComplete): its worst case is reserved before it is
// sent, and the pass stops when the cap has no room for the next call.
// The pass is also held to the wave cap (lib/wave.mjs): before the first
// call it reserves the smaller of every planned call's worst case and the
// room the run's cap leaves, and at its end it settles with what the run's
// ledger says the pass spent.
//
// The findings judged are those the scorer matches to a planted bug, by the
// run's own specs unless --specs names others, in the first attempt of each
// review (a retry is never scored, so it is never judged).
//
// Writes judge.json into the results folder: each review's verdicts, its
// cost, the model that answered and the totals (raw answers in judge-raw/).
//
// Exit codes: 0 judged; 1 stopped by the run's cap or a failed call, with
// what was judged kept (--resume continues); 2 refused before any call.
//
// Failure list, written before the code:
// 1. The verdict ends up gating a release: score.mjs adds it to score.json
//    after the scoring, no rule, exit code or accept reads it, and this
//    script exits 0 after any judged run.
// 2. The model judges whether the bug was found, which the script already
//    decided: it gets only findings matched to a planted bug, with that
//    bug's truth, and answers about the sentences only.
// 3. The answer is not JSON, or names a finding that was not asked about:
//    it is parsed by script; an answer that does not parse is recorded as
//    unparsed and never guessed at.
// 4. The model reads tools or anything kept from an earlier call: it gets
//    one message and no tools, and the provider keeps nothing.
// 5. The reviewer's own model marks its own wording: the judge is the
//    deployment boards.json gives the wording role, recorded in judge.json
//    beside the run's reviewers.
// 6. The judge spends outside the run's cap or past it: every call goes
//    through the run's ledger with the run's own caps, and a run that
//    records no cap is refused before any call.
// 7. A missing settings file sends the calls to another provider (Azure or
//    OpenAI settings in the environment): the file is the only source, and
//    without it the pass is refused in one line before any call.
// 8. The key or the base URL lands in judge.json, judge-raw/ or a printed
//    line: they stay inside the adapter, whose errors carry neither, and
//    every file is checked for both before it is written.
// 9. A failed call is retried, or recorded as a verdict: it stops the pass
//    at once (a quota, a login or a permission error does not clear on a
//    retry), its reservation is kept as spent, and --resume judges that
//    review later.
// 10. A second pass judges everything again, mixes two judges, or writes
//    over verdicts already paid for: --resume keeps every review already
//    judged and refuses a judge.json from another model or other specs;
//    without --resume an existing judge.json is refused.
// 11. The pass costs more than meant: one call per review, --limit caps the
//    reviews, and the plan is printed before the first call.
// From the review of the first version:
// 12. A write cut off part way (a full disk, a kill) leaves judge.json half
//    written, so the verdicts already paid for are lost and --resume refuses
//    the file: every file is written beside its place and renamed into it,
//    and a write that fails stops the pass with the last whole file kept.
// 13. A resumed pass sends and charges again a review whose answer was saved
//    in judge-raw/ before its verdict reached judge.json: --resume takes such
//    an answer, from the same model about the same findings, with no call
//    and no reservation; without --resume, a judge-raw/ that holds answers is
//    refused like judge.json.
// 14. Two judges on one run send the same calls and write over each other:
//    a judge takes judge.lock in the run folder by an exclusive create (the
//    runner's lockRun), a second one is refused before any call, and the
//    lock goes back on exit.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetRefused, loadPrices, MAX_UTF8_BYTES_PER_CHAR, meteredComplete, openRunLedger, readLedger, requestChars, worstCaseUsd } from "./lib/budget.mjs";
import { openWave, reserve, settle } from "./lib/wave.mjs";
import { repoRoot } from "./lib/cases.mjs";
import { loadModelEnv } from "./lib/model-env.mjs";
import { createOpenAIReviewer } from "./lib/openai-reviewer.mjs";
import { lockRun } from "./lib/runner.mjs";
import { WORDING_SENTENCES, shownFindings, attemptOf, classify, wordingBlock, wordingTotals } from "./lib/score.mjs";
import { renderWording } from "./score.mjs";

const BOARDS = new URL("./outside/boards.json", import.meta.url);
export const JUDGE_LOCK = "judge.lock";
// Room for a verdict on every finding of one review and the model's
// reasoning. A reply cut short does not parse and is recorded as unparsed.
const MAX_OUTPUT_TOKENS = 8000;
// Two yes-or-no questions per sentence need little reasoning; the session's
// probe of the judge deployment ran at this effort.
const EFFORT = "low";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

// The deployment boards.json gives the wording role: exactly one.
function wordingDeployment() {
  const found = Object.values(JSON.parse(readFileSync(BOARDS, "utf8")).deployments ?? {}).filter((d) => Array.isArray(d?.roles) && d.roles.includes("wording"));
  if (found.length !== 1) throw new Error(`refused: benchmark/outside/boards.json gives the wording role to ${found.length} deployments; the judge needs exactly one`);
  return found[0].id;
}

function prompt(items) {
  return [
    "You judge the wording of code review findings. A script has already matched each finding below to a planted bug; the planted truth says what the bug is and how to fix it.",
    "You have no tools and no access to the code. Judge from the text below only, and answer at once.",
    "For each finding, judge its three sentences apart:",
    "- plain: short sentences in the active voice, one fact per sentence, every technical word either common or explained, no filler.",
    "- correct: true to the planted truth; for the fix, it would remove the planted bug. A sentence that contradicts the truth or adds a claim the truth makes false is not correct.",
    "Do not judge whether the bug was found or how severe it is.",
    'Answer with JSON only, in this shape: {"verdicts":[{"id":"f1","problem":{"plain":true,"correct":true},"consequence":{"plain":true,"correct":true},"fix":{"plain":true,"correct":true},"note":"one short sentence"}]}',
    "",
    ...items.map((it) => [`Finding ${it.id}`, `Planted truth: ${it.truth}`, `Title: ${it.finding.title}`, `Problem: ${it.finding.problem ?? ""}`, `Consequence: ${it.finding.consequence ?? ""}`, `Fix: ${it.finding.fix ?? ""}`, ""].join("\n")),
  ].join("\n");
}

// The verdicts in the model's answer, by finding id; null when it does not parse.
export function parseVerdicts(answer, ids) {
  const text = String(answer ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.verdicts)) return null;
  const out = {};
  for (const v of doc.verdicts) {
    if (!ids.includes(v?.id)) continue;
    const ok = WORDING_SENTENCES.every((s) => typeof v[s]?.plain === "boolean" && typeof v[s]?.correct === "boolean");
    if (ok) out[v.id] = { ...Object.fromEntries(WORDING_SENTENCES.map((s) => [s, { plain: v[s].plain, correct: v[s].correct }])), note: typeof v.note === "string" ? v.note : null };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let configs = null;
  let limit = Infinity;
  let resumeRun = false;
  let specsDir = null;
  let waveId = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--configs") configs = args[++i].split(",");
    else if (args[i] === "--wave") waveId = args[++i] ?? null;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else if (args[i] === "--resume") resumeRun = true;
    else if (args[i] === "--specs") specsDir = resolve(args[++i]);
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || !(limit > 0) || waveId === null) {
    console.error(`${waveId === null && pos.length === 1 ? "--wave <id> is required: the pass pays a model, so its forecast is reserved in the wave's journal first\n" : ""}usage: node benchmark/judge.mjs <results folder> --wave <id> [--configs a,b] [--limit <reviews>] [--resume] [--specs <folder of <case>.json>]`);
    return 2;
  }
  // A refusal before any call: one line on stderr.
  const refuse = (message) => {
    const line = String(message).split("\n")[0];
    console.error(line.startsWith("refused:") ? line : `refused: ${line}`);
    return 2;
  };
  const folder = resolve(pos[0]);

  // Where the calls go, from the settings file only, and the adapter that sends them.
  let settings;
  let reviewer;
  try {
    const model = wordingDeployment();
    settings = loadModelEnv();
    reviewer = createOpenAIReviewer({ model, baseUrl: settings.baseUrl, apiKey: settings.apiKey, authHeader: settings.authHeader, maxOutputTokens: MAX_OUTPUT_TOKENS, effort: EFFORT });
  } catch (error) {
    return refuse(error.message);
  }
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) return refuse(`${folder} has no manifest.json; it is not a benchmark run`);
  // One judge per run at a time, held until this process exits; a lock
  // left by a judge that died is taken over.
  try {
    const release = lockRun(folder, { file: JUDGE_LOCK, who: "another judge", advice: "wait for it to end" });
    process.on("exit", release);
  } catch (error) {
    return refuse(error.message);
  }
  // Saved relative to the repository when the specs lie in it, so no machine path is published.
  const specsShown = specsDir === null ? "the run's own cases/" : (() => {
    const r = relative(repoRoot, specsDir);
    return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : specsDir;
  })();
  const outPath = join(folder, "judge.json");
  const rawDir = join(folder, "judge-raw");
  const rawPath = (name) => join(rawDir, `${name}.json`);
  const earlier = existsSync(outPath) ? readJson(outPath) : null;
  if (!resumeRun && (existsSync(outPath) || (existsSync(rawDir) && readdirSync(rawDir).length > 0))) {
    return refuse(`${existsSync(outPath) ? outPath : rawDir} holds an earlier pass's verdicts; pass --resume to judge only the reviews it lacks, or move it away first`);
  }
  if (existsSync(outPath)) {
    if (earlier === null || !Array.isArray(earlier.samples)) return refuse(`${outPath} cannot be read as a judge.json; move it away first`);
    if (earlier.model !== reviewer.model) return refuse(`${outPath} was judged by ${earlier.model}; resuming with ${reviewer.model} would mix two judges, so move it away first`);
    if (earlier.specs !== specsShown) return refuse(`${outPath} was judged by the specs in ${earlier.specs}; resuming with ${specsShown} would mix two sets of findings, so pass the same --specs or move it away first`);
  }
  // The run's own ledger and caps, which every call is held to.
  let ledger;
  let wave;
  try {
    ledger = openRunLedger(folder);
    wave = openWave(waveId);
  } catch (error) {
    return refuse(error.message);
  }

  // Nothing written may hold the endpoint's key or address. Each file is
  // written beside its place and renamed into it, so a write cut off part
  // way never leaves it half written.
  const save = (path, text) => {
    if (settings.appearsIn(text)) throw new Error(`refused: ${path} would hold the model endpoint's key or address, so it was not written`);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, text);
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };
  // What a call is asked, as a hash: an answer saved for other findings is never taken for these.
  const askedHash = (items) => createHash("sha256").update(JSON.stringify(items.map((i) => [i.id, i.bug, i.finding.title]))).digest("hex");
  // An answer an earlier pass was charged for and saved before its verdict
  // reached judge.json: from this model, about these findings. Null when there is none.
  const savedAnswer = (name, items) => {
    const raw = readJson(rawPath(name));
    if (typeof raw?.message?.text !== "string" || raw?.usage?.model !== reviewer.model || raw?.asked !== askedHash(items)) return null;
    return raw;
  };
  const doc = earlier ?? {
    version: 2,
    model: reviewer.model,
    servedModels: [],
    effort: EFFORT,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    specs: specsShown,
    reviewers: manifest.reviewers ?? (manifest.reviewer ? { [manifest.reviewer.name]: manifest.reviewer } : null),
    at: new Date().toISOString(),
    samples: [],
  };
  const judged = new Set(doc.samples.map((s) => `${s.case}/${s.config}/${s.repeat}`));

  const work = [];
  for (const c of dirs(join(folder, "samples"))) {
    const spec = readJson(join(specsDir ?? join(folder, "cases"), `${c}.json`));
    if (!spec) continue;
    for (const config of dirs(join(folder, "samples", c))) {
      if (configs && !configs.includes(config)) continue;
      for (const n of dirs(join(folder, "samples", c, config))) {
        const which = attemptOf(n);
        if (which === null || which.attempt !== 1 || judged.has(`${c}/${config}/${which.repeat}`)) continue;
        const report = readJson(join(folder, "samples", c, config, n, "report", "report.json"));
        if (!report) continue;
        const items = [];
        for (const f of shownFindings(report)) {
          const m = classify(f, spec);
          if (m.outcome !== "hit") continue;
          const bug = spec.bugs.find((b) => b.id === m.bug);
          items.push({ id: `f${items.length + 1}`, bug: bug.id, truth: bug.truth, finding: f });
        }
        if (items.length > 0) work.push({ case: c, config, repeat: which.repeat, items });
      }
    }
  }
  const todo = work.slice(0, limit);
  console.log(`Wording pass with ${reviewer.model}: ${todo.length} reviews, ${todo.reduce((n, w) => n + w.items.length, 0)} findings matched to planted bugs. Each call is held to the run's cap (budget.jsonl). The verdict is reported and never blocks.`);
  const requestOf = (w) => ({ callId: `judge-${w.case}-${w.config}-${w.repeat}`, attempt: 1, purpose: "judge", messages: [{ role: "user", text: prompt(w.items) }], tools: [], maxOutputTokens: MAX_OUTPUT_TOKENS });

  // The wave's reservation: no call can spend past the run's cap, nor past
  // the planned calls' worst cases (when the judge's prices are known).
  const before = ledger.state();
  const room = Math.max(0, ledger.caps.maxUsd - before.spentUsd - before.reservedUsd);
  const rates = loadPrices()[reviewer.model];
  const worst = rates ? todo.reduce((n, w) => n + worstCaseUsd({ requestBytes: MAX_UTF8_BYTES_PER_CHAR * requestChars(requestOf(w)), maxOutputTokens: MAX_OUTPUT_TOKENS, rates }), 0) : Infinity;
  const waveRun = `${manifest.runId ?? basename(folder)}:judge-wording`;
  try {
    reserve(wave, { id: waveRun, path: "judge-wording", forecastUsd: Math.min(room, worst) });
  } catch (error) {
    return refuse(error.message);
  }
  try {
    return await judgeAll();
  } finally {
    settle(wave, waveRun, Math.max(0, readLedger(folder).spentUsd - before.spentUsd));
  }

  async function judgeAll() {

    const write = () => {
      doc.servedModels = [...new Set(doc.samples.map((s) => s.servedModel).filter((m) => typeof m === "string" && m !== ""))].sort();
      doc.totals = wordingTotals(doc.samples);
      return saved(outPath, `${JSON.stringify(doc, null, 2)}\n`);
    };
    let stopped = null;
    // A file that could not be written stops the pass, and is not tried again.
    let unwritten = false;
    const saved = (path, text) => {
      try {
        save(path, text);
        return true;
      } catch (error) {
        stopped = `could not write ${path}: ${error.message}`;
        unwritten = true;
        return false;
      }
    };
    for (const w of todo) {
      const name = `${w.case}-${w.config}-${w.repeat}`;
      let answer = resumeRun ? savedAnswer(name, w.items) : null;
      if (answer === null) {
        const request = requestOf(w);
        try {
          answer = await meteredComplete(ledger, reviewer, request, { what: `wording judge ${w.case}/${w.config}/${w.repeat}` });
        } catch (error) {
          // Nothing was sent when the budget refused; a call that failed is kept as its error.
          if (!(error instanceof BudgetRefused)) saved(rawPath(name), `${JSON.stringify({ asked: askedHash(w.items), error: error.message }, null, 2)}\n`);
          stopped = error.message;
          break;
        }
        // The answer is kept before its verdict reaches judge.json, so a pass cut off between the two never pays for it again.
        if (!saved(rawPath(name), `${JSON.stringify({ asked: askedHash(w.items), message: answer.message, usage: answer.usage }, null, 2)}\n`)) break;
      }
      const verdicts = parseVerdicts(answer.message.text, w.items.map((i) => i.id));
      doc.samples.push({
        case: w.case,
        config: w.config,
        repeat: w.repeat,
        costUsd: answer.usage.costUsd,
        servedModel: answer.usage.servedModel ?? null,
        parsed: verdicts !== null,
        findings: w.items.map((i) => ({ bug: i.bug, title: i.finding.title, verdict: verdicts?.[i.id] ?? null })),
      });
      if (!write()) break;
    }

    // A pass stopped before its first verdict leaves no judge.json behind, and
    // one whose write failed keeps the last whole file.
    if (!unwritten && (doc.samples.length > 0 || stopped === null) && write()) {
      const table = renderWording(Object.fromEntries(Object.keys(doc.totals).map((config) => [config, wordingBlock(doc, config)])));
      if (table !== null) console.log(`\n${table}`);
      console.log(`\nSaved: ${outPath} (judged by ${reviewer.model}; the reviewers were ${JSON.stringify(doc.reviewers)}). This verdict never blocks.`);
    }
    if (stopped !== null) {
      console.error(`Stopped: ${stopped.split("\n")[0]}`);
      return 1;
    }
    return 0;
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
