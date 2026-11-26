// The ReviewBench entrypoint (benchmark/outside/reviewbench/entry.mjs), run
// as ReviewBench runs it: a subprocess with the RB_* variables, a real git
// clone at head with its base reachable, and the built CLI. The only
// stand-ins are the reviewer (fixtures/reviewbench/claude.cjs, put on PATH as
// `claude`) and, for the model configuration, the model API
// (fixtures/reviewbench/openrouter.mjs on 127.0.0.1); git, the CLI, the
// library, the change source and the report are real.
//
// Failures guarded, written before the code:
// 1. pr.head or pr.pr_number differs from RB_HEAD or RB_PR_NUMBER (or the
//    number is written as a string), which fails the pull request; or a
//    finding lacks RB_AGENT as its producer, or loses its file and lines.
// 2. The model ReviewBench configures (RB_CONFIG_MODEL) never reaches the
//    reviewer, or a run without it reviews with another model than Opus.
// 3. A checkout that is not at RB_HEAD is reviewed, so the findings are
//    for another commit.
// 4. A reviewer that never answered is written as a clean review on the
//    first attempt, so no retry happens; or, from the second, fails again,
//    so one pull request fails the whole run. The same holds for a review
//    stopped at its deadline with no report and one whose openqodex exit is
//    outside 0, 1 and 2.
// 5. A review the reviewer answered but that ended incomplete (it then
//    holds no finding) is written as clean on the first attempt; or, from
//    the second, fails again, so one pull request fails the whole run.
// 6. A pull request with nothing to review fails instead of writing an
//    empty findings file; for the model review, one its report marks
//    nothing_to_review is retried.
// 7. One finding ReviewBench's validator refuses (a path with "..", a
//    backslash or a colon) fails the whole pull request instead of being
//    left out; a finding with no line (below 1) or an end before its start
//    fails it instead of being placed at line 1 or on its start line; a
//    scanner's own outside-change finding, which the report does not show,
//    is written; one finding shown twice is written twice.
// 8. The review writes into the mounted clone (openqodex adds a work tree
//    under its .git), which fails when another user owns the clone, as on
//    ReviewBench, where the review runs as the node user.
// 9. A report.json symlink planted by the reviewer is refused, not read as
//    root: the reviewer reads an untrusted pull request and owns the folder
//    root reads the report from. A refused file then fails every attempt,
//    so one pull request fails the whole run.
// 10. The findings file is written as root through a temporary name where a
//    link was planted, so root overwrites the file the link names.
// 11. At the deadline the review is killed at once, so openqodex never stops
//    its reviewer, which leads a process group of its own and keeps running.
// 12. The model configuration (RB_CONFIG_REVIEWER=model) sends the review to
//    another URL, path or model id than RB_MODEL_BASE_URL/responses and
//    RB_CONFIG_MODEL (default openai/gpt-6.1-sol), or without the key as a
//    bearer header; or the key reaches RB_OUT or the log, also when the
//    provider quotes it back in an error.
// 13. Adding the model configuration changes the claude configuration: its
//    reviewer, model or findings differ with RB_CONFIG_REVIEWER=claude, or
//    with an OPENROUTER_API_KEY in the environment.
// 14. A model configuration without its key, with an http URL to another
//    machine (the key would go in clear), or an unknown reviewer, starts a
//    review instead of failing every attempt.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { decide, findingsOf, readContract, readReviewFile, runReview, writeFindingsFile } from "../outside/reviewbench/entry.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "../outside/reviewbench/entry.mjs");
const CLI = join(here, "../../packages/cli/dist/bin.js");
const STANDIN = join(here, "fixtures/reviewbench/claude.cjs");
const MODEL_API = join(here, "fixtures/reviewbench/openrouter.mjs");
// A key no other text holds, so finding it anywhere is a leak.
const KEY = "sk-or-v1-standin-7f3a9c2e5b18d4f6a0c3e9b2d7f1a8c4";

// The model API stand-in in a process of its own (run() blocks this one):
// { baseUrl, requests(), stop() }.
async function modelApi(mode = "") {
  const dir = tempDir("oq-rb-api-");
  const child = spawn(process.execPath, [MODEL_API, dir, ...(mode ? [mode] : [])], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "port")); i++) await sleep(50);
  if (!existsSync(join(dir, "port"))) throw new Error("the model API stand-in did not start");
  return {
    baseUrl: `http://127.0.0.1:${readFileSync(join(dir, "port"), "utf8")}/api/v1`,
    requests: () => (existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    stop: () => child.kill("SIGKILL"),
  };
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=rb@example.com", "-c", "user.name=rb", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

// A clone with a base commit and a head commit that changes one function.
function pullRequest() {
  const repo = tempDir("oq-rb-repo-");
  git(repo, "init", "-q");
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n\n\ndef div(a, b):\n    return a / b\n");
  git(repo, "commit", "-qam", "head");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

// One container's run: the stand-in as `claude`, in `mode` (see the stand-in).
function run({ repo, base, head }, { mode = "", env = {} } = {}) {
  const bin = tempDir("oq-rb-bin-");
  copyFileSync(STANDIN, join(bin, "claude"));
  chmodSync(join(bin, "claude"), 0o755);
  if (mode) writeFileSync(join(bin, "STANDIN_MODE"), mode);
  const pr = tempDir("oq-rb-pr-");
  writeFileSync(join(pr, "pr.json"), JSON.stringify({ repo: "https://github.com/example/calc", pr_number: 7, base, head, nwo: "example/calc", title: "t", body: "" }));
  const out = join(tempDir("oq-rb-out-"), "findings.json");
  const home = tempDir("oq-rb-home-");
  const p = spawnSync(process.execPath, [ENTRY], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      // So the test folders' cleanup finds a review a timeout left behind.
      OPENQODEX_TEST_OWNER: process.env.OPENQODEX_TEST_OWNER,
      OPENQODEX_HOME: join(home, ".openqodex"),
      OPENQODEX_AUTO_UPDATE: "0",
      OPENQODEX_CLI: CLI,
      ANTHROPIC_API_KEY: "stand-in",
      RB_REPO: repo,
      RB_PR_JSON: join(pr, "pr.json"),
      RB_OUT: out,
      RB_NWO: "example/calc",
      RB_PR_NUMBER: "7",
      RB_BASE: base,
      RB_HEAD: head,
      RB_AGENT: "openqodex",
      RB_ATTEMPT: "1",
      ...env,
    },
  });
  const text = existsSync(out) ? readFileSync(out, "utf8") : null;
  return { code: p.status, stderr: p.stderr, text, out: text === null ? null : JSON.parse(text) };
}

describe("ReviewBench entrypoint", () => {
  it("1, 2. writes the pull request as RB_* names it, each finding with RB_AGENT, and reviews with Opus unless RB_CONFIG_MODEL says otherwise", () => {
    const pr = pullRequest();
    const r = run(pr);
    expect(r.code, r.stderr).toBe(0);
    expect(r.out.pr).toEqual({ repo: "https://github.com/example/calc", pr_number: 7, base: pr.base, head: pr.head });
    expect(r.out.agent).toBe("openqodex");
    expect(r.out.findings).toHaveLength(1);
    expect(r.out.findings[0]).toMatchObject({ file: "calc.py", start_line: 2, end_line: 2, producer: "openqodex" });
    expect(r.out.findings[0].message).toContain("with model claude-opus-5-5");
    expect(r.stderr).toContain("model=claude-opus-5-5");

    const other = run(pr, { env: { RB_CONFIG_MODEL: "claude-sonnet-5-5" } });
    expect(other.code, other.stderr).toBe(0);
    expect(other.out.findings[0].message).toContain("with model claude-sonnet-5-5");
    expect(other.stderr).toContain("model=claude-sonnet-5-5");
  });

  it("3. refuses a checkout that is not at RB_HEAD", () => {
    const pr = pullRequest();
    const r = run({ ...pr, head: pr.base });
    expect(r.code).toBe(1);
    expect(r.out).toBeNull();
    expect(r.stderr).toContain("not RB_HEAD");
  });

  it("4. fails the first attempt when the reviewer never answered, and writes it empty from the second", () => {
    const pr = pullRequest();
    const first = run(pr, { mode: "crash", env: { RB_ATTEMPT: "1" } });
    expect(first.code).toBe(1);
    expect(first.out).toBeNull();
    expect(first.stderr).toContain("the reviewer never answered");
    for (const attempt of ["2", "3"]) {
      const later = run(pr, { mode: "crash", env: { RB_ATTEMPT: attempt } });
      expect(later.code, later.stderr).toBe(0);
      expect(later.out).toMatchObject({ pr: { head: pr.head, pr_number: 7 }, findings: [] });
      expect(later.stderr).toContain("the reviewer never answered");
    }
  });

  it("4b. decide fails every unfinished review on attempt 1 and writes it empty, naming the reason, from attempt 2", () => {
    const incompleteNoAnswer = { completion: { status: "partial", missing: ["the reviewer"] }, findings: [] };
    const cases = [
      ["a deadline stop with no report", { code: null, report: null, usage: null }, /stopped at its deadline/],
      ["an openqodex exit outside 0, 1 and 2 with no report", { code: 3, report: null, usage: null }, /openqodex exited 3 and wrote no report/],
      ["an openqodex exit outside 0, 1 and 2 with a report", { code: 137, report: incompleteNoAnswer, usage: null }, /openqodex exited 137/],
      ["a reviewer that never answered", { code: 1, report: incompleteNoAnswer, usage: { calls: [{ outcome: "error" }] } }, /the reviewer never answered/],
    ];
    for (const [why, input, reason] of cases) {
      expect(decide({ ...input, attempt: 1, agent: "openqodex" }), `${why}: attempt 1 did not fail`).toEqual({ fail: expect.stringMatching(reason) });
      for (const attempt of [2, 3]) {
        const d = decide({ ...input, attempt, agent: "openqodex" });
        expect(d, `${why}: attempt ${attempt} did not write an empty findings file`).toEqual({ write: [], note: expect.stringMatching(reason) });
      }
    }
  });

  it("5. fails an answered but incomplete review on the first attempt and writes it empty from the second", () => {
    const pr = pullRequest();
    const first = run(pr, { mode: "unexamined" });
    expect(first.code).toBe(1);
    expect(first.out).toBeNull();
    expect(first.stderr).toContain("ended incomplete");
    const second = run(pr, { mode: "unexamined", env: { RB_ATTEMPT: "2" } });
    expect(second.code, second.stderr).toBe(0);
    expect(second.out).toMatchObject({ pr: { head: pr.head, pr_number: 7 }, findings: [] });
  });

  it("6. writes an empty findings file for a pull request with nothing to review", () => {
    const pr = pullRequest();
    const r = run({ ...pr, base: pr.head });
    expect(r.code, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ pr: { head: pr.head, pr_number: 7 }, findings: [] });
  });

  it("6. writes an empty findings file, with no retry, for a model review that had nothing to review", () => {
    const report = { status: "nothing_to_review", reason: "nothing to review: the head changes no line a reviewer can read since the merge base" };
    expect(decide({ code: 0, report, usage: { calls: [] }, attempt: 1, agent: "openqodex" })).toEqual({ write: [], note: report.reason });
  });

  it("8. reviews a mounted clone it cannot write, and leaves it unchanged", () => {
    const pr = pullRequest();
    const status = () => execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: pr.repo, encoding: "utf8" });
    const before = status();
    execFileSync("chmod", ["-R", "a-w", pr.repo]);
    try {
      const r = run(pr);
      expect(r.code, r.stderr).toBe(0);
      expect(r.out.findings).toHaveLength(1);
    } finally {
      execFileSync("chmod", ["-R", "u+w", pr.repo]);
    }
    expect(status()).toBe(before);
    expect(git(pr.repo, "worktree", "list")).not.toContain("\n");
  });

  it("7. leaves out a finding the validator refuses, and the scanner's own outside-change findings, and keeps the rest", () => {
    const f = (file_path, line_number, line_end, extra = {}) => ({ origin: "agent", file_path, line_number, line_end, title: "Divides by zero", problem: "b can be 0.", consequence: "The call raises.", fix: "Check b.", ...extra });
    const report = {
      findings: [f("./calc.py", 5, 5), f("../etc/passwd", 1, 1), f("a\\b.py", 1, 1), f("c:/x.py", 1, 1), f("calc.py", 0, 0), f("calc.py", 3, 2)],
      outside_change: [f("lib.py", 9, 9, { origin: "scanner" }), f("lib.py", 4, 6)],
      observations: [f("calc.py", 5, 5)],
      possible: [],
    };
    const { findings, dropped } = findingsOf(report, "openqodex");
    expect(findings).toEqual([
      { file: "calc.py", start_line: 5, end_line: 5, message: "Divides by zero. b can be 0. The call raises. Fix: Check b.", producer: "openqodex" },
      { file: "calc.py", start_line: 1, end_line: 1, message: "Divides by zero. b can be 0. The call raises. Fix: Check b.", producer: "openqodex" },
      { file: "calc.py", start_line: 3, end_line: 3, message: "Divides by zero. b can be 0. The call raises. Fix: Check b.", producer: "openqodex" },
      { file: "lib.py", start_line: 4, end_line: 6, message: "Divides by zero. b can be 0. The call raises. Fix: Check b.", producer: "openqodex" },
    ]);
    expect(dropped).toBe(3);
  });

  it("9. a report.json symlink planted by the reviewer is refused, not read as root", () => {
    const dir = tempDir("oq-rb-report-");
    const secret = join(tempDir("oq-rb-secret-"), "secret.json");
    writeFileSync(secret, JSON.stringify({ secret: "root only" }));
    symlinkSync(secret, join(dir, "report.json"));
    const uid = process.getuid();
    expect(readReviewFile(join(dir, "report.json"), uid)).toEqual({ refused: "report.json is a symbolic link" });
    // The regular file the review wrote is read only when its user owns it.
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ calls: [] }));
    expect(readReviewFile(join(dir, "usage.json"), uid)).toEqual({ json: { calls: [] } });
    expect(readReviewFile(join(dir, "usage.json"), uid + 1)).toEqual({ refused: `usage.json is owned by uid ${uid}, not the review's user ${uid + 1}` });
    expect(readReviewFile(join(dir, "absent.json"), uid)).toBeNull();
    // A refused file fails the first attempt and is written empty from the second, even with a report beside it.
    const report = { completion: { status: "complete" }, findings: [] };
    expect(decide({ code: 0, report, usage: null, attempt: 1, agent: "openqodex", refused: "report.json is a symbolic link" })).toEqual({ fail: expect.stringMatching(/refused: report\.json is a symbolic link/) });
    expect(decide({ code: 0, report, usage: null, attempt: 2, agent: "openqodex", refused: "report.json is a symbolic link" })).toEqual({ write: [], note: expect.stringMatching(/refused: report\.json is a symbolic link; written with no finding on attempt 2/) });
  });

  it("10. a link planted at the findings file's temporary name is refused, and the file it names is unchanged", () => {
    const dir = tempDir("oq-rb-out-");
    const target = join(tempDir("oq-rb-target-"), "target.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "findings.json.tmp-4242"));
    expect(() => writeFindingsFile(join(dir, "findings.json"), { findings: [] }, 4242)).toThrow(/EEXIST/);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(existsSync(join(dir, "findings.json"))).toBe(false);
    writeFindingsFile(join(dir, "findings.json"), { findings: [] }, 4243);
    expect(JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"))).toEqual({ findings: [] });
  });

  it("11. at the deadline openqodex is asked to stop first, so it stops a reviewer in a process group of its own", async () => {
    const dir = tempDir("oq-rb-stop-");
    const pidFile = join(dir, "reviewer.pid");
    // A stand-in openqodex: it starts a detached reviewer, and on SIGTERM stops that reviewer's group and exits.
    const script = join(dir, "cli.cjs");
    writeFileSync(script, `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const r = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(r.pid));
process.on("SIGTERM", () => { try { process.kill(-r.pid, "SIGKILL"); } catch {} process.exit(143); });
setInterval(() => {}, 1000);
`);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let reviewer = null;
    try {
      const code = await runReview(process.execPath, [script], { env: process.env }, { deadlineMs: 1500, graceMs: 5000 });
      expect(code, "the deadline stop did not resolve null").toBeNull();
      reviewer = Number(readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 40 && alive(reviewer); i++) await sleep(50);
      expect(alive(reviewer), "the reviewer kept running after the deadline").toBe(false);
    } finally {
      if (reviewer !== null && alive(reviewer)) process.kill(-reviewer, "SIGKILL");
    }
  });

  it("12. the model configuration passes the OpenRouter base URL, model id and bearer key to the reviewer and never into RB_OUT or the log", async () => {
    const api = await modelApi();
    try {
      const pr = pullRequest();
      const r = run(pr, { env: { RB_CONFIG_REVIEWER: "model", RB_MODEL_BASE_URL: api.baseUrl, OPENROUTER_API_KEY: KEY } });
      expect(r.code, r.stderr).toBe(0);
      const requests = api.requests();
      expect(requests.length, "the reviewer never called the model API").toBeGreaterThan(0);
      for (const q of requests) expect(q).toEqual({ path: "/api/v1/responses", authorization: `Bearer ${KEY}`, model: "openai/gpt-6.1-sol" });
      expect(r.out.pr).toEqual({ repo: "https://github.com/example/calc", pr_number: 7, base: pr.base, head: pr.head });
      expect(r.out.findings).toHaveLength(1);
      expect(r.out.findings[0]).toMatchObject({ file: "calc.py", start_line: 2, end_line: 2, producer: "openqodex" });
      expect(r.out.findings[0].message).toContain("with model openai/gpt-6.1-sol");
      expect(r.stderr).toContain("model=openai/gpt-6.1-sol reviewer=model");
      expect(r.text).not.toContain(KEY);
      expect(r.stderr).not.toContain(KEY);
    } finally {
      api.stop();
    }
  });

  it("12b. a model API that quotes the key back in its error never puts it in RB_OUT or the log", async () => {
    const api = await modelApi("reject");
    try {
      const pr = pullRequest();
      const env = { RB_CONFIG_REVIEWER: "model", RB_CONFIG_MODEL: "openai/gpt-6.1-sol", RB_MODEL_BASE_URL: api.baseUrl, OPENROUTER_API_KEY: KEY };
      const first = run(pr, { env });
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("the reviewer never answered");
      expect(first.stderr).not.toContain(KEY);
      expect(api.requests().length, "the stand-in was never asked, so its error was never read").toBeGreaterThan(0);
      const second = run(pr, { env: { ...env, RB_ATTEMPT: "2" } });
      expect(second.code, second.stderr).toBe(0);
      expect(second.out.findings).toEqual([]);
      expect(second.text).not.toContain(KEY);
      expect(second.stderr).not.toContain(KEY);
    } finally {
      api.stop();
    }
  });

  it("13. the claude configuration is unchanged by RB_CONFIG_REVIEWER=claude or an OPENROUTER_API_KEY beside it", () => {
    const pr = pullRequest();
    const plain = run(pr);
    const named = run(pr, { env: { RB_CONFIG_REVIEWER: "claude", OPENROUTER_API_KEY: KEY } });
    expect(plain.code, plain.stderr).toBe(0);
    expect(named.code, named.stderr).toBe(0);
    expect(named.out).toEqual(plain.out);
    expect(named.out.findings[0].message).toContain("with model claude-opus-5-5");
    expect(named.stderr).toContain("model=claude-opus-5-5 reviewer=claude");
  });

  it("14. refuses a model configuration with no key or an http URL to another machine, and an unknown reviewer", () => {
    const env = { RB_OUT: "/work/out/findings.json", RB_HEAD: "a".repeat(40), RB_BASE: "b".repeat(40), RB_PR_NUMBER: "7", RB_NWO: "example/calc", RB_AGENT: "openqodex" };
    expect(() => readContract({ ...env, RB_CONFIG_REVIEWER: "model" })).toThrow("OPENROUTER_API_KEY is not set");
    expect(() => readContract({ ...env, RB_CONFIG_REVIEWER: "model", OPENROUTER_API_KEY: KEY, RB_MODEL_BASE_URL: "http://openrouter.ai/api/v1" })).toThrow("RB_MODEL_BASE_URL must be an https URL");
    expect(() => readContract({ ...env, RB_CONFIG_REVIEWER: "codex" })).toThrow("RB_CONFIG_REVIEWER must be claude or model, not codex");
    expect(readContract({ ...env, RB_CONFIG_REVIEWER: "model", OPENROUTER_API_KEY: KEY })).toMatchObject({ reviewer: "model", model: "openai/gpt-6.1-sol", baseUrl: "https://openrouter.ai/api/v1" });
    expect(readContract(env)).toMatchObject({ reviewer: "claude", model: "claude-opus-5-5", baseUrl: null });
  });
});
