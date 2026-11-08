// What benchmark/test/martian-board.test.mjs builds its runs from, kept apart
// so that recording the fixture's pipeline outputs (MARTIAN_BOARD_RECORD=1)
// builds exactly the same run: Martian-shaped cases for a golden file we
// write (benchmark/outside/fixtures/martian/golden.json), ingested into a
// suite in a temp folder with every GitHub answer in a temp cache; a run
// folder made by the runner's own code; and a model provider on this
// machine that answers Martian's three prompts by fixed rules (the one
// stand-in the tests allow).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { ingestMartian, writeMartianIngest } from "../ingest/martian.mjs";
import { benchRoot } from "../lib/cases.mjs";
import { saveCommitAnswer, savePullAnswer, saveRepoAnswer } from "../lib/licence.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { listCases, readCase } from "../lib/suites.mjs";
import { tempDir } from "../../tests/temp-dirs.mjs";

export const FIXTURES = join(benchRoot, "outside", "fixtures", "martian");
export const BOARDS = JSON.parse(readFileSync(join(benchRoot, "outside", "boards.json"), "utf8"));
export const COMMIT = BOARDS.boards.martian.commit;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// ---------- the cases: our golden file, ingested as Martian's ----------

export const GOLDEN = readJson(join(FIXTURES, "golden.json"));
export const REPORTS = readJson(join(FIXTURES, "reports.json")).cases;
const GOLDEN_PATH = "offline/golden_comments/oq_fixture.json";
const PR = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const headOf = (repo, n) => createHash("sha1").update(`head ${repo} ${n}`).digest("hex");
const baseOf = (repo, n) => createHash("sha1").update(`base ${repo} ${n}`).digest("hex");

// A suite root and a cache holding Martian-shaped cases for `rows` (golden
// rows in Martian's shape). `spdx` gives a repository's licence id
// (default MIT). Returns { root, cache, ids: name -> case id }.
export async function suite(rows = GOLDEN, spdx = {}) {
  const cache = tempDir("oq-martian-board-cache-");
  const bytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`);
  write(join(cache, "raw", "martian", GOLDEN_PATH), bytes);
  const board = BOARDS.boards.martian;
  const boards = { version: 1, boards: { martian: { repo: board.repo, source: board.source, commit: COMMIT, licence: "MIT", data: [{ path: GOLDEN_PATH, url: `https://raw.githubusercontent.com/${board.repo}/${COMMIT}/${GOLDEN_PATH}`, sha256: sha256(bytes), prCount: rows.length }], reservedPrUrls: rows.map((r) => r.url) } } };
  for (const repo of new Set(rows.map((r) => PR.exec(r.url)[1]))) {
    const id = spdx[repo] ?? "MIT";
    saveRepoAnswer(cache, { asked: repo, readOn: "2026-10-11", found: true, fullName: repo, fork: false, source: null, licence: { spdx: id, key: id.toLowerCase(), file: "LICENSE", fileSha256: sha256(`licence of ${repo}`) } });
  }
  for (const row of rows) {
    const [, repo, n] = PR.exec(row.url);
    savePullAnswer(cache, { repo, number: Number(n), readOn: "2026-10-11", found: true, baseSha: baseOf(repo, n), headSha: headOf(repo, n), createdAt: "2026-09-01T00:00:00Z", additions: 20, deletions: 4, language: "TypeScript" });
    saveCommitAnswer(cache, { repo, sha: headOf(repo, n), readOn: "2026-10-11", served: true });
  }
  const root = tempDir("oq-martian-board-root-");
  writeMartianIngest(await ingestMartian({ boards, cache, offline: true }), { root });
  const ids = new Map(listCases({ suite: "martian", split: "test", root }).map((id) => [id.slice("martian/".length, id.lastIndexOf("@")), id]));
  return { root, cache, ids };
}

// ---------- a saved run, as run.mjs saves it ----------

export const finding = (extra = {}) => ({
  file_path: "src/a.ts",
  line_number: 10,
  line_end: 12,
  severity: "major",
  category: "bug",
  confidence: 0.9,
  title: "Index read past the end",
  problem: "The loop reads one element past the array.",
  consequence: "It throws at run time.",
  fix: "Stop the loop one element earlier.",
  ...extra,
});
export const report = ({ findings = [], outside = [], status = "complete" } = {}) => ({
  version: 1,
  kind: "review",
  verdict: "passed",
  findings,
  outside_change: outside,
  possible: [], low_confidence: [],
  dropped: [],
  scanners: [],
  impact: { status: "ok", build: { durationMs: 100 } },
  completion: { status, missing: status === "complete" ? [] : ["the reviewer stopped early"], reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 1200, output_tokens: 300, cost_usd: 0.01 } } },
});
export const fixtureReport = (name) => report({ findings: REPORTS[name].findings, outside: REPORTS[name].outside_change, status: REPORTS[name].status });

export const MODEL = "model-scripted-graph-on";
export const CLAUDE = "claude-graph-on";

// The published package a release run reviews (run.mjs --package
// npm:<release> records it so), and the npm registry's answer for it, saved.
export const REGISTRY_ANSWER = readJson(join(FIXTURES, "registry-openqodex-0.12.0.json"));
export const RELEASE = REGISTRY_ANSWER.version;
export const PACKAGE = { spec: `npm:${RELEASE}`, name: "openqodex", version: RELEASE, sha256: REGISTRY_ANSWER.tarballSha256, integrity: REGISTRY_ANSWER.dist.integrity, bytes: REGISTRY_ANSWER.tarballBytes, registryIntegrity: REGISTRY_ANSWER.dist.integrity };
const BUILD = { commit: null, short: null, dirty: null, cliVersion: RELEASE };
/** The registry as the tests ask it: the saved answer for RELEASE, and a 404 for any other version. */
export const savedRegistry = async (version) => {
  if (version === RELEASE) return structuredClone(REGISTRY_ANSWER);
  throw new Error(`it answered 404 for openqodex@${version}`);
};

// A run folder made by the runner's own code. `plan` maps "<config>/<repeat>"
// to case name to a report, "failed" (an attempt with no report),
// "unstarted" (no attempt), or "retried" (a failed first attempt and a
// second with a finding, which never counts). `settings` overrides the
// manifest's settings (release, package, smoke, suite).
export async function savedRun(ctx, { plan, configs = [MODEL], repeat = 1, settings = {} }) {
  const names = [...ctx.ids.keys()].sort();
  const reviewers = configs.map((c) => (c === MODEL ? "model:scripted" : c === CLAUDE ? "claude" : c.replace(/-graph-(on|off)$/, "").replace(/^model-/, "model:")));
  const graph = [...new Set(configs.map((c) => (c.endsWith("-graph-off") ? "off" : "on")))];
  const { jobs } = planJobs({ cases: names, caseIds: Object.fromEntries(names.map((n) => [n, ctx.ids.get(n)])), reviewers: [...new Set(reviewers)], graph, repeat });
  const kept = jobs.filter((j) => configs.includes(j.config));
  const out = join(tempDir("oq-martian-board-run-"), "run");
  const first = readCase(ctx.ids.get(names[0]), { root: ctx.root });
  const manifest = runManifest({
    startedAt: "2026-10-11T10:00:00.000Z",
    settings: { runId: "martian-board-test", mode: "review", path: "server", suite: "martian", split: "test", splitHash: first.splitHash, subset: null, release: RELEASE, smoke: false, package: PACKAGE, build: BUILD, reviewers: Object.fromEntries(reviewers.map((r) => [r, { name: r }])), cases: names, caseIds: names.map((n) => ctx.ids.get(n)), caseHashes: Object.fromEntries(names.map((n) => [n, readCase(ctx.ids.get(n), { root: ctx.root }).hash])), configs, repeat, concurrency: 1, ...settings },
    jobs: kept,
  });
  await executeRun({
    out,
    manifest,
    jobs: kept,
    runJob: async (job) => {
      const saved = plan[`${job.config}/${job.repeat}`]?.[job.case] ?? report();
      if (saved === "unstarted") return;
      if (saved.reviewer === "control") {
        write(join(attemptDir(out, job, 1), "sample.json"), JSON.stringify({ ...job, attempt: 1, ...saved }));
        return;
      }
      const result = { code: 0, signal: null, wallMs: 90_000 };
      const attempt = (n, rep) => {
        const dir = attemptDir(out, job, n);
        write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job, attempt: n, result, report: rep, who: null, startedAt: "2026-10-11T10:00:00.000Z", failure: rep ? null : { cause: "no report.json" }, stopped: null })));
        if (rep) write(join(dir, "report", "report.json"), JSON.stringify(rep));
      };
      if (saved === "failed") attempt(1, null);
      else if (saved === "retried") {
        attempt(1, null);
        attempt(2, report({ findings: [finding()] }));
      } else attempt(1, saved);
    },
  });
  return out;
}

// The three-sample fixture run: one tool name, the three fixture reviews.
export const fixturePlan = () => ({ [`${MODEL}/1`]: Object.fromEntries(Object.keys(REPORTS).map((n) => [n, fixtureReport(n)])) });
export const convertOpts = (ctx, extra = {}) => ({ root: ctx.root, cache: ctx.cache, accessLog: join(tempDir("oq-martian-board-index-"), "heldout-access.jsonl"), by: "tester", registry: savedRegistry, ...extra });

// ---------- a model provider for Martian's judge ----------

// A model provider on this machine in the shape Martian's client calls
// (chat completions), answering each of its three prompts by a fixed rule
// and recording what it got. Extraction: one issue per comment body, the
// text before " Fix: ", split again at ". Also, ". Dedup: candidates that
// share four words of five letters or more are one group. Judge: a match
// when the golden comment and the candidate share three such words.
export async function fakeProvider() {
  const seen = [];
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_]{5,}/g) ?? []);
  const shared = (a, b) => [...words(a)].filter((w) => words(b).has(w)).length;
  const between = (text, from, to) => text.slice(text.indexOf(from) + from.length, text.indexOf(to, text.indexOf(from)));
  const answer = (system, prompt) => {
    if (system.startsWith("You extract")) {
      const comment = between(prompt, "Code Review Comment:\n", "\n\nInstructions:");
      return { kind: "extract", content: JSON.stringify({ issues: comment.split("\n\n---\n\n").flatMap((b) => b.split(" Fix: ")[0].split(". Also, ").map((s) => s.trim())) }) };
    }
    if (system.startsWith("You group")) {
      const items = between(prompt, "Candidates:\n", "\n\nReturn ONLY").split("\n").map((l) => l.replace(/^\d+\. /, ""));
      const group = items.map((_, i) => i);
      for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) if (shared(items[i], items[j]) >= 4 && group[i] === i) group[i] = group[j];
      const groups = [...new Set(group)].map((g) => group.map((x, i) => (x === g ? i : -1)).filter((i) => i >= 0));
      return { kind: "dedup", content: JSON.stringify({ groups }) };
    }
    const golden = between(prompt, "Golden Comment (the issue we're looking for):\n", "\n\nCandidate Issue");
    const candidate = between(prompt, "Candidate Issue (from the tool's review):\n", "\n\nInstructions:");
    const n = shared(golden, candidate);
    return { kind: "judge", content: JSON.stringify({ reasoning: `${n} shared words`, match: n >= 3, confidence: Math.min(0.99, Math.round((0.5 + 0.05 * n) * 100) / 100) }) };
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const request = JSON.parse(body);
      const { kind, content } = answer(request.messages?.[0]?.content ?? "", request.messages?.[1]?.content ?? "");
      seen.push({ kind, path: req.url, authorization: req.headers.authorization ?? null, apiKey: req.headers["api-key"] ?? null, model: request.model, temperature: request.temperature });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: request.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((up) => server.listen(0, "127.0.0.1", up));
  return { seen, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((down) => server.close(down)) };
}
