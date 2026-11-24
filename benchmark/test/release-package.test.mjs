// Failure list, written before implementation:
// 1. A release run is refused at its argument check because it names the published npm package, although the docs
//    and the converter's release gate say a release run reviews that package. It must reach the later gates.
// 2. The argument check is loosened too far: a packed file or a smoke run is admitted under --release.
// 3. An npm release run reads held-out cases on a package record the registry does not confirm: a record whose
//    integrity was changed, an answer from the registry that differs, or no answer at all. Case selection must
//    refuse each before the held-out access log gains a line.
// 4. An npm release run reads golden comments before its access is logged: selection logs the release, the
//    package and its integrity first, and the truth is read only after.
// 5. An npm release run runs the cached package's code (its CLI's --version) before its record is checked
//    against the release and the registry, so a tampered cache runs before it is refused.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { benchRoot, git } from "../lib/cases.mjs";
import { selectCases, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterEach(() => vi.unstubAllEnvs());
afterAll(removeTempDirs);

const AT_ARGS = "--release requires a comparison's local build";
// A cache that already holds a small openqodex 9.9.9 tarball and the registry's answer for it, so the run never
// touches the real bench cache or the network to fetch it. Its CLI writes `ran` into `marker` when it runs.
const cacheWithPackage = (marker = join(tempDir("oq-release-package-marker-"), "ran")) => {
  const cache = tempDir("oq-release-package-run-cache-");
  const src = tempDir("oq-release-package-src-");
  mkdirSync(join(src, "package", "dist"), { recursive: true });
  writeFileSync(join(src, "package", "package.json"), JSON.stringify({ name: "openqodex", version: "9.9.9" }));
  writeFileSync(join(src, "package", "dist", "bin.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  writeFileSync(join(src, "package", "dist", "lib.js"), "export const x = 1;\n");
  const dir = join(cache, "packages", "npm");
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-czf", join(dir, "openqodex-9.9.9.tgz"), "-C", src, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const integrity = `sha512-${createHash("sha512").update(readFileSync(join(dir, "openqodex-9.9.9.tgz"))).digest("base64")}`;
  writeFileSync(join(dir, "openqodex-9.9.9.json"), JSON.stringify({ name: "openqodex", version: "9.9.9", tarball: "https://registry.npmjs.org/openqodex/-/openqodex-9.9.9.tgz", integrity, fetchedAt: "2026-11-01T00:00:00.000Z" }));
  return cache;
};
const run = (cache, release, ...extra) => {
  const r = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--release", release, "--suite", "martian", "--split", "test", "--purpose", "diagnostic", "--reviewers", "claude", "--graph", "on", "--web", "off", "--repeat", "3", "--max-usd", "1", "--max-minutes", "60", "--dry-run", ...extra], { encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: cache } });
  return `${r.stdout}${r.stderr}`;
};

it("a release run with --package npm:<version> passes the argument check, and a file or smoke package does not", () => {
  const marker = join(tempDir("oq-release-package-marker-"), "ran");
  const cache = cacheWithPackage(marker);
  // The package is unpacked from the temp cache, then its record is checked against the release: a record of
  // another version is the next refusal, before the registry is asked, so the test needs no network.
  expect(run(cache, "9.9.8", "--package", "npm:9.9.9"), "npm:<version> did not reach the package record check").toContain("refused: the run names the release 9.9.8, but it reviewed npm:9.9.9 (openqodex@9.9.9)");
  expect(existsSync(join(cache, "packages", "openqodex-" + createHash("sha256").update(readFileSync(join(cache, "packages", "npm", "openqodex-9.9.9.tgz"))).digest("hex").slice(0, 16), "record.json")), "the run did not use the temp cache").toBe(true);
  expect(existsSync(marker), "the package's CLI ran before its record was checked").toBe(false);
  expect(run(cache, "9.9.9", "--package", "file:/nowhere/openqodex-9.9.9.tgz"), "a packed file was admitted under --release").toContain(AT_ARGS);
  expect(run(cache, "9.9.9", "--package", "npm:9.9.9", "--smoke"), "a smoke run was admitted under --release").toContain("--smoke runs development cases only");
});

// The package record run.mjs makes of npm:0.23.0 (lib/package.mjs preparePackage), and the registry's answer for it.
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const record = (patch = {}) => ({ spec: "npm:0.23.0", name: "openqodex", version: "0.23.0", sha256: "a".repeat(64), integrity: INTEGRITY, bytes: 1, registryIntegrity: INTEGRITY, fileCount: 1, ...patch });
const answer = (integrity = INTEGRITY) => ({ name: "openqodex", version: "0.23.0", dist: { integrity } });
// A clean git checkout holding the martian suite files, so the selection tests do not depend on the state of this working tree.
const cleanBenchmark = () => {
  const repo = tempDir("oq-release-package-repo-");
  for (const file of ["suites/martian", "splits/martian-v1.json"]) {
    mkdirSync(join(repo, "benchmark", file, ".."), { recursive: true });
    cpSync(join(benchRoot, file), join(repo, "benchmark", file), { recursive: true });
  }
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "Fixture");
  return { repo, root: join(repo, "benchmark") };
};
const selection = (packageRecord, registryAnswer) => {
  vi.stubEnv("OPENQODEX_BENCH_CACHE", tempDir("oq-release-package-cache-"));
  const accessLog = join(tempDir("oq-release-package-index-"), "heldout-access.jsonl");
  const checkout = cleanBenchmark();
  const options = { suite: "martian", split: "test", release: "0.23.0", packageRecord, registryAnswer, runId: "test-run", by: "tester", purpose: "score", accessLog, root: checkout.root };
  return { accessLog, checkout, select: () => selectCases(options) };
};

it("an npm release run whose registry integrity differs is refused before any case is read", () => {
  const other = `sha512-${"B".repeat(86)}==`;
  const tries = [
    ["the registry gives another integrity", record(), answer(other), /did not review the published build/],
    ["the record's integrity was changed after the registry gave its own", record({ integrity: other }), answer(), /integrity that equals the one the registry gave/],
    ["the record was changed to match a tampered answer", record({ integrity: other, registryIntegrity: other }), answer(), /did not review the published build/],
    ["the registry was never asked", record(), null, /did not review the published build/],
    ["the record names another version", record({ spec: "npm:0.22.0", version: "0.22.0" }), answer(), /not openqodex@0\.23\.0 from npm/],
  ];
  for (const [why, packageRecord, registryAnswer, refusal] of tries) {
    const s = selection(packageRecord, registryAnswer);
    expect(s.select, `${why}: the selection was admitted`).toThrow(refusal);
    expect(existsSync(s.accessLog), `${why}: the access log gained a line`).toBe(false);
  }
});

it("an npm release run logs held-out access before reading golden comments", () => {
  const s = selection(record(), answer());
  const cases = s.select();
  expect(cases.length).toBeGreaterThan(0);
  const lines = readFileSync(s.accessLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines, "the access line does not name the release, the package and its integrity").toEqual([expect.objectContaining({ suite: "martian", purpose: "release-run", runPurpose: "score", release: "0.23.0", runId: "test-run", caseCount: cases.length, caseIds: cases.map((c) => c.id), build: "npm openqodex@0.23.0", integrity: INTEGRITY, harness: git(s.checkout.repo, "rev-parse", "HEAD").trim() })]);
  expect(lines[0], "an npm release run claims a comparison record").not.toHaveProperty("comparisonHash");
  // The cache holds no golden file: selection read none, and a read after it fails.
  expect(() => truthOf(cases[0], { cache: tempDir("oq-release-package-empty-") })).toThrow(/not in the cache/);
});

it("an npm release run on a dirty checkout is refused before any held-out case is selected", () => {
  const s = selection(record(), answer());
  writeFileSync(join(s.checkout.repo, "scratch.txt"), "dirty\n");
  expect(s.select, "an npm release run was admitted on a dirty checkout").toThrow(/npm release requires a clean checkout; the tree is dirty/);
  expect(existsSync(s.accessLog), "the access log gained a line").toBe(false);
});
