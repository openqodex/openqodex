// The review queue holds every finding nothing frozen decides, until a
// person rules on it, and the rulings are the only way such a finding moves
// a score. These tests run the real commands (score.mjs and queue.mjs) on
// runs made in temp folders by the runner's own code, with each review
// replaced by a saved report and brief, and read what the commands wrote.
//
// Failure list, written before the code:
// 1. A repeated unresolved finding raises precision: the same unlisted
//    finding in three reviews is three unresolved findings in the bounds,
//    one queue item with three occurrences, and queueing it again or keeping
//    it in the queue moves no number.
// 2. A ruling on one finding transfers to a different issue on the same
//    lines: on one call that holds a SQL injection and a path traversal, a
//    person's ruling that the SQL finding is the listed truth item finds
//    that item, and the path traversal finding on the same line stays
//    unresolved and never finds it. Two legacy findings with one title on
//    one line, whose descriptions name the two issues, are two findings too.
// 3. Two findings are merged into one issue without a person's consolidate
//    line: findings on the same lines with different words stay two issues
//    until a person signs a consolidate line, and then one issue ruling
//    applies to both.
// 4. A ruling without a person's name changes a score: a line with no
//    `by`, an empty one, a model's or an agent's name, or any name not in
//    the queue's people.json is ignored and reported, and `decide` refuses
//    to write it. A later line under such a name never overrides a
//    person's ruling or signs a consolidation.
// 5. A blind sheet names the run, the build, the configuration or how often
//    a finding recurred, so the person rules on what they expect: the sheet
//    shows the case, the finding, the code and the truth item only, every
//    text through the shared redactor with the full and the short build
//    commit, in a seeded order it records.
// 6. A status from the adjudication file is refused or dropped: `decide`
//    writes every status of the file's shape, the reviewer part's
//    spec-candidate-accepted and spec-candidate-rejected included, and the
//    scorer reads each one back with its effect.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { specHashOf } from "../lib/rulings.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const scoreMjs = fileURLToPath(new URL("../score.mjs", import.meta.url));
const queueMjs = fileURLToPath(new URL("../queue.mjs", import.meta.url));
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// One planted truth item on a line where one call does two wrong things:
// it reads a file by a path from the database, and builds that query from
// the raw name. Only the SQL injection is listed, and its words are ones the
// unresolved findings below never use.
const spec = {
  id: "files",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  bugs: [{ id: "sqli", file: "app/files.py", lines: [12, 12], anchor: { line: 12, text: "SELECT" }, mentions: ["parameter"], kind: ["security"], severity: "critical", found_by: ["reasoning"], truth: "The name goes into the SQL text unescaped; pass it as a query parameter." }],
  extras: [],
};

// The spec version a ruling on its truth item names (rules version 8).
const SPEC = specHashOf(spec);
const HASH = "cd".repeat(32);
const CASE_ID = `planted/files@${HASH.slice(0, 8)}`;
const CONFIG = "claude-graph-on";
const BUILD = "abcdef1";
const COMMIT = `${BUILD}9f8e7d6c5b4a39281706f5e4d3c2b1a0f`;

const finding = (line, category, title, extra = {}) => ({ origin: "agent", severity: "major", category, confidence: 0.8, file_path: "app/files.py", line_number: line, line_end: line, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: `${title}.`, consequence: "Users lose data.", fix: "Fix it.", ...extra });
const report = (findings) => ({ version: 1, kind: "review", verdict: "passed", findings, outside_change: [], dropped: [], scanners: [], impact: { status: "ok" }, completion: { status: "complete", missing: [], reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 } } } });

// A frozen hit (it names the listed words), the two issues on line 12, an
// unlisted leak three lines away, and two wordings of one removed form.
const HIT = finding(12, "security", "Pass the name as a parameter");
const SQLI = finding(12, "security", "SQL injection in the file lookup", { problem: "The name is pasted into the SELECT text." });
const PATH = finding(12, "security", "Path traversal through the stored path", { problem: "The path read back from the table is opened without a check." });
const LEAK = finding(15, "bug", "File handle is never closed");
const FORM_A = finding(17, "bug", "Search form removed with no replacement");
const FORM_B = finding(17, "bug", "The search input was deleted from the page");

// The brief the reviewer was given: the diff of app/files.py, lines 10 to 19
// on the new side.
const BRIEF = [
  "# Review brief",
  "",
  "## Diff",
  "",
  "```diff",
  "diff --git a/app/files.py b/app/files.py",
  "--- a/app/files.py",
  "+++ b/app/files.py",
  "@@ -10,3 +10,10 @@",
  " def read_file(name):",
  "-    pass",
  "+    # Look the file up by its name.",
  `+    return open(db.scalar(f"SELECT path FROM files WHERE name = '{name}'")).read()`,
  "+",
  "+def handle():",
  "+    f = open(LOG)",
  "+    f.write('x')",
  "+    return render('search.html')",
  "+",
  " # end",
  "```",
  "",
  "## Answer",
].join("\n");

const planned = (repeat) => planJobs({ cases: ["files"], caseIds: { files: CASE_ID }, reviewers: ["claude"], graph: ["on"], repeat }).jobs;

// A run of the files case made by the runner's own code, each review
// replaced by the report given for its repeat, with the brief beside it.
async function savedRun({ name = "run", repeat, reports }) {
  const root = tempDir("oq-queue-run-");
  const out = join(root, name);
  write(join(root, "files.json"), JSON.stringify(spec));
  const jobs = planned(repeat);
  const manifest = runManifest({
    startedAt: "2026-10-10T10:00:00.000Z",
    settings: { build: { commit: COMMIT, short: BUILD, dirty: false, cliVersion: "0.14.0" }, reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } }, cases: ["files"], caseIds: [CASE_ID], caseHashes: { files: HASH }, configs: [CONFIG], repeat },
    jobs,
  });
  await executeRun({ out, manifest, jobs, copies: [[join(root, "files.json"), "cases/files.json"]], runJob: async (job) => {
    const dir = attemptDir(out, job, 1);
    const r = reports[job.repeat - 1];
    write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result: { code: 0, signal: null, wallMs: 1000 }, report: r, who: null, startedAt: "t", failure: null, stopped: null })));
    write(join(dir, "report", "report.json"), JSON.stringify(r));
    write(join(dir, "report", "brief.md"), BRIEF);
  } });
  return out;
}

// A queue folder whose people file names the one person who rules here.
function queueDir() {
  const q = tempDir("oq-queue-");
  write(join(q, "people.json"), JSON.stringify({ v: 1, people: ["Sid"] }));
  return q;
}

// Scores a run with the adjudication file given, and reads back what score.mjs wrote.
function scored(run, decisions) {
  const r = node(scoreMjs, [run, "--decisions", decisions, "--json"]);
  expect(r.status, r.stderr).toBe(0);
  return { score: JSON.parse(readFileSync(join(run, "score.json"), "utf8")), outcomes: readJsonl(join(run, "outcomes.jsonl")), unresolved: readJsonl(join(run, "unresolved.jsonl")) };
}

const queue = (...args) => node(queueMjs, args);

// A ruling line as `queue.mjs decide` writes it, for the lines a test writes itself.
const line = (target, status, by, extra = {}) => ({ v: 1, caseId: CASE_ID, fromSheet: null, target, status, by, at: "2026-10-11T10:00:00.000Z", note: "", evidence: null, ...extra });
const writeLines = (path, lines) => write(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

describe("a repeated unresolved finding raises precision", () => {
  it("counts an unlisted finding seen in every repeat as unresolved each time, queues it once with every occurrence, and moves no bound", async () => {
    const run = await savedRun({ repeat: 3, reports: [1, 2, 3].map(() => report([HIT, LEAK])) });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const first = scored(run, decisions);
    const c = first.score.byConfig[CONFIG];
    expect(c.precision.lower).toMatchObject({ hit: 3, of: 6 });
    expect(c.precision.upper).toMatchObject({ hit: 6, of: 6 });
    const leaks = first.outcomes.filter((o) => o.outcome === "unresolved");
    expect(leaks).toHaveLength(3);
    expect(new Set(leaks.map((o) => o.findingId)).size).toBe(1);
    // Three lines from the truth item's line: no location match, so no truth item to ask about.
    expect(leaks.every((o) => o.truthId === null && o.evidenceKind === null && o.issueId === null)).toBe(true);
    // Queued twice: one item, three occurrences, the retained text and the code at its line.
    for (let i = 0; i < 2; i++) {
      const r = queue("add", run, "--queue", q);
      expect(r.status, r.stderr).toBe(0);
    }
    const items = readJsonl(join(q, "planted.jsonl"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ findingId: leaks[0].findingId, caseId: CASE_ID, file: "app/files.py", lines: [15, 15], text: { title: LEAK.title, problem: LEAK.problem, consequence: LEAK.consequence, fix: LEAK.fix }, asks: ["real"], truth: null });
    expect(items[0].occurrences.map((o) => o.repeat)).toEqual([1, 2, 3]);
    expect(items[0].evidence).toMatchObject({ lines: [15, 15], text: "    f = open(LOG)", from: "brief" });
    expect(items[0].evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Scored again with the queue in place: the bounds have not moved.
    const again = scored(run, decisions);
    expect(again.score.byConfig[CONFIG].precision).toEqual(c.precision);
    expect(again.score.byConfig[CONFIG].uniqueIssuePrecision).toEqual(c.uniqueIssuePrecision);
  });
});

describe("a ruling on one finding transfers to a different issue on the same lines", () => {
  it("lets a person's same-issue ruling make the SQL injection finding find its truth item, and leaves the path traversal on the same call unresolved", async () => {
    const run = await savedRun({ repeat: 2, reports: [report([SQLI, PATH]), report([PATH])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const before = scored(run, decisions);
    // Both sit on the truth item's line and neither names its words: location matches, nothing more.
    for (const o of before.outcomes) expect(o).toMatchObject({ outcome: "unresolved", truthId: "sqli", evidenceKind: "location-only" });
    expect(before.score.byConfig[CONFIG].issueRecall.all).toMatchObject({ hit: 0, of: 2 });
    // The first review raised SQLI then PATH; the second, PATH alone.
    const sqliId = before.outcomes.find((o) => o.repeat === 1 && o.index === 0).findingId;
    const pathId = before.outcomes.find((o) => o.repeat === 1 && o.index === 1).findingId;
    expect(before.outcomes.find((o) => o.repeat === 2).findingId).toBe(pathId);
    expect(sqliId).not.toBe(pathId);
    writeLines(decisions, [line({ kind: "match", findingId: sqliId, truthId: "sqli", specHash: SPEC }, "same-issue", "Sid")]);
    const after = scored(run, decisions);
    const byId = (id, repeat) => after.outcomes.find((o) => o.findingId === id && o.repeat === repeat);
    expect(byId(sqliId, 1)).toMatchObject({ outcome: "hit", truthId: "sqli", evidenceKind: "ruling" });
    expect(byId(pathId, 1)).toMatchObject({ outcome: "unresolved", truthId: "sqli", evidenceKind: "location-only", issueId: null });
    expect(byId(pathId, 2)).toMatchObject({ outcome: "unresolved", truthId: "sqli", evidenceKind: "location-only" });
    // The review that raised only the path traversal did not find the SQL injection.
    expect(after.score.perBug[CONFIG][CASE_ID].sqli.found).toEqual([true, false]);
    expect(after.score.byConfig[CONFIG].issueRecall.all).toMatchObject({ hit: 1, of: 2 });
    // The queue keeps asking about the path traversal, both questions, and no longer about the ruled finding.
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const items = readJsonl(join(q, "planted.jsonl"));
    expect(items.map((i) => i.findingId)).toEqual([pathId]);
    expect(items[0]).toMatchObject({ asks: ["real", "match"], truth: { id: "sqli", file: "app/files.py", lines: [12, 12], text: spec.bugs[0].truth } });
    expect(items[0].occurrences).toHaveLength(2);
    // A ruling on the path traversal stays on the path traversal.
    writeLines(decisions, [line({ kind: "match", findingId: sqliId, truthId: "sqli", specHash: SPEC }, "same-issue", "Sid"), line({ kind: "finding", findingId: pathId }, "false", "Sid")]);
    const last = scored(run, decisions);
    expect(last.outcomes.find((o) => o.findingId === sqliId)).toMatchObject({ outcome: "hit", evidenceKind: "ruling" });
    expect(last.outcomes.filter((o) => o.findingId === pathId).map((o) => o.outcome)).toEqual(["ruled-false", "ruled-false"]);
  });

  it("gives two legacy findings that differ only in their description two ids, so a ruling on the SQL injection stays off the path traversal", async () => {
    // A report from before the structured prose fields: title, description and suggested_change only.
    const legacy = (description, fix) => ({ origin: "agent", severity: "major", category: "security", confidence: 0.8, file_path: "app/files.py", line_number: 12, line_end: 12, title: "Unsafe file lookup", description, suggested_change: fix, source: null, candidate: null, notes: [] });
    const run = await savedRun({ repeat: 1, reports: [report([legacy("The name is pasted into the SELECT text: SQL injection.", "Bind the name."), legacy("The stored path is opened unchecked: path traversal.", "Check the path.")])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const before = scored(run, decisions);
    const [sql, path] = before.outcomes.map((o) => o.findingId);
    expect(sql).not.toBe(path);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    expect(readJsonl(join(q, "planted.jsonl"))).toHaveLength(2);
    writeLines(decisions, [line({ kind: "finding", findingId: sql }, "true", "Sid")]);
    const after = scored(run, decisions);
    expect(after.outcomes.map((o) => o.outcome)).toEqual(["ruled-true", "unresolved"]);
  });
});

describe("two findings are merged into one issue without a person's consolidate line", () => {
  it("keeps two wordings on one line two issues until a person signs a consolidate line, then applies one issue ruling to both", async () => {
    const run = await savedRun({ repeat: 1, reports: [report([FORM_A, FORM_B])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const before = scored(run, decisions);
    const c = before.score.byConfig[CONFIG];
    expect(c.uniqueIssuePrecision.lower).toMatchObject({ hit: 0, of: 2 });
    expect(c.redundancy).toMatchObject({ hit: 0, of: 2 });
    expect(before.outcomes.map((o) => o.issueId)).toEqual([null, null]);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const [a, b] = before.outcomes.map((o) => o.findingId);
    expect(readJsonl(join(q, "planted.jsonl")).map((i) => i.findingId).sort()).toEqual([a, b].sort());
    // No name, or a model's name: refused, and nothing is written.
    for (const by of [[], ["--by", "claude"], ["--by", "gpt-6.1-sol"]]) {
      const r = queue("decide", "consolidate", a.slice(0, 12), b.slice(0, 12), ...by, "--queue", q);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/person/);
    }
    expect(existsSync(decisions)).toBe(false);
    // A consolidate line written by hand under a model's name is ignored by the scorer.
    writeLines(decisions, [line({ kind: "issue", issueId: `${CASE_ID}#I1`, members: [a, b] }, "consolidate", "claude")]);
    const forged = scored(run, decisions);
    expect(forged.score.byConfig[CONFIG].uniqueIssuePrecision).toEqual(c.uniqueIssuePrecision);
    expect(forged.outcomes.map((o) => o.issueId)).toEqual([null, null]);
    expect(forged.score.rulings.ignored).toEqual([{ line: 1, why: expect.stringMatching(/person/) }]);
    // A person signs it.
    writeLines(decisions, []);
    const signed = queue("decide", "consolidate", a.slice(0, 12), b.slice(0, 12), "--by", "Sid", "--note", "one removed form", "--queue", q);
    expect(signed.status, signed.stderr).toBe(0);
    const [cons] = readJsonl(decisions);
    expect(cons).toMatchObject({ v: 1, caseId: CASE_ID, target: { kind: "issue", issueId: `${CASE_ID}#I1`, members: [a, b].sort() }, status: "consolidate", by: "Sid", note: "one removed form" });
    const merged = scored(run, decisions);
    expect(merged.outcomes.map((o) => o.issueId)).toEqual([`${CASE_ID}#I1`, `${CASE_ID}#I1`]);
    expect(merged.score.byConfig[CONFIG].uniqueIssuePrecision.lower).toMatchObject({ hit: 0, of: 1 });
    expect(merged.score.byConfig[CONFIG].redundancy).toMatchObject({ hit: 1, of: 2 });
    // The queue keys both items by the issue too, and still asks about it.
    expect(queue("add", run, "--queue", q).status).toBe(0);
    expect(readJsonl(join(q, "planted.jsonl")).map((i) => [i.issueId, i.asks])).toEqual([[`${CASE_ID}#I1`, ["real"]], [`${CASE_ID}#I1`, ["real"]]]);
    // One ruling on the issue rules both members.
    expect(queue("decide", "true", `${CASE_ID}#I1`, "--by", "Sid", "--queue", q).status).toBe(0);
    const ruled = scored(run, decisions);
    expect(ruled.outcomes.map((o) => o.outcome)).toEqual(["ruled-true", "ruled-true"]);
    expect(ruled.score.byConfig[CONFIG].precision.lower).toMatchObject({ hit: 2, of: 2 });
  });
});

describe("a ruling without a person's name changes a score", () => {
  it("ignores and reports a line with no name, an empty one, or a model's or an agent's, and decide refuses to write one", async () => {
    const run = await savedRun({ repeat: 1, reports: [report([HIT, LEAK, SQLI])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const base = scored(run, decisions);
    const leak = base.outcomes[1].findingId;
    const sqli = base.outcomes[2].findingId;
    const names = [undefined, "", "  ", "claude", "Codex", "gpt-6.1-sol", "the session", "opus builder"];
    writeLines(decisions, names.flatMap((by) => [line({ kind: "finding", findingId: leak }, "true", by), line({ kind: "match", findingId: sqli, truthId: "sqli", specHash: SPEC }, "same-issue", by)]));
    const after = scored(run, decisions);
    expect(after.score.byConfig).toEqual(base.score.byConfig);
    expect(after.score.perBug).toEqual(base.score.perBug);
    expect(after.outcomes).toEqual(base.outcomes);
    expect(after.score.rulings.ignored).toHaveLength(names.length * 2);
    for (const x of after.score.rulings.ignored) expect(x.why).toMatch(/person/);
    expect(after.score.decisionsHash).toMatch(/^[0-9a-f]{64}$/);
    // decide refuses the same names and writes nothing.
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const fresh = queueDir();
    expect(queue("add", run, "--queue", fresh).status).toBe(0);
    for (const by of [[], ["--by", ""], ["--by", "Claude"], ["--by", "gpt-6.1-sol"], ["--by", "session"]]) {
      const r = queue("decide", "true", leak.slice(0, 12), ...by, "--queue", fresh);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/person/);
    }
    expect(existsSync(join(fresh, "decisions.jsonl"))).toBe(false);
  });

  it("counts a ruling only from a name in people.json, so a later true under ChatGPT or an unlisted name never overrides Sid's false or signs a consolidation", async () => {
    const run = await savedRun({ repeat: 1, reports: [report([LEAK, FORM_A, FORM_B])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const base = scored(run, decisions);
    const [leak, a, b] = base.outcomes.map((o) => o.findingId);
    writeLines(decisions, [
      line({ kind: "finding", findingId: leak }, "false", "Sid"),
      line({ kind: "finding", findingId: leak }, "true", "ChatGPT"),
      line({ kind: "finding", findingId: leak }, "true", "Alex"),
      line({ kind: "issue", issueId: `${CASE_ID}#I1`, members: [a, b] }, "consolidate", "ChatGPT"),
      line({ kind: "issue", issueId: `${CASE_ID}#I2`, members: [a, b] }, "consolidate", "Alex"),
    ]);
    const after = scored(run, decisions);
    expect(after.outcomes.map((o) => [o.outcome, o.issueId])).toEqual([["ruled-false", null], ["unresolved", null], ["unresolved", null]]);
    expect(after.score.rulings.ignored.map((x) => x.line)).toEqual([2, 3, 4, 5]);
    for (const x of after.score.rulings.ignored) expect(x.why).toMatch(/people\.json/);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    for (const by of ["ChatGPT", "Alex"]) {
      const r = queue("decide", "consolidate", a.slice(0, 12), b.slice(0, 12), "--by", by, "--queue", q);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/people\.json/);
    }
    expect(readJsonl(decisions)).toHaveLength(5);
  });
});

describe("a blind sheet names the run, the build, the configuration or how often a finding recurred", () => {
  it("shows the case, the finding, the code and the truth item only, through the shared redactor, in a seeded order it records", async () => {
    const runId = `2026-10-10-${BUILD}-planted-review-laptop`;
    const quoting = finding(12, "security", "Path traversal through the stored path", { problem: `Seen in ${runId} under ${CONFIG} at ${BUILD}.`, consequence: `Built from ${COMMIT}.` });
    const run = await savedRun({ name: runId, repeat: 3, reports: [1, 2, 3].map(() => report([quoting, LEAK, FORM_A])) });
    const q = queueDir();
    scored(run, join(q, "decisions.jsonl"));
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const json = queue("sheet", "planted", "--seed", "7", "--json", "--queue", q);
    expect(json.status, json.stderr).toBe(0);
    const sheet = JSON.parse(json.stdout);
    expect(sheet).toMatchObject({ sheet: "planted@7", suite: "planted", seed: 7 });
    expect(sheet.items).toHaveLength(3);
    const allowed = ["item", "ref", "issueId", "caseId", "file", "lines", "category", "severity", "text", "evidence", "truth", "asks"];
    for (const item of sheet.items) for (const key of Object.keys(item)) expect(allowed).toContain(key);
    const md = queue("sheet", "planted", "--seed", "7", "--queue", q);
    expect(md.status).toBe(0);
    for (const text of [json.stdout, md.stdout]) {
      // The full commit and its tail too: the short form alone would leave the rest of the hash naming the build.
      for (const forbidden of [runId, BUILD, COMMIT, COMMIT.slice(BUILD.length), CONFIG, "graph-on", "claude", "occurrence", "repeat", "laptop"]) expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(md.stdout).toMatch(/planted@7/);
    // The same seed gives the same order; the order is not the queue's.
    const again = JSON.parse(queue("sheet", "planted", "--seed", "7", "--json", "--queue", q).stdout);
    expect(again.items.map((i) => i.ref)).toEqual(sheet.items.map((i) => i.ref));
    const other = JSON.parse(queue("sheet", "planted", "--seed", "8", "--json", "--queue", q).stdout);
    expect(new Set(other.items.map((i) => i.ref))).toEqual(new Set(sheet.items.map((i) => i.ref)));
  });
});

describe("a status from the adjudication file is refused or dropped", () => {
  it("writes every status of the file through decide, and the scorer reads each one back", async () => {
    const run = await savedRun({ repeat: 1, reports: [report([SQLI, PATH, LEAK, FORM_A, FORM_B])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const base = scored(run, decisions);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const [sqli, path, leak, a, b] = base.outcomes.map((o) => o.findingId.slice(0, 12));
    const steps = [
      ["confirmed", CASE_ID, "--bug", "sqli", "--run", run],
      ["disputed", CASE_ID, "--bug", "sqli", "--run", run],
      ["same-issue", sqli],
      ["different-issue", path],
      ["true", leak],
      ["false", path],
      ["consolidate", a, b],
      ["true", `${CASE_ID}#I1`],
      ["false", `${CASE_ID}#I1`],
      ["clean", CASE_ID],
      ["not-clean", CASE_ID],
    ];
    for (const step of steps) {
      const r = queue("decide", ...step, "--by", "Sid", "--sheet", "planted@7", "--queue", q);
      expect(r.status, `${step.join(" ")}: ${r.stderr}`).toBe(0);
    }
    const lines = readJsonl(decisions);
    expect(lines.map((l) => l.status)).toEqual(["confirmed", "disputed", "same-issue", "different-issue", "true", "false", "consolidate", "true", "false", "clean", "not-clean"]);
    expect(lines.map((l) => l.target.kind)).toEqual(["bug", "bug", "match", "match", "finding", "finding", "issue", "issue", "issue", "case", "case"]);
    for (const l of lines) {
      expect(l).toMatchObject({ v: 1, caseId: CASE_ID, by: "Sid", fromSheet: "planted@7", note: "" });
      expect(Number.isNaN(Date.parse(l.at))).toBe(false);
    }
    // A finding's ruling carries the code the person read.
    expect(lines[4].evidence).toMatchObject({ lines: [15, 15], text: "    f = open(LOG)" });
    expect(lines[4].evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    const after = scored(run, decisions);
    expect(after.score.rulings).toMatchObject({ read: steps.length, ignored: [] });
    expect(after.score.perBug[CONFIG][CASE_ID].sqli.ruling).toBe("disputed");
    expect(after.outcomes.map((o) => o.outcome)).toEqual(["hit", "ruled-false", "ruled-true", "ruled-false", "ruled-false"]);
  });

  it("takes the reviewer part's names for a spec candidate, spec-candidate-accepted and spec-candidate-rejected, with the effects of true and false", async () => {
    const run = await savedRun({ repeat: 1, reports: [report([PATH, LEAK, FORM_A, FORM_B])] });
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const base = scored(run, decisions);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const [path, leak, a, b] = base.outcomes.map((o) => o.findingId.slice(0, 12));
    // Each named status comes after the opposite ruling, so its own effect shows.
    const steps = [
      ["false", leak],
      ["spec-candidate-accepted", leak],
      ["true", path],
      ["spec-candidate-rejected", path],
      ["consolidate", a, b],
      ["false", `${CASE_ID}#I1`],
      ["spec-candidate-accepted", `${CASE_ID}#I1`],
    ];
    for (const step of steps) {
      const r = queue("decide", ...step, "--by", "Sid", "--queue", q);
      expect(r.status, `${step.join(" ")}: ${r.stderr}`).toBe(0);
    }
    const lines = readJsonl(decisions);
    expect(lines.map((l) => [l.status, l.target.kind])).toEqual([["false", "finding"], ["spec-candidate-accepted", "finding"], ["true", "finding"], ["spec-candidate-rejected", "finding"], ["consolidate", "issue"], ["false", "issue"], ["spec-candidate-accepted", "issue"]]);
    const after = scored(run, decisions);
    expect(after.score.rulings).toMatchObject({ read: steps.length, ignored: [] });
    expect(after.outcomes.map((o) => o.outcome)).toEqual(["ruled-false", "ruled-true", "ruled-true", "ruled-true"]);
    expect(after.score.byConfig[CONFIG].precision.lower).toMatchObject({ hit: 3, of: 4 });
    expect(after.score.byConfig[CONFIG].precision.upper).toMatchObject({ hit: 3, of: 4 });
  });
});
