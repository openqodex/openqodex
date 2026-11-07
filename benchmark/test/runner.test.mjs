// The runner decides what a run holds, so each rule that keeps a run honest
// is checked without starting a reviewer: every attempt is its own scored
// sample, a retry never lands on the first attempt's files, a failed review
// is a scored failure, a resume refuses changed settings, the bundle must be
// the one built from the tree the run names, and the Codex model comes from
// Codex's own output. The run folder rules (one plan per folder, one runner
// at a time, a crashed attempt kept, a dead holder's lock taken over by
// exactly one of several processes racing on it, never two) are checked on
// executeRun, the code run.mjs runs, with the review step, which would call
// a model, replaced.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "../lib/cases.mjs";
import { redactRowReasons, saveSampleRow, attemptDir, codexModelFrom, executeRun, failureOf, lockRun, LOCK_FILE, planJobs, provenanceProblems, resumeProblems, runManifest, sampleRecord, claudeModels, claudeRunModels, takeOverStale, treeState } from "../lib/runner.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const runnerModule = new URL("../lib/runner.mjs", import.meta.url).href;

const job = { case: "c", config: "claude-graph-on", reviewer: "claude", graph: true, repeat: 2 };

describe("attempts", () => {
  it("gives every attempt its own folder, the first one the repeat's own", () => {
    expect(attemptDir("/r", job, 1)).toBe(join("/r", "samples", "c", "claude-graph-on", "2"));
    expect(attemptDir("/r", job, 2)).toBe(join("/r", "samples", "c", "claude-graph-on", "2-attempt2"));
    expect(attemptDir("/r", job, 2)).not.toBe(attemptDir("/r", job, 1));
  });

  it("calls a review with no report, or whose reviewer timed out, a reviewer failure, and an unread range a product result", () => {
    expect(failureOf({ code: 2, signal: null, stderr: "boom" }, null)).toMatchObject({ infra: true });
    expect(failureOf({ code: 2, signal: null, stderr: "Full review unavailable: openqodex could not start a reviewer." }, null)).toMatchObject({ infra: true, unavailable: true });
    const timedOut = { completion: { status: "incomplete", missing: ["the reviewer timed out and was stopped"] } };
    expect(failureOf({ code: 2, signal: null, stderr: "" }, timedOut)).toMatchObject({ infra: true, cause: "the reviewer timed out and was stopped" });
    const unread = { completion: { status: "incomplete", missing: ["1 changed range was not read: a.py:3"] } };
    expect(failureOf({ code: 2, signal: null, stderr: "" }, unread)).toMatchObject({ infra: false });
    expect(failureOf({ code: 0, signal: null, stderr: "" }, { completion: { status: "complete", missing: [] } })).toBeNull();
  });

  it("records a failed attempt as a sample with its cause, so it is scored and never a missing row", () => {
    const rec = sampleRecord({ job, attempt: 1, result: { code: 2, signal: null, wallMs: 900_000 }, report: null, who: null, startedAt: "t", failure: { cause: "the reviewer timed out and was stopped" }, stopped: null });
    expect(rec).toMatchObject({ case: "c", repeat: 2, attempt: 1, status: "failed", failure: "the reviewer timed out and was stopped", findings: null });
  });

  it("loads every attempt of a saved run as a sample, a failed one included", () => {
    const out = tempDir("oq-bench-load-");
    const spec = { id: "c", guards: "g", language: "python", framework: "none", clean: false, bugs: [{ id: "b", file: "a.py", lines: [1, 1], anchor: { line: 1, text: "x" }, mentions: ["x"], kind: ["bug"], severity: "major", found_by: ["reasoning"], truth: "t" }] };
    mkdirSync(join(out, "cases"), { recursive: true });
    writeFileSync(join(out, "cases", "c.json"), JSON.stringify(spec));
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ version: 1, repeat: 1, planned: 1 }));
    for (const [n, status] of [["1", "failed"], ["1-attempt2", "complete"]]) {
      const dir = join(out, "samples", "c", "claude-graph-on", n);
      mkdirSync(join(dir, "report"), { recursive: true });
      writeFileSync(join(dir, "sample.json"), JSON.stringify({ case: "c", config: "claude-graph-on", repeat: 1, attempt: n === "1" ? 1 : 2, status }));
      if (status === "complete") writeFileSync(join(dir, "report", "report.json"), JSON.stringify({ findings: [], outside_change: [], dropped: [], completion: { status: "complete", missing: [] } }));
    }
    const run = loadRun(out);
    expect(run.samples.map((s) => s.status).sort()).toEqual(["complete", "failed"]);
  });
});

describe("resuming a run", () => {
  const manifest = {
    build: { bundleHash: "b1" },
    machine: { platform: "darwin", arch: "arm64", cpu: "M5", cpus: 15, memoryGb: 48, node: "v22.23.3" },
    reviewers: { claude: { name: "claude", version: "2.1.294", model: "m1" } },
    review: { web: "on", timeoutSeconds: 900 },
    concurrency: 1,
    caseHashes: { c: "h1" },
  };

  it("accepts the same settings and names each one that differs", () => {
    expect(resumeProblems(manifest, manifest)).toEqual([]);
    const now = {
      ...manifest,
      build: { bundleHash: "b2" },
      machine: { ...manifest.machine, cpu: "M4" },
      reviewers: { claude: { name: "claude", version: "2.1.295", model: "m2" } },
      review: { web: "off", timeoutSeconds: 600 },
      concurrency: 2,
      caseHashes: { c: "h2" },
    };
    const said = resumeProblems(manifest, now).join("\n");
    for (const word of ["CLI bundle", "machine", "claude reviewer version", "claude model", "web", "timeout", "concurrency", "case c"]) expect(said).toContain(word);
  });
});

describe("the build's provenance", () => {
  const repo = () => {
    const dir = join(tempDir("oq-bench-prov-"), "repo");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  };

  it("calls the tree clean when it matches the commit, and dirty after an edit or a new file, whatever the index holds", () => {
    const dir = repo();
    const clean = treeState(dir);
    expect(clean).toMatchObject({ dirty: false });
    expect(clean.tree).toBe(clean.commitTree);
    writeFileSync(join(dir, "b.txt"), "new\n");
    const added = treeState(dir);
    expect(added.dirty).toBe(true);
    expect(added.commit).toBe(clean.commit);
    // Staging the file does not change what the tree holds.
    git(dir, "add", "b.txt");
    expect(treeState(dir).tree).toBe(added.tree);
  });

  it("refuses a bundle that is not the one built, and a run with no record of its build", () => {
    const prov = { commit: "c1", tree: "t1", commitTree: "t1", dirty: false, bundleHash: "b1" };
    expect(provenanceProblems(prov, "b1")).toEqual([]);
    expect(provenanceProblems(prov, "b2").join("\n")).toMatch(/not the one benchmark\/build-cli.mjs built/);
    expect(provenanceProblems(null, "b1").join("\n")).toMatch(/node benchmark\/build-cli.mjs/);
  });
});

describe("the Codex model", () => {
  it("reads the model from the header Codex prints, and says unknown when there is none", () => {
    const header = "OpenAI Codex v0.161.0\n--------\nworkdir: /tmp/x\nmodel: gpt-6.1-sol\nprovider: openai\n--------\n";
    expect(codexModelFrom(header)).toBe("gpt-6.1-sol");
    expect(codexModelFrom("no header here")).toBe("unknown");
  });
});

// --- the run folder ---

const ID = "planted/one@cdcdcdcd";
const oneSpec = { id: "one", guards: "g", language: "python", framework: "none", clean: false, bugs: [{ id: "sqli", file: "app.py", lines: [4, 4], anchor: { line: 4, text: "x" }, mentions: ["sql"], kind: ["security"], severity: "critical", found_by: ["reasoning"], truth: "t" }] };
const hitReport = { findings: [{ origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path: "app.py", line_number: 4, line_end: 4, title: "SQL injection", problem: "p", consequence: "c", fix: "f" }], outside_change: [], dropped: [], completion: { status: "complete", missing: [], reviewer: { usage: { cost_usd: 0.3 } } } };

// The plan, the manifest and the spec copy run.mjs gives executeRun for one case.
function runInputs(repeat = 1) {
  const root = tempDir("oq-bench-folder-");
  const specFile = join(root, "one.json");
  writeFileSync(specFile, JSON.stringify(oneSpec));
  const { jobs } = planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on"], repeat });
  const manifest = runManifest({ startedAt: "2026-10-10T10:00:00.000Z", settings: { cases: ["one"], caseIds: [ID], configs: ["claude-graph-on"], repeat }, jobs });
  return { out: join(root, "run"), jobs, manifest, copies: [[specFile, "cases/one.json"]] };
}

// One attempt as the runner leaves it: its folder, its sample and, when the review wrote one, its report.
function saveAttempt(out, job, attempt, report) {
  const dir = attemptDir(out, job, attempt);
  mkdirSync(join(dir, "report"), { recursive: true });
  writeFileSync(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job, attempt, result: { code: report ? 0 : 2, signal: null, wallMs: 1000 }, report, who: null, startedAt: "t", failure: null, stopped: null })));
  if (report) writeFileSync(join(dir, "report", "report.json"), JSON.stringify(report));
}

describe("a plan with one job twice counts that job twice", () => {
  it("refuses a plan whose configurations or cases repeat (--graph on,on, --cases one,one)", () => {
    expect(() => planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on", "on"], repeat: 1 })).toThrow(/twice/);
    expect(() => planJobs({ cases: ["one", "one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on"], repeat: 1 })).toThrow(/twice/);
    expect(planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude", "codex"], graph: ["off", "on"], repeat: 2 }).jobs).toHaveLength(8);
  });
});

describe("drift lands on the same cases in every repeat", () => {
  it("rotates the case order by the repeat number, as the configuration order alternates", () => {
    const ids = { a: "planted/a@aaaaaaaa", b: "planted/b@bbbbbbbb", c: "planted/c@cccccccc" };
    const { jobs } = planJobs({ cases: ["a", "b", "c"], caseIds: ids, reviewers: ["claude"], graph: ["off", "on"], repeat: 3 });
    const order = (r) => [...new Set(jobs.filter((j) => j.repeat === r).map((j) => j.case))];
    expect([order(1), order(2), order(3)]).toEqual([["a", "b", "c"], ["b", "c", "a"], ["c", "a", "b"]]);
    expect(jobs.filter((j) => j.repeat === 2).map((j) => j.config).slice(0, 2)).toEqual(["claude-graph-on", "claude-graph-off"]);
  });
});

describe("repeats added to a finished run are scored as unplanned", () => {
  it("writes the longer plan into the manifest before the added reviews run, and scores every repeat as planned", async () => {
    const { out, jobs, manifest, copies } = runInputs(1);
    await executeRun({ out, manifest, jobs, copies, runJob: async (job, attempt) => saveAttempt(out, job, attempt, hitReport) });
    const longer = planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on"], repeat: 3 }).jobs;
    const ran = [];
    await executeRun({
      out,
      manifest: null,
      resume: true,
      jobs: longer,
      copies,
      addRepeats: { repeat: 3, at: "2026-10-11T12:00:00.000Z" },
      runJob: async (job, attempt) => {
        // The longer plan is on disk before the first added review starts.
        expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).planned).toBe(3);
        ran.push(job.repeat);
        saveAttempt(out, job, attempt, hitReport);
      },
    });
    expect(ran).toEqual([2, 3]);
    const saved = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(saved).toMatchObject({ started_at: manifest.started_at, repeat: 3, planned: 3, repeatsAdded: [{ from: 1, to: 3, jobs: 2 }] });
    const { score } = scoreRun(loadRun(out));
    expect(score.population.unplanned).toEqual([]);
    expect(score.byConfig["claude-graph-on"].population).toMatchObject({ planned: 3, complete: 3, unstarted: 0 });
  });

  it("refuses to add repeats to a run that did not finish, or with a plan that drops a review the run planned", async () => {
    const { out, jobs, manifest, copies } = runInputs(2);
    await executeRun({ out, manifest, jobs, copies, stopReason: () => "stopped by Ctrl-C", runJob: async () => {} });
    const longer = planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on"], repeat: 3 }).jobs;
    await expect(executeRun({ out, manifest: null, resume: true, jobs: longer, copies, addRepeats: { repeat: 3, at: "t" }, runJob: async () => {} })).rejects.toThrow(/not finished/);
    const other = planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["codex"], graph: ["on"], repeat: 3 }).jobs;
    await expect(executeRun({ out, manifest: null, resume: true, jobs: other, copies, addRepeats: { repeat: 3, at: "t" }, runJob: async () => {} })).rejects.toThrow(/leaves out 2 reviews/);
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).repeat).toBe(2);
  });
});

describe("a resumed run reruns a crashed first attempt in its folder, so a later success replaces the crash", () => {
  it("keeps a first-attempt folder that never got its sample.json, runs the job again as attempt 2, and scores the crash as the first attempt", async () => {
    const { out, jobs, manifest, copies } = runInputs();
    // The runner was killed after the review started: the folder exists, sample.json does not.
    await executeRun({ out, manifest, jobs, copies, runJob: async (job) => {
      mkdirSync(attemptDir(out, job, 1), { recursive: true });
      writeFileSync(join(attemptDir(out, job, 1), "stderr.txt"), "killed\n");
    } });
    const ran = [];
    await executeRun({ out, manifest: null, resume: true, jobs, copies, runJob: async (job, attempt) => {
      ran.push([job.jobId, attempt]);
      saveAttempt(out, job, attempt, hitReport);
    } });
    expect(ran).toEqual([[jobs[0].jobId, 2]]);
    expect(readdirSync(attemptDir(out, jobs[0], 1))).toEqual(["stderr.txt"]);
    const { score } = scoreRun(loadRun(out));
    expect(score.byConfig["claude-graph-on"].population).toMatchObject({ planned: 1, failed: 1, complete: 0, retries: 1 });
    // One case is too few clusters for an interval.
    expect(score.byConfig["claude-graph-on"].issueRecall.all).toEqual({ hit: 0, of: 1, ci: null });
  });
});

describe("two runners share one run folder, or a restart replaces a crashed run's plan", () => {
  it("refuses a second runner on the same empty --out while the first holds it", async () => {
    const a = runInputs();
    let release;
    const held = new Promise((r) => (release = r));
    const first = executeRun({ out: a.out, manifest: a.manifest, jobs: a.jobs, copies: a.copies, runJob: () => held });
    // The first runner has taken the folder before its first review.
    for (let i = 0; i < 50 && !existsSync(join(a.out, "manifest.json")); i++) await new Promise((r) => setTimeout(r, 10));
    const written = readFileSync(join(a.out, "manifest.json"), "utf8");
    const other = { ...a.manifest, started_at: "2026-10-10T11:00:00.000Z" };
    await expect(executeRun({ out: a.out, manifest: other, jobs: a.jobs, copies: a.copies, runJob: async () => {} })).rejects.toThrow(/in use by another run/);
    await expect(executeRun({ out: a.out, manifest: null, resume: true, jobs: a.jobs, copies: a.copies, runJob: async () => {} })).rejects.toThrow(/in use by another run/);
    release();
    await first;
    expect(JSON.parse(readFileSync(join(a.out, "manifest.json"), "utf8")).started_at).toBe(JSON.parse(written).started_at);
  });

  it("refuses a new run in a folder whose run crashed before any sample, so its plan is never replaced", async () => {
    const a = runInputs();
    mkdirSync(a.out, { recursive: true });
    writeFileSync(join(a.out, "manifest.json"), JSON.stringify(a.manifest));
    // The crashed runner's lock: a process that has ended.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(a.out, ".run.lock"), `${dead}\n`);
    const before = readFileSync(join(a.out, "manifest.json"), "utf8");
    await expect(executeRun({ out: a.out, manifest: { ...a.manifest, started_at: "2026-10-10T12:00:00.000Z" }, jobs: a.jobs, copies: a.copies, runJob: async () => {} })).rejects.toThrow(/already holds a run/);
    expect(readFileSync(join(a.out, "manifest.json"), "utf8")).toBe(before);
    // With --resume the stale lock is taken over and the run goes on.
    const ran = [];
    await executeRun({ out: a.out, manifest: null, resume: true, jobs: a.jobs, copies: a.copies, runJob: async (job, attempt) => ran.push(attempt) });
    expect(ran).toEqual([1]);
    expect(existsSync(join(a.out, ".run.lock"))).toBe(false);
  });

  it("never takes over a lock that is being written (empty), or one a live runner put in place after the dead holder was read", () => {
    const out = tempDir("oq-bench-lock-");
    const lock = join(out, ".run.lock");
    writeFileSync(lock, "");
    expect(() => lockRun(out)).toThrow(/in use by another run/);
    expect(readFileSync(lock, "utf8")).toBe("");
    // The holder read as dead, but by the takeover a live runner's lock is there: it stays.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, `${process.pid}\n`);
    expect(takeOverStale(lock, dead)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    // Still the dead holder's: taken over in one step, this process's own
    // pid replacing it directly, so the path never sits empty in between.
    writeFileSync(lock, `${dead}\n`);
    expect(takeOverStale(lock, dead)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it("lets exactly one of several processes racing on a dead lock take over the run folder, never two", async () => {
    // The same race lib/budget.mjs's ledger lock had before PR 125: a lock
    // left by a process that has ended, read by several processes at once.
    // The old takeOverStale moved the lock aside before checking it, so a
    // second process could rename away a first process's fresh, live lock
    // and (finding it not stale) put it back with a gap in between where a
    // third process saw no lock at all and claimed the folder itself - two
    // processes then held one run folder. This runs that race for real, six
    // processes at once, several trials, and counts how many ever hold the
    // lock while another of the six is still live and racing: always one.
    // Each holder keeps it for a while, as a real run would: a holder that
    // exited the instant it won would make its own lock stale again right
    // away, letting a slow straggler take over next, a real second winner
    // but not the double hold this test means to catch.
    for (let trial = 0; trial < 6; trial++) {
      const out = tempDir("oq-bench-run-stale-");
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, LOCK_FILE), `${dead}\n`);
      const go = join(out, "go");
      const child = () =>
        new Promise((finished) => {
          const code = `
            import { existsSync, writeFileSync } from "node:fs";
            import { lockRun } from ${JSON.stringify(runnerModule)};
            while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 1));
            try {
              const release = lockRun(${JSON.stringify(out)});
              writeFileSync(${JSON.stringify(out)} + "/claimed-" + process.pid, "");
              const until = Date.now() + 500;
              while (Date.now() < until) {}
              release();
            } catch (error) {
              if (!/in use by another run/.test(error.message)) throw error;
            }
          `;
          const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          p.stderr.on("data", (d) => (stderr += d));
          p.on("close", () => finished(stderr));
        });
      const runs = Array.from({ length: 6 }, child);
      await new Promise((wake) => setTimeout(wake, 300));
      writeFileSync(go, "");
      for (const stderr of await Promise.all(runs)) expect(stderr).toBe("");
      expect(readdirSync(out).filter((f) => f.startsWith("claimed-"))).toHaveLength(1);
    }
  });
});

// Failure list for issue 182, before the code:
// A served model is replaced by the requested model; mixed reviews look like
// one model; missing usage looks known; reviewer text supplies a model; a
// review Claude Code never answered makes a finished run unknown.
describe("Claude Code models from usage", () => {
  // A resume with mixed evidence leaves a finished manifest acceptable.
  it("marks the manifest stopped when a resume finds mixed models", async () => {
    const { out, jobs, manifest, copies } = runInputs();
    await executeRun({ out, manifest, jobs, copies, runJob: async (job, attempt) => saveAttempt(out, job, attempt, hitReport) });
    const why = "Claude Code samples have mixed models: one, two";
    await executeRun({ out, manifest: null, jobs, resume: true, runJob: async () => {}, finish: () => ({ reviewers: { claude: { model: null } }, modelRefusal: why }) });
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).ended).toMatchObject({ how: "stopped", why });
  });
  // A halt during the first review leaves no model; the manifest must still name the halt.
  it("keeps a halt's own reason when the model is unknown", async () => {
    const { out, jobs, manifest, copies } = runInputs();
    await executeRun({ out, manifest, jobs, copies, runJob: async (job, attempt) => saveAttempt(out, job, attempt, hitReport), stopReason: () => "interrupted by SIGINT", finish: () => ({ reviewers: { claude: { model: null } }, modelRefusal: "Claude Code samples have an unknown per-review model" }) });
    const saved = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(saved.ended).toMatchObject({ how: "stopped", why: "interrupted by SIGINT" });
    expect(saved.modelRefusal).toMatch(/unknown/);
  });
  const usage = (...models) => ({ calls: models.map((model) => ({ model, purpose: "brief", outcome: "ok" })) });
  it("records the served model rather than the requested model or reviewer text", () => {
    const rec = sampleRecord({ job, attempt: 1, result: {}, report: null, who: { model: "claimed" }, usageRecord: usage("served"), startedAt: "t" });
    expect(rec).toMatchObject({ model: "served", modelFrom: "the usage record Claude Code returned for this review" });
    expect(claudeRunModels([rec], "requested").why).toMatch(/requested.*served/);
  });
  it("keeps every model within a review and refuses two models across reviews", () => {
    expect(claudeModels(usage("one, two", "one"))).toMatchObject({ model: ["one", "two"], modelStatus: "mixed" });
    expect(claudeRunModels([{ reviewer: "claude", ...claudeModels(usage("one")) }, { reviewer: "claude", ...claudeModels(usage("two")) }]).why).toMatch(/mixed.*one, two/);
  });
  it("keeps missing usage unknown even when reviewer text names a model", () => {
    expect(claudeModels({ calls: [{ model: null, outcome: "ok" }] })).toMatchObject({ model: null, modelStatus: "unknown" });
    expect(claudeRunModels([{ reviewer: "claude", ...claudeModels(null) }]).why).toMatch(/unknown/);
    expect(claudeRunModels([{ reviewer: "claude", reviewerUsed: { model: "claimed" } }]).why).toMatch(/unknown/);
  });
  it("leaves out a review Claude Code never answered", () => {
    const timedOut = claudeModels({ calls: [{ model: null, outcome: "failed" }] });
    expect(timedOut).toMatchObject({ model: null, modelStatus: "none" });
    const rows = [{ reviewer: "claude", ...claudeModels(usage("one")) }, { reviewer: "claude", ...timedOut }, { reviewer: "claude", ...claudeModels(null) }];
    expect(claudeRunModels(rows, "one")).toMatchObject({ model: "one", why: null });
  });
});

// Failure cases: saving a row leaves repeated paths, redacts home before a
// nested run root, changes null reasons, leaves the sample copy leaking, or
// rewrites a path that only starts with the home folder's text.
it("redacts run and home paths in every saved reason and keeps null reasons", () => {
  const run = tempDir("oq-row-paths-");
  const sample = join(run, "samples", "case", "config", "1");
  mkdirSync(sample, { recursive: true });
  const reason = `${run}/repo/a.go and ${run}/repo/b.go and ${homedir()}/cache`;
  const row = { scanners: [{ reason }, { reason: null }], nested: { reason }, status: "failed" };
  saveSampleRow(run, sample, row);
  const saved = JSON.parse(readFileSync(join(run, "rows.jsonl"), "utf8"));
  expect(saved.scanners[0].reason).toBe("<run>/repo/a.go and <run>/repo/b.go and <home>/cache");
  expect(saved.nested.reason).toBe(saved.scanners[0].reason);
  expect(saved.scanners[1].reason).toBeNull();
  expect(saved.status).toBe("failed");
  expect(JSON.parse(readFileSync(join(sample, "sample.json"), "utf8"))).toEqual(saved);
  const nestedRun = join(homedir(), "results", "run");
  expect(redactRowReasons({ reason: `${nestedRun}/a ${homedir()}/b` }, nestedRun).row.reason).toBe("<run>/a <home>/b");
  const other = { reason: `${homedir()}-other/a and ${run}2/b` };
  expect(redactRowReasons(other, run)).toMatchObject({ row: other, count: 0 });
});
