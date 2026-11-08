import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { buildReviewerBrief, checkSubmission, DEFAULT_CONFIG } from "../../packages/core/dist/index.js";
import { hashFolder } from "../lib/index.mjs";
import { buildCase, caseHash } from "../lib/cases.mjs";
import { CLASSES } from "../lib/classes.mjs";
import { replayRun, replaySubmission } from "../loop/replay.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const cli = fileURLToPath(new URL("../loop/replay.mjs", import.meta.url));
const f = (extra = {}) => ({ severity: "minor", category: "bug", confidence: 0.8, file_path: "a.py", line_number: 2, title: "Division by zero", problem: "The divisor is zero.", consequence: "The request fails.", fix: "Reject zero.", source: null, candidate: null, ...extra });
const spec = { id: "division", guards: "Division is checked", language: "python", framework: "none", clean: false, bugs: [{ id: "zero", file: "a.py", lines: [2, 2], anchor: { line: 2, text: "return 1 / 0" }, mentions: ["zero"], kind: ["bug"], severity: "minor", truth: "The divisor is zero.", found_by: ["reasoning"] }], extras: [] };
const brief = "## Changed files\n\n| Status | Path |\n|---|---|\n| modified | a.py |\n\n## Diff\n\n```diff\ndiff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,3 +1,3 @@\n # context\n-return 1\n+return 1 / 0\n # context\n```\n";
const manifest = { version: 3, change_id: "abcdef", lenses: [{ name: "division", confidenceFloor: 0.85 }] };
const scan = { candidates: [], scanners: [], secretFingerprints: [] };
const submission = (findings) => ({ version: 2, change_id: "abcdef", summary: "Check division.", findings, dropped: [] });
const input = (findings) => ({ change: { id: "abcdef", shortId: "abcdef", files: [{ path: "a.py" }], coverage: new Map([["a.py", new Set([2])]]), deletionPoints: new Map(), baseRef: "HEAD", baseSha: "123", notReviewed: [], stats: {} }, scan, manifest, config: DEFAULT_CONFIG, submission: submission(findings), lineCount: (path) => path === "a.py" ? 3 : null });
const write = (path, data) => writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));

function savedRun(findingsByRepeat, { savedBrief = brief, argsFor = input, inventory = [{ path: "a.py", size: 30, lines: 3, language: "python", candidates: 0 }] } = {}) {
  const root = tempDir("oq-replay-");
  const run = join(root, "run");
  mkdirSync(join(run, "cases"), { recursive: true });
  write(join(run, "manifest.json"), { version: 1, cases: ["division"], configs: ["claude-graph-off"], repeat: findingsByRepeat.length });
  write(join(run, "cases", "division.json"), spec);
  for (const [i, findings] of findingsByRepeat.entries()) {
    const dir = join(run, "samples", "division", "claude-graph-off", String(i + 1));
    mkdirSync(join(dir, "report"), { recursive: true });
    write(join(dir, "sample.json"), { case: "division", config: "claude-graph-off", repeat: i + 1, attempt: 1 });
    write(join(dir, "report", "brief.md"), savedBrief);
    if (inventory !== null) write(join(dir, "report", "inventory.json"), inventory);
    write(join(dir, "report", "manifest.json"), manifest);
    const args = argsFor(findings);
    write(join(dir, "report", "scan.json"), args.scan);
    write(join(dir, "report", "submission.json"), args.submission);
    const checked = checkSubmission(args);
    expect(checked.ok).toBe(true);
    write(join(dir, "report", "report.json"), { ...checked.report, completion: { status: "complete" } });
  }
  return { root, run };
}

function plantedSource(run) {
  const root = join(run, "cases");
  const dir = join(root, "division");
  for (const folder of ["base", "change"]) mkdirSync(join(dir, folder, "tests"), { recursive: true });
  write(join(dir, "case.json"), { ...spec, bugs: spec.bugs.map((b) => ({ ...b, class: CLASSES[0], tags: [], evidence: [] })) });
  write(join(dir, "base", "a.py"), "# context\nreturn 1\n# context\n");
  write(join(dir, "change", "a.py"), "# context\nreturn 1 / 0\n# context\n");
  write(join(dir, "base", "tests", "test_money.py"), "assert True\n".repeat(30));
  return root;
}

it("replays a saved brief whose diff contains three backticks with matching fences", () => {
  for (const backticks of [3, 5]) {
    const diff = brief.match(/```diff\n([\s\S]*?)```\n/)[1].replace("+return 1 / 0", `+return 1 / 0 # ${"`".repeat(backticks)}`);
    const change = { ...input([]).change, changedPaths: ["a.py"], diff };
    const { text: savedBrief } = buildReviewerBrief({ change, scan, lenses: [], config: DEFAULT_CONFIG, secrets: [] });
    const fence = "`".repeat(backticks + 1);
    expect(savedBrief).toContain(`${fence}diff\n`);
    const { run } = savedRun([[f()]], { savedBrief });
    const replay = replayRun(run);
    expect(replay.unresolved).toHaveLength(0);
    expect(replay.rows[0].hits).toBe(1);
    const path = join(run, "samples", "division", "claude-graph-off", "1", "report", "brief.md");
    for (const length of [backticks, backticks + 2]) {
      write(path, savedBrief.replace(`\n${fence}\n`, `\n${"`".repeat(length)}\n`));
      expect(() => replayRun(run)).toThrow(/saved brief has no diff/);
    }
  }
});

it("replays and scores a finding on an omitted file's saved changed ranges", () => {
  for (const withShownDiff of [true, false]) {
    const omitted = { path: "a.py", text: `diff --git a/a.py b/a.py\n${"+x\n".repeat(120_000)}` };
    const shown = { path: "b.py", text: "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-old\n+new\n" };
    const change = { ...input([]).change, changedPaths: ["a.py"], coverage: new Map([["a.py", new Set([2, 3, 5])]]), diffs: withShownDiff ? [shown, omitted] : [omitted] };
    const { text: savedBrief, diffFiles } = buildReviewerBrief({ change, scan, lenses: [], config: DEFAULT_CONFIG, secrets: [] });
    expect(diffFiles.has("a.py")).toBe(false);
    expect(savedBrief).toContain("- a.py: lines 2-3, 5");
    const argsFor = (fs) => ({ ...input(fs), change, lineCount: () => 5 });
    const { run } = savedRun([[f(), f({ line_number: 3, title: "Zero at three" }), f({ line_number: 5, title: "Zero at five" })]], { savedBrief, argsFor, inventory: [{ path: "a.py", lines: 5 }] });
    const replay = replayRun(run);
    expect(replay.unresolved).toHaveLength(0);
    expect(replay.rows[0].hits).toBe(1);
    expect(replay.rows[0].findings).toBe(3);
    write(join(run, "samples", "division", "claude-graph-off", "1", "report", "submission.json"), submission([f({ line_number: 4 })]));
    expect(() => replayRun(run)).toThrow(/not a line this change/);
  }
});

it("checks a dropped candidate without a saved length against the rebuilt head file", () => {
  const candidate = { id: "c1", token: "bandit:B101", source: "bandit", ruleId: "B101", filePath: "a.py", lineStart: 2, lineEnd: 2, severity: "low", message: "An assert." };
  const dropped = { candidate: "c1", file_path: "tests/test_money.py", line_number: 30, reason: "The test uses an assert correctly." };
  const argsFor = (fs) => ({ ...input(fs), scan: { ...scan, candidates: [candidate] }, submission: { ...submission(fs), dropped: [dropped] }, lineCount: () => 30 });
  const { run } = savedRun([[f()]], { argsFor, inventory: null });
  const root = plantedSource(run);
  const built = buildCase("division", join(tempDir("oq-replay-built-"), "repo"), root);
  const headHash = hashFolder(built.dir, ["a.py", "tests/test_money.py"]).listHash;
  for (const hash of [null, headHash, caseHash("division", root)]) {
    write(join(run, "manifest.json"), { version: 1, cases: ["division"], configs: ["claude-graph-off"], repeat: 1, ...(hash ? { caseHashes: { division: hash } } : {}) });
    for (const mode of ["threshold", "union", "floor"]) expect(replayRun(run, { mode }).unresolved).toHaveLength(0);
  }
  write(join(run, "samples", "division", "claude-graph-off", "1", "report", "submission.json"), { ...submission([f()]), dropped: [{ ...dropped, line_number: 31 }] });
  expect(() => replayRun(run)).toThrow(/has 30 lines/);
});

it("refuses a case by name when its content differs from the recorded specs", () => {
  const { run } = savedRun([[f()]], { inventory: null });
  const root = plantedSource(run);
  write(join(run, "manifest.json"), { version: 1, cases: ["division"], configs: ["claude-graph-off"], repeat: 1, caseHashes: { division: caseHash("division", root) } });
  write(join(root, "division", "change", "a.py"), "# context\nreturn 2 / 0\n# context\n");
  expect(() => replayRun(run)).toThrow(/division.*content differs/);
});

it("a replay applies a check other than the product's", () => {
  for (const invalid of [f({ line_number: 1 }), f({ problem: "word ".repeat(21) }), f({ source: "lens:unknown" })]) {
    const args = input([invalid]);
    const core = checkSubmission(args);
    expect(core.ok).toBe(false);
    expect(replaySubmission(args)).toEqual(core);
  }
  // A floor is inclusive, and a lens's higher floor still wins.
  const args = input([f({ confidence: 0.8 }), f({ confidence: 0.79, title: "Low confidence" }), f({ confidence: 0.84, source: "lens:division", title: "Lens floor" })]);
  expect(replaySubmission(args, { floor: 0.8 }).report.findings.map((x) => x.title)).toEqual(["Division by zero"]);
});

it("refuses dangling and chained output symlinks into the input run", () => {
  const { root, run } = savedRun([[f()]]);
  const before = hashFolder(run);
  const target = join(run, "new.md");
  const dangling = join(root, "dangling.md");
  const chained = join(root, "chained.md");
  symlinkSync(relative(root, target), dangling);
  symlinkSync("dangling.md", chained);
  for (const out of [dangling, chained]) {
    const result = spawnSync(process.execPath, [cli, "threshold", run, "--out", out], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("run folder");
  }
  expect(existsSync(target)).toBe(false);
  expect(hashFolder(run)).toEqual(before);
});

it("refuses output inside another manifest folder outside the results store", () => {
  const { root, run } = savedRun([[f()]]);
  const other = join(root, "other-run");
  mkdirSync(join(other, "nested"), { recursive: true });
  write(join(other, "manifest.json"), { version: 1 });
  symlinkSync("other-run/nested/new.md", join(root, "other.md"));
  const before = hashFolder(other);
  for (const out of [join(other, "nested", "new.md"), join(root, "other.md")]) {
    const result = spawnSync(process.execPath, [cli, "threshold", run, "--out", out], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr.trim().split("\n")).toEqual([`replay: --out cannot write into a run folder: ${realpathSync(other)}`]);
  }
  expect(hashFolder(other)).toEqual(before);
});

it("uses saved file lengths for ranges beyond a zero-context diff", () => {
  const savedBrief = brief.replace("@@ -1,3 +1,3 @@\n # context\n-return 1\n+return 1 / 0\n # context", "@@ -2 +2 @@\n-return 1\n+return 1 / 0");
  const finding = f({ line_end: 5 });
  const { run } = savedRun([[finding]], { savedBrief, argsFor: (fs) => ({ ...input(fs), lineCount: () => 10 }), inventory: [{ path: "a.py", size: 100, lines: 10, language: "python", candidates: 0 }] });
  expect(replayRun(run).rows[0].hits).toBe(1);
  const dir = join(run, "samples", "division", "claude-graph-off", "1", "report");
  write(join(dir, "submission.json"), submission([f({ line_end: 11 })]));
  expect(() => replayRun(run)).toThrow(/has 10 lines/);
});

it("uses the saved brief's file list when lengths were not saved, as core does", () => {
  const { run } = savedRun([[f({ confidence: 1, line_end: 5 })]], { argsFor: (fs) => ({ ...input(fs), lineCount: () => 10 }), inventory: null });
  // A recorded read range is not the file's length either.
  write(join(run, "samples", "division", "claude-graph-off", "1", "report", "trace.json"), [{ tool: "Read", ok: true, inside: true, path: "a.py", range: [1, 2] }]);
  for (const mode of ["threshold", "floor"]) {
    const replay = replayRun(run, { mode });
    expect(replay.rows.every((r) => r.findings === 1)).toBe(true);
    expect(replay.unresolved).toHaveLength(0);
  }
  const result = spawnSync(process.execPath, [cli, "threshold", run], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Unresolved: 0");
});

it("replays accepted submissions with missing dropped citations as unresolved and scores the rest", () => {
  const candidate = { id: "c1", token: "bandit:B101", source: "bandit", ruleId: "B101", filePath: "a.py", lineStart: 2, lineEnd: 2, severity: "low", message: "An assert." };
  const dropped = { candidate: "c1", file_path: "tests/test_money.py", line_number: 21, reason: "The test uses an assert correctly." };
  const missingFinding = f({ file_path: "missing.py", title: "Missing divisor check" });
  const argsFor = (fs) => {
    const args = input(fs);
    return { ...args, change: { ...args.change, files: [...args.change.files, { path: "missing.py" }], coverage: new Map([...args.change.coverage, ["missing.py", new Set([2])]]) }, scan: { ...scan, candidates: [candidate] }, submission: { ...submission(fs), dropped: [dropped] }, lineCount: (path) => path === "tests/test_money.py" ? 30 : 3 };
  };
  const { run } = savedRun([[f({ confidence: 1 }), missingFinding], [f({ confidence: 1 }), missingFinding]], { argsFor });
  const before = hashFolder(run);
  for (const mode of ["threshold", "union", "floor"]) {
    const replay = replayRun(run, { mode });
    expect(replay.rows.every((r) => r.hits === (mode === "union" ? 1 : 2))).toBe(true);
    expect(replay.unresolved).toHaveLength(4);
    expect(replay.unresolved).toContainEqual(expect.objectContaining({ finding: missingFinding, reason: "no saved file length for missing.py; no planted source folders or pinned build commit" }));
    expect(replay.unresolved).toContainEqual(expect.objectContaining({ dropped, reason: "no saved file length for tests/test_money.py; no planted source folders or pinned build commit" }));
  }
  const result = spawnSync(process.execPath, [cli, "threshold", run], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("dropped c1");
  expect(result.stdout).toContain("no saved file length for tests/test_money.py");
  expect(hashFolder(run)).toEqual(before);
});

it("uses core's saved deletion anchors for deletion-only hunks", () => {
  const savedBrief = brief.replace("@@ -1,3 +1,3 @@\n # context\n-return 1\n+return 1 / 0\n # context", "@@ -5 +4,0 @@\n-return 1").replace("## Diff", "## Deleted lines\n\n- 1 line deleted after line 4 of a.py (cite line 4 or 5)\n\n## Diff");
  const argsFor = (fs) => {
    const args = input(fs);
    return { ...args, change: { ...args.change, coverage: new Map([["a.py", new Set()]]), deletionPoints: new Map([["a.py", [{ after: 4, lines: 1, anchors: [4, 5] }]]]) }, lineCount: () => 10 };
  };
  for (const line_number of [4, 5]) {
    const { run } = savedRun([[f({ line_number })]], { savedBrief, argsFor, inventory: [{ path: "a.py", lines: 10 }] });
    expect(replayRun(run).rows[0].findings).toBe(1);
  }
});

it("preserves core's emptied and deleted file metadata", () => {
  for (const status of ["modified", "deleted"]) {
    const empty = status === "modified";
    const deletedLines = empty ? "- 3 lines deleted at the top of a.py (cite line 1)" : "- a.py was deleted (cite line 1)";
    const savedBrief = brief.replace("| modified |", `| ${status} |`).replace("## Diff", `## Deleted lines\n\n${deletedLines}\n\n## Diff`).replace("+++ b/a.py", empty ? "+++ b/a.py" : "+++ /dev/null").replace("@@ -1,3 +1,3 @@\n # context\n-return 1\n+return 1 / 0\n # context", "@@ -1,3 +0,0 @@\n-one\n-two\n-three");
    const argsFor = (fs) => {
      const args = input(fs);
      return { ...args, change: { ...args.change, files: [{ path: "a.py", status }], coverage: new Map(), deletionPoints: new Map([["a.py", [{ after: 0, lines: 3, anchors: [1] }]]]) }, lineCount: () => empty ? 0 : null };
    };
    const { run } = savedRun([[]], { savedBrief, argsFor, inventory: empty ? [{ path: "a.py", lines: 0 }] : null });
    write(join(run, "samples", "division", "claude-graph-off", "1", "report", "submission.json"), submission([f({ line_number: 1 })]));
    if (empty) {
      expect(checkSubmission(argsFor([f({ line_number: 1 })])).ok).toBe(false);
      expect(() => replayRun(run)).toThrow(/has 0 lines/);
    } else {
      expect(checkSubmission(argsFor([f({ line_number: 1 })])).ok).toBe(true);
      expect(replayRun(run).rows[0].findings).toBe(1);
      expect(replayRun(run).unresolved).toHaveLength(0);
    }
  }
});

it("a replay changes a saved run", () => {
  const { root, run } = savedRun([[f({ severity: "nitpick" }), f({ severity: "info", category: "maintainability", title: "Missing tests" })], [f()]]);
  const before = hashFolder(run);
  for (const mode of ["threshold", "union", "floor"]) {
    const out = join(root, `${mode}.md`);
    const result = spawnSync(process.execPath, [cli, mode, run, "--out", out], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(result.stdout);
  }
  const threshold = replayRun(run, { mode: "threshold" }).rows[0];
  expect(threshold.addedHits).toBe(1);
  expect(threshold.addedTestRequests).toBe(1);
  // Reject a normal path, a parent symlink, and an alias of a saved file.
  symlinkSync(run, join(root, "alias"));
  symlinkSync(join(run, "manifest.json"), join(root, "saved.json"));
  for (const out of [join(run, "replay.md"), join(root, "alias", "replay.md"), join(root, "saved.json")]) {
    const result = spawnSync(process.execPath, [cli, "threshold", run, "--out", out], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("run folder");
  }
  expect(hashFolder(run)).toEqual(before);
});

it("the union counts one bug found in two repeats twice", () => {
  // Two titles about one truth item survive product dedup, but recall is one.
  const { run } = savedRun([[f()], [f(), f({ title: "Zero divisor crashes" })]]);
  const row = replayRun(run, { mode: "union" }).rows[0];
  expect(row.beforeHits).toBe(1);
  expect(row.hits).toBe(1);
  expect(row.of).toBe(1);
  expect(row.findings).toBe(2);
  const single = savedRun([[f()]]);
  expect(replayRun(single.run, { mode: "union" }).rows[0].status).toBe("insufficient repeats");
});

it("a saved submission rejected by core is scored as a successful replay", () => {
  const { run } = savedRun([[f()]]);
  write(join(run, "samples", "division", "claude-graph-off", "1", "report", "submission.json"), submission([f({ line_number: 1 })]));
  expect(() => replayRun(run, { mode: "threshold" })).toThrow(/not a line this change/);
});

// Issue 276: one incomplete review out of several must not stop the whole replay.
it("skips an incomplete review instead of stopping the whole replay", () => {
  const { run } = savedRun([[f()], [f()]]);
  const dir = join(run, "samples", "division", "claude-graph-off", "2", "report");
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  write(join(dir, "report.json"), { ...report, completion: { status: "incomplete" } });
  const replay = replayRun(run, { mode: "threshold" });
  expect(replay.rows[0].samples).toBe(1);
  expect(replay.skipped).toHaveLength(1);
  expect(replay.skipped[0]).toMatchObject({ case: "division", config: "claude-graph-off", repeat: 2 });
  expect(replay.skipped[0].reason).toContain("not complete");
  const result = spawnSync(process.execPath, [cli, "threshold", run], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("replay: skipping 1 incomplete review");
  expect(result.stdout).toContain("Skipped: 1 incomplete review.");
});

it("--floors replaces the default 0.6-0.9 sweep with the given floors", () => {
  const { run } = savedRun([[f()]]);
  expect(replayRun(run, { mode: "floor" }).rows.map((r) => r.floor)).toEqual([0.6, 0.7, 0.8, 0.9]);
  expect(replayRun(run, { mode: "floor", floors: [0.5] }).rows.map((r) => r.floor)).toEqual([0.5]);
  const result = spawnSync(process.execPath, [cli, "floor", run, "--floors", "0.5"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("| 0.5 |");
  for (const kept of ["0.6", "0.7", "0.8", "0.9"]) expect(result.stdout).not.toContain(`| ${kept} |`);
  const bad = spawnSync(process.execPath, [cli, "floor", run, "--floors", "1.5"], { encoding: "utf8" });
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain("--floors takes comma-separated numbers from 0 to 1");
});
