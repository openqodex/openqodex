// Laptop reviews (Claude Code, Codex) of pull request cases. No reviewer
// runs here: the review itself needs a logged-in reviewer, so the laptop
// smoke run (docs/benchmark.md) proves it. No test reads the clone cache,
// the pinned dataset files or the network. Failure list, written before the
// code:
// 1. A laptop review reads the target tip instead of the merge base.
//    Guarded by materialise.test.mjs, failure 2.
// 2. The pull request change stays committed, so the laptop sees no change.
//    Guarded by materialise.test.mjs, failure 4.
// 3. A test-split case reaches a laptop run before its refusal.
// 4. A laptop sample lacks the fields the common scorer needs.
// 5. Materialising a case changes the clone cache. Guarded by
//    materialise.test.mjs, failures 7 and 12.
// 6. Pull request reviews lose the planted path's graph and web options.
// 7. The flags still refuse laptop reviewers for pull request cases.
// 8. Build validation hides a development case's missing cached truth.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/cases.mjs";
import { laptopReviewArgs, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { aacrTruth, listCases, readCase, specCopy } from "../lib/suites.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const RUN = join(repoRoot, "benchmark/run.mjs");
const c = readCase(listCases({ suite: "aacr", subset: "dev-smoke" })[0]);

// run.mjs as a developer runs it, with a clone cache folder that does not exist yet.
function run(args) {
  const cache = join(tempDir("oq-laptop-pr-"), "cache");
  const p = spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: cache }, timeout: 60_000 });
  return { ...p, cacheMade: existsSync(cache) ? readdirSync(cache) : null };
}

// A truth in AACR-Bench's row shape with as many accepted comments as the case lists.
function truthFor(x) {
  const comment = (n) => ({ path: "src/app.ts", from_line: 10 * n, to_line: 10 * n + 2, side: "right", note: `comment ${n}`, category: "Code Defect", context: "Diff Level", is_ai_comment: false, source_model: "" });
  return aacrTruth({ comments: Array.from({ length: x.truthCount.accepted }, (_, i) => comment(i + 1)) }, null);
}

const finding = (file_path, line_number, title) => ({ origin: "agent", severity: "major", category: "bug", confidence: 0.9, file_path, line_number, line_end: line_number, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: title, consequence: "c", fix: "f" });

describe("a laptop run of pull request cases", () => {
  it("refuses a test-split run before it creates or reads the clone cache", () => {
    const p = run(["--suite", "aacr", "--split", "test", "--reviewers", "claude", "--max-usd", "1", "--max-minutes", "20"]);
    expect(p.status).toBe(2);
    expect(p.stderr).toContain("the aacr test split is held out: no held-out case runs before a release");
    expect(p.cacheMade).toBeNull();
  });

  it("refuses missing development truth before checking the build", () => {
    const p = run(["--suite", "aacr", "--subset", "dev-smoke", "--reviewers", "claude", "--max-usd", "1", "--max-minutes", "20", "--cli", join(repoRoot, "benchmark/results/missing-cli.js"), "--dry-run"]);
    expect(p.status).toBe(2);
    expect(p.stderr).toContain("The run cannot start:");
    expect(p.stderr).toMatch(/is not in the cache .*run node benchmark\/ingest\/aacr\.mjs/);
    expect(p.stderr).not.toMatch(/model reviewers only/);
    expect(p.stderr).not.toContain("no record of how the CLI was built");
  });

  it("scores a Claude Code sample of a pull request case against its saved truth", () => {
    const out = join(tempDir("oq-laptop-pr-run-"), "run");
    const { jobs } = planJobs({ cases: [c.name], caseIds: { [c.name]: c.id }, reviewers: ["claude"], graph: ["on"], repeat: 1 });
    const job = jobs[0];
    const dir = join(out, "samples", c.name, job.config, "1");
    mkdirSync(join(dir, "report"), { recursive: true });
    mkdirSync(join(out, "cases"));
    writeFileSync(join(out, "cases", `${c.name}.json`), JSON.stringify(specCopy(c, truthFor(c))));
    const settings = { runId: "laptop-pr", mode: "review", path: "laptop", suite: "aacr", split: "dev", splitHash: c.splitHash, cases: [c.name], caseIds: [c.id], caseHashes: { [c.name]: c.hash }, configs: [job.config], repeat: 1, concurrency: 1 };
    writeFileSync(join(out, "manifest.json"), JSON.stringify(runManifest({ startedAt: "t", settings, jobs })));
    // On the first accepted comment's lines, and elsewhere.
    const report = { version: 1, kind: "review", verdict: "passed", findings: [finding("src/app.ts", 11, "An off-by-one in the loop"), finding("src/other.ts", 3, "Unrelated")], outside_change: [], dropped: [], scanners: [], impact: { status: "ok", build: { durationMs: 100 } }, completion: { status: "complete", missing: [], reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 10, output_tokens: 10, cost_usd: 0.25 } } } };
    const sample = sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result: { code: 0, wallMs: 1000 }, report, who: null, startedAt: "t", failure: null, stopped: null });
    writeFileSync(join(dir, "sample.json"), JSON.stringify(sample));
    writeFileSync(join(dir, "report", "report.json"), JSON.stringify(report));
    expect(sample).toMatchObject({ caseId: c.id, jobId: job.jobId, firstAttempt: true, reviewer: "claude", graph: "on", status: "complete", usage: { cost_usd: 0.25 } });
    const s = scoreRun(loadRun(out)).score.byConfig[job.config];
    expect(s.population).toMatchObject({ planned: 1, complete: 1 });
    expect(s.location).toMatchObject({ matches: 1, generated: 2, expected: c.truthCount.accepted });
  });

  it("passes the graph and web options as for planted cases", () => {
    expect(laptopReviewArgs({ repo: "/r", reportDir: "/report", job: { reviewer: "codex", graph: false }, web: "on", timeout: 60 })).toEqual(["review", "--cwd", "/r", "--report-dir", "/report", "--reviewer", "codex", "--reviewer-web", "on", "--timeout", "60", "--no-color", "--no-graph"]);
    expect(laptopReviewArgs({ repo: "/r", reportDir: "/report", job: { reviewer: "claude", graph: true }, web: "off", timeout: 1800 })).toEqual(["review", "--cwd", "/r", "--report-dir", "/report", "--reviewer", "claude", "--reviewer-web", "off", "--timeout", "1800", "--no-color"]);
  });
});
