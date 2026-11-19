// Keeps one GitHub issue in step with the nightly full gate on main
// (.github/workflows/nightly.yml). After the gate, given its result:
// - failure: opens the issue, or comments on the open one, with the commit,
//   the run link and the tests that failed, job by job;
// - success: comments on the open issue with the green run and closes it;
// - anything else (cancelled, skipped): changes nothing.
// The issue is the open one whose title is exactly TITLE. The failing tests
// are read from the failed jobs' logs: the lines vitest starts with FAIL. A
// failed job whose log names no test (a setup step, a timeout) is listed by
// its name, so the issue never reads as if nothing failed.
// Usage: node scripts/nightly-issue.mjs
//   (RESULT, RUN_ID and SHA from the workflow; gh reads GH_TOKEN and GH_REPO)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TITLE = "Nightly full gate fails on main";
// A failure list longer than this is cut, with a count of the rest.
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

function failureBody({ sha, url, jobs }) {
  const lines = [`The nightly full gate failed on \`main\` at ${sha}.`, "", `Run: ${url}`, ""];
  let shown = 0;
  let cut = 0;
  for (const job of jobs) {
    lines.push(`**${job.name}**`);
    if (job.tests === null) lines.push("- the log could not be read; open the run");
    else if (job.tests.length === 0) lines.push("- no failing test in the log: a step before or after the tests failed; open the run");
    for (const test of job.tests ?? []) {
      if (shown < MAX_TESTS) {
        lines.push(`- \`${test}\``);
        shown++;
      } else cut++;
    }
    lines.push("");
  }
  if (cut > 0) lines.push(`And ${cut} more failing tests; the run lists them all.`, "");
  if (jobs.length === 0) lines.push("No job is marked failed; open the run.", "");
  lines.push("The next green nightly run closes this issue.");
  return lines.join("\n");
}

export function report({ result, runId, sha, repo, server = "https://github.com", gh = runGh, log = (line) => console.log(line) }) {
  if (result !== "success" && result !== "failure") {
    log(`the full gate ended ${result || "with no result"}; the issue is left as it is`);
    return 0;
  }
  const url = `${server}/${repo}/actions/runs/${runId}`;
  const open = JSON.parse(gh(["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title"])).find((i) => i.title === TITLE);
  if (result === "success") {
    if (open === undefined) {
      log("the full gate passed and no issue is open");
      return 0;
    }
    gh(["issue", "close", String(open.number), "--comment", `The nightly full gate passed on \`main\` at ${sha}: ${url}`]);
    log(`the full gate passed; issue ${open.number} closed`);
    return 0;
  }
  // One JSON object per failed job of this run, the reusable workflow's
  // jobs among them.
  const listed = gh(["api", "--paginate", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, "--jq", '.jobs[] | select(.conclusion == "failure") | {id, name}']);
  const jobs = listed
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .map(({ id, name }) => ({ name, tests: readLog(gh, `repos/${repo}/actions/jobs/${id}/logs`) }));
  const body = failureBody({ sha, url, jobs });
  if (open === undefined) {
    gh(["issue", "create", "--title", TITLE, "--body", body]);
    log("the full gate failed; issue opened");
  } else {
    gh(["issue", "comment", String(open.number), "--body", body]);
    log(`the full gate failed; issue ${open.number} commented`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { RESULT, RUN_ID, SHA, GH_REPO, GITHUB_SERVER_URL } = process.env;
  process.exitCode = report({ result: RESULT, runId: RUN_ID, sha: SHA, repo: GH_REPO, server: GITHUB_SERVER_URL });
}
