// The release waits for the CI run of the commit it releases
// (scripts/release-ci-check.mjs). gh is passed in, so each test hands it the
// JSON gh run list prints, and the clock moves only when the script sleeps.
//
// Ways it could fail, written before the code:
//  1. A failed, cancelled or timed-out CI run lets the release go on.
//  2. A run still queued or running counts as passed, or the wait gives up
//     on it before the run ends.
//  3. A commit with no CI run at all releases, or one whose run is created a
//     moment late is refused at once.
//  4. A run that never ends holds the release forever.
//  5. A run of another commit in the list counts for this one.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Run = { status: string; conclusion: string; databaseId: number; headSha: string };
type Options = { sha: string; gh: (args: string[]) => string; sleep: (ms: number) => Promise<void>; now: () => number; log: (line: string) => void };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { waitForCi } = (await import(join(root, "scripts/release-ci-check.mjs"))) as { waitForCi: (o: Options) => Promise<number> };

const sha = "a".repeat(40);
const other = "b".repeat(40);

// Each poll of gh returns the next answer; the last one repeats.
async function check(answers: Run[][]) {
  let clock = 0;
  const calls: string[][] = [];
  const code = await waitForCi({
    sha,
    gh: (args) => {
      calls.push(args);
      return JSON.stringify(answers[Math.min(calls.length - 1, answers.length - 1)]);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  });
  return { code, polls: calls.length, minutes: clock / 60_000, args: calls[0] };
}

const run = (status: string, conclusion = "", headSha = sha): Run => ({ status, conclusion, databaseId: 7, headSha });

describe("the release's wait for its commit's CI run", () => {
  it("passes on a completed run with success, and asks gh for this commit's push run of ci.yml", async () => {
    const result = await check([[run("completed", "success")]]);
    expect(result.code).toBe(0);
    expect(result.polls).toBe(1);
    expect(result.args).toEqual(["run", "list", "--workflow", "ci.yml", "--commit", sha, "--event", "push", "--json", "status,conclusion,databaseId,headSha", "--limit", "20"]);
  });

  it("refuses a run that failed, was cancelled or timed out (failure 1)", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]) {
      expect((await check([[run("completed", conclusion)]])).code, conclusion).toBe(1);
    }
  });

  it("waits while the run is queued or in progress, then passes on success (failure 2)", async () => {
    const result = await check([[run("queued")], [run("in_progress")], [run("in_progress")], [run("completed", "success")]]);
    expect(result.code).toBe(0);
    expect(result.polls).toBe(4);
  });

  it("waits while the run is in progress, then refuses on failure (failure 2)", async () => {
    expect((await check([[run("in_progress")], [run("completed", "failure")]])).code).toBe(1);
  });

  it("refuses when no run appears within three minutes, and waits for one that appears late (failure 3)", async () => {
    const missing = await check([[]]);
    expect(missing.code).toBe(1);
    expect(missing.minutes).toBe(3);
    expect((await check([[], [], [run("completed", "success")]])).code).toBe(0);
  });

  it("gives up on a run still running after 60 minutes (failure 4)", async () => {
    const result = await check([[run("in_progress")]]);
    expect(result.code).toBe(1);
    expect(result.minutes).toBe(60);
  });

  it("ignores a run of another commit (failure 5)", async () => {
    expect((await check([[run("completed", "success", other)]])).code).toBe(1);
  });
});
