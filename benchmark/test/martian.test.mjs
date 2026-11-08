// Martian's offline Code Review Bench: the ingest (benchmark/ingest/martian.mjs)
// into the martian suite and its split, the suite reader (lib/suites.mjs), and
// the evaluation reader (lib/score.mjs). The ingest runs on golden files
// written here in Martian's own shape, with the pinned files and GitHub's
// answers placed in a temp cache, so nothing reaches the network. The reader
// runs on the fixture under fixtures/martian: an evaluation.json in the shape
// PLAN-benchmark 4.5 keeps from Martian's pipeline, the saved findings it
// names, and the golden comments of its two pull requests. Three failures are
// guarded:
//
// 1. A Martian case runs on the dev split.
// 2. A finding without problem, consequence or fix is saved for the judge.
// 3. One finding extracted into two issues, or matched to two golden
//    comments, loses a match.
// Also: a pull request whose licence GitHub cannot name is used and
// published in full, as unverified, with a person's reading of that very
// file noted; official totals missing a field of their shape, and a match
// across two pull requests, are refused.
// A plain ingest must preserve the report saved by --verify-published.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestMartian, verifyMartianMapping, verifyPublishedMartian, writeMartianIngest } from "../ingest/martian.mjs";
import { benchRoot } from "../lib/cases.mjs";
import { LICENCE_READINGS, cacheRoot, saveCommitAnswer, savePullAnswer, saveRepoAnswer } from "../lib/licence.mjs";
import { martianFindings, martianGolden, readMartianEvaluation } from "../lib/score.mjs";
import { listCases, martianTruth, materialise, rawPath, readCase, truthOf } from "../lib/suites.mjs";
// These tests use synchronous subprocesses, so cleanup needs no process scan.
const tempDirs = [];
const tempDir = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

// Round 1 and 2 failure list: greptile-failures.md, items 11 and 12.
const cache = cacheRoot();
const suite = JSON.parse(readFileSync(join(benchRoot, "suites/martian/cases.json"), "utf8"));
const publishedSource = JSON.parse(readFileSync(join(benchRoot, "suites/martian/verification-source.json"), "utf8"));
const hasPublishedData = [publishedSource, ...suite.dataset.files].every((pin) => existsSync(rawPath(cache, "martian", pin)));
describe.skipIf(!hasPublishedData)("published Martian tree proofs (needs pinned Martian data in the bench cache; skipped without it)", () => {
  let verified;
  beforeAll(async () => { verified = await verifyPublishedMartian({ cache, offline: true }); });

  it.each(["all", "mergeBase", "builtBase", "head", "builtHead"])("refuses absent %s trees", (field) => {
    const proofs = structuredClone(verified.proofs);
    const proof = proofs.find((p) => p.name === suite.cases[0].name);
    if (field === "all") delete proof.trees;
    else delete proof.trees[field];
    const check = verifyMartianMapping({ suite, published: verified.published, rows: verified.rows, proofs });
    expect(check.differences).toContain(`${proof.name}: committed tree proof differs from the suite's frozen commits or is not proved`);
    expect(check.counts.mappedProofs).toBe(49);
  });

  it.each([null, "", "bad", "z".repeat(40)])("refuses equal invalid tree hashes %j", (tree) => {
    const proofs = structuredClone(verified.proofs);
    const proof = proofs.find((p) => p.name === suite.cases[0].name);
    proof.trees = { mergeBase: tree, builtBase: tree, head: tree, builtHead: tree };
    const check = verifyMartianMapping({ suite, published: verified.published, rows: verified.rows, proofs });
    expect(check.differences).toContain(`${proof.name}: committed tree proof differs from the suite's frozen commits or is not proved`);
    expect(check.counts.mappedProofs).toBe(49);
  });
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const COMMIT = "d".repeat(40);
const BOARD = "withmartian/code-review-benchmark";
const raw = (path) => `https://raw.githubusercontent.com/${BOARD}/${COMMIT}/${path}`;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "martian");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

// Golden files in Martian's shape: usable pull requests, an evaluation copy
// with its original, one whose head the host no longer serves, one whose
// repository's licence GitHub cannot name (Sentry's, which a person read),
// one with no licence file, and one GitHub does not serve at all.
const GOLDEN = {
  "offline/golden_comments/alpha.json": [
    { pr_title: "t", url: "https://github.com/alpha/app/pull/1", comments: [{ comment: "The cache entry is read after the lock is released.", severity: "High", category: "bug" }, { comment: "The flag name is vague.", severity: "Low", category: "style" }] },
    { pr_title: "t", url: "https://github.com/alpha/app/pull/2", comments: [{ comment: "The widget id reaches the SQL string unescaped.", severity: "Critical", category: "security" }] },
    { pr_title: "t", url: "https://github.com/eval-org/alpha-copy/pull/1", original_url: "https://github.com/alpha/app/pull/9", az_comment: "reviewed commit is not in the repo", comments: [{ comment: "The retry counter is shared without a lock.", severity: "Medium", category: "concurrency" }] },
    { pr_title: "t", url: "https://github.com/alpha/app/pull/7", az_comment: "reviewed commit is not in the repo", comments: [{ comment: "The endpoint answers 200 where clients expect 404.", severity: "High", category: "api" }] },
  ],
  "offline/golden_comments/beta.json": [
    { pr_title: "t", url: "https://github.com/getsentry/sentry/pull/5", comments: [{ comment: "The loop allocates on every row.", severity: "Medium", category: "perf" }] },
    { pr_title: "t", url: "https://github.com/gamma/lib/pull/3", comments: [{ comment: "The docstring names the old argument.", severity: "Low", category: "doc_defect" }] },
    { pr_title: "t", url: "https://github.com/delta/gone/pull/4", comments: [{ comment: "The migration drops rows it should keep.", severity: "High", category: "data" }] },
    { pr_title: "t", url: "https://github.com/eval-org/beta-copy/pull/2", original_url: "https://github.com/getsentry/sentry/commit/abcdef0", comments: [{ comment: "This may break callers later.", severity: "Low", category: "speculative" }] },
  ],
};
// [repository, GitHub's licence id (null: no licence file), the licence
// file a person read, when one did]
const REPOS = [
  ["alpha/app", "MIT"],
  ["eval-org/alpha-copy", "MIT"],
  ["getsentry/sentry", "NOASSERTION", LICENCE_READINGS["getsentry/sentry"]],
  ["gamma/lib", null],
  ["delta/gone", "Apache-2.0"],
  ["eval-org/beta-copy", "Apache-2.0"],
];
const NOT_SERVED_PULL = "delta/gone#4";
const NOT_SERVED_HEAD = "alpha/app#7";

const encode = (rows) => Buffer.from(`${JSON.stringify(rows, null, 2)}\n`);
const PR = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const headOf = (repo, n) => createHash("sha1").update(`head ${repo} ${n}`).digest("hex");
const baseOf = (repo, n) => createHash("sha1").update(`base ${repo} ${n}`).digest("hex");

// A cache holding the pinned golden files and every GitHub answer the ingest
// asks for, and the board pins that name them.
function setup(golden = GOLDEN) {
  const cache = tempDir("oq-martian-cache-");
  const pins = [];
  for (const [path, rows] of Object.entries(golden)) {
    const bytes = encode(rows);
    mkdirSync(dirname(join(cache, "raw", "martian", path)), { recursive: true });
    writeFileSync(join(cache, "raw", "martian", path), bytes);
    pins.push({ path, url: raw(path), sha256: sha256(bytes), prCount: rows.length });
  }
  const boards = { version: 1, boards: { martian: { repo: BOARD, source: `https://github.com/${BOARD}/tree/${COMMIT}`, commit: COMMIT, licence: "MIT", data: pins, reservedPrUrls: Object.values(golden).flat().map((r) => r.url) } } };
  for (const [repo, spdx, read] of REPOS) {
    const licence = spdx === null ? null : { spdx, key: spdx.toLowerCase(), file: read?.file ?? "LICENSE", fileSha256: read?.fileSha256 ?? sha256(`licence of ${repo}`) };
    saveRepoAnswer(cache, { asked: repo, readOn: "2026-10-11", found: true, fullName: repo, fork: false, source: null, licence });
  }
  for (const row of Object.values(golden).flat()) {
    const [, repo, n] = PR.exec(row.url);
    const found = `${repo}#${n}` !== NOT_SERVED_PULL;
    savePullAnswer(cache, { repo, number: Number(n), readOn: "2026-10-11", found, baseSha: found ? baseOf(repo, n) : null, headSha: found ? headOf(repo, n) : null, createdAt: found ? "2025-07-29T00:31:05Z" : null, additions: found ? 10 * Number(n) : null, deletions: found ? 3 : null, language: found ? "TypeScript" : null });
    if (found) saveCommitAnswer(cache, { repo, sha: headOf(repo, n), readOn: "2026-10-11", served: `${repo}#${n}` !== NOT_SERVED_HEAD });
  }
  return { cache, boards };
}

async function ingestInto(ctx, root = tempDir("oq-martian-root-")) {
  const result = await ingestMartian({ boards: ctx.boards, cache: ctx.cache, offline: true });
  writeMartianIngest(result, { root });
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  return { root, result, cases: JSON.parse(read("suites/martian/cases.json")), split: JSON.parse(read("splits/martian-v1.json")), report: read("suites/martian/ingest-report.txt") };
}

describe("a Martian case runs on the dev split", () => {
  it("holds every Martian pull request out, and refuses a development list and a development materialise", async () => {
    const ctx = setup();
    const { root, cases, split } = await ingestInto(ctx);
    expect(split.cases.dev).toEqual([]);
    expect(split.cases.test).toEqual(cases.cases.map((e) => e.name).sort());
    expect(split.subsets).toEqual({});
    expect(() => listCases({ suite: "martian", split: "dev", root })).toThrow(/held out/);
    const ids = listCases({ suite: "martian", split: "test", root });
    expect(ids).toEqual(listCases({ suite: "martian", root }));
    expect(ids.length).toBe(5);
    for (const id of ids) {
      const c = readCase(id, { root });
      expect(c).toMatchObject({ suite: "martian", split: "test", origin: "injected" });
      expect(() => materialise(c, tempDir("oq-martian-into-"), { cache: ctx.cache })).toThrow(/held out/);
    }
  });

  it("refuses a split file that places a Martian case in development", async () => {
    const ctx = setup();
    const { root, split } = await ingestInto(ctx);
    const id = listCases({ suite: "martian", root })[0];
    const moved = split.cases.test.find((n) => id.includes(`/${n}@`));
    const edited = { ...split, cases: { dev: [moved], test: split.cases.test.filter((n) => n !== moved) } };
    writeFileSync(join(root, "splits/martian-v1.json"), `${JSON.stringify(edited, null, 2)}\n`);
    expect(() => listCases({ suite: "martian", root })).toThrow(/held out/);
    expect(() => listCases({ suite: "martian", split: "test", root })).toThrow(/held out/);
    expect(() => readCase(id, { root })).toThrow(/held out/);
  });
});

describe("the Martian ingest", () => {
  it("names every exclusion with its reason, in each entry and with counts in the report", async () => {
    const { cases, report } = await ingestInto(setup());
    expect(cases.cases.length).toBe(8);
    const by = Object.fromEntries(cases.cases.map((e) => [e.name, e]));
    // A licence GitHub cannot name is used and published in full, unverified,
    // with a person's reading of the very file noted beside it.
    expect(by["getsentry__sentry-5"]).toMatchObject({ status: "usable", excludedWhy: null, licence: { class: "unverified", spdx: "NOASSERTION", excerpts: "omit", reading: { spdx: "FSL-1.1-Apache-2.0", by: "Sid", on: "2026-10-11" } } });
    expect(by["gamma__lib-3"]).toMatchObject({ status: "excluded", licence: { class: "none" } });
    expect(by["gamma__lib-3"].excludedWhy).toMatch(/^licence none/);
    expect(by["delta__gone-4"].status).toBe("excluded");
    expect(by["delta__gone-4"].excludedWhy).toMatch(/does not serve the pull request/);
    expect(by["alpha__app-7"].status).toBe("excluded");
    expect(by["alpha__app-7"].excludedWhy).toMatch(/^head no longer served by the host/);
    expect(by["alpha__app-7"].note).toBe("reviewed commit is not in the repo");
    // A copy whose head is served is usable, with Martian's note kept beside it.
    expect(by["eval-org__alpha-copy-1"]).toMatchObject({ status: "usable", excludedWhy: null, note: "reviewed commit is not in the repo", originalUrl: "https://github.com/alpha/app/pull/9", repoGroup: "alpha/app" });
    expect(by["eval-org__beta-copy-2"].repoGroup).toBe("getsentry/sentry");
    for (const e of cases.cases) expect(e.status === "usable" ? e.excludedWhy === null : typeof e.excludedWhy === "string" && e.excludedWhy.length > 0, e.name).toBe(true);
    expect(by["alpha__app-1"]).toMatchObject({ baseSha: baseOf("alpha/app", 1), headSha: headOf("alpha/app", 1), mergeBaseSha: null, prRef: "refs/pull/1/head", cloneUrl: "https://github.com/alpha/app.git", changeLines: 13, language: "TypeScript", truth: { kind: "prose", items: 2 } });
    expect(report).toMatch(/Usable: 5\. Excluded: 3\./);
    expect(report).not.toMatch(/licence unknown/);
    expect(report).toMatch(/unverified licence[^\n]*: 1 pull request[^\n]*getsentry\/sentry 1 \(NOASSERTION, LICENSE\.md; read by Sid on 2026-10-11 as FSL-1\.1-Apache-2\.0\)/);
    expect(report).toMatch(/licence none[^\n]*: 1 pull request/);
    expect(report).toMatch(/pull request not served[^\n]*: 1 pull request[^\n]*delta\/gone#4/);
    expect(report).toMatch(/head no longer served by the host[^\n]*: 1 pull request[^\n]*alpha\/app#7/);
    expect(report).toMatch(/Held out: 8 of 8/);

    // A reading belongs to the file the person read: another file carries none.
    const other = setup();
    saveRepoAnswer(other.cache, { asked: "getsentry/sentry", readOn: "2026-10-11", found: true, fullName: "getsentry/sentry", fork: false, source: null, licence: { spdx: "NOASSERTION", key: "other", file: "LICENSE.md", fileSha256: "0".repeat(64) } });
    const changed = await ingestInto(other);
    const sentry = changed.cases.cases.find((e) => e.name === "getsentry__sentry-5");
    expect(sentry).toMatchObject({ status: "usable", licence: { class: "unverified" } });
    expect(sentry.licence.reading).toBeUndefined();
  });

  it("refuses a golden file that differs from its pin, and a pin that is not the board's raw file at its commit", async () => {
    const ctx = setup();
    const { root } = await ingestInto(ctx);
    const c = readCase(listCases({ suite: "martian", root }).find((x) => x.startsWith("martian/alpha__app-1@")), { root });
    expect(truthOf(c, { cache: ctx.cache }).items).toEqual([
      { id: "g1", text: "The cache entry is read after the lock is released.", severity: "major", rawSeverity: "High", category: "bug", rawCategory: "bug" },
      { id: "g2", text: "The flag name is vague.", severity: "nitpick", rawSeverity: "Low", category: "style", rawCategory: "style" },
    ]);
    const path = join(ctx.cache, "raw", "martian", "offline/golden_comments/alpha.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("The flag name is vague.", "The flag name is vague, edited."));
    await expect(ingestMartian({ boards: ctx.boards, cache: ctx.cache, offline: true })).rejects.toThrow(/alpha\.json.*sha256.*pinned/s);
    expect(() => truthOf(c, { cache: ctx.cache })).toThrow(/alpha\.json.*sha256.*pinned/s);

    const other = setup();
    other.boards.boards.martian.data[0].url = "https://example.invalid/alpha.json";
    await expect(ingestMartian({ boards: other.boards, cache: other.cache, offline: true })).rejects.toThrow(/not the pinned URL/);
  });

  it("commits no golden comment text, and writes byte-identical files on a second ingest", async () => {
    const ctx = setup();
    const first = await ingestInto(ctx);
    const second = await ingestInto(ctx);
    for (const file of ["suites/martian/cases.json", "splits/martian-v1.json", "suites/martian/ingest-report.txt"]) {
      const text = readFileSync(join(first.root, file), "utf8");
      expect(readFileSync(join(second.root, file), "utf8")).toBe(text);
      for (const row of Object.values(GOLDEN).flat()) for (const g of row.comments) expect(text).not.toContain(g.comment);
    }
  });

  it("preserves the published verification report through a plain ingest", async () => {
    const path = "offline/golden_comments/alpha.json";
    const rows = Array.from({ length: 50 }, (_, i) => ({ pr_title: `Change ${i}`, url: `https://github.com/alpha/app/pull/${101 + i}`, comments: Array.from({ length: i < 23 ? 4 : 3 }, (_, j) => ({ comment: `Bug ${i}.${j}`, severity: "High", category: "bug" })) }));
    const ctx = setup({ [path]: rows });
    const parent = tempDir("oq-martian-verification-");
    const { root, cases, report } = await ingestInto(ctx, join(parent, "benchmark"));
    for (const dir of ["ingest", "lib"]) {
      mkdirSync(join(root, dir));
      for (const file of readdirSync(join(benchRoot, dir)).filter((f) => f.endsWith(".mjs"))) cpSync(join(benchRoot, dir, file), join(root, dir, file));
    }
    for (const file of ["score.mjs", "legacy"]) cpSync(join(benchRoot, file), join(root, file), { recursive: true });
    mkdirSync(join(parent, "packages"));
    symlinkSync(join(benchRoot, "../packages/scanners"), join(parent, "packages/scanners"));
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside/boards.json"), encode(ctx.boards));
    const published = encode(Object.fromEntries(rows.map(({ comments, ...row }) => [row.url, { ...row, golden_source_file: "alpha.json", golden_comments: comments }])));
    const sourcePath = "offline/results/benchmark_data.json";
    mkdirSync(dirname(join(ctx.cache, "raw/martian", sourcePath)), { recursive: true });
    writeFileSync(join(ctx.cache, "raw/martian", sourcePath), published);
    writeFileSync(join(root, "suites/martian/verification-source.json"), encode({ path: sourcePath, url: raw(sourcePath), revision: COMMIT, readDate: "2026-10-14", sha256: sha256(published) }));
    mkdirSync(join(root, "index/proof"), { recursive: true });
    writeFileSync(join(root, "index/proof/martian.json"), encode({ cases: cases.cases.map((c) => ({ name: c.name, caseId: c.id, baseSha: c.baseSha, headSha: c.headSha, mergeBaseSha: c.baseSha, ok: true, ancestorOfHead: true, trees: { mergeBase: c.baseSha, builtBase: c.baseSha, head: c.headSha, builtHead: c.headSha } })) }));
    const run = (...args) => spawnSync(process.execPath, [join(root, "ingest/martian.mjs"), ...args, "--offline"], { env: { ...process.env, OPENQODEX_BENCH_CACHE: ctx.cache }, encoding: "utf8" });
    const verified = run("--verify-published");
    expect(verified.status, verified.stderr).toBe(0);
    const verificationPath = join(root, "suites/martian/verification-report.txt");
    const verification = readFileSync(verificationPath);
    expect(verification.toString()).toBe(verified.stdout);
    const plain = run();
    expect(plain.status, plain.stderr).toBe(0);
    expect(readFileSync(verificationPath)).toEqual(verification);
    expect(readFileSync(join(root, "suites/martian/ingest-report.txt"), "utf8")).toBe(report);
  });
});

// The fixture's findings, golden comments and evaluation, read the way a
// scorer of a Martian run reads them.
function fixtureInputs() {
  const reports = fixture("reports.json");
  const golden = fixture("golden.json");
  const findings = [];
  const goldenItems = [];
  for (const c of reports.cases) {
    findings.push(...martianFindings(c.caseId, c.report));
    goldenItems.push(...martianGolden(c.caseId, martianTruth(golden.find((r) => r.url === c.prUrl))));
  }
  return { reports, findings, golden: goldenItems, evaluation: fixture("evaluation.json") };
}

describe("the evaluation reader", () => {
  it("keeps the official totals, candidate ids, extraction provenance and matches unchanged, and adds our severity accuracy beside them", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    const before = structuredClone(evaluation);
    const read = readMartianEvaluation(evaluation, { findings, golden });
    expect(read.official).toEqual(before.totals);
    expect(read.candidates).toEqual(before.candidates);
    expect(read.matches).toEqual(before.matches);
    expect(read).toMatchObject({ toolName: "openqodex-library-r1", judge: before.judge, board: before.board });
    expect(evaluation).toEqual(before);
    expect(read.ours.severity).toMatchObject({ exact: { hit: 3, of: 5 }, oneOff: { hit: 1, of: 5 }, off: { hit: 1, of: 5 }, withinOne: { hit: 4, of: 5 }, over: 1, under: 1, unknown: 0 });
    expect(read.ours.severity.matrix.major.major).toBe(1);
    expect(read.ours.severity.matrix.nitpick.major).toBe(1);
    expect(read.ours.severity.matrix.critical.critical).toBe(1);
    expect(read.ours.severity.matrix.minor.minor).toBe(1);
    expect(read.ours.severity.matrix.major.minor).toBe(1);
    expect(read.ours.label).toMatch(/never an acceptance metric/);
    expect(read.ours.judge).toEqual(before.judge);
  });

  it("refuses official totals that lack a field of Martian's shape, naming it, rather than returning them as official", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    const without = (path) => {
      const e = structuredClone(evaluation);
      const keys = path.split(".");
      delete keys.slice(0, -1).reduce((o, k) => o[k], e)[keys.at(-1)];
      return e;
    };
    for (const path of ["totals.core", "totals.strict.fbeta", "totals.all.fn", "totals.all.prs", "totals.beta"]) {
      expect(() => readMartianEvaluation(without(path), { findings, golden }), path).toThrow(new RegExp(`${path.replace(/\./g, "\\.")}\\b`));
    }
    const text = structuredClone(evaluation);
    text.totals.core.recall = "1.0";
    expect(() => readMartianEvaluation(text, { findings, golden })).toThrow(/totals\.core\.recall/);
  });

  it("refuses a match that links a candidate of one pull request to a golden comment of another, naming both", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    const crossed = { ...evaluation, matches: [...evaluation.matches, { candidateId: "https://github.com/alpha/app/pull/1#2", goldenId: "martian/eval-org__alpha-copy-1@4e5f6a7b#g1", verdict: "match", confidence: 0.6 }] };
    expect(() => readMartianEvaluation(crossed, { findings, golden })).toThrow(/https:\/\/github\.com\/alpha\/app\/pull\/1#2[^\n]*martian\/alpha__app-1@0a1b2c3d[^\n]*martian\/eval-org__alpha-copy-1@4e5f6a7b#g1/);
  });
});

describe("a finding without problem, consequence or fix is saved for the judge", () => {
  it("refuses to render such a finding for the judge, naming it and what it lacks", () => {
    const { reports } = fixtureInputs();
    const c = structuredClone(reports.cases[1]);
    delete c.report.findings[1].fix;
    c.report.findings[0].problem = "   ";
    expect(() => martianFindings(c.caseId, c.report)).toThrow(/index 0[^\n]*problem[\s\S]*index 1[^\n]*fix/);
  });

  it("refuses to score an evaluation whose sent findings include one, rather than scoring it silently", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    const lacking = findings.map((f, i) => (i === 5 ? { ...f, consequence: undefined } : f));
    expect(() => readMartianEvaluation(evaluation, { findings: lacking, golden })).toThrow(new RegExp(`${findings[5].findingId.slice(0, 12)}[^\\n]*consequence`));
  });
});

describe("one finding extracted into two issues, or matched to two golden comments, loses a match", () => {
  it("keeps both golden comments of a finding Martian split in two, and both of a candidate matched twice, counting each finding and each golden comment once", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    const read = readMartianEvaluation(evaluation, { findings, golden });
    // alpha/app#1: one finding extracted into two candidates, matched to g1 and g2.
    // eval-org/alpha-copy#1: one candidate matched to g1 and g2.
    expect(read.ours.golden).toEqual({ found: 5, of: 5 });
    expect(read.ours.findings).toEqual({ sent: 6, matched: 3 });
    expect(read.ours.candidates).toEqual({ extracted: 7, findings: 6 });
    expect(read.ours.severity.exact.of).toBe(5);
    expect(read.ours.byGolden.map((g) => [g.goldenId.split("@")[1], g.findingIndex, g.severity, g.given])).toEqual([
      ["0a1b2c3d#g1", 0, "major", "major"],
      ["0a1b2c3d#g2", 0, "nitpick", "major"],
      ["0a1b2c3d#g3", 1, "critical", "critical"],
      ["4e5f6a7b#g1", 0, "minor", "minor"],
      ["4e5f6a7b#g2", 0, "major", "minor"],
    ]);
  });

  it("counts a golden comment once when two candidates of two findings match it, judged by the first finding in report order", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    // The third finding of alpha/app#1 (minor) also matched g1, and a match line is repeated.
    // That candidate was a false positive before this added match. Keep
    // the official totals consistent with the matches the reader checks.
    const totals = structuredClone(evaluation.totals);
    evaluation.candidates.find((c) => c.candidateId === "https://github.com/alpha/app/pull/1#3").officialFp = false;
    for (const profile of ["strict", "core", "all"]) {
      const t = totals[profile];
      t.fp = 1;
      t.precision = t.tp / (t.tp + t.fp);
      t.f1 = 2 * t.precision / (t.precision + 1);
      t.fbeta = 5 * t.precision / (4 * t.precision + 1);
    }
    const more = { ...evaluation, totals, matches: [...evaluation.matches, { candidateId: "https://github.com/alpha/app/pull/1#3", goldenId: "martian/alpha__app-1@0a1b2c3d#g1", verdict: "match", confidence: 0.7 }, evaluation.matches[0]] };
    const read = readMartianEvaluation(more, { findings, golden });
    expect(read.matches).toEqual(more.matches);
    expect(read.ours.golden).toEqual({ found: 5, of: 5 });
    expect(read.ours.findings).toEqual({ sent: 6, matched: 4 });
    expect(read.ours.severity.exact).toEqual({ hit: 3, of: 5 });
    expect(read.ours.byGolden[0]).toMatchObject({ findingIndex: 0, given: "major" });
  });

  it("refuses an evaluation whose matches name fewer golden comments than its official totals count", () => {
    const { evaluation, findings, golden } = fixtureInputs();
    const dropped = { ...evaluation, matches: evaluation.matches.slice(0, 4) };
    expect(() => readMartianEvaluation(dropped, { findings, golden })).toThrow(/official totals count 5 golden comments found[^\n]*matches name 4/);
  });
});
