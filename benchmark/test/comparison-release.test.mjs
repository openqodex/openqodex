// Failure list, written before implementation:
// 1. A development run reviews a held-out split.
// 2. An unsigned or uncommitted comparison admits held-out cases.
// 3. A changed build fingerprint or a dirty build or checkout is admitted.
// 4. A release uses a suite or split outside its accepted pins.
// 5. Truth is read before access is logged, or after logging fails.
// 6. A pinned local build is described as an npm package.
// 7. Runtime admission dirties the checkout and refuses an unchanged
//    resume or a later suite, or changes the tracked access log.
// 8. An admitted scanner-only run loses permission to materialise test cases.
// 9. The runner reads truth or logs access before refusing a changed build.
// 10. A signed comparison release pins an entry that differs from HEAD.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { benchRoot, git } from "../lib/cases.mjs";
import { comparisonHash, comparisonRelease, freezeComparison } from "../lib/comparison.mjs";
import { toolName } from "../lib/aacr-board.mjs";
import { entryProblems, hashReviewedFolder } from "../lib/index.mjs";
import { BOARDS } from "../lib/outside-boards.mjs";
import { releaseGate } from "../lib/martian-board.mjs";
import { caseRepo } from "../lib/materialise.mjs";
import { bundleHash } from "../lib/runner.mjs";
import { caseSetHash } from "../lib/score.mjs";
import { aacrTruth, entryHash, readCase, selectCases, sha256, truthHashOf, truthOf } from "../lib/suites.mjs";

const dirs = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
function fixture({ accepted = true, committed = true, runner = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "oq-comparison-release-")); dirs.push(repo);
  const root = join(repo, "benchmark");
  const cache = mkdtempSync(join(tmpdir(), "oq-comparison-cache-")); dirs.push(cache);
  vi.stubEnv("OPENQODEX_BENCH_CACHE", cache);
  for (const file of ["outside/boards.json", "suites/aacr/cases.json", "splits/aacr-v1.json", "review-queue/people.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(benchRoot, file), join(root, file));
  }
  writeFileSync(join(repo, ".gitignore"), "benchmark/.build/\nbenchmark/results/\n");
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(join(root, "index/heldout-access.jsonl"), "");
  write(join(repo, "packages/cli/package.json"), { version: "0.12.0" });
  write(join(repo, "packages/cli/dist/bin.js"), "a real bundle fixture");
  if (runner) {
    mkdirSync(join(root, "cases"));
    for (const file of ["run.mjs", "score.mjs", "lib", "legacy"]) cpSync(join(benchRoot, file), join(root, file), { recursive: true });
    for (const file of ["dist", "lenses", "toolchain.json", "locks", "package.json"]) cpSync(join(benchRoot, "../packages/cli", file), join(repo, "packages/cli", file), { recursive: true });
    symlinkSync(join(benchRoot, "../packages/scanners"), join(repo, "packages/scanners"));
    const upstream = join(cache, "upstream"); mkdirSync(upstream);
    git(upstream, "init", "-q");
    git(upstream, "config", "uploadpack.allowFilter", "true");
    writeFileSync(join(upstream, "a.txt"), "before\n"); git(upstream, "add", "."); git(upstream, "commit", "-qm", "Base");
    const baseSha = git(upstream, "rev-parse", "HEAD").trim();
    writeFileSync(join(upstream, "a.txt"), "after\n"); git(upstream, "add", "."); git(upstream, "commit", "-qm", "Change");
    const headSha = git(upstream, "rev-parse", "HEAD").trim();
    const row = { githubPrUrl: "https://github.com/fixture/widget/pull/1", target_commit: headSha, comments: [{ path: "a.txt", from_line: 1, to_line: 1, side: "right", note: "The change removes the expected value.", category: "Code Defect" }] };
    const bytes = `${JSON.stringify([row])}\n`;
    mkdirSync(join(cache, "raw/aacr"), { recursive: true }); writeFileSync(join(cache, "raw/aacr/positive.json"), bytes);
    writeFileSync(join(cache, "raw/aacr/negative.json"), "[]\n");
    const file = read(join(root, "suites/aacr/cases.json"));
    const entry = { ...file.cases.find((c) => c.status === "usable"), name: "fixture__widget-1", repo: "fixture/widget", repoGroup: "fixture/widget", prUrl: row.githubPrUrl, cloneUrl: "https://github.com/fixture/widget.git", prRef: "refs/pull/1/head", baseSha, headSha, mergeBaseSha: baseSha, truthHash: truthHashOf(aacrTruth(row, null).items), truth: { accepted: 1, rejected: 0 }, matchSignatures: null };
    entry.hash = entryHash(entry);
    file.cases = [entry];
    file.dataset.files = { positive: { path: "positive.json", sha256: sha256(bytes) }, negative: { path: "negative.json", sha256: sha256("[]\n") } };
    write(join(root, "suites/aacr/cases.json"), file);
    const split = read(join(root, "splits/aacr-v1.json")); split.cases = { dev: [], test: [entry.name] }; split.subsets = {};
    write(join(root, "splits/aacr-v1.json"), split);
    const c = readCase(`aacr/${entry.name}@${entry.hash.slice(0, 8)}`, { root });
    caseRepo({ ...c, materialise: { ...c.materialise, cloneUrl: `file://${upstream}` } }, { cache, heldOut: true, allowFileUrl: true });
  }
  git(repo, "init", "-q"); git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Build fixture");
  const build = { commit: git(repo, "rev-parse", "HEAD").trim(), tree: git(repo, "rev-parse", "HEAD^{tree}").trim(), bundleHash: bundleHash(join(repo, "packages/cli")), version: read(join(repo, "packages/cli/package.json")).version };
  write(join(root, ".build/provenance.json"), { ...build, commitTree: build.tree, dirty: false });
  const record = freezeComparison({ release: "test-release", suites: ["aacr"], boards: ["aacr"], reviewers: { control: { path: "laptop", reviewer: "control", model: "claude-opus-5-5", graph: "off", web: "off", effort: null, maxOutputTokens: null } }, capUsd: 1 }, { root, build });
  if (accepted) { record.acceptance = { person: "Sid", date: "2026-10-14", hash: "" }; record.acceptance.hash = comparisonHash(record); }
  const file = join(root, "index/comparisons/test-release.json"); write(file, record);
  if (committed) { git(repo, "add", "."); git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Freeze comparison"); }
  const manifest = { release: record.release, suite: "aacr", split: "test", splitHash: record.suites.aacr.splitHash, build: { ...build, cliVersion: build.version, dirty: false, commitTree: build.tree }, package: { spec: "local", commit: build.commit, dirty: false } };
  const options = { root, suite: "aacr", split: "test", release: record.release, build: manifest.build, packageRecord: manifest.package, runId: "test-run", by: "Sid" };
  return { repo, root, cache, build, record, manifest, options, file, log: join(cache, "heldout-access.jsonl"), trackedLog: join(root, "index/heldout-access.jsonl") };
}
function attachRun(f, suffix) {
  const config = "model-gpt-6.1-sol-graph-on";
  const reviewer = { path: "server", reviewer: "model:gpt-6.1-sol", model: "gpt-6.1-sol", graph: "on", web: "off", effort: "high", maxOutputTokens: 32000 };
  f.record.reviewers.library = reviewer;
  const entry = read(join(benchRoot, "index/runs/2026-10-12-b43b25b-aacr-gpt61.json"));
  entry.runId = `2026-10-24-${suffix}`;
  entry.date = "2026-10-24"; entry.startedAt = "2026-10-24T00:00:00.000Z";
  entry.asset.url = entry.asset.url.replace(/[^/]+$/, `${entry.runId}.tar.gz`);
  entry.build = { ...entry.build, ...f.build, short: f.build.commit.slice(0, 7), cliVersion: f.build.version };
  entry.splitHash = f.record.suites.aacr.splitHash;
  entry.caseIds = Object.entries(f.record.suites.aacr.caseHashes).map(([name, h]) => `aacr/${name}@${h.slice(0, 8)}`);
  entry.caseSetHash = caseSetHash(entry.caseIds);
  entry.perCase = {}; entry.perBug = {}; entry.intervals = { ...entry.intervals, cluster: "case", groups: null };
  entry.configs = [config]; entry.repeat = 1;
  const folder = join(f.root, "results", entry.runId);
  write(join(folder, "manifest.json"), { build: f.build, reviewers: { [reviewer.reviewer]: { ...entry.reviewers[reviewer.reviewer], settings: { effort: reviewer.effort, maxOutputTokens: reviewer.maxOutputTokens } } } });
  const out = join(folder, "outside/aacr");
  const tool = toolName(config, 1);
  const dir = `${config}/r1`;
  write(join(out, "convert.json"), { reader: "ocr", lineK: null, references: {}, withoutLine: [], folders: [{ config, repeat: 1, tool, dir, files: entry.caseIds.length }] });
  write(join(out, "eval.json"), { judge: { deployment: f.record.boards.aacr.judgeModel }, folders: [{ config, repeat: 1, mode: "llm", judgeErrors: 0, metrics: ["metrics_ocr_fixture.json"] }] });
  write(join(out, dir, "metrics_ocr_fixture.json"), { summary: { evaluated_instances: entry.caseIds.length, missing_instances: 0, expected_notes: 0, generated_notes: 0, matched_line_notes: 0, matched_semantic_notes: 0 } });
  entry.outside = { aacr: BOARDS.aacr(folder, [], {}) };
  entry.privateListHash = hashReviewedFolder(folder).listHash;
  expect(entryProblems(entry)).toEqual([]);
  const file = join(f.root, "index/runs", `${entry.runId}.json`);
  write(file, entry);
  f.record.runs.push({ runId: entry.runId, sha256: sha256(readFileSync(file)), reviewer: "library", casesNotRun: [] });
  return file;
}

for (const changed of ["first", "second"]) it(`comparison release refuses the ${changed} attached entry when its bytes differ from HEAD`, () => {
  const f = fixture();
  const files = [attachRun(f, "first"), attachRun(f, "second")];
  const saveRecord = () => {
    f.record.acceptance.hash = comparisonHash(f.record);
    write(f.file, f.record);
  };
  saveRecord();
  git(f.repo, "add", "benchmark/index"); git(f.repo, "commit", "-qm", "Attach run entries");
  expect(comparisonRelease(f.manifest, { root: f.root }).release).toBe(f.record.release);
  const index = changed === "first" ? 0 : 1;
  writeFileSync(files[index], `${readFileSync(files[index], "utf8")}\n`);
  f.record.runs[index].sha256 = sha256(readFileSync(files[index]));
  saveRecord();
  git(f.repo, "add", "benchmark/index/comparisons/test-release.json"); git(f.repo, "commit", "-qm", "Sign updated entry hash");
  expect(() => comparisonRelease(f.manifest, { root: f.root })).toThrow(`run 2026-10-24-${changed} entry is not committed at HEAD; commit it before attaching`);
});

it("a conversion on a later checkout accepts the record on its pinned build, and making a run there is refused", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "later.txt"), "a commit after the pinned build\n");
  git(f.repo, "add", "."); git(f.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Later work");
  expect(git(f.repo, "rev-parse", "HEAD").trim()).not.toBe(f.build.commit);
  expect(comparisonRelease(f.manifest, { root: f.root }).buildLabel).toBe(`local build ${f.build.commit}`);
  // The bundle built on the later commit is not the pinned build, so no run may be made from it.
  const later = { commit: git(f.repo, "rev-parse", "HEAD").trim(), tree: git(f.repo, "rev-parse", "HEAD^{tree}").trim() };
  write(join(f.root, ".build/provenance.json"), { ...f.build, ...later, commitTree: later.tree, dirty: false });
  expect(() => comparisonRelease(f.manifest, { root: f.root, admit: true })).toThrow("comparison release requires the pinned build checked out and built");
  expect(comparisonRelease(f.manifest, { root: f.root }).buildLabel).toBe(`local build ${f.build.commit}`);
});

it("refuses a development run on a held-out split", () => {
  expect(() => selectCases({ suite: "aacr", split: "test" })).toThrow(/held out/);
});
it("refuses an unaccepted comparison record", async () => {
  const f = fixture({ accepted: false });
  expect(() => selectCases(f.options)).toThrow(/not accepted/);
  await expect(releaseGate(f.manifest, { root: f.root })).rejects.toThrow(/not accepted/);
  expect(existsSync(f.log)).toBe(false);
});
it("refuses a comparison record that has not been committed", () => {
  const f = fixture({ committed: false });
  expect(() => selectCases(f.options)).toThrow(/committed/);
});
it("refuses a changed build fingerprint", async () => {
  const f = fixture(); f.manifest.build.bundleHash = "d".repeat(64);
  await expect(releaseGate(f.manifest, { root: f.root })).rejects.toThrow(/build/);
});
it("refuses a bundle changed after provenance was written", () => {
  const f = fixture(); write(join(f.repo, "packages/cli/dist/bin.js"), "changed");
  expect(() => selectCases(f.options)).toThrow(/bundle|build/);
});
it("refuses a dirty build", async () => {
  const f = fixture(); f.manifest.build.dirty = true;
  await expect(releaseGate(f.manifest, { root: f.root })).rejects.toThrow(/clean/);
});
it("refuses a dirty checkout", () => {
  const f = fixture(); writeFileSync(join(f.repo, "scratch.txt"), "dirty\n");
  expect(() => selectCases(f.options)).toThrow(/clean|dirty/);
});
it("refuses a suite or split outside the accepted pins", async () => {
  const f = fixture();
  for (const patch of [{ suite: "martian" }, { splitHash: "f".repeat(64) }, { split: "dev" }]) {
    await expect(releaseGate({ ...f.manifest, ...patch }, { root: f.root })).rejects.toThrow(/suite|split/);
  }
});
it("logs accepted pinned access before truth can be read", async () => {
  const f = fixture(); const cases = selectCases(f.options);
  const access = read(f.log);
  expect(access).toMatchObject({ suite: "aacr", purpose: "release-run", release: "test-release", runId: "test-run", caseCount: cases.length, comparisonHash: f.record.acceptance.hash, build: `local build ${f.build.commit}` });
  // No raw truth is installed: the read fails after admission was logged.
  expect(() => truthOf(cases[0], { cache: join(f.repo, "empty-cache") })).toThrow(/not in the cache/);
  const gate = await releaseGate(f.manifest, { root: f.root });
  expect(gate.buildLabel).toBe(`local build ${f.build.commit}`);
  expect(gate.package).toEqual(f.manifest.package);
  expect(gate.package).not.toHaveProperty("name");
  expect(gate.package).not.toHaveProperty("integrity");
});
it("refuses access when its log cannot be written", () => {
  const f = fixture();
  expect(() => selectCases({ ...f.options, accessLog: f.file + "/blocked" })).toThrow(/access log/);
});
it("keeps admission outside the checkout so unchanged resumes and later suites are admitted", () => {
  const f = fixture();
  const first = selectCases(f.options);
  expect(git(f.repo, "status", "--porcelain").trim()).toBe("");
  expect(readFileSync(f.trackedLog, "utf8")).toBe("");
  expect(selectCases({ ...f.options, runId: "next-run" })).toEqual(first);
  expect(selectCases(f.options)).toEqual(first);
  expect(readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line).runId)).toEqual(["test-run", "next-run", "test-run"]);
});
it("passes admitted held-out permission through a real scanner-only release run, and leaves no temp folder behind", () => {
  const f = fixture({ runner: true });
  const out = join(f.root, "results/scan");
  const temp = join(f.root, "tmp");
  mkdirSync(temp);
  const r = spawnSync(process.execPath, [join(f.root, "run.mjs"), "--mode", "scan", "--suite", "aacr", "--split", "test", "--release", "test-release", "--out", out, "--allow-missing-scanners"], { cwd: f.repo, encoding: "utf8", env: { ...process.env, OPENQODEX_HOME: join(f.cache, "home"), TMPDIR: temp }, timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(readdirSync(temp).filter((n) => n.startsWith("oq-bench-run-")), "a real suite's scan removes its case copies when it ends").toEqual([]);
  expect(read(join(out, "samples/fixture__widget-1/scan/1/sample.json"))).toMatchObject({ status: "complete" });
  expect(read(join(out, "manifest.json"))).toMatchObject({ release: "test-release", split: "test", mode: "scan" });
  expect(git(f.repo, "status", "--porcelain").trim()).toBe("");
});
it("refuses a changed release build before the runner logs admission or reads uncached truth", () => {
  const f = fixture({ runner: true });
  const provenance = read(join(f.root, ".build/provenance.json")); provenance.bundleHash = "d".repeat(64);
  write(join(f.root, ".build/provenance.json"), provenance);
  rmSync(join(f.cache, "raw"), { recursive: true });
  const r = spawnSync(process.execPath, [join(f.root, "run.mjs"), "--mode", "scan", "--suite", "aacr", "--split", "test", "--release", "test-release", "--dry-run"], { cwd: f.repo, encoding: "utf8" });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("the CLI bundle is not the one benchmark/build-cli.mjs built");
  expect(r.stderr).not.toMatch(/not in the cache|truth|access log/);
  expect(existsSync(f.log)).toBe(false);
  expect(readFileSync(f.trackedLog, "utf8")).toBe("");
});
