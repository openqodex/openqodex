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
import { readFileSync } from "node:fs";
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

// A fake gh that answers the four reads and records every write. gh 2.105
// prints a log with colour codes only with --allow-escape-sequences
// ("new"); an older gh does not know that flag ("old").
function fakeGh(openIssues: { number: number; title: string }[], failedJobs: Job[], ghVersion: "new" | "old" = "new") {
  const writes: string[][] = [];
  const gh: Gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(openIssues);
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
    expect(body).toContain("**gate / Gate (ubuntu-latest)**\n- `packages/graph/src/frameworks/nest/nest.test.ts > the Nest plugin (5) > reads a route`\n- `tests/e2e/graph-truth.test.ts > trueforge > finds every route`");
    expect(body).toContain("**gate / Gate (macos-latest)**\n- no failing test in the log");
    expect(body).toContain("**gate / Scanner-only benchmark**\n- the log could not be read");
    expect(body).not.toContain(ESC);
  });

  it("reads the logs with a gh that refuses colour codes and with one that does not know the flag (failure 2)", () => {
    for (const version of ["new", "old"] as const) {
      const { gh, writes } = fakeGh([], [{ id: 1, name: "gate / Gate (ubuntu-latest)", log: e2eFail }], version);
      run("failure", gh);
      expect(writes[0][5], version).toContain("- `tests/e2e/graph-truth.test.ts > trueforge > finds every route`");
    }
  });

  it("comments on the open issue instead of opening a second one (failure 1)", () => {
    const { gh, writes } = fakeGh(
      [
        { number: 4, title: "Something else" },
        { number: 7, title: TITLE },
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
        { number: 4, title: `${TITLE} (old)` },
        { number: 7, title: TITLE },
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

type Workflow = { permissions?: Record<string, string>; jobs: Record<string, { if?: string; needs?: string[]; uses?: string; with?: Record<string, unknown>; permissions?: Record<string, string>; steps?: { uses?: string; with?: Record<string, string> }[] }> };
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
