#!/usr/bin/env node
// Replays saved submissions with the product's checks, with no reviewer:
//   node benchmark/loop/replay.mjs threshold|union|floor <run> [--specs <folder>]
//                                 [<run> [--specs <folder>]]... [--out <file>] [--floors <list>]
// Threshold shows info at the product's confidence floor. Union merges
// repeats 1 and 2 per case and configuration. Floor sweeps 0.6 to 0.9,
// or --floors 0.5,0.6,... (comma-separated, 0 to 1) in their place.
// Counts use the planted matching diagnostic in lib/score.mjs, without
// adjudication. --specs follows its run; otherwise its own cases are used.
// A saved review that is not complete is skipped (one line to stderr, a
// count in the summary) rather than stopping the whole replay.
// Saved runs are read only. Exit 0 printed, 2 invalid input or output path.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSubmission, DEFAULT_CONFIG, GLOBAL_CONFIDENCE_FLOOR, parseDiffCoverage, unquoteDiffPath } from "../../packages/core/dist/index.js";
import { mergeFindings } from "../../packages/review/dist/index.js";
import { fileList, hashFolder, resultsRoot } from "../lib/index.mjs";
import { buildCase, repoRoot } from "../lib/cases.mjs";
import { CLASSES } from "../lib/classes.mjs";
import { groupBy, scoreSample, shownFindings, summarize } from "../lib/score.mjs";
import { loadRun } from "../score.mjs";

// The product owns validation, deduplication, severity visibility and lens
// floors. This wrapper changes only the two settings being replayed.
export function replaySubmission(args, { floor = GLOBAL_CONFIDENCE_FLOOR, threshold = args.config.severityThreshold } = {}) {
  return checkSubmission({ ...args, confidenceFloor: floor, config: { ...args.config, severityThreshold: threshold } });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const inFolder = (folder, path) => {
  const rel = relative(folder, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

// Resolve every link, including dangling links and links in parent folders.
function canonicalPath(path, links = new Set()) {
  const parent = dirname(path);
  if (parent === path) return realpathSync(path);
  const target = join(canonicalPath(parent, links), basename(path));
  let entry;
  try { entry = lstatSync(target); } catch (error) {
    if (error.code === "ENOENT") return target;
    throw error;
  }
  if (!entry.isSymbolicLink()) return target;
  if (links.has(target)) throw new Error(`cannot resolve cyclic symlink ${target}`);
  links.add(target);
  try { return canonicalPath(resolve(dirname(target), readlinkSync(target)), links); }
  finally { links.delete(target); }
}

function checkOutput(path, folders) {
  const target = canonicalPath(resolve(path));
  const saved = folders.map((f) => realpathSync(f));
  for (let folder = dirname(target); ; folder = dirname(folder)) {
    if (existsSync(join(folder, "manifest.json"))) throw new Error(`--out cannot write into a run folder: ${folder}`);
    if (dirname(folder) === folder) break;
  }
  // Protect any saved run under the standard store, including one not being
  // replayed. An existing hard link to an input also aliases its contents.
  const protectedFolder = [canonicalPath(resolve(resultsRoot)), ...saved].find((f) => inFolder(f, target));
  if (protectedFolder) throw new Error(`--out cannot write into a run folder: ${protectedFolder}`);
  if (existsSync(target)) {
    const out = statSync(target);
    for (const folder of saved) for (const file of fileList(folder)) {
      const s = statSync(join(folder, file));
      if (s.dev === out.dev && s.ino === out.ino) throw new Error("--out cannot overwrite a file from a run folder");
    }
  }
  return target;
}

// Adapt the recorded diff to Change, never the current case's source tree.
// core's coverage parser includes context when given a contextual diff, so
// remove those context positions before passing it to checkSubmission.
function savedChange(brief, manifest, report, inventory) {
  const blocks = [...brief.matchAll(/^(`{3,})diff\r?\n([\s\S]*?)^\1[ \t]*\r?$/gm)];
  const diff = blocks.map((m) => m[2]).join("\n");
  const coverage = parseDiffCoverage(diff);
  const section = (name) => brief.split(/^## /m).find((s) => s.startsWith(`${name}\n`) || s.startsWith(`${name}\r\n`)) ?? "";
  // core's diffBlockV2 records coverage for files outside the diff budget
  // as "- path: lines 3-5, 9", before any deletion-only anchor text.
  const omitted = section("Diff").split(/^These files changed but their diff is not in this brief\..*$/m)[1] ?? "";
  for (const m of omitted.matchAll(/^- (.+): lines (\d+(?:-\d+)?(?:, \d+(?:-\d+)?)*)(?:;[^\r\n]*)?\r?$/gm)) {
    const lines = coverage.get(m[1]) ?? new Set();
    for (const range of m[2].split(", ")) {
      const [start, end = start] = range.split("-").map(Number);
      for (let line = start; line <= end; line++) lines.add(line);
    }
    coverage.set(m[1], lines);
  }
  if (blocks.length === 0 && coverage.size === 0) throw new Error("the saved brief has no diff; the change cannot be replayed");
  // report/inventory.json is the product's saved snapshot listing, written
  // by commands/review.ts with buildInventory's exact per-file `lines`.
  // Legacy change reviews did not save lengths. A diff or read range cannot
  // supply them; core permits unknown lengths for changed-line findings.
  const limits = new Map((inventory ?? []).filter((f) => Number.isSafeInteger(f.lines) && f.lines >= 0).map((f) => [f.path, f.lines]));
  let path = null;
  let next = null;
  let left = 0;
  let right = 0;
  for (const line of diff.split("\n")) {
    if (left > 0 || right > 0) {
      if (line.startsWith(" ")) {
        coverage.get(path)?.delete(next);
        next++;
        left--; right--;
      } else if (line.startsWith("+")) {
        next++;
        right--;
      } else if (line.startsWith("-")) left--;
      continue;
    }
    if (line.startsWith("diff --git ")) { path = null; next = null; }
    else if (line.startsWith("+++ ")) {
      const raw = unquoteDiffPath(line.slice(4).replace(/\t$/, ""));
      path = raw === "/dev/null" ? null : raw.replace(/^b\//, "");
    } else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        next = Number(m[3]);
        left = m[2] === undefined ? 1 : Number(m[2]);
        right = m[4] === undefined ? 1 : Number(m[4]);
      }
    }
  }
  // brief.md's Changed files and Deleted lines sections are emitted by
  // core's changedFilesBlock and deletionsBlock. Copy the recorded anchors,
  // including line 1 for emptied/deleted files; never compute new anchors.
  const files = [...section("Changed files").matchAll(/^\| (added|modified|deleted|renamed from .+?)(, binary)? \| (.*?) \|\r?$/gm)].map((m) => ({ path: m[3].replace(/\\\|/g, "|"), status: m[1].startsWith("renamed from ") ? "renamed" : m[1], oldPath: m[1].startsWith("renamed from ") ? m[1].slice(13) : null, binary: Boolean(m[2]) }));
  for (const p of coverage.keys()) if (!files.some((f) => f.path === p)) files.push({ path: p, status: "modified", oldPath: null, binary: false });
  const deletionPoints = new Map();
  for (const line of section("Deleted lines").split(/\r?\n/)) {
    const removed = /^- (\d+) lines? deleted (?:after line (\d+) of|at the top of) (.+) \(cite line (\d+(?: or \d+)*)\)$/.exec(line);
    const deleted = /^- (.+) was deleted \(cite line (\d+(?: or \d+)*)\)$/.exec(line);
    if (!removed && !deleted) continue;
    const file = removed ? removed[3] : deleted[1];
    const points = deletionPoints.get(file) ?? [];
    points.push({ after: removed ? Number(removed[2] ?? 0) : 0, lines: removed ? Number(removed[1]) : 0, anchors: (removed ? removed[4] : deleted[2]).split(" or ").map(Number) });
    deletionPoints.set(file, points);
  }
  const change = { id: manifest.change_id, shortId: manifest.change_id.slice(0, 12), repoRoot: ".", baseRef: report.base?.ref ?? "saved", baseSha: report.base?.sha ?? "saved", files, changedPaths: files.filter((f) => f.status !== "deleted").map((f) => f.path), coverage, deletionPoints, diff, notReviewed: report.not_reviewed_paths ?? [], stats: report.stats };
  return { change, lineCount: (p) => limits.get(p) ?? null };
}

// Rebuild from the supplied specs and the run's pinned source folders, not
// today's lock. Old caseHashes cover spec bytes and source paths/content;
// newer hashes also cover executable modes. Compute both. With no hash,
// the pinned source is the reference. In every case compare built head paths
// and content without modes, so scoring amendments and mode changes cannot
// masquerade as content changes. A mismatch refuses the named case.
function rebuiltLengths(folder, run, name, specsDir) {
  if ((run.manifest.suite ?? "planted") !== "planted") return { reason: "no pull request builder on this branch; clone-cache reconstruction unavailable" };
  const from = specsDir ?? join(folder, "cases");
  const local = join(from, name, "case.json");
  const commit = run.manifest.build?.commit;
  if (!existsSync(local) && !commit) return { reason: "no planted source folders or pinned build commit" };
  // Reject TMPDIR inside any repository, including one with .git as a file.
  const tempBase = realpathSync(tmpdir());
  for (let p = tempBase; ; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) throw new Error(`${name}: temporary folder must be outside any repository`);
    if (dirname(p) === p) break;
  }
  const temp = mkdtempSync(join(tempBase, "oq-replay-case-"));
  try {
    const sourceRoot = join(temp, "source", "benchmark", "cases");
    const caseDir = join(sourceRoot, name);
    mkdirSync(caseDir, { recursive: true });
    const gitBytes = (path) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    const raw = existsSync(local) ? readFileSync(local) : gitBytes(`benchmark/cases/${name}/case.json`);
    const original = JSON.parse(raw);
    const selected = run.specs[name];
    const copy = (path, target) => {
      if (existsSync(local)) cpSync(path, target, { recursive: true });
      else {
        const rel = relative(repoRoot, path).split(sep).join("/");
        const entries = execFileSync("git", ["ls-tree", "-r", "-z", commit, "--", rel], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
        if (!entries.length) throw new Error(`${name}: pinned source folder ${rel} is missing`);
        for (const entry of entries) {
          const [metadata, file] = entry.split("\t");
          if (!metadata.startsWith("100")) throw new Error(`${name}: pinned source ${file} is not a plain file`);
          const dest = join(target, relative(path, join(repoRoot, file)));
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, gitBytes(file), { mode: metadata.startsWith("100755") ? 0o755 : 0o644 });
        }
      }
    };
    const originDir = existsSync(local) ? dirname(local) : join(repoRoot, "benchmark", "cases", name);
    for (const spec of [original, selected]) for (const label of ["base", "change"]) {
      const rel = spec[label] ?? label;
      const target = resolve(caseDir, rel);
      if (!inFolder(join(temp, "source"), target)) throw new Error(`${name}: source folder escapes the temporary snapshot`);
      if (!existsSync(target)) copy(resolve(originDir, rel), target);
    }
    const del = existsSync(local) ? join(originDir, "delete.txt") : `benchmark/cases/${name}/delete.txt`;
    if (existsSync(local)) {
      if (existsSync(del)) cpSync(del, join(caseDir, "delete.txt"));
    } else {
      const entry = execFileSync("git", ["ls-tree", commit, "--", del], { cwd: repoRoot, encoding: "utf8" });
      if (entry.trim()) writeFileSync(join(caseDir, "delete.txt"), gitBytes(del));
    }
    const hashes = [false, true].map((modes) => {
      const h = createHash("sha256").update(raw);
      for (const label of ["base", "change"]) {
        const dir = resolve(caseDir, original[label] ?? label);
        for (const path of fileList(dir).sort()) {
          h.update(`\0${label}/${path}\0`);
          if (modes) h.update(`${statSync(join(dir, path)).mode & 0o100 ? "755" : "644"}\0`);
          h.update(readFileSync(join(dir, path)));
        }
      }
      if (existsSync(join(caseDir, "delete.txt"))) h.update(readFileSync(join(caseDir, "delete.txt")));
      return h.digest("hex");
    });
    // Labels were added after these runs. The builder validates them, but
    // they do not alter the files it builds or the recorded hash above.
    const build = (spec, into) => {
      const labelled = { ...spec, bugs: spec.bugs.map((b) => ({ class: CLASSES[0], tags: [], evidence: [], ...b, mentions: b.mentions ?? [b.id] })), extras: (spec.extras ?? []).map((e) => ({ ...e, mentions: e.mentions ?? [e.why] })) };
      writeFileSync(join(caseDir, "case.json"), JSON.stringify(labelled));
      return buildCase(name, join(temp, into), sourceRoot).dir;
    };
    const headHash = (dir) => hashFolder(dir, fileList(dir).filter((p) => !p.startsWith(".git/"))).listHash;
    const rebuilt = build(selected, "head");
    const sameInputs = ["base", "change", "generated"].every((key) => JSON.stringify(selected[key]) === JSON.stringify(original[key]));
    const reference = sameInputs ? rebuilt : build(original, "reference");
    const expected = headHash(reference);
    const recorded = run.manifest.caseHashes?.[name];
    if (recorded && ![...hashes, expected].includes(recorded)) throw new Error(`${name}: case content differs from the manifest`);
    if (headHash(rebuilt) !== expected) throw new Error(`${name}: case content differs from the supplied specs`);
    // finalize.ts's citesChange and checkSubmission consume these counts.
    // snapshot.ts's lineCounter is not exported: use its byte rule, LF count
    // plus one for a nonempty unterminated last line, at most 5 MiB per file.
    const lengths = new Map();
    for (const path of fileList(rebuilt).filter((p) => !p.startsWith(".git/"))) {
      const bytes = readFileSync(join(rebuilt, path));
      if (bytes.length > 5 * 1024 * 1024) continue;
      let count = 0;
      for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) count++;
      if (bytes.length && bytes.at(-1) !== 10) count++;
      lengths.set(path, count);
    }
    return { lengths };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Thrown by inputsOf for a saved review that is not complete: replayRun
// skips the sample rather than stopping the whole replay on it (issue 276).
class Incomplete extends Error {}

function inputsOf(folder, a, rebuilt) {
  const dir = join(folder, "samples", a.case, a.config, String(a.repeat), "report");
  for (const [name, value] of [["report.json", a.report], ["submission.json", a.submission], ["scan.json", a.scan], ["brief.md", a.brief]]) if (value === null) throw new Error(`${dir}: missing ${name}; cannot replay the product's checks`);
  if (a.report.completion?.status !== "complete") throw new Incomplete(`${dir}: the saved review is not complete`);
  const manifest = readJson(join(dir, "manifest.json"));
  const scan = { ...a.scan, secretFingerprints: a.scan.secretFingerprints ?? [] };
  const settings = { ...DEFAULT_CONFIG, blockOnSeverity: a.report.block_on_severity ?? null };
  const inventoryPath = join(dir, "inventory.json");
  const inventory = existsSync(inventoryPath) ? readJson(inventoryPath) : null;
  const saved = savedChange(a.brief, manifest, a.report, inventory);
  const files = new Set([...saved.change.files.map((f) => f.path), ...(inventory ?? []).map((f) => f.path), ...(scan.selection ?? []).flatMap((s) => s.paths)]);
  return { ...saved, lineCount: (p) => saved.lineCount(p) ?? rebuilt.lengths?.get(p) ?? null, hasFile: (p) => rebuilt.lengths?.has(p) || files.has(p), rebuildReason: rebuilt.reason, manifest, scan, config: settings, submission: a.submission };
}

const counts = (scores) => {
  const s = summarize(scores);
  return { hits: s.recall.hit, of: s.recall.of, false: s.falseFindings, nonHits: s.precision.of - s.precision.hit, testRequests: s.testGaps, findings: scores.reduce((n, s) => n + s.findings.length, 0) };
};

export function replayRun(folder, { mode = "threshold", specsDir = null, floors = [0.6, 0.7, 0.8, 0.9] } = {}) {
  if (!["threshold", "union", "floor"].includes(mode)) throw new Error(`unknown replay ${mode}`);
  if (!Array.isArray(floors) || floors.length === 0 || floors.some((f) => !Number.isFinite(f) || f < 0 || f > 1)) throw new Error("floors must be numbers from 0 to 1");
  const run = loadRun(folder, { specsDir });
  if (run.manifest.mode && run.manifest.mode !== "review") throw new Error("replays need reviewer submissions, not a scanner-only run");
  const firsts = run.attempts.filter((a) => a.attempt === 1);
  const rebuilt = new Map([...new Set(firsts.map((a) => a.case))].map((name) => {
    try { return [name, rebuiltLengths(folder, run, name, specsDir)]; }
    catch (error) {
      if (error.message.includes("content differs") || error.message.includes("temporary folder must")) throw error;
      return [name, { reason: `${name}: reconstruction unavailable: ${error.message}` }];
    }
  }));
  const checked = [];
  const skipped = [];
  for (const a of firsts) {
    try { checked.push({ ...a, args: inputsOf(folder, a, rebuilt.get(a.case)) }); }
    catch (error) {
      if (!(error instanceof Incomplete)) throw error;
      skipped.push({ case: a.case, config: a.config, repeat: a.repeat, reason: error.message });
    }
  }
  if (skipped.length) process.stderr.write(`replay: skipping ${skipped.length} incomplete review${skipped.length === 1 ? "" : "s"}\n`);
  const unresolved = [];
  for (const a of checked) {
    const pending = a.args.submission.findings.filter((f) => !a.args.hasFile(f.file_path) || ((run.manifest.suite ?? "planted") !== "planted" && a.args.lineCount(f.file_path) === null));
    const dropped = a.args.submission.dropped.filter((d) => a.args.lineCount(d.file_path) === null);
    for (const finding of pending) unresolved.push({ case: a.case, config: a.config, repeat: a.repeat, finding, reason: `no saved file length for ${finding.file_path}${a.args.rebuildReason ? `; ${a.args.rebuildReason}` : ""}` });
    for (const disposition of dropped) unresolved.push({ case: a.case, config: a.config, repeat: a.repeat, dropped: disposition, reason: `no saved file length for ${disposition.file_path}${a.args.rebuildReason ? `; ${a.args.rebuildReason}` : ""}` });
    // Both findings and dropped dispositions dispose scanner candidates.
    // Exclude each unresolved disposition and its candidate from the check.
    const candidates = new Set([...pending, ...dropped].map((f) => f.candidate).filter(Boolean));
    a.args = { ...a.args, scan: { ...a.args.scan, candidates: a.args.scan.candidates.filter((c) => !candidates.has(c.id)) }, submission: { ...a.args.submission, findings: a.args.submission.findings.filter((f) => !pending.includes(f)), dropped: a.args.submission.dropped.filter((d) => !dropped.includes(d)) } };
  }
  const reportAt = (a, settings = {}) => {
    const check = replaySubmission(a.args, settings);
    if (!check.ok) throw new Error(`${a.case}/${a.config}/${a.repeat}: core rejected the saved submission:\n${check.errors.join("\n")}`);
    return { ...check.report, completion: a.report.completion };
  };
  const score = (a, report) => scoreSample({ spec: run.specs[a.case], brief: a.brief, row: a.row, report, testOnly: (run.manifest.suite ?? "planted") === "planted" });
  const rows = [];
  for (const config of run.manifest.configs ?? [...groupBy(checked, (a) => a.config).keys()]) {
    const samples = checked.filter((a) => a.config === config);
    if (mode === "union") {
      const pairs = [...groupBy(samples, (a) => a.case).values()].map((as) => [as.find((a) => a.repeat === 1), as.find((a) => a.repeat === 2)]);
      const expectedCases = run.manifest.cases ?? Object.keys(run.specs);
      if (pairs.length !== expectedCases.length || pairs.some(([a, b]) => !a || !b)) {
        rows.push({ config, status: "insufficient repeats" });
        continue;
      }
      const before = [];
      const after = [];
      for (const [a, b] of pairs) {
        const primary = reportAt(a);
        const second = reportAt(b);
        const merged = mergeFindings({ name: "repeat 1", findings: shownFindings(primary) }, { name: "repeat 2", findings: shownFindings(second) });
        before.push(score(a, primary));
        after.push(score(a, { ...primary, findings: merged.findings, outside_change: [] }));
      }
      const base = counts(before);
      const union = counts(after);
      rows.push({ config, status: "replayed", beforeHits: base.hits, beforeNonHits: base.nonHits, ...union });
    } else {
      const planned = (run.manifest.cases?.length ?? Object.keys(run.specs).length) * run.manifest.repeat;
      const configSkipped = skipped.filter((s) => s.config === config).length;
      if (samples.length !== planned - configSkipped) throw new Error(`${config}: ${samples.length} first attempts saved, ${planned} planned, ${configSkipped} skipped as incomplete; cannot replay every submission`);
      const base = counts(samples.map((a) => score(a, reportAt(a))));
      if (mode === "threshold") {
        const info = counts(samples.map((a) => score(a, reportAt(a, { threshold: "info" }))));
        rows.push({ config, samples: samples.length, beforeHits: base.hits, beforeTestRequests: base.testRequests, ...info, addedHits: info.hits - base.hits, addedTestRequests: info.testRequests - base.testRequests });
      } else for (const floor of floors) rows.push({ config, samples: samples.length, floor, ...counts(samples.map((a) => score(a, reportAt(a, { floor })))) });
    }
  }
  return { run: basename(folder), mode, specsFrom: run.specsFrom ?? "the run's own cases/", rows, unresolved, skipped };
}

const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
function render(runs) {
  const out = ["# Saved-run replays", "", "No reviewer calls. Counts use the planted matching diagnostic, without adjudication. False means unlisted under that diagnostic; counted non-hits also include near misses and wrong kinds.", "", "Checks: built core checkSubmission and built review mergeFindings, with saved inventory lengths or verified rebuilt head lengths and core's recorded deletion anchors. Missing lengths stay unresolved when reconstruction is unavailable. Lens floors still apply. Threshold and floor replays use every first attempt; union uses repeats 1 and 2 only.", ""];
  for (const r of runs) {
    out.push(`## ${r.run}: ${r.mode}`, "", `Specs: ${r.specsFrom}.`, "");
    if (r.mode === "threshold") out.push(table(["Configuration", "Samples", "Minor hits", "Info hits", "Added hits", "Minor tests", "Info tests", "Added tests", "False at info", "Counted non-hits at info"], r.rows.map((x) => [x.config, x.samples, `${x.beforeHits}/${x.of}`, `${x.hits}/${x.of}`, x.addedHits, x.beforeTestRequests, x.testRequests, x.addedTestRequests, x.false, x.nonHits])), "");
    else if (r.mode === "union") out.push(table(["Configuration", "Repeat 1 hits", "Union hits", "Repeat 1 non-hits", "Union non-hits", "Union findings", "Status"], r.rows.map((x) => [x.config, x.status === "replayed" ? `${x.beforeHits}/${x.of}` : "n/a", x.status === "replayed" ? `${x.hits}/${x.of}` : "n/a", x.beforeNonHits ?? "n/a", x.nonHits ?? "n/a", x.findings ?? "n/a", x.status])), "");
    else out.push(table(["Configuration", "Samples", "Floor", "Hits", "False", "Counted non-hits", "Test requests"], r.rows.map((x) => [x.config, x.samples, x.floor.toFixed(1), `${x.hits}/${x.of}`, x.false, x.nonHits, x.testRequests])), "");
    out.push(`Unresolved: ${r.unresolved.length} findings and dropped candidates.`, "");
    if (r.unresolved.length > 0) out.push(...r.unresolved.map((u) => `- ${u.case}/${u.config}/${u.repeat}: ${u.finding?.title ?? `dropped ${u.dropped.candidate}`}: ${u.reason}`), "");
    out.push(`Skipped: ${r.skipped.length} incomplete review${r.skipped.length === 1 ? "" : "s"}.`, "");
    if (r.skipped.length > 0) out.push(...r.skipped.map((s) => `- ${s.case}/${s.config}/${s.repeat}: ${s.reason}`), "");
  }
  return out.join("\n");
}

function main(argv) {
  const mode = argv[0];
  const requests = [];
  let out = null;
  let floors = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--specs") {
      if (!requests.length || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--specs takes a folder and follows its run");
      requests.at(-1).specs = argv[++i];
    } else if (a === "--out") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--out takes a file");
      out = argv[++i];
    } else if (a === "--floors") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--floors takes comma-separated numbers from 0 to 1, such as 0.5,0.6,0.7");
      floors = argv[++i].split(",").map(Number);
      if (!floors.length || floors.some((f) => !Number.isFinite(f) || f < 0 || f > 1)) throw new Error("--floors takes comma-separated numbers from 0 to 1, such as 0.5,0.6,0.7");
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else requests.push({ folder: existsSync(a) ? resolve(a) : join(resultsRoot, a), specs: null });
  }
  if (!requests.length || !["threshold", "union", "floor"].includes(mode)) throw new Error("usage: node benchmark/loop/replay.mjs threshold|union|floor <run> [--specs <folder>] [<run> ...] [--out <file>] [--floors <list>]");
  const target = out === null ? null : checkOutput(out, requests.map((r) => r.folder));
  const runs = requests.map((r) => replayRun(r.folder, { mode, specsDir: r.specs === null ? null : existsSync(r.specs) ? resolve(r.specs) : join(r.folder, r.specs), ...(floors === null ? {} : { floors }) }));
  const text = render(runs);
  if (target !== null) writeFileSync(target, text);
  process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`replay: ${e.message}\n`); process.exitCode = 2; }
}
