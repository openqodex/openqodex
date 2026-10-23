// The parts of the runner that decide what a run holds, kept apart from the
// script that starts reviews so each is tested without a reviewer.
//
// Failure list, written before the code:
// 1. A retry writes over the first attempt's report and receipt, so the
//    failure that caused it is lost: every attempt has its own folder.
// 2. A review that timed out or failed leaves no row, so the run looks better
//    than it was: every attempt, a failed or stopped one included, is saved
//    as a sample before anything halts, and is scored.
// 3. A product result (an unread range, a failed answer check) is retried as
//    if the reviewer broke: only a reviewer that failed, timed out or could
//    not start counts as a reviewer failure.
// 4. A resume mixes two runs: it is refused when the bundle, the machine,
//    any reviewer's version or model, web access, the timeout, the
//    concurrency, the cases, the configurations or the repeats differ.
// 5. A run names a commit its bundle was not built from: the build records
//    the commit and the tree it was built from, and the bundle's hash; a run
//    refuses a bundle whose hash differs.
// 6. "Dirty" reads the checkout as it is now, or only some folders: it means
//    the tree the bundle was built from differs from the commit's tree,
//    every file git sees counted, staged or not, untracked included.
// 7. The Codex model is guessed or taken from a variable Codex never reads:
//    it is read from the header Codex prints, or recorded as unknown.
// 8. A planned review that never starts leaves no trace, so the scorer
//    cannot count it as a miss: every job gets an id before the run starts,
//    the manifest lists them all and is written before the first review
//    starts, and every attempt names its job and whether it is the job's
//    first attempt.
// 9. One job is planned twice (--graph on,on, --cases a,a) and counted
//    twice: a plan with a job id twice is refused.
// 10. A runner killed after an attempt started, but before its sample.json,
//    is resumed into the same folder, so a later success replaces the
//    crash: an attempt folder that exists has started and is kept; the
//    resume puts its work in the next free attempt folder.
// 11. Two runners write one run folder, or a restart after a crash writes a
//    new plan over the old: a run folder has one runner at a time (a lock
//    file naming its process; a lock whose process has ended is taken
//    over), and a folder that holds a manifest or samples is refused
//    without --resume.
// 12. Drift (load, time of day) lands on the same cases in every repeat:
//    within each repeat the case order is rotated by the repeat number, as
//    the configuration order alternates.
// 13. A run stopped by its budget reads as finished or as stopped by hand,
//    and is taken for a full run: executeRun asks the budget before every
//    launch, and a stop it gives ends the run as "budget", naming the limit,
//    whether it is a hard cap or a forecast, and what was spent and held.
// 14. A run on a machine that lacks a scanner its cases need is taken for a
//    run with every scanner: scannerPreflight asks the real CLI's doctor, in
//    each case's own repository, which scanners the case calls for and
//    whether each is installed and not switched off by offline mode; a run
//    with one missing is refused unless --allow-missing-scanners, and then
//    records scannersComplete false.
// 15. Repeats added to a finished run are scored as unplanned, or replace
//    the plan the first reviews ran under: --add-repeats keeps every planned
//    job, writes the longer plan into the manifest before any added review
//    starts, and records the addition in the manifest and resumes.jsonl.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REVIEWER_FAILED } from "./reviewers.mjs";
import { SCAN_CONFIG } from "./scan-score.mjs";
import { RULES_VERSION, jobIdOf, shownFindings } from "./score.mjs";
import { controlArgs, controlInput } from "./claude-control.mjs";

// The arguments of one laptop review (Claude Code or Codex through
// `openqodex review`), the same for planted and pull request cases.
export function laptopReviewArgs({ repo, reportDir, job, web, timeout, instructionsRef, configPath }) {
  const args = ["review", "--cwd", repo, "--report-dir", reportDir, "--reviewer", job.reviewer, "--reviewer-web", web, "--timeout", String(timeout), "--no-color"];
  if (configPath !== undefined) args.push("--config", configPath);
  if (instructionsRef !== undefined) args.push("--instructions-ref", instructionsRef);
  if (!job.graph) args.push("--no-graph");
  return args;
}

export function laptopInvocation(options) {
  if (options.job.reviewer === "control") return { command: "claude", args: controlArgs(options), input: controlInput(options.caseData) };
  return { command: process.execPath, args: [options.cli, ...laptopReviewArgs(options)], input: "" };
}

// The jobs of a run in run order: per repeat, every case, every
// configuration, with the configuration order alternating and the case
// order rotated by repeat so drift lands on no one configuration or case
// (failure 12). `caseIds` maps each case name to its frozen id; a job's id
// is <caseId>/<config>/<repeat>. A plan that holds a job id twice is
// refused (failure 9). A scanner-only run (`mode: "scan"`) has one
// configuration, "scan", with no reviewer.
export function planJobs({ cases, caseIds, reviewers = [], graph = [], repeat, mode = "review" }) {
  const configs = [];
  // A model reviewer's name (model:<deployment>) holds a colon, which a
  // configuration id, a folder name, writes as a dash.
  if (mode === "scan") configs.push({ id: SCAN_CONFIG, reviewer: null, graph: false });
  else for (const reviewer of reviewers) for (const g of graph) {
    if (reviewer === "control" && g !== "off") throw new Error("the control reviewer has no graph configuration; use --graph off");
    configs.push({ id: `${reviewer.replace(/:/g, "-")}-graph-${g}`, reviewer, graph: g === "on" });
  }
  const jobs = [];
  for (let r = 1; r <= repeat; r++) {
    const order = r % 2 === 1 ? configs : [...configs].reverse();
    const shift = cases.length === 0 ? 0 : (r - 1) % cases.length;
    for (const c of [...cases.slice(shift), ...cases.slice(0, shift)]) for (const cfg of order) jobs.push({ jobId: jobIdOf(caseIds[c], cfg.id, r), caseId: caseIds[c], case: c, config: cfg.id, reviewer: cfg.reviewer, graph: cfg.graph, repeat: r });
  }
  const seen = new Set();
  for (const j of jobs) {
    if (seen.has(j.jobId)) throw new Error(`the plan holds the review ${j.jobId} twice; name each case, reviewer and graph setting once`);
    seen.add(j.jobId);
  }
  return { configs, jobs };
}

// A new run's manifest: the settings, the rules version, and every planned
// job with its id.
export function runManifest({ startedAt, settings, jobs }) {
  return { version: 3, started_at: startedAt, ...settings, rulesVersion: RULES_VERSION, planned: jobs.length, jobs: jobs.map(({ jobId, caseId, config, repeat }) => ({ jobId, caseId, config, repeat })), ended: null };
}

// One job in a run folder: whether its first attempt folder exists (it
// started), whether any attempt was saved with its sample.json (it is done),
// and the next free attempt number (failure 10).
export function jobState(out, job) {
  let next = 1;
  let done = false;
  while (existsSync(attemptDir(out, job, next))) {
    if (existsSync(join(attemptDir(out, job, next), "sample.json"))) done = true;
    next++;
  }
  return { started: next > 1, done, next };
}

export const LOCK_FILE = ".run.lock";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// The lock file as one open file: its device and inode, which ties a stale
// lock to the one guard that may replace it, and its text; null when there
// is none. Reading by an open fd, not by path, so what is checked below is
// exactly the file whose dev/ino were read, never a different file a rename
// put at the same path afterward.
function readLock(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { dev, ino } = fstatSync(fd);
    return { dev, ino, text: readFileSync(fd, "utf8").trim() };
  } finally {
    closeSync(fd);
  }
}

// Replaces a lock whose holder `stalePid` has ended with this process's own,
// and only in one process: lib/budget.mjs's ledger lock took the same race
// (fixed in PR 125) and uses the same guard. The taker first makes the
// takeover guard for that very file (its device and inode) by an exclusive
// create, so one process at a time may act on it; a process taking the lock
// the usual way never touches this file, so while the guard is there only
// its holder changes the lock. The holder re-reads the lock and only goes on
// when it is still that very file (dev and ino, not just a path that could
// hold a different file by then), with the same text, and still no live
// process: it then writes its own pid into a fresh file and renames that
// over the lock in one step, so the path is never briefly empty for a third
// process to claim. True when this process now holds the lock.
export function takeOverStale(path, stalePid) {
  const seen = readLock(path);
  if (seen === null || seen.text !== String(stalePid) || alive(Number(seen.text))) return false;
  const guard = `${path}.takeover-${seen.dev}-${seen.ino}`;
  try {
    writeFileSync(guard, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    const now = readLock(path);
    if (now === null || now.dev !== seen.dev || now.ino !== seen.ino || now.text !== seen.text || alive(Number(now.text))) return false;
    const mine = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(mine, `${process.pid}\n`);
    renameSync(mine, path);
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

// Takes a run folder for this process, or throws when another live process
// holds it. A lock file with no process number is being written, and counts
// as held. Returns the function that gives the folder back (failure 11).
// `file`, `who` and `advice` let another command on the run folder (the
// wording judge) take a lock of its own the same way.
export function lockRun(out, { file = LOCK_FILE, who = "another run", advice = "wait for it to end, or use another --out" } = {}) {
  mkdirSync(out, { recursive: true });
  const path = join(out, file);
  const held = () => () => {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
  };
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return held();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
      const pid = Number(text);
      if (!/^\d+$/.test(text) || alive(pid)) break;
      // A lock left by a runner that died: take it over (this process's own
      // pid is already written by takeOverStale on success), unless another
      // runner got there first.
      if (takeOverStale(path, pid)) return held();
    }
  }
  const holder = existsSync(path) ? readFileSync(path, "utf8").trim() : "unknown";
  const empty = holder === "" ? `; its lock names no process yet, and if it stays empty, a runner died while writing it: move ${path} away by hand` : "";
  throw new Error(`${out} is in use by ${who} (process ${holder || "unknown"}); ${advice}${empty}`);
}

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// Runs a planned run in its folder, the way run.mjs does, with `runJob`
// doing one job's reviews:
// 1. takes the folder (lockRun); a new run is refused when the folder holds
//    a manifest or samples, and writes `manifest` before any review; a
//    resume reads the folder's manifest and is refused when
//    `checkResume(earlier)` names a difference;
// 2. copies each [from, path in the run] in `copies` that is not there yet
//    (the specs the run scores against);
// 3. runs every job with no saved attempt, `concurrency` at a time, as
//    runJob(job, attempt, ticket), where attempt is the job's next free
//    attempt number, until `stopReason()` names a reason. With a `budget`
//    (lib/budget.mjs runBudget), each launch is asked of budget.admit(job)
//    first: a ticket (closed when the job ends; a model review's meter), a
//    wait for a running job to end, or a stop that ends the run as
//    "budget" (failure 13);
// 4. records how it ended, with the minutes it took, the halt rule that
//    stopped it when `haltOf()` names one ({ rule, why }, lib/halts.mjs),
//    and what `finish()` adds once every job is done (a scanner-only run's
//    external inputs, a model run's served models), in the manifest (a new
//    run) or resumes.jsonl (a resume), and gives the folder back.
// `addRepeats` ({ repeat, jobs, at }) adds repeats to a finished run, as a
// resume whose plan grows: the manifest gets the longer plan, under the
// folder's lock, before the first added review (failure 15). `resumeNote`
// is added to the resume's first line (the budget it runs under).
// Throws before any review when the folder is refused.
export async function executeRun({ out, manifest, resume = false, checkResume = () => [], copies = [], jobs, concurrency = 1, runJob, stopReason = () => null, haltOf = () => null, log = () => {}, budget = null, addRepeats = null, resumeNote = {}, finish = () => ({}) }) {
  const release = lockRun(out);
  const started = Date.now();
  try {
    const manifestPath = join(out, "manifest.json");
    const resumesPath = join(out, "resumes.jsonl");
    if (resume) {
      const earlier = readJsonFile(manifestPath);
      if (!earlier) throw new Error(`${out} has no manifest.json; there is no run to resume`);
      const differ = checkResume(earlier);
      if (addRepeats) differ.push(...repeatsProblems(earlier, readJsonLines(resumesPath), addRepeats, jobs));
      if (differ.length > 0) throw new Error(`${out} cannot be ${addRepeats ? "given more repeats" : "resumed"}: ${addRepeats ? "it" : "resuming"} would mix two runs. Start a new run with --out.\n${differ.map((d) => `- ${d}`).join("\n")}`);
      if (addRepeats) {
        const added = { at: addRepeats.at, from: earlier.repeat, to: addRepeats.repeat, jobs: jobs.length - earlier.jobs.length };
        writeFileSync(manifestPath, `${JSON.stringify({ ...earlier, repeat: addRepeats.repeat, planned: jobs.length, jobs: jobs.map(({ jobId, caseId, config, repeat }) => ({ jobId, caseId, config, repeat })), repeatsAdded: [...(earlier.repeatsAdded ?? []), added] }, null, 2)}\n`);
        appendFileSync(resumesPath, `${JSON.stringify({ event: "repeats-added", ...added })}\n`);
      }
    } else {
      if (existsSync(manifestPath) || existsSync(join(out, "samples"))) throw new Error(`${out} already holds a run (a manifest or samples); pass --resume to finish it, or --out for a new folder`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const [from, path] of copies) {
      const to = join(out, path);
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
    const queue = jobs.map((job) => ({ job, state: jobState(out, job) })).filter((x) => !x.state.done);
    if (resume) appendFileSync(resumesPath, `${JSON.stringify({ event: "resumed", at: new Date().toISOString(), toRun: queue.length, ...resumeNote })}\n`);
    const total = queue.length;
    let done = 0;
    let running = 0;
    let budgetStop = null;
    const waiting = [];
    const worker = async () => {
      while (stopReason() === null && budgetStop === null && queue.length > 0) {
        let ticket = null;
        if (budget) {
          const a = budget.admit(queue[0].job);
          if (a.stop) {
            budgetStop ??= a.stop;
            break;
          }
          if (a.wait) {
            // The room is held by reviews running now; one of them ends and gives back what it did not spend.
            if (running === 0) {
              budgetStop ??= { how: "budget", limit: "max-usd", limitKind: "hard", why: "hard cap --max-usd: the room left is held by another process's reservation" };
              break;
            }
            await new Promise((wake) => waiting.push(wake));
            continue;
          }
          ticket = a.review ?? null;
        }
        const { job } = queue.shift();
        running++;
        try {
          // Read again now: the attempt number is the next free folder at the time the job starts.
          await runJob(job, jobState(out, job).next, ticket);
        } finally {
          running--;
          ticket?.close?.();
          for (const wake of waiting.splice(0)) wake();
        }
        done++;
        log(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    const why = stopReason();
    const spent = budget ? (budgetStop ?? budget.stopped()) : null;
    const how = why !== null ? "stopped" : spent ? "budget" : "finished";
    const halt = how === "stopped" ? haltOf() : null;
    const ended = {
      at: new Date().toISOString(),
      how,
      why: why ?? spent?.why ?? null,
      ...(halt ? { halt } : {}),
      ...(how === "budget" ? { limit: spent.limit, limitKind: spent.limitKind } : {}),
      ...(budget ? budget.summary() : {}),
      reviewsWithAnAttempt: jobs.filter((j) => jobState(out, j).done).length,
      planned: jobs.length,
      elapsedMin: Math.round((Date.now() - started) / 600) / 100,
    };
    const more = finish();
    // A model refusal stops a run that finished; a halt or a budget stop keeps
    // its own reason, and the refusal is recorded beside it.
    const refused = Boolean(more.modelRefusal) && how === "finished";
    if (refused) { ended.how = "stopped"; ended.why = more.modelRefusal; }
    if (resume) {
      if (more.reviewers) writeFileSync(manifestPath, `${JSON.stringify({ ...readJsonFile(manifestPath), ...more, ...(refused ? { ended } : {}) }, null, 2)}\n`);
      appendFileSync(resumesPath, `${JSON.stringify({ event: "ended", ...ended, ...more })}\n`);
    }
    else writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...more, ended }, null, 2)}\n`);
    return { ended, ran: total };
  } finally {
    release();
  }
}

const readJsonLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// Why repeats cannot be added to the run in its folder: it must have ended
// finished (a stopped run is resumed first), and every job it planned must
// stay in the longer plan, unchanged.
function repeatsProblems(earlier, resumes, addRepeats, jobs) {
  const out = [];
  const last = [...resumes].reverse().find((r) => r.event === "ended") ?? earlier.ended;
  if (last?.how !== "finished") out.push(`the run ended "${last?.how ?? "never"}", not finished; resume it with --resume before adding repeats`);
  if (!Array.isArray(earlier.jobs)) out.push("the run's manifest lists no jobs, so the repeats it planned cannot be kept");
  else {
    const now = new Set(jobs.map((j) => j.jobId));
    const lost = earlier.jobs.filter((j) => !now.has(j.jobId));
    if (lost.length > 0) out.push(`the longer plan leaves out ${lost.length} reviews the run planned, such as ${lost[0].jobId}`);
  }
  if (!(addRepeats.repeat > (earlier.repeat ?? 0))) out.push(`the run has ${earlier.repeat} repeats; adding repeats must raise that`);
  return out;
}

export function attemptDir(out, job, attempt) {
  const base = join(out, "samples", job.case, job.config);
  return attempt === 1 ? join(base, String(job.repeat)) : join(base, `${job.repeat}-attempt${attempt}`);
}

// Why a review did not end complete, in one line, whether the reviewer itself
// failed (`infra`), and whether no reviewer could start at all. Null when it
// completed.
export function failureOf(result, report) {
  const missing = report?.completion?.missing ?? [];
  const reviewerFailed = missing.find((m) => REVIEWER_FAILED.test(m));
  if (!report) {
    const last = String(result.stderr ?? "").trim().split("\n").slice(-6).join(" | ");
    const unavailable = /Full review unavailable|could not start a reviewer/.test(result.stderr ?? "");
    return { cause: unavailable ? `no reviewer could start: ${last}` : `no report.json (exit ${result.code ?? result.signal}): ${last}`, infra: true, unavailable };
  }
  if (reviewerFailed) return { cause: reviewerFailed, infra: true, unavailable: false };
  if (report.completion?.status !== "complete") return { cause: missing.join("; ") || "incomplete", infra: false, unavailable: false };
  return null;
}

// Failure list: requested models replace served ones, mixed usage looks single,
// absent usage looks known, reviewer-written text supplies a model, and a
// review Claude Code never answered (a timeout, a stop) makes a run unknown.
export const CLAUDE_MODEL_FROM = "the usage record Claude Code returned for this review";

// A round Claude Code answered names its models; a round that failed before
// Claude Code's result names none. A review with no answered round is "none".
export function claudeModels(usage) {
  const calls = Array.isArray(usage?.calls) ? usage.calls : [];
  const names = (c) => (typeof c.model === "string" ? c.model.split(",").map((m) => m.trim()).filter(Boolean) : []);
  const models = [...new Set(calls.flatMap(names))].sort();
  const unknown = calls.some((c) => c.outcome !== "failed" && names(c).length === 0);
  const modelStatus = models.length > 1 ? "mixed" : unknown ? "unknown" : models.length === 1 ? "known" : "none";
  return { model: models.length > 1 ? models : modelStatus === "known" ? models[0] : null, models, modelFrom: CLAUDE_MODEL_FROM, modelStatus };
}

export function claudeRunModels(rows, requested = null, reviewer = "claude") {
  const samples = rows.filter((r) => r.reviewer === reviewer);
  const models = [...new Set(samples.flatMap((r) => Array.isArray(r.model) ? r.model : typeof r.model === "string" ? [r.model] : r.models ?? []))].sort();
  const unknown = models.length === 0 || samples.some((r) => r.modelFrom !== CLAUDE_MODEL_FROM || (r.modelStatus !== "none" && r.model == null));
  const why = models.length > 1 ? `Claude Code samples have mixed models: ${models.join(", ")}` : unknown ? "Claude Code samples have an unknown per-review model" : requested && models[0] !== requested ? `Claude Code requested model ${requested}, but samples were served by ${models[0]}` : null;
  return { model: models.length === 1 && !unknown ? models[0] : null, models, modelFrom: CLAUDE_MODEL_FROM, why };
}

// Reads sample.json rather than rows.jsonl, which a crash can leave behind.
export function savedSampleRows(out) {
  const rows = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name === "sample.json") rows.push(JSON.parse(readFileSync(path, "utf8")));
    }
  };
  walk(join(out, "samples"));
  return rows;
}

// The saved record of one attempt, whatever happened to it.
export function sampleRecord({ job, attempt, result, report, who, startedAt, failure, stopped, usageRecord = null }) {
  return {
    jobId: job.jobId ?? null,
    caseId: job.caseId ?? null,
    firstAttempt: attempt === 1,
    case: job.case,
    config: job.config,
    reviewer: job.reviewer,
    graph: job.graph ? "on" : "off",
    repeat: job.repeat,
    attempt,
    started_at: startedAt,
    exit: result.code ?? null,
    signal: result.signal ?? null,
    wallMs: result.wallMs ?? null,
    status: report ? (report.completion?.status ?? "unknown") : "failed",
    failure: failure?.cause ?? null,
    // Set when the run halted while this attempt ran: why it halted.
    stopped: stopped ?? null,
    verdict: report?.verdict ?? null,
    reviewerUsed: who ?? null,
    ...(job.reviewer === "claude" ? claudeModels(usageRecord) : {}),
    findings: report ? shownFindings(report).length : null,
    usage: report?.completion?.reviewer?.usage ?? null,
    reviewerMs: report?.completion?.reviewer?.duration_ms ?? null,
    rounds: report?.completion?.reviewer?.rounds ?? null,
    graphStatus: report?.impact?.status ?? null,
    graphMs: report?.impact?.build?.durationMs ?? null,
    scanners: scannerRows(report?.scanners ?? []),
    // The product's phase times, as report.json gives them.
    timings: report?.timings ?? null,
  };
}

// Each scanner of a scan as a sample records it: its status and version,
// its raw and kept counts, its time and the time to find its tool, the
// files it was handed, what each filter stage dropped, and, for semgrep,
// the rule packs it consumed.
export function scannerRows(list) {
  return list.map((s) => ({ scanner: s.scanner, status: s.status, version: s.version, raw: s.rawCount ?? null, kept: s.keptCount, ms: s.durationMs, resolveMs: s.resolveMs ?? null, files: s.files ?? null, stages: s.stages ?? null, ...(Array.isArray(s.rules) ? { rules: s.rules } : {}), reason: s.reason ?? null }));
}

// The saved record of one attempt of a scanner-only run: `scan` is the
// scan.json it wrote and `report` its report.json (null when it wrote
// none), `failure` why it wrote none.
export function scanSampleRecord({ job, attempt, result, scan, report, startedAt, failure, stopped }) {
  return {
    jobId: job.jobId ?? null,
    caseId: job.caseId ?? null,
    firstAttempt: attempt === 1,
    case: job.case,
    config: job.config,
    reviewer: null,
    graph: "off",
    repeat: job.repeat,
    attempt,
    started_at: startedAt,
    exit: result.code ?? null,
    signal: result.signal ?? null,
    wallMs: result.wallMs ?? null,
    status: scan ? "complete" : "failed",
    failure: failure?.cause ?? null,
    stopped: stopped ?? null,
    verdict: report?.verdict ?? null,
    candidates: scan ? scan.candidates.length : null,
    findings: report ? report.findings.length : null,
    timings: report?.timings ?? null,
    scanners: scannerRows(scan?.scanners ?? []),
  };
}

// Every setting of `now` that differs from the run being resumed.
export function resumeProblems(earlier, now) {
  const out = [];
  const same = (label, a, b) => {
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(`${label}: ${JSON.stringify(a ?? null)} then, now ${JSON.stringify(b ?? null)}`);
  };
  same("CLI bundle", earlier.build?.bundleHash ?? earlier.build?.bundleSha256, now.build?.bundleHash);
  same("machine", earlier.machine, now.machine);
  const names = [...new Set([...Object.keys(earlier.reviewers ?? {}), ...Object.keys(now.reviewers ?? {})])].sort();
  for (const n of names) {
    same(`${n} reviewer version`, earlier.reviewers?.[n]?.version, now.reviewers?.[n]?.version);
    const e = earlier.reviewers?.[n];
    const w = now.reviewers?.[n];
    // A model reviewer's `model` is the id that served the run's first
    // answered review, which a new invocation does not know yet; the model it
    // asks for is what must match. The served id is held by
    // lib/server-review.mjs recordServed.
    if (e?.kind === "model" || w?.kind === "model" || (["claude", "control"].includes(n) && e?.modelFrom === CLAUDE_MODEL_FROM)) same(`${n} requested model`, e?.requestedModel, w?.requestedModel);
    else same(`${n} model`, e?.model, w?.model);
    // A model reviewer's settings (effort, maxOutputTokens), the alias that
    // named it and the scripted model's script.
    same(`${n} settings`, e?.settings, w?.settings);
    same(`${n} alias`, e?.alias, w?.alias);
    same(`${n} script`, e?.script?.sha256, w?.script?.sha256);
    // The endpoint, as an HMAC-SHA256 of its base URL keyed with its key; the line names neither.
    if ((e?.endpoint ?? null) !== (w?.endpoint ?? null)) out.push(`${n}: the model endpoint differs from the run's: the settings file names another base URL or another key than when the run started`);
  }
  same("reviewer web access", earlier.review?.web, now.review?.web);
  same("review timeout in seconds", earlier.review?.timeoutSeconds, now.review?.timeoutSeconds);
  // The tools folder a model review reads its scanners from.
  same("install root", earlier.review?.installRoot, now.review?.installRoot);
  same("concurrency", earlier.concurrency, now.concurrency);
  // The cases' suite and where in it they come from; a run made before the
  // manifest named them is a planted run on the dev split.
  same("suite", earlier.suite ?? "planted", now.suite ?? "planted");
  same("split", earlier.split ?? "dev", now.split ?? "dev");
  same("split file hash", earlier.splitHash ?? null, now.splitHash ?? null);
  same("comparison release", earlier.release, now.release);
  same("subset", earlier.subset ?? null, now.subset ?? null);
  if (earlier.cases !== undefined || now.cases !== undefined) same("cases", earlier.cases, now.cases);
  if (earlier.configs !== undefined || now.configs !== undefined) same("configurations", earlier.configs, now.configs);
  if (earlier.repeat !== undefined || now.repeat !== undefined) same("repeats", earlier.repeat, now.repeat);
  // The per-review cap shapes what a review may finish; the run's own caps
  // and forecast stops may change on a resume, which is how a run stopped by
  // its budget is finished.
  if (earlier.budget !== undefined || now.budget !== undefined) same("--review-max-usd", earlier.budget?.hardCaps?.reviewMaxUsd, now.budget?.hardCaps?.reviewMaxUsd);
  if (earlier.scannersComplete !== undefined || now.scannersComplete !== undefined) {
    same("scanners complete", earlier.scannersComplete, now.scannersComplete);
    same("scanners missing", earlier.scannersMissing, now.scannersMissing);
  }
  if (earlier.changeId !== undefined || now.changeId !== undefined) same("change", earlier.changeId, now.changeId);
  // A smoke run stays one: it is never indexed, so a resume may not make it a full run.
  if (earlier.smoke !== undefined || now.smoke !== undefined) same("smoke", earlier.smoke ?? false, now.smoke ?? false);
  for (const c of Object.keys(now.caseHashes ?? {})) {
    if (earlier.caseHashes?.[c] !== now.caseHashes[c]) out.push(`case ${c}: its files or spec differ from the run's (or the run recorded no hash)`);
  }
  return out;
}

function gitOut(dir, args, env) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// The commit, the tree the work tree holds now (every file git sees, staged
// or not, untracked included, through a temporary index so the real one is
// not touched), the commit's own tree, and whether the two differ.
export function treeState(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  const temp = mkdtempSync(join(tmpdir(), "oq-bench-tree-"));
  const withIndex = { ...env, GIT_INDEX_FILE: join(temp, "index") };
  let tree;
  try {
    gitOut(dir, ["read-tree", "HEAD"], withIndex);
    gitOut(dir, ["add", "-A"], withIndex);
    tree = gitOut(dir, ["write-tree"], withIndex);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const commit = gitOut(dir, ["rev-parse", "HEAD"], env);
  const commitTree = gitOut(dir, ["rev-parse", "HEAD^{tree}"], env);
  return { commit, tree, commitTree, dirty: tree !== commitTree };
}

// One hash over everything the installed CLI runs from: the bundle and the
// assets copied beside it.
export const BUNDLE_PARTS = ["dist", "lenses", "wasm", "locks", "demo", "docs", "skills", "toolchain.json"];
export function bundleHash(cliDir) {
  const h = createHash("sha256");
  const add = (rel) => {
    const full = join(cliDir, rel);
    if (!existsSync(full)) return;
    for (const e of readdirSync(full, { withFileTypes: true, recursive: true }).filter((x) => x.isFile()).map((x) => join(x.parentPath, x.name)).sort()) {
      h.update(`\0${e.slice(cliDir.length)}\0`);
      h.update(readFileSync(e));
    }
  };
  for (const part of BUNDLE_PARTS) {
    const full = join(cliDir, part);
    if (part.endsWith(".json")) {
      if (existsSync(full)) {
        h.update(`\0/${part}\0`);
        h.update(readFileSync(full));
      }
    } else add(part);
  }
  return h.digest("hex");
}

// Why a run cannot trust the bundle it would start, if anything.
export function provenanceProblems(provenance, bundleNow) {
  if (!provenance) return ["no record of how the CLI was built; run node benchmark/build-cli.mjs, which builds it and records the commit and tree it was built from"];
  if (provenance.bundleHash !== bundleNow) return ["the CLI bundle is not the one benchmark/build-cli.mjs built (it was rebuilt or edited since); run node benchmark/build-cli.mjs again"];
  return [];
}

// Defined beside the Codex probe; here because the runner records it.
export { codexModelFrom } from "./reviewers.mjs";

// ---------- the scanner preflight ----------

// The doctor's report on one case repository, run with `env`.
function doctorReport(cli, name, dir, env) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [cli, "doctor", "--json", "--cwd", dir], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // The doctor exits 2 when git or the folder is wrong, after printing its report.
    stdout = error.stdout ?? "";
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`${name}: openqodex doctor --json gave no report to read the scanners from`);
  }
  if (!Array.isArray(report.selection)) throw new Error(`${name}: openqodex doctor could not say which scanners the case's files call for (${report.config ?? "no config line"})`);
  return report;
}

// Which scanners each case's repository calls for, and which of those this
// machine has not installed, as the real CLI's doctor reports them in that
// repository (failure 14). `repos`: [{ case, dir }], each a built case
// repository; `env`: the environment the reviews get, so the doctor reads
// the same tools folder. What a case calls for is read with offline mode
// off: a scanner its files call for that the reviews' offline mode
// (OPENQODEX_OFFLINE=1) switches off is missing too, with state "offline".
// Throws when the doctor gives no answer to read.
export function scannerPreflight({ cli, repos, env = process.env }) {
  const needed = {};
  const missing = [];
  const online = { ...env };
  delete online.OPENQODEX_OFFLINE;
  for (const { case: name, dir } of repos) {
    const report = doctorReport(cli, name, dir, online);
    needed[name] = report.selection.filter((s) => s.wanted).map((s) => s.scanner);
    const off = env.OPENQODEX_OFFLINE === "1" ? new Map(doctorReport(cli, name, dir, env).selection.filter((s) => !s.wanted && needed[name].includes(s.scanner)).map((s) => [s.scanner, s.line])) : new Map();
    for (const scanner of needed[name]) {
      const status = (report.scanners ?? []).find((s) => s.scanner === scanner);
      if (off.has(scanner)) missing.push({ case: name, scanner, state: "offline", detail: off.get(scanner) });
      else if (status?.state !== "ready") missing.push({ case: name, scanner, state: status?.state ?? "unknown", detail: status?.detail ?? null });
    }
  }
  return { complete: missing.length === 0, needed, missing };
}

const MISSING_WORDS = { needs_runtime: "is missing its runtime", will_install: "is not installed yet", offline: "offline mode switches off" };

// Why a run cannot start with the scanners this machine has; empty when it
// can, or when --allow-missing-scanners lets it go as incomplete.
export function preflightRefusals(preflight, { allowMissing }) {
  if (preflight.complete || allowMissing) return [];
  const lines = preflight.missing.map((m) => `${m.case} needs ${m.scanner}, which ${MISSING_WORDS[m.state] ?? `is ${m.state}`}${m.state === "needs_runtime" && m.detail ? ` (${m.detail})` : ""}`);
  return [...lines, "Install them first (node packages/cli/dist/bin.js doctor --install --all-scanners), or run with --allow-missing-scanners: the run then records scannersComplete false and is never accepted."];
}

// A path only where it stands whole, so /Users/s never matches inside
// /Users/sam. A dot after it ends a sentence unless a name follows it.
const NAME = "[\\p{L}\\p{N}_@+~-]";
const wholePath = (root) => new RegExp(`(?<!${NAME}|\\.)${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${NAME}|\\.${NAME})`, "gu");

// A row's reason fields can quote scanner paths. Replace the run root
// before home, since a run can live inside home. Count changed fields.
export function redactRowReasons(row, runRoot) {
  const replacements = [[resolve(runRoot), "<run>"], [homedir(), "<home>"]].filter(([root]) => root.length > 1).map(([root, placeholder]) => [wholePath(root), placeholder]);
  let count = 0;
  const reasons = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, text]) => {
      if (key !== "reason" || typeof text !== "string") return [key, visit(text)];
      let clean = text;
      for (const [pattern, placeholder] of replacements) clean = clean.replace(pattern, placeholder);
      if (clean !== text) {
        count++;
        reasons.set(text, clean);
      }
      return [key, clean];
    }));
  };
  const clean = visit(row);
  return { row: clean, count, reasons };
}

// Both copies of an attempt use the same redacted reasons. A null
// sampleDir appends the row only: the server path saves its own sample.json
// with every machine path replaced.
export function saveSampleRow(runRoot, sampleDir, row) {
  const clean = redactRowReasons(row, runRoot).row;
  if (sampleDir !== null) writeFileSync(join(sampleDir, "sample.json"), `${JSON.stringify(clean, null, 2)}\n`);
  appendFileSync(join(runRoot, "rows.jsonl"), `${JSON.stringify(clean)}\n`);
}
