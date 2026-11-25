// Failure cases are listed in greptile-failures.md. Every input comes from
// the pinned public datasets. The tree check uses a real fork clone.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ingestGreptile, validateGreptileEntry } from "../ingest/greptile.mjs";
import { verifyMartianMapping, verifyPublishedMartian } from "../ingest/martian.mjs";
import { benchRoot, git } from "../lib/cases.mjs";
import { GREPTILE_REPOS, greptileRows } from "../lib/greptile.mjs";
import { cacheRoot, saveRepoAnswer } from "../lib/licence.mjs";
import { seenTree } from "../lib/materialise.mjs";
import { canonicalJson, entryHash, materialise, readCase, sha256, splitRewriteProblems, suiteHashOf, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const cache = cacheRoot();
let result;
let entry;
let c;
let repo;

beforeAll(async () => {
  result = await ingestGreptile({ cache });
  entry = result.suite.cases.find((e) => e.name === "ai-code-review-evaluation__discourse-greptile-1");
  c = readCase(entry.id);
  repo = materialise(c, tempDir("oq-greptile-real-"), { cache, shape: "server" }).dir;
}, 300_000);

function sourceFixture(change) {
  const sources = JSON.parse(readFileSync(join(benchRoot, "suites/greptile/sources.json"), "utf8"));
  const local = tempDir("oq-greptile-sources-");
  cpSync(join(cache, "raw/greptile"), join(local, "raw/greptile"), { recursive: true });
  change(sources, local);
  sources.repositoriesSha256 = sha256(canonicalJson(sources.repositories));
  return { sources, cache: local, offline: true };
}

function pageFixture(change) {
  return sourceFixture((sources, local) => {
    const pin = sources.original.asset;
    const path = join(cache, "raw/greptile", pin.path);
    const rows = greptileRows(readFileSync(path, "utf8"));
    change(rows);
    const text = Object.keys(GREPTILE_REPOS).map((id) => {
      const bugs = rows.filter((r) => r.dataset === id);
      const fork = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(rows.find((r) => r.dataset === id).prUrl)[1];
      return `{id:"${id}",label:"${id}",bugs:${JSON.stringify(bugs)},toolResults:[{name:"Greptile",href:"https://github.com/${fork}/pulls"}]}`;
    }).join("\n");
    pin.sha256 = sha256(text);
    sources.original.revision = `sha256:${pin.sha256}`;
    writeFileSync(join(local, "raw/greptile", pin.path), text);
  });
}

it.each([false, true])("ignores a cached repository answer with found %s and no licence", async (found) => {
  const ctx = sourceFixture(() => {});
  saveRepoAnswer(ctx.cache, { ...ctx.sources.repositories[0], found, licence: null });
  const again = await ingestGreptile(ctx);
  expect(again.suite).toEqual(result.suite);
  expect(again.suite.cases.filter((e) => e.status === "usable")).toHaveLength(50);
  expect(again.split.counts).toMatchObject({ dev: 30, test: 20, tune: 30, score: 20 });
});

it.each(["missing", "not found", "no licence answer"])("refuses a %s pinned repository answer and names its case", async (failure) => {
  let repo;
  const ctx = sourceFixture((sources) => {
    repo = sources.repositories[0].asked;
    if (failure === "missing") sources.repositories.shift();
    else if (failure === "not found") sources.repositories[0].found = false;
    else delete sources.repositories[0].licence;
  });
  const rows = greptileRows(readFileSync(join(ctx.cache, "raw/greptile", ctx.sources.original.asset.path), "utf8"));
  const name = rows.find((r) => r.prUrl.startsWith(`https://github.com/${repo}/`)).prUrl;
  await expect(ingestGreptile(ctx)).rejects.toThrow(name);
});

it("refuses a wrong corrected title join", async () => {
  const ctx = sourceFixture((sources) => { sources.titleAliases["sentry-1"] = "No corrected row has this title"; });
  await expect(ingestGreptile(ctx)).rejects.toThrow(/sentry-greptile\/pull\/1: expected one distinct corrected row/);
});

it("refuses a duplicated reconstructed pull request link", async () => {
  const ctx = pageFixture((rows) => { rows[1].prNumber = rows[0].prNumber; });
  await expect(ingestGreptile(ctx)).rejects.toThrow(/fifty distinct reconstructed pull requests/);
});

it("refuses a missing original case", async () => {
  const ctx = pageFixture((rows) => { rows.splice(1, 1); });
  await expect(ingestGreptile(ctx)).rejects.toThrow(/sentry: expected ten Greptile bugs/);
});

it("refuses a missing fork pull request and names its case", async () => {
  let url;
  const ctx = sourceFixture((sources) => {
    const pin = sources.pullFiles[0];
    const missing = pin.snapshot.shift();
    url = missing.html_url;
    pin.sha256 = sha256(`${JSON.stringify(pin.snapshot, null, 2)}\n`);
  });
  const pin = ctx.sources.pullFiles[0];
  const path = join(ctx.cache, "raw/greptile", pin.path);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pin.snapshot, null, 2)}\n`);
  await expect(ingestGreptile(ctx)).rejects.toThrow(`${url}: the pinned fork metadata has no unique pull request`);
});

it("refuses the upstream fix instead of the defect-bearing change", () => {
  expect(seenTree(repo)).toBe(git(repo, "rev-parse", "HEAD^{tree}").trim());
  expect(git(repo, "diff", "--name-only", "HEAD~1", "HEAD").trim()).not.toBe("");
  const wrong = { ...entry, prUrl: "https://github.com/discourse/discourse/pull/1", headSha: entry.baseSha };
  expect(() => validateGreptileEntry(wrong, entry.change)).toThrow(/defect-bearing/);
  expect(() => materialise({ ...c, materialise: { ...c.materialise, headSha: c.materialise.baseSha } }, tempDir("oq-greptile-refused-"), { cache })).toThrow(/defect-bearing/);
});

it("refuses a case without both truth sets recorded apart", () => {
  const truth = truthOf(c, { cache });
  expect(Object.keys(truth.sets).sort()).toEqual(["augment", "greptile"]);
  expect(truth.sets.greptile.items).toHaveLength(1);
  expect(truth.sets.augment.items.length).toBeGreaterThan(0);
  expect(truth.sets.greptile.source.url).not.toBe(truth.sets.augment.source.url);
  for (const absent of ["augment", "greptile"]) {
    const broken = structuredClone(entry);
    delete broken.truthSets[absent];
    expect(() => validateGreptileEntry(broken, entry.change)).toThrow(/truth sets/);
  }
});

it("changes the suite hash when a case changes", () => {
  expect(suiteHashOf(result.suite.cases)).toBe(result.suite.hash);
  for (const field of ["title", "body", "headSha", "truthHash"]) {
    const changed = structuredClone(result.suite.cases);
    changed[0][field] += " changed";
    expect(entryHash(changed[0])).not.toBe(changed[0].hash);
    expect(suiteHashOf(changed)).not.toBe(result.suite.hash);
  }
});

it("names a mismatched Martian comment against the published revision", async () => {
  const verified = await verifyPublishedMartian({ cache });
  expect(verified.counts).toMatchObject({ cases: 50, comments: 173 });
  const suite = JSON.parse(readFileSync(join(benchRoot, "suites/martian/cases.json"), "utf8"));
  const changed = structuredClone(verified.published);
  const url = suite.cases[0].prUrl;
  changed[url].golden_comments[0].comment += " changed";
  const check = verifyMartianMapping({ suite, published: changed, rows: verified.rows, proofs: verified.proofs });
  expect(check.differences).toContain(`${suite.cases[0].name} comment g1: published comment differs from the pinned golden file`);
});

it("refuses an edited raw source and a missing offline source", async () => {
  const { checkPinned, readPinned } = await import("../lib/suites.mjs");
  const pin = result.suite.dataset.files[0];
  expect(() => checkPinned(Buffer.from("edited"), pin, "edited source")).toThrow(/not the pinned/);
  expect(() => readPinned(tempDir("oq-greptile-empty-"), "greptile", pin)).toThrow(/not in the cache/);
});

it("keeps all fifty case joins unique and both truth totals separate", () => {
  expect(result.suite.cases).toHaveLength(50);
  expect(new Set(result.suite.cases.map((e) => e.prUrl)).size).toBe(50);
  expect(result.suite.cases.reduce((n, e) => n + e.truthSets.greptile.items, 0)).toBe(50);
  expect(result.suite.cases.reduce((n, e) => n + e.truthSets.augment.items, 0)).toBe(137);
});

it("keeps the same hash and split on an unchanged offline re-ingest", async () => {
  const again = await ingestGreptile({ cache, offline: true });
  expect(again.suite).toEqual(result.suite);
  expect(again.split).toEqual(result.split);
});

it("refuses a split rewrite that moves an existing case", () => {
  const changed = structuredClone(result.split);
  const name = changed.cases.dev.shift();
  changed.cases.test.push(name);
  expect(splitRewriteProblems(result.split, changed)).toContain(`${name} would move from dev to test`);
});
