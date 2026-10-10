// Runs the scanner ensemble against the developer's working tree and turns
// what survives into review candidates.
//
// Order of work: the selector (select.ts) decides which builtin scanners
// the change calls for, from the files, the project each file is in and the
// config; the tool is resolved only for those, everything runs in
// parallel, then one pipeline: paths rebased to repo-relative, the
// changed-line filter, the fixture filter, `disabled_rules`, one fixed
// order, cross-scanner dedup, a severity sort, candidate ids. Custom
// scanners join after the builtins through the same pipeline.
//
// Nothing a scanner does can reject this function: a missing tool, a
// failed install, a timeout, bad JSON or a thrown error all become a status
// and a one-line reason in that scanner's summary. Static analysis is
// additive context, never a gate on its own.

import fs from "node:fs";
import path from "node:path";
import {
  fingerprintSecrets,
  isOwnCandidate,
  mapScannerSeverity,
  matchesGlob,
  REDACTED,
  redactSecrets,
  SETTINGS_RULE,
  SUPPRESSION_RULE,
} from "@openqodex/core";
import type {
  AdapterResult,
  BuiltinScanner,
  Candidate,
  Config,
  DiffCoverage,
  ResolveTool,
  ScanResult,
  ScannerRunSummary,
  ScannerSeverity,
  ScannerSource,
  StaticFinding,
} from "@openqodex/core";
import { sameProblemClass } from "./same-problem.js";
import { ADAPTERS, IN_PROCESS, SETTINGS_FILES } from "./adapters/index.js";
import { repoFacts, type RepoFacts } from "./detect.js";
import { DISABLED_REASON, selectScanners, type ScannerChoice } from "./select.js";
import type { SettingsFile } from "./adapters/index.js";
import type { SettingsReader } from "./shared-settings.js";
import { readRepoFile, repoFileOrReason, scannerInputs } from "./adapters/read.js";
import type { Adapter } from "./adapters/index.js";
import { dropFixtureFindings, filterToChangedLines } from "./filter.js";
import { laptopScratch, scratchAt, type Scratch } from "./scratch.js";
import { SEMGREP_MAX_TARGET_BYTES } from "./adapters/semgrep.js";
import { findMarkers, SUPPRESSION_MARKERS } from "./suppression.js";

// A custom scanner prepared by the custom module. `skipped` is set when the
// entry must not run (untrusted, changed since approval); the runner then
// records that summary and never calls `run`. `scratch`: where the run may
// write (scratch.ts); the laptop's places when left out.
export type CustomAdapter = {
  source: ScannerSource;
  skipped: ScannerRunSummary | null;
  wants(changedPaths: string[]): boolean;
  run(args: { repoDir: string; changedPaths: string[]; scratch?: Scratch }): Promise<AdapterResult & { version: string | null }>;
};

export type RunScannersResult = {
  scan: ScanResult;
  // Raw matched secrets, in memory only, for redacting the brief. Never persist.
  secrets: string[];
  // The rules scanners that ran checked, token to files: what lets a review
  // pattern (lens) the rule covers stand down.
  checked: Map<string, Set<string>>;
};

// One scanner's run before the shared pipeline.
// `summary.reason` is the raw text here; it is redacted and cut to one line
// only once every scanner's secrets are known.
type Outcome = {
  summary: ScannerRunSummary;
  findings: StaticFinding[];
  secrets: string[];
  checked?: { token: string; files: string[] }[];
};

export async function runScanners(args: {
  repoDir: string;
  changedPaths: string[];
  // The changed lines. Absent for a whole-repo review: then every finding
  // in a file of `changedPaths` is kept, whatever its line.
  coverage?: DiffCoverage;
  // The base's copy of a file (null when the base has none): what tells
  // whether a change altered what a scanner reads from a shared file such
  // as pyproject.toml.
  baseText?: (path: string) => Promise<string | null>;
  config: Config;
  resolveTool: ResolveTool;
  custom?: CustomAdapter[];
  only?: ScannerSource[];
  skip?: ScannerSource[];
  onProgress?: (line: string) => void;
  // Where the run writes (scratch.ts). Left out, the laptop's places: caches
  // under the OpenQodex home, temporary folders in the system temp folder.
  // Given, for a server run: every folder the run makes or fills is under
  // this one, and every scanner process gets its HOME and TMPDIR there. The
  // caller removes it when the run is done.
  scratchRoot?: string;
}): Promise<RunScannersResult> {
  const selected = (source: ScannerSource): boolean =>
    (!args.only || args.only.includes(source)) && !(args.skip ?? []).includes(source);
  const scratch = args.scratchRoot === undefined ? laptopScratch() : scratchAt(args.scratchRoot);

  // Read once for the whole run: every scanner and the suppression check ask
  // the same questions about the same files.
  const facts = repoFacts(args.repoDir);
  // The changed files a built-in scanner may be handed: no link, nothing
  // outside the repository (adapters/read.ts, isScannerInput). The settings
  // and suppression checks below still read every changed path, through
  // their own checks.
  // A refused file a scanner would have checked is named in its reason.
  const { inputs, refused } = scannerInputs(args.repoDir, args.changedPaths);
  const choices = new Map(
    selectScanners({ repoDir: args.repoDir, paths: inputs, config: args.config, facts }).map((c) => [c.scanner, c]),
  );
  const builtins = ADAPTERS.filter((a) => selected(a.source)).map((adapter) =>
    guard(adapter.source, async () => {
      const outcome = await runBuiltin(adapter, choices.get(adapter.source)!, facts, { ...args, changedPaths: inputs, scratch });
      const held = refused.size === 0 || outcome.summary.status === "disabled" ? [] : adapter.files([...refused.keys()], facts);
      if (held.length === 0) return outcome;
      const named = held.map((p) => `${p}: ${refused.get(p)}`).join("; ");
      return { ...outcome, summary: { ...outcome.summary, reason: outcome.summary.reason ? `${named}; ${outcome.summary.reason}` : named } };
    }),
  );
  const customs = (args.custom ?? [])
    .filter((c) => selected(c.source))
    .map((custom) => guard(custom.source, () => runCustom(custom, { ...args, scratch })));
  const outcomes = await Promise.all([...builtins, ...customs]);

  const secrets = outcomes.flatMap((o) => o.secrets);

  // Adapters do not agree on what a finding's path is relative to, and the
  // changed-line filter matches coverage keys by exact string, so every
  // path is rebased onto the repo root first.
  const inScope = new Set(args.changedPaths);
  const coverage = args.coverage;
  let merged = outcomes.flatMap((o) => {
    const rebased = toRunDirRelative(o.findings, args.repoDir);
    return coverage ? filterToChangedLines(rebased, coverage) : rebased.filter((f) => inScope.has(f.filePath));
  });
  if (coverage) {
    // A changed settings file and an added suppression comment silence their
    // scanner in every later run, so --only and --skip, which pick scanners
    // for this run, keep them. scanners.disable, the repository's choice that
    // the scanner never runs here, leaves them out with it.
    const wanted = (s: BuiltinScanner) => !args.config.disabledScanners.includes(s);
    // concat, not push(...): a spread of many thousands of candidates as
    // arguments overflows the call stack.
    merged = merged.concat(
      await settingsFindings({
        repoDir: args.repoDir,
        changedPaths: args.changedPaths,
        coverage,
        baseText: args.baseText,
        wanted,
      }),
      await suppressionFindings({ repoDir: args.repoDir, changedPaths: args.changedPaths, coverage, wanted, facts }),
    );
  }

  // Fixture, mock and snapshot files hold throwaway data shaped like the
  // real thing; hits there are noise unless the developer asks for them.
  // A changed settings file is never dropped: one in a fixture folder can
  // govern code outside it (a root ruff.toml can `extend` it), so it can hide
  // findings the report shows. A suppression comment goes through the filter
  // like a hit: it only silences findings in its own file, and the filter
  // hides those findings too.
  let postFixture = merged;
  let fixturesDropped = 0;
  if (!args.config.includeFixtures) {
    const settings = new Set(merged.filter((f) => f.ruleId === SETTINGS_RULE && isOwnCandidate(f)));
    const dropped = dropFixtureFindings(merged.filter((f) => !settings.has(f)));
    postFixture = [...dropped.kept, ...settings];
    fixturesDropped = dropped.droppedCount;
  }

  const postRules =
    args.config.disabledRules.length === 0
      ? postFixture
      : postFixture.filter(
          (f) => !args.config.disabledRules.some((glob) => matchesGlob(`${f.source}:${f.ruleId}`, glob)),
        );

  // One fixed order, whatever order the scanners printed in (checkov on
  // Linux prints its framework reports as they finish, issue #89): by
  // scanner in ensemble order (builtins, then custom scanners as configured),
  // then file, line start, line end, rule id and message. The dedup then sees
  // the same input every run, and the stable severity sort after it gives
  // the candidates, and so their ids, the order severity, scanner, file,
  // line start, line end, rule id, message.
  const ensemble = [...ADAPTERS.map((a) => a.source), ...(args.custom ?? []).map((c) => c.source)];
  const ordered = [...postRules].sort(placeOrder(ensemble));
  const mergedInto = new Map<StaticFinding, string[]>();
  const deduped = dedupByRuleClass(ordered, mergedInto);
  deduped.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const candidates: Candidate[] = deduped.map((f, i) => ({
    ...f,
    message: redactCut(f.message, secrets),
    id: `c${i + 1}`,
    token: `${f.source}:${f.ruleId}`,
    reviewSeverity: mapScannerSeverity(f.severity),
    ...(mergedInto.has(f) ? { alsoReportedBy: mergedInto.get(f) } : {}),
  }));

  const kept = new Map<ScannerSource, number>();
  for (const c of candidates) kept.set(c.source, (kept.get(c.source) ?? 0) + 1);
  const scanners = outcomes.map((o) => ({
    ...o.summary,
    keptCount: kept.get(o.summary.scanner) ?? 0,
    reason: o.summary.reason === null ? null : oneLine(redactCut(o.summary.reason, secrets)),
  }));
  args.onProgress?.(stageLine(scanners, candidates.length));

  const checked = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (o.summary.status !== "ran") continue;
    for (const c of o.checked ?? []) checked.set(c.token, new Set([...(checked.get(c.token) ?? []), ...c.files]));
  }

  return {
    scan: {
      candidates,
      scanners,
      fixturesDropped,
      secretFingerprints: fingerprintSecrets(secrets),
      projects: projectsOf(args.changedPaths, facts),
    },
    secrets,
    checked,
  };
}

// The projects the changed files belong to, with their frameworks, for the
// scan record. A file in no project adds nothing.
function projectsOf(paths: string[], facts: RepoFacts): { root: string; frameworks: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const p of paths) {
    const project = facts.project(p);
    if (project && !seen.has(project.root)) seen.set(project.root, project.frameworks);
  }
  return [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([root, frameworks]) => ({ root, frameworks }));
}

const SETTINGS_MAX_BYTES = 1024 * 1024;

// The file as the head has it: null when the change deleted it, undefined
// when it cannot be read (a link, too large, not a regular file).
async function headSettingsText(repoDir: string, filePath: string): Promise<string | null | undefined> {
  try {
    return await readRepoFile(repoDir, filePath, SETTINGS_MAX_BYTES);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

// True when what the scanner reads from this shared file (ruff or SQLFluff
// in pyproject.toml, SQLFluff in setup.cfg, tox.ini or pep8.ini) differs
// between the base and the head, by meaning (shared-settings.ts). It errs
// towards yes: a side that cannot be read, is over the size cap or does not
// parse counts as a change, and with no base to compare against the file
// counts when the head holds the scanner's settings at all.
async function touchesShared(args: SettingsArgs, filePath: string, reader: SettingsReader): Promise<boolean> {
  const read = (text: string | null): string | null => {
    if (text === null) return "";
    if (Buffer.byteLength(text, "utf8") > SETTINGS_MAX_BYTES) return null;
    return reader(text);
  };
  const head = await headSettingsText(args.repoDir, filePath);
  if (head === undefined) return true;
  const after = read(head);
  if (after === null) return true;
  if (args.baseText === undefined) return after !== "";
  const base = await args.baseText(filePath).catch(() => undefined);
  if (base === undefined) return true;
  const before = read(base);
  return before === null || before !== after;
}

type SettingsArgs = {
  repoDir: string;
  changedPaths: string[];
  coverage: DiffCoverage;
  // The file as the base has it, null when the base has none.
  baseText?: (path: string) => Promise<string | null>;
  wanted: (s: BuiltinScanner) => boolean;
};

// One candidate per changed file that a scanner really reads as its settings
// or ignore list, from that scanner, on the file's first changed line, with
// rule `settings-file`. Raised whether or not the scanner ran. A review's
// reviewer clears it or raises it; a scan counts it as minor.
async function settingsFindings(args: SettingsArgs): Promise<StaticFinding[]> {
  const out: StaticFinding[] = [];
  for (const [source, files] of Object.entries(SETTINGS_FILES) as [BuiltinScanner, readonly SettingsFile[]][]) {
    if (!args.wanted(source)) continue;
    for (const filePath of args.changedPaths) {
      const name = filePath.slice(filePath.lastIndexOf("/") + 1);
      const entry = files.find((f) => (f.anyFolder ? f.path === name : f.path === filePath));
      if (entry === undefined) continue;
      if (entry.reader && !(await touchesShared(args, filePath, entry.reader))) continue;
      // A loop, not Math.min(...lines): a file can have more changed lines
      // than a call can take as arguments.
      let line = Infinity;
      for (const n of args.coverage.get(filePath) ?? []) if (n < line) line = n;
      if (line === Infinity) line = 1;
      out.push({
        source,
        ruleId: SETTINGS_RULE,
        filePath,
        lineStart: line,
        lineEnd: line,
        severity: "high",
        message: `This change edits a scanner settings file; findings of ${source} may be hidden by it`,
        reference: null,
      });
    }
  }
  return out;
}

// The largest file read for suppression comments. The scanners with markers
// set no size limit of their own except semgrep, so this is only a memory
// guard, far above any hand-written source file. The readers are linear.
const SUPPRESSION_MAX_BYTES = 64 * 1024 * 1024;

// One candidate per suppression comment on a line the change added, such as
// `# nosec`, from the scanner it silences, with rule SUPPRESSION_RULE. Only
// in a file that scanner checks, and whether or not it ran: the
// scanner obeys the comment, so its own output never shows what it hides.
// The message names the marker and the scanner, never the line, which can
// hold a secret no scanner reported.
async function suppressionFindings(args: {
  repoDir: string;
  changedPaths: string[];
  coverage: DiffCoverage;
  wanted: (s: BuiltinScanner) => boolean;
  facts: RepoFacts;
}): Promise<StaticFinding[]> {
  const out: StaticFinding[] = [];
  for (const filePath of args.changedPaths) {
    const added = args.coverage.get(filePath);
    if (added === undefined || added.size === 0) continue;
    let scanners = ADAPTERS.filter(
      (a) => SUPPRESSION_MARKERS[a.source] !== undefined && args.wanted(a.source) && a.files([filePath], args.facts).length > 0,
    ).map((a) => a.source);
    if (scanners.length === 0) continue;
    let text: string;
    let size: number;
    try {
      const checked = await repoFileOrReason(args.repoDir, filePath, SUPPRESSION_MAX_BYTES);
      if ("reason" in checked) continue;
      size = checked.size;
      text = await readRepoFile(args.repoDir, filePath, SUPPRESSION_MAX_BYTES);
    } catch {
      // Gone, not a regular file in the repo, or over the size cap.
      continue;
    }
    // semgrep skips a file over its own limit, as the adapter runs it. The
    // limit is on the file's bytes, which invalid UTF-8 makes shorter than
    // its decoded text.
    if (size > SEMGREP_MAX_TARGET_BYTES) scanners = scanners.filter((s) => s !== "semgrep");
    for (const hit of findMarkers(text, scanners)) {
      if (!added.has(hit.line)) continue;
      out.push({
        source: hit.scanner,
        ruleId: SUPPRESSION_RULE,
        filePath,
        lineStart: hit.line,
        lineEnd: hit.line,
        severity: "medium",
        message: `This change adds ${hit.name}, which stops ${hit.scanner} reporting what it covers; check that it hides no real problem`,
        reference: null,
      });
    }
  }
  return out;
}

// One builtin scanner, as the selector chose it for this change.
async function runBuiltin(
  adapter: Adapter,
  choice: ScannerChoice,
  facts: RepoFacts,
  args: {
    repoDir: string;
    changedPaths: string[];
    coverage?: DiffCoverage;
    config: Config;
    resolveTool: ResolveTool;
    scratch: Scratch;
  },
): Promise<Outcome> {
  const started = Date.now();
  const source = adapter.source;
  if (choice.skip === DISABLED_REASON) return skippedOutcome(source, "disabled", DISABLED_REASON, started);
  if (choice.paths.length === 0) return skippedOutcome(source, "no_matching_files", null, started);
  if (!choice.wanted) return skippedOutcome(source, "disabled", choice.skip, started);

  let tool = null;
  if (!IN_PROCESS.has(source)) {
    const resolution = await args.resolveTool(source);
    if (!resolution.ok) return skippedOutcome(source, resolution.status, resolution.reason, started);
    // The tool's own environment on the laptop; on a scratch root, the
    // scratch's variables on top and a Go or Cargo tool's caches moved into
    // it (scratch.ts).
    tool = args.scratch.laptop ? resolution.tool : { ...resolution.tool, env: args.scratch.toolEnv(resolution.tool.env) };
  }

  const ranFrom = Date.now();
  const result = await adapter.run({
    repoDir: args.repoDir,
    changedPaths: args.changedPaths,
    tool,
    coverage: args.coverage,
    facts,
    scratch: args.scratch,
  });
  return ranOutcome(source, result, tool?.version ?? null, ranFrom);
}

async function runCustom(
  custom: CustomAdapter,
  args: { repoDir: string; changedPaths: string[]; scratch: Scratch },
): Promise<Outcome> {
  const started = Date.now();
  if (custom.skipped) return { summary: custom.skipped, findings: [], secrets: [] };
  if (!custom.wants(args.changedPaths)) {
    return skippedOutcome(custom.source, "no_matching_files", null, started);
  }
  const result = await custom.run({ repoDir: args.repoDir, changedPaths: args.changedPaths, scratch: args.scratch });
  return ranOutcome(custom.source, result, result.version, started);
}

// A scanner whose run threw is recorded as failed; the throw never escapes.
async function guard(source: ScannerSource, run: () => Promise<Outcome>): Promise<Outcome> {
  const started = Date.now();
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return skippedOutcome(source, "failed", message, started);
  }
}

function skippedOutcome(
  scanner: ScannerSource,
  status: ScannerRunSummary["status"],
  reason: string | null,
  started: number,
): Outcome {
  return {
    summary: { scanner, status, version: null, rawCount: 0, keptCount: 0, durationMs: Date.now() - started, reason },
    findings: [],
    secrets: [],
  };
}

// A scanner that ran. An error with no findings is a failure; an error next
// to findings (one Go module of several failed, one .sql file unreadable)
// keeps the findings and the note. A note (a folder held back) is the reason
// of a scanner that ran. An adapter that chose not to run is disabled, with
// its reason.
function ranOutcome(
  scanner: ScannerSource,
  result: AdapterResult,
  version: string | null,
  started: number,
): Outcome {
  if (result.skipped) return skippedOutcome(scanner, "disabled", result.skipped, started);
  const failed = result.error !== null && result.findings.length === 0;
  return {
    summary: {
      scanner,
      status: failed ? "failed" : "ran",
      version,
      rawCount: result.findings.length,
      keptCount: 0,
      durationMs: Date.now() - started,
      reason: result.error ?? result.note ?? null,
    },
    findings: result.findings,
    secrets: result.secrets ?? [],
    checked: failed ? [] : result.checked,
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

// The scanner stage in one line: how many scanners ran, how many had
// nothing to check, the other states by name, and the candidates the review
// checks. Counts only: a reason can quote tool output.
export function stageLine(scanners: ScannerRunSummary[], candidates: number): string {
  const count = (status: ScannerRunSummary["status"]) => scanners.filter((s) => s.status === status).length;
  const parts = [`${count("ran")} ran`, `${count("no_matching_files")} had nothing to check`];
  for (const status of ["not_installed", "installing", "failed", "disabled", "untrusted"] as const) {
    const n = count(status);
    if (n > 0) parts.push(`${n} ${status.replace(/_/g, " ")}`);
  }
  parts.push(`${candidates} ${candidates === 1 ? "candidate" : "candidates"} to check`);
  return `Scanners: ${parts.join(", ")}`;
}

// The shortest piece of a secret treated as a leak at the edge of cut text.
const MIN_PIECE = 6;

// Redacts every whole secret, then the pieces a cut can leave: text that
// ends (before a trailing "...") with the start of a secret, or begins with
// the end of one. Messages and reasons are cut to a length before they reach
// the runner, and a cut through a secret defeats whole-string redaction.
export function redactCut(text: string, secrets: string[]): string {
  let out = redactSecrets(text, secrets);
  const ellipsis = out.endsWith("...") ? "..." : "";
  let body = out.slice(0, out.length - ellipsis.length);
  for (const secret of secrets) {
    for (let k = Math.min(secret.length - 1, body.length); k >= MIN_PIECE; k--) {
      if (body.endsWith(secret.slice(0, k))) {
        body = body.slice(0, body.length - k) + REDACTED;
        break;
      }
    }
    for (let k = Math.min(secret.length - 1, body.length); k >= MIN_PIECE; k--) {
      if (body.startsWith(secret.slice(secret.length - k))) {
        body = REDACTED + body.slice(k);
        break;
      }
    }
  }
  out = body + ellipsis;
  return out;
}

/**
 * Rewrite each finding's path to be relative to `runDir`, the directory the
 * scanners were actually started in (the repo root).
 *
 * Everything downstream speaks that one frame: the coverage keys and the
 * changed-path list are built in it, and filterToChangedLines matches a
 * finding's path against those keys by EXACT STRING. A path in any other
 * shape is not "slightly off", it is silently dropped.
 *
 * Absolute paths are why this exists. A scanner that resolves a project root
 * reports absolute filenames whatever arguments it was handed (ruff does),
 * and it reports them resolved through symlinks. That second part matters
 * because on macOS /var/folders/... is a symlink to /private/var/folders/...,
 * so a raw prefix comparison against runDir misses. Hence the realpath
 * fallback, computed once and only if some path is absolute.
 *
 * A path that is absolute and outside runDir under both spellings is left
 * alone: there is no honest way to guess where it belongs, and the coverage
 * filter drops it.
 *
 * Exported for unit tests.
 */
export function toRunDirRelative(
  findings: StaticFinding[],
  runDir: string,
): StaticFinding[] {
  let realRunDir: string | null = null;
  const realRunDirOnce = (): string => {
    if (realRunDir === null) {
      try {
        realRunDir = fs.realpathSync(runDir);
      } catch {
        realRunDir = runDir;
      }
    }
    return realRunDir;
  };
  return findings.map((f) => {
    const filePath = rebaseFindingPath(f.filePath, runDir, realRunDirOnce);
    return filePath === f.filePath ? f : { ...f, filePath };
  });
}

function rebaseFindingPath(
  filePath: string,
  runDir: string,
  realRunDirOnce: () => string,
): string {
  if (!filePath) return filePath;
  if (!path.isAbsolute(filePath)) {
    // "./src/a.py" and "src/a.py" name one file to a linter and are two
    // different keys to a Map.
    const normalized = path.normalize(filePath);
    return normalized.startsWith("..") ? filePath : normalized;
  }
  return (
    relativeUnder(runDir, filePath) ??
    relativeUnder(realRunDirOnce(), filePath) ??
    filePath
  );
}

// path.relative, but null rather than a traversal when the target is not
// inside dir.
function relativeUnder(dir: string, absolutePath: string): string | null {
  const rel = path.relative(dir, absolutePath);
  if (!rel || path.isAbsolute(rel)) return null;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return null;
  return rel;
}

const SEVERITY_RANK: Record<ScannerSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function severityRank(s: ScannerSeverity): number {
  return SEVERITY_RANK[s] ?? 0;
}

// Code unit order, the same on every machine (localeCompare is not).
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Scanner (by its place in `ensemble`; one not there after them, by name),
// file, line start, line end, rule id, message.
function placeOrder(ensemble: ScannerSource[]): (a: StaticFinding, b: StaticFinding) => number {
  const place = new Map(ensemble.map((s, i) => [s, i]));
  const rank = (s: ScannerSource) => place.get(s) ?? ensemble.length;
  return (a, b) =>
    rank(a.source) - rank(b.source) ||
    byText(a.source, b.source) ||
    byText(a.filePath, b.filePath) ||
    a.lineStart - b.lineStart ||
    a.lineEnd - b.lineEnd ||
    byText(a.ruleId, b.ruleId) ||
    byText(a.message, b.message);
}

// Coarse category used for cross-scanner dedup. Different rule IDs for
// the same vulnerability class should collapse on the same span; rules
// that don't fit a known class get a class string unique to themselves
// (so they only ever dedup with their own duplicates, never with
// adjacent-but-distinct rules).
//
// gitleaks always classes as "secret": it's a secret scanner, every
// hit is structurally the same class. semgrep classification is
// pattern-based on the rule id; coverage focuses on the categories
// where semgrep overlaps gitleaks (secret) or where multiple semgrep
// rules commonly co-fire on one line (injection, auth).
//
// A candidate OpenQodex raises about the change itself (a changed settings
// file, an added suppression comment) is not a scanner hit: it has a class
// of its own, so a scanner's finding on the same line never swallows it.
//
// Rules of different scanners that name one problem share the class of
// their group in same-problem.ts. The word classes apply only to the
// scanners they were written for (WORD_CLASSED) and to custom scanners: a
// scanner added later merges through same-problem.ts or not at all, since a
// word in its rule id ("env-var-secret", "excessive-permissions") does not
// say it names the problem a secret or access rule of another scanner names.
export function ruleClassFor(f: StaticFinding): string {
  if (isOwnCandidate(f)) return `${f.source}:${f.ruleId}`;
  const same = sameProblemClass(f);
  if (same !== null) return same;
  if (!WORD_CLASSED.has(f.source) && !f.source.startsWith("custom:")) return `${f.source}:${f.ruleId}`;
  if (f.source === "gitleaks") return "secret";
  const id = f.ruleId.toLowerCase();
  if (/secret|credential|api[-_]?key|access[-_]?key|password|token/.test(id)) {
    return "secret";
  }
  if (
    /sql[-_]?injection|command[-_]?injection|xss|path[-_]?traversal|tainted|untrusted[-_]?input/.test(
      id,
    )
  ) {
    return "injection";
  }
  if (/\bauth(?!or)|permission|access[-_]?control|rbac/.test(id)) {
    return "auth";
  }
  // Fall-through: only dedups with itself, never merges with other
  // rule ids. The full rule id is the per-finding fingerprint.
  return `${f.source}:${f.ruleId}`;
}

const WORD_CLASSED: ReadonlySet<string> = new Set<BuiltinScanner>([
  "semgrep",
  "gitleaks",
  "sqllint",
  "osv-scanner",
  "actionlint",
  "hadolint",
  "shellcheck",
  "ruff",
  "brakeman",
  "rubocop",
  "bandit",
  "oxlint",
  "golangci",
]);

// Group by (file, lineStart, lineEnd, ruleClass). The class merge is only
// across scanners: semgrep and gitleaks reporting the same secret on one
// line is one problem, so the scanner with the highest-severity hit keeps
// its findings in the group and the others' are dropped (ties go to the
// first occurrence: semgrep precedes gitleaks in the input order, and its
// rule message is the more descriptive). Two different rules from one
// scanner on one span are two problems and both stay; only an exact repeat
// (same scanner, same rule) collapses, to its highest-severity hit (ties go
// to the first occurrence, which the fixed input order makes the first
// message), so a repeat never lowers a candidate's severity. Findings on
// different lines never merge, even where their spans overlap.
//
// `merged`, when given, receives for each finding kept the tokens
// ("<source>:<ruleId>") of the other scanners' findings merged into it, in
// input order, so the report can say who else reported it.
// Exported for unit tests.
export function dedupByRuleClass(findings: StaticFinding[], merged?: Map<StaticFinding, string[]>): StaticFinding[] {
  const groups = new Map<string, StaticFinding[]>();
  for (const f of findings) {
    const key = `${f.filePath}::${f.lineStart}::${f.lineEnd}::${ruleClassFor(f)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  const emitted = new Set<StaticFinding>();
  for (const bucket of groups.values()) {
    const winner = [...bucket].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    )[0];
    // The winner's scanner keeps one hit per rule: its highest severity.
    const kept = new Map<string, StaticFinding>();
    const others: string[] = [];
    for (const f of bucket) {
      if (f.source !== winner.source) {
        const token = `${f.source}:${f.ruleId}`;
        if (!others.includes(token)) others.push(token);
        continue;
      }
      const held = kept.get(f.ruleId);
      if (!held || severityRank(f.severity) > severityRank(held.severity)) kept.set(f.ruleId, f);
    }
    for (const f of kept.values()) emitted.add(f);
    if (merged && others.length > 0) merged.set(winner, others);
  }
  // Walk the input once so survivors keep their input order.
  return findings.filter((f) => emitted.has(f));
}
