#!/usr/bin/env node
// The ReviewBench entrypoint: one pull request per container, as their agent
// contract (AGENT_CONTRACT.md in review-bench/ReviewBench) gives it. The
// clone is at RB_REPO (default /work/repo), checked out at RB_HEAD with
// RB_BASE reachable; the findings file goes to RB_OUT. It runs
// `openqodex review --base RB_BASE` as a developer runs it, with Claude Code
// as the reviewer, then writes every finding the report shows.
//
//   RB_CONFIG_MODEL      the Claude model (default claude-opus-5-5), passed
//                        as ANTHROPIC_MODEL, which the reviewer reads
//   RB_MODEL_BASE_URL    the model API, passed as ANTHROPIC_BASE_URL
//   ANTHROPIC_API_KEY    the key, handed in by ReviewBench
//   RB_ATTEMPT           the attempt number, from 1
//   OPENQODEX_CLI        the CLI to run (tests); default the image's package
//
// Started as root (the image's user), it reviews as the node user and only
// writes the findings file as root, since another user may own the folders
// ReviewBench mounts. The review writes into the clone's .git (a work tree),
// so it reviews a shared clone in a temp folder its user owns, which reads
// the mounted clone's objects in place; the mounted clone is never written.
// It calls no GitHub API. The reviewer reaches the model's host; semgrep and
// osv-scanner reach theirs when ReviewBench allows them, else they fail alone.
//
// Exit 0 with a findings file, or non-zero with none, which ReviewBench
// retries. Every review that does not finish (the deadline stopped it with
// no report, openqodex exited outside 0, 1 and 2, the reviewer never
// answered, it answered and ended incomplete, or a file it wrote was
// refused) fails the first attempt
// and is written empty from the second, so one pull request the review
// cannot finish costs that pull request, not the whole run.
// The failure list is in benchmark/test/reviewbench-entry.test.mjs.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chownSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL = "claude-opus-5-5";
// The manifest asks for 3600 s per pull request. The reviewer gets 2700 s;
// the whole review is asked to stop at 3300 s and killed 30 s later, so this
// process always ends first.
const REVIEW_TIMEOUT_SECONDS = 2700;
const REVIEW_DEADLINE_MS = 3300_000;
const STOP_GRACE_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;

/** The contract's inputs from the environment; throws naming the first that is wrong. */
export function readContract(env = process.env) {
  const need = (name) => {
    const value = env[name];
    if (value === undefined || value.trim() === "") throw new Error(`${name} is not set`);
    return value.trim();
  };
  const out = need("RB_OUT");
  if (!isAbsolute(out)) throw new Error(`RB_OUT must be an absolute path, not ${out}`);
  const head = need("RB_HEAD");
  const base = need("RB_BASE");
  if (!SHA.test(head)) throw new Error(`RB_HEAD must be a 40-character commit sha, not ${head}`);
  if (!SHA.test(base)) throw new Error(`RB_BASE must be a 40-character commit sha, not ${base}`);
  const number = need("RB_PR_NUMBER");
  if (!/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error(`RB_PR_NUMBER must be a pull request number, not ${number}`);
  const nwo = need("RB_NWO");
  if (!/^[^/\s]+\/[^/\s]+$/.test(nwo)) throw new Error(`RB_NWO must be owner/repo, not ${nwo}`);
  const attempt = Number(env.RB_ATTEMPT ?? "1");
  return {
    out,
    head,
    base,
    prNumber: Number(number),
    nwo,
    agent: need("RB_AGENT"),
    repoDir: resolve(env.RB_REPO?.trim() || "/work/repo"),
    prJson: env.RB_PR_JSON?.trim() || "/work/pr/pr.json",
    model: env.RB_CONFIG_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: env.RB_MODEL_BASE_URL?.trim() || null,
    attempt: Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1,
  };
}

const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** One finding's message: "{title}. {problem} {consequence} Fix: {fix}", leaving out what it lacks. */
export function messageOf(f) {
  const title = flat(f.title);
  const fix = flat(f.fix ?? f.suggested_change);
  const parts = [title === "" || /[.!?]$/.test(title) ? title : `${title}.`, flat(f.problem ?? f.description), flat(f.consequence), fix === "" ? "" : `Fix: ${fix}`];
  return parts.filter((p) => p !== "").join(" ");
}

// The checks ReviewBench's validator applies to one finding
// (scripts/harbor/verify.ts validateCandidate): one that fails them fails the
// whole pull request, so it is left out here instead.
function valid(f) {
  return f.file !== "" && !f.file.includes("\\") && !f.file.includes(":") &&
    f.file.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    Number.isSafeInteger(f.start_line) && Number.isSafeInteger(f.end_line) &&
    f.start_line >= 1 && f.end_line >= f.start_line && f.message !== "" && f.producer !== "";
}

/**
 * Every finding report.json shows the developer, in ReviewBench's shape:
 * findings, outside-change findings that are not scanner output,
 * observations and possible findings (benchmark/lib/score.mjs
 * shownFindings, the set the Martian conversion sends too). Returns
 * { findings, dropped }: dropped counts the ones the validator would refuse.
 */
export function findingsOf(report, agent) {
  const outside = (report.outside_change ?? []).filter((f) => f.origin !== "scanner");
  const shown = [...(report.findings ?? []), ...outside, ...(report.observations ?? []), ...(report.possible ?? [])];
  const seen = new Set();
  const findings = [];
  let dropped = 0;
  for (const f of shown) {
    const start = Number.isSafeInteger(f.line_number) && f.line_number >= 1 ? f.line_number : 1;
    const end = Number.isSafeInteger(f.line_end) && f.line_end >= start ? f.line_end : start;
    const finding = { file: String(f.file_path ?? "").replace(/^(\.\/)+/, ""), start_line: start, end_line: end, message: messageOf(f), producer: agent };
    if (!valid(finding)) {
      dropped++;
      continue;
    }
    const key = JSON.stringify(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  return { findings, dropped };
}

/** The findings file: pr.head and pr.pr_number are RB_HEAD and RB_PR_NUMBER, or ReviewBench fails the pull request. */
export function outputOf(contract, pr, findings) {
  const repo = typeof pr?.repo === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(pr.repo) ? pr.repo : `https://github.com/${contract.nwo}`;
  return { pr: { repo, pr_number: contract.prNumber, base: contract.base, head: contract.head }, agent: contract.agent, findings };
}

/**
 * What to do with a finished review: { write: findings[] } or { fail: reason }.
 * `code` is the CLI's exit code (null when it was stopped), `report` its
 * report.json or null, `usage` its usage.json or null, and `refused` why one
 * of those files was not read (readReviewFile), or null.
 */
export function decide({ code, report, usage, attempt, agent, refused = null }) {
  // A failure ReviewBench retries: the first attempt fails so a retry happens;
  // from the second the pull request is written with no finding, because one
  // pull request that never succeeds fails the whole run.
  const failing = (reason) => (attempt < 2 ? { fail: reason } : { write: [], note: `${reason}; written with no finding on attempt ${attempt}` });
  if (refused) return failing(`the review's files were refused: ${refused}`);
  if (code === 0 && report === null) return { write: [], note: "nothing to review: the change has no file the review reads" };
  if (report === null) return failing(code === null ? "the review was stopped at its deadline and wrote no report" : `openqodex exited ${code} and wrote no report`);
  if (code !== 0 && code !== 1 && code !== 2) return failing(`openqodex exited ${code}`);
  const status = report.completion?.status ?? null;
  if (status === "complete") {
    const { findings, dropped } = findingsOf(report, agent);
    return { write: findings, note: dropped > 0 ? `${dropped} finding(s) left out: their path or lines are not ones ReviewBench accepts` : null };
  }
  const missing = (report.completion?.missing ?? []).slice(0, 3).join("; ") || "no completion record";
  const answered = (usage?.calls ?? []).some((c) => c.outcome === "ok");
  if (!answered) return failing(`the reviewer never answered: ${missing}`);
  if (attempt < 2) return { fail: `the review ended incomplete, so it holds no finding: ${missing}` };
  return { write: [], note: `the review ended incomplete again on attempt ${attempt}; written with no finding: ${missing}` };
}

// The node user's ids and home, from /etc/passwd.
function nodeUser() {
  const line = readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith("node:"));
  if (!line) throw new Error("the image has no node user to review as");
  const [, , uid, gid, , home] = line.split(":");
  return { uid: Number(uid), gid: Number(gid), home };
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

/**
 * One file the review wrote: null when it is absent, else { json } or
 * { refused: reason }. The review reads an untrusted pull request in a folder
 * its user owns, so it could plant a link, a pipe or another user's file
 * there for root to read. Only a regular file owned by `uid` is read: it is
 * opened without following a link, and the opened file itself is checked.
 */
export function readReviewFile(file, uid) {
  const name = basename(file);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { refused: error.code === "ELOOP" ? `${name} is a symbolic link` : `${name} could not be opened (${error.code ?? error.message})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { refused: `${name} is not a regular file` };
    if (stat.uid !== uid) return { refused: `${name} is owned by uid ${stat.uid}, not the review's user ${uid}` };
    return { json: JSON.parse(readFileSync(fd, "utf8")) };
  } catch (error) {
    return { refused: `${name} could not be read as JSON (${error.message})` };
  } finally {
    closeSync(fd);
  }
}

function cliPath(env) {
  if (env.OPENQODEX_CLI) return resolve(env.OPENQODEX_CLI);
  const pkg = createRequire(import.meta.url).resolve("openqodex/package.json");
  const bin = JSON.parse(readFileSync(pkg, "utf8")).bin;
  return join(dirname(pkg), typeof bin === "string" ? bin : bin.openqodex);
}

/**
 * Runs the review and resolves with its exit code, or null when the
 * deadline stopped it. The child leads a process group of its own. The
 * reviewer leads another group, which only openqodex stops: at the
 * deadline the group gets SIGTERM, on which openqodex stops its reviewer
 * and exits, and SIGKILL `graceMs` later. The group is also killed when
 * the review ends, so no process of it is left to change the files root
 * reads next.
 */
export function runReview(command, args, options, { deadlineMs = REVIEW_DEADLINE_MS, graceMs = STOP_GRACE_MS } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "inherit", "inherit"] });
    let stopped = false;
    let kill = null;
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      stopped = true;
      signalGroup("SIGTERM");
      kill = setTimeout(() => signalGroup("SIGKILL"), graceMs);
    }, deadlineMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(kill);
      console.error(`openqodex-reviewbench: could not start openqodex: ${error.message}`);
      done(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(kill);
      signalGroup("SIGKILL");
      done(stopped ? null : code);
    });
  });
}

/**
 * Writes the findings file as root through a temporary file beside it,
 * created new (wx): a link or file planted at that name is refused, never
 * followed or overwritten.
 */
export function writeFindingsFile(out, doc, pid = process.pid) {
  const tmp = `${out}.tmp-${pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, out);
}

async function main(env = process.env) {
  const contract = readContract(env);
  const at = execFileSync("git", ["-C", contract.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (at !== contract.head) throw new Error(`the checkout at ${contract.repoDir} is at ${at}, not RB_HEAD ${contract.head}`);
  const pr = readJson(contract.prJson);
  const cli = cliPath(env);
  const version = JSON.parse(readFileSync(join(dirname(cli), "..", "package.json"), "utf8")).version;
  console.error(`openqodex-reviewbench: model=${contract.model} reviewer=claude openqodex=${version} attempt=${contract.attempt}`);

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const user = root ? nodeUser() : null;
  const work = mkdtempSync(join(tmpdir(), "rb-work-"));
  const repo = join(work, "repo");
  const reportDir = join(work, "report");
  mkdirSync(reportDir);
  if (user) for (const dir of [work, reportDir]) chownSync(dir, user.uid, user.gid);
  const childEnv = { ...env, GIT_LFS_SKIP_SMUDGE: "1", ANTHROPIC_MODEL: contract.model, ...(contract.baseUrl ? { ANTHROPIC_BASE_URL: contract.baseUrl } : {}), ...(user ? { HOME: user.home, USER: "node", LOGNAME: "node" } : {}) };
  const as = { env: childEnv, ...(user ? { uid: user.uid, gid: user.gid } : {}) };
  const cloned = Date.now();
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", contract.repoDir, repo], { ...as, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("git", ["-C", repo, "checkout", "--quiet", "--detach", contract.head], { ...as, stdio: ["ignore", "ignore", "inherit"] });
  console.error(`openqodex-reviewbench: shared clone at ${contract.head.slice(0, 12)} in ${Math.round((Date.now() - cloned) / 1000)} s`);
  const args = [cli, "review", "--cwd", repo, "--base", contract.base, "--reviewer", "claude", "--reviewer-web", "off", "--report-dir", reportDir, "--timeout", String(REVIEW_TIMEOUT_SECONDS), "--no-install", "--no-color"];
  const started = Date.now();
  const code = await runReview(process.execPath, args, as);
  const reviewUid = user ? user.uid : process.getuid();
  const reportRead = readReviewFile(join(reportDir, "report.json"), reviewUid);
  const usageRead = readReviewFile(join(reportDir, "usage.json"), reviewUid);
  const report = reportRead?.json ?? null;
  const usage = usageRead?.json ?? null;
  const served = [...new Set((usage?.calls ?? []).map((c) => c.model).filter((m) => typeof m === "string" && m !== ""))];
  console.error(`openqodex-reviewbench: review exited ${code} after ${Math.round((Date.now() - started) / 1000)} s; served models: ${served.join(", ") || "none named"}; report timings: ${JSON.stringify(report?.timings ?? null)}`);
  // Removed as the review's user, so a link planted in it never leads root
  // to delete anything else.
  spawnSync("rm", ["-rf", work], { stdio: "ignore", ...(user ? { uid: user.uid, gid: user.gid } : {}) });
  const refused = reportRead?.refused ?? usageRead?.refused ?? null;

  // A refused file is never read: its pull request fails as any review
  // that did not finish, and from the second attempt is written empty.
  const decision = decide({ code, report: refused ? null : report, usage: refused ? null : usage, attempt: contract.attempt, agent: contract.agent, refused });
  if (decision.fail) throw new Error(decision.fail);
  if (decision.note) console.error(`openqodex-reviewbench: ${decision.note}`);
  const doc = outputOf(contract, pr, decision.write);
  writeFindingsFile(contract.out, doc);
  console.error(`openqodex-reviewbench: wrote ${doc.findings.length} finding(s) to ${contract.out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`openqodex-reviewbench: failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
