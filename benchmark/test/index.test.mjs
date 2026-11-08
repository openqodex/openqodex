// The committed index entry is the only record of a run in the tree, and the
// trend and the accept step read nothing else. Guarded failure: a run on the
// held-out split that names no release passes the validator, so a held-out
// number made outside a release, or one carrying per-case detail of held-out
// cases, sits in the index as a sound entry. The entry is built the way
// publish-run.mjs builds it, from a saved run scored with format 3 in a temp
// folder; every committed entry must stay sound under the same validator.
// Also guarded: two runs of one suite and configuration that differ only in
// their subset (dev-smoke, dev-laptop) share one trend group and one
// accepted pointer, so each overwrites the other's baseline; and a run with
// no subset gets another key than it had, which orphans the committed
// accepted pointer.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acceptedPath, acceptedProblems, assetUrl, buildEntry, entryProblems, groupKeys, listEntries } from "../lib/index.mjs";
import { planJobs, sampleRecord } from "../lib/runner.mjs";
import { RULES_VERSION } from "../lib/score.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

it("the committed accepted pointer records every accepted entry's current board hash", () => {
  const pointer = JSON.parse(readFileSync(acceptedPath(), "utf8"));
  const entries = new Map(listEntries().map(({ entry }) => [entry.runId, entry]));
  expect(acceptedProblems(pointer, entries)).toEqual([]);
});

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const RUN_ID = "2026-10-10-aaaaaaa-planted-review-laptop";
const HASH = "cd".repeat(32);
const CASE_ID = `planted/one@${HASH.slice(0, 8)}`;
const spec = {
  id: "one",
  guards: "g",
  language: "python",
  framework: "none",
  clean: false,
  bugs: [{ id: "sqli", file: "app.py", lines: [4, 4], anchor: { line: 4, text: "x" }, mentions: ["sql"], kind: ["security"], severity: "critical", found_by: ["reasoning"], truth: "t" }],
};
const finding = { origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path: "app.py", line_number: 4, line_end: 4, title: "SQL injection", problem: "p", consequence: "c", fix: "f", candidate: null, source: null };
const report = { findings: [finding], outside_change: [], dropped: [], completion: { status: "complete", missing: [], reviewer: { usage: { cost_usd: 0.2 } } } };

// One planted case, one configuration, one repeat, reviewed once. `extra`
// is added to the manifest the entry is built from (after scoring).
function scoredRun(extra = {}) {
  const out = join(tempDir("oq-index-"), RUN_ID);
  const { jobs } = planJobs({ cases: ["one"], caseIds: { one: CASE_ID }, reviewers: ["claude"], graph: ["on"], repeat: 1 });
  const manifest = {
    version: 3,
    started_at: "2026-10-10T10:00:00.000Z",
    build: { commit: "a".repeat(40), short: "aaaaaaa", dirty: false, cliVersion: "0.14.0", bundleHash: "b".repeat(64) },
    reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } },
    review: { web: "off" },
    cases: ["one"],
    caseHashes: { one: HASH },
    caseIds: [CASE_ID],
    configs: ["claude-graph-on"],
    repeat: 1,
    planned: 1,
    jobs: jobs.map(({ jobId, caseId, config, repeat }) => ({ jobId, caseId, config, repeat })),
    ended: { how: "finished", why: null },
  };
  write(join(out, "manifest.json"), JSON.stringify(manifest));
  write(join(out, "cases", "one.json"), JSON.stringify(spec));
  const dir = join(out, "samples", "one", "claude-graph-on", "1");
  write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job: jobs[0], attempt: 1, result: { code: 0, signal: null, wallMs: 20_000 }, report, who: null, startedAt: "t", failure: null, stopped: null })));
  write(join(dir, "report", "report.json"), JSON.stringify(report));
  write(join(dir, "report", "scan.json"), JSON.stringify({ candidates: [] }));
  const { score } = scoreRun(loadRun(out));
  return buildEntry({ runId: RUN_ID, manifest: { ...manifest, ...extra }, resumes: [], score, asset: { url: assetUrl(RUN_ID), sha256: "e".repeat(64), bytes: 1000, files: 12, listHash: "f".repeat(64) }, privateListHash: "9".repeat(64) });
}

describe("a test-split entry without a release is accepted", () => {
  it("takes a development entry built from a format 3 score, with its rules, population and per-case ratios", () => {
    const entry = scoredRun();
    expect(entryProblems(entry)).toEqual([]);
    expect(entry).toMatchObject({ rulesVersion: RULES_VERSION, legacy: false, caseIds: [CASE_ID] });
    expect(entry.rulesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.scores["claude-graph-on"].population).toMatchObject({ planned: 1, complete: 1 });
    expect(entry.perCase["claude-graph-on"][CASE_ID].issueRecall).toEqual({ hit: 1, of: 1 });
    // Severity agreement and the finder of each found bug, as the score gives them.
    const head = entry.scores["claude-graph-on"];
    expect(head.severity).toMatchObject({ exact: { hit: 1, of: 1, ci: null }, withinOne: { hit: 1, of: 1, ci: null }, over: 0, under: 0 });
    expect(head.finder).toMatchObject({ match: { hit: 1, of: 1, ci: null }, byExpected: { reasoning: { hit: 1, of: 1 } }, scannerExpectedReviewerFound: 0 });
    expect(entryProblems({ ...entry, scores: { "claude-graph-on": { ...head, finder: undefined } } }).join("\n")).toMatch(/finder/);
  });

  it("refuses a held-out entry that names no release, accepted or not, and one that carries per-case detail", () => {
    const entry = scoredRun();
    const heldOut = { ...entry, split: "test", perCase: null, perBug: null, release: null };
    expect(entryProblems(heldOut).join("\n")).toMatch(/held-out .*release/);
    expect(entryProblems({ ...heldOut, accepted: true, acceptedAt: "2026-10-11T09:00:00.000Z", acceptedBy: "Sid" }).join("\n")).toMatch(/held-out .*release/);
    expect(entryProblems({ ...heldOut, release: "0.14.0", perCase: entry.perCase }).join("\n")).toMatch(/per-case/);
    expect(entryProblems({ ...heldOut, release: "0.14.0", perBug: entry.perBug }).join("\n")).toMatch(/perBug must be null/);
    expect(entryProblems({ ...heldOut, release: "0.14.0" })).toEqual([]);
  });

  it("keeps every committed entry sound, so no published run stops being fetchable", () => {
    const entries = listEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const { entry } of entries) expect(entryProblems(entry)).toEqual([]);
  });
});

describe("two runs that differ only in their subset share a trend group and an accepted pointer", () => {
  const real = { suite: "aacr", split: "dev", splitHash: "ab".repeat(32) };

  it("puts two runs that differ only in subset in two groups, each key naming its subset", () => {
    const smoke = groupKeys(scoredRun({ ...real, subset: "dev-smoke" })).map((g) => g.key);
    const laptop = groupKeys(scoredRun({ ...real, subset: "dev-laptop" })).map((g) => g.key);
    expect(smoke).not.toEqual(laptop);
    expect(smoke[0]).toBe(`aacr|dev|${"ab".repeat(32)}|review|laptop|claude|claude-opus-5-5|claude-graph-on|${RULES_VERSION}|dev-smoke`);
    expect(laptop[0]).toMatch(/\|dev-laptop$/);
    expect(entryProblems(scoredRun({ ...real, subset: "dev-smoke" }))).toEqual([]);
    expect(entryProblems({ ...scoredRun(real), subset: "" }).join("\n")).toMatch(/subset/);
  });

  it("keeps the key a run with no subset had, writes no subset field, and reads --subset all as no subset", () => {
    const none = scoredRun(real);
    expect("subset" in none).toBe(false);
    expect(groupKeys(none)[0].key).toBe(`aacr|dev|${"ab".repeat(32)}|review|laptop|claude|claude-opus-5-5|claude-graph-on|${RULES_VERSION}`);
    expect(groupKeys(scoredRun({ ...real, subset: "all" }))).toEqual(groupKeys(none));
    expect("subset" in scoredRun({ ...real, subset: null })).toBe(false);
  });

  it("still finds every committed accepted run under the key its pointer names", () => {
    const pointer = JSON.parse(readFileSync(acceptedPath(), "utf8"));
    const byId = new Map(listEntries().map(({ entry }) => [entry.runId, entry]));
    const groups = Object.entries(pointer.groups ?? {});
    expect(groups.length).toBeGreaterThan(0);
    for (const [key, g] of groups) expect(groupKeys(byId.get(g.runId)).map((x) => x.key)).toContain(key);
  });
});
