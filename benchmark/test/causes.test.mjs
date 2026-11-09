// Why a review missed a truth item, or showed a finding that is not one, is
// read from the review's saved files: the brief, the trace, the correction
// rounds, the submission, the report with its drops, and a person's rulings.
// Each test makes a run in a temp folder with the runner's own code, writes
// the files a review would have saved, scores it with score.mjs and reads
// the causes back from the score and from causes.mjs.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MISS_CAUSES, NON_HIT_CAUSES } from "../lib/causes.mjs";
import { specHashOf } from "../lib/rulings.mjs";
import { attemptDir, executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const causesMjs = fileURLToPath(new URL("../causes.mjs", import.meta.url));
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const truth = (id, file, lines, kind, severity, mentions, found_by, extra = {}) => ({ id, file, lines, anchor: { line: lines[0], text: "x" }, mentions, kind, severity, found_by, truth: "t", ...extra });

// Four planted bugs in three files, and one whose proof lives outside the change.
const spec = {
  id: "mixed",
  guards: "g",
  language: "python",
  framework: "flask",
  clean: false,
  bugs: [
    truth("sqli", "app/search.py", [14, 14], ["security"], "critical", ["sql", "inject"], ["semgrep", "reasoning"]),
    truth("apt", "Dockerfile", [3, 3], ["maintainability"], "minor", ["apt", "pin"], ["hadolint"]),
    truth("loop", "scripts/deploy.sh", [11, 11], ["bug"], "minor", ["ls"], ["shellcheck"]),
    truth("admin", "app/users.py", [2, 2], ["security"], "critical", ["admin", "any user"], ["reasoning"]),
  ],
  extras: [],
};

// The spec version a ruling on its truth item names (rules version 8).
const SPEC = specHashOf(spec);
const HASH = "ef".repeat(32);
const CASE_ID = `planted/mixed@${HASH.slice(0, 8)}`;
const CONFIG = "claude-graph-off";

const finding = (file_path, line_number, category, title, extra = {}) => ({ severity: "major", category, confidence: 0.9, file_path, line_number, line_end: line_number, title, description: title, suggested_change: null, source: null, candidate: null, problem: `${title}.`, consequence: "It breaks.", fix: "Fix it.", ...extra });
const shown = (f) => ({ origin: "agent", notes: [], ...f });
const candidate = (id, token, filePath, line, message) => {
  const cut = token.indexOf(":");
  return { id, token, source: token.slice(0, cut), ruleId: token.slice(cut + 1), filePath, lineStart: line, lineEnd: line, severity: "low", message };
};
const drop = (c, reason) => ({ candidate: c, reason });

// What a review saved: the report, built from the submission the way
// finalize does (findings at or above minor listed, the rest counted), and
// the submission itself.
function review({ submitted = [], dropped = [], low = [], status = "complete", extra = {} }) {
  const passed = submitted.filter((f) => !low.includes(f));
  const listed = passed.filter((f) => ["critical", "major", "minor"].includes(f.severity));
  const report = {
    version: 1,
    kind: "review",
    verdict: "passed",
    findings: listed.map(shown),
    below_threshold: passed.length - listed.length,
    outside_change: [],
    low_confidence: low.map((f) => ({ title: f.title, file_path: f.file_path, confidence: f.confidence, floor: 0.7 })),
    dropped,
    scanners: [],
    impact: { status: "off" },
    completion: { status, missing: status === "complete" ? [] : ["1 changed range was not read"], trace_complete: true, reviewer: { duration_ms: 1000, rounds: 1, usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 } } },
    ...extra,
  };
  return { report, submission: { version: 2, change_id: "x", summary: "s", findings: submitted, dropped: dropped.map((d) => ({ candidate: d.candidate.id, reason: d.reason })) } };
}

// A brief whose diff shows `hunks` ({ path, start, count } on the new side).
function briefOf(hunks) {
  const lines = ["# Review brief", "", "## Diff", "", "```diff"];
  for (const h of hunks) {
    lines.push(`diff --git a/${h.path} b/${h.path}`, `--- a/${h.path}`, `+++ b/${h.path}`, `@@ -${h.start},1 +${h.start},${h.count} @@`, " context");
    for (let i = 1; i < h.count; i++) lines.push(`+added ${i}`);
  }
  lines.push("```", "", "## Answer");
  return lines.join("\n");
}
const BRIEF = briefOf([
  { path: "app/search.py", start: 10, count: 8 },
  { path: "Dockerfile", start: 1, count: 6 },
  { path: "scripts/deploy.sh", start: 5, count: 8 },
  { path: "app/users.py", start: 1, count: 22 },
]);

const planned = (repeat) => planJobs({ cases: ["mixed"], caseIds: { mixed: CASE_ID }, reviewers: ["claude"], graph: ["off"], repeat }).jobs;

// A run of the mixed case made by the runner's own code; each repeat's
// review is replaced by the files given for it (null: it never started).
async function savedRun(reviews, caseSpec = spec) {
  const root = tempDir("oq-causes-run-");
  const out = join(root, "run");
  write(join(root, "mixed.json"), JSON.stringify(caseSpec));
  const repeat = reviews.length;
  const jobs = planned(repeat);
  const manifest = runManifest({
    startedAt: "2026-10-11T10:00:00.000Z",
    settings: { build: { commit: "b".repeat(40), short: "bbbbbbb", dirty: false, cliVersion: "0.14.0" }, reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } }, cases: ["mixed"], caseIds: [CASE_ID], caseHashes: { mixed: HASH }, configs: [CONFIG], repeat },
    jobs,
  });
  await executeRun({ out, manifest, jobs, copies: [[join(root, "mixed.json"), "cases/mixed.json"]], runJob: async (job) => {
    const r = reviews[job.repeat - 1];
    if (r === null) return;
    const dir = attemptDir(out, job, 1);
    write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ usageRecord: { calls: [{ model: "claude-opus-5-5" }] }, job, attempt: 1, result: { code: 0, signal: null, wallMs: 1000 }, report: r.report, who: null, startedAt: "t", failure: null, stopped: null })));
    write(join(dir, "report", "report.json"), JSON.stringify(r.report));
    // A file set to null was not saved, as by an older review.
    if (r.submission !== null) write(join(dir, "report", "submission.json"), JSON.stringify(r.submission));
    write(join(dir, "report", "brief.md"), r.brief ?? BRIEF);
    if (r.trace !== null) write(join(dir, "report", "trace.json"), JSON.stringify(r.trace ?? []));
    if (r.rounds) write(join(dir, "report", "rounds.json"), JSON.stringify(r.rounds));
  } });
  return out;
}

// The rulings a person made: people.json names Sid; each line as decide writes it.
function decisions(lines) {
  const folder = tempDir("oq-causes-queue-");
  write(join(folder, "people.json"), JSON.stringify({ v: 1, people: ["Sid"] }));
  return lines.map((l, i) => ({ v: 1, caseId: CASE_ID, fromSheet: null, target: l.target, status: l.status, by: l.by ?? "Sid", at: `2026-10-11T10:0${i}:00.000Z`, note: "n", evidence: null }));
}

const scored = (run, lines = []) => scoreRun(loadRun(run), { decisions: decisions(lines), people: ["Sid"] });
const causeOf = (s, bug, repeat = 1) => s.score.perBug[CONFIG][CASE_ID][bug].cause[repeat - 1];

const SQLI = finding("app/search.py", 14, "security", "SQL injection through the search term");
const APT = finding("Dockerfile", 3, "maintainability", "apt-get packages are not pinned", { severity: "minor" });
const LOOP = finding("scripts/deploy.sh", 11, "bug", "Loop parses ls output", { severity: "nitpick", candidate: "c10" });
const ADMIN = finding("app/users.py", 2, "security", "Admin check skips destroy");

describe("a found bug gets a cause", () => {
  it("leaves every found truth item without a cause and gives every missed one exactly one, in the score and in causes.mjs", async () => {
    const run = await savedRun([review({ submitted: [SQLI, APT, ADMIN] }), review({ submitted: [APT] })]);
    const s = scored(run);
    expect(causeOf(s, "sqli", 1)).toBeNull();
    expect(causeOf(s, "apt", 1)).toBeNull();
    expect(causeOf(s, "apt", 2)).toBeNull();
    for (const [bug, repeat] of [["loop", 1], ["sqli", 2], ["loop", 2], ["admin", 2]]) expect(MISS_CAUSES).toContain(causeOf(s, bug, repeat));
    const out = spawnSync(process.execPath, [causesMjs, run, "--json"], { encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    const doc = JSON.parse(out.stdout);
    const misses = doc.runs[0].misses;
    expect(misses.map((m) => `${m.bug}/${m.repeat}`).sort()).toEqual(["admin/2", "loop/1", "loop/2", "sqli/2"]);
    expect(misses.every((m) => MISS_CAUSES.includes(m.cause))).toBe(true);
    const counts = s.score.byConfig[CONFIG].causes;
    expect(Object.values(counts.misses).reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe("a miss with no scanner on its lines is labelled dropped", () => {
  it("labels candidate-dropped only when a dropped candidate located the item, by its expected scanner or by its words", async () => {
    // On the Dockerfile the reviewer dropped a hadolint candidate about the
    // apt line; on the search line it dropped a gitleaks candidate about a
    // key, which neither the spec expects nor names the injection.
    const dropped = [drop(candidate("c1", "hadolint:DL3008", "Dockerfile", 3, "Pin versions in apt get install"), "Only affects reproducibility."), drop(candidate("c2", "gitleaks:generic-api-key", "app/search.py", 14, "Generic API key detected"), "A test token, not a secret.")];
    const s = scored(await savedRun([review({ submitted: [LOOP, ADMIN], dropped })]));
    expect(causeOf(s, "apt")).toBe("candidate-dropped");
    expect(causeOf(s, "sqli")).toBe("judged-wrong");
  });
});

describe("a drop reason is lost, or one miss gets a cause per drop", () => {
  it("gives the miss one cause, candidate-dropped, and keeps each drop's reason and its class from drops.mjs", async () => {
    const dropped = [drop(candidate("c1", "hadolint:DL3008", "Dockerfile", 3, "Pin versions in apt get install"), "Unpinned packages only enlarge the image."), drop(candidate("c2", "hadolint:DL3015", "Dockerfile", 3, "Avoid additional packages by specifying --no-install-recommends"), "The same problem is raised under c1.")];
    const run = await savedRun([review({ submitted: [SQLI, LOOP, ADMIN], dropped })]);
    expect(causeOf(scored(run), "apt")).toBe("candidate-dropped");
    const doc = JSON.parse(spawnSync(process.execPath, [causesMjs, run, "--json"], { encoding: "utf8" }).stdout);
    const apt = doc.runs[0].misses.filter((m) => m.bug === "apt");
    expect(apt).toHaveLength(1);
    expect(apt[0].drops.map((d) => [d.token, d.reason, d.class])).toEqual([
      ["hadolint:DL3008", "Unpinned packages only enlarge the image.", "low-value"],
      ["hadolint:DL3015", "The same problem is raised under c1.", "duplicate"],
    ]);
  });
});

describe("a nitpick on a planted bug hidden by the threshold is labelled a scanner drop", () => {
  it("labels finalize-threshold when the reviewer raised the bug below the threshold, though it also dropped a candidate on it", async () => {
    // The shellcheck candidate is dropped as covered by the nitpick raised under c10.
    const dropped = [drop(candidate("c11", "shellcheck:SC2086", "scripts/deploy.sh", 11, "Double quote to prevent globbing and word splitting"), "The quoting problem in the loop is covered by the finding raised under c10.")];
    const s = scored(await savedRun([review({ submitted: [SQLI, APT, ADMIN, LOOP], dropped })]));
    expect(causeOf(s, "loop")).toBe("finalize-threshold");
  });

  it("labels finalize-floor, not the threshold, when the finding on the bug was under the confidence floor", async () => {
    const low = { ...SQLI, confidence: 0.6 };
    const s = scored(await savedRun([review({ submitted: [low, APT, ADMIN], low: [low] })]));
    expect(causeOf(s, "sqli")).toBe("finalize-floor");
  });
});

describe("a finding a correction round rejected reads as never raised", () => {
  it("labels finalize-rejected when a round's answer held a finding on the bug that the final answer left out", async () => {
    const r = review({ submitted: [APT, ADMIN] });
    r.rounds = [{ by: "primary", round: 1, errors: ["finding 1 cites app/search.py:40, which the change does not touch"], delivered: [], later: 0, answer: { findings: [SQLI, APT, ADMIN] } }];
    const s = scored(await savedRun([r]));
    expect(causeOf(s, "sqli")).toBe("finalize-rejected");
    expect(causeOf(s, "loop")).toBe("judged-wrong");
  });
});

describe("a drop on a disputed plant is labelled spec-disputed without a person's ruling", () => {
  it("keeps candidate-dropped until a person disputes the truth item, and ignores a dispute signed by a model", async () => {
    const dropped = [drop(candidate("c1", "hadolint:DL3008", "Dockerfile", 3, "Pin versions in apt get install"), "Not a defect: the base image pins the packages.")];
    const run = await savedRun([review({ submitted: [SQLI, LOOP, ADMIN], dropped })]);
    expect(causeOf(scored(run), "apt")).toBe("candidate-dropped");
    expect(causeOf(scored(run, [{ target: { kind: "bug", id: "apt", specHash: SPEC }, status: "disputed", by: "claude" }]), "apt")).toBe("candidate-dropped");
    expect(causeOf(scored(run, [{ target: { kind: "bug", id: "apt", specHash: SPEC }, status: "disputed" }]), "apt")).toBe("spec-disputed");
  });
});

describe("an unresolved case is guessed", () => {
  const OTHER = finding("app/search.py", 20, "bug", "Pagination skips the first page");

  it("labels an unlisted finding unresolved until a person rules it a real issue or not", async () => {
    const run = await savedRun([review({ submitted: [SQLI, APT, ADMIN, OTHER] })]);
    const before = scored(run);
    const at = before.outcomes.findIndex((o) => o.outcome === "unresolved");
    expect(before.outcomes[at].cause).toBe("unresolved");
    expect(before.outcomes.filter((o) => o.outcome === "hit").every((o) => o.cause === null)).toBe(true);
    const id = before.outcomes[at].findingId;
    expect(scored(run, [{ target: { kind: "finding", findingId: id }, status: "true" }]).outcomes[at].cause).toBe("real-unlisted");
    expect(scored(run, [{ target: { kind: "finding", findingId: id }, status: "false" }]).outcomes[at].cause).toBe("false");
    for (const o of before.outcomes) if (o.cause !== null) expect(NON_HIT_CAUSES).toContain(o.cause);
  });

  it("labels a miss unresolved, not judged wrong, while the review holds an unruled finding that names it at a place the spec does not list, by words no other plant shares", async () => {
    // The admin check is planted at line 2; the reviewer reported it where it bites, at line 21.
    // A second plant in that file shares the word admin, and the finding is not about it.
    const escalate = truth("escalate", "app/users.py", [16, 16], ["security"], "major", ["admin", "escalat"], ["reasoning"]);
    const elsewhere = finding("app/users.py", 21, "security", "Any user can delete any account", { problem: "destroy is exempt from the admin check." });
    const s = scored(await savedRun([review({ submitted: [SQLI, APT, elsewhere] })], { ...spec, bugs: [...spec.bugs, escalate] }));
    expect(causeOf(s, "admin")).toBe("unresolved");
    expect(causeOf(s, "escalate")).toBe("judged-wrong");
    expect(s.outcomes.find((o) => o.truthId === null && o.outcome === "unresolved").cause).toBe("unresolved");
  });

  it("labels a miss unresolved while an unruled finding sits on its lines, and moves on once a person rules it a different issue", async () => {
    const onLines = finding("app/search.py", 14, "bug", "Search term is not trimmed");
    const run = await savedRun([review({ submitted: [onLines, APT, ADMIN] })]);
    const before = scored(run);
    expect(causeOf(before, "sqli")).toBe("unresolved");
    const id = before.outcomes.find((o) => o.truthId === "sqli").findingId;
    expect(causeOf(scored(run, [{ target: { kind: "match", findingId: id, truthId: "sqli", specHash: SPEC }, status: "different-issue" }]), "sqli")).toBe("judged-wrong");
  });

  it("labels a near miss line-off and a finding of another kind wrong-kind, both as a miss and as a finding", async () => {
    const near = finding("app/search.py", 16, "security", "SQL injection in the search query");
    const kind = finding("Dockerfile", 3, "security", "apt-get packages are not pinned");
    const s = scored(await savedRun([review({ submitted: [near, kind, ADMIN] })]));
    expect(causeOf(s, "sqli")).toBe("line-off");
    expect(causeOf(s, "apt")).toBe("wrong-kind");
    expect(s.outcomes.map((o) => o.cause)).toEqual(["line-off", "wrong-kind", null]);
  });
});

describe("a miss the reviewer never saw is blamed on its judgement", () => {
  const late = truth("late", "app/late.py", [100, 100], ["bug"], "major", ["late"], ["reasoning"]);
  const proof = truth("proof", "app/search.py", [12, 12], ["bug"], "major", ["rounding"], ["reasoning"], { evidence: [{ file: "app/money.py", lines: [40, 44] }] });
  const withBoth = { ...spec, bugs: [...spec.bugs, late, proof] };

  it("labels not-in-brief when no brief hunk, read or delivered range showed the item's lines, and not-read when its proof outside the change was never read", async () => {
    const s = scored(await savedRun([review({ submitted: [SQLI, APT, ADMIN] })], withBoth));
    expect(causeOf(s, "late")).toBe("not-in-brief");
    expect(causeOf(s, "proof")).toBe("not-read");
  });

  it("does not blame the brief once a read or a correction round delivered the lines", async () => {
    const r = review({ submitted: [SQLI, APT, ADMIN] });
    r.trace = [{ tool: "Read", path: "app/money.py", inside: true, range: [1, 60], ok: true }];
    r.rounds = [{ by: "primary", round: 1, errors: [], delivered: [{ path: "app/late.py", start: 95, end: 105, deletion: false }], later: 0, answer: null }];
    const s = scored(await savedRun([r], withBoth));
    expect(causeOf(s, "late")).toBe("judged-wrong");
    expect(causeOf(s, "proof")).toBe("judged-wrong");
  });
});

describe("absent data is read as evidence", () => {
  const late = truth("late", "app/late.py", [100, 100], ["bug"], "major", ["late"], ["reasoning"]);
  const withLate = { ...spec, bugs: [...spec.bugs, late] };

  it("labels a miss unresolved, not judged-wrong, when no trace records the reads and the brief does not hold its lines", async () => {
    const r = review({ submitted: [SQLI, APT, ADMIN] });
    r.trace = null;
    const s = scored(await savedRun([r], withLate));
    expect(causeOf(s, "late")).toBe("unresolved");
    // The brief holds the loop's lines, so its miss is still judged wrong.
    expect(causeOf(s, "loop")).toBe("judged-wrong");
  });

  it("labels a miss unresolved, not not-in-brief or judged-wrong, when the review took correction rounds and saved no rounds.json", async () => {
    const r = review({ submitted: [SQLI, APT, ADMIN] });
    r.report.completion.reviewer.rounds = 2;
    const s = scored(await savedRun([r], withLate));
    expect(causeOf(s, "late")).toBe("unresolved");
    expect(causeOf(s, "loop")).toBe("unresolved");
  });

  it("labels a miss unresolved, not finalize-rejected or judged-wrong, when the submission was not saved", async () => {
    const r = review({ submitted: [APT, ADMIN] });
    r.submission = null;
    r.rounds = [{ by: "primary", round: 1, errors: ["finding 1 cites app/search.py:40, which the change does not touch"], delivered: [], later: 0, answer: { findings: [SQLI, APT, ADMIN] } }];
    const s = scored(await savedRun([r]));
    expect(causeOf(s, "sqli")).toBe("unresolved");
    expect(causeOf(s, "loop")).toBe("unresolved");
  });
});

describe("a miss in a review that did not complete is blamed on the reviewer", () => {
  it("labels incomplete for an incomplete review and for a planned review that never started", async () => {
    const s = scored(await savedRun([review({ submitted: [SQLI], status: "incomplete" }), null]));
    expect(causeOf(s, "apt", 1)).toBe("incomplete");
    expect(causeOf(s, "sqli", 1)).toBeNull();
    for (const bug of ["sqli", "apt", "loop", "admin"]) expect(causeOf(s, bug, 2)).toBe("incomplete");
  });
});
