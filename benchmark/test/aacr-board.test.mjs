// AACR-Bench as an outside board: a saved run's samples on AACR cases in the
// shape AACR-Bench's own evaluator reads (benchmark/outside/convert/aacr.mjs),
// the wrapper that runs that evaluator with the judge settings
// (benchmark/outside/boards/aacr.sh), and what score.mjs --outside aacr
// reads back beside our score.
//
// Failures guarded, each test written before the code:
// 1. A finding without a line is dropped, so AACR's precision rises: it is
//    held in the comment list with null lines, and counted.
// 2. A sample on a case outside AACR-Bench is converted for the board.
// 3. A failed or never-started review vanishes from AACR's denominators
//    (their evaluator leaves out an instance with no result file).
// 4. A case whose licence nobody verified is converted for a board.
// 5. The wrapper echoes the judge's key or base URL: a dry run with a fake
//    settings file, traced by bash -x, leaves neither in any output or file.
// 6. AACR's mock judge scores a run as if a model judged it.
// 7. The diagnostics change score.json's own fields or the rules hash.
// 8. Our line count differs from AACR's on the same reports, or the format
//    mismatch silently scores zero: on a crafted report set over 5
//    development cases, our location numbers equal the line counts AACR's
//    evaluator gave (recorded in fixtures/aacr-board/, and run again live
//    when their pinned checkout is in the cache).
// 16. Scoring with --outside saves the run or evaluator home path.
// 17. Adding board diagnostics overwrites an existing score or queue output.
// From the review of PR 155:
// 9. A crash of the evaluator, whose environment holds the key and base
//    URL, writes a core file outside the folder checked for leaks.
// 10. Result files leave the run through a symbolic link.
// 11. A held-out (test split) case in a saved run is converted and exported.
// 12. A modified evaluator runs while eval.json records the pinned commit.
// 13. The bench cache under the repository puts their venv in the repository.
// 14. An assume-unchanged edit or ignored file passes the checkout check
//     or a dry run starts without checking an existing evaluator.
// 15. A split or URL-encoded key reaches output; sharing a buffer between
//     stdout and stderr hides the pieces from the redactor.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, git, repoRoot } from "../lib/cases.mjs";
import { cacheRoot } from "../lib/licence.mjs";
import { endpointSecrets } from "../lib/model-env.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { RULES } from "../lib/score.mjs";
import { aacrTruth, readCase, readSuite, specCopy } from "../lib/suites.mjs";
import * as judgeRunner from "../outside/boards/aacr-judge.mjs";
import { commentOf, convertRun, filterDataset, instanceIdOf, readAacrOutside } from "../outside/convert/aacr.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "aacr-board");
const WRAPPER = join(benchRoot, "outside", "boards", "aacr.sh");
const SCORE = join(benchRoot, "score.mjs");
const BOARDS = JSON.parse(readFileSync(join(benchRoot, "outside", "boards.json"), "utf8"));
const COMMIT = BOARDS.boards.aacr.commit;

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((p) => join(dir, String(p))).filter((p) => statSync(p).isFile()) : []);

// ---------- the crafted cases and reports ----------

// The five development cases of dev-smoke, with truth written here in
// AACR-Bench's row shape (no comment text from the dataset). Each list has as
// many comments as the suite entry counts. A note has no word of three
// letters or more, so AACR's mock judge never takes it for a finding.
const SMOKE = readSuite("aacr").split.subsets["dev-smoke"];
const comment = (path, from, to, side, n) => ({ path, from_line: from, to_line: to, side, note: `${n} q7 x9`, category: "Code Defect", context: "Diff Level", is_ai_comment: false, source_model: "" });
const TRUTH = {
  "cline__cline-1808": [comment("src/core/task.ts", 10, 12, "right", 1), comment("src/core/task.ts", 14, 14, "right", 2), comment("src/core/old.ts", 5, 5, "left", 3)],
  "dotnet__aspnetcore-62936": [
    comment("src/Http/Request.cs", 20, 20, "right", 1),
    comment("src/Http/Request.cs", 22, 25, "right", 2),
    comment("src/Http/Request.cs", 40, 40, "right", 3),
    comment("src/Http/Response.cs", 1, 3, "right", 4),
    // A reversed range, as one comment in the dataset has.
    comment("src/Http/Response.cs", 102, 100, "right", 5),
  ],
  "infiniflow__ragflow-6691": [
    comment("api/db/services.py", 30, 30, "right", 1),
    comment("api/db/services.py", 31, 31, "right", 2),
    comment("api/db/services.py", 32, 32, "right", 3),
    comment("api/apps/kb_app.py", 7, 9, "right", 4),
    comment("api/apps/kb_app.py", 50, 50, "right", 5),
    comment("rag/nlp/query.py", 3, 3, "right", 6),
  ],
  "laravel__framework-56591": [comment("src/Illuminate/Support/Str.php", 7, 7, "right", 1)],
  "linera-io__linera-protocol-3151": [comment("linera-core/src/client.rs", 30, 31, "right", 1)],
};
// A committed suite entry as a case, usable or not.
const caseOf = (name) => readCase(`aacr/${name}@${readSuite("aacr").byName.get(name).hash.slice(0, 8)}`);

const finding = (file_path, line_number, extra = {}) => ({
  origin: "agent",
  severity: "major",
  category: "bug",
  confidence: 0.9,
  file_path,
  ...(line_number === undefined ? {} : { line_number, line_end: line_number }),
  title: "Index read past the end",
  description: "The loop reads one element past the array.",
  suggested_change: null,
  source: null,
  candidate: null,
  notes: [],
  problem: "The loop reads one element past the array.",
  consequence: "It throws at run time.",
  fix: "Stop the loop one element earlier.",
  ...extra,
});
const report = (findings, { outside = [], status = "complete", low = [] } = {}) => ({
  version: 1,
  kind: "review",
  verdict: "passed",
  findings,
  outside_change: outside,
  low_confidence: low,
  dropped: [],
  scanners: [],
  impact: { status: "ok", build: { durationMs: 100 } },
  completion: { status, missing: status === "complete" ? [] : ["the reviewer stopped early"], reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 1200, output_tokens: 300, cost_usd: 0.01 } } },
});

const MODEL = "model-scripted-graph-on";
const CLAUDE = "claude-graph-on";
// What each review of the crafted set saved: a report, "failed" (an attempt
// with no report), "unstarted" (no attempt at all), or "retried" (a failed
// first attempt and a second one with a finding, which never counts).
const PLAN = {
  [`${MODEL}/1`]: {
    "cline__cline-1808": report([finding("src/core/task.ts", 13), finding("src/core/task.ts", 14), finding("src/core/old.ts", 5)]),
    "dotnet__aspnetcore-62936": report([
      finding("./src/Http/Request.cs", 21),
      finding("src/Http/Request.cs", 23, { line_end: 24 }),
      finding("src/Http/Request.cs", 42),
      // No line: held with null lines.
      finding("src/Http/Response.cs", undefined),
      finding("src/Http/Response.cs", 99),
    ]),
    "infiniflow__ragflow-6691": "failed",
    "laravel__framework-56591": report([], { outside: [finding("src/Illuminate/Support/Str.php", 8)], low: [finding("src/Illuminate/Support/Str.php", 7)] }),
    "linera-io__linera-protocol-3151": report([finding("linera-core/src/client.rs", 31), finding("linera-core/src/client.rs", 30)]),
  },
  [`${CLAUDE}/1`]: {
    "cline__cline-1808": report([]),
    "dotnet__aspnetcore-62936": "unstarted",
    "infiniflow__ragflow-6691": report([finding("api/db/services.py", 31), finding("api/apps/kb_app.py", 10, { line_end: 8 }), finding("rag\\nlp\\query.py", 3)]),
    "laravel__framework-56591": report([finding("src/Illuminate/Support/Str.php", 5)]),
    "linera-io__linera-protocol-3151": report([finding("linera-core/src/client.rs", 33)]),
  },
  [`${MODEL}/2`]: {
    "cline__cline-1808": "retried",
    "dotnet__aspnetcore-62936": report([finding("src/Http/Request.cs", 20)]),
    "infiniflow__ragflow-6691": report([finding("api/db/services.py", 32)], { status: "incomplete" }),
    "laravel__framework-56591": report([finding("src/Illuminate/Support/Str.php", 7, { line_end: 9 })]),
    "linera-io__linera-protocol-3151": report([]),
  },
  [`${CLAUDE}/2`]: {
    "cline__cline-1808": report([]),
    "dotnet__aspnetcore-62936": report([]),
    "infiniflow__ragflow-6691": report([finding("api/apps/kb_app.py", 51)]),
    "laravel__framework-56591": report([]),
    "linera-io__linera-protocol-3151": report([]),
  },
};

const BUILD = { commit: "a".repeat(40), short: "aaaaaaa", dirty: false, cliVersion: "0.14.0" };

// A run folder made by the runner's own code, as run.mjs saves it: the
// manifest with every planned job, the truth copy of each case, and each
// attempt's sample.json and report.json. `specs` overrides a case's copy;
// `suite` is the suite the manifest names.
async function savedRun({ names = SMOKE, plan = PLAN, specs = {}, suite = "aacr", configs = [MODEL, CLAUDE], repeat = 2 } = {}) {
  const cases = names.map(caseOf);
  const reviewers = configs.map((c) => (c === MODEL ? "model:scripted" : "claude"));
  const { jobs } = planJobs({ cases: names, caseIds: Object.fromEntries(cases.map((c) => [c.name, c.id])), reviewers, graph: ["on"], repeat });
  const root = tempDir("oq-aacr-board-");
  const out = join(root, "run");
  for (const c of cases) write(join(root, "specs", `${c.name}.json`), `${JSON.stringify(specs[c.name] ?? specCopy(c, aacrTruth({ comments: TRUTH[c.name] ?? [] }, null)), null, 2)}\n`);
  const settings = { runId: "aacr-board-test", mode: "review", path: "server", suite, split: "dev", splitHash: cases[0].splitHash, build: BUILD, reviewers: Object.fromEntries(reviewers.map((r) => [r, { name: r }])), cases: names, caseIds: cases.map((c) => c.id), caseHashes: Object.fromEntries(cases.map((c) => [c.name, c.hash])), configs, repeat, concurrency: 1 };
  await executeRun({
    out,
    manifest: runManifest({ startedAt: "2026-10-11T10:00:00.000Z", settings, jobs }),
    jobs,
    copies: cases.map((c) => [join(root, "specs", `${c.name}.json`), join("cases", `${c.name}.json`)]),
    runJob: async (job) => {
      const saved = plan[`${job.config}/${job.repeat}`]?.[job.case] ?? report([]);
      if (saved === "unstarted") return;
      const result = { code: 0, signal: null, wallMs: 90_000 };
      const attempt = (n, rep) => {
        const dir = attemptDir(out, job, n);
        write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job, attempt: n, result, report: rep, who: null, startedAt: "t", failure: rep ? null : { cause: "no report.json" }, stopped: null })));
        if (rep) write(join(dir, "report", "report.json"), JSON.stringify(rep));
      };
      if (saved === "failed") attempt(1, null);
      else if (saved === "retried") {
        attempt(1, null);
        attempt(2, report([finding("src/core/task.ts", 11)]));
      } else attempt(1, saved);
    },
  });
  return out;
}

// Our location numbers per configuration and repeat, from the scored jobs.
function ourLineCounts(out) {
  const { jobs } = scoreRun(loadRun(out));
  const sums = {};
  for (const j of jobs) {
    const s = (sums[`${j.config}/r${j.repeat}`] ??= { matches: 0, generated: 0, expected: 0 });
    s.matches += j.location.matches;
    s.generated += j.location.generated;
    s.expected += j.location.expected;
  }
  return sums;
}

// What score.mjs --outside aacr reads back for the run, scored as score.mjs scores it.
function outsideOf(out) {
  const run = loadRun(out);
  return readAacrOutside(out, scoreRun(run).jobs, run.specs);
}

// ---------- AACR-Bench's own code, when its pinned checkout is in the cache ----------

const EVALUATION = join(cacheRoot(), "upstream", `aacr-bench@${COMMIT}`, "evaluation");
const PYTHON = join(cacheRoot(), "upstream", `aacr-bench@${COMMIT}.venv`, "bin", "python");
const live = existsSync(join(EVALUATION, "evaluate.py")) && existsSync(PYTHON);
const RECORD = process.env.AACR_BOARD_RECORD === "1";

// Their evaluate() called directly, in mock mode, on one results folder:
// the deterministic part of their evaluator (path, side, line within k)
// with the semantic stage answered by their local mock.
const DRIVER = [
  "import asyncio, json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import evaluate, schema",
  "instances = schema.load_instances(sys.argv[2])",
  "r = asyncio.run(evaluate.evaluate(instances=instances, results_dir=sys.argv[3], reviewer='ocr', output_dir=sys.argv[3], line_k=1))",
  "print(json.dumps({'summary': r['summary'], 'mode': evaluate.judge_mode_description()}))",
].join("\n");

function python(args, { cwd }) {
  const env = { ...process.env, JUDGE_USE_MOCK: "true" };
  delete env.JUDGE_API_KEY;
  delete env.JUDGE_BASE_URL;
  const r = spawnSync(PYTHON, ["-I", "-B", ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`python ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

// Their dataset converter on rows in AACR-Bench's shape for the crafted
// cases, then our filter to the run's instances.
function theirDataset(out) {
  const tmp = tempDir("oq-aacr-their-");
  const rows = SMOKE.map((n) => {
    const c = caseOf(n);
    return { githubPrUrl: c.source.prUrl, source_commit: c.materialise.baseSha, target_commit: c.materialise.headSha, change_line_count: c.changeLines, project_main_language: c.language, comments: TRUTH[n] };
  });
  write(join(tmp, "positive_samples.json"), JSON.stringify(rows));
  python([join(EVALUATION, "converters", "aacr_bench.py"), "--input", join(tmp, "positive_samples.json"), "--output", join(tmp, "aacr_bench.jsonl"), "--validate"], { cwd: tmp });
  return filterDataset(out, join(tmp, "aacr_bench.jsonl"));
}

// Relay failures, written before its code:
// 1. Removing the vLLM field rewrites another value or its JSON spelling.
// 2. The Azure key uses bearer auth or reaches a log or the saved record.
// 3. A first-call 401 or 404 runs evaluation rounds instead of exiting 2.
// 4. eval.json omits or miscounts relay requests, removals or statuses.
// 5. Azure receives temperature, top_p or max_tokens, or the rename changes its value.
// 6. The first-call error loses the upstream message or prints the key, URL or host.
// 7. A local caller without the evaluator's placeholder token spends the Azure key.

// ---------- the tests ----------

describe("a finding without a line is dropped", () => {
  it("holds a finding without a line in the comment list with null lines, counts it, and writes every shown finding once", async () => {
    const out = await savedRun();
    const { record } = convertRun(out);
    const c = caseOf("dotnet__aspnetcore-62936");
    const file = readJson(join(out, "outside", "aacr", MODEL, "r1", `${instanceIdOf(c).replace(/\//g, "__")}.json`));
    expect(file.review.comments).toHaveLength(5);
    expect(file.review.comments[3]).toMatchObject({ path: "src/Http/Response.cs", start_line: null, end_line: null });
    expect(file.review.comments[3].content).toMatch(/^Index read past the end\n/);
    // The path as our scorer reads it, and the range as our scorer reads it.
    expect(file.review.comments[0]).toMatchObject({ path: "src/Http/Request.cs", start_line: 21, end_line: 21 });
    expect(file.review.comments[1]).toMatchObject({ start_line: 23, end_line: 24 });
    expect(record.withoutLine).toEqual([{ caseId: c.id, config: MODEL, repeat: 1, index: 3 }]);
    // A finding on the change and one outside it are shown, so both are written; a low-confidence one is not shown.
    const laravel = readJson(join(out, "outside", "aacr", MODEL, "r1", `${instanceIdOf(caseOf("laravel__framework-56591"))}.json`));
    expect(laravel.review.comments).toEqual([expect.objectContaining({ path: "src/Illuminate/Support/Str.php", start_line: 8, end_line: 8 })]);
  });
});

describe("a sample on a case outside AACR-Bench is converted for the board", () => {
  it("refuses a run of another suite before writing anything", async () => {
    const out = await savedRun();
    const manifest = readJson(join(out, "manifest.json"));
    write(join(out, "manifest.json"), JSON.stringify({ ...manifest, suite: "planted", jobs: manifest.jobs.map((j) => ({ ...j, caseId: j.caseId.replace(/^aacr\//, "planted/") })) }));
    expect(() => convertRun(out)).toThrow(/planted.*not aacr|not an AACR-Bench run/s);
    expect(existsSync(join(out, "outside"))).toBe(false);
  });

  it("refuses a sample folder whose case is not an AACR-Bench case", async () => {
    const out = await savedRun();
    const stray = join(out, "samples", "flask-path-traversal", MODEL, "1");
    write(join(stray, "sample.json"), JSON.stringify({ case: "flask-path-traversal", config: MODEL, repeat: 1, attempt: 1 }));
    expect(() => convertRun(out)).toThrow(/flask-path-traversal/);
    expect(existsSync(join(out, "outside"))).toBe(false);
  });
});

describe("a failed or never-started review vanishes from AACR's denominators", () => {
  it("writes a result file for every planned review's first attempt: empty for a failed or unstarted one, and never the retry", async () => {
    const out = await savedRun();
    const { record } = convertRun(out);
    const dir = (config, r) => join(out, "outside", "aacr", config, `r${r}`);
    for (const [config, r] of [[MODEL, 1], [CLAUDE, 1], [MODEL, 2], [CLAUDE, 2]]) {
      expect(readdirSync(dir(config, r)).filter((f) => f.endsWith(".json")).sort()).toEqual(SMOKE.map((n) => `${instanceIdOf(caseOf(n))}.json`).sort());
    }
    const at = (config, r, name) => readJson(join(dir(config, r), `${instanceIdOf(caseOf(name))}.json`));
    expect(at(MODEL, 1, "infiniflow__ragflow-6691")).toMatchObject({ review: { comments: [] }, openqodex: { status: "failed", tool: `openqodex-${MODEL}-r1` } });
    expect(at(CLAUDE, 1, "dotnet__aspnetcore-62936")).toMatchObject({ review: { comments: [] }, openqodex: { status: "unstarted" } });
    expect(at(MODEL, 2, "cline__cline-1808")).toMatchObject({ review: { comments: [] }, openqodex: { status: "failed", attempt: 1 } });
    expect(at(MODEL, 2, "infiniflow__ragflow-6691")).toMatchObject({ openqodex: { status: "incomplete" } });
    expect(at(MODEL, 2, "infiniflow__ragflow-6691").review.comments).toHaveLength(1);
    expect(record.folders.map((f) => [f.config, f.repeat, f.files])).toEqual([[CLAUDE, 1, 5], [CLAUDE, 2, 5], [MODEL, 1, 5], [MODEL, 2, 5]]);
  });

  it("refuses to convert a run twice into the same folder", async () => {
    const out = await savedRun();
    convertRun(out);
    expect(() => convertRun(out)).toThrow(/already/);
  });
});

describe("a case whose licence nobody verified is converted for a board", () => {
  // A licence record as the ingest writes it for a repository whose licence
  // file the licence API cannot name: class unverified, used and published in full,
  // but refused for a board; unknown, the class before that; and for one
  // with no licence file, class none.
  const licence = (cls) => ({ spdx: cls === "none" ? null : "NOASSERTION", chosen: null, class: cls, file: cls === "none" ? null : "LICENSE.txt", fileSha256: null, at: "the default branch on 2026-10-11", source: "the licence API", use: "local review and scoring", excerpts: "omit" });

  it.each(["unverified", "unknown", "none"])("refuses a run holding a case whose licence class is %s, naming the case, and writes nothing", async (cls) => {
    const [name, other] = SMOKE;
    const c = caseOf(name);
    const spec = specCopy(c, aacrTruth({ comments: TRUTH[name] }, null));
    const out = await savedRun({ names: [name, other], plan: {}, specs: { [name]: { ...spec, source: { ...spec.source, licence: licence(cls) } } }, configs: [MODEL], repeat: 1 });
    const refusal = (() => {
      try {
        convertRun(out);
      } catch (error) {
        return error.message;
      }
      return null;
    })();
    expect(refusal).toContain(name);
    expect(refusal).not.toContain(other);
    expect(refusal).toMatch(/never converted for a board/);
    expect(existsSync(join(out, "outside"))).toBe(false);
  });
});

describe("the wrapper echoes the judge's key or base URL", () => {
  const KEY = `fake-judge-key-${randomBytes(16).toString("hex")}`;
  const BASE = `https://fake-judge-${randomBytes(4).toString("hex")}.example.test/openai/v1`;
  const dryRun = (out, extraEnv = {}) => {
    const home = tempDir("oq-aacr-wrapper-");
    const settings = join(home, "azure.env");
    writeFileSync(settings, `AZURE_OPENAI_BASE_URL=${BASE}\nAZURE_OPENAI_KEY=${KEY}\n`);
    const tmp = join(home, "tmp");
    mkdirSync(tmp);
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OPENQODEX_BENCH_MODEL_ENV: settings, TMPDIR: tmp, ...extraEnv };
    delete env.JUDGE_USE_MOCK;
    Object.assign(env, extraEnv);
    // bash -x prints every command bash runs, with its expanded arguments.
    const r = spawnSync("bash", ["-x", WRAPPER, out, "--dry-run", "--rounds", "3"], { encoding: "utf8", env, timeout: 120_000 });
    return { ...r, tmp };
  };

  it("keeps a static guard: set -u, no trace, no environment dump", () => {
    const text = readFileSync(WRAPPER, "utf8");
    expect(text).toMatch(/^set -euo pipefail$/m);
    expect(text).toMatch(/^ulimit -c 0$/m);
    expect(text).not.toMatch(/set -[a-z]*x|set -o xtrace|\bprintenv\b|\bexport -p\b|\bdeclare -p\b|^\s*env\s*$|\$JUDGE_API_KEY|\$\{JUDGE_API_KEY/m);
  });

  it("leaves nothing of the key, the base URL or its host in its output or any file, even traced by bash -x", async () => {
    const out = await savedRun();
    const r = dryRun(out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/JUDGE_MODEL=gpt-5\.2/);
    expect(r.stdout).toMatch(/loopback relay for JUDGE_BASE_URL with a random placeholder JUDGE_API_KEY/);
    expect(r.stdout).toMatch(/left-side references/);
    // A crash of the evaluator, whose environment holds both, leaves no core file.
    expect(r.stdout).toMatch(/core file limit for the evaluator: 0\b/);
    const secrets = endpointSecrets(BASE, KEY);
    const leaks = [];
    for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ...[...filesUnder(out), ...filesUnder(r.tmp)].map((p) => [p, readFileSync(p, "utf8")])]) {
      for (const s of secrets) if (text.includes(s)) leaks.push(`${where} holds ${s === KEY ? "the key" : "the base URL or its host"}`);
    }
    expect(leaks).toEqual([]);
  });

  it("gives the evaluator a core file limit of zero though its parent allows core files", async () => {
    const out = await savedRun();
    convertRun(out);
    const home = tempDir("oq-aacr-core-");
    writeFileSync(join(home, "azure.env"), `AZURE_OPENAI_BASE_URL=${BASE}\nAZURE_OPENAI_KEY=${KEY}\n`);
    const env = { ...process.env, OPENQODEX_BENCH_MODEL_ENV: join(home, "azure.env") };
    delete env.JUDGE_USE_MOCK;
    // Node cannot set a resource limit, so a shell raises the parent's soft limit before it becomes the launcher.
    const raise = 'ulimit -S -c unlimited 2>/dev/null; echo "parent core file limit: $(ulimit -c)"; exec "$0" "$@"';
    const r = spawnSync("/bin/sh", ["-c", raise, process.execPath, join(benchRoot, "outside", "boards", "aacr-judge.mjs"), out, "--dry-run", "--evaluation", join(home, "none"), "--python", join(home, "none", "python")], { encoding: "utf8", env, timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/parent core file limit: unlimited/);
    expect(r.stdout).toMatch(/core file limit for the evaluator: 0\b/);
  });

  it("refuses to run when the mock judge is asked for", async () => {
    const out = await savedRun();
    const r = dryRun(out, { JUDGE_USE_MOCK: "true" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/JUDGE_USE_MOCK.*mock/s);
  });
});

describe("AACR's mock judge scores a run as if a model judged it", () => {
  it("reports AACR's line numbers but no semantic numbers for an evaluation the wrapper did not run with a judge", async () => {
    const out = await savedRun();
    convertRun(out);
    copyRecordedMetrics(out);
    const run = loadRun(out);
    const { jobs } = scoreRun(run);
    const block = readAacrOutside(out, jobs, run.specs);
    for (const config of [MODEL, CLAUDE]) {
      for (const r of block.byConfig[config].repeats) {
        expect(r.semantic).toBeNull();
        expect(r.judged).toBe(false);
        expect(r.why).toMatch(/no judged evaluation/);
      }
      expect(block.byConfig[config].mean.semantic).toBeNull();
    }
    // A wrapper record that says the mock judge answered, or that judge calls failed, reports no semantic numbers either.
    for (const folder of [{ mode: "mock", judgeErrors: 0 }, { mode: "llm", judgeErrors: 2 }]) {
      const evalRecord = { version: 1, board: "aacr", commit: COMMIT, judge: { deployment: "gpt-5.2" }, rounds: 1, folders: block.folders.map((f) => ({ config: f.config, repeat: f.repeat, metrics: f.metrics, ...folder })) };
      write(join(out, "outside", "aacr", "eval.json"), JSON.stringify(evalRecord));
      const again = readAacrOutside(out, jobs, run.specs);
      expect(again.byConfig[MODEL].repeats.every((r) => r.semantic === null && r.judged === false)).toBe(true);
      expect(again.byConfig[MODEL].repeats[0].why).toMatch(folder.mode === "mock" ? /mock/ : /2 judge calls failed/);
    }
  });
});

describe("the diagnostics change score.json's own fields or the rules hash", () => {
  it("adds only outside.aacr: every other field of score.json is the same with and without --outside aacr", async () => {
    const out = await savedRun();
    convertRun(out);
    copyRecordedMetrics(out);
    const plain = tempDir("oq-aacr-score-");
    const withOutside = tempDir("oq-aacr-score-");
    const run = (args) => spawnSync(process.execPath, [SCORE, out, ...args], { encoding: "utf8", timeout: 120_000 });
    expect(run(["--out", plain]).status).toBe(0);
    const r = run(["--out", withOutside, "--outside", "aacr"]);
    expect(r.status, r.stderr).toBe(0);
    const a = readJson(join(plain, "score.json"));
    const saved = readFileSync(join(withOutside, "score.json"), "utf8");
    expect(saved).not.toContain("/Users/");
    expect(saved).not.toContain(homedir());
    const b = JSON.parse(saved);
    expect(a.outside).toBeUndefined();
    expect(b.outside.aacr.board).toMatchObject({ repo: "alibaba/aacr-bench", commit: COMMIT });
    const rest = { ...b };
    delete rest.outside;
    expect(rest).toEqual(a);
    expect(b.rules).toEqual(RULES);
    const existing = { ...a, rules: { ...a.rules, code: "the reviewed scorer" } };
    write(join(out, "score.json"), `${JSON.stringify(existing, null, 2)}\n`);
    write(join(out, "outcomes.jsonl"), "reviewed outcomes\n");
    write(join(out, "unresolved.jsonl"), "reviewed queue\n");
    expect(run(["--outside", "aacr"]).status).toBe(0);
    const refreshed = readJson(join(out, "score.json"));
    delete refreshed.outside;
    expect(refreshed).toEqual(existing);
    expect(readFileSync(join(out, "outcomes.jsonl"), "utf8")).toBe("reviewed outcomes\n");
    expect(readFileSync(join(out, "unresolved.jsonl"), "utf8")).toBe("reviewed queue\n");
    expect(readFileSync(join(plain, "outcomes.jsonl"), "utf8")).toBe(readFileSync(join(withOutside, "outcomes.jsonl"), "utf8"));
    expect(r.stdout).toMatch(/AACR-Bench's own evaluator/);
  });
});

describe("our line count differs from AACR's on the same reports", () => {
  const recorded = existsSync(join(FIXTURES, "line-counts.json")) ? readJson(join(FIXTURES, "line-counts.json")) : null;

  it("gives, on the crafted set over 5 development cases, the line counts AACR-Bench's evaluator recorded on the same files", async () => {
    expect(recorded, "fixtures/aacr-board/line-counts.json is recorded from their evaluator").not.toBeNull();
    expect(recorded.commit).toBe(COMMIT);
    const out = await savedRun();
    convertRun(out);
    const ours = ourLineCounts(out);
    const theirs = Object.fromEntries(recorded.folders.map((f) => [`${f.config}/r${f.repeat}`, { matches: f.summary.matched_line_notes, generated: f.summary.generated_notes, expected: f.summary.expected_notes }]));
    expect(ours).toEqual(theirs);
    // Their evaluator read every file: no instance missing, and the format gave it every finding (not zero).
    for (const f of recorded.folders) expect(f.summary).toMatchObject({ evaluated_instances: 5, missing_instances: 0, matched_semantic_notes: 0 });
    expect(recorded.folders.reduce((n, f) => n + f.summary.generated_notes, 0)).toBe(20);
    // score.mjs --outside aacr reads their recorded files and finds them equal to ours.
    copyRecordedMetrics(out);
    const block = outsideOf(out);
    expect(block.folders.every((f) => f.lineEqual === true)).toBe(true);
    // Each case's references once: 16 accepted comments, one of them on the left side.
    expect(block.references).toEqual({ total: 16, left: 1, share: 1 / 16 });
  });

  it.skipIf(!live)(`runs AACR-Bench's own converter and evaluator at ${COMMIT.slice(0, 7)} (mock judge) on the converted files, and gets the recorded counts (needs their checkout from aacr.sh --prepare; skipped without it)`, async () => {
    const out = await savedRun();
    convertRun(out);
    const { instances } = theirDataset(out);
    expect(instances).toBe(5);
    const folders = [];
    for (const [config, repeat] of [[CLAUDE, 1], [CLAUDE, 2], [MODEL, 1], [MODEL, 2]]) {
      const dir = join(out, "outside", "aacr", config, `r${repeat}`);
      const r = JSON.parse(python(["-c", DRIVER, EVALUATION, join(out, "outside", "aacr", "dataset.jsonl"), dir], { cwd: tempDir("oq-aacr-cwd-") }).trim().split("\n").at(-1));
      expect(r.mode).toMatch(/Mock/);
      folders.push({ config, repeat, summary: r.summary, metrics: readdirSync(dir).find((f) => /^metrics_ocr_.*\.json$/.test(f)) });
    }
    const counts = (f) => ({ matches: f.summary.matched_line_notes, generated: f.summary.generated_notes, expected: f.summary.expected_notes });
    expect(Object.fromEntries(folders.map((f) => [`${f.config}/r${f.repeat}`, counts(f)]))).toEqual(ourLineCounts(out));
    for (const f of folders) expect(f.summary.matched_semantic_notes).toBe(0);
    if (RECORD) {
      write(join(FIXTURES, "line-counts.json"), `${JSON.stringify({ commit: COMMIT, judge: "mock (their local similarity), which matched no note", folders: folders.map(({ config, repeat, summary }) => ({ config, repeat, summary })) }, null, 2)}\n`);
      for (const f of folders) {
        const metrics = readJson(join(out, "outside", "aacr", f.config, `r${f.repeat}`, f.metrics));
        metrics.ex_info.results_dir = "<results>";
        metrics.ex_info.start_time = "2026-10-11T00:00:00";
        write(join(FIXTURES, "metrics", `${f.config}-r${f.repeat}.json`), `${JSON.stringify(metrics, null, 2)}\n`);
      }
    } else {
      for (const f of folders) expect(f.summary).toEqual(recorded.folders.find((x) => x.config === f.config && x.repeat === f.repeat).summary);
    }
  });
});

describe("the wrapper runs their evaluation stage with a model as judge", () => {
  // A model provider on this machine (the one stand-in the tests allow) in
  // the shape their judge calls: it says yes only when the reference
  // comment is the second of its pull request, and records what it got.
  async function fakeJudge({ status = 200, echo = false } = {}) {
    const seen = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const request = JSON.parse(body);
        const prompt = request.messages?.[0]?.content ?? "";
        const reference = /Review Comment 1:\n([\s\S]*?)\n\nReview Comment 2:/.exec(prompt)?.[1] ?? "";
        seen.push({ body, path: req.url, authorization: req.headers.authorization ?? null, apiKey: req.headers["api-key"] ?? null, request: { ...request, messages: undefined } });
        res.writeHead(status, { "content-type": "application/json" });
        if (echo) return res.end(req.headers["api-key"] ?? "missing key");
        if (status !== 200) return res.end(JSON.stringify({ error: { message: `Unsupported parameter\nkey ${req.headers["api-key"]}, URL http://${req.headers.host}/v1, host ${req.headers.host}` } }));
        res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: request.model, choices: [{ index: 0, message: { role: "assistant", content: reference.startsWith("2 ") ? "yes" : "no" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise((up) => server.listen(0, "127.0.0.1", up));
    return { seen, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((down) => server.close(down)) };
  }

  it("relay parameter changes preserve every other body byte", async () => {
    const provider = await fakeJudge();
    const relay = await judgeRunner.startRelay({ baseUrl: provider.base, apiKey: "test-key", authHeader: "api-key" });
    const kept = '"model":"gpt-5.2", "messages":[{"role":"user","content":"a, } \\"quoted\\" chat_template_kwargs"}], "nested":{"chat_template_kwargs":true,"temperature":0.7,"top_p":0.95,"max_tokens":40000}';
    try {
      for (const [body, expected] of [
        [`{${kept},"chat_template_kwargs":{"enable_thinking":false}}`, `{${kept}}`],
        [`{"chat_template_kwargs":{"enable_thinking":false},${kept}}`, `{${kept}}`],
        ['{"model":"gpt-5.2","chat_template_kwargs":{}, "messages":[]}', '{"model":"gpt-5.2", "messages":[]}'],
        [`{${kept}}`, `{${kept}}`],
        [`{"temperature":7e-1,${kept},"top_p":0.95,"max_tokens":40000}`, `{${kept},"max_completion_tokens":40000}`],
      ]) {
        const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body });
        expect(response.status).toBe(200);
        await response.text();
        expect(provider.seen.at(-1).body).toBe(expected);
      }
      expect(relay.counts()).toEqual({ relay: true, requests: 5, stripped: 3, parameterChanges: { chat_template_kwargs: 3, temperature: 1, top_p: 1, max_tokens: 1 }, upstreamStatuses: { 200: 5 } });
    } finally {
      await relay.close();
      await provider.close();
    }
  });

  it("relay refuses a caller without the evaluator's placeholder token and never forwards it", async () => {
    const provider = await fakeJudge();
    const relay = await judgeRunner.startRelay({ baseUrl: provider.base, apiKey: "test-key", authHeader: "api-key" });
    const body = JSON.stringify({ model: "gpt-5.2", messages: [] });
    try {
      for (const headers of [{}, { authorization: `Bearer ${randomBytes(32).toString("hex")}` }, { authorization: relay.apiKey }, { authorization: `Bearer ${relay.apiKey}x` }, { "api-key": relay.apiKey }]) {
        const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers, body });
        expect(response.status).toBe(401);
        await response.text();
      }
      expect(provider.seen).toEqual([]);
      expect(relay.counts()).toMatchObject({ requests: 0, upstreamStatuses: {} });
      const allowed = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${relay.apiKey}` }, body });
      expect(allowed.status).toBe(200);
      await allowed.text();
      expect(provider.seen).toHaveLength(1);
    } finally {
      await relay.close();
      await provider.close();
    }
  });

  it("relay sends api-key and keeps it out of the evaluator log", async () => {
    const key = `fake-relay-key-${randomBytes(16).toString("hex")}`;
    const provider = await fakeJudge({ echo: true });
    const relay = await judgeRunner.startRelay({ baseUrl: provider.base, apiKey: key, authHeader: "api-key" });
    const dir = tempDir("oq-aacr-relay-log-");
    try {
      const script = 'const r = await fetch(process.env.JUDGE_BASE_URL + "/chat/completions", {method:"POST", headers:{authorization:"Bearer " + process.env.JUDGE_API_KEY}, body:JSON.stringify({model:"gpt-5.2",messages:[]})}); console.log(await r.text());';
      const result = await judgeRunner.run(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, env: { ...process.env, JUDGE_BASE_URL: relay.baseUrl, JUDGE_API_KEY: relay.apiKey }, log: join(dir, "eval.log"), secrets: endpointSecrets(provider.base, key) });
      expect(result.code).toBe(0);
      expect(provider.seen[0]).toMatchObject({ apiKey: key, authorization: null });
      expect(relay.apiKey).not.toBe(key);
      expect(readFileSync(join(dir, "eval.log"), "utf8")).toBe("[hidden]\n");
      expect(JSON.stringify(relay.counts())).not.toContain(key);
    } finally {
      await relay.close();
      await provider.close();
    }
  });

  it.skipIf(!live)("relay first-call failure carries the upstream message with secrets hidden and stops before round 1", async () => {
    for (const status of [400, 401, 404]) {
      const out = await savedRun();
      convertRun(out);
      write(join(out, "outside", "aacr", "dataset.jsonl"), "");
      const provider = await fakeJudge({ status });
      const home = tempDir("oq-aacr-relay-refused-");
      write(join(home, "azure.env"), `AZURE_OPENAI_BASE_URL=${provider.base}\nAZURE_OPENAI_KEY=test-key\n`);
      const env = { ...process.env, OPENQODEX_BENCH_MODEL_ENV: join(home, "azure.env") };
      delete env.JUDGE_USE_MOCK;
      try {
        const r = await new Promise((done) => {
          const child = spawn(process.execPath, [join(benchRoot, "outside", "boards", "aacr-judge.mjs"), out, "--evaluation", EVALUATION, "--python", PYTHON], { env });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (c) => (stdout += c));
          child.stderr.on("data", (c) => (stderr += c));
          child.on("close", (code) => done({ code, stdout, stderr }));
        });
        expect(r).toEqual({ code: 2, stdout: "", stderr: `AACR judge relay: upstream returned ${status} on the first call: Unsupported parameter key [hidden], URL [hidden], host [hidden]; stopped before round 1\n` });
        expect(provider.seen).toHaveLength(1);
        expect(existsSync(join(out, "outside", "aacr", "eval.json"))).toBe(false);
        expect(filesUnder(join(out, "outside", "aacr")).some((p) => p.endsWith("eval.log"))).toBe(false);
      } finally {
        await provider.close();
      }
    }
  });

  it.skipIf(!live)("relay counts reach eval.json without the key (needs their checkout; skipped without it)", async () => {
    const out = await savedRun();
    convertRun(out);
    theirDataset(out);
    const judge = await fakeJudge();
    const key = `fake-judge-key-${randomBytes(16).toString("hex")}`;
    const home = tempDir("oq-aacr-judged-");
    writeFileSync(join(home, "azure.env"), `AZURE_OPENAI_BASE_URL=${judge.base}\nAZURE_OPENAI_KEY=${key}\n`);
    const env = { ...process.env, OPENQODEX_BENCH_MODEL_ENV: join(home, "azure.env"), TMPDIR: home };
    delete env.JUDGE_USE_MOCK;
    const r = await new Promise((done) => {
      const child = spawn(process.execPath, [join(benchRoot, "outside", "boards", "aacr-judge.mjs"), out, "--rounds", "1", "--evaluation", EVALUATION, "--python", PYTHON], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    await judge.close();
    expect(r.status, r.stderr).toBe(0);
    const record = readJson(join(out, "outside", "aacr", "eval.json"));
    expect(record).toMatchObject({ commit: COMMIT, checkout: { commit: COMMIT, tree: expect.stringMatching(/^[0-9a-f]{40}$/) }, rounds: 1, judge: { deployment: "gpt-5.2" } });
    expect(record.folders.map((f) => [f.config, f.repeat, f.mode, f.judgeErrors, f.metrics.length])).toEqual([[CLAUDE, 1, "llm", 0, 1], [CLAUDE, 2, "llm", 0, 1], [MODEL, 1, "llm", 0, 1], [MODEL, 2, "llm", 0, 1]]);
    // The relay sends Azure auth to the chat completions path, naming the judge deployment.
    expect(judge.seen.length).toBeGreaterThan(0);
    expect(judge.seen.every((s) => s.path === "/v1/chat/completions" && s.authorization === null && s.apiKey === key && s.request.model === "gpt-5.2")).toBe(true);
    // Azure receives the original token limit under its reasoning model parameter.
    expect(judge.seen.every((s) => s.request.max_completion_tokens === 40000)).toBe(true);
    expect(judge.seen.every((s) => ["chat_template_kwargs", "temperature", "top_p", "max_tokens"].every((name) => !(name in s.request)))).toBe(true);
    expect(record.relay).toEqual({ relay: true, requests: judge.seen.length, stripped: judge.seen.length, parameterChanges: { chat_template_kwargs: judge.seen.length, temperature: judge.seen.length, top_p: judge.seen.length, max_tokens: judge.seen.length }, upstreamStatuses: { 200: judge.seen.length } });
    const leaks = [["stdout", r.stdout], ["stderr", r.stderr], ...filesUnder(out).map((p) => [p, readFileSync(p, "utf8")])].filter(([, text]) => endpointSecrets(judge.base, key).some((s) => text.includes(s)));
    expect(leaks.map(([where]) => where)).toEqual([]);
    // Semantic numbers are reported now. Their line count drops below ours where the judge's yes on a
    // comment an earlier reference took by line ends a reference's search (two references in model r1).
    const block = outsideOf(out);
    expect(block.folders.map((f) => [f.config, f.repeat, f.judged, f.rounds[0].semanticMatches, f.rounds[0].lineMatches, f.ours.matches, f.lineEqual])).toEqual([
      [CLAUDE, 1, true, 1, 3, 3, true],
      [CLAUDE, 2, true, 0, 1, 1, true],
      [MODEL, 1, true, 2, 6, 8, false],
      [MODEL, 2, true, 1, 3, 3, true],
    ]);
    expect(block.byConfig[CLAUDE].mean.semantic).not.toBeNull();
  });
});

describe("result files leave the run through a symbolic link", () => {
  it("refuses to convert when <run>/outside leads out of the run, and writes nothing there", async () => {
    const out = await savedRun();
    const elsewhere = tempDir("oq-aacr-elsewhere-");
    symlinkSync(elsewhere, join(out, "outside"));
    expect(() => convertRun(out)).toThrow(/outside the run/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses to write the dataset when outside/aacr was replaced by a link out of the run", async () => {
    const out = await savedRun();
    convertRun(out);
    const elsewhere = tempDir("oq-aacr-elsewhere-");
    renameSync(join(out, "outside", "aacr"), join(elsewhere, "aacr"));
    symlinkSync(join(elsewhere, "aacr"), join(out, "outside", "aacr"));
    write(join(elsewhere, "theirs.jsonl"), "");
    expect(() => filterDataset(out, join(elsewhere, "theirs.jsonl"))).toThrow(/outside the run/);
    expect(existsSync(join(elsewhere, "aacr", "dataset.jsonl"))).toBe(false);
  });
});

describe("a held-out case in a saved run is converted and exported", () => {
  it("refuses a run holding a held-out (test split) case, naming it, and writes nothing", async () => {
    const suite = readSuite("aacr");
    const name = suite.split.cases.test.find((n) => suite.byName.get(n)?.status === "usable");
    const c = caseOf(name);
    expect(c.split).toBe("test");
    const comments = Array.from({ length: c.truthCount.accepted }, (_, i) => comment("src/x.java", 10 * (i + 1), 10 * (i + 1), "right", i + 1));
    const out = await savedRun({ names: [name, SMOKE[0]], plan: {}, specs: { [name]: specCopy(c, aacrTruth({ comments }, null)) }, configs: [MODEL], repeat: 1 });
    const refusal = (() => {
      try {
        convertRun(out);
      } catch (error) {
        return error.message;
      }
      return null;
    })();
    expect(refusal).toContain(name);
    expect(refusal).toMatch(/held out/);
    expect(refusal).not.toContain(SMOKE[0]);
    expect(existsSync(join(out, "outside"))).toBe(false);
  });
});

describe("a modified evaluator runs while eval.json records the pinned commit", () => {
  it("names an edited file, a staged one and an untracked one in the checkout, and gives the commit and tree of a clean one", () => {
    const dir = tempDir("oq-aacr-checkout-");
    git(dir, "init", "-q");
    write(join(dir, "evaluation", "evaluate.py"), "print('pinned')\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "pinned");
    const clean = { commit: git(dir, "rev-parse", "HEAD").trim(), tree: git(dir, "rev-parse", "HEAD^{tree}").trim(), problems: [] };
    expect(judgeRunner.checkoutState(dir)).toEqual(clean);
    write(join(dir, "evaluation", "evaluate.py"), "print('patched')\n");
    expect(judgeRunner.checkoutState(dir).problems.join(" ")).toMatch(/evaluation\/evaluate\.py/);
    git(dir, "add", "-A");
    expect(judgeRunner.checkoutState(dir).problems.join(" ")).toMatch(/evaluation\/evaluate\.py/);
    git(dir, "reset", "-q", "--hard");
    expect(judgeRunner.checkoutState(dir)).toEqual(clean);
    write(join(dir, "evaluation", "json.py"), "raise SystemExit\n");
    expect(judgeRunner.checkoutState(dir).problems.join(" ")).toMatch(/evaluation\/json\.py/);
  });
});

describe("the bench cache under the repository puts their venv in the repository", () => {
  it("refuses, in one line and creating nothing, a cache whose real path is inside the repository", () => {
    const inside = join(repoRoot, `.oq-aacr-cache-test-${randomBytes(4).toString("hex")}`);
    const link = join(tempDir("oq-aacr-cache-link-"), "cache");
    symlinkSync(join(repoRoot, "benchmark", "suites"), link);
    const before = readdirSync(join(repoRoot, "benchmark", "suites"));
    for (const cache of [inside, link]) {
      const r = spawnSync("bash", [WRAPPER, "--prepare"], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OPENQODEX_BENCH_CACHE: cache }, timeout: 60_000 });
      expect(r.status).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).toMatch(/inside the repository/);
    }
    expect(existsSync(inside)).toBe(false);
    expect(readdirSync(join(repoRoot, "benchmark", "suites"))).toEqual(before);
  });
});

// Their recorded metrics files, put where their evaluator writes them.
function copyRecordedMetrics(out) {
  for (const name of readdirSync(join(FIXTURES, "metrics"))) {
    const [, config, repeat] = /^(.*)-r(\d+)\.json$/.exec(name);
    cpSync(join(FIXTURES, "metrics", name), join(out, "outside", "aacr", config, `r${repeat}`, "metrics_ocr_20261011_000000.json"));
  }
}

describe("an edit hidden from git runs as the pinned evaluator", () => {
  it("refuses an assume-unchanged edit on a dry run and names an ignored file", async () => {
    const dir = tempDir("oq-aacr-hidden-");
    git(dir, "init", "-q");
    write(join(dir, ".gitignore"), "*.pth\n");
    write(join(dir, "evaluation", "evaluate.py"), "print('pinned')\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "pinned");
    git(dir, "update-index", "--assume-unchanged", "evaluation/evaluate.py");
    write(join(dir, "evaluation", "evaluate.py"), "print('patched')\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(judgeRunner.checkoutState(dir).problems.join(" ")).toMatch(/differ[^;]*evaluate\.py/);
    const out = await savedRun();
    convertRun(out);
    await expect(judgeRunner.main([out, "--dry-run", "--evaluation", join(dir, "evaluation"), "--python", process.execPath])).rejects.toThrow(/differ[^;]*evaluate\.py/);
    expect(existsSync(join(out, "outside", "aacr", "eval.json"))).toBe(false);
    git(dir, "update-index", "--no-assume-unchanged", "evaluation/evaluate.py");
    git(dir, "checkout", "--", ".");
    write(join(dir, "evaluation", "patch.pth"), "import os\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(judgeRunner.checkoutState(dir).problems.join(" ")).toMatch(/not in the pinned tree[^;]*patch\.pth/);
  });
});

describe("a split or encoded key reaches AACR output", () => {
  it("redacts split keys and encoded URLs at every chunk size", () => {
    const key = "synthetic-key-abcdefghijklmnopqrstuvwxyz";
    const base = "https://synthetic.example.test/v1";
    const secrets = endpointSecrets(base, key);
    const line = `key ${key} encoded ${encodeURIComponent(base)}\nplain text\n`;
    for (const size of [1, 2, 3, 7, 13, 64, line.length]) {
      let text = "";
      const filter = judgeRunner.redactor(secrets, (t) => (text += t));
      for (let i = 0; i < line.length; i += size) filter.write(Buffer.from(line.slice(i, i + size)));
      filter.end();
      expect(text).toBe("key [hidden] encoded [hidden]\nplain text\n");
    }
  });

  it("keeps stderr from interrupting a split key on stdout in the evaluator log", async () => {
    const key = "synthetic-key-abcdefghijklmnopqrstuvwxyz";
    const dir = tempDir("oq-aacr-streams-");
    const log = join(dir, "eval.log");
    const script = `process.stdout.write(${JSON.stringify(key.slice(0, 12))}); setTimeout(() => { process.stderr.write("progress\\n"); setTimeout(() => process.stdout.write(${JSON.stringify(key.slice(12) + '\n')}), 50); }, 50);`;
    const result = await judgeRunner.run(process.execPath, ["-e", script], { cwd: dir, env: process.env, log, secrets: [key] });
    expect(result.code).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("[hidden]");
    expect(text).toContain("progress\n");
    expect(text).not.toContain(key.slice(0, 12));
    expect(text).not.toContain(key.slice(12));
  });
});

// H1 failures, written before the converter rule:
// 1. A test request survives conversion or its left-out count is missing.
// 2. A non-test finding changes, or a test-related bug is removed by title alone.
// 3. Turning the board flag off still drops a finding.
// 4. score.mjs --outside aacr reads a run converted with the flag as
//    differing from ours, or the allowance hides a finding lost on the way.
describe("board conversion drops the wrong findings", () => {
  const name = "cline__cline-1808";
  const gap = finding("src/core/task.ts", 13, { category: "maintainability", title: "Changed behaviour has no covering test" });
  const bug = finding("src/core/task.ts", 14, { title: "Missing test fixture crashes the loader" });
  const ordinary = finding("src/core/task.ts", 15);
  const plan = { [`${MODEL}/1`]: { [name]: report([gap, bug, ordinary], { outside: [gap] }) } };
  const comments = (out) => readJson(join(out, "outside", "aacr", MODEL, "r1", `${instanceIdOf(caseOf(name))}.json`)).review.comments;

  it("leaves out test requests and records their count without changing other comments", async () => {
    const out = await savedRun({ names: [name], configs: [MODEL], repeat: 1, plan });
    const { record } = convertRun(out);
    expect(comments(out)).toEqual([commentOf(bug), commentOf(ordinary)]);
    expect(record.leftOutTestGaps).toBe(2);
    expect(record.folders[0]).toMatchObject({ comments: 2, leftOutTestGaps: 2 });
    expect(loadRun(out).attempts[0].report.findings).toEqual([gap, bug, ordinary]);
  });

  it("keeps every shown finding when the board flag is off", async () => {
    const out = await savedRun({ names: [name], configs: [MODEL], repeat: 1, plan });
    const { record } = convertRun(out, { excludeTestGaps: false });
    expect(comments(out)).toEqual([gap, bug, ordinary, gap].map(commentOf));
    expect(record.leftOutTestGaps).toBe(0);
    expect(record.folders[0]).toMatchObject({ comments: 4, leftOutTestGaps: 0 });
  });
});

describe("the line-count check misreads a run whose test gaps were left out", () => {
  it("finds their counts equal to ours on the converted set, and still differ when a finding is missing", async () => {
    const name = "cline__cline-1808";
    // The test gap sits on the first reference's lines, so leaving it out lowers the line matches, not only the count.
    const gap = finding("src/core/task.ts", 11, { category: "maintainability", title: "Changed behaviour has no covering test" });
    const plan = { [`${MODEL}/1`]: { [name]: report([gap, finding("src/core/task.ts", 14)]) } };
    const out = await savedRun({ names: [name], configs: [MODEL], repeat: 1, plan });
    convertRun(out);
    // The summary their evaluator at the pinned commit gives on the converted file (checked with their code, mock judge).
    const theirs = (generated, matched) => write(join(out, "outside", "aacr", MODEL, "r1", "metrics_ocr_20261013_000000.json"), JSON.stringify({ summary: { evaluated_instances: 1, missing_instances: 0, expected_notes: 3, generated_notes: generated, matched_line_notes: matched, matched_semantic_notes: 0 } }));
    theirs(1, 1);
    const block = outsideOf(out);
    expect(block.problems).toEqual([]);
    expect(block.folders[0]).toMatchObject({ ours: { matches: 1, generated: 1, expected: 3 }, lineEqual: true });
    // Our own score still counts both findings and both line matches.
    expect(scoreRun(loadRun(out)).jobs[0].location).toMatchObject({ matches: 2, generated: 2 });
    // A finding lost on the way: their evaluator read no comment.
    theirs(0, 0);
    const lost = outsideOf(out);
    expect(lost.folders[0].lineEqual).toBe(false);
    expect(lost.problems).toEqual([expect.stringMatching(/differ from ours \(1 of 1, 3 expected\)/)]);
  });
});
