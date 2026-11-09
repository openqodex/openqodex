// The outside-run features of run.mjs (P4-04): the package build under test
// (--package), every model call held by the run's reservation ledger, the
// halt rules, the development-only smoke run (--smoke) and the proof-only
// build of cases (--materialise-only).
//
// run.mjs is run as a developer runs it, on a package build this file packs
// from packages/cli with npm pack (so no build provenance of the checkout is
// read or written), with the scripted model as the only stand-in: no test
// makes a model call. Git, the library, the budget ledger, the materialiser
// and the scorer are the real ones. Pull request cases are built from a real
// upstream repository in a temp folder over file://.
//
// Failures guarded, written before the code:
// 1. Overspend: a review whose calls cost $0.20 each under a $0.50 cap per
//    review sends a third call, or the run records a refused call as spent.
// 2. Two concurrent reviews overrun the run cap, or a review the run's
//    ledger has no room for leaves a sample or a spend.
// 3. Burning budget on a broken setup: two reviews in a row end incomplete
//    for the same reason and the run goes on; a halt that loses a finished
//    sample or its spend, or that --resume cannot continue.
// 4. A provider that refuses the key or the quota, a served model that
//    changes, a share of incomplete reviews or a cost far past the estimate
//    is read as one more sample instead of a reason to stop.
// 5. A held-out case runs before a release: --smoke takes a test-split case
//    or a held-out case named in --cases, or more reviews than a smoke run
//    is for; a smoke run is indexed.
// 6. --materialise-only runs a scanner, a reviewer or the CLI, writes no
//    proof, or builds a held-out case with no line in the held-out access
//    log.
// 7. A run on a package build is recorded as the checkout's commit, or
//    without the package's version and sha.
// From the code review of the first version (sol):
// 8. A published package is taken from wherever the caller's npm points,
//    or from a tarball on another host, or under a version the registry
//    does not list.
// 9. A package run writes outside the run and the bench cache (npm's own
//    cache and logs under the home folder).
// 10. An unpacked package edited after it was unpacked runs under the
//    tarball's sha256.
// 11. A tarball member is written outside the package's folder, or as a
//    link.
// 12. A per-minute rate limit halts the run as a quota refusal, or is
//    retried without a bound.
// 13. The cost rules divide the spend of reviews still running by the
//    reviews finished.
// 14. Retries let a smoke run invoke the reviewer more than five times per
//    configuration.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchRoot, casesRoot, git, gitEnv, listCases, repoRoot } from "../lib/cases.mjs";
import { readLedger } from "../lib/budget.mjs";
import { haltRules, retryOnce, reasonClass, smokeCap } from "../lib/halts.mjs";
import { materialiseOnly } from "../lib/materialise-only.mjs";
import { preparePackage, tarballOf } from "../lib/package.mjs";
import { readSuite } from "../lib/suites.mjs";
import { publishRun } from "../publish-run.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const RUN = join(benchRoot, "run.mjs");
const CONFIG = "model-scripted-graph-on";
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The package build under test: packages/cli packed as npm would publish it.
let tarball = null;
beforeAll(() => {
  const dir = tempDir("oq-outside-pack-");
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: join(repoRoot, "packages/cli"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  tarball = join(dir, JSON.parse(out)[0].filename);
}, 120_000);

// A script for the scripted model. `reply` null answers each brief's
// protocol; a text is sent as every answer instead, which fails its checks
// and makes each session ask twice more before its fresh-session retry.
function script(more = {}) {
  const file = join(tempDir("oq-outside-script-"), "script.json");
  write(file, JSON.stringify({ version: 1, model: "scripted", served: "scripted-1", prices: { input: 1, cachedInput: 0, output: 1 }, summary: "Reads the change.", findings: [], dropReason: "The scripted model drops every candidate.", reply: null, ...more }));
  return file;
}

// A call that costs exactly $0.20 and may cost at most $0.20: the output
// allowance is 1,000 tokens at $200 per million, input is free, and every
// answer fills the allowance.
const PRICEY = { prices: { input: 0, cachedInput: 0, output: 200 }, reply: `Not an answer. ${"x".repeat(6000)}` };

// run.mjs on the package build, with the scripted model, an empty tools
// folder (no scanner runs, so the preflight needs --allow-missing-scanners)
// and a clone cache of its own; a resume passes the first run's.
function run(args, { cache = tempDir("oq-outside-cache-"), home = tempDir("oq-outside-oqhome-") } = {}) {
  mkdirSync(join(home, "tools"), { recursive: true });
  const p = spawnSync(process.execPath, [RUN, "--package", `file:${tarball}`, "--reviewers", "model:scripted", "--install-root", join(home, "tools"), "--allow-missing-scanners", "--max-minutes", "30", ...args], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: cache }, timeout: 300_000 });
  return { ...p, cache, home };
}

const samplesOf = (out, name) => (existsSync(join(out, "samples", name, CONFIG)) ? readdirSync(join(out, "samples", name, CONFIG)).sort() : []);

describe("overspend", () => {
  it("refuses the third $0.20 call of a review under a $0.50 cap, saves the sample incomplete, and counts only what was sent", { timeout: 300_000 }, () => {
    const out = join(tempDir("oq-outside-overspend-"), "run");
    const r = run(["--cases", "flask-path-traversal", "--repeat", "1", "--max-usd", "2", "--review-max-usd", "0.5", "--max-output-tokens", "1000", "--model-script", script(PRICEY), "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const sample = readJson(join(out, "samples", "flask-path-traversal", CONFIG, "1", "sample.json"));
    expect(sample.status).toBe("incomplete");
    expect(sample.failure).toMatch(/budget refused before/);
    const usage = readJson(join(out, "samples", "flask-path-traversal", CONFIG, "1", "usage.json"));
    // The two finder sessions run at once, so their call order is not fixed.
    expect(usage.calls.filter((c) => c.outcome === "ok")).toHaveLength(2);
    expect(usage.calls.filter((c) => c.outcome === "refused").length).toBeGreaterThanOrEqual(1);
    expect(usage.calls.every((c) => c.outcome === "ok" || c.outcome === "refused")).toBe(true);
    expect(usage.totals.costUsd).toBeCloseTo(0.4, 9);
    // The refused call reserved nothing and spent nothing: two calls were held and settled.
    const ledger = readLedger(out);
    expect(ledger.spentUsd).toBeCloseTo(0.4, 9);
    expect(ledger.events.filter((e) => e.op === "reserve" && e.kind === "call")).toHaveLength(2);
    expect(ledger.peakUsd).toBeLessThanOrEqual(2);
    const m = readJson(join(out, "manifest.json"));
    expect(m.ended.how).toBe("finished");
    expect(m.ended.spentUsd).toBeCloseTo(0.4, 9);
  });
});

describe("two concurrent reviews overrun the run cap", () => {
  it("never holds more than --max-usd, and the review with no room leaves no sample and no spend", { timeout: 300_000 }, () => {
    const out = join(tempDir("oq-outside-concurrent-"), "run");
    const r = run(["--cases", "flask-path-traversal,go-http-handler", "--repeat", "1", "--concurrency", "2", "--max-usd", "0.7", "--review-max-usd", "0.5", "--max-output-tokens", "1000", "--model-script", script(PRICEY), "--out", out]);
    expect(r.status, r.stderr).toBe(1);
    const m = readJson(join(out, "manifest.json"));
    expect(m.ended).toMatchObject({ how: "budget", limit: "max-usd", limitKind: "hard" });
    const saved = ["flask-path-traversal", "go-http-handler"].filter((n) => samplesOf(out, n).length > 0);
    expect(saved).toHaveLength(1);
    const ledger = readLedger(out);
    expect(ledger.peakUsd).toBeLessThanOrEqual(0.7);
    expect(ledger.spentUsd).toBeCloseTo(0.4, 9);
    // One review's envelope only: the other was never reserved.
    expect(ledger.events.filter((e) => e.op === "reserve" && e.kind === "review")).toHaveLength(1);
  });
});

describe("burning budget on a broken setup", () => {
  it("halts after two incomplete reviews in a row with one reason, keeps both samples and the spend, records the halt, and --resume continues", { timeout: 300_000 }, () => {
    const out = join(tempDir("oq-outside-halt-"), "run");
    const cases = "flask-path-traversal,go-http-handler,express-route-param";
    const file = script({ reply: "I read the change and it looks fine." });
    const args = ["--cases", cases, "--repeat", "1", "--concurrency", "1", "--max-usd", "2", "--review-max-usd", "0.5", "--model-script", file, "--out", out];
    const first = run(args);
    expect(first.status, first.stderr).toBe(1);
    const m = readJson(join(out, "manifest.json"));
    expect(m.ended.how).toBe("stopped");
    expect(m.ended.halt).toMatchObject({ rule: "same-reason-twice" });
    expect(m.ended.halt.why).toMatch(/answer-checks/);
    const order = m.jobs.map((j) => j.jobId.split("/")[1].split("@")[0]);
    expect(order.slice(0, 2).map((n) => samplesOf(out, n))).toEqual([["1"], ["1"]]);
    expect(samplesOf(out, order[2])).toEqual([]);
    // The spend of the finished samples is recorded, and it is what they cost.
    const costs = order.slice(0, 2).map((n) => readJson(join(out, "samples", n, CONFIG, "1", "sample.json")).usage.cost_usd);
    expect(costs.every((c) => c > 0)).toBe(true);
    // A staged review is many calls, each recorded to nine decimals, so the
    // two sums agree to a millionth of a dollar, not to the last decimal.
    expect(m.ended.spentUsd).toBeCloseTo(costs[0] + costs[1], 6);
    expect(readLedger(out).spentUsd).toBeCloseTo(costs[0] + costs[1], 6);
    // What a run on a package build records: the package, not the checkout's commit.
    expect(m.package).toMatchObject({ spec: `file:${tarball.split("/").at(-1)}`, name: "openqodex", sha256: sha256(tarball) });
    expect(m.package.version).toBe(readJson(join(repoRoot, "packages/cli/package.json")).version);
    expect(m.package.integrity).toMatch(/^sha512-/);
    expect(m.build.commit).toBeNull();
    expect(m.build.short).toBe(`v${m.package.version}`);
    expect(m.smoke).toBe(false);
    expect(m.board).toBeNull();
    expect(m.budget.hardCaps).toEqual({ maxUsd: 2, reviewMaxUsd: 0.5 });
    expect(m.servedModels).toEqual({ [CONFIG]: ["scripted-1"] });

    const second = run([...args, "--resume"], { cache: first.cache, home: first.home });
    expect(second.status, second.stderr).toBe(0);
    expect(samplesOf(out, order[2])).toEqual(["1"]);
    const ended = lines(join(out, "resumes.jsonl")).at(-1);
    expect(ended).toMatchObject({ event: "ended", how: "finished" });
  });
});

describe("a provider refusal, a served-model change, a share of incomplete reviews or a cost past the estimate is read as one more sample", () => {
  const complete = (more = {}) => ({ config: "model-x-graph-on", status: "complete", failure: null, servedModels: ["m-1"], usage: { cost_usd: 0.1 }, ...more });
  const incomplete = (failure, more = {}) => complete({ status: "incomplete", failure, ...more });
  const own = (usd = 0.1) => ({ ownUsd: usd, reservedUsd: 0 });

  it("stops at once on a key, quota or billing refusal from the endpoint", () => {
    for (const failure of ["the reviewer failed: the model call failed: HTTP 401: Access denied due to invalid subscription key", "the model call failed: HTTP 403: Forbidden", "the model call failed: HTTP 429 (insufficient_quota): You exceeded your current quota", "the model call failed: HTTP 429: You exceeded your current quota, please check your plan and billing details"]) {
      expect(haltRules({ maxUsd: 10, toRun: 20 }).after(incomplete(failure), own())).toMatchObject({ rule: "provider-blocked" });
    }
  });

  it("reads a per-minute rate limit as retryable after a bounded wait, never as a quota refusal", () => {
    const perMinute = incomplete("the model call failed: HTTP 429: per-minute quota exceeded; retry after 2 seconds");
    const limited = incomplete("the model call failed: HTTP 429 (rate_limit_exceeded): Rate limit is exceeded");
    expect(haltRules({ maxUsd: 10, toRun: 20 }).after(perMinute, own())).toBeNull();
    expect(reasonClass(perMinute.failure)).toBe("provider-rate-limit");
    // One retry per review, after the wait the provider names, or a fixed one, never past a minute.
    expect(retryOnce(perMinute, 0)).toEqual({ waitMs: 2000 });
    expect(retryOnce(limited, 0)).toEqual({ waitMs: 10_000 });
    expect(retryOnce(incomplete("the model call failed: HTTP 429: Please retry after 900 seconds"), 0)).toEqual({ waitMs: 60_000 });
    expect(retryOnce(perMinute, 1)).toBeNull();
    expect(retryOnce(incomplete("the model call failed: HTTP 429 (insufficient_quota): You exceeded your current quota"), 0)).toBeNull();
    expect(retryOnce(incomplete("budget refused before correction call 3"), 0)).toBeNull();
    expect(retryOnce(complete(), 0)).toBeNull();
    // A rate limit that outlasts its retry, twice in a row, halts.
    const rules = haltRules({ maxUsd: 10, toRun: 20 });
    expect(rules.after(limited, own())).toBeNull();
    expect(rules.after(perMinute, own())).toMatchObject({ rule: "same-reason-twice" });
  });

  it("stops when the served model changes during the run, or a review names two", () => {
    const rules = haltRules({ maxUsd: 10, toRun: 20, servedBefore: { "model-x-graph-on": ["m-1"] } });
    expect(rules.after(complete(), own())).toBeNull();
    expect(rules.after(complete({ servedModels: ["m-2"] }), own())).toMatchObject({ rule: "served-model-changed" });
    expect(haltRules({ maxUsd: 10, toRun: 20 }).after(complete({ servedModels: ["m-1", "m-2"] }), own())).toMatchObject({ rule: "served-model-changed" });
  });

  it("does not halt when two model reviewers of one run are answered by their own models", () => {
    const rules = haltRules({ maxUsd: 10, toRun: 20, servedBefore: { "model-x-graph-on": ["m-1"] } });
    expect(rules.after(complete({ config: "model-y-graph-on", servedModels: ["m-2"] }), own())).toBeNull();
    expect(rules.after(complete(), own())).toBeNull();
    expect(rules.after(complete({ config: "model-y-graph-on", servedModels: ["m-3"] }), own())).toMatchObject({ rule: "served-model-changed" });
  });

  it("does not halt on two incomplete reviews in a row with different reasons", () => {
    const rules = haltRules({ maxUsd: 10, toRun: 20 });
    expect(rules.after(incomplete("budget refused before correction call 3"), own())).toBeNull();
    expect(rules.after(incomplete("the reviewer's answer still failed 2 checks after the correction rounds"), own())).toBeNull();
    expect(reasonClass("budget refused before brief call 1")).toBe(reasonClass("budget refused before correction call 3"));
  });

  it("classes exhausted staged answers as answer checks, keeping budget and deadline precedence", () => {
    const finder = "unit u1 was not examined by local: 1. the answer is not one JSON object; hunk h1 of app.py was not examined by the local pass";
    const verifier = "candidates c1, k2 were not verified: 1. candidate c1: needs exactly one verdict, got 0";
    for (const failure of [finder, verifier, "candidates c1 were not verified: the verifier exhausted its correction rounds"]) {
      expect(reasonClass(failure)).toBe("answer-checks");
      expect(reasonClass(`${failure}; budget refused before find call 2`)).toBe("budget");
      expect(reasonClass(`${failure}; the reviewer timed out and was stopped`)).toBe("deadline");
    }
    // A staged session that ran out of time or was stopped is not an answer check.
    expect(reasonClass("unit u1 was not examined by local: the finders' time ran out")).toBe("deadline");
    expect(reasonClass("candidates c1 were not verified: the verifier did not finish in time")).toBe("deadline");
    expect(reasonClass("unit u1 was not examined by local: the reviewer tried to read outside the snapshot")).not.toBe("answer-checks");
  });

  it("after 10 reviews, stops when more than 20% are incomplete, when the mean cost passes 1.5 times the estimate, or when the forecast passes --max-usd", () => {
    const failures = ["budget refused before brief call 1", "the reviewer timed out and was stopped", "the reviewer's answer still failed 1 check after the correction rounds"];
    const share = haltRules({ maxUsd: 100, toRun: 40 });
    const said = [];
    for (let i = 0; i < 10; i++) said.push(share.after(i % 3 === 0 && i < 9 ? incomplete(failures[i / 3]) : complete(), own()));
    expect(said.slice(0, 9).every((x) => x === null)).toBe(true);
    expect(said[9]).toMatchObject({ rule: "incomplete-share" });

    const fine = haltRules({ maxUsd: 100, toRun: 40 });
    for (let i = 0; i < 10; i++) expect(fine.after(i < 2 ? incomplete(failures[i]) : complete(), own())).toBeNull();

    const dear = haltRules({ maxUsd: 100, toRun: 40, estimatePerReview: 0.05 });
    for (let i = 0; i < 9; i++) expect(dear.after(complete(), own(0.1))).toBeNull();
    expect(dear.after(complete(), own(0.1))).toMatchObject({ rule: "cost-over-estimate" });

    const forecast = haltRules({ maxUsd: 3, toRun: 40 });
    for (let i = 0; i < 9; i++) expect(forecast.after(complete(), own(0.1))).toBeNull();
    const past = forecast.after(complete(), { ownUsd: 0.1, reservedUsd: 0.7 });
    expect(past).toMatchObject({ rule: "forecast-past-cap" });
    // Reservations of reviews in flight are named apart, never counted as spend.
    expect(past.why).toMatch(/\$0\.7 .*in flight/);
  });

  it("takes the mean cost over the finished reviews' own spend, never over the spend of reviews still running", () => {
    // Ten reviews at $0.05 each finish while reviews still running have
    // spent $2 more (in the ledger's total) and hold $2 in reservations.
    const rules = haltRules({ maxUsd: 3, toRun: 40, estimatePerReview: 0.05 });
    for (let i = 0; i < 10; i++) expect(rules.after(complete(), { ownUsd: 0.05, reservedUsd: 2, spentUsd: 0.05 * (i + 1) + 2 })).toBeNull();
  });
});

describe("retries let a smoke run invoke the reviewer more than five times per configuration", () => {
  it("counts every invocation, retries included, and stops at the cap saying how many were retries", () => {
    const cap = smokeCap(5);
    expect(cap.take("model-x-graph-on")).toBeNull();
    expect(cap.take("model-x-graph-on", { retry: true })).toBeNull();
    for (let i = 0; i < 3; i++) expect(cap.take("model-x-graph-on")).toBeNull();
    expect(cap.take("model-y-graph-on")).toBeNull();
    const stop = cap.take("model-x-graph-on");
    expect(stop).toMatchObject({ rule: "smoke-cap" });
    expect(stop.why).toMatch(/5 times.*1 of them a retry/);
    // A resumed smoke run counts the invocations its earlier attempts made.
    const resumed = smokeCap(5, { rows: [{ config: "c", attempt: 1 }, { config: "c", attempt: 2 }, { config: "c", attempt: 1 }, { config: "c", attempt: 1 }] });
    expect(resumed.take("c")).toBeNull();
    expect(resumed.take("c", { retry: true })).toMatchObject({ rule: "smoke-cap" });
  });
});

describe("a held-out case runs before a release", () => {
  const suite = readSuite("aacr");
  const usable = (name) => suite.byName.get(name)?.status === "usable";
  const heldOut = suite.split.cases.test.find(usable);

  it("refuses --smoke on the test split, and a held-out case named in --cases, before anything is fetched or written", () => {
    for (const args of [["--smoke", "--suite", "aacr", "--split", "test"], ["--smoke", "--cases", `aacr/${heldOut}`]]) {
      const out = join(tempDir("oq-outside-smoke-"), "run");
      const r = run([...args, "--max-usd", "1", "--review-max-usd", "0.5", "--out", out]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/held out|development/);
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(r.cache)).toEqual([]);
    }
  });

  it("refuses a smoke run of more reviews than a smoke run is for", () => {
    const out = join(tempDir("oq-outside-smoke-"), "run");
    const six = listCases().slice(0, 6).join(",");
    const r = run(["--smoke", "--cases", six, "--max-usd", "1", "--review-max-usd", "0.5", "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--smoke.*at most 5/);
    expect(existsSync(out)).toBe(false);
    // Repeats added to a smoke run would grow it past its size.
    const more = run(["--smoke", "--add-repeats", "5", "--cases", "flask-path-traversal", "--max-usd", "1", "--review-max-usd", "0.5", "--out", out]);
    expect(more.status).toBe(2);
    expect(more.stderr).toMatch(/--add-repeats.*smoke/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses --split test without --materialise-only", () => {
    const r = run(["--suite", "aacr", "--split", "test", "--max-usd", "1", "--review-max-usd", "0.5"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/held out/);
  });

  it("never indexes a smoke run", async () => {
    const runFolder = join(tempDir("oq-outside-smoke-index-"), "2026-10-11-v0.12.0-planted-review-server");
    write(join(runFolder, "manifest.json"), JSON.stringify({ version: 3, started_at: "2026-10-11T10:00:00.000Z", smoke: true, build: { commit: "a".repeat(40), short: "aaaaaaa", dirty: false }, configs: [CONFIG], repeat: 1, planned: 1, cases: ["flask-path-traversal"], ended: { how: "finished", why: null } }));
    write(join(runFolder, "cases", "flask-path-traversal.json"), readFileSync(join(casesRoot, "flask-path-traversal", "case.json"), "utf8"));
    write(join(runFolder, "score.json"), JSON.stringify({ byConfig: {} }));
    const runs = tempDir("oq-outside-smoke-runs-");
    await expect(publishRun(runFolder, { dryRun: true, writeIndex: true, runs, out: tempDir("oq-outside-smoke-asset-") })).rejects.toThrow(/smoke run/);
    expect(readdirSync(runs)).toEqual([]);
  });
});

// A gzipped tar of `members` ({ name, type: file, dir, symlink or hardlink,
// body, link }), written header by header in the ustar layout npm pack
// writes.
function tgz(members) {
  const blocks = [];
  for (const m of members) {
    const h = Buffer.alloc(512);
    const body = Buffer.from(m.body ?? "");
    h.write(m.name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write({ file: "0", dir: "5", symlink: "2", hardlink: "1" }[m.type ?? "file"], 156);
    if (m.link) h.write(m.link, 157, 100, "utf8");
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// The files a package build must hold.
const minimal = (version = "9.9.9") => [
  { name: "package/package.json", body: JSON.stringify({ name: "openqodex", version }) },
  { name: "package/dist/bin.js", body: "console.log('bin');\n" },
  { name: "package/dist/lib.js", body: "export const x = 1;\n" },
];

describe("a published package is taken from elsewhere than the registry", () => {
  const packument = (dist) => ({ name: "openqodex", versions: { "0.12.0": { dist } } });
  const good = { tarball: "https://registry.npmjs.org/openqodex/-/openqodex-0.12.0.tgz", integrity: "sha512-abc sha1-def" };

  it("takes the tarball and its sha512 integrity from the registry's own answer, and refuses an absent version, another host or plain http", () => {
    expect(tarballOf(packument(good), "0.12.0")).toEqual({ url: good.tarball, integrity: "sha512-abc" });
    expect(() => tarballOf(packument(good), "0.13.0")).toThrow(/lists no openqodex@0\.13\.0/);
    expect(() => tarballOf(packument({ ...good, tarball: "https://registry.npmjs.org.evil.example/openqodex/-/openqodex-0.12.0.tgz" }), "0.12.0")).toThrow(/https:\/\/registry\.npmjs\.org/);
    expect(() => tarballOf(packument({ ...good, tarball: "http://registry.npmjs.org/openqodex/-/openqodex-0.12.0.tgz" }), "0.12.0")).toThrow(/https:\/\/registry\.npmjs\.org/);
    expect(() => tarballOf(packument({ ...good, integrity: "sha1-def" }), "0.12.0")).toThrow(/sha512/);
  });
});

describe("a package run writes outside the run and the bench cache", () => {
  it("runs a published version from the bench cache and writes nothing to the home folder or the temp folder", { timeout: 300_000 }, () => {
    const version = readJson(join(repoRoot, "packages/cli/package.json")).version;
    const cache = tempDir("oq-outside-cache-");
    mkdirSync(join(cache, "packages", "npm"), { recursive: true });
    copyFileSync(tarball, join(cache, "packages", "npm", `openqodex-${version}.tgz`));
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    // The registry's answer as a first fetch saves it; the packed build
    // stands in for the published one, so the run needs no network.
    write(join(cache, "packages", "npm", `openqodex-${version}.json`), JSON.stringify({ name: "openqodex", version, tarball: `https://registry.npmjs.org/openqodex/-/openqodex-${version}.tgz`, integrity, fetchedAt: "2026-10-11T00:00:00.000Z" }));
    const home = tempDir("oq-outside-home-");
    const tmp = tempDir("oq-outside-tmp-");
    const oq = tempDir("oq-outside-oqhome-");
    mkdirSync(join(oq, "tools"));
    const out = join(tempDir("oq-outside-npm-"), "run");
    const p = spawnSync(process.execPath, [RUN, "--package", `npm:${version}`, "--reviewers", "model:scripted", "--install-root", join(oq, "tools"), "--allow-missing-scanners", "--cases", "flask-path-traversal", "--repeat", "1", "--max-usd", "1", "--max-minutes", "30", "--review-max-usd", "0.5", "--model-script", script(), "--out", out], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: tmp, OPENQODEX_BENCH_CACHE: cache }, timeout: 300_000 });
    expect(p.status, p.stderr).toBe(0);
    expect(readJson(join(out, "manifest.json")).package).toMatchObject({ spec: `npm:${version}`, version, sha256: sha256(tarball), integrity, registryIntegrity: integrity });
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
    expect(readdirSync(cache)).toEqual(["packages"]);
  });
});

describe("an unpacked package edited after it was unpacked runs under the tarball's sha256", () => {
  it("checks every unpacked file against the record before use, and unpacks again on any difference", async () => {
    const cache = tempDir("oq-outside-cache-");
    const first = await preparePackage(`file:${tarball}`, { cache });
    expect(first.extracted).toBe("now");
    const original = readFileSync(first.lib);
    expect(first.record.files["package/dist/lib.js"]).toBe(createHash("sha256").update(original).digest("hex"));
    expect((await preparePackage(`file:${tarball}`, { cache })).extracted).toBe("reused");
    appendFileSync(first.lib, "\nprocess.exit(0);\n");
    const again = await preparePackage(`file:${tarball}`, { cache });
    expect(again.extracted).toBe("again");
    expect(readFileSync(again.lib).equals(original)).toBe(true);
    // A file added to the folder is a difference too.
    writeFileSync(join(again.dir, "dist", "extra.js"), "planted");
    expect((await preparePackage(`file:${tarball}`, { cache })).extracted).toBe("again");
    expect(existsSync(join(again.dir, "dist", "extra.js"))).toBe(false);
  });
});

describe("a tarball member is written outside the package's folder, or as a link", () => {
  it("refuses an absolute path, a path through .., a symbolic link and a hard link, and writes nothing", async () => {
    const bad = [
      [{ name: "/tmp/oq-outside-absolute-evil.txt", body: "x" }, /absolute/],
      [{ name: "package/../../evil.txt", body: "x" }, /\.\./],
      [{ name: "package/dist/link.js", type: "symlink", link: "/etc/passwd" }, /symbolic link/],
      [{ name: "package/dist/hard.js", type: "hardlink", link: "package/dist/bin.js" }, /hard link/],
    ];
    for (const [member, why] of bad) {
      const dir = tempDir("oq-outside-tar-");
      const file = join(dir, "openqodex-9.9.9.tgz");
      writeFileSync(file, tgz([...minimal(), member]));
      const cache = join(dir, "cache");
      await expect(preparePackage(`file:${file}`, { cache })).rejects.toThrow(why);
      // The tarball is refused before anything is written, the cache folder included.
      expect(existsSync(cache)).toBe(false);
      expect(existsSync(join(dir, "evil.txt"))).toBe(false);
    }
    expect(existsSync("/tmp/oq-outside-absolute-evil.txt")).toBe(false);
    // The same package without the bad member unpacks.
    const dir = tempDir("oq-outside-tar-");
    writeFileSync(join(dir, "openqodex-9.9.9.tgz"), tgz(minimal()));
    const ok = await preparePackage(`file:${join(dir, "openqodex-9.9.9.tgz")}`, { cache: join(dir, "cache") });
    expect(ok.record).toMatchObject({ name: "openqodex", version: "9.9.9" });
    expect(readFileSync(ok.lib, "utf8")).toBe("export const x = 1;\n");
  });
});

// A real upstream with one pull request: the merge base, the head on
// refs/pull/7/head, and main moved on, so the dataset's base is not the
// merge base.
function upstream() {
  const dir = join(tempDir("oq-outside-up-"), "widget");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Base");
  const mergeBase = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "one\ntwo, changed\n");
  git(dir, "commit", "-q", "-am", "Feature");
  const headSha = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), "main moved on\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Main later");
  const baseSha = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "update-ref", "refs/pull/7/head", headSha);
  git(dir, "branch", "-q", "-D", "feature");
  const tree = (rev) => execFileSync("git", ["rev-parse", `${rev}^{tree}`], { cwd: dir, env: gitEnv(), encoding: "utf8" }).trim();
  return { dir, baseSha, headSha, mergeBase, baseTree: tree(mergeBase), headTree: tree(headSha) };
}

const MIT = { spdx: "MIT", chosen: "MIT", class: "permissive", file: "LICENSE", fileSha256: null, at: "the default branch", source: "the GitHub licence API", use: "local review and scoring", excerpts: "full" };

// A case in the shape lib/suites.mjs readCase returns for an AACR entry.
function prCase(up, { split = "dev", licence = MIT, name = "acme__widget-7" } = {}) {
  const hash = createHash("sha256").update(`${up.dir}\0${up.headSha}\0${name}`).digest("hex");
  const cloneUrl = `file://${up.dir}`;
  return {
    id: `aacr/${name}@${hash.slice(0, 8)}`,
    suite: "aacr",
    name,
    hash,
    split,
    status: "usable",
    excludedWhy: null,
    source: { repo: "acme/widget", prUrl: "https://github.com/acme/widget/pull/7", cloneUrl, licence },
    materialise: { kind: "pr", cloneUrl, prRef: "refs/pull/7/head", baseSha: up.baseSha, headSha: up.headSha, mergeBaseSha: null },
  };
}

describe("--materialise-only runs a scanner or a reviewer, writes no proof, or builds a held-out case unlogged", () => {
  it("builds planted cases in the shape a model review needs and writes their proof, with no CLI, no sample, no manifest and no spend", { timeout: 120_000 }, () => {
    const out = join(tempDir("oq-outside-mat-"), "proof");
    const r = spawnSync(process.execPath, [RUN, "--materialise-only", "--reviewers", "model:scripted", "--cases", "flask-path-traversal,go-http-handler", "--cli", join(tempDir("oq-outside-nocli-"), "bin.js"), "--out", out], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OPENQODEX_BENCH_CACHE: tempDir("oq-outside-cache-") }, timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["proof.json"]);
    const proof = readJson(join(out, "proof.json"));
    expect(proof).toMatchObject({ purpose: "materialise-only", shape: "server", suite: "planted", proved: 2, failed: 0 });
    for (const c of proof.cases) {
      expect(c.ok).toBe(true);
      expect(c.built.baseTree).toMatch(/^[0-9a-f]{40}$/);
      expect(c.built.headTree).toMatch(/^[0-9a-f]{40}$/);
      expect(c.built.baseTree).not.toBe(c.built.headTree);
      expect(c.ancestor).toMatchObject({ isAncestor: true });
    }
  });

  it("logs every held-out suite it builds before building it, proves trees, licence and ancestry, and fails a case it may not fetch", () => {
    const up = upstream();
    const cache = tempDir("oq-outside-cache-");
    const accessLog = join(tempDir("oq-outside-index-"), "heldout-access.jsonl");
    const held = prCase(up, { split: "test" });
    const dev = prCase(up, { name: "acme__widget-8" });
    const unlicensed = prCase(up, { split: "test", name: "acme__widget-9", licence: { ...MIT, spdx: null, chosen: null, class: "none" } });
    const proof = materialiseOnly({ cases: [held, dev, unlicensed], shape: "server", workRoot: tempDir("oq-outside-work-"), accessLog, by: "a test", cache, allowFileUrl: true });
    const access = lines(accessLog);
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ suite: "aacr", caseCount: 2, purpose: "materialise-only", runId: null, release: null, by: "a test" });
    expect(lines(join(cache, "held-out-access.log")).map((l) => l.caseId)).toEqual([held.id]);
    expect(proof).toMatchObject({ proved: 2, failed: 1, heldOut: 2 });
    const byId = Object.fromEntries(proof.cases.map((c) => [c.caseId, c]));
    for (const c of [held, dev]) {
      const p = byId[c.id];
      expect(p.ok).toBe(true);
      expect(p.licence).toMatchObject({ class: "permissive", spdx: "MIT" });
      expect(p.upstream).toMatchObject({ baseSha: up.baseSha, headSha: up.headSha, mergeBaseSha: up.mergeBase, mergeBaseTree: up.baseTree, headTree: up.headTree });
      expect(p.built).toMatchObject({ baseTree: up.baseTree, headTree: up.headTree });
      expect(p.ancestor).toMatchObject({ isAncestor: true });
    }
    expect(byId[unlicensed.id].ok).toBe(false);
    expect(byId[unlicensed.id].error).toMatch(/licence none/);
  });

  it("refuses to build a held-out case when its access cannot be logged", () => {
    const up = upstream();
    const cache = tempDir("oq-outside-cache-");
    const index = tempDir("oq-outside-index-");
    mkdirSync(join(index, "heldout-access.jsonl"));
    expect(() => materialiseOnly({ cases: [prCase(up, { split: "test" })], shape: "laptop", workRoot: tempDir("oq-outside-work-"), accessLog: join(index, "heldout-access.jsonl"), by: null, cache, allowFileUrl: true })).toThrow(/held-out access/);
    expect(existsSync(join(cache, "repos"))).toBe(false);
  });
});
