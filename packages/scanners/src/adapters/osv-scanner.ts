// OSV-Scanner adapter (dependency vulnerabilities). Runs osv-scanner 2's
// `scan source --format json --lockfile <path> ...` against each admitted
// lockfile in the repository and normalizes the vendor JSON into
// StaticFinding[]. This is the only scanner in the ensemble that sees
// known vulnerabilities in third-party dependencies; the others scan
// first-party source, not the dependency graph.
//
// osv-scanner asks osv.dev about the dependency names and versions it reads
// from the lockfile (never the code). Its other lookups are switched off:
// --no-resolve (no transitive resolution through deps.dev for a manifest
// such as pom.xml), --experimental-disable-plugins directory (no file hashes
// sent to identify vendored C and C++ code) and --no-call-analysis all (no
// reachability analysis, which runs the Go and Rust toolchains). Checked
// with osv-scanner 2.6.0 through a proxy: the scan opens api.osv.dev only.
// With OPENQODEX_OFFLINE=1 (set by the CLI for --offline) it is skipped with
// a plain reason instead.
//
// OSV's JSON reports a vulnerability against a (package, version) pair,
// NOT a source line. To anchor each advisory to a real diff line we
// re-read the lockfile and find the first line that mentions the
// package name. That line-mapping is deterministic and mechanical (a
// string scan, no model), and lets filterToChangedLines keep only
// advisories whose lockfile entry the change actually touched (i.e. the
// dependency this change added or bumped).
//
// osv-scanner writes nothing to disk in this mode. All errors are captured
// into the result; the runner never throws on a scanner failure: static
// analysis is additive context, not a gate.

import type { LineSet } from "@openqodex/core";
import fs from "node:fs";
import path from "node:path";
import type {
  AdapterResult,
  DiffCoverage,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, isOffline, runInChunks } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import { RUSTSEC_ID } from "../same-problem.js";
import type { Adapter } from "./index.js";
import { suchAs } from "./words.js";
import { readRepoFile, repoFileOrReason } from "./read.js";

const OSV_TIMEOUT_MS = 90_000;
const OSV_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
// A lockfile bigger than this is not read for line mapping; its advisories
// anchor to line 1.
const LOCKFILE_MAX_BYTES = 50 * 1024 * 1024;
// Tree line numbers are informational. Bound their aggregate text while
// changed lockfiles still get line mapping independently of this budget.
const TREE_LOCKFILE_TEXT_MAX_BYTES = 64 * 1024 * 1024;

export const OSV_OFFLINE_REASON = "offline, dependency lookups are off";

// Known before any tool is resolved, so an offline run never installs or
// starts osv-scanner.
function offlineReason(): string | null {
  return isOffline() ? OSV_OFFLINE_REASON : null;
}

// Lockfile / manifest basenames OSV-Scanner understands.
// Kept as a basename allowlist rather than
// a glob so we don't pass random files to --lockfile and get a parse
// error per file.
//
// NOT package.json, NOT go.sum. osv-scanner has no --lockfile extractor for
// either (checked with osv-scanner 2.6.0), and ONE path it cannot extract
// kills the whole run: the scan exits with an empty stdout and "could not
// determine extractor suitable to this file" on stderr, throwing away every
// package it had just read from the lockfile beside it. A change to
// package.json alone scans nothing; its real dependency change lands in the
// lockfile next to it, as go.sum's lands in go.mod.
const LOCKFILE_BASENAMES = new Set<string>([
  // JavaScript
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  // Python
  "Pipfile.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "pylock.toml",
  // Ruby, PHP, Rust, Go
  "Gemfile.lock",
  "gems.locked",
  "composer.lock",
  "Cargo.lock",
  "go.mod",
  // Java
  "pom.xml",
  "gradle.lockfile",
  "buildscript-gradle.lockfile",
  // .NET (NuGet)
  "packages.lock.json",
  "packages.config",
  // Dart, Elixir, C and C++, R, Haskell
  "pubspec.lock",
  "mix.lock",
  "conan.lock",
  "renv.lock",
  "cabal.project.freeze",
  "stack.yaml.lock",
]);

export type OsvScannerRunArgs = {
  repoDir: string;
  changedPaths: string[];
  treePaths?: string[];
  tool: ResolvedTool | null;
  coverage?: DiffCoverage;
};

// Besides the names above, the ones osv-scanner 2.6.0 matches by pattern:
// a .txt file with "requirements" in its name (requirements-dev.txt), a
// .NET `<app>.deps.json`, and Gradle's gradle/verification-metadata.xml.
function isLockfilePath(p: string): boolean {
  const base = path.basename(p);
  if (LOCKFILE_BASENAMES.has(base)) return true;
  if (base.endsWith(".txt") && base.includes("requirements")) return true;
  if (base.endsWith(".deps.json") && base.length > ".deps.json".length) return true;
  return p === "gradle/verification-metadata.xml" || p.endsWith("/gradle/verification-metadata.xml");
}

// The lookups osv-scanner 2 makes beyond names and versions to osv.dev,
// switched off (see the top of this file).
const LOOKUPS_OFF = ["--no-resolve", "--experimental-disable-plugins", "directory", "--no-call-analysis", "all"];

export async function runOsvScanner(args: OsvScannerRunArgs): Promise<AdapterResult> {
  const lockfiles = args.changedPaths.filter(isLockfilePath).map((p) => path.normalize(p));
  const changed = new Set(lockfiles);
  const tree = (args.treePaths ?? []).filter(isLockfilePath).map((p) => path.normalize(p)).filter((p) => !changed.has(p));
  if (lockfiles.length === 0 && tree.length === 0) return { findings: [], error: null };
  const skipped = offlineReason();
  if (skipped) return { findings: [], error: null, skipped };
  if (!args.tool) return { findings: [], error: "not installed" };

  // Pre-read each lockfile so the parser can map advisories to lines
  // without doing IO per advisory. A read failure for one lockfile just
  // means its advisories anchor to line 1 (still inside the diff if the
  // file was added wholesale); never fatal.
  const lockfileLines = await readLockfileLines(args.repoDir, lockfiles, tree);

  // One process per chunk of lockfiles, so a whole-repo list stays under
  // the argument limit; the findings of every chunk are merged.
  const tool = args.tool;
  const scan = (paths: string[], completed?: StaticFinding[]) =>
    runInChunks("osv-scanner", paths, OSV_TIMEOUT_MS, async (chunk, left) => {
      // Escape only command arguments, so repository identity never depends
      // on the spelling needed to keep a leading dash out of flag parsing.
      const cliArgs = ["scan", "source", "--format", "json", ...LOOKUPS_OFF, ...safeFileArgs(chunk).flatMap((rel) => ["--lockfile", rel])];
      const run = await execTool(tool.path, cliArgs, {
        cwd: args.repoDir,
        timeoutMs: left,
        maxBytes: OSV_OUTPUT_MAX_BYTES,
        env: tool.env,
      });
      // The only failures are the ones that leave no report to read: the
      // binary did not start, the process was killed, or it overflowed.
      const failed = describeFailure("osv-scanner", run, OSV_TIMEOUT_MS);
      if (failed) throw new Error(failed);

      let found: StaticFinding[];
      try {
        found = parseOsvScannerJson(run.stdout, lockfileLines, {
          repoDir: args.repoDir,
          coverage: args.coverage,
        });
      } catch (err) {
        // THE JSON IS THE RESULT, AND ONLY AN UNREADABLE ONE IS A FAILURE.
        // osv-scanner uses its exit code to describe what it found (1 is
        // vulnerabilities found), so the report decides, not the code. When the
        // report will not parse, the exit code is the best clue about why, so
        // it goes in the message when there was a non-zero one.
        const message = err instanceof Error ? err.message : String(err);
        const where = run.exitCode ? `exit ${run.exitCode}, ` : "";
        throw new Error(`parse: ${where}${message.slice(0, 200)}`);
      }

      // A completed scan that printed no report at all, under an exit code
      // that is not one of the two "I ran" codes, did not run. Except 128:
      // osv-scanner 2's "No package sources found", a lockfile that lists no
      // package (a new project's package-lock.json), which has nothing to report.
      if (!run.stdout.trim() && run.exitCode !== null && run.exitCode > 1) {
        if (run.exitCode === 128 && /No package sources found/.test(run.stderr)) return [];
        throw new Error(`osv-scanner exit ${run.exitCode}: ${run.stderr.trim().slice(-300)}`);
      }
      return found;
    }, completed);
  const completed: StaticFinding[] = [];
  const [changedResult, treeError] = await Promise.all([
    scan(lockfiles).then(
      (findings) => ({ findings, error: null }),
      (err: unknown): { findings: StaticFinding[]; error: string } => ({ findings: [], error: errorMessage(err) }),
    ),
    scan(tree, completed).then(
      () => null,
      (err: unknown) => `Repository lockfiles: ${errorMessage(err)}`,
    ),
  ]);
  const findings = changedResult.findings.concat(completed);
  if (changedResult.error) return { findings, error: [changedResult.error, treeError].filter(Boolean).join("; ") };
  return treeError && lockfiles.length > 0 ? { findings, error: null, note: treeError } : { findings, error: treeError };
}

// Register identity before any reads. Failed and budget-skipped reads still
// have exact keys, so a nested lockfile cannot inherit a sibling's lines.
// The optional limits let tests exercise real file reads with small files.
export async function readLockfileLines(
  repoDir: string,
  changedPaths: string[],
  treePaths: string[],
  limits: { fileBytes?: number; treeBytes?: number } = {},
): Promise<Map<string, string[]>> {
  const lines = new Map<string, string[]>([...changedPaths, ...treePaths].map((rel) => [path.normalize(rel), []]));
  const maxBytes = limits.fileBytes ?? LOCKFILE_MAX_BYTES;
  for (const rel of changedPaths) {
    try {
      lines.set(path.normalize(rel), (await readRepoFile(repoDir, rel, maxBytes)).split("\n"));
    } catch {
      // An unreadable changed lockfile anchors to line 1.
    }
  }
  let remaining = limits.treeBytes ?? TREE_LOCKFILE_TEXT_MAX_BYTES;
  for (const rel of treePaths) {
    if (remaining <= 0) break;
    try {
      const checked = await repoFileOrReason(repoDir, rel, maxBytes);
      if ("reason" in checked) continue;
      if (checked.size > remaining) break;
      const content = await readRepoFile(repoDir, rel, Math.min(maxBytes, remaining));
      remaining -= Buffer.byteLength(content, "utf8");
      lines.set(path.normalize(rel), content.split("\n"));
    } catch {
      // An unreadable tree lockfile stays informational at line 1.
    }
  }
  return lines;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export const osvScanner: Adapter = {
  source: "osv-scanner",
  tree: true,
  files: (changedPaths) => changedPaths.filter(isLockfilePath),
  why: (files) => `lockfiles in the repository, ${suchAs(files)}`,
  skip: offlineReason,
  run: (args) => runOsvScanner(args),
};

type OsvSeverityEntry = { type?: unknown; score?: unknown };
type OsvVulnerability = {
  id?: unknown;
  summary?: unknown;
  details?: unknown;
  aliases?: unknown;
  severity?: unknown;
  affected?: unknown;
  database_specific?: { severity?: unknown };
};
type OsvGroup = { ids?: unknown; aliases?: unknown; max_severity?: unknown };
type OsvPackageEntry = {
  package?: { name?: unknown; version?: unknown; ecosystem?: unknown };
  vulnerabilities?: unknown;
  groups?: unknown;
};
type OsvResultEntry = {
  source?: { path?: unknown };
  packages?: unknown;
};

export function parseOsvScannerJson(
  json: string,
  lockfileLines: Map<string, string[]>,
  opts: { repoDir?: string; coverage?: DiffCoverage } = {},
): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: StaticFinding[] = [];
  for (const result of parsed.results as OsvResultEntry[]) {
    if (!result || typeof result !== "object") continue;
    const sourcePath = typeof result.source?.path === "string" ? result.source.path : "";
    const relPath = relativeLockfilePath(sourcePath, lockfileLines, opts.repoDir);
    const lines = lockfileLines.get(relPath) ?? null;
    if (!Array.isArray(result.packages)) continue;
    for (const pkg of result.packages as OsvPackageEntry[]) {
      if (!pkg || typeof pkg !== "object") continue;
      const pkgName = typeof pkg.package?.name === "string" ? pkg.package.name : "";
      const pkgVersion =
        typeof pkg.package?.version === "string" ? pkg.package.version : "";
      const range = entryRangeForPackage(lines, pkgName, pkgVersion, opts.coverage?.get(relPath));
      const maxSeverityByVulnId = groupSeverityById(pkg.groups);
      const leaderOf = groupLeaders(pkg.groups);
      if (!Array.isArray(pkg.vulnerabilities)) continue;
      for (const vuln of pkg.vulnerabilities as OsvVulnerability[]) {
        if (!vuln || typeof vuln !== "object") continue;
        const id = typeof vuln.id === "string" ? vuln.id : "";
        if (!id) continue;
        // osv-scanner groups advisories that alias one another (two GHSA
        // ids for one CVE): one finding per group, under its leader.
        const leader = leaderOf.get(id);
        if (leader !== undefined && leader !== id) continue;
        const severity = severityForVuln(vuln, maxSeverityByVulnId.get(id));
        const fixedIn = fixedVersions(vuln.affected, pkgName, pkg.package?.ecosystem);
        out.push({
          source: "osv-scanner",
          ruleId: id,
          filePath: relPath || sourcePath,
          lineStart: range.start,
          lineEnd: range.end,
          severity,
          message: vulnMessage(pkgName, pkgVersion, vuln, fixedIn),
          fixedIn,
          reference: id.startsWith("CVE-")
            ? `https://nvd.nist.gov/vuln/detail/${id}`
            : `https://osv.dev/vulnerability/${id}`,
        });
      }
    }
  }
  return out;
}

// OSV prints the lockfile path it was given, often made absolute. Rebase it
// onto the repo root (under either spelling of a symlinked root) and look it
// up exactly, so `service/package-lock.json` never takes the root lockfile's
// path. Without a repo root, the longest key that ends the path at a folder
// boundary wins. Falls back to the raw path if nothing matches.
function relativeLockfilePath(
  sourcePath: string,
  lockfileLines: Map<string, string[]>,
  repoDir?: string,
): string {
  if (lockfileLines.has(sourcePath)) return sourcePath;
  if (repoDir && path.isAbsolute(sourcePath)) {
    const roots = [repoDir];
    try {
      roots.push(fs.realpathSync(repoDir));
    } catch {
      // The plain spelling is enough.
    }
    for (const root of roots) {
      const rel = path.relative(root, sourcePath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && lockfileLines.has(rel)) return rel;
    }
  }
  if (!path.isAbsolute(sourcePath) && lockfileLines.has(path.normalize(sourcePath))) {
    return path.normalize(sourcePath);
  }
  let best: string | null = null;
  for (const key of lockfileLines.keys()) {
    const boundary = sourcePath.length === key.length || sourcePath[sourcePath.length - key.length - 1] === "/";
    if (sourcePath.endsWith(key) && boundary && (!best || key.length > best.length)) best = key;
  }
  return best ?? sourcePath;
}

// Lockfile range for a package's entry: from the line that names the
// package through the line carrying its flagged version. Anchoring to a
// RANGE (not just the name line) is what lets the changed-line filter
// keep advisories for BUMPED dependencies: on a version bump the
// name/key line is unchanged while the version/integrity lines change.
//
// A package can match in several places: a top-level declaration
// (`"lodash": "^4.17.20"`, unchanged by a lockfile refresh) and the resolved
// entry that carries the version. Every place where the name has the version
// nearby is a candidate; the first one that touches a changed line wins, so
// the advisory stays on the entry the change actually moved. Without changed
// lines the first candidate wins. Falls back to a small window from the
// first name line when the version is not found verbatim (hashed lockfiles),
// and to line 1 when content is unavailable (a wholesale-added file still
// overlaps).
function entryRangeForPackage(
  lines: string[] | null,
  pkgName: string,
  pkgVersion: string,
  changed?: LineSet,
): { start: number; end: number } {
  if (!lines || !pkgName) return { start: 1, end: 1 };
  const name = pkgName.toLowerCase();
  const ver = pkgVersion ? pkgVersion.toLowerCase() : "";
  let firstNameLine = -1;
  const candidates: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(name)) continue;
    if (firstNameLine === -1) firstNameLine = i;
    if (ver) {
      const windowEnd = Math.min(lines.length, i + 9);
      for (let j = i; j < windowEnd; j++) {
        if (lines[j].toLowerCase().includes(ver)) {
          candidates.push({ start: i + 1, end: j + 1 });
          break;
        }
      }
    }
  }
  if (candidates.length > 0) {
    const touched = changed
      ? candidates.find((c) => changed.overlaps(c.start, c.end))
      : undefined;
    return touched ?? candidates[0];
  }
  if (firstNameLine === -1) return { start: 1, end: 1 };
  return {
    start: firstNameLine + 1,
    end: Math.min(lines.length, firstNameLine + 1 + 6),
  };
}

// Build vulnId -> max CVSS severity label from the package's groups
// array. OSV groups aliased advisories and exposes max_severity (a CVSS
// base score string) per group. Used as a fallback when an individual
// vulnerability has no severity array of its own.
function groupSeverityById(groups: unknown): Map<string, StaticFindingSeverity> {
  const map = new Map<string, StaticFindingSeverity>();
  if (!Array.isArray(groups)) return map;
  for (const g of groups as OsvGroup[]) {
    if (!g || typeof g !== "object") continue;
    const score = typeof g.max_severity === "string" ? parseFloat(g.max_severity) : NaN;
    const sev = cvssScoreToSeverity(score);
    if (!Array.isArray(g.ids)) continue;
    for (const id of g.ids) {
      if (typeof id === "string") map.set(id, sev);
    }
  }
  return map;
}

// For each advisory id in a group, the group's RustSec id when it holds one,
// otherwise its first id. cargo-deny names a Rust advisory by its RustSec id,
// so the two scanners' findings of one advisory share a name and merge
// (same-problem.ts) whatever order osv.dev lists the group's ids in.
function groupLeaders(groups: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(groups)) return map;
  for (const g of groups as OsvGroup[]) {
    if (!g || typeof g !== "object" || !Array.isArray(g.ids)) continue;
    const ids = (g.ids as unknown[]).filter((x): x is string => typeof x === "string");
    const leader = ids.find((id) => RUSTSEC_ID.test(id)) ?? ids[0]!;
    for (const id of ids) map.set(id, leader);
  }
  return map;
}

function severityForVuln(
  vuln: OsvVulnerability,
  groupSeverity: StaticFindingSeverity | undefined,
): StaticFindingSeverity {
  // Prefer a CVSS vector score on the vuln itself.
  if (Array.isArray(vuln.severity)) {
    for (const s of vuln.severity as OsvSeverityEntry[]) {
      if (!s || typeof s !== "object") continue;
      const score = cvssVectorScore(s.score);
      if (score !== null) return cvssScoreToSeverity(score);
    }
  }
  // Then a database_specific qualitative label (GHSA uses these).
  const dbSev = vuln.database_specific?.severity;
  if (typeof dbSev === "string") {
    const mapped = qualitativeToSeverity(dbSev);
    if (mapped) return mapped;
  }
  // Then the group's max CVSS score.
  if (groupSeverity) return groupSeverity;
  // No severity data at all: a known CVE in a dependency is worth a look.
  return "high";
}

// OSV CVSS scores arrive as vector strings (e.g.
// "CVSS:3.1/AV:N/AC:L/...") whose base score isn't a bare number, OR as
// a plain numeric string. We only trust a bare numeric score here; a
// full vector requires a CVSS calculator we don't bundle, so those fall
// through to database_specific / group severity.
function cvssVectorScore(score: unknown): number | null {
  if (typeof score !== "string") return null;
  const n = parseFloat(score);
  if (Number.isFinite(n) && !score.includes("/")) return n;
  return null;
}

function cvssScoreToSeverity(score: number): StaticFindingSeverity {
  if (!Number.isFinite(score)) return "high";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "info";
}

function qualitativeToSeverity(raw: string): StaticFindingSeverity | null {
  const v = raw.trim().toUpperCase();
  if (v === "CRITICAL") return "critical";
  if (v === "HIGH") return "high";
  if (v === "MODERATE" || v === "MEDIUM") return "medium";
  if (v === "LOW") return "low";
  return null;
}

function fixedVersions(affected: unknown, name: string, ecosystem: unknown): string[] {
  if (!Array.isArray(affected) || typeof ecosystem !== "string") return [];
  const fixed: string[] = [];
  for (const entry of affected) {
    if (!entry || entry.package?.name !== name || typeof entry.package?.ecosystem !== "string") continue;
    if (entry.package.ecosystem.split(":")[0] !== ecosystem.split(":")[0]) continue;
    if (!Array.isArray(entry.ranges)) continue;
    for (const range of entry.ranges) {
      if (!Array.isArray(range?.events)) continue;
      for (const event of range.events) {
        if (typeof event?.fixed === "string" && event.fixed && !fixed.includes(event.fixed)) fixed.push(event.fixed);
      }
    }
  }
  return fixed;
}

function vulnMessage(pkgName: string, pkgVersion: string, vuln: OsvVulnerability, fixedIn: string[]): string {
  const id = typeof vuln.id === "string" ? vuln.id : "advisory";
  const aliases = Array.isArray(vuln.aliases)
    ? (vuln.aliases as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const aliasStr = aliases.length > 0 ? ` (${aliases.slice(0, 3).join(", ")})` : "";
  const summary =
    typeof vuln.summary === "string" && vuln.summary.trim()
      ? vuln.summary
      : typeof vuln.details === "string"
        ? vuln.details
        : "Known vulnerability";
  const where = pkgVersion ? `${pkgName}@${pkgVersion}` : pkgName || "dependency";
  const suffix = fixedIn.length > 0 ? `. Fixed in ${fixedIn.join(", ")}` : ". No fixed version published";
  return trimMessage(`${where}: ${id}${aliasStr}. ${summary}`, Math.max(0, 500 - suffix.length)) + suffix;
}

function trimMessage(m: string, limit: number): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, Math.max(0, limit - 3)) + "..." : collapsed;
}
