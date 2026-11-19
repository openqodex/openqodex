// The full gate left the merge path on 2026-11-19: pull requests, the merge
// queue and pushes to main run the fast gate; the nightly run
// (.github/workflows/nightly.yml) runs the full gate on main and keeps one
// issue in step with it (scripts/nightly-issue.mjs); the release runs the
// full gate on the commit it publishes. gh is passed in to the script, so
// each test hands it what gh prints and reads what it was asked to do. The
// workflows' conditions are evaluated as GitHub reads them, for every
// result their jobs can end with.
//
// Ways it could fail, written before the code:
//  1. A failed night opens a second issue while one is open, so the issues
//     pile up.
//  2. The issue leaves out the failing tests, the commit or the run link; a
//     test name keeps the log's colours, timestamp or vitest project label.
//  3. A failed job whose log names no test (a setup step, a timeout) is left
//     out, so the issue reads as if nothing failed.
//  4. A green night leaves the issue open, or closes an issue with another
//     title.
//  5. A cancelled or skipped run opens, comments on or closes the issue.
//  6. The release publishes a commit whose full gate failed, was cancelled
//     or never ran; or a push that publishes nothing waits on the full gate.
//  7. A job other than the nightly report can write issues.
// Added after the review:
//  8. The script acts on an issue someone else opened with the same title
//     (the repository is public), instead of the Actions bot's own.
//  9. A job whose tests come after the cap on listed tests shows no line,
//     so it reads as if it passed.
// 10. A test name with backticks or an @mention breaks the issue's markdown
//     or pings someone.
// 11. A workflow runs scripts/gate.sh without --full for a purpose that
//     needs the real scanners: the pin bump's gate then skips the scanner
//     install, the end-to-end tests and the golden run, and its pull
//     request still says the gate passed.
// 12. main's merge queue lookup counts a run that failed, or a run of
//     another event, as the queue having tested the commit.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Gh = (args: string[]) => string;
type Options = { result: string; runId: string; sha: string; repo: string; server?: string; gh: Gh; log: (line: string) => void };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { report, failingTests, TITLE } = (await import(join(root, "scripts/nightly-issue.mjs"))) as {
  report: (o: Options) => number;
  failingTests: (log: string) => string[];
  TITLE: string;
};

const sha = "c".repeat(40);
const ESC = "\u001b";
// Two lines as a GitHub job log holds them: a timestamp, then vitest's
// coloured FAIL, its project label and the test (copied from run
// 44398758854, the Linux gate on main after pull request 369).
const unitFail = `2026-11-18T21:24:12.8532455Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${ESC}[30m${ESC}[42m unit ${ESC}[49m${ESC}[39m packages/graph/src/frameworks/nest/nest.test.ts${ESC}[2m > ${ESC}[22mthe Nest plugin (5)${ESC}[2m > ${ESC}[22mreads a route`;
const e2eFail = `2026-11-19T20:41:00.0000000Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m tests/e2e/graph-truth.test.ts${ESC}[2m > ${ESC}[22mtrueforge${ESC}[2m > ${ESC}[22mfinds every route`;

type Job = { id: number; name: string; log: string | Error };
// An open issue; bot says the Actions bot opened it, not a person.
type Issue = { number: number; title: string; bot?: boolean };

// A fake gh that answers the four reads and records every write. gh 2.105
// prints a log with colour codes only with --allow-escape-sequences
// ("new"); an older gh does not know that flag ("old"). Asked with
// --author app/github-actions, it lists only the bot's issues, as GitHub
// does.
function fakeGh(openIssues: Issue[], failedJobs: Job[], ghVersion: "new" | "old" = "new") {
  const writes: string[][] = [];
  const gh: Gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      const author = args[args.indexOf("--author") + 1];
      const listed = args.includes("--author") ? openIssues.filter((i) => author === "app/github-actions" && i.bot === true) : openIssues;
      return JSON.stringify(listed.map(({ number, title }) => ({ number, title })));
    }
    if (args[0] === "api" && args[1] === "--paginate") return failedJobs.map(({ id, name }) => JSON.stringify({ id, name })).join("\n") + "\n";
    if (args[0] === "api") {
      const flag = args.includes("--allow-escape-sequences");
      if (ghVersion === "new" && !flag) throw new Error("the response contains terminal escape sequences");
      if (ghVersion === "old" && flag) throw new Error("unknown flag: --allow-escape-sequences");
      const job = failedJobs.find((j) => args[1] === `repos/o/r/actions/jobs/${j.id}/logs`);
      if (job === undefined || job.log instanceof Error) throw job?.log ?? new Error("no such job");
      return job.log;
    }
    writes.push(args);
    return "";
  };
  return { gh, writes };
}

const run = (result: string, gh: Gh) => report({ result, runId: "99", sha, repo: "o/r", server: "https://github.com", gh, log: () => {} });

describe("the nightly issue", () => {
  it("reads each failing test once, without timestamps, colours or the project label (failure 2)", () => {
    // The last FAIL line is vitest's form without colours, as a terminal
    // that is not a TTY prints it.
    const plain = " FAIL  |unit| packages/cli/test/hook.test.ts > the push hook > blocks";
    expect(failingTests([unitFail, unitFail, e2eFail, "2026-11-19T20:41:01.0Z  ✓ tests/e2e/demo.test.ts (3 tests) 900ms", plain].join("\n"))).toEqual([
      "packages/graph/src/frameworks/nest/nest.test.ts > the Nest plugin (5) > reads a route",
      "tests/e2e/graph-truth.test.ts > trueforge > finds every route",
      "packages/cli/test/hook.test.ts > the push hook > blocks",
    ]);
  });

  it("opens one issue on a failure, with the commit, the run link and each failed job's tests (failures 2 and 3)", () => {
    const { gh, writes } = fakeGh(
      [{ number: 4, title: "Something else" }],
      [
        { id: 1, name: "gate / Gate (ubuntu-latest)", log: `${unitFail}\n${e2eFail}\n` },
        { id: 2, name: "gate / Gate (macos-latest)", log: "2026-11-19T20:41:00.0Z ##[error]The job running on runner X has exceeded the maximum execution time\n" },
        { id: 3, name: "gate / Scanner-only benchmark", log: new Error("HTTP 410") },
      ],
    );
    expect(run("failure", gh)).toBe(0);
    expect(writes).toHaveLength(1);
    const [create] = writes;
    expect(create.slice(0, 4)).toEqual(["issue", "create", "--title", TITLE]);
    const body = create[5];
    expect(body).toContain(sha);
    expect(body).toContain("https://github.com/o/r/actions/runs/99");
    expect(body).toContain("**gate / Gate (ubuntu-latest)**\n```text\npackages/graph/src/frameworks/nest/nest.test.ts > the Nest plugin (5) > reads a route\ntests/e2e/graph-truth.test.ts > trueforge > finds every route\n```");
    expect(body).toContain("**gate / Gate (macos-latest)**\n- no failing test in the log");
    expect(body).toContain("**gate / Scanner-only benchmark**\n- the log could not be read");
    expect(body).not.toContain(ESC);
  });

  it("reads the logs with a gh that refuses colour codes and with one that does not know the flag (failure 2)", () => {
    for (const version of ["new", "old"] as const) {
      const { gh, writes } = fakeGh([], [{ id: 1, name: "gate / Gate (ubuntu-latest)", log: e2eFail }], version);
      run("failure", gh);
      expect(writes[0][5], version).toContain("```text\ntests/e2e/graph-truth.test.ts > trueforge > finds every route\n```");
    }
  });

  it("comments on the open issue instead of opening a second one (failure 1)", () => {
    const { gh, writes } = fakeGh(
      [
        { number: 4, title: "Something else", bot: true },
        { number: 7, title: TITLE, bot: true },
      ],
      [{ id: 1, name: "gate / Gate (ubuntu-latest)", log: e2eFail }],
    );
    run("failure", gh);
    expect(writes.map((w) => w.slice(0, 3))).toEqual([["issue", "comment", "7"]]);
    expect(writes[0][4]).toContain("tests/e2e/graph-truth.test.ts > trueforge > finds every route");
  });

  it("closes the open issue on a green run, and touches no other issue (failure 4)", () => {
    const { gh, writes } = fakeGh(
      [
        { number: 4, title: `${TITLE} (old)`, bot: true },
        { number: 7, title: TITLE, bot: true },
      ],
      [],
    );
    run("success", gh);
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 4)).toEqual(["issue", "close", "7", "--comment"]);
    expect(writes[0][4]).toContain("https://github.com/o/r/actions/runs/99");
    const none = fakeGh([{ number: 4, title: `${TITLE} (old)` }], []);
    run("success", none.gh);
    expect(none.writes).toEqual([]);
  });

  it("acts only on the issues the Actions bot opened, with none, one or two open (failure 8)", () => {
    const failed = [{ id: 1, name: "gate / Gate (ubuntu-latest)", log: e2eFail }];
    // A person's issue with the same title: a failure opens the bot's own,
    // and a green run closes nothing.
    const person = { number: 3, title: TITLE };
    let fake = fakeGh([person], failed);
    run("failure", fake.gh);
    expect(fake.writes.map((w) => w.slice(0, 2))).toEqual([["issue", "create"]]);
    fake = fakeGh([person], []);
    run("success", fake.gh);
    expect(fake.writes).toEqual([]);
    // The person's and the bot's: only the bot's is commented on or closed.
    fake = fakeGh([person, { number: 7, title: TITLE, bot: true }], failed);
    run("failure", fake.gh);
    expect(fake.writes.map((w) => w.slice(0, 3))).toEqual([["issue", "comment", "7"]]);
    fake = fakeGh([person, { number: 7, title: TITLE, bot: true }], []);
    run("success", fake.gh);
    expect(fake.writes.map((w) => w.slice(0, 3))).toEqual([["issue", "close", "7"]]);
    // Two of the bot's: a failure comments on the older, a green run closes both.
    const two = [
      { number: 9, title: TITLE, bot: true },
      { number: 7, title: TITLE, bot: true },
    ];
    fake = fakeGh(two, failed);
    run("failure", fake.gh);
    expect(fake.writes.map((w) => w.slice(0, 3))).toEqual([["issue", "comment", "7"]]);
    fake = fakeGh(two, []);
    run("success", fake.gh);
    expect(fake.writes.map((w) => w.slice(0, 3))).toEqual([
      ["issue", "close", "7"],
      ["issue", "close", "9"],
    ]);
  });

  it("names every failed job and counts the tests past the cap (failure 9)", () => {
    const many = Array.from({ length: 50 }, (_, i) => ` FAIL  tests/e2e/many.test.ts > case ${i}`).join("\n");
    const three = Array.from({ length: 3 }, (_, i) => ` FAIL  tests/e2e/late.test.ts > case ${i}`).join("\n");
    const { gh, writes } = fakeGh(
      [],
      [
        { id: 1, name: "gate / Gate (ubuntu-latest)", log: many },
        { id: 2, name: "gate / Gate (macos-latest)", log: three },
      ],
    );
    run("failure", gh);
    const body = writes[0][5];
    expect(body).toContain("tests/e2e/many.test.ts > case 49");
    expect(body).toContain("**gate / Gate (macos-latest)**\n- 3 more failing tests in this job; the run lists them");
  });

  it("puts test names in a code block that their backticks cannot close (failure 10)", () => {
    const name = "tests/e2e/x.test.ts > says ```hi``` to @octocat";
    const { gh, writes } = fakeGh([], [{ id: 1, name: "gate / Gate (ubuntu-latest)", log: ` FAIL  ${name}` }]);
    run("failure", gh);
    const lines = writes[0][5].split("\n");
    const at = lines.indexOf(name);
    expect(at).toBeGreaterThan(0);
    // The fence above and below is longer than any run of backticks inside.
    expect(lines[at - 1]).toBe("````text");
    expect(lines[at + 1]).toBe("````");
    expect(lines.filter((l) => l.includes("@octocat"))).toEqual([name]);
  });

  it("changes nothing on a cancelled, skipped or empty result (failure 5)", () => {
    for (const result of ["cancelled", "skipped", ""]) {
      const calls: string[][] = [];
      run(result, (args) => {
        calls.push(args);
        return "[]";
      });
      expect(calls, result).toEqual([]);
    }
  });
});

type Workflow = { permissions?: Record<string, string>; jobs: Record<string, { if?: string; needs?: string[]; uses?: string; with?: Record<string, unknown>; permissions?: Record<string, string>; steps?: { uses?: string; run?: string; with?: Record<string, string> }[] }> };
const workflow = (name: string) => parse(readFileSync(join(root, ".github", "workflows", name), "utf8")) as Workflow;
const inner = (value: string) => /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value)?.[1] ?? value;
// A GitHub expression of the shapes these workflows use (&&, ||, ==, !=,
// !, quoted strings, cancelled()) evaluated with JavaScript's operators,
// which read them the same way for these lowercase values.
function evaluate(expression: string, needs: Record<string, { result: string; outputs?: Record<string, string> }>) {
  const js = inner(expression).replace(/needs\.([\w-]+)/g, 'needs["$1"]');
  const fn = new Function("github", "needs", "cancelled", `return (${js});`) as (...a: unknown[]) => unknown;
  return fn({ repository: "openqodex/openqodex" }, needs, () => false);
}

describe("the release and the full gate", () => {
  const release = workflow("release.yml");
  const job = release.jobs.release;
  const publishInput = job.steps?.find((s) => s.uses?.startsWith("changesets/action@"))?.with?.publish ?? "";
  const results = ["success", "failure", "cancelled", "skipped"];

  it("publishes only after this commit's full gate passed, and a push that publishes nothing does not wait on it (failure 6)", () => {
    const gate = release.jobs["full-gate"];
    expect(gate.uses).toBe("./.github/workflows/ci.yml");
    expect(gate.with?.full).toBe(true);
    expect(evaluate(gate.if ?? "", { plan: { result: "success", outputs: { publish: "true" } } })).toBe(true);
    expect(evaluate(gate.if ?? "", { plan: { result: "success", outputs: { publish: "false" } } })).toBe(false);
    for (const publish of ["true", "false"]) {
      for (const gateResult of results) {
        const needs = {
          plan: { result: "success", outputs: { publish } },
          "release-check": { result: "success" },
          "ci-passed": { result: "success" },
          "full-gate": { result: gateResult },
        };
        const runs = evaluate(job.if ?? "", needs) === true;
        const publishes = runs && evaluate(publishInput, needs) !== "";
        // The release job runs when the gate it needs is in the state this
        // push needs: passed for a publish, skipped otherwise.
        expect(runs, `publish ${publish}, full gate ${gateResult}`).toBe(publish === "true" ? gateResult === "success" : gateResult === "skipped");
        expect(publishes, `publish ${publish}, full gate ${gateResult}`).toBe(publish === "true" && gateResult === "success");
      }
    }
  });

  it("does not run when the plan, the release check or main's CI check did not pass (failure 6)", () => {
    for (const failed of ["plan", "release-check", "ci-passed"]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const needs: Record<string, { result: string; outputs?: Record<string, string> }> = {
          plan: { result: "success", outputs: { publish: "true" } },
          "release-check": { result: "success" },
          "ci-passed": { result: "success" },
          "full-gate": { result: "success" },
        };
        needs[failed] = { ...needs[failed], result };
        expect(evaluate(job.if ?? "", needs), `${failed} ${result}`).toBe(false);
      }
    }
  });

  it("runs scripts/gate.sh with --full in every workflow (failure 11)", () => {
    const calls: string[] = [];
    for (const name of readdirSync(join(root, ".github", "workflows")).filter((f) => f.endsWith(".yml"))) {
      for (const [id, j] of Object.entries(workflow(name).jobs)) {
        for (const step of j.steps ?? []) {
          for (const line of (step.run ?? "").split("\n")) if (/scripts\/gate\.sh\b/.test(line)) calls.push(`${name} ${id}: ${line.trim()}`);
        }
      }
    }
    expect(calls).toEqual(["pin-bump.yml gate: bash scripts/gate.sh --full"]);
  });

  it("skips main's gate only on a passed merge queue run of ci.yml on this very commit (failure 12)", () => {
    const run = workflow("ci.yml").jobs["queue-tested"].steps?.[0]?.run ?? "";
    const command = /gh run list (.*?) \|\|/.exec(run)?.[1] ?? "";
    // Words as the shell splits them: a double-quoted word may hold \".
    const words = command.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
    const flag = (name: string) => words[words.indexOf(name) + 1];
    expect(flag("--workflow")).toBe("ci.yml");
    expect(flag("--event")).toBe("merge_group");
    expect(flag("--status")).toBe("success");
    expect(flag("--commit")).toBe('"$GITHUB_SHA"');
    expect(flag("--jq")).toBe('"map(select(.headSha == \\"$GITHUB_SHA\\")) | length"');
    expect(run).toContain('if [ "$found" -gt 0 ] 2>/dev/null; then tested=true; else tested=false; fi');
  });

  it("gives issue write to the nightly report job alone (failure 7)", () => {
    const writers: string[] = [];
    for (const name of ["ci.yml", "nightly.yml", "release.yml"]) {
      const w = workflow(name);
      if (Object.values(w.permissions ?? {}).includes("write")) writers.push(`${name} (top level)`);
      for (const [id, j] of Object.entries(w.jobs)) if (j.permissions?.issues === "write") writers.push(`${name} ${id}`);
    }
    expect(writers).toEqual(["nightly.yml report"]);
    const nightly = workflow("nightly.yml");
    expect(nightly.jobs.gate.uses).toBe("./.github/workflows/ci.yml");
    expect(nightly.jobs.gate.with?.full).toBe(true);
    expect(nightly.jobs.report.needs).toBe("gate");
  });
});
