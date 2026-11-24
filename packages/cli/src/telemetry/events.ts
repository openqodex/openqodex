// What the anonymous usage data may hold. Every event is built here and
// checked here, by the command and again by the worker before it sends.
// No property is free text: each is a boolean, a whole number, a word from
// its closed list, a list or map of such words, a version rebuilt from its
// digits, or a model from PUBLIC_MODELS. A value that does not fit is
// dropped or becomes `other`; a property not in its event's table is
// dropped. So a path, a repository or branch name, finding text or a
// private model name has no way into an event.
import { platform as osPlatform, release } from "node:os";
import { OPERATIONS } from "@openqodex/graph";
import { OpenQodexError } from "@openqodex/core";
import type { CompletionRecord, Report, ScannerRunSummary } from "@openqodex/core";
import { failureCode } from "../feedback.js";

// ---------- the closed lists ----------

export const EVENTS = ["install.first_use", "command.completed", "init.completed", "init.first_review", "review.completed", "scan.completed"] as const;
export type EventName = (typeof EVENTS)[number];

// Every command but `mcp`, which never sends.
const COMMANDS = ["init", "review", "update", "trust", "scan", "doctor", "hook", "guide", "findings", "demo", "report", "config", "graph"] as const;

const SUBS: Record<string, readonly string[]> = {
  hook: ["install", "uninstall", "pre-push"],
  review: ["agent", "finalize", "all", "target", "change"],
  update: ["rollback", "off", "on", "status", "now"],
  graph: [...OPERATIONS, "build", "help"],
  config: ["migrate"],
};
const ALL_SUBS = [...new Set(Object.values(SUBS).flat())];

const EXIT_CODES = [0, 1, 2, 130, 143] as const;

const ERROR_CLASSES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "AbortError", "ZodError"] as const;
const ERROR_CODES = ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EEXIST", "ENOTDIR", "EISDIR", "EMFILE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EPIPE"] as const;

// The CLI's own flags, by name only; a value never leaves.
const FLAGS = [
  "--cwd", "--config", "--format", "--output", "--no-color", "--quiet", "--verbose", "--no-install", "--offline",
  "--uncommitted", "--base", "--only", "--skip", "--agent", "--finalize", "--all", "--no-graph", "--run",
  "--reviewer", "--timeout", "--block-on-severity", "--instructions", "--instructions-ref", "--report-dir", "--reviewer-web", "--reviewer-model", "--reviewer-effort",
  "--install", "--all-scanners", "--json", "--require-all",
  "--project", "--hook", "--no-repo", "--no-review", "--mcp", "--no-mcp", "--yes", "-y", "--uninstall", "--dry-run",
  "--now", "--rollback", "--off", "--on", "--status", "--write", "--repo",
  "--send-last", "--list", "--revoke", "--force",
  "--full", "--compact", "--exclude-tests", "--file", "--name", "--tier", "--depth", "--limit", "--cursor", "--generation",
  "--edges", "--level", "--text", "--tokens", "--budget-ms", "--context",
] as const;

const FORMATS = ["terminal", "markdown", "json", "sarif"] as const;

const PLATFORMS = ["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"] as const;
const ARCHES = ["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc64", "riscv64", "s390x", "x64"] as const;

const AGENTS = ["claude-code", "cursor", "codex", "cline", "goose"] as const;

const SEVERITIES = ["critical", "major", "minor", "nitpick", "info"] as const;
const VERDICTS = ["passed", "blocked", "incomplete"] as const;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const GRAPH = ["ok", "partial", "off", "skipped", "failed"] as const;
const FAILURES = ["timeout", "exit", "could_not_start", "output_limit", "killed", "no_report", "unreadable_report", "other"] as const;

// The built-in scanners (BUILTIN in core's config.ts). A custom scanner's
// name never leaves; it is only counted.
const SCANNERS = [
  "semgrep", "gitleaks", "sqllint", "osv-scanner", "actionlint", "hadolint", "shellcheck", "ruff", "brakeman", "rubocop", "bandit",
  "oxlint", "golangci", "zizmor", "trivy", "squawk", "kube-linter", "tflint", "kubeconform", "cargo-deny", "checkov", "sqlfluff",
] as const;

// The public model ids a reviewer can run, one per line, and the aliases
// the config accepts. Read on 2026-11-24 from
// https://platform.claude.com/docs/en/about-claude/models/overview,
// https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
// and https://developers.openai.com/api/docs/models/all. A model not on this
// list, public or private, is sent as `other`; a new public one is added here
// with one line.
export const PUBLIC_MODELS: readonly string[] = [
  // The aliases review.reviewers takes for Claude Code.
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "best",
  "default",
  // Claude.
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  // OpenAI.
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-6-cyber",
  "gpt-5.6-cyber",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5-codex",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "o4-mini",
  "o3",
  "o3-pro",
  "o3-mini",
  "o1",
  "o1-pro",
];

// The values a model property may hold besides a list member.
const MODEL_WORDS = ["other", "default", "unknown", "mixed"] as const;

const PROVIDER_PREFIXES = ["us.anthropic.", "eu.anthropic.", "apac.anthropic.", "global.anthropic.", "anthropic.", "anthropic/", "openai/"];

// A model name as the list knows it, else `other`. Only public decoration
// comes off: one provider prefix from the closed list, then the known
// endings (a bracket suffix such as [1m], -YYYYMMDD, @YYYYMMDD, a Bedrock
// -vN or -vN:N, -latest). What is left must equal a list member in full.
export function canonicalModel(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 200) return "other";
  let m = raw.trim().toLowerCase();
  const prefix = PROVIDER_PREFIXES.find((p) => m.startsWith(p));
  if (prefix !== undefined) m = m.slice(prefix.length);
  m = m.replace(/\[[a-z0-9]{1,16}\]$/, "");
  m = m.replace(/-v\d+(?::\d+)?$/, "");
  m = m.replace(/[-@]\d{8}$/, "");
  m = m.replace(/-latest$/, "");
  return PUBLIC_MODELS.includes(m) ? m : "other";
}

// ---------- the property tables ----------

type Kind =
  | { kind: "boolean" }
  | { kind: "count" }
  | { kind: "exit" }
  | { kind: "word"; list: readonly string[]; other?: true }
  | { kind: "words"; list: readonly string[] }
  | { kind: "map"; keys: readonly string[]; values: "count" | readonly string[] }
  | { kind: "version" }
  | { kind: "model" }
  | { kind: "hash" }
  | { kind: "const"; value: string | boolean };

const B: Kind = { kind: "boolean" };
const N: Kind = { kind: "count" };
const word = (list: readonly string[], other?: true): Kind => ({ kind: "word", list, ...(other ? { other } : {}) });

const COMMON: Record<string, Kind> = {
  installId: { kind: "hash" },
  installAgeDays: N,
  $process_person_profile: { kind: "const", value: false },
  $lib: { kind: "const", value: "openqodex" },
  openqodexVersion: { kind: "version" },
  platform: word(PLATFORMS, true),
  arch: word(ARCHES, true),
  os: word(["macOS", "Linux", "Windows", "other"]),
  osMajor: N,
  nodeMajor: N,
  wsl: B,
  hostAgent: word(["claude", "codex", "cursor", "none"]),
  runner: word(["launcher", "package"]),
  tty: B,
};

const TIMINGS = ["totalMs", "changeMs", "scanMs", "graphMs", "briefMs", "reviewerMs", "finalizeMs"] as const;

const SCANNER_PROPS: Record<string, Kind> = {
  scannersRan: { kind: "words", list: SCANNERS },
  scannersFailed: { kind: "words", list: SCANNERS },
  scannersNotInstalled: { kind: "words", list: SCANNERS },
  scannersInstalling: { kind: "words", list: SCANNERS },
  scannersDisabled: { kind: "words", list: SCANNERS },
  scannerMs: { kind: "map", keys: SCANNERS, values: "count" },
  scannerFailures: { kind: "map", keys: SCANNERS, values: FAILURES },
  customScanners: N,
  customScannersFailed: N,
};

export const TABLES: Record<EventName, Record<string, Kind>> = {
  "install.first_use": {},
  "command.completed": {
    command: word(COMMANDS),
    sub: word(ALL_SUBS),
    exitCode: { kind: "exit" },
    durationMs: N,
    threw: B,
    interrupted: B,
    errorKind: word(["input", "internal"]),
    errorClass: word(ERROR_CLASSES, true),
    errorCode: word(ERROR_CODES, true),
    errorLine: N,
    errorColumn: N,
    flags: { kind: "words", list: FLAGS },
    format: word(FORMATS),
  },
  "init.completed": {
    ended: word(["written", "unchanged", "unconfirmed", "cancelled", "stopped"]),
    agents: { kind: "words", list: AGENTS },
    scope: word(["user", "project"]),
    hook: word(["pre-push", "none"]),
    mcp: B,
    inRepo: B,
    interactive: B,
    exitCode: { kind: "exit" },
  },
  "init.first_review": {
    result: word(["finished", "incomplete", "skipped", "unavailable"]),
    reviewerReady: B,
    skipReason: word(["flag", "no_repo", "no_change", "declined"]),
  },
  "review.completed": {
    mode: word(["reviewer", "agent"]),
    scope: word(["change", "target", "all"]),
    fromInit: B,
    ended: word(["finished", "incomplete", "unavailable", "nothing", "interrupted", "error"]),
    cleanupFailed: B,
    verdict: word(VERDICTS),
    exitCode: { kind: "exit" },
    reviewer: word(["claude", "codex", "cursor", "other"]),
    reviewerVersion: { kind: "version" },
    modelRequested: { kind: "model" },
    modelReported: { kind: "model" },
    effortRequested: word([...EFFORTS, "other", "default"]),
    reviewersPassed: N,
    staged: B,
    web: B,
    sessions: N,
    rounds: N,
    turns: N,
    inputTokens: N,
    outputTokens: N,
    ...Object.fromEntries(TIMINGS.map((t) => [t, N])),
    files: N,
    additions: N,
    deletions: N,
    findings: N,
    possible: N,
    observations: N,
    outsideChange: N,
    belowThreshold: N,
    notReviewed: N,
    dropped: N,
    lowConfidence: N,
    findingsBySeverity: { kind: "map", keys: SEVERITIES, values: "count" },
    findingsByOrigin: { kind: "map", keys: ["agent", "scanner"], values: "count" },
    candidatesTotal: N,
    candidatesDisposed: N,
    hunks: N,
    hunksCovered: N,
    missingCount: N,
    graph: word(GRAPH),
    blockOn: word(SEVERITIES),
    ...SCANNER_PROPS,
  },
  "scan.completed": {
    verdict: word(VERDICTS),
    exitCode: { kind: "exit" },
    nothing: B,
    demo: B,
    totalMs: N,
    changeMs: N,
    scanMs: N,
    files: N,
    additions: N,
    deletions: N,
    candidates: N,
    findings: N,
    ...SCANNER_PROPS,
    reportDir: B,
    blockOnFlag: B,
  },
};

// ---------- checking ----------

const MAX_COUNT = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A version from text that states one: the first word, split on spaces
// only, that is a version on its own: 1.2 or 1.2.3, a v before it and a
// -suffix of letters and digits after it allowed, rebuilt from its three
// numbers. "2.1.289 (Claude Code)" is 2.1.289. Anything else is unknown, so
// digits inside a path or in brackets, such as a user id, never leave.
export function versionOf(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  for (const word of raw.slice(0, 200).split(/\s+/)) {
    const m = /^v?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:-[0-9A-Za-z]+)?$/.exec(word);
    if (m) return [m[1]!, m[2]!, m[3] ?? "0"].map((r) => String(Number(r))).join(".");
  }
  return "unknown";
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

function check(kind: Kind, v: unknown): { keep: boolean; value?: unknown } {
  switch (kind.kind) {
    case "boolean":
      return typeof v === "boolean" ? { keep: true, value: v } : { keep: false };
    case "count":
      return isCount(v) ? { keep: true, value: v } : { keep: false };
    case "exit":
      return (EXIT_CODES as readonly unknown[]).includes(v) ? { keep: true, value: v } : { keep: false };
    case "word":
      if (typeof v === "string" && kind.list.includes(v)) return { keep: true, value: v };
      return kind.other ? { keep: true, value: "other" } : { keep: false };
    case "words": {
      if (!Array.isArray(v)) return { keep: false };
      const kept = [...new Set(v.filter((w): w is string => typeof w === "string" && kind.list.includes(w)))];
      return { keep: true, value: kept };
    }
    case "map": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return { keep: false };
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (!kind.keys.includes(k)) continue;
        if (kind.values === "count" ? isCount(x) : typeof x === "string" && kind.values.includes(x)) out[k] = x;
      }
      return { keep: true, value: out };
    }
    case "version":
      return { keep: true, value: versionOf(v) };
    case "model":
      return { keep: true, value: typeof v === "string" && (MODEL_WORDS as readonly string[]).includes(v) ? v : canonicalModel(v) };
    case "hash":
      return typeof v === "string" && HEX64.test(v) ? { keep: true, value: v } : { keep: false };
    case "const":
      return { keep: true, value: kind.value };
  }
}

export type Envelope = { uuid: string; event: EventName; distinct_id: string; timestamp: string; properties: Record<string, unknown> };

// The event as it may leave, or null. Only the bytes built here are sent.
export function validate(raw: unknown): Envelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.event !== "string" || !(EVENTS as readonly string[]).includes(e.event)) return null;
  if (typeof e.uuid !== "string" || !UUID.test(e.uuid)) return null;
  if (typeof e.distinct_id !== "string" || !HEX64.test(e.distinct_id)) return null;
  if (typeof e.timestamp !== "string" || !ISO.test(e.timestamp)) return null;
  const props = typeof e.properties === "object" && e.properties !== null && !Array.isArray(e.properties) ? (e.properties as Record<string, unknown>) : {};
  const table = { ...COMMON, ...TABLES[e.event as EventName] };
  const properties: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(table)) {
    if (!(name in props) && kind.kind !== "const") continue;
    const r = check(kind, props[name]);
    if (r.keep) properties[name] = r.value;
  }
  return { uuid: e.uuid, event: e.event as EventName, distinct_id: e.distinct_id, timestamp: e.timestamp, properties };
}

// Every property name an event may carry, for the docs and the tests.
export function propertyNames(): string[] {
  return [...new Set([...Object.keys(COMMON), ...Object.values(TABLES).flatMap((t) => Object.keys(t))])];
}

// ---------- the builders: raw values in, properties out ----------

// The properties every event shares, but the install id and its age, which
// the worker adds: only the worker reads the id.
export function commonProps(o: { hostAgent: string | null; launcher: boolean; env: NodeJS.ProcessEnv }): Record<string, unknown> {
  const p = osPlatform();
  return {
    $process_person_profile: false,
    $lib: "openqodex",
    openqodexVersion: __OPENQODEX_VERSION__,
    platform: p,
    arch: process.arch,
    os: p === "darwin" ? "macOS" : p === "linux" ? "Linux" : p === "win32" ? "Windows" : "other",
    osMajor: Number(release().split(".")[0]),
    nodeMajor: Number(process.versions.node.split(".")[0]),
    wsl: o.env.WSL_DISTRO_NAME !== undefined && o.env.WSL_DISTRO_NAME !== "",
    hostAgent: o.hostAgent ?? "none",
    runner: o.launcher ? "launcher" : "package",
    tty: process.stdout.isTTY === true,
  };
}

// The sub-command word of a command line, from the closed table.
export function subOf(command: string, args: string[]): string | undefined {
  if (command === "update") {
    const flag = ["--rollback", "--off", "--on", "--status", "--now"].find((f) => args.includes(f));
    return flag === undefined ? "now" : flag.slice(2);
  }
  if (command === "hook" || command === "config" || command === "graph") {
    const first = args[0];
    return first !== undefined && SUBS[command]!.includes(first) ? first : undefined;
  }
  return undefined;
}

function flagNames(args: string[]): string[] {
  const names: string[] = [];
  for (const a of args) {
    if (a === "--") break;
    if (!a.startsWith("-")) continue;
    const name = a.split("=")[0]!;
    if ((FLAGS as readonly string[]).includes(name)) names.push(name);
  }
  return names;
}

// The format the command used, read the way parseFlags reads it: flags end
// at `--` and the last --format wins; --json (doctor, graph) is json.
function formatOf(args: string[]): string {
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  let format: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i]!;
    if (a === "--format") format = flags[++i];
    else if (a.startsWith("--format=")) format = a.slice(9);
  }
  return format ?? (flags.includes("--json") ? "json" : "terminal");
}

// The place of the first stack frame inside the bundle: its line and column
// only. The message, which can quote what was typed, comes before the
// frames and is skipped whole; only a line shaped like a frame counts.
function errorPlace(error: Error): { errorLine?: number; errorColumn?: number } {
  const lines = (error.stack ?? "").split("\n").slice(error.message.split("\n").length);
  for (const line of lines) {
    const m = /^ {4}at (?:.* \()?[^()\n]*[/\\]bin\.js:(\d+):(\d+)\)?$/.exec(line);
    if (m) return { errorLine: Number(m[1]), errorColumn: Number(m[2]) };
  }
  return {};
}

export function commandProps(o: { command: string; args: string[]; sub?: string; exitCode: number; durationMs: number; error?: unknown; threw: boolean; interrupted: boolean }): Record<string, unknown> {
  const p: Record<string, unknown> = {
    command: o.command,
    exitCode: o.exitCode,
    durationMs: Math.max(0, Math.round(o.durationMs)),
    threw: o.threw,
    interrupted: o.interrupted,
    flags: flagNames(o.args),
    format: formatOf(o.args),
  };
  const sub = o.sub ?? subOf(o.command, o.args);
  if (sub !== undefined) p.sub = sub;
  if (o.threw && o.error !== undefined) {
    p.errorKind = o.error instanceof OpenQodexError ? "input" : "internal";
    if (o.error instanceof Error) {
      p.errorClass = o.error.name;
      const code = (o.error as NodeJS.ErrnoException).code;
      if (typeof code === "string") p.errorCode = code;
      Object.assign(p, errorPlace(o.error));
    } else p.errorClass = "other";
  }
  return p;
}

// A scanner list as the event takes it: the built-in names by status, how
// long each ran, why each failed, and custom scanners only counted.
function scannerProps(scanners: readonly ScannerRunSummary[]): Record<string, unknown> {
  const builtin = scanners.filter((s) => !s.scanner.startsWith("custom:"));
  const custom = scanners.filter((s) => s.scanner.startsWith("custom:"));
  const named = (status: ScannerRunSummary["status"]) => builtin.filter((s) => s.status === status).map((s) => s.scanner);
  return {
    scannersRan: named("ran"),
    scannersFailed: named("failed"),
    scannersNotInstalled: named("not_installed"),
    scannersInstalling: named("installing"),
    scannersDisabled: named("disabled"),
    scannerMs: Object.fromEntries(builtin.filter((s) => s.status === "ran" || s.status === "failed").map((s) => [s.scanner, Math.round(s.durationMs)])),
    scannerFailures: Object.fromEntries(builtin.filter((s) => s.status === "failed").map((s) => [s.scanner, failureCode(s.reason, s.scanner)])),
    customScanners: custom.filter((s) => s.status === "ran" || s.status === "failed").length,
    customScannersFailed: custom.filter((s) => s.status === "failed").length,
  };
}

function reportProps(report: Report): Record<string, unknown> {
  const t = report.timings;
  const p: Record<string, unknown> = {
    verdict: report.verdict,
    files: report.stats.files,
    additions: report.stats.additions,
    deletions: report.stats.deletions,
    findings: report.findings.length,
    ...scannerProps(report.scanners),
  };
  if (t !== undefined) {
    const pairs: [string, number | undefined][] = [["totalMs", t.total_ms], ["changeMs", t.change_ms], ["scanMs", t.scan_ms], ["graphMs", t.graph_ms], ["briefMs", t.brief_ms], ["reviewerMs", t.reviewer_ms], ["finalizeMs", t.finalize_ms]];
    for (const [k, v] of pairs) if (v !== undefined) p[k] = Math.round(v);
  }
  return p;
}

export function scanProps(o: { report: Report | null; exitCode: number; candidates: number; demo: boolean; reportDir: boolean; blockOnFlag: boolean }): Record<string, unknown> {
  const base = { exitCode: o.exitCode, nothing: o.report === null, demo: o.demo, reportDir: o.reportDir, blockOnFlag: o.blockOnFlag };
  if (o.report === null) return base;
  const { graphMs: _g, briefMs: _b, reviewerMs: _r, finalizeMs: _f, ...rest } = reportProps(o.report);
  return { ...base, ...rest, candidates: o.candidates };
}

export type ReviewInput = {
  mode: "reviewer" | "agent";
  scope: "change" | "target" | "all";
  fromInit: boolean;
  ended: "finished" | "incomplete" | "unavailable" | "nothing" | "interrupted" | "error";
  cleanupFailed: boolean;
  exitCode: number;
  staged?: boolean;
  web?: boolean;
  // The reviewer that started (a driver's name) and its version text.
  reviewer?: string | null;
  reviewerVersion?: string;
  completion?: CompletionRecord | null;
  report?: Report | null;
  // The model names on each call record; null where the agent named none.
  modelsReported?: (string | null)[];
  inputTokens?: number | null;
  outputTokens?: number | null;
};

// The model the agent reported, across every call: one name, `mixed` for
// more than one, `unknown` when it named none. Two spellings of one public
// model (a provider prefix, a date) count as one; names not on the list
// count apart, so two private models are still mixed.
function reported(models: (string | null)[]): string {
  const raw = models.flatMap((m) => (m === null ? [] : m.split(", "))).filter((m) => m !== "");
  const names = new Set(raw.map((m) => {
    const known = canonicalModel(m);
    return known === "other" ? `other:${m}` : known;
  }));
  if (names.size === 0) return "unknown";
  if (names.size > 1) return "mixed";
  const only = [...names][0]!;
  return only.startsWith("other:") ? "other" : only;
}

export function reviewProps(o: ReviewInput): Record<string, unknown> {
  const p: Record<string, unknown> = { mode: o.mode, scope: o.scope, fromInit: o.fromInit, ended: o.ended, cleanupFailed: o.cleanupFailed, exitCode: o.exitCode };
  if (o.staged !== undefined) p.staged = o.staged;
  if (o.web !== undefined) p.web = o.web;
  const served = o.completion?.reviewer ?? null;
  const reviewer = served?.driver ?? o.reviewer ?? null;
  if (reviewer !== null) {
    p.reviewer = ["claude", "codex", "cursor"].includes(reviewer) ? reviewer : "other";
    const version = served?.version ?? o.reviewerVersion;
    if (version !== undefined) p.reviewerVersion = version;
  }
  if (served !== null) {
    p.modelRequested = served.model === undefined ? "default" : canonicalModel(served.model);
    p.effortRequested = served.effort === undefined ? "default" : (EFFORTS as readonly string[]).includes(served.effort) ? served.effort : "other";
    p.reviewersPassed = served.passed?.length ?? 0;
    p.sessions = served.sessions?.length ?? 1;
    p.rounds = served.rounds;
    p.turns = served.usage.turns;
  }
  if (o.modelsReported !== undefined && reviewer !== null) p.modelReported = reported(o.modelsReported);
  if (o.inputTokens !== undefined && o.inputTokens !== null) p.inputTokens = o.inputTokens;
  if (o.outputTokens !== undefined && o.outputTokens !== null) p.outputTokens = o.outputTokens;
  const r = o.report;
  if (r !== undefined && r !== null) {
    Object.assign(p, reportProps(r));
    if (o.ended !== "finished" && o.ended !== "incomplete") delete p.verdict;
    p.possible = r.possible.length;
    p.observations = r.observations?.length ?? 0;
    p.outsideChange = r.outside_change.length;
    p.belowThreshold = r.below_threshold;
    p.notReviewed = r.not_reviewed.length;
    p.dropped = r.dropped.length;
    p.lowConfidence = r.low_confidence.length;
    const bySeverity: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    for (const f of r.findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byOrigin[f.origin] = (byOrigin[f.origin] ?? 0) + 1;
    }
    p.findingsBySeverity = bySeverity;
    p.findingsByOrigin = byOrigin;
    p.graph = r.impact?.status ?? "off";
    if (r.block_on_severity !== null) p.blockOn = r.block_on_severity;
  }
  const c = o.completion;
  if (c !== undefined && c !== null) {
    p.candidatesTotal = c.candidates.total;
    p.candidatesDisposed = c.candidates.disposed;
    p.hunks = c.coverage.hunks;
    p.hunksCovered = c.coverage.covered;
    p.missingCount = c.missing.length;
  }
  return p;
}
