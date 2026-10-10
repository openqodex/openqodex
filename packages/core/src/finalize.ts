// Turns what the agent wrote into a report, with no model. Every check
// either passes or throws OpenQodexError naming what is wrong; a finding is
// never repaired, so the agent fixes its file and runs finalize again.
//
// The config hash in the manifest (RunManifest.config_hash) is compared by
// the caller, which owns the hashing; this module checks everything else
// the manifest binds: the change id and the lenses the brief selected.
import { z } from "zod";
import { matchesGlob } from "./glob.js";
import { redactByFingerprint } from "./redact.js";
import { atOrAbove, severityRank } from "./severity.js";
import type {
  AgentFinding,
  AgentSubmission,
  Candidate,
  Category,
  Change,
  Config,
  Report,
  ReportFinding,
  RunManifest,
  ScannerSource,
  ScanResult,
  Severity,
  Verdict,
} from "./types.js";
import { OpenQodexError } from "./types.js";

// The lowest confidence a finding may have unless the caller sets its own
// floor (checkSubmission's confidenceFloor); a lens's higher floor still wins.
export const GLOBAL_CONFIDENCE_FLOOR = 0.7;

const severity = z.enum(["critical", "major", "minor", "nitpick", "info"]);
const category = z.enum(["bug", "security", "performance", "maintainability", "style"]);

const findingSchema = z.object({
  severity,
  category,
  confidence: z.number().min(0).max(1),
  file_path: z.string().min(1),
  line_number: z.number().int().min(1),
  line_end: z.number().int().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  suggested_change: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  candidate: z.string().nullable().optional(),
});

const submissionSchema = z.object({
  version: z.literal(1),
  change_id: z.string().min(1),
  summary: z.string(),
  findings: z.array(findingSchema),
  dropped: z.array(z.object({ candidate: z.string().min(1), reason: z.string().min(1) })).optional(),
  reviewer: z.enum(["subagent", "same-agent"]).optional(),
});

// The first line of the report's summary says who reviewed, so a review by
// the agent that wrote the code is never silent.
const REVIEWER_LINE = {
  subagent: "Reviewed by a separate subagent.",
  "same-agent": "Reviewed by the coding agent you are using.",
} as const;

// The manifest version `review` writes now. From 2 on, a submission must say
// who reviewed; a run briefed before that may leave it out. From 3 on, the
// manifest names the openqodex version that wrote the brief.
export const MANIFEST_VERSION = 3;

const REVIEWER_UNRECORDED = "The reviewer was not recorded: this run was briefed before openqodex asked for it.";

function summaryWithReviewer(sub: AgentSubmission): string {
  return `${sub.reviewer === undefined ? REVIEWER_UNRECORDED : REVIEWER_LINE[sub.reviewer]}\n${sub.summary}`;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${String(part)}` : String(part);
  }
  return out || "the top level";
}

function parseSubmission(submission: unknown): AgentSubmission {
  const parsed = submissionSchema.safeParse(submission);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? formatPath(issue.path) : "the top level";
    throw new OpenQodexError(`agent findings are invalid at ${where}: ${issue?.message ?? "invalid"}`);
  }
  const value = parsed.data;
  value.findings.forEach((f, i) => {
    if (f.line_end !== undefined && f.line_end < f.line_number) {
      throw new OpenQodexError(`agent findings are invalid at findings[${i}].line_end: it is before line_number`);
    }
  });
  return {
    ...value,
    findings: value.findings.map((f) => ({
      ...f,
      suggested_change: f.suggested_change ?? null,
      source: f.source ?? null,
    })),
  };
}

function sameChange(id: string, change: Change): boolean {
  return id === change.id || id === change.shortId;
}

const STALE = "the change moved since the brief; run openqodex review again";

// Citation checks, in order, for every finding and every dropped entry.
// `clean` redacts by fingerprint: every fragment of the agent's text that
// goes into an error message passes through it first.
function checkCitations(
  sub: AgentSubmission,
  scan: ScanResult,
  manifest: RunManifest,
  clean: (text: string) => string,
): void {
  const tokens = new Set(scan.candidates.map((c) => c.token));
  const byId = new Map(scan.candidates.map((c) => [c.id, c]));
  const lenses = new Set(manifest.lenses.map((l) => l.name));
  const raisedBy = new Map<string, number>();
  sub.findings.forEach((f, i) => {
    const at = `finding ${i} ("${clean(f.title)}")`;
    const src = f.source;
    if (src !== null) {
      const lensName = src.startsWith("lens:") ? src.slice("lens:".length) : null;
      const ok = tokens.has(src) || (lensName !== null && lenses.has(lensName));
      if (!ok) {
        throw new OpenQodexError(
          `${at} cites source "${clean(src)}", which is neither a scanner token in this scan nor a lens selected for this change; set source to one of those or to null`,
        );
      }
    }
    if (f.candidate !== undefined && f.candidate !== null) {
      const c = byId.get(f.candidate);
      if (!c) throw new OpenQodexError(`${at} raises candidate "${clean(f.candidate)}", which is not in this scan`);
      if (c.token !== src) {
        throw new OpenQodexError(`${at} raises candidate ${c.id}, whose token is "${c.token}", but its source is "${src === null ? "null" : clean(src)}"`);
      }
      raisedBy.set(c.id, i);
    }
  });
  (sub.dropped ?? []).forEach((d, j) => {
    if (!byId.has(d.candidate)) {
      throw new OpenQodexError(`dropped[${j}] names candidate "${clean(d.candidate)}", which is not in this scan`);
    }
    const raised = raisedBy.get(d.candidate);
    if (raised !== undefined) {
      throw new OpenQodexError(`candidate ${d.candidate} is both raised by finding ${raised} and listed in dropped[${j}]`);
    }
  });
}

function disabled(source: string | null, config: Config): boolean {
  return source !== null && config.disabledRules.some((glob) => matchesGlob(source, glob));
}

function touchesChange(f: AgentFinding, change: Change): string | null {
  if (!change.files.some((file) => file.path === f.file_path)) return "the file is not in this change";
  const lines = change.coverage.get(f.file_path);
  const end = f.line_end ?? f.line_number;
  if (lines) {
    for (const n of lines) if (f.line_number <= n && n <= end) return null;
  }
  // A deletion has no line of its own: the lines just above and just below it
  // in the new file, those that exist, stand for it.
  for (const p of change.deletionPoints.get(f.file_path) ?? []) {
    for (const n of p.anchors) if (f.line_number <= n && n <= end) return null;
  }
  const where = end > f.line_number ? `lines ${f.line_number} to ${end} are` : `line ${f.line_number} is`;
  return `${where} not a line this change added or modified`;
}

// The longest range a version 2 finding may cite, first line to last.
const MAX_FINDING_SPAN = 200;

// A version 2 finding's range: it starts on a changed line or a deletion
// anchor, and ends within the file and within MAX_FINDING_SPAN lines of its
// start. Overlapping a changed line is not enough: `1` to `999999` overlaps
// every change. Null when the range is sound.
function citesChange(path: string, start: number, end: number, change: Change, lineCount: (path: string) => number | null): string | null {
  if (!change.files.some((file) => file.path === path)) return "the file is not in this change; cite a changed line, or a line next to a deletion";
  const changed = change.coverage.get(path)?.has(start) || (change.deletionPoints.get(path) ?? []).some((p) => p.anchors.includes(start));
  if (!changed) return `line ${start} of ${path} is not a line this change added or modified; start the range on a changed line, or a line next to a deletion`;
  const count = lineCount(path);
  if (count !== null && end > count) return `line ${end} of ${path} does not exist; it has ${count} lines`;
  const span = end - start + 1;
  if (span > MAX_FINDING_SPAN) return `the range spans ${span} lines; the limit is ${MAX_FINDING_SPAN}, so cite the lines that show the problem`;
  return null;
}

// `review --all`: the whole repository is the change, so a finding is in
// scope when its file is a text file in the inventory and its lines are
// within the file's line count. Anything else is a wrong citation, rejected
// like one, so nothing lands outside the change.
function checkInRepo(sub: AgentSubmission, lines: Map<string, number>, clean: (text: string) => string): void {
  sub.findings.forEach((f, i) => {
    const at = `finding ${i} ("${clean(f.title)}")`;
    const count = lines.get(f.file_path);
    if (count === undefined) {
      throw new OpenQodexError(`${at} names ${clean(f.file_path)}, which is not a text file in this review's inventory`);
    }
    const end = f.line_end ?? f.line_number;
    if (end > count) {
      throw new OpenQodexError(`${at} cites line ${end > f.line_number ? `${f.line_number} to ${end}` : f.line_number} of ${clean(f.file_path)}, which has ${count} lines`);
    }
  });
}

// What makes two findings the same finding, for dedup here and for merging
// two reviewers' findings: the file, the range, the category, and the
// candidate, or the source when no candidate is cited, or the title when
// neither is.
export function findingKey(f: Pick<ReportFinding, "file_path" | "line_number" | "line_end" | "category" | "candidate" | "source" | "title">): string {
  const what = f.candidate ? `candidate\0${f.candidate}` : f.source ? `source\0${f.source}` : `title\0${f.title}`;
  return [f.file_path, f.line_number, f.line_end, f.category, what].join("\0");
}

// Removes only true duplicates: same file, range and category, and the same
// candidate, or the same source when no candidate is cited, or the same title
// when neither is. Keeps the higher severity, then the first.
function dedup(findings: ReportFinding[]): ReportFinding[] {
  const kept = new Map<string, ReportFinding>();
  for (const f of findings) {
    const key = findingKey(f);
    const prev = kept.get(key);
    if (!prev || severityRank(f.severity) > severityRank(prev.severity)) kept.set(key, f);
  }
  return [...kept.values()];
}

// One redaction pass over every string value in a finished report, run after
// the coverage decisions so they still match on the raw paths.
function redactAll<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactAll(v, clean)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAll(v, clean)])) as T;
  }
  return value;
}

// review.severity_threshold: a finding below it is counted, not listed. A
// finding at or above block_on_severity is always listed, whatever the
// threshold, so a blocked verdict always names what blocked it. So is one
// that cites a candidate in `own` (an added suppression comment, a changed
// settings file): the scanner it silences shows nothing there, so hiding
// it too would leave the change with no trace in the report.
function shown(f: ReportFinding, config: Config, own: ReadonlySet<string>): boolean {
  if (f.candidate !== null && own.has(f.candidate)) return true;
  if (atOrAbove(f.severity, config.severityThreshold)) return true;
  return config.blockOnSeverity !== null && atOrAbove(f.severity, config.blockOnSeverity);
}

// The ids of the candidates OpenQodex raises about the change itself.
function ownIds(scan: ScanResult): Set<string> {
  return new Set(scan.candidates.filter(isOwnCandidate).map((c) => c.id));
}

export function verdictFor(threshold: Severity | null, severities: Severity[]): Verdict {
  return threshold && severities.some((s) => atOrAbove(s, threshold)) ? "blocked" : "passed";
}

// The line every output of a legacy review carries: the agent the developer
// works in reviewed the change.
export const SAME_AGENT_REVIEW = "Reviewed by the coding agent you are using.";

export function finalizeReview(args: {
  change: Change;
  scan: ScanResult;
  manifest: RunManifest;
  config: Config;
  submission: unknown;
  // Set when the run reviewed the whole repository (`review --all`): the
  // line count of every text file in its inventory.
  wholeRepo?: { lines: Map<string, number> };
}): Report {
  const { change, scan, manifest, config } = args;
  const sub = parseSubmission(args.submission);
  if (sub.reviewer === undefined && manifest.version >= 2) {
    throw new OpenQodexError('agent findings are invalid at reviewer: say who reviewed, "subagent" or "same-agent"');
  }
  if (!sameChange(sub.change_id, change) || !sameChange(manifest.change_id, change)) {
    throw new OpenQodexError(STALE);
  }
  const clean = (text: string) => redactByFingerprint(text, scan.secretFingerprints);
  checkCitations(sub, scan, manifest, clean);
  if (args.wholeRepo) checkInRepo(sub, args.wholeRepo.lines, clean);
  const floors = new Map(manifest.lenses.map((l) => [l.name, l.confidenceFloor]));

  const findings: ReportFinding[] = [];
  const outside: ReportFinding[] = [];
  const lowConfidence: Report["low_confidence"] = [];
  const raised = new Set<string>();

  for (const f of sub.findings) {
    if (f.candidate) raised.add(f.candidate);
    if (disabled(f.source, config)) continue;
    const lensFloor = f.source?.startsWith("lens:") ? floors.get(f.source.slice("lens:".length)) : undefined;
    const floor = Math.max(GLOBAL_CONFIDENCE_FLOOR, lensFloor ?? 0);
    if (f.confidence < floor) {
      lowConfidence.push({ title: f.title, file_path: f.file_path, confidence: f.confidence, floor });
      continue;
    }
    const outsideReason = args.wholeRepo ? null : touchesChange(f, change);
    const entry: ReportFinding = {
      origin: "agent",
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      file_path: f.file_path,
      line_number: f.line_number,
      line_end: f.line_end ?? f.line_number,
      title: f.title,
      description: f.description,
      suggested_change: f.suggested_change,
      source: f.source,
      candidate: f.candidate ?? null,
      notes: outsideReason ? [outsideReason] : [],
    };
    (outsideReason ? outside : findings).push(entry);
  }

  const droppedIds = new Map((sub.dropped ?? []).map((d) => [d.candidate, d.reason]));
  const live = scan.candidates.filter((c) => !disabled(c.token, config));
  const notReviewed = live.filter((c) => !raised.has(c.id) && !droppedIds.has(c.id));
  const dropped = live
    .filter((c) => droppedIds.has(c.id))
    .map((c) => ({ candidate: c, reason: droppedIds.get(c.id) ?? "" }));

  const deduped = dedup(findings);
  const own = ownIds(scan);
  const kept = deduped.filter((f) => shown(f, config, own));
  const verdict = verdictFor(config.blockOnSeverity, [
    ...kept.map((f) => f.severity),
    ...notReviewed.map((c) => c.reviewSeverity),
  ]);

  const report: Report = {
    version: 1,
    kind: "review",
    reviewed_by: SAME_AGENT_REVIEW,
    impact: null,
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict,
    block_on_severity: config.blockOnSeverity,
    summary: summaryWithReviewer(sub),
    findings: kept,
    below_threshold: deduped.length - kept.length,
    outside_change: outside,
    low_confidence: lowConfidence,
    not_reviewed: notReviewed,
    dropped,
    scanners: scan.scanners,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
  return redactAll(report, clean);
}

// ---------- submission version 2 (`review` with its own reviewer) ----------

const findingV2Schema = z.object({
  severity,
  category,
  confidence: z.number().min(0).max(1),
  file_path: z.string().min(1),
  line_number: z.number().int().min(1),
  line_end: z.number().int().min(1).optional(),
  title: z.string().min(1),
  problem: z.string().min(1),
  consequence: z.string().min(1),
  fix: z.string().min(1),
  suggested_change: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  candidate: z.string().nullable().optional(),
});

const submissionV2Schema = z.object({
  version: z.literal(2),
  change_id: z.string().min(1),
  summary: z.string(),
  findings: z.array(findingV2Schema),
  dropped: z.array(z.object({ candidate: z.string().min(1), reason: z.string().min(1), file_path: z.string().min(1), line_number: z.number().int().min(1) })),
});

export const MAX_SENTENCE_WORDS = 20;
const MAX_SENTENCES = 2;
const EM_DASH = String.fromCharCode(0x2014);
// Every C0 and C1 control character, line breaks and tabs included: a prose
// field is one line of plain text.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

const BUILTIN_SCANNERS = ["semgrep", "gitleaks", "sqllint", "osv-scanner", "actionlint", "hadolint", "shellcheck", "ruff", "brakeman", "rubocop", "bandit", "oxlint", "golangci", "zizmor", "trivy", "squawk", "kube-linter", "tflint", "kubeconform", "cargo-deny", "checkov", "sqlfluff"];

export function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const wordCount = (sentence: string) => sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Scanner names (any case) and rule ids (as written) that may not appear in
// the reviewer's prose: the source has its own line in the report. A rule id
// made of letters only ("expression") is an ordinary word and is not banned;
// its token ("actionlint:expression") still is.
function scannerTerms(scan: ScanResult): { term: string; re: RegExp; what: string }[] {
  const ran = scan.scanners.map((s) => String(s.scanner));
  // A custom scanner is also named without its "custom:" prefix.
  const names = new Set([...BUILTIN_SCANNERS, ...ran, ...ran.filter((n) => n.startsWith("custom:")).map((n) => n.slice("custom:".length))]);
  const bound = (t: string, flags: string) => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(t)}(?=[^A-Za-z0-9_-]|$)`, flags);
  const terms = [...names].filter((n) => n.length >= 3).map((n) => ({ term: n, re: bound(n, "i"), what: "scanner name" }));
  const rules = new Set<string>();
  for (const c of scan.candidates) {
    rules.add(c.token);
    if (/[0-9._/:-]/.test(c.ruleId)) rules.add(c.ruleId);
  }
  for (const r of rules) terms.push({ term: r, re: bound(r, ""), what: "rule id" });
  return terms;
}

// The mechanical style rules of one prose field. `banned` is null for text
// that may name a scanner (a dropped candidate's reason).
function proseErrors(at: string, text: string, banned: ReturnType<typeof scannerTerms> | null, sentenceLimit: number | null): string[] {
  const errors: string[] = [];
  if (text.includes(EM_DASH)) errors.push(`${at}: has an em dash; use a comma, a colon or a full stop`);
  if (CONTROL_CHAR.test(text)) errors.push(`${at}: has a control character or a line break; write one line of plain text`);
  const parts = sentences(text);
  if (sentenceLimit !== null && parts.length > sentenceLimit) errors.push(`${at}: has ${parts.length} sentences; the limit is ${sentenceLimit}`);
  parts.forEach((s, i) => {
    const n = wordCount(s);
    if (n > MAX_SENTENCE_WORDS) errors.push(`${at}: sentence ${i + 1} has ${n} words; the limit is ${MAX_SENTENCE_WORDS}`);
  });
  for (const b of banned ?? []) {
    if (b.re.test(text)) errors.push(`${at}: names the ${b.what} "${b.term}"; describe the problem in your own words, the source is shown on its own line`);
  }
  return errors;
}

// `required`: the candidates that need a disposition (those no disabled rule
// covers); `disposed`: how many of them have exactly one.
export type SubmissionCheck = { ok: true; report: Report; required: number; disposed: number } | { ok: false; errors: string[]; required: number; disposed: number };

// Checks a version 2 submission with no model and returns every rejection at
// once, numbered, so the reviewer can fix them all in one round; or the
// report. `lineCount` gives a file's line count in the snapshot, or null when
// it is not a file there: a dropped candidate's cited line must exist.
export function checkSubmission(args: {
  change: Change;
  scan: ScanResult;
  manifest: RunManifest;
  config: Config;
  submission: unknown;
  lineCount: (path: string) => number | null;
  wholeRepo?: { lines: Map<string, number> };
  // The lowest confidence a finding may have, the same value the brief
  // states (buildReviewerBrief's confidenceFloor); GLOBAL_CONFIDENCE_FLOOR
  // when left out. A lens's higher floor still wins.
  confidenceFloor?: number;
}): SubmissionCheck {
  const { change, scan, manifest, config } = args;
  const clean = (text: string) => redactByFingerprint(text, scan.secretFingerprints);
  const errors: string[] = [];
  const live = scan.candidates.filter((c) => !disabled(c.token, config));
  const done = (disposed: number): SubmissionCheck => ({ ok: false, errors: errors.map((e, i) => `${i + 1}. ${clean(e)}`), required: live.length, disposed });

  const parsed = submissionV2Schema.safeParse(args.submission);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${formatPath(issue.path)}: ${issue.message}`);
    return done(0);
  }
  const sub = parsed.data;
  if (!sameChange(sub.change_id, change)) errors.push(`change_id: "${sub.change_id}" is not this change; use ${change.shortId}`);

  const banned = scannerTerms(scan);
  const tokens = new Set(scan.candidates.map((c) => c.token));
  const byId = new Map(scan.candidates.map((c) => [c.id, c]));
  const lenses = new Set(manifest.lenses.map((l) => l.name));
  const dispositions = new Map<string, number>();
  const dispose = (id: string) => dispositions.set(id, (dispositions.get(id) ?? 0) + 1);

  sub.findings.forEach((f, i) => {
    const at = `findings[${i}] ("${f.title}")`;
    if (f.line_end !== undefined && f.line_end < f.line_number) errors.push(`${at}.line_end: it is before line_number`);
    errors.push(...proseErrors(`${at}.title`, f.title, banned, null));
    for (const field of ["problem", "consequence", "fix"] as const) errors.push(...proseErrors(`${at}.${field}`, f[field], banned, MAX_SENTENCES));
    const src = f.source ?? null;
    if (src !== null && !tokens.has(src) && !(src.startsWith("lens:") && lenses.has(src.slice("lens:".length)))) {
      errors.push(`${at}.source: "${src}" is neither a candidate token in this review nor a listed pattern; use one of those or null`);
    }
    if (f.candidate) {
      const c = byId.get(f.candidate);
      if (!c) errors.push(`${at}.candidate: "${f.candidate}" is not a candidate in this review`);
      else {
        dispose(c.id);
        if (c.token !== src) errors.push(`${at}.source: it raises ${c.id}, so source must be "${c.token}"`);
      }
    }
    if (args.wholeRepo) {
      const count = args.wholeRepo.lines.get(f.file_path);
      const end = f.line_end ?? f.line_number;
      if (count === undefined) errors.push(`${at}.file_path: ${f.file_path} is not a text file in this review`);
      else if (end > count) errors.push(`${at}.line_number: line ${end} of ${f.file_path} does not exist; it has ${count} lines`);
    } else {
      const wrong = citesChange(f.file_path, f.line_number, f.line_end ?? f.line_number, change, args.lineCount);
      if (wrong !== null) errors.push(`${at}: ${wrong}`);
    }
  });

  sub.dropped.forEach((d, j) => {
    const at = `dropped[${j}] (${d.candidate})`;
    if (!byId.has(d.candidate)) errors.push(`${at}: "${d.candidate}" is not a candidate in this review`);
    else dispose(d.candidate);
    errors.push(...proseErrors(`${at}.reason`, d.reason, null, MAX_SENTENCES));
    const count = args.lineCount(d.file_path);
    if (count === null) errors.push(`${at}: ${d.file_path} is not a file in the code under review; cite the line that shows why`);
    else if (d.line_number > count) errors.push(`${at}: it cites line ${d.line_number} of ${d.file_path}, which has ${count} lines`);
  });

  for (const c of live) {
    const n = dispositions.get(c.id) ?? 0;
    if (n === 0) errors.push(`candidate ${c.id} (${c.filePath}:${c.lineStart}) has no disposition: raise it in a finding or add it to dropped with a reason and a line`);
    if (n > 1) errors.push(`candidate ${c.id} has more than one disposition: raise it once or drop it once`);
  }
  const disposed = live.filter((c) => dispositions.get(c.id) === 1).length;
  if (errors.length > 0) return done(disposed);

  const floors = new Map(manifest.lenses.map((l) => [l.name, l.confidenceFloor]));
  const findings: ReportFinding[] = [];
  const lowConfidence: Report["low_confidence"] = [];
  for (const f of sub.findings) {
    const source = f.source ?? null;
    if (disabled(source, config)) continue;
    const lensFloor = source?.startsWith("lens:") ? floors.get(source.slice("lens:".length)) : undefined;
    const floor = Math.max(args.confidenceFloor ?? GLOBAL_CONFIDENCE_FLOOR, lensFloor ?? 0);
    if (f.confidence < floor) {
      lowConfidence.push({ title: f.title, file_path: f.file_path, confidence: f.confidence, floor });
      continue;
    }
    findings.push({
      origin: "agent",
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      file_path: f.file_path,
      line_number: f.line_number,
      line_end: f.line_end ?? f.line_number,
      title: f.title,
      description: `${f.problem} ${f.consequence} ${f.fix}`,
      suggested_change: f.suggested_change ?? null,
      source,
      candidate: f.candidate ?? null,
      notes: [],
      problem: f.problem,
      consequence: f.consequence,
      fix: f.fix,
    });
  }
  const droppedBy = new Map(sub.dropped.map((d) => [d.candidate, d]));
  const deduped = dedup(findings);
  const own = ownIds(scan);
  const kept = deduped.filter((f) => shown(f, config, own));
  const report: Report = {
    version: 1,
    kind: "review",
    impact: null,
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict: verdictFor(config.blockOnSeverity, kept.map((f) => f.severity)),
    block_on_severity: config.blockOnSeverity,
    summary: sub.summary,
    findings: kept,
    below_threshold: deduped.length - kept.length,
    outside_change: [],
    low_confidence: lowConfidence,
    not_reviewed: [],
    dropped: live
      .filter((c) => droppedBy.has(c.id))
      .map((c) => {
        const d = droppedBy.get(c.id)!;
        return { candidate: c, reason: d.reason, cited: { file_path: d.file_path, line_number: d.line_number } };
      }),
    scanners: scan.scanners,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
  return { ok: true, report: redactAll(report, clean), required: live.length, disposed };
}

// What each scanner's findings are about, for a scan-only report.
const SECURITY_SCANNERS = new Set<ScannerSource>(["gitleaks", "semgrep", "bandit", "brakeman", "osv-scanner"]);

export function scannerCategory(source: ScannerSource): Category {
  return SECURITY_SCANNERS.has(source) || source.startsWith("custom:") ? "security" : "maintainability";
}

function candidateFinding(c: Candidate): ReportFinding {
  return {
    origin: "scanner",
    severity: c.reviewSeverity,
    category: scannerCategory(c.source),
    confidence: null,
    file_path: c.filePath,
    line_number: c.lineStart,
    line_end: Math.max(c.lineStart, c.lineEnd),
    title: c.ruleId,
    description: c.message,
    suggested_change: null,
    source: c.token,
    candidate: c.id,
    notes: [],
  };
}

// The rule of the candidate a scanner raises for a changed file it reads as
// its own settings or ignore list.
export const SETTINGS_RULE = "settings-file";

// The rule of the candidate a scanner raises for a suppression comment the
// change adds, such as `# nosec`, which makes that scanner skip the line.
export const SUPPRESSION_RULE = "openqodex.suppression-added";

// True for a candidate OpenQodex raises about the change itself rather than
// a scanner's hit: a changed settings file or an added suppression comment.
// The scanner still obeys either one. In a review the reviewer keeps or drops
// it like any candidate; in a scan nobody can, so it counts as minor.
export function isOwnCandidate(f: { source: ScannerSource; ruleId: string }): boolean {
  return !f.source.startsWith("custom:") && (f.ruleId === SETTINGS_RULE || f.ruleId === SUPPRESSION_RULE);
}

export function scanReport(args: { change: Change; scan: ScanResult; config: Config }): Report {
  const { change, scan, config } = args;
  const clean = (text: string) => redactByFingerprint(text, scan.secretFingerprints);
  const live = scan.candidates
    .filter((c) => !disabled(c.token, config))
    .map((c): ReportFinding => (isOwnCandidate(c) ? { ...candidateFinding(c), severity: "minor" } : candidateFinding(c)));
  const own = ownIds(scan);
  const findings = live.filter((f) => shown(f, config, own));
  const report: Report = {
    version: 1,
    kind: "scan",
    impact: null,
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict: verdictFor(
      config.blockOnSeverity,
      findings.map((f) => f.severity),
    ),
    block_on_severity: config.blockOnSeverity,
    summary: null,
    findings,
    below_threshold: live.length - findings.length,
    outside_change: [],
    low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: scan.scanners,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
  return redactAll(report, clean);
}
