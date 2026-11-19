// Keeps one GitHub issue in step with the nightly full gate on main
// (.github/workflows/nightly.yml). After the gate, given its result:
// - success: comments on the open issue with the green run and closes it;
// - anything else (failure, cancelled, abandoned, skipped, no result):
//   opens the issue, or comments on the open one, with the commit, the run
//   link and each job that did not pass. A gate that did not finish proves
//   nothing, so it never counts as green: on 2026-11-19 the first run
//   (44563238218) ended "abandoned" because GitHub gave its macOS job no
//   runner, and the night had no full gate.
// The issue is an open one the Actions bot opened (gh's --author
// app/github-actions) whose title is exactly TITLE: the repository is
// public, so anyone can open an issue with that title, and the script never
// acts on theirs. With two of the bot's open, a failure comments on the
// older and a green run closes both. A job is listed when it ended other
// than success or skipped (a job still running has no conclusion yet: the
// report job itself). The failing tests are read from its log: the lines
// vitest starts with FAIL. Each listed job shows its name and conclusion,
// its tests in a code block (a test name's backticks or @mention cannot
// break the markdown or ping anyone) and a count of those past the cap;
// when its log names no test, GitHub's failure notes on its check run
// (such as "The job was not acquired by Runner of type hosted") in a code
// block too.
// Usage: node scripts/nightly-issue.mjs
//   (RESULT, RUN_ID and SHA from the workflow; gh reads GH_TOKEN and GH_REPO)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TITLE = "Nightly full gate fails on main";
// Tests past this many, over the whole issue, are counted per job, not listed.
const MAX_TESTS = 50;

// Runs gh and returns its stdout; the test passes its own in place of it.
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
}

// The failing tests a job log names, in order, each once: the log's
// timestamps and colours removed, and the vitest project label too.
export function failingTests(log) {
  const tests = [];
  for (const raw of log.split("\n")) {
    const line = raw
      .replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .trimEnd();
    const m = /^\s*FAIL\s+(?:\S+\s+)?(\S+\.test\.[cm]?[jt]s(?:\s>\s.*)?)$/.exec(line);
    if (m && !tests.includes(m[1])) tests.push(m[1]);
  }
  return tests;
}

// A job log's failing tests, or null when gh cannot read it. gh 2.105
// refuses to print a log's colour codes without --allow-escape-sequences;
// a gh older than that flag refuses the flag, so it is asked again without.
function readLog(gh, path) {
  for (const args of [["api", path, "--allow-escape-sequences"], ["api", path]]) {
    try {
      return failingTests(gh(args));
    } catch {
      // the next form, or null below
    }
  }
  return null;
}

// A fenced code block that no run of backticks in the lines can close.
function codeBlock(lines) {
  const longest = Math.max(0, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, ...lines, fence];
}

// GitHub's failure notes on a job's check run, or none when they cannot be
// read. A job's id is its check run's id.
function readNotes(gh, repo, id) {
  try {
    return JSON.parse(gh(["api", `repos/${repo}/check-runs/${id}/annotations`]))
      .filter((a) => a.annotation_level === "failure")
      .map((a) => String(a.message).split("\n")[0])
      .slice(0, 5);
  } catch {
    return [];
  }
}

function failureBody({ result, sha, url, jobs }) {
  const lines = [`The nightly full gate did not pass on \`main\` at ${sha}: it ended ${result || "with no result"}.`, "", `Run: ${url}`, ""];
  let room = MAX_TESTS;
  for (const job of jobs) {
    lines.push(`**${job.name}** (${job.conclusion})`);
    if (job.tests === null) lines.push("- the log could not be read; open the run");
    else if (job.tests.length === 0) lines.push("- no failing test in the log: a step before or after the tests failed; open the run");
    if (job.notes.length > 0) lines.push(...codeBlock(job.notes));
    if (job.tests !== null && job.tests.length > 0) {
      const shown = job.tests.slice(0, room);
      room -= shown.length;
      if (shown.length > 0) lines.push(...codeBlock(shown));
      const rest = job.tests.length - shown.length;
      if (rest > 0) lines.push(`- ${rest} more failing tests in this job; the run lists them`);
    }
    lines.push("");
  }
  if (jobs.length === 0) lines.push("No job ended other than success or skipped; open the run.", "");
  lines.push("The next green nightly run closes this issue.");
  return lines.join("\n");
}

export function report({ result, runId, sha, repo, server = "https://github.com", gh = runGh, log = (line) => console.log(line) }) {
  const url = `${server}/${repo}/actions/runs/${runId}`;
  const ours = JSON.parse(gh(["issue", "list", "--state", "open", "--author", "app/github-actions", "--limit", "1000", "--json", "number,title"]))
    .filter((i) => i.title === TITLE)
    .sort((a, b) => a.number - b.number);
  if (result === "success") {
    if (ours.length === 0) log("the full gate passed and no issue is open");
    for (const issue of ours) {
      gh(["issue", "close", String(issue.number), "--comment", `The nightly full gate passed on \`main\` at ${sha}: ${url}`]);
      log(`the full gate passed; issue ${issue.number} closed`);
    }
    return 0;
  }
  const open = ours[0];
  // One JSON object per job of this run, the reusable workflow's jobs
  // among them; those that did not pass are listed.
  const listed = gh(["api", "--paginate", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, "--jq", ".jobs[] | {id, name, conclusion}"]);
  const jobs = listed
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter(({ conclusion }) => conclusion !== null && conclusion !== "success" && conclusion !== "skipped")
    .map(({ id, name, conclusion }) => {
      const tests = readLog(gh, `repos/${repo}/actions/jobs/${id}/logs`);
      return { name, conclusion, tests, notes: tests === null || tests.length === 0 ? readNotes(gh, repo, id) : [] };
    });
  const body = failureBody({ result, sha, url, jobs });
  if (open === undefined) {
    gh(["issue", "create", "--title", TITLE, "--body", body]);
    log(`the full gate ended ${result || "with no result"}; issue opened`);
  } else {
    gh(["issue", "comment", String(open.number), "--body", body]);
    log(`the full gate ended ${result || "with no result"}; issue ${open.number} commented`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { RESULT, RUN_ID, SHA, GH_REPO, GITHUB_SERVER_URL } = process.env;
  process.exitCode = report({ result: RESULT, runId: RUN_ID, sha: SHA, repo: GH_REPO, server: GITHUB_SERVER_URL });
}
