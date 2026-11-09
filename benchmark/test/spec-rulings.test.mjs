// A ruling on a truth item judges one version of its case's spec, and a
// planted bug found at a place its spec does not list can be joined to it.
// These tests run the real commands (score.mjs and queue.mjs) on runs made
// in temp folders by the runner's own code, with each review replaced by a
// saved report and brief, and read what the commands wrote.
//
// Failure list, written before the code (issues 163 and 139):
// 1. A disputed ruling recorded on one spec version labels the item on
//    every later version (issue 163): a ruling recorded on spec hash A does
//    not apply when the run is scored against spec hash B, and a line that
//    names no spec version applies to none.
// 2. A same-issue ruling joins a finding to a truth item in another file:
//    decide refuses it, and refuses one whose finding sits on no line the
//    change added, or names an item the finding's spec does not list.
// 3. A planted bug found at a place its spec does not list can never be
//    ruled found (issue 139): a same-issue ruling that names the item, for a
//    finding on a line the change added in the item's file, is recorded with
//    that item and the spec version, and scores as the item's hit on that
//    version only.
// 4. A bug ruling is recorded against a held-out spec version (sol review
//    of PR 172): decide refuses a run of the test split, or one whose case
//    the committed split holds out, before it looks for a spec, with
//    --specs too, in one line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { readSuite, realCaseId } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const scoreMjs = fileURLToPath(new URL("../score.mjs", import.meta.url));
const queueMjs = fileURLToPath(new URL("../queue.mjs", import.meta.url));
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const queue = (...args) => node(queueMjs, args);
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// A spec's version, as the rulings name it: the sha256 of its JSON with the
// keys of every object in sorted order.
const sorted = (v) => (Array.isArray(v) ? `[${v.map(sorted).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sorted(v[k])}`).join(",")}}` : JSON.stringify(v));
const specHash = (spec) => createHash("sha256").update(sorted(spec)).digest("hex");

// Two truth items in two files: an admin check planted at line 2 of the
// users file, which a review may report where it bites (line 21), and a SQL
// injection in the search file.
const plant = (id, file, line, mentions, truth) => ({ id, file, lines: [line, line], anchor: { line, text: "x" }, mentions, kind: ["security"], severity: "critical", found_by: ["reasoning"], truth });
const specA = {
  id: "users",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  bugs: [plant("admin", "app/users.py", 2, ["skips the admin check"], "destroy skips the admin check, so any user can delete any user."), plant("sqli", "app/search.py", 14, ["sql"], "The term goes into the SQL text.")],
  extras: [],
};
// The next version of the case: only the SQL item's truth is reworded.
const specB = { ...specA, bugs: [specA.bugs[0], { ...specA.bugs[1], truth: "The term goes into the SQL text unescaped; bind it as a parameter." }] };
const HASH_A = specHash(specA);
const HASH_B = specHash(specB);

const CASE_HASH = "ab".repeat(32);
const CASE_ID = `planted/users@${CASE_HASH.slice(0, 8)}`;
const CONFIG = "claude-graph-on";

const finding = (file, line, category, title, extra = {}) => ({ origin: "agent", severity: "critical", category, confidence: 0.9, file_path: file, line_number: line, line_end: line, title, description: title, suggested_change: null, source: null, candidate: null, notes: [], problem: `${title}.`, consequence: "Data is lost.", fix: "Fix it.", ...extra });
const report = (findings) => ({ version: 1, kind: "review", verdict: "passed", findings, outside_change: [], dropped: [], scanners: [], impact: { status: "ok" }, completion: { status: "complete", missing: [], trace_complete: true, reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 } } } });

// A frozen hit on the SQL item; the admin check found at the destroy
// action, nineteen lines from its plant; a finding on a line the change did
// not touch; and one in the search file, on an added line far from the SQL
// item.
const SQLI = finding("app/search.py", 14, "security", "SQL injection in the search");
const DESTROY = finding("app/users.py", 21, "security", "Any user can delete any account", { problem: "destroy is exempt from the admin check." });
const UNCHANGED = finding("app/users.py", 23, "bug", "The end marker is misplaced");
const ELSEWHERE = finding("app/search.py", 18, "bug", "The page size is never checked");

// The brief the reviewer was given: app/users.py with lines 2 to 22 added
// between two unchanged lines, and app/search.py with lines 11 to 19 added.
const BRIEF = [
  "# Review brief",
  "",
  "## Diff",
  "",
  "```diff",
  "diff --git a/app/users.py b/app/users.py",
  "--- a/app/users.py",
  "+++ b/app/users.py",
  "@@ -1,2 +1,23 @@",
  " class Users:",
  ...Array.from({ length: 21 }, (_, i) => `+    line_${i + 2} = ${i + 2}`),
  " # end",
  "diff --git a/app/search.py b/app/search.py",
  "--- a/app/search.py",
  "+++ b/app/search.py",
  "@@ -10,1 +10,10 @@",
  " def search(q):",
  ...Array.from({ length: 9 }, (_, i) => `+    step_${i + 11} = ${i + 11}`),
  "```",
  "",
  "## Answer",
].join("\n");

// A run of the users case under spec A, made by the runner's own code, each
// review replaced by the report given for its repeat with the brief beside
// it; and a folder holding spec B, to score the same reviews against.
async function savedRun(reports) {
  const root = tempDir("oq-spec-rulings-run-");
  const out = join(root, "run");
  write(join(root, "users.json"), JSON.stringify(specA, null, 2));
  write(join(root, "specs-b", "users.json"), JSON.stringify(specB, null, 2));
  const repeat = reports.length;
  const { jobs } = planJobs({ cases: ["users"], caseIds: { users: CASE_ID }, reviewers: ["claude"], graph: ["on"], repeat });
  const manifest = runManifest({
    startedAt: "2026-10-11T10:00:00.000Z",
    settings: { build: { commit: "c".repeat(40), short: "ccccccc", dirty: false, cliVersion: "0.14.0" }, reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } }, cases: ["users"], caseIds: [CASE_ID], caseHashes: { users: CASE_HASH }, configs: [CONFIG], repeat },
    jobs,
  });
  await executeRun({ out, manifest, jobs, copies: [[join(root, "users.json"), "cases/users.json"]], runJob: async (job) => {
    const dir = attemptDir(out, job, 1);
    const r = reports[job.repeat - 1];
    write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result: { code: 0, signal: null, wallMs: 1000 }, report: r, who: null, startedAt: "t", failure: null, stopped: null })));
    write(join(dir, "report", "report.json"), JSON.stringify(r));
    write(join(dir, "report", "brief.md"), BRIEF);
  } });
  return { run: out, specsB: join(root, "specs-b") };
}

function queueDir() {
  const q = tempDir("oq-spec-rulings-queue-");
  write(join(q, "people.json"), JSON.stringify({ v: 1, people: ["Sid"] }));
  return q;
}

// Scores the run with the adjudication file given, against its own specs or
// the folder `specs` names, and reads back what score.mjs wrote.
function scored(run, decisions, specs = null) {
  const r = node(scoreMjs, [run, "--decisions", decisions, ...(specs ? ["--specs", specs] : []), "--json"]);
  expect(r.status, r.stderr).toBe(0);
  const suffix = specs ? "-specs-b" : "";
  return { score: JSON.parse(readFileSync(join(run, `score${suffix}.json`), "utf8")), outcomes: readJsonl(join(run, `outcomes${suffix}.jsonl`)), unresolved: readJsonl(join(run, `unresolved${suffix}.jsonl`)) };
}

const bugOf = (s, id) => s.score.perBug[CONFIG][CASE_ID][id];

describe("a disputed ruling recorded on one spec version labels the item on every later version", () => {
  it("applies a ruling recorded on spec hash A when the run is scored against A, and not against spec hash B", async () => {
    // The review misses the SQL item, so its cause shows the ruling too.
    const { run, specsB } = await savedRun([report([DESTROY])]);
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const r = queue("decide", "disputed", CASE_ID, "--bug", "sqli", "--run", run, "--by", "Sid", "--note", "the spec names the wrong line", "--queue", q);
    expect(r.status, r.stderr).toBe(0);
    const [disputed] = readJsonl(decisions);
    expect(disputed).toMatchObject({ v: 1, caseId: CASE_ID, target: { kind: "bug", id: "sqli", specHash: HASH_A }, status: "disputed", by: "Sid" });
    expect(HASH_A).not.toBe(HASH_B);
    const onA = scored(run, decisions);
    expect(onA.score.rulings).toMatchObject({ read: 1, ignored: [] });
    expect(bugOf(onA, "sqli")).toMatchObject({ ruling: "disputed", cause: ["spec-disputed"] });
    const onB = scored(run, decisions, specsB);
    expect(bugOf(onB, "sqli").ruling).toBeNull();
    expect(bugOf(onB, "sqli").cause[0]).not.toBe("spec-disputed");
    // A ruling recorded on B, through the run and that folder, is B's alone.
    expect(queue("decide", "confirmed", CASE_ID, "--bug", "sqli", "--run", run, "--specs", specsB, "--by", "Sid", "--queue", q).status).toBe(0);
    expect(readJsonl(decisions)[1].target).toEqual({ kind: "bug", id: "sqli", specHash: HASH_B });
    expect(bugOf(scored(run, decisions, specsB), "sqli").ruling).toBe("confirmed");
    expect(bugOf(scored(run, decisions), "sqli").ruling).toBe("disputed");
  });

  it("ignores, and reports, a bug or match ruling that names no spec version", async () => {
    const { run } = await savedRun([report([SQLI, DESTROY])]);
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const base = scored(run, decisions);
    const destroy = base.outcomes.find((o) => o.index === 1).findingId;
    const old = (target, status) => ({ v: 1, caseId: CASE_ID, fromSheet: null, target, status, by: "Sid", at: "2026-10-11T10:00:00.000Z", note: "", evidence: null });
    write(decisions, [old({ kind: "bug", id: "sqli" }, "disputed"), old({ kind: "match", findingId: destroy, truthId: "admin" }, "same-issue")].map((l) => `${JSON.stringify(l)}\n`).join(""));
    const after = scored(run, decisions);
    expect(after.score.rulings.ignored.map((x) => x.line)).toEqual([1, 2]);
    for (const x of after.score.rulings.ignored) expect(x.why).toMatch(/spec/);
    expect(after.score.perBug).toEqual(base.score.perBug);
    expect(after.outcomes).toEqual(base.outcomes);
  });

  it("refuses a bug ruling that names no run, a case the run did not score, or an item its spec does not list", async () => {
    const { run } = await savedRun([report([SQLI])]);
    const q = queueDir();
    const refused = [
      [["disputed", CASE_ID, "--bug", "sqli"], /--run/],
      [["disputed", "planted/other@00000000", "--bug", "sqli", "--run", run], /scored no case planted\/other/],
      [["disputed", CASE_ID, "--bug", "nope", "--run", run], /no truth item nope/],
    ];
    for (const [args, why] of refused) {
      const r = queue("decide", ...args, "--by", "Sid", "--queue", q);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(why);
    }
    expect(existsSync(join(q, "decisions.jsonl"))).toBe(false);
  });
});

describe("a bug ruling is recorded against a held-out spec version", () => {
  // A run's manifest as the runner writes it, for decide to read; the
  // ruling is refused before any spec is looked for.
  function manifestRun(settings, caseName, caseId) {
    const run = tempDir("oq-spec-rulings-heldout-");
    const { jobs } = planJobs({ cases: [caseName], caseIds: { [caseName]: caseId }, reviewers: ["claude"], graph: ["on"], repeat: 1 });
    write(join(run, "manifest.json"), JSON.stringify(runManifest({ startedAt: "2026-10-11T10:00:00.000Z", settings: { cases: [caseName], caseIds: [caseId], configs: [CONFIG], repeat: 1, ...settings }, jobs })));
    return run;
  }

  it("refuses a run of the test split, or one whose case the committed split holds out, with or without --specs", () => {
    const suite = readSuite("aacr");
    const heldOut = suite.split.cases.test.find((n) => suite.byName.get(n)?.status === "usable");
    const runs = [
      [manifestRun({ suite: "planted", split: "test" }, "users", CASE_ID), CASE_ID],
      [manifestRun({ suite: "aacr", split: "dev" }, heldOut, realCaseId("aacr", heldOut, suite.byName.get(heldOut).hash)), realCaseId("aacr", heldOut, suite.byName.get(heldOut).hash)],
    ];
    const q = queueDir();
    for (const [run, caseId] of runs) {
      for (const specs of [[], ["--specs", run]]) {
        const r = queue("decide", "disputed", caseId, "--bug", "sqli", "--run", run, ...specs, "--by", "Sid", "--queue", q);
        expect(r.status, `${caseId} ${specs.join(" ")}`).toBe(2);
        expect(r.stderr).toMatch(/held out/);
        expect(r.stderr.trim().split("\n")).toHaveLength(1);
      }
    }
    expect(existsSync(join(q, "decisions.jsonl"))).toBe(false);
  });
});

describe("a same-issue ruling joins a finding to a truth item in another file", () => {
  it("refuses a join to an item in another file, from a line the change did not add, or to an item the spec does not list", async () => {
    const { run } = await savedRun([report([SQLI, DESTROY, UNCHANGED, ELSEWHERE])]);
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const base = scored(run, decisions);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const ref = (index) => base.outcomes.find((o) => o.index === index).findingId.slice(0, 12);
    const refused = [
      [["same-issue", ref(3), "--bug", "admin"], /admin sits in app\/users\.py, not in app\/search\.py/],
      [["same-issue", ref(2), "--bug", "admin"], /no line the change added/],
      [["same-issue", ref(1), "--bug", "nope"], /no truth item nope/],
      [["different-issue", ref(1), "--bug", "admin"], /same-issue/],
      [["true", ref(1), "--bug", "admin"], /--bug/],
    ];
    for (const [args, why] of refused) {
      const r = queue("decide", ...args, "--by", "Sid", "--queue", q);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(why);
    }
    expect(existsSync(decisions)).toBe(false);
  });
});

describe("a planted bug found at a place its spec does not list can never be ruled found", () => {
  it("records a same-issue ruling that names the item for a finding on an added line of its file, and scores it as that item's hit on that spec version only", async () => {
    const { run, specsB } = await savedRun([report([SQLI, DESTROY]), report([SQLI])]);
    const q = queueDir();
    const decisions = join(q, "decisions.jsonl");
    const before = scored(run, decisions);
    const destroy = before.outcomes.find((o) => o.repeat === 1 && o.index === 1);
    // Nineteen lines from the plant: no location match, so nothing to ask it against.
    expect(destroy).toMatchObject({ outcome: "unresolved", truthId: null, evidenceKind: null });
    expect(bugOf(before, "admin").found).toEqual([false, false]);
    expect(queue("add", run, "--queue", q).status).toBe(0);
    const [item] = readJsonl(join(q, "planted.jsonl"));
    expect(item).toMatchObject({ findingId: destroy.findingId, truth: null, asks: ["real"], specHash: HASH_A, changedLines: [21] });
    const r = queue("decide", "same-issue", destroy.findingId.slice(0, 12), "--bug", "admin", "--by", "Sid", "--note", "the admin check, found where it bites", "--queue", q);
    expect(r.status, r.stderr).toBe(0);
    const [joined] = readJsonl(decisions);
    expect(joined).toMatchObject({ caseId: CASE_ID, target: { kind: "match", findingId: destroy.findingId, truthId: "admin", specHash: HASH_A }, status: "same-issue", by: "Sid" });
    expect(joined.evidence).toMatchObject({ lines: [21, 21], text: "    line_21 = 21" });
    const after = scored(run, decisions);
    expect(after.outcomes.find((o) => o.findingId === destroy.findingId)).toMatchObject({ outcome: "hit", truthId: "admin", evidenceKind: "ruling" });
    expect(bugOf(after, "admin").found).toEqual([true, false]);
    expect(after.score.byConfig[CONFIG].issueRecall.all.hit).toBe(before.score.byConfig[CONFIG].issueRecall.all.hit + 1);
    // The question is answered: the sheet no longer asks it.
    const sheet = queue("sheet", "planted", "--seed", "1", "--json", "--queue", q);
    expect(sheet.status, sheet.stderr).toBe(0);
    expect(JSON.parse(sheet.stdout).items).toEqual([]);
    // Against the next version of the spec the ruling is silent.
    const onB = scored(run, decisions, specsB);
    expect(onB.outcomes.find((o) => o.findingId === destroy.findingId)).toMatchObject({ outcome: "unresolved", truthId: null });
    expect(bugOf(onB, "admin").found).toEqual([false, false]);
    expect(onB.unresolved.find((i) => i.findingId === destroy.findingId)).toMatchObject({ specHash: HASH_B, asks: ["real"] });
  });
});
